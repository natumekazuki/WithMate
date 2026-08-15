import type { ProviderAgentRuntimeBindingProjection } from "./agent-runtime-binding.js";
import {
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV,
  WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV,
} from "../src/agent-runtime/agent-runtime-binding-contract.js";

export {
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV,
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_HEADER,
  WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV,
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

/**
 * Sanitizes projection copies only. Raw provider events must remain untouched
 * until lifecycle/control handling has completed.
 */
export function createProviderAgentRuntimeBindingRedactor(
  projection: ProviderAgentRuntimeBindingProjection | null | undefined,
): ProviderAgentRuntimeBindingRedactor {
  const reference = projection?.transport === "env" ? projection.bindingReference : "";
  const sanitizeText = (value: string): string =>
    reference.length > 0 ? value.split(reference).join(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER) : value;
  const sanitize = <T>(value: T): T => {
    if (reference.length === 0) {
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
  return projection?.transport === "env"
    ? {
        [WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV]: projection.bindingReference,
        [WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV]: "1",
      }
    : {};
}

export function buildProviderAgentRuntimeBindingCacheKey(
  projection: ProviderAgentRuntimeBindingProjection | null | undefined,
): string {
  if (!projection || projection.transport === "unsupported") {
    return "";
  }
  return JSON.stringify([
    projection.bindingId,
    projection.providerId,
    projection.executionGeneration,
    projection.expiresAt,
  ]);
}

export function mergeDefinedProviderEnv(
  baseEnv: NodeJS.ProcessEnv,
  overlay: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  const bindingReferenceKey = WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV.toLowerCase();
  const bindingRequiredKey = WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV.toLowerCase();
  for (const [key, value] of Object.entries(baseEnv)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey !== bindingReferenceKey && normalizedKey !== bindingRequiredKey && value !== undefined) {
      merged[key] = value;
    }
  }
  return { ...merged, ...overlay };
}
