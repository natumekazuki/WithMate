import { SESSION_HISTORY_RUNTIME_OPERATION_PATHS, type SessionHistoryOperation } from "../../../src-shared/session-history/session-history-contract.js";
import { WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH } from "../memory/memory-runtime-exchange.js";
import {
  callWithMateMemoryRuntime, mapWithMateMemoryDiscoveryCode, resolveWithMateMemoryApi,
  resolveAgentRuntimeBindingReference, resolveAgentRuntimeTurnCapability,
  type WithMateMemoryRuntimeConnection,
} from "./withmate-memory-runtime-client.js";

export type SessionHistoryRuntimeClientDeps = Omit<Parameters<typeof resolveWithMateMemoryApi>[0], "adapter" | "signal"> & {
  connection?: WithMateMemoryRuntimeConnection;
  runtimeCall?: typeof callWithMateMemoryRuntime;
  requestTimeoutMs?: number;
};

export function createSessionHistoryTransportError(): Record<string, unknown> {
  return { ok: false, code: "SESSION_HISTORY_TRANSPORT_ERROR", message: "Session history runtime request failed.", effect: "none" };
}

/** Every operation is a read, so a failed exchange never leaves a partial effect. */
export async function callSessionHistoryRuntime(
  operation: SessionHistoryOperation,
  body: Record<string, unknown>,
  deps: SessionHistoryRuntimeClientDeps,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deps.requestTimeoutMs ?? 10_000);
  try {
    let bindingReference: string | undefined;
    try { bindingReference = resolveAgentRuntimeBindingReference(deps.env); }
    catch { return { ok: false, code: "SESSION_HISTORY_BINDING_REQUIRED", effect: "none" }; }
    if (!bindingReference) return { ok: false, code: "SESSION_HISTORY_BINDING_REQUIRED", effect: "none" };
    const resolution = deps.connection ? { kind: "selected" as const, connection: deps.connection }
      : await resolveWithMateMemoryApi({ ...deps, adapter: "mcp", signal: controller.signal });
    if (resolution.kind === "error") {
      return { ok: false, code: mapWithMateMemoryDiscoveryCode(resolution.code), effect: "none", candidates: resolution.candidates };
    }
    const response = await (deps.runtimeCall ?? callWithMateMemoryRuntime)(resolution.connection,
      { method: "POST", path: SESSION_HISTORY_RUNTIME_OPERATION_PATHS[operation], body }, {
        signal: controller.signal, bindingReference, turnCapability: resolveAgentRuntimeTurnCapability(deps.env),
        exchangePath: WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH,
      });
    return response.value && typeof response.value === "object" && !Array.isArray(response.value)
      ? response.value as Record<string, unknown> : createSessionHistoryTransportError();
  } catch {
    return createSessionHistoryTransportError();
  } finally { clearTimeout(timeout); }
}
