import { createHash } from "node:crypto";
import path from "node:path";

import type {
  ApplicationAccessValidator,
  ApplicationDomainError,
  ApplicationOperationOptions,
  ApplicationOperationResponse,
  ApplicationPersistenceStatus,
  ApplicationSessionCloseRequest,
  ApplicationSessionCreateRequest,
  ApplicationSessionCreateResult,
  ApplicationSessionListRequest,
  ApplicationSessionOperation,
  ApplicationSessionOperations,
  ApplicationSessionPage,
  ApplicationSessionReadRequest,
  ApplicationSessionReadResult,
  ApplicationSessionTransitionResult,
  ApplicationSessionWriteRequest,
} from "../shared/application-service-model.js";
import type { PersistenceError } from "../shared/persistence-protocol.js";
import { isCanonicalUuid } from "../shared/persistence-runtime-protocol.js";
import type { PageOmission, SessionDetail, SessionListItem } from "../shared/repository-read-model.js";
import type {
  RepositoryCommandError,
  RepositoryCommandResult,
  SessionCreateResult,
  SessionLifecycleStatus,
  SessionTransitionResult,
} from "../shared/repository-write-model.js";
import { PersistenceClientError } from "./persistence-worker-client.js";
import type { RepositoryReadClient } from "./repository-read-client.js";
import type { RepositoryWriteClient } from "./repository-write-client.js";

type SessionReadPort = Pick<RepositoryReadClient, "sessionsPage" | "sessionGet">;
type SessionWritePort = Pick<RepositoryWriteClient, "createSession" | "transitionSession">;

type RequestDecodeResult<TValue> =
  Readonly<{ ok: true; value: TValue }> | Readonly<{ ok: false; response: ApplicationOperationResponse<never> }>;

export type ApplicationSessionServiceOptions<TAuthorizationContext> = Readonly<{
  reads: SessionReadPort;
  writes: SessionWritePort;
  access: ApplicationAccessValidator<TAuthorizationContext>;
}>;

export class ApplicationSessionService<
  TAuthorizationContext,
> implements ApplicationSessionOperations<TAuthorizationContext> {
  readonly #reads: SessionReadPort;
  readonly #writes: SessionWritePort;
  readonly #access: ApplicationAccessValidator<TAuthorizationContext>;

  constructor(options: ApplicationSessionServiceOptions<TAuthorizationContext>) {
    this.#reads = options.reads;
    this.#writes = options.writes;
    this.#access = options.access;
  }

  async create(
    request: ApplicationSessionCreateRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionCreateResult>> {
    const decoded = decodeCreateRequest<TAuthorizationContext>(request);
    if (!decoded.ok) return decoded.response;
    const input = decoded.value;
    const denied = await this.#validateAccess("create", "write", input.context);
    if (denied !== undefined) return denied;

    try {
      const result = await this.#writes.createSession(
        {
          idempotencyKey: input.idempotencyKey,
          session: {
            id: issueSessionId(input.idempotencyKey),
            providerId: input.providerId,
            workspaceKey: input.context.workspaceKey,
            allowedAdditionalDirectories: input.allowedAdditionalDirectories,
            defaultCharacterId: input.defaultCharacterId,
            maxConcurrentChildRuns: input.maxConcurrentChildRuns,
          },
        },
        options,
      );
      return mapWriteResult<SessionCreateResult, ApplicationSessionCreateResult>(result, (value) => ({
        sessionId: value.sessionId,
        workspaceKey: value.workspaceKey,
        lifecycleStatus: value.lifecycleStatus,
        createdAt: value.createdAt,
      }));
    } catch (error) {
      return mapThrownFailure(error, "write");
    }
  }

  async list(
    request: ApplicationSessionListRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionPage>> {
    const decoded = decodeListRequest<TAuthorizationContext>(request);
    if (!decoded.ok) return decoded.response;
    const input = decoded.value;
    const denied = await this.#validateAccess("list", "read", input.context);
    if (denied !== undefined) return denied;

    try {
      const page = await this.#reads.sessionsPage(
        {
          workspaceKey: input.context.workspaceKey,
          ...(input.lifecycleStatus === undefined ? {} : { lifecycleStatus: input.lifecycleStatus }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        },
        options,
      );
      const items: SessionListItem[] = [];
      const omissions: PageOmission[] = [];
      for (const item of page.items) {
        if (isPageOmission(item)) omissions.push(item);
        else items.push(projectSessionListItem(item));
      }
      const value: ApplicationSessionPage =
        page.nextCursor === undefined ? { items } : { items, nextCursor: page.nextCursor };
      if (omissions.length === 0) {
        return { overallStatus: "success", value, persistence: { status: "read", effect: "none" } };
      }
      return {
        overallStatus: "partial_success",
        value,
        issues: omissions.map((omission) =>
          omission.ordinal === undefined
            ? {
                kind: "omission",
                code: "response_size_limit",
                message: "A Session list item was omitted because the response size limit was reached.",
              }
            : {
                kind: "omission",
                code: "response_size_limit",
                message: "A Session list item was omitted because the response size limit was reached.",
                ordinal: omission.ordinal,
              },
        ),
        persistence: { status: "read", effect: "none" },
      };
    } catch (error) {
      return mapThrownFailure(error, "read");
    }
  }

  async read(
    request: ApplicationSessionReadRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionReadResult>> {
    const decoded = decodeReadRequest<TAuthorizationContext>(request);
    if (!decoded.ok) return decoded.response;
    const input = decoded.value;
    const denied = await this.#validateAccess("read", "read", input.context);
    if (denied !== undefined) return denied;

    try {
      const repositoryValue = await this.#reads.sessionGet(
        { workspaceKey: input.context.workspaceKey, sessionId: input.sessionId },
        options,
      );
      const value = projectSessionReadResult(repositoryValue);
      return { overallStatus: "success", value, persistence: { status: "read", effect: "none" } };
    } catch (error) {
      return mapThrownFailure(error, "read");
    }
  }

  archive(
    request: ApplicationSessionWriteRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionTransitionResult>> {
    const decoded = decodeWriteRequest<TAuthorizationContext>(request);
    if (!decoded.ok) return Promise.resolve(decoded.response);
    return this.#transition("archive", decoded.value, "active", "archived", options);
  }

  unarchive(
    request: ApplicationSessionWriteRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionTransitionResult>> {
    const decoded = decodeWriteRequest<TAuthorizationContext>(request);
    if (!decoded.ok) return Promise.resolve(decoded.response);
    return this.#transition("unarchive", decoded.value, "archived", "active", options);
  }

  close(
    request: ApplicationSessionCloseRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionTransitionResult>> {
    const decoded = decodeCloseRequest<TAuthorizationContext>(request);
    if (!decoded.ok) return Promise.resolve(decoded.response);
    return this.#transition("close", decoded.value, decoded.value.expectedLifecycleStatus, "closed", options);
  }

  async #transition(
    operation: "archive" | "unarchive" | "close",
    request: ApplicationSessionWriteRequest<TAuthorizationContext>,
    expectedLifecycleStatus: "active" | "archived",
    targetLifecycleStatus: SessionLifecycleStatus,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionTransitionResult>> {
    const denied = await this.#validateAccess(operation, "write", request.context);
    if (denied !== undefined) return denied;

    try {
      const result = await this.#writes.transitionSession(
        {
          sessionId: request.sessionId,
          workspaceKey: request.context.workspaceKey,
          idempotencyKey: request.idempotencyKey,
          expectedLifecycleStatus,
          targetLifecycleStatus,
        },
        options,
      );
      return mapWriteResult<SessionTransitionResult, ApplicationSessionTransitionResult>(result, (value) => ({
        sessionId: value.sessionId,
        lifecycleStatus: value.lifecycleStatus,
        updatedAt: value.updatedAt,
      }));
    } catch (error) {
      return mapThrownFailure(error, "write");
    }
  }

  async #validateAccess(
    operation: ApplicationSessionOperation,
    access: "read" | "write",
    context: ApplicationSessionCreateRequest<TAuthorizationContext>["context"],
  ): Promise<ApplicationOperationResponse<never> | undefined> {
    try {
      const input = { operation, access, context } as const;
      const workspace = await this.#access.validateWorkspace(input);
      if (!workspace.allowed) return accessFailure(workspace.error);
      const authorization = await this.#access.authorize(input);
      if (!authorization.allowed) return accessFailure(authorization.error);
      return undefined;
    } catch {
      return applicationFailure({ status: "not_attempted", effect: "none" });
    }
  }
}

function decodeCreateRequest<TAuthorizationContext>(
  request: unknown,
): RequestDecodeResult<ApplicationSessionCreateRequest<TAuthorizationContext>> {
  if (
    !isPlainObject(request) ||
    !hasOnlyKeys(request, [
      "context",
      "idempotencyKey",
      "providerId",
      "allowedAdditionalDirectories",
      "defaultCharacterId",
      "maxConcurrentChildRuns",
    ]) ||
    !isCanonicalIdempotencyKey(request.idempotencyKey) ||
    !isBoundedString(request.providerId) ||
    !isBoundedString(request.defaultCharacterId) ||
    !isAllowedAdditionalDirectories(request.allowedAdditionalDirectories) ||
    !isNonNegativeSafeInteger(request.maxConcurrentChildRuns)
  ) {
    return decodeRequestFailure();
  }
  const context = decodeOperationContext<TAuthorizationContext>(request.context);
  if (context === undefined) return decodeRequestFailure();
  return {
    ok: true,
    value: {
      context,
      idempotencyKey: request.idempotencyKey,
      providerId: request.providerId,
      allowedAdditionalDirectories: [...request.allowedAdditionalDirectories],
      defaultCharacterId: request.defaultCharacterId,
      maxConcurrentChildRuns: request.maxConcurrentChildRuns,
    },
  };
}

function decodeWriteRequest<TAuthorizationContext>(
  request: unknown,
): RequestDecodeResult<ApplicationSessionWriteRequest<TAuthorizationContext>> {
  if (
    !isPlainObject(request) ||
    !hasOnlyKeys(request, ["context", "sessionId", "idempotencyKey"]) ||
    !isBoundedString(request.sessionId) ||
    !isCanonicalIdempotencyKey(request.idempotencyKey)
  ) {
    return decodeRequestFailure();
  }
  const context = decodeOperationContext<TAuthorizationContext>(request.context);
  if (context === undefined) return decodeRequestFailure();
  return { ok: true, value: { context, sessionId: request.sessionId, idempotencyKey: request.idempotencyKey } };
}

function decodeListRequest<TAuthorizationContext>(
  request: unknown,
): RequestDecodeResult<ApplicationSessionListRequest<TAuthorizationContext>> {
  if (
    !isPlainObject(request) ||
    !hasOnlyKeys(request, ["context", "lifecycleStatus", "cursor", "limit"]) ||
    (request.lifecycleStatus !== undefined && !isSessionLifecycleStatus(request.lifecycleStatus)) ||
    (request.cursor !== undefined && !isBoundedStringWithLimit(request.cursor, 2_048)) ||
    (request.limit !== undefined &&
      (!Number.isSafeInteger(request.limit) || (request.limit as number) < 1 || (request.limit as number) > 100))
  ) {
    return decodeRequestFailure();
  }
  const context = decodeOperationContext<TAuthorizationContext>(request.context);
  if (context === undefined) return decodeRequestFailure();
  return {
    ok: true,
    value: {
      context,
      ...(request.lifecycleStatus === undefined ? {} : { lifecycleStatus: request.lifecycleStatus }),
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      ...(request.limit === undefined ? {} : { limit: request.limit as number }),
    },
  };
}

function decodeReadRequest<TAuthorizationContext>(
  request: unknown,
): RequestDecodeResult<ApplicationSessionReadRequest<TAuthorizationContext>> {
  if (
    !isPlainObject(request) ||
    !hasOnlyKeys(request, ["context", "sessionId"]) ||
    !isBoundedString(request.sessionId)
  ) {
    return decodeRequestFailure();
  }
  const context = decodeOperationContext<TAuthorizationContext>(request.context);
  if (context === undefined) return decodeRequestFailure();
  return { ok: true, value: { context, sessionId: request.sessionId } };
}

function decodeCloseRequest<TAuthorizationContext>(
  request: unknown,
): RequestDecodeResult<ApplicationSessionCloseRequest<TAuthorizationContext>> {
  if (
    !isPlainObject(request) ||
    !hasOnlyKeys(request, ["context", "sessionId", "idempotencyKey", "expectedLifecycleStatus"]) ||
    !isBoundedString(request.sessionId) ||
    !isCanonicalIdempotencyKey(request.idempotencyKey) ||
    (request.expectedLifecycleStatus !== "active" && request.expectedLifecycleStatus !== "archived")
  ) {
    return decodeRequestFailure();
  }
  const context = decodeOperationContext<TAuthorizationContext>(request.context);
  if (context === undefined) return decodeRequestFailure();
  return {
    ok: true,
    value: {
      context,
      sessionId: request.sessionId,
      idempotencyKey: request.idempotencyKey,
      expectedLifecycleStatus: request.expectedLifecycleStatus,
    },
  };
}

function decodeOperationContext<TAuthorizationContext>(
  context: unknown,
): ApplicationSessionCreateRequest<TAuthorizationContext>["context"] | undefined {
  if (
    !isPlainObject(context) ||
    !hasOnlyKeys(context, ["workspaceKey", "authorization"]) ||
    !Object.hasOwn(context, "authorization") ||
    !isBoundedString(context.workspaceKey)
  ) {
    return undefined;
  }
  try {
    return {
      workspaceKey: context.workspaceKey,
      authorization: structuredClone(context.authorization) as TAuthorizationContext,
    };
  } catch {
    return undefined;
  }
}

function decodeRequestFailure<TValue>(): RequestDecodeResult<TValue> {
  return { ok: false, response: requestFailure() };
}

function requestFailure(): ApplicationOperationResponse<never> {
  return {
    overallStatus: "failure",
    error: {
      kind: "request",
      code: "request_invalid",
      message: "Application operation request is invalid.",
      retryable: false,
    },
    persistence: { status: "not_attempted", effect: "none" },
  };
}

function accessFailure(
  error: Readonly<{
    code: "workspace_invalid" | "workspace_unavailable" | "authorization_invalid" | "forbidden";
    message: string;
    retryable: boolean;
  }>,
): ApplicationOperationResponse<never> {
  return {
    overallStatus: "failure",
    error: {
      kind: "access",
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    },
    persistence: { status: "not_attempted", effect: "none" },
  };
}

function applicationFailure(persistence: ApplicationPersistenceStatus): ApplicationOperationResponse<never> {
  return {
    overallStatus: "failure",
    error: {
      kind: "application",
      code: "internal_error",
      message: "Application Service could not complete the operation.",
      retryable: false,
    },
    persistence,
  };
}

function mapWriteResult<TRepositoryValue, TApplicationValue extends TRepositoryValue>(
  result: RepositoryCommandResult<TRepositoryValue>,
  mapValue: (value: TRepositoryValue) => TApplicationValue,
): ApplicationOperationResponse<TApplicationValue> {
  if (!result.ok) return domainFailure(result.error);
  return {
    overallStatus: "success",
    value: mapValue(result.value),
    persistence: { status: "committed", effect: "none", replayed: result.replayed },
  };
}

function domainFailure(error: RepositoryCommandError | ApplicationDomainError): ApplicationOperationResponse<never> {
  const projectedError: ApplicationDomainError =
    error.code === "capacity_exceeded" && error.details !== undefined
      ? {
          kind: "domain",
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          details: projectCapacityExceededDetails(error.details),
        }
      : {
          kind: "domain",
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        };
  return {
    overallStatus: "failure",
    error: projectedError,
    persistence: { status: "rejected", effect: "none" },
  };
}

function mapThrownFailure(error: unknown, requestClass: "read" | "write"): ApplicationOperationResponse<never> {
  if (!(error instanceof PersistenceClientError)) {
    return applicationFailure({ status: "failed", effect: requestClass === "write" ? "unknown" : "none" });
  }
  const persistenceError = error.persistenceError;
  if (requestClass === "read" && isReadDomainError(persistenceError)) {
    return domainFailure({
      kind: "domain",
      code: persistenceError.code,
      message: persistenceError.message,
      retryable: persistenceError.retryable,
    });
  }
  return {
    overallStatus: "failure",
    error: {
      kind: "persistence",
      code: mapPersistenceErrorCode(persistenceError.code),
      message: persistenceError.message,
      retryable: persistenceError.retryable,
      effect: persistenceError.effect,
    },
    persistence: { status: "failed", effect: persistenceError.effect },
  };
}

function mapPersistenceErrorCode(
  code: PersistenceError["code"],
):
  | "persistence_unavailable"
  | "persistence_busy"
  | "persistence_timeout"
  | "persistence_canceled"
  | "persistence_configuration_invalid"
  | "persistence_integrity_failed"
  | "persistence_response_too_large"
  | "persistence_operation_failed" {
  switch (code) {
    case "worker_not_ready":
    case "worker_closing":
    case "worker_crashed":
    case "worker_start_failed":
    case "worker_shutdown_forced":
    case "database_unavailable":
      return "persistence_unavailable";
    case "queue_full":
    case "database_busy":
      return "persistence_busy";
    case "request_timeout":
      return "persistence_timeout";
    case "request_canceled":
      return "persistence_canceled";
    case "database_path_invalid":
    case "database_identity_mismatch":
    case "database_schema_unknown":
    case "database_schema_too_new":
    case "database_schema_too_old":
    case "database_pragma_mismatch":
    case "database_wal_unavailable":
    case "database_bootstrap_failed":
    case "schema_artifact_invalid":
      return "persistence_configuration_invalid";
    case "database_schema_verification_failed":
    case "database_integrity_check_failed":
      return "persistence_integrity_failed";
    case "response_too_large":
      return "persistence_response_too_large";
    case "protocol_invalid":
    case "protocol_version_unsupported":
    case "request_id_duplicate":
    case "request_invalid":
    case "cursor_invalid":
    case "not_found":
    case "operation_not_supported":
    case "payload_chunk_invalid":
    case "payload_chunk_too_large":
    case "operation_failed":
    case "internal_error":
      return "persistence_operation_failed";
  }
}

function isReadDomainError(
  error: PersistenceError,
): error is PersistenceError & { code: "request_invalid" | "cursor_invalid" | "not_found" } {
  return error.code === "request_invalid" || error.code === "cursor_invalid" || error.code === "not_found";
}

function issueSessionId(idempotencyKey: string): string {
  return `session_${createHash("sha256").update(`withmate.application.session.v1\0${idempotencyKey}`, "utf8").digest("hex")}`;
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024;
}

function isCanonicalIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && isCanonicalUuid(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isSessionLifecycleStatus(value: unknown): value is SessionLifecycleStatus {
  return value === "active" || value === "archived" || value === "closed";
}

function projectCapacityExceededDetails(
  details: NonNullable<ApplicationDomainError["details"]>,
): NonNullable<ApplicationDomainError["details"]> {
  switch (details.scope) {
    case "root":
      return {
        scope: details.scope,
        rootSessionId: details.rootSessionId,
        current: details.current,
        limit: details.limit,
      };
    case "application":
      return { scope: details.scope, current: details.current, limit: details.limit };
    case "provider":
      return {
        scope: details.scope,
        providerId: details.providerId,
        current: details.current,
        limit: details.limit,
      };
  }
}

function isAllowedAdditionalDirectories(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > 1_024) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (
      !Object.hasOwn(value, index) ||
      !isBoundedStringWithLimit(value[index], 32_768) ||
      (!path.win32.isAbsolute(value[index]) && !path.posix.isAbsolute(value[index]))
    ) {
      return false;
    }
  }
  return Buffer.byteLength(JSON.stringify(value)) <= 4 * 1_024 * 1_024;
}

function isBoundedStringWithLimit(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function projectSessionListItem(item: SessionListItem): SessionListItem {
  return {
    id: item.id,
    workspaceKey: item.workspaceKey,
    defaultCharacterId: item.defaultCharacterId,
    lifecycleStatus: item.lifecycleStatus,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    lastActivityAt: item.lastActivityAt,
    executionState: item.executionState,
    ...(item.activeRunId === undefined ? {} : { activeRunId: item.activeRunId }),
    ...(item.latestRunId === undefined ? {} : { latestRunId: item.latestRunId }),
    stateChangedAt: item.stateChangedAt,
  };
}

function projectSessionReadResult(value: ApplicationSessionReadResult): ApplicationSessionReadResult {
  return {
    session: projectSessionDetail(value.session),
    execution: {
      state: value.execution.state,
      ...(value.execution.activeRunId === undefined ? {} : { activeRunId: value.execution.activeRunId }),
      ...(value.execution.latestRunId === undefined ? {} : { latestRunId: value.execution.latestRunId }),
    },
  };
}

function projectSessionDetail(session: SessionDetail): SessionDetail {
  return {
    id: session.id,
    providerId: session.providerId,
    workspaceKey: session.workspaceKey,
    allowedAdditionalDirectoriesByteLength: session.allowedAdditionalDirectoriesByteLength,
    allowedAdditionalDirectoriesState: session.allowedAdditionalDirectoriesState,
    ...(session.allowedAdditionalDirectories === undefined
      ? {}
      : { allowedAdditionalDirectories: [...session.allowedAdditionalDirectories] }),
    defaultCharacterId: session.defaultCharacterId,
    maxConcurrentChildRuns: session.maxConcurrentChildRuns,
    lifecycleStatus: session.lifecycleStatus,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastActivityAt: session.lastActivityAt,
  };
}

function isPageOmission(value: unknown): value is PageOmission {
  return typeof value === "object" && value !== null && "omitted" in value && value.omitted === true;
}
