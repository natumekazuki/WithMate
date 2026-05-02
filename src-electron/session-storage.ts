import type { DatabaseSync } from "node:sqlite";

import {
  cloneSessionSummaries,
  cloneSessions,
  normalizeSession,
  normalizeSessionSummary,
  type MessageArtifact,
  type Session,
  type SessionSummary,
} from "../src/session-state.js";
import {
  CREATE_SESSIONS_TABLE_SQL,
  LEGACY_SESSION_COLUMN_DEFINITIONS,
} from "./database-schema-v1.js";
import { openAppDatabase } from "./sqlite-connection.js";

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
  session_kind: string;
  character_id: string;
  character_name: string;
  character_icon_path: string;
  character_theme_main: string;
  character_theme_sub: string;
  run_state: string;
  approval_mode: string;
  codex_sandbox_mode: string;
  model: string;
  reasoning_effort: string;
  custom_agent_name: string;
  allowed_additional_directories_json: string;
  thread_id: string;
  messages_json: string;
  stream_json: string;
};

type SessionSummaryRow = Omit<SessionRow, "messages_json" | "stream_json">;

type TableColumnRow = {
  name: string;
};

const SESSION_SELECT_COLUMNS = `
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
  session_kind,
  character_id,
  character_name,
  character_icon_path,
  character_theme_main,
  character_theme_sub,
  run_state,
  approval_mode,
  codex_sandbox_mode,
  model,
  reasoning_effort,
  custom_agent_name,
  allowed_additional_directories_json,
  thread_id,
  messages_json,
  stream_json
`;

const LIST_SESSIONS_SQL = `
  SELECT
    ${SESSION_SELECT_COLUMNS}
  FROM sessions
  ORDER BY last_active_at DESC, id DESC
`;

const SESSION_SUMMARY_SELECT_COLUMNS = `
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
  session_kind,
  character_id,
  character_name,
  character_icon_path,
  character_theme_main,
  character_theme_sub,
  run_state,
  approval_mode,
  codex_sandbox_mode,
  model,
  reasoning_effort,
  custom_agent_name,
  allowed_additional_directories_json,
  thread_id
`;

const LIST_SESSION_SUMMARIES_SQL = `
  SELECT
    ${SESSION_SUMMARY_SELECT_COLUMNS}
  FROM sessions
  ORDER BY last_active_at DESC, id DESC
`;

const GET_SESSION_SQL = `
  SELECT
    ${SESSION_SELECT_COLUMNS}
  FROM sessions
  WHERE id = ?
`;

const UPSERT_SESSION_SQL = `
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
    session_kind,
    character_id,
    character_name,
    character_icon_path,
    character_theme_main,
    character_theme_sub,
    run_state,
    approval_mode,
    codex_sandbox_mode,
    model,
    reasoning_effort,
    custom_agent_name,
    allowed_additional_directories_json,
    thread_id,
    messages_json,
    stream_json,
    last_active_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    session_kind = excluded.session_kind,
    character_id = excluded.character_id,
    character_name = excluded.character_name,
    character_icon_path = excluded.character_icon_path,
    character_theme_main = excluded.character_theme_main,
    character_theme_sub = excluded.character_theme_sub,
    run_state = excluded.run_state,
    approval_mode = excluded.approval_mode,
    codex_sandbox_mode = excluded.codex_sandbox_mode,
    model = excluded.model,
    reasoning_effort = excluded.reasoning_effort,
    custom_agent_name = excluded.custom_agent_name,
    allowed_additional_directories_json = excluded.allowed_additional_directories_json,
    thread_id = excluded.thread_id,
    messages_json = excluded.messages_json,
    stream_json = excluded.stream_json,
    last_active_at = excluded.last_active_at
`;

const DELETE_SESSION_SQL = `
  DELETE FROM sessions
  WHERE id = ?
`;

type SessionRowParseMode = "skip" | "throw";

function parseSessionJson<T>(row: SessionRow, columnName: keyof Pick<
  SessionRow,
  "allowed_additional_directories_json" | "messages_json" | "stream_json"
>, mode: SessionRowParseMode): T | null {
  try {
    return JSON.parse(row[columnName]) as T;
  } catch (error) {
    console.error("stored session JSON parse failed", {
      sessionId: row.id,
      columnName,
      error,
    });
    if (mode === "throw") {
      throw new Error(`保存済み session ${row.id} の ${columnName} が壊れているよ。`);
    }
    return null;
  }
}

function rowToSession(row: SessionRow, mode: SessionRowParseMode = "skip"): Session | null {
  const allowedAdditionalDirectories = parseSessionJson<string[]>(row, "allowed_additional_directories_json", mode);
  const messages = parseSessionJson<Session["messages"]>(row, "messages_json", mode);
  const stream = parseSessionJson<Session["stream"]>(row, "stream_json", mode);
  if (!allowedAdditionalDirectories || !messages || !stream) {
    return null;
  }

  const session = normalizeSession({
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
    sessionKind: row.session_kind,
    characterId: row.character_id,
    character: row.character_name,
    characterIconPath: row.character_icon_path,
    characterThemeColors: {
      main: row.character_theme_main,
      sub: row.character_theme_sub,
    },
    runState: row.run_state,
    approvalMode: row.approval_mode,
    codexSandboxMode: row.codex_sandbox_mode,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    customAgentName: row.custom_agent_name,
    allowedAdditionalDirectories,
    threadId: row.thread_id,
    messages,
    stream,
  });
  if (!session) {
    console.error("stored session normalization failed", { sessionId: row.id });
    if (mode === "throw") {
      throw new Error(`保存済み session ${row.id} が壊れているよ。`);
    }
  }

  return session;
}

function rowToSessionSummary(row: SessionSummaryRow, mode: SessionRowParseMode = "skip"): SessionSummary | null {
  const allowedAdditionalDirectories = parseSessionJson<string[]>(
    row as SessionRow,
    "allowed_additional_directories_json",
    mode,
  );
  if (!allowedAdditionalDirectories) {
    return null;
  }

  const summary = normalizeSessionSummary({
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
    sessionKind: row.session_kind,
    characterId: row.character_id,
    character: row.character_name,
    characterIconPath: row.character_icon_path,
    characterThemeColors: {
      main: row.character_theme_main,
      sub: row.character_theme_sub,
    },
    runState: row.run_state,
    approvalMode: row.approval_mode,
    codexSandboxMode: row.codex_sandbox_mode,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    customAgentName: row.custom_agent_name,
    allowedAdditionalDirectories,
    threadId: row.thread_id,
  });
  if (!summary) {
    console.error("stored session summary normalization failed", { sessionId: row.id });
    if (mode === "throw") {
      throw new Error(`保存済み session ${row.id} の summary が壊れているよ。`);
    }
  }

  return summary;
}

export class SessionStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);

    this.db.exec(CREATE_SESSIONS_TABLE_SQL);
    this.ensureSchema();
  }

  private writeSession(normalized: Session, lastActiveAt: number): void {
    this.db.prepare(UPSERT_SESSION_SQL).run(
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
      normalized.sessionKind,
      normalized.characterId,
      normalized.character,
      normalized.characterIconPath,
      normalized.characterThemeColors.main,
      normalized.characterThemeColors.sub,
      normalized.runState,
      normalized.approvalMode,
      normalized.codexSandboxMode,
      normalized.model,
      normalized.reasoningEffort,
      normalized.customAgentName,
      JSON.stringify(normalized.allowedAdditionalDirectories),
      normalized.threadId,
      JSON.stringify(normalized.messages),
      JSON.stringify(normalized.stream),
      lastActiveAt,
    );
  }

  private ensureSchema(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(sessions)").all() as TableColumnRow[]).map((column) => column.name),
    );

    if (!columns.has("model")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN model ${LEGACY_SESSION_COLUMN_DEFINITIONS.model};`);
    }

    if (!columns.has("reasoning_effort")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN reasoning_effort ${LEGACY_SESSION_COLUMN_DEFINITIONS.reasoning_effort};`);
    }

    if (!columns.has("codex_sandbox_mode")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN codex_sandbox_mode ${LEGACY_SESSION_COLUMN_DEFINITIONS.codex_sandbox_mode};`);
    }

    if (!columns.has("catalog_revision")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN catalog_revision ${LEGACY_SESSION_COLUMN_DEFINITIONS.catalog_revision};`);
    }

    if (!columns.has("custom_agent_name")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN custom_agent_name ${LEGACY_SESSION_COLUMN_DEFINITIONS.custom_agent_name};`);
    }

    if (!columns.has("allowed_additional_directories_json")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN allowed_additional_directories_json ${LEGACY_SESSION_COLUMN_DEFINITIONS.allowed_additional_directories_json};`);
    }

    if (!columns.has("character_theme_main")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN character_theme_main ${LEGACY_SESSION_COLUMN_DEFINITIONS.character_theme_main};`);
    }

    if (!columns.has("character_theme_sub")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN character_theme_sub ${LEGACY_SESSION_COLUMN_DEFINITIONS.character_theme_sub};`);
    }

  }

  listSessions(): Session[] {
    const rows = this.db.prepare(LIST_SESSIONS_SQL).all() as SessionRow[];
    return cloneSessions(rows.map((row) => rowToSession(row)).filter((session): session is Session => session !== null));
  }

  listSessionSummaries(): SessionSummary[] {
    const rows = this.db.prepare(LIST_SESSION_SUMMARIES_SQL).all() as SessionSummaryRow[];
    return cloneSessionSummaries(
      rows.map((row) => rowToSessionSummary(row)).filter((session): session is SessionSummary => session !== null),
    );
  }

  getSession(sessionId: string): Session | null {
    const row = this.db.prepare(GET_SESSION_SQL).get(sessionId) as SessionRow | undefined;
    if (!row) {
      return null;
    }

    const session = rowToSession(row, "throw");
    return session ? cloneSessions([session])[0] : null;
  }

  getSessionMessageArtifact(sessionId: string, messageIndex: number): MessageArtifact | null {
    const session = this.getSession(sessionId);
    return session?.messages[messageIndex]?.artifact ?? null;
  }

  upsertSession(session: Session): Session {
    const normalized = normalizeSession(session);
    if (!normalized) {
      throw new Error("保存するセッション形式が不正だよ。");
    }

    this.writeSession(normalized, Date.now());
    return cloneSessions([normalized])[0];
  }

  replaceSessions(nextSessions: Session[]): Session[] {
    const normalizedSessions = nextSessions.map((session) => {
      const normalized = normalizeSession(session);
      if (!normalized) {
        throw new Error("保存するセッション形式が不正だよ。");
      }

      return normalized;
    });

    const baseLastActiveAt = Date.now() + normalizedSessions.length;
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db.exec("DELETE FROM sessions");
      normalizedSessions.forEach((session, index) => {
        this.writeSession(session, baseLastActiveAt - index);
      });
      this.db.exec("COMMIT");
      return cloneSessions(normalizedSessions);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteSession(sessionId: string): void {
    this.db.prepare(DELETE_SESSION_SQL).run(sessionId);
  }

  clearSessions(): void {
    this.db.exec("DELETE FROM sessions;");
  }

  close(): void {
    this.db.close();
  }
}
