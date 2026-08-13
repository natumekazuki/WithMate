import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SessionRuntimeAdapterKind } from "./session-external-runtime-contract.js";

export const SESSION_RUNTIME_DISCOVERY_SCHEMA_VERSION = "withmate-session-discovery-v1" as const;
export const SESSION_RUNTIME_DISCOVERY_POINTER_SCHEMA_VERSION = "withmate-session-discovery-pointer-v1" as const;
export const SESSION_RUNTIME_DISCOVERY_FILE_NAME = "session.current.json" as const;

export type SessionRuntimeDiscoveryDocument = {
  schemaVersion: typeof SESSION_RUNTIME_DISCOVERY_SCHEMA_VERSION;
  adapter: SessionRuntimeAdapterKind;
  baseUrl: string;
  apiSecret: string;
  adapterSecret: string;
  runtimeInstanceId: string;
  publishedAt: string;
};

export type SessionRuntimeDiscoveryPointer = {
  schemaVersion: typeof SESSION_RUNTIME_DISCOVERY_POINTER_SCHEMA_VERSION;
  runtimeInstanceId: string;
};

export function buildSessionRuntimeDiscoveryGenerationFileName(
  adapter: SessionRuntimeAdapterKind,
  runtimeInstanceId: string,
): string {
  const generationId = createHash("sha256").update(runtimeInstanceId, "utf8").digest("hex");
  return `session-${adapter}.${generationId}.json`;
}

export function resolveDefaultSessionRuntimeDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = env.WITHMATE_SESSION_RUNTIME_DIR?.trim();
  if (platform === "win32") {
    if (configured) {
      throw new Error("WITHMATE_SESSION_RUNTIME_DIR is not supported on Windows.");
    }
    const localAppDataPath = env.LOCALAPPDATA?.trim();
    if (!localAppDataPath || !path.win32.isAbsolute(localAppDataPath)) {
      throw new Error("LOCALAPPDATA must identify an absolute Windows directory.");
    }
    return path.win32.join(localAppDataPath, "WithMate", "session-runtime");
  }
  if (configured) {
    return path.resolve(configured);
  }
  const ownerSegment = typeof process.getuid === "function" ? `uid-${process.getuid()}` : "local-user";
  return path.join(tmpdir(), "withmate-session", ownerSegment);
}

export function resolveDefaultSessionRuntimeDiscoveryFilePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const runtimeDirectoryPath = resolveDefaultSessionRuntimeDirectory(env, platform);
  return platform === "win32"
    ? path.win32.join(runtimeDirectoryPath, SESSION_RUNTIME_DISCOVERY_FILE_NAME)
    : path.join(runtimeDirectoryPath, SESSION_RUNTIME_DISCOVERY_FILE_NAME);
}
