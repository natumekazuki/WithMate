import type { DatabaseSync } from "node:sqlite";

import type { PersistenceRequestClass } from "../shared/persistence-protocol.js";

export class PersistenceExecutorError extends Error {
  constructor(
    readonly code: "queue_full" | "request_canceled" | "worker_closing" | "request_id_duplicate",
    message: string,
  ) {
    super(message);
    this.name = "PersistenceExecutorError";
  }
}

type QueueEntry<T> = {
  requestId: string;
  requestClass: PersistenceRequestClass;
  run: () => T | Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export class BoundedSerialExecutor {
  readonly #queue: QueueEntry<unknown>[] = [];
  readonly #knownRequestIds = new Set<string>();
  readonly #idleWaiters = new Set<() => void>();
  #runningRequestId: string | undefined;
  #accepting = true;

  constructor(readonly maxQueueDepth: number) {
    if (!Number.isSafeInteger(maxQueueDepth) || maxQueueDepth < 0) {
      throw new RangeError("maxQueueDepth must be a non-negative safe integer.");
    }
  }

  get isIdle(): boolean {
    return this.#runningRequestId === undefined && this.#queue.length === 0;
  }

  submit<T>(requestId: string, requestClass: PersistenceRequestClass, run: () => T | Promise<T>): Promise<T> {
    if (!this.#accepting) {
      return Promise.reject(new PersistenceExecutorError("worker_closing", "Persistence worker is closing."));
    }
    if (this.#knownRequestIds.has(requestId)) {
      return Promise.reject(new PersistenceExecutorError("request_id_duplicate", "Request ID is already in use."));
    }
    if (this.#runningRequestId !== undefined && this.#queue.length >= this.maxQueueDepth) {
      return Promise.reject(new PersistenceExecutorError("queue_full", "Persistence request queue is full."));
    }

    this.#knownRequestIds.add(requestId);
    const promise = new Promise<T>((resolve, reject) => {
      this.#queue.push({
        requestId,
        requestClass,
        run,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
    void this.#drain();
    return promise;
  }

  cancel(requestId: string): "queued" | "running" | "missing" {
    if (this.#runningRequestId === requestId) {
      return "running";
    }
    const index = this.#queue.findIndex((entry) => entry.requestId === requestId);
    if (index < 0) {
      return "missing";
    }
    const [entry] = this.#queue.splice(index, 1);
    this.#knownRequestIds.delete(requestId);
    entry?.reject(new PersistenceExecutorError("request_canceled", "Persistence request was canceled."));
    this.#resolveIdleWaiters();
    return "queued";
  }

  closeAdmission(): void {
    this.#accepting = false;
    for (const entry of this.#queue.splice(0)) {
      this.#knownRequestIds.delete(entry.requestId);
      entry.reject(new PersistenceExecutorError("worker_closing", "Persistence worker is closing."));
    }
    this.#resolveIdleWaiters();
  }

  async whenIdle(): Promise<void> {
    if (this.isIdle) {
      return;
    }
    await new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
  }

  async #drain(): Promise<void> {
    if (this.#runningRequestId !== undefined) {
      return;
    }
    const entry = this.#queue.shift();
    if (entry === undefined) {
      this.#resolveIdleWaiters();
      return;
    }

    this.#runningRequestId = entry.requestId;
    try {
      entry.resolve(await entry.run());
    } catch (error) {
      entry.reject(error);
    } finally {
      this.#knownRequestIds.delete(entry.requestId);
      this.#runningRequestId = undefined;
      void this.#drain();
    }
  }

  #resolveIdleWaiters(): void {
    if (!this.isIdle) {
      return;
    }
    for (const resolve of this.#idleWaiters) {
      resolve();
    }
    this.#idleWaiters.clear();
  }
}

/** callbackは同期処理に限定し、PromiseLikeを返した場合はcommitせずrollbackする。 */
export function executeWriteTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const result = operation();
    if (isPromiseLike(result)) {
      throw new TypeError("Persistence transactions require a synchronous callback.");
    }
    database.exec("COMMIT;");
    return result;
  } catch (error) {
    if (database.isTransaction) {
      database.exec("ROLLBACK;");
    }
    throw error;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" || typeof value === "function") && value !== null && "then" in value;
}
