import { createHmac } from "node:crypto";

export const SESSION_RUNTIME_API_SECRET_HEADER = "x-withmate-session-api-secret" as const;
export const SESSION_RUNTIME_ADAPTER_HEADER = "x-withmate-session-adapter" as const;
export const SESSION_RUNTIME_ADAPTER_SECRET_HEADER = "x-withmate-session-adapter-secret" as const;
export const SESSION_RUNTIME_INSTANCE_HEADER = "x-withmate-session-runtime-instance" as const;
export const SESSION_RUNTIME_NONCE_HEADER = "x-withmate-session-runtime-nonce" as const;
export const SESSION_RUNTIME_CHALLENGE_HEADER = "x-withmate-session-runtime-challenge" as const;
export const SESSION_RUNTIME_OPERATION_PATH = "/v1/operation" as const;

export function createSessionRuntimeChallenge(
  apiSecret: string,
  runtimeInstanceId: string,
  nonce: string,
): string {
  return createHmac("sha256", apiSecret)
    .update(`${runtimeInstanceId}\n${nonce}`, "utf8")
    .digest("base64url");
}
