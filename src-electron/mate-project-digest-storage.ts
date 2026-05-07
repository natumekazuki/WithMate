import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { CREATE_V4_SCHEMA_SQL } from "./database-schema-v4.js";
import { resolveProjectScope } from "./project-scope.js";
import { openAppDatabase } from "./sqlite-connection.js";

const MATE_ID = "current";

type MateProjectDigestRow = {
  id: string;
  mate_id: string;
  project_type: string;
  project_key: string;
  workspace_path: string;
  git_root: string;
  display_name: string;
  digest_file_path: string;
  sha256: string;
  byte_size: number;
  active_revision_id: string | null;
  last_growth_event_id: string | null;
  last_compiled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MateProjectDigest = {
  id: string;
  mateId: string;
  projectType: "git";
  projectKey: string;
  workspacePath: string;
  gitRoot: string;
  displayName: string;
  digestFilePath: string;
  sha256: string;
  byteSize: number;
  activeRevisionId: string | null;
  lastGrowthEventId: string | null;
  lastCompiledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RewriteProjectDigestProjectionInput = {
  projectDigestId: string;
  userDataPath: string;
  content: string;
  activeRevisionId: string | null;
  lastGrowthEventId: string | null;
};

export type RewriteProjectDigestProjectionResult = {
  digestFilePath: string;
  sha256: string;
  byteSize: number;
  lastCompiledAt: string;
  updatedAt: string;
};

export type ProjectDigestProjectionWriter = {
  rewriteProjectDigestProjection(
    input: RewriteProjectDigestProjectionInput,
  ): Promise<RewriteProjectDigestProjectionResult>;
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

function buildSafeProjectDigestFileStem(value: string): string {
  const text = value.trim().toLowerCase();
  const sanitized = text.replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "project-digest";
}

function buildProjectDigestRelativePath(projectDigestId: string): string {
  return path.join("mate", "project-digests", `${buildSafeProjectDigestFileStem(projectDigestId)}.md`).replace(/\\/g, "/");
}

async function readExistingTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException | undefined;
    if (nodeError?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function toProjectDigest(row: MateProjectDigestRow): MateProjectDigest | null {
  if (row.project_type !== "git") {
    return null;
  }

  return {
    id: row.id,
    mateId: row.mate_id,
    projectType: "git",
    projectKey: row.project_key,
    workspacePath: row.workspace_path,
    gitRoot: row.git_root,
    displayName: row.display_name,
    digestFilePath: row.digest_file_path,
    sha256: row.sha256,
    byteSize: row.byte_size,
    activeRevisionId: row.active_revision_id,
    lastGrowthEventId: row.last_growth_event_id,
    lastCompiledAt: row.last_compiled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MateProjectDigestStorage implements ProjectDigestProjectionWriter {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    this.initializeSchema();
  }

  private initializeSchema(): void {
    for (const statement of CREATE_V4_SCHEMA_SQL) {
      this.db.exec(statement);
    }
  }

  private withTransaction<T>(runner: (db: DatabaseSync) => T): T {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION;");
    try {
      const result = runner(this.db);
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  private getByProjectKey(projectKey: string): MateProjectDigest | null {
    const row = this.db.prepare(`
      SELECT
        id,
        mate_id,
        project_type,
        project_key,
        workspace_path,
        git_root,
        display_name,
        digest_file_path,
        sha256,
        byte_size,
        active_revision_id,
        last_growth_event_id,
        last_compiled_at,
        created_at,
        updated_at
      FROM mate_project_digests
      WHERE project_key = ?
      LIMIT 1
    `).get(projectKey) as MateProjectDigestRow | undefined;

    if (!row) {
      return null;
    }

    return toProjectDigest(row);
  }

  getById(projectDigestId: string): MateProjectDigest | null {
    const row = this.db.prepare(`
      SELECT
        id,
        mate_id,
        project_type,
        project_key,
        workspace_path,
        git_root,
        display_name,
        digest_file_path,
        sha256,
        byte_size,
        active_revision_id,
        last_growth_event_id,
        last_compiled_at,
        created_at,
        updated_at
      FROM mate_project_digests
      WHERE id = ?
      LIMIT 1
    `).get(projectDigestId) as MateProjectDigestRow | undefined;

    if (!row) {
      return null;
    }

    return toProjectDigest(row);
  }

  hasProjectDigest(projectDigestId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 AS exists_flag
      FROM mate_project_digests
      WHERE id = ? AND mate_id = ?
      LIMIT 1
    `).get(projectDigestId, MATE_ID) as { exists_flag: number } | undefined;

    return Boolean(row);
  }

  resolveProjectDigestForWorkspace(workspacePath: string): MateProjectDigest | null {
    const scope = resolveProjectScope(workspacePath);
    if (scope.projectType !== "git") {
      return null;
    }

    const existing = this.getByProjectKey(scope.projectKey);
    if (existing) {
      return existing;
    }

    const now = nowIso();
    const projectDigestId = randomUUID();
    const digestFilePath = buildProjectDigestRelativePath(projectDigestId);
    this.db.prepare(`
      INSERT INTO mate_project_digests (
        id,
        mate_id,
        project_type,
        project_key,
        workspace_path,
        git_root,
        display_name,
        digest_file_path,
        sha256,
        byte_size,
        active_revision_id,
        last_growth_event_id,
        last_compiled_at,
        disabled_at,
        created_at,
        updated_at
      ) VALUES (?, ?, 'git', ?, ?, ?, ?, ?, '', 0, NULL, NULL, NULL, NULL, ?, ?)
    `).run(
      projectDigestId,
      MATE_ID,
      scope.projectKey,
      scope.workspacePath,
      scope.gitRoot,
      scope.displayName,
      digestFilePath,
      now,
      now,
    );

    const created = this.getByProjectKey(scope.projectKey);
    if (!created) {
      throw new Error("Project digest の作成後に再読込できないよ。");
    }

    return created;
  }

  async rewriteProjectDigestProjection(
    input: RewriteProjectDigestProjectionInput,
  ): Promise<RewriteProjectDigestProjectionResult> {
    const projectDigest = this.getById(input.projectDigestId);
    if (!projectDigest) {
      throw new Error(`Project digest が見つかりません: ${input.projectDigestId}`);
    }

    const digestFilePath = buildProjectDigestRelativePath(input.projectDigestId);
    const absoluteDirectory = path.resolve(input.userDataPath);
    const absoluteFilePath = path.join(absoluteDirectory, digestFilePath);
    const now = nowIso();
    const projectedText = input.content;
    const projectedSha256 = sha256Hex(projectedText);
    const projectedByteSize = byteSize(projectedText);

    await mkdir(path.dirname(absoluteFilePath), { recursive: true });

    const previousText = await readExistingTextFile(absoluteFilePath);

    try {
      await writeFile(absoluteFilePath, projectedText, "utf8");
    } catch (error) {
      throw error;
    }

    try {
      this.withTransaction((db) => {
        db.prepare(`
          UPDATE mate_project_digests
          SET
            digest_file_path = ?,
            sha256 = ?,
            byte_size = ?,
            active_revision_id = ?,
            last_growth_event_id = ?,
            last_compiled_at = ?,
            updated_at = ?
          WHERE id = ? AND mate_id = ?
        `).run(
          digestFilePath,
          projectedSha256,
          projectedByteSize,
          input.activeRevisionId,
          input.lastGrowthEventId,
          now,
          now,
          projectDigest.id,
          MATE_ID,
        );
      });
    } catch (error) {
      try {
        if (previousText === null) {
          await rm(absoluteFilePath, { force: true });
        } else {
          await writeFile(absoluteFilePath, previousText, "utf8");
        }
      } catch {
        // best effort rollback
      }

      throw error;
    }

    const updated = this.getById(input.projectDigestId);
    if (!updated) {
      throw new Error(`Project digest の更新後に再読込できないよ: ${input.projectDigestId}`);
    }
    if (!updated.lastCompiledAt) {
      throw new Error(`Project digest の compiled_at が更新されていません: ${input.projectDigestId}`);
    }

    return {
      digestFilePath: updated.digestFilePath,
      sha256: updated.sha256,
      byteSize: updated.byteSize,
      lastCompiledAt: updated.lastCompiledAt,
      updatedAt: updated.updatedAt,
    };
  }

  close(): void {
    this.db.close();
  }
}
