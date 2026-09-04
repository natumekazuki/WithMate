import type { SessionRuntimeAdapterKind } from "./session-external-runtime-contract.js";
import type { RuntimeDiscoveryCredentialEnvelope } from "./runtime-discovery/runtime-discovery-contract.js";

export const SESSION_RUNTIME_KIND = "session" as const;
export const SESSION_RUNTIME_CREDENTIAL_SCHEMA_VERSION = "withmate-session-runtime-credential-v1" as const;
export const WITHMATE_SESSION_RUNTIME_APPLICATION_INSTANCE_ID_ENV =
  "WITHMATE_SESSION_RUNTIME_APPLICATION_INSTANCE_ID" as const;
export const WITHMATE_SESSION_RUNTIME_GENERATION_ID_ENV =
  "WITHMATE_SESSION_RUNTIME_GENERATION_ID" as const;

export type SessionRuntimeCredential = {
  schemaVersion: typeof SESSION_RUNTIME_CREDENTIAL_SCHEMA_VERSION;
  baseUrl: string;
  apiSecret: string;
  adapterSecret: string;
};

export type SessionRuntimeCredentialEnvelope = RuntimeDiscoveryCredentialEnvelope<SessionRuntimeCredential> & {
  runtimeKind: typeof SESSION_RUNTIME_KIND;
  adapterKind: SessionRuntimeAdapterKind;
};

export function parseSessionRuntimeCredentialEnvelope(
  serialized: string,
  identity: { applicationInstanceId: string; runtimeKind: string; runtimeGenerationId: string },
  adapter: SessionRuntimeAdapterKind,
): SessionRuntimeCredentialEnvelope | null {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)
    || !hasExactKeys(value, ["schemaVersion", "applicationInstanceId", "runtimeKind", "adapterKind", "runtimeGenerationId", "credential"])
    || value.schemaVersion !== "withmate-runtime-credential-v1"
    || value.applicationInstanceId !== identity.applicationInstanceId
    || value.runtimeKind !== SESSION_RUNTIME_KIND
    || value.runtimeKind !== identity.runtimeKind
    || value.adapterKind !== adapter
    || value.runtimeGenerationId !== identity.runtimeGenerationId
    || !isRecord(value.credential)
    || !hasExactKeys(value.credential, ["schemaVersion", "baseUrl", "apiSecret", "adapterSecret"])
    || value.credential.schemaVersion !== SESSION_RUNTIME_CREDENTIAL_SCHEMA_VERSION
    || typeof value.credential.baseUrl !== "string"
    || typeof value.credential.apiSecret !== "string"
    || typeof value.credential.adapterSecret !== "string") {
    return null;
  }
  return value as SessionRuntimeCredentialEnvelope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}
