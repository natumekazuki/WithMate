import { types as nodeTypes } from "node:util";

import type {
  ApplicationAccessDecision,
  ApplicationCapacityExceededDetails,
  ApplicationDomainError,
  ApplicationOperationOptions,
  ApplicationOperationResponse,
} from "../shared/application-service-model.js";
import type {
  ApplicationRunAccessValidator,
  ApplicationRunSendInputRequest,
  ApplicationRunSendInputResult,
} from "../shared/application-run-model.js";
import { RUN_MUTATION_INLINE_CONTENT_LIMITS, snapshotMessageContentBlocks } from "../shared/message-content.js";
import type { PersistenceError } from "../shared/persistence-protocol.js";
import { isCanonicalUuid, isPlainObject } from "../shared/persistence-runtime-protocol.js";
import type {
  RepositoryCommandError,
  RepositoryCommandResult,
  RunInputAdmissionCommand,
  RunInputAdmissionResult,
} from "../shared/repository-write-model.js";
import type { RunInputReplayProbeRequest, RunInputReplayProbeResult } from "../shared/repository-read-model.js";
import { PersistenceClientError, type PersistenceWorkerClient } from "./persistence-worker-client.js";
import { RepositoryReadClient } from "./repository-read-client.js";
import { RepositoryWriteClient } from "./repository-write-client.js";

export type ApplicationRunInputOwnerReservation = Readonly<{
  token: object;
  sessionId: string;
  runId: string;
  workspaceKey: string;
  providerId: string;
  attemptId: string;
  bindingId: string;
  persistenceMode: "persistent" | "ephemeral";
  ephemeralOwnerToken: string | null;
  generationId: string;
  conversationId: string;
  executionId: string;
}>;

export type ApplicationRunInputPreflightError =
  | Readonly<{
      code: "not_found" | "lifecycle_conflict";
      message: string;
      retryable: boolean;
    }>
  | Readonly<{
      code: "capacity_exceeded";
      message: string;
      retryable: true;
      details:
        | Readonly<{ scope: "run"; runId: string; current: number; limit: number }>
        | Readonly<{ scope: "application"; current: number; limit: number }>;
    }>;

export type ApplicationRunInputPreflightResult =
  | Readonly<{ ok: true; value: ApplicationRunInputOwnerReservation }>
  | Readonly<{ ok: false; error: ApplicationRunInputPreflightError }>;

export type ApplicationRunInputHandoffRecord = Readonly<{
  reservation: ApplicationRunInputOwnerReservation;
  sessionId: string;
  runId: string;
  attemptId: string;
  messageId: string;
  messageOrdinal: number;
  bindingId: string;
  admittedAt: number;
  contentBlocks: ApplicationRunSendInputRequest<unknown>["contentBlocks"];
}>;

export interface ApplicationRunInputOwnerPort {
  preflight(
    input: Readonly<{ sessionId: string; runId: string }>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationRunInputPreflightResult>;
  handoff(record: ApplicationRunInputHandoffRecord): void;
  release(reservation: ApplicationRunInputOwnerReservation): void;
}

export interface ApplicationRunInputAdmissionPort {
  admit(command: RunInputAdmissionCommand): Promise<RepositoryCommandResult<RunInputAdmissionResult>>;
}

export interface ApplicationRunInputReplayPort {
  probe(command: RunInputReplayProbeRequest): Promise<RunInputReplayProbeResult>;
}

export type ApplicationRunInputServiceOptions<TAuthorizationContext> = Readonly<{
  access: ApplicationRunAccessValidator<TAuthorizationContext>;
  snapshotAuthorization(value: unknown): TAuthorizationContext;
  owner: ApplicationRunInputOwnerPort;
  admission: ApplicationRunInputAdmissionPort;
  replay?: ApplicationRunInputReplayPort;
}>;

type WriteResponse = ApplicationOperationResponse<ApplicationRunSendInputResult, "write">;
type WriteFailure = Extract<WriteResponse, Readonly<{ overallStatus: "failure" }>>;

type OperationControl = Readonly<{
  deadlineAt?: number;
  signal?: AbortSignal;
}>;

type OperationInterruption = "timeout" | "canceled";

type ControlledSettlement<TValue> =
  | Readonly<{ status: "fulfilled"; value: TValue }>
  | Readonly<{ status: "rejected"; error: unknown }>
  | Readonly<{ status: "interrupted"; interruption: OperationInterruption; started: boolean }>;

type ReplayCheck =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "pending"; response: WriteResponse }>
  | Readonly<{ kind: "response"; response: WriteResponse }>;

const unavailableOwner: ApplicationRunInputOwnerPort = {
  async preflight() {
    return {
      ok: false,
      error: {
        code: "lifecycle_conflict",
        message: "The active Run is not owned by this runtime.",
        retryable: true,
      },
    };
  },
  handoff() {},
  release() {},
};

const unavailableAdmission: ApplicationRunInputAdmissionPort = {
  async admit() {
    throw new Error("Run input admission is unavailable.");
  },
};

const unavailableReplay: ApplicationRunInputReplayPort = {
  async probe() {
    return { kind: "absent" };
  },
};

export function defaultApplicationRunInputOwnerPort(): ApplicationRunInputOwnerPort {
  return unavailableOwner;
}

export function defaultApplicationRunInputAdmissionPort(): ApplicationRunInputAdmissionPort {
  return unavailableAdmission;
}

export class RepositoryApplicationRunInputAdmissionPort implements ApplicationRunInputAdmissionPort {
  readonly #writes: RepositoryWriteClient;

  constructor(writes: RepositoryWriteClient) {
    this.#writes = writes;
  }

  admit(command: RunInputAdmissionCommand): Promise<RepositoryCommandResult<RunInputAdmissionResult>> {
    return this.#writes.admitRunInput(command);
  }
}

export class RepositoryApplicationRunInputReplayPort implements ApplicationRunInputReplayPort {
  readonly #reads: RepositoryReadClient;

  constructor(reads: RepositoryReadClient) {
    this.#reads = reads;
  }

  probe(command: RunInputReplayProbeRequest): Promise<RunInputReplayProbeResult> {
    return this.#reads.runInputReplayProbe(command);
  }
}

export function createRepositoryApplicationRunInputAdmissionPort(
  worker: PersistenceWorkerClient,
): ApplicationRunInputAdmissionPort {
  return new RepositoryApplicationRunInputAdmissionPort(new RepositoryWriteClient(worker));
}

export function createRepositoryApplicationRunInputReplayPort(
  worker: PersistenceWorkerClient,
): ApplicationRunInputReplayPort {
  return new RepositoryApplicationRunInputReplayPort(new RepositoryReadClient(worker));
}

export class ApplicationRunInputService<TAuthorizationContext> {
  readonly #access: ApplicationRunAccessValidator<TAuthorizationContext>;
  readonly #snapshotAuthorization: (value: unknown) => TAuthorizationContext;
  readonly #owner: ApplicationRunInputOwnerPort;
  readonly #admission: ApplicationRunInputAdmissionPort;
  readonly #replay: ApplicationRunInputReplayPort;

  constructor(options: ApplicationRunInputServiceOptions<TAuthorizationContext>) {
    this.#access = options.access;
    this.#snapshotAuthorization = options.snapshotAuthorization;
    this.#owner = options.owner;
    this.#admission = options.admission;
    this.#replay = options.replay ?? unavailableReplay;
  }

  async sendInput(
    request: ApplicationRunSendInputRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<WriteResponse> {
    let input: ApplicationRunSendInputRequest<TAuthorizationContext>;
    let control: OperationControl;
    try {
      control = decodeOperationControl(options);
      input = decodeRequest(request, this.#snapshotAuthorization);
    } catch {
      return requestFailure();
    }
    const interrupted = getInterruption(control);
    if (interrupted !== undefined) return operationFailure(interrupted);

    const authorization = await runControlled(control, () =>
      this.#access.authorize({
        operation: "send-input",
        access: "write",
        context: input.context,
        target: { kind: "run_input", sessionId: input.sessionId, runId: input.runId },
      }),
    );
    if (authorization.status === "interrupted") return operationFailure(authorization.interruption);
    if (authorization.status === "rejected") return applicationFailure("none");
    let decision: ApplicationAccessDecision;
    try {
      decision = projectAccessDecision(authorization.value);
    } catch {
      return applicationFailure("none");
    }
    if (!decision.allowed) return accessFailure(decision.error);

    const initialReplay = await this.#probeReplay(input, control);
    if (initialReplay.kind === "response") return initialReplay.response;

    const preflightAbort = new AbortController();
    const preflight = await runControlled(
      control,
      () =>
        this.#owner.preflight({ sessionId: input.sessionId, runId: input.runId }, { signal: preflightAbort.signal }),
      () => preflightAbort.abort(),
    );
    if (preflight.status === "interrupted") return operationFailure(preflight.interruption);
    if (preflight.status === "rejected") return applicationFailure("none");
    let reservation: ApplicationRunInputOwnerReservation;
    try {
      const projected = projectPreflight(preflight.value, input.sessionId, input.runId);
      if (!projected.ok) {
        const replayAfterFailure = await this.#probeReplay(input, control);
        if (replayAfterFailure.kind !== "absent") return replayAfterFailure.response;
        if (initialReplay.kind === "pending") return initialReplay.response;
        return preflightFailure(projected.error);
      }
      reservation = projected.value;
    } catch {
      return applicationFailure("none");
    }

    const interruptedBeforeAdmission = getInterruption(control);
    if (interruptedBeforeAdmission !== undefined) {
      this.#release(reservation);
      return operationFailure(interruptedBeforeAdmission);
    }

    const work = this.#admitAndHandoff(input, reservation);
    const settlement = await runControlled(control, () => work, undefined, true);
    if (settlement.status === "interrupted") return persistenceInterruptionFailure(settlement.interruption);
    if (settlement.status === "rejected") return applicationFailure("unknown");
    return settlement.value;
  }

  async #probeReplay(
    input: ApplicationRunSendInputRequest<TAuthorizationContext>,
    control: OperationControl,
  ): Promise<ReplayCheck> {
    const settlement = await runControlled(control, () =>
      this.#replay.probe({
        sessionId: input.sessionId,
        runId: input.runId,
        idempotencyKey: input.idempotencyKey,
        contentBlocks: input.contentBlocks,
      }),
    );
    if (settlement.status === "interrupted") {
      return { kind: "response", response: operationFailure(settlement.interruption) };
    }
    if (settlement.status === "rejected") {
      if (settlement.error instanceof PersistenceClientError) {
        return {
          kind: "response",
          response: persistenceFailure(settlement.error.persistenceError, settlement.error.persistenceError.effect),
        };
      }
      return { kind: "response", response: applicationFailure("none") };
    }
    try {
      const probe = projectReplayProbe(settlement.value, input.sessionId, input.runId);
      if (probe.kind === "absent") return probe;
      if (probe.kind === "failure") {
        return { kind: "response", response: repositoryFailure(probe.error, input.runId) };
      }
      const response: WriteResponse = {
        overallStatus: "success",
        value: projectPublicResult(probe.value),
        persistence: { status: "committed", effect: "none", replayed: true },
      };
      return probe.value.deliveryState === "pending" ? { kind: "pending", response } : { kind: "response", response };
    } catch {
      return { kind: "response", response: applicationFailure("none") };
    }
  }

  async #admitAndHandoff(
    input: ApplicationRunSendInputRequest<TAuthorizationContext>,
    reservation: ApplicationRunInputOwnerReservation,
  ): Promise<WriteResponse> {
    let handedOff = false;
    try {
      const result = await this.#admission.admit({
        sessionId: reservation.sessionId,
        workspaceKey: reservation.workspaceKey,
        idempotencyKey: input.idempotencyKey,
        runId: reservation.runId,
        attemptId: reservation.attemptId,
        ephemeralOwnerToken: reservation.ephemeralOwnerToken,
        contentBlocks: input.contentBlocks,
      });
      if (!result.ok) return repositoryFailure(result.error, input.runId);
      const record = projectAdmission(result.value, input.sessionId, input.runId);
      if (!result.replayed && record.deliveryState !== "pending") {
        throw new TypeError("A fresh Run input admission must remain pending.");
      }
      if (
        record.deliveryState === "pending" &&
        record.attemptId === reservation.attemptId &&
        record.bindingId === reservation.bindingId
      ) {
        try {
          this.#owner.handoff({
            reservation,
            sessionId: record.sessionId,
            runId: record.runId,
            attemptId: record.attemptId,
            messageId: record.messageId,
            messageOrdinal: record.messageOrdinal,
            bindingId: record.bindingId,
            admittedAt: record.admittedAt,
            contentBlocks: input.contentBlocks,
          });
          handedOff = true;
        } catch {
          // The durable pending Delivery remains an exact-replay recovery candidate.
        }
      }
      return {
        overallStatus: "success",
        value: projectPublicResult(record),
        persistence: { status: "committed", effect: "none", replayed: result.replayed },
      };
    } catch (error) {
      if (error instanceof PersistenceClientError) {
        return persistenceFailure(error.persistenceError, error.persistenceError.effect);
      }
      return applicationFailure("unknown");
    } finally {
      if (!handedOff) this.#release(reservation);
    }
  }

  #release(reservation: ApplicationRunInputOwnerReservation): void {
    try {
      this.#owner.release(reservation);
    } catch {
      // Release is best effort at this boundary; the owner must bound stale reservations.
    }
  }
}

function decodeRequest<TAuthorizationContext>(
  value: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): ApplicationRunSendInputRequest<TAuthorizationContext> {
  assertProxyFree(value);
  const request = exactRecord(value, ["context", "sessionId", "runId", "idempotencyKey", "contentBlocks"]);
  const context = exactRecord(request.context, ["authorization"]);
  const contentBlocks = snapshotMessageContentBlocks(request.contentBlocks, RUN_MUTATION_INLINE_CONTENT_LIMITS);
  if (contentBlocks === undefined) throw new TypeError("Run input content is invalid.");
  if (
    typeof request.sessionId !== "string" ||
    request.sessionId.length < 1 ||
    request.sessionId.length > 1_024 ||
    typeof request.runId !== "string" ||
    request.runId.length < 1 ||
    request.runId.length > 1_024 ||
    !isCanonicalUuid(request.idempotencyKey)
  ) {
    throw new TypeError("Run input scope is invalid.");
  }
  return {
    context: { authorization: snapshotAuthorization(context.authorization) },
    sessionId: request.sessionId,
    runId: request.runId,
    idempotencyKey: request.idempotencyKey,
    contentBlocks,
  };
}

function decodeOperationControl(value: unknown): OperationControl {
  if (value === undefined) return {};
  const options = exactRecord(value, ["timeoutMs", "signal"]);
  const timeoutMs = options.timeoutMs;
  const signal = options.signal;
  if (
    (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 0)) ||
    (signal !== undefined && !(signal instanceof AbortSignal))
  ) {
    throw new TypeError("Operation control is invalid.");
  }
  return {
    ...(timeoutMs === undefined ? {} : { deadlineAt: Date.now() + (timeoutMs as number) }),
    ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
  };
}

function projectPreflight(value: unknown, sessionId: string, runId: string): ApplicationRunInputPreflightResult {
  if (!isPlainObject(value) || typeof value.ok !== "boolean") throw new TypeError("Preflight result is invalid.");
  if (!value.ok) {
    const error = exactRecord(value.error, ["code", "message", "retryable", "details"]);
    if (
      (error.code !== "not_found" && error.code !== "lifecycle_conflict" && error.code !== "capacity_exceeded") ||
      typeof error.message !== "string" ||
      error.message.length < 1 ||
      error.message.length > 4_096 ||
      typeof error.retryable !== "boolean"
    ) {
      throw new TypeError("Preflight error is invalid.");
    }
    if (error.code !== "capacity_exceeded") {
      if (error.details !== undefined) throw new TypeError("Preflight error details are invalid.");
      return {
        ok: false,
        error: { code: error.code, message: error.message, retryable: error.retryable },
      };
    }
    const details = exactRecord(error.details, ["scope", "runId", "current", "limit"]);
    if (
      (details.scope !== "run" && details.scope !== "application") ||
      !Number.isSafeInteger(details.current) ||
      !Number.isSafeInteger(details.limit) ||
      (details.current as number) < 0 ||
      (details.limit as number) < 1 ||
      (details.scope === "run" ? details.runId !== runId : details.runId !== undefined)
    ) {
      throw new TypeError("Preflight capacity is invalid.");
    }
    return {
      ok: false,
      error: {
        code: "capacity_exceeded",
        message: error.message,
        retryable: true,
        details:
          details.scope === "run"
            ? { scope: "run", runId, current: details.current as number, limit: details.limit as number }
            : { scope: "application", current: details.current as number, limit: details.limit as number },
      },
    };
  }
  const reservation = exactRecord(value.value, [
    "token",
    "sessionId",
    "runId",
    "workspaceKey",
    "providerId",
    "attemptId",
    "bindingId",
    "persistenceMode",
    "ephemeralOwnerToken",
    "generationId",
    "conversationId",
    "executionId",
  ]);
  if (
    typeof reservation.token !== "object" ||
    reservation.token === null ||
    reservation.sessionId !== sessionId ||
    reservation.runId !== runId ||
    !boundedIdentifier(reservation.workspaceKey) ||
    !boundedIdentifier(reservation.providerId) ||
    !boundedIdentifier(reservation.attemptId) ||
    !boundedIdentifier(reservation.bindingId) ||
    (reservation.persistenceMode !== "persistent" && reservation.persistenceMode !== "ephemeral") ||
    (reservation.ephemeralOwnerToken !== null && !isCanonicalUuid(reservation.ephemeralOwnerToken)) ||
    !boundedIdentifier(reservation.generationId) ||
    !boundedIdentifier(reservation.conversationId, 4_096) ||
    !boundedIdentifier(reservation.executionId, 4_096)
  ) {
    throw new TypeError("Preflight reservation is invalid.");
  }
  return { ok: true, value: reservation as ApplicationRunInputOwnerReservation };
}

function projectAdmission(value: unknown, sessionId: string, runId: string): RunInputAdmissionResult {
  const record = exactRecord(value, [
    "sessionId",
    "runId",
    "attemptId",
    "messageId",
    "messageOrdinal",
    "bindingId",
    "deliveryState",
    "resolutionCode",
    "admittedAt",
    "dispatchingAt",
    "resolvedAt",
  ]);
  const deliveryState = record.deliveryState;
  if (
    record.sessionId !== sessionId ||
    record.runId !== runId ||
    !boundedIdentifier(record.attemptId) ||
    !boundedIdentifier(record.messageId) ||
    !Number.isSafeInteger(record.messageOrdinal) ||
    (record.messageOrdinal as number) < 1 ||
    !boundedIdentifier(record.bindingId) ||
    (deliveryState !== "pending" &&
      deliveryState !== "dispatching" &&
      deliveryState !== "accepted" &&
      deliveryState !== "rejected" &&
      deliveryState !== "ambiguous" &&
      deliveryState !== "aborted") ||
    !Number.isSafeInteger(record.admittedAt) ||
    (record.dispatchingAt !== null && !Number.isSafeInteger(record.dispatchingAt)) ||
    (record.resolvedAt !== null && !Number.isSafeInteger(record.resolvedAt)) ||
    !validResolution(deliveryState, record.resolutionCode)
  ) {
    throw new TypeError("Run input admission projection is invalid.");
  }
  return record as RunInputAdmissionResult;
}

function projectReplayProbe(value: unknown, sessionId: string, runId: string): RunInputReplayProbeResult {
  const probe = exactRecord(value, ["kind", "value", "error"]);
  if (probe.kind === "absent") {
    if (probe.value !== undefined || probe.error !== undefined) throw new TypeError("Replay probe is invalid.");
    return { kind: "absent" };
  }
  if (probe.kind === "replay") {
    if (probe.error !== undefined) throw new TypeError("Replay probe is invalid.");
    return { kind: "replay", value: projectAdmission(probe.value, sessionId, runId) };
  }
  if (probe.kind !== "failure" || probe.value !== undefined) throw new TypeError("Replay probe is invalid.");
  const error = exactRecord(probe.error, ["code", "message", "retryable"]);
  if (
    (error.code !== "idempotency_conflict" &&
      error.code !== "idempotency_in_progress" &&
      error.code !== "idempotency_expired" &&
      error.code !== "reference_invalid") ||
    typeof error.message !== "string" ||
    error.message.length < 1 ||
    error.message.length > 4_096 ||
    typeof error.retryable !== "boolean" ||
    error.retryable !== (error.code === "idempotency_in_progress")
  ) {
    throw new TypeError("Replay probe error is invalid.");
  }
  return {
    kind: "failure",
    error: { code: error.code, message: error.message, retryable: error.retryable },
  };
}

function validResolution(deliveryState: unknown, resolutionCode: unknown): boolean {
  if (deliveryState === "pending" || deliveryState === "dispatching" || deliveryState === "accepted") {
    return resolutionCode === null;
  }
  if (deliveryState === "rejected") {
    return resolutionCode === "provider_rejected" || resolutionCode === "delivery_not_sent";
  }
  if (deliveryState === "ambiguous") {
    return resolutionCode === "transport_unknown" || resolutionCode === "process_unknown";
  }
  return deliveryState === "aborted" && resolutionCode === "run_terminal_not_sent";
}

function projectPublicResult(record: RunInputAdmissionResult): ApplicationRunSendInputResult {
  const base = { sessionId: record.sessionId, runId: record.runId, messageId: record.messageId };
  if (record.deliveryState === "pending" || record.deliveryState === "dispatching") {
    return { ...base, deliveryState: "pending" };
  }
  if (record.deliveryState === "accepted") return { ...base, deliveryState: "accepted" };
  return {
    ...base,
    deliveryState: record.deliveryState,
    resolutionCode: record.resolutionCode,
  } as ApplicationRunSendInputResult;
}

function projectAccessDecision(value: unknown): ApplicationAccessDecision {
  const decision = exactRecord(value, ["allowed", "error"]);
  if (decision.allowed === true) {
    if (decision.error !== undefined) throw new TypeError("Access decision is invalid.");
    return { allowed: true };
  }
  if (decision.allowed !== false) throw new TypeError("Access decision is invalid.");
  const error = exactRecord(decision.error, ["code", "message", "retryable"]);
  if (
    (error.code !== "workspace_invalid" &&
      error.code !== "workspace_unavailable" &&
      error.code !== "authorization_invalid" &&
      error.code !== "forbidden") ||
    typeof error.message !== "string" ||
    error.message.length < 1 ||
    error.message.length > 4_096 ||
    typeof error.retryable !== "boolean"
  ) {
    throw new TypeError("Access error is invalid.");
  }
  return {
    allowed: false,
    error: { code: error.code, message: error.message, retryable: error.retryable },
  };
}

function repositoryFailure(error: RepositoryCommandError, expectedRunId: string): WriteFailure {
  if (error.code === "capacity_exceeded") {
    const details = error.details;
    let projected: ApplicationCapacityExceededDetails;
    if (details.scope === "run" && details.runId === expectedRunId) {
      projected = {
        scope: "run",
        runId: expectedRunId,
        current: details.current,
        limit: details.limit,
      };
    } else if (details.scope === "application") {
      projected = {
        scope: "application",
        current: details.current,
        limit: details.limit,
      };
    } else {
      throw new TypeError("Run input capacity scope is invalid.");
    }
    return domainFailure(
      { kind: "domain", code: "capacity_exceeded", message: error.message, retryable: true, details: projected },
      true,
    );
  }
  return domainFailure({ kind: "domain", code: error.code, message: error.message, retryable: error.retryable }, true);
}

function preflightFailure(error: ApplicationRunInputPreflightError): WriteFailure {
  return domainFailure(
    error.code === "capacity_exceeded"
      ? { kind: "domain", ...error }
      : { kind: "domain", code: error.code, message: error.message, retryable: error.retryable },
    false,
  );
}

function domainFailure(error: ApplicationDomainError, persistenceAttempted: boolean): WriteFailure {
  return {
    overallStatus: "failure",
    error,
    persistence: persistenceAttempted
      ? { status: "rejected", effect: "none" }
      : { status: "not_attempted", effect: "none" },
  };
}

function requestFailure(): WriteFailure {
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

function accessFailure(error: Extract<ApplicationAccessDecision, { allowed: false }>["error"]): WriteFailure {
  return {
    overallStatus: "failure",
    error: { kind: "access", ...error },
    persistence: { status: "not_attempted", effect: "none" },
  };
}

function operationFailure(interruption: OperationInterruption): WriteFailure {
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

function persistenceInterruptionFailure(interruption: OperationInterruption): WriteFailure {
  return {
    overallStatus: "failure",
    error: {
      kind: "persistence",
      code: interruption === "timeout" ? "persistence_timeout" : "persistence_canceled",
      message: interruption === "timeout" ? "Application operation timed out." : "Application operation was canceled.",
      retryable: interruption === "timeout",
      effect: "unknown",
    },
    persistence: { status: "failed", effect: "unknown", reconciliation: "exact_request_required" },
  };
}

function persistenceFailure(error: PersistenceError, effect: "none" | "unknown"): WriteFailure {
  const code = mapPersistenceErrorCode(error.code);
  return effect === "unknown"
    ? {
        overallStatus: "failure",
        error: { kind: "persistence", code, message: error.message, retryable: error.retryable, effect },
        persistence: { status: "failed", effect, reconciliation: "exact_request_required" },
      }
    : {
        overallStatus: "failure",
        error: { kind: "persistence", code, message: error.message, retryable: error.retryable, effect },
        persistence: { status: "failed", effect },
      };
}

function applicationFailure(effect: "none" | "unknown"): WriteFailure {
  return effect === "unknown"
    ? {
        overallStatus: "failure",
        error: {
          kind: "application",
          code: "internal_error",
          message: "Application Service could not complete the operation.",
          retryable: false,
        },
        persistence: { status: "failed", effect, reconciliation: "exact_request_required" },
      }
    : {
        overallStatus: "failure",
        error: {
          kind: "application",
          code: "internal_error",
          message: "Application Service could not complete the operation.",
          retryable: false,
        },
        persistence: { status: "not_attempted", effect },
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
    case "response_too_large":
      return "persistence_response_too_large" as const;
    case "database_schema_verification_failed":
    case "database_integrity_check_failed":
      return "persistence_integrity_failed" as const;
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
    default:
      return "persistence_operation_failed" as const;
  }
}

function exactRecord(value: unknown, allowedKeys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value) || nodeTypes.isProxy(value)) throw new TypeError("Record is invalid.");
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) throw new TypeError("Record keys are invalid.");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("Record property is invalid.");
    }
  }
  return value;
}

function assertProxyFree(value: unknown): void {
  if (typeof value === "object" && value !== null && nodeTypes.isProxy(value)) {
    throw new TypeError("Proxy input is invalid.");
  }
}

function boundedIdentifier(value: unknown, maxLength = 1_024): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}

async function runControlled<TValue>(
  control: OperationControl,
  start: () => Promise<TValue>,
  onInterrupt?: () => void,
  started = false,
): Promise<ControlledSettlement<TValue>> {
  const interruption = getInterruption(control);
  if (interruption !== undefined) return { status: "interrupted", interruption, started: false };
  let operation: Promise<TValue>;
  try {
    operation = Promise.resolve(start());
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
    const interrupt = (kind: OperationInterruption) => {
      if (settled) return;
      try {
        onInterrupt?.();
      } finally {
        finish({ status: "interrupted", interruption: kind, started });
      }
    };
    const onAbort = () => interrupt("canceled");
    operation.then(
      (value) => finish({ status: "fulfilled", value }),
      (error: unknown) => finish({ status: "rejected", error }),
    );
    const remaining = remainingTimeout(control);
    if (remaining !== undefined) timer = setTimeout(() => interrupt("timeout"), remaining);
    control.signal?.addEventListener("abort", onAbort, { once: true });
    if (control.signal?.aborted) onAbort();
  });
}

function getInterruption(control: OperationControl): OperationInterruption | undefined {
  if (control.signal?.aborted) return "canceled";
  if (control.deadlineAt !== undefined && control.deadlineAt <= Date.now()) return "timeout";
  return undefined;
}

function remainingTimeout(control: OperationControl): number | undefined {
  return control.deadlineAt === undefined ? undefined : Math.max(0, control.deadlineAt - Date.now());
}
