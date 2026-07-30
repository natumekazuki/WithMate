import { createHash } from "node:crypto";

import { ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS } from "../shared/allowed-additional-directories.js";
import { APPLICATION_RUN_PAYLOAD_LIMITS } from "../shared/application-run-payload-limits.js";
import {
  MESSAGE_CONTENT_LIMITS,
  snapshotMessageContentBlocks,
  type TextContentBlock,
} from "../shared/message-content.js";
import type { ApplicationOperationOptions } from "../shared/application-service-model.js";
import type { RecoveryProjection, RunDetail, SessionDetail } from "../shared/repository-read-model.js";
import type {
  ProviderBindingResolutionCommand,
  ProviderBindingResolutionResult,
  RepositoryCommandResult,
  RunExecutionSnapshot,
  RunTerminalCommand,
  RunTerminalResult,
} from "../shared/repository-write-model.js";
import type {
  CodexAdapterEvent,
  CodexAdapterMutationResult,
  CodexAdapterSteerAcknowledgement,
  CodexAdapterThreadSnapshot,
  CodexAdapterTurnSnapshot,
  CodexResumeThreadInput,
  CodexStartThreadInput,
  CodexStartTurnInput,
  CodexSteerTurnInput,
} from "./providers/codex/index.js";
import { decodeApplicationRunExecutionSnapshot } from "./application-run-admission-service.js";
import type {
  ApplicationRunAdmissionRecord,
  ApplicationRunWorkHandoffPort,
} from "./application-run-admission-service.js";
import {
  ApplicationRunProviderRuntimeStartupError,
  classifyApplicationRunProviderRuntimeStartupFailure,
  classifyApplicationRunProviderMutationFailure,
  type ApplicationRunProviderMutationInterruption,
} from "./application-run-provider-failure.js";
import { PersistenceClientError, type PersistenceWorkerClient } from "./persistence-worker-client.js";
import { RepositoryReadClient } from "./repository-read-client.js";
import { RepositoryWriteClient } from "./repository-write-client.js";

export const APPLICATION_RUN_RUNTIME_LIMITS = Object.freeze({
  maxLiveRuns: 128,
  maxTrackedBindings: 128,
  maxSnapshotBytes: APPLICATION_RUN_PAYLOAD_LIMITS.executionSnapshotMaxJsonBytes,
  chunkBytes: 256 * 1024,
  persistenceRetryDelayMs: 25,
} as const);

export interface ApplicationRunProviderAdapterPort {
  startThread(
    input: CodexStartThreadInput & Readonly<{ reasoningEffort: string }>,
    options?: ApplicationOperationOptions,
  ): Promise<CodexAdapterMutationResult<CodexAdapterThreadSnapshot>>;
  resumeThread(
    input: CodexResumeThreadInput,
    options?: ApplicationOperationOptions,
  ): Promise<CodexAdapterMutationResult<CodexAdapterThreadSnapshot>>;
  startTurn(
    input: CodexStartTurnInput,
    options?: ApplicationOperationOptions,
  ): Promise<CodexAdapterMutationResult<CodexAdapterTurnSnapshot>>;
  steerTurn?(
    input: CodexSteerTurnInput,
    options?: ApplicationOperationOptions,
  ): Promise<CodexAdapterMutationResult<CodexAdapterSteerAcknowledgement>>;
  nextEvent(): Promise<CodexAdapterEvent>;
  close(): Promise<void>;
}

export type ApplicationRunProviderRuntime = Readonly<{
  providerId: string;
  generationId: string;
  adapter: ApplicationRunProviderAdapterPort;
}>;

export interface ApplicationRunProviderRuntimeFactory {
  supports(providerId: string): boolean;
  start(providerId: string, generationId: string, signal: AbortSignal): Promise<ApplicationRunProviderRuntime>;
  closePending?(): Promise<void>;
}

export type ApplicationRunBindingOwnership =
  | Readonly<{
      persistenceMode: "persistent";
      ephemeralOwnerToken: null;
    }>
  | Readonly<{
      persistenceMode: "ephemeral";
      ephemeralOwnerToken: string;
    }>;

export type ApplicationRunPreparedDispatch = Readonly<{
  admission: ApplicationRunAdmissionRecord;
  workspaceKey: string;
  providerId: string;
  threadId: string;
  generationId: string;
  executionSnapshot: RunExecutionSnapshot;
  contentBlocks: readonly TextContentBlock[];
}> &
  ApplicationRunBindingOwnership;

export type ApplicationRunDispatchFailure = Readonly<{
  preDispatchResolution: "not_applicable" | "dispatch_not_sent";
  outcomeKind: "failed" | "interrupted";
  failureOrigin: "provider" | "transport" | "process" | "application" | "unknown";
  providerErrorCode: string | null;
  errorSummary: string;
}>;

export type ApplicationRunDispatchControl = Readonly<{
  adapter: ApplicationRunProviderAdapterPort;
  signal: AbortSignal;
  isCurrent(): boolean;
  terminalize(failure: ApplicationRunDispatchFailure): Promise<boolean>;
}>;

export interface ApplicationRunDispatchReadyPort {
  ready(dispatch: ApplicationRunPreparedDispatch, control: ApplicationRunDispatchControl): void | Promise<void>;
  retryPending?(runId: string): Promise<boolean>;
  flushPending?(): Promise<boolean>;
  pendingRunIds?(): readonly string[];
}

export interface ApplicationRunProviderEventPort {
  accept(generationId: string, event: CodexAdapterEvent): void | Promise<void>;
  retryRun?(runId: string): Promise<boolean>;
  releaseGeneration(
    generationId: string,
    reason: Readonly<
      { kind: "connection_failure"; code: string } | { kind: "shutdown" } | { kind: "event_consumer_failure" }
    >,
  ): void | Promise<void>;
}

export type ApplicationRunRuntimeReadPort = Pick<
  RepositoryReadClient,
  "sessionGet" | "sessionDirectoriesChunk" | "runGet" | "runSnapshotChunk" | "messageContentChunk" | "recoveryGet"
>;

export interface ApplicationRunRuntimeWritePort {
  resolveProviderBinding(
    command: ProviderBindingResolutionCommand,
    options?: ApplicationOperationOptions,
  ): Promise<RepositoryCommandResult<ProviderBindingResolutionResult>>;
  completeRun(
    command: RunTerminalCommand,
    options?: ApplicationOperationOptions,
  ): Promise<RepositoryCommandResult<RunTerminalResult>>;
}

export type ApplicationRunRuntimeServiceOptions = Readonly<{
  reads: ApplicationRunRuntimeReadPort;
  writes: ApplicationRunRuntimeWritePort;
  runtimeFactory: ApplicationRunProviderRuntimeFactory;
  dispatchReady: ApplicationRunDispatchReadyPort;
  events?: ApplicationRunProviderEventPort;
  persistenceRetryable?: () => boolean;
  limits?: Readonly<{
    maxLiveRuns?: number;
    maxTrackedBindings?: number;
  }>;
}>;

type RuntimeState = {
  providerId: string;
  generationId: string;
  runtime: ApplicationRunProviderRuntime;
  failed: boolean;
  generationReleased: boolean;
  retireReason: Parameters<ApplicationRunProviderEventPort["releaseGeneration"]>[1] | null;
  eventDrain: ReturnType<typeof startEventDrain> | null;
};

type BindingOwner = Readonly<{
  sessionId: string;
  providerId: string;
  bindingId: string;
  threadId: string;
  generationId: string;
}> &
  ApplicationRunBindingOwnership;

type RuntimeExecutionContext = Readonly<{
  admission: ApplicationRunAdmissionRecord;
  session: SessionDetail;
  recovery: RecoveryProjection;
  run: RunDetail;
  snapshot: RunExecutionSnapshot;
  contentBlocks: readonly TextContentBlock[];
}>;

type PendingBindingResolution = Readonly<{
  context: RuntimeExecutionContext;
  command: ProviderBindingResolutionCommand;
}>;

export class ApplicationRunRuntimeShutdownPendingError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "ApplicationRunRuntimeShutdownPendingError";
  }
}

class ApplicationRunRuntimeFatalPersistenceClosureError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "ApplicationRunRuntimeFatalPersistenceClosureError";
  }
}

const discardUnownedProviderEvents: ApplicationRunProviderEventPort = {
  accept() {
    // Provider event persistence and terminal ownership are added by the next implementation slice.
  },
  releaseGeneration() {
    // No attempt state is owned when the event port is absent.
  },
};

export class ApplicationRunRuntimeService implements ApplicationRunWorkHandoffPort {
  readonly #reads: ApplicationRunRuntimeReadPort;
  readonly #writes: ApplicationRunRuntimeWritePort;
  readonly #runtimeFactory: ApplicationRunProviderRuntimeFactory;
  readonly #dispatchReady: ApplicationRunDispatchReadyPort;
  readonly #events: ApplicationRunProviderEventPort;
  readonly #persistenceRetryable: () => boolean;
  readonly #maxLiveRuns: number;
  readonly #maxTrackedBindings: number;
  readonly #work = new Map<string, Promise<void>>();
  readonly #pendingContextReads = new Map<string, ApplicationRunAdmissionRecord>();
  readonly #pendingBindingResolutions = new Map<string, PendingBindingResolution>();
  readonly #pendingTerminals = new Map<string, RunTerminalCommand>();
  readonly #terminalRetryTasks = new Map<string, Promise<void>>();
  readonly #replayAfterWork = new Set<string>();
  readonly #bindings = new Map<string, BindingOwner>();
  readonly #closedRuntimes = new WeakSet<RuntimeState>();
  readonly #closingRuntimes = new WeakMap<RuntimeState, Promise<void>>();
  readonly #retiringRuntimes = new WeakMap<RuntimeState, Promise<void>>();
  readonly #lifecycleAbort = new AbortController();
  #runtime: RuntimeState | undefined;
  #runtimeStart: Promise<RuntimeState> | undefined;
  #nextGeneration = 1;
  #closing = false;
  #shutdownPromise: Promise<void> | undefined;
  #rejectedHandoffCount = 0;

  constructor(options: ApplicationRunRuntimeServiceOptions) {
    this.#reads = options.reads;
    this.#writes = options.writes;
    this.#runtimeFactory = options.runtimeFactory;
    this.#dispatchReady = options.dispatchReady;
    this.#events = options.events ?? discardUnownedProviderEvents;
    this.#persistenceRetryable = options.persistenceRetryable ?? (() => true);
    this.#maxLiveRuns = positiveLimit(options.limits?.maxLiveRuns ?? APPLICATION_RUN_RUNTIME_LIMITS.maxLiveRuns);
    this.#maxTrackedBindings = positiveLimit(
      options.limits?.maxTrackedBindings ?? APPLICATION_RUN_RUNTIME_LIMITS.maxTrackedBindings,
    );
  }

  handoff(record: ApplicationRunAdmissionRecord): void {
    const admission = snapshotAdmissionRecord(record);
    this.#handoff(admission, false);
  }

  #handoff(admission: ApplicationRunAdmissionRecord, ownsCapacity: boolean): void {
    if (this.#closing) return;
    if (this.#work.has(admission.runId)) {
      this.#replayAfterWork.add(admission.runId);
      void this.#events.retryRun?.(admission.runId).catch(() => undefined);
      return;
    }
    const pendingTerminal = this.#pendingTerminals.get(admission.runId);
    if (pendingTerminal !== undefined) {
      const work = this.#retryPendingTerminal(pendingTerminal).finally(() => {
        this.#finishWork(admission, work);
      });
      this.#work.set(admission.runId, work);
      void work.catch(() => undefined);
      return;
    }
    const isPendingDispatchOwner = this.#dispatchReady.pendingRunIds?.().includes(admission.runId) === true;
    if (!ownsCapacity && !isPendingDispatchOwner && this.#ownedRunCount() >= this.#maxLiveRuns) {
      this.#rejectedHandoffCount += 1;
      throw new RangeError("Application Run runtime work limit was reached.");
    }
    const work = (async () => {
      if ((await this.#dispatchReady.retryPending?.(admission.runId)) === true) return;
      await this.#own(admission);
    })().finally(() => {
      this.#finishWork(admission, work);
    });
    this.#work.set(admission.runId, work);
    void work.catch(() => undefined);
  }

  #finishWork(admission: ApplicationRunAdmissionRecord, work: Promise<void>): void {
    if (this.#work.get(admission.runId) !== work) return;
    this.#work.delete(admission.runId);
    if (!this.#replayAfterWork.delete(admission.runId) || this.#closing) return;
    if (this.#dispatchReady.pendingRunIds?.().includes(admission.runId) !== true) return;
    this.#handoff(admission, true);
  }

  diagnostics(): Readonly<{
    liveRunCount: number;
    trackedBindingCount: number;
    providerGenerationCount: number;
    rejectedHandoffCount: number;
  }> {
    return Object.freeze({
      liveRunCount: this.#ownedRunCount(),
      trackedBindingCount: this.#bindings.size,
      providerGenerationCount: this.#runtime === undefined ? 0 : 1,
      rejectedHandoffCount: this.#rejectedHandoffCount,
    });
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise === undefined) {
      const attempt = this.#shutdown().catch((error: unknown) => {
        if (this.#shutdownPromise === attempt) this.#shutdownPromise = undefined;
        throw error;
      });
      this.#shutdownPromise = attempt;
    }
    return this.#shutdownPromise;
  }

  async #shutdown(): Promise<void> {
    this.#closing = true;
    this.#lifecycleAbort.abort();
    const runtimes = new Set<RuntimeState>();
    if (this.#runtime !== undefined) runtimes.add(this.#runtime);
    const starting = this.#runtimeStart;
    if (starting !== undefined) {
      const started = await starting.catch(() => undefined);
      if (started !== undefined) runtimes.add(started);
    }
    if (this.#runtime !== undefined) runtimes.add(this.#runtime);
    const providerClosures = [
      ...[...runtimes].map((runtime) => this.#retireRuntime(runtime, { kind: "shutdown" })),
      ...(this.#runtimeFactory.closePending === undefined ? [] : [this.#runtimeFactory.closePending()]),
    ];
    const providerClosureResults = await Promise.allSettled(providerClosures);
    const providerClosureFailure = providerClosureResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (providerClosureFailure !== undefined) {
      if (
        providerClosureFailure.reason instanceof ApplicationRunRuntimeShutdownPendingError ||
        providerClosureFailure.reason instanceof ApplicationRunRuntimeFatalPersistenceClosureError
      ) {
        throw providerClosureFailure.reason;
      }
      throw new ApplicationRunRuntimeShutdownPendingError("Provider runtime closure is still unresolved.", {
        cause: providerClosureFailure.reason,
      });
    }
    if ((await this.#dispatchReady.flushPending?.()) === false) {
      this.#throwPersistenceClosure("Run dispatch persistence outcome is still unknown during shutdown.");
    }
    await Promise.allSettled([...this.#work.values()]);
    if ((await this.#dispatchReady.flushPending?.()) === false) {
      this.#throwPersistenceClosure("Run dispatch persistence outcome is still unknown during shutdown.");
    }
    await this.#drainPendingRuntimeOwners();
    for (const command of [...this.#pendingTerminals.values()]) await this.#retryPendingTerminal(command);
    if (this.#pendingTerminals.size > 0) {
      this.#throwPersistenceClosure("Run terminal persistence outcome is still unknown during shutdown.");
    }
    if (this.#pendingContextReads.size > 0 || this.#pendingBindingResolutions.size > 0) {
      this.#throwPersistenceClosure("Run runtime persistence ownership is still unresolved during shutdown.");
    }
    this.#bindings.clear();
    this.#runtime = undefined;
    this.#runtimeStart = undefined;
  }

  #throwPersistenceClosure(message: string, cause?: unknown): never {
    if (!this.#persistenceRetryable()) {
      throw new ApplicationRunRuntimeFatalPersistenceClosureError(
        "Persistence Worker is unavailable while Run closure remains unresolved.",
        { cause },
      );
    }
    throw new ApplicationRunRuntimeShutdownPendingError(message, { cause });
  }

  async #own(admission: ApplicationRunAdmissionRecord): Promise<void> {
    this.#pendingContextReads.set(admission.runId, admission);
    const context = await this.#readContextUntilAvailable(admission);
    if (context === undefined) return;
    this.#pendingContextReads.delete(admission.runId);
    if (!isSafeRuntimeCandidate(context)) return;
    if (!this.#runtimeFactory.supports(context.session.providerId)) {
      await this.#terminalize(
        context,
        context.recovery.bindingState === "creating" ? "binding_creation_not_sent" : "dispatch_not_sent",
        "failed",
        "application",
        "The Session Provider is not supported by this runtime.",
      );
      return;
    }

    let runtime: RuntimeState;
    try {
      runtime = await this.#getRuntime(context.session.providerId);
    } catch (error) {
      const failure = classifyApplicationRunProviderRuntimeStartupFailure(error, this.#closing);
      await this.#terminalize(
        context,
        context.recovery.bindingState === "creating" ? "binding_creation_not_sent" : "dispatch_not_sent",
        failure.outcomeKind,
        failure.failureOrigin,
        failure.errorSummary,
      );
      return;
    }
    if (this.#closing) {
      await this.#terminalize(
        context,
        context.recovery.bindingState === "creating" ? "binding_creation_not_sent" : "dispatch_not_sent",
        "interrupted",
        "application",
        "Application shutdown completed before Provider execution started.",
      );
      return;
    }
    if (runtime.failed || this.#runtime !== runtime) {
      await this.#terminalize(
        context,
        context.recovery.bindingState === "creating" ? "binding_creation_not_sent" : "dispatch_not_sent",
        "interrupted",
        "transport",
        "Provider runtime ended before mutation.",
      );
      return;
    }

    if (context.recovery.bindingState === "creating") {
      await this.#createBinding(context, runtime);
      return;
    }
    await this.#reuseBinding(context, runtime);
  }

  async #createBinding(context: RuntimeExecutionContext, runtime: RuntimeState): Promise<void> {
    const settings = providerSettings(context.snapshot);
    let result: CodexAdapterMutationResult<CodexAdapterThreadSnapshot>;
    try {
      result = await runtime.runtime.adapter.startThread(
        {
          model: settings.model,
          reasoningEffort: settings.reasoningEffort,
          workspacePath: settings.workspacePath,
          approvalPolicy: "never",
          sandboxMode: settings.sandboxMode,
          persistence: "persistent",
        },
        { signal: this.#lifecycleAbort.signal },
      );
    } catch {
      await this.#terminalize(
        context,
        "binding_creation_ambiguous",
        "interrupted",
        "transport",
        "Provider conversation creation outcome is unknown.",
      );
      await this.#retireRuntime(runtime, { kind: "event_consumer_failure" });
      return;
    }
    if (result.kind !== "accepted") {
      const ambiguous = result.kind === "ambiguous" || result.kind === "connection_failure";
      const failure = classifyApplicationRunProviderMutationFailure(
        result,
        this.#providerMutationInterruption(runtime),
      );
      await this.#terminalize(
        context,
        ambiguous ? "binding_creation_ambiguous" : "binding_creation_not_sent",
        failure.outcomeKind,
        failure.failureOrigin,
        ambiguous ? "Provider conversation creation outcome is unknown." : "Provider conversation was not created.",
        failure.providerErrorCode,
      );
      if (ambiguous) await this.#retireRuntime(runtime, { kind: "event_consumer_failure" });
      return;
    }
    const resolution: ProviderBindingResolutionCommand = {
      sessionId: context.session.id,
      workspaceKey: context.session.workspaceKey,
      runId: context.admission.runId,
      attemptId: context.admission.attemptId,
      bindingId: context.admission.bindingId,
      resolution: {
        kind: "active",
        externalConversationId: result.value.threadId,
        ephemeralOwnerToken: null,
      },
    };
    this.#pendingBindingResolutions.set(context.admission.runId, { context, command: resolution });
    if (!(await this.#confirmBindingResolution(context, resolution))) return;
    this.#pendingBindingResolutions.delete(context.admission.runId);
    if (runtime.failed || this.#runtime !== runtime || this.#closing) {
      await this.#terminalize(
        context,
        "dispatch_not_sent",
        "interrupted",
        "transport",
        "Provider connection ended before execution.",
      );
      return;
    }
    const binding = this.#registerBinding(context, runtime, result.value.threadId);
    if (binding === undefined) {
      await this.#terminalize(
        context,
        "dispatch_not_sent",
        "failed",
        "application",
        "Provider binding ownership capacity was reached.",
      );
      return;
    }
    await this.#publishReady(context, binding);
  }

  async #reuseBinding(context: RuntimeExecutionContext, runtime: RuntimeState): Promise<void> {
    const threadId = context.recovery.externalConversationId;
    if (threadId === null) return;
    const current = this.#bindings.get(context.admission.bindingId);
    if (current !== undefined) {
      if (
        current.sessionId !== context.session.id ||
        current.providerId !== context.session.providerId ||
        current.threadId !== threadId ||
        current.generationId !== runtime.generationId
      ) {
        await this.#terminalize(
          context,
          "dispatch_not_sent",
          "interrupted",
          "application",
          "Provider binding owner tuple conflicted.",
        );
        return;
      }
      await this.#publishReady(context, current);
      return;
    }

    const settings = providerSettings(context.snapshot);
    let result: CodexAdapterMutationResult<CodexAdapterThreadSnapshot>;
    try {
      result = await runtime.runtime.adapter.resumeThread(
        {
          threadId,
          model: settings.model,
          modelSelection: context.snapshot.modelSelection,
          reasoningEffort: settings.reasoningEffort,
          workspacePath: settings.workspacePath,
          approvalPolicy: "never",
          sandboxMode: settings.sandboxMode,
        },
        { signal: this.#lifecycleAbort.signal },
      );
    } catch {
      await this.#terminalize(
        context,
        "dispatch_not_sent",
        "interrupted",
        "transport",
        "Persistent Provider conversation could not be resumed.",
      );
      await this.#retireRuntime(runtime, { kind: "event_consumer_failure" });
      return;
    }
    if (result.kind !== "accepted") {
      const ambiguous = result.kind === "ambiguous" || result.kind === "connection_failure";
      const failure = classifyApplicationRunProviderMutationFailure(
        result,
        this.#providerMutationInterruption(runtime),
      );
      await this.#terminalize(
        context,
        "dispatch_not_sent",
        failure.outcomeKind,
        failure.failureOrigin,
        "Persistent Provider conversation could not be resumed.",
        failure.providerErrorCode,
      );
      if (ambiguous) await this.#retireRuntime(runtime, { kind: "event_consumer_failure" });
      return;
    }
    if (result.value.threadId !== threadId) {
      await this.#terminalize(
        context,
        "dispatch_not_sent",
        "interrupted",
        "unknown",
        "Persistent Provider conversation could not be resumed.",
      );
      await this.#retireRuntime(runtime, { kind: "event_consumer_failure" });
      return;
    }
    if (runtime.failed || this.#runtime !== runtime || this.#closing) {
      await this.#terminalize(
        context,
        "dispatch_not_sent",
        "interrupted",
        "transport",
        "Provider connection ended before execution.",
      );
      return;
    }
    const binding = this.#registerBinding(context, runtime, threadId);
    if (binding === undefined) {
      await this.#terminalize(
        context,
        "dispatch_not_sent",
        "failed",
        "application",
        "Provider binding ownership capacity was reached.",
      );
      return;
    }
    await this.#publishReady(context, binding);
  }

  #providerMutationInterruption(runtime: RuntimeState): ApplicationRunProviderMutationInterruption {
    if (this.#closing || this.#lifecycleAbort.signal.aborted) return "shutdown";
    if (runtime.failed || this.#runtime !== runtime) return "transport";
    return null;
  }

  async #publishReady(context: RuntimeExecutionContext, binding: BindingOwner): Promise<void> {
    const runtime = this.#runtime;
    if (runtime === undefined || runtime.failed || this.#closing || runtime.generationId !== binding.generationId) {
      await this.#terminalize(
        context,
        "dispatch_not_sent",
        "interrupted",
        "transport",
        "Provider connection ended before execution.",
      );
      return;
    }
    try {
      const prepared =
        binding.persistenceMode === "persistent"
          ? Object.freeze({
              admission: context.admission,
              workspaceKey: context.session.workspaceKey,
              providerId: context.session.providerId,
              threadId: binding.threadId,
              generationId: binding.generationId,
              persistenceMode: "persistent" as const,
              ephemeralOwnerToken: null,
              executionSnapshot: context.snapshot,
              contentBlocks: context.contentBlocks,
            })
          : Object.freeze({
              admission: context.admission,
              workspaceKey: context.session.workspaceKey,
              providerId: context.session.providerId,
              threadId: binding.threadId,
              generationId: binding.generationId,
              persistenceMode: "ephemeral" as const,
              ephemeralOwnerToken: binding.ephemeralOwnerToken,
              executionSnapshot: context.snapshot,
              contentBlocks: context.contentBlocks,
            });
      await this.#dispatchReady.ready(
        prepared,
        Object.freeze({
          adapter: runtime.runtime.adapter,
          signal: this.#lifecycleAbort.signal,
          isCurrent: () =>
            !this.#closing &&
            !runtime.failed &&
            this.#runtime === runtime &&
            this.#bindings.get(binding.bindingId) === binding,
          terminalize: (failure) =>
            this.#terminalize(
              context,
              failure.preDispatchResolution,
              failure.outcomeKind,
              failure.failureOrigin,
              failure.errorSummary,
              failure.providerErrorCode,
            ),
        }),
      );
    } catch {
      // Dispatch owns failure classification after its durable begin Gate.
    }
  }

  #registerBinding(
    context: RuntimeExecutionContext,
    runtime: RuntimeState,
    threadId: string,
  ): BindingOwner | undefined {
    const existing = this.#bindings.get(context.admission.bindingId);
    if (existing !== undefined) return existing;
    if (this.#bindings.size >= this.#maxTrackedBindings) return undefined;
    const binding = Object.freeze({
      sessionId: context.session.id,
      providerId: context.session.providerId,
      bindingId: context.admission.bindingId,
      threadId,
      generationId: runtime.generationId,
      persistenceMode: "persistent",
      ephemeralOwnerToken: null,
    });
    this.#bindings.set(binding.bindingId, binding);
    return binding;
  }

  async #getRuntime(providerId: string): Promise<RuntimeState> {
    if (this.#closing) throw new Error("Application Run runtime is closing.");
    if (!this.#runtimeFactory.supports(providerId)) {
      throw new ApplicationRunProviderRuntimeStartupError("capability", "Provider runtime is unsupported.");
    }
    if (this.#runtime !== undefined && !this.#runtime.failed) {
      if (this.#runtime.providerId !== providerId) {
        throw new ApplicationRunProviderRuntimeStartupError("application", "Provider runtime owner conflicted.");
      }
      return this.#runtime;
    }
    if (this.#runtimeStart !== undefined) return this.#runtimeStart;
    const generationId = `${providerId}-${this.#nextGeneration}`;
    this.#nextGeneration += 1;
    const starting = this.#startRuntime(providerId, generationId);
    this.#runtimeStart = starting;
    try {
      return await starting;
    } finally {
      if (this.#runtimeStart === starting) this.#runtimeStart = undefined;
    }
  }

  async #startRuntime(providerId: string, generationId: string): Promise<RuntimeState> {
    const previous = this.#runtime;
    if (previous !== undefined) {
      await this.#retireRuntime(previous, { kind: "event_consumer_failure" });
    }
    const runtime = await this.#runtimeFactory.start(providerId, generationId, this.#lifecycleAbort.signal);
    if (runtime.providerId !== providerId || runtime.generationId !== generationId) {
      const invalidOwner: RuntimeState = {
        providerId: runtime.providerId,
        generationId: runtime.generationId,
        runtime,
        failed: true,
        generationReleased: true,
        retireReason: null,
        eventDrain: null,
      };
      this.#runtime = invalidOwner;
      await this.#closeRuntime(invalidOwner);
      if (this.#runtime === invalidOwner) this.#runtime = undefined;
      throw new ApplicationRunProviderRuntimeStartupError("application", "Provider runtime owner is invalid.");
    }
    const state: RuntimeState = {
      providerId,
      generationId,
      runtime,
      failed: false,
      generationReleased: false,
      retireReason: null,
      eventDrain: null,
    };
    this.#runtime = state;
    const drain = startEventDrain(runtime.adapter, (event) => this.#acceptProviderEvent(state, event));
    state.eventDrain = drain;
    void drain.drain().catch(() => {
      void this.#handleEventConsumerFailure(state).catch(() => undefined);
    });
    try {
      await drain.ready;
    } catch (error) {
      await this.#handleEventConsumerFailure(state);
      throw new ApplicationRunProviderRuntimeStartupError(
        "transport",
        "Provider event consumer failed during startup.",
        { cause: error },
      );
    }
    if (this.#closing) {
      throw new ApplicationRunProviderRuntimeStartupError("process", "Application Run runtime is closing.");
    }
    if (state.failed) {
      throw new ApplicationRunProviderRuntimeStartupError(
        "transport",
        "Provider event consumer failed during startup.",
      );
    }
    return state;
  }

  async #acceptProviderEvent(runtime: RuntimeState, event: CodexAdapterEvent): Promise<void> {
    if (this.#runtime !== runtime || runtime.generationReleased) return;
    await this.#events.accept(runtime.generationId, event);
    if (event.kind === "connection_failure") {
      if (this.#retiringRuntimes.has(runtime)) return;
      void this.#retireRuntime(runtime, {
        kind: "connection_failure",
        code: event.code,
      }).catch(() => undefined);
    }
  }

  async #handleEventConsumerFailure(runtime: RuntimeState): Promise<void> {
    if (this.#runtime !== runtime || this.#closing) return;
    await this.#retireRuntime(runtime, { kind: "event_consumer_failure" });
  }

  async #retireRuntime(
    runtime: RuntimeState,
    reason: Parameters<ApplicationRunProviderEventPort["releaseGeneration"]>[1],
  ): Promise<void> {
    const existing = this.#retiringRuntimes.get(runtime);
    if (existing !== undefined) return existing;
    runtime.retireReason ??= reason;
    const retireReason = runtime.retireReason;
    const retiring = (async () => {
      if (this.#runtime !== runtime) return;
      runtime.failed = true;
      runtime.eventDrain?.beginClose();
      await this.#closeRuntime(runtime);
      try {
        await runtime.eventDrain?.drain();
      } catch (error) {
        if (this.#closing) {
          this.#throwPersistenceClosure("Run event persistence outcome is still unknown during shutdown.", error);
        }
        throw error;
      }
      if (!runtime.generationReleased) {
        try {
          await this.#events.releaseGeneration(runtime.generationId, retireReason);
        } catch (error) {
          if (this.#closing) {
            this.#throwPersistenceClosure("Run event persistence outcome is still unknown during shutdown.", error);
          }
          throw error;
        }
        runtime.generationReleased = true;
      }
      for (const [bindingId, owner] of this.#bindings) {
        if (owner.generationId === runtime.generationId) this.#bindings.delete(bindingId);
      }
    })().finally(() => {
      if (this.#retiringRuntimes.get(runtime) === retiring) this.#retiringRuntimes.delete(runtime);
    });
    this.#retiringRuntimes.set(runtime, retiring);
    return retiring;
  }

  async #closeRuntime(runtime: RuntimeState): Promise<void> {
    if (this.#closedRuntimes.has(runtime)) return;
    const existing = this.#closingRuntimes.get(runtime);
    if (existing !== undefined) return existing;
    const closing = (async () => {
      await runtime.runtime.adapter.close();
      this.#closedRuntimes.add(runtime);
    })().finally(() => {
      if (this.#closingRuntimes.get(runtime) === closing) this.#closingRuntimes.delete(runtime);
    });
    this.#closingRuntimes.set(runtime, closing);
    return closing;
  }

  async #readContext(admission: ApplicationRunAdmissionRecord): Promise<RuntimeExecutionContext> {
    const sessionProjection = await this.#reads.sessionGet({ sessionId: admission.sessionId });
    const session = sessionProjection.session;
    if (session.id !== admission.sessionId) throw new TypeError("Runtime Session scope is invalid.");
    const [recovery, runProjection] = await Promise.all([
      this.#reads.recoveryGet({
        sessionId: admission.sessionId,
        runId: admission.runId,
        workspaceKey: session.workspaceKey,
      }),
      this.#reads.runGet({
        sessionId: admission.sessionId,
        runId: admission.runId,
        workspaceKey: session.workspaceKey,
      }),
    ]);
    if (
      recovery.sessionId !== session.id ||
      recovery.runId !== admission.runId ||
      recovery.workspaceKey !== session.workspaceKey ||
      runProjection.sessionId !== session.id ||
      runProjection.workspaceKey !== session.workspaceKey ||
      runProjection.run.id !== admission.runId ||
      runProjection.run.sessionId !== session.id
    ) {
      throw new TypeError("Runtime Run scope is invalid.");
    }
    const run = runProjection.run;
    const snapshotValue =
      run.executionSnapshotState === "inline"
        ? run.executionSnapshot
        : await readJsonChunks(
            (offset, maxBytes) =>
              this.#reads.runSnapshotChunk({
                sessionId: session.id,
                runId: run.id,
                workspaceKey: session.workspaceKey,
                offset,
                maxBytes,
              }),
            { sessionId: session.id, runId: run.id },
            APPLICATION_RUN_RUNTIME_LIMITS.maxSnapshotBytes,
            run.executionSnapshotByteLength,
          );
    const snapshot = decodeApplicationRunExecutionSnapshot(snapshotValue);
    const directories = await readSessionDirectories(this.#reads, session);
    const contentValue = await readJsonChunks(
      (offset, maxBytes) =>
        this.#reads.messageContentChunk({
          sessionId: session.id,
          messageId: run.initiatingMessageId,
          workspaceKey: session.workspaceKey,
          offset,
          maxBytes,
        }),
      { sessionId: session.id, messageId: run.initiatingMessageId },
      MESSAGE_CONTENT_LIMITS.maxJsonBytes,
    );
    const contentBlocks = snapshotMessageContentBlocks(contentValue);
    if (
      contentBlocks === undefined ||
      admission.messageId !== run.initiatingMessageId ||
      snapshot.providerId !== session.providerId ||
      !isRuntimeWorkspace(snapshot.workspace, session, directories)
    ) {
      throw new TypeError("Runtime execution snapshot is invalid.");
    }
    return Object.freeze({ admission, session, recovery, run, snapshot, contentBlocks });
  }

  async #readContextUntilAvailable(
    admission: ApplicationRunAdmissionRecord,
  ): Promise<RuntimeExecutionContext | undefined> {
    while (!this.#closing) {
      try {
        return await this.#readContext(admission);
      } catch {
        if (!(await waitForRetry(this.#lifecycleAbort.signal))) return undefined;
      }
    }
    return undefined;
  }

  async #confirmBindingResolution(
    context: RuntimeExecutionContext,
    command: ProviderBindingResolutionCommand,
  ): Promise<boolean> {
    while (!this.#closing) {
      if (await this.#confirmBindingResolutionOnce(context, command)) return true;
      if (!(await waitForRetry(this.#lifecycleAbort.signal))) return false;
    }
    return false;
  }

  async #confirmBindingResolutionOnce(
    context: RuntimeExecutionContext,
    command: ProviderBindingResolutionCommand,
  ): Promise<boolean> {
    const result = await this.#writeBindingResolution(command);
    if (
      result?.ok &&
      result.value.sessionId === command.sessionId &&
      result.value.runId === command.runId &&
      result.value.attemptId === command.attemptId &&
      result.value.bindingId === command.bindingId &&
      result.value.bindingState === "active" &&
      result.value.externalConversationId === command.resolution.externalConversationId
    ) {
      return true;
    }
    try {
      const recovery = await this.#reads.recoveryGet({
        sessionId: command.sessionId,
        workspaceKey: command.workspaceKey,
        runId: command.runId,
      });
      return (
        recovery.sessionId === context.session.id &&
        recovery.workspaceKey === context.session.workspaceKey &&
        recovery.runId === context.admission.runId &&
        recovery.attemptId === context.admission.attemptId &&
        recovery.bindingId === context.admission.bindingId &&
        recovery.bindingState === "active" &&
        recovery.externalConversationId === command.resolution.externalConversationId
      );
    } catch {
      return false;
    }
  }

  async #drainPendingRuntimeOwners(): Promise<void> {
    await Promise.all([
      ...[...this.#pendingContextReads].map(async ([runId, admission]) => {
        let context: RuntimeExecutionContext;
        try {
          context = await this.#readContext(admission);
        } catch {
          return;
        }
        if (this.#pendingContextReads.get(runId) !== admission) return;
        this.#pendingContextReads.delete(runId);
        if (!isSafeRuntimeCandidate(context)) return;
        await this.#terminalize(
          context,
          context.recovery.bindingState === "creating" ? "binding_creation_not_sent" : "dispatch_not_sent",
          "interrupted",
          "application",
          "Application shutdown completed before Provider execution started.",
        );
      }),
      ...[...this.#pendingBindingResolutions].map(async ([runId, pending]) => {
        if (!(await this.#confirmBindingResolutionOnce(pending.context, pending.command))) return;
        if (this.#pendingBindingResolutions.get(runId) !== pending) return;
        this.#pendingBindingResolutions.delete(runId);
        await this.#terminalize(
          pending.context,
          "dispatch_not_sent",
          "interrupted",
          "application",
          "Application shutdown completed after Provider conversation creation.",
        );
      }),
    ]);
  }

  async #writeBindingResolution(
    command: ProviderBindingResolutionCommand,
  ): Promise<RepositoryCommandResult<ProviderBindingResolutionResult> | undefined> {
    try {
      return await this.#writes.resolveProviderBinding(command);
    } catch (error) {
      if (!(error instanceof PersistenceClientError) || error.persistenceError.effect !== "unknown") return undefined;
      try {
        return await this.#writes.resolveProviderBinding(command);
      } catch {
        return undefined;
      }
    }
  }

  async #terminalize(
    context: RuntimeExecutionContext,
    preDispatchResolution: RunTerminalCommand["preDispatchResolution"]["kind"],
    outcomeKind: "failed" | "interrupted",
    failureOrigin: "provider" | "transport" | "process" | "application" | "unknown",
    errorSummary: string,
    providerErrorCode: string | null = null,
  ): Promise<boolean> {
    const identity = terminalIdentity(context.admission.runId);
    const command =
      this.#pendingTerminals.get(context.admission.runId) ??
      ({
        sessionId: context.session.id,
        workspaceKey: context.session.workspaceKey,
        runId: context.admission.runId,
        attemptId: context.admission.attemptId,
        terminalEvent: identity,
        providerExecution: null,
        preDispatchResolution: { kind: preDispatchResolution },
        outcome: {
          kind: outcomeKind,
          failureOrigin,
          providerErrorCode,
          errorSummary,
        },
        outputs: [],
        childResult: null,
      } satisfies RunTerminalCommand);
    const confirmed = await this.#confirmRunTerminal(command);
    if (confirmed) {
      this.#pendingTerminals.delete(command.runId);
      return true;
    }
    this.#pendingTerminals.set(command.runId, command);
    this.#schedulePendingTerminalRetry(command);
    return false;
  }

  async #retryPendingTerminal(command: RunTerminalCommand): Promise<void> {
    if (!(await this.#confirmRunTerminal(command))) return;
    if (this.#pendingTerminals.get(command.runId) === command) this.#pendingTerminals.delete(command.runId);
  }

  #schedulePendingTerminalRetry(command: RunTerminalCommand): void {
    if (this.#closing || this.#terminalRetryTasks.has(command.runId)) return;
    const task = (async () => {
      while (!this.#closing && this.#pendingTerminals.get(command.runId) === command) {
        if (!(await waitForRetry(this.#lifecycleAbort.signal))) return;
        if (this.#closing || this.#pendingTerminals.get(command.runId) !== command) return;
        await this.#retryPendingTerminal(command);
      }
    })().finally(() => {
      if (this.#terminalRetryTasks.get(command.runId) === task) this.#terminalRetryTasks.delete(command.runId);
    });
    this.#terminalRetryTasks.set(command.runId, task);
    void task.catch(() => undefined);
  }

  async #confirmRunTerminal(command: RunTerminalCommand): Promise<boolean> {
    const result = await this.#writeRunTerminal(command);
    if (
      result?.ok &&
      result.value.sessionId === command.sessionId &&
      result.value.runId === command.runId &&
      result.value.attemptId === command.attemptId &&
      result.value.phase === command.outcome.kind &&
      result.value.terminalEventId === command.terminalEvent.id
    ) {
      return true;
    }
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

  #ownedRunCount(): number {
    const runIds = new Set(this.#work.keys());
    for (const runId of this.#pendingContextReads.keys()) runIds.add(runId);
    for (const runId of this.#pendingBindingResolutions.keys()) runIds.add(runId);
    for (const runId of this.#pendingTerminals.keys()) runIds.add(runId);
    for (const runId of this.#dispatchReady.pendingRunIds?.() ?? []) runIds.add(runId);
    return runIds.size;
  }

  async #writeRunTerminal(
    command: RunTerminalCommand,
  ): Promise<RepositoryCommandResult<RunTerminalResult> | undefined> {
    try {
      return await this.#writes.completeRun(command);
    } catch (error) {
      if (!(error instanceof PersistenceClientError) || error.persistenceError.effect !== "unknown") return undefined;
      try {
        return await this.#writes.completeRun(command);
      } catch {
        return undefined;
      }
    }
  }
}

export function createApplicationRunRuntimeService(
  worker: PersistenceWorkerClient,
  runtimeFactory: ApplicationRunProviderRuntimeFactory,
  options: Omit<ApplicationRunRuntimeServiceOptions, "reads" | "writes" | "runtimeFactory">,
): ApplicationRunRuntimeService {
  const reads = new RepositoryReadClient(worker);
  const writes = new RepositoryWriteClient(worker);
  return new ApplicationRunRuntimeService({
    reads,
    writes,
    runtimeFactory,
    persistenceRetryable: () => worker.state === "ready",
    ...options,
  });
}

function isSafeRuntimeCandidate(context: RuntimeExecutionContext): boolean {
  const { admission, recovery, session, run } = context;
  return (
    session.lifecycleStatus === "active" &&
    (run.phase === "queued" || run.phase === "starting") &&
    recovery.runPhase === run.phase &&
    recovery.attemptId === admission.attemptId &&
    recovery.bindingId === admission.bindingId &&
    recovery.providerId === session.providerId &&
    recovery.persistenceMode === "persistent" &&
    (recovery.bindingState === "creating" || recovery.bindingState === "active") &&
    recovery.dispatchState === "pending" &&
    (recovery.bindingState !== "active" || recovery.externalConversationId !== null)
  );
}

function providerSettings(snapshot: RunExecutionSnapshot): Readonly<{
  model: string;
  reasoningEffort: string;
  workspacePath: string;
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
}> {
  const sandbox = snapshot.sandbox as Readonly<Record<string, unknown>>;
  const reasoning = snapshot.reasoning as Readonly<Record<string, unknown>>;
  const workspace = snapshot.workspace as Readonly<Record<string, unknown>>;
  if (
    typeof snapshot.model !== "string" ||
    typeof reasoning.effort !== "string" ||
    (sandbox.mode !== "read-only" && sandbox.mode !== "workspace-write" && sandbox.mode !== "danger-full-access") ||
    typeof workspace.path !== "string"
  ) {
    throw new TypeError("Provider execution settings are invalid.");
  }
  return {
    model: snapshot.model,
    reasoningEffort: reasoning.effort,
    workspacePath: workspace.path,
    sandboxMode: sandbox.mode,
  };
}

function snapshotAdmissionRecord(value: ApplicationRunAdmissionRecord): ApplicationRunAdmissionRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.sessionId !== "string" ||
    typeof value.messageId !== "string" ||
    typeof value.runId !== "string" ||
    typeof value.attemptId !== "string" ||
    typeof value.bindingId !== "string" ||
    (value.runPhase !== "queued" && value.runPhase !== "starting") ||
    (value.bindingState !== "creating" && value.bindingState !== "active") ||
    value.dispatchState !== "pending"
  ) {
    throw new TypeError("Application Run handoff is invalid.");
  }
  return Object.freeze({
    sessionId: value.sessionId,
    messageId: value.messageId,
    runId: value.runId,
    ...(value.retryOfRunId === undefined ? {} : { retryOfRunId: value.retryOfRunId }),
    attemptId: value.attemptId,
    bindingId: value.bindingId,
    runPhase: value.runPhase,
    bindingState: value.bindingState,
    dispatchState: value.dispatchState,
    admittedAt: value.admittedAt,
  });
}

async function readSessionDirectories(
  reads: ApplicationRunRuntimeReadPort,
  session: SessionDetail,
): Promise<readonly string[]> {
  const value =
    session.allowedAdditionalDirectoriesState === "inline"
      ? session.allowedAdditionalDirectories
      : await readJsonChunks(
          (offset, maxBytes) =>
            reads.sessionDirectoriesChunk({
              sessionId: session.id,
              offset,
              maxBytes,
            }),
          { sessionId: session.id },
          ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxJsonBytes,
          session.allowedAdditionalDirectoriesByteLength,
        );
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError("Session directories are invalid.");
  }
  return Object.freeze([...value]);
}

function isRuntimeWorkspace(value: unknown, session: SessionDetail, directories: readonly string[]): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const workspace = value as Readonly<Record<string, unknown>>;
  return (
    workspace.key === session.workspaceKey &&
    workspace.path === session.workspacePath &&
    Array.isArray(workspace.allowedAdditionalDirectories) &&
    workspace.allowedAdditionalDirectories.length === directories.length &&
    workspace.allowedAdditionalDirectories.every((directory, index) => directory === directories[index])
  );
}

async function readJsonChunks(
  read: (offset: number, maxBytes: number) => Promise<unknown>,
  expectedScope: Readonly<Record<string, string>>,
  maxTotalBytes: number,
  expectedTotalBytes?: number,
): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let totalBytes: number | undefined;
  do {
    const value = (await read(
      offset,
      Math.min(APPLICATION_RUN_RUNTIME_LIMITS.chunkBytes, maxTotalBytes - offset),
    )) as Readonly<Record<string, unknown>>;
    for (const [key, expected] of Object.entries(expectedScope)) {
      if (value[key] !== expected) throw new TypeError("Repository chunk scope is invalid.");
    }
    if (
      !Number.isSafeInteger(value.offset) ||
      !Number.isSafeInteger(value.totalBytes) ||
      (value.offset as number) !== offset ||
      (value.totalBytes as number) < 0 ||
      (value.totalBytes as number) > maxTotalBytes ||
      (expectedTotalBytes !== undefined && value.totalBytes !== expectedTotalBytes) ||
      typeof value.eof !== "boolean"
    ) {
      throw new TypeError("Repository chunk metadata is invalid.");
    }
    if (totalBytes !== undefined && totalBytes !== value.totalBytes) {
      throw new TypeError("Repository chunk total changed.");
    }
    totalBytes = value.totalBytes as number;
    const bytes = toBytes(value.bytes);
    if (
      (bytes.byteLength === 0 && offset < totalBytes) ||
      offset + bytes.byteLength > totalBytes ||
      value.eof !== (offset + bytes.byteLength === totalBytes)
    ) {
      throw new TypeError("Repository chunk boundary is invalid.");
    }
    chunks.push(bytes);
    offset += bytes.byteLength;
  } while (totalBytes === undefined || offset < totalBytes);
  if (totalBytes === undefined || offset !== totalBytes) throw new TypeError("Repository chunk stream is incomplete.");
  const combined = new Uint8Array(totalBytes);
  let writeOffset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined)) as unknown;
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("Repository chunk bytes are invalid.");
}

function terminalIdentity(runId: string): Readonly<{ id: string; dedupeKey: string }> {
  const digest = createHash("sha256").update(`run-runtime-terminal\0${runId}`).digest("hex");
  return Object.freeze({
    id: `run_event_${digest}`,
    dedupeKey: `run-runtime-terminal:${digest}`,
  });
}

function waitForRetry(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(ready);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(true), APPLICATION_RUN_RUNTIME_LIMITS.persistenceRetryDelayMs);
    timer.unref();
    signal.addEventListener("abort", abort, { once: true });
  });
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Application Run runtime limit is invalid.");
  return value;
}

function startEventDrain(
  adapter: ApplicationRunProviderAdapterPort,
  accept: (event: CodexAdapterEvent) => void | Promise<void>,
): Readonly<{ ready: Promise<void>; beginClose(): void; drain(): Promise<void> }> {
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let announced = false;
  let closeStarted = false;
  let pendingEvent: CodexAdapterEvent | undefined;
  let activeDrain: Promise<void> | undefined;
  const announce = () => {
    if (announced) return;
    announced = true;
    resolveReady();
  };
  const drain = (): Promise<void> => {
    if (activeDrain !== undefined) return activeDrain;
    let attempt!: Promise<void>;
    attempt = (async () => {
      for (;;) {
        if (pendingEvent === undefined) {
          let next: Promise<CodexAdapterEvent>;
          try {
            next = adapter.nextEvent();
            announce();
          } catch (error) {
            if (!announced) {
              announced = true;
              rejectReady(error);
            }
            if (closeStarted) return;
            throw error;
          }
          try {
            pendingEvent = await next;
          } catch (error) {
            // CodexAdapter returns every queued event before its closed rejection.
            if (closeStarted) return;
            throw error;
          }
        }
        // Ownership moves out of the drain only after Event Service accepts this exact event.
        await accept(pendingEvent);
        pendingEvent = undefined;
      }
    })().finally(() => {
      if (activeDrain === attempt) activeDrain = undefined;
    });
    activeDrain = attempt;
    return attempt;
  };
  return Object.freeze({
    ready,
    beginClose() {
      closeStarted = true;
    },
    drain,
  });
}
