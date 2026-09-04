import { createHash, createHmac } from "node:crypto";

export const WITHMATE_MEMORY_RUNTIME_NONCE_HEADER = "x-withmate-memory-runtime-nonce";
export const WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER = "x-withmate-memory-runtime-instance";
/** Non-secret application owner identity (main-process lifetime). */
export const WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_HEADER = "x-withmate-memory-application-instance";
/** Canonical Memory runtime generation header; runtime-instance remains a legacy alias. */
export const WITHMATE_MEMORY_RUNTIME_GENERATION_HEADER = "x-withmate-memory-runtime-generation";
export const WITHMATE_MEMORY_RUNTIME_CHALLENGE_HEADER = "x-withmate-memory-runtime-challenge";
export const WITHMATE_MEMORY_RUNTIME_EXCHANGE_PATH = "/v1/exchange";
export const WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH = "/v1/agent-runtime-extension-exchange";
export const WITHMATE_MEMORY_FALLBACK_LISTED_PATH = "/v1/fallback-admission/listed";
export const WITHMATE_MEMORY_FALLBACK_LISTED_ROLLBACK_PATH = "/v1/fallback-admission/listed/rollback";
export const WITHMATE_MEMORY_FALLBACK_ELIGIBLE_PATH = "/v1/fallback-admission/eligible";
export const WITHMATE_MEMORY_FALLBACK_ADMISSION_ADAPTER_KIND = "mcp-fallback-admission";
export const WITHMATE_MEMORY_FALLBACK_ADMISSION_CREDENTIAL_SCHEMA_VERSION =
  "withmate-memory-fallback-admission-credential-v1";
export const WITHMATE_AGENT_RUNTIME_EXTENSION_MAX_BODY_BYTES = 34 * 1024 * 1024;
export const WITHMATE_MEMORY_RUNTIME_EXCHANGE_SCHEMA_VERSION = "withmate-memory-runtime-exchange-v1";

export type WithMateMemoryFallbackAdmissionCredential = {
  schemaVersion: typeof WITHMATE_MEMORY_FALLBACK_ADMISSION_CREDENTIAL_SCHEMA_VERSION;
  admissionSecret: string;
};

export function createWithMateMemoryRuntimeChallenge(
  apiSecret: string,
  runtimeGenerationId: string,
  nonce: string,
): string {
  return createHmac("sha256", apiSecret)
    .update(`${runtimeGenerationId}\n${nonce}`, "utf8")
    .digest("base64url");
}

/**
 * New owner-aware challenge. The legacy challenge above is intentionally kept
 * unchanged so 6.3.x clients can continue to authenticate during migration.
 */
export function createWithMateMemoryRuntimeOwnerChallenge(
  apiSecret: string,
  applicationInstanceId: string,
  runtimeGenerationId: string,
  nonce: string,
): string {
  return createHmac("sha256", apiSecret)
    .update(`${applicationInstanceId}\n${runtimeGenerationId}\n${nonce}`, "utf8")
    .digest("base64url");
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeJson(entry)]),
    );
  }
  return value;
}

/** Fingerprint for one exact MCP operation that may be retried through CLI fallback. */
export function createMemoryFallbackOperationFingerprint(operation: {
  method: "GET" | "POST";
  path: string;
  body: unknown;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      method: operation.method,
      path: operation.path,
      body: canonicalizeJson(operation.body),
    }), "utf8")
    .digest("base64url");
}
