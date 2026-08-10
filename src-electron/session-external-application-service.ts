import { createHash } from "node:crypto";

import {
  SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
  SESSION_RUNTIME_DEFAULT_WAIT_TIMEOUT_MS,
  SessionRuntimeValidationError,
  createSessionRuntimeError,
  createSessionRuntimeResult,
  parseSessionRuntimeRequestEnvelope,
  projectSessionExecution,
  type SessionRuntimeEnqueueInput,
  type SessionRuntimeError,
  type SessionRuntimeExecutionInput,
  type SessionRuntimeListInput,
  type SessionRuntimeOperation,
  type SessionRuntimeResultEnvelope,
  type SessionRuntimeRunInput,
} from "../src/session-external-runtime-contract.js";
import type { SessionExecution } from "../src/session-execution.js";
import {
  SessionExecutionNotFoundError,
  SessionExecutionOwnerMismatchError,
  type SessionExecutionService,
} from "./session-execution-service.js";
import {
  SessionExecutionBusyError,
  SessionExecutionIdempotencyConflictError,
  SessionExecutionQueueFullError,
  SessionExecutionStateConflictError,
} from "./session-execution-storage-v6.js";

export type SessionExternalApplicationServiceDeps = {
  executionService: Pick<SessionExecutionService, "run" | "enqueue" | "get" | "list" | "cancel" | "waitForTerminal">;
  currentCatalogRevision(): number;
};

export type SessionExternalApplicationResponse = SessionRuntimeResultEnvelope | SessionRuntimeError;

export class SessionExternalApplicationService {
  constructor(private readonly deps: SessionExternalApplicationServiceDeps) {}

  async execute(operation: SessionRuntimeOperation | string, input: unknown): Promise<SessionExternalApplicationResponse> {
    try {
      const request = parseSessionRuntimeRequestEnvelope({
        schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
        operation,
        input,
      });
      const result = await this.executeValidated(request.operation, request.input);
      return createSessionRuntimeResult(request.operation, result);
    } catch (error) {
      return mapApplicationError(error);
    }
  }

  private async executeValidated(operation: SessionRuntimeOperation, input: unknown): Promise<unknown> {
    if (operation === "turn.run") {
      return this.run(input as SessionRuntimeRunInput);
    }
    if (operation === "turn.enqueue") {
      return this.enqueue(input as SessionRuntimeEnqueueInput);
    }
    if (operation === "turn.list") {
      return this.list(input as SessionRuntimeListInput);
    }
    if (operation === "turn.get") {
      const request = input as SessionRuntimeExecutionInput;
      return projectSessionExecution(this.deps.executionService.get(request.sessionId, request.executionId));
    }
    if (operation === "turn.cancel") {
      const request = input as SessionRuntimeExecutionInput;
      return projectSessionExecution(await this.deps.executionService.cancel(request));
    }
    throw new SessionRuntimeValidationError("Unsupported Session runtime operation.", { field: "operation" });
  }

  private async run(input: SessionRuntimeRunInput): Promise<SessionExecution> {
    this.requireCurrentCatalog(input.catalogRevision);
    const execution = await this.deps.executionService.run({
      sessionId: input.sessionId,
      request: input.turn,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprintMutation(input),
    });
    if (input.responseMode === "deferred") {
      return projectSessionExecution(execution);
    }
    const timeoutMs = input.waitTimeoutMs ?? SESSION_RUNTIME_DEFAULT_WAIT_TIMEOUT_MS;
    return projectSessionExecution(await waitWithoutCancel(
      this.deps.executionService.waitForTerminal(input.sessionId, execution.id),
      timeoutMs,
      execution,
    ));
  }

  private async enqueue(input: SessionRuntimeEnqueueInput): Promise<SessionExecution> {
    this.requireCurrentCatalog(input.catalogRevision);
    return projectSessionExecution(await this.deps.executionService.enqueue({
      sessionId: input.sessionId,
      request: input.turn,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprintMutation(input),
    }));
  }

  private list(input: SessionRuntimeListInput): { items: SessionExecution[]; nextCursor?: string } {
    const offset = input.cursor ? decodeListCursor(input.cursor, input.sessionId) : 0;
    const all = this.deps.executionService.list(input.sessionId);
    const items = all.slice(offset, offset + input.limit).map(projectSessionExecution);
    const nextOffset = offset + items.length;
    return {
      items,
      ...(nextOffset < all.length ? { nextCursor: encodeListCursor(input.sessionId, nextOffset) } : {}),
    };
  }

  private requireCurrentCatalog(catalogRevision: number): void {
    if (catalogRevision !== this.deps.currentCatalogRevision()) {
      throw new SessionRuntimeValidationError(
        "The model catalog revision is stale.",
        { field: "catalogRevision", catalogRevision },
        "CATALOG_REVISION_STALE",
      );
    }
  }
}

function fingerprintMutation(input: SessionRuntimeEnqueueInput): string {
  return createHash("sha256").update(stableJson({
    sessionId: input.sessionId,
    catalogRevision: input.catalogRevision,
    turn: input.turn,
  }), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function waitWithoutCancel(
  pending: Promise<SessionExecution>,
  timeoutMs: number,
  fallback: SessionExecution,
): Promise<SessionExecution> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    timer.unref?.();
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function encodeListCursor(sessionId: string, offset: number): string {
  return Buffer.from(JSON.stringify({ version: 1, operation: "turn.list", sessionId, offset }), "utf8").toString("base64url");
}

function decodeListCursor(cursor: string, sessionId: string): number {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      value.version !== 1
      || value.operation !== "turn.list"
      || value.sessionId !== sessionId
      || !Number.isSafeInteger(value.offset)
      || (value.offset as number) < 0
    ) {
      throw new Error("invalid cursor");
    }
    return value.offset as number;
  } catch {
    throw new SessionRuntimeValidationError("The pagination cursor is invalid.", { field: "cursor" }, "INVALID_CURSOR");
  }
}

function mapApplicationError(error: unknown): SessionRuntimeError {
  if (error instanceof SessionRuntimeValidationError) {
    return createSessionRuntimeError({
      code: error.code,
      message: error.message,
      retryable: error.code === "CATALOG_REVISION_STALE",
      details: error.details,
    });
  }
  if (error instanceof SessionExecutionQueueFullError) {
    return createSessionRuntimeError({ code: "QUEUE_FULL", message: "The Session execution queue is full." });
  }
  if (error instanceof SessionExecutionBusyError) {
    return createSessionRuntimeError({ code: "SESSION_BUSY", message: "The Session already has an active execution." });
  }
  if (error instanceof SessionExecutionIdempotencyConflictError) {
    return createSessionRuntimeError({ code: "IDEMPOTENCY_CONFLICT", message: "The idempotency key was reused with different input." });
  }
  if (error instanceof SessionExecutionNotFoundError || error instanceof SessionExecutionOwnerMismatchError) {
    return createSessionRuntimeError({ code: "EXECUTION_NOT_FOUND", message: "The Session execution was not found." });
  }
  if (error instanceof SessionExecutionStateConflictError) {
    return createSessionRuntimeError({ code: "EXECUTION_NOT_CANCELLABLE", message: "The Session execution cannot be canceled in its current state." });
  }
  if (error instanceof TypeError) {
    return createSessionRuntimeError({ code: "INVALID_INPUT", message: "The Session operation input is invalid." });
  }
  return createSessionRuntimeError({
    code: "RUNTIME_UNAVAILABLE",
    message: "The Session operation could not be completed.",
    retryable: true,
    effect: "indeterminate",
  });
}
