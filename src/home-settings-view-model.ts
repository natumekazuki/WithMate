import {
  getCharacterReflectionProviderSettings,
  getMemoryExtractionProviderSettings,
  getProviderAppSettings,
  type AppSettings,
  type CharacterReflectionProviderSettings,
  type MemoryExtractionProviderSettings,
  type ProviderAppSettings,
} from "./app-state.js";
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
    const settings = getProviderAppSettings(appSettings, provider.id);
    const memoryExtractionSettings = getMemoryExtractionProviderSettings(appSettings, provider.id);
    const characterReflectionSettings = getCharacterReflectionProviderSettings(appSettings, provider.id);
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
