import {
  sessionHistoryAgentRuntimeOperation,
  sessionHistoryOperationRequestSchemas,
  sessionHistoryRuntimeOperationByPath,
  type SessionHistoryReadInput,
  type SessionHistoryResult,
} from "../../src-shared/session-history/session-history-contract.js";
import type { AgentRuntimeBindingRegistry } from "../providers/agent-runtime-binding.js";
import { authorizeSessionHistoryRead } from "../providers/session-history-runtime-authorization.js";
import { assertRuntimeTurnAdmission, runWithRuntimeTurnAdmission } from "../platform/memory/runtime-turn-admission.js";
import type { ProviderAgentRuntimeTurnCoordinator } from "../providers/provider-agent-runtime-turn-coordinator.js";
import type { AgentRuntimeExtensionRequest, AgentRuntimeExtensionResponse } from "../memory/memory-v6-http-server.js";

const FAILURE_STATUS = {
  HISTORY_INVALID_REQUEST: 400,
  HISTORY_OUT_OF_RANGE: 400,
  HISTORY_NOT_SAVED: 404,
  HISTORY_SOURCE_DELETED: 409,
  HISTORY_SOURCE_REPLACED: 409,
  HISTORY_RANGE_UNAVAILABLE: 409,
} as const;

/**
 * Serves saved-history reads to an app-managed background execution. The source and permitted
 * range come only from the authorized binding scope, never from the request.
 */
export class SessionHistoryRuntimeService {
  constructor(readonly deps: {
    read(input: SessionHistoryReadInput): Promise<SessionHistoryResult>;
    bindingRegistry: Pick<AgentRuntimeBindingRegistry, "resolve">;
    providerAgentRuntimeTurns: ProviderAgentRuntimeTurnCoordinator;
  }) {}

  async route(request: AgentRuntimeExtensionRequest): Promise<AgentRuntimeExtensionResponse | null> {
    const operation = sessionHistoryRuntimeOperationByPath.get(new URL(request.path, "http://127.0.0.1").pathname);
    if (!operation) return null;
    const error = (status: number, code: string, message: string): AgentRuntimeExtensionResponse => ({ status, value: { ok: false, code, message, effect: "none" } });
    if (request.method !== "POST") return error(405, "HISTORY_INVALID_REQUEST", "Session history requires POST.");
    const parsed = sessionHistoryOperationRequestSchemas[operation].safeParse(request.body);
    if (!parsed.success) return error(400, "HISTORY_INVALID_REQUEST", parsed.error.message);
    const grant = sessionHistoryAgentRuntimeOperation(operation);
    const resolved = authorizeSessionHistoryRead({ bindings: this.deps.bindingRegistry, turns: this.deps.providerAgentRuntimeTurns },
      { bindingReference: request.bindingReference, turnCapability: request.turnCapability, operation: grant });
    if (!resolved.ok) return error(resolved.code === "SESSION_BINDING_FORBIDDEN" ? 403 : 401, resolved.code, "Session history requires an active background execution binding.");
    const { scope, admission } = resolved.context;
    let result: SessionHistoryResult;
    try {
      result = await runWithRuntimeTurnAdmission(admission, async () => {
        const read = await this.deps.read({ scope, operation, request: parsed.data });
        assertRuntimeTurnAdmission();
        return read;
      });
    } catch {
      if (!admission.isCurrent?.()) return error(401, "HISTORY_EXECUTION_INACTIVE", "The background execution ended before the history was returned.");
      return error(500, "HISTORY_READ_FAILED", "Saved history could not be read.");
    }
    return { status: result.ok ? 200 : FAILURE_STATUS[result.code], value: { ...result } };
  }
}
