import { randomUUID } from "node:crypto";
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
  createdAt: string;
  updatedAt: string;
};

function nowIso(): string {
  return new Date().toISOString();
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MateProjectDigestStorage {
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
      ) VALUES (?, ?, 'git', ?, ?, ?, ?, '', '', 0, NULL, NULL, NULL, NULL, ?, ?)
    `).run(
      projectDigestId,
      MATE_ID,
      scope.projectKey,
      scope.workspacePath,
      scope.gitRoot,
      scope.displayName,
      now,
      now,
    );

    const created = this.getByProjectKey(scope.projectKey);
    if (!created) {
      throw new Error("Project digest の作成後に再読込できないよ。");
    }

    return created;
  }

  close(): void {
    this.db.close();
  }
}
