import type { ModelReasoningEffort } from "./model-catalog.js";

export type MateProfileState = "draft" | "active" | "deleted";
export type MateStorageState = "not_created" | MateProfileState;
export type MateProfileSectionState = {
  sectionKey: "core" | "bond" | "work_style" | "notes" | "project_digest";
  filePath: string;
  sha256: string;
  byteSize: number;
  updatedByRevisionId: string | null;
  updatedAt: string;
  projectionAllowed?: boolean;
};

export type MateProfile = {
  id: string;
  state: MateProfileState;
  displayName: string;
  description: string;
  themeMain: string;
  themeSub: string;
  avatarFilePath: string;
  avatarSha256: string;
  avatarByteSize: number;
  activeRevisionId: string | null;
  profileGeneration: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  sections: MateProfileSectionState[];
};

export type MateGrowthCandidateMode = "every_turn" | "threshold" | "manual";
export const MATE_GROWTH_MODEL_PREFERENCES = [
  "memory_candidate",
  "profile_update",
  "project_digest",
] as const;
export type MateGrowthModelPreferencePurpose = (typeof MATE_GROWTH_MODEL_PREFERENCES)[number];

export const DEFAULT_MATE_GROWTH_APPLY_INTERVAL_MINUTES = 60;

export type MateGrowthSettings = {
  enabled: boolean;
  autoApplyEnabled: boolean;
  memoryCandidateMode: MateGrowthCandidateMode;
  applyIntervalMinutes: number;
  modelPreferences: MateGrowthModelPreference[];
  updatedAt: string;
};

export type MateGrowthModelPreference = {
  purpose: MateGrowthModelPreferencePurpose;
  priority: number;
  provider: string;
  model: string;
  depth: string;
  enabled: boolean;
};

export type UpdateMateGrowthModelPreferenceInput = {
  purpose: MateGrowthModelPreferencePurpose;
  priority?: number;
  provider: string;
  model: string;
  depth: string;
  enabled?: boolean;
};

export type UpdateMateGrowthSettingsInput = {
  enabled?: boolean;
  autoApplyEnabled?: boolean;
  memoryCandidateMode?: MateGrowthCandidateMode;
  applyIntervalMinutes?: number;
  modelPreferences?: UpdateMateGrowthModelPreferenceInput[];
};

export type CreateMateInput = {
  displayName: string;
  description?: string;
  themeMain?: string;
  themeSub?: string;
  avatarFilePath?: string;
  avatarSha256?: string;
  avatarByteSize?: number;
};

export type UpdateMateInput = {
  displayName?: string;
  description?: string;
  themeMain?: string;
  themeSub?: string;
};

export type SetMateAvatarInput = {
  avatarFilePath?: string | null;
};

export type MateTalkTurnInput = {
  message: string;
  provider?: string;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
};

export type MateTalkTurnResult = {
  mateId: string;
  userMessage: string;
  assistantMessage: string;
  createdAt: string;
};
