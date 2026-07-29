import { createHash } from "node:crypto";

import type { ApplicationRunLiveActivity } from "../shared/application-run-model.js";
import type {
  RepositoryCommandResult,
  RunDispatchResolutionCommand,
  RunDispatchResolutionResult,
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
  CodexAdapterMutationResult,
  CodexAdapterOutput,
  CodexAdapterTurnSnapshot,
} from "./providers/codex/index.js";
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
  "resolveRunDispatch" | "appendRunOutput" | "completeRun"
>;

export type ApplicationRunEventServiceOptions = Readonly<{
  reads: ApplicationRunEventReadPort;
  writes: ApplicationRunEventWritePort;
  limits?: Readonly<{
    maxTrackedAttempts?: number;
    maxBufferedEventsPerAttempt?: number;
    maxPersistedOutputsPerAttempt?: number;
  }>;
}>;

export function createApplicationRunEventService(worker: PersistenceWorkerClient): ApplicationRunEventService {
  return new ApplicationRunEventService({
    reads: new RepositoryReadClient(worker),
    writes: new RepositoryWriteClient(worker),
  });
}

type AttemptPhase = "sending" | "ambiguous" | "accepted" | "closed";

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
  chain: Promise<void>;
};

export class ApplicationRunEventService
  implements
    ApplicationRunAttemptEventPort,
    ApplicationRunProviderEventPort,
    ApplicationRunProviderGenerationPort,
    ApplicationRunLiveActivityPort
{
  readonly #reads: ApplicationRunEventReadPort;
  readonly #writes: ApplicationRunEventWritePort;
  readonly #maxTrackedAttempts: number;
  readonly #maxBufferedEventsPerAttempt: number;
  readonly #maxPersistedOutputsPerAttempt: number;
  readonly #attemptsByRun = new Map<string, AttemptState>();
  readonly #attemptsByOwner = new Map<string, AttemptState>();
  readonly #persistenceRetryTasks = new Map<AttemptState, Promise<void>>();

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
    if (!(await this.#retryPendingResolution(state))) return;
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

  #enqueue(state: AttemptState, operation: () => Promise<void>): Promise<void> {
    const next = state.chain.then(operation, operation);
    // A rejected caller retains the Attempt and every frozen command for exact replay.
    state.chain = next.catch(() => undefined);
    return next;
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
    if (!(await this.#retryPendingResolution(state))) return false;
    if (state.phase === "sending") {
      state.releaseReason ??= reason;
      if (state.startTurnResult === null) return true;
      await this.#settleStartTurn(state, state.startTurnResult);
      const phase = state.phase as AttemptPhase;
      return phase === "closed" || phase === "ambiguous";
    }
    if (state.phase === "accepted") {
      state.releaseReason ??= reason;
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
      state.releaseReason ??= reason;
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
    await this.#terminalize(
      state,
      {
        kind: event.status,
        failureOrigin: "provider",
        providerErrorCode: null,
        errorSummary: event.status === "failed" ? "Provider execution failed." : "Provider execution was interrupted.",
      },
      contentFailureOutput,
    );
  }

  async #terminalize(
    state: AttemptState,
    outcome: RunTerminalCommand["outcome"],
    outputs: readonly RunTerminalOutputDraft[] = [],
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
        outcome,
        outputs: terminalOutputs,
        childResult: null,
      } satisfies RunTerminalCommand);
    state.terminalCommand = command;
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
      ephemeralOwnerToken: null,
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
    if (this.#attemptsByRun.get(state.dispatch.admission.runId) === state) {
      this.#attemptsByRun.delete(state.dispatch.admission.runId);
    }
    if (this.#attemptsByOwner.get(state.ownerKey) === state) this.#attemptsByOwner.delete(state.ownerKey);
    state.resolveDone();
  }
}

function hasPendingPersistence(state: AttemptState): boolean {
  if (state.pendingResolution !== null || state.terminalCommand !== null) return true;
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
