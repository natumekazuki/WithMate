import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  DEFAULT_REASONING_EFFORT,
  normalizeProviderId,
  type ModelReasoningEffort,
} from "./model-catalog.js";

export type AppSettings = {
  systemPromptPrefix: string;
  codingProviderSettings: Record<string, ProviderAppSettings>;
  memoryExtractionProviderSettings: Record<string, MemoryExtractionProviderSettings>;
  characterReflectionProviderSettings: Record<string, CharacterReflectionProviderSettings>;
};

export type ProviderAppSettings = {
  enabled: boolean;
  apiKey: string;
  skillRootPath: string;
};

export type MemoryExtractionProviderSettings = {
  model: string;
  reasoningEffort: ModelReasoningEffort;
  outputTokensThreshold: number;
};

export type CharacterReflectionProviderSettings = {
  model: string;
  reasoningEffort: ModelReasoningEffort;
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

export const DEFAULT_MEMORY_EXTRACTION_OUTPUT_TOKENS_THRESHOLD = 200;

export const DEFAULT_MEMORY_EXTRACTION_PROVIDER_SETTINGS: MemoryExtractionProviderSettings = {
  model: DEFAULT_MODEL_ID,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  outputTokensThreshold: DEFAULT_MEMORY_EXTRACTION_OUTPUT_TOKENS_THRESHOLD,
};

export const DEFAULT_CHARACTER_REFLECTION_PROVIDER_SETTINGS: CharacterReflectionProviderSettings = {
  model: DEFAULT_MODEL_ID,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
};

export function createDefaultAppSettings(): AppSettings {
  return {
    systemPromptPrefix: "",
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

  if (normalized > 100_000) {
    return 100_000;
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
    reasoningEffort:
      candidate.reasoningEffort === "minimal" ||
      candidate.reasoningEffort === "low" ||
      candidate.reasoningEffort === "medium" ||
      candidate.reasoningEffort === "high" ||
      candidate.reasoningEffort === "xhigh"
        ? candidate.reasoningEffort
        : DEFAULT_REASONING_EFFORT,
    outputTokensThreshold: normalizeOutputTokensThreshold(candidate.outputTokensThreshold),
  };
}

function normalizeCharacterReflectionProviderSettings(value: unknown): CharacterReflectionProviderSettings {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_CHARACTER_REFLECTION_PROVIDER_SETTINGS };
  }

  const candidate = value as Partial<CharacterReflectionProviderSettings>;
  return {
    model: typeof candidate.model === "string" && candidate.model.trim() ? candidate.model.trim() : DEFAULT_MODEL_ID,
    reasoningEffort:
      candidate.reasoningEffort === "minimal" ||
      candidate.reasoningEffort === "low" ||
      candidate.reasoningEffort === "medium" ||
      candidate.reasoningEffort === "high" ||
      candidate.reasoningEffort === "xhigh"
        ? candidate.reasoningEffort
        : DEFAULT_REASONING_EFFORT,
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
