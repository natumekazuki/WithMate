import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  cloneProjectMemoryEntries,
  cloneProjectScopes,
  normalizeProjectMemoryEntry,
  normalizeProjectScope,
} from "../src/memory-state.js";
import type { ProjectMemoryEntry, ProjectScope } from "../src/memory-state.js";
import type { ResolvedProjectScopeInput } from "./project-scope.js";

type ProjectScopeRow = {
  id: string;
  project_type: string;
  project_key: string;
  workspace_path: string;
  git_root: string | null;
  git_remote_url: string | null;
  display_name: string;
  created_at: string;
  updated_at: string;
};

type ProjectMemoryEntryRow = {
  id: string;
  project_scope_id: string;
  source_session_id: string | null;
  category: string;
  title: string;
  detail: string;
  keywords_json: string;
  evidence_json: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
};

const PROJECT_SCOPE_SELECT_COLUMNS = `
  id,
  project_type,
  project_key,
  workspace_path,
  git_root,
  git_remote_url,
  display_name,
  created_at,
  updated_at
`;

const PROJECT_MEMORY_ENTRY_SELECT_COLUMNS = `
  id,
  project_scope_id,
  source_session_id,
  category,
  title,
  detail,
  keywords_json,
  evidence_json,
  created_at,
  updated_at,
  last_used_at
`;

function rowToProjectScope(row: ProjectScopeRow): ProjectScope | null {
  return normalizeProjectScope({
    id: row.id,
    projectType: row.project_type,
    projectKey: row.project_key,
    workspacePath: row.workspace_path,
    gitRoot: row.git_root,
    gitRemoteUrl: row.git_remote_url,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function rowToProjectMemoryEntry(row: ProjectMemoryEntryRow): ProjectMemoryEntry | null {
  return normalizeProjectMemoryEntry({
    id: row.id,
    projectScopeId: row.project_scope_id,
    sourceSessionId: row.source_session_id,
    category: row.category,
    title: row.title,
    detail: row.detail,
    keywords: JSON.parse(row.keywords_json),
    evidence: JSON.parse(row.evidence_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  });
}

export class ProjectMemoryStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_scopes (
        id TEXT PRIMARY KEY,
        project_type TEXT NOT NULL,
        project_key TEXT NOT NULL UNIQUE,
        workspace_path TEXT NOT NULL,
        git_root TEXT,
        git_remote_url TEXT,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_memory_entries (
        id TEXT PRIMARY KEY,
        project_scope_id TEXT NOT NULL REFERENCES project_scopes(id) ON DELETE CASCADE,
        source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        keywords_json TEXT NOT NULL DEFAULT '[]',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_project_memory_entries_scope
        ON project_memory_entries(project_scope_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_project_memory_entries_category
        ON project_memory_entries(project_scope_id, category, updated_at DESC);
    `);
  }

  listProjectScopes(): ProjectScope[] {
    const rows = this.db.prepare(`
      SELECT ${PROJECT_SCOPE_SELECT_COLUMNS}
      FROM project_scopes
      ORDER BY updated_at DESC, id DESC
    `).all() as ProjectScopeRow[];
    return cloneProjectScopes(rows.map(rowToProjectScope).filter((row): row is ProjectScope => row !== null));
  }

  getProjectScopeById(projectScopeId: string): ProjectScope | null {
    const row = this.db.prepare(`
      SELECT ${PROJECT_SCOPE_SELECT_COLUMNS}
      FROM project_scopes
      WHERE id = ?
    `).get(projectScopeId) as ProjectScopeRow | undefined;
    if (!row) {
      return null;
    }

    return rowToProjectScope(row);
  }

  getProjectScopeByKey(projectKey: string): ProjectScope | null {
    const row = this.db.prepare(`
      SELECT ${PROJECT_SCOPE_SELECT_COLUMNS}
      FROM project_scopes
      WHERE project_key = ?
    `).get(projectKey) as ProjectScopeRow | undefined;
    if (!row) {
      return null;
    }

    return rowToProjectScope(row);
  }

  ensureProjectScope(input: ResolvedProjectScopeInput): ProjectScope {
    const now = new Date().toISOString();
    const existing = this.getProjectScopeByKey(input.projectKey);
    if (existing) {
      this.db.prepare(`
        UPDATE project_scopes
        SET
          project_type = ?,
          workspace_path = ?,
          git_root = ?,
          git_remote_url = ?,
          display_name = ?,
          updated_at = ?
        WHERE project_key = ?
      `).run(
        input.projectType,
        input.workspacePath,
        input.gitRoot,
        input.gitRemoteUrl,
        input.displayName,
        now,
        input.projectKey,
      );

      const updated = this.getProjectScopeByKey(input.projectKey);
      if (!updated) {
        throw new Error("project scope の更新後に再読込できないよ。");
      }

      return updated;
    }

    const projectScopeId = randomUUID();
    this.db.prepare(`
      INSERT INTO project_scopes (
        id,
        project_type,
        project_key,
        workspace_path,
        git_root,
        git_remote_url,
        display_name,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectScopeId,
      input.projectType,
      input.projectKey,
      input.workspacePath,
      input.gitRoot,
      input.gitRemoteUrl,
      input.displayName,
      now,
      now,
    );

    const created = this.getProjectScopeById(projectScopeId);
    if (!created) {
      throw new Error("project scope の作成後に再読込できないよ。");
    }

    return created;
  }

  listProjectMemoryEntries(projectScopeId: string): ProjectMemoryEntry[] {
    const rows = this.db.prepare(`
      SELECT ${PROJECT_MEMORY_ENTRY_SELECT_COLUMNS}
      FROM project_memory_entries
      WHERE project_scope_id = ?
      ORDER BY updated_at DESC, id DESC
    `).all(projectScopeId) as ProjectMemoryEntryRow[];
    return cloneProjectMemoryEntries(rows.map(rowToProjectMemoryEntry).filter((row): row is ProjectMemoryEntry => row !== null));
  }

  markProjectMemoryEntriesUsed(entryIds: string[]): void {
    const uniqueIds = [...new Set(entryIds.map((id) => id.trim()).filter((id) => id.length > 0))];
    if (uniqueIds.length === 0) {
      return;
    }

    const now = new Date().toISOString();
    const placeholders = uniqueIds.map(() => "?").join(", ");
    this.db.prepare(`
      UPDATE project_memory_entries
      SET last_used_at = ?, updated_at = updated_at
      WHERE id IN (${placeholders})
    `).run(now, ...uniqueIds);
  }

  upsertProjectMemoryEntry(input: Omit<ProjectMemoryEntry, "id" | "createdAt" | "updatedAt" | "lastUsedAt"> & { id?: string }): ProjectMemoryEntry {
    const normalized = normalizeProjectMemoryEntry({
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUsedAt: null,
    });
    if (!normalized) {
      throw new Error("保存する project memory entry の形式が不正だよ。");
    }

    const existing = this.db.prepare(`
      SELECT ${PROJECT_MEMORY_ENTRY_SELECT_COLUMNS}
      FROM project_memory_entries
      WHERE project_scope_id = ?
        AND category = ?
        AND title = ?
        AND detail = ?
      LIMIT 1
    `).get(
      normalized.projectScopeId,
      normalized.category,
      normalized.title,
      normalized.detail,
    ) as ProjectMemoryEntryRow | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE project_memory_entries
        SET
          source_session_id = ?,
          keywords_json = ?,
          evidence_json = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        normalized.sourceSessionId,
        JSON.stringify(normalized.keywords),
        JSON.stringify(normalized.evidence),
        normalized.updatedAt,
        existing.id,
      );

      const updated = this.db.prepare(`
        SELECT ${PROJECT_MEMORY_ENTRY_SELECT_COLUMNS}
        FROM project_memory_entries
        WHERE id = ?
      `).get(existing.id) as ProjectMemoryEntryRow | undefined;
      if (!updated) {
        throw new Error("project memory entry の更新後に再読込できないよ。");
      }

      const resolved = rowToProjectMemoryEntry(updated);
      if (!resolved) {
        throw new Error("project memory entry の更新結果が不正だよ。");
      }

      return resolved;
    }

    this.db.prepare(`
      INSERT INTO project_memory_entries (
        id,
        project_scope_id,
        source_session_id,
        category,
        title,
        detail,
        keywords_json,
        evidence_json,
        created_at,
        updated_at,
        last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.id,
      normalized.projectScopeId,
      normalized.sourceSessionId,
      normalized.category,
      normalized.title,
      normalized.detail,
      JSON.stringify(normalized.keywords),
      JSON.stringify(normalized.evidence),
      normalized.createdAt,
      normalized.updatedAt,
      normalized.lastUsedAt,
    );

    const created = this.db.prepare(`
      SELECT ${PROJECT_MEMORY_ENTRY_SELECT_COLUMNS}
      FROM project_memory_entries
      WHERE id = ?
    `).get(normalized.id) as ProjectMemoryEntryRow | undefined;
    if (!created) {
      throw new Error("project memory entry の作成後に再読込できないよ。");
    }

    const resolved = rowToProjectMemoryEntry(created);
    if (!resolved) {
      throw new Error("project memory entry の作成結果が不正だよ。");
    }

    return resolved;
  }

  clearProjectMemories(): void {
    this.db.exec("DELETE FROM project_memory_entries;");
    this.db.exec("DELETE FROM project_scopes;");
  }

  close(): void {
    this.db.close();
  }
}
