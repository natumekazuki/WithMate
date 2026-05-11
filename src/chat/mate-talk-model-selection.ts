import type { ModelCatalogItem, ModelCatalogProvider, ModelCatalogSnapshot, ModelReasoningEffort } from "../model-catalog.js";
import { getProviderAppSettings, type AppSettings, type MateMemoryGenerationProviderSettings } from "../provider-settings-state.js";
import { modelOptionLabel } from "../ui-utils.js";

export type MateTalkModelOption = {
  value: string;
  label: string;
};

export type MateTalkReasoningOption = {
  value: ModelReasoningEffort;
  label: ModelReasoningEffort;
};

export type MateTalkModelSelection = {
  enabledProviders: ModelCatalogProvider[];
  defaultPriority: MateMemoryGenerationProviderSettings | null;
  providerCatalog: ModelCatalogProvider | null;
  selectedModel: ModelCatalogItem | null;
  modelOptions: MateTalkModelOption[];
  reasoningOptions: MateTalkReasoningOption[];
  providerId: string;
  model: string;
  reasoningEffort: ModelReasoningEffort;
};

export function buildMateTalkModelSelection({
  appSettings,
  modelCatalog,
  providerId,
  model,
  reasoningEffort,
}: {
  appSettings: AppSettings;
  modelCatalog: ModelCatalogSnapshot | null;
  providerId: string;
  model: string;
  reasoningEffort: ModelReasoningEffort;
}): MateTalkModelSelection {
  const enabledProviders = (modelCatalog?.providers ?? []).filter(
    (provider) => getProviderAppSettings(appSettings, provider.id).enabled,
  );
  const defaultPriority = appSettings.mateMemoryGenerationSettings.priorityList[0] ?? null;
  const preferredProviderId =
    enabledProviders.find((provider) => provider.id === defaultPriority?.provider)?.id ??
    enabledProviders[0]?.id ??
    "";
  const requestedProviderCatalog = enabledProviders.find((provider) => provider.id === providerId) ?? null;
  const providerCatalog =
    requestedProviderCatalog ??
    enabledProviders.find((provider) => provider.id === preferredProviderId) ??
    enabledProviders[0] ??
    null;
  const nextProviderId = providerCatalog?.id ?? "";
  const preferredModelId = nextProviderId === defaultPriority?.provider ? defaultPriority.model : "";
  const requestedModel = providerCatalog?.models.find((candidate) => candidate.id === model) ?? null;
  const selectedModel =
    requestedModel ??
    providerCatalog?.models.find((candidate) => candidate.id === preferredModelId) ??
    providerCatalog?.models.find((candidate) => candidate.id === providerCatalog.defaultModelId) ??
    providerCatalog?.models[0] ??
    null;
  const canKeepReasoningEffort =
    !!requestedProviderCatalog &&
    !!requestedModel &&
    !!selectedModel?.reasoningEfforts.includes(reasoningEffort);
  const nextReasoningEffort =
    canKeepReasoningEffort
      ? reasoningEffort
      : nextProviderId === defaultPriority?.provider && selectedModel?.reasoningEfforts.includes(defaultPriority.reasoningEffort)
      ? defaultPriority.reasoningEffort
      : selectedModel?.reasoningEfforts.includes(providerCatalog?.defaultReasoningEffort ?? "low")
        ? providerCatalog?.defaultReasoningEffort ?? "low"
        : selectedModel?.reasoningEfforts[0] ?? "low";

  return {
    enabledProviders,
    defaultPriority,
    providerCatalog,
    selectedModel,
    modelOptions: providerCatalog?.models.map((candidate) => ({ value: candidate.id, label: modelOptionLabel(candidate) })) ?? [],
    reasoningOptions: selectedModel?.reasoningEfforts.map((effort) => ({ value: effort, label: effort })) ?? [],
    providerId: nextProviderId,
    model: selectedModel?.id ?? "",
    reasoningEffort: nextReasoningEffort,
  };
}

export function resolveMateTalkModelChange({
  providerCatalog,
  model,
  reasoningEffort,
}: {
  providerCatalog: ModelCatalogProvider | null;
  model: string;
  reasoningEffort: ModelReasoningEffort;
}): { model: string; reasoningEffort: ModelReasoningEffort } {
  const nextModelCatalog = providerCatalog?.models.find((candidate) => candidate.id === model) ?? null;
  return {
    model,
    reasoningEffort: nextModelCatalog?.reasoningEfforts.includes(reasoningEffort)
      ? reasoningEffort
      : nextModelCatalog?.reasoningEfforts[0] ?? providerCatalog?.defaultReasoningEffort ?? reasoningEffort,
  };
}

export function isMateTalkReasoningEffortAllowed(
  selectedModel: ModelCatalogItem | null,
  reasoningEffort: string,
): reasoningEffort is ModelReasoningEffort {
  return selectedModel?.reasoningEfforts.includes(reasoningEffort as ModelReasoningEffort) ?? false;
}
