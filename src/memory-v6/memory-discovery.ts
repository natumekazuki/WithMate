import { tmpdir } from "node:os";
import path from "node:path";

export const WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION = "withmate-memory-discovery-v1" as const;
export const WITHMATE_MEMORY_DISCOVERY_FILE_NAME = "memory-v6-api.json" as const;

export type WithMateMemoryDiscoveryDocument = {
  schemaVersion: typeof WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION;
  baseUrl: string;
  apiSecret?: string;
  runtimeInstanceId?: string;
  publishedAt?: string;
};

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
): string {
  return path.join(resolveDefaultWithMateMemoryRuntimeDirectory(env), WITHMATE_MEMORY_DISCOVERY_FILE_NAME);
}
