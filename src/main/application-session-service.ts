import { createHash } from "node:crypto";

import type {
  ApplicationAccessDecision,
  ApplicationAccessValidationInput,
  ApplicationAccessValidator,
  ApplicationDomainError,
  ApplicationDomainErrorCode,
  ApplicationOperationOptions,
  ApplicationOperationResponse,
  ApplicationSessionCloseRequest,
  ApplicationSessionCreateRequest,
  ApplicationSessionCreateResult,
  ApplicationSessionDetail,
  ApplicationSessionDirectoriesChunkRequest,
  ApplicationSessionDirectoriesChunkResult,
  ApplicationSessionListRequest,
  ApplicationSessionOperations,
  ApplicationSessionPage,
  ApplicationSessionReadRequest,
  ApplicationSessionReadResult,
  ApplicationSessionTransitionResult,
  ApplicationSessionWriteRequest,
} from "../shared/application-service-model.js";
import { normalizeAllowedAdditionalDirectories } from "../shared/allowed-additional-directories.js";
import type { PersistenceError } from "../shared/persistence-protocol.js";
import { isCanonicalUuid } from "../shared/persistence-runtime-protocol.js";
import type { SessionListItem } from "../shared/repository-read-model.js";
import type { SessionLifecycleStatus } from "../shared/repository-write-model.js";
import { PersistenceClientError } from "./persistence-worker-client.js";
import type { RepositoryReadClient } from "./repository-read-client.js";
import type { RepositoryWriteClient } from "./repository-write-client.js";

type SessionReadPort = Pick<RepositoryReadClient, "sessionsPage" | "sessionGet" | "sessionDirectoriesChunk">;
type SessionWritePort = Pick<RepositoryWriteClient, "createSession" | "transitionSession">;
type ApplicationFailureResponse<TMode extends "read" | "write" = "read" | "write"> = Extract<
  ApplicationOperationResponse<never, TMode>,
  Readonly<{ overallStatus: "failure" }>
>;
type ApplicationPrePersistenceFailureResponse = Extract<
  ApplicationFailureResponse,
  Readonly<{ persistence: Readonly<{ status: "not_attempted" }> }>
>;
type ApplicationDomainFailureResponse = Extract<
  ApplicationFailureResponse<"read">,
  Readonly<{ error: Readonly<{ kind: "domain" }> }>
>;

type RequestDecodeResult<TValue> =
  Readonly<{ ok: true; value: TValue }> | Readonly<{ ok: false; response: ApplicationPrePersistenceFailureResponse }>;

type OperationPreparation<TValue> =
  | Readonly<{ ok: true; input: TValue; control: OperationControl }>
  | Readonly<{ ok: false; response: ApplicationPrePersistenceFailureResponse }>;

type OperationControl = Readonly<{
  deadlineAt?: number;
  signal?: AbortSignal;
}>;

type OperationInterruption = "timeout" | "canceled";

type ControlledSettlement<TValue> =
  | Readonly<{ status: "fulfilled"; value: TValue }>
  | Readonly<{ status: "rejected"; error: unknown }>
  | Readonly<{ status: "interrupted"; interruption: OperationInterruption; started: boolean }>;

// admissionはより低いapp / Provider capも適用するが、永続設定値自体をboundedに保つ。
export const APPLICATION_MAX_CONCURRENT_CHILD_RUNS = 1_024;
export const APPLICATION_MAX_READ_CHUNK_BYTES = 256 * 1024;

export type ApplicationSessionServiceOptions<TAuthorizationContext> = Readonly<{
  reads: SessionReadPort;
  writes: SessionWritePort;
  access: ApplicationAccessValidator<TAuthorizationContext>;
  snapshotAuthorization(value: unknown): TAuthorizationContext;
}>;

export class ApplicationSessionService<
  TAuthorizationContext,
> implements ApplicationSessionOperations<TAuthorizationContext> {
  readonly #reads: SessionReadPort;
  readonly #writes: SessionWritePort;
  readonly #access: ApplicationAccessValidator<TAuthorizationContext>;
  readonly #snapshotAuthorization: (value: unknown) => TAuthorizationContext;

  constructor(options: ApplicationSessionServiceOptions<TAuthorizationContext>) {
    this.#reads = options.reads;
    this.#writes = options.writes;
    this.#access = options.access;
    this.#snapshotAuthorization = options.snapshotAuthorization;
  }

  async create(
    request: ApplicationSessionCreateRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionCreateResult, "write">> {
    const prepared = prepareOperation(options, () =>
      decodeCreateRequest<TAuthorizationContext>(request, this.#snapshotAuthorization),
    );
    if (!prepared.ok) return prepared.response;
    const { input, control } = prepared;
    const denied = await this.#validateAccess(
      {
        operation: "create",
        access: "write",
        context: input.context,
        target: {
          kind: "session_create",
          providerId: input.providerId,
          allowedAdditionalDirectories: [...input.allowedAdditionalDirectories],
          defaultCharacterId: input.defaultCharacterId,
          maxConcurrentChildRuns: input.maxConcurrentChildRuns,
        },
      },
      control,
    );
    if (denied !== undefined) return denied;
    const sessionId = issueSessionId(input.idempotencyKey);

    return executeRepositoryOperation(
      "write",
      control,
      (repositoryOptions) =>
        this.#writes.createSession(
          {
            idempotencyKey: input.idempotencyKey,
            session: {
              id: sessionId,
              providerId: input.providerId,
              workspaceKey: input.context.workspaceKey,
              allowedAdditionalDirectories: input.allowedAdditionalDirectories,
              defaultCharacterId: input.defaultCharacterId,
              maxConcurrentChildRuns: input.maxConcurrentChildRuns,
            },
          },
          repositoryOptions,
        ),
      (result) =>
        mapWriteResult<ApplicationSessionCreateResult>(result, (value) =>
          projectSessionCreateResult(value, sessionId, input.context.workspaceKey),
        ),
    );
  }

  async list(
    request: ApplicationSessionListRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionPage, "read">> {
    const prepared = prepareOperation(options, () =>
      decodeListRequest<TAuthorizationContext>(request, this.#snapshotAuthorization),
    );
    if (!prepared.ok) return prepared.response;
    const { input, control } = prepared;
    const denied = await this.#validateAccess(
      {
        operation: "list",
        access: "read",
        context: input.context,
        target: {
          kind: "session_collection",
          ...(input.lifecycleStatus === undefined ? {} : { lifecycleStatus: input.lifecycleStatus }),
        },
      },
      control,
    );
    if (denied !== undefined) return denied;

    return executeRepositoryOperation(
      "read",
      control,
      (repositoryOptions) =>
        this.#reads.sessionsPage(
          {
            workspaceKey: input.context.workspaceKey,
            ...(input.lifecycleStatus === undefined ? {} : { lifecycleStatus: input.lifecycleStatus }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          },
          repositoryOptions,
        ),
      (value) => projectSessionPage(value, input.context.workspaceKey, input.lifecycleStatus),
    );
  }

  async read(
    request: ApplicationSessionReadRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionReadResult, "read">> {
    const prepared = prepareOperation(options, () =>
      decodeReadRequest<TAuthorizationContext>(request, this.#snapshotAuthorization),
    );
    if (!prepared.ok) return prepared.response;
    const { input, control } = prepared;
    const denied = await this.#validateAccess(
      {
        operation: "read",
        access: "read",
        context: input.context,
        target: { kind: "session", sessionId: input.sessionId },
      },
      control,
    );
    if (denied !== undefined) return denied;

    return executeRepositoryOperation(
      "read",
      control,
      (repositoryOptions) =>
        this.#reads.sessionGet(
          { workspaceKey: input.context.workspaceKey, sessionId: input.sessionId },
          repositoryOptions,
        ),
      (repositoryValue) => ({
        overallStatus: "success",
        value: projectSessionReadResult(repositoryValue, input.sessionId, input.context.workspaceKey),
        persistence: { status: "read", effect: "none" },
      }),
    );
  }

  async readDirectoriesChunk(
    request: ApplicationSessionDirectoriesChunkRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionDirectoriesChunkResult, "read">> {
    const prepared = prepareOperation(options, () =>
      decodeDirectoriesChunkRequest<TAuthorizationContext>(request, this.#snapshotAuthorization),
    );
    if (!prepared.ok) return prepared.response;
    const { input, control } = prepared;
    const denied = await this.#validateAccess(
      {
        operation: "read_directories_chunk",
        access: "read",
        context: input.context,
        target: {
          kind: "session_directories",
          sessionId: input.sessionId,
          offset: input.offset,
          maxBytes: input.maxBytes,
        },
      },
      control,
    );
    if (denied !== undefined) return denied;

    return executeRepositoryOperation(
      "read",
      control,
      (repositoryOptions) =>
        this.#reads.sessionDirectoriesChunk(
          {
            sessionId: input.sessionId,
            workspaceKey: input.context.workspaceKey,
            offset: input.offset,
            maxBytes: input.maxBytes,
          },
          repositoryOptions,
        ),
      (value) => ({
        overallStatus: "success",
        value: projectSessionDirectoriesChunk(value, input.sessionId, input.offset, input.maxBytes),
        persistence: { status: "read", effect: "none" },
      }),
    );
  }

  archive(
    request: ApplicationSessionWriteRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionTransitionResult, "write">> {
    const prepared = prepareOperation(options, () =>
      decodeWriteRequest<TAuthorizationContext>(request, this.#snapshotAuthorization),
    );
    if (!prepared.ok) return Promise.resolve(prepared.response);
    return this.#transition("archive", prepared.input, "active", "archived", prepared.control);
  }

  unarchive(
    request: ApplicationSessionWriteRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionTransitionResult, "write">> {
    const prepared = prepareOperation(options, () =>
      decodeWriteRequest<TAuthorizationContext>(request, this.#snapshotAuthorization),
    );
    if (!prepared.ok) return Promise.resolve(prepared.response);
    return this.#transition("unarchive", prepared.input, "archived", "active", prepared.control);
  }

  close(
    request: ApplicationSessionCloseRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionTransitionResult, "write">> {
    const prepared = prepareOperation(options, () =>
      decodeCloseRequest<TAuthorizationContext>(request, this.#snapshotAuthorization),
    );
    if (!prepared.ok) return Promise.resolve(prepared.response);
    return this.#transition(
      "close",
      prepared.input,
      prepared.input.expectedLifecycleStatus,
      "closed",
      prepared.control,
    );
  }

  async #transition(
    operation: "archive" | "unarchive" | "close",
    request: ApplicationSessionWriteRequest<TAuthorizationContext>,
    expectedLifecycleStatus: "active" | "archived",
    targetLifecycleStatus: SessionLifecycleStatus,
    control: OperationControl,
  ): Promise<ApplicationOperationResponse<ApplicationSessionTransitionResult, "write">> {
    const denied = await this.#validateAccess(
      {
        operation,
        access: "write",
        context: request.context,
        target: { kind: "session", sessionId: request.sessionId },
      },
      control,
    );
    if (denied !== undefined) return denied;

    return executeRepositoryOperation(
      "write",
      control,
      (repositoryOptions) =>
        this.#writes.transitionSession(
          {
            sessionId: request.sessionId,
            workspaceKey: request.context.workspaceKey,
            idempotencyKey: request.idempotencyKey,
            expectedLifecycleStatus,
            targetLifecycleStatus,
          },
          repositoryOptions,
        ),
      (result) =>
        mapWriteResult<ApplicationSessionTransitionResult>(result, (value) =>
          projectSessionTransitionResult(value, request.sessionId, targetLifecycleStatus),
        ),
    );
  }

  async #validateAccess(
    input: ApplicationAccessValidationInput<TAuthorizationContext>,
    control: OperationControl,
  ): Promise<ApplicationPrePersistenceFailureResponse | undefined> {
    const workspace = await runControlled(control, () =>
      this.#access.validateWorkspace(createAccessValidationView(input, this.#snapshotAuthorization)),
    );
    if (workspace.status === "interrupted") return operationInterruptionFailure(workspace.interruption);
    if (workspace.status === "rejected") return prePersistenceApplicationFailure();
    const workspaceDecision = safelyProjectAccessDecision(workspace.value);
    if (workspaceDecision === undefined) return prePersistenceApplicationFailure();
    if (!workspaceDecision.allowed) return accessFailure(workspaceDecision.error);

    const authorization = await runControlled(control, () =>
      this.#access.authorize(createAccessValidationView(input, this.#snapshotAuthorization)),
    );
    if (authorization.status === "interrupted") return operationInterruptionFailure(authorization.interruption);
    if (authorization.status === "rejected") {
      return prePersistenceApplicationFailure();
    }
    const authorizationDecision = safelyProjectAccessDecision(authorization.value);
    if (authorizationDecision === undefined) {
      return prePersistenceApplicationFailure();
    }
    if (!authorizationDecision.allowed) return accessFailure(authorizationDecision.error);
    return undefined;
  }
}

function createAccessValidationView<TAuthorizationContext>(
  input: ApplicationAccessValidationInput<TAuthorizationContext>,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): ApplicationAccessValidationInput<TAuthorizationContext> {
  const context = {
    workspaceKey: input.context.workspaceKey,
    authorization: snapshotAuthorization(input.context.authorization),
  };
  switch (input.operation) {
    case "create":
      return {
        operation: input.operation,
        access: input.access,
        context,
        target: { ...input.target, allowedAdditionalDirectories: [...input.target.allowedAdditionalDirectories] },
      };
    case "list":
      return { operation: input.operation, access: input.access, context, target: { ...input.target } };
    case "read":
      return { operation: input.operation, access: input.access, context, target: { ...input.target } };
    case "read_directories_chunk":
      return { operation: input.operation, access: input.access, context, target: { ...input.target } };
    case "archive":
    case "unarchive":
    case "close":
      return { operation: input.operation, access: input.access, context, target: { ...input.target } };
  }
}

function decodeCreateRequest<TAuthorizationContext>(
  request: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
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
    !isSafeChildRunLimit(request.maxConcurrentChildRuns)
  ) {
    return decodeRequestFailure();
  }
  const context = decodeOperationContext(request.context, snapshotAuthorization);
  if (context === undefined) return decodeRequestFailure();
  const allowedAdditionalDirectories = normalizeAllowedAdditionalDirectories(request.allowedAdditionalDirectories);
  if (allowedAdditionalDirectories === undefined) return decodeRequestFailure();
  return {
    ok: true,
    value: {
      context,
      idempotencyKey: request.idempotencyKey,
      providerId: request.providerId,
      allowedAdditionalDirectories,
      defaultCharacterId: request.defaultCharacterId,
      maxConcurrentChildRuns: request.maxConcurrentChildRuns,
    },
  };
}

function decodeWriteRequest<TAuthorizationContext>(
  request: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): RequestDecodeResult<ApplicationSessionWriteRequest<TAuthorizationContext>> {
  if (
    !isPlainObject(request) ||
    !hasOnlyKeys(request, ["context", "sessionId", "idempotencyKey"]) ||
    !isBoundedString(request.sessionId) ||
    !isCanonicalIdempotencyKey(request.idempotencyKey)
  ) {
    return decodeRequestFailure();
  }
  const context = decodeOperationContext(request.context, snapshotAuthorization);
  if (context === undefined) return decodeRequestFailure();
  return { ok: true, value: { context, sessionId: request.sessionId, idempotencyKey: request.idempotencyKey } };
}

function decodeListRequest<TAuthorizationContext>(
  request: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
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
  const context = decodeOperationContext(request.context, snapshotAuthorization);
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
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): RequestDecodeResult<ApplicationSessionReadRequest<TAuthorizationContext>> {
  if (
    !isPlainObject(request) ||
    !hasOnlyKeys(request, ["context", "sessionId"]) ||
    !isBoundedString(request.sessionId)
  ) {
    return decodeRequestFailure();
  }
  const context = decodeOperationContext(request.context, snapshotAuthorization);
  if (context === undefined) return decodeRequestFailure();
  return { ok: true, value: { context, sessionId: request.sessionId } };
}

function decodeDirectoriesChunkRequest<TAuthorizationContext>(
  request: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): RequestDecodeResult<ApplicationSessionDirectoriesChunkRequest<TAuthorizationContext>> {
  if (
    !isPlainObject(request) ||
    !hasOnlyKeys(request, ["context", "sessionId", "offset", "maxBytes"]) ||
    !isBoundedString(request.sessionId) ||
    !isNonNegativeSafeInteger(request.offset) ||
    !Number.isSafeInteger(request.maxBytes) ||
    (request.maxBytes as number) < 1 ||
    (request.maxBytes as number) > APPLICATION_MAX_READ_CHUNK_BYTES
  ) {
    return decodeRequestFailure();
  }
  const context = decodeOperationContext(request.context, snapshotAuthorization);
  if (context === undefined) return decodeRequestFailure();
  return {
    ok: true,
    value: {
      context,
      sessionId: request.sessionId,
      offset: request.offset,
      maxBytes: request.maxBytes as number,
    },
  };
}

function decodeCloseRequest<TAuthorizationContext>(
  request: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
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
  const context = decodeOperationContext(request.context, snapshotAuthorization);
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
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
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
      authorization: snapshotAuthorization(context.authorization),
    };
  } catch {
    return undefined;
  }
}

function decodeRequestFailure<TValue>(): RequestDecodeResult<TValue> {
  return { ok: false, response: requestFailure() };
}

function prepareOperation<TValue>(
  options: unknown,
  decodeRequest: () => RequestDecodeResult<TValue>,
): OperationPreparation<TValue> {
  const operationStartedAt = Date.now();
  const decodedOptions = decodeOperationOptions(options);
  if (!decodedOptions.ok) return decodedOptions;
  const control = createOperationControl(decodedOptions.value, operationStartedAt);
  const beforeDecode = getOperationInterruption(control);
  if (beforeDecode !== undefined) return { ok: false, response: operationInterruptionFailure(beforeDecode) };
  const decodedRequest = decodeRequest();
  const afterDecode = getOperationInterruption(control);
  if (afterDecode !== undefined) return { ok: false, response: operationInterruptionFailure(afterDecode) };
  return decodedRequest.ok
    ? { ok: true, input: decodedRequest.value, control }
    : { ok: false, response: decodedRequest.response };
}

function createOperationControl(
  options: ApplicationOperationOptions | undefined,
  operationStartedAt: number,
): OperationControl {
  return {
    ...(options?.timeoutMs === undefined ? {} : { deadlineAt: operationStartedAt + options.timeoutMs }),
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  };
}

async function runControlled<TValue>(
  control: OperationControl,
  start: () => Promise<TValue>,
  interruptStartedWork?: () => void,
): Promise<ControlledSettlement<TValue>> {
  const beforeStart = getOperationInterruption(control);
  if (beforeStart !== undefined) {
    return { status: "interrupted", interruption: beforeStart, started: false };
  }

  let work: Promise<TValue>;
  try {
    work = Promise.resolve(start());
  } catch (error) {
    return { status: "rejected", error };
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: ControlledSettlement<TValue>) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      control.signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const interrupt = (interruption: OperationInterruption) => {
      interruptStartedWork?.();
      finish({ status: "interrupted", interruption, started: true });
    };
    const onAbort = () => interrupt("canceled");
    const remaining = getRemainingTimeout(control);
    if (remaining !== undefined) {
      timer = setTimeout(() => interrupt("timeout"), remaining);
    }
    control.signal?.addEventListener("abort", onAbort, { once: true });
    if (control.signal?.aborted) {
      onAbort();
      return;
    }
    work.then(
      (value) => finish({ status: "fulfilled", value }),
      (error: unknown) => finish({ status: "rejected", error }),
    );
  });
}

async function executeRepositoryOperation<TRepositoryValue, TApplicationValue, TMode extends "read" | "write">(
  requestClass: TMode,
  control: OperationControl,
  execute: (options: ApplicationOperationOptions | undefined) => Promise<TRepositoryValue>,
  mapValue: (value: TRepositoryValue) => ApplicationOperationResponse<TApplicationValue, TMode>,
): Promise<ApplicationOperationResponse<TApplicationValue, TMode>> {
  const interruption = getOperationInterruption(control);
  if (interruption !== undefined) return operationInterruptionFailure(interruption);
  const repositoryAbort = new AbortController();
  const settlement = await runControlled(
    control,
    () => execute(createRepositoryOptions(control, repositoryAbort.signal)),
    () => repositoryAbort.abort(),
  );
  if (settlement.status === "interrupted") {
    return settlement.started
      ? persistenceInterruptionFailure(settlement.interruption, requestClass)
      : operationInterruptionFailure(settlement.interruption);
  }
  if (settlement.status === "rejected") return mapThrownFailure(settlement.error, requestClass);
  try {
    return mapValue(settlement.value);
  } catch {
    return persistenceApplicationFailure(requestClass);
  }
}

function createRepositoryOptions(
  control: OperationControl,
  repositorySignal: AbortSignal,
): ApplicationOperationOptions | undefined {
  // deadlineの所有者をApplicationへ一本化し、Repository timeoutとのraceでretry契約を揺らさない。
  return control.deadlineAt === undefined && control.signal === undefined ? undefined : { signal: repositorySignal };
}

function getOperationInterruption(control: OperationControl): OperationInterruption | undefined {
  if (control.signal?.aborted) return "canceled";
  if (control.deadlineAt !== undefined && control.deadlineAt <= Date.now()) return "timeout";
  return undefined;
}

function getRemainingTimeout(control: OperationControl): number | undefined {
  return control.deadlineAt === undefined ? undefined : Math.max(0, control.deadlineAt - Date.now());
}

function decodeOperationOptions(options: unknown): RequestDecodeResult<ApplicationOperationOptions | undefined> {
  if (options === undefined) return { ok: true, value: undefined };
  if (!isPlainObject(options) || !hasOnlyKeys(options, ["timeoutMs", "signal"])) {
    return decodeRequestFailure();
  }
  const timeoutMs = options.timeoutMs;
  const signal = options.signal;
  if (
    (timeoutMs !== undefined &&
      (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 2_147_483_647)) ||
    (signal !== undefined && !(signal instanceof AbortSignal))
  ) {
    return decodeRequestFailure();
  }
  return {
    ok: true,
    value: {
      ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
      ...(signal === undefined ? {} : { signal }),
    },
  };
}

function requestFailure(): ApplicationPrePersistenceFailureResponse {
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
): ApplicationPrePersistenceFailureResponse {
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

function projectAccessDecision(value: unknown): ApplicationAccessDecision | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value.allowed === true) return { allowed: true };
  if (value.allowed !== false || !isPlainObject(value.error)) return undefined;
  const error = value.error;
  if (
    !isAccessErrorCode(error.code) ||
    !isBoundedStringWithLimit(error.message, 4_096) ||
    typeof error.retryable !== "boolean"
  ) {
    return undefined;
  }
  return {
    allowed: false,
    error: { code: error.code, message: error.message, retryable: error.retryable },
  };
}

function safelyProjectAccessDecision(value: unknown): ApplicationAccessDecision | undefined {
  try {
    return projectAccessDecision(value);
  } catch {
    return undefined;
  }
}

function isAccessErrorCode(
  value: unknown,
): value is "workspace_invalid" | "workspace_unavailable" | "authorization_invalid" | "forbidden" {
  return (
    value === "workspace_invalid" ||
    value === "workspace_unavailable" ||
    value === "authorization_invalid" ||
    value === "forbidden"
  );
}

function operationInterruptionFailure(interruption: OperationInterruption): ApplicationPrePersistenceFailureResponse {
  return {
    overallStatus: "failure",
    error:
      interruption === "timeout"
        ? {
            kind: "operation",
            code: "operation_timeout",
            message: "Application operation timed out.",
            retryable: true,
          }
        : {
            kind: "operation",
            code: "operation_canceled",
            message: "Application operation was canceled.",
            retryable: false,
          },
    persistence: { status: "not_attempted", effect: "none" },
  };
}

function persistenceInterruptionFailure<TMode extends "read" | "write">(
  interruption: OperationInterruption,
  requestClass: TMode,
): ApplicationFailureResponse<TMode> {
  const effect = requestClass === "write" ? "unknown" : "none";
  const error = {
    kind: "persistence" as const,
    code: interruption === "timeout" ? ("persistence_timeout" as const) : ("persistence_canceled" as const),
    message: interruption === "timeout" ? "Application operation timed out." : "Application operation was canceled.",
    retryable: interruption === "timeout",
  };
  if (effect === "unknown") {
    return {
      overallStatus: "failure",
      error: { ...error, effect: "unknown" },
      persistence: { status: "failed", effect: "unknown", reconciliation: "exact_request_required" },
    } as ApplicationFailureResponse<TMode>;
  }
  return {
    overallStatus: "failure",
    error: { ...error, effect: "none" },
    persistence: { status: "failed", effect: "none" },
  } as ApplicationFailureResponse<TMode>;
}

function prePersistenceApplicationFailure(): ApplicationPrePersistenceFailureResponse {
  return {
    overallStatus: "failure",
    error: {
      kind: "application",
      code: "internal_error",
      message: "Application Service could not complete the operation.",
      retryable: false,
    },
    persistence: { status: "not_attempted", effect: "none" },
  };
}

function persistenceApplicationFailure<TMode extends "read" | "write">(
  requestClass: TMode,
): ApplicationFailureResponse<TMode> {
  const response = {
    overallStatus: "failure" as const,
    error: {
      kind: "application" as const,
      code: "internal_error" as const,
      message: "Application Service could not complete the operation.",
      retryable: false,
    },
    persistence:
      requestClass === "write"
        ? ({ status: "failed", effect: "unknown", reconciliation: "exact_request_required" } as const)
        : ({ status: "failed", effect: "none" } as const),
  };
  return response as ApplicationFailureResponse<TMode>;
}

function mapWriteResult<TApplicationValue>(
  result: unknown,
  mapValue: (value: unknown) => TApplicationValue,
): ApplicationOperationResponse<TApplicationValue, "write"> {
  if (!isPlainObject(result) || typeof result.replayed !== "boolean") return invalidRepositoryValue();
  if (result.ok === false) {
    if (result.replayed) return invalidRepositoryValue();
    return domainFailure(projectRepositoryDomainError(result.error));
  }
  if (result.ok !== true) return invalidRepositoryValue();
  return {
    overallStatus: "success",
    value: mapValue(result.value),
    persistence: { status: "committed", effect: "none", replayed: result.replayed },
  };
}

function domainFailure(error: ApplicationDomainError): ApplicationDomainFailureResponse {
  return {
    overallStatus: "failure",
    error,
    persistence: { status: "rejected", effect: "none" },
  };
}

function mapThrownFailure<TMode extends "read" | "write">(
  error: unknown,
  requestClass: TMode,
): ApplicationFailureResponse<TMode> {
  if (!(error instanceof PersistenceClientError)) {
    return persistenceApplicationFailure(requestClass);
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
  const mappedError = {
    kind: "persistence" as const,
    code: mapPersistenceErrorCode(persistenceError.code),
    message: persistenceError.message,
    retryable: persistenceError.retryable,
  };
  if (requestClass === "write" && persistenceError.effect === "unknown") {
    return {
      overallStatus: "failure",
      error: { ...mappedError, effect: "unknown" },
      persistence: { status: "failed", effect: "unknown", reconciliation: "exact_request_required" },
    } as ApplicationFailureResponse<TMode>;
  }
  return {
    overallStatus: "failure",
    error: { ...mappedError, effect: "none" },
    persistence: { status: "failed", effect: "none" },
  } as ApplicationFailureResponse<TMode>;
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

function isSafeChildRunLimit(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value <= APPLICATION_MAX_CONCURRENT_CHILD_RUNS;
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

function projectRepositoryDomainError(value: unknown): ApplicationDomainError {
  if (
    !isPlainObject(value) ||
    !isRepositoryDomainErrorCode(value.code) ||
    !isBoundedStringWithLimit(value.message, 4_096) ||
    typeof value.retryable !== "boolean"
  ) {
    return invalidRepositoryValue();
  }
  if (value.code === "capacity_exceeded") {
    if (!value.retryable) return invalidRepositoryValue();
    return {
      kind: "domain",
      code: value.code,
      message: value.message,
      retryable: true,
      details: projectCapacityExceededDetails(value.details),
    };
  }
  return {
    kind: "domain",
    code: value.code,
    message: value.message,
    retryable: value.retryable,
  };
}

function isRepositoryDomainErrorCode(value: unknown): value is Exclude<ApplicationDomainErrorCode, "cursor_invalid"> {
  return (
    value === "request_invalid" ||
    value === "not_found" ||
    value === "reference_invalid" ||
    value === "lifecycle_conflict" ||
    value === "session_busy" ||
    value === "capacity_exceeded" ||
    value === "idempotency_conflict" ||
    value === "idempotency_in_progress" ||
    value === "idempotency_expired"
  );
}

function projectCapacityExceededDetails(value: unknown): NonNullable<ApplicationDomainError["details"]> {
  if (!isPlainObject(value) || !isNonNegativeSafeInteger(value.current) || !isNonNegativeSafeInteger(value.limit)) {
    return invalidRepositoryValue();
  }
  switch (value.scope) {
    case "root":
      if (!isBoundedString(value.rootSessionId)) return invalidRepositoryValue();
      return {
        scope: value.scope,
        rootSessionId: value.rootSessionId,
        current: value.current,
        limit: value.limit,
      };
    case "application":
      return { scope: value.scope, current: value.current, limit: value.limit };
    case "provider":
      if (!isBoundedString(value.providerId)) return invalidRepositoryValue();
      return {
        scope: value.scope,
        providerId: value.providerId,
        current: value.current,
        limit: value.limit,
      };
    default:
      return invalidRepositoryValue();
  }
}

function isAllowedAdditionalDirectories(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > 1_024) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || !isBoundedStringWithLimit(value[index], 32_768)) {
      return false;
    }
  }
  return Buffer.byteLength(JSON.stringify(value)) <= 4 * 1_024 * 1_024;
}

function isBoundedStringWithLimit(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function projectSessionPage(
  value: unknown,
  expectedWorkspaceKey: string,
  expectedLifecycleStatus: SessionLifecycleStatus | undefined,
): ApplicationOperationResponse<ApplicationSessionPage, "read"> {
  if (!isPlainObject(value) || !Array.isArray(value.items)) return invalidRepositoryValue();
  if (value.nextCursor !== undefined && !isBoundedStringWithLimit(value.nextCursor, 2_048)) {
    return invalidRepositoryValue();
  }
  const items: SessionListItem[] = [];
  const omissions: ReturnType<typeof projectPageOmission>[] = [];
  for (let index = 0; index < value.items.length; index += 1) {
    if (!Object.hasOwn(value.items, index)) return invalidRepositoryValue();
    const item = value.items[index];
    if (isPageOmission(item)) omissions.push(projectPageOmission(item));
    else {
      const projected = projectSessionListItem(item);
      if (
        projected.workspaceKey !== expectedWorkspaceKey ||
        (expectedLifecycleStatus !== undefined && projected.lifecycleStatus !== expectedLifecycleStatus)
      ) {
        return invalidRepositoryValue();
      }
      items.push(projected);
    }
  }
  const page: ApplicationSessionPage =
    value.nextCursor === undefined ? { items } : { items, nextCursor: value.nextCursor };
  const [firstOmission, ...remainingOmissions] = omissions;
  return firstOmission === undefined
    ? { overallStatus: "success", value: page, persistence: { status: "read", effect: "none" } }
    : {
        overallStatus: "partial_success",
        value: page,
        issues: [firstOmission, ...remainingOmissions],
        persistence: { status: "read", effect: "none" },
      };
}

function projectSessionListItem(value: unknown): SessionListItem {
  if (
    !isPlainObject(value) ||
    !isBoundedString(value.id) ||
    !isBoundedString(value.workspaceKey) ||
    !isBoundedString(value.defaultCharacterId) ||
    !isSessionLifecycleStatus(value.lifecycleStatus) ||
    !isNonNegativeSafeInteger(value.createdAt) ||
    !isNonNegativeSafeInteger(value.updatedAt) ||
    !isNonNegativeSafeInteger(value.lastActivityAt) ||
    !isSessionExecutionState(value.executionState) ||
    (value.activeRunId !== undefined && !isBoundedString(value.activeRunId)) ||
    (value.latestRunId !== undefined && !isBoundedString(value.latestRunId)) ||
    !isNonNegativeSafeInteger(value.stateChangedAt)
  ) {
    return invalidRepositoryValue();
  }
  return {
    id: value.id,
    workspaceKey: value.workspaceKey,
    defaultCharacterId: value.defaultCharacterId,
    lifecycleStatus: value.lifecycleStatus,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastActivityAt: value.lastActivityAt,
    executionState: value.executionState,
    ...(value.activeRunId === undefined ? {} : { activeRunId: value.activeRunId }),
    ...(value.latestRunId === undefined ? {} : { latestRunId: value.latestRunId }),
    stateChangedAt: value.stateChangedAt,
  };
}

function projectSessionReadResult(
  value: unknown,
  expectedSessionId: string,
  expectedWorkspaceKey: string,
): ApplicationSessionReadResult {
  if (!isPlainObject(value) || !isPlainObject(value.execution)) return invalidRepositoryValue();
  const execution = value.execution;
  if (
    !isSessionExecutionState(execution.state) ||
    (execution.activeRunId !== undefined && !isBoundedString(execution.activeRunId)) ||
    (execution.latestRunId !== undefined && !isBoundedString(execution.latestRunId))
  ) {
    return invalidRepositoryValue();
  }
  const session = projectSessionDetail(value.session);
  if (session.id !== expectedSessionId || session.workspaceKey !== expectedWorkspaceKey) {
    return invalidRepositoryValue();
  }
  return {
    session,
    execution: {
      state: execution.state,
      ...(execution.activeRunId === undefined ? {} : { activeRunId: execution.activeRunId }),
      ...(execution.latestRunId === undefined ? {} : { latestRunId: execution.latestRunId }),
    },
  };
}

function projectSessionDetail(value: unknown): ApplicationSessionDetail {
  if (
    !isPlainObject(value) ||
    !isBoundedString(value.id) ||
    !isBoundedString(value.providerId) ||
    !isBoundedString(value.workspaceKey) ||
    !isNonNegativeSafeInteger(value.allowedAdditionalDirectoriesByteLength) ||
    (value.allowedAdditionalDirectoriesState !== "inline" && value.allowedAdditionalDirectoriesState !== "chunked") ||
    !isBoundedString(value.defaultCharacterId) ||
    !isNonNegativeSafeInteger(value.maxConcurrentChildRuns) ||
    !isSessionLifecycleStatus(value.lifecycleStatus) ||
    !isNonNegativeSafeInteger(value.createdAt) ||
    !isNonNegativeSafeInteger(value.updatedAt) ||
    !isNonNegativeSafeInteger(value.lastActivityAt)
  ) {
    return invalidRepositoryValue();
  }
  return {
    id: value.id,
    providerId: value.providerId,
    workspaceKey: value.workspaceKey,
    allowedAdditionalDirectoriesByteLength: value.allowedAdditionalDirectoriesByteLength,
    allowedAdditionalDirectoriesState: value.allowedAdditionalDirectoriesState,
    defaultCharacterId: value.defaultCharacterId,
    maxConcurrentChildRuns: value.maxConcurrentChildRuns,
    lifecycleStatus: value.lifecycleStatus,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastActivityAt: value.lastActivityAt,
  };
}

function projectSessionDirectoriesChunk(
  value: unknown,
  expectedSessionId: string,
  expectedOffset: number,
  expectedMaxBytes: number,
): ApplicationSessionDirectoriesChunkResult {
  if (
    !isPlainObject(value) ||
    value.sessionId !== expectedSessionId ||
    value.offset !== expectedOffset ||
    !isNonNegativeSafeInteger(value.totalBytes) ||
    typeof value.eof !== "boolean" ||
    !(value.bytes instanceof ArrayBuffer)
  ) {
    return invalidRepositoryValue();
  }
  const byteLength = value.bytes.byteLength;
  const endOffset = expectedOffset + byteLength;
  const expectedEof = endOffset >= value.totalBytes;
  if (
    byteLength > expectedMaxBytes ||
    (byteLength === 0 && !value.eof) ||
    !Number.isSafeInteger(endOffset) ||
    endOffset > value.totalBytes ||
    value.eof !== expectedEof
  ) {
    return invalidRepositoryValue();
  }
  return {
    sessionId: value.sessionId,
    offset: value.offset,
    totalBytes: value.totalBytes,
    eof: value.eof,
    bytes: value.bytes,
  };
}

function projectSessionCreateResult(
  value: unknown,
  expectedSessionId: string,
  expectedWorkspaceKey: string,
): ApplicationSessionCreateResult {
  if (
    !isPlainObject(value) ||
    value.sessionId !== expectedSessionId ||
    value.workspaceKey !== expectedWorkspaceKey ||
    value.lifecycleStatus !== "active" ||
    !isNonNegativeSafeInteger(value.createdAt)
  ) {
    return invalidRepositoryValue();
  }
  return {
    sessionId: value.sessionId,
    workspaceKey: value.workspaceKey,
    lifecycleStatus: value.lifecycleStatus,
    createdAt: value.createdAt,
  };
}

function projectSessionTransitionResult(
  value: unknown,
  expectedSessionId: string,
  expectedLifecycleStatus: SessionLifecycleStatus,
): ApplicationSessionTransitionResult {
  if (
    !isPlainObject(value) ||
    value.sessionId !== expectedSessionId ||
    value.lifecycleStatus !== expectedLifecycleStatus ||
    !isNonNegativeSafeInteger(value.updatedAt)
  ) {
    return invalidRepositoryValue();
  }
  return { sessionId: expectedSessionId, lifecycleStatus: expectedLifecycleStatus, updatedAt: value.updatedAt };
}

function isSessionExecutionState(value: unknown): value is SessionListItem["executionState"] {
  return (
    value === "not_started" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "canceled" ||
    value === "interrupted"
  );
}

function isPageOmission(value: unknown): value is Readonly<{
  omitted: true;
  reason: "response_size_limit";
  ordinal?: number;
}> {
  return (
    isPlainObject(value) &&
    value.omitted === true &&
    value.reason === "response_size_limit" &&
    (value.ordinal === undefined || isNonNegativeSafeInteger(value.ordinal))
  );
}

function projectPageOmission(omission: ReturnTypeGuard<typeof isPageOmission>) {
  return omission.ordinal === undefined
    ? {
        kind: "omission" as const,
        code: "response_size_limit" as const,
        message: "A Session list item was omitted because the response size limit was reached.",
      }
    : {
        kind: "omission" as const,
        code: "response_size_limit" as const,
        message: "A Session list item was omitted because the response size limit was reached.",
        ordinal: omission.ordinal,
      };
}

type ReturnTypeGuard<TGuard> = TGuard extends (value: unknown) => value is infer TValue ? TValue : never;

function invalidRepositoryValue(): never {
  throw new TypeError("Repository result does not match the Application Service contract.");
}
