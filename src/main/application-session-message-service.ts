import {
  APPLICATION_SESSION_MESSAGE_LIMITS,
  type ApplicationSessionMessageAccessValidationInput,
  type ApplicationSessionMessageAccessValidator,
  type ApplicationSessionMessageContentChunk,
  type ApplicationSessionMessageContentChunkRequest,
  type ApplicationSessionMessageItem,
  type ApplicationSessionMessageOperation,
  type ApplicationSessionMessageOperations,
  type ApplicationSessionMessagePage,
  type ApplicationSessionMessagesRequest,
} from "../shared/application-session-message-model.js";
import type {
  ApplicationAccessDecision,
  ApplicationOperationOptions,
  ApplicationOperationResponse,
} from "../shared/application-service-model.js";
import { snapshotMessageContentBlocks } from "../shared/message-content.js";
import type { PersistenceError } from "../shared/persistence-protocol.js";
import { PersistenceClientError } from "./persistence-worker-client.js";
import type { PersistenceWorkerClient } from "./persistence-worker-client.js";
import { RepositoryReadClient } from "./repository-read-client.js";

type SessionMessageReadPort = Pick<RepositoryReadClient, "sessionGet" | "messagesPage" | "messageContentChunk">;

type ApplicationSessionMessageFailureResponse = Extract<
  ApplicationOperationResponse<never, "read">,
  Readonly<{ overallStatus: "failure" }>
>;

type PreparedOperation<TValue> =
  | Readonly<{ ok: true; input: TValue; control: OperationControl }>
  | Readonly<{ ok: false; response: ApplicationSessionMessageFailureResponse }>;

type OperationControl = {
  readonly deadlineAt?: number;
  readonly signal?: AbortSignal;
  persistenceStarted: boolean;
};

type OperationInterruption = "timeout" | "canceled";

type ControlledSettlement<TValue> =
  | Readonly<{ status: "fulfilled"; value: TValue }>
  | Readonly<{ status: "rejected"; error: unknown }>
  | Readonly<{ status: "interrupted"; interruption: OperationInterruption }>;

type OperationResolution<TValue> =
  Readonly<{ ok: true; value: TValue }> | Readonly<{ ok: false; response: ApplicationSessionMessageFailureResponse }>;

type SessionMessageScope = Readonly<{ sessionId: string; workspaceKey: string }>;

type MessageOmissionIssue = Readonly<{
  kind: "omission";
  code: "response_size_limit";
  message: string;
  ordinal?: number;
}>;

type ProjectedMessagePage = Readonly<{
  value: ApplicationSessionMessagePage;
  issues: readonly MessageOmissionIssue[];
}>;

const MESSAGE_ITEM_PROJECTION_KEYS = [
  "omitted",
  "reason",
  "id",
  "sessionId",
  "ordinal",
  "role",
  "contentByteLength",
  "contentState",
  "contentBlocks",
  "createdAt",
] as const;

const MESSAGE_VALUE_KEYS = [
  "id",
  "sessionId",
  "role",
  "contentByteLength",
  "contentState",
  "contentBlocks",
  "createdAt",
] as const;

export type ApplicationSessionMessageServiceOptions<TAuthorizationContext> = Readonly<{
  reads: SessionMessageReadPort;
  access: ApplicationSessionMessageAccessValidator<TAuthorizationContext>;
  snapshotAuthorization(value: unknown): TAuthorizationContext;
}>;

export function createApplicationSessionMessageOperations<TAuthorizationContext>(
  worker: PersistenceWorkerClient,
  options: Omit<ApplicationSessionMessageServiceOptions<TAuthorizationContext>, "reads">,
): ApplicationSessionMessageOperations<TAuthorizationContext> {
  return new ApplicationSessionMessageService({ reads: new RepositoryReadClient(worker), ...options });
}

export class ApplicationSessionMessageService<
  TAuthorizationContext,
> implements ApplicationSessionMessageOperations<TAuthorizationContext> {
  readonly #reads: SessionMessageReadPort;
  readonly #access: ApplicationSessionMessageAccessValidator<TAuthorizationContext>;
  readonly #snapshotAuthorization: (value: unknown) => TAuthorizationContext;

  constructor(options: ApplicationSessionMessageServiceOptions<TAuthorizationContext>) {
    this.#reads = options.reads;
    this.#access = options.access;
    this.#snapshotAuthorization = options.snapshotAuthorization;
  }

  async messages(
    request: ApplicationSessionMessagesRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionMessagePage, "read">> {
    const prepared = prepareOperation(options, () => decodeMessagesRequest(request, this.#snapshotAuthorization));
    if (!prepared.ok) return prepared.response;
    const scope = await this.#authorizeAndResolveScope("messages", prepared.input, prepared.control);
    if (!scope.ok) return scope.response;
    const limit = prepared.input.limit ?? APPLICATION_SESSION_MESSAGE_LIMITS.messagesDefaultItems;
    const page = await readRepository(prepared.control, (repositoryOptions) =>
      this.#reads.messagesPage(
        {
          ...scope.value,
          ...(prepared.input.cursor === undefined ? {} : { cursor: prepared.input.cursor }),
          limit,
        },
        repositoryOptions,
      ),
    );
    if (!page.ok) return page.response;
    const projected = projectOperationValue(prepared.control, () =>
      projectMessagePage(page.value, scope.value, prepared.input.cursor, limit),
    );
    return projected.ok
      ? readOutcome(prepared.control, projected.value.value, projected.value.issues)
      : projected.response;
  }

  async messageContentChunk(
    request: ApplicationSessionMessageContentChunkRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionMessageContentChunk, "read">> {
    const prepared = prepareOperation(options, () => decodeChunkRequest(request, this.#snapshotAuthorization));
    if (!prepared.ok) return prepared.response;
    const scope = await this.#authorizeAndResolveScope("message_content_chunk", prepared.input, prepared.control);
    if (!scope.ok) return scope.response;
    const chunk = await readRepository(prepared.control, (repositoryOptions) =>
      this.#reads.messageContentChunk(
        {
          ...scope.value,
          messageId: prepared.input.messageId,
          offset: prepared.input.offset,
          maxBytes: prepared.input.maxBytes,
        },
        repositoryOptions,
      ),
    );
    if (!chunk.ok) return chunk.response;
    const projected = projectOperationValue(prepared.control, () =>
      projectMessageContentChunk(
        chunk.value,
        scope.value,
        prepared.input.messageId,
        prepared.input.offset,
        prepared.input.maxBytes,
      ),
    );
    return projected.ok ? readSuccess(prepared.control, projected.value) : projected.response;
  }

  async #authorizeAndResolveScope(
    operation: ApplicationSessionMessageOperation,
    input:
      | ApplicationSessionMessagesRequest<TAuthorizationContext>
      | ApplicationSessionMessageContentChunkRequest<TAuthorizationContext>,
    control: OperationControl,
  ): Promise<OperationResolution<SessionMessageScope>> {
    const authorizationInput = {
      operation,
      access: "read",
      context: input.context,
      target:
        operation === "messages"
          ? { kind: "session_messages", sessionId: input.sessionId }
          : {
              kind: "session_message_content",
              sessionId: input.sessionId,
              messageId: (input as ApplicationSessionMessageContentChunkRequest<TAuthorizationContext>).messageId,
              offset: (input as ApplicationSessionMessageContentChunkRequest<TAuthorizationContext>).offset,
              maxBytes: (input as ApplicationSessionMessageContentChunkRequest<TAuthorizationContext>).maxBytes,
            },
    } as ApplicationSessionMessageAccessValidationInput<TAuthorizationContext>;
    const authorization = await runControlled(control, () => this.#access.authorize(authorizationInput));
    if (authorization.status === "interrupted") {
      return { ok: false, response: operationInterruptionFailure(authorization.interruption) };
    }
    if (authorization.status === "rejected") return { ok: false, response: prePersistenceApplicationFailure() };
    const decision = projectOperationValue(control, () => projectAccessDecision(authorization.value));
    if (!decision.ok) return decision;
    if (!decision.value.allowed) return { ok: false, response: accessFailure(decision.value.error) };

    const session = await readRepository(control, (repositoryOptions) =>
      this.#reads.sessionGet({ sessionId: input.sessionId }, repositoryOptions),
    );
    if (!session.ok) return session;
    return projectOperationValue(control, () => {
      const projected = projectionRecord(session.value, ["session"]);
      const projectedSession = projectionRecord(projected.session, ["id", "workspaceKey"]);
      const sessionId = boundedString(projectedSession.id);
      const workspaceKey = boundedString(projectedSession.workspaceKey);
      if (sessionId !== input.sessionId) throw new TypeError("Session scope mismatch.");
      return { sessionId, workspaceKey };
    });
  }
}

function decodeMessagesRequest<TAuthorizationContext>(
  value: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): ApplicationSessionMessagesRequest<TAuthorizationContext> {
  const request = requestRecord(value, ["context", "sessionId", "cursor", "limit"]);
  const cursor = optionalBoundedString(request.cursor, APPLICATION_SESSION_MESSAGE_LIMITS.maxCursorLength);
  const limit = optionalInteger(request.limit, 1, APPLICATION_SESSION_MESSAGE_LIMITS.messagesMaxItems);
  return {
    ...decodeContextAndSession(request, snapshotAuthorization),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function decodeChunkRequest<TAuthorizationContext>(
  value: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): ApplicationSessionMessageContentChunkRequest<TAuthorizationContext> {
  const request = requestRecord(value, ["context", "sessionId", "messageId", "offset", "maxBytes"]);
  return {
    ...decodeContextAndSession(request, snapshotAuthorization),
    messageId: boundedString(request.messageId),
    offset: integer(request.offset, 0, Number.MAX_SAFE_INTEGER),
    maxBytes: integer(request.maxBytes, 1, APPLICATION_SESSION_MESSAGE_LIMITS.chunkMaxBytes),
  };
}

function decodeContextAndSession<TAuthorizationContext>(
  request: Readonly<Record<string, unknown>>,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): Readonly<{
  context: Readonly<{ authorization: TAuthorizationContext }>;
  sessionId: string;
}> {
  const context = requestRecord(request.context, ["authorization"]);
  return {
    context: { authorization: snapshotAuthorization(context.authorization) },
    sessionId: boundedString(request.sessionId),
  };
}

function projectMessagePage(
  value: unknown,
  expected: SessionMessageScope,
  inputCursor: string | undefined,
  limit: number,
): ProjectedMessagePage {
  const page = projectionRecord(value, ["sessionId", "workspaceKey", "items", "nextCursor"]);
  assertScope(page, expected);
  if (!isDenseArray(page.items, limit)) throw new TypeError("Message page is invalid.");
  const nextCursor = optionalBoundedString(page.nextCursor, APPLICATION_SESSION_MESSAGE_LIMITS.maxCursorLength);
  if (page.items.length === 0 && nextCursor !== undefined) throw new TypeError("Empty Message page has a cursor.");
  if (nextCursor !== undefined && nextCursor === inputCursor) throw new TypeError("Message cursor did not advance.");

  const items: ApplicationSessionMessageItem[] = [];
  const issues: MessageOmissionIssue[] = [];
  let previousOrdinal = 0;
  for (const rawValue of page.items) {
    const rawItem = plainRecord(rawValue);
    const item = projectionRecord(rawItem, MESSAGE_ITEM_PROJECTION_KEYS);
    const ordinal = optionalInteger(item.ordinal, 1, Number.MAX_SAFE_INTEGER);
    if (ordinal !== undefined && ordinal <= previousOrdinal) throw new TypeError("Message ordinals are invalid.");
    if (ordinal !== undefined) previousOrdinal = ordinal;
    if (item.omitted === true) {
      if (item.reason !== "response_size_limit" || MESSAGE_VALUE_KEYS.some((key) => Object.hasOwn(rawItem, key))) {
        throw new TypeError("Message omission is invalid.");
      }
      issues.push({
        kind: "omission",
        code: "response_size_limit",
        message: "Message was omitted because the response size limit was reached.",
        ...(ordinal === undefined ? {} : { ordinal }),
      });
      continue;
    }
    if (item.omitted !== undefined || item.reason !== undefined || ordinal === undefined) {
      throw new TypeError("Message item is invalid.");
    }
    items.push(projectMessageItem(rawItem, item, expected, ordinal));
  }
  return {
    value: {
      sessionId: expected.sessionId,
      items,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    },
    issues,
  };
}

function projectMessageItem(
  rawItem: Readonly<Record<string, unknown>>,
  item: Readonly<Record<string, unknown>>,
  expected: SessionMessageScope,
  ordinal: number,
): ApplicationSessionMessageItem {
  const id = boundedString(item.id);
  if (boundedString(item.sessionId) !== expected.sessionId) throw new TypeError("Message identity mismatch.");
  const role = enumString(item.role, ["user", "assistant"] as const);
  const contentByteLength = integer(item.contentByteLength, 2, APPLICATION_SESSION_MESSAGE_LIMITS.maxContentBytes);
  const createdAt = integer(item.createdAt, 0, Number.MAX_SAFE_INTEGER);
  const base = { id, ordinal, role, contentByteLength, createdAt } as const;
  if (item.contentState === "inline") {
    if (
      contentByteLength > APPLICATION_SESSION_MESSAGE_LIMITS.inlineMaxBytes ||
      !Object.hasOwn(rawItem, "contentBlocks")
    ) {
      throw new TypeError("Inline Message content is invalid.");
    }
    const blocks = snapshotMessageContentBlocks(item.contentBlocks);
    if (blocks === undefined) throw new TypeError("Inline Message content blocks are invalid.");
    if (new TextEncoder().encode(JSON.stringify(blocks)).byteLength !== contentByteLength) {
      throw new TypeError("Inline Message content byte length is invalid.");
    }
    return { ...base, content: { state: "inline", blocks } };
  }
  if (
    item.contentState !== "chunked" ||
    contentByteLength <= APPLICATION_SESSION_MESSAGE_LIMITS.inlineMaxBytes ||
    Object.hasOwn(rawItem, "contentBlocks")
  ) {
    throw new TypeError("Chunked Message content is invalid.");
  }
  return { ...base, content: { state: "chunked" } };
}

function projectMessageContentChunk(
  value: unknown,
  expected: SessionMessageScope,
  expectedMessageId: string,
  expectedOffset: number,
  requestedMaxBytes: number,
): ApplicationSessionMessageContentChunk {
  const chunk = projectionRecord(value, ["sessionId", "messageId", "offset", "totalBytes", "eof", "bytes"]);
  if (boundedString(chunk.sessionId) !== expected.sessionId || boundedString(chunk.messageId) !== expectedMessageId) {
    throw new TypeError("Message content chunk scope mismatch.");
  }
  const offset = integer(chunk.offset, 0, Number.MAX_SAFE_INTEGER);
  const totalBytes = integer(chunk.totalBytes, 2, APPLICATION_SESSION_MESSAGE_LIMITS.maxContentBytes);
  if (offset !== expectedOffset || !(chunk.bytes instanceof ArrayBuffer) || typeof chunk.eof !== "boolean") {
    throw new TypeError("Message content chunk is invalid.");
  }
  const byteLength = chunk.bytes.byteLength;
  const endOffset = offset + byteLength;
  if (
    byteLength > requestedMaxBytes ||
    !Number.isSafeInteger(endOffset) ||
    (offset < totalBytes
      ? byteLength === 0 || endOffset > totalBytes || chunk.eof !== (endOffset === totalBytes)
      : byteLength !== 0 || !chunk.eof)
  ) {
    throw new TypeError("Message content chunk range is inconsistent.");
  }
  const bytes = cloneOwnedArrayBuffer(chunk.bytes);
  if (bytes.byteLength !== byteLength) throw new TypeError("Message content chunk ownership is invalid.");
  const result = {
    sessionId: expected.sessionId,
    messageId: expectedMessageId,
    offset,
    totalBytes,
    byteLength,
    bytes,
  } as const;
  return chunk.eof ? { ...result, eof: true } : { ...result, eof: false, nextOffset: endOffset };
}

function cloneOwnedArrayBuffer(source: ArrayBuffer): ArrayBuffer {
  const sourceBytes = new Uint8Array(source);
  const result = new ArrayBuffer(sourceBytes.byteLength);
  const resultBytes = new Uint8Array(result);
  for (let index = 0; index < sourceBytes.byteLength; index += 1) resultBytes[index] = sourceBytes[index]!;
  return result;
}

function assertScope(value: Readonly<Record<string, unknown>>, expected: SessionMessageScope): void {
  if (
    boundedString(value.sessionId) !== expected.sessionId ||
    boundedString(value.workspaceKey) !== expected.workspaceKey
  ) {
    throw new TypeError("Message page scope mismatch.");
  }
}

function prepareOperation<TValue>(options: unknown, decodeRequest: () => TValue): PreparedOperation<TValue> {
  const operationStartedAt = Date.now();
  let decodedOptions: ApplicationOperationOptions | undefined;
  try {
    decodedOptions = decodeOperationOptions(options);
  } catch {
    return { ok: false, response: requestFailure() };
  }
  const control: OperationControl = {
    ...(decodedOptions?.timeoutMs === undefined ? {} : { deadlineAt: operationStartedAt + decodedOptions.timeoutMs }),
    ...(decodedOptions?.signal === undefined ? {} : { signal: decodedOptions.signal }),
    persistenceStarted: false,
  };
  const beforeDecode = getOperationInterruption(control);
  if (beforeDecode !== undefined) return { ok: false, response: operationInterruptionFailure(beforeDecode) };
  let input: TValue;
  try {
    input = decodeRequest();
  } catch {
    return { ok: false, response: requestFailure() };
  }
  const afterDecode = getOperationInterruption(control);
  return afterDecode === undefined
    ? { ok: true, input, control }
    : { ok: false, response: operationInterruptionFailure(afterDecode) };
}

function decodeOperationOptions(value: unknown): ApplicationOperationOptions | undefined {
  if (value === undefined) return undefined;
  const options = requestRecord(value, ["timeoutMs", "signal"]);
  const timeoutMs = optionalInteger(options.timeoutMs, 1, 2_147_483_647);
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new TypeError("Invalid signal.");
  return {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal as AbortSignal }),
  };
}

async function readRepository<TValue>(
  control: OperationControl,
  execute: (options: ApplicationOperationOptions | undefined) => Promise<TValue>,
): Promise<OperationResolution<TValue>> {
  const interruption = getOperationInterruption(control);
  if (interruption !== undefined) return { ok: false, response: interruptionFailure(control, interruption) };
  const repositoryAbort = new AbortController();
  const settlement = await runControlled(
    control,
    () => {
      control.persistenceStarted = true;
      return execute({ signal: repositoryAbort.signal });
    },
    () => repositoryAbort.abort(),
  );
  if (settlement.status === "interrupted") {
    return { ok: false, response: interruptionFailure(control, settlement.interruption) };
  }
  if (settlement.status === "rejected") return { ok: false, response: mapThrownReadFailure(settlement.error) };
  return { ok: true, value: settlement.value };
}

function projectOperationValue<TValue>(control: OperationControl, project: () => TValue): OperationResolution<TValue> {
  try {
    const value = project();
    const interruption = getOperationInterruption(control);
    return interruption === undefined
      ? { ok: true, value }
      : { ok: false, response: interruptionFailure(control, interruption) };
  } catch {
    const interruption = getOperationInterruption(control);
    return {
      ok: false,
      response:
        interruption === undefined
          ? control.persistenceStarted
            ? persistenceApplicationFailure()
            : prePersistenceApplicationFailure()
          : interruptionFailure(control, interruption),
    };
  }
}

async function runControlled<TValue>(
  control: OperationControl,
  start: () => Promise<TValue>,
  interruptStartedWork?: () => void,
): Promise<ControlledSettlement<TValue>> {
  const beforeStart = getOperationInterruption(control);
  if (beforeStart !== undefined) return { status: "interrupted", interruption: beforeStart };
  let work: Promise<TValue>;
  try {
    work = Promise.resolve(start());
  } catch (error) {
    const interruption = getOperationInterruption(control);
    return interruption === undefined ? { status: "rejected", error } : { status: "interrupted", interruption };
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ControlledSettlement<TValue>) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      control.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const interrupt = (interruption: OperationInterruption) => {
      if (settled) return;
      try {
        interruptStartedWork?.();
      } catch {
        // Interruption owns the public result even if the Repository abort hook fails.
      }
      finish({ status: "interrupted", interruption });
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
    if (remaining !== undefined) timer = setTimeout(() => interrupt("timeout"), remaining);
    control.signal?.addEventListener("abort", onAbort, { once: true });
    if (control.signal?.aborted) onAbort();
  });
}

function readSuccess<TValue>(control: OperationControl, value: TValue): ApplicationOperationResponse<TValue, "read"> {
  const response = { overallStatus: "success", value, persistence: { status: "read", effect: "none" } } as const;
  const interruption = getOperationInterruption(control);
  return interruption === undefined ? response : interruptionFailure(control, interruption);
}

function readOutcome<TValue>(
  control: OperationControl,
  value: TValue,
  issues: readonly MessageOmissionIssue[],
): ApplicationOperationResponse<TValue, "read"> {
  if (issues.length === 0) return readSuccess(control, value);
  const response = {
    overallStatus: "partial_success",
    value,
    issues: issues as [MessageOmissionIssue, ...MessageOmissionIssue[]],
    persistence: { status: "read", effect: "none" },
  } as const;
  const interruption = getOperationInterruption(control);
  return interruption === undefined ? response : interruptionFailure(control, interruption);
}

function projectAccessDecision(value: unknown): ApplicationAccessDecision {
  const decision = projectionRecord(value, ["allowed", "error"]);
  if (decision.allowed === true) return { allowed: true };
  if (decision.allowed !== false) throw new TypeError("Access decision is invalid.");
  const error = projectionRecord(decision.error, ["code", "message", "retryable"]);
  const code = enumString(error.code, [
    "workspace_invalid",
    "workspace_unavailable",
    "authorization_invalid",
    "forbidden",
  ] as const);
  if (typeof error.retryable !== "boolean") throw new TypeError("Access retryability is invalid.");
  return {
    allowed: false,
    error: { code, message: boundedString(error.message, 4_096), retryable: error.retryable },
  };
}

function requestFailure(): ApplicationSessionMessageFailureResponse {
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
  error: Extract<ApplicationAccessDecision, Readonly<{ allowed: false }>>["error"],
): ApplicationSessionMessageFailureResponse {
  return {
    overallStatus: "failure",
    error: { kind: "access", code: error.code, message: accessErrorMessage(error.code), retryable: error.retryable },
    persistence: { status: "not_attempted", effect: "none" },
  };
}

function operationInterruptionFailure(interruption: OperationInterruption): ApplicationSessionMessageFailureResponse {
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

function interruptionFailure(
  control: OperationControl,
  interruption: OperationInterruption,
): ApplicationSessionMessageFailureResponse {
  if (!control.persistenceStarted) return operationInterruptionFailure(interruption);
  return {
    overallStatus: "failure",
    error: {
      kind: "persistence",
      code: interruption === "timeout" ? "persistence_timeout" : "persistence_canceled",
      message: interruption === "timeout" ? "Application operation timed out." : "Application operation was canceled.",
      retryable: interruption === "timeout",
      effect: "none",
    },
    persistence: { status: "failed", effect: "none" },
  };
}

function prePersistenceApplicationFailure(): ApplicationSessionMessageFailureResponse {
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

function persistenceApplicationFailure(): ApplicationSessionMessageFailureResponse {
  return {
    overallStatus: "failure",
    error: {
      kind: "application",
      code: "internal_error",
      message: "Application Service could not complete the operation.",
      retryable: false,
    },
    persistence: { status: "failed", effect: "none" },
  };
}

function mapThrownReadFailure(error: unknown): ApplicationSessionMessageFailureResponse {
  if (!(error instanceof PersistenceClientError)) return persistenceApplicationFailure();
  const persistenceError = error.persistenceError;
  if (
    persistenceError.code === "request_invalid" ||
    persistenceError.code === "cursor_invalid" ||
    persistenceError.code === "not_found"
  ) {
    return {
      overallStatus: "failure",
      error: {
        kind: "domain",
        code: persistenceError.code,
        message: repositoryDomainErrorMessage(persistenceError.code),
        retryable: persistenceError.retryable,
      },
      persistence: { status: "rejected", effect: "none" },
    };
  }
  return {
    overallStatus: "failure",
    error: {
      kind: "persistence",
      code: mapPersistenceErrorCode(persistenceError.code),
      message: "Persistence could not complete the Message read.",
      retryable: persistenceError.retryable,
      effect: "none",
    },
    persistence: { status: "failed", effect: "none" },
  };
}

function accessErrorMessage(
  code: Extract<ApplicationAccessDecision, Readonly<{ allowed: false }>>["error"]["code"],
): string {
  switch (code) {
    case "workspace_invalid":
      return "The workspace authorization scope is invalid.";
    case "workspace_unavailable":
      return "The workspace authorization scope is unavailable.";
    case "authorization_invalid":
      return "The authorization context is invalid.";
    case "forbidden":
      return "The Message read is not authorized.";
  }
}

function repositoryDomainErrorMessage(code: "request_invalid" | "cursor_invalid" | "not_found"): string {
  switch (code) {
    case "request_invalid":
      return "The Message read request was rejected.";
    case "cursor_invalid":
      return "The Message cursor is invalid.";
    case "not_found":
      return "The requested Message resource was not found.";
  }
}

function mapPersistenceErrorCode(code: PersistenceError["code"]) {
  switch (code) {
    case "worker_not_ready":
    case "worker_closing":
    case "worker_crashed":
    case "worker_start_failed":
    case "worker_shutdown_forced":
    case "database_unavailable":
      return "persistence_unavailable" as const;
    case "queue_full":
    case "database_busy":
      return "persistence_busy" as const;
    case "request_timeout":
      return "persistence_timeout" as const;
    case "request_canceled":
      return "persistence_canceled" as const;
    case "database_path_invalid":
    case "database_identity_mismatch":
    case "database_schema_unknown":
    case "database_schema_too_new":
    case "database_schema_too_old":
    case "database_pragma_mismatch":
    case "database_wal_unavailable":
    case "database_bootstrap_failed":
    case "schema_artifact_invalid":
      return "persistence_configuration_invalid" as const;
    case "database_schema_verification_failed":
    case "database_integrity_check_failed":
      return "persistence_integrity_failed" as const;
    case "response_too_large":
      return "persistence_response_too_large" as const;
    default:
      return "persistence_operation_failed" as const;
  }
}

function getOperationInterruption(control: OperationControl): OperationInterruption | undefined {
  if (control.deadlineAt !== undefined && control.deadlineAt <= Date.now()) return "timeout";
  if (control.signal?.aborted) return "canceled";
  return undefined;
}

function getRemainingTimeout(control: OperationControl): number | undefined {
  return control.deadlineAt === undefined ? undefined : Math.max(0, control.deadlineAt - Date.now());
}

function requestRecord(value: unknown, allowedKeys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new TypeError("Request object is invalid.");
  }
  return Object.fromEntries(allowedKeys.map((key) => [key, value[key]]));
}

function projectionRecord(value: unknown, allowedKeys: readonly string[]): Readonly<Record<string, unknown>> {
  const record = plainRecord(value);
  return Object.fromEntries(allowedKeys.map((key) => [key, record[key]]));
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) throw new TypeError("Projection object is invalid.");
  return value;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isDenseArray(value: unknown, maxLength: number): value is readonly unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function boundedString(
  value: unknown,
  maxLength: number = APPLICATION_SESSION_MESSAGE_LIMITS.maxIdentifierLength,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError("String is invalid.");
  }
  return value;
}

function optionalBoundedString(value: unknown, maxLength: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, maxLength);
}

function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new TypeError("Integer is invalid.");
  }
  return value as number;
}

function optionalInteger(value: unknown, min: number, max: number): number | undefined {
  return value === undefined ? undefined : integer(value, min, max);
}

function enumString<const TValues extends readonly string[]>(value: unknown, values: TValues): TValues[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new TypeError("Enum value is invalid.");
  return value as TValues[number];
}
