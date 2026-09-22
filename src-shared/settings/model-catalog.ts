export type ModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type ModelCatalogItem = {
  id: string;
  label: string;
  reasoningEfforts: ModelReasoningEffort[];
};

export type ModelCatalogProvider = {
  id: string;
  label: string;
  defaultModelId: string;
  defaultReasoningEffort: ModelReasoningEffort;
  models: ModelCatalogItem[];
};

export type ModelCatalogDocument = {
  providers: ModelCatalogProvider[];
};

export type ModelCatalogSnapshot = {
  revision: number;
  providers: ModelCatalogProvider[];
};

export type ResolvedModelSelection = {
  requestedModel: string;
  resolvedModel: string;
  requestedReasoningEffort: ModelReasoningEffort;
  resolvedReasoningEffort: ModelReasoningEffort;
};

export const MODEL_REASONING_EFFORTS: readonly ModelReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
const REASONING_EFFORT_ORDER = MODEL_REASONING_EFFORTS;
const REASONING_EFFORT_SET = new Set<ModelReasoningEffort>(REASONING_EFFORT_ORDER);

export const DEFAULT_PROVIDER_ID = "codex";
export const DEFAULT_MODEL_ID = "gpt-5.4";
export const DEFAULT_REASONING_EFFORT: ModelReasoningEffort = "high";
export const DEFAULT_CATALOG_REVISION = 1;

export const reasoningEffortOptions = [
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
  { id: "max", label: "Max" },
  { id: "ultra", label: "Ultra" },
] as const satisfies ReadonlyArray<{ id: ModelReasoningEffort; label: string }>;

export function isModelReasoningEffort(value: unknown): value is ModelReasoningEffort {
  return typeof value === "string" && REASONING_EFFORT_SET.has(value as ModelReasoningEffort);
}

function normalizeNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} cannot be empty.`);
  }

  return value.trim();
}

function normalizeReasoningEffort(value: unknown, fieldName: string): ModelReasoningEffort {
  if (!isModelReasoningEffort(value)) {
    throw new Error(`${fieldName} is invalid.`);
  }

  return value;
}

function normalizeReasoningEfforts(value: unknown, fieldName: string): ModelReasoningEffort[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${fieldName} must contain at least one item.`);
  }

  const efforts = Array.from(new Set(value.map((entry, index) => normalizeReasoningEffort(entry, `${fieldName}[${index}]`))));
  if (efforts.length === 0) {
    throw new Error(`${fieldName} must contain at least one item.`);
  }

  return efforts;
}

function normalizeModelCatalogItem(value: unknown, index: number): ModelCatalogItem {
  if (!value || typeof value !== "object") {
    throw new Error(`models[${index}] is invalid.`);
  }

  const candidate = value as Partial<ModelCatalogItem>;
  return {
    id: normalizeNonEmptyString(candidate.id, `models[${index}].id`),
    label: normalizeNonEmptyString(candidate.label, `models[${index}].label`),
    reasoningEfforts: normalizeReasoningEfforts(candidate.reasoningEfforts, `models[${index}].reasoningEfforts`),
  };
}

function normalizeProviderCatalog(value: unknown, index: number): ModelCatalogProvider {
  if (!value || typeof value !== "object") {
    throw new Error(`providers[${index}] is invalid.`);
  }

  const candidate = value as Partial<ModelCatalogProvider>;
  if (!Array.isArray(candidate.models) || candidate.models.length === 0) {
    throw new Error(`providers[${index}].models must contain at least one item.`);
  }

  const models = candidate.models.map((model, modelIndex) => normalizeModelCatalogItem(model, modelIndex));
  const defaultModelId = normalizeNonEmptyString(candidate.defaultModelId, `providers[${index}].defaultModelId`);
  const defaultModel = models.find((model) => model.id === defaultModelId);
  if (!defaultModel) {
    throw new Error(`providers[${index}].defaultModelId is not present in models.`);
  }

  const defaultReasoningEffort = normalizeReasoningEffort(
    candidate.defaultReasoningEffort,
    `providers[${index}].defaultReasoningEffort`,
  );
  if (!defaultModel.reasoningEfforts.includes(defaultReasoningEffort)) {
    throw new Error(`providers[${index}].defaultReasoningEffort does not match defaultModel.`);
  }

  const modelIds = new Set<string>();
  for (const model of models) {
    if (modelIds.has(model.id)) {
      throw new Error(`Provider ${candidate.id ?? index} contains duplicate model IDs.`);
    }

    modelIds.add(model.id);
  }

  return {
    id: normalizeProviderId(candidate.id),
    label: normalizeNonEmptyString(candidate.label, `providers[${index}].label`),
    defaultModelId,
    defaultReasoningEffort,
    models,
  };
}

export function normalizeProviderId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    return DEFAULT_PROVIDER_ID;
  }

  const trimmed = value.trim();
  if (trimmed === "Codex") {
    return DEFAULT_PROVIDER_ID;
  }

  return trimmed;
}

export function parseModelCatalogDocument(value: unknown): ModelCatalogDocument {
  if (!value || typeof value !== "object") {
    throw new Error("Model catalog JSON is invalid. `providers` is required." );
  }

  const candidate = value as Partial<ModelCatalogDocument>;
  if (!Array.isArray(candidate.providers) || candidate.providers.length === 0) {
    throw new Error("Model catalog JSON must contain at least one provider.");
  }

  return {
    providers: candidate.providers.map((provider, index) => normalizeProviderCatalog(provider, index)),
  };
}

export function cloneModelCatalogDocument(document: ModelCatalogDocument): ModelCatalogDocument {
  return JSON.parse(JSON.stringify(document)) as ModelCatalogDocument;
}

export function cloneModelCatalogSnapshot(snapshot: ModelCatalogSnapshot): ModelCatalogSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as ModelCatalogSnapshot;
}

export function getDefaultProviderCatalog(providers: readonly ModelCatalogProvider[]): ModelCatalogProvider | null {
  return providers.find((provider) => provider.id === DEFAULT_PROVIDER_ID) ?? providers[0] ?? null;
}

export function getProviderCatalog(
  providers: readonly ModelCatalogProvider[],
  providerId: string | null | undefined,
): ModelCatalogProvider | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  return providers.find((provider) => provider.id === normalizedProviderId) ?? getDefaultProviderCatalog(providers);
}

export function getModelCatalogItem(providerCatalog: ModelCatalogProvider, model: string): ModelCatalogItem | null {
  const normalizedModel = typeof model === "string" && model.trim() ? model.trim() : providerCatalog.defaultModelId;
  return providerCatalog.models.find((entry) => entry.id === normalizedModel) ?? null;
}

export function getReasoningEffortOptionsForModel(
  providerCatalog: ModelCatalogProvider,
  model: string,
): readonly ModelReasoningEffort[] {
  return getModelCatalogItem(providerCatalog, model)?.reasoningEfforts ??
    getModelCatalogItem(providerCatalog, providerCatalog.defaultModelId)?.reasoningEfforts ??
    [providerCatalog.defaultReasoningEffort];
}

export function reasoningEffortLabel(reasoningEffort: ModelReasoningEffort): string {
  return reasoningEffortOptions.find((option) => option.id === reasoningEffort)?.label ?? reasoningEffort;
}

function clampReasoningEffort(
  requestedReasoningEffort: ModelReasoningEffort,
  allowedEfforts: readonly ModelReasoningEffort[],
): ModelReasoningEffort {
  if (allowedEfforts.includes(requestedReasoningEffort)) {
    return requestedReasoningEffort;
  }

  throw new Error("The selected reasoning effort does not match the model catalog definition.");
}

function fallbackReasoningEffort(
  providerCatalog: ModelCatalogProvider,
  allowedEfforts: readonly ModelReasoningEffort[],
): ModelReasoningEffort {
  if (allowedEfforts.includes(providerCatalog.defaultReasoningEffort)) {
    return providerCatalog.defaultReasoningEffort;
  }

  return allowedEfforts[0] ?? providerCatalog.defaultReasoningEffort;
}

export function coerceModelSelection(
  providerCatalog: ModelCatalogProvider,
  requestedModel: string,
  requestedReasoningEffort: ModelReasoningEffort,
): ResolvedModelSelection {
  const normalizedModel = typeof requestedModel === "string" && requestedModel.trim()
    ? requestedModel.trim()
    : providerCatalog.defaultModelId;
  const resolvedEntry =
    providerCatalog.models.find((entry) => entry.id === normalizedModel) ??
    providerCatalog.models.find((entry) => entry.id === providerCatalog.defaultModelId) ??
    providerCatalog.models[0];
  if (!resolvedEntry) {
  throw new Error("The selected model is not in the model catalog.");
  }

  return {
    requestedModel: normalizedModel,
    resolvedModel: resolvedEntry.id,
    requestedReasoningEffort,
    resolvedReasoningEffort: resolvedEntry.reasoningEfforts.includes(requestedReasoningEffort)
      ? requestedReasoningEffort
      : fallbackReasoningEffort(providerCatalog, resolvedEntry.reasoningEfforts),
  };
}

export function resolveModelChangeSelection(
  providerCatalog: ModelCatalogProvider,
  requestedModel: string,
  requestedReasoningEffort: ModelReasoningEffort,
): ResolvedModelSelection {
  const normalizedModel = typeof requestedModel === "string" && requestedModel.trim()
    ? requestedModel.trim()
    : providerCatalog.defaultModelId;
  const exactEntry = providerCatalog.models.find((entry) => entry.id === normalizedModel);
  if (!exactEntry) {
  throw new Error("The selected model is not in the model catalog.");
  }

  return {
    requestedModel: normalizedModel,
    resolvedModel: exactEntry.id,
    requestedReasoningEffort,
    resolvedReasoningEffort: exactEntry.reasoningEfforts.includes(requestedReasoningEffort)
      ? requestedReasoningEffort
      : fallbackReasoningEffort(providerCatalog, exactEntry.reasoningEfforts),
  };
}

export function resolveModelSelection(
  providerCatalog: ModelCatalogProvider,
  requestedModel: string,
  requestedReasoningEffort: ModelReasoningEffort,
): ResolvedModelSelection {
  const normalizedModel = typeof requestedModel === "string" && requestedModel.trim()
    ? requestedModel.trim()
    : providerCatalog.defaultModelId;
  const exactEntry = providerCatalog.models.find((entry) => entry.id === normalizedModel);
  if (!exactEntry) {
  throw new Error("The selected model is not in the model catalog.");
  }

  return {
    requestedModel: normalizedModel,
    resolvedModel: exactEntry.id,
    requestedReasoningEffort,
    resolvedReasoningEffort: clampReasoningEffort(requestedReasoningEffort, exactEntry.reasoningEfforts),
  };
}
