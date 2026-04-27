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

type SessionMessageRow = {
  role: string;
  text: string;
  accent: number;
  artifact_available: number;
  artifact_json: string | null;
};

type SessionRowParseMode = "skip" | "throw";

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

export class SessionStorageV2Read {
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  private withDb<T>(runner: (db: DatabaseSync) => T): T {
    const db = openAppDatabase(this.dbPath);
    try {
      return runner(db);
    } finally {
      db.close();
    }
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

  close(): void {
    return;
  }
}
