import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import {
  createDefaultSessionMemory,
  normalizeSessionMemory,
  type Session,
  type SessionMemory,
} from "../src/app-state.js";
import type { ManagedSessionMemoryItem, MemoryManagementPageRequest } from "../src/memory-management-state.js";
import { CREATE_SESSION_MEMORIES_TABLE_SQL } from "./database-schema-v1.js";
import { openAppDatabase } from "./sqlite-connection.js";

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

type ManagedSessionMemoryRow = SessionMemoryRow & {
  task_title: string | null;
  character_name: string | null;
  provider: string | null;
  session_workspace_label: string | null;
  session_workspace_path: string | null;
  status: Session["status"] | null;
  run_state: Session["runState"] | null;
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

function rowToManagedSessionMemoryItem(row: ManagedSessionMemoryRow): ManagedSessionMemoryItem | null {
  const memory = rowToSessionMemory(row);
  if (!memory) {
    return null;
  }

  return {
    sessionId: memory.sessionId,
    taskTitle: row.task_title || "削除済み Session",
    character: row.character_name || "Unknown",
    provider: row.provider || "",
    workspaceLabel: row.session_workspace_label || memory.workspacePath || "workspace 未設定",
    workspacePath: memory.workspacePath || row.session_workspace_path || "",
    status: row.status || "saved",
    runState: row.run_state || "idle",
    updatedAt: memory.updatedAt,
    memory,
  };
}

function normalizePageCursor(cursor: MemoryManagementPageRequest["cursor"]): number {
  return typeof cursor === "number" && Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
}

function normalizePageLimit(limit: MemoryManagementPageRequest["limit"]): number {
  return typeof limit === "number" && Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 50;
}

function pushSearchParam(params: SQLInputValue[], searchText: string): void {
  params.push(searchText);
}

function buildSessionMemoryPageWhere(request: MemoryManagementPageRequest): { sql: string; params: SQLInputValue[] } {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  const searchText = typeof request.searchText === "string" ? request.searchText.trim().toLowerCase() : "";

  if (searchText) {
    clauses.push(`
      (
        instr(lower(
          coalesce(s.task_title, '') || char(10) ||
          coalesce(s.character_name, '') || char(10) ||
          coalesce(s.provider, '') || char(10) ||
          coalesce(s.workspace_label, '') || char(10) ||
          coalesce(s.workspace_path, '') || char(10) ||
          m.goal
        ), ?) > 0
        OR EXISTS (SELECT 1 FROM json_each(m.decisions_json) WHERE instr(lower(CAST(value AS TEXT)), ?) > 0)
        OR EXISTS (SELECT 1 FROM json_each(m.open_questions_json) WHERE instr(lower(CAST(value AS TEXT)), ?) > 0)
        OR EXISTS (SELECT 1 FROM json_each(m.next_actions_json) WHERE instr(lower(CAST(value AS TEXT)), ?) > 0)
        OR EXISTS (SELECT 1 FROM json_each(m.notes_json) WHERE instr(lower(CAST(value AS TEXT)), ?) > 0)
      )
    `);
    pushSearchParam(params, searchText);
    pushSearchParam(params, searchText);
    pushSearchParam(params, searchText);
    pushSearchParam(params, searchText);
    pushSearchParam(params, searchText);
  }

  if (request.sessionStatus === "running") {
    clauses.push("(s.status = 'running' OR s.run_state = 'running')");
  } else if (request.sessionStatus === "idle" || request.sessionStatus === "saved") {
    clauses.push("coalesce(s.status, 'saved') = ?");
    params.push(request.sessionStatus);
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

export class SessionMemoryStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    this.db.exec(CREATE_SESSION_MEMORIES_TABLE_SQL);
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

  listSessionMemoryPage(request: MemoryManagementPageRequest = {}): { items: ManagedSessionMemoryItem[]; total: number } {
    const cursor = normalizePageCursor(request.cursor);
    const limit = normalizePageLimit(request.limit);
    const direction = request.sort === "updated-asc" ? "ASC" : "DESC";
    const where = buildSessionMemoryPageWhere(request);
    const totalRow = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM session_memories AS m
      LEFT JOIN sessions AS s ON s.id = m.session_id
      ${where.sql}
    `).get(...where.params) as { count: number };
    const rows = this.db.prepare(`
      SELECT
        ${SESSION_MEMORY_SELECT_COLUMNS.split("\n").map((column) => {
          const trimmed = column.trim().replace(/,$/, "");
          return trimmed ? `m.${trimmed}` : "";
        }).filter(Boolean).join(",\n        ")},
        s.task_title,
        s.character_name,
        s.provider,
        s.workspace_label AS session_workspace_label,
        s.workspace_path AS session_workspace_path,
        s.status,
        s.run_state
      FROM session_memories AS m
      LEFT JOIN sessions AS s ON s.id = m.session_id
      ${where.sql}
      ORDER BY m.updated_at ${direction}, m.session_id ASC
      LIMIT ? OFFSET ?
    `).all(...where.params, limit, cursor) as ManagedSessionMemoryRow[];

    return {
      items: rows.map(rowToManagedSessionMemoryItem).filter((item): item is ManagedSessionMemoryItem => item !== null),
      total: totalRow.count,
    };
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
