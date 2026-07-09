import type { ModelCatalogItem, ModelCatalogProvider, ModelReasoningEffort } from "./model-catalog.js";
import { modelDisplayLabel, modelOptionLabel, reasoningDepthLabel } from "./ui-utils.js";

export type ModelSelectOption = {
  value: string;
  label: string;
};

export type ReasoningEffortSelectOption = {
  value: ModelReasoningEffort;
  label: string;
};

export function buildModelSelectOptions(
  models: readonly ModelCatalogItem[],
  selectedModelId = "",
): ModelSelectOption[] {
  const options = models.map((model) => ({
    value: model.id,
    label: modelOptionLabel(model),
  }));
  if (selectedModelId && !options.some((option) => option.value === selectedModelId)) {
    options.unshift({ value: selectedModelId, label: selectedModelId });
  }

  return options;
}

export function resolveModelFallbackLabel(
  providerCatalog: ModelCatalogProvider | null | undefined,
  modelId: string,
): string {
  return modelDisplayLabel(providerCatalog ?? null, modelId);
}

export function buildReasoningEffortSelectOptions(
  reasoningEfforts: readonly ModelReasoningEffort[],
): ReasoningEffortSelectOption[] {
  return reasoningEfforts.map((reasoningEffort) => ({
    value: reasoningEffort,
    label: reasoningDepthLabel(reasoningEffort),
  }));
}
