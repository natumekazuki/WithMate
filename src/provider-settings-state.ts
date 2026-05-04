import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  DEFAULT_REASONING_EFFORT,
  normalizeProviderId,
  type ModelReasoningEffort,
} from "./model-catalog.js";
import type {
  ProviderInstructionFailPolicy,
  ProviderInstructionLastSyncState,
  ProviderInstructionTarget,
  ProviderInstructionTargetInput,
  ProviderInstructionWriteMode,
} from "./provider-instruction-target-state.js";

export type AppSettings = {
  systemPromptPrefix: string;
  memoryGenerationEnabled: boolean;
  autoCollapseActionDockOnSend: boolean;
  characterReflectionTriggerSettings: CharacterReflectionTriggerSettings;
  mateMemoryGenerationSettings: MateMemoryGenerationSettings;
  codingProviderSettings: Record<string, ProviderAppSettings>;
  memoryExtractionProviderSettings: Record<string, MemoryExtractionProviderSettings>;
  characterReflectionProviderSettings: Record<string, CharacterReflectionProviderSettings>;
};

export const DEFAULT_PROVIDER_INSTRUCTION_TARGET_ID = "main";
export const DEFAULT_PROVIDER_INSTRUCTION_RELATIVE_PATH_BY_PROVIDER: Record<string, string> = {
  codex: "AGENTS.md",
  copilot: ".github/copilot-instructions.md",
};

export type ProviderInstructionTargetSyncState = ProviderInstructionLastSyncState;
export type ProviderInstructionTargetSettings = ProviderInstructionTarget;
export type ProviderInstructionTargetUpsertInput = ProviderInstructionTargetInput;
export type {
  ProviderInstructionFailPolicy,
  ProviderInstructionWriteMode,
};

export function getDefaultProviderInstructionRelativePath(providerId: string): string {
  const normalizedProviderId = providerId.trim().toLowerCase();
  return (
    DEFAULT_PROVIDER_INSTRUCTION_RELATIVE_PATH_BY_PROVIDER[normalizedProviderId] ??
    `.github/${normalizedProviderId || "provider"}-instructions.md`
  );
}

export type ProviderAppSettings = {
  enabled: boolean;
  apiKey: string;
  skillRootPath: string;
};

export type MemoryExtractionProviderSettings = {
  model: string;
  reasoningEffort: ModelReasoningEffort;
  outputTokensThreshold: number;
  timeoutSeconds: number;
};

export type CharacterReflectionProviderSettings = {
  model: string;
  reasoningEffort: ModelReasoningEffort;
  timeoutSeconds: number;
};

export type MateMemoryGenerationProviderSettings = {
  provider: string;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  timeoutSeconds: number;
};

export type MateMemoryGenerationSettings = {
  priorityList: MateMemoryGenerationProviderSettings[];
  triggerIntervalMinutes: number;
};

export type CharacterReflectionTriggerSettings = {
  cooldownSeconds: number;
  charDeltaThreshold: number;
  messageDeltaThreshold: number;
};

export type ResolvedProviderSettingsBundle = {
  coding: ProviderAppSettings;
  memoryExtraction: MemoryExtractionProviderSettings;
  characterReflection: CharacterReflectionProviderSettings;
};

export const DEFAULT_PROVIDER_APP_SETTINGS: ProviderAppSettings = {
  enabled: false,
  apiKey: "",
  skillRootPath: "",
};

export const DEFAULT_MEMORY_EXTRACTION_OUTPUT_TOKENS_THRESHOLD = 300_000;
export const DEFAULT_BACKGROUND_TIMEOUT_SECONDS = 180;

export const DEFAULT_MEMORY_EXTRACTION_PROVIDER_SETTINGS: MemoryExtractionProviderSettings = {
  model: DEFAULT_MODEL_ID,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  outputTokensThreshold: DEFAULT_MEMORY_EXTRACTION_OUTPUT_TOKENS_THRESHOLD,
  timeoutSeconds: DEFAULT_BACKGROUND_TIMEOUT_SECONDS,
};

export const DEFAULT_CHARACTER_REFLECTION_PROVIDER_SETTINGS: CharacterReflectionProviderSettings = {
  model: DEFAULT_MODEL_ID,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  timeoutSeconds: DEFAULT_BACKGROUND_TIMEOUT_SECONDS,
};

export const DEFAULT_MATE_MEMORY_GENERATION_TRIGGER_INTERVAL_MINUTES = 60;
export const DEFAULT_MATE_MEMORY_GENERATION_PROVIDER_SETTINGS: MateMemoryGenerationProviderSettings = {
  provider: DEFAULT_PROVIDER_ID,
  model: DEFAULT_MODEL_ID,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  timeoutSeconds: DEFAULT_BACKGROUND_TIMEOUT_SECONDS,
};
export const DEFAULT_MATE_MEMORY_GENERATION_SETTINGS: MateMemoryGenerationSettings = {
  priorityList: [{ ...DEFAULT_MATE_MEMORY_GENERATION_PROVIDER_SETTINGS }],
  triggerIntervalMinutes: DEFAULT_MATE_MEMORY_GENERATION_TRIGGER_INTERVAL_MINUTES,
};

export const DEFAULT_CHARACTER_REFLECTION_TRIGGER_SETTINGS: CharacterReflectionTriggerSettings = {
  cooldownSeconds: 120,
  charDeltaThreshold: 400,
  messageDeltaThreshold: 2,
};

export function createDefaultAppSettings(): AppSettings {
  return {
    systemPromptPrefix: "",
    memoryGenerationEnabled: true,
    autoCollapseActionDockOnSend: true,
    characterReflectionTriggerSettings: { ...DEFAULT_CHARACTER_REFLECTION_TRIGGER_SETTINGS },
    mateMemoryGenerationSettings: {
      ...DEFAULT_MATE_MEMORY_GENERATION_SETTINGS,
      priorityList: [{ ...DEFAULT_MATE_MEMORY_GENERATION_PROVIDER_SETTINGS }],
    },
    codingProviderSettings: {
      [DEFAULT_PROVIDER_ID]: {
        enabled: true,
        apiKey: "",
        skillRootPath: "",
      },
    },
    memoryExtractionProviderSettings: {
      [DEFAULT_PROVIDER_ID]: { ...DEFAULT_MEMORY_EXTRACTION_PROVIDER_SETTINGS },
    },
    characterReflectionProviderSettings: {
      [DEFAULT_PROVIDER_ID]: { ...DEFAULT_CHARACTER_REFLECTION_PROVIDER_SETTINGS },
    },
  };
}

function normalizeCharacterReflectionCooldownSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CHARACTER_REFLECTION_TRIGGER_SETTINGS.cooldownSeconds;
  }

  const normalized = Math.trunc(value);
  if (normalized < 30) {
    return 30;
  }

  if (normalized > 3_600) {
    return 3_600;
  }

  return normalized;
}

function normalizeCharacterReflectionCharDeltaThreshold(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CHARACTER_REFLECTION_TRIGGER_SETTINGS.charDeltaThreshold;
  }

  const normalized = Math.trunc(value);
  if (normalized < 1) {
    return 1;
  }

  if (normalized > 20_000) {
    return 20_000;
  }

  return normalized;
}

function normalizeCharacterReflectionMessageDeltaThreshold(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CHARACTER_REFLECTION_TRIGGER_SETTINGS.messageDeltaThreshold;
  }

  const normalized = Math.trunc(value);
  if (normalized < 1) {
    return 1;
  }

  if (normalized > 100) {
    return 100;
  }

  return normalized;
}

function normalizeReasoningEffort(value: unknown, fallback: ModelReasoningEffort): ModelReasoningEffort {
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }

  return fallback;
}

function normalizeProviderAppSettings(value: unknown, defaultEnabled: boolean): ProviderAppSettings {
  if (!value || typeof value !== "object") {
    return {
      enabled: defaultEnabled,
      apiKey: "",
      skillRootPath: "",
    };
  }

  const candidate = value as Partial<ProviderAppSettings>;
  return {
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : defaultEnabled,
    apiKey: typeof candidate.apiKey === "string" ? candidate.apiKey : "",
    skillRootPath: typeof candidate.skillRootPath === "string" ? candidate.skillRootPath : "",
  };
}

function normalizeOutputTokensThreshold(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MEMORY_EXTRACTION_OUTPUT_TOKENS_THRESHOLD;
  }

  const normalized = Math.trunc(value);
  if (normalized < 1) {
    return 1;
  }

  if (normalized > 1_000_000) {
    return 1_000_000;
  }

  return normalized;
}

function normalizeBackgroundTimeoutSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_BACKGROUND_TIMEOUT_SECONDS;
  }

  const normalized = Math.trunc(value);
  if (normalized < 30) {
    return 30;
  }

  if (normalized > 1_800) {
    return 1_800;
  }

  return normalized;
}

function normalizeMemoryExtractionProviderSettings(value: unknown): MemoryExtractionProviderSettings {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_MEMORY_EXTRACTION_PROVIDER_SETTINGS };
  }

  const candidate = value as Partial<MemoryExtractionProviderSettings>;
  return {
    model: typeof candidate.model === "string" && candidate.model.trim() ? candidate.model.trim() : DEFAULT_MODEL_ID,
    reasoningEffort: normalizeReasoningEffort(candidate.reasoningEffort, DEFAULT_REASONING_EFFORT),
    outputTokensThreshold: normalizeOutputTokensThreshold(candidate.outputTokensThreshold),
    timeoutSeconds: normalizeBackgroundTimeoutSeconds(candidate.timeoutSeconds),
  };
}

function normalizeCharacterReflectionProviderSettings(value: unknown): CharacterReflectionProviderSettings {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_CHARACTER_REFLECTION_PROVIDER_SETTINGS };
  }

  const candidate = value as Partial<CharacterReflectionProviderSettings>;
  return {
    model: typeof candidate.model === "string" && candidate.model.trim() ? candidate.model.trim() : DEFAULT_MODEL_ID,
    reasoningEffort: normalizeReasoningEffort(candidate.reasoningEffort, DEFAULT_REASONING_EFFORT),
    timeoutSeconds: normalizeBackgroundTimeoutSeconds(candidate.timeoutSeconds),
  };
}

function normalizeMateMemoryGenerationTriggerIntervalMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MATE_MEMORY_GENERATION_TRIGGER_INTERVAL_MINUTES;
  }

  const normalized = Math.trunc(value);
  if (normalized < 1) {
    return 1;
  }

  if (normalized > 14_400) {
    return 14_400;
  }

  return normalized;
}

function normalizeMateMemoryGenerationProviderSettings(value: unknown): MateMemoryGenerationProviderSettings {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_MATE_MEMORY_GENERATION_PROVIDER_SETTINGS };
  }

  const candidate = value as Partial<MateMemoryGenerationProviderSettings>;
  return {
    provider: normalizeProviderId(typeof candidate.provider === "string" ? candidate.provider : DEFAULT_PROVIDER_ID),
    model: typeof candidate.model === "string" && candidate.model.trim() ? candidate.model.trim() : DEFAULT_MODEL_ID,
    reasoningEffort: normalizeReasoningEffort(candidate.reasoningEffort, DEFAULT_REASONING_EFFORT),
    timeoutSeconds: normalizeBackgroundTimeoutSeconds(candidate.timeoutSeconds),
  };
}

function normalizeMateMemoryGenerationSettings(value: unknown): MateMemoryGenerationSettings {
  if (!value || typeof value !== "object") {
    return {
      ...DEFAULT_MATE_MEMORY_GENERATION_SETTINGS,
      priorityList: [{ ...DEFAULT_MATE_MEMORY_GENERATION_PROVIDER_SETTINGS }],
    };
  }

  const candidate = value as Partial<MateMemoryGenerationSettings>;
  const normalizedPriorityList = Array.isArray(candidate.priorityList)
    ? candidate.priorityList.map((entry) => normalizeMateMemoryGenerationProviderSettings(entry))
    : null;

  return {
    priorityList:
      normalizedPriorityList && normalizedPriorityList.length > 0
        ? normalizedPriorityList
        : [{ ...DEFAULT_MATE_MEMORY_GENERATION_PROVIDER_SETTINGS }],
    triggerIntervalMinutes: normalizeMateMemoryGenerationTriggerIntervalMinutes(candidate.triggerIntervalMinutes),
  };
}

function normalizeCharacterReflectionTriggerSettings(value: unknown): CharacterReflectionTriggerSettings {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_CHARACTER_REFLECTION_TRIGGER_SETTINGS };
  }

  const candidate = value as Partial<CharacterReflectionTriggerSettings>;
  return {
    cooldownSeconds: normalizeCharacterReflectionCooldownSeconds(candidate.cooldownSeconds),
    charDeltaThreshold: normalizeCharacterReflectionCharDeltaThreshold(candidate.charDeltaThreshold),
    messageDeltaThreshold: normalizeCharacterReflectionMessageDeltaThreshold(candidate.messageDeltaThreshold),
  };
}

export function normalizeAppSettings(value: unknown): AppSettings {
  const defaults = createDefaultAppSettings();
  if (!value || typeof value !== "object") {
    return defaults;
  }

  const candidate = value as Partial<AppSettings>;
  const rawCodingProviderSettings =
    candidate.codingProviderSettings && typeof candidate.codingProviderSettings === "object"
      ? candidate.codingProviderSettings
      : null;
  const rawMemoryExtractionProviderSettings =
    candidate.memoryExtractionProviderSettings && typeof candidate.memoryExtractionProviderSettings === "object"
      ? candidate.memoryExtractionProviderSettings
      : null;
  const rawCharacterReflectionProviderSettings =
    candidate.characterReflectionProviderSettings && typeof candidate.characterReflectionProviderSettings === "object"
      ? candidate.characterReflectionProviderSettings
      : null;
  const codingProviderSettings: Record<string, ProviderAppSettings> = {};
  const memoryExtractionProviderSettings: Record<string, MemoryExtractionProviderSettings> = {};
  const characterReflectionProviderSettings: Record<string, CharacterReflectionProviderSettings> = {};
  if (rawCodingProviderSettings) {
    for (const [providerId, providerSettingsValue] of Object.entries(rawCodingProviderSettings)) {
      const normalizedProviderId = normalizeProviderId(providerId);
      codingProviderSettings[normalizedProviderId] = normalizeProviderAppSettings(
        providerSettingsValue,
        normalizedProviderId === DEFAULT_PROVIDER_ID,
      );
    }
  }
  if (rawMemoryExtractionProviderSettings) {
    for (const [providerId, providerSettingsValue] of Object.entries(rawMemoryExtractionProviderSettings)) {
      const normalizedProviderId = normalizeProviderId(providerId);
      memoryExtractionProviderSettings[normalizedProviderId] = normalizeMemoryExtractionProviderSettings(providerSettingsValue);
    }
  }
  if (rawCharacterReflectionProviderSettings) {
    for (const [providerId, providerSettingsValue] of Object.entries(rawCharacterReflectionProviderSettings)) {
      const normalizedProviderId = normalizeProviderId(providerId);
      characterReflectionProviderSettings[normalizedProviderId] = normalizeCharacterReflectionProviderSettings(providerSettingsValue);
    }
  }

  if (!codingProviderSettings[DEFAULT_PROVIDER_ID]) {
    codingProviderSettings[DEFAULT_PROVIDER_ID] = { ...defaults.codingProviderSettings[DEFAULT_PROVIDER_ID] };
  }
  if (!memoryExtractionProviderSettings[DEFAULT_PROVIDER_ID]) {
    memoryExtractionProviderSettings[DEFAULT_PROVIDER_ID] = { ...defaults.memoryExtractionProviderSettings[DEFAULT_PROVIDER_ID] };
  }
  if (!characterReflectionProviderSettings[DEFAULT_PROVIDER_ID]) {
    characterReflectionProviderSettings[DEFAULT_PROVIDER_ID] = { ...defaults.characterReflectionProviderSettings[DEFAULT_PROVIDER_ID] };
  }

  return {
    systemPromptPrefix: typeof candidate.systemPromptPrefix === "string" ? candidate.systemPromptPrefix : "",
    memoryGenerationEnabled:
      typeof candidate.memoryGenerationEnabled === "boolean" ? candidate.memoryGenerationEnabled : true,
    autoCollapseActionDockOnSend:
      typeof candidate.autoCollapseActionDockOnSend === "boolean" ? candidate.autoCollapseActionDockOnSend : true,
    characterReflectionTriggerSettings: normalizeCharacterReflectionTriggerSettings(candidate.characterReflectionTriggerSettings),
    mateMemoryGenerationSettings: normalizeMateMemoryGenerationSettings(candidate.mateMemoryGenerationSettings),
    codingProviderSettings,
    memoryExtractionProviderSettings,
    characterReflectionProviderSettings,
  };
}

export function getProviderAppSettings(settings: AppSettings, providerId: string | null | undefined): ProviderAppSettings {
  const normalizedProviderId = normalizeProviderId(providerId);
  const resolvedSettings = normalizeAppSettings(settings);
  return normalizeProviderAppSettings(
    resolvedSettings.codingProviderSettings[normalizedProviderId],
    normalizedProviderId === DEFAULT_PROVIDER_ID,
  );
}

export function getMemoryExtractionProviderSettings(
  settings: AppSettings,
  providerId: string | null | undefined,
): MemoryExtractionProviderSettings {
  const normalizedProviderId = normalizeProviderId(providerId);
  const resolvedSettings = normalizeAppSettings(settings);
  return normalizeMemoryExtractionProviderSettings(
    resolvedSettings.memoryExtractionProviderSettings[normalizedProviderId],
  );
}

export function getCharacterReflectionProviderSettings(
  settings: AppSettings,
  providerId: string | null | undefined,
): CharacterReflectionProviderSettings {
  const normalizedProviderId = normalizeProviderId(providerId);
  const resolvedSettings = normalizeAppSettings(settings);
  return normalizeCharacterReflectionProviderSettings(
    resolvedSettings.characterReflectionProviderSettings[normalizedProviderId],
  );
}

export function getCharacterReflectionTriggerSettings(settings: AppSettings): CharacterReflectionTriggerSettings {
  const resolvedSettings = normalizeAppSettings(settings);
  return normalizeCharacterReflectionTriggerSettings(resolvedSettings.characterReflectionTriggerSettings);
}

export function getMateMemoryGenerationSettings(settings: AppSettings): MateMemoryGenerationSettings {
  const resolvedSettings = normalizeAppSettings(settings);
  return normalizeMateMemoryGenerationSettings(resolvedSettings.mateMemoryGenerationSettings);
}

export function getResolvedProviderSettingsBundle(
  settings: AppSettings,
  providerId: string | null | undefined,
): ResolvedProviderSettingsBundle {
  return {
    coding: getProviderAppSettings(settings, providerId),
    memoryExtraction: getMemoryExtractionProviderSettings(settings, providerId),
    characterReflection: getCharacterReflectionProviderSettings(settings, providerId),
  };
}
