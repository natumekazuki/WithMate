import { createHmac } from "node:crypto";

export const WITHMATE_MEMORY_RUNTIME_NONCE_HEADER = "x-withmate-memory-runtime-nonce";
export const WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER = "x-withmate-memory-runtime-instance";
/** Non-secret application owner identity (main-process lifetime). */
export const WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_HEADER = "x-withmate-memory-application-instance";
/** Canonical Memory runtime generation header; runtime-instance remains a legacy alias. */
export const WITHMATE_MEMORY_RUNTIME_GENERATION_HEADER = "x-withmate-memory-runtime-generation";
export const WITHMATE_MEMORY_RUNTIME_CHALLENGE_HEADER = "x-withmate-memory-runtime-challenge";
export const WITHMATE_MEMORY_RUNTIME_EXCHANGE_PATH = "/v1/exchange";
export const WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH = "/v1/agent-runtime-extension-exchange";
export const WITHMATE_AGENT_RUNTIME_EXTENSION_MAX_BODY_BYTES = 34 * 1024 * 1024;
export const WITHMATE_MEMORY_RUNTIME_EXCHANGE_SCHEMA_VERSION = "withmate-memory-runtime-exchange-v1";

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
