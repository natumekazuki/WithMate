import { types as nodeTypes } from "node:util";

import type {
  ApplicationAccessDecision,
  ApplicationDomainError,
  ApplicationOperationOptions,
  ApplicationOperationResponse,
} from "../shared/application-service-model.js";
import {
  isApplicationRunCancelDomainErrorCode,
  type ApplicationRunAccessValidator,
  type ApplicationRunCancelRequest,
  type ApplicationRunCancelResult,
} from "../shared/application-run-model.js";
import type { PersistenceError } from "../shared/persistence-protocol.js";
import { isCanonicalUuid, isPlainObject } from "../shared/persistence-runtime-protocol.js";
import type { RunCancelReplayProbeRequest, RunCancelReplayProbeResult } from "../shared/repository-read-model.js";
import type {
  RepositoryCommandError,
  RepositoryCommandResult,
  RunCancelAdmissionCommand,
  RunCancelAdmissionResult,
} from "../shared/repository-write-model.js";
import { projectPersistedRun } from "./application-run-projection.js";
import { PersistenceClientError, type PersistenceWorkerClient } from "./persistence-worker-client.js";
import { RepositoryReadClient } from "./repository-read-client.js";
import { RepositoryWriteClient } from "./repository-write-client.js";

export type ApplicationRunCancelOwnerReservation = Readonly<{
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

export type ApplicationRunCancelPreflightResult =
  | Readonly<{
      ok: true;
      value:
        | Readonly<{ kind: "active_execution"; reservation: ApplicationRunCancelOwnerReservation }>
        | Readonly<{ kind: "terminal_only" }>;
    }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: "not_found" | "lifecycle_conflict";
        message: string;
        retryable: boolean;
      }>;
    }>;

export type ApplicationRunCancelHandoffRecord = Readonly<{
  reservation: ApplicationRunCancelOwnerReservation;
  sessionId: string;
  runId: string;
  idempotencyKey: string;
  cancelRequestedAt: number;
}>;

export interface ApplicationRunCancelOwnerPort {
  preflight(
    input: Readonly<{ sessionId: string; runId: string }>,
    options?: ApplicationOperationOptions,
  ): Promise<ApplicationRunCancelPreflightResult>;
  handoff(record: ApplicationRunCancelHandoffRecord): void;
  release(reservation: ApplicationRunCancelOwnerReservation): void;
}

export interface ApplicationRunCancelAdmissionPort {
  admit(command: RunCancelAdmissionCommand): Promise<RepositoryCommandResult<RunCancelAdmissionResult>>;
}

export interface ApplicationRunCancelReplayPort {
  probe(command: RunCancelReplayProbeRequest): Promise<RunCancelReplayProbeResult>;
}

export type ApplicationRunCancelReadPort = Pick<RepositoryReadClient, "sessionGet" | "runGet">;

export type ApplicationRunCancelServiceOptions<TAuthorizationContext> = Readonly<{
  reads: ApplicationRunCancelReadPort;
  access: ApplicationRunAccessValidator<TAuthorizationContext>;
  snapshotAuthorization(value: unknown): TAuthorizationContext;
  owner: ApplicationRunCancelOwnerPort;
  admission: ApplicationRunCancelAdmissionPort;
  replay?: ApplicationRunCancelReplayPort;
}>;

type WriteResponse = ApplicationOperationResponse<ApplicationRunCancelResult, "write">;
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

type CancelScope = Readonly<{ sessionId: string; runId: string; workspaceKey: string }>;

type ReplayCheck = Readonly<{ kind: "absent" }> | Readonly<{ kind: "response"; response: WriteResponse }>;
type TerminalOwnerRecovery =
  | Readonly<{ kind: "terminal" }>
  | Readonly<{ kind: "non_terminal" }>
  | Readonly<{ kind: "response"; response: WriteFailure }>;

const unavailableOwner: ApplicationRunCancelOwnerPort = {
  async preflight() {
    return { ok: true, value: { kind: "terminal_only" } };
  },
  handoff() {},
  release() {},
};

const unavailableAdmission: ApplicationRunCancelAdmissionPort = {
  async admit() {
    throw new Error("Run cancel admission is unavailable.");
  },
};

const unavailableReplay: ApplicationRunCancelReplayPort = {
  async probe() {
    return { kind: "absent" };
  },
};

export function defaultApplicationRunCancelOwnerPort(): ApplicationRunCancelOwnerPort {
  return unavailableOwner;
}

export function defaultApplicationRunCancelAdmissionPort(): ApplicationRunCancelAdmissionPort {
  return unavailableAdmission;
}

export class RepositoryApplicationRunCancelAdmissionPort implements ApplicationRunCancelAdmissionPort {
  readonly #writes: RepositoryWriteClient;

  constructor(writes: RepositoryWriteClient) {
    this.#writes = writes;
  }

  admit(command: RunCancelAdmissionCommand): Promise<RepositoryCommandResult<RunCancelAdmissionResult>> {
    return this.#writes.admitRunCancel(command);
  }
}

export class RepositoryApplicationRunCancelReplayPort implements ApplicationRunCancelReplayPort {
  readonly #reads: RepositoryReadClient;

  constructor(reads: RepositoryReadClient) {
    this.#reads = reads;
  }

  probe(command: RunCancelReplayProbeRequest): Promise<RunCancelReplayProbeResult> {
    return this.#reads.runCancelReplayProbe(command);
  }
}

export function createRepositoryApplicationRunCancelAdmissionPort(
  worker: PersistenceWorkerClient,
): ApplicationRunCancelAdmissionPort {
  return new RepositoryApplicationRunCancelAdmissionPort(new RepositoryWriteClient(worker));
}

export function createRepositoryApplicationRunCancelReplayPort(
  worker: PersistenceWorkerClient,
): ApplicationRunCancelReplayPort {
  return new RepositoryApplicationRunCancelReplayPort(new RepositoryReadClient(worker));
}

export class ApplicationRunCancelService<TAuthorizationContext> {
  readonly #reads: ApplicationRunCancelReadPort;
  readonly #access: ApplicationRunAccessValidator<TAuthorizationContext>;
  readonly #snapshotAuthorization: (value: unknown) => TAuthorizationContext;
  readonly #owner: ApplicationRunCancelOwnerPort;
  readonly #admission: ApplicationRunCancelAdmissionPort;
  readonly #replay: ApplicationRunCancelReplayPort;

  constructor(options: ApplicationRunCancelServiceOptions<TAuthorizationContext>) {
    this.#reads = options.reads;
    this.#access = options.access;
    this.#snapshotAuthorization = options.snapshotAuthorization;
    this.#owner = options.owner;
    this.#admission = options.admission;
    this.#replay = options.replay ?? unavailableReplay;
  }

  async cancel(
    request: ApplicationRunCancelRequest<TAuthorizationContext>,
    options?: ApplicationOperationOptions,
  ): Promise<WriteResponse> {
    let input: ApplicationRunCancelRequest<TAuthorizationContext>;
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
        operation: "cancel",
        access: "write",
        context: input.context,
        target: { kind: "run_cancel", sessionId: input.sessionId, runId: input.runId },
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

    const replay = await this.#probeReplay(input, control);
    if (replay.kind === "response") return replay.response;

    const scope = await this.#resolveScope(input, control);
    if (scope.overallStatus === "failure") return scope;

    const preflightAbort = new AbortController();
    const preflight = await runControlled(
      control,
      () =>
        this.#owner.preflight({ sessionId: input.sessionId, runId: input.runId }, { signal: preflightAbort.signal }),
      () => preflightAbort.abort(),
    );
    if (preflight.status === "interrupted") return operationFailure(preflight.interruption);
    if (preflight.status === "rejected") return applicationFailure("none");
    let projectedPreflight: ApplicationRunCancelPreflightResult;
    try {
      projectedPreflight = projectPreflight(preflight.value, scope.value);
    } catch {
      return applicationFailure("none");
    }
    let owner: Extract<ApplicationRunCancelPreflightResult, Readonly<{ ok: true }>>["value"];
    if (!projectedPreflight.ok) {
      if (projectedPreflight.error.code !== "not_found") {
        return preflightFailure(projectedPreflight.error);
      }
      const recovery = await this.#recoverTerminalOwner(scope.value, control);
      if (recovery.kind === "response") return recovery.response;
      if (recovery.kind !== "terminal") return preflightFailure(projectedPreflight.error);
      owner = { kind: "terminal_only" };
    } else {
      owner = projectedPreflight.value;
    }

    const interruptedBeforeAdmission = getInterruption(control);
    if (interruptedBeforeAdmission !== undefined) {
      if (owner.kind === "active_execution") this.#release(owner.reservation);
      return operationFailure(interruptedBeforeAdmission);
    }

    const work = this.#admitHandoffAndRead(input, scope.value, owner);
    const settlement = await runControlled(control, () => work, undefined, true);
    if (settlement.status === "interrupted") return persistenceInterruptionFailure(settlement.interruption);
    if (settlement.status === "rejected") return applicationFailure("unknown");
    return settlement.value;
  }

  async #recoverTerminalOwner(scope: CancelScope, control: OperationControl): Promise<TerminalOwnerRecovery> {
    const settlement = await runControlled(control, () => this.#reads.runGet(scope));
    if (settlement.status === "interrupted") {
      return { kind: "response", response: operationFailure(settlement.interruption) };
    }
    if (settlement.status === "rejected") {
      return {
        kind: "response",
        response:
          settlement.error instanceof PersistenceClientError
            ? persistenceFailure(settlement.error.persistenceError, "none")
            : applicationFailure("none"),
      };
    }
    try {
      const projection = allowRecord(settlement.value);
      if (projection.sessionId !== scope.sessionId || projection.workspaceKey !== scope.workspaceKey) {
        throw new TypeError("Run projection scope mismatch.");
      }
      const run = allowRecord(projection.run);
      if (boundedIdentifierValue(run.id) !== scope.runId) {
        throw new TypeError("Run projection identity mismatch.");
      }
      const phase = projectPersistedRun(run).phase;
      return {
        kind:
          phase === "completed" || phase === "failed" || phase === "canceled" || phase === "interrupted"
            ? "terminal"
            : "non_terminal",
      };
    } catch {
      return { kind: "response", response: applicationFailure("none") };
    }
  }

  async #probeReplay(
    input: ApplicationRunCancelRequest<TAuthorizationContext>,
    control: OperationControl,
  ): Promise<ReplayCheck> {
    const settlement = await runControlled(control, () =>
      this.#replay.probe({
        sessionId: input.sessionId,
        runId: input.runId,
        idempotencyKey: input.idempotencyKey,
      }),
    );
    if (settlement.status === "interrupted") {
      return { kind: "response", response: operationFailure(settlement.interruption) };
    }
    if (settlement.status === "rejected") {
      return {
        kind: "response",
        response:
          settlement.error instanceof PersistenceClientError
            ? persistenceFailure(settlement.error.persistenceError, settlement.error.persistenceError.effect)
            : applicationFailure("none"),
      };
    }
    let probe: RunCancelReplayProbeResult;
    try {
      probe = projectReplayProbe(settlement.value, input.sessionId, input.runId);
    } catch {
      return { kind: "response", response: applicationFailure("none") };
    }
    if (probe.kind === "absent") return probe;
    if (probe.kind === "failure") {
      return { kind: "response", response: repositoryFailure(probe.error, false) };
    }
    const scope = await this.#resolveScope(input, control);
    if (scope.overallStatus === "failure") return { kind: "response", response: scope };
    if (probe.value.phase === "canceling") {
      void this.#resumeDurableHandoff(input, scope.value, probe.value.cancelRequestedAt).catch(() => undefined);
    }
    const response = await this.#readPublicResult(probe.value, scope.value, control, true);
    return { kind: "response", response };
  }

  async #resumeDurableHandoff(
    input: ApplicationRunCancelRequest<TAuthorizationContext>,
    scope: CancelScope,
    cancelRequestedAt: number,
  ): Promise<void> {
    const preflight = await this.#owner.preflight({
      sessionId: input.sessionId,
      runId: input.runId,
    });
    if (!preflight.ok) return;
    const projected = projectPreflight(preflight, scope);
    if (!projected.ok || projected.value.kind !== "active_execution") return;
    const reservation = projected.value.reservation;
    let handedOff = false;
    try {
      handedOff = true;
      this.#owner.handoff({
        reservation,
        sessionId: input.sessionId,
        runId: input.runId,
        idempotencyKey: input.idempotencyKey,
        cancelRequestedAt,
      });
    } finally {
      if (!handedOff) this.#release(reservation);
    }
  }

  async #resolveScope(
    input: ApplicationRunCancelRequest<TAuthorizationContext>,
    control: OperationControl,
  ): Promise<
    | Readonly<{ overallStatus: "success"; value: CancelScope }>
    | Extract<WriteResponse, Readonly<{ overallStatus: "failure" }>>
  > {
    const settlement = await runControlled(control, () => this.#reads.sessionGet({ sessionId: input.sessionId }));
    if (settlement.status === "interrupted") return operationFailure(settlement.interruption);
    if (settlement.status === "rejected") {
      return settlement.error instanceof PersistenceClientError
        ? persistenceFailure(settlement.error.persistenceError, "none")
        : applicationFailure("none");
    }
    try {
      const projection = allowRecord(settlement.value);
      const session = allowRecord(projection.session);
      const sessionId = boundedIdentifierValue(session.id);
      const workspaceKey = boundedIdentifierValue(session.workspaceKey);
      if (sessionId !== input.sessionId) throw new TypeError("Session scope mismatch.");
      return {
        overallStatus: "success",
        value: { sessionId, runId: input.runId, workspaceKey },
      };
    } catch {
      return applicationFailure("none");
    }
  }

  async #admitHandoffAndRead(
    input: ApplicationRunCancelRequest<TAuthorizationContext>,
    scope: CancelScope,
    owner: Extract<ApplicationRunCancelPreflightResult, Readonly<{ ok: true }>>["value"],
  ): Promise<WriteResponse> {
    const reservation = owner.kind === "active_execution" ? owner.reservation : undefined;
    let handedOff = false;
    try {
      const result = await this.#admission.admit({
        sessionId: scope.sessionId,
        workspaceKey: scope.workspaceKey,
        idempotencyKey: input.idempotencyKey,
        runId: scope.runId,
        owner:
          reservation === undefined
            ? { kind: "terminal_only" }
            : {
                kind: "active_execution",
                attemptId: reservation.attemptId,
                bindingId: reservation.bindingId,
                ephemeralOwnerToken: reservation.ephemeralOwnerToken,
                externalConversationId: reservation.conversationId,
                externalExecutionId: reservation.executionId,
              },
      });
      if (!result.ok) return repositoryFailure(result.error, true);
      const admitted = projectAdmission(result.value, scope.sessionId, scope.runId);
      if (!result.replayed && admitted.phase === "canceling" && reservation === undefined) {
        throw new TypeError("Fresh active cancel has no runtime owner.");
      }
      if (!result.replayed && admitted.phase === "canceling" && reservation !== undefined) {
        handedOff = true;
        try {
          this.#owner.handoff({
            reservation,
            sessionId: admitted.sessionId,
            runId: admitted.runId,
            idempotencyKey: input.idempotencyKey,
            cancelRequestedAt: admitted.cancelRequestedAt,
          });
        } catch {
          // The owner consumed the reservation before this boundary exposed durable success.
        }
      }
      return await this.#readPublicResult(admitted, scope, {}, result.replayed);
    } catch (error) {
      if (error instanceof PersistenceClientError) {
        return persistenceFailure(error.persistenceError, error.persistenceError.effect);
      }
      return applicationFailure("unknown");
    } finally {
      if (reservation !== undefined && !handedOff) this.#release(reservation);
    }
  }

  async #readPublicResult(
    admitted: RunCancelAdmissionResult,
    scope: CancelScope,
    control: OperationControl,
    replayed: boolean,
  ): Promise<WriteResponse> {
    const settlement = await runControlled(control, () => this.#reads.runGet(scope));
    if (settlement.status === "interrupted") return persistenceInterruptionFailure(settlement.interruption);
    if (settlement.status === "rejected") {
      return settlement.error instanceof PersistenceClientError
        ? persistenceFailure(settlement.error.persistenceError, "unknown")
        : applicationFailure("unknown");
    }
    try {
      const projection = allowRecord(settlement.value);
      if (projection.sessionId !== scope.sessionId || projection.workspaceKey !== scope.workspaceKey) {
        throw new TypeError("Run projection scope mismatch.");
      }
      const run = allowRecord(projection.run);
      const runId = boundedIdentifierValue(run.id);
      if (runId !== scope.runId) throw new TypeError("Run projection identity mismatch.");
      const persisted = projectPersistedRun(run);
      const value = {
        sessionId: scope.sessionId,
        runId: scope.runId,
        ...persisted,
        liveActivity: null,
      } as ApplicationRunCancelResult;
      assertOutcomeMatches(admitted, value);
      return {
        overallStatus: "success",
        value,
        persistence: { status: "committed", effect: "none", replayed },
      };
    } catch {
      return applicationFailure("unknown");
    }
  }

  #release(reservation: ApplicationRunCancelOwnerReservation): void {
    try {
      this.#owner.release(reservation);
    } catch {
      // The runtime owner bounds stale reservations independently.
    }
  }
}

function decodeRequest<TAuthorizationContext>(
  value: unknown,
  snapshotAuthorization: (value: unknown) => TAuthorizationContext,
): ApplicationRunCancelRequest<TAuthorizationContext> {
  assertProxyFree(value);
  const request = exactRecord(value, ["context", "sessionId", "runId", "idempotencyKey"]);
  const context = exactRecord(request.context, ["authorization"]);
  if (
    !boundedIdentifier(request.sessionId) ||
    !boundedIdentifier(request.runId) ||
    !isCanonicalUuid(request.idempotencyKey)
  ) {
    throw new TypeError("Run cancel scope is invalid.");
  }
  return {
    context: { authorization: snapshotAuthorization(context.authorization) },
    sessionId: request.sessionId,
    runId: request.runId,
    idempotencyKey: request.idempotencyKey,
  };
}

function decodeOperationControl(value: unknown): OperationControl {
  if (value === undefined) return {};
  const options = exactRecord(value, ["timeoutMs", "signal"]);
  if (
    (options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || (options.timeoutMs as number) < 0)) ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal))
  ) {
    throw new TypeError("Operation control is invalid.");
  }
  return {
    ...(options.timeoutMs === undefined ? {} : { deadlineAt: Date.now() + (options.timeoutMs as number) }),
    ...(options.signal === undefined ? {} : { signal: options.signal as AbortSignal }),
  };
}

function projectPreflight(value: unknown, scope: CancelScope): ApplicationRunCancelPreflightResult {
  const result = exactRecord(value, ["ok", "value", "error"]);
  if (result.ok === false) {
    if (result.value !== undefined) throw new TypeError("Cancel preflight result is invalid.");
    const error = exactRecord(result.error, ["code", "message", "retryable"]);
    if (
      (error.code !== "not_found" && error.code !== "lifecycle_conflict") ||
      typeof error.message !== "string" ||
      error.message.length < 1 ||
      error.message.length > 4_096 ||
      typeof error.retryable !== "boolean"
    ) {
      throw new TypeError("Cancel preflight error is invalid.");
    }
    return {
      ok: false,
      error: { code: error.code, message: error.message, retryable: error.retryable },
    };
  }
  if (result.ok !== true || result.error !== undefined) throw new TypeError("Cancel preflight result is invalid.");
  const owner = exactRecord(result.value, ["kind", "reservation"]);
  if (owner.kind === "terminal_only") {
    if (owner.reservation !== undefined) throw new TypeError("Terminal cancel preflight has a reservation.");
    return { ok: true, value: { kind: "terminal_only" } };
  }
  if (owner.kind !== "active_execution") throw new TypeError("Cancel preflight owner is invalid.");
  const reservation = exactRecord(owner.reservation, [
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
    reservation.sessionId !== scope.sessionId ||
    reservation.runId !== scope.runId ||
    reservation.workspaceKey !== scope.workspaceKey ||
    !boundedIdentifier(reservation.providerId) ||
    !boundedIdentifier(reservation.attemptId) ||
    !boundedIdentifier(reservation.bindingId) ||
    (reservation.persistenceMode !== "persistent" && reservation.persistenceMode !== "ephemeral") ||
    (reservation.ephemeralOwnerToken !== null && !isCanonicalUuid(reservation.ephemeralOwnerToken)) ||
    !boundedIdentifier(reservation.generationId) ||
    !boundedIdentifier(reservation.conversationId, 4_096) ||
    !boundedIdentifier(reservation.executionId, 4_096)
  ) {
    throw new TypeError("Cancel preflight reservation is invalid.");
  }
  return {
    ok: true,
    value: { kind: "active_execution", reservation: reservation as ApplicationRunCancelOwnerReservation },
  };
}

function projectReplayProbe(value: unknown, sessionId: string, runId: string): RunCancelReplayProbeResult {
  const probe = exactRecord(value, ["kind", "value", "error"]);
  if (probe.kind === "absent") {
    if (probe.value !== undefined || probe.error !== undefined) throw new TypeError("Cancel replay probe is invalid.");
    return { kind: "absent" };
  }
  if (probe.kind === "replay") {
    if (probe.error !== undefined) throw new TypeError("Cancel replay probe is invalid.");
    return { kind: "replay", value: projectAdmission(probe.value, sessionId, runId) };
  }
  if (probe.kind !== "failure" || probe.value !== undefined) throw new TypeError("Cancel replay probe is invalid.");
  const error = projectRepositoryError(probe.error);
  return { kind: "failure", error };
}

function projectAdmission(value: unknown, sessionId: string, runId: string): RunCancelAdmissionResult {
  const result = exactRecord(value, [
    "sessionId",
    "runId",
    "phase",
    "cancelRequestedAt",
    "cancelAcknowledgedAt",
    "terminalAt",
  ]);
  if (result.sessionId !== sessionId || result.runId !== runId) {
    throw new TypeError("Cancel admission scope mismatch.");
  }
  const requestedAt = nullableNonNegativeInteger(result.cancelRequestedAt);
  const acknowledgedAt = nullableNonNegativeInteger(result.cancelAcknowledgedAt);
  const terminalAt = nullableNonNegativeInteger(result.terminalAt);
  if (result.phase === "canceling") {
    if (requestedAt === null || acknowledgedAt !== null || terminalAt !== null) {
      throw new TypeError("Canceling admission outcome is invalid.");
    }
    return {
      sessionId,
      runId,
      phase: "canceling",
      cancelRequestedAt: requestedAt,
      cancelAcknowledgedAt: null,
      terminalAt: null,
    };
  }
  if (
    result.phase !== "completed" &&
    result.phase !== "failed" &&
    result.phase !== "canceled" &&
    result.phase !== "interrupted"
  ) {
    throw new TypeError("Cancel admission phase is invalid.");
  }
  if (
    terminalAt === null ||
    (requestedAt !== null && requestedAt > terminalAt) ||
    (acknowledgedAt !== null && (requestedAt === null || acknowledgedAt < requestedAt || acknowledgedAt > terminalAt))
  ) {
    throw new TypeError("Terminal cancel admission timestamps are invalid.");
  }
  if (result.phase !== "canceled") {
    if (acknowledgedAt !== null) throw new TypeError("Non-canceled outcome has a cancel acknowledgment.");
    return {
      sessionId,
      runId,
      phase: result.phase,
      cancelRequestedAt: requestedAt,
      cancelAcknowledgedAt: null,
      terminalAt,
    };
  }
  if (requestedAt === null && acknowledgedAt === null) {
    return {
      sessionId,
      runId,
      phase: "canceled",
      cancelRequestedAt: null,
      cancelAcknowledgedAt: null,
      terminalAt,
    };
  }
  if (requestedAt === null || acknowledgedAt === null) {
    throw new TypeError("Canceled outcome has incomplete cancellation timestamps.");
  }
  return {
    sessionId,
    runId,
    phase: "canceled",
    cancelRequestedAt: requestedAt,
    cancelAcknowledgedAt: acknowledgedAt,
    terminalAt,
  };
}

function assertOutcomeMatches(admitted: RunCancelAdmissionResult, value: ApplicationRunCancelResult): void {
  if (value.sessionId !== admitted.sessionId || value.runId !== admitted.runId) {
    throw new TypeError("Cancel status outcome mismatch.");
  }
  const requestedAt = "cancellation" in value ? value.cancellation?.requestedAt : undefined;
  const acknowledgedAt = "cancellation" in value ? value.cancellation?.acknowledgedAt : undefined;
  const terminalAt = "terminalAt" in value ? value.terminalAt : undefined;
  if (admitted.phase === "canceling") {
    if (requestedAt !== admitted.cancelRequestedAt) {
      throw new TypeError("Cancel status request timestamp mismatch.");
    }
    return;
  }
  if (
    value.phase !== admitted.phase ||
    requestedAt !== (admitted.cancelRequestedAt ?? undefined) ||
    acknowledgedAt !== (admitted.cancelAcknowledgedAt ?? undefined) ||
    terminalAt !== (admitted.terminalAt ?? undefined)
  ) {
    throw new TypeError("Cancel status timestamp mismatch.");
  }
}

function projectRepositoryError(value: unknown): RepositoryCommandError {
  const error = exactRecord(value, ["code", "message", "retryable", "details"]);
  if (
    !isApplicationRunCancelDomainErrorCode(error.code) ||
    typeof error.message !== "string" ||
    error.message.length < 1 ||
    error.message.length > 4_096 ||
    typeof error.retryable !== "boolean" ||
    error.details !== undefined
  ) {
    throw new TypeError("Cancel Repository error is invalid.");
  }
  return { code: error.code, message: error.message, retryable: error.retryable };
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

function repositoryFailure(error: RepositoryCommandError, persistenceAttempted: boolean): WriteFailure {
  if (!isApplicationRunCancelDomainErrorCode(error.code) || "details" in error) {
    return applicationFailure(persistenceAttempted ? "unknown" : "none");
  }
  return domainFailure(
    { kind: "domain", code: error.code, message: error.message, retryable: error.retryable },
    persistenceAttempted,
  );
}

function preflightFailure(
  error: Extract<ApplicationRunCancelPreflightResult, Readonly<{ ok: false }>>["error"],
): WriteFailure {
  return domainFailure({ kind: "domain", ...error }, false);
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

function allowRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value) || nodeTypes.isProxy(value)) throw new TypeError("Record is invalid.");
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

function boundedIdentifierValue(value: unknown): string {
  if (!boundedIdentifier(value)) throw new TypeError("Identifier is invalid.");
  return value;
}

function nullableNonNegativeInteger(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("Timestamp is invalid.");
  return value as number;
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
