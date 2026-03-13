export type ModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export type ModelCatalogItem = {
  id: string;
  label: string;
  reasoningEfforts: readonly ModelReasoningEffort[];
  aliases?: readonly string[];
  fallbackModelId?: string;
};

export type ResolvedModelSelection = {
  requestedModel: string;
  resolvedModel: string;
  requestedReasoningEffort: ModelReasoningEffort;
  resolvedReasoningEffort: ModelReasoningEffort;
};

const REASONING_EFFORT_ORDER: readonly ModelReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];

export const DEFAULT_MODEL_ID = "gpt-5.4";
export const DEFAULT_REASONING_EFFORT: ModelReasoningEffort = "high";

export const bundledModelCatalog: readonly ModelCatalogItem[] = [
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    reasoningEfforts: ["minimal", "low", "medium", "high"],
  },
  {
    id: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    aliases: ["gpt-5.1-codex-mini"],
  },
  {
    id: "gpt-5.2-codex",
    label: "GPT-5.2 Codex",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    aliases: ["gpt-5.1-codex-max"],
  },
] as const;

export const reasoningEffortOptions = [
  { id: "minimal", label: "最小" },
  { id: "low", label: "低" },
  { id: "medium", label: "中" },
  { id: "high", label: "高" },
  { id: "xhigh", label: "最高" },
] as const satisfies ReadonlyArray<{ id: ModelReasoningEffort; label: string }>;

function normalizeModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_MODEL_ID;
}

function getCatalogEntryByExactId(model: string): ModelCatalogItem | null {
  return bundledModelCatalog.find((entry) => entry.id === model) ?? null;
}

function getCatalogEntryByAlias(model: string): ModelCatalogItem | null {
  return bundledModelCatalog.find((entry) => entry.aliases?.includes(model)) ?? null;
}

export function getModelCatalogItem(model: string): ModelCatalogItem | null {
  const normalized = normalizeModelId(model);
  return getCatalogEntryByExactId(normalized) ?? getCatalogEntryByAlias(normalized);
}

export function isBundledModel(model: string): boolean {
  return getCatalogEntryByExactId(normalizeModelId(model)) !== null;
}

export function getReasoningEffortOptionsForModel(model: string): readonly ModelReasoningEffort[] {
  return getModelCatalogItem(model)?.reasoningEfforts ?? bundledModelCatalog[0].reasoningEfforts;
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

  const requestedIndex = REASONING_EFFORT_ORDER.indexOf(requestedReasoningEffort);
  for (let index = requestedIndex; index >= 0; index -= 1) {
    const candidate = REASONING_EFFORT_ORDER[index];
    if (allowedEfforts.includes(candidate)) {
      return candidate;
    }
  }

  return allowedEfforts[0] ?? DEFAULT_REASONING_EFFORT;
}

export function resolveModelSelection(
  requestedModel: string,
  requestedReasoningEffort: ModelReasoningEffort,
): ResolvedModelSelection {
  const normalizedModel = normalizeModelId(requestedModel);
  const exactEntry = getCatalogEntryByExactId(normalizedModel);
  const aliasedEntry = exactEntry ? null : getCatalogEntryByAlias(normalizedModel);
  const resolvedModel = exactEntry?.id ?? aliasedEntry?.id ?? normalizedModel;
  const allowedEfforts = (exactEntry ?? aliasedEntry)?.reasoningEfforts;

  return {
    requestedModel: normalizedModel,
    resolvedModel,
    requestedReasoningEffort,
    resolvedReasoningEffort: allowedEfforts
      ? clampReasoningEffort(requestedReasoningEffort, allowedEfforts)
      : requestedReasoningEffort,
  };
}

export function didModelSelectionFallback(selection: ResolvedModelSelection): boolean {
  return (
    selection.requestedModel !== selection.resolvedModel ||
    selection.requestedReasoningEffort !== selection.resolvedReasoningEffort
  );
}
