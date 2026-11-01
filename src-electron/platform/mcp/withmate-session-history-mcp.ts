import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SESSION_HISTORY_USAGE_NOTICE, sessionHistoryOperationRequestSchemas } from "../../../src-shared/session-history/session-history-contract.js";
import type { WithMateMemoryRuntimeConnection } from "./withmate-memory-runtime-client.js";
import { callSessionHistoryRuntime, type SessionHistoryRuntimeClientDeps } from "./withmate-session-history-runtime-client.js";

export type SessionHistoryMcpRuntimeDeps = Pick<SessionHistoryRuntimeClientDeps, "env" | "runtimeCall"> & {
  connection: WithMateMemoryRuntimeConnection;
};

export const SESSION_HISTORY_MCP_SERVER_INSTRUCTIONS = `Session history reads the saved conversation of the one source Session fixed for this background execution, inside a fixed sequence window. The source and window come from the execution binding; no tool input selects a Session, Character or range. Use list_messages first, then get_message for the full text of one message, list_operations for its recorded operations, changed files and checks, and get_operation_detail for one operation's saved output, one changed file's diff rows, or one elicitation record (get_message reports elicitationRecordCount). Long diff rows are listed as oversized and read with row. Pages report total and nextOffset; a null nextOffset is the end. Failures are explicit: HISTORY_NOT_SAVED means the information was not saved, HISTORY_OUT_OF_RANGE means outside the permitted window, HISTORY_SOURCE_DELETED/HISTORY_SOURCE_REPLACED mean the source no longer matches, and HISTORY_RANGE_UNAVAILABLE means the saved conversation is shorter than the window. Operation summaries and details are stored previews; truncated and detailSaved say what exists, and nothing is reconstructed. ${SESSION_HISTORY_USAGE_NOTICE}`;

const descriptions = {
  list_messages: "List messages in the permitted window with role, exact Turn linkage when recorded, a text preview and operation counts. Page with offset/limit.",
  get_message: "Read one message's saved text in pieces of up to maxChars UTF-16 code units, continuing from nextOffset.",
  list_operations: "List one message's recorded operations (status, exit code, error, whether a detail is saved), changed files or run checks, selected by section. Page with offset/limit.",
  get_operation_detail: "Read one operation's saved output (kind=operation), one elicitation record (kind=elicitation) in pieces of maxChars, or one changed file's diff rows (kind=changed_file, maxRows, maxChars budget; row reads a single oversized row in pieces), continuing from nextOffset.",
} as const;

export function createWithMateSessionHistoryMcpServer(deps: SessionHistoryMcpRuntimeDeps): McpServer {
  const server = new McpServer({ name: "withmate-session-history", version: "1.0.0" }, { instructions: SESSION_HISTORY_MCP_SERVER_INSTRUCTIONS });
  for (const operation of Object.keys(sessionHistoryOperationRequestSchemas) as (keyof typeof sessionHistoryOperationRequestSchemas)[]) {
    server.registerTool(`session_history.${operation}`, { description: descriptions[operation], inputSchema: sessionHistoryOperationRequestSchemas[operation] }, async (input: Record<string, unknown>) => {
      const value = await callSessionHistoryRuntime(operation, input, deps);
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) };
    });
  }
  return server;
}
