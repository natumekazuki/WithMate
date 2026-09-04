import { createHmac } from "node:crypto";

import type {
  SessionRuntimeAdapterKind,
  SessionRuntimeRequestEnvelope,
} from "./session-external-runtime-contract.js";

export const SESSION_RUNTIME_APPLICATION_INSTANCE_HEADER = "x-withmate-session-runtime-application-instance" as const;
export const SESSION_RUNTIME_GENERATION_HEADER = "x-withmate-session-runtime-generation" as const;
export const SESSION_RUNTIME_NONCE_HEADER = "x-withmate-session-runtime-nonce" as const;
export const SESSION_RUNTIME_CHALLENGE_HEADER = "x-withmate-session-runtime-challenge" as const;
export const SESSION_RUNTIME_OPERATION_PATH = "/v1/operation" as const;
export const SESSION_RUNTIME_EXCHANGE_SCHEMA_VERSION = "withmate-session-exchange-v1" as const;

export type SessionRuntimeExchangePayload = {
  schemaVersion: typeof SESSION_RUNTIME_EXCHANGE_SCHEMA_VERSION;
  apiSecret: string;
  adapter: SessionRuntimeAdapterKind;
  adapterSecret: string;
  agentRuntimeBindingReference?: string;
  envelope: SessionRuntimeRequestEnvelope;
};

export function createSessionRuntimeChallenge(
  apiSecret: string,
  applicationInstanceId: string,
  runtimeGenerationId: string,
  nonce: string,
): string {
  return createHmac("sha256", apiSecret)
    .update(`${applicationInstanceId}\n${runtimeGenerationId}\n${nonce}`, "utf8")
    .digest("base64url");
}
