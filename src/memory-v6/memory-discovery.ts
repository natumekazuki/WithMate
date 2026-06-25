import { tmpdir } from "node:os";
import path from "node:path";

export const WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION = "withmate-memory-discovery-v1" as const;
export const WITHMATE_MEMORY_DISCOVERY_FILE_NAME = "memory-v6-api.json" as const;

export type WithMateMemoryDiscoveryDocument = {
  schemaVersion: typeof WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION;
  baseUrl: string;
};

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
