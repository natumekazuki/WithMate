import { createHash } from "node:crypto";

import {
  SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
  SESSION_RUNTIME_DEFAULT_WAIT_TIMEOUT_MS,
  SESSION_RUNTIME_MAX_RESPONSE_BYTES,
  SessionRuntimeProjectionLimitError,
  SessionRuntimeValidationError,
  createSessionRuntimeError,
  createSessionRuntimeResult,
  parseSessionRuntimeRequestEnvelope,
  projectSessionExecution,
  type SessionRuntimeCancelInput,
  type SessionRuntimeCatalogResult,
  type SessionRuntimeCreateInput,
  type SessionRuntimeEnqueueInput,
  type SessionRuntimeError,
  type SessionRuntimeExecutionInput,
  type SessionRuntimeListInput,
  type SessionRuntimeOperation,
  type SessionRuntimeResultEnvelope,
  type SessionRuntimeRunInput,
  type SessionRuntimeRenameInput,
  type SessionRuntimeSessionInput,
  type SessionRuntimeSessionListInput,
} from "../src/session-external-runtime-contract.js";
import type { ModelCatalogSnapshot } from "../src/model-catalog.js";
import type { SessionExecution } from "../src/session-execution.js";
import { SessionTurnValidationError } from "./session-turn-validation-error.js";
import {
  SessionExecutionNotFoundError,
  SessionExecutionOwnerMismatchError,
  SessionExecutionShuttingDownError,
  type SessionExecutionService,
} from "./session-execution-service.js";
import {
  SessionExecutionBusyError,
  SessionExecutionIdempotencyConflictError,
  SessionExecutionQueueFullError,
  SessionExecutionStateConflictError,
} from "./session-execution-storage-v6.js";
import { SessionCrudError, type SessionCrudService } from "./session-crud-service.js";

export type SessionExternalApplicationServiceDeps = {
  executionService: Pick<
    SessionExecutionService,
    "beginShutdown" | "run" | "enqueue" | "get" | "listPage" | "cancel" | "waitForTerminal" | "resolveReplay"
  >;
  crudService: Pick<SessionCrudService, "create" | "list" | "get" | "rename">;
  currentModelCatalog(): ModelCatalogSnapshot | null;
};

export type SessionExternalApplicationResponse = SessionRuntimeResultEnvelope | SessionRuntimeError;

export class SessionExternalApplicationService {
  private accepting = true;

  constructor(private readonly deps: SessionExternalApplicationServiceDeps) {}

  beginShutdown(): void {
    this.accepting = false;
    this.deps.executionService.beginShutdown();
  }

  async execute(operation: SessionRuntimeOperation | string, input: unknown): Promise<SessionExternalApplicationResponse> {
    if (!this.accepting) {
      return createSessionRuntimeError({
        code: "RUNTIME_SHUTTING_DOWN",
        message: "The Session runtime is shutting down.",
      });
    }
    try {
      const request = parseSessionRuntimeRequestEnvelope({
        schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
        operation,
        input,
      });
      const result = await this.executeValidated(request.operation, request.input);
      return createSessionRuntimeResult(request.operation, result);
    } catch (error) {
      return mapApplicationError(error, operation);
    }
  }

  private async executeValidated(operation: SessionRuntimeOperation, input: unknown): Promise<unknown> {
    if (operation === "runtime.catalog") {
      return projectRuntimeCatalog(this.requireCurrentModelCatalog());
    }
    if (operation === "session.create") {
      return this.deps.crudService.create(input as SessionRuntimeCreateInput);
    }
    if (operation === "session.list") {
      return this.deps.crudService.list(input as SessionRuntimeSessionListInput);
    }
    if (operation === "session.get") {
      return this.deps.crudService.get((input as SessionRuntimeSessionInput).sessionId);
    }
    if (operation === "session.rename") {
      return this.deps.crudService.rename(input as SessionRuntimeRenameInput);
    }
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
      const request = input as SessionRuntimeCancelInput;
      return projectSessionExecution(await this.deps.executionService.cancel({
        ...request,
        requestFingerprint: fingerprintCancel(request),
      }));
    }
    throw new SessionRuntimeValidationError("Unsupported Session runtime operation.", { field: "operation" });
  }

  private async run(input: SessionRuntimeRunInput): Promise<SessionExecution> {
    const mutation = {
      sessionId: input.sessionId,
      request: { catalogRevision: input.catalogRevision, turn: input.turn },
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprintMutation(input),
    };
    const replay = this.deps.executionService.resolveReplay("turn.run", mutation);
    if (!replay) {
      this.requireCurrentCatalog(input.catalogRevision);
    }
    const execution = replay ?? await this.deps.executionService.run(mutation);
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
    const mutation = {
      sessionId: input.sessionId,
      request: { catalogRevision: input.catalogRevision, turn: input.turn },
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprintMutation(input),
    };
    const replay = this.deps.executionService.resolveReplay("turn.enqueue", mutation);
    if (!replay) {
      this.requireCurrentCatalog(input.catalogRevision);
    }
    return projectSessionExecution(replay ?? await this.deps.executionService.enqueue(mutation));
  }

  private list(input: SessionRuntimeListInput): { items: SessionExecution[]; nextCursor?: string } {
    const afterSequence = input.cursor ? decodeListCursor(input.cursor, input.sessionId) : null;
    const resultBase: { items: SessionExecution[]; nextCursor?: string } = {
      items: [] as SessionExecution[],
    };
    let responseBytes = Buffer.byteLength(JSON.stringify(createSessionRuntimeResult("turn.list", resultBase)), "utf8");
    let lastSequence: number | undefined;
    for (const execution of this.deps.executionService.listPage(input.sessionId, afterSequence, input.limit + 1)) {
      if (resultBase.items.length >= input.limit) {
        if (lastSequence !== undefined) {
          resultBase.nextCursor = encodeListCursor(input.sessionId, lastSequence);
          if (
            Buffer.byteLength(JSON.stringify(createSessionRuntimeResult("turn.list", resultBase)), "utf8")
            > SESSION_RUNTIME_MAX_RESPONSE_BYTES
          ) {
            throw new SessionRuntimeProjectionLimitError("result.items");
          }
        }
        break;
      }
      const item = projectSessionExecution(execution);
      responseBytes += (resultBase.items.length > 0 ? 1 : 0) + Buffer.byteLength(JSON.stringify(item), "utf8");
      if (responseBytes > SESSION_RUNTIME_MAX_RESPONSE_BYTES) {
        throw new SessionRuntimeProjectionLimitError("result.items");
      }
      resultBase.items.push(item);
      lastSequence = execution.sequence;
    }
    return resultBase;
  }

  private requireCurrentCatalog(catalogRevision: number): void {
    if (catalogRevision !== this.requireCurrentModelCatalog().revision) {
      throw new SessionRuntimeValidationError(
        "The model catalog revision is stale.",
        { field: "catalogRevision", catalogRevision },
        "CATALOG_REVISION_STALE",
      );
    }
  }

  private requireCurrentModelCatalog(): ModelCatalogSnapshot {
    const snapshot = this.deps.currentModelCatalog();
    if (!snapshot) {
      throw new SessionRuntimeValidationError(
        "The model catalog is unavailable.",
        {},
        "RUNTIME_UNAVAILABLE",
      );
    }
    return snapshot;
  }
}

function projectRuntimeCatalog(snapshot: ModelCatalogSnapshot): SessionRuntimeCatalogResult {
  return {
    revision: snapshot.revision,
    providers: snapshot.providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      defaultModelId: provider.defaultModelId,
      defaultReasoningEffort: provider.defaultReasoningEffort,
      models: provider.models.map((model) => ({
        id: model.id,
        label: model.label,
        reasoningEfforts: [...model.reasoningEfforts],
      })),
    })),
  };
}

function fingerprintMutation(input: SessionRuntimeEnqueueInput): string {
  return createHash("sha256").update(stableJson({
    sessionId: input.sessionId,
    catalogRevision: input.catalogRevision,
    turn: input.turn,
  }), "utf8").digest("hex");
}

function fingerprintCancel(input: SessionRuntimeCancelInput): string {
  return createHash("sha256").update(stableJson({
    sessionId: input.sessionId,
    executionId: input.executionId,
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

function encodeListCursor(sessionId: string, afterSequence: number): string {
  return Buffer.from(
    JSON.stringify({ version: 1, operation: "turn.list", sessionId, afterSequence }),
    "utf8",
  ).toString("base64url");
}

function decodeListCursor(cursor: string, sessionId: string): number {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      value.version !== 1
      || value.operation !== "turn.list"
      || value.sessionId !== sessionId
      || !Number.isSafeInteger(value.afterSequence)
      || (value.afterSequence as number) < 1
    ) {
      throw new Error("invalid cursor");
    }
    return value.afterSequence as number;
  } catch {
    throw new SessionRuntimeValidationError("The pagination cursor is invalid.", { field: "cursor" }, "INVALID_CURSOR");
  }
}

function mapApplicationError(error: unknown, operation: SessionRuntimeOperation | string): SessionRuntimeError {
  if (error instanceof SessionCrudError) {
    return createSessionRuntimeError({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    });
  }
  if (error instanceof SessionRuntimeProjectionLimitError) {
    return createSessionRuntimeError({
      code: error.code,
      message: error.message,
      effect: operation === "session.create"
        || operation === "session.rename"
        || operation === "turn.run"
        || operation === "turn.enqueue"
        || operation === "turn.cancel"
        ? "applied"
        : "not_applied",
      details: error.details,
    });
  }
  if (error instanceof SessionRuntimeValidationError) {
    return createSessionRuntimeError({
      code: error.code,
      message: error.message,
      retryable: error.code === "CATALOG_REVISION_STALE" || error.code === "RUNTIME_UNAVAILABLE",
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
  if (error instanceof SessionExecutionShuttingDownError) {
    return createSessionRuntimeError({ code: error.code, message: error.message });
  }
  if (error instanceof SessionTurnValidationError) {
    return createSessionRuntimeError({
      code: error.code,
      message: error.message,
      retryable: error.code === "CATALOG_REVISION_STALE",
    });
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
