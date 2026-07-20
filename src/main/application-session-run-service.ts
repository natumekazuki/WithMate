import {
  APPLICATION_SESSION_RUN_LIMITS,
  type ApplicationSessionRunAccessValidationInput,
  type ApplicationSessionRunAccessValidator,
  type ApplicationSessionRunItem,
  type ApplicationSessionRunOperations,
  type ApplicationSessionRunPage,
  type ApplicationSessionRunsRequest,
} from "../shared/application-session-run-model.js";
import type {
  ApplicationAccessDecision,
  ApplicationOperationOptions,
  ApplicationOperationResponse,
} from "../shared/application-service-model.js";
import type { PersistenceError } from "../shared/persistence-protocol.js";
import { PERSISTED_RUN_PROJECTION_KEYS, projectPersistedRun } from "./application-run-projection.js";
import { PersistenceClientError } from "./persistence-worker-client.js";
import type { PersistenceWorkerClient } from "./persistence-worker-client.js";
import { RepositoryReadClient } from "./repository-read-client.js";

type SessionRunReadPort = Pick<RepositoryReadClient, "sessionGet" | "runsPage">;

type ApplicationSessionRunFailureResponse = Extract<
  ApplicationOperationResponse<never, "read">,
  Readonly<{ overallStatus: "failure" }>
>;

type PreparedOperation<TValue> =
  | Readonly<{ ok: true; input: TValue; control: OperationControl }>
  | Readonly<{ ok: false; response: ApplicationSessionRunFailureResponse }>;

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
  Readonly<{ ok: true; value: TValue }> | Readonly<{ ok: false; response: ApplicationSessionRunFailureResponse }>;

type SessionRunScope = Readonly<{ sessionId: string; workspaceKey: string }>;

type RunOmissionIssue = Readonly<{
  kind: "omission";
  code: "response_size_limit";
  message: string;
  ordinal: number;
}>;

type ProjectedRunPage = Readonly<{
  value: ApplicationSessionRunPage;
  issues: readonly RunOmissionIssue[];
}>;

const RUN_ITEM_PROJECTION_KEYS = [
  "omitted",
  "reason",
  "runId",
  "sessionId",
  "ordinal",
  "initiatingMessageId",
  "finalAssistantMessageId",
  ...PERSISTED_RUN_PROJECTION_KEYS,
] as const;

const RUN_VALUE_KEYS = RUN_ITEM_PROJECTION_KEYS.filter(
  (key) => key !== "omitted" && key !== "reason" && key !== "ordinal",
);

export type ApplicationSessionRunServiceOptions<TAuthorizationContext> = Readonly<{
  reads: SessionRunReadPort;
  access: ApplicationSessionRunAccessValidator<TAuthorizationContext>;
  snapshotAuthorization(value: unknown): TAuthorizationContext;
}>;

export function createApplicationSessionRunOperations<TAuthorizationContext>(
  worker: PersistenceWorkerClient,
  options: Omit<ApplicationSessionRunServiceOptions<TAuthorizationContext>, "reads">,
): ApplicationSessionRunOperations<TAuthorizationContext> {
  return new ApplicationSessionRunService({ reads: new RepositoryReadClient(worker), ...options });
}

export class ApplicationSessionRunService<
  TAuthorizationContext,
> implements ApplicationSessionRunOperations<TAuthorizationContext> {
  readonly #reads: SessionRunReadPort;
  readonly #access: ApplicationSessionRunAccessValidator<TAuthorizationContext>;
  readonly #snapshotAuthorization: (value: unknown) => TAuthorizationContext;

  constructor(options: ApplicationSessionRunServiceOptions<TAuthorizationContext>) {
    this.#reads = options.reads;
    this.#access = options.access;
    this.#snapshotAuthorization = options.snapshotAuthorization;
  }

  async runs(
    request: ApplicationSessionRunsRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationSessionRunPage, "read">> {
    const prepared = prepareOperation(options, () => decodeRunsRequest(request, this.#snapshotAuthorization));
    if (!prepared.ok) return prepared.response;
    const scope = await this.#authorizeAndResolveScope(prepared.input, prepared.control);
    if (!scope.ok) return scope.response;
    const limit = prepared.input.limit ?? APPLICATION_SESSION_RUN_LIMITS.runsDefaultItems;
    const page = await readRepository(prepared.control, (repositoryOptions) =>
      this.#reads.runsPage(
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
      projectRunPage(page.value, scope.value, prepared.input.cursor, limit),
    );
    return projected.ok
      ? readOutcome(prepared.control, projected.value.value, projected.value.issues)
      : projected.response;
  }

  async #authorizeAndResolveScope(
    input: ApplicationSessionRunsRequest<TAuthorizationContext>,
    control: OperationControl,
  ): Promise<OperationResolution<SessionRunScope>> {
    const authorizationInput: ApplicationSessionRunAccessValidationInput<TAuthorizationContext> = {
      operation: "runs",
      access: "read",
      context: input.context,
      target: { kind: "session_runs", sessionId: input.sessionId },
    };
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

function decodeRunsRequest<TAuthorizationContext>(
  value: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): ApplicationSessionRunsRequest<TAuthorizationContext> {
  const request = requestRecord(value, ["context", "sessionId", "cursor", "limit"]);
  const context = requestRecord(request.context, ["authorization"]);
  const cursor = optionalBoundedString(request.cursor, APPLICATION_SESSION_RUN_LIMITS.maxCursorLength);
  const limit = optionalInteger(request.limit, 1, APPLICATION_SESSION_RUN_LIMITS.runsMaxItems);
  return {
    context: { authorization: snapshotAuthorization(context.authorization) },
    sessionId: boundedString(request.sessionId),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function projectRunPage(
  value: unknown,
  expected: SessionRunScope,
  inputCursor: string | undefined,
  limit: number,
): ProjectedRunPage {
  const page = exactProjectionRecord(value, ["sessionId", "workspaceKey", "items", "nextCursor"]);
  if (
    boundedString(page.sessionId) !== expected.sessionId ||
    boundedString(page.workspaceKey) !== expected.workspaceKey
  ) {
    throw new TypeError("Run page scope mismatch.");
  }
  if (!isDenseArray(page.items, limit)) throw new TypeError("Run page is invalid.");
  const nextCursor = optionalBoundedString(page.nextCursor, APPLICATION_SESSION_RUN_LIMITS.maxCursorLength);
  if (page.items.length === 0 && nextCursor !== undefined) throw new TypeError("Empty Run page has a cursor.");
  if (nextCursor !== undefined && nextCursor === inputCursor) throw new TypeError("Run cursor did not advance.");

  const items: ApplicationSessionRunItem[] = [];
  const issues: RunOmissionIssue[] = [];
  let previousOrdinal = 0;
  for (const rawValue of page.items) {
    const originalItem = plainRecord(rawValue);
    const rawItem = exactProjectionRecord(originalItem, RUN_ITEM_PROJECTION_KEYS);
    const ordinal = integer(rawItem.ordinal, 1, Number.MAX_SAFE_INTEGER);
    if (ordinal <= previousOrdinal) throw new TypeError("Run ordinals are invalid.");
    previousOrdinal = ordinal;
    if (rawItem.omitted === true) {
      if (rawItem.reason !== "response_size_limit" || RUN_VALUE_KEYS.some((key) => Object.hasOwn(originalItem, key))) {
        throw new TypeError("Run omission is invalid.");
      }
      issues.push({
        kind: "omission",
        code: "response_size_limit",
        message: "Run was omitted because the response size limit was reached.",
        ordinal,
      });
      continue;
    }
    if (Object.hasOwn(originalItem, "omitted") || Object.hasOwn(originalItem, "reason")) {
      throw new TypeError("Run item is invalid.");
    }
    items.push(projectRunItem(rawItem, expected, ordinal));
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

function projectRunItem(
  item: Readonly<Record<string, unknown>>,
  expected: SessionRunScope,
  ordinal: number,
): ApplicationSessionRunItem {
  const runId = boundedString(item.runId);
  if (boundedString(item.sessionId) !== expected.sessionId) throw new TypeError("Run identity mismatch.");
  const initiatingMessageId = boundedString(item.initiatingMessageId);
  const finalAssistantMessageId = optionalBoundedString(
    item.finalAssistantMessageId,
    APPLICATION_SESSION_RUN_LIMITS.maxIdentifierLength,
  );
  const persisted = projectPersistedRun(item);
  const identity = { runId, ordinal, initiatingMessageId } as const;
  if (persisted.phase === "completed") {
    return {
      ...identity,
      ...persisted,
      ...(finalAssistantMessageId === undefined ? {} : { finalAssistantMessageId }),
    };
  }
  if (finalAssistantMessageId !== undefined) throw new TypeError("Non-completed Run has a final Message.");
  return { ...identity, ...persisted };
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
  issues: readonly RunOmissionIssue[],
): ApplicationOperationResponse<TValue, "read"> {
  if (issues.length === 0) return readSuccess(control, value);
  const response = {
    overallStatus: "partial_success",
    value,
    issues: issues as [RunOmissionIssue, ...RunOmissionIssue[]],
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

function requestFailure(): ApplicationSessionRunFailureResponse {
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
): ApplicationSessionRunFailureResponse {
  return {
    overallStatus: "failure",
    error: { kind: "access", code: error.code, message: accessErrorMessage(error.code), retryable: error.retryable },
    persistence: { status: "not_attempted", effect: "none" },
  };
}

function operationInterruptionFailure(interruption: OperationInterruption): ApplicationSessionRunFailureResponse {
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
): ApplicationSessionRunFailureResponse {
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

function prePersistenceApplicationFailure(): ApplicationSessionRunFailureResponse {
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

function persistenceApplicationFailure(): ApplicationSessionRunFailureResponse {
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

function mapThrownReadFailure(error: unknown): ApplicationSessionRunFailureResponse {
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
      message: "Persistence could not complete the Run history read.",
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
      return "The Run history read is not authorized.";
  }
}

function repositoryDomainErrorMessage(code: "request_invalid" | "cursor_invalid" | "not_found"): string {
  switch (code) {
    case "request_invalid":
      return "The Run history read request was rejected.";
    case "cursor_invalid":
      return "The Run history cursor is invalid.";
    case "not_found":
      return "The requested Run history resource was not found.";
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

function exactProjectionRecord(value: unknown, allowedKeys: readonly string[]): Readonly<Record<string, unknown>> {
  const record = plainRecord(value);
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) {
    throw new TypeError("Projection object has unknown fields.");
  }
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

function boundedString(value: unknown, maxLength: number = APPLICATION_SESSION_RUN_LIMITS.maxIdentifierLength): string {
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
