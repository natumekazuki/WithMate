import type { ModelCatalogItem, ModelCatalogProvider, ModelReasoningEffort } from "../../src-shared/settings/model-catalog.js";
import { modelDisplayLabel, modelOptionLabel, reasoningDepthLabel } from "../ui/ui-utils.js";

export type ModelSelectOption = {
  value: string;
  label: string;
  sourceLabel?: string;
};

export type ReasoningEffortSelectOption = {
  value: ModelReasoningEffort;
  label: string;
};

export function buildModelSelectOptions(
  models: readonly ModelCatalogItem[],
  selectedModelId = "",
): ModelSelectOption[] {
  const options: ModelSelectOption[] = models.map((model) => ({
    value: model.id,
    label: modelOptionLabel(model),
    ...(model.sourceLabel ? { sourceLabel: model.sourceLabel } : {}),
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
    label: reasoningEffort ? reasoningDepthLabel(reasoningEffort) : "Default",
  }));
}
