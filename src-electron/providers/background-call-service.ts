import { randomUUID } from "node:crypto";
import type { Session } from "../../src-shared/session/session-state.js";
import type { BackgroundExecutionSelection } from "../../src-shared/settings/background-settings.js";
import { classifyBackgroundFailure, type BackgroundFailure, type BackgroundFailureInput } from "./background-failure.js";
import type { BackgroundExecutionScope, BackgroundPurpose } from "../../src-shared/agent-runtime/background-execution-scope.js";
import type { BackgroundSourceRef } from "../../src-shared/session/background-source-snapshot.js";
import { runWithRuntimeTurnAdmission } from "../platform/memory/runtime-turn-admission.js";
import type { ProviderAgentRuntimeBindingProjection } from "./agent-runtime-binding.js";
import type { ProviderAgentRuntimeTurnHandle } from "./provider-agent-runtime-turn-coordinator.js";
import type { BackgroundExecution, BackgroundExecutionService } from "./background-execution-service.js";

export type BackgroundCallContext = Omit<
  Parameters<BackgroundExecutionService["begin"]>[0], "providerId" | "session"
> & { session: Session };

export type BackgroundSelection = Readonly<BackgroundExecutionSelection>;

export type BackgroundAgentInput = Readonly<{
  session: Session;
  scope: BackgroundExecutionScope;
  selection: BackgroundSelection;
  userInput: string;
  binding: ProviderAgentRuntimeBindingProjection;
  handle: ProviderAgentRuntimeTurnHandle;
  signal: AbortSignal;
  continuation: Readonly<{ id: string; threadId: string | null; onThreadId: (threadId: string | null) => void }>;
}>;

/** The Agent reads and registers through its bound tools within this invocation. */
export type BackgroundAgentPort = (input: BackgroundAgentInput) => void | Promise<void>;

export type BackgroundCallInput = Readonly<{
  context: BackgroundCallContext;
  selection: BackgroundSelection;
  userInput: string;
  onAdmitted: () => void;
}>;

export type BackgroundCallResult =
  | { kind: "failed" | "canceled"; code: string }
  | { kind: "completed" };

type Continuation = {
  id: string;
  source: BackgroundSourceRef;
  purpose: BackgroundPurpose;
  providerId?: string;
  ownerIdentity?: string;
  characterId?: string;
  threadId: string | null;
  previousFailure?: BackgroundFailure & { providerId?: string; modelId?: string };
  abort: AbortController;
  running?: Promise<BackgroundCallResult>;
  preceding?: Promise<void>;
  activeBindingId?: string;
};

function continuationKey(source: BackgroundSourceRef, purpose: BackgroundPurpose): string {
  return JSON.stringify([source.kind, source.sessionId, source.incarnationId,
    ...(source.kind === "auxiliary" ? [source.parent.sessionId, source.parent.incarnationId] : []), purpose]);
}

const canceled = (): BackgroundCallResult => ({ kind: "canceled", code: "BACKGROUND_CALL_CANCELED" });

/** Native context lives only here; invocation authority remains in BackgroundExecutionService. */
export class BackgroundCallService {
  readonly #continuations = new Map<string, Continuation>();
  readonly #providers = new Map<BackgroundPurpose, string | undefined>();
  constructor(private readonly deps: {
    executions: BackgroundExecutionService;
    runAgent: BackgroundAgentPort;
    onFailure?: (input: BackgroundFailureInput) => void;
  }) {}

  setProvider(purpose: BackgroundPurpose, providerId: string | undefined): void {
    if (this.#providers.has(purpose) && this.#providers.get(purpose) === providerId) return;
    this.#providers.set(purpose, providerId);
    for (const [key, state] of this.#continuations) {
      if (state.purpose !== purpose || state.providerId === providerId) continue;
      state.abort.abort();
      this.#continuations.set(key, { id: randomUUID(), source: state.source, purpose, providerId,
        ownerIdentity: state.ownerIdentity, characterId: state.characterId, threadId: null,
        previousFailure: state.previousFailure, abort: new AbortController(),
        preceding: state.running?.then(() => undefined, () => undefined) ?? state.preceding });
    }
  }

  forgetSource(kind: BackgroundSourceRef["kind"], sessionId: string): void {
    for (const [key, state] of this.#continuations) {
      if ((state.source.kind === kind && state.source.sessionId === sessionId)
        || (kind === "main" && state.source.kind === "auxiliary" && state.source.parent.sessionId === sessionId)) {
        state.abort.abort();
        this.#continuations.delete(key);
      }
    }
  }

  stop(): void {
    for (const state of this.#continuations.values()) state.abort.abort();
    this.#continuations.clear();
    this.#providers.clear();
  }

  captureFailureRecorder(input: Pick<BackgroundFailureInput, "source" | "purpose">): (failure: BackgroundFailureInput) => void {
    const key = continuationKey(input.source, input.purpose);
    const state: Continuation = this.#continuations.get(key) ?? { id: randomUUID(), source: input.source,
      purpose: input.purpose, threadId: null, abort: new AbortController() };
    this.#continuations.set(key, state);
    return (failure) => {
      if (this.#continuations.get(key) !== state || state.abort.signal.aborted) return;
      if (failure.selection && state.providerId !== undefined && state.providerId !== failure.selection.providerId) return;
      state.providerId ??= failure.selection?.providerId;
      state.previousFailure = { ...classifyBackgroundFailure(failure.error, failure.stage, "BACKGROUND_PREPARE_FAILED"),
        ...(failure.selection ? { providerId: failure.selection.providerId, modelId: failure.selection.modelId } : {}) };
    };
  }

  async runOnce(input: BackgroundCallInput): Promise<BackgroundCallResult> {
    const source = input.context.scope.history.source;
    const purpose = input.context.scope.purpose;
    if (this.#providers.has(purpose) && this.#providers.get(purpose) !== input.selection.providerId) return canceled();
    const key = continuationKey(source, purpose);
    let state = this.#continuations.get(key);
    if (state && ((state.providerId !== undefined && state.providerId !== input.selection.providerId)
      || (state.ownerIdentity !== undefined && state.ownerIdentity !== source.ownerIdentity)
      || (state.characterId !== undefined && state.characterId !== input.context.session.characterId))) {
      state.abort.abort();
      const preceding = state.running?.then(() => undefined, () => undefined) ?? state.preceding;
      state = { id: randomUUID(), source, purpose, providerId: input.selection.providerId, threadId: null,
        abort: new AbortController(), preceding };
    }
    state ??= { id: randomUUID(), source, purpose, providerId: input.selection.providerId, threadId: null, abort: new AbortController() };
    state.providerId = input.selection.providerId;
    state.ownerIdentity = source.ownerIdentity;
    state.characterId = input.context.session.characterId;
    this.#continuations.set(key, state);
    if (state.preceding) {
      await state.preceding;
      state.preceding = undefined;
    }
    while (state.running) await state.running;
    if (this.#continuations.get(key) !== state || state.abort.signal.aborted) return canceled();
    const pending = this.runInvocation(input, key, state);
    state.running = pending;
    try { return await pending; }
    finally { if (state.running === pending) state.running = undefined; }
  }

  private async runInvocation(input: BackgroundCallInput, key: string, state: Continuation): Promise<BackgroundCallResult> {
    let execution: BackgroundExecution | undefined;
    const signal = input.context.signal ? AbortSignal.any([input.context.signal, state.abort.signal]) : state.abort.signal;
    const failed = (error: unknown, stage: BackgroundFailureInput["stage"]): BackgroundCallResult => {
      const failure = classifyBackgroundFailure(error, stage, stage === "admission" ? "BACKGROUND_ADMISSION_CALLBACK_FAILED" : stage === "setup" ? "BACKGROUND_SETUP_FAILED" : "BACKGROUND_AGENT_FAILED");
      if (this.#continuations.get(key) === state && !state.abort.signal.aborted) {
        state.previousFailure = { ...failure, providerId: input.selection.providerId, modelId: input.selection.modelId };
      }
      this.deps.onFailure?.({ purpose: input.context.scope.purpose, source: input.context.scope.history.source,
        selection: input.selection, stage: failure.stage, error: failure,
        ...(execution ? { execution: { executionId: execution.binding.bindingId, bindingId: execution.binding.bindingId,
          startedAt: execution.startedAt, endedAt: new Date().toISOString(), outcome: "failed",
          scope: input.context.scope, operations: [...execution.operations] } } : {}) });
      return { kind: "failed", code: failure.code };
    };
    try {
      execution = this.deps.executions.begin({ ...input.context, signal, providerId: input.selection.providerId });
      state.activeBindingId = execution.binding.bindingId;
    } catch (error) {
      if (signal.aborted && error === signal.reason) return canceled();
      return failed(error, "setup");
    }
    try {
      try {
        input.onAdmitted();
      } catch (error) {
        return failed(error, "admission");
      }

      try {
        execution.signal.throwIfAborted();
        await runWithRuntimeTurnAdmission(execution.admission, () => this.deps.runAgent({
          session: input.context.session, scope: input.context.scope, selection: input.selection,
          userInput: state.previousFailure === undefined ? input.userInput : [input.userInput,
            "# 前回の背景実行の失敗（アプリ提供の参照材料）", JSON.stringify(state.previousFailure)].join("\n\n"),
          binding: execution.binding, handle: execution.handle, signal: execution.signal,
          continuation: { id: state.id, threadId: state.threadId, onThreadId: (threadId) => {
            if (threadId && this.#continuations.get(key) === state && state.activeBindingId === execution!.binding.bindingId
              && !execution!.signal.aborted) state.threadId = threadId;
          } },
        }));
      } catch (error) {
        if (execution.failure) return failed(execution.failure, execution.failure.stage);
        return execution.signal.aborted
          ? { kind: "canceled", code: "BACKGROUND_CALL_CANCELED" }
          : failed(error, "agent");
      }
      if (execution.failure) return failed(execution.failure, execution.failure.stage);
      if (execution.signal.aborted) return { kind: "canceled", code: "BACKGROUND_CALL_CANCELED" };

      if (this.#continuations.get(key) === state) state.previousFailure = undefined;
      return { kind: "completed" };
    } finally {
      this.deps.executions.finish(execution);
      if (state.activeBindingId === execution.binding.bindingId) state.activeBindingId = undefined;
    }
  }
}
