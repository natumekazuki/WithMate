import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  createWithMateGlossaryMcpServer,
  type GlossaryMcpRuntimeDeps,
} from "../../src-electron/platform/mcp/withmate-glossary-mcp.js";

export async function startWithMateGlossaryMcpServer(deps: GlossaryMcpRuntimeDeps = {}): Promise<McpServer> {
  const server = createWithMateGlossaryMcpServer(deps);
  await server.connect(new StdioServerTransport());
  return server;
}
