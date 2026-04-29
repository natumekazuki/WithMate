import type { DatabaseSync } from "node:sqlite";

import {
  cloneSessionSummaries,
  cloneSessions,
  normalizeSession,
  normalizeSessionSummary,
  type Message,
  type MessageArtifact,
  type Session,
  type SessionSummary,
} from "../src/session-state.js";
import { openAppDatabase } from "./sqlite-connection.js";

type SessionHeaderRow = {
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
};

type SessionAuditLogCountRow = {
  id: string;
  audit_log_count: number;
};

type SessionAuditLogCountValueRow = {
  audit_log_count: number;
};

type SessionIdRow = {
  id: string;
};

type SessionMessageRow = {
  role: string;
  text: string;
  accent: number;
  artifact_available: number;
  artifact_json: string | null;
};

type SessionRowParseMode = "skip" | "throw";

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
    message_count,
    audit_log_count,
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
    message_count = excluded.message_count,
    audit_log_count = excluded.audit_log_count,
    last_active_at = excluded.last_active_at
`;

const DELETE_SESSION_MESSAGES_SQL = `
  DELETE FROM session_messages
  WHERE session_id = ?
`;

const DELETE_SESSION_SQL = `
  DELETE FROM sessions
  WHERE id = ?
`;

const DELETE_ALL_SESSIONS_SQL = `
  DELETE FROM sessions
`;

const LIST_SESSION_IDS_SQL = `
  SELECT id
  FROM sessions
`;

const INSERT_SESSION_MESSAGE_SQL = `
  INSERT INTO session_messages (
    session_id,
    seq,
    role,
    text,
    accent,
    artifact_available,
    created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_MESSAGE_ARTIFACT_SQL = `
  INSERT INTO session_message_artifacts (message_id, artifact_json)
  VALUES (?, ?)
`;

const GET_SESSION_AUDIT_LOG_COUNT_SQL = `
  SELECT audit_log_count
  FROM sessions
  WHERE id = ?
`;

const LIST_SESSION_AUDIT_LOG_COUNTS_SQL = `
  SELECT id, audit_log_count
  FROM sessions
`;

const SESSION_HEADER_COLUMNS = `
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
    ${SESSION_HEADER_COLUMNS}
  FROM sessions
  ORDER BY last_active_at DESC, id DESC
`;

const GET_SESSION_HEADER_SQL = `
  SELECT
    ${SESSION_HEADER_COLUMNS}
  FROM sessions
  WHERE id = ?
`;

const LIST_SESSION_MESSAGES_SQL = `
  SELECT
    m.role,
    m.text,
    m.accent,
    m.artifact_available,
    a.artifact_json
  FROM session_messages AS m
  LEFT JOIN session_message_artifacts AS a
    ON a.message_id = m.id
  WHERE m.session_id = ?
  ORDER BY m.seq ASC
`;

function parseAllowedAdditionalDirectories(row: SessionHeaderRow, mode: SessionRowParseMode): string[] | null {
  try {
    const parsed = JSON.parse(row.allowed_additional_directories_json);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : null;
  } catch (error) {
    console.error("stored session JSON parse failed", {
      sessionId: row.id,
      columnName: "allowed_additional_directories_json",
      error,
    });
    if (mode === "throw") {
      throw new Error(`保存済み session ${row.id} の allowed_additional_directories_json が壊れているよ。`);
    }
    return null;
  }
}

function rowToSessionSummary(row: SessionHeaderRow, mode: SessionRowParseMode = "skip"): SessionSummary | null {
  const allowedAdditionalDirectories = parseAllowedAdditionalDirectories(row, mode);
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

  if (!summary && mode === "throw") {
    throw new Error(`保存済み session ${row.id} の summary が壊れているよ。`);
  }

  return summary;
}

function rowToMessage(row: SessionMessageRow): Message | null {
  if (row.role !== "user" && row.role !== "assistant") {
    return null;
  }

  let artifact: MessageArtifact | undefined;
  if (row.artifact_available === 1 && row.artifact_json) {
    try {
      artifact = JSON.parse(row.artifact_json) as MessageArtifact;
    } catch {
      artifact = undefined;
    }
  }

  return {
    role: row.role,
    text: row.text,
    accent: row.accent === 1 ? true : undefined,
    artifact,
  };
}

function rowToSession(row: SessionHeaderRow, messages: Message[], mode: SessionRowParseMode = "skip"): Session | null {
  const summary = rowToSessionSummary(row, mode);
  if (!summary) {
    return null;
  }

  const session = normalizeSession({
    ...summary,
    messages,
    stream: [],
  });
  if (!session && mode === "throw") {
    throw new Error(`保存済み session ${row.id} が壊れているよ。`);
  }

  return session;
}

function readAuditLogCountRows(db: DatabaseSync): Map<string, number> {
  const rows = db.prepare(LIST_SESSION_AUDIT_LOG_COUNTS_SQL).all() as SessionAuditLogCountRow[];
  return new Map(rows.map((row) => [row.id, row.audit_log_count]));
}

function readSessionIds(db: DatabaseSync): Set<string> {
  const rows = db.prepare(LIST_SESSION_IDS_SQL).all() as SessionIdRow[];
  return new Set(rows.map((row) => row.id));
}

function getAuditLogCountFromDb(db: DatabaseSync, sessionId: string): number {
  const row = db.prepare(GET_SESSION_AUDIT_LOG_COUNT_SQL).get(sessionId) as SessionAuditLogCountValueRow | undefined;
  return row?.audit_log_count ?? 0;
}

function writeSessionHeader(
  statement: ReturnType<DatabaseSync["prepare"]>,
  session: Session,
  lastActiveAt: number,
  auditLogCount: number,
): void {
  statement.run(
    session.id,
    session.taskTitle,
    session.taskSummary,
    session.status,
    session.updatedAt,
    session.provider,
    session.catalogRevision,
    session.workspaceLabel,
    session.workspacePath,
    session.branch,
    session.sessionKind,
    session.characterId,
    session.character,
    session.characterIconPath,
    session.characterThemeColors.main,
    session.characterThemeColors.sub,
    session.runState,
    session.approvalMode,
    session.codexSandboxMode,
    session.model,
    session.reasoningEffort,
    session.customAgentName,
    JSON.stringify(session.allowedAdditionalDirectories ?? []),
    session.threadId,
    session.messages.length,
    auditLogCount,
    lastActiveAt,
  );
}

function writeSessionMessages(
  insertMessageStatement: ReturnType<DatabaseSync["prepare"]>,
  insertArtifactStatement: ReturnType<DatabaseSync["prepare"]>,
  session: Session,
): void {
  session.messages.forEach((message, index) => {
    const result = insertMessageStatement.run(
      session.id,
      index,
      message.role,
      message.text,
      message.accent === true ? 1 : 0,
      message.artifact ? 1 : 0,
      "",
    );
    if (message.artifact) {
      insertArtifactStatement.run(Number(result.lastInsertRowid), JSON.stringify(message.artifact));
    }
  });
}

export class SessionStorageV2 {
  private db: DatabaseSync | null;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
  }

  private withDb<T>(runner: (db: DatabaseSync) => T): T {
    if (!this.db) {
      throw new Error("SessionStorageV2 は close 済みだよ。");
    }

    return runner(this.db);
  }

  listSessions(): Session[] {
    return this.withDb((db) => {
      const rows = db.prepare(LIST_SESSION_SUMMARIES_SQL).all() as SessionHeaderRow[];
      return cloneSessions(
        rows
          .map((row) => rowToSession(row, []))
          .filter((session): session is Session => session !== null),
      );
    });
  }

  listSessionSummaries(): SessionSummary[] {
    return this.withDb((db) => {
      const rows = db.prepare(LIST_SESSION_SUMMARIES_SQL).all() as SessionHeaderRow[];
      return cloneSessionSummaries(
        rows.map((row) => rowToSessionSummary(row)).filter((session): session is SessionSummary => session !== null),
      );
    });
  }

  getSession(sessionId: string): Session | null {
    return this.withDb((db) => {
      const row = db.prepare(GET_SESSION_HEADER_SQL).get(sessionId) as SessionHeaderRow | undefined;
      if (!row) {
        return null;
      }

      const messageRows = db.prepare(LIST_SESSION_MESSAGES_SQL).all(sessionId) as SessionMessageRow[];
      const messages = messageRows
        .map((messageRow) => rowToMessage(messageRow))
        .filter((message): message is Message => message !== null);
      const session = rowToSession(row, messages, "throw");
      return session ? cloneSessions([session])[0] : null;
    });
  }

  upsertSession(session: Session): Session {
    const normalized = normalizeSession(session);
    if (!normalized) {
      throw new Error("保存するセッション形式が不正だよ。");
    }

    return this.withDb((db) => {
      const auditLogCount = getAuditLogCountFromDb(db, normalized.id);
      const upsertSessionStatement = db.prepare(UPSERT_SESSION_SQL);
      const deleteMessagesStatement = db.prepare(DELETE_SESSION_MESSAGES_SQL);
      const insertMessageStatement = db.prepare(INSERT_SESSION_MESSAGE_SQL);
      const insertArtifactStatement = db.prepare(INSERT_MESSAGE_ARTIFACT_SQL);

      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        writeSessionHeader(upsertSessionStatement, normalized, Date.now(), auditLogCount);
        deleteMessagesStatement.run(normalized.id);
        writeSessionMessages(insertMessageStatement, insertArtifactStatement, normalized);
        db.exec("COMMIT");
        return cloneSessions([normalized])[0];
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  replaceSessions(nextSessions: Session[]): Session[] {
    const normalizedSessions = nextSessions.map((session) => {
      const normalized = normalizeSession(session);
      if (!normalized) {
        throw new Error("保存するセッション形式が不正だよ。");
      }

      return normalized;
    });

    return this.withDb((db) => {
      const existingAuditLogCounts = readAuditLogCountRows(db);
      const existingSessionIds = readSessionIds(db);
      const nextSessionIds = new Set(normalizedSessions.map((session) => session.id));
      const upsertSessionStatement = db.prepare(UPSERT_SESSION_SQL);
      const deleteSessionStatement = db.prepare(DELETE_SESSION_SQL);
      const deleteMessagesStatement = db.prepare(DELETE_SESSION_MESSAGES_SQL);
      const insertMessageStatement = db.prepare(INSERT_SESSION_MESSAGE_SQL);
      const insertArtifactStatement = db.prepare(INSERT_MESSAGE_ARTIFACT_SQL);
      const baseLastActiveAt = Date.now() + normalizedSessions.length;

      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        for (const existingSessionId of existingSessionIds) {
          if (!nextSessionIds.has(existingSessionId)) {
            deleteSessionStatement.run(existingSessionId);
          }
        }
        normalizedSessions.forEach((session, index) => {
          writeSessionHeader(
            upsertSessionStatement,
            session,
            baseLastActiveAt - index,
            existingAuditLogCounts.get(session.id) ?? 0,
          );
          deleteMessagesStatement.run(session.id);
          writeSessionMessages(insertMessageStatement, insertArtifactStatement, session);
        });
        db.exec("COMMIT");
        return cloneSessions(normalizedSessions);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  deleteSession(sessionId: string): void {
    this.withDb((db) => {
      db.prepare(DELETE_SESSION_SQL).run(sessionId);
    });
  }

  clearSessions(): void {
    this.withDb((db) => {
      db.prepare(DELETE_ALL_SESSIONS_SQL).run();
    });
  }

  close(): void {
    if (!this.db) {
      return;
    }

    this.db.close();
    this.db = null;
  }
}
