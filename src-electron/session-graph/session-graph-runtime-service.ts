import { sessionGraphAgentRuntimeOperation, sessionGraphOperationRequestSchemas, sessionGraphRuntimeOperationByPath } from "../../src-shared/session-graph/session-graph-operation-schema.js";
import type { SessionGraphOwner } from "../../src-shared/session-graph/session-graph-contract.js";
import type { AgentRuntimeBindingResolveResult } from "../providers/agent-runtime-binding.js";
import type { ProviderAgentRuntimeTurnCoordinator } from "../providers/provider-agent-runtime-turn-coordinator.js";
import type { AgentRuntimeExtensionRequest, AgentRuntimeExtensionResponse } from "../memory/memory-v6-http-server.js";
import type { RuntimeTurnAdmission } from "../platform/memory/runtime-turn-admission.js";
import type { SessionHistoryReadScope } from "../../src-shared/session/session-history-read-scope.js";
import { SessionGraphApplicationService, sameSessionGraphOwner } from "./session-graph-application-service.js";

export class SessionGraphRuntimeService {
  constructor(readonly deps: {
    applicationService: SessionGraphApplicationService;
    bindingRegistry: { resolve(reference: string | null | undefined, operation: string): AgentRuntimeBindingResolveResult };
    providerAgentRuntimeTurns: ProviderAgentRuntimeTurnCoordinator;
    validateBackgroundSource?: (scope: SessionHistoryReadScope) => Promise<boolean>;
  }) {}

  async route(request: AgentRuntimeExtensionRequest): Promise<AgentRuntimeExtensionResponse | null> {
    const operation = sessionGraphRuntimeOperationByPath.get(new URL(request.path, "http://127.0.0.1").pathname);
    if (!operation) return null;
    const error = (status: number, code: string, message: string, effect: "none" | "unknown" = "none"): AgentRuntimeExtensionResponse => ({ status, value: { ok: false, code, message, effect } });
    if (request.method !== "POST") return error(405, "SESSION_GRAPH_INVALID_REQUEST", "Session Graph requires POST.");
    const parsed = sessionGraphOperationRequestSchemas[operation].safeParse(request.body);
    if (!parsed.success) return error(400, "SESSION_GRAPH_INVALID_REQUEST", parsed.error.message);
    const grant = sessionGraphAgentRuntimeOperation(operation);
    const resolved = this.deps.bindingRegistry.resolve(request.bindingReference, grant);
    if (!resolved.ok) return error(401, resolved.code, "Session Graph requires an active Session binding.");
    const binding = resolved.binding;
    const validBackgroundSource = async () => !binding.backgroundScope
      || Boolean(await this.deps.validateBackgroundSource?.(binding.backgroundScope.history));
    if (binding.backgroundScope && !await validBackgroundSource()) return error(403, "SESSION_GRAPH_BINDING_INVALID", "Background source authority is no longer active.");
    const owner = binding.authoritySnapshot.sessionGraphOwner as SessionGraphOwner | undefined;
    const sourceKind = binding.backgroundScope?.history.source.kind;
    const actor = await this.deps.applicationService.resolveSession(binding.actorSessionId, sourceKind);
    if (!owner || typeof owner.sessionId !== "string" || typeof owner.incarnationId !== "string" || !actor
      || (!binding.backgroundScope && actor.providerId !== binding.providerId) || !sameSessionGraphOwner(owner, actor.owner)
      || typeof binding.authoritySnapshot.characterId !== "string"
      || actor.identity.character?.id !== binding.authoritySnapshot.characterId) {
      return error(403, "SESSION_GRAPH_BINDING_INVALID", "Session Graph parent authority is no longer active.");
    }
    const currentBinding = () => {
      const current = this.deps.bindingRegistry.resolve(request.bindingReference, grant);
      return current.ok && current.binding.bindingId === binding.bindingId
        && current.binding.executionGeneration === binding.executionGeneration;
    };
    let admission: RuntimeTurnAdmission | undefined;
    if (operation === "apply" || request.turnCapability || binding.backgroundScope) {
      const turnInput = { actorSessionId: binding.actorSessionId, providerId: binding.providerId, turnCapability: request.turnCapability,
        ...(binding.backgroundScope ? { bindingId: binding.bindingId } : {}) };
      const turn = this.deps.providerAgentRuntimeTurns.admit(turnInput);
      if (!turn.ok) return error(401, "SESSION_GRAPH_TURN_INACTIVE", "Session Graph requires the captured active provider turn.");
      admission = { state: turn.handle.revocationState, isCurrent: () => {
        const active = this.deps.providerAgentRuntimeTurns.admit(turnInput);
        return currentBinding() && active.ok && active.handle === turn.handle;
      } };
    }
    try {
      const result = await this.deps.applicationService.executeTrusted(binding.actorSessionId, operation, parsed.data, currentBinding, admission, owner, sourceKind);
      if (binding.backgroundScope && (!await validBackgroundSource() || !currentBinding() || admission?.isCurrent?.() === false)) {
        return error(403, "SESSION_GRAPH_BINDING_INVALID", "Background source authority is no longer active.");
      }
      return { status: result.status === "conflict" ? 409 : 200, value: { ...result } };
    } catch (cause) {
      return error(409, "SESSION_GRAPH_REQUEST_FAILED", cause instanceof Error ? cause.message : "Session Graph request failed.", operation === "apply" ? "unknown" : "none");
    }
  }
}
