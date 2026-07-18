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
  ApplicationSessionExecution,
  ApplicationSessionListItem,
  ApplicationSessionListRequest,
  ApplicationSessionOperations,
  ApplicationSessionPage,
  ApplicationSessionReadRequest,
  ApplicationSessionReadResult,
  ApplicationSessionTransitionResult,
  ApplicationSessionWriteRequest,
} from "../shared/application-service-model.js";
import {
  ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS,
  allowedAdditionalDirectoriesJsonByteLength,
  canonicalizeAllowedAdditionalDirectories,
  compactCanonicalAllowedAdditionalDirectories,
} from "../shared/allowed-additional-directories.js";
import type { CanonicalAllowedAdditionalDirectory } from "../shared/allowed-additional-directories.js";
import type { PersistenceError } from "../shared/persistence-protocol.js";
import { isCanonicalUuid } from "../shared/persistence-runtime-protocol.js";
import { REPOSITORY_READ_LIMITS } from "../shared/repository-read-model.js";
import type { SessionLifecycleStatus } from "../shared/repository-write-model.js";
import { MAX_SESSION_CONCURRENT_CHILD_RUNS } from "../shared/session-limits.js";
import { resolveWorkspaceIdentity } from "../shared/workspace-path.js";
import { PersistenceClientError } from "./persistence-worker-client.js";
import type { PersistenceWorkerClient } from "./persistence-worker-client.js";
import { RepositoryReadClient } from "./repository-read-client.js";
import { RepositoryWriteClient } from "./repository-write-client.js";

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

type DecodedSessionCreateRequest<TAuthorizationContext> = Omit<
  ApplicationSessionCreateRequest<TAuthorizationContext>,
  "allowedAdditionalDirectories"
> &
  Readonly<{ allowedAdditionalDirectories: readonly CanonicalAllowedAdditionalDirectory[] }>;

// admissionはより低いapp / Provider capも適用するが、永続設定値自体をboundedに保つ。
export const APPLICATION_MAX_CONCURRENT_CHILD_RUNS = MAX_SESSION_CONCURRENT_CHILD_RUNS;
export const APPLICATION_MAX_READ_CHUNK_BYTES = 256 * 1024;

export type ApplicationSessionServiceOptions<TAuthorizationContext> = Readonly<{
  reads: SessionReadPort;
  writes: SessionWritePort;
  access: ApplicationAccessValidator<TAuthorizationContext>;
  snapshotAuthorization(value: unknown): TAuthorizationContext;
}>;

export function createApplicationSessionOperations<TAuthorizationContext>(
  worker: PersistenceWorkerClient,
  options: Pick<ApplicationSessionServiceOptions<TAuthorizationContext>, "access" | "snapshotAuthorization">,
): ApplicationSessionOperations<TAuthorizationContext> {
  return new ApplicationSessionService({
    reads: new RepositoryReadClient(worker),
    writes: new RepositoryWriteClient(worker),
    ...options,
  });
}

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
    const workspace = resolveWorkspaceIdentity(input.workspacePath);
    if (workspace === undefined) return requestFailure();
    const validationDirectories = input.allowedAdditionalDirectories.map(({ path: directoryPath }) => directoryPath);
    const denied = await this.#validateAccess(
      {
        operation: "create",
        access: "write",
        context: input.context,
        target: {
          kind: "session_create",
          workspacePath: workspace.workspacePath,
          providerId: input.providerId,
          allowedAdditionalDirectories: validationDirectories,
          defaultCharacterId: input.defaultCharacterId,
          maxConcurrentChildRuns: input.maxConcurrentChildRuns,
        },
      },
      control,
      true,
    );
    if (denied !== undefined) return denied;
    const persistedDirectories = compactCanonicalAllowedAdditionalDirectories(input.allowedAdditionalDirectories);
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
              workspaceKey: workspace.workspaceKey,
              workspacePath: workspace.workspacePath,
              allowedAdditionalDirectories: persistedDirectories,
              defaultCharacterId: input.defaultCharacterId,
              maxConcurrentChildRuns: input.maxConcurrentChildRuns,
            },
          },
          repositoryOptions,
        ),
      (result) =>
        mapWriteResult<ApplicationSessionCreateResult>(result, (value) =>
          projectSessionCreateResult(value, sessionId, workspace),
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
    const workspace = input.workspacePath === undefined ? undefined : resolveWorkspaceIdentity(input.workspacePath);
    if (input.workspacePath !== undefined && workspace === undefined) return requestFailure();
    const denied = await this.#validateAccess(
      {
        operation: "list",
        access: "read",
        context: input.context,
        target: {
          kind: "session_collection",
          scope: "all_sessions",
          ...(workspace === undefined ? {} : { workspacePath: workspace.workspacePath }),
          ...(input.lifecycleStatus === undefined ? {} : { lifecycleStatus: input.lifecycleStatus }),
        },
      },
      control,
      false,
    );
    if (denied !== undefined) return denied;

    return executeRepositoryOperation(
      "read",
      control,
      (repositoryOptions) =>
        this.#reads.sessionsPage(
          {
            ...(workspace === undefined ? {} : { workspaceKey: workspace.workspaceKey }),
            ...(input.lifecycleStatus === undefined ? {} : { lifecycleStatus: input.lifecycleStatus }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          },
          repositoryOptions,
        ),
      (value) =>
        projectSessionPage(
          value,
          workspace,
          input.lifecycleStatus,
          input.limit ?? REPOSITORY_READ_LIMITS.sessions.default,
        ),
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
      false,
    );
    if (denied !== undefined) return denied;

    return executeRepositoryOperation(
      "read",
      control,
      (repositoryOptions) => this.#reads.sessionGet({ sessionId: input.sessionId }, repositoryOptions),
      (repositoryValue) => ({
        overallStatus: "success",
        value: projectSessionReadResult(repositoryValue, input.sessionId),
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
      false,
    );
    if (denied !== undefined) return denied;

    return executeRepositoryOperation(
      "read",
      control,
      (repositoryOptions) =>
        this.#reads.sessionDirectoriesChunk(
          {
            sessionId: input.sessionId,
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
      false,
    );
    if (denied !== undefined) return denied;

    return executeRepositoryOperation(
      "write",
      control,
      (repositoryOptions) =>
        this.#writes.transitionSession(
          {
            sessionId: request.sessionId,
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
    validateWorkspace: boolean,
  ): Promise<ApplicationPrePersistenceFailureResponse | undefined> {
    if (validateWorkspace) {
      const workspaceInput = prepareAccessValidationView(input, control, this.#snapshotAuthorization);
      if (!workspaceInput.ok) return workspaceInput.response;
      const workspace = await runControlled(control, () =>
        this.#access.validateWorkspace(
          workspaceInput.value as Extract<
            ApplicationAccessValidationInput<TAuthorizationContext>,
            Readonly<{ operation: "create" }>
          >,
        ),
      );
      if (workspace.status === "interrupted") return operationInterruptionFailure(workspace.interruption);
      if (workspace.status === "rejected") return prePersistenceApplicationFailure();
      const workspaceDecision = safelyProjectAccessDecision(workspace.value);
      const workspaceProjectionInterruption = getOperationInterruption(control);
      if (workspaceProjectionInterruption !== undefined) {
        return operationInterruptionFailure(workspaceProjectionInterruption);
      }
      if (workspaceDecision === undefined) return prePersistenceApplicationFailure();
      if (!workspaceDecision.allowed) return accessFailure(workspaceDecision.error);
    }

    const authorizationInput = prepareAccessValidationView(input, control, this.#snapshotAuthorization);
    if (!authorizationInput.ok) return authorizationInput.response;
    const authorization = await runControlled(control, () => this.#access.authorize(authorizationInput.value));
    if (authorization.status === "interrupted") return operationInterruptionFailure(authorization.interruption);
    if (authorization.status === "rejected") {
      return prePersistenceApplicationFailure();
    }
    const authorizationDecision = safelyProjectAccessDecision(authorization.value);
    const authorizationProjectionInterruption = getOperationInterruption(control);
    if (authorizationProjectionInterruption !== undefined) {
      return operationInterruptionFailure(authorizationProjectionInterruption);
    }
    if (authorizationDecision === undefined) {
      return prePersistenceApplicationFailure();
    }
    if (!authorizationDecision.allowed) return accessFailure(authorizationDecision.error);
    return undefined;
  }
}

function prepareAccessValidationView<TAuthorizationContext>(
  input: ApplicationAccessValidationInput<TAuthorizationContext>,
  control: OperationControl,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
):
  | Readonly<{ ok: true; value: ApplicationAccessValidationInput<TAuthorizationContext> }>
  | Readonly<{ ok: false; response: ApplicationPrePersistenceFailureResponse }> {
  const beforeSnapshot = getOperationInterruption(control);
  if (beforeSnapshot !== undefined) {
    return { ok: false, response: operationInterruptionFailure(beforeSnapshot) };
  }
  let value: ApplicationAccessValidationInput<TAuthorizationContext>;
  try {
    value = createAccessValidationView(input, snapshotAuthorization);
  } catch {
    const interruption = getOperationInterruption(control);
    return {
      ok: false,
      response:
        interruption === undefined ? prePersistenceApplicationFailure() : operationInterruptionFailure(interruption),
    };
  }
  const interruption = getOperationInterruption(control);
  return interruption === undefined
    ? { ok: true, value }
    : { ok: false, response: operationInterruptionFailure(interruption) };
}

function createAccessValidationView<TAuthorizationContext>(
  input: ApplicationAccessValidationInput<TAuthorizationContext>,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): ApplicationAccessValidationInput<TAuthorizationContext> {
  const context = {
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
): RequestDecodeResult<DecodedSessionCreateRequest<TAuthorizationContext>> {
  const snapshot = snapshotRecord(request, [
    "context",
    "workspacePath",
    "idempotencyKey",
    "providerId",
    "allowedAdditionalDirectories",
    "defaultCharacterId",
    "maxConcurrentChildRuns",
  ]);
  if (
    snapshot === undefined ||
    typeof snapshot.workspacePath !== "string" ||
    !isCanonicalIdempotencyKey(snapshot.idempotencyKey) ||
    !isBoundedString(snapshot.providerId) ||
    !isBoundedString(snapshot.defaultCharacterId) ||
    !isSafeChildRunLimit(snapshot.maxConcurrentChildRuns)
  ) {
    return decodeRequestFailure();
  }
  const directories = snapshotAllowedAdditionalDirectories(snapshot.allowedAdditionalDirectories);
  if (directories === undefined) return decodeRequestFailure();
  const context = decodeOperationContext(snapshot.context, snapshotAuthorization);
  if (context === undefined) return decodeRequestFailure();
  const workspace = resolveWorkspaceIdentity(snapshot.workspacePath);
  if (workspace === undefined) return decodeRequestFailure();
  const allowedAdditionalDirectories = canonicalizeAllowedAdditionalDirectories(directories);
  if (
    allowedAdditionalDirectories === undefined ||
    allowedAdditionalDirectoriesJsonByteLength(
      allowedAdditionalDirectories.map(({ path: directoryPath }) => directoryPath),
    ) > ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxJsonBytes
  ) {
    return decodeRequestFailure();
  }
  return {
    ok: true,
    value: {
      context,
      workspacePath: workspace.workspacePath,
      idempotencyKey: snapshot.idempotencyKey,
      providerId: snapshot.providerId,
      allowedAdditionalDirectories,
      defaultCharacterId: snapshot.defaultCharacterId,
      maxConcurrentChildRuns: snapshot.maxConcurrentChildRuns,
    },
  };
}

function decodeWriteRequest<TAuthorizationContext>(
  request: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): RequestDecodeResult<ApplicationSessionWriteRequest<TAuthorizationContext>> {
  const snapshot = snapshotRecord(request, ["context", "sessionId", "idempotencyKey"]);
  if (
    snapshot === undefined ||
    !isBoundedString(snapshot.sessionId) ||
    !isCanonicalIdempotencyKey(snapshot.idempotencyKey)
  ) {
    return decodeRequestFailure();
  }
  const context = decodeOperationContext(snapshot.context, snapshotAuthorization);
  if (context === undefined) return decodeRequestFailure();
  return { ok: true, value: { context, sessionId: snapshot.sessionId, idempotencyKey: snapshot.idempotencyKey } };
}

function decodeListRequest<TAuthorizationContext>(
  request: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): RequestDecodeResult<ApplicationSessionListRequest<TAuthorizationContext>> {
  const snapshot = snapshotRecord(request, ["context", "workspacePath", "lifecycleStatus", "cursor", "limit"]);
  if (
    snapshot === undefined ||
    (snapshot.workspacePath !== undefined && typeof snapshot.workspacePath !== "string") ||
    (snapshot.lifecycleStatus !== undefined && !isSessionLifecycleStatus(snapshot.lifecycleStatus)) ||
    (snapshot.cursor !== undefined && !isBoundedStringWithLimit(snapshot.cursor, 2_048)) ||
    (snapshot.limit !== undefined &&
      (!Number.isSafeInteger(snapshot.limit) ||
        (snapshot.limit as number) < 1 ||
        (snapshot.limit as number) > REPOSITORY_READ_LIMITS.sessions.max))
  ) {
    return decodeRequestFailure();
  }
  const context = decodeOperationContext(snapshot.context, snapshotAuthorization);
  if (context === undefined) return decodeRequestFailure();
  const workspace =
    snapshot.workspacePath === undefined ? undefined : resolveWorkspaceIdentity(snapshot.workspacePath as string);
  if (snapshot.workspacePath !== undefined && workspace === undefined) return decodeRequestFailure();
  return {
    ok: true,
    value: {
      context,
      ...(workspace === undefined ? {} : { workspacePath: workspace.workspacePath }),
      ...(snapshot.lifecycleStatus === undefined ? {} : { lifecycleStatus: snapshot.lifecycleStatus }),
      ...(snapshot.cursor === undefined ? {} : { cursor: snapshot.cursor }),
      ...(snapshot.limit === undefined ? {} : { limit: snapshot.limit as number }),
    },
  };
}

function decodeReadRequest<TAuthorizationContext>(
  request: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): RequestDecodeResult<ApplicationSessionReadRequest<TAuthorizationContext>> {
  const snapshot = snapshotRecord(request, ["context", "sessionId"]);
  if (snapshot === undefined || !isBoundedString(snapshot.sessionId)) {
    return decodeRequestFailure();
  }
  const context = decodeOperationContext(snapshot.context, snapshotAuthorization);
  if (context === undefined) return decodeRequestFailure();
  return { ok: true, value: { context, sessionId: snapshot.sessionId } };
}

function decodeDirectoriesChunkRequest<TAuthorizationContext>(
  request: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): RequestDecodeResult<ApplicationSessionDirectoriesChunkRequest<TAuthorizationContext>> {
  const snapshot = snapshotRecord(request, ["context", "sessionId", "offset", "maxBytes"]);
  if (
    snapshot === undefined ||
    !isBoundedString(snapshot.sessionId) ||
    !isNonNegativeSafeInteger(snapshot.offset) ||
    !Number.isSafeInteger(snapshot.maxBytes) ||
    (snapshot.maxBytes as number) < 1 ||
    (snapshot.maxBytes as number) > APPLICATION_MAX_READ_CHUNK_BYTES
  ) {
    return decodeRequestFailure();
  }
  const context = decodeOperationContext(snapshot.context, snapshotAuthorization);
  if (context === undefined) return decodeRequestFailure();
  return {
    ok: true,
    value: {
      context,
      sessionId: snapshot.sessionId,
      offset: snapshot.offset,
      maxBytes: snapshot.maxBytes as number,
    },
  };
}

function decodeCloseRequest<TAuthorizationContext>(
  request: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): RequestDecodeResult<ApplicationSessionCloseRequest<TAuthorizationContext>> {
  const snapshot = snapshotRecord(request, ["context", "sessionId", "idempotencyKey", "expectedLifecycleStatus"]);
  if (
    snapshot === undefined ||
    !isBoundedString(snapshot.sessionId) ||
    !isCanonicalIdempotencyKey(snapshot.idempotencyKey) ||
    (snapshot.expectedLifecycleStatus !== "active" && snapshot.expectedLifecycleStatus !== "archived")
  ) {
    return decodeRequestFailure();
  }
  const context = decodeOperationContext(snapshot.context, snapshotAuthorization);
  if (context === undefined) return decodeRequestFailure();
  return {
    ok: true,
    value: {
      context,
      sessionId: snapshot.sessionId,
      idempotencyKey: snapshot.idempotencyKey,
      expectedLifecycleStatus: snapshot.expectedLifecycleStatus,
    },
  };
}

function decodeOperationContext<TAuthorizationContext>(
  context: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): ApplicationSessionCreateRequest<TAuthorizationContext>["context"] | undefined {
  const snapshot = snapshotRecord(context, ["authorization"]);
  if (snapshot === undefined || !Object.hasOwn(snapshot, "authorization")) {
    return undefined;
  }
  try {
    return {
      authorization: snapshotAuthorization(snapshot.authorization),
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
  let decodedOptions: RequestDecodeResult<ApplicationOperationOptions | undefined>;
  try {
    decodedOptions = decodeOperationOptions(options);
  } catch {
    return { ok: false, response: requestFailure() };
  }
  if (!decodedOptions.ok) return decodedOptions;
  const control = createOperationControl(decodedOptions.value, operationStartedAt);
  const beforeDecode = getOperationInterruption(control);
  if (beforeDecode !== undefined) return { ok: false, response: operationInterruptionFailure(beforeDecode) };
  let decodedRequest: RequestDecodeResult<TValue>;
  try {
    decodedRequest = decodeRequest();
  } catch {
    decodedRequest = decodeRequestFailure();
  }
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
    const interruption = getOperationInterruption(control);
    if (interruption !== undefined) {
      try {
        interruptStartedWork?.();
      } catch {
        // operation結果はadapterのabort hookではなくdeadline/cancellationで決まる。
      }
      return { status: "interrupted", interruption, started: true };
    }
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
      if (settled) return;
      try {
        interruptStartedWork?.();
      } catch {
        // operation結果はadapterのabort hookではなくdeadline/cancellationで決まる。
      }
      finish({ status: "interrupted", interruption, started: true });
    };
    const onAbort = () => interrupt("canceled");
    work.then(
      (value) => {
        const interruption = getOperationInterruption(control);
        if (interruption === undefined) finish({ status: "fulfilled", value });
        else interrupt(interruption);
      },
      (error: unknown) => {
        const interruption = getOperationInterruption(control);
        if (interruption === undefined) finish({ status: "rejected", error });
        else interrupt(interruption);
      },
    );
    const remaining = getRemainingTimeout(control);
    if (remaining !== undefined) {
      timer = setTimeout(() => interrupt("timeout"), remaining);
    }
    control.signal?.addEventListener("abort", onAbort, { once: true });
    if (control.signal?.aborted) {
      onAbort();
    }
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
    const response = mapValue(settlement.value);
    const projectionInterruption = getOperationInterruption(control);
    return projectionInterruption === undefined
      ? response
      : persistenceInterruptionFailure(projectionInterruption, requestClass);
  } catch {
    const projectionInterruption = getOperationInterruption(control);
    return projectionInterruption === undefined
      ? persistenceApplicationFailure(requestClass)
      : persistenceInterruptionFailure(projectionInterruption, requestClass);
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
  const snapshot = snapshotRecord(options, ["timeoutMs", "signal"]);
  if (snapshot === undefined) return decodeRequestFailure();
  const timeoutMs = snapshot.timeoutMs;
  const signal = snapshot.signal;
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
  const decision = snapshotProjectionRecord(value, ["allowed", "error"]);
  if (decision === undefined) return undefined;
  if (decision.allowed === true) return { allowed: true };
  if (decision.allowed !== false) return undefined;
  const error = snapshotProjectionRecord(decision.error, ["code", "message", "retryable"]);
  if (error === undefined) return undefined;
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
  const snapshot = snapshotProjectionRecord(result, ["ok", "replayed", "error", "value"]);
  if (snapshot === undefined || typeof snapshot.replayed !== "boolean") return invalidRepositoryValue();
  if (snapshot.ok === false) {
    if (snapshot.replayed) return invalidRepositoryValue();
    return domainFailure(projectRepositoryDomainError(snapshot.error));
  }
  if (snapshot.ok !== true) return invalidRepositoryValue();
  return {
    overallStatus: "success",
    value: mapValue(snapshot.value),
    persistence: { status: "committed", effect: "none", replayed: snapshot.replayed },
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

function snapshotRecord(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const allowed = new Set(allowedKeys);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return undefined;
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) snapshot[key as string] = Reflect.get(value, key);
  return snapshot;
}

function snapshotProjectionRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) snapshot[key] = Reflect.get(value, key);
  return snapshot;
}

function snapshotProjectionArray(value: unknown, maxLength: number): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const length = Reflect.get(value, "length") as unknown;
  if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maxLength) return undefined;
  const snapshot: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    if (!Object.hasOwn(value, index)) return undefined;
    snapshot.push(Reflect.get(value, String(index)) as unknown);
  }
  return snapshot;
}

function isSessionLifecycleStatus(value: unknown): value is SessionLifecycleStatus {
  return value === "active" || value === "archived" || value === "closed";
}

function projectRepositoryDomainError(value: unknown): ApplicationDomainError {
  const snapshot = snapshotProjectionRecord(value, ["code", "message", "retryable", "details"]);
  if (
    snapshot === undefined ||
    !isRepositoryDomainErrorCode(snapshot.code) ||
    !isBoundedStringWithLimit(snapshot.message, 4_096) ||
    typeof snapshot.retryable !== "boolean"
  ) {
    return invalidRepositoryValue();
  }
  if (snapshot.code === "capacity_exceeded") {
    if (!snapshot.retryable) return invalidRepositoryValue();
    return {
      kind: "domain",
      code: snapshot.code,
      message: snapshot.message,
      retryable: true,
      details: projectCapacityExceededDetails(snapshot.details),
    };
  }
  return {
    kind: "domain",
    code: snapshot.code,
    message: snapshot.message,
    retryable: snapshot.retryable,
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
  const snapshot = snapshotProjectionRecord(value, ["scope", "rootSessionId", "providerId", "current", "limit"]);
  if (
    snapshot === undefined ||
    !isNonNegativeSafeInteger(snapshot.current) ||
    !isNonNegativeSafeInteger(snapshot.limit)
  ) {
    return invalidRepositoryValue();
  }
  switch (snapshot.scope) {
    case "root":
      if (!isBoundedString(snapshot.rootSessionId)) return invalidRepositoryValue();
      return {
        scope: snapshot.scope,
        rootSessionId: snapshot.rootSessionId,
        current: snapshot.current,
        limit: snapshot.limit,
      };
    case "application":
      return { scope: snapshot.scope, current: snapshot.current, limit: snapshot.limit };
    case "provider":
      if (!isBoundedString(snapshot.providerId)) return invalidRepositoryValue();
      return {
        scope: snapshot.scope,
        providerId: snapshot.providerId,
        current: snapshot.current,
        limit: snapshot.limit,
      };
    default:
      return invalidRepositoryValue();
  }
}

function snapshotAllowedAdditionalDirectories(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const length = Reflect.get(value, "length") as unknown;
  if (
    !Number.isSafeInteger(length) ||
    (length as number) < 0 ||
    (length as number) > ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxItems
  ) {
    return undefined;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== (length as number) + 1 || !ownKeys.includes("length")) return undefined;
  const indexKeys = new Set(ownKeys.filter((key): key is string => typeof key === "string" && key !== "length"));
  if (indexKeys.size !== length) return undefined;
  const snapshot: string[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const key = String(index);
    if (!indexKeys.has(key)) return undefined;
    const item = Reflect.get(value, key) as unknown;
    if (!isBoundedStringWithLimit(item, ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxPathLength)) return undefined;
    snapshot.push(item);
  }
  return allowedAdditionalDirectoriesJsonByteLength(snapshot) <= ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxJsonBytes
    ? snapshot
    : undefined;
}

function isBoundedStringWithLimit(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function projectSessionPage(
  value: unknown,
  expectedWorkspace: Readonly<{ workspaceKey: string; workspacePath: string }> | undefined,
  expectedLifecycleStatus: SessionLifecycleStatus | undefined,
  expectedLimit: number,
): ApplicationOperationResponse<ApplicationSessionPage, "read"> {
  const snapshot = snapshotProjectionRecord(value, ["items", "nextCursor"]);
  const pageItems = snapshotProjectionArray(snapshot?.items, expectedLimit);
  if (snapshot === undefined || pageItems === undefined) {
    return invalidRepositoryValue();
  }
  if (snapshot.nextCursor !== undefined && !isBoundedStringWithLimit(snapshot.nextCursor, 2_048)) {
    return invalidRepositoryValue();
  }
  const items: ApplicationSessionListItem[] = [];
  const omissions: NonNullable<ReturnType<typeof projectPageOmission>>[] = [];
  for (const item of pageItems) {
    const omission = projectPageOmission(item);
    if (omission !== undefined) omissions.push(omission);
    else {
      const projected = projectSessionListItem(item);
      if (
        (expectedWorkspace !== undefined &&
          resolveWorkspaceIdentity(projected.workspacePath)?.workspaceKey !== expectedWorkspace.workspaceKey) ||
        (expectedLifecycleStatus !== undefined && projected.lifecycleStatus !== expectedLifecycleStatus)
      ) {
        return invalidRepositoryValue();
      }
      items.push(projected);
    }
  }
  const page: ApplicationSessionPage =
    snapshot.nextCursor === undefined ? { items } : { items, nextCursor: snapshot.nextCursor };
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

function projectSessionListItem(value: unknown): ApplicationSessionListItem {
  const snapshot = snapshotProjectionRecord(value, [
    "id",
    "workspaceKey",
    "workspacePath",
    "defaultCharacterId",
    "lifecycleStatus",
    "createdAt",
    "updatedAt",
    "lastActivityAt",
    "stateChangedAt",
    "executionState",
    "activeRunId",
    "latestRunId",
  ]);
  if (
    snapshot === undefined ||
    !isBoundedString(snapshot.id) ||
    !isBoundedString(snapshot.workspaceKey) ||
    typeof snapshot.workspacePath !== "string" ||
    !isBoundedString(snapshot.defaultCharacterId) ||
    !isSessionLifecycleStatus(snapshot.lifecycleStatus) ||
    !isNonNegativeSafeInteger(snapshot.createdAt) ||
    !isNonNegativeSafeInteger(snapshot.updatedAt) ||
    !isNonNegativeSafeInteger(snapshot.lastActivityAt) ||
    !isNonNegativeSafeInteger(snapshot.stateChangedAt)
  ) {
    return invalidRepositoryValue();
  }
  const workspace = resolveWorkspaceIdentity(snapshot.workspacePath);
  if (workspace === undefined || workspace.workspaceKey !== snapshot.workspaceKey) return invalidRepositoryValue();
  const execution = projectSessionExecution(snapshot.executionState, snapshot.activeRunId, snapshot.latestRunId);
  if (snapshot.lifecycleStatus !== "active" && execution.state === "running") return invalidRepositoryValue();
  const base = {
    id: snapshot.id,
    workspacePath: workspace.workspacePath,
    defaultCharacterId: snapshot.defaultCharacterId,
    lifecycleStatus: snapshot.lifecycleStatus,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    lastActivityAt: snapshot.lastActivityAt,
    stateChangedAt: snapshot.stateChangedAt,
  };
  switch (execution.state) {
    case "not_started":
      return { ...base, executionState: execution.state };
    case "running":
      if (snapshot.lifecycleStatus !== "active") return invalidRepositoryValue();
      return {
        ...base,
        lifecycleStatus: "active",
        executionState: execution.state,
        activeRunId: execution.activeRunId,
        latestRunId: execution.latestRunId,
      };
    default:
      return { ...base, executionState: execution.state, latestRunId: execution.latestRunId };
  }
}

function projectSessionReadResult(value: unknown, expectedSessionId: string): ApplicationSessionReadResult {
  const snapshot = snapshotProjectionRecord(value, ["session", "execution"]);
  const executionSnapshot = snapshotProjectionRecord(snapshot?.execution, ["state", "activeRunId", "latestRunId"]);
  if (snapshot === undefined || executionSnapshot === undefined) return invalidRepositoryValue();
  const execution = projectSessionExecution(
    executionSnapshot.state,
    executionSnapshot.activeRunId,
    executionSnapshot.latestRunId,
  );
  const session = projectSessionDetail(snapshot.session);
  if (session.id !== expectedSessionId) {
    return invalidRepositoryValue();
  }
  if (session.lifecycleStatus === "active") {
    return { session: { ...session, lifecycleStatus: "active" }, execution };
  }
  if (execution.state === "running") return invalidRepositoryValue();
  return { session: { ...session, lifecycleStatus: session.lifecycleStatus }, execution };
}

function projectSessionDetail(value: unknown): ApplicationSessionDetail {
  const snapshot = snapshotProjectionRecord(value, [
    "id",
    "providerId",
    "workspaceKey",
    "workspacePath",
    "allowedAdditionalDirectoriesByteLength",
    "allowedAdditionalDirectoriesState",
    "defaultCharacterId",
    "maxConcurrentChildRuns",
    "lifecycleStatus",
    "createdAt",
    "updatedAt",
    "lastActivityAt",
  ]);
  if (
    snapshot === undefined ||
    !isBoundedString(snapshot.id) ||
    !isBoundedString(snapshot.providerId) ||
    !isBoundedString(snapshot.workspaceKey) ||
    typeof snapshot.workspacePath !== "string" ||
    !isNonNegativeSafeInteger(snapshot.allowedAdditionalDirectoriesByteLength) ||
    (snapshot.allowedAdditionalDirectoriesState !== "inline" &&
      snapshot.allowedAdditionalDirectoriesState !== "chunked") ||
    !isBoundedString(snapshot.defaultCharacterId) ||
    !isSafeChildRunLimit(snapshot.maxConcurrentChildRuns) ||
    !isSessionLifecycleStatus(snapshot.lifecycleStatus) ||
    !isNonNegativeSafeInteger(snapshot.createdAt) ||
    !isNonNegativeSafeInteger(snapshot.updatedAt) ||
    !isNonNegativeSafeInteger(snapshot.lastActivityAt)
  ) {
    return invalidRepositoryValue();
  }
  const workspace = resolveWorkspaceIdentity(snapshot.workspacePath);
  if (workspace === undefined || workspace.workspaceKey !== snapshot.workspaceKey) return invalidRepositoryValue();
  return {
    id: snapshot.id,
    providerId: snapshot.providerId,
    workspacePath: workspace.workspacePath,
    allowedAdditionalDirectoriesByteLength: snapshot.allowedAdditionalDirectoriesByteLength,
    allowedAdditionalDirectoriesState: snapshot.allowedAdditionalDirectoriesState,
    defaultCharacterId: snapshot.defaultCharacterId,
    maxConcurrentChildRuns: snapshot.maxConcurrentChildRuns,
    lifecycleStatus: snapshot.lifecycleStatus,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    lastActivityAt: snapshot.lastActivityAt,
  };
}

function projectSessionDirectoriesChunk(
  value: unknown,
  expectedSessionId: string,
  expectedOffset: number,
  expectedMaxBytes: number,
): ApplicationSessionDirectoriesChunkResult {
  const snapshot = snapshotProjectionRecord(value, ["sessionId", "offset", "totalBytes", "eof", "bytes"]);
  if (
    snapshot === undefined ||
    snapshot.sessionId !== expectedSessionId ||
    snapshot.offset !== expectedOffset ||
    !isNonNegativeSafeInteger(snapshot.totalBytes) ||
    typeof snapshot.eof !== "boolean" ||
    !(snapshot.bytes instanceof ArrayBuffer)
  ) {
    return invalidRepositoryValue();
  }
  const byteLength = snapshot.bytes.byteLength;
  const endOffset = expectedOffset + byteLength;
  if (
    byteLength > expectedMaxBytes ||
    !Number.isSafeInteger(endOffset) ||
    (expectedOffset >= snapshot.totalBytes
      ? byteLength !== 0 || !snapshot.eof
      : byteLength === 0 || endOffset > snapshot.totalBytes || snapshot.eof !== (endOffset === snapshot.totalBytes))
  ) {
    return invalidRepositoryValue();
  }
  return {
    sessionId: snapshot.sessionId,
    offset: snapshot.offset,
    totalBytes: snapshot.totalBytes,
    eof: snapshot.eof,
    bytes: snapshot.bytes,
  };
}

function projectSessionCreateResult(
  value: unknown,
  expectedSessionId: string,
  expectedWorkspace: Readonly<{ workspaceKey: string; workspacePath: string }>,
): ApplicationSessionCreateResult {
  const snapshot = snapshotProjectionRecord(value, [
    "sessionId",
    "workspaceKey",
    "workspacePath",
    "lifecycleStatus",
    "createdAt",
  ]);
  if (
    snapshot === undefined ||
    snapshot.sessionId !== expectedSessionId ||
    snapshot.workspaceKey !== expectedWorkspace.workspaceKey ||
    snapshot.workspacePath !== expectedWorkspace.workspacePath ||
    snapshot.lifecycleStatus !== "active" ||
    !isNonNegativeSafeInteger(snapshot.createdAt)
  ) {
    return invalidRepositoryValue();
  }
  return {
    sessionId: snapshot.sessionId,
    workspacePath: expectedWorkspace.workspacePath,
    lifecycleStatus: snapshot.lifecycleStatus,
    createdAt: snapshot.createdAt,
  };
}

function projectSessionTransitionResult(
  value: unknown,
  expectedSessionId: string,
  expectedLifecycleStatus: SessionLifecycleStatus,
): ApplicationSessionTransitionResult {
  const snapshot = snapshotProjectionRecord(value, ["sessionId", "lifecycleStatus", "updatedAt"]);
  if (
    snapshot === undefined ||
    snapshot.sessionId !== expectedSessionId ||
    snapshot.lifecycleStatus !== expectedLifecycleStatus ||
    !isNonNegativeSafeInteger(snapshot.updatedAt)
  ) {
    return invalidRepositoryValue();
  }
  return { sessionId: expectedSessionId, lifecycleStatus: expectedLifecycleStatus, updatedAt: snapshot.updatedAt };
}

function projectSessionExecution(
  state: unknown,
  activeRunId: unknown,
  latestRunId: unknown,
): ApplicationSessionExecution {
  if (state === "not_started") {
    if (activeRunId !== undefined || latestRunId !== undefined) return invalidRepositoryValue();
    return { state };
  }
  if (state === "running") {
    if (!isBoundedString(activeRunId) || !isBoundedString(latestRunId) || activeRunId !== latestRunId) {
      return invalidRepositoryValue();
    }
    return { state, activeRunId, latestRunId };
  }
  if (state === "completed" || state === "failed" || state === "canceled" || state === "interrupted") {
    if (activeRunId !== undefined || !isBoundedString(latestRunId)) return invalidRepositoryValue();
    return { state, latestRunId };
  }
  return invalidRepositoryValue();
}

function projectPageOmission(value: unknown) {
  const omission = snapshotProjectionRecord(value, ["omitted", "reason", "ordinal"]);
  if (
    omission === undefined ||
    omission.omitted !== true ||
    omission.reason !== "response_size_limit" ||
    (omission.ordinal !== undefined && !isNonNegativeSafeInteger(omission.ordinal))
  ) {
    return undefined;
  }
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

function invalidRepositoryValue(): never {
  throw new TypeError("Repository result does not match the Application Service contract.");
}
