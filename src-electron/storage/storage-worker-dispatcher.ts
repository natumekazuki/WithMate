import type {
  StorageWorkerCallRequest,
  StorageWorkerErrorMessage,
  StorageWorkerRequestContext,
} from "./storage-worker-protocol.js";
import {
  MemoryV6EntryNotFoundError,
  MemoryV6FileQuotaExceededError,
  MemoryV6IdempotencyConflictError,
} from "../memory/memory-v6-storage.js";
import { CharacterAffectIdempotencyConflictError, CharacterAffectVersionConflictError } from "../character/character-affect-storage.js";

export type StorageWorkerHandlerContext = StorageWorkerRequestContext & {
  reportProgress(progress: unknown): void;
};

export type StorageWorkerCommandHandler = (
  payload: unknown,
  context: StorageWorkerHandlerContext,
) => unknown | Promise<unknown>;

export type StorageWorkerCommandHandlers = Readonly<Record<string, StorageWorkerCommandHandler>>;

export class StorageWorkerCommandNotAllowedError extends Error {
  readonly code = "STORAGE_WORKER_COMMAND_NOT_ALLOWED";

  constructor(message: string) {
    super(message);
    this.name = "StorageWorkerCommandNotAllowedError";
  }
}

export async function dispatchStorageWorkerCall(
  handlers: StorageWorkerCommandHandlers,
  request: StorageWorkerCallRequest,
  context: Pick<StorageWorkerHandlerContext, "reportProgress"> = { reportProgress: () => {} },
): Promise<unknown> {
  if (!Object.prototype.hasOwnProperty.call(handlers, request.command)) {
    throw new StorageWorkerCommandNotAllowedError(`Storage worker command is not allowed: ${request.command}`);
  }
  const handler = handlers[request.command];
  if (!handler) {
    throw new StorageWorkerCommandNotAllowedError(`Storage worker command is not allowed: ${request.command}`);
  }
  return handler(request.payload, { ...request.context, ...context });
}

export function serializeStorageWorkerError(
  requestId: string,
  generationId: string,
  error: unknown,
  outcome: "not-executed" | "rejected" | "unknown" = "unknown",
): StorageWorkerErrorMessage {
  const normalized = error instanceof Error ? error : new Error(String(error));
  let code = "STORAGE_WORKER_COMMAND_FAILED";
  let details: Record<string, string | number> | undefined;
  if (normalized instanceof StorageWorkerCommandNotAllowedError) {
    code = normalized.code;
  } else if (normalized instanceof MemoryV6IdempotencyConflictError) {
    code = "MEMORY_V6_IDEMPOTENCY_CONFLICT";
  } else if (normalized instanceof MemoryV6EntryNotFoundError) {
    code = "MEMORY_V6_ENTRY_NOT_FOUND";
    const entryId = normalized.message.match(/: (.*)$/)?.[1];
    if (entryId) details = { entryId };
  } else if (normalized instanceof MemoryV6FileQuotaExceededError) {
    code = "MEMORY_V6_FILE_QUOTA_EXCEEDED";
    details = { quotaBytes: normalized.quotaBytes, usedBytes: normalized.usedBytes, incomingBytes: normalized.incomingBytes, availableBytes: normalized.availableBytes };
  } else if (normalized instanceof CharacterAffectVersionConflictError) {
    code = "CHARACTER_AFFECT_VERSION_CONFLICT";
    details = { expectedVersion: normalized.expectedVersion, actualVersion: normalized.actualVersion };
  } else if (normalized instanceof CharacterAffectIdempotencyConflictError) {
    code = "CHARACTER_AFFECT_IDEMPOTENCY_CONFLICT";
  }
  // Domain rejections are known outcomes (and may persist rejection telemetry).
  // An arbitrary exception after a mutation remains an unknown write outcome.
  if (normalized instanceof StorageWorkerCommandNotAllowedError) outcome = "not-executed";
  else if (code !== "STORAGE_WORKER_COMMAND_FAILED") outcome = "rejected";
  return {
    type: "error",
    requestId,
    generationId,
    name: normalized.name,
    message: normalized.message,
    code,
    outcome,
    ...(normalized.stack ? { stack: normalized.stack } : {}),
    ...(details ? { details } : {}),
  };
}
