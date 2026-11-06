import type { ProviderAgentRuntimeBindingProjection } from "./agent-runtime-binding.js";

export const WITHMATE_MANAGED_MCP_TOKEN_ENV = "WITHMATE_MANAGED_MCP_TOKEN";
export const WITHMATE_MANAGED_MCP_TOKEN_HEADER = "x-withmate-mcp-token";
export const WITHMATE_MANAGED_MEMORY_MCP_NAME = "withmate-memory";
export const WITHMATE_MANAGED_GLOSSARY_MCP_NAME = "withmate-glossary";
export const WITHMATE_MANAGED_SESSION_GRAPH_MCP_NAME = "withmate-session-graph";
export const WITHMATE_MANAGED_SESSION_HISTORY_MCP_NAME = "withmate-session-history";
export const WITHMATE_MANAGED_SESSION_MCP_NAME = "withmate-session";

function managedServerUrls(binding: ProviderAgentRuntimeBindingProjection): [string, string][] {
  const connection = binding.managedMcp;
  if (!connection) return [];
  if (binding.background) {
    if (!connection.sessionHistoryUrl) throw new Error("Background execution requires its session-history MCP endpoint.");
    return [[WITHMATE_MANAGED_SESSION_HISTORY_MCP_NAME, connection.sessionHistoryUrl],
      [WITHMATE_MANAGED_MEMORY_MCP_NAME, connection.memoryUrl]];
  }
  return [
    [WITHMATE_MANAGED_MEMORY_MCP_NAME, connection.memoryUrl],
    [WITHMATE_MANAGED_GLOSSARY_MCP_NAME, connection.glossaryUrl],
    [WITHMATE_MANAGED_SESSION_GRAPH_MCP_NAME, connection.sessionGraphUrl],
    ...(connection.sessionUrl ? [[WITHMATE_MANAGED_SESSION_MCP_NAME, connection.sessionUrl] as [string, string]] : []),
  ];
}

export function buildCodexManagedHttpMcpArguments(binding: ProviderAgentRuntimeBindingProjection | null | undefined): string[] {
  if (!binding?.managedMcp) return [];
  // Codex deep-merges config tables; private HTTP keys keep old stdio fields out.
  return [
    ...managedServerUrls(binding).flatMap(([name, url]) => [
      "-c",
      `mcp_servers.${name}-http={url=${JSON.stringify(url)},env_http_headers={${WITHMATE_MANAGED_MCP_TOKEN_HEADER}=${JSON.stringify(WITHMATE_MANAGED_MCP_TOKEN_ENV)}}}`,
    ]),
  ];
}

export function buildCodexManagedMcpDisableConfig(effectiveConfig: Record<string, unknown>): Record<string, { enabled: false }> {
  const configured = effectiveConfig.mcp_servers;
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) return {};
  return Object.fromEntries(
    [WITHMATE_MANAGED_MEMORY_MCP_NAME, WITHMATE_MANAGED_GLOSSARY_MCP_NAME, WITHMATE_MANAGED_SESSION_GRAPH_MCP_NAME, WITHMATE_MANAGED_SESSION_HISTORY_MCP_NAME, WITHMATE_MANAGED_SESSION_MCP_NAME]
      .filter((name) => Object.hasOwn(configured, name))
      .map((name) => [name, { enabled: false as const }]),
  );
}

export function buildCodexManagedHttpMcpConfig(binding: ProviderAgentRuntimeBindingProjection):
  Record<string, { url: string; env_http_headers: Record<string, string> }> {
  const connection = binding.managedMcp;
  if (!connection) return {};
  return Object.fromEntries(managedServerUrls(binding).map(([name, url]) => [`${name}-http`, {
    url, env_http_headers: { [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: WITHMATE_MANAGED_MCP_TOKEN_ENV },
  }]));
}

export function buildManagedHttpMcpServers(binding: ProviderAgentRuntimeBindingProjection | null | undefined):
  Record<string, { type: "http"; url: string; headers: Record<string, string> }> | undefined {
  if (!binding?.managedMcp) return undefined;
  const connection = binding.managedMcp;
  return Object.fromEntries(managedServerUrls(binding).map(([name, url]) => [name, {
    type: "http" as const, url,
    headers: { [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: connection.token },
  }]));
}
