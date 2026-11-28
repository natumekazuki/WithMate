import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  CREATE_V4_SCHEMA_SQL,
  APP_DATABASE_V4_FILENAME,
  isLegacyAppDatabasePath,
} from "../storage/database-schema-v4.js";
import { openAppDatabase } from "../storage/sqlite-connection.js";
import {
  DEFAULT_MATE_GROWTH_APPLY_INTERVAL_MINUTES,
  type MateGrowthModelPreferencePurpose,
  type MateGrowthCandidateMode,
  type MateGrowthModelPreference,
  type MateGrowthSettings,
  type UpdateMateGrowthModelPreferenceInput,
  type UpdateMateGrowthSettingsInput,
} from "../../src-shared/mate/mate-state.js";

const MATE_ID = "current";
const MATE_DIRECTORY_NAME = "mate";
const MATE_REVISIONS_DIRECTORY_NAME = "revisions";
const MATE_AVATAR_FILE_PATH = "mate/avatar.png";
const MATE_GROWTH_DEFAULT_MODEL_PREFERENCE_PROVIDER_ID = "codex";
const MATE_GROWTH_DEFAULT_MODEL_PREFERENCE_MODEL = "gpt-5.4";
const MATE_GROWTH_DEFAULT_MODEL_PREFERENCE_DEPTH = "low";
const MATE_GROWTH_SUPPORTED_MODEL_PREFERENCE_PURPOSE = "memory_candidate";
const MATE_SECTION_FILES = [
  { key: "core", relativePath: "mate/core.md" },
  { key: "bond", relativePath: "mate/bond.md" },
  { key: "work_style", relativePath: "mate/work-style.md" },
  { key: "notes", relativePath: "mate/notes.md" },
] as const;

/** Mate の固定ファイルに対応するプロフィール区分のキー。 */
export type MateSectionKey = (typeof MATE_SECTION_FILES)[number]["key"];

/** 保存済みプロフィールの下書き、有効、削除済みを区別する状態値。 */
export type MateProfileState = "draft" | "active" | "deleted";
/** プロフィール自体の状態に加え、未作成と保存非対応を区別する。 */
export type MateStorageState =
  "not_created" | "profile_unavailable" | MateProfileState;

/** 現在の Mate の表示情報、アバター、リビジョン参照を保持する SQLite 行。 */
type MateProfileRow = {
  id: string;
  state: MateProfileState;
  display_name: string;
  description: string;
  theme_main: string;
  theme_sub: string;
  avatar_file_path: string;
  avatar_sha256: string;
  avatar_byte_size: number;
  active_revision_id: string | null;
  profile_generation: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

/** 区分の投影ファイルパス、照合情報、最終更新元を保持する SQLite 行。 */
type MateProfileSectionRow = {
  mate_id: string;
  section_key: MateSectionKey;
  file_path: string;
  sha256: string;
  byte_size: number;
  updated_by_revision_id: string | null;
  updated_at: string;
};

/** Growth の動作モードと実行間隔を、真偽値は整数として読み出す SQLite 行。 */
type MateGrowthSettingsRow = {
  enabled: number;
  auto_apply_enabled: number;
  memory_candidate_mode: "every_turn" | "threshold" | "manual";
  apply_interval_minutes: number;
  updated_at: string;
};

/** 用途と優先度別に Growth のモデル、推論設定、有効性を保持する SQLite 行。 */
type MateGrowthModelPreferenceRow = {
  purpose: MateGrowthModelPreferencePurpose;
  priority: number;
  provider_id: string;
  model: string;
  reasoning_effort: string;
  enabled: number;
};

/** 区分ごとの投影ファイルを特定し、照合するための保存済みメタデータ。 */
export type MateProfileSectionState = {
  sectionKey: MateSectionKey;
  filePath: string;
  sha256: string;
  byteSize: number;
  updatedByRevisionId: string | null;
  updatedAt: string;
};

/** 想定した投影ファイルと実ファイルの差異を、欠損・読取不能・サイズ違い・ハッシュ違いに分けて示す。 */
export type MateProfileFileMismatch = {
  sectionKey: MateSectionKey;
  filePath: string;
  expectedHash: string;
  actualHash: string;
  expectedByteSize: number;
  actualByteSize: number;
  reason: "missing" | "hash_mismatch" | "size_mismatch" | "unreadable";
};

/** 現在の Mate の表示用情報、生成世代、利用可能なリビジョン、区分別のファイル情報。 */
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

/** Mate の初期表示情報。指定されたアバターは取り込み時に実ファイルからメタデータを計算する。 */
export type CreateMateInput = {
  displayName: string;
  description?: string;
  themeMain?: string;
  themeSub?: string;
  avatarFilePath?: string;
  avatarSha256?: string;
  avatarByteSize?: number;
};

/** 既存 Mate の表示情報の部分更新。未指定のフィールドは既存値を保つ。 */
export type UpdateMateInput = {
  displayName?: string;
  description?: string;
  themeMain?: string;
  themeSub?: string;
};

/** 取り込むアバターのパス。未指定、null、空白では既存アバターを解除する。 */
export type SetMateAvatarInput = {
  avatarFilePath?: string | null;
};

/** 更新する区分ファイルの新しい本文と、その区分に対応する規定相対パス。 */
export type ApplyMateProfileFileInput = {
  sectionKey: MateSectionKey;
  relativePath: string;
  content: string;
};

/** プロフィール投影の反映内容。ファイル書き込み後の確定前処理と、DB 確定と同時に実行する処理を指定できる。 */
export type ApplyMateProfileFilesInput = {
  sourceGrowthEventId?: string | null;
  summary: string;
  files: ApplyMateProfileFileInput[];
  beforeFinalize?: (context: {
    profile: MateProfile;
    revisionId: string;
    now: string;
  }) => Promise<void> | void;
  finalizeInTransaction?: (context: {
    db: DatabaseSync;
    revisionId: string;
    now: string;
  }) => void;
};

/** プロフィールやリビジョンの記録に使う UTC の ISO 8601 時刻を返す。 */
function nowIso(): string {
  return new Date().toISOString();
}

/** 投影ファイルやアバターの照合用 SHA-256 を十六進表記で求める。 */
function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** SQLite に記録する本文のファイルサイズを、UTF-8 のバイト数として求める。 */
function byteSize(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

/** 有限の実行間隔を整数に切り捨て、保存可能な 1〜14,400 分に収める。 */
function normalizeApplyIntervalMinutes(applyIntervalMinutes: number): number {
  if (!Number.isFinite(applyIntervalMinutes)) {
    throw new Error("applyIntervalMinutes は有限の数値で指定してね。");
  }

  return Math.min(14_400, Math.max(1, Math.trunc(applyIntervalMinutes)));
}

/** メモリ候補の作成モードが保存可能な三つの値のいずれかであることを確認する。 */
function normalizeMemoryCandidateMode(mode: string): MateGrowthCandidateMode {
  if (mode === "every_turn" || mode === "threshold" || mode === "manual") {
    return mode;
  }

  throw new Error(
    "memoryCandidateMode は every_turn / threshold / manual のいずれかで指定してね。",
  );
}

/** メモリ候補用のモデル設定を高々 1 件に制限し、保存用に整える。省略と空配列はそれぞれ維持と解除を表す。 */
function normalizeGrowthModelPreferences(
  modelPreferences: Array<UpdateMateGrowthModelPreferenceInput> | undefined,
): Array<MateGrowthModelPreference> | undefined {
  if (modelPreferences === undefined) {
    return undefined;
  }

  if (!Array.isArray(modelPreferences)) {
    throw new Error("modelPreferences は配列で指定してね。");
  }

  if (modelPreferences.length === 0) {
    return [];
  }

  if (modelPreferences.length > 1) {
    throw new Error(
      "modelPreferences は current runtime では memory_candidate 1 件だけ指定してね。",
    );
  }

  const normalized = modelPreferences.map((preference, index) => {
    if (
      preference === null ||
      typeof preference !== "object" ||
      Array.isArray(preference)
    ) {
      throw new Error("modelPreferences は配列で指定してね。");
    }

    const purpose = preference.purpose;
    if (purpose !== MATE_GROWTH_SUPPORTED_MODEL_PREFERENCE_PURPOSE) {
      throw new Error(
        "purpose は current runtime では memory_candidate だけ指定してね。",
      );
    }

    if (typeof preference.provider !== "string") {
      throw new Error("provider は文字列で指定してね。");
    }
    const provider = preference.provider.trim();
    if (!provider) {
      throw new Error("provider は空にできないよ。");
    }

    if (typeof preference.model !== "string") {
      throw new Error("model は文字列で指定してね。");
    }
    const model = preference.model.trim();
    if (!model) {
      throw new Error("model は空にできないよ。");
    }

    if (typeof preference.depth !== "string") {
      throw new Error("depth は文字列で指定してね。");
    }
    const depth = preference.depth.trim();

    let priority = preference.priority;
    if (priority !== undefined) {
      if (!Number.isFinite(priority)) {
        throw new Error("priority は有限の数値で指定してね。");
      }
      priority = Math.trunc(priority);
      if (priority < 1) {
        throw new Error("priority は1以上で指定してね。");
      }
    }

    const enabled = preference.enabled ?? true;
    if (typeof enabled !== "boolean") {
      throw new Error("enabled は boolean で指定してね。");
    }

    return {
      purpose,
      provider,
      model,
      depth,
      priority,
      enabled,
      index,
    };
  });

  const hasPriority = normalized.some(
    (preference) => typeof preference.priority === "number",
  );
  const ordered = hasPriority
    ? [...normalized].sort((left, right) => {
        if (left.priority === right.priority) {
          return left.index - right.index;
        }
        return (left.priority ?? 0) - (right.priority ?? 0);
      })
    : [...normalized].sort((left, right) => left.index - right.index);

  return ordered.map((preference, index) => ({
    purpose: preference.purpose,
    provider: preference.provider,
    model: preference.model,
    depth: preference.depth,
    enabled: preference.enabled,
    priority: index + 1,
  }));
}

/** Growth 設定の部分更新を処理する前に、入力が配列でないオブジェクトかを確認する。 */
function assertMateGrowthSettingsInput(
  input: UpdateMateGrowthSettingsInput,
): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Mate Growth 設定の更新内容は object で指定してね。");
  }
}

/** 表示名の前後の空白を除き、未指定の表示設定やアバターメタデータに初期値を補う。 */
function withDefaults(input: CreateMateInput): Required<CreateMateInput> {
  const displayName = input.displayName.trim();

  return {
    displayName,
    description: input.description ?? "",
    themeMain: input.themeMain ?? "#6f8cff",
    themeSub: input.themeSub ?? "#6fb8c7",
    avatarFilePath: input.avatarFilePath ?? "",
    avatarSha256: input.avatarSha256 ?? "",
    avatarByteSize:
      typeof input.avatarByteSize === "number" && input.avatarByteSize >= 0
        ? input.avatarByteSize
        : 0,
  };
}

/** 相対資産パスをユーザーデータディレクトリから解決し、空・絶対パス・スキーム付き文字列はそのまま扱う。 */
function materializeMateAssetPath(
  userDataPath: string,
  filePath: string,
): string {
  const trimmed = filePath.trim();
  if (
    !trimmed ||
    path.isAbsolute(trimmed) ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  ) {
    return trimmed;
  }

  return path.join(userDataPath, trimmed);
}

/** 指定された表示情報のみ取り出し、表示名を更新する場合は前後の空白を除いて空でないことを確認する。 */
function normalizeMateUpdate(input: UpdateMateInput): UpdateMateInput {
  const output: UpdateMateInput = {};

  if (input.displayName !== undefined) {
    const displayName = input.displayName.trim();
    if (!displayName) {
      throw new Error("displayName が空だよ。");
    }
    output.displayName = displayName;
  }

  if (input.description !== undefined) {
    output.description = input.description;
  }
  if (input.themeMain !== undefined) {
    output.themeMain = input.themeMain;
  }
  if (input.themeSub !== undefined) {
    output.themeSub = input.themeSub;
  }

  return output;
}

/** Mate ディレクトリの削除処理を差し替えるためのファイルシステム依存。 */
type MateStorageFileSystem = {
  rm?: typeof rm;
};

/** Mate のプロフィール、Growth 設定、投影ファイルと各リビジョンのスナップショットを管理する。 */
export class MateStorage {
  private db: DatabaseSync | null;
  private readonly userDataPath: string;
  private readonly isLegacyDatabase: boolean;
  private readonly removeFileSystemEntry: typeof rm;

  /** DB 接続とユーザーデータの保存先を設定し、V4 の保存先ではスキーマを準備して未完了リビジョンを失敗扱いにする。 */
  constructor(
    dbPath: string,
    userDataPath: string,
    fileSystem: MateStorageFileSystem = {},
  ) {
    this.userDataPath = userDataPath;
    this.isLegacyDatabase =
      isLegacyAppDatabasePath(dbPath) ||
      !dbPath.endsWith(APP_DATABASE_V4_FILENAME);
    this.removeFileSystemEntry = fileSystem.rm ?? rm;
    this.db = openAppDatabase(dbPath);
    if (!this.isLegacyDatabase) {
      this.initializeSchema();
      this.recoverIncompleteRevisions();
    }
  }

  /** 保持中の SQLite 接続で処理を実行し、接続を閉じた後の利用は拒否する。 */
  private withDb<T>(runner: (db: DatabaseSync) => T): T {
    if (!this.db) {
      throw new Error("MateStorage は close 済みだよ。");
    }

    return runner(this.db);
  }

  /** 書き込み用トランザクションで処理を実行し、失敗時はロールバックして例外を返す。 */
  private withTransaction<T>(runner: (db: DatabaseSync) => T): T {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION;");
      try {
        const result = runner(db);
        db.exec("COMMIT;");
        return result;
      } catch (error) {
        db.exec("ROLLBACK;");
        throw error;
      }
    });
  }

  /** V4 以外の保存先で実行できない処理を、操作名を含むエラーで止める。 */
  private assertV4StorageAvailable(operation: string): void {
    if (!this.isLegacyDatabase) {
      return;
    }

    throw new Error(
      `${operation} requires withmate-v4.db; legacy DB does not support Mate profile persistence.`,
    );
  }

  /** V4 のテーブル定義を適用し、古いリビジョン区分のテーブルに不足列を補う。 */
  initializeSchema(): void {
    this.assertV4StorageAvailable("MateStorage.initializeSchema");
    this.withDb((db) => {
      for (const statement of CREATE_V4_SCHEMA_SQL) {
        db.exec(statement);
      }
      this.ensureMateProfileRevisionSectionsColumns(db);
    });
  }

  /** 旧テーブルに written_at 列がない場合に、既存行の値を空文字列とする列を追加する。 */
  private ensureMateProfileRevisionSectionsColumns(db: DatabaseSync): void {
    const columns = db
      .prepare("PRAGMA table_info(mate_profile_revision_sections)")
      .all() as Array<{
      name: string;
    }>;

    const hasWrittenAt = columns.some((column) => column.name === "written_at");
    if (!hasWrittenAt) {
      db.exec(
        "ALTER TABLE mate_profile_revision_sections ADD COLUMN written_at TEXT NOT NULL DEFAULT '';",
      );
    }
  }

  /** 起動時に残った準備中・ファイル反映中のリビジョンを失敗扱いにし、確定済みのリビジョンは変更しない。 */
  private recoverIncompleteRevisions(): void {
    this.assertV4StorageAvailable("MateStorage.recoverIncompleteRevisions");
    const now = nowIso();
    this.withDb((db) => {
      db.prepare(
        `
        UPDATE mate_profile_revisions
        SET status = 'failed',
            failed_at = COALESCE(failed_at, ?)
        WHERE mate_id = ?
          AND status IN ('staging', 'committing_files')
      `,
      ).run(now, MATE_ID);
    });
  }

  /** 投影、アバター、スナップショットを格納する Mate ディレクトリの絶対パスを返す。 */
  private getMateDirectoryPath(): string {
    return path.join(this.userDataPath, MATE_DIRECTORY_NAME);
  }

  /** DB に記録する、ユーザーデータディレクトリからリビジョンのスナップショットまでの相対パスを返す。 */
  private getRevisionSnapshotRelativePath(revisionId: string): string {
    return `${MATE_DIRECTORY_NAME}/${MATE_REVISIONS_DIRECTORY_NAME}/${revisionId}`;
  }

  /** リビジョン別のスナップショットの書き込み先を、ユーザーデータディレクトリから解決する。 */
  private getRevisionSnapshotAbsolutePath(revisionId: string): string {
    return path.join(
      this.userDataPath,
      this.getRevisionSnapshotRelativePath(revisionId),
    );
  }

  /** 区分ファイルのベース名を使って、指定スナップショット内のファイルの絶対パスを求める。 */
  private getSectionSnapshotAbsolutePath(
    snapshotDirPath: string,
    sectionRelativePath: string,
  ): string {
    return path.join(
      this.userDataPath,
      snapshotDirPath,
      path.basename(sectionRelativePath),
    );
  }

  /** 取り込み済みアバターを置く固定ファイルの絶対パスを返す。 */
  private getMateAvatarAbsolutePath(): string {
    return path.join(this.userDataPath, MATE_AVATAR_FILE_PATH);
  }

  /** 保存機能が使えない場合、プロフィールが未作成の場合、保存済みの場合を区別して返す。 */
  getMateState(): MateStorageState {
    if (this.isLegacyDatabase) {
      return "profile_unavailable";
    }

    const profile = this.getMateProfile();
    return profile ? profile.state : "not_created";
  }

  /** Mate の投影ファイルやアバターの相対パスを解決する基準ディレクトリを返す。 */
  getUserDataPath(): string {
    return this.userDataPath;
  }

  /** プロフィールと区分を読み、アバターパスと有効なリビジョン参照を解決して返す。保存非対応または未作成なら null を返す。 */
  getMateProfile(): MateProfile | null {
    if (this.isLegacyDatabase) {
      return null;
    }

    return this.withDb((db) => {
      const profileRow = db
        .prepare(
          `
        SELECT
          id,
          state,
          display_name,
          description,
          theme_main,
          theme_sub,
          avatar_file_path,
          avatar_sha256,
          avatar_byte_size,
          active_revision_id,
          profile_generation,
          created_at,
          updated_at,
          deleted_at
        FROM mate_profile
        WHERE id = ?
      `,
        )
        .get(MATE_ID) as MateProfileRow | undefined;

      if (!profileRow) {
        return null;
      }

      const sectionRows = db
        .prepare(
          `
        SELECT
          mate_id,
          section_key,
          file_path,
          sha256,
          byte_size,
          updated_by_revision_id,
          updated_at
        FROM mate_profile_sections
        WHERE mate_id = ?
        ORDER BY section_key
      `,
        )
        .all(MATE_ID) as MateProfileSectionRow[];

      return {
        id: profileRow.id,
        state: profileRow.state,
        displayName: profileRow.display_name,
        description: profileRow.description,
        themeMain: profileRow.theme_main,
        themeSub: profileRow.theme_sub,
        avatarFilePath: materializeMateAssetPath(
          this.userDataPath,
          profileRow.avatar_file_path,
        ),
        avatarSha256: profileRow.avatar_sha256,
        avatarByteSize: profileRow.avatar_byte_size,
        activeRevisionId: this.getReadyActiveRevisionId(
          db,
          profileRow.active_revision_id,
        ),
        profileGeneration: profileRow.profile_generation,
        createdAt: profileRow.created_at,
        updatedAt: profileRow.updated_at,
        deletedAt: profileRow.deleted_at,
        sections: sectionRows.map((sectionRow) => ({
          sectionKey: sectionRow.section_key,
          filePath: sectionRow.file_path,
          sha256: sectionRow.sha256,
          byteSize: sectionRow.byte_size,
          updatedByRevisionId: sectionRow.updated_by_revision_id,
          updatedAt: sectionRow.updated_at,
        })),
      };
    });
  }

  /** 投影済みファイルを DB のバイトサイズとハッシュで照合し、不一致または読取不能の区分だけを返す。 */
  async verifyMateProfileFiles(): Promise<MateProfileFileMismatch[]> {
    const profile = this.getMateProfile();
    if (!profile) {
      return [];
    }

    const mismatches: MateProfileFileMismatch[] = [];

    for (const section of profile.sections) {
      const absolutePath = path.join(this.userDataPath, section.filePath);
      let content: string;

      try {
        content = await readFile(absolutePath, "utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const missing = code === "ENOENT";
        mismatches.push({
          sectionKey: section.sectionKey,
          filePath: section.filePath,
          expectedHash: section.sha256,
          actualHash: "",
          expectedByteSize: section.byteSize,
          actualByteSize: 0,
          reason: missing ? "missing" : "unreadable",
        });
        continue;
      }

      const actualHash = sha256Hex(content);
      const actualByteSize = byteSize(content);

      if (actualByteSize !== section.byteSize) {
        mismatches.push({
          sectionKey: section.sectionKey,
          filePath: section.filePath,
          expectedHash: section.sha256,
          actualHash,
          expectedByteSize: section.byteSize,
          actualByteSize,
          reason: "size_mismatch",
        });
      } else if (actualHash !== section.sha256) {
        mismatches.push({
          sectionKey: section.sectionKey,
          filePath: section.filePath,
          expectedHash: section.sha256,
          actualHash,
          expectedByteSize: section.byteSize,
          actualByteSize,
          reason: "hash_mismatch",
        });
      }
    }

    return mismatches;
  }

  /** DB が指すリビジョンが確定済みなら採用し、未確定・欠損・未設定なら最新の確定済みリビジョンを探す。 */
  private getReadyActiveRevisionId(
    db: DatabaseSync,
    activeRevisionId: string | null,
  ): string | null {
    if (!activeRevisionId) {
      return this.getLatestReadyRevisionId(db);
    }

    const revision = db
      .prepare(
        `
      SELECT status
      FROM mate_profile_revisions
      WHERE mate_id = ? AND id = ?
    `,
      )
      .get(MATE_ID, activeRevisionId) as { status: string } | undefined;

    if (revision?.status === "ready") {
      return activeRevisionId;
    }

    return this.getLatestReadyRevisionId(db);
  }

  /** 確定済みのリビジョンから連番が最大の ID を返し、なければ null を返す。 */
  private getLatestReadyRevisionId(db: DatabaseSync): string | null {
    const revision = db
      .prepare(
        `
      SELECT id
      FROM mate_profile_revisions
      WHERE mate_id = ? AND status = 'ready'
      ORDER BY seq DESC
      LIMIT 1
    `,
      )
      .get(MATE_ID) as { id: string } | undefined;

    return revision?.id ?? null;
  }

  /** 保存済みの Growth 設定に優先度順のモデル設定を添える。設定がないか保存非対応なら null を返す。 */
  getMateGrowthSettings(): MateGrowthSettings | null {
    if (this.isLegacyDatabase) {
      return null;
    }

    return this.withDb((db) => {
      const row = db
        .prepare(
          `
        SELECT
          enabled,
          auto_apply_enabled,
          memory_candidate_mode,
          apply_interval_minutes,
          updated_at
        FROM mate_growth_settings
        WHERE mate_id = ?
      `,
        )
        .get(MATE_ID) as MateGrowthSettingsRow | undefined;

      if (!row) {
        return null;
      }

      const preferenceRows = db
        .prepare(
          `
        SELECT
          purpose,
          priority,
          provider_id,
          model,
          reasoning_effort,
          enabled
        FROM mate_growth_model_preferences
        WHERE mate_id = ?
        ORDER BY priority ASC
      `,
        )
        .all(MATE_ID) as MateGrowthModelPreferenceRow[];

      return {
        enabled: row.enabled === 1,
        autoApplyEnabled: row.auto_apply_enabled === 1,
        memoryCandidateMode: row.memory_candidate_mode,
        applyIntervalMinutes: row.apply_interval_minutes,
        modelPreferences: preferenceRows.map((preferenceRow) => ({
          purpose: preferenceRow.purpose,
          priority: preferenceRow.priority,
          provider: preferenceRow.provider_id,
          model: preferenceRow.model,
          depth: preferenceRow.reasoning_effort,
          enabled: preferenceRow.enabled === 1,
        })),
        updatedAt: row.updated_at,
      };
    });
  }

  /** 正規化した Growth 実行間隔だけを更新日時とともに書き込み、設定を読み返す。 */
  updateMateGrowthApplyIntervalMinutes(
    applyIntervalMinutes: number,
  ): MateGrowthSettings | null {
    this.assertV4StorageAvailable(
      "MateStorage.updateMateGrowthApplyIntervalMinutes",
    );
    const normalizedApplyIntervalMinutes =
      normalizeApplyIntervalMinutes(applyIntervalMinutes);
    this.withDb((db) => {
      db.prepare(
        `
        UPDATE mate_growth_settings
        SET apply_interval_minutes = ?, updated_at = ?
        WHERE mate_id = ?
      `,
      ).run(normalizedApplyIntervalMinutes, nowIso(), MATE_ID);
    });

    return this.getMateGrowthSettings();
  }

  /** 指定された Growth 設定を部分更新し、モデル設定が指定された場合は同じトランザクションで一覧を置き換える。 */
  updateMateGrowthSettings(
    input: UpdateMateGrowthSettingsInput,
  ): MateGrowthSettings | null {
    this.assertV4StorageAvailable("MateStorage.updateMateGrowthSettings");
    assertMateGrowthSettingsInput(input);
    const normalizedModelPreferences = normalizeGrowthModelPreferences(
      input.modelPreferences,
    );

    const updates: string[] = [];
    const values: Array<number | string> = [];
    const hasModelPreferenceUpdate = normalizedModelPreferences !== undefined;

    if (input.enabled !== undefined) {
      if (typeof input.enabled !== "boolean") {
        throw new Error("enabled は boolean で指定してね。");
      }
      updates.push("enabled = ?");
      values.push(input.enabled ? 1 : 0);
    }
    if (input.autoApplyEnabled !== undefined) {
      if (typeof input.autoApplyEnabled !== "boolean") {
        throw new Error("autoApplyEnabled は boolean で指定してね。");
      }
      updates.push("auto_apply_enabled = ?");
      values.push(input.autoApplyEnabled ? 1 : 0);
    }
    if (input.memoryCandidateMode !== undefined) {
      updates.push("memory_candidate_mode = ?");
      values.push(normalizeMemoryCandidateMode(input.memoryCandidateMode));
    }
    if (input.applyIntervalMinutes !== undefined) {
      updates.push("apply_interval_minutes = ?");
      values.push(normalizeApplyIntervalMinutes(input.applyIntervalMinutes));
    }

    if (updates.length === 0 && !hasModelPreferenceUpdate) {
      return this.getMateGrowthSettings();
    }

    const current = this.getMateGrowthSettings();
    if (!current) {
      return null;
    }

    const updatedAt = nowIso();
    updates.push("updated_at = ?");
    values.push(updatedAt);
    values.push(MATE_ID);

    this.withTransaction((db) => {
      if (updates.length > 0) {
        db.prepare(
          `
          UPDATE mate_growth_settings
          SET ${updates.join(", ")}
          WHERE mate_id = ?
        `,
        ).run(...values);
      }

      if (hasModelPreferenceUpdate) {
        db.prepare(
          "DELETE FROM mate_growth_model_preferences WHERE mate_id = ?",
        ).run(MATE_ID);
        const insert = db.prepare(`
          INSERT INTO mate_growth_model_preferences (
            mate_id,
            purpose,
            priority,
            provider_id,
            model,
            reasoning_effort,
            enabled,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const preference of normalizedModelPreferences) {
          insert.run(
            MATE_ID,
            preference.purpose,
            preference.priority,
            preference.provider,
            preference.model,
            preference.depth,
            preference.enabled ? 1 : 0,
            updatedAt,
            updatedAt,
          );
        }
      }
    });

    return this.getMateGrowthSettings();
  }

  /** 未作成の Mate に初期プロフィール、空の区分ファイル、確定済みの初期リビジョンと既定の Growth 設定を作る。 */
  async createMate(input: CreateMateInput): Promise<MateProfile> {
    this.assertV4StorageAvailable("MateStorage.createMate");
    const normalized = withDefaults(input);

    if (!normalized.displayName.trim()) {
      throw new Error("displayName が空だよ。");
    }

    const existing = this.getMateProfile();
    if (existing) {
      throw new Error("Mate は既に作成済みだよ。");
    }

    const createdAt = nowIso();
    let avatarFilePath = normalized.avatarFilePath;
    let avatarSha256 = normalized.avatarSha256;
    let avatarByteSize = normalized.avatarByteSize;

    if (avatarFilePath) {
      const avatarMeta = await this.loadAvatarFromSourcePath(avatarFilePath);
      avatarFilePath = avatarMeta.avatarFilePath;
      avatarSha256 = avatarMeta.avatarSha256;
      avatarByteSize = avatarMeta.avatarByteSize;
    }

    const revisionId = randomUUID();
    const snapshotDirPath = this.getRevisionSnapshotRelativePath(revisionId);
    const sectionSeed = MATE_SECTION_FILES.map((section) => ({
      section,
      path: section.relativePath,
      content: "",
      sha256: sha256Hex(""),
      byteSize: Buffer.byteLength("", "utf8"),
    }));

    try {
      await this.ensureMateFiles(
        sectionSeed.map((section) => ({
          relativePath: section.path,
          content: "",
        })),
      );
      await this.saveRevisionSnapshotFiles(
        revisionId,
        sectionSeed.map((section) => ({
          relativePath: section.path,
          content: section.content,
        })),
      );

      this.withTransaction((db) => {
        db.prepare(
          `
          INSERT INTO mate_profile (
            id,
            state,
            display_name,
            description,
            theme_main,
            theme_sub,
            avatar_file_path,
            avatar_sha256,
            avatar_byte_size,
            active_revision_id,
            profile_generation,
            created_at,
            updated_at,
            deleted_at
          ) VALUES (?, 'active', ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, NULL)
        `,
        ).run(
          MATE_ID,
          normalized.displayName,
          normalized.description,
          normalized.themeMain,
          normalized.themeSub,
          avatarFilePath,
          avatarSha256,
          avatarByteSize,
          createdAt,
          createdAt,
        );

        for (const section of sectionSeed) {
          db.prepare(
            `
            INSERT INTO mate_profile_sections (
              mate_id,
              section_key,
              file_path,
              sha256,
              byte_size,
              updated_by_revision_id,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
          ).run(
            MATE_ID,
            section.section.key,
            section.path,
            section.sha256,
            section.byteSize,
            revisionId,
            createdAt,
          );
        }

        db.prepare(
          `
          INSERT INTO mate_profile_revisions (
            id,
            mate_id,
            seq,
            parent_revision_id,
            status,
            kind,
            source_growth_event_id,
            summary,
            snapshot_dir_path,
            created_by,
            created_at,
            ready_at,
            failed_at,
            reverted_by_revision_id
          ) VALUES (?, ?, 1, NULL, 'ready', 'initial', NULL, 'initial', ?, 'user', ?, ?, NULL, NULL)
        `,
        ).run(revisionId, MATE_ID, snapshotDirPath, createdAt, createdAt);

        for (const section of sectionSeed) {
          db.prepare(
            `
            INSERT INTO mate_profile_revision_sections (
              revision_id,
              section_key,
              file_path,
              before_sha256,
              after_sha256,
              before_byte_size,
              after_byte_size,
              written_at,
              diff_path
            ) VALUES (?, ?, ?, '', ?, 0, ?, ?, '')
          `,
          ).run(
            revisionId,
            section.section.key,
            section.path,
            section.sha256,
            section.byteSize,
            createdAt,
          );
        }

        db.prepare(
          `
          INSERT INTO mate_growth_settings (
            mate_id,
            enabled,
            auto_apply_enabled,
            min_auto_apply_confidence,
            memory_candidate_mode,
            memory_candidate_timeout_seconds,
            apply_interval_minutes,
            retrieval_strategy,
            retrieval_sql_candidate_limit,
            retrieval_embedding_candidate_limit,
            retrieval_final_limit,
            pending_count_threshold,
            pending_salience_threshold,
            cooldown_seconds,
            timeout_seconds,
            updated_at
          ) VALUES (?, 1, 1, 75, 'every_turn', 60, ?, 'hybrid', 80, 40, 12, 10, 300, 900, 180, ?)
        `,
        ).run(MATE_ID, DEFAULT_MATE_GROWTH_APPLY_INTERVAL_MINUTES, createdAt);

        const insertGrowthModelPreference = db.prepare(`
          INSERT INTO mate_growth_model_preferences (
            mate_id,
            purpose,
            priority,
            provider_id,
            model,
            reasoning_effort,
            enabled,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insertGrowthModelPreference.run(
          MATE_ID,
          MATE_GROWTH_SUPPORTED_MODEL_PREFERENCE_PURPOSE,
          1,
          MATE_GROWTH_DEFAULT_MODEL_PREFERENCE_PROVIDER_ID,
          MATE_GROWTH_DEFAULT_MODEL_PREFERENCE_MODEL,
          MATE_GROWTH_DEFAULT_MODEL_PREFERENCE_DEPTH,
          1,
          createdAt,
          createdAt,
        );

        db.prepare(
          `
          INSERT INTO mate_embedding_settings (
            mate_id,
            enabled,
            backend_type,
            model_id,
            source_model_id,
            dimension,
            cache_policy,
            cache_state,
            cache_dir_path,
            cache_manifest_sha256,
            model_revision,
            cache_size_bytes,
            cache_updated_at,
            last_verified_at,
            last_status,
            last_error_preview,
            created_at,
            updated_at
          ) VALUES (?, 1, 'local_transformers_js', 'Xenova/multilingual-e5-small', 'intfloat/multilingual-e5-small', 384, 'download_once_local_cache', 'missing', '', '', '', 0, NULL, NULL, 'unknown', '', ?, ?)
        `,
        ).run(MATE_ID, createdAt, createdAt);

        db.prepare(
          "UPDATE mate_profile SET active_revision_id = ?, updated_at = ? WHERE id = ?",
        ).run(revisionId, createdAt, MATE_ID);
      });
    } catch (error) {
      await this.deleteMateDirectory();
      throw error;
    }

    const profile = this.getMateProfile();
    if (!profile) {
      throw new Error("Mate 作成後の再読込に失敗したよ。");
    }

    return profile;
  }

  /** 有効な Mate の表示情報だけを更新し、区分ファイルとアクティブなリビジョンは維持する。 */
  async updateMate(input: UpdateMateInput): Promise<MateProfile> {
    this.assertV4StorageAvailable("MateStorage.updateMate");
    const profile = this.getMateProfile();
    if (!profile || profile.state !== "active") {
      throw new Error("Mate が作成されていないよ。");
    }

    const normalized = normalizeMateUpdate(input);
    const updatedAt = nowIso();

    this.withDb((db) => {
      db.prepare(
        `
        UPDATE mate_profile
        SET display_name = ?, description = ?, theme_main = ?, theme_sub = ?, updated_at = ?
        WHERE id = ?
      `,
      ).run(
        normalized.displayName ?? profile.displayName,
        normalized.description ?? profile.description,
        normalized.themeMain ?? profile.themeMain,
        normalized.themeSub ?? profile.themeSub,
        updatedAt,
        MATE_ID,
      );
    });

    const updatedProfile = this.getMateProfile();
    if (!updatedProfile) {
      throw new Error("Mate 更新後の再読込に失敗したよ。");
    }

    return updatedProfile;
  }

  /** 有効な Mate のアバターを取り込むか解除し、ファイルと DB の更新に失敗した場合は元のファイルの復元を試みる。 */
  async setMateAvatar(input: SetMateAvatarInput): Promise<MateProfile> {
    this.assertV4StorageAvailable("MateStorage.setMateAvatar");
    const profile = this.getMateProfile();
    if (!profile || profile.state !== "active") {
      throw new Error("Mate が作成されていないよ。");
    }

    const sourceAvatarFilePath = input.avatarFilePath?.trim() ?? "";
    const avatarAbsolutePath = this.getMateAvatarAbsolutePath();
    let previousAvatar: Buffer | null = null;
    let nextAvatarFilePath = "";
    let nextAvatarSha256 = "";
    let nextAvatarByteSize = 0;

    try {
      try {
        previousAvatar = await readFile(avatarAbsolutePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          throw error;
        }
      }

      if (sourceAvatarFilePath) {
        const avatarContent = await readFile(sourceAvatarFilePath);
        await mkdir(this.getMateDirectoryPath(), { recursive: true });
        await writeFile(avatarAbsolutePath, avatarContent);

        nextAvatarFilePath = MATE_AVATAR_FILE_PATH;
        nextAvatarSha256 = sha256Hex(avatarContent);
        nextAvatarByteSize = avatarContent.byteLength;
      } else {
        await rm(avatarAbsolutePath, { force: true });
      }

      this.withDb((db) => {
        db.prepare(
          `
          UPDATE mate_profile
          SET avatar_file_path = ?, avatar_sha256 = ?, avatar_byte_size = ?, updated_at = ?
          WHERE id = ?
        `,
        ).run(
          nextAvatarFilePath,
          nextAvatarSha256,
          nextAvatarByteSize,
          nowIso(),
          MATE_ID,
        );
      });
    } catch (error) {
      if (sourceAvatarFilePath) {
        if (previousAvatar === null) {
          try {
            await rm(avatarAbsolutePath, { force: true });
          } catch {
            // 可能な範囲でロールバックする。
          }
        } else {
          try {
            await writeFile(avatarAbsolutePath, previousAvatar);
          } catch {
            // 可能な範囲でロールバックする。
          }
        }
      } else if (previousAvatar !== null) {
        try {
          await writeFile(avatarAbsolutePath, previousAvatar);
        } catch {
          // 可能な範囲でロールバックする。
        }
      }

      throw error;
    }

    const updatedProfile = this.getMateProfile();
    if (!updatedProfile) {
      throw new Error("プロフィールの再取得に失敗したよ。");
    }

    return updatedProfile;
  }

  /** 有効なリビジョンのスナップショットから投影を復元し、復元できない場合も残っている不一致を検証して返す。 */
  async recoverMateProfileFilesFromActiveRevision(): Promise<
    MateProfileFileMismatch[]
  > {
    const profile = this.getMateProfile();
    if (!profile || !profile.activeRevisionId) {
      return [];
    }

    const restored = await this.restoreMateProfileFilesFromRevisionSnapshot(
      profile.activeRevisionId,
      profile.sections,
    );
    if (!restored) {
      return this.verifyMateProfileFiles();
    }

    return this.verifyMateProfileFiles();
  }

  /** 確定済みリビジョンの全区分を読み込めた場合だけ投影先に書き戻す。保存場所やファイルが欠けていれば false を返す。 */
  private async restoreMateProfileFilesFromRevisionSnapshot(
    revisionId: string,
    sections: readonly MateProfileSectionState[],
  ): Promise<boolean> {
    const activeRevision = this.withDb((db) => {
      return db
        .prepare(
          `
        SELECT snapshot_dir_path
        FROM mate_profile_revisions
        WHERE mate_id = ? AND id = ? AND status = 'ready'
      `,
        )
        .get(MATE_ID, revisionId) as { snapshot_dir_path: string } | undefined;
    });

    if (!activeRevision?.snapshot_dir_path) {
      return false;
    }

    const snapshotFiles: Array<{ relativePath: string; content: string }> = [];
    try {
      for (const section of sections) {
        const sectionSnapshotAbsolutePath = this.getSectionSnapshotAbsolutePath(
          activeRevision.snapshot_dir_path,
          section.filePath,
        );
        const content = await readFile(sectionSnapshotAbsolutePath, "utf8");
        snapshotFiles.push({
          relativePath: section.filePath,
          content,
        });
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT" || err.code === "EISDIR") {
        return false;
      }
      throw error;
    }

    await this.ensureMateFiles(snapshotFiles);
    return true;
  }

  /** 先に Mate ディレクトリを削除し、成功後にプロフィール行を削除する。保存非対応の DB は変更しない。 */
  async resetMate(): Promise<void> {
    if (this.isLegacyDatabase) {
      return;
    }

    await this.deleteMateDirectory();
    this.withTransaction((db) => {
      db.prepare("DELETE FROM mate_profile WHERE id = ?").run(MATE_ID);
    });
  }

  /** Mate ディレクトリを削除するが、DB のプロフィールはこの操作では変更しない。 */
  async deleteMateProjectionDirectory(): Promise<void> {
    await this.deleteMateDirectory();
  }

  /** 新しいスナップショットと区分ファイルを書いた後、DB でリビジョンを確定する。失敗時は前の投影の復元を試み、失敗リビジョンを記録する。 */
  async applyProfileFiles(
    input: ApplyMateProfileFilesInput,
  ): Promise<MateProfile> {
    this.assertV4StorageAvailable("MateStorage.applyProfileFiles");
    const profile = this.getMateProfile();
    if (!profile || profile.state !== "active") {
      throw new Error("Mate が作成されていないよ。");
    }

    const summary = input.summary.trim();
    if (!summary) {
      throw new Error("summary が空だよ。");
    }

    const sourceGrowthEventId = input.sourceGrowthEventId?.trim() || null;
    const files = normalizeProfileFiles(input.files);
    if (files.length === 0) {
      throw new Error("更新する Mate ファイルが空だよ。");
    }

    const revisionId = randomUUID();
    const snapshotDirPath = this.getRevisionSnapshotRelativePath(revisionId);
    const now = nowIso();
    const nextSequence = this.getNextProfileRevisionSequence();
    const sectionByKey = new Map(
      profile.sections.map((section) => [section.sectionKey, section]),
    );
    const nextSections = files.map((file) => {
      const currentSection = sectionByKey.get(file.sectionKey);
      if (!currentSection) {
        throw new Error(
          `Mate profile section が見つからないよ: ${file.sectionKey}`,
        );
      }

      return {
        ...file,
        beforeSha256: currentSection.sha256,
        beforeByteSize: currentSection.byteSize,
        afterSha256: sha256Hex(file.content),
        afterByteSize: byteSize(file.content),
      };
    });

    if (sourceGrowthEventId !== null) {
      this.assertSourceGrowthEventExists(sourceGrowthEventId);
    }

    this.withDb((db) => {
      db.prepare(
        `
        INSERT INTO mate_profile_revisions (
          id,
          mate_id,
          seq,
          parent_revision_id,
          status,
          kind,
          source_growth_event_id,
          summary,
          snapshot_dir_path,
          created_by,
          created_at,
          ready_at,
          failed_at,
          reverted_by_revision_id
        ) VALUES (?, ?, ?, ?, 'staging', 'growth_apply', ?, ?, ?, 'system', ?, NULL, NULL, NULL)
      `,
      ).run(
        revisionId,
        MATE_ID,
        nextSequence,
        profile.activeRevisionId,
        sourceGrowthEventId,
        summary,
        snapshotDirPath,
        now,
      );
    });

    this.withDb((db) => {
      db.prepare(
        `
        UPDATE mate_profile_revisions
        SET status = 'committing_files'
        WHERE id = ?
      `,
      ).run(revisionId);
    });

    try {
      const nextSectionByKey = new Map(
        nextSections.map((section) => [section.sectionKey, section.content]),
      );
      const snapshotFiles = await Promise.all(
        profile.sections.map(async (section) => {
          const currentContent = await readFile(
            path.join(this.userDataPath, section.filePath),
            "utf8",
          );
          return {
            relativePath: section.filePath,
            content: nextSectionByKey.get(section.sectionKey) ?? currentContent,
          };
        }),
      );

      await this.saveRevisionSnapshotFiles(revisionId, snapshotFiles);

      await this.ensureMateFiles(
        nextSections.map((section) => ({
          relativePath: section.relativePath,
          content: section.content,
        })),
      );
    } catch (error) {
      try {
        if (profile.activeRevisionId) {
          await this.restoreMateProfileFilesFromRevisionSnapshot(
            profile.activeRevisionId,
            profile.sections,
          );
        }
      } catch {
        // DB は前回 active revision のままなので、復旧失敗時も failed 記録を優先する。
      }
      this.withDb((db) => {
        db.prepare(
          `
          UPDATE mate_profile_revisions
          SET status = 'failed', failed_at = ?
          WHERE id = ?
        `,
        ).run(nowIso(), revisionId);
      });
      throw error;
    }

    try {
      const nextSectionMetadataByKey = new Map(
        nextSections.map((section) => [section.sectionKey, section]),
      );
      const pendingProfile: MateProfile = {
        ...profile,
        activeRevisionId: revisionId,
        profileGeneration: profile.profileGeneration + 1,
        updatedAt: now,
        sections: profile.sections.map((section) => {
          const nextSection = nextSectionMetadataByKey.get(section.sectionKey);
          if (!nextSection) {
            return section;
          }

          return {
            ...section,
            filePath: nextSection.relativePath,
            sha256: nextSection.afterSha256,
            byteSize: nextSection.afterByteSize,
            updatedByRevisionId: revisionId,
            updatedAt: now,
          };
        }),
      };

      await input.beforeFinalize?.({
        profile: pendingProfile,
        revisionId,
        now,
      });

      this.withTransaction((db) => {
        db.prepare(
          `
          UPDATE mate_profile_revisions
          SET status = 'ready', ready_at = ?
          WHERE id = ?
        `,
        ).run(now, revisionId);

        for (const section of nextSections) {
          db.prepare(
            `
            INSERT INTO mate_profile_revision_sections (
              revision_id,
              section_key,
              file_path,
              before_sha256,
              after_sha256,
              before_byte_size,
              after_byte_size,
              written_at,
              diff_path
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '')
          `,
          ).run(
            revisionId,
            section.sectionKey,
            section.relativePath,
            section.beforeSha256,
            section.afterSha256,
            section.beforeByteSize,
            section.afterByteSize,
            now,
          );

          db.prepare(
            `
            UPDATE mate_profile_sections
            SET
              file_path = ?,
              sha256 = ?,
              byte_size = ?,
              updated_by_revision_id = ?,
              updated_at = ?
            WHERE mate_id = ? AND section_key = ?
          `,
          ).run(
            section.relativePath,
            section.afterSha256,
            section.afterByteSize,
            revisionId,
            now,
            MATE_ID,
            section.sectionKey,
          );
        }

        input.finalizeInTransaction?.({ db, revisionId, now });

        db.prepare(
          `
          UPDATE mate_profile
          SET
            active_revision_id = ?,
            profile_generation = profile_generation + 1,
            updated_at = ?
          WHERE id = ?
        `,
        ).run(revisionId, now, MATE_ID);
      });
    } catch (error) {
      try {
        if (profile.activeRevisionId) {
          await this.restoreMateProfileFilesFromRevisionSnapshot(
            profile.activeRevisionId,
            profile.sections,
          );
        }
      } catch {
        // DB は前回 active revision のままなので、復旧失敗時も failed 記録を優先する。
      }
      this.withDb((db) => {
        db.prepare(
          `
          UPDATE mate_profile_revisions
          SET status = 'failed', failed_at = ?
          WHERE id = ?
        `,
        ).run(nowIso(), revisionId);
      });
      throw error;
    }

    const updatedProfile = this.getMateProfile();
    if (!updatedProfile) {
      throw new Error("Mate 更新後の再読込に失敗したよ。");
    }

    return updatedProfile;
  }

  /** 指定された Growth Event が存在しない場合、リビジョンに無効な出典を記録する前に拒否する。 */
  private assertSourceGrowthEventExists(sourceGrowthEventId: string): void {
    const row = this.withDb(
      (db) =>
        db
          .prepare("SELECT id FROM mate_growth_events WHERE id = ?")
          .get(sourceGrowthEventId) as { id: string } | undefined,
    );

    if (!row) {
      throw new Error(
        `sourceGrowthEventId が見つからないよ: ${sourceGrowthEventId}`,
      );
    }
  }

  /** 指定区分の投影を UTF-8 で書き込み、途中で失敗した場合は成功済みの書き込みを逆順に戻すよう試みる。 */
  private async ensureMateFiles(
    files: Array<{ relativePath: string; content: string }>,
  ): Promise<void> {
    const mateDirectoryPath = this.getMateDirectoryPath();
    await mkdir(mateDirectoryPath, { recursive: true });

    const writtenFiles: Array<{
      absolutePath: string;
      previousContent: string | null;
    }> = [];

    try {
      for (const { relativePath, content } of files) {
        const absolutePath = path.join(this.userDataPath, relativePath);
        let previousContent: string | null = null;

        try {
          previousContent = await readFile(absolutePath, "utf8");
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            throw error;
          }
        }

        await writeFile(absolutePath, content, "utf8");
        writtenFiles.push({ absolutePath, previousContent });
      }
    } catch (error) {
      for (const { absolutePath, previousContent } of writtenFiles.reverse()) {
        try {
          if (previousContent === null) {
            await rm(absolutePath, { force: true });
          } else {
            await writeFile(absolutePath, previousContent, "utf8");
          }
        } catch {
          // 可能な範囲でロールバックする。失敗したリビジョンは呼び出し元で記録する。
        }
      }
      throw error;
    }
  }

  /** 現在の Mate に記録されたリビジョンの最大連番に 1 を加え、初回は 1 を返す。 */
  private getNextProfileRevisionSequence(): number {
    return this.withDb((db) => {
      const row = db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM mate_profile_revisions WHERE mate_id = ?",
        )
        .get(MATE_ID) as { next_seq: number };
      return row.next_seq;
    });
  }

  /** 投影・アバター・スナップショットを含む Mate ディレクトリを再帰削除する。 */
  private async deleteMateDirectory(): Promise<void> {
    await this.removeFileSystemEntry(this.getMateDirectoryPath(), {
      recursive: true,
      force: true,
    });
  }

  /** 指定ファイルを固定のアバター保存先にコピーし、コピーした内容のハッシュとバイト数を返す。 */
  private async loadAvatarFromSourcePath(
    sourceAvatarFilePath: string,
  ): Promise<{
    avatarFilePath: string;
    avatarSha256: string;
    avatarByteSize: number;
  }> {
    const avatarContent = await readFile(sourceAvatarFilePath);
    await mkdir(this.getMateDirectoryPath(), { recursive: true });
    const avatarAbsolutePath = this.getMateAvatarAbsolutePath();
    await writeFile(avatarAbsolutePath, avatarContent);
    return {
      avatarFilePath: MATE_AVATAR_FILE_PATH,
      avatarSha256: sha256Hex(avatarContent),
      avatarByteSize: avatarContent.byteLength,
    };
  }

  /** 新しいリビジョン別ディレクトリに区分の完全な本文を書き出し、失敗時は途中までの出力の削除を試みる。 */
  private async saveRevisionSnapshotFiles(
    revisionId: string,
    files: Array<{ relativePath: string; content: string }>,
  ): Promise<void> {
    const snapshotDirectoryPath =
      this.getRevisionSnapshotAbsolutePath(revisionId);
    await mkdir(snapshotDirectoryPath, { recursive: true });

    const writtenFiles: string[] = [];
    try {
      for (const { relativePath, content } of files) {
        const snapshotFilePath = this.getSectionSnapshotAbsolutePath(
          this.getRevisionSnapshotRelativePath(revisionId),
          relativePath,
        );
        await writeFile(snapshotFilePath, content, "utf8");
        writtenFiles.push(snapshotFilePath);
      }
    } catch (error) {
      for (const absolutePath of writtenFiles.reverse()) {
        try {
          await rm(absolutePath, { force: true });
        } catch {
          // 可能な範囲でロールバックする。
        }
      }

      try {
        await rm(snapshotDirectoryPath, { recursive: true, force: true });
      } catch {
        // 可能な範囲でロールバックする。
      }

      throw error;
    }
  }

  /** SQLite 接続を閉じ、後続処理が閉じた接続を使えないようにする。 */
  close(): void {
    this.withDb((db) => {
      db.close();
      this.db = null;
    });
  }
}

/** 区分の重複や未知の区分を拒否し、表記を整えたパスが区分の規定相対パスと一致することを確認する。 */
function normalizeProfileFiles(
  files: ApplyMateProfileFileInput[],
): ApplyMateProfileFileInput[] {
  const seen = new Set<string>();
  return files.map((file) => {
    const sectionKey = file.sectionKey;
    if (!MATE_SECTION_FILES.some((section) => section.key === sectionKey)) {
      throw new Error(`sectionKey が不正です: ${sectionKey}`);
    }
    if (seen.has(sectionKey)) {
      throw new Error(`sectionKey が重複しているよ: ${sectionKey}`);
    }
    seen.add(sectionKey);

    const relativePath = file.relativePath.trim().replace(/\\/g, "/");
    const canonical = MATE_SECTION_FILES.find(
      (section) => section.key === sectionKey,
    )?.relativePath;
    if (!canonical || relativePath !== canonical) {
      throw new Error(`relativePath が不正です: ${file.relativePath}`);
    }

    if (
      !relativePath ||
      path.isAbsolute(relativePath) ||
      relativePath.startsWith("../") ||
      relativePath.includes("/../")
    ) {
      throw new Error(`relativePath が不正です: ${file.relativePath}`);
    }

    return {
      sectionKey,
      relativePath,
      content: file.content,
    };
  });
}
