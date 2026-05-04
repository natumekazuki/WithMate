import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  CREATE_V4_SCHEMA_SQL,
} from "./database-schema-v4.js";
import { openAppDatabase } from "./sqlite-connection.js";

const MATE_ID = "current";
const MATE_DIRECTORY_NAME = "mate";

const MATE_SECTION_FILES = [
  { key: "core", relativePath: "mate/core.md" },
  { key: "bond", relativePath: "mate/bond.md" },
  { key: "work_style", relativePath: "mate/work-style.md" },
  { key: "notes", relativePath: "mate/notes.md" },
] as const;

export type MateSectionKey = (typeof MATE_SECTION_FILES)[number]["key"];

export type MateProfileState = "draft" | "active" | "deleted";
export type MateStorageState = "not_created" | MateProfileState;

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

type MateProfileSectionRow = {
  mate_id: string;
  section_key: MateSectionKey;
  file_path: string;
  sha256: string;
  byte_size: number;
  updated_by_revision_id: string | null;
  updated_at: string;
};

type MateGrowthSettingsRow = {
  enabled: number;
  auto_apply_enabled: number;
  memory_candidate_mode: "every_turn" | "threshold" | "manual";
  apply_interval_minutes: number;
  updated_at: string;
};

export type MateProfileSectionState = {
  sectionKey: MateSectionKey;
  filePath: string;
  sha256: string;
  byteSize: number;
  updatedByRevisionId: string | null;
  updatedAt: string;
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

export type MateGrowthSettings = {
  enabled: boolean;
  autoApplyEnabled: boolean;
  memoryCandidateMode: "every_turn" | "threshold" | "manual";
  applyIntervalMinutes: number;
  updatedAt: string;
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

export type ApplyMateProfileFileInput = {
  sectionKey: MateSectionKey;
  relativePath: string;
  content: string;
};

export type ApplyMateProfileFilesInput = {
  sourceGrowthEventId?: string | null;
  summary: string;
  files: ApplyMateProfileFileInput[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function byteSize(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

function withDefaults(input: CreateMateInput): Required<CreateMateInput> {
  const displayName = input.displayName.trim();

  return {
    displayName,
    description: input.description ?? "",
    themeMain: input.themeMain ?? "#6f8cff",
    themeSub: input.themeSub ?? "#6fb8c7",
    avatarFilePath: input.avatarFilePath ?? "",
    avatarSha256: input.avatarSha256 ?? "",
    avatarByteSize: typeof input.avatarByteSize === "number" && input.avatarByteSize >= 0 ? input.avatarByteSize : 0,
  };
}

export class MateStorage {
  private db: DatabaseSync | null;
  private readonly userDataPath: string;

  constructor(dbPath: string, userDataPath: string) {
    this.userDataPath = userDataPath;
    this.db = openAppDatabase(dbPath);
    this.initializeSchema();
  }

  private withDb<T>(runner: (db: DatabaseSync) => T): T {
    if (!this.db) {
      throw new Error("MateStorage は close 済みだよ。");
    }

    return runner(this.db);
  }

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

  initializeSchema(): void {
    this.withDb((db) => {
      for (const statement of CREATE_V4_SCHEMA_SQL) {
        db.exec(statement);
      }
    });
  }

  private getMateDirectoryPath(): string {
    return path.join(this.userDataPath, MATE_DIRECTORY_NAME);
  }

  getMateState(): MateStorageState {
    const profile = this.getMateProfile();
    return profile ? profile.state : "not_created";
  }

  getMateProfile(): MateProfile | null {
    return this.withDb((db) => {
      const profileRow = db.prepare(`
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
      `).get(MATE_ID) as MateProfileRow | undefined;

      if (!profileRow) {
        return null;
      }

      const sectionRows = db.prepare(`
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
      `).all(MATE_ID) as MateProfileSectionRow[];

      return {
        id: profileRow.id,
        state: profileRow.state,
        displayName: profileRow.display_name,
        description: profileRow.description,
        themeMain: profileRow.theme_main,
        themeSub: profileRow.theme_sub,
        avatarFilePath: profileRow.avatar_file_path,
        avatarSha256: profileRow.avatar_sha256,
        avatarByteSize: profileRow.avatar_byte_size,
        activeRevisionId: profileRow.active_revision_id,
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

  getMateGrowthSettings(): MateGrowthSettings | null {
    return this.withDb((db) => {
      const row = db.prepare(`
        SELECT
          enabled,
          auto_apply_enabled,
          memory_candidate_mode,
          apply_interval_minutes,
          updated_at
        FROM mate_growth_settings
        WHERE mate_id = ?
      `).get(MATE_ID) as MateGrowthSettingsRow | undefined;

      if (!row) {
        return null;
      }

      return {
        enabled: row.enabled === 1,
        autoApplyEnabled: row.auto_apply_enabled === 1,
        memoryCandidateMode: row.memory_candidate_mode,
        applyIntervalMinutes: row.apply_interval_minutes,
        updatedAt: row.updated_at,
      };
    });
  }

  async createMate(input: CreateMateInput): Promise<MateProfile> {
    const normalized = withDefaults(input);

    if (!normalized.displayName.trim()) {
      throw new Error("displayName が空だよ。");
    }

    const existing = this.getMateProfile();
    if (existing) {
      throw new Error("Mate は既に作成済みだよ。");
    }

    const createdAt = nowIso();
    const revisionId = randomUUID();
    const sectionSeed = MATE_SECTION_FILES.map((section) => ({
      section,
      path: section.relativePath,
      content: "",
      sha256: sha256Hex(""),
      byteSize: Buffer.byteLength("", "utf8"),
    }));

    await this.ensureMateFiles(sectionSeed.map((section) => ({
      relativePath: section.path,
      content: "",
    })));

    try {
      this.withTransaction((db) => {
        db.prepare(`
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
        `).run(
          MATE_ID,
          normalized.displayName,
          normalized.description,
          normalized.themeMain,
          normalized.themeSub,
          normalized.avatarFilePath,
          normalized.avatarSha256,
          normalized.avatarByteSize,
          createdAt,
          createdAt,
        );

        for (const section of sectionSeed) {
          db.prepare(`
            INSERT INTO mate_profile_sections (
              mate_id,
              section_key,
              file_path,
              sha256,
              byte_size,
              updated_by_revision_id,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            MATE_ID,
            section.section.key,
            section.path,
            section.sha256,
            section.byteSize,
            revisionId,
            createdAt,
          );
        }

        db.prepare(`
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
          ) VALUES (?, ?, 1, NULL, 'ready', 'initial', NULL, 'initial', '', 'user', ?, ?, NULL, NULL)
        `).run(
          revisionId,
          MATE_ID,
          createdAt,
          createdAt,
        );

        for (const section of sectionSeed) {
          db.prepare(`
            INSERT INTO mate_profile_revision_sections (
              revision_id,
              section_key,
              file_path,
              before_sha256,
              after_sha256,
              before_byte_size,
              after_byte_size,
              diff_path
            ) VALUES (?, ?, ?, '', ?, 0, ?, '')
          `).run(
            revisionId,
            section.section.key,
            section.path,
            section.sha256,
            section.byteSize,
          );
        }

        db.prepare(`
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
          ) VALUES (?, 1, 1, 75, 'every_turn', 60, 60, 'hybrid', 80, 40, 12, 10, 300, 900, 180, ?)
        `).run(
          MATE_ID,
          createdAt,
        );

        db.prepare(`
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
        `).run(
          MATE_ID,
          createdAt,
          createdAt,
        );

        db.prepare("UPDATE mate_profile SET active_revision_id = ?, updated_at = ? WHERE id = ?").run(
          revisionId,
          createdAt,
          MATE_ID,
        );
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

  async resetMate(): Promise<void> {
    this.withTransaction((db) => {
      db.prepare("DELETE FROM mate_profile WHERE id = ?").run(MATE_ID);
    });
    await this.deleteMateDirectory();
  }

  async applyProfileFiles(input: ApplyMateProfileFilesInput): Promise<MateProfile> {
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
    const now = nowIso();
    const nextSequence = this.getNextProfileRevisionSequence();
    const sectionByKey = new Map(profile.sections.map((section) => [section.sectionKey, section]));
    const nextSections = files.map((file) => {
      const currentSection = sectionByKey.get(file.sectionKey);
      if (!currentSection) {
        throw new Error(`Mate profile section が見つからないよ: ${file.sectionKey}`);
      }

      return {
        ...file,
        beforeSha256: currentSection.sha256,
        beforeByteSize: currentSection.byteSize,
        afterSha256: sha256Hex(file.content),
        afterByteSize: byteSize(file.content),
      };
    });

    await this.ensureMateFiles(nextSections.map((section) => ({
      relativePath: section.relativePath,
      content: section.content,
    })));

    this.withTransaction((db) => {
      db.prepare(`
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
        ) VALUES (?, ?, ?, ?, 'ready', 'growth_apply', ?, ?, '', 'system', ?, ?, NULL, NULL)
      `).run(
        revisionId,
        MATE_ID,
        nextSequence,
        profile.activeRevisionId,
        sourceGrowthEventId,
        summary,
        now,
        now,
      );

      for (const section of nextSections) {
        db.prepare(`
          UPDATE mate_profile_sections
          SET
            file_path = ?,
            sha256 = ?,
            byte_size = ?,
            updated_by_revision_id = ?,
            updated_at = ?
          WHERE mate_id = ? AND section_key = ?
        `).run(
          section.relativePath,
          section.afterSha256,
          section.afterByteSize,
          revisionId,
          now,
          MATE_ID,
          section.sectionKey,
        );

        db.prepare(`
          INSERT INTO mate_profile_revision_sections (
            revision_id,
            section_key,
            file_path,
            before_sha256,
            after_sha256,
            before_byte_size,
            after_byte_size,
            diff_path
          ) VALUES (?, ?, ?, ?, ?, ?, ?, '')
        `).run(
          revisionId,
          section.sectionKey,
          section.relativePath,
          section.beforeSha256,
          section.afterSha256,
          section.beforeByteSize,
          section.afterByteSize,
        );
      }

      db.prepare(`
        UPDATE mate_profile
        SET
          active_revision_id = ?,
          profile_generation = profile_generation + 1,
          updated_at = ?
        WHERE id = ?
      `).run(revisionId, now, MATE_ID);
    });

    const updatedProfile = this.getMateProfile();
    if (!updatedProfile) {
      throw new Error("Mate 更新後の再読込に失敗したよ。");
    }

    return updatedProfile;
  }

  private async ensureMateFiles(files: Array<{ relativePath: string; content: string }>): Promise<void> {
    const mateDirectoryPath = this.getMateDirectoryPath();
    await mkdir(mateDirectoryPath, { recursive: true });

    await Promise.all(files.map(({ relativePath, content }) => writeFile(
      path.join(this.userDataPath, relativePath),
      content,
      "utf8",
    )));
  }

  private getNextProfileRevisionSequence(): number {
    return this.withDb((db) => {
      const row = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM mate_profile_revisions WHERE mate_id = ?").get(
        MATE_ID,
      ) as { next_seq: number };
      return row.next_seq;
    });
  }

  private async deleteMateDirectory(): Promise<void> {
    await rm(this.getMateDirectoryPath(), { recursive: true, force: true });
  }

  close(): void {
    this.withDb((db) => {
      db.close();
      this.db = null;
    });
  }
}

function normalizeProfileFiles(files: ApplyMateProfileFileInput[]): ApplyMateProfileFileInput[] {
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
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.startsWith("../") || relativePath.includes("/../")) {
      throw new Error(`relativePath が不正です: ${file.relativePath}`);
    }

    return {
      sectionKey,
      relativePath,
      content: file.content,
    };
  });
}
