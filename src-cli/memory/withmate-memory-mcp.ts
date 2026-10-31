import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  createWithMateMemoryMcpServer,
  type McpRuntimeDeps,
} from "../../src-electron/platform/mcp/withmate-memory-mcp.js";

export async function startWithMateMemoryMcpServer(deps: McpRuntimeDeps = {}): Promise<McpServer> {
  const server = createWithMateMemoryMcpServer(deps);
  await server.connect(new StdioServerTransport());
  return server;
}
