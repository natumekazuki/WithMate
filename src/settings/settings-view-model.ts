import {
  getResolvedProviderSettingsBundle,
  type AppSettings,
  type MemoryExtractionProviderSettings,
  type ProviderAppSettings,
} from "../provider-settings-state.js";
import {
  coerceModelSelection,
  getReasoningEffortOptionsForModel,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../model-catalog.js";

export type HomeProviderSettingRow = {
  provider: ModelCatalogProvider;
  settings: ProviderAppSettings;
  memoryExtractionSettings: MemoryExtractionProviderSettings;
  resolvedMemoryExtractionModel: string;
  resolvedMemoryExtractionReasoningEffort: MemoryExtractionProviderSettings["reasoningEffort"];
  availableMemoryExtractionReasoningEfforts: readonly MemoryExtractionProviderSettings["reasoningEffort"][];
};

export function buildHomeProviderSettingRows(
  modelCatalog: ModelCatalogSnapshot | null,
  appSettings: AppSettings,
): HomeProviderSettingRow[] {
  return (modelCatalog?.providers ?? []).map((provider) => {
    const resolvedSettings = getResolvedProviderSettingsBundle(appSettings, provider.id);
    const settings = resolvedSettings.coding;
    const memoryExtractionSettings = resolvedSettings.memoryExtraction;
    const memoryExtractionSelection = coerceModelSelection(
      provider,
      memoryExtractionSettings.model,
      memoryExtractionSettings.reasoningEffort,
    );

    return {
      provider,
      settings,
      memoryExtractionSettings,
      resolvedMemoryExtractionModel: memoryExtractionSelection.resolvedModel,
      resolvedMemoryExtractionReasoningEffort: memoryExtractionSelection.resolvedReasoningEffort,
      availableMemoryExtractionReasoningEfforts: getReasoningEffortOptionsForModel(
        provider,
        memoryExtractionSelection.resolvedModel,
      ),
    };
  });
}

export function buildNormalizedMemoryExtractionProviderSettings(
  rows: readonly HomeProviderSettingRow[],
): Record<string, MemoryExtractionProviderSettings> {
  return Object.fromEntries(
    rows.map((row) => [
      row.provider.id,
      {
        model: row.resolvedMemoryExtractionModel,
        reasoningEffort: row.resolvedMemoryExtractionReasoningEffort,
        outputTokensThreshold: row.memoryExtractionSettings.outputTokensThreshold,
        timeoutSeconds: row.memoryExtractionSettings.timeoutSeconds,
      } satisfies MemoryExtractionProviderSettings,
    ]),
  );
}

export function buildPersistedAppSettingsFromRows(
  draft: AppSettings,
  rows: readonly HomeProviderSettingRow[],
): AppSettings {
  return {
    ...draft,
    memoryExtractionProviderSettings: buildNormalizedMemoryExtractionProviderSettings(rows),
  };
}
