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
} from "./provider-settings-state.js";
import { coerceModelSelection, type ModelCatalogProvider } from "./model-catalog.js";

export function updateSystemPromptPrefix(
  draft: AppSettings,
  systemPromptPrefix: string,
): AppSettings {
  return {
    ...draft,
    systemPromptPrefix,
  };
}

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

function getResolvedMateMemoryGenerationPriority(draft: AppSettings): MateMemoryGenerationProviderSettings {
  return getMateMemoryGenerationSettings(draft).priorityList[0] ?? {
    provider: "",
    model: "",
    reasoningEffort: "high",
    timeoutSeconds: 30,
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
  providerId: string,
): AppSettings {
  const current = getMateMemoryGenerationSettings(draft);
  const currentPriority = getResolvedMateMemoryGenerationPriority(draft);
  const nextPriority: MateMemoryGenerationProviderSettings = {
    ...currentPriority,
    provider: providerId,
  };

  return {
    ...draft,
    mateMemoryGenerationSettings: {
      ...current,
      priorityList: [nextPriority],
    },
  };
}

export function updateMateMemoryGenerationPriorityModelDraft(
  draft: AppSettings,
  providerCatalog: ModelCatalogProvider,
  providerId: string,
  model: string,
): AppSettings {
  const current = getMateMemoryGenerationSettings(draft);
  const currentPriority = getResolvedMateMemoryGenerationPriority(draft);
  const selection = coerceModelSelection(providerCatalog, model, currentPriority.reasoningEffort);
  return {
    ...draft,
    mateMemoryGenerationSettings: {
      ...current,
      priorityList: [
        {
          ...currentPriority,
          provider: providerId,
          model: selection.resolvedModel,
          reasoningEffort: selection.resolvedReasoningEffort,
        },
      ],
    },
  };
}

export function updateMateMemoryGenerationPriorityReasoningEffortDraft(
  draft: AppSettings,
  reasoningEffort: MateMemoryGenerationProviderSettings["reasoningEffort"],
): AppSettings {
  const current = getMateMemoryGenerationSettings(draft);
  const currentPriority = getResolvedMateMemoryGenerationPriority(draft);
  return {
    ...draft,
    mateMemoryGenerationSettings: {
      ...current,
      priorityList: [
        {
          ...currentPriority,
          reasoningEffort,
        },
      ],
    },
  };
}

export function updateMateMemoryGenerationPriorityTimeoutSecondsDraft(
  draft: AppSettings,
  rawValue: string,
): AppSettings {
  const current = getMateMemoryGenerationSettings(draft);
  const currentPriority = getResolvedMateMemoryGenerationPriority(draft);
  const normalized = Number.parseInt(rawValue, 10);
  return {
    ...draft,
    mateMemoryGenerationSettings: {
      ...current,
      priorityList: [
        {
          ...currentPriority,
          timeoutSeconds: Number.isFinite(normalized) && normalized > 0 ? normalized : 30,
        },
      ],
    },
  };
}
