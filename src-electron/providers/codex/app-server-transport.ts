import type { ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { TextDecoder } from "node:util";
import { spawnOwnedCodexProcess, OwnedCodexProcessAcquisitionError, type OwnedCodexProcessCleanupOwner } from "./owned-process.js";

export const CODEX_APP_SERVER_ARGUMENTS = ["app-server", "--listen", "stdio://"] as const;
export type CodexRequestOptions = { signal?: AbortSignal; timeoutMs?: number };
export type CodexWireError = { code: number; message: string; data?: unknown };
export type CodexProtocolEvent =
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "serverRequest"; id: string | number; method: string; params: unknown;
      respond(result: unknown): Promise<void>; reject(error: CodexWireError): Promise<void> };
export type CodexAppServerTransportOptions = {
  executable: string;
  arguments?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  clientInfo: { name: string; title?: string; version: string };
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
};

export class CodexAppServerRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "CodexAppServerRpcError";
  }
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void };
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_QUEUE_BYTES = 32 * 1024 * 1024;

export class CodexAppServerTransport {
  #state: "idle" | "starting" | "ready" | "closing" | "closed" | "failed" = "idle";
  #child?: ChildProcessWithoutNullStreams;
  #owner?: OwnedCodexProcessCleanupOwner;
  #startPromise?: Promise<unknown>;
  #closePromise?: Promise<void>;
  #exitPromise?: Promise<void>;
  #terminalError?: Error;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #events: { event: CodexProtocolEvent; bytes: number }[] = [];
  #eventBytes = 0;
  #waiters: Pending[] = [];
  #serverRequests = new Set<string>();
  #queuedWriteBytes = 0;
  #options: CodexAppServerTransportOptions;
  #spawnOwnedProcess: typeof spawnOwnedCodexProcess;

  constructor(options: CodexAppServerTransportOptions, dependencies: { spawnOwnedProcess?: typeof spawnOwnedCodexProcess } = {}) {
    if (!options.executable || !options.clientInfo.name || !options.clientInfo.version) {
      throw new TypeError("Codex executable and clientInfo are required.");
    }
    for (const duration of [options.startupTimeoutMs, options.requestTimeoutMs, options.closeTimeoutMs]) {
      if (duration !== undefined && (!Number.isSafeInteger(duration) || duration < 1 || duration > 2_147_483_647)) {
        throw new RangeError("Codex timeouts must be positive Node timer durations.");
      }
    }
    this.#options = { ...options, clientInfo: { ...options.clientInfo },
      arguments: [...(options.arguments ?? CODEX_APP_SERVER_ARGUMENTS)],
      ...(options.env === undefined ? {} : { env: { ...options.env } }) };
    this.#spawnOwnedProcess = dependencies.spawnOwnedProcess ?? spawnOwnedCodexProcess;
  }

  get state() { return this.#state; }

  start(signal?: AbortSignal): Promise<unknown> {
    if (this.#startPromise) return this.#startPromise;
    if (this.#state !== "idle") return Promise.reject(new Error("Codex transport is not idle."));
    if (signal?.aborted) return Promise.reject(abortError());
    this.#state = "starting";
    this.#startPromise = this.#start(signal);
    return this.#startPromise;
  }

  async #start(signal?: AbortSignal): Promise<unknown> {
    try {
      const owner = this.#spawnOwnedProcess({
        executable: this.#options.executable, arguments: this.#options.arguments!,
        cwd: this.#options.cwd, env: this.#options.env,
      });
      this.#owner = owner;
      const child = owner.child;
      this.#child = child;
      this.#exitPromise = new Promise((resolve) => {
        child.once("close", () => resolve());
      });
      this.#attach(child);
      await withTimeout(owner.ready, this.#options.startupTimeoutMs ?? 10_000, signal);
      const result = await this.#request("initialize", {
        clientInfo: this.#options.clientInfo,
        capabilities: { experimentalApi: true, requestAttestation: false, mcpServerOpenaiFormElicitation: true },
      }, { signal, timeoutMs: this.#options.startupTimeoutMs ?? 10_000 });
      if (!isObject(result) || typeof result.userAgent !== "string" || typeof result.codexHome !== "string"
        || !path.isAbsolute(result.codexHome) || typeof result.platformFamily !== "string" || typeof result.platformOs !== "string") {
        throw new Error("Codex initialize response is invalid.");
      }
      await this.#write({ method: "initialized" });
      if (this.#terminalError) throw this.#terminalError;
      this.#state = "ready";
      return result;
    } catch (error) {
      if (error instanceof OwnedCodexProcessAcquisitionError) {
        this.#owner = error.owner;
        this.#child = error.owner.child;
        this.#child?.on("error", () => {});
      }
      const failure = asError(error);
      this.#fail(failure);
      await this.close();
      throw failure;
    }
  }

  request<T>(method: string, params?: unknown, options: CodexRequestOptions = {}): Promise<T> {
    if (this.#state !== "ready") return Promise.reject(this.#terminalError ?? new Error("Codex transport is not ready."));
    return this.#request(method, params, options) as Promise<T>;
  }

  #request(method: string, params: unknown, options: CodexRequestOptions): Promise<unknown> {
    if (options.signal?.aborted) return Promise.reject(abortError());
    const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs ?? 30_000;
    if (!method || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      return Promise.reject(new TypeError("Invalid Codex request method or timeout."));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const settle = (error: Error) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        pending.cleanup();
        reject(error);
      };
      const timer = setTimeout(() => settle(new Error(`Codex request timed out: ${method}`)), timeoutMs);
      const onAbort = () => settle(abortError());
      this.#pending.set(id, { resolve, reject,
        cleanup: () => { clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); } });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      void this.#write({ id, method, ...(params === undefined ? {} : { params }) }).catch(settle);
    });
  }

  nextEvent(): Promise<CodexProtocolEvent> {
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    const queued = this.#events.shift();
    if (queued) { this.#eventBytes -= queued.bytes; return Promise.resolve(queued.event); }
    if (this.#state !== "ready" && this.#state !== "starting") return Promise.reject(new Error("Codex transport is closed."));
    return new Promise((resolve, reject) => this.#waiters.push({ resolve: value => resolve(value as CodexProtocolEvent), reject, cleanup() {} }));
  }

  #attach(child: ChildProcessWithoutNullStreams): void {
    let decoder = new TextDecoder("utf-8", { fatal: true });
    let line = "";
    let lineBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.#terminalError || this.#state === "closing" || this.#state === "closed") return;
      try {
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf(10, offset);
          const end = newline < 0 ? chunk.length : newline;
          const segment = chunk.subarray(offset, end);
          lineBytes += segment.byteLength;
          if (lineBytes > MAX_LINE_BYTES) throw new Error("Codex stdout frame is too large.");
          line += decoder.decode(segment, { stream: true });
          if (newline < 0) break;
          line += decoder.decode();
          this.#accept(JSON.parse(line), lineBytes);
          line = ""; lineBytes = 0; decoder = new TextDecoder("utf-8", { fatal: true });
          offset = newline + 1;
        }
      } catch (error) { this.#fail(new Error("Codex stdout protocol failure.", { cause: error })); }
    });
    child.stdout.on("end", () => {
      if (this.#state === "closing" || this.#state === "closed") return;
      this.#fail(new Error(lineBytes ? "Codex stdout ended with a partial frame." : "Codex stdout disconnected."));
    });
    child.stdout.on("error", error => this.#fail(error));
    child.stdin.on("error", error => this.#fail(error));
    child.stderr.on("error", error => this.#fail(error));
    // Drain diagnostics without retaining arbitrary CLI output or credentials.
    child.stderr.resume();
    child.on("error", error => this.#fail(error));
    child.on("exit", (code, signal) => {
      if (this.#state !== "closing" && this.#state !== "closed") this.#fail(new Error(`Codex process exited (${code ?? signal}).`));
    });
    child.on("close", (code, signal) => {
      if (this.#state !== "closing" && this.#state !== "closed") this.#fail(new Error(`Codex process exited (${code ?? signal}).`));
    });
  }

  #accept(value: unknown, bytes: number): void {
    if (!isObject(value)) throw new Error("Invalid Codex envelope.");
    const hasId = Object.hasOwn(value, "id");
    if (hasId && !isId(value.id)) throw new Error("Invalid Codex request ID.");
    if (typeof value.method === "string" && value.method.length > 0) {
      if (Object.hasOwn(value, "result") || Object.hasOwn(value, "error")) throw new Error("Invalid Codex request envelope.");
      let event: CodexProtocolEvent;
      if (hasId) {
        const id = value.id as string | number;
        const key = `${typeof id}:${id}`;
        if (this.#serverRequests.has(key)) throw new Error("Duplicate Codex server request.");
        this.#serverRequests.add(key);
        let responded = false;
        const respond = async (response: object) => {
          if (responded || !this.#serverRequests.has(key)) throw new Error("Codex server request is already resolved.");
          responded = true;
          this.#serverRequests.delete(key);
          await this.#write({ id, ...response });
        };
        event = { kind: "serverRequest", id, method: value.method, params: value.params,
          respond: result => respond({ result }), reject: error => respond({ error }) };
      } else event = { kind: "notification", method: value.method, params: value.params };
      const waiter = this.#waiters.shift();
      if (waiter) waiter.resolve(event);
      else {
        if (this.#events.length >= 4096 || this.#eventBytes + bytes > MAX_QUEUE_BYTES) throw new Error("Codex event queue overflow.");
        this.#events.push({ event, bytes }); this.#eventBytes += bytes;
      }
      return;
    }
    if (!hasId || Object.hasOwn(value, "result") === Object.hasOwn(value, "error")) throw new Error("Invalid Codex response envelope.");
    if (Object.hasOwn(value, "error") && (!isObject(value.error) || !Number.isSafeInteger(value.error.code) || typeof value.error.message !== "string")) {
      throw new Error("Invalid Codex RPC error.");
    }
    // Late responses to locally aborted/timed-out requests are not new requests.
    const pending = typeof value.id === "number" ? this.#pending.get(value.id) : undefined;
    if (!pending) return;
    this.#pending.delete(value.id as number); pending.cleanup();
    if (isObject(value.error)) pending.reject(new CodexAppServerRpcError(value.error.code as number, value.error.message as string, value.error.data));
    else pending.resolve(value.result);
  }

  #write(value: object): Promise<void> {
    if (this.#terminalError || !this.#child || this.#state === "closing" || this.#state === "closed") {
      return Promise.reject(this.#terminalError ?? new Error("Codex transport is closed."));
    }
    let frame: string;
    try { frame = `${JSON.stringify(value)}\n`; } catch (error) { return Promise.reject(asError(error)); }
    const bytes = Buffer.byteLength(frame);
    if (bytes > MAX_LINE_BYTES || this.#queuedWriteBytes + bytes > MAX_QUEUE_BYTES) return Promise.reject(new Error("Codex write queue overflow."));
    this.#queuedWriteBytes += bytes;
    return new Promise((resolve, reject) => {
      this.#child!.stdin.write(frame, error => {
        this.#queuedWriteBytes -= bytes;
        if (error) { this.#fail(error); reject(error); } else resolve();
      });
    });
  }

  #fail(error: Error): void {
    if (this.#terminalError || this.#state === "closing" || this.#state === "closed") return;
    this.#state = "failed"; this.#terminalError = error;
    this.#settlePending(error);
    // Cleanup failures are returned by close(), never turned into successful protocol events.
    void this.close().catch(() => {});
  }

  #settlePending(error: Error): void {
    for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(error); }
    this.#pending.clear();
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters = []; this.#events = []; this.#eventBytes = 0; this.#serverRequests.clear();
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#state === "closed") return Promise.resolve();
    this.#state = "closing";
    this.#settlePending(this.#terminalError ?? new Error("Codex transport closed."));
    const attempt = this.#close();
    this.#closePromise = attempt;
    void attempt.catch(() => {
      // Only a retained ownership handle can be safely retried; never kill by a retired PID.
      if (this.#owner && this.#closePromise === attempt) this.#closePromise = undefined;
    });
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    const child = this.#child;
    const failures: Error[] = [];
    try { this.#owner?.terminate(); } catch (error) { failures.push(asError(error)); }
    try {
      this.#owner?.release();
      this.#owner = undefined;
    } catch (error) { failures.push(asError(error)); }
    for (const stream of [child?.stdin, child?.stdout, child?.stderr]) {
      try { stream?.destroy(); } catch (error) { failures.push(asError(error)); }
    }
    try {
      if (this.#exitPromise) await withTimeout(this.#exitPromise, this.#options.closeTimeoutMs ?? 5_000);
    } catch (error) { failures.push(asError(error)); }
    if (failures.length) {
      this.#state = "failed";
      const failure = new AggregateError(failures, "Codex process cleanup failed.");
      this.#terminalError ??= failure;
      throw failure;
    }
    this.#state = "closed";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}
function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
function abortError(): Error { const error = new Error("Codex request aborted."); error.name = "AbortError"; return error; }
async function withTimeout(operation: Promise<void>, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Codex process cleanup timed out.")), timeoutMs);
      onAbort = () => reject(abortError());
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    })]);
  } finally { clearTimeout(timer); if (onAbort) signal?.removeEventListener("abort", onAbort); }
}
