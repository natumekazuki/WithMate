import type {
  ApplicationRunAccessValidationInput,
  ApplicationRunAccessValidator,
  ApplicationRunEvent,
  ApplicationRunEventPage,
  ApplicationRunEventsRequest,
  ApplicationRunFollowRequest,
  ApplicationRunFollowResult,
  ApplicationRunLiveActivity,
  ApplicationRunOperations,
  ApplicationRunOperation,
  ApplicationRunPhase,
  ApplicationRunStatus,
  ApplicationRunStatusRequest,
} from "../shared/application-run-model.js";
import { APPLICATION_RUN_LIMITS } from "../shared/application-run-model.js";
import type {
  ApplicationAccessDecision,
  ApplicationOperationOptions,
  ApplicationOperationResponse,
} from "../shared/application-service-model.js";
import type { PersistenceError } from "../shared/persistence-protocol.js";
import type { RunEventPage } from "../shared/repository-read-model.js";
import { projectPersistedRun } from "./application-run-projection.js";
import { PersistenceClientError } from "./persistence-worker-client.js";
import type { PersistenceWorkerClient } from "./persistence-worker-client.js";
import { RepositoryReadClient } from "./repository-read-client.js";

type RunReadPort = Pick<RepositoryReadClient, "sessionGet" | "runGet" | "runEventsPage">;

type ApplicationRunFailureResponse = Extract<
  ApplicationOperationResponse<never, "read">,
  Readonly<{ overallStatus: "failure" }>
>;

type RequestDecodeResult<TValue> =
  Readonly<{ ok: true; value: TValue }> | Readonly<{ ok: false; response: ApplicationRunFailureResponse }>;

type PreparedOperation<TValue> =
  | Readonly<{ ok: true; input: TValue; control: OperationControl }>
  | Readonly<{ ok: false; response: ApplicationRunFailureResponse }>;

type OperationControl = {
  readonly deadlineAt?: number;
  readonly signal?: AbortSignal;
  persistenceStarted: boolean;
};

type OperationInterruption = "timeout" | "canceled";

type ControlledSettlement<TValue> =
  | Readonly<{ status: "fulfilled"; value: TValue }>
  | Readonly<{ status: "rejected"; error: unknown }>
  | Readonly<{ status: "interrupted"; interruption: OperationInterruption; started: boolean }>;

type OperationResolution<TValue> =
  Readonly<{ ok: true; value: TValue }> | Readonly<{ ok: false; response: ApplicationRunFailureResponse }>;

type RunScope = Readonly<{ sessionId: string; runId: string; workspaceKey: string }>;

type ProjectedEventPage = Readonly<{
  value: ApplicationRunEventPage;
  issues: readonly Readonly<{
    kind: "omission";
    code: "response_size_limit";
    message: string;
    ordinal?: number;
  }>[];
  consumed: boolean;
  containsTerminalEvent: boolean;
  hasMore: boolean;
}>;

export type ApplicationRunLiveActivitySnapshot = Readonly<{
  sessionId: string;
  runId: string;
  runVersion: number;
  activity: ApplicationRunLiveActivity;
}>;

export interface ApplicationRunLiveActivityPort {
  read(input: Readonly<{ sessionId: string; runId: string }>): Promise<ApplicationRunLiveActivitySnapshot | null>;
}

export interface ApplicationRunClock {
  now(): number;
}

export interface ApplicationRunSleeper {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export type ApplicationRunServiceOptions<TAuthorizationContext> = Readonly<{
  reads: RunReadPort;
  access: ApplicationRunAccessValidator<TAuthorizationContext>;
  snapshotAuthorization(value: unknown): TAuthorizationContext;
  liveActivity?: ApplicationRunLiveActivityPort;
  clock?: ApplicationRunClock;
  sleeper?: ApplicationRunSleeper;
}>;

const terminalPhases = new Set<ApplicationRunPhase>(["completed", "failed", "canceled", "interrupted"]);

const defaultLiveActivity: ApplicationRunLiveActivityPort = {
  async read() {
    return null;
  },
};

const monotonicClock: ApplicationRunClock = {
  now: () => performance.now(),
};

const defaultSleeper: ApplicationRunSleeper = {
  sleep(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const finish = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  },
};

export function createApplicationRunOperations<TAuthorizationContext>(
  worker: PersistenceWorkerClient,
  options: Omit<ApplicationRunServiceOptions<TAuthorizationContext>, "reads">,
): ApplicationRunOperations<TAuthorizationContext> {
  return new ApplicationRunService({ reads: new RepositoryReadClient(worker), ...options });
}

export class ApplicationRunService<TAuthorizationContext> implements ApplicationRunOperations<TAuthorizationContext> {
  readonly #reads: RunReadPort;
  readonly #access: ApplicationRunAccessValidator<TAuthorizationContext>;
  readonly #snapshotAuthorization: (value: unknown) => TAuthorizationContext;
  readonly #liveActivity: ApplicationRunLiveActivityPort;
  readonly #clock: ApplicationRunClock;
  readonly #sleeper: ApplicationRunSleeper;

  constructor(options: ApplicationRunServiceOptions<TAuthorizationContext>) {
    this.#reads = options.reads;
    this.#access = options.access;
    this.#snapshotAuthorization = options.snapshotAuthorization;
    this.#liveActivity = options.liveActivity ?? defaultLiveActivity;
    this.#clock = options.clock ?? monotonicClock;
    this.#sleeper = options.sleeper ?? defaultSleeper;
  }

  async status(
    request: ApplicationRunStatusRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationRunStatus, "read">> {
    const prepared = prepareOperation(options, () => decodeStatusRequest(request, this.#snapshotAuthorization));
    if (!prepared.ok) return prepared.response;
    const scope = await this.#authorizeAndResolveScope("status", prepared.input, prepared.control);
    if (!scope.ok) return scope.response;
    const status = await this.#readStatus(scope.value, prepared.control);
    return status.ok ? readSuccess(prepared.control, status.value.status) : status.response;
  }

  async events(
    request: ApplicationRunEventsRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationRunEventPage, "read">> {
    const prepared = prepareOperation(options, () => decodeEventsRequest(request, this.#snapshotAuthorization));
    if (!prepared.ok) return prepared.response;
    const scope = await this.#authorizeAndResolveScope("events", prepared.input, prepared.control);
    if (!scope.ok) return scope.response;
    const page = await this.#readEvents(
      scope.value,
      prepared.input.cursor,
      prepared.input.limit ?? APPLICATION_RUN_LIMITS.eventsDefaultItems,
      prepared.control,
    );
    return page.ok ? readOutcome(prepared.control, page.value.value, page.value.issues) : page.response;
  }

  async follow(
    request: ApplicationRunFollowRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationOperationResponse<ApplicationRunFollowResult, "read">> {
    const prepared = prepareOperation(options, () => decodeFollowRequest(request, this.#snapshotAuthorization));
    if (!prepared.ok) return prepared.response;
    const waitStartedAt = projectOperationValue(prepared.control, () => this.#clock.now());
    if (!waitStartedAt.ok) return waitStartedAt.response;
    const scope = await this.#authorizeAndResolveScope("follow", prepared.input, prepared.control);
    if (!scope.ok) return scope.response;

    const limit = prepared.input.limit ?? APPLICATION_RUN_LIMITS.eventsDefaultItems;
    const waitMs = prepared.input.waitMs ?? APPLICATION_RUN_LIMITS.followDefaultWaitMs;
    const pollMs = prepared.input.pollMs ?? APPLICATION_RUN_LIMITS.followDefaultPollMs;
    const waitDeadlineAt = waitStartedAt.value + waitMs;
    let cursor = prepared.input.cursor;

    while (true) {
      const status = await this.#readStatus(scope.value, prepared.control);
      if (!status.ok) return status.response;
      const page = await this.#readEvents(scope.value, cursor, limit, prepared.control);
      if (!page.ok) return page.response;

      if (page.value.consumed) {
        let observedStatus = status.value.status;
        if (page.value.containsTerminalEvent && !isTerminalStatus(observedStatus)) {
          const terminalStatus = await this.#readStatus(scope.value, prepared.control);
          if (!terminalStatus.ok) return terminalStatus.response;
          if (!isTerminalStatus(terminalStatus.value.status)) return persistenceApplicationFailure();
          observedStatus = terminalStatus.value.status;
        }
        const reason =
          isTerminalStatus(observedStatus) && (page.value.containsTerminalEvent || !page.value.hasMore)
            ? "terminal"
            : "events";
        const value =
          reason === "terminal"
            ? ({ reason, status: observedStatus, events: page.value.value } as ApplicationRunFollowResult)
            : ({ reason, status: observedStatus, events: page.value.value } as ApplicationRunFollowResult);
        return readOutcome(prepared.control, value, page.value.issues);
      }

      cursor = page.value.value.nextCursor;
      if (isTerminalStatus(status.value.status)) {
        const value = {
          reason: "terminal",
          status: status.value.status,
          events: page.value.value,
        } as ApplicationRunFollowResult;
        return readOutcome(prepared.control, value, page.value.issues);
      }

      const observedAt = projectOperationValue(prepared.control, () => this.#clock.now());
      if (!observedAt.ok) return observedAt.response;
      if (observedAt.value >= waitDeadlineAt) {
        return readSuccess(prepared.control, {
          reason: "deadline",
          status: status.value.status,
          events: page.value.value,
        });
      }
      const sleep = await this.#sleep(Math.min(pollMs, waitDeadlineAt - observedAt.value), prepared.control);
      if (!sleep.ok) return sleep.response;
    }
  }

  async #authorizeAndResolveScope(
    operation: ApplicationRunOperation,
    input: ApplicationRunStatusRequest<TAuthorizationContext>,
    control: OperationControl,
  ): Promise<OperationResolution<RunScope>> {
    const authorizationInput: ApplicationRunAccessValidationInput<TAuthorizationContext> = {
      operation,
      access: "read",
      context: input.context,
      target: { kind: "run", sessionId: input.sessionId, runId: input.runId },
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
      return { sessionId, runId: input.runId, workspaceKey };
    });
  }

  async #readStatus(
    scope: RunScope,
    control: OperationControl,
  ): Promise<OperationResolution<Readonly<{ status: ApplicationRunStatus; version: number }>>> {
    const run = await readRepository(control, (repositoryOptions) => this.#reads.runGet(scope, repositoryOptions));
    if (!run.ok) return run;
    const persisted = projectOperationValue(control, () => projectRunStatus(run.value, scope));
    if (!persisted.ok) return persisted;
    const persistedValue = persisted.value;
    if (persistedValue.status.phase !== "active") return persisted;
    const activeStatus = persistedValue.status;

    const live = await runControlled(control, () =>
      this.#liveActivity.read({ sessionId: scope.sessionId, runId: scope.runId }),
    );
    if (live.status === "interrupted") {
      return { ok: false, response: interruptionFailure(control, live.interruption) };
    }
    if (live.status === "rejected") return { ok: false, response: persistenceApplicationFailure() };
    return projectOperationValue(control, () => {
      const activity = projectLiveActivity(live.value, scope, persistedValue.version);
      return {
        ...persistedValue,
        status: { ...activeStatus, liveActivity: activity },
      };
    });
  }

  async #readEvents(
    scope: RunScope,
    cursor: string | undefined,
    limit: number,
    control: OperationControl,
  ): Promise<OperationResolution<ProjectedEventPage>> {
    const events = await readRepository(control, (repositoryOptions) =>
      this.#reads.runEventsPage({ ...scope, ...(cursor === undefined ? {} : { cursor }), limit }, repositoryOptions),
    );
    if (!events.ok) return events;
    return projectOperationValue(control, () => projectRunEventPage(events.value, scope, cursor, limit));
  }

  async #sleep(milliseconds: number, control: OperationControl): Promise<OperationResolution<undefined>> {
    const sleeperAbort = new AbortController();
    const sleep = await runControlled(
      control,
      () => this.#sleeper.sleep(milliseconds, sleeperAbort.signal),
      () => sleeperAbort.abort(),
    );
    if (sleep.status === "interrupted") {
      return { ok: false, response: interruptionFailure(control, sleep.interruption) };
    }
    if (sleep.status === "rejected") return { ok: false, response: persistenceApplicationFailure() };
    return { ok: true, value: undefined };
  }
}

function decodeStatusRequest<TAuthorizationContext>(
  value: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): RequestDecodeResult<ApplicationRunStatusRequest<TAuthorizationContext>> {
  const request = requestRecord(value, ["context", "sessionId", "runId"]);
  const context = decodeContext(request.context, snapshotAuthorization);
  return {
    ok: true,
    value: {
      context,
      sessionId: boundedString(request.sessionId),
      runId: boundedString(request.runId),
    },
  };
}

function decodeEventsRequest<TAuthorizationContext>(
  value: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): RequestDecodeResult<ApplicationRunEventsRequest<TAuthorizationContext>> {
  const request = requestRecord(value, ["context", "sessionId", "runId", "cursor", "limit"]);
  const base = decodeContextAndScope(request, snapshotAuthorization);
  const cursor = optionalBoundedString(request.cursor, APPLICATION_RUN_LIMITS.maxCursorLength);
  const limit = optionalInteger(request.limit, 1, APPLICATION_RUN_LIMITS.eventsMaxItems);
  return {
    ok: true,
    value: {
      ...base,
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
    },
  };
}

function decodeFollowRequest<TAuthorizationContext>(
  value: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): RequestDecodeResult<ApplicationRunFollowRequest<TAuthorizationContext>> {
  const request = requestRecord(value, ["context", "sessionId", "runId", "cursor", "limit", "waitMs", "pollMs"]);
  const base = decodeContextAndScope(request, snapshotAuthorization);
  const cursor = optionalBoundedString(request.cursor, APPLICATION_RUN_LIMITS.maxCursorLength);
  const limit = optionalInteger(request.limit, 1, APPLICATION_RUN_LIMITS.eventsMaxItems);
  const waitMs = optionalInteger(request.waitMs, 0, APPLICATION_RUN_LIMITS.followMaxWaitMs);
  const pollMs = optionalInteger(
    request.pollMs,
    APPLICATION_RUN_LIMITS.followMinPollMs,
    APPLICATION_RUN_LIMITS.followMaxPollMs,
  );
  return {
    ok: true,
    value: {
      ...base,
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
      ...(waitMs === undefined ? {} : { waitMs }),
      ...(pollMs === undefined ? {} : { pollMs }),
    },
  };
}

function decodeContextAndScope<TAuthorizationContext>(
  request: Readonly<Record<string, unknown>>,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): ApplicationRunStatusRequest<TAuthorizationContext> {
  return {
    context: decodeContext(request.context, snapshotAuthorization),
    sessionId: boundedString(request.sessionId),
    runId: boundedString(request.runId),
  };
}

function decodeContext<TAuthorizationContext>(
  value: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
) {
  const context = requestRecord(value, ["authorization"]);
  return { authorization: snapshotAuthorization(context.authorization) } as const;
}

function prepareOperation<TValue>(
  options: unknown,
  decodeRequest: () => RequestDecodeResult<TValue>,
): PreparedOperation<TValue> {
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
  let decoded: RequestDecodeResult<TValue>;
  try {
    decoded = decodeRequest();
  } catch {
    decoded = { ok: false, response: requestFailure() };
  }
  const afterDecode = getOperationInterruption(control);
  if (afterDecode !== undefined) return { ok: false, response: operationInterruptionFailure(afterDecode) };
  return decoded.ok ? { ok: true, input: decoded.value, control } : decoded;
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
  if (beforeStart !== undefined) return { status: "interrupted", interruption: beforeStart, started: false };
  let work: Promise<TValue>;
  try {
    work = Promise.resolve(start());
  } catch (error) {
    const interruption = getOperationInterruption(control);
    if (interruption !== undefined) {
      try {
        interruptStartedWork?.();
      } catch {
        // The operation result is owned by the deadline/cancellation, not an adapter abort hook.
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
        // The operation result is owned by the deadline/cancellation, not an adapter abort hook.
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
    if (remaining !== undefined) timer = setTimeout(() => interrupt("timeout"), remaining);
    control.signal?.addEventListener("abort", onAbort, { once: true });
    if (control.signal?.aborted) onAbort();
  });
}

function projectRunStatus(
  value: unknown,
  expected: RunScope,
): Readonly<{ status: ApplicationRunStatus; version: number }> {
  const outer = projectionRecord(value, ["sessionId", "workspaceKey", "run"]);
  if (
    boundedString(outer.sessionId) !== expected.sessionId ||
    boundedString(outer.workspaceKey) !== expected.workspaceKey
  ) {
    throw new TypeError("Run scope mismatch.");
  }
  const run = projectionRecord(outer.run, [
    "id",
    "sessionId",
    "retryOfRunId",
    "phase",
    "failureOrigin",
    "errorSummary",
    "cancelRequestedAt",
    "cancelAcknowledgedAt",
    "createdAt",
    "startedAt",
    "terminalAt",
    "updatedAt",
    "version",
  ]);
  const runId = boundedString(run.id);
  const sessionId = boundedString(run.sessionId);
  if (runId !== expected.runId || sessionId !== expected.sessionId) throw new TypeError("Run identity mismatch.");
  const version = nonNegativeInteger(run.version);
  const persisted = projectPersistedRun(run);
  const base = {
    sessionId,
    runId,
    ...(persisted.retryOfRunId === undefined ? {} : { retryOfRunId: persisted.retryOfRunId }),
    createdAt: persisted.createdAt,
    ...(persisted.startedAt === undefined ? {} : { startedAt: persisted.startedAt }),
    updatedAt: persisted.updatedAt,
  } as const;

  let status: ApplicationRunStatus;
  switch (persisted.phase) {
    case "queued":
    case "starting":
    case "finalizing":
      status = { ...base, phase: persisted.phase, liveActivity: null };
      break;
    case "active":
      status = { ...base, phase: persisted.phase, liveActivity: null };
      break;
    case "canceling":
      status = {
        ...base,
        phase: persisted.phase,
        liveActivity: null,
        ...(persisted.cancellation === undefined ? {} : { cancellation: persisted.cancellation }),
      };
      break;
    case "completed":
      status = { ...base, phase: persisted.phase, liveActivity: null, terminalAt: persisted.terminalAt };
      break;
    case "failed":
    case "interrupted":
      status = {
        ...base,
        phase: persisted.phase,
        liveActivity: null,
        terminalAt: persisted.terminalAt,
        failure: persisted.failure,
        ...(persisted.cancellation === undefined ? {} : { cancellation: persisted.cancellation }),
      };
      break;
    case "canceled":
      status = {
        ...base,
        phase: persisted.phase,
        liveActivity: null,
        terminalAt: persisted.terminalAt,
        ...(persisted.cancellation === undefined ? {} : { cancellation: persisted.cancellation }),
      };
      break;
  }
  return { status, version };
}

function projectLiveActivity(
  value: unknown,
  expected: RunScope,
  expectedVersion: number,
): ApplicationRunLiveActivity | null {
  if (value === null) return null;
  const snapshot = projectionRecord(value, ["sessionId", "runId", "runVersion", "activity"]);
  if (boundedString(snapshot.sessionId) !== expected.sessionId || boundedString(snapshot.runId) !== expected.runId) {
    throw new TypeError("Live activity scope mismatch.");
  }
  const version = nonNegativeInteger(snapshot.runVersion);
  const activity = enumString(snapshot.activity, ["running", "waiting_approval", "waiting_input", "waiting_child"]);
  return version === expectedVersion ? activity : null;
}

function projectRunEventPage(
  value: RunEventPage,
  expected: RunScope,
  inputCursor: string | undefined,
  limit: number,
): ProjectedEventPage {
  const page = projectionRecord(value, [
    "sessionId",
    "runId",
    "workspaceKey",
    "items",
    "continuationCursor",
    "hasMore",
  ]);
  if (
    boundedString(page.sessionId) !== expected.sessionId ||
    boundedString(page.runId) !== expected.runId ||
    boundedString(page.workspaceKey) !== expected.workspaceKey
  ) {
    throw new TypeError("Run event scope mismatch.");
  }
  if (!Array.isArray(page.items) || page.items.length > limit || typeof page.hasMore !== "boolean") {
    throw new TypeError("Run event page is invalid.");
  }
  const continuationCursor = boundedString(page.continuationCursor, APPLICATION_RUN_LIMITS.maxCursorLength);
  if (page.items.length > 0 && continuationCursor === inputCursor)
    throw new TypeError("Run event cursor did not advance.");
  if (page.items.length === 0 && inputCursor !== undefined && continuationCursor !== inputCursor) {
    throw new TypeError("Empty Run event cursor changed.");
  }
  if (page.items.length === 0 && page.hasMore) throw new TypeError("Empty Run event page cannot have more items.");

  const items: ApplicationRunEvent[] = [];
  const issues: ProjectedEventPage["issues"][number][] = [];
  let previousOrdinal = 0;
  let containsTerminalEvent = false;
  for (const rawItem of page.items) {
    const item = projectionRecord(rawItem, [
      "omitted",
      "reason",
      "id",
      "runId",
      "ordinal",
      "eventCode",
      "subjectType",
      "subjectId",
      "summary",
      "createdAt",
    ]);
    const ordinal = positiveInteger(item.ordinal);
    if (ordinal <= previousOrdinal) throw new TypeError("Run event ordinals are not strictly increasing.");
    previousOrdinal = ordinal;
    if (item.omitted === true) {
      if (item.reason !== "response_size_limit") throw new TypeError("Run event omission is invalid.");
      issues.push({
        kind: "omission",
        code: "response_size_limit",
        message: "Run event was omitted because the response size limit was reached.",
        ordinal,
      });
      continue;
    }
    if (item.omitted !== undefined || boundedString(item.runId) !== expected.runId) {
      throw new TypeError("Run event identity is invalid.");
    }
    boundedString(item.id);
    const eventCode = boundedString(item.eventCode, 64);
    const subjectType = optionalBoundedString(item.subjectType, 64);
    const subjectId = optionalBoundedString(item.subjectId, APPLICATION_RUN_LIMITS.maxIdentifierLength);
    if ((subjectType === undefined) !== (subjectId === undefined))
      throw new TypeError("Run event subject is incomplete.");
    let kind: ApplicationRunEvent["kind"];
    if (eventCode === "run.terminal") {
      if (subjectType !== "run" || subjectId !== expected.runId)
        throw new TypeError("Terminal event subject is invalid.");
      kind = "run_terminal";
      containsTerminalEvent = true;
    } else if (eventCode === "child.result.collected") {
      if (subjectType !== "child_result_delivery" || subjectId === undefined) {
        throw new TypeError("Child result event subject is invalid.");
      }
      kind = "child_result_collected";
    } else {
      kind = "unknown";
    }
    const summary = optionalPublicSummary(item.summary, APPLICATION_RUN_LIMITS.maxSummaryLength);
    items.push({
      ordinal,
      kind,
      ...(summary === undefined ? {} : { summary }),
      createdAt: nonNegativeInteger(item.createdAt),
    });
  }
  return {
    value: { sessionId: expected.sessionId, runId: expected.runId, items, nextCursor: continuationCursor },
    issues,
    consumed: page.items.length > 0,
    containsTerminalEvent,
    hasMore: page.hasMore,
  };
}

function readSuccess<TValue>(control: OperationControl, value: TValue): ApplicationOperationResponse<TValue, "read"> {
  const response = { overallStatus: "success", value, persistence: { status: "read", effect: "none" } } as const;
  const interruption = getOperationInterruption(control);
  return interruption === undefined ? response : interruptionFailure(control, interruption);
}

function readOutcome<TValue>(
  control: OperationControl,
  value: TValue,
  issues: ProjectedEventPage["issues"],
): ApplicationOperationResponse<TValue, "read"> {
  if (issues.length === 0) return readSuccess(control, value);
  const response = {
    overallStatus: "partial_success",
    value,
    issues: issues as [ProjectedEventPage["issues"][number], ...ProjectedEventPage["issues"][number][]],
    persistence: { status: "read", effect: "none" },
  } as const;
  const interruption = getOperationInterruption(control);
  return interruption === undefined ? response : interruptionFailure(control, interruption);
}

function isTerminalStatus(
  status: ApplicationRunStatus,
): status is Extract<ApplicationRunStatus, Readonly<{ phase: "completed" | "failed" | "canceled" | "interrupted" }>> {
  return terminalPhases.has(status.phase);
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
  ]);
  if (typeof error.retryable !== "boolean") throw new TypeError("Access decision retryability is invalid.");
  return {
    allowed: false,
    error: { code, message: boundedString(error.message, 4_096), retryable: error.retryable },
  };
}

function requestFailure(): ApplicationRunFailureResponse {
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
): ApplicationRunFailureResponse {
  return {
    overallStatus: "failure",
    error: { kind: "access", ...error },
    persistence: { status: "not_attempted", effect: "none" },
  };
}

function operationInterruptionFailure(interruption: OperationInterruption): ApplicationRunFailureResponse {
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

function persistenceInterruptionFailure(interruption: OperationInterruption): ApplicationRunFailureResponse {
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

function interruptionFailure(
  control: OperationControl,
  interruption: OperationInterruption,
): ApplicationRunFailureResponse {
  return control.persistenceStarted
    ? persistenceInterruptionFailure(interruption)
    : operationInterruptionFailure(interruption);
}

function prePersistenceApplicationFailure(): ApplicationRunFailureResponse {
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

function persistenceApplicationFailure(): ApplicationRunFailureResponse {
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

function mapThrownReadFailure(error: unknown): ApplicationRunFailureResponse {
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
        message: persistenceError.message,
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
      message: persistenceError.message,
      retryable: persistenceError.retryable,
      effect: "none",
    },
    persistence: { status: "failed", effect: "none" },
  };
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
  if (control.signal?.aborted) return "canceled";
  if (control.deadlineAt !== undefined && control.deadlineAt <= Date.now()) return "timeout";
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
  if (!isPlainObject(value)) throw new TypeError("Projection object is invalid.");
  return Object.fromEntries(allowedKeys.map((key) => [key, value[key]]));
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number = APPLICATION_RUN_LIMITS.maxIdentifierLength): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength)
    throw new TypeError("String is invalid.");
  return value;
}

function optionalBoundedString(value: unknown, maxLength: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, maxLength);
}

function optionalPublicSummary(value: unknown, maxLength: number): string | undefined {
  return value === undefined || value === "" ? undefined : boundedString(value, maxLength);
}

function optionalInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError("Integer is invalid.");
  }
  return value as number;
}

function nonNegativeInteger(value: unknown): number {
  const result = optionalInteger(value, 0, Number.MAX_SAFE_INTEGER);
  if (result === undefined) throw new TypeError("Integer is required.");
  return result;
}

function positiveInteger(value: unknown): number {
  const result = optionalInteger(value, 1, Number.MAX_SAFE_INTEGER);
  if (result === undefined) throw new TypeError("Positive integer is required.");
  return result;
}

function enumString<TValue extends string>(value: unknown, allowed: readonly TValue[]): TValue {
  if (typeof value !== "string" || !allowed.includes(value as TValue)) throw new TypeError("Enum is invalid.");
  return value as TValue;
}
