import { createHmac } from "node:crypto";

export const WITHMATE_MEMORY_RUNTIME_NONCE_HEADER = "x-withmate-memory-runtime-nonce";
export const WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER = "x-withmate-memory-runtime-instance";
export const WITHMATE_MEMORY_RUNTIME_CHALLENGE_HEADER = "x-withmate-memory-runtime-challenge";
export const WITHMATE_MEMORY_RUNTIME_EXCHANGE_PATH = "/v1/exchange";
export const WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH = "/v1/agent-runtime-extension-exchange";
export const WITHMATE_AGENT_RUNTIME_EXTENSION_MAX_BODY_BYTES = 34 * 1024 * 1024;
export const WITHMATE_MEMORY_RUNTIME_EXCHANGE_SCHEMA_VERSION = "withmate-memory-runtime-exchange-v1";

export function createWithMateMemoryRuntimeChallenge(
  apiSecret: string,
  runtimeInstanceId: string,
  nonce: string,
): string {
  return createHmac("sha256", apiSecret)
    .update(`${runtimeInstanceId}\n${nonce}`, "utf8")
    .digest("base64url");
}
