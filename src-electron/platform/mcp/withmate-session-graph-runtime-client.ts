import { SESSION_GRAPH_RUNTIME_OPERATION_PATHS, type SessionGraphRuntimeOperation } from "../../../src-shared/session-graph/session-graph-operation-schema.js";
import { WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH } from "../memory/memory-runtime-exchange.js";
import {
  callWithMateMemoryRuntime, mapWithMateMemoryDiscoveryCode, resolveWithMateMemoryApi,
  resolveAgentRuntimeBindingReference, resolveAgentRuntimeTurnCapability,
  type WithMateMemoryRuntimeConnection, WithMateMemoryRuntimeExchangeError,
} from "./withmate-memory-runtime-client.js";

export type SessionGraphRuntimeClientDeps = Omit<Parameters<typeof resolveWithMateMemoryApi>[0], "adapter" | "signal"> & {
  connection?: WithMateMemoryRuntimeConnection;
  runtimeCall?: typeof callWithMateMemoryRuntime;
  requestTimeoutMs?: number;
};

export function createSessionGraphTransportError(effect: "none" | "unknown" = "none"): Record<string, unknown> {
  return { ok: false, code: "SESSION_GRAPH_TRANSPORT_ERROR", message: "Session Graph runtime request failed.", effect };
}

export async function callSessionGraphRuntime(
  operation: SessionGraphRuntimeOperation,
  body: Record<string, unknown>,
  deps: SessionGraphRuntimeClientDeps,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deps.requestTimeoutMs ?? 10_000);
  let dispatched = false;
  try {
    let bindingReference: string | undefined;
    try { bindingReference = resolveAgentRuntimeBindingReference(deps.env); }
    catch { return { ok: false, code: "SESSION_GRAPH_BINDING_REQUIRED", effect: "none" }; }
    const turnCapability = resolveAgentRuntimeTurnCapability(deps.env);
    if (!bindingReference) {
      return { ok: false, code: "SESSION_GRAPH_BINDING_REQUIRED", effect: "none" };
    }
    const resolution = deps.connection ? { kind: "selected" as const, connection: deps.connection }
      : await resolveWithMateMemoryApi({ ...deps, adapter: "mcp", signal: controller.signal });
    if (resolution.kind === "error") {
      return { ok: false, code: mapWithMateMemoryDiscoveryCode(resolution.code), effect: "none", candidates: resolution.candidates };
    }
    dispatched = true;
    const response = await (deps.runtimeCall ?? callWithMateMemoryRuntime)(resolution.connection,
      { method: "POST", path: SESSION_GRAPH_RUNTIME_OPERATION_PATHS[operation], body }, {
        signal: controller.signal, bindingReference, turnCapability,
        exchangePath: WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH,
      });
    return response.value && typeof response.value === "object" && !Array.isArray(response.value)
      ? response.value as Record<string, unknown>
      : createSessionGraphTransportError(operation === "apply" ? "unknown" : "none");
  } catch (cause) {
    const wasDispatched = cause instanceof WithMateMemoryRuntimeExchangeError ? cause.dispatched : dispatched;
    return createSessionGraphTransportError(operation === "apply" && wasDispatched ? "unknown" : "none");
  } finally { clearTimeout(timeout); }
}
