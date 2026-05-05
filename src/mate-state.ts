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

export type MateGrowthSettings = {
  enabled: boolean;
  autoApplyEnabled: boolean;
  memoryCandidateMode: MateGrowthCandidateMode;
  applyIntervalMinutes: number;
  updatedAt: string;
};

export type UpdateMateGrowthSettingsInput = {
  enabled?: boolean;
  autoApplyEnabled?: boolean;
  memoryCandidateMode?: MateGrowthCandidateMode;
  applyIntervalMinutes?: number;
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

export type MateTalkTurnInput = {
  message: string;
};

export type MateTalkTurnResult = {
  mateId: string;
  userMessage: string;
  assistantMessage: string;
  createdAt: string;
};
