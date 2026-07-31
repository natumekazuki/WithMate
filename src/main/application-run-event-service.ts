import { createHash } from "node:crypto";

import { APPLICATION_RUN_LIMITS, type ApplicationRunLiveActivity } from "../shared/application-run-model.js";
import type {
  RepositoryCommandResult,
  RunDispatchResolutionCommand,
  RunDispatchResolutionResult,
  RunInputBeginCommand,
  RunInputResolutionCommand,
  RunOutputAppendCommand,
  RunOutputDraft,
  RunOutputPayloadCommand,
  RunProviderExecutionCorrelation,
  RunTerminalCommand,
  RunTerminalOutputDraft,
  RunTerminalResult,
} from "../shared/repository-write-model.js";
import type {
  CodexAdapterEvent,
  CodexAdapterInterruptAcknowledgement,
  CodexAdapterMutationResult,
  CodexAdapterOutput,
  CodexAdapterTurnSnapshot,
} from "./providers/codex/index.js";
import type {
  ApplicationRunCancelHandoffRecord,
  ApplicationRunCancelOwnerPort,
  ApplicationRunCancelOwnerReservation,
  ApplicationRunCancelPreflightResult,
} from "./application-run-cancel-service.js";
import type {
  ApplicationRunInputHandoffRecord,
  ApplicationRunInputOwnerPort,
  ApplicationRunInputOwnerReservation,
  ApplicationRunInputPreflightResult,
} from "./application-run-input-service.js";
import type {
  ApplicationRunDispatchControl,
  ApplicationRunPreparedDispatch,
  ApplicationRunProviderEventPort,
} from "./application-run-runtime-service.js";
import {
  classifyApplicationRunProviderMutationFailure,
  type ApplicationRunProviderMutationFailure,
} from "./application-run-provider-failure.js";
import type { ApplicationRunLiveActivityPort, ApplicationRunLiveActivitySnapshot } from "./application-run-service.js";
import { PersistenceClientError, type PersistenceWorkerClient } from "./persistence-worker-client.js";
import { RepositoryReadClient } from "./repository-read-client.js";
import { RepositoryWriteClient } from "./repository-write-client.js";

export const APPLICATION_RUN_EVENT_LIMITS = Object.freeze({
  maxTrackedAttempts: 128,
  maxBufferedEventsPerAttempt: 64,
  maxPersistedOutputsPerAttempt: 4_096,
  maxPendingInputsPerAttempt: APPLICATION_RUN_LIMITS.maxPendingInputsPerAttempt,
  maxTrackedInputs: APPLICATION_RUN_LIMITS.maxTrackedInputs,
  persistenceRetryDelayMs: 25,
  maxSummaryBytes: 4_096,
  maxOutputKindCharacters: 64,
} as const);

export type ApplicationRunStartTurnResult = CodexAdapterMutationResult<CodexAdapterTurnSnapshot>;

export interface ApplicationRunAttemptHandle {
  settleStartTurn(result: ApplicationRunStartTurnResult): Promise<void>;
  readonly done: Promise<void>;
}

export interface ApplicationRunAttemptEventPort {
  register(
    dispatch: ApplicationRunPreparedDispatch,
    control: ApplicationRunDispatchControl,
  ): ApplicationRunAttemptHandle | null;
}

export interface ApplicationRunProviderGenerationPort {
  releaseGeneration(generationId: string, reason: ApplicationRunGenerationReleaseReason): Promise<void>;
}

export type ApplicationRunGenerationReleaseReason = Readonly<
  { kind: "connection_failure"; code: string } | { kind: "shutdown" } | { kind: "event_consumer_failure" }
>;

export type ApplicationRunEventReadPort = Pick<RepositoryReadClient, "runGet" | "recoveryGet">;

export type ApplicationRunEventWritePort = Pick<
  RepositoryWriteClient,
  "resolveRunDispatch" | "beginRunInput" | "resolveRunInput" | "appendRunOutput" | "completeRun"
>;

export type ApplicationRunEventServiceOptions = Readonly<{
  reads: ApplicationRunEventReadPort;
  writes: ApplicationRunEventWritePort;
  limits?: Readonly<{
    maxTrackedAttempts?: number;
    maxBufferedEventsPerAttempt?: number;
    maxPersistedOutputsPerAttempt?: number;
    maxPendingInputsPerAttempt?: number;
    maxTrackedInputs?: number;
  }>;
}>;

export function createApplicationRunEventService(worker: PersistenceWorkerClient): ApplicationRunEventService {
  return new ApplicationRunEventService({
    reads: new RepositoryReadClient(worker),
    writes: new RepositoryWriteClient(worker),
  });
}

type AttemptPhase = "sending" | "ambiguous" | "accepted" | "closed";

type InputWorkStatus =
  | "waiting"
  | "reserved"
  | "handed_off"
  | "ordering_blocked"
  | "beginning"
  | "resolving"
  | "persistence_blocked"
  | "settled"
  | "released";

type InputResolutionConfirmation = "confirmed" | "retry" | "blocked";

type CancelWorkStatus = "reserved" | "handed_off" | "calling" | "settled" | "released";

type CancelDisposition = CodexAdapterMutationResult<CodexAdapterInterruptAcknowledgement>;

type CancelWork = {
  readonly reservation: ApplicationRunCancelOwnerReservation;
  readonly state: AttemptState;
  readonly reservationSettlement: Promise<void>;
  readonly resolveReservationSettlement: () => void;
  status: CancelWorkStatus;
  record: ApplicationRunCancelHandoffRecord | null;
  disposition: CancelDisposition | null;
  settlementHandle: ReturnType<typeof setImmediate> | null;
  abortSignal: AbortSignal | null;
  abortListener: (() => void) | null;
};

type InputWork = {
  readonly reservation: ApplicationRunInputOwnerReservation;
  readonly state: AttemptState;
  status: InputWorkStatus;
  preflightResolve: ((result: ApplicationRunInputPreflightResult) => void) | null;
  record: ApplicationRunInputHandoffRecord | null;
  beginCommand: RunInputBeginCommand | null;
  resolutionCommand: RunInputResolutionCommand | null;
  providerCalled: boolean;
  abortSignal: AbortSignal | null;
  abortListener: (() => void) | null;
};

type AttemptState = {
  readonly dispatch: ApplicationRunPreparedDispatch;
  readonly control: ApplicationRunDispatchControl;
  readonly ownerKey: string;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
  phase: AttemptPhase;
  turnId: string | null;
  runVersion: number | null;
  activity: ApplicationRunLiveActivity | null;
  bufferedEvents: CodexAdapterEvent[];
  eventLimitExceeded: boolean;
  excludedLateAcceptanceIds: Set<string>;
  outputCommands: Map<string, { readonly command: RunOutputAppendCommand; confirmed: boolean }>;
  outputLimitExceeded: boolean;
  pendingResolution: RunDispatchResolutionCommand | null;
  terminalCommand: RunTerminalCommand | null;
  releaseReason: ApplicationRunGenerationReleaseReason | null;
  startTurnResult: ApplicationRunStartTurnResult | null;
  startTurnFailure: ApplicationRunProviderMutationFailure | null;
  cancelWork: CancelWork | null;
  inputQueue: InputWork[];
  inputDrainScheduled: boolean;
  chain: Promise<void>;
};

export class ApplicationRunEventService
  implements
    ApplicationRunAttemptEventPort,
    ApplicationRunProviderEventPort,
    ApplicationRunProviderGenerationPort,
    ApplicationRunLiveActivityPort,
    ApplicationRunInputOwnerPort
{
  readonly #reads: ApplicationRunEventReadPort;
  readonly #writes: ApplicationRunEventWritePort;
  readonly #maxTrackedAttempts: number;
  readonly #maxBufferedEventsPerAttempt: number;
  readonly #maxPersistedOutputsPerAttempt: number;
  readonly #maxPendingInputsPerAttempt: number;
  readonly #maxTrackedInputs: number;
  readonly #attemptsByRun = new Map<string, AttemptState>();
  readonly #attemptsByOwner = new Map<string, AttemptState>();
  readonly #persistenceRetryTasks = new Map<AttemptState, Promise<void>>();
  readonly #cancelReservations = new Map<object, CancelWork>();
  readonly #inputReservations = new Map<object, InputWork>();
  readonly #inputsByMessage = new Map<string, InputWork>();
  readonly cancelOwner: ApplicationRunCancelOwnerPort;

  constructor(options: ApplicationRunEventServiceOptions) {
    this.#reads = options.reads;
    this.#writes = options.writes;
    this.#maxTrackedAttempts = positiveLimit(
      options.limits?.maxTrackedAttempts ?? APPLICATION_RUN_EVENT_LIMITS.maxTrackedAttempts,
    );
    this.#maxBufferedEventsPerAttempt = positiveLimit(
      options.limits?.maxBufferedEventsPerAttempt ?? APPLICATION_RUN_EVENT_LIMITS.maxBufferedEventsPerAttempt,
    );
    this.#maxPersistedOutputsPerAttempt = positiveLimit(
      options.limits?.maxPersistedOutputsPerAttempt ?? APPLICATION_RUN_EVENT_LIMITS.maxPersistedOutputsPerAttempt,
    );
    this.#maxPendingInputsPerAttempt = positiveLimit(
      options.limits?.maxPendingInputsPerAttempt ?? APPLICATION_RUN_EVENT_LIMITS.maxPendingInputsPerAttempt,
    );
    this.#maxTrackedInputs = positiveLimit(
      options.limits?.maxTrackedInputs ?? APPLICATION_RUN_EVENT_LIMITS.maxTrackedInputs,
    );
    this.cancelOwner = Object.freeze<ApplicationRunCancelOwnerPort>({
      preflight: (input, operationOptions) => this.#preflightCancel(input, operationOptions),
      handoff: (record) => this.#handoffCancel(record),
      release: (reservation) => this.#releaseCancel(reservation),
    });
  }

  register(
    dispatch: ApplicationRunPreparedDispatch,
    control: ApplicationRunDispatchControl,
  ): ApplicationRunAttemptHandle | null {
    if (this.#attemptsByRun.size >= this.#maxTrackedAttempts) return null;
    const ownerKey = providerOwnerKey(dispatch.generationId, dispatch.threadId);
    if (this.#attemptsByRun.has(dispatch.admission.runId) || this.#attemptsByOwner.has(ownerKey)) return null;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const state: AttemptState = {
      dispatch,
      control,
      ownerKey,
      done,
      resolveDone,
      phase: "sending",
      turnId: null,
      runVersion: null,
      activity: null,
      bufferedEvents: [],
      eventLimitExceeded: false,
      excludedLateAcceptanceIds: new Set(),
      outputCommands: new Map(),
      outputLimitExceeded: false,
      pendingResolution: null,
      terminalCommand: null,
      releaseReason: null,
      startTurnResult: null,
      startTurnFailure: null,
      cancelWork: null,
      inputQueue: [],
      inputDrainScheduled: false,
      chain: Promise.resolve(),
    };
    this.#attemptsByRun.set(dispatch.admission.runId, state);
    this.#attemptsByOwner.set(ownerKey, state);
    return Object.freeze({
      settleStartTurn: (result: ApplicationRunStartTurnResult) =>
        this.#enqueue(state, () => this.#settleStartTurn(state, result)),
      done,
    });
  }

  #preflightCancel(
    input: Readonly<{ sessionId: string; runId: string }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ApplicationRunCancelPreflightResult> {
    const state = this.#attemptsByRun.get(input.runId);
    if (state === undefined || state.dispatch.admission.sessionId !== input.sessionId) {
      return Promise.resolve(cancelPreflightFailure("not_found"));
    }
    return this.#enqueue(state, async () => {
      if (options?.signal?.aborted === true || state.cancelWork !== null || !this.#isCancelOwnerCurrent(state)) {
        return cancelPreflightFailure("lifecycle_conflict");
      }
      const token = Object.freeze({});
      const reservation = Object.freeze({
        token,
        sessionId: state.dispatch.admission.sessionId,
        runId: state.dispatch.admission.runId,
        workspaceKey: state.dispatch.workspaceKey,
        providerId: state.dispatch.providerId,
        attemptId: state.dispatch.admission.attemptId,
        bindingId: state.dispatch.admission.bindingId,
        persistenceMode: state.dispatch.persistenceMode,
        ephemeralOwnerToken: state.dispatch.ephemeralOwnerToken,
        generationId: state.dispatch.generationId,
        conversationId: state.dispatch.threadId,
        executionId: state.turnId as string,
      });
      let resolveReservationSettlement!: () => void;
      const reservationSettlement = new Promise<void>((resolve) => {
        resolveReservationSettlement = resolve;
      });
      const work: CancelWork = {
        reservation,
        state,
        reservationSettlement,
        resolveReservationSettlement,
        status: "reserved",
        record: null,
        disposition: null,
        settlementHandle: null,
        abortSignal: options?.signal ?? null,
        abortListener: null,
      };
      if (options?.signal !== undefined) {
        work.abortListener = () => this.#releaseCancelWork(work);
        options.signal.addEventListener("abort", work.abortListener, { once: true });
      }
      state.cancelWork = work;
      this.#cancelReservations.set(token, work);
      return {
        ok: true,
        value: { kind: "active_execution", reservation },
      };
    });
  }

  #handoffCancel(record: ApplicationRunCancelHandoffRecord): void {
    const work = this.#cancelReservations.get(record.reservation.token);
    if (
      work === undefined ||
      work.status !== "reserved" ||
      work.reservation !== record.reservation ||
      !cancelHandoffMatchesReservation(record, work.reservation)
    ) {
      return;
    }
    this.#detachCancelAbort(work);
    work.record = Object.freeze({ ...record });
    work.status = "handed_off";
    work.resolveReservationSettlement();
    for (const input of [...work.state.inputQueue]) {
      this.#releaseInputReservation(input, false);
    }
    void this.#enqueue(work.state, () => this.#interruptCancelWork(work)).catch(() => undefined);
  }

  #releaseCancel(reservation: ApplicationRunCancelOwnerReservation): void {
    const work = this.#cancelReservations.get(reservation.token);
    if (work === undefined || work.reservation !== reservation || work.status !== "reserved") return;
    this.#releaseCancelWork(work);
  }

  preflight(
    input: Readonly<{ sessionId: string; runId: string }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ApplicationRunInputPreflightResult> {
    const state = this.#attemptsByRun.get(input.runId);
    if (state === undefined || state.dispatch.admission.sessionId !== input.sessionId) {
      return Promise.resolve(inputPreflightFailure("not_found"));
    }
    return this.#enqueue(state, async () => {
      const steerTurn = state.control.adapter.steerTurn;
      if (
        options?.signal?.aborted === true ||
        !this.#isInputDeliveryOpen(state) ||
        state.turnId === null ||
        state.control.signal.aborted ||
        !safeIsCurrent(state.control) ||
        typeof steerTurn !== "function"
      ) {
        return { settlement: Promise.resolve(inputPreflightFailure("lifecycle_conflict")) };
      }
      if (state.inputQueue.length >= this.#maxPendingInputsPerAttempt) {
        return {
          settlement: Promise.resolve({
            ok: false,
            error: {
              code: "capacity_exceeded",
              message: "The active Run has reached its supplemental input capacity.",
              retryable: true,
              details: {
                scope: "run",
                runId: input.runId,
                current: state.inputQueue.length,
                limit: this.#maxPendingInputsPerAttempt,
              },
            },
          } satisfies ApplicationRunInputPreflightResult),
        };
      }
      if (this.#inputReservations.size >= this.#maxTrackedInputs) {
        return {
          settlement: Promise.resolve({
            ok: false,
            error: {
              code: "capacity_exceeded",
              message: "The runtime has reached its supplemental input capacity.",
              retryable: true,
              details: {
                scope: "application",
                current: this.#inputReservations.size,
                limit: this.#maxTrackedInputs,
              },
            },
          } satisfies ApplicationRunInputPreflightResult),
        };
      }
      const token = Object.freeze({});
      const reservation = Object.freeze({
        token,
        sessionId: state.dispatch.admission.sessionId,
        runId: state.dispatch.admission.runId,
        workspaceKey: state.dispatch.workspaceKey,
        providerId: state.dispatch.providerId,
        attemptId: state.dispatch.admission.attemptId,
        bindingId: state.dispatch.admission.bindingId,
        persistenceMode: state.dispatch.persistenceMode,
        ephemeralOwnerToken: state.dispatch.ephemeralOwnerToken,
        generationId: state.dispatch.generationId,
        conversationId: state.dispatch.threadId,
        executionId: state.turnId as string,
      });
      let resolvePreflight!: (result: ApplicationRunInputPreflightResult) => void;
      const settlement = new Promise<ApplicationRunInputPreflightResult>((resolve) => {
        resolvePreflight = resolve;
      });
      const admissionPending = state.inputQueue.some(
        (candidate) => candidate.status === "waiting" || candidate.status === "reserved",
      );
      const work: InputWork = {
        reservation,
        state,
        status: admissionPending ? "waiting" : "reserved",
        preflightResolve: resolvePreflight,
        record: null,
        beginCommand: null,
        resolutionCommand: null,
        providerCalled: false,
        abortSignal: options?.signal ?? null,
        abortListener: null,
      };
      if (options?.signal !== undefined) {
        work.abortListener = () => this.#releaseInputReservation(work);
        options.signal.addEventListener("abort", work.abortListener, { once: true });
      }
      state.inputQueue.push(work);
      this.#inputReservations.set(token, work);
      if (!admissionPending) {
        this.#resolveInputPreflight(work, { ok: true, value: reservation });
      }
      return { settlement };
    }).then(({ settlement }) => settlement);
  }

  handoff(record: ApplicationRunInputHandoffRecord): void {
    const work = this.#inputReservations.get(record.reservation.token);
    if (
      work === undefined ||
      work.status !== "reserved" ||
      work.reservation !== record.reservation ||
      !inputHandoffMatchesReservation(record, work.reservation)
    ) {
      return;
    }
    const existing = this.#inputsByMessage.get(record.messageId);
    if (existing !== undefined && existing !== work) {
      this.#releaseInputReservation(work);
      return;
    }
    this.#detachInputAbort(work);
    work.record = Object.freeze({
      ...record,
      contentBlocks: Object.freeze([...record.contentBlocks]),
    });
    work.status = "handed_off";
    this.#inputsByMessage.set(record.messageId, work);
    this.#sortInputQueue(work.state);
    this.#activateNextInputReservation(work.state);
    this.#scheduleInputDrain(work.state);
  }

  release(reservation: ApplicationRunInputOwnerReservation): void {
    const work = this.#inputReservations.get(reservation.token);
    if (work === undefined || work.reservation !== reservation || work.status !== "reserved") return;
    this.#releaseInputReservation(work);
  }

  accept(generationId: string, event: CodexAdapterEvent): Promise<void> {
    if (event.kind === "connection_failure") {
      const attempts = [...this.#attemptsByRun.values()].filter(
        (state) => state.dispatch.generationId === generationId,
      );
      return Promise.all(
        attempts.map((state) => this.#enqueue(state, () => this.#acceptAttemptEvent(state, event))),
      ).then(() => undefined);
    }
    const correlation = eventCorrelation(event);
    if (correlation.threadId === null) return Promise.resolve();
    const state = this.#attemptsByOwner.get(providerOwnerKey(generationId, correlation.threadId));
    if (state === undefined) return Promise.resolve();
    return this.#enqueue(state, () => this.#acceptAttemptEvent(state, event));
  }

  async retryRun(runId: string): Promise<boolean> {
    const state = this.#attemptsByRun.get(runId);
    if (state === undefined) return false;
    await this.#enqueue(state, () => this.#retryPersistence(state));
    this.#schedulePersistenceRetry(state);
    return true;
  }

  async #retryPersistence(state: AttemptState): Promise<void> {
    if (!(await this.#retryInputPersistence(state))) return;
    if (!(await this.#retryPendingResolution(state))) return;
    if (state.releaseReason !== null) {
      await this.#releaseAttempt(state, state.releaseReason);
      return;
    }
    if (state.phase === "sending" && state.startTurnResult !== null) {
      await this.#settleStartTurn(state, state.startTurnResult);
      return;
    }
    if ((state.phase === "accepted" || state.phase === "ambiguous") && state.terminalCommand !== null) {
      await this.#terminalize(state, state.terminalCommand.outcome, state.terminalCommand.outputs);
      return;
    }
    if (state.phase === "accepted") {
      await this.#confirmOutputsInOrder(state);
      this.#scheduleInputDrain(state);
    }
  }

  async releaseGeneration(generationId: string, reason: ApplicationRunGenerationReleaseReason): Promise<void> {
    const attempts = [...this.#attemptsByRun.values()].filter((state) => state.dispatch.generationId === generationId);
    let durabilityPending = false;
    await Promise.all(
      attempts.map((state) =>
        this.#enqueue(state, async () => {
          if (!(await this.#releaseAttempt(state, reason))) durabilityPending = true;
        }),
      ),
    );
    if (durabilityPending) throw new Error("Run persistence outcome is still unknown.");
  }

  async read(
    input: Readonly<{ sessionId: string; runId: string }>,
  ): Promise<ApplicationRunLiveActivitySnapshot | null> {
    const state = this.#attemptsByRun.get(input.runId);
    if (
      state === undefined ||
      state.phase !== "accepted" ||
      state.dispatch.admission.sessionId !== input.sessionId ||
      state.runVersion === null ||
      state.activity === null
    ) {
      return null;
    }
    return Object.freeze({
      sessionId: input.sessionId,
      runId: input.runId,
      runVersion: state.runVersion,
      activity: state.activity,
    });
  }

  #enqueue<T>(state: AttemptState, operation: () => Promise<T>): Promise<T> {
    const next = state.chain.then(operation, operation);
    // A rejected caller retains the Attempt and every frozen command for exact replay.
    state.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #interruptCancelWork(work: CancelWork): Promise<void> {
    if (work.status !== "handed_off" || work.record === null) return;
    if (!this.#isCancelWorkCurrent(work)) {
      work.disposition = { kind: "not_sent", effect: "none", code: "capability_unavailable" };
      work.status = "settled";
      this.#scheduleCancelDispositionSettlement(work);
      return;
    }
    if (work.state.control.adapter.interruptTurn === undefined) {
      work.disposition = { kind: "not_sent", effect: "none", code: "capability_unavailable" };
      work.status = "settled";
      this.#scheduleCancelDispositionSettlement(work);
      return;
    }
    work.status = "calling";
    let result: CancelDisposition;
    try {
      result = await work.state.control.adapter.interruptTurn(
        {
          threadId: work.reservation.conversationId,
          turnId: work.reservation.executionId,
        },
        { signal: work.state.control.signal },
      );
    } catch {
      result = { kind: "ambiguous", effect: "unknown", code: "invalid_response" };
    }
    work.disposition = normalizeCancelDisposition(result, work.reservation);
    work.status = "settled";
    if (work.disposition.kind !== "accepted") {
      this.#scheduleCancelDispositionSettlement(work);
    }
  }

  #scheduleCancelDispositionSettlement(work: CancelWork): void {
    if (work.settlementHandle !== null || work.state.phase === "closed") return;
    work.settlementHandle = setImmediate(() => {
      work.settlementHandle = null;
      void this.#enqueue(work.state, () => this.#settleCancelDisposition(work)).catch(() => undefined);
    });
  }

  async #settleCancelDisposition(work: CancelWork): Promise<void> {
    const disposition = work.disposition;
    if (
      disposition === null ||
      disposition.kind === "accepted" ||
      work.state.cancelWork !== work ||
      work.state.phase !== "accepted" ||
      work.state.terminalCommand !== null
    ) {
      return;
    }
    await this.#terminalize(work.state, {
      kind: "interrupted",
      failureOrigin: cancelDispositionFailureOrigin(disposition),
      providerErrorCode: null,
      errorSummary: "Provider cancellation did not confirm a terminal outcome.",
    });
  }

  #isCancelWorkCurrent(work: CancelWork): boolean {
    const { reservation, state } = work;
    return (
      state.cancelWork === work &&
      work.record !== null &&
      work.record.reservation === reservation &&
      this.#isCancelOwnerCurrent(state) &&
      state.turnId === reservation.executionId &&
      state.dispatch.admission.sessionId === reservation.sessionId &&
      state.dispatch.admission.runId === reservation.runId &&
      state.dispatch.admission.attemptId === reservation.attemptId &&
      state.dispatch.admission.bindingId === reservation.bindingId &&
      state.dispatch.workspaceKey === reservation.workspaceKey &&
      state.dispatch.providerId === reservation.providerId &&
      state.dispatch.persistenceMode === reservation.persistenceMode &&
      state.dispatch.ephemeralOwnerToken === reservation.ephemeralOwnerToken &&
      state.dispatch.generationId === reservation.generationId &&
      state.dispatch.threadId === reservation.conversationId
    );
  }

  #isCancelOwnerCurrent(state: AttemptState): boolean {
    return (
      state.phase === "accepted" &&
      state.turnId !== null &&
      state.terminalCommand === null &&
      state.releaseReason === null &&
      !state.control.signal.aborted &&
      typeof state.control.adapter.interruptTurn === "function" &&
      safeIsCurrent(state.control)
    );
  }

  #releaseCancelWork(work: CancelWork): void {
    if (work.status !== "reserved") return;
    work.status = "released";
    this.#detachCancelAbort(work);
    this.#cancelReservations.delete(work.reservation.token);
    if (work.state.cancelWork === work) work.state.cancelWork = null;
    work.resolveReservationSettlement();
  }

  #detachCancelAbort(work: CancelWork): void {
    if (work.abortSignal !== null && work.abortListener !== null) {
      work.abortSignal.removeEventListener("abort", work.abortListener);
    }
    work.abortSignal = null;
    work.abortListener = null;
  }

  async #drainInputQueue(state: AttemptState): Promise<void> {
    while (state.inputQueue[0]?.status === "released" || state.inputQueue[0]?.status === "settled") {
      state.inputQueue.shift();
    }
    if (!this.#isInputDeliveryOpen(state)) return;
    const work = state.inputQueue[0];
    if (
      work === undefined ||
      work.status === "waiting" ||
      work.status === "reserved" ||
      work.status === "beginning" ||
      work.status === "resolving" ||
      work.status === "persistence_blocked"
    ) {
      return;
    }
    if (state.phase === "closed") {
      this.#releaseInputReservation(work);
      return;
    }
    await this.#beginAndDeliverInput(work);
  }

  #scheduleInputDrain(state: AttemptState): void {
    if (state.phase === "closed" || state.inputDrainScheduled || !this.#hasInputReadyToDrain(state)) {
      return;
    }
    state.inputDrainScheduled = true;
    const drain = this.#enqueue(state, () => this.#drainInputQueue(state));
    void drain
      .finally(() => {
        state.inputDrainScheduled = false;
        if (state.phase !== "closed" && this.#hasInputReadyToDrain(state)) {
          this.#scheduleInputDrain(state);
        }
      })
      .catch(() => undefined);
  }

  #hasInputReadyToDrain(state: AttemptState): boolean {
    if (!this.#isInputDeliveryOpen(state)) return false;
    for (const work of state.inputQueue) {
      if (work.status === "released" || work.status === "settled") continue;
      return work.status === "handed_off";
    }
    return false;
  }

  async #beginAndDeliverInput(work: InputWork): Promise<void> {
    const { state, record, reservation } = work;
    if (record === null || work.providerCalled || work.resolutionCommand !== null) return;
    const command =
      work.beginCommand ??
      Object.freeze({
        sessionId: record.sessionId,
        workspaceKey: reservation.workspaceKey,
        runId: record.runId,
        attemptId: record.attemptId,
        messageId: record.messageId,
        bindingId: record.bindingId,
        ephemeralOwnerToken: reservation.ephemeralOwnerToken,
      });
    work.beginCommand = command;
    work.status = "beginning";
    const begin = await writeExact(() => this.#writes.beginRunInput(command));
    if (begin === undefined) {
      this.#schedulePersistenceRetry(state);
      return;
    }
    if (!begin.ok) {
      if (begin.error.code === "lifecycle_conflict" && begin.error.retryable) {
        work.status = "ordering_blocked";
        return;
      }
      if (begin.error.retryable) {
        this.#schedulePersistenceRetry(state);
        return;
      }
      // A deterministic Gate failure does not prove that the durable Delivery is terminal.
      work.status = "persistence_blocked";
      return;
    }
    if (
      begin.value.sessionId !== command.sessionId ||
      begin.value.runId !== command.runId ||
      begin.value.attemptId !== command.attemptId ||
      begin.value.messageId !== command.messageId ||
      begin.value.bindingId !== command.bindingId ||
      begin.value.deliveryState !== "dispatching"
    ) {
      await this.#resolveInput(work, { kind: "ambiguous", resolutionCode: "process_unknown" });
      return;
    }
    if (begin.replayed || !begin.value.sendAllowed) {
      await this.#resolveInput(work, { kind: "ambiguous", resolutionCode: "process_unknown" });
      return;
    }
    if (!this.#isCurrentInputOwner(work)) {
      await this.#resolveInput(work, { kind: "rejected", resolutionCode: "delivery_not_sent" });
      return;
    }
    const steerTurn = state.control.adapter.steerTurn;
    if (steerTurn === undefined) {
      await this.#resolveInput(work, { kind: "rejected", resolutionCode: "delivery_not_sent" });
      return;
    }
    work.providerCalled = true;
    let outcome: RunInputResolutionCommand["outcome"];
    try {
      const result = await state.control.adapter.steerTurn!(
        {
          threadId: reservation.conversationId,
          expectedTurnId: reservation.executionId,
          contentBlocks: record.contentBlocks,
        },
        { signal: state.control.signal },
      );
      outcome = inputResolutionOutcome(result, reservation);
    } catch {
      outcome = { kind: "ambiguous", resolutionCode: "process_unknown" };
    }
    await this.#resolveInput(work, outcome);
  }

  async #resolveInput(work: InputWork, outcome: RunInputResolutionCommand["outcome"]): Promise<void> {
    const record = work.record;
    if (record === null) return;
    const command =
      work.resolutionCommand ??
      Object.freeze({
        sessionId: record.sessionId,
        workspaceKey: work.reservation.workspaceKey,
        runId: record.runId,
        attemptId: record.attemptId,
        messageId: record.messageId,
        bindingId: record.bindingId,
        ephemeralOwnerToken: work.reservation.ephemeralOwnerToken,
        outcome: Object.freeze(outcome),
      });
    if (canonicalJsonString(command.outcome) !== canonicalJsonString(outcome)) return;
    work.resolutionCommand = command;
    work.status = "resolving";
    const confirmation = await this.#confirmInputResolution(command);
    if (confirmation === "confirmed") {
      this.#settleInput(work);
      return;
    }
    if (confirmation === "retry") {
      this.#schedulePersistenceRetry(work.state);
      return;
    }
    // The Run terminal transaction owns aggregate convergence for a non-terminal write rejection.
    work.status = "persistence_blocked";
  }

  async #retryInputPersistence(state: AttemptState): Promise<boolean> {
    const work = state.inputQueue.find(
      (candidate) => candidate.status === "beginning" || candidate.status === "resolving",
    );
    if (work === undefined) return true;
    if (work.status === "beginning") {
      await this.#beginAndDeliverInput(work);
      return work.status !== "beginning" && work.status !== "resolving";
    }
    const command = work.resolutionCommand;
    if (command === null) return false;
    const confirmation = await this.#confirmInputResolution(command);
    if (confirmation === "retry") return false;
    if (confirmation === "blocked") {
      work.status = "persistence_blocked";
      return true;
    }
    this.#settleInput(work);
    this.#scheduleInputDrain(state);
    return true;
  }

  async #confirmInputResolution(command: RunInputResolutionCommand): Promise<InputResolutionConfirmation> {
    const result = await writeExact(() => this.#writes.resolveRunInput(command));
    if (result === undefined) return "retry";
    if (!result.ok) return result.error.retryable ? "retry" : "blocked";
    return result.value.sessionId === command.sessionId &&
      result.value.runId === command.runId &&
      result.value.attemptId === command.attemptId &&
      result.value.messageId === command.messageId &&
      result.value.bindingId === command.bindingId &&
      result.value.deliveryState === command.outcome.kind &&
      result.value.resolutionCode === (command.outcome.kind === "accepted" ? null : command.outcome.resolutionCode)
      ? "confirmed"
      : "retry";
  }

  #isCurrentInputOwner(work: InputWork): boolean {
    const { reservation, state } = work;
    return (
      this.#isInputDeliveryOpen(state) &&
      state.turnId === reservation.executionId &&
      state.dispatch.admission.sessionId === reservation.sessionId &&
      state.dispatch.admission.runId === reservation.runId &&
      state.dispatch.admission.attemptId === reservation.attemptId &&
      state.dispatch.admission.bindingId === reservation.bindingId &&
      state.dispatch.workspaceKey === reservation.workspaceKey &&
      state.dispatch.providerId === reservation.providerId &&
      state.dispatch.generationId === reservation.generationId &&
      state.dispatch.threadId === reservation.conversationId &&
      !state.control.signal.aborted &&
      typeof state.control.adapter.steerTurn === "function" &&
      safeIsCurrent(state.control)
    );
  }

  #isInputDeliveryOpen(state: AttemptState): boolean {
    return (
      state.phase === "accepted" &&
      state.terminalCommand === null &&
      state.releaseReason === null &&
      (state.cancelWork === null || state.cancelWork.status === "reserved" || state.cancelWork.status === "released")
    );
  }

  #releaseInputReservation(work: InputWork, activateNext = true): void {
    if (
      work.status === "released" ||
      work.status === "settled" ||
      work.status === "beginning" ||
      work.status === "resolving" ||
      work.providerCalled
    ) {
      return;
    }
    work.status = "released";
    this.#resolveInputPreflight(work, inputPreflightFailure("lifecycle_conflict"));
    this.#detachInputAbort(work);
    this.#inputReservations.delete(work.reservation.token);
    this.#removeInputFromQueue(work);
    if (work.record !== null && this.#inputsByMessage.get(work.record.messageId) === work) {
      this.#inputsByMessage.delete(work.record.messageId);
    }
    if (activateNext) this.#activateNextInputReservation(work.state);
    if (work.state.phase !== "closed") {
      this.#scheduleInputDrain(work.state);
    }
  }

  #activateNextInputReservation(state: AttemptState): void {
    if (state.phase === "closed" || state.inputQueue.some((work) => work.status === "reserved")) return;
    while (true) {
      const next = state.inputQueue.find((work) => work.status === "waiting");
      if (next === undefined) return;
      if (!this.#isCurrentInputOwner(next)) {
        this.#releaseInputReservation(next, false);
        continue;
      }
      next.status = "reserved";
      this.#resolveInputPreflight(next, { ok: true, value: next.reservation });
      return;
    }
  }

  #resolveInputPreflight(work: InputWork, result: ApplicationRunInputPreflightResult): void {
    const resolve = work.preflightResolve;
    if (resolve === null) return;
    work.preflightResolve = null;
    resolve(result);
  }

  #removeInputFromQueue(work: InputWork): void {
    const index = work.state.inputQueue.indexOf(work);
    if (index >= 0) work.state.inputQueue.splice(index, 1);
  }

  #sortInputQueue(state: AttemptState): void {
    state.inputQueue.sort((left, right) => {
      const leftOrdinal = left.record?.messageOrdinal;
      const rightOrdinal = right.record?.messageOrdinal;
      if (leftOrdinal === undefined) return rightOrdinal === undefined ? 0 : 1;
      if (rightOrdinal === undefined) return -1;
      return leftOrdinal - rightOrdinal;
    });
  }

  #settleInput(work: InputWork): void {
    const settledOrdinal = work.record?.messageOrdinal;
    work.status = "settled";
    this.#detachInputAbort(work);
    this.#inputReservations.delete(work.reservation.token);
    this.#removeInputFromQueue(work);
    if (work.record !== null && this.#inputsByMessage.get(work.record.messageId) === work) {
      this.#inputsByMessage.delete(work.record.messageId);
    }
    if (settledOrdinal === undefined) return;
    const next = work.state.inputQueue.find(
      (candidate) => candidate.status !== "released" && candidate.status !== "settled",
    );
    if (next?.status === "ordering_blocked" && next.record !== null && next.record.messageOrdinal > settledOrdinal) {
      next.status = "handed_off";
    }
  }

  #detachInputAbort(work: InputWork): void {
    if (work.abortSignal !== null && work.abortListener !== null) {
      work.abortSignal.removeEventListener("abort", work.abortListener);
    }
    work.abortSignal = null;
    work.abortListener = null;
  }

  async #settleStartTurn(state: AttemptState, result: ApplicationRunStartTurnResult): Promise<void> {
    if (state.phase !== "sending") return;
    state.startTurnResult ??= result;
    result = state.startTurnResult;
    if (
      result.kind === "accepted" &&
      result.value.threadId === state.dispatch.threadId &&
      result.value.turnId.length > 0
    ) {
      await this.#acceptDurableExecution(state, result.value.turnId);
      return;
    }
    if (result.kind === "not_sent" || result.kind === "rejected") {
      state.startTurnFailure ??= classifyApplicationRunProviderMutationFailure(
        result,
        state.releaseReason?.kind === "shutdown" || state.control.signal.aborted
          ? "shutdown"
          : state.releaseReason === null
            ? null
            : "transport",
      );
      const resolved = await this.#resolveDispatch(state, { kind: "rejected" });
      if (resolved !== "rejected") return;
      const terminalized = await state.control.terminalize({
        preDispatchResolution: "not_applicable",
        outcomeKind: state.startTurnFailure.outcomeKind,
        failureOrigin: state.startTurnFailure.failureOrigin,
        providerErrorCode: state.startTurnFailure.providerErrorCode,
        errorSummary:
          result.kind === "rejected" ? "Provider execution was rejected." : "Provider execution was not sent.",
      });
      if (!terminalized) return;
      this.#close(state);
      return;
    }

    for (const event of state.bufferedEvents) {
      const turnId = acceptanceTurnId(event);
      if (turnId !== null) state.excludedLateAcceptanceIds.add(turnId);
    }
    state.phase = "ambiguous";
    await this.#resolveDispatch(state, { kind: "ambiguous" });
    const bufferedFailure = state.bufferedEvents.find(
      (event): event is Extract<CodexAdapterEvent, Readonly<{ kind: "connection_failure" }>> =>
        event.kind === "connection_failure",
    );
    const releaseReason =
      state.releaseReason ??
      (bufferedFailure === undefined ? null : ({ kind: "connection_failure", code: bufferedFailure.code } as const));
    if (releaseReason !== null) {
      await this.#releaseAttempt(state, releaseReason);
    }
  }

  async #acceptDurableExecution(state: AttemptState, turnId: string): Promise<void> {
    const resolved = await this.#resolveDispatch(state, { kind: "accepted", externalExecutionId: turnId });
    if (resolved !== "accepted") {
      state.phase = "ambiguous";
      state.turnId = turnId;
      return;
    }
    await this.#activateDurableExecution(state, turnId);
  }

  async #activateDurableExecution(state: AttemptState, turnId: string): Promise<void> {
    state.phase = "accepted";
    state.turnId = turnId;
    state.activity = "running";
    state.runVersion = await this.#readRunVersion(state);
    const buffered = state.bufferedEvents;
    state.bufferedEvents = [];
    for (const event of buffered) {
      const correlation = eventCorrelation(event);
      if (
        event.kind === "connection_failure" ||
        (correlation.threadId === state.dispatch.threadId &&
          (correlation.turnId === null || correlation.turnId === turnId))
      ) {
        await this.#acceptOwnedEvent(state, event);
      }
    }
    if ((state.phase as AttemptPhase) !== "closed" && state.releaseReason !== null) {
      const reason = state.releaseReason;
      state.releaseReason = null;
      await this.#releaseAttempt(state, reason);
    }
  }

  async #releaseAttempt(state: AttemptState, reason: ApplicationRunGenerationReleaseReason): Promise<boolean> {
    state.releaseReason ??= reason;
    if (!(await this.#retryInputPersistence(state))) return false;
    if (!(await this.#retryPendingResolution(state))) return false;
    if (state.phase === "sending") {
      if (state.startTurnResult === null) return true;
      await this.#settleStartTurn(state, state.startTurnResult);
      const phase = state.phase as AttemptPhase;
      return phase === "closed" || phase === "ambiguous";
    }
    if (state.phase === "accepted") {
      const terminalized = await this.#terminalize(state, {
        kind: "interrupted",
        failureOrigin: state.releaseReason.kind === "shutdown" ? "application" : "transport",
        providerErrorCode: state.releaseReason.kind === "connection_failure" ? state.releaseReason.code : null,
        errorSummary:
          state.releaseReason.kind === "shutdown"
            ? "Provider execution was interrupted by application shutdown."
            : "Provider connection ended during execution.",
      });
      if (terminalized) state.releaseReason = null;
      return terminalized;
    }
    if (state.phase === "ambiguous") {
      const terminalized = await this.#terminalize(state, {
        kind: "interrupted",
        failureOrigin: state.releaseReason.kind === "shutdown" ? "application" : "transport",
        providerErrorCode: state.releaseReason.kind === "connection_failure" ? state.releaseReason.code : null,
        errorSummary:
          state.releaseReason.kind === "shutdown"
            ? "Provider execution acceptance became unresolvable during application shutdown."
            : "Provider execution acceptance could not be resolved before the Provider generation ended.",
      });
      if (terminalized) state.releaseReason = null;
      return terminalized;
    }
    this.#close(state);
    return true;
  }

  async #acceptAttemptEvent(state: AttemptState, event: CodexAdapterEvent): Promise<void> {
    if (state.phase === "closed" || state.terminalCommand !== null) return;
    if (
      (event.kind === "connection_failure" &&
        (event.code === "adapter_resource_limit" || event.code === "event_queue_overflow")) ||
      (event.kind === "turn_terminal" && event.resourceLimitExceeded === true)
    ) {
      state.eventLimitExceeded = true;
    }
    if (state.pendingResolution !== null) {
      this.#bufferEvent(state, event);
      return;
    }
    if (state.phase === "sending") {
      this.#bufferEvent(state, event);
      return;
    }
    if (state.phase === "ambiguous") {
      if (event.kind === "connection_failure") {
        await this.#releaseAttempt(state, { kind: "connection_failure", code: event.code });
        return;
      }
      const turnId = acceptanceTurnId(event);
      if (turnId === null || state.excludedLateAcceptanceIds.has(turnId)) return;
      if (state.turnId !== null && state.turnId !== turnId) return;
      await this.#acceptDurableExecution(state, turnId);
      if (state.pendingResolution !== null) {
        this.#bufferEvent(state, event);
        return;
      }
      await this.#acceptOwnedEvent(state, event);
      return;
    }
    await this.#acceptOwnedEvent(state, event);
  }

  #bufferEvent(state: AttemptState, event: CodexAdapterEvent): void {
    if (state.bufferedEvents.length < this.#maxBufferedEventsPerAttempt) {
      state.bufferedEvents.push(event);
      return;
    }
    state.eventLimitExceeded = true;
    if (event.kind === "turn_terminal" || event.kind === "connection_failure") {
      const replaceIndex = state.bufferedEvents.findIndex(
        (candidate) => candidate.kind !== "turn_terminal" && candidate.kind !== "connection_failure",
      );
      if (replaceIndex >= 0) {
        state.bufferedEvents.splice(replaceIndex, 1);
        state.bufferedEvents.push(event);
      }
    }
  }

  async #acceptOwnedEvent(state: AttemptState, event: CodexAdapterEvent): Promise<void> {
    if (state.phase !== "accepted" || state.turnId === null) return;
    const correlation = eventCorrelation(event);
    if (event.kind !== "connection_failure" && correlation.threadId !== state.dispatch.threadId) return;
    if (
      event.kind !== "connection_failure" &&
      event.kind !== "thread_status_observed" &&
      correlation.turnId !== state.turnId
    )
      return;
    switch (event.kind) {
      case "turn_started":
        state.activity = "running";
        return;
      case "thread_status_observed":
        if (event.status === "active") state.activity = "running";
        return;
      case "item_output":
        await this.#appendOutput(state, event.output, {
          eventKind: event.kind,
          providerItemId: event.itemId,
          itemId: event.itemId,
        });
        return;
      case "turn_output":
        await this.#appendOutput(state, event.output, { eventKind: event.kind, providerItemId: null, itemId: null });
        return;
      case "provider_metadata":
        await this.#appendOutput(state, event.output, {
          eventKind: event.kind,
          providerItemId: null,
          itemId: event.correlation.itemId ?? null,
        });
        return;
      case "diagnostic":
        await this.#appendOutput(
          state,
          {
            category: "diagnostic",
            kind: event.diagnostic.code,
            summary: event.diagnostic.summary,
            completionState: "complete",
            payload: { kind: "none", redaction: "not_required" },
          },
          {
            eventKind: event.kind,
            providerItemId: null,
            itemId: event.diagnostic.correlation?.itemId ?? null,
          },
        );
        return;
      case "turn_terminal":
        await this.#terminalizeFromProvider(state, event);
        return;
      case "connection_failure":
        state.releaseReason ??= { kind: "connection_failure", code: event.code };
        if (
          await this.#terminalize(state, {
            kind: "interrupted",
            failureOrigin: "transport",
            providerErrorCode: event.code,
            errorSummary: "Provider connection ended during execution.",
          })
        ) {
          state.releaseReason = null;
        }
        return;
      case "thread_started":
        return;
    }
  }

  async #appendOutput(
    state: AttemptState,
    output: CodexAdapterOutput,
    identity: Readonly<{ eventKind: string; providerItemId: string | null; itemId: string | null }>,
  ): Promise<void> {
    const providerExecution = executionCorrelation(state);
    const outputKey = canonicalJsonString({
      eventKind: identity.eventKind,
      itemId: identity.itemId,
      output,
      providerExecution,
    });
    let pending = state.outputCommands.get(outputKey);
    if (pending?.confirmed === true) return;
    if (pending === undefined) {
      if (state.outputCommands.size >= this.#maxPersistedOutputsPerAttempt) {
        state.outputLimitExceeded = true;
        return;
      }
      const item = outputDraft(state.dispatch.admission.runId, outputKey, identity.providerItemId, output);
      pending = {
        command: {
          sessionId: state.dispatch.admission.sessionId,
          workspaceKey: state.dispatch.workspaceKey,
          runId: state.dispatch.admission.runId,
          providerExecution,
          item,
        },
        confirmed: false,
      };
      state.outputCommands.set(outputKey, pending);
    }
    if (!(await this.#confirmOutputsInOrder(state))) this.#schedulePersistenceRetry(state);
  }

  async #confirmOutputsInOrder(state: AttemptState): Promise<boolean> {
    for (const pending of state.outputCommands.values()) {
      if (!pending.confirmed) pending.confirmed = await this.#confirmOutput(pending.command);
      if (!pending.confirmed) return false;
    }
    return true;
  }

  async #confirmOutput(command: RunOutputAppendCommand): Promise<boolean> {
    const result = await writeExact(() => this.#writes.appendRunOutput(command));
    return (
      result?.ok === true &&
      result.value.sessionId === command.sessionId &&
      result.value.runId === command.runId &&
      result.value.outputItemId === command.item.id
    );
  }

  async #terminalizeFromProvider(
    state: AttemptState,
    event: Extract<CodexAdapterEvent, Readonly<{ kind: "turn_terminal" }>>,
  ): Promise<void> {
    const contentFailureOutput =
      event.contentFailure === null ? [] : [contentFailureTerminalOutput(state.dispatch.admission.runId, event)];
    if (event.status === "completed") {
      await this.#terminalize(
        state,
        {
          kind: "completed",
          finalAssistantMessage:
            event.contentFailure !== null || event.finalAssistantMessage === null
              ? null
              : {
                  id: deterministicId("message", state.dispatch.admission.runId, event.turnId),
                  contentBlocks: event.finalAssistantMessage.contentBlocks,
                },
        },
        contentFailureOutput,
      );
      return;
    }
    const cancelCorrelation =
      event.status === "interrupted" ? await this.#terminalCancelCorrelation(state) : ({ kind: "none" } as const);
    await this.#terminalize(
      state,
      cancelCorrelation.kind === "admitted_user_cancel"
        ? { kind: "canceled" }
        : {
            kind: event.status,
            failureOrigin: "provider",
            providerErrorCode: null,
            errorSummary:
              event.status === "failed" ? "Provider execution failed." : "Provider execution was interrupted.",
          },
      contentFailureOutput,
      cancelCorrelation,
    );
  }

  async #terminalCancelCorrelation(state: AttemptState): Promise<RunTerminalCommand["cancelCorrelation"]> {
    const work = state.cancelWork;
    if (work === null) return await this.#readDurableCancelCorrelation(state);
    if (work.status === "reserved") await work.reservationSettlement;
    const record = work.record;
    if (
      record === null ||
      state.phase !== "accepted" ||
      state.turnId === null ||
      state.turnId !== work.reservation.executionId ||
      !cancelHandoffMatchesReservation(record, work.reservation) ||
      state.dispatch.admission.sessionId !== work.reservation.sessionId ||
      state.dispatch.admission.runId !== work.reservation.runId ||
      state.dispatch.admission.attemptId !== work.reservation.attemptId ||
      state.dispatch.admission.bindingId !== work.reservation.bindingId ||
      state.dispatch.workspaceKey !== work.reservation.workspaceKey ||
      state.dispatch.providerId !== work.reservation.providerId ||
      state.dispatch.persistenceMode !== work.reservation.persistenceMode ||
      state.dispatch.ephemeralOwnerToken !== work.reservation.ephemeralOwnerToken ||
      state.dispatch.generationId !== work.reservation.generationId ||
      state.dispatch.threadId !== work.reservation.conversationId
    ) {
      return await this.#readDurableCancelCorrelation(state, work.reservation);
    }
    return {
      kind: "admitted_user_cancel",
      cancelRequestedAt: record.cancelRequestedAt,
    };
  }

  async #readDurableCancelCorrelation(
    state: AttemptState,
    reservation?: ApplicationRunCancelOwnerReservation,
  ): Promise<RunTerminalCommand["cancelCorrelation"]> {
    if (
      state.phase !== "accepted" ||
      state.turnId === null ||
      (reservation !== undefined && !cancelReservationMatchesState(reservation, state))
    ) {
      return { kind: "none" };
    }
    const sessionId = state.dispatch.admission.sessionId;
    const workspaceKey = state.dispatch.workspaceKey;
    const runId = state.dispatch.admission.runId;
    try {
      const projection = await this.#reads.runGet({
        sessionId,
        workspaceKey,
        runId,
      });
      const requestedAt = projection.run.cancelRequestedAt;
      if (
        projection.sessionId !== sessionId ||
        projection.workspaceKey !== workspaceKey ||
        projection.run.id !== runId ||
        projection.run.sessionId !== sessionId ||
        projection.run.phase !== "canceling" ||
        typeof requestedAt !== "number" ||
        !Number.isSafeInteger(requestedAt) ||
        requestedAt < 0 ||
        projection.run.cancelAcknowledgedAt !== undefined ||
        projection.run.terminalAt !== undefined
      ) {
        return { kind: "none" };
      }
      return { kind: "admitted_user_cancel", cancelRequestedAt: requestedAt };
    } catch {
      return { kind: "none" };
    }
  }

  async #terminalize(
    state: AttemptState,
    outcome: RunTerminalCommand["outcome"],
    outputs: readonly RunTerminalOutputDraft[] = [],
    cancelCorrelation: RunTerminalCommand["cancelCorrelation"] = { kind: "none" },
  ): Promise<boolean> {
    const acceptedExecution = state.phase === "accepted" && state.turnId !== null;
    const ambiguousExecution = state.phase === "ambiguous" && outcome.kind === "interrupted";
    if (!acceptedExecution && !ambiguousExecution) {
      this.#close(state);
      return true;
    }
    const terminalIdentity = acceptedExecution ? (state.turnId as string) : "dispatch-ambiguous";
    const terminalOutputs = acceptedExecution
      ? [...outputs, ...resourceLimitTerminalOutputs(state)]
      : resourceLimitTerminalOutputs(state);
    const command =
      state.terminalCommand ??
      ({
        sessionId: state.dispatch.admission.sessionId,
        workspaceKey: state.dispatch.workspaceKey,
        runId: state.dispatch.admission.runId,
        attemptId: state.dispatch.admission.attemptId,
        terminalEvent: {
          id: deterministicId("event", state.dispatch.admission.runId, terminalIdentity),
          dedupeKey: deterministicId("terminal", state.dispatch.admission.runId, terminalIdentity),
        },
        providerExecution: acceptedExecution ? executionCorrelation(state) : null,
        preDispatchResolution: acceptedExecution ? { kind: "not_applicable" } : { kind: "dispatch_ambiguous" },
        cancelCorrelation,
        outcome,
        outputs: terminalOutputs,
        childResult: null,
      } satisfies RunTerminalCommand);
    state.terminalCommand = command;
    if (!(await this.#retryInputPersistence(state))) {
      this.#schedulePersistenceRetry(state);
      return false;
    }
    if (!(await this.#confirmOutputsInOrder(state))) {
      this.#schedulePersistenceRetry(state);
      return false;
    }
    const result = await writeExact(() => this.#writes.completeRun(command));
    if (
      result?.ok &&
      result.value.sessionId === command.sessionId &&
      result.value.runId === command.runId &&
      result.value.attemptId === command.attemptId &&
      result.value.phase === command.outcome.kind &&
      result.value.terminalEventId === command.terminalEvent.id
    ) {
      this.#close(state);
      return true;
    }
    if (await this.#isTerminalPersisted(state, command)) {
      this.#close(state);
      return true;
    }
    this.#schedulePersistenceRetry(state);
    return false;
  }

  async #resolveDispatch(
    state: AttemptState,
    outcome: RunDispatchResolutionCommand["outcome"],
  ): Promise<RunDispatchResolutionResult["dispatchState"] | undefined> {
    const nextCommand: RunDispatchResolutionCommand = {
      sessionId: state.dispatch.admission.sessionId,
      workspaceKey: state.dispatch.workspaceKey,
      runId: state.dispatch.admission.runId,
      attemptId: state.dispatch.admission.attemptId,
      bindingId: state.dispatch.admission.bindingId,
      ephemeralOwnerToken: state.dispatch.ephemeralOwnerToken,
      outcome,
    };
    const command = state.pendingResolution ?? nextCommand;
    if (canonicalJsonString(command) !== canonicalJsonString(nextCommand)) return undefined;
    if (await this.#confirmDispatchResolution(state, command)) {
      state.pendingResolution = null;
      return outcome.kind;
    }
    state.pendingResolution = command;
    this.#schedulePersistenceRetry(state);
    return undefined;
  }

  async #retryPendingResolution(state: AttemptState): Promise<boolean> {
    const command = state.pendingResolution;
    if (command === null) return true;
    if (!(await this.#confirmDispatchResolution(state, command))) return false;
    state.pendingResolution = null;
    if (command.outcome.kind === "accepted") {
      await this.#activateDurableExecution(state, command.outcome.externalExecutionId);
      return true;
    }
    if (command.outcome.kind === "ambiguous") {
      await this.#replayBufferedEvents(state);
      return state.pendingResolution === null;
    }
    return true;
  }

  async #replayBufferedEvents(state: AttemptState): Promise<void> {
    const acceptanceEvidence = state.bufferedEvents.find((event) => {
      const turnId = acceptanceTurnId(event);
      return (
        turnId !== null &&
        !state.excludedLateAcceptanceIds.has(turnId) &&
        (state.turnId === null || state.turnId === turnId)
      );
    });
    if (acceptanceEvidence !== undefined) {
      const turnId = acceptanceTurnId(acceptanceEvidence);
      if (turnId === null) return;
      await this.#acceptDurableExecution(state, turnId);
      return;
    }
    const connectionFailure = state.bufferedEvents.find(
      (event): event is Extract<CodexAdapterEvent, Readonly<{ kind: "connection_failure" }>> =>
        event.kind === "connection_failure",
    );
    if (connectionFailure !== undefined) {
      await this.#releaseAttempt(state, { kind: "connection_failure", code: connectionFailure.code });
    }
  }

  async #confirmDispatchResolution(state: AttemptState, command: RunDispatchResolutionCommand): Promise<boolean> {
    const result = await writeExact(() => this.#writes.resolveRunDispatch(command));
    if (
      result?.ok &&
      result.value.sessionId === command.sessionId &&
      result.value.runId === command.runId &&
      result.value.attemptId === command.attemptId &&
      result.value.bindingId === command.bindingId &&
      result.value.dispatchState === command.outcome.kind &&
      result.value.externalExecutionId ===
        (command.outcome.kind === "accepted" ? command.outcome.externalExecutionId : null)
    ) {
      return true;
    }
    return await this.#isDispatchResolutionPersisted(state, command.outcome);
  }

  async #isDispatchResolutionPersisted(
    state: AttemptState,
    outcome: RunDispatchResolutionCommand["outcome"],
  ): Promise<boolean> {
    try {
      const recovery = await this.#reads.recoveryGet({
        sessionId: state.dispatch.admission.sessionId,
        workspaceKey: state.dispatch.workspaceKey,
        runId: state.dispatch.admission.runId,
      });
      return (
        recovery.sessionId === state.dispatch.admission.sessionId &&
        recovery.workspaceKey === state.dispatch.workspaceKey &&
        recovery.runId === state.dispatch.admission.runId &&
        recovery.attemptId === state.dispatch.admission.attemptId &&
        recovery.bindingId === state.dispatch.admission.bindingId &&
        recovery.providerId === state.dispatch.providerId &&
        recovery.externalConversationId === state.dispatch.threadId &&
        recovery.dispatchState === outcome.kind &&
        recovery.externalExecutionId === (outcome.kind === "accepted" ? outcome.externalExecutionId : null)
      );
    } catch {
      return false;
    }
  }

  async #isTerminalPersisted(state: AttemptState, command: RunTerminalCommand): Promise<boolean> {
    try {
      const projection = await this.#reads.runGet({
        sessionId: command.sessionId,
        workspaceKey: command.workspaceKey,
        runId: command.runId,
      });
      return (
        projection.sessionId === command.sessionId &&
        projection.workspaceKey === command.workspaceKey &&
        projection.run.id === command.runId &&
        projection.run.phase === command.outcome.kind
      );
    } catch {
      return false;
    }
  }

  async #readRunVersion(state: AttemptState): Promise<number | null> {
    try {
      const projection = await this.#reads.runGet({
        sessionId: state.dispatch.admission.sessionId,
        workspaceKey: state.dispatch.workspaceKey,
        runId: state.dispatch.admission.runId,
      });
      return projection.sessionId === state.dispatch.admission.sessionId &&
        projection.workspaceKey === state.dispatch.workspaceKey &&
        projection.run.id === state.dispatch.admission.runId &&
        projection.run.phase === "active"
        ? projection.run.version
        : null;
    } catch {
      return null;
    }
  }

  #schedulePersistenceRetry(state: AttemptState): void {
    if (
      state.phase === "closed" ||
      this.#attemptsByRun.get(state.dispatch.admission.runId) !== state ||
      !hasPendingPersistence(state) ||
      this.#persistenceRetryTasks.has(state)
    ) {
      return;
    }
    const task = (async () => {
      while (
        state.phase !== "closed" &&
        this.#attemptsByRun.get(state.dispatch.admission.runId) === state &&
        hasPendingPersistence(state)
      ) {
        await waitForPersistenceRetry();
        if (
          (state.phase as AttemptPhase) === "closed" ||
          this.#attemptsByRun.get(state.dispatch.admission.runId) !== state ||
          !hasPendingPersistence(state)
        ) {
          return;
        }
        await this.#enqueue(state, () => this.#retryPersistence(state));
      }
    })().finally(() => {
      if (this.#persistenceRetryTasks.get(state) === task) this.#persistenceRetryTasks.delete(state);
    });
    this.#persistenceRetryTasks.set(state, task);
    void task.catch(() => undefined);
  }

  #close(state: AttemptState): void {
    if (state.phase === "closed") return;
    state.phase = "closed";
    state.activity = null;
    state.bufferedEvents = [];
    state.excludedLateAcceptanceIds.clear();
    state.outputCommands.clear();
    state.pendingResolution = null;
    state.terminalCommand = null;
    state.releaseReason = null;
    state.startTurnResult = null;
    if (state.cancelWork !== null) {
      if (state.cancelWork.settlementHandle !== null) {
        clearImmediate(state.cancelWork.settlementHandle);
        state.cancelWork.settlementHandle = null;
      }
      this.#detachCancelAbort(state.cancelWork);
      this.#cancelReservations.delete(state.cancelWork.reservation.token);
      state.cancelWork.resolveReservationSettlement();
      state.cancelWork.status = "settled";
      state.cancelWork.record = null;
      state.cancelWork.disposition = null;
      state.cancelWork = null;
    }
    state.inputDrainScheduled = false;
    for (const work of state.inputQueue) {
      this.#resolveInputPreflight(work, inputPreflightFailure("lifecycle_conflict"));
      this.#detachInputAbort(work);
      this.#inputReservations.delete(work.reservation.token);
      if (work.record !== null && this.#inputsByMessage.get(work.record.messageId) === work) {
        this.#inputsByMessage.delete(work.record.messageId);
      }
      work.status = "settled";
    }
    state.inputQueue = [];
    if (this.#attemptsByRun.get(state.dispatch.admission.runId) === state) {
      this.#attemptsByRun.delete(state.dispatch.admission.runId);
    }
    if (this.#attemptsByOwner.get(state.ownerKey) === state) this.#attemptsByOwner.delete(state.ownerKey);
    state.resolveDone();
  }
}

function hasPendingPersistence(state: AttemptState): boolean {
  if (state.pendingResolution !== null || state.terminalCommand !== null) return true;
  if (state.inputQueue.some((work) => work.status === "beginning" || work.status === "resolving")) return true;
  for (const output of state.outputCommands.values()) {
    if (!output.confirmed) return true;
  }
  return false;
}

function waitForPersistenceRetry(): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, APPLICATION_RUN_EVENT_LIMITS.persistenceRetryDelayMs);
    timer.unref();
  });
}

function outputDraft(
  runId: string,
  outputKey: string,
  providerItemId: string | null,
  output: CodexAdapterOutput,
): RunOutputDraft {
  return {
    id: deterministicId("output", runId, outputKey),
    category: output.category,
    kind: safeKind(output.kind),
    providerItemId,
    summary: safeSummary(output.summary),
    completionState: output.completionState,
    payload: outputPayload(output),
  };
}

function outputPayload(output: CodexAdapterOutput): RunOutputPayloadCommand {
  switch (output.payload.kind) {
    case "none":
      return { state: "none" };
    case "text":
      return { state: "omitted_redaction", originalByteLength: output.payload.originalByteLength };
    case "omitted":
      return output.payload.reason === "redaction"
        ? { state: "omitted_redaction", originalByteLength: output.payload.originalByteLength }
        : {
            state: "omitted_size_limit",
            originalByteLength: output.payload.originalByteLength,
            redactionState: "redacted",
          };
    case "token_usage": {
      const content = new TextEncoder().encode(
        canonicalJsonString({
          last: output.payload.last,
          total: output.payload.total,
          modelContextWindow: output.payload.modelContextWindow,
        }),
      );
      return {
        state: "stored",
        originalByteLength: content.byteLength,
        redactionState: "not_required",
        payloadFormat: "json",
        mediaType: "application/json",
        content,
      };
    }
  }
}

function contentFailureTerminalOutput(
  runId: string,
  event: Extract<CodexAdapterEvent, Readonly<{ kind: "turn_terminal" }>>,
): RunTerminalOutputDraft {
  const code = event.contentFailure?.code ?? "invalid_content";
  return {
    id: deterministicId("output", runId, event.turnId, "content-failure", code),
    category: "diagnostic",
    kind: "assistant_content_failure",
    providerItemId: null,
    summary:
      code === "size_limit"
        ? "Final assistant content exceeded the accepted size limit."
        : "Final assistant content was invalid.",
    completionState: "complete",
    payload: { state: "none" },
  };
}

function resourceLimitTerminalOutputs(state: AttemptState): readonly RunTerminalOutputDraft[] {
  const exceeded = [...(state.eventLimitExceeded ? ["event"] : []), ...(state.outputLimitExceeded ? ["output"] : [])];
  if (exceeded.length === 0) return [];
  return [
    {
      id: deterministicId("output", state.dispatch.admission.runId, "runtime-resource-limit", ...exceeded),
      category: "diagnostic",
      kind: "runtime_resource_limit",
      providerItemId: null,
      summary: "Provider events or outputs exceeded the accepted per-Run persistence limit; bounded data was omitted.",
      completionState: "partial",
      payload: { state: "none" },
    },
  ];
}

function executionCorrelation(state: AttemptState): RunProviderExecutionCorrelation {
  if (state.turnId === null) throw new TypeError("Provider execution correlation is unavailable.");
  return {
    attemptId: state.dispatch.admission.attemptId,
    bindingId: state.dispatch.admission.bindingId,
    externalConversationId: state.dispatch.threadId,
    externalExecutionId: state.turnId,
  };
}

function eventCorrelation(event: CodexAdapterEvent): Readonly<{ threadId: string | null; turnId: string | null }> {
  switch (event.kind) {
    case "thread_started":
      return { threadId: event.thread.threadId, turnId: null };
    case "thread_status_observed":
      return { threadId: event.threadId, turnId: null };
    case "turn_started":
      return { threadId: event.turn.threadId, turnId: event.turn.turnId };
    case "item_output":
    case "turn_output":
    case "turn_terminal":
      return { threadId: event.threadId, turnId: event.turnId };
    case "provider_metadata":
      return {
        threadId: event.correlation.threadId ?? null,
        turnId: event.correlation.turnId ?? null,
      };
    case "diagnostic":
      return {
        threadId: event.diagnostic.correlation?.threadId ?? null,
        turnId: event.diagnostic.correlation?.turnId ?? null,
      };
    case "connection_failure":
      return { threadId: null, turnId: null };
  }
}

function acceptanceTurnId(event: CodexAdapterEvent): string | null {
  return event.kind === "turn_started" ? event.turn.turnId : event.kind === "turn_terminal" ? event.turnId : null;
}

function providerOwnerKey(generationId: string, threadId: string): string {
  return `${generationId.length}:${generationId}${threadId}`;
}

function deterministicId(prefix: string, ...parts: readonly string[]): string {
  const digest = createHash("sha256").update(canonicalJsonString(parts)).digest("hex");
  return `${prefix}_${digest}`;
}

function canonicalJsonString(value: unknown): string {
  return JSON.stringify(toCanonicalJson(value));
}

function toCanonicalJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) return value.map(toCanonicalJson);
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Provider event contains a non-plain value.");
    }
    const record = value as Readonly<Record<string, unknown>>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, toCanonicalJson(record[key])]),
    );
  }
  throw new TypeError("Provider event is not JSON-compatible.");
}

function safeKind(value: string): string {
  return value.length > 0 && value.length <= APPLICATION_RUN_EVENT_LIMITS.maxOutputKindCharacters
    ? value
    : "provider_output";
}

function safeSummary(value: string): string {
  return Buffer.byteLength(value, "utf8") <= APPLICATION_RUN_EVENT_LIMITS.maxSummaryBytes
    ? value
    : "Provider output summary exceeded the persistence limit.";
}

function inputPreflightFailure(code: "not_found" | "lifecycle_conflict"): ApplicationRunInputPreflightResult {
  return {
    ok: false,
    error:
      code === "not_found"
        ? {
            code,
            message: "The active Run is not owned by this runtime.",
            retryable: false,
          }
        : {
            code,
            message: "Supplemental input is not available for the active Run.",
            retryable: true,
          },
  };
}

function inputHandoffMatchesReservation(
  record: ApplicationRunInputHandoffRecord,
  reservation: ApplicationRunInputOwnerReservation,
): boolean {
  return (
    record.sessionId === reservation.sessionId &&
    record.runId === reservation.runId &&
    record.attemptId === reservation.attemptId &&
    record.bindingId === reservation.bindingId &&
    typeof record.messageId === "string" &&
    record.messageId.length > 0 &&
    record.messageId.length <= 1_024 &&
    Number.isSafeInteger(record.messageOrdinal) &&
    record.messageOrdinal > 0 &&
    Number.isSafeInteger(record.admittedAt)
  );
}

function cancelHandoffMatchesReservation(
  record: ApplicationRunCancelHandoffRecord,
  reservation: ApplicationRunCancelOwnerReservation,
): boolean {
  return (
    record.reservation === reservation &&
    record.sessionId === reservation.sessionId &&
    record.runId === reservation.runId &&
    typeof record.idempotencyKey === "string" &&
    record.idempotencyKey.length > 0 &&
    record.idempotencyKey.length <= 1_024 &&
    Number.isSafeInteger(record.cancelRequestedAt) &&
    record.cancelRequestedAt >= 0
  );
}

function cancelReservationMatchesState(
  reservation: ApplicationRunCancelOwnerReservation,
  state: AttemptState,
): boolean {
  return (
    state.phase === "accepted" &&
    state.turnId === reservation.executionId &&
    state.dispatch.admission.sessionId === reservation.sessionId &&
    state.dispatch.admission.runId === reservation.runId &&
    state.dispatch.admission.attemptId === reservation.attemptId &&
    state.dispatch.admission.bindingId === reservation.bindingId &&
    state.dispatch.workspaceKey === reservation.workspaceKey &&
    state.dispatch.providerId === reservation.providerId &&
    state.dispatch.persistenceMode === reservation.persistenceMode &&
    state.dispatch.ephemeralOwnerToken === reservation.ephemeralOwnerToken &&
    state.dispatch.generationId === reservation.generationId &&
    state.dispatch.threadId === reservation.conversationId
  );
}

function normalizeCancelDisposition(
  result: CancelDisposition,
  reservation: ApplicationRunCancelOwnerReservation,
): CancelDisposition {
  switch (result.kind) {
    case "accepted":
      return result.value.threadId === reservation.conversationId &&
        result.value.turnId === reservation.executionId &&
        result.value.terminal === false
        ? Object.freeze({
            kind: "accepted",
            effect: "present",
            value: Object.freeze({
              threadId: reservation.conversationId,
              turnId: reservation.executionId,
              terminal: false,
            }),
          })
        : Object.freeze({ kind: "ambiguous", effect: "unknown", code: "invalid_response" });
    case "not_sent":
      return Object.freeze({ kind: "not_sent", effect: "none", code: result.code });
    case "rejected":
      return Object.freeze({ kind: "rejected", effect: "none", code: result.code });
    case "ambiguous":
      return Object.freeze({ kind: "ambiguous", effect: "unknown", code: result.code });
    case "connection_failure":
      return Object.freeze({ kind: "connection_failure", effect: "unknown", code: result.code });
  }
}

function cancelDispositionFailureOrigin(
  disposition: Exclude<CancelDisposition, Readonly<{ kind: "accepted" }>>,
): "provider" | "transport" | "application" {
  switch (disposition.kind) {
    case "rejected":
      return "provider";
    case "ambiguous":
    case "connection_failure":
      return "transport";
    case "not_sent":
      return "application";
  }
}

function cancelPreflightFailure(code: "not_found" | "lifecycle_conflict"): ApplicationRunCancelPreflightResult {
  return {
    ok: false,
    error: {
      code,
      message: code === "not_found" ? "The active Run owner was not found." : "The active Run cannot be canceled.",
      retryable: false,
    },
  };
}

function safeIsCurrent(control: ApplicationRunDispatchControl): boolean {
  try {
    return control.isCurrent();
  } catch {
    return false;
  }
}

function inputResolutionOutcome(
  result: CodexAdapterMutationResult<Readonly<{ threadId: string; turnId: string }>>,
  reservation: ApplicationRunInputOwnerReservation,
): RunInputResolutionCommand["outcome"] {
  switch (result.kind) {
    case "accepted":
      return result.value.threadId === reservation.conversationId && result.value.turnId === reservation.executionId
        ? { kind: "accepted" }
        : { kind: "ambiguous", resolutionCode: "transport_unknown" };
    case "rejected":
      return { kind: "rejected", resolutionCode: "provider_rejected" };
    case "not_sent":
      return { kind: "rejected", resolutionCode: "delivery_not_sent" };
    case "ambiguous":
      return { kind: "ambiguous", resolutionCode: "transport_unknown" };
    case "connection_failure":
      return { kind: "ambiguous", resolutionCode: "process_unknown" };
  }
}

async function writeExact<TValue>(
  write: () => Promise<RepositoryCommandResult<TValue>>,
): Promise<RepositoryCommandResult<TValue> | undefined> {
  try {
    return await write();
  } catch (error) {
    if (!(error instanceof PersistenceClientError) || error.persistenceError.effect !== "unknown") return undefined;
    try {
      return await write();
    } catch {
      return undefined;
    }
  }
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Application Run event limit is invalid.");
  return value;
}
