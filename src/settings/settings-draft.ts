import {
  getCharacterReflectionProviderSettings,
  getCharacterReflectionTriggerSettings,
  getMemoryExtractionProviderSettings,
  getMateMemoryGenerationSettings,
  getProviderAppSettings,
  type AppSettings,
  type CharacterReflectionProviderSettings,
  type MemoryExtractionProviderSettings,
  type MateMemoryGenerationProviderSettings,
  type ProviderAppSettings,
} from "../provider-settings-state.js";
import { coerceModelSelection, type ModelCatalogProvider } from "../model-catalog.js";

export function updateMemoryGenerationEnabled(
  draft: AppSettings,
  enabled: boolean,
): AppSettings {
  return {
    ...draft,
    memoryGenerationEnabled: enabled,
  };
}

export function updateAutoCollapseActionDockOnSend(
  draft: AppSettings,
  enabled: boolean,
): AppSettings {
  return {
    ...draft,
    autoCollapseActionDockOnSend: enabled,
  };
}

export function updateCharacterReflectionCooldownSeconds(
  draft: AppSettings,
  rawValue: string,
): AppSettings {
  const normalized = Number.parseInt(rawValue, 10);
  return {
    ...draft,
    characterReflectionTriggerSettings: {
      ...getCharacterReflectionTriggerSettings(draft),
      cooldownSeconds: Number.isFinite(normalized) && normalized > 0 ? normalized : 30,
    },
  };
}

export function updateCharacterReflectionCharDeltaThreshold(
  draft: AppSettings,
  rawValue: string,
): AppSettings {
  const normalized = Number.parseInt(rawValue, 10);
  return {
    ...draft,
    characterReflectionTriggerSettings: {
      ...getCharacterReflectionTriggerSettings(draft),
      charDeltaThreshold: Number.isFinite(normalized) && normalized > 0 ? normalized : 1,
    },
  };
}

export function updateCharacterReflectionMessageDeltaThreshold(
  draft: AppSettings,
  rawValue: string,
): AppSettings {
  const normalized = Number.parseInt(rawValue, 10);
  return {
    ...draft,
    characterReflectionTriggerSettings: {
      ...getCharacterReflectionTriggerSettings(draft),
      messageDeltaThreshold: Number.isFinite(normalized) && normalized > 0 ? normalized : 1,
    },
  };
}

export function updateCodingProviderEnabledDraft(
  draft: AppSettings,
  providerId: string,
  enabled: boolean,
): AppSettings {
  return {
    ...draft,
    codingProviderSettings: updateCodingProviderEnabled(draft, providerId, enabled),
  };
}

export function updateCodingProviderApiKeyDraft(
  draft: AppSettings,
  providerId: string,
  apiKey: string,
): AppSettings {
  return {
    ...draft,
    codingProviderSettings: updateCodingProviderApiKey(draft, providerId, apiKey),
  };
}

export function updateCodingProviderSkillRootPathDraft(
  draft: AppSettings,
  providerId: string,
  skillRootPath: string,
): AppSettings {
  return {
    ...draft,
    codingProviderSettings: updateCodingProviderSkillRootPath(draft, providerId, skillRootPath),
  };
}

export function updateCodingProviderSkillRelativePathDraft(
  draft: AppSettings,
  providerId: string,
  skillRelativePath: string,
): AppSettings {
  return {
    ...draft,
    codingProviderSettings: updateCodingProviderSkillRelativePath(draft, providerId, skillRelativePath),
  };
}

export function updateCodingProviderEnabled(
  draft: AppSettings,
  providerId: string,
  enabled: boolean,
): Record<string, ProviderAppSettings> {
  return {
    ...draft.codingProviderSettings,
    [providerId]: {
      ...getProviderAppSettings(draft, providerId),
      enabled,
    },
  };
}

export function updateCodingProviderApiKey(
  draft: AppSettings,
  providerId: string,
  apiKey: string,
): Record<string, ProviderAppSettings> {
  return {
    ...draft.codingProviderSettings,
    [providerId]: {
      ...getProviderAppSettings(draft, providerId),
      apiKey,
    },
  };
}

export function updateCodingProviderSkillRootPath(
  draft: AppSettings,
  providerId: string,
  skillRootPath: string,
): Record<string, ProviderAppSettings> {
  return {
    ...draft.codingProviderSettings,
    [providerId]: {
      ...getProviderAppSettings(draft, providerId),
      skillRootPath,
    },
  };
}

export function updateCodingProviderSkillRelativePath(
  draft: AppSettings,
  providerId: string,
  skillRelativePath: string,
): Record<string, ProviderAppSettings> {
  return {
    ...draft.codingProviderSettings,
    [providerId]: {
      ...getProviderAppSettings(draft, providerId),
      skillRelativePath,
    },
  };
}

export function updateMemoryExtractionModel(
  draft: AppSettings,
  providerCatalog: ModelCatalogProvider,
  providerId: string,
  model: string,
): Record<string, MemoryExtractionProviderSettings> {
  const currentSettings = getMemoryExtractionProviderSettings(draft, providerId);
  const selection = coerceModelSelection(providerCatalog, model, currentSettings.reasoningEffort);
  return {
    ...draft.memoryExtractionProviderSettings,
    [providerId]: {
      ...currentSettings,
      model: selection.resolvedModel,
      reasoningEffort: selection.resolvedReasoningEffort,
    },
  };
}

export function updateMemoryExtractionReasoningEffort(
  draft: AppSettings,
  providerId: string,
  reasoningEffort: MemoryExtractionProviderSettings["reasoningEffort"],
): Record<string, MemoryExtractionProviderSettings> {
  return {
    ...draft.memoryExtractionProviderSettings,
    [providerId]: {
      ...getMemoryExtractionProviderSettings(draft, providerId),
      reasoningEffort,
    },
  };
}

export function updateMemoryExtractionThreshold(
  draft: AppSettings,
  providerId: string,
  rawValue: string,
): Record<string, MemoryExtractionProviderSettings> {
  const normalized = Number.parseInt(rawValue, 10);
  return {
    ...draft.memoryExtractionProviderSettings,
    [providerId]: {
      ...getMemoryExtractionProviderSettings(draft, providerId),
      outputTokensThreshold: Number.isFinite(normalized) && normalized > 0 ? normalized : 1,
    },
  };
}

export function updateMemoryExtractionTimeoutSeconds(
  draft: AppSettings,
  providerId: string,
  rawValue: string,
): Record<string, MemoryExtractionProviderSettings> {
  const normalized = Number.parseInt(rawValue, 10);
  return {
    ...draft.memoryExtractionProviderSettings,
    [providerId]: {
      ...getMemoryExtractionProviderSettings(draft, providerId),
      timeoutSeconds: Number.isFinite(normalized) && normalized > 0 ? normalized : 30,
    },
  };
}

export function updateMemoryExtractionModelDraft(
  draft: AppSettings,
  providerCatalog: ModelCatalogProvider,
  providerId: string,
  model: string,
): AppSettings {
  return {
    ...draft,
    memoryExtractionProviderSettings: updateMemoryExtractionModel(draft, providerCatalog, providerId, model),
  };
}

export function updateMemoryExtractionReasoningEffortDraft(
  draft: AppSettings,
  providerId: string,
  reasoningEffort: MemoryExtractionProviderSettings["reasoningEffort"],
): AppSettings {
  return {
    ...draft,
    memoryExtractionProviderSettings: updateMemoryExtractionReasoningEffort(draft, providerId, reasoningEffort),
  };
}

export function updateMemoryExtractionThresholdDraft(
  draft: AppSettings,
  providerId: string,
  rawValue: string,
): AppSettings {
  return {
    ...draft,
    memoryExtractionProviderSettings: updateMemoryExtractionThreshold(draft, providerId, rawValue),
  };
}

export function updateMemoryExtractionTimeoutSecondsDraft(
  draft: AppSettings,
  providerId: string,
  rawValue: string,
): AppSettings {
  return {
    ...draft,
    memoryExtractionProviderSettings: updateMemoryExtractionTimeoutSeconds(draft, providerId, rawValue),
  };
}

export function updateCharacterReflectionModel(
  draft: AppSettings,
  providerCatalog: ModelCatalogProvider,
  providerId: string,
  model: string,
): Record<string, CharacterReflectionProviderSettings> {
  const currentSettings = getCharacterReflectionProviderSettings(draft, providerId);
  const selection = coerceModelSelection(providerCatalog, model, currentSettings.reasoningEffort);
  return {
    ...draft.characterReflectionProviderSettings,
    [providerId]: {
      ...currentSettings,
      model: selection.resolvedModel,
      reasoningEffort: selection.resolvedReasoningEffort,
    },
  };
}

export function updateCharacterReflectionReasoningEffort(
  draft: AppSettings,
  providerId: string,
  reasoningEffort: CharacterReflectionProviderSettings["reasoningEffort"],
): Record<string, CharacterReflectionProviderSettings> {
  return {
    ...draft.characterReflectionProviderSettings,
    [providerId]: {
      ...getCharacterReflectionProviderSettings(draft, providerId),
      reasoningEffort,
    },
  };
}

export function updateCharacterReflectionTimeoutSeconds(
  draft: AppSettings,
  providerId: string,
  rawValue: string,
): Record<string, CharacterReflectionProviderSettings> {
  const normalized = Number.parseInt(rawValue, 10);
  return {
    ...draft.characterReflectionProviderSettings,
    [providerId]: {
      ...getCharacterReflectionProviderSettings(draft, providerId),
      timeoutSeconds: Number.isFinite(normalized) && normalized > 0 ? normalized : 30,
    },
  };
}

export function updateCharacterReflectionModelDraft(
  draft: AppSettings,
  providerCatalog: ModelCatalogProvider,
  providerId: string,
  model: string,
): AppSettings {
  return {
    ...draft,
    characterReflectionProviderSettings: updateCharacterReflectionModel(draft, providerCatalog, providerId, model),
  };
}

export function updateCharacterReflectionReasoningEffortDraft(
  draft: AppSettings,
  providerId: string,
  reasoningEffort: CharacterReflectionProviderSettings["reasoningEffort"],
): AppSettings {
  return {
    ...draft,
    characterReflectionProviderSettings: updateCharacterReflectionReasoningEffort(draft, providerId, reasoningEffort),
  };
}

export function updateCharacterReflectionTimeoutSecondsDraft(
  draft: AppSettings,
  providerId: string,
  rawValue: string,
): AppSettings {
  return {
    ...draft,
    characterReflectionProviderSettings: updateCharacterReflectionTimeoutSeconds(draft, providerId, rawValue),
  };
}

function getDefaultMateMemoryGenerationPriority(): MateMemoryGenerationProviderSettings {
  return {
    provider: "",
    model: "",
    reasoningEffort: "high",
    timeoutSeconds: 30,
  };
}

function getResolvedMateMemoryGenerationPriority(
  draft: AppSettings,
  index: number,
): MateMemoryGenerationProviderSettings {
  return getMateMemoryGenerationSettings(draft).priorityList[index] ?? getDefaultMateMemoryGenerationPriority();
}

function updateMateMemoryGenerationPriorityAt(
  draft: AppSettings,
  index: number,
  nextPriority: MateMemoryGenerationProviderSettings,
): AppSettings {
  const current = getMateMemoryGenerationSettings(draft);
  const priorityList = current.priorityList.length > 0
    ? [...current.priorityList]
    : [getDefaultMateMemoryGenerationPriority()];
  const normalizedIndex = Math.max(0, Math.min(index, priorityList.length - 1));
  priorityList[normalizedIndex] = nextPriority;

  return {
    ...draft,
    mateMemoryGenerationSettings: {
      ...current,
      priorityList,
    },
  };
}

export function updateMateMemoryGenerationTriggerIntervalMinutesDraft(
  draft: AppSettings,
  rawValue: string,
): AppSettings {
  const normalized = Number.parseInt(rawValue, 10);
  return {
    ...draft,
    mateMemoryGenerationSettings: {
      ...getMateMemoryGenerationSettings(draft),
      triggerIntervalMinutes: Number.isFinite(normalized) && normalized > 0 ? normalized : 1,
    },
  };
}

export function updateMateMemoryGenerationPriorityProviderDraft(
  draft: AppSettings,
  index: number,
  providerId: string,
): AppSettings {
  const currentPriority = getResolvedMateMemoryGenerationPriority(draft, index);
  return updateMateMemoryGenerationPriorityAt(draft, index, {
    ...currentPriority,
    provider: providerId,
  });
}

export function updateMateMemoryGenerationPriorityModelDraft(
  draft: AppSettings,
  providerCatalog: ModelCatalogProvider,
  index: number,
  providerId: string,
  model: string,
): AppSettings {
  const currentPriority = getResolvedMateMemoryGenerationPriority(draft, index);
  const selection = coerceModelSelection(providerCatalog, model, currentPriority.reasoningEffort);
  return updateMateMemoryGenerationPriorityAt(draft, index, {
    ...currentPriority,
    provider: providerId,
    model: selection.resolvedModel,
    reasoningEffort: selection.resolvedReasoningEffort,
  });
}

export function updateMateMemoryGenerationPriorityReasoningEffortDraft(
  draft: AppSettings,
  index: number,
  reasoningEffort: MateMemoryGenerationProviderSettings["reasoningEffort"],
): AppSettings {
  const currentPriority = getResolvedMateMemoryGenerationPriority(draft, index);
  return updateMateMemoryGenerationPriorityAt(draft, index, {
    ...currentPriority,
    reasoningEffort,
  });
}

export function updateMateMemoryGenerationPriorityTimeoutSecondsDraft(
  draft: AppSettings,
  index: number,
  rawValue: string,
): AppSettings {
  const currentPriority = getResolvedMateMemoryGenerationPriority(draft, index);
  const normalized = Number.parseInt(rawValue, 10);
  return {
    ...draft,
    mateMemoryGenerationSettings: updateMateMemoryGenerationPriorityAt(draft, index, {
      ...currentPriority,
      timeoutSeconds: Number.isFinite(normalized) && normalized > 0 ? normalized : 30,
    }).mateMemoryGenerationSettings,
  };
}

export function addMateMemoryGenerationPriorityDraft(
  draft: AppSettings,
  priority: MateMemoryGenerationProviderSettings,
): AppSettings {
  const current = getMateMemoryGenerationSettings(draft);
  return {
    ...draft,
    mateMemoryGenerationSettings: {
      ...current,
      priorityList: [...current.priorityList, priority],
    },
  };
}

export function removeMateMemoryGenerationPriorityDraft(
  draft: AppSettings,
  index: number,
): AppSettings {
  const current = getMateMemoryGenerationSettings(draft);
  if (current.priorityList.length <= 1) {
    return draft;
  }

  return {
    ...draft,
    mateMemoryGenerationSettings: {
      ...current,
      priorityList: current.priorityList.filter((_, priorityIndex) => priorityIndex !== index),
    },
  };
}
