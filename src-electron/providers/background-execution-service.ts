import type { BackgroundExecutionScope } from "../../src-shared/agent-runtime/background-execution-scope.js";
import type { BackgroundFailure } from "./background-failure.js";
import { getSessionIncarnationId, isReadOnlySession, type Session } from "../../src-shared/session/session-state.js";
import type { RuntimeTurnAdmission } from "../platform/memory/runtime-turn-admission.js";
import type { AgentRuntimeBindingRegistry, IssueAgentRuntimeBindingInput, ProviderAgentRuntimeBindingProjection } from "./agent-runtime-binding.js";
import type { ProviderAgentRuntimeTurnCoordinator, ProviderAgentRuntimeTurnHandle } from "./provider-agent-runtime-turn-coordinator.js";

export type BackgroundExecution = Readonly<{
  binding: ProviderAgentRuntimeBindingProjection;
  handle: ProviderAgentRuntimeTurnHandle;
  signal: AbortSignal;
  admission: RuntimeTurnAdmission;
  readonly failure?: BackgroundFailure;
}>;

type ActiveExecution = { execution: BackgroundExecution; abort: AbortController; failure?: BackgroundFailure; removeAbort?: () => void };

/** In-memory invocation lifetime only; it does not enqueue work or advance processing checkpoints. */
export class BackgroundExecutionService {
  readonly #active = new Map<string, ActiveExecution>();
  #accepting = false;

  constructor(private readonly deps: {
    bindings: AgentRuntimeBindingRegistry;
    turns: ProviderAgentRuntimeTurnCoordinator;
    closeConnection: (handle: ProviderAgentRuntimeTurnHandle) => void;
  }) {
    deps.bindings.subscribeChanges((change) => {
      if (change.backgroundBindingId && change.executionGeneration === null) this.cancel(change.backgroundBindingId);
    });
  }

  begin(input: IssueAgentRuntimeBindingInput & {
    session: Pick<Session, "id" | "incarnationId" | "accessMode" | "sourceSchemaVersion" | "sessionKind" | "characterId">;
    scope: BackgroundExecutionScope;
    signal?: AbortSignal;
  }): BackgroundExecution {
    if (!this.#accepting) throw new Error("Background execution runtime is unavailable.");
    input.signal?.throwIfAborted();
    const source = input.scope.history.source;
    if (isReadOnlySession(input.session) || input.session.sessionKind === "character-authoring"
      || input.session.id !== input.actorSessionId || source.sessionId !== input.session.id
      || source.incarnationId !== getSessionIncarnationId(input.session)
      || input.authoritySnapshot?.characterId !== input.session.characterId) {
      throw new Error("Background execution requires its current eligible source Session and Character.");
    }
    const binding = this.deps.bindings.issueBackground(input);
    const handle = this.deps.turns.beginBackground({ actorSessionId: input.actorSessionId,
      providerId: binding.providerId, bindingId: binding.bindingId });
    const abort = new AbortController();
    const execution: BackgroundExecution = Object.freeze({ binding: { ...binding, turnCapability: handle.capability }, handle,
      get failure() { return active.failure; },
      signal: abort.signal, admission: { state: handle.revocationState, isCurrent: () => {
        const current = this.deps.bindings.resolveIdentity(binding.bindingReference);
        return this.#active.get(binding.bindingId)?.execution === execution && current.ok
          && current.binding.bindingId === binding.bindingId && current.binding.executionGeneration === binding.executionGeneration;
      } } });
    const active: ActiveExecution = { execution, abort };
    this.#active.set(binding.bindingId, active);
    if (input.signal) {
      const cancel = () => this.cancel(binding.bindingId);
      input.signal.addEventListener("abort", cancel, { once: true });
      active.removeAbort = () => input.signal!.removeEventListener("abort", cancel);
    }
    return execution;
  }

  finish(execution: BackgroundExecution): void {
    if (this.#active.get(execution.binding.bindingId)?.execution === execution) this.cancel(execution.binding.bindingId);
  }

  reportOperationFailure(bindingId: string, failure: BackgroundFailure): void {
    const active = this.#active.get(bindingId);
    if (!active || active.failure || active.execution.signal.aborted) return;
    active.failure = failure;
  }

  cancel(bindingId: string): void {
    const active = this.#active.get(bindingId);
    if (!active) return;
    this.#active.delete(bindingId);
    active.removeAbort?.();
    this.deps.turns.end(active.execution.handle);
    this.deps.bindings.revokeBinding(bindingId);
    active.abort.abort();
    this.deps.closeConnection(active.execution.handle);
  }

  cancelAll(): void {
    for (const id of [...this.#active.keys()]) this.cancel(id);
  }

  start(): void {
    this.#accepting = true;
  }

  stop(): void {
    this.#accepting = false;
    this.cancelAll();
  }
}
