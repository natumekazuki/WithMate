/** 保存済みプロフィールの作成途中・有効・削除済みの状態。 */
export type MateProfileState = "draft" | "active" | "deleted";
/** 保存状態に加え、まだ作成されていない場合と取得不能の場合を区別する。 */
export type MateStorageState =
  "not_created" | "profile_unavailable" | MateProfileState;
/** プロフィール節のファイル、内容の識別情報、更新された版と投影の許可状態。 */
export type MateProfileSectionState = {
  sectionKey: "core" | "bond" | "work_style" | "notes" | "project_digest";
  filePath: string;
  sha256: string;
  byteSize: number;
  updatedByRevisionId: string | null;
  updatedAt: string;
  projectionAllowed?: boolean;
};

/** Mateの表示情報とアバター、現在の版・世代、各節の保存状態。 */
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

/** 記憶候補を各Turn、条件到達、または手動で生成する設定。 */
export type MateGrowthCandidateMode = "every_turn" | "threshold" | "manual";
/** 成長処理でモデルの選択を分ける、記憶候補・プロフィール更新・プロジェクト要約。 */
export const MATE_GROWTH_MODEL_PREFERENCES = [
  "memory_candidate",
  "profile_update",
  "project_digest",
] as const;
/** モデル優先順位を適用する成長処理の用途。 */
export type MateGrowthModelPreferencePurpose =
  (typeof MATE_GROWTH_MODEL_PREFERENCES)[number];

/** 自動反映の間隔を設定していない場合の既定分数。 */
export const DEFAULT_MATE_GROWTH_APPLY_INTERVAL_MINUTES = 60;

/** 成長・自動反映の有効化、候補の生成条件と用途別のモデル選択を保持する。 */
export type MateGrowthSettings = {
  enabled: boolean;
  autoApplyEnabled: boolean;
  memoryCandidateMode: MateGrowthCandidateMode;
  applyIntervalMinutes: number;
  modelPreferences: MateGrowthModelPreference[];
  updatedAt: string;
};

/** 用途内での優先順位と、使うProvider・モデル・推論レベル、有効状態。 */
export type MateGrowthModelPreference = {
  purpose: MateGrowthModelPreferencePurpose;
  priority: number;
  provider: string;
  model: string;
  depth: string;
  enabled: boolean;
};

/** 更新するモデル候補。保存される優先順位と有効状態は省略できる。 */
export type UpdateMateGrowthModelPreferenceInput = {
  purpose: MateGrowthModelPreferencePurpose;
  priority?: number;
  provider: string;
  model: string;
  depth: string;
  enabled?: boolean;
};

/** 成長設定のうち更新する項目だけを渡す。 */
export type UpdateMateGrowthSettingsInput = {
  enabled?: boolean;
  autoApplyEnabled?: boolean;
  memoryCandidateMode?: MateGrowthCandidateMode;
  applyIntervalMinutes?: number;
  modelPreferences?: UpdateMateGrowthModelPreferenceInput[];
};

/** 新規プロフィールの表示名と、必要なら説明・配色・アバターファイル情報を渡す。 */
export type CreateMateInput = {
  displayName: string;
  description?: string;
  themeMain?: string;
  themeSub?: string;
  avatarFilePath?: string;
  avatarSha256?: string;
  avatarByteSize?: number;
};

/** 既存プロフィールの表示名・説明・配色を部分更新する。アバターは別の入力を使う。 */
export type UpdateMateInput = {
  displayName?: string;
  description?: string;
  themeMain?: string;
  themeSub?: string;
};

/** Mateのアバター画像ファイルを指定する。画像がない場合の値も受け付ける。 */
export type SetMateAvatarInput = {
  avatarFilePath?: string | null;
};
