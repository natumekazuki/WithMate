import type { SessionHistoryReadScope } from "../../src-shared/session/session-history-read-scope.js";
import type { AgentRuntimeBindingRegistry, AgentRuntimeBindingResolveResult } from "./agent-runtime-binding.js";
import type { ProviderAgentRuntimeTurnCoordinator } from "./provider-agent-runtime-turn-coordinator.js";
import type { RuntimeTurnAdmission } from "../platform/memory/runtime-turn-admission.js";

export type AuthorizedSessionHistoryRead = Readonly<{
  scope: SessionHistoryReadScope;
  admission: RuntimeTurnAdmission;
}>;

export type SessionHistoryAuthorizationResult =
  | { ok: true; context: AuthorizedSessionHistoryRead }
  | Extract<AgentRuntimeBindingResolveResult, { ok: false }>;

/** Operation comes from the server's route/schema registry, never from caller identity. */
export function authorizeSessionHistoryRead(
  deps: {
    bindings: Pick<AgentRuntimeBindingRegistry, "resolve">;
    turns: Pick<ProviderAgentRuntimeTurnCoordinator, "admit">;
  },
  input: { bindingReference: string | undefined; turnCapability: string | undefined; operation: string },
): SessionHistoryAuthorizationResult {
  const resolved = deps.bindings.resolve(input.bindingReference, input.operation);
  if (!resolved.ok) return resolved;
  const binding = resolved.binding;
  if (!binding.backgroundScope) return { ok: false, code: "SESSION_BINDING_FORBIDDEN" };
  const admitted = deps.turns.admit({ actorSessionId: binding.actorSessionId, providerId: binding.providerId,
    bindingId: binding.bindingId, turnCapability: input.turnCapability });
  if (!admitted.ok || admitted.handle.bindingId !== binding.bindingId) return { ok: false, code: "SESSION_BINDING_INVALID" };
  const handle = admitted.handle;
  return { ok: true, context: {
    scope: binding.backgroundScope.history,
    admission: {
      state: handle.revocationState,
      isCurrent: () => {
        const current = deps.bindings.resolve(input.bindingReference, input.operation);
        const turn = deps.turns.admit({ actorSessionId: binding.actorSessionId, providerId: binding.providerId,
          bindingId: binding.bindingId, turnCapability: input.turnCapability });
        return current.ok && current.binding.bindingId === binding.bindingId
          && current.binding.executionGeneration === binding.executionGeneration
          && turn.ok && turn.handle === handle;
      },
    },
  } };
}
