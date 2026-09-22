import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RuntimeBuildChannel } from "../runtime-discovery/runtime-discovery-contract.js";

export const WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION = "withmate-memory-discovery-v2" as const;
export const WITHMATE_MEMORY_DISCOVERY_POINTER_SCHEMA_VERSION = "withmate-memory-discovery-pair-pointer-v1" as const;
export const WITHMATE_MEMORY_CLI_DISCOVERY_FILE_NAME = "memory-v6.current.json" as const;
export const WITHMATE_MEMORY_MCP_DISCOVERY_FILE_NAME = WITHMATE_MEMORY_CLI_DISCOVERY_FILE_NAME;
export const WITHMATE_MEMORY_DISCOVERY_FILE_NAME = WITHMATE_MEMORY_CLI_DISCOVERY_FILE_NAME;

export type WithMateMemoryAdapterKind = "cli" | "mcp";

export type WithMateMemoryDiscoveryDocument = {
  schemaVersion: typeof WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION;
  adapter: WithMateMemoryAdapterKind;
  baseUrl: string;
  apiSecret: string;
  adapterSecret: string;
  applicationInstanceId?: string;
  runtimeGenerationId?: string;
  buildChannel?: RuntimeBuildChannel;
  /** @deprecated This field has runtime generation semantics. */
  runtimeInstanceId: string;
  publishedAt: string;
};

export type WithMateMemoryDiscoveryPointer = {
  schemaVersion: typeof WITHMATE_MEMORY_DISCOVERY_POINTER_SCHEMA_VERSION;
  /** @deprecated This field has runtime generation semantics. */
  runtimeInstanceId: string;
};

export function buildWithMateMemoryDiscoveryGenerationFileName(
  adapter: WithMateMemoryAdapterKind,
  runtimeGenerationId: string,
): string {
  const generationId = createHash("sha256").update(runtimeGenerationId, "utf8").digest("hex");
  return `memory-v6-${adapter}.${generationId}.json`;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") {
    return true;
  }

  const ipv4Parts = normalized.split(".");
  return ipv4Parts.length === 4
    && ipv4Parts[0] === "127"
    && ipv4Parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255);
}

export function normalizeWithMateMemoryApiBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) {
      return null;
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function resolveDefaultWithMateMemoryRuntimeDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const runtimeDirectoryPath = env.WITHMATE_MEMORY_RUNTIME_DIR?.trim();
  if (runtimeDirectoryPath) {
    return path.resolve(runtimeDirectoryPath);
  }

  const ownerSegment = typeof process.getuid === "function" ? `uid-${process.getuid()}` : "local-user";
  return path.join(tmpdir(), "withmate-memory", ownerSegment);
}

export function resolveDefaultWithMateMemoryDiscoveryFilePath(
  env: NodeJS.ProcessEnv = process.env,
  _adapter: WithMateMemoryAdapterKind = "cli",
): string {
  return path.join(resolveDefaultWithMateMemoryRuntimeDirectory(env), WITHMATE_MEMORY_DISCOVERY_FILE_NAME);
}
