import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createDefaultSessionMemory,
  normalizeSessionMemory,
  type Session,
  type SessionMemory,
} from "../src/app-state.js";

type SessionMemoryRow = {
  session_id: string;
  workspace_path: string;
  thread_id: string;
  schema_version: number;
  goal: string;
  decisions_json: string;
  open_questions_json: string;
  next_actions_json: string;
  notes_json: string;
  updated_at: string;
};

const SESSION_MEMORY_SELECT_COLUMNS = `
  session_id,
  workspace_path,
  thread_id,
  schema_version,
  goal,
  decisions_json,
  open_questions_json,
  next_actions_json,
  notes_json,
  updated_at
`;

const GET_SESSION_MEMORY_SQL = `
  SELECT
    ${SESSION_MEMORY_SELECT_COLUMNS}
  FROM session_memories
  WHERE session_id = ?
`;

const LIST_SESSION_MEMORIES_SQL = `
  SELECT
    ${SESSION_MEMORY_SELECT_COLUMNS}
  FROM session_memories
  ORDER BY updated_at DESC, session_id DESC
`;

const UPSERT_SESSION_MEMORY_SQL = `
  INSERT INTO session_memories (
    session_id,
    workspace_path,
    thread_id,
    schema_version,
    goal,
    decisions_json,
    open_questions_json,
    next_actions_json,
    notes_json,
    updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET
    workspace_path = excluded.workspace_path,
    thread_id = excluded.thread_id,
    schema_version = excluded.schema_version,
    goal = excluded.goal,
    decisions_json = excluded.decisions_json,
    open_questions_json = excluded.open_questions_json,
    next_actions_json = excluded.next_actions_json,
    notes_json = excluded.notes_json,
    updated_at = excluded.updated_at
`;

function rowToSessionMemory(row: SessionMemoryRow): SessionMemory | null {
  return normalizeSessionMemory({
    sessionId: row.session_id,
    workspacePath: row.workspace_path,
    threadId: row.thread_id,
    schemaVersion: row.schema_version,
    goal: row.goal,
    decisions: JSON.parse(row.decisions_json),
    openQuestions: JSON.parse(row.open_questions_json),
    nextActions: JSON.parse(row.next_actions_json),
    notes: JSON.parse(row.notes_json),
    updatedAt: row.updated_at,
  });
}

export class SessionMemoryStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_memories (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        workspace_path TEXT NOT NULL,
        thread_id TEXT NOT NULL DEFAULT '',
        schema_version INTEGER NOT NULL DEFAULT 1,
        goal TEXT NOT NULL DEFAULT '',
        decisions_json TEXT NOT NULL DEFAULT '[]',
        open_questions_json TEXT NOT NULL DEFAULT '[]',
        next_actions_json TEXT NOT NULL DEFAULT '[]',
        notes_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );
    `);
  }

  getSessionMemory(sessionId: string): SessionMemory | null {
    const row = this.db.prepare(GET_SESSION_MEMORY_SQL).get(sessionId) as SessionMemoryRow | undefined;
    if (!row) {
      return null;
    }

    return rowToSessionMemory(row);
  }

  listSessionMemories(): SessionMemory[] {
    const rows = this.db.prepare(LIST_SESSION_MEMORIES_SQL).all() as SessionMemoryRow[];
    return rows.map(rowToSessionMemory).filter((memory): memory is SessionMemory => memory !== null);
  }

  upsertSessionMemory(memory: SessionMemory): SessionMemory {
    const normalized = normalizeSessionMemory(memory);
    if (!normalized) {
      throw new Error("保存する session memory の形式が不正だよ。");
    }

    this.db.prepare(UPSERT_SESSION_MEMORY_SQL).run(
      normalized.sessionId,
      normalized.workspacePath,
      normalized.threadId,
      normalized.schemaVersion,
      normalized.goal,
      JSON.stringify(normalized.decisions),
      JSON.stringify(normalized.openQuestions),
      JSON.stringify(normalized.nextActions),
      JSON.stringify(normalized.notes),
      normalized.updatedAt,
    );

    return normalizeSessionMemory(normalized) as SessionMemory;
  }

  ensureSessionMemory(session: Pick<Session, "id" | "workspacePath" | "threadId" | "taskTitle" | "taskSummary">): SessionMemory {
    const existing = this.getSessionMemory(session.id);
    if (existing) {
      return existing;
    }

    return this.upsertSessionMemory(createDefaultSessionMemory(session));
  }

  deleteSessionMemory(sessionId: string): void {
    this.db.prepare(`
      DELETE FROM session_memories
      WHERE session_id = ?
    `).run(sessionId);
  }

  clearSessionMemories(): void {
    this.db.exec("DELETE FROM session_memories;");
  }

  close(): void {
    this.db.close();
  }
}
