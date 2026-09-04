import { createHash } from "node:crypto";
import type { ProviderAgentRuntimeBindingProjection } from "./agent-runtime-binding.js";
import type { ProviderAgentRuntimeAuthoritySnapshot } from "../src/agent-runtime/agent-runtime-binding-contract.js";
import {
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV,
  WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV,
  WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV,
  WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV,
  WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV,
} from "../src/agent-runtime/agent-runtime-binding-contract.js";

export {
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV,
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_HEADER,
  WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV,
  WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV,
  WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV,
  WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV,
} from "../src/agent-runtime/agent-runtime-binding-contract.js";

export type ProviderAgentRuntimeBindingCapability = {
  providerId: string;
  transport: "env" | "unsupported";
};

export const PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER = "[WITHMATE_BINDING_REFERENCE_REDACTED]";

export type ProviderAgentRuntimeBindingRedactor = {
  sanitizeText: (value: string) => string;
  sanitize: <T>(value: T) => T;
};

export type ProviderAgentRuntimeAuthoritySnapshotInput = {
  characterId: string | null | undefined;
  workspacePath: string | null | undefined;
  resolveCanonicalProjectId: (workspacePath: string) => string | null | undefined;
};

/**
 * Builds the canonical actor authority snapshot from the bound Session only.
 * Project resolution is deliberately fail-closed: an unknown workspace grants
 * no project target rather than inventing an identifier.
 */
export function buildProviderAgentRuntimeAuthoritySnapshot(
  input: ProviderAgentRuntimeAuthoritySnapshotInput,
): ProviderAgentRuntimeAuthoritySnapshot | null {
  const characterId = input.characterId?.trim() ?? "";
  if (!characterId) {
    return null;
  }
  const workspacePath = input.workspacePath?.trim() ?? "";
  const resolvedProjectId = workspacePath ? input.resolveCanonicalProjectId(workspacePath)?.trim() ?? "" : "";
  const allowedProjectIds = resolvedProjectId ? [resolvedProjectId] : [];
  return {
    userId: "local-user",
    characterId,
    allowedProjectIds,
  };
}

/**
 * Sanitizes projection copies only. Raw provider events must remain untouched
 * until lifecycle/control handling has completed.
 */
export function createProviderAgentRuntimeBindingRedactor(
  projection: ProviderAgentRuntimeBindingProjection | null | undefined,
): ProviderAgentRuntimeBindingRedactor {
  const secrets = projection?.transport === "env"
    ? [projection.bindingReference, projection.turnCapability ?? ""].filter((value) => value.length > 0)
    : [];
  const sanitizeText = (value: string): string => secrets.reduce(
    (current, secret) => current.split(secret).join(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER),
    value,
  );
  const sanitize = <T>(value: T): T => {
    if (secrets.length === 0) {
      return value;
    }
    const visit = (candidate: unknown): unknown => {
      if (typeof candidate === "string") {
        return sanitizeText(candidate);
      }
      if (Array.isArray(candidate)) {
        return candidate.map((entry) => visit(entry));
      }
      if (candidate && typeof candidate === "object") {
        const output: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(candidate)) {
          output[sanitizeText(key)] = visit(entry);
        }
        return output;
      }
      return candidate;
    };
    return visit(value) as T;
  };
  return { sanitizeText, sanitize };
}

export function getProviderAgentRuntimeBindingCapability(
  providerId: string,
): ProviderAgentRuntimeBindingCapability {
  return {
    providerId,
    transport: providerId === "codex" || providerId === "copilot" ? "env" : "unsupported",
  };
}

export function buildProviderAgentRuntimeBindingEnv(
  projection: ProviderAgentRuntimeBindingProjection | null | undefined,
): Record<string, string> {
  const memoryOwner = projection?.memoryRuntimeOwner;
  const memoryApplicationInstanceId = memoryOwner?.applicationInstanceId?.trim();
  const memoryGenerationId = memoryOwner?.runtimeGenerationId?.trim();
  return projection?.transport === "env"
      ? {
        [WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV]: projection.bindingReference,
        [WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV]: "1",
        ...(projection.turnCapability
          ? { [WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV]: projection.turnCapability }
          : {}),
        ...(memoryApplicationInstanceId && memoryGenerationId
          ? {
            [WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV]: memoryApplicationInstanceId,
            [WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV]: memoryGenerationId,
          }
          : {}),
      }
    : {};
}

export function buildProviderAgentRuntimeBindingCacheKey(
  projection: ProviderAgentRuntimeBindingProjection | null | undefined,
): string {
  if (!projection || projection.transport === "unsupported") {
    return "";
  }
  const memoryOwner = projection.memoryRuntimeOwner;
  return JSON.stringify([
    projection.bindingId,
    projection.providerId,
    projection.executionGeneration,
    projection.expiresAt,
    projection.turnCapability
      ? createHash("sha256").update(projection.turnCapability, "utf8").digest("base64url")
      : null,
    memoryOwner?.applicationInstanceId ?? null,
    memoryOwner?.runtimeGenerationId ?? null,
  ]);
}

export function mergeDefinedProviderEnv(
  baseEnv: NodeJS.ProcessEnv,
  overlay: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  const bindingReferenceKey = WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV.toLowerCase();
  const bindingRequiredKey = WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV.toLowerCase();
  const turnCapabilityKey = WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV.toLowerCase();
  const memoryApplicationInstanceIdKey = WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV.toLowerCase();
  const memoryGenerationIdKey = WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV.toLowerCase();
  for (const [key, value] of Object.entries(baseEnv)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey !== bindingReferenceKey
      && normalizedKey !== bindingRequiredKey
      && normalizedKey !== turnCapabilityKey
      && normalizedKey !== memoryApplicationInstanceIdKey
      && normalizedKey !== memoryGenerationIdKey
      && value !== undefined
    ) {
      merged[key] = value;
    }
  }
  return { ...merged, ...overlay };
}
