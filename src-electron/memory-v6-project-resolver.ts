import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { resolveProjectScope } from "./project-scope.js";
import { openAppDatabase } from "./sqlite-connection.js";
import type { MemoryV6ProjectContext, MemoryV6TargetResolverDeps } from "./memory-v6-context-resolver.js";

type ProjectScopeRow = {
  id: string;
  project_type: string;
  project_key: string;
  workspace_path: string;
  display_name: string;
};

export function createMemoryV6ProjectResolver(dbPath: string): Pick<
  MemoryV6TargetResolverDeps,
  "resolveProjectById" | "resolveProjectByPath" | "resolveProjectByAlias"
> & { resolveSessionById(id: string): boolean } {
  return {
    resolveProjectById: (id) => withDatabase(dbPath, (db) => {
      const row = db.prepare(`
        SELECT id, display_name
        FROM project_scopes_v6
        WHERE id = ?
      `).get(id) as { id: string; display_name: string } | undefined;
      return row ? { id: row.id, displayName: row.display_name } : null;
    }),
    resolveProjectByPath: (projectPath) => withDatabase(dbPath, (db) => {
      const resolved = resolveProjectScope(projectPath);
      const now = new Date().toISOString();
      const existing = db.prepare(`
        SELECT id
        FROM project_scopes_v6
        WHERE project_type = ?
          AND project_key = ?
      `).get(resolved.projectType, resolved.projectKey) as { id: string } | undefined;
      const projectId = existing?.id ?? `project-${randomUUID()}`;

      db.prepare(`
        INSERT INTO project_scopes_v6 (
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
        ON CONFLICT(project_type, project_key) DO UPDATE SET
          workspace_path = excluded.workspace_path,
          git_root = excluded.git_root,
          git_remote_url = excluded.git_remote_url,
          display_name = excluded.display_name,
          updated_at = excluded.updated_at
      `).run(
        projectId,
        resolved.projectType,
        resolved.projectKey,
        resolved.workspacePath,
        resolved.gitRoot ?? "",
        resolved.gitRemoteUrl ?? "",
        resolved.displayName,
        now,
        now,
      );

      const row = db.prepare(`
        SELECT id, display_name
        FROM project_scopes_v6
        WHERE project_type = ?
          AND project_key = ?
      `).get(resolved.projectType, resolved.projectKey) as { id: string; display_name: string } | undefined;
      return row
        ? { id: row.id, displayName: row.display_name }
        : { id: projectId, displayName: resolved.displayName };
    }),
    resolveProjectByAlias: (alias) => withDatabase(dbPath, (db) => {
      const row = db.prepare(`
        SELECT id, display_name
        FROM project_scopes_v6
        WHERE id = ?
           OR project_key = ?
           OR display_name = ?
           OR workspace_path = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(alias, alias, alias, alias) as { id: string; display_name: string } | undefined;
      return row ? { id: row.id, displayName: row.display_name } : null;
    }),
    resolveSessionById: (id) => withDatabase(dbPath, (db) => {
      const row = db.prepare(`
        SELECT id
        FROM sessions_v6
        WHERE id = ?
      `).get(id) as { id: string } | undefined;
      return Boolean(row);
    }),
  };
}

export function listMemoryV6ProjectScopes(dbPath: string): ProjectScopeRow[] {
  return withDatabase(dbPath, (db) =>
    db.prepare(`
      SELECT id, project_type, project_key, workspace_path, display_name
      FROM project_scopes_v6
      ORDER BY updated_at DESC, id ASC
    `).all() as ProjectScopeRow[]
  );
}

function withDatabase<T>(dbPath: string, runner: (db: DatabaseSync) => T): T {
  const db = openAppDatabase(dbPath);
  try {
    return runner(db);
  } finally {
    db.close();
  }
}
