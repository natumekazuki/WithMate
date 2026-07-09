import {
  MEMORY_FILE_QUOTA_MAX_BYTES,
  MEMORY_FILE_QUOTA_MIN_BYTES,
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

function normalizeSelectablePath(filePath: string): string {
  return filePath.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
}

function normalizePathComparisonKey(filePath: string): string {
  const normalized = normalizeSelectablePath(filePath);
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function resolveProviderRelativePathFromSelection(
  rootDirectory: string,
  selectedPath: string,
): string | null {
  const normalizedRoot = normalizeSelectablePath(rootDirectory);
  const normalizedSelectedPath = normalizeSelectablePath(selectedPath);
  if (!normalizedRoot || !normalizedSelectedPath) {
    return null;
  }

  const rootKey = normalizePathComparisonKey(normalizedRoot);
  const selectedKey = normalizePathComparisonKey(normalizedSelectedPath);
  if (selectedKey === rootKey) {
    return "";
  }

  const prefix = `${rootKey}/`;
  if (!selectedKey.startsWith(prefix)) {
    return null;
  }

  return normalizedSelectedPath.slice(normalizedRoot.length + 1);
}

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

export function getMemoryFileQuotaMegabytes(settings: Pick<AppSettings, "memoryFileQuotaBytes">): number {
  return Math.round(settings.memoryFileQuotaBytes / 1024 / 1024);
}

export function getMemoryFileQuotaMegabytesInputBounds(): { min: number; max: number } {
  return {
    min: Math.ceil(MEMORY_FILE_QUOTA_MIN_BYTES / 1024 / 1024),
    max: Math.floor(MEMORY_FILE_QUOTA_MAX_BYTES / 1024 / 1024),
  };
}
