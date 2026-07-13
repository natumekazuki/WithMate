import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  DEFAULT_REASONING_EFFORT,
  isModelReasoningEffort,
  normalizeProviderId,
  type ModelReasoningEffort,
} from "./model-catalog.js";
import {
  createDefaultUserMicrocopyCatalog,
  normalizeUserMicrocopyCatalog,
  type MicrocopyCatalog,
} from "./microcopy-state.js";

export type AppSettings = {
  memoryGenerationEnabled: boolean;
  launchAtLoginEnabled: boolean;
  autoCollapseActionDockOnSend: boolean;
  memoryFileQuotaBytes: number;
  userMicrocopyCatalog: MicrocopyCatalog;
  mateMemoryGenerationSettings: MateMemoryGenerationSettings;
  codingProviderSettings: Record<string, ProviderAppSettings>;
  memoryExtractionProviderSettings: Record<string, MemoryExtractionProviderSettings>;
};

export type ProviderAppSettings = {
  enabled: boolean;
  apiKey: string;
  skillRootPath: string;
  skillRelativePath?: string;
  instructionRelativePath?: string;
};

export type MemoryExtractionProviderSettings = {
  model: string;
  reasoningEffort: ModelReasoningEffort;
  outputTokensThreshold: number;
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

export type ResolvedProviderSettingsBundle = {
  coding: ProviderAppSettings;
  memoryExtraction: MemoryExtractionProviderSettings;
};

export const DEFAULT_PROVIDER_APP_SETTINGS: ProviderAppSettings = {
  enabled: false,
  apiKey: "",
  skillRootPath: "",
  skillRelativePath: "",
  instructionRelativePath: "",
};

export const DEFAULT_MEMORY_EXTRACTION_OUTPUT_TOKENS_THRESHOLD = 300_000;
export const DEFAULT_BACKGROUND_TIMEOUT_SECONDS = 180;
export const MEMORY_FILE_QUOTA_DEFAULT_BYTES = 1_073_741_824;
export const MEMORY_FILE_QUOTA_MIN_BYTES = 67_108_864;
export const MEMORY_FILE_QUOTA_MAX_BYTES = 53_687_091_200;

export const DEFAULT_MEMORY_EXTRACTION_PROVIDER_SETTINGS: MemoryExtractionProviderSettings = {
  model: DEFAULT_MODEL_ID,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  outputTokensThreshold: DEFAULT_MEMORY_EXTRACTION_OUTPUT_TOKENS_THRESHOLD,
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

export function createDefaultAppSettings(): AppSettings {
  return {
    memoryGenerationEnabled: true,
    launchAtLoginEnabled: false,
    autoCollapseActionDockOnSend: true,
    memoryFileQuotaBytes: MEMORY_FILE_QUOTA_DEFAULT_BYTES,
    userMicrocopyCatalog: createDefaultUserMicrocopyCatalog(),
    mateMemoryGenerationSettings: {
      ...DEFAULT_MATE_MEMORY_GENERATION_SETTINGS,
      priorityList: [{ ...DEFAULT_MATE_MEMORY_GENERATION_PROVIDER_SETTINGS }],
    },
    codingProviderSettings: {
      [DEFAULT_PROVIDER_ID]: {
        enabled: true,
        apiKey: "",
        skillRootPath: "",
        skillRelativePath: "",
        instructionRelativePath: "",
      },
    },
    memoryExtractionProviderSettings: {
      [DEFAULT_PROVIDER_ID]: { ...DEFAULT_MEMORY_EXTRACTION_PROVIDER_SETTINGS },
    },
  };
}

function normalizeReasoningEffort(value: unknown, fallback: ModelReasoningEffort): ModelReasoningEffort {
  return isModelReasoningEffort(value) ? value : fallback;
}

function normalizeProviderAppSettings(value: unknown, defaultEnabled: boolean): ProviderAppSettings {
  if (!value || typeof value !== "object") {
    return {
      enabled: defaultEnabled,
      apiKey: "",
      skillRootPath: "",
      skillRelativePath: "",
      instructionRelativePath: "",
    };
  }

  const candidate = value as Partial<ProviderAppSettings>;
  return {
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : defaultEnabled,
    apiKey: typeof candidate.apiKey === "string" ? candidate.apiKey : "",
    skillRootPath: typeof candidate.skillRootPath === "string" ? candidate.skillRootPath : "",
    skillRelativePath: typeof candidate.skillRelativePath === "string" ? candidate.skillRelativePath : "",
    instructionRelativePath: typeof candidate.instructionRelativePath === "string" ? candidate.instructionRelativePath : "",
  };
}

export function resolveProviderSkillRootPath(settings: ProviderAppSettings): string {
  const rootDirectory = settings.skillRootPath.trim().replace(/[\\/]+$/g, "");
  const skillRelativePath = (settings.skillRelativePath ?? "").trim().replace(/^[\\/]+|[\\/]+$/g, "");
  if (!rootDirectory || !skillRelativePath) {
    return rootDirectory;
  }

  return `${rootDirectory}/${skillRelativePath}`;
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

export function normalizeMemoryFileQuotaBytes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return MEMORY_FILE_QUOTA_DEFAULT_BYTES;
  }

  const normalized = Math.trunc(value);
  if (normalized < MEMORY_FILE_QUOTA_MIN_BYTES) {
    return MEMORY_FILE_QUOTA_MIN_BYTES;
  }

  if (normalized > MEMORY_FILE_QUOTA_MAX_BYTES) {
    return MEMORY_FILE_QUOTA_MAX_BYTES;
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
  const codingProviderSettings: Record<string, ProviderAppSettings> = {};
  const memoryExtractionProviderSettings: Record<string, MemoryExtractionProviderSettings> = {};
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
  if (!codingProviderSettings[DEFAULT_PROVIDER_ID]) {
    codingProviderSettings[DEFAULT_PROVIDER_ID] = { ...defaults.codingProviderSettings[DEFAULT_PROVIDER_ID] };
  }
  if (!memoryExtractionProviderSettings[DEFAULT_PROVIDER_ID]) {
    memoryExtractionProviderSettings[DEFAULT_PROVIDER_ID] = { ...defaults.memoryExtractionProviderSettings[DEFAULT_PROVIDER_ID] };
  }
  return {
    memoryGenerationEnabled:
      typeof candidate.memoryGenerationEnabled === "boolean" ? candidate.memoryGenerationEnabled : true,
    launchAtLoginEnabled:
      typeof candidate.launchAtLoginEnabled === "boolean" ? candidate.launchAtLoginEnabled : false,
    autoCollapseActionDockOnSend:
      typeof candidate.autoCollapseActionDockOnSend === "boolean" ? candidate.autoCollapseActionDockOnSend : true,
    memoryFileQuotaBytes: normalizeMemoryFileQuotaBytes(candidate.memoryFileQuotaBytes),
    userMicrocopyCatalog: normalizeUserMicrocopyCatalog(candidate.userMicrocopyCatalog),
    mateMemoryGenerationSettings: normalizeMateMemoryGenerationSettings(candidate.mateMemoryGenerationSettings),
    codingProviderSettings,
    memoryExtractionProviderSettings,
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
  };
}
