export const WITHMATE_MEMORY_BINDING_REFERENCE_ENV = "WITHMATE_MEMORY_BINDING_REFERENCE";
export const WITHMATE_MEMORY_BINDING_CONTEXT_FILE_ENV = "WITHMATE_MEMORY_BINDING_CONTEXT_FILE";
export const WITHMATE_MEMORY_BINDING_REFERENCE_HEADER = "x-withmate-memory-binding-reference";

export type ProviderMemoryBindingTransport = "env" | "context_file" | "unsupported";

export type ProviderMemoryBindingRuntimeProjection = {
  bindingId: string;
  bindingReference: string;
  transport: ProviderMemoryBindingTransport;
  contextFilePath?: string;
  expiresAt?: string | null;
};

export type ProviderMemoryBindingCapability = {
  providerId: string;
  transport: ProviderMemoryBindingTransport;
  reason: string;
};

export function getProviderMemoryBindingCapability(providerId: string): ProviderMemoryBindingCapability {
  if (providerId === "codex") {
    return {
      providerId,
      transport: "env",
      reason: "Codex SDK accepts process env at Codex client construction.",
    };
  }

  if (providerId === "copilot") {
    return {
      providerId,
      transport: "env",
      reason: "Copilot SDK accepts process env at CopilotClient construction.",
    };
  }

  return {
    providerId,
    transport: "unsupported",
    reason: "Provider binding transport has not been verified for this provider.",
  };
}

export function buildProviderMemoryBindingEnv(
  projection: ProviderMemoryBindingRuntimeProjection | null | undefined,
): Record<string, string> {
  if (!projection || projection.transport === "unsupported") {
    return {};
  }

  if (projection.transport === "context_file") {
    return projection.contextFilePath
      ? { [WITHMATE_MEMORY_BINDING_CONTEXT_FILE_ENV]: projection.contextFilePath }
      : {};
  }

  return {
    [WITHMATE_MEMORY_BINDING_REFERENCE_ENV]: projection.bindingReference,
  };
}

export function buildProviderMemoryBindingSettingsKey(
  projection: ProviderMemoryBindingRuntimeProjection | null | undefined,
): string {
  if (!projection) {
    return "";
  }

  return JSON.stringify([
    projection.transport,
    projection.bindingId,
    projection.contextFilePath ?? "",
    projection.expiresAt ?? "",
  ]);
}

export function mergeDefinedEnv(
  baseEnv: NodeJS.ProcessEnv,
  overlay: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (
      key === WITHMATE_MEMORY_BINDING_REFERENCE_ENV ||
      key === WITHMATE_MEMORY_BINDING_CONTEXT_FILE_ENV
    ) {
      continue;
    }
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return {
    ...merged,
    ...overlay,
  };
}
