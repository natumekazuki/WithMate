import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  normalizeWithMateMemoryApiBaseUrl,
  resolveDefaultWithMateMemoryDiscoveryFilePath,
  WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
  type WithMateMemoryDiscoveryDocument,
} from "../src/memory-v6/memory-discovery.js";
import { createMemoryErrorResponse } from "../src/memory-v6/memory-response-contract.js";

export type WithMateMemoryApiConnection = {
  baseUrl: string;
  apiSecret?: string;
  operatorApiSecret?: string;
  mcpApiSecret?: string;
  runtimeInstanceId?: string;
};

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const WITHMATE_MEMORY_API_SECRET_HEADER = "x-withmate-memory-api-secret";

function usageError(message: string) {
  return createMemoryErrorResponse({
    code: "WITHMATE_MEMORY_CLI_USAGE",
    message,
  });
}

function transportError(message: string) {
  return createMemoryErrorResponse({
    code: "WITHMATE_MEMORY_TRANSPORT_ERROR",
    message,
  });
}

function readEnvSecret(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.WITHMATE_MEMORY_API_SECRET?.trim();
  return value ? value : undefined;
}

function readEnvRuntimeInstanceId(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.WITHMATE_MEMORY_RUNTIME_INSTANCE_ID?.trim();
  return value ? value : undefined;
}

export async function discoverWithMateMemoryApi(
  options: {
    env?: NodeJS.ProcessEnv;
    apiUrl?: string;
    discoveryFilePath?: string;
    readFile?: typeof readFile;
  } = {},
): Promise<WithMateMemoryApiConnection | null> {
  const env = options.env ?? process.env;
  if (options.apiUrl !== undefined) {
    const explicitUrl = normalizeWithMateMemoryApiBaseUrl(options.apiUrl);
    if (!explicitUrl) {
      throw usageError("--api-url must be a valid loopback HTTP URL.");
    }
    return {
      baseUrl: explicitUrl,
      ...(readEnvSecret(env) ? { apiSecret: readEnvSecret(env) } : {}),
      ...(env.WITHMATE_MEMORY_OPERATOR_API_SECRET?.trim()
        ? { operatorApiSecret: env.WITHMATE_MEMORY_OPERATOR_API_SECRET.trim() }
        : {}),
      ...(env.WITHMATE_MEMORY_MCP_API_SECRET?.trim()
        ? { mcpApiSecret: env.WITHMATE_MEMORY_MCP_API_SECRET.trim() }
        : {}),
      ...(readEnvRuntimeInstanceId(env) ? { runtimeInstanceId: readEnvRuntimeInstanceId(env) } : {}),
    };
  }

  const rawEnvUrl = env.WITHMATE_MEMORY_API_URL?.trim();
  if (rawEnvUrl) {
    const envUrl = normalizeWithMateMemoryApiBaseUrl(rawEnvUrl);
    if (!envUrl) {
      throw usageError("WITHMATE_MEMORY_API_URL must be a valid loopback HTTP URL.");
    }
    return {
      baseUrl: envUrl,
      ...(readEnvSecret(env) ? { apiSecret: readEnvSecret(env) } : {}),
      ...(env.WITHMATE_MEMORY_OPERATOR_API_SECRET?.trim()
        ? { operatorApiSecret: env.WITHMATE_MEMORY_OPERATOR_API_SECRET.trim() }
        : {}),
      ...(env.WITHMATE_MEMORY_MCP_API_SECRET?.trim()
        ? { mcpApiSecret: env.WITHMATE_MEMORY_MCP_API_SECRET.trim() }
        : {}),
      ...(readEnvRuntimeInstanceId(env) ? { runtimeInstanceId: readEnvRuntimeInstanceId(env) } : {}),
    };
  }

  const envDiscoveryFilePath = env.WITHMATE_MEMORY_DISCOVERY_FILE?.trim();
  const discoveryFilePath = options.discoveryFilePath
    ?? (envDiscoveryFilePath || resolveDefaultWithMateMemoryDiscoveryFilePath(env));
  const read = options.readFile ?? readFile;

  try {
    const document = JSON.parse(await read(discoveryFilePath, "utf8")) as Partial<WithMateMemoryDiscoveryDocument>;
    if (document.schemaVersion !== WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION || typeof document.baseUrl !== "string") {
      return null;
    }
    const baseUrl = normalizeWithMateMemoryApiBaseUrl(document.baseUrl);
    if (!baseUrl) {
      return null;
    }
    return {
      baseUrl,
      ...(typeof document.apiSecret === "string" && document.apiSecret.trim()
        ? { apiSecret: document.apiSecret.trim() }
        : {}),
      ...(typeof document.operatorApiSecret === "string" && document.operatorApiSecret.trim()
        ? { operatorApiSecret: document.operatorApiSecret.trim() }
        : {}),
      ...(typeof document.mcpApiSecret === "string" && document.mcpApiSecret.trim()
        ? { mcpApiSecret: document.mcpApiSecret.trim() }
        : {}),
      ...(typeof document.runtimeInstanceId === "string" && document.runtimeInstanceId.trim()
        ? { runtimeInstanceId: document.runtimeInstanceId.trim() }
        : {}),
    };
  } catch {
    return null;
  }
}

function hasVerifiableRuntimeIdentity(connection: WithMateMemoryApiConnection): connection is WithMateMemoryApiConnection & {
  apiSecret: string;
  runtimeInstanceId: string;
} {
  return Boolean(connection.apiSecret?.trim() && connection.runtimeInstanceId?.trim());
}

export async function verifyRuntimeIdentity(
  connection: WithMateMemoryApiConnection,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<boolean> {
  if (!hasVerifiableRuntimeIdentity(connection)) {
    return false;
  }

  const nonce = randomBytes(16).toString("base64url");
  const response = await fetchImpl(`${connection.baseUrl}/v1/status?nonce=${encodeURIComponent(nonce)}`, {
    method: "GET",
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    return false;
  }

  const text = await response.text();
  if (!text.trim()) {
    throw transportError("Memory API returned a non-JSON response.");
  }
  let status: {
    runtimeInstanceId?: unknown;
    challenge?: { nonce?: unknown; hmacSha256?: unknown };
  };
  try {
    status = JSON.parse(text) as typeof status;
  } catch {
    throw transportError("Memory API returned a non-JSON response.");
  }
  const expectedChallenge = createHmac("sha256", connection.apiSecret).update(nonce, "utf8").digest("base64url");
  return status.runtimeInstanceId === connection.runtimeInstanceId
    && status.challenge?.nonce === nonce
    && status.challenge.hmacSha256 === expectedChallenge;
}
