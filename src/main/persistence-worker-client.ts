import { randomUUID } from "node:crypto";
import { Worker, type WorkerOptions } from "node:worker_threads";

import {
  PERSISTENCE_PROTOCOL_VERSION,
  type PersistenceError,
  type PersistenceRequestClass,
} from "../shared/persistence-protocol.js";
import { decodeMainToWorkerMessage, decodeWorkerToMainMessage } from "../shared/persistence-runtime-protocol.js";

export type PersistenceWorkerClientState = "idle" | "starting" | "ready" | "closing" | "closed" | "failed";

export type PersistenceWorkerClientOptions = Readonly<{
  workerUrl?: URL;
  databasePath: string;
  legacyDatabasePaths: readonly string[];
  maxQueueDepth?: number;
  maxConcurrentRuns?: number;
  maxConcurrentRunsPerProvider?: number;
  startupTimeoutMs?: number;
  workerOptions?: Pick<WorkerOptions, "execArgv" | "env">;
}>;

export type PersistenceRequestOptions = Readonly<{
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

export type PersistenceStartOptions = Readonly<{ signal?: AbortSignal }>;

export class PersistenceClientError extends Error {
  constructor(readonly persistenceError: PersistenceError) {
    super(persistenceError.message);
    this.name = "PersistenceClientError";
  }
}

type PendingRequest = {
  requestClass: PersistenceRequestClass;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  removeAbortListener: (() => void) | undefined;
};

export class PersistenceWorkerClient {
  readonly generationId = randomUUID();
  readonly #pending = new Map<string, PendingRequest>();
  #state: PersistenceWorkerClientState = "idle";
  #worker: Worker | undefined;
  #startPromise: Promise<void> | undefined;
  #shutdownPromise: Promise<Readonly<{ checkpoint: "completed" | "failed" }>> | undefined;
  #resolveStartup: (() => void) | undefined;
  #rejectStartup: ((error: unknown) => void) | undefined;
  #resolveClosed: ((checkpoint: "completed" | "failed") => void) | undefined;
  #rejectClosed: ((error: unknown) => void) | undefined;
  #shutdownRequestId: string | undefined;
  #exitPromise: Promise<number> | undefined;
  #resolveExit: ((exitCode: number) => void) | undefined;
  #expectedExit = false;
  #nextRequestSequence = 1;
  readonly #workerUrl: URL;

  constructor(readonly options: PersistenceWorkerClientOptions) {
    this.#workerUrl = options.workerUrl ?? new URL("../persistence-worker/worker-entry.js", import.meta.url);
  }

  get state(): PersistenceWorkerClientState {
    return this.#state;
  }

  start(options: PersistenceStartOptions = {}): Promise<void> {
    if (this.#startPromise !== undefined) {
      return this.#startPromise;
    }
    if (this.#state !== "idle") {
      return Promise.reject(clientError("worker_not_ready", "Persistence worker cannot be started.", false, "none"));
    }
    if (options.signal?.aborted) {
      this.#state = "failed";
      return Promise.reject(clientError("request_canceled", "Persistence worker startup was canceled.", false, "none"));
    }

    this.#state = "starting";
    this.#startPromise = new Promise<void>((resolve, reject) => {
      this.#resolveStartup = resolve;
      this.#rejectStartup = reject;
    });
    this.#exitPromise = new Promise<number>((resolve) => {
      this.#resolveExit = resolve;
    });

    let worker: Worker;
    try {
      worker = new Worker(this.#workerUrl, {
        ...this.options.workerOptions,
        workerData: {
          generationId: this.generationId,
          databasePath: this.options.databasePath,
          legacyDatabasePaths: this.options.legacyDatabasePaths,
          maxQueueDepth: this.options.maxQueueDepth ?? 128,
          maxConcurrentRuns: this.options.maxConcurrentRuns ?? 4,
          maxConcurrentRunsPerProvider: this.options.maxConcurrentRunsPerProvider ?? 4,
        },
      });
    } catch {
      this.#failStartup(clientError("worker_start_failed", "Persistence worker could not be created.", false, "none"));
      return this.#startPromise;
    }
    this.#worker = worker;
    worker.on("message", (message: unknown) => this.#handleMessage(message));
    worker.on("error", () => this.#handleCrash());
    worker.on("exit", (exitCode) => this.#handleExit(exitCode));

    const onAbort = () => {
      if (this.#state !== "starting") return;
      this.#expectedExit = true;
      this.#failStartup(clientError("request_canceled", "Persistence worker startup was canceled.", false, "none"));
      void worker.terminate();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    const startupTimer = setTimeout(() => {
      if (this.#state !== "starting") {
        return;
      }
      this.#expectedExit = true;
      void worker.terminate();
      this.#failStartup(clientError("worker_start_failed", "Persistence worker startup timed out.", true, "none"));
    }, this.options.startupTimeoutMs ?? 10_000);
    this.#startPromise
      .finally(() => {
        clearTimeout(startupTimer);
        options.signal?.removeEventListener("abort", onAbort);
      })
      .catch(() => undefined);
    return this.#startPromise;
  }

  /**
   * timeoutまたはcrashでwrite結果を確認できない場合は`effect=unknown`を返す。
   * そのrequestを自動再送せず、repositoryのidempotency契約で収束させる。
   */
  request<TResult>(
    operation: string,
    requestClass: PersistenceRequestClass,
    payload: Readonly<Record<string, unknown>>,
    options: PersistenceRequestOptions = {},
  ): Promise<TResult> {
    if (this.#state !== "ready" || this.#worker === undefined) {
      return Promise.reject(
        clientError(
          this.#state === "closing" ? "worker_closing" : "worker_not_ready",
          this.#state === "closing" ? "Persistence worker is closing." : "Persistence worker is not ready.",
          this.#state === "closing",
          "none",
        ),
      );
    }

    const requestId = randomUUID();
    const requestMessage = {
      protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
      generationId: this.generationId,
      kind: "request",
      requestId,
      requestSequence: this.#nextRequestSequence,
      operation,
      requestClass,
      payload,
    } as const;
    if (!decodeMainToWorkerMessage(requestMessage).ok) {
      return Promise.reject(clientError("protocol_invalid", "Persistence request is invalid.", false, "none"));
    }
    const signal = options.signal;
    if (signal?.aborted) {
      return Promise.reject(clientError("request_canceled", "Persistence request was canceled.", false, "none"));
    }

    const worker = this.#worker;
    return new Promise<TResult>((resolve, reject) => {
      const pending: PendingRequest = {
        requestClass,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: undefined,
        removeAbortListener: undefined,
      };
      if (options.timeoutMs !== undefined) {
        pending.timer = setTimeout(() => this.#cancelPending(requestId, "request_timeout"), options.timeoutMs);
      }
      if (signal !== undefined) {
        const onAbort = () => this.#cancelPending(requestId, "request_canceled");
        signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          cleanupPending(pending);
          reject(clientError("request_canceled", "Persistence request was canceled.", false, "none"));
          return;
        }
      }
      this.#pending.set(requestId, pending);
      try {
        worker.postMessage(requestMessage);
        this.#nextRequestSequence += 1;
      } catch {
        this.#pending.delete(requestId);
        cleanupPending(pending);
        reject(clientError("protocol_invalid", "Persistence request could not be transferred.", false, "none"));
      }
    });
  }

  /**
   * 新規requestを拒否し、実行中request、primary connection、WAL checkpointの順に終了する。
   * timeoutによるterminateは正常shutdownとして扱わない。
   */
  shutdown(timeoutMs = 10_000, signal?: AbortSignal): Promise<Readonly<{ checkpoint: "completed" | "failed" }>> {
    if (this.#shutdownPromise !== undefined) {
      return this.#shutdownPromise;
    }
    if (this.#state === "closed") {
      return Promise.resolve({ checkpoint: "completed" });
    }
    if (this.#state !== "ready" || this.#worker === undefined || this.#exitPromise === undefined) {
      return Promise.reject(clientError("worker_not_ready", "Persistence worker is not ready.", false, "none"));
    }

    this.#state = "closing";
    const shutdownRequestId = randomUUID();
    this.#shutdownRequestId = shutdownRequestId;
    const closed = new Promise<"completed" | "failed">((resolve, reject) => {
      this.#resolveClosed = resolve;
      this.#rejectClosed = reject;
    });
    try {
      this.#worker.postMessage({
        protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
        generationId: this.generationId,
        kind: "shutdown",
        requestId: shutdownRequestId,
      });
    } catch {
      const error = clientError("protocol_invalid", "Shutdown request could not be transferred.", false, "none");
      this.#rejectClosed?.(error);
    }

    this.#shutdownPromise = this.#finishShutdown(closed, timeoutMs, signal);
    return this.#shutdownPromise;
  }

  async #finishShutdown(
    closed: Promise<"completed" | "failed">,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<Readonly<{ checkpoint: "completed" | "failed" }>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const forced = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(clientError("worker_shutdown_forced", "Persistence worker shutdown was forced.", false, "unknown")),
        timeoutMs,
      );
      if (signal !== undefined) {
        onAbort = () =>
          reject(clientError("request_canceled", "Persistence worker shutdown was canceled.", false, "unknown"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
    });
    try {
      const checkpoint = await Promise.race([
        closed.then(async (value) => {
          this.#expectedExit = true;
          await this.#exitPromise;
          return value;
        }),
        forced,
      ]);
      this.#state = "closed";
      return { checkpoint };
    } catch (error) {
      this.#expectedExit = true;
      await this.#worker?.terminate();
      this.#rejectAll("worker_shutdown_forced", "Persistence worker shutdown was forced.");
      this.#state = "failed";
      throw error;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    }
  }

  #handleMessage(rawMessage: unknown): void {
    const decoded = decodeWorkerToMainMessage(rawMessage);
    if (!decoded.ok || decoded.value.generationId !== this.generationId) {
      return;
    }
    const message = decoded.value;
    switch (message.kind) {
      case "ready":
        if (this.#state === "starting") {
          this.#state = "ready";
          this.#resolveStartup?.();
        }
        return;
      case "startupFailed":
        this.#failStartup(new PersistenceClientError(message.error));
        return;
      case "response": {
        const pending = this.#pending.get(message.requestId);
        if (pending === undefined) {
          return;
        }
        this.#pending.delete(message.requestId);
        cleanupPending(pending);
        if (message.ok) {
          pending.resolve(message.result);
        } else {
          pending.reject(new PersistenceClientError(message.error));
        }
        return;
      }
      case "closed":
        if (this.#state === "closing" && message.requestId === this.#shutdownRequestId) {
          this.#resolveClosed?.(message.checkpoint);
        }
    }
  }

  #cancelPending(requestId: string, code: "request_timeout" | "request_canceled"): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(requestId);
    cleanupPending(pending);
    this.#worker?.postMessage({
      protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
      generationId: this.generationId,
      kind: "cancel",
      requestId,
    });
    pending.reject(
      clientError(
        code,
        code === "request_timeout" ? "Persistence request timed out." : "Persistence request was canceled.",
        false,
        uncertainEffect(pending.requestClass),
      ),
    );
  }

  #handleCrash(): void {
    if (this.#state === "closed" || this.#expectedExit) {
      return;
    }
    this.#state = "failed";
    const error = clientError("worker_crashed", "Persistence worker crashed.", false, "none");
    this.#rejectStartup?.(error);
    this.#rejectClosed?.(error);
    this.#rejectAll("worker_crashed", "Persistence worker crashed.");
  }

  #handleExit(exitCode: number): void {
    this.#resolveExit?.(exitCode);
    if (!this.#expectedExit && this.#state !== "closed") {
      this.#handleCrash();
    }
  }

  #failStartup(error: unknown): void {
    if (this.#state !== "starting") {
      return;
    }
    this.#state = "failed";
    this.#rejectStartup?.(error);
  }

  #rejectAll(code: "worker_crashed" | "worker_shutdown_forced", message: string): void {
    for (const [requestId, pending] of this.#pending) {
      this.#pending.delete(requestId);
      cleanupPending(pending);
      pending.reject(clientError(code, message, false, uncertainEffect(pending.requestClass)));
    }
  }
}

function uncertainEffect(requestClass: PersistenceRequestClass): PersistenceError["effect"] {
  return requestClass === "read" ? "none" : "unknown";
}

function cleanupPending(pending: PendingRequest): void {
  if (pending.timer !== undefined) {
    clearTimeout(pending.timer);
  }
  pending.removeAbortListener?.();
}

function clientError(
  code: PersistenceError["code"],
  message: string,
  retryable: boolean,
  effect: PersistenceError["effect"],
): PersistenceClientError {
  return new PersistenceClientError({ code, message, retryable, effect });
}
