export type ModelReasoningEffort = string;

export type ModelCatalogItem = {
  id: string;
  label: string;
  sourceLabel?: string;
  reasoningEfforts: ModelReasoningEffort[];
  defaultReasoningEffort?: ModelReasoningEffort;
};

export type ModelCatalogProvider = {
  id: string;
  label: string;
  defaultModelId: string;
  defaultReasoningEffort: ModelReasoningEffort;
  models: ModelCatalogItem[];
};

export type ModelCatalogSnapshot = {
  workspacePath?: string;
  providers: ModelCatalogProvider[];
  discovery?: Record<string, {
    status: "idle" | "loading" | "ready" | "error";
    fetchedAt?: string;
    error?: string;
  }>;
};

export type ModelCatalogRequest = {
  providerId?: string;
  workspacePath?: string;
};

export type ResolvedModelSelection = {
  requestedModel: string;
  resolvedModel: string;
  requestedReasoningEffort: ModelReasoningEffort;
  resolvedReasoningEffort: ModelReasoningEffort;
};

export const DEFAULT_PROVIDER_ID = "codex";
export const DEFAULT_MODEL_ID = "";
export const DEFAULT_REASONING_EFFORT: ModelReasoningEffort = "";

export const reasoningEffortOptions = [
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "X High" },
  { id: "max", label: "Max" },
  { id: "ultra", label: "Ultra" },
] as const;

export function isModelReasoningEffort(value: unknown): value is ModelReasoningEffort {
  return typeof value === "string";
}

export function normalizeProviderId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim() === "Codex") {
    return DEFAULT_PROVIDER_ID;
  }
  return value.trim();
}

export function cloneModelCatalogSnapshot(snapshot: ModelCatalogSnapshot): ModelCatalogSnapshot {
  return structuredClone(snapshot);
}

export function getDefaultProviderCatalog(providers: readonly ModelCatalogProvider[]): ModelCatalogProvider | null {
  return providers.find((provider) => provider.id === DEFAULT_PROVIDER_ID) ?? null;
}

export function getProviderCatalog(
  providers: readonly ModelCatalogProvider[],
  providerId: string | null | undefined,
): ModelCatalogProvider | null {
  return providers.find((provider) => provider.id === normalizeProviderId(providerId)) ?? null;
}

export function getModelCatalogItem(providerCatalog: ModelCatalogProvider, model: string): ModelCatalogItem | null {
  return providerCatalog.models.find((entry) => entry.id === model) ?? null;
}

export function getReasoningEffortOptionsForModel(
  providerCatalog: ModelCatalogProvider,
  model: string,
): readonly ModelReasoningEffort[] {
  return getModelCatalogItem(providerCatalog, model)?.reasoningEfforts ?? [];
}

export function reasoningEffortLabel(reasoningEffort: ModelReasoningEffort): string {
  return reasoningEffortOptions.find((option) => option.id === reasoningEffort)?.label ?? reasoningEffort;
}

export function coerceModelSelection(
  _providerCatalog: ModelCatalogProvider,
  requestedModel: string,
  requestedReasoningEffort: ModelReasoningEffort,
): ResolvedModelSelection {
  return {
    requestedModel,
    resolvedModel: requestedModel,
    requestedReasoningEffort,
    resolvedReasoningEffort: requestedReasoningEffort,
  };
}

export function resolveModelChangeSelection(
  providerCatalog: ModelCatalogProvider,
  requestedModel: string,
  requestedReasoningEffort: ModelReasoningEffort,
): ResolvedModelSelection {
  const model = getModelCatalogItem(providerCatalog, requestedModel);
  if (!model) {
    throw new Error("The selected model is not in the discovered model list.");
  }
  return resolveModelItemChangeSelection(model, requestedReasoningEffort);
}

export function resolveModelItemChangeSelection(
  model: ModelCatalogItem,
  requestedReasoningEffort: ModelReasoningEffort,
): ResolvedModelSelection {
  return {
    requestedModel: model.id,
    resolvedModel: model.id,
    requestedReasoningEffort,
    resolvedReasoningEffort: model.reasoningEfforts.length === 0
      ? ""
      : model.reasoningEfforts.includes(requestedReasoningEffort)
        ? requestedReasoningEffort
        : model.defaultReasoningEffort ?? "",
  };
}

export function resolveModelSelection(
  providerCatalog: ModelCatalogProvider,
  requestedModel: string,
  requestedReasoningEffort: ModelReasoningEffort,
): ResolvedModelSelection {
  if (!requestedModel.trim()) {
    throw new Error("A model must be selected before running.");
  }
  return coerceModelSelection(providerCatalog, requestedModel, requestedReasoningEffort);
}
