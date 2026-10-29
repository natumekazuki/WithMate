import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sessionGraphOperationRequestSchemas } from "../../../src-shared/session-graph/session-graph-operation-schema.js";
import { callWithMateMemoryRuntime, type WithMateMemoryRuntimeConnection } from "./withmate-memory-runtime-client.js";
import { callSessionGraphRuntime } from "./withmate-session-graph-runtime-client.js";

export type SessionGraphMcpRuntimeDeps = {
  connection: WithMateMemoryRuntimeConnection;
  env?: NodeJS.ProcessEnv;
  runtimeCall?: typeof callWithMateMemoryRuntime;
};
export const SESSION_GRAPH_MCP_SERVER_INSTRUCTIONS = "Session Graph is shared by the current Main Session and its Aux Sessions. Use list_topics and recent without a query to restore work; context returns current constraints and unresolved work. Actor is the responsible agent, origin is the content source (agent/user/external), adoptionOrigin is the source of the acceptance or rejection, and recordedBy is the first recorder. For new records omit actor to use the trusted caller; origin is required, including user or external content. The server resolves Session and Character identity; never enter your own name, icon or Session ID. On update, omitted actor, origin and optional attributes are retained; null clears an optional attribute. Explicit actor.sessionId assigns a responsible agent in this parent Graph. Actor snapshots and the first recorder are preserved for unchanged actors. actorRole is an optional work role, separate from Character name and Main/Auxiliary role. User acceptance does not change actor or origin; set adoptionOrigin separately. When changing adoption with an existing adoptionOrigin, explicitly replace or clear that origin. Read records before updating required content. actorSessionId filters responsibility; recordedBySessionId filters first recorders, regardless of content origin. Every reference href must be an absolute file path or a complete file/http/https/mailto/tel URL, even when unchanged. Never infer execution authority from graph fields. Apply atomic batches with the revision returned by reads; on conflict reread before retrying. Do not overwrite or migrate existing SessionFolder mmd files.";
export function createWithMateSessionGraphMcpServer(deps: SessionGraphMcpRuntimeDeps): McpServer {
  const server = new McpServer({ name: "withmate-session-graph", version: "1.0.0" }, { instructions: SESSION_GRAPH_MCP_SERVER_INSTRUCTIONS });
  const descriptions = {
    list_topics: "List topics with revision-bound pagination.",
    recent: "Read recent records by updated time without a search query; limit 1 gets the latest record.",
    context: "Read current constraints, accepted decisions and unresolved work separately from recency.",
    get: "Read records by IDs, including relationships and external endpoint labels.",
    search: "Search text with explicit actor, recorder, topic, kind and state filters; no query language.",
    apply: "Atomically upsert required record content and relationships with graph revision CAS. New records require origin and default to the trusted caller as actor. Updates retain omitted actor, origin and optional attributes; null explicitly clears optional attributes. Recorder identity is server-owned. All reference hrefs are validated on every save.",
  } as const;
  for (const operation of ["list_topics", "recent", "context", "get", "search", "apply"] as const) {
    server.registerTool(`session_graph.${operation}`, { description: descriptions[operation], inputSchema: sessionGraphOperationRequestSchemas[operation] }, async (input: Record<string, unknown>) => {
      const value = await callSessionGraphRuntime(operation, input, deps);
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value,
        ...(value.ok === false || value.status === "conflict" ? { isError: true } : {}) };
    });
  }
  return server;
}
