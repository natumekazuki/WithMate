export type ModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

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

const REASONING_EFFORT_ORDER: readonly ModelReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
const REASONING_EFFORT_SET = new Set<ModelReasoningEffort>(REASONING_EFFORT_ORDER);

export const DEFAULT_PROVIDER_ID = "codex";
export const DEFAULT_MODEL_ID = "gpt-5.4";
export const DEFAULT_REASONING_EFFORT: ModelReasoningEffort = "high";
export const DEFAULT_CATALOG_REVISION = 1;

export const reasoningEffortOptions = [
  { id: "minimal", label: "minimal" },
  { id: "low", label: "low" },
  { id: "medium", label: "medium" },
  { id: "high", label: "high" },
  { id: "xhigh", label: "xhigh" },
] as const satisfies ReadonlyArray<{ id: ModelReasoningEffort; label: string }>;

function normalizeNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} は空にできないよ。`);
  }

  return value.trim();
}

function normalizeReasoningEffort(value: unknown, fieldName: string): ModelReasoningEffort {
  if (typeof value !== "string" || !REASONING_EFFORT_SET.has(value as ModelReasoningEffort)) {
    throw new Error(`${fieldName} が不正だよ。`);
  }

  return value as ModelReasoningEffort;
}

function normalizeReasoningEfforts(value: unknown, fieldName: string): ModelReasoningEffort[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${fieldName} は 1 件以上必要だよ。`);
  }

  const efforts = Array.from(new Set(value.map((entry, index) => normalizeReasoningEffort(entry, `${fieldName}[${index}]`))));
  if (efforts.length === 0) {
    throw new Error(`${fieldName} は 1 件以上必要だよ。`);
  }

  return efforts;
}

function normalizeModelCatalogItem(value: unknown, index: number): ModelCatalogItem {
  if (!value || typeof value !== "object") {
    throw new Error(`models[${index}] が不正だよ。`);
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
    throw new Error(`providers[${index}] が不正だよ。`);
  }

  const candidate = value as Partial<ModelCatalogProvider>;
  if (!Array.isArray(candidate.models) || candidate.models.length === 0) {
    throw new Error(`providers[${index}].models は 1 件以上必要だよ。`);
  }

  const models = candidate.models.map((model, modelIndex) => normalizeModelCatalogItem(model, modelIndex));
  const defaultModelId = normalizeNonEmptyString(candidate.defaultModelId, `providers[${index}].defaultModelId`);
  const defaultModel = models.find((model) => model.id === defaultModelId);
  if (!defaultModel) {
    throw new Error(`providers[${index}] の defaultModelId が models に存在しないよ。`);
  }

  const defaultReasoningEffort = normalizeReasoningEffort(
    candidate.defaultReasoningEffort,
    `providers[${index}].defaultReasoningEffort`,
  );
  if (!defaultModel.reasoningEfforts.includes(defaultReasoningEffort)) {
    throw new Error(`providers[${index}] の defaultReasoningEffort が defaultModel と噛み合ってないよ。`);
  }

  const modelIds = new Set<string>();
  for (const model of models) {
    if (modelIds.has(model.id)) {
      throw new Error(`provider ${candidate.id ?? index} に重複 model id があるよ。`);
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
    throw new Error("model catalog JSON の形式が不正だよ。`providers` が必要。" );
  }

  const candidate = value as Partial<ModelCatalogDocument>;
  if (!Array.isArray(candidate.providers) || candidate.providers.length === 0) {
    throw new Error("model catalog JSON には providers が 1 件以上必要だよ。");
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

  throw new Error("selected depth が model catalog の定義と一致してないよ。");
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
    throw new Error("selected model が model catalog に存在しないよ。");
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
    throw new Error("selected model が model catalog に存在しないよ。");
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
    throw new Error("selected model が model catalog に存在しないよ。");
  }

  return {
    requestedModel: normalizedModel,
    resolvedModel: exactEntry.id,
    requestedReasoningEffort,
    resolvedReasoningEffort: clampReasoningEffort(requestedReasoningEffort, exactEntry.reasoningEfforts),
  };
}
