import { createHmac } from "node:crypto";

export const WITHMATE_AGENT_RUNTIME_NONCE_HEADER = "x-withmate-agent-runtime-nonce";
export const WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_HEADER = "x-withmate-agent-runtime-application-instance";
export const WITHMATE_AGENT_RUNTIME_GENERATION_HEADER = "x-withmate-agent-runtime-generation";
export const WITHMATE_AGENT_RUNTIME_CHALLENGE_HEADER = "x-withmate-agent-runtime-challenge";
export const WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH = "/v1/agent-runtime-extension-exchange";
export const WITHMATE_AGENT_RUNTIME_EXTENSION_MAX_BODY_BYTES = 34 * 1024 * 1024;
export const WITHMATE_AGENT_RUNTIME_EXCHANGE_SCHEMA_VERSION = "withmate-agent-runtime-exchange-v1";

export function createAgentRuntimeChallenge(apiSecret: string, runtimeGenerationId: string, nonce: string): string {
  return createHmac("sha256", apiSecret).update(`${runtimeGenerationId}\n${nonce}`, "utf8").digest("base64url");
}

export function createAgentRuntimeOwnerChallenge(apiSecret: string, applicationInstanceId: string, runtimeGenerationId: string, nonce: string): string {
  return createHmac("sha256", apiSecret).update(`${applicationInstanceId}\n${runtimeGenerationId}\n${nonce}`, "utf8").digest("base64url");
}
