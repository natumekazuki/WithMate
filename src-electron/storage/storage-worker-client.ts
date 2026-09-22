import { randomUUID } from "node:crypto";
import { Worker, type WorkerOptions } from "node:worker_threads";

import {
  isStorageWorkerMessage,
  type StorageWorkerMessage,
  type StorageWorkerRequest,
} from "./storage-worker-protocol.js";
import {
  MemoryV6EntryNotFoundError,
  MemoryV6FileQuotaExceededError,
  MemoryV6IdempotencyConflictError,
} from "../memory/memory-v6-storage.js";
import { CharacterAffectIdempotencyConflictError, CharacterAffectVersionConflictError } from "../character/character-affect-storage.js";
import {
  createStorageOperationDiagnosticContext,
  emitStorageOperationDiagnostic,
  type StorageOperationDiagnosticSink,
} from "./storage-operation-diagnostics.js";

type PendingRequest = {
  mutation: boolean;
  sent: boolean;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  onProgress?: (progress: unknown) => void;
  operation: string;
  diagnostic?: ReturnType<typeof createStorageOperationDiagnosticContext>;
  workerQueueWaitMs?: number;
  workerExecutionMs?: number;
};

export class StorageWorkerUnknownOutcomeError extends Error {
  constructor(message = "Storage worker write outcome is unknown.") {
    super(message);
    this.name = "StorageWorkerUnknownOutcomeError";
  }
}

export class StorageWorkerGenerationError extends Error {
  constructor(message = "Storage worker generation is no longer active.") {
    super(message);
    this.name = "StorageWorkerGenerationError";
  }
}

export class StorageWorkerRemoteError extends Error {
  readonly code: string;
  readonly outcome: "not-executed" | "rejected" | "unknown";
  readonly details?: Record<string, string | number>;

  constructor(message: string, code = "STORAGE_WORKER_COMMAND_FAILED", outcome: "not-executed" | "rejected" | "unknown" = "not-executed", details?: Record<string, string | number>) {
    super(message);
    this.name = "StorageWorkerRemoteError";
    this.code = code;
    this.outcome = outcome;
    this.details = details;
  }
}

export class StorageWorkerClient {
  readonly generationId = randomUUID();
  private readonly worker: Worker;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly queued: StorageWorkerRequest[] = [];
  private ready = false;
  private closed = false;
  private faulted = false;
  private closePromise: Promise<void> | null = null;
  private terminationPromise: Promise<number> | null = null;
  private readonly diagnosticSink?: StorageOperationDiagnosticSink;

  constructor(workerUrl: URL | string, options: Omit<WorkerOptions, "workerData"> & { workerData: Record<string, unknown>; diagnosticSink?: StorageOperationDiagnosticSink }) {
    this.diagnosticSink = options.diagnosticSink;
    const { diagnosticSink: _diagnosticSink, ...workerOptions } = options;
    this.worker = new Worker(workerUrl, {
      ...workerOptions,
      workerData: { ...workerOptions.workerData, generationId: this.generationId },
    });
    this.worker.on("message", (message: unknown) => this.handleMessage(message));
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => {
      if (code !== 0) {
        this.fail(new Error(`Storage worker exited with code ${code}.`));
      } else if (!this.closed) {
        this.fail(new Error("Storage worker exited unexpectedly."));
      } else {
        this.rejectPendingForWorkerExit("Storage worker exited before the request completed.");
      }
    });
  }

  call<T, TProgress = unknown>(command: string, payload: unknown, options: {
    mutation?: boolean;
    onProgress?: (progress: TProgress) => void;
    operation?: string;
  } = {}): Promise<T> {
    if (this.closed || this.faulted) {
      return Promise.reject(new StorageWorkerGenerationError("Storage worker is closed."));
    }
    const requestId = randomUUID();
    const mutation = options.mutation ?? false;
    const operation = options.operation ?? command;
    const diagnostic = this.diagnosticSink ? createStorageOperationDiagnosticContext() : undefined;
    emitStorageOperationDiagnostic(this.diagnosticSink, {
      operation,
      correlationId: diagnostic?.correlationId ?? requestId,
      generationId: this.generationId,
      stage: "queued",
      outcome: "pending",
      requestId,
    });
    const request: StorageWorkerRequest = {
      type: "call",
      context: { requestId, generationId: this.generationId },
      command,
      payload,
      mutation,
    };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        mutation,
        sent: false,
        resolve,
        reject,
        onProgress: options.onProgress as ((progress: unknown) => void) | undefined,
        operation,
        diagnostic,
      });
      if (this.ready) {
        this.send(request);
      } else {
        this.queued.push(request);
      }
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    if (this.faulted) {
      await this.terminateWorker();
      return;
    }
    this.closed = true;
    for (const request of this.queued.splice(0)) {
      this.rejectPending(request.type === "call" ? request.context.requestId : request.requestId, new StorageWorkerGenerationError("Storage worker was closed before dispatch."));
    }
    this.closePromise = (async () => {
      const requestId = randomUUID();
      const exited = new Promise<void>((resolve) => this.worker.once("exit", resolve));
      try {
        this.worker.postMessage({ type: "shutdown", requestId });
      } catch (error) {
        this.fail(error);
        await this.terminateWorker();
        return;
      }
      await exited;
      if (this.terminationPromise) await this.terminationPromise;
    })();
    return this.closePromise;
  }

  private send(request: StorageWorkerRequest): void {
    try {
      this.worker.postMessage(request);
      if (request.type === "call") {
        const pending = this.pending.get(request.context.requestId);
        if (pending) pending.sent = true;
      }
    } catch (error) {
      const requestId = request.type === "call" ? request.context.requestId : request.requestId;
      if (isStructuredCloneError(error)) {
        this.rejectPending(requestId, error instanceof Error ? error : new Error(String(error)));
      } else {
        this.fail(error);
      }
    }
  }

  private handleMessage(message: unknown): void {
    if (!isStorageWorkerMessage(message)) {
      this.fail(new Error("Storage worker response is invalid."));
      return;
    }
    if (message.type === "ready") {
      if (message.generationId !== this.generationId) {
        this.fail(new StorageWorkerGenerationError("Storage worker generation does not match."));
        return;
      }
      this.ready = true;
      for (const request of this.queued.splice(0)) {
        this.send(request);
      }
      return;
    }
    if (message.type === "shutdown-complete") {
      if (message.generationId !== this.generationId) {
        this.fail(new StorageWorkerGenerationError("Storage worker shutdown generation does not match."));
        return;
      }
      for (const requestId of [...this.pending.keys()]) {
        this.rejectPending(requestId, this.pending.get(requestId)?.sent && this.pending.get(requestId)?.mutation
          ? new StorageWorkerUnknownOutcomeError("Storage worker closed before the write result was received.")
          : new StorageWorkerGenerationError("Storage worker closed before the request completed."));
      }
      return;
    }
    if (message.type === "progress") {
      if (message.generationId !== this.generationId) {
        this.fail(new StorageWorkerGenerationError("Storage worker progress generation does not match."));
        return;
      }
      this.pending.get(message.requestId)?.onProgress?.(message.progress);
      return;
    }
    if (message.type === "started") {
      if (message.generationId !== this.generationId) {
        this.fail(new StorageWorkerGenerationError("Storage worker start generation does not match."));
        return;
      }
      const pending = this.pending.get(message.requestId);
      if (pending) {
        pending.workerQueueWaitMs = message.queueWaitMs;
        if (pending.diagnostic) {
          pending.diagnostic.startedAt = pending.diagnostic.clock();
          emitStorageOperationDiagnostic(this.diagnosticSink, {
            operation: pending.operation,
            correlationId: pending.diagnostic.correlationId,
            generationId: this.generationId,
            stage: "started",
            outcome: "pending",
            waitMs: message.queueWaitMs,
            requestId: message.requestId,
          });
        }
      }
      return;
    }
    if (message.generationId !== this.generationId) {
      this.fail(new StorageWorkerGenerationError("Storage worker response generation does not match."));
      return;
    }
    this.resolveMessage(message);
  }

  private resolveMessage(message: Extract<StorageWorkerMessage, { type: "result" | "error" }>): void {
    const requestId = message.requestId;
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(requestId);
    pending.workerQueueWaitMs = message.timing?.queueWaitMs ?? pending.workerQueueWaitMs;
    pending.workerExecutionMs = message.timing?.executionMs ?? pending.workerExecutionMs;
    const finishDiagnostic = (outcome: "success" | "failure") => {
      if (!pending.diagnostic) return;
      const completedAt = pending.diagnostic.clock();
      emitStorageOperationDiagnostic(this.diagnosticSink, {
        operation: pending.operation,
        correlationId: pending.diagnostic.correlationId,
        generationId: this.generationId,
        stage: "completed",
        outcome,
        waitMs: pending.workerQueueWaitMs ?? (pending.diagnostic.startedAt === undefined ? completedAt - pending.diagnostic.queuedAt : undefined),
        holdMs: pending.workerExecutionMs ?? (pending.diagnostic.startedAt === undefined ? undefined : completedAt - pending.diagnostic.startedAt),
        requestId,
      });
    };
    if (message.type === "result") {
      finishDiagnostic("success");
      pending.resolve(message.value);
      return;
    }
    finishDiagnostic("failure");
    const error = message.outcome === "unknown"
      ? new StorageWorkerUnknownOutcomeError(message.message)
      : rehydrateStorageWorkerError(message);
    error.name = message.name;
    if (message.stack) {
      error.stack = message.stack;
    }
    pending.reject(error);
  }

  private rejectPending(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(requestId);
    if (pending.diagnostic) {
      const completedAt = pending.diagnostic.clock();
      emitStorageOperationDiagnostic(this.diagnosticSink, {
        operation: pending.operation,
        correlationId: pending.diagnostic.correlationId,
        generationId: this.generationId,
        stage: "completed",
        outcome: "failure",
        waitMs: pending.workerQueueWaitMs ?? (pending.diagnostic.startedAt === undefined ? completedAt - pending.diagnostic.queuedAt : undefined),
        holdMs: pending.workerExecutionMs ?? (pending.diagnostic.startedAt === undefined ? undefined : completedAt - pending.diagnostic.startedAt),
        requestId,
      });
    }
    pending.reject(error);
  }

  private rejectAllPending(error: Error): void {
    for (const requestId of [...this.pending.keys()]) this.rejectPending(requestId, error);
  }

  private rejectPendingForWorkerExit(message: string): void {
    for (const requestId of [...this.pending.keys()]) {
      const pending = this.pending.get(requestId);
      this.rejectPending(requestId, pending?.sent && pending.mutation
        ? new StorageWorkerUnknownOutcomeError(message)
        : new StorageWorkerGenerationError(message));
    }
  }

  private fail(error: unknown): void {
    if (this.faulted) {
      return;
    }
    this.faulted = true;
    this.closed = true;
    this.ready = false;
    for (const [requestId, pending] of [...this.pending]) {
      this.rejectPending(requestId, pending.sent && pending.mutation
        ? new StorageWorkerUnknownOutcomeError(error instanceof Error ? error.message : String(error))
        : error instanceof Error ? error : new Error(String(error)));
    }
    for (const request of this.queued.splice(0)) {
      this.rejectPending(
        request.type === "call" ? request.context.requestId : request.requestId,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    void this.terminateWorker();
  }

  private terminateWorker(): Promise<number> {
    if (!this.terminationPromise) {
      this.terminationPromise = this.worker.terminate();
    }
    return this.terminationPromise;
  }
}

function isStructuredCloneError(error: unknown): boolean {
  return error instanceof Error && error.name === "DataCloneError";
}

function rehydrateStorageWorkerError(message: Extract<StorageWorkerMessage, { type: "error" }>): Error {
  const details = message.details ?? {};
  let error: Error;
  switch (message.code) {
    case "MEMORY_V6_IDEMPOTENCY_CONFLICT": error = new MemoryV6IdempotencyConflictError(); break;
    case "MEMORY_V6_ENTRY_NOT_FOUND": error = new MemoryV6EntryNotFoundError(String(details.entryId ?? "unknown")); break;
    case "MEMORY_V6_FILE_QUOTA_EXCEEDED": error = new MemoryV6FileQuotaExceededError(Number(details.quotaBytes ?? 0), Number(details.usedBytes ?? 0), Number(details.incomingBytes ?? 0)); break;
    case "CHARACTER_AFFECT_VERSION_CONFLICT": error = new CharacterAffectVersionConflictError(String(details.expectedVersion ?? ""), String(details.actualVersion ?? "")); break;
    case "CHARACTER_AFFECT_IDEMPOTENCY_CONFLICT": error = new CharacterAffectIdempotencyConflictError(); break;
    default: return new StorageWorkerRemoteError(message.message, message.code, message.outcome, message.details);
  }
  error.name = message.name || error.name;
  return error;
}
