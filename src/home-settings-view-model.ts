import {
  getResolvedProviderSettingsBundle,
  type AppSettings,
  type CharacterReflectionProviderSettings,
  type MemoryExtractionProviderSettings,
  type ProviderAppSettings,
} from "./provider-settings-state.js";
import {
  coerceModelSelection,
  getReasoningEffortOptionsForModel,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "./model-catalog.js";

export type HomeProviderSettingRow = {
  provider: ModelCatalogProvider;
  settings: ProviderAppSettings;
  memoryExtractionSettings: MemoryExtractionProviderSettings;
  characterReflectionSettings: CharacterReflectionProviderSettings;
  resolvedMemoryExtractionModel: string;
  resolvedMemoryExtractionReasoningEffort: MemoryExtractionProviderSettings["reasoningEffort"];
  resolvedCharacterReflectionModel: string;
  resolvedCharacterReflectionReasoningEffort: CharacterReflectionProviderSettings["reasoningEffort"];
  availableMemoryExtractionReasoningEfforts: readonly MemoryExtractionProviderSettings["reasoningEffort"][];
  availableCharacterReflectionReasoningEfforts: readonly CharacterReflectionProviderSettings["reasoningEffort"][];
};

export function buildHomeProviderSettingRows(
  modelCatalog: ModelCatalogSnapshot | null,
  appSettings: AppSettings,
): HomeProviderSettingRow[] {
  return (modelCatalog?.providers ?? []).map((provider) => {
    const resolvedSettings = getResolvedProviderSettingsBundle(appSettings, provider.id);
    const settings = resolvedSettings.coding;
    const memoryExtractionSettings = resolvedSettings.memoryExtraction;
    const characterReflectionSettings = resolvedSettings.characterReflection;
    const memoryExtractionSelection = coerceModelSelection(
      provider,
      memoryExtractionSettings.model,
      memoryExtractionSettings.reasoningEffort,
    );
    const characterReflectionSelection = coerceModelSelection(
      provider,
      characterReflectionSettings.model,
      characterReflectionSettings.reasoningEffort,
    );

    return {
      provider,
      settings,
      memoryExtractionSettings,
      characterReflectionSettings,
      resolvedMemoryExtractionModel: memoryExtractionSelection.resolvedModel,
      resolvedMemoryExtractionReasoningEffort: memoryExtractionSelection.resolvedReasoningEffort,
      resolvedCharacterReflectionModel: characterReflectionSelection.resolvedModel,
      resolvedCharacterReflectionReasoningEffort: characterReflectionSelection.resolvedReasoningEffort,
      availableMemoryExtractionReasoningEfforts: getReasoningEffortOptionsForModel(
        provider,
        memoryExtractionSelection.resolvedModel,
      ),
      availableCharacterReflectionReasoningEfforts: getReasoningEffortOptionsForModel(
        provider,
        characterReflectionSelection.resolvedModel,
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
      } satisfies MemoryExtractionProviderSettings,
    ]),
  );
}

export function buildNormalizedCharacterReflectionProviderSettings(
  rows: readonly HomeProviderSettingRow[],
): Record<string, CharacterReflectionProviderSettings> {
  return Object.fromEntries(
    rows.map((row) => [
      row.provider.id,
      {
        model: row.resolvedCharacterReflectionModel,
        reasoningEffort: row.resolvedCharacterReflectionReasoningEffort,
      } satisfies CharacterReflectionProviderSettings,
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
    characterReflectionProviderSettings: buildNormalizedCharacterReflectionProviderSettings(rows),
  };
}
