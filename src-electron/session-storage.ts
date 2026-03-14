import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { cloneSessions, normalizeSession, type Session } from "../src/mock-data.js";
import { DEFAULT_CATALOG_REVISION, DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT } from "../src/model-catalog.js";

type SessionRow = {
  id: string;
  task_title: string;
  task_summary: string;
  status: string;
  updated_at: string;
  provider: string;
  catalog_revision: number;
  workspace_label: string;
  workspace_path: string;
  branch: string;
  character_id: string;
  character_name: string;
  character_icon_path: string;
  run_state: string;
  approval_mode: string;
  model: string;
  reasoning_effort: string;
  thread_id: string;
  messages_json: string;
  stream_json: string;
};

type TableColumnRow = {
  name: string;
};

function rowToSession(row: SessionRow): Session | null {
  return normalizeSession({
    id: row.id,
    taskTitle: row.task_title,
    taskSummary: row.task_summary,
    status: row.status,
    updatedAt: row.updated_at,
    provider: row.provider,
    catalogRevision: row.catalog_revision,
    workspaceLabel: row.workspace_label,
    workspacePath: row.workspace_path,
    branch: row.branch,
    characterId: row.character_id,
    character: row.character_name,
    characterIconPath: row.character_icon_path,
    runState: row.run_state,
    approvalMode: row.approval_mode,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    threadId: row.thread_id,
    messages: JSON.parse(row.messages_json),
    stream: JSON.parse(row.stream_json),
  });
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export class SessionStorage {
  private readonly db: DatabaseSync;
  private readonly listStatement: StatementSync;
  private readonly getStatement: StatementSync;
  private readonly upsertStatement: StatementSync;
  private readonly deleteStatement: StatementSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        task_title TEXT NOT NULL,
        task_summary TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        provider TEXT NOT NULL,
        catalog_revision INTEGER NOT NULL DEFAULT ${DEFAULT_CATALOG_REVISION},
        workspace_label TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        branch TEXT NOT NULL,
        character_id TEXT NOT NULL,
        character_name TEXT NOT NULL,
        character_icon_path TEXT NOT NULL,
        run_state TEXT NOT NULL,
        approval_mode TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT ${sqlStringLiteral(DEFAULT_MODEL_ID)},
        reasoning_effort TEXT NOT NULL DEFAULT ${sqlStringLiteral(DEFAULT_REASONING_EFFORT)},
        thread_id TEXT NOT NULL DEFAULT '',
        messages_json TEXT NOT NULL,
        stream_json TEXT NOT NULL,
        last_active_at INTEGER NOT NULL
      );
    `);
    this.ensureSchema();

    this.listStatement = this.db.prepare(`
      SELECT
        id,
        task_title,
        task_summary,
        status,
        updated_at,
        provider,
        catalog_revision,
        workspace_label,
        workspace_path,
        branch,
        character_id,
        character_name,
        character_icon_path,
        run_state,
        approval_mode,
        model,
        reasoning_effort,
        thread_id,
        messages_json,
        stream_json
      FROM sessions
      ORDER BY last_active_at DESC, id DESC
    `);

    this.getStatement = this.db.prepare(`
      SELECT
        id,
        task_title,
        task_summary,
        status,
        updated_at,
        provider,
        catalog_revision,
        workspace_label,
        workspace_path,
        branch,
        character_id,
        character_name,
        character_icon_path,
        run_state,
        approval_mode,
        model,
        reasoning_effort,
        thread_id,
        messages_json,
        stream_json
      FROM sessions
      WHERE id = ?
    `);

    this.upsertStatement = this.db.prepare(`
      INSERT INTO sessions (
        id,
        task_title,
        task_summary,
        status,
        updated_at,
        provider,
        catalog_revision,
        workspace_label,
        workspace_path,
        branch,
        character_id,
        character_name,
        character_icon_path,
        run_state,
        approval_mode,
        model,
        reasoning_effort,
        thread_id,
        messages_json,
        stream_json,
        last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        task_title = excluded.task_title,
        task_summary = excluded.task_summary,
        status = excluded.status,
        updated_at = excluded.updated_at,
        provider = excluded.provider,
        catalog_revision = excluded.catalog_revision,
        workspace_label = excluded.workspace_label,
        workspace_path = excluded.workspace_path,
        branch = excluded.branch,
        character_id = excluded.character_id,
        character_name = excluded.character_name,
        character_icon_path = excluded.character_icon_path,
        run_state = excluded.run_state,
        approval_mode = excluded.approval_mode,
        model = excluded.model,
        reasoning_effort = excluded.reasoning_effort,
        thread_id = excluded.thread_id,
        messages_json = excluded.messages_json,
        stream_json = excluded.stream_json,
        last_active_at = excluded.last_active_at
    `);

    this.deleteStatement = this.db.prepare(`
      DELETE FROM sessions
      WHERE id = ?
    `);
  }

  private ensureSchema(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(sessions)").all() as TableColumnRow[]).map((column) => column.name),
    );

    if (!columns.has("model")) {
      this.db.exec(
        `ALTER TABLE sessions ADD COLUMN model TEXT NOT NULL DEFAULT ${sqlStringLiteral(DEFAULT_MODEL_ID)};`,
      );
    }

    if (!columns.has("reasoning_effort")) {
      this.db.exec(
        `ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT ${sqlStringLiteral(DEFAULT_REASONING_EFFORT)};`,
      );
    }

    if (!columns.has("catalog_revision")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN catalog_revision INTEGER NOT NULL DEFAULT ${DEFAULT_CATALOG_REVISION};`);
    }
  }

  listSessions(): Session[] {
    const rows = this.listStatement.all() as SessionRow[];
    return cloneSessions(rows.map(rowToSession).filter((session): session is Session => session !== null));
  }

  getSession(sessionId: string): Session | null {
    const row = this.getStatement.get(sessionId) as SessionRow | undefined;
    if (!row) {
      return null;
    }

    const session = rowToSession(row);
    return session ? cloneSessions([session])[0] : null;
  }

  upsertSession(session: Session): Session {
    const normalized = normalizeSession(session);
    if (!normalized) {
      throw new Error("保存するセッション形式が不正だよ。");
    }

    this.upsertStatement.run(
      normalized.id,
      normalized.taskTitle,
      normalized.taskSummary,
      normalized.status,
      normalized.updatedAt,
      normalized.provider,
      normalized.catalogRevision,
      normalized.workspaceLabel,
      normalized.workspacePath,
      normalized.branch,
      normalized.characterId,
      normalized.character,
      normalized.characterIconPath,
      normalized.runState,
      normalized.approvalMode,
      normalized.model,
      normalized.reasoningEffort,
      normalized.threadId,
      JSON.stringify(normalized.messages),
      JSON.stringify(normalized.stream),
      Date.now(),
    );

    return cloneSessions([normalized])[0];
  }

  deleteSession(sessionId: string): void {
    this.deleteStatement.run(sessionId);
  }

  close(): void {
    this.db.close();
  }
}
