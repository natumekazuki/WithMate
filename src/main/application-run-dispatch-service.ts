import type { ApplicationOperationOptions } from "../shared/application-service-model.js";
import type { RecoveryProjection } from "../shared/repository-read-model.js";
import type {
  RepositoryCommandResult,
  RunDispatchBeginCommand,
  RunDispatchBeginResult,
  RunDispatchResolutionCommand,
  RunDispatchResolutionResult,
} from "../shared/repository-write-model.js";
import { buildProviderRequest } from "./application-run-admission-service.js";
import type {
  ApplicationRunDispatchControl,
  ApplicationRunDispatchReadyPort,
  ApplicationRunPreparedDispatch,
} from "./application-run-runtime-service.js";
import type { ApplicationRunAttemptEventPort, ApplicationRunStartTurnResult } from "./application-run-event-service.js";
import { PersistenceClientError, type PersistenceWorkerClient } from "./persistence-worker-client.js";
import { RepositoryReadClient } from "./repository-read-client.js";
import { RepositoryWriteClient } from "./repository-write-client.js";
import type { ProviderDefinitionRegistry } from "./providers/provider-definition.js";
import { defaultProviderDefinitionRegistry } from "./providers/provider-registry.js";

export type ApplicationRunDispatchWritePort = Pick<RepositoryWriteClient, "beginRunDispatch" | "resolveRunDispatch">;
export type ApplicationRunDispatchReadPort = Pick<RepositoryReadClient, "recoveryGet">;

export type ApplicationRunDispatchServiceOptions = Readonly<{
  writes: ApplicationRunDispatchWritePort;
  reads?: ApplicationRunDispatchReadPort;
  attempts: ApplicationRunAttemptEventPort;
  providers?: ProviderDefinitionRegistry;
  maxOwnedRuns?: number;
}>;

export const APPLICATION_RUN_DISPATCH_LIMITS = Object.freeze({
  maxOwnedRuns: 128,
  persistenceRetryDelayMs: 25,
} as const);

type PendingDispatchContext = Readonly<{
  dispatch: ApplicationRunPreparedDispatch;
  control: ApplicationRunDispatchControl;
}>;

type PendingDispatchAction =
  | (PendingDispatchContext &
      Readonly<{
        kind: "begin";
        command: RunDispatchBeginCommand;
      }>)
  | (PendingDispatchContext &
      Readonly<{
        kind: "rejection";
        failure: Readonly<{
          outcomeKind: "failed" | "interrupted";
          failureOrigin: "provider" | "transport" | "application";
          providerErrorCode: string | null;
          errorSummary: string;
        }>;
      }>);

type BeginOutcome =
  | Readonly<{ kind: "confirmed"; result: RepositoryCommandResult<RunDispatchBeginResult> }>
  | Readonly<{ kind: "provider_not_sent"; result?: RunDispatchBeginResult }>
  | Readonly<{ kind: "unresolved" }>
  | Readonly<{ kind: "failed" }>;

type DispatchRejectionFailure = Readonly<{
  outcomeKind: "failed" | "interrupted";
  failureOrigin: "provider" | "transport" | "application";
  providerErrorCode: string | null;
  errorSummary: string;
}>;

export function createApplicationRunDispatchService(
  worker: PersistenceWorkerClient,
  attempts: ApplicationRunAttemptEventPort,
): ApplicationRunDispatchService {
  return new ApplicationRunDispatchService({
    reads: new RepositoryReadClient(worker),
    writes: new RepositoryWriteClient(worker),
    attempts,
  });
}

export class ApplicationRunDispatchService implements ApplicationRunDispatchReadyPort {
  readonly #writes: ApplicationRunDispatchWritePort;
  readonly #reads: ApplicationRunDispatchReadPort | undefined;
  readonly #attempts: ApplicationRunAttemptEventPort;
  readonly #providers: ProviderDefinitionRegistry;
  readonly #pendingActions = new Map<string, PendingDispatchAction>();
  readonly #retryAttempts = new Map<string, Promise<boolean>>();
  readonly #retryTasks = new Map<string, Promise<void>>();
  readonly #ownedRuns = new Set<string>();
  readonly #maxOwnedRuns: number;

  constructor(options: ApplicationRunDispatchServiceOptions) {
    this.#writes = options.writes;
    this.#reads = options.reads;
    this.#attempts = options.attempts;
    this.#providers = options.providers ?? defaultProviderDefinitionRegistry;
    this.#maxOwnedRuns = positiveLimit(options.maxOwnedRuns ?? APPLICATION_RUN_DISPATCH_LIMITS.maxOwnedRuns);
  }

  async ready(dispatch: ApplicationRunPreparedDispatch, control: ApplicationRunDispatchControl): Promise<void> {
    if (await this.retryPending(dispatch.admission.runId)) return;
    if (this.#ownedRuns.size >= this.#maxOwnedRuns) {
      await control.terminalize({
        preDispatchResolution: "dispatch_not_sent",
        outcomeKind: "failed",
        failureOrigin: "application",
        providerErrorCode: null,
        errorSummary: "Provider dispatch ownership capacity was reached.",
      });
      return;
    }
    this.#ownedRuns.add(dispatch.admission.runId);
    try {
      await this.#readyOwned(dispatch, control);
    } finally {
      if (!this.#pendingActions.has(dispatch.admission.runId)) this.#ownedRuns.delete(dispatch.admission.runId);
    }
  }

  pendingRunIds(): readonly string[] {
    return Object.freeze([...this.#ownedRuns]);
  }

  async #readyOwned(dispatch: ApplicationRunPreparedDispatch, control: ApplicationRunDispatchControl): Promise<void> {
    if (!control.isCurrent()) {
      await control.terminalize({
        preDispatchResolution: "dispatch_not_sent",
        outcomeKind: "interrupted",
        failureOrigin: "transport",
        providerErrorCode: null,
        errorSummary: "Provider connection ended before execution.",
      });
      return;
    }

    const providerRequest = buildProviderRequest(dispatch.contentBlocks, dispatch.executionSnapshot, this.#providers);
    const beginCommand: RunDispatchBeginCommand = {
      sessionId: dispatch.admission.sessionId,
      workspaceKey: dispatch.workspaceKey,
      runId: dispatch.admission.runId,
      attemptId: dispatch.admission.attemptId,
      bindingId: dispatch.admission.bindingId,
      providerRequest,
      ephemeralOwnerToken: dispatch.ephemeralOwnerToken,
    };
    const begun = await this.#begin(dispatch, beginCommand);
    if (begun.kind === "unresolved") {
      this.#pendingActions.set(dispatch.admission.runId, {
        kind: "begin",
        dispatch,
        control,
        command: beginCommand,
      });
      this.#schedulePendingRetry(dispatch.admission.runId);
      return;
    }
    if (begun.kind === "provider_not_sent") {
      await this.#rejectAndTerminalize(dispatch, control, {
        outcomeKind: "interrupted",
        failureOrigin: "application",
        providerErrorCode: null,
        errorSummary: "Dispatch persistence response was lost before Provider execution.",
      });
      return;
    }
    if (
      begun.kind === "failed" ||
      !begun.result.ok ||
      !isExpectedBeginResult(begun.result.value, dispatch) ||
      !begun.result.value.sendAllowed
    ) {
      return;
    }

    await this.#continueAfterBegin(dispatch, control);
  }

  async #continueAfterBegin(
    dispatch: ApplicationRunPreparedDispatch,
    control: ApplicationRunDispatchControl,
  ): Promise<void> {
    const compiled = this.#providers.compileSnapshot(dispatch.executionSnapshot);
    if (!control.isCurrent()) {
      await this.#rejectAndTerminalize(dispatch, control, {
        outcomeKind: "interrupted",
        failureOrigin: "transport",
        providerErrorCode: null,
        errorSummary: "Provider connection ended before execution.",
      });
      return;
    }

    const attempt = this.#attempts.register(dispatch, control);
    if (attempt === null) {
      await this.#rejectAndTerminalize(dispatch, control, {
        outcomeKind: "failed",
        failureOrigin: "application",
        providerErrorCode: null,
        errorSummary: "Provider execution ownership capacity was reached.",
      });
      return;
    }

    let result: ApplicationRunStartTurnResult;
    try {
      result = await control.adapter.startTurn(
        {
          threadId: dispatch.threadId,
          contentBlocks: dispatch.contentBlocks,
          ...compiled.startTurn,
        },
        { signal: control.signal },
      );
    } catch {
      result = { kind: "ambiguous", effect: "unknown", code: "connection_lost" };
    }

    await attempt.settleStartTurn(result).catch(() => undefined);
    await attempt.done;
  }

  async retryPending(runId: string): Promise<boolean> {
    const existing = this.#retryAttempts.get(runId);
    if (existing !== undefined) return existing;
    const attempt = this.#retryPending(runId).finally(() => {
      if (this.#retryAttempts.get(runId) === attempt) this.#retryAttempts.delete(runId);
    });
    this.#retryAttempts.set(runId, attempt);
    return attempt;
  }

  async #retryPending(runId: string): Promise<boolean> {
    const pending = this.#pendingActions.get(runId);
    if (pending === undefined) return false;
    if (pending.kind === "rejection") {
      await this.#rejectAndTerminalize(pending.dispatch, pending.control, pending.failure);
      if (!this.#pendingActions.has(runId)) this.#ownedRuns.delete(runId);
      return true;
    }
    const begun = await this.#begin(pending.dispatch, pending.command);
    if (begun.kind === "unresolved") return true;
    this.#pendingActions.delete(runId);
    if (
      begun.kind === "provider_not_sent" ||
      (begun.kind === "confirmed" &&
        begun.result.ok &&
        isExpectedBeginResult(begun.result.value, pending.dispatch) &&
        !begun.result.value.sendAllowed)
    ) {
      await this.#rejectAndTerminalize(pending.dispatch, pending.control, {
        outcomeKind: "interrupted",
        failureOrigin: "application",
        providerErrorCode: null,
        errorSummary: "Dispatch persistence response was lost before Provider execution.",
      });
    } else if (
      begun.kind === "confirmed" &&
      begun.result.ok &&
      isExpectedBeginResult(begun.result.value, pending.dispatch) &&
      begun.result.value.sendAllowed
    ) {
      await this.#continueAfterBegin(pending.dispatch, pending.control);
    }
    if (!this.#pendingActions.has(runId)) this.#ownedRuns.delete(runId);
    return true;
  }

  #schedulePendingRetry(runId: string): void {
    if (this.#retryTasks.has(runId)) return;
    const task = (async () => {
      while (this.#pendingActions.has(runId)) {
        await waitForPersistenceRetry();
        if (!this.#pendingActions.has(runId)) return;
        await this.retryPending(runId);
      }
    })().finally(() => {
      if (this.#retryTasks.get(runId) === task) this.#retryTasks.delete(runId);
    });
    this.#retryTasks.set(runId, task);
    void task.catch(() => undefined);
  }

  async flushPending(): Promise<boolean> {
    for (const runId of [...this.#pendingActions.keys()]) await this.retryPending(runId);
    return this.#pendingActions.size === 0;
  }

  async #rejectAndTerminalize(
    dispatch: ApplicationRunPreparedDispatch,
    control: ApplicationRunDispatchControl,
    failure: DispatchRejectionFailure,
  ): Promise<void> {
    const resolved = await this.#resolve(dispatch, { kind: "rejected" });
    if (resolved !== "rejected") {
      this.#pendingActions.set(dispatch.admission.runId, { kind: "rejection", dispatch, control, failure });
      this.#schedulePendingRetry(dispatch.admission.runId);
      return;
    }
    this.#pendingActions.delete(dispatch.admission.runId);
    await control.terminalize({
      preDispatchResolution: "not_applicable",
      ...failure,
    });
  }

  async #begin(dispatch: ApplicationRunPreparedDispatch, command: RunDispatchBeginCommand): Promise<BeginOutcome> {
    try {
      return { kind: "confirmed", result: await this.#writes.beginRunDispatch(command) };
    } catch (error) {
      if (
        error instanceof PersistenceClientError &&
        error.persistenceError.effect === "none" &&
        error.persistenceError.retryable
      ) {
        return { kind: "unresolved" };
      }
      if (!(error instanceof PersistenceClientError) || error.persistenceError.effect !== "unknown") {
        return { kind: "failed" };
      }
    }
    try {
      const result = await this.#writes.beginRunDispatch(command);
      return result.ok && isExpectedBeginResult(result.value, dispatch) && !result.value.sendAllowed
        ? { kind: "provider_not_sent", result: result.value }
        : { kind: "confirmed", result };
    } catch {
      const recovery = await this.#readRecovery(dispatch);
      if (recovery?.dispatchState === "dispatching") return { kind: "provider_not_sent" };
      return recovery === undefined || recovery.dispatchState === "pending"
        ? { kind: "unresolved" }
        : { kind: "failed" };
    }
  }

  async #resolve(
    dispatch: ApplicationRunPreparedDispatch,
    outcome: RunDispatchResolutionCommand["outcome"],
  ): Promise<RunDispatchResolutionResult["dispatchState"] | undefined> {
    const command: RunDispatchResolutionCommand = {
      sessionId: dispatch.admission.sessionId,
      workspaceKey: dispatch.workspaceKey,
      runId: dispatch.admission.runId,
      attemptId: dispatch.admission.attemptId,
      bindingId: dispatch.admission.bindingId,
      ephemeralOwnerToken: dispatch.ephemeralOwnerToken,
      outcome,
    };
    const result = await writeResolutionWithExactRetry(this.#writes, command);
    if (result?.ok && isExpectedResolutionResult(result.value, dispatch, outcome)) return result.value.dispatchState;
    const recovery = await this.#readRecovery(dispatch);
    return recovery !== undefined &&
      recovery.dispatchState === outcome.kind &&
      recovery.externalExecutionId === (outcome.kind === "accepted" ? outcome.externalExecutionId : null)
      ? outcome.kind
      : undefined;
  }

  async #readRecovery(dispatch: ApplicationRunPreparedDispatch): Promise<RecoveryProjection | undefined> {
    if (this.#reads === undefined) return undefined;
    try {
      const recovery = await this.#reads.recoveryGet({
        sessionId: dispatch.admission.sessionId,
        workspaceKey: dispatch.workspaceKey,
        runId: dispatch.admission.runId,
      });
      return recovery.sessionId === dispatch.admission.sessionId &&
        recovery.workspaceKey === dispatch.workspaceKey &&
        recovery.runId === dispatch.admission.runId &&
        recovery.attemptId === dispatch.admission.attemptId &&
        recovery.bindingId === dispatch.admission.bindingId &&
        recovery.providerId === dispatch.providerId &&
        recovery.externalConversationId === dispatch.threadId
        ? recovery
        : undefined;
    } catch {
      return undefined;
    }
  }
}

async function writeResolutionWithExactRetry(
  writes: ApplicationRunDispatchWritePort,
  command: RunDispatchResolutionCommand,
): Promise<RepositoryCommandResult<RunDispatchResolutionResult> | undefined> {
  try {
    return await writes.resolveRunDispatch(command);
  } catch (error) {
    if (!(error instanceof PersistenceClientError) || error.persistenceError.effect !== "unknown") return undefined;
    try {
      return await writes.resolveRunDispatch(command);
    } catch {
      return undefined;
    }
  }
}

function isExpectedBeginResult(value: RunDispatchBeginResult, dispatch: ApplicationRunPreparedDispatch): boolean {
  return (
    value.sessionId === dispatch.admission.sessionId &&
    value.runId === dispatch.admission.runId &&
    value.attemptId === dispatch.admission.attemptId &&
    value.bindingId === dispatch.admission.bindingId &&
    value.dispatchState === "dispatching"
  );
}

function isExpectedResolutionResult(
  value: RunDispatchResolutionResult,
  dispatch: ApplicationRunPreparedDispatch,
  outcome: RunDispatchResolutionCommand["outcome"],
): boolean {
  return (
    value.sessionId === dispatch.admission.sessionId &&
    value.runId === dispatch.admission.runId &&
    value.attemptId === dispatch.admission.attemptId &&
    value.bindingId === dispatch.admission.bindingId &&
    value.dispatchState === outcome.kind &&
    value.externalExecutionId === (outcome.kind === "accepted" ? outcome.externalExecutionId : null)
  );
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Application Run dispatch limit is invalid.");
  return value;
}

function waitForPersistenceRetry(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, APPLICATION_RUN_DISPATCH_LIMITS.persistenceRetryDelayMs);
    timer.unref();
  });
}
