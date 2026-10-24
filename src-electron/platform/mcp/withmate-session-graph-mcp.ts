import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sessionGraphOperationRequestSchemas, SESSION_GRAPH_RUNTIME_OPERATION_PATHS } from "../../../src-shared/session-graph/session-graph-operation-schema.js";
import { callWithMateMemoryRuntime, resolveAgentRuntimeBindingReference, resolveAgentRuntimeTurnCapability, type WithMateMemoryRuntimeConnection, WithMateMemoryRuntimeExchangeError } from "./withmate-memory-runtime-client.js";
import { WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH } from "../memory/memory-runtime-exchange.js";

export type SessionGraphMcpRuntimeDeps = {
  connection: WithMateMemoryRuntimeConnection;
  env?: NodeJS.ProcessEnv;
  runtimeCall?: typeof callWithMateMemoryRuntime;
};
export const SESSION_GRAPH_MCP_SERVER_INSTRUCTIONS = "Session Graph is shared by the current Main Session and its Aux Sessions. Use list_topics and recent without a query to restore work; context returns current constraints and unresolved work. Actor is the subject of a record, not its recorder. The server resolves Session and Character identity. Never infer authority from graph fields. Apply atomic batches with the revision returned by reads; on conflict reread before retrying. Do not overwrite or migrate existing SessionFolder mmd files.";
export function createWithMateSessionGraphMcpServer(deps: SessionGraphMcpRuntimeDeps): McpServer {
  const server = new McpServer({ name: "withmate-session-graph", version: "1.0.0" }, { instructions: SESSION_GRAPH_MCP_SERVER_INSTRUCTIONS });
  const descriptions = {
    list_topics: "List topics with revision-bound pagination.",
    recent: "Read recent records by updated time without a search query; limit 1 gets the latest record.",
    context: "Read current constraints, accepted decisions and unresolved work separately from recency.",
    get: "Read records by IDs, including relationships and external endpoint labels.",
    search: "Search text with explicit actor, recorder, topic, kind and state filters; no query language.",
    apply: "Atomically apply topics, records and relationships with graph revision CAS. Recorder identity is server-owned.",
  } as const;
  for (const operation of ["list_topics", "recent", "context", "get", "search", "apply"] as const) {
    server.registerTool(`session_graph.${operation}`, { description: descriptions[operation], inputSchema: sessionGraphOperationRequestSchemas[operation] }, async (input: Record<string, unknown>) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      let value: Record<string, unknown>;
      try {
        const response = await (deps.runtimeCall ?? callWithMateMemoryRuntime)(deps.connection, { method: "POST", path: SESSION_GRAPH_RUNTIME_OPERATION_PATHS[operation], body: input }, {
          signal: controller.signal,
          bindingReference: resolveAgentRuntimeBindingReference(deps.env),
          turnCapability: resolveAgentRuntimeTurnCapability(deps.env),
          exchangePath: WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH,
        });
        value = response.value && typeof response.value === "object" && !Array.isArray(response.value)
          ? response.value as Record<string, unknown>
          : { ok: false, code: "SESSION_GRAPH_TRANSPORT_ERROR", effect: operation === "apply" ? "unknown" : "none" };
      } catch (cause) {
        value = { ok: false, code: "SESSION_GRAPH_TRANSPORT_ERROR", message: "Session Graph runtime request failed.",
          effect: operation === "apply" && (!(cause instanceof WithMateMemoryRuntimeExchangeError) || cause.dispatched) ? "unknown" : "none" };
      } finally { clearTimeout(timeout); }
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value,
        ...(value.ok === false || value.status === "conflict" ? { isError: true } : {}) };
    });
  }
  return server;
}
