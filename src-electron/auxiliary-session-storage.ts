import type { DatabaseSync } from "node:sqlite";

import {
  normalizeAuxiliarySession,
  projectAuxiliarySessionSummary,
  type AuxiliarySession,
  type AuxiliarySessionSummary,
} from "../src/auxiliary-session-state.js";
import { openAppDatabase } from "./sqlite-connection.js";

type AuxiliarySessionRow = {
  created_at: string;
  updated_at: string;
  payload_json: string;
};

type TableInfoRow = {
  name: string;
};

const CREATE_AUXILIARY_SESSION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS auxiliary_sessions (
    id TEXT PRIMARY KEY,
    parent_session_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );
`;

const CREATE_AUXILIARY_SESSION_PARENT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_auxiliary_sessions_parent_updated
    ON auxiliary_sessions(parent_session_id, updated_at DESC);
`;

const CREATE_AUXILIARY_SESSION_PARENT_CREATED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_auxiliary_sessions_parent_created
    ON auxiliary_sessions(parent_session_id, created_at ASC);
`;

export class AuxiliarySessionStorage {
  private db: DatabaseSync | null;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    this.initializeSchema();
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  listAllAuxiliarySessions(): AuxiliarySession[] {
    return this.withDb((db) => {
      const rows = db.prepare(`
        SELECT created_at, updated_at, payload_json
        FROM auxiliary_sessions
        ORDER BY updated_at DESC, id DESC
      `).all() as AuxiliarySessionRow[];
      return rows
        .map((row) => parseAuxiliarySessionRow(row))
        .filter((session): session is AuxiliarySession => session !== null);
    });
  }

  listAuxiliarySessions(parentSessionId: string): AuxiliarySessionSummary[] {
    return this.withDb((db) => {
      const rows = db.prepare(`
        SELECT created_at, updated_at, payload_json
        FROM auxiliary_sessions
        WHERE parent_session_id = ?
        ORDER BY updated_at DESC, id DESC
      `).all(parentSessionId) as AuxiliarySessionRow[];
      return rows
        .map((row) => parseAuxiliarySessionRow(row))
        .filter((session): session is AuxiliarySession => session !== null)
        .map(projectAuxiliarySessionSummary);
    });
  }

  listRunningActiveAuxiliarySessions(): AuxiliarySessionSummary[] {
    return this.withDb((db) => {
      const rows = db.prepare(`
        SELECT created_at, updated_at, payload_json
        FROM auxiliary_sessions
        WHERE status = 'active'
        ORDER BY updated_at DESC, id DESC
      `).all() as AuxiliarySessionRow[];
      return rows
        .map((row) => parseAuxiliarySessionRow(row))
        .filter((session): session is AuxiliarySession => session?.runState === "running")
        .map(projectAuxiliarySessionSummary);
    });
  }

  getActiveAuxiliarySession(parentSessionId: string): AuxiliarySession | null {
    return this.withDb((db) => {
      const row = db.prepare(`
        SELECT created_at, updated_at, payload_json
        FROM auxiliary_sessions
        WHERE parent_session_id = ?
          AND status = 'active'
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `).get(parentSessionId) as AuxiliarySessionRow | undefined;
      return row ? parseAuxiliarySessionRow(row) : null;
    });
  }

  getAuxiliarySession(auxiliarySessionId: string): AuxiliarySession | null {
    return this.withDb((db) => {
      const row = db.prepare(`
        SELECT created_at, updated_at, payload_json
        FROM auxiliary_sessions
        WHERE id = ?
      `).get(auxiliarySessionId) as AuxiliarySessionRow | undefined;
      return row ? parseAuxiliarySessionRow(row) : null;
    });
  }

  upsertAuxiliarySession(session: AuxiliarySession): AuxiliarySession {
    return this.withDb((db) => {
      const payload = JSON.stringify(session);
      db.prepare(`
        INSERT INTO auxiliary_sessions (
          id,
          parent_session_id,
          status,
          created_at,
          updated_at,
          payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          parent_session_id = excluded.parent_session_id,
          status = excluded.status,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json
      `).run(session.id, session.parentSessionId, session.status, session.createdAt, session.updatedAt, payload);
      return session;
    });
  }

  deleteAuxiliarySessionsForParent(parentSessionId: string): void {
    this.withDb((db) => {
      db.prepare("DELETE FROM auxiliary_sessions WHERE parent_session_id = ?").run(parentSessionId);
    });
  }

  deleteAuxiliarySessionsExceptParents(parentSessionIds: Iterable<string>): void {
    const retainedParentSessionIds = Array.from(new Set(parentSessionIds));
    this.withDb((db) => {
      if (retainedParentSessionIds.length === 0) {
        db.prepare("DELETE FROM auxiliary_sessions").run();
        return;
      }

      const placeholders = retainedParentSessionIds.map(() => "?").join(", ");
      db.prepare(`DELETE FROM auxiliary_sessions WHERE parent_session_id NOT IN (${placeholders})`)
        .run(...retainedParentSessionIds);
    });
  }

  private initializeSchema(): void {
    this.withDb((db) => {
      db.exec(CREATE_AUXILIARY_SESSION_TABLE_SQL);
      ensureAuxiliarySessionCreatedAtColumn(db);
      db.exec(CREATE_AUXILIARY_SESSION_PARENT_INDEX_SQL);
      db.exec(CREATE_AUXILIARY_SESSION_PARENT_CREATED_INDEX_SQL);
    });
  }

  private withDb<T>(runner: (db: DatabaseSync) => T): T {
    if (!this.db) {
      throw new Error("AuxiliarySessionStorage は close 済みだよ。");
    }

    return runner(this.db);
  }
}

function parseAuxiliarySessionPayload(payloadJson: string): AuxiliarySession | null {
  try {
    return normalizeAuxiliarySession(JSON.parse(payloadJson));
  } catch {
    return null;
  }
}

function parseAuxiliarySessionRow(row: AuxiliarySessionRow): AuxiliarySession | null {
  const session = parseAuxiliarySessionPayload(row.payload_json);
  if (!session) {
    return null;
  }

  return {
    ...session,
    createdAt: session.createdAt || row.created_at,
    updatedAt: session.updatedAt || row.updated_at,
  };
}

function ensureAuxiliarySessionCreatedAtColumn(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(auxiliary_sessions)").all() as TableInfoRow[];
  if (columns.some((column) => column.name === "created_at")) {
    return;
  }

  db.exec("ALTER TABLE auxiliary_sessions ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
}
