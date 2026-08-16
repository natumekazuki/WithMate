import { createHash } from "node:crypto";
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
  "resolveProjectById" | "resolveProjectByPath" | "resolveKnownProjectByPath"
> {
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
      if (resolved.projectType !== "git") {
        return null;
      }
      const existing = db.prepare(`
        SELECT id
        FROM project_scopes_v6
        WHERE project_type = ?
          AND project_key = ?
      `).get(resolved.projectType, resolved.projectKey) as { id: string } | undefined;
      if (existing) {
        return {
          id: existing.id,
          displayName: resolved.displayName,
          admission: { id: existing.id, ...resolved },
        };
      }
      const projectId = `project-${createHash("sha256").update(resolved.projectKey, "utf8").digest("hex").slice(0, 32)}`;
      return {
        id: projectId,
        displayName: resolved.displayName,
        admission: { id: projectId, ...resolved },
      };
    }),
    resolveKnownProjectByPath: (projectPath) => withDatabase(dbPath, (db) => {
      const resolved = resolveProjectScope(projectPath);
      if (resolved.projectType !== "git") {
        return null;
      }
      const row = db.prepare(`
        SELECT id, display_name
        FROM project_scopes_v6
        WHERE project_type = ?
          AND project_key = ?
      `).get(resolved.projectType, resolved.projectKey) as { id: string; display_name: string } | undefined;
      return row
        ? { id: row.id, displayName: row.display_name }
        : { id: `unresolved:${resolved.projectKey}`, displayName: resolved.displayName };
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
