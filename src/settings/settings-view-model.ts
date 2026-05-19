import {
  getResolvedProviderSettingsBundle,
  type AppSettings,
  type MemoryExtractionProviderSettings,
  type ProviderInstructionFailPolicy,
  type ProviderInstructionTargetUpsertInput,
  type ProviderInstructionTargetSettings,
  type ProviderInstructionWriteMode,
  DEFAULT_PROVIDER_INSTRUCTION_TARGET_ID,
  getDefaultProviderInstructionRelativePath,
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
  instructionTarget: HomeProviderInstructionTargetSettings;
  resolvedMemoryExtractionModel: string;
  resolvedMemoryExtractionReasoningEffort: MemoryExtractionProviderSettings["reasoningEffort"];
  availableMemoryExtractionReasoningEfforts: readonly MemoryExtractionProviderSettings["reasoningEffort"][];
};

export type HomeProviderInstructionTargetSettings = ProviderInstructionTargetSettings;

export type HomeProviderInstructionTargetUpsertInput = ProviderInstructionTargetUpsertInput;

export function buildHomeProviderInstructionTargetUpsertInput(
  target: HomeProviderInstructionTargetSettings,
): HomeProviderInstructionTargetUpsertInput {
  return {
    providerId: target.providerId,
    targetId: target.targetId,
    enabled: target.enabled,
    rootDirectory: target.rootDirectory,
    instructionRelativePath: target.instructionRelativePath,
    writeMode: target.writeMode,
    failPolicy: target.failPolicy,
  };
}

export function resolveInstructionRelativePathFromSelection(
  rootDirectory: string,
  selectedFilePath: string,
): string | null {
  const normalizedRoot = normalizePathForComparison(rootDirectory);
  const normalizedSelected = normalizePathForComparison(selectedFilePath);
  if (!normalizedRoot || !normalizedSelected) {
    return null;
  }

  const rootForComparison = normalizedRoot.toLowerCase();
  const selectedForComparison = normalizedSelected.toLowerCase();
  if (!selectedForComparison.startsWith(`${rootForComparison}/`)) {
    return null;
  }

  return normalizedSelected.slice(normalizedRoot.length + 1);
}

function normalizePathForComparison(pathValue: string): string {
  return pathValue
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "");
}

export function buildHomeProviderSettingRows(
  modelCatalog: ModelCatalogSnapshot | null,
  appSettings: AppSettings,
  instructionTargets: readonly HomeProviderInstructionTargetSettings[] = [],
): HomeProviderSettingRow[] {
  const instructionTargetByProvider = new Map<string, HomeProviderInstructionTargetSettings>(
    instructionTargets.map((target) => [target.providerId, target]),
  );

  return (modelCatalog?.providers ?? []).map((provider) => {
    const resolvedSettings = getResolvedProviderSettingsBundle(appSettings, provider.id);
    const settings = resolvedSettings.coding;
    const memoryExtractionSettings = resolvedSettings.memoryExtraction;
    const instructionTarget = resolveProviderInstructionTarget(provider.id, instructionTargetByProvider.get(provider.id));
    const memoryExtractionSelection = coerceModelSelection(
      provider,
      memoryExtractionSettings.model,
      memoryExtractionSettings.reasoningEffort,
    );

    return {
      provider,
      settings,
      memoryExtractionSettings,
      instructionTarget,
      resolvedMemoryExtractionModel: memoryExtractionSelection.resolvedModel,
      resolvedMemoryExtractionReasoningEffort: memoryExtractionSelection.resolvedReasoningEffort,
      availableMemoryExtractionReasoningEfforts: getReasoningEffortOptionsForModel(
        provider,
        memoryExtractionSelection.resolvedModel,
      ),
    };
  });
}

function resolveProviderInstructionTarget(
  providerId: string,
  instructionTarget?: HomeProviderInstructionTargetSettings,
): HomeProviderInstructionTargetSettings {
  if (instructionTarget) {
    return instructionTarget;
  }

  return {
    providerId,
    targetId: DEFAULT_PROVIDER_INSTRUCTION_TARGET_ID,
    enabled: false,
    rootDirectory: "",
    instructionRelativePath: getDefaultProviderInstructionRelativePath(providerId),
    lastSyncState: "never",
    lastSyncRunId: null,
    lastSyncedRevisionId: null,
    lastErrorPreview: "",
    lastSyncedAt: null,
    writeMode: "managed_block" satisfies ProviderInstructionWriteMode,
    projectionScope: "mate_only",
    failPolicy: "warn_continue" satisfies ProviderInstructionFailPolicy,
    requiresRestart: false,
  };
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
