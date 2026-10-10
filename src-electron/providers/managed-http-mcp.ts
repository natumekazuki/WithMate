import type { ProviderAgentRuntimeBindingProjection } from "./agent-runtime-binding.js";

export const WITHMATE_MANAGED_MCP_TOKEN_ENV = "WITHMATE_MANAGED_MCP_TOKEN";
export const WITHMATE_MANAGED_MCP_TOKEN_HEADER = "x-withmate-mcp-token";
export const WITHMATE_MANAGED_MEMORY_MCP_NAME = "withmate-memory";
export const WITHMATE_MANAGED_GLOSSARY_MCP_NAME = "withmate-glossary";

export function buildCodexManagedHttpMcpArguments(binding: ProviderAgentRuntimeBindingProjection | null | undefined): string[] {
  const connection = binding?.managedMcp;
  if (!connection) return [];
  // Codex deep-merges config tables; private HTTP keys keep old stdio fields out.
  return [
    ...[
      ["withmate-memory-http", connection.memoryUrl],
      ["withmate-glossary-http", connection.glossaryUrl],
    ].flatMap(([name, url]) => [
      "-c",
      `mcp_servers.${name}={url=${JSON.stringify(url)},env_http_headers={${WITHMATE_MANAGED_MCP_TOKEN_HEADER}=${JSON.stringify(WITHMATE_MANAGED_MCP_TOKEN_ENV)}}}`,
    ]),
  ];
}

export function buildCodexManagedMcpDisableConfig(effectiveConfig: Record<string, unknown>): Record<string, { enabled: false }> {
  const configured = effectiveConfig.mcp_servers;
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) return {};
  return Object.fromEntries(
    [WITHMATE_MANAGED_MEMORY_MCP_NAME, WITHMATE_MANAGED_GLOSSARY_MCP_NAME]
      .filter((name) => Object.hasOwn(configured, name))
      .map((name) => [name, { enabled: false as const }]),
  );
}

export function buildCodexManagedHttpMcpConfig(binding: ProviderAgentRuntimeBindingProjection):
  Record<string, { url: string; env_http_headers: Record<string, string> }> {
  const connection = binding.managedMcp;
  if (!connection) return {};
  return Object.fromEntries([
    ["withmate-memory-http", connection.memoryUrl],
    ["withmate-glossary-http", connection.glossaryUrl],
  ].map(([name, url]) => [name, {
    url, env_http_headers: { [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: WITHMATE_MANAGED_MCP_TOKEN_ENV },
  }]));
}

export function buildManagedHttpMcpServers(binding: ProviderAgentRuntimeBindingProjection | null | undefined):
  Record<string, { type: "http"; url: string; headers: Record<string, string> }> | undefined {
  const connection = binding?.managedMcp;
  if (!connection) return undefined;
  return {
    [WITHMATE_MANAGED_MEMORY_MCP_NAME]: {
      type: "http", url: connection.memoryUrl,
      headers: { [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: connection.token },
    },
    [WITHMATE_MANAGED_GLOSSARY_MCP_NAME]: {
      type: "http", url: connection.glossaryUrl,
      headers: { [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: connection.token },
    },
  };
}
