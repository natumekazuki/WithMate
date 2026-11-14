import { createHash } from "node:crypto";
import type { ProviderAgentRuntimeBindingProjection } from "./agent-runtime-binding.js";
import { WITHMATE_MANAGED_MCP_TOKEN_ENV } from "./managed-http-mcp.js";
import {
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV,
  WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV,
  WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV,
  WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV,
  WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV,
} from "../../src-shared/agent-runtime/agent-runtime-binding-contract.js";

export {
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV,
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_HEADER,
  WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV,
  WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV,
  WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV,
  WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV,
} from "../../src-shared/agent-runtime/agent-runtime-binding-contract.js";

export type ProviderAgentRuntimeBindingCapability = {
  providerId: string;
  transport: "env" | "unsupported";
};

export const PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER = "[WITHMATE_BINDING_REFERENCE_REDACTED]";

export type ProviderAgentRuntimeBindingRedactor = {
  sanitizeText: (value: string, previewLimit?: number) => string;
  sanitize: <T>(value: T) => T;
};

/**
 * Sanitizes projection copies only. Raw provider events must remain untouched
 * until lifecycle/control handling has completed.
 */
export function createProviderAgentRuntimeBindingRedactor(
  projection: ProviderAgentRuntimeBindingProjection | null | undefined,
  additionalSecrets: readonly string[] = [],
): ProviderAgentRuntimeBindingRedactor {
  const secrets = [
    ...(projection?.transport === "env" ? [projection.bindingReference, projection.turnCapability ?? ""] : []),
    projection?.managedMcp?.token ?? "",
    ...additionalSecrets,
  ].filter((value) => value.length > 0);
  const maxSecretLength = Math.max(0, ...secrets.map((secret) => secret.length));
  const secretPattern = secrets.length > 0
    ? new RegExp([...secrets].sort((left, right) => right.length - left.length)
      .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
    : null;
  const sanitizeText = (value: string, previewLimit?: number): string => {
    if (previewLimit === undefined) {
      return secrets.reduce(
        (current, secret) => current.split(secret).join(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER),
        value,
      );
    }
    const limit = Math.max(0, previewLimit);
    if (!secretPattern || limit === 0) return value.slice(0, limit);
    // Look beyond the raw preview boundary only far enough to recognize a
    // complete secret whose prefix would otherwise survive truncation.
    const bounded = value.slice(0, limit + maxSecretLength - 1);
    const parts: string[] = [];
    let cursor = 0;
    for (const match of bounded.matchAll(secretPattern)) {
      if (match.index >= limit) break;
      parts.push(bounded.slice(cursor, match.index), PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER);
      cursor = match.index + match[0].length;
    }
    parts.push(bounded.slice(cursor, Math.max(cursor, limit)));
    return parts.join("");
  };
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
    transport: providerId === "codex" || providerId === "copilot" || providerId === "claude" || providerId === "opencode" ? "env" : "unsupported",
  };
}

export function buildProviderAgentRuntimeBindingEnv(
  projection: ProviderAgentRuntimeBindingProjection | null | undefined,
): Record<string, string> {
  const runtimeOwner = projection?.runtimeOwner;
  const runtimeApplicationInstanceId = runtimeOwner?.applicationInstanceId?.trim();
  const runtimeGenerationId = runtimeOwner?.runtimeGenerationId?.trim();
  return projection?.transport === "env"
      ? {
        [WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV]: projection.bindingReference,
        [WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV]: "1",
        ...(projection.providerId === "codex" && projection.managedMcp
          ? { [WITHMATE_MANAGED_MCP_TOKEN_ENV]: projection.managedMcp.token }
          : {}),
        ...(projection.turnCapability
          ? { [WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV]: projection.turnCapability }
          : {}),
        ...(runtimeApplicationInstanceId && runtimeGenerationId
          ? {
            [WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV]: runtimeApplicationInstanceId,
            [WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV]: runtimeGenerationId,
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
  const runtimeOwner = projection.runtimeOwner;
  return JSON.stringify([
    projection.bindingId,
    projection.providerId,
    projection.executionGeneration,
    projection.expiresAt,
    projection.turnCapability
      ? createHash("sha256").update(projection.turnCapability, "utf8").digest("base64url")
      : null,
    runtimeOwner?.applicationInstanceId ?? null,
    runtimeOwner?.runtimeGenerationId ?? null,
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
  const runtimeApplicationInstanceIdKey = WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV.toLowerCase();
  const runtimeGenerationIdKey = WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV.toLowerCase();
  for (const [key, value] of Object.entries(baseEnv)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey !== bindingReferenceKey
      && normalizedKey !== bindingRequiredKey
      && normalizedKey !== turnCapabilityKey
      && normalizedKey !== runtimeApplicationInstanceIdKey
      && normalizedKey !== runtimeGenerationIdKey
      && normalizedKey !== WITHMATE_MANAGED_MCP_TOKEN_ENV.toLowerCase()
      && value !== undefined
    ) {
      merged[key] = value;
    }
  }
  return { ...merged, ...overlay };
}
