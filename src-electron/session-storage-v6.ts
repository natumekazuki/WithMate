import type { DatabaseSync } from "node:sqlite";

import {
  cloneSessionSummaries,
  cloneSessions,
  CURRENT_SESSION_SCHEMA_VERSION,
  normalizeMessage,
  normalizeSession,
  normalizeSessionSummary,
  summarizeMessageArtifact,
  type Message,
  type MessageArtifact,
  type Session,
  type SessionSummary,
} from "../src/session-state.js";
import {
  parseCharacterRuntimeSnapshotJson,
  stringifyCharacterRuntimeSnapshot,
} from "../src/character/character-runtime-snapshot.js";
import { CREATE_V6_SCHEMA_SQL } from "./database-schema-v6.js";
import { openAppDatabase } from "./sqlite-connection.js";
import type { DeleteSessionsLastActiveBeforeCutoff } from "../src/withmate-window-types.js";

type SessionV6Row = {
  id: string;
  title: string;
  state: string;
  session_kind: string;
  provider_id: string;
  catalog_revision: number;
  model_id: string;
  reasoning_effort: string;
  custom_agent_name: string;
  approval_mode: string;
  codex_sandbox_mode: string;
  allowed_additional_directories_json: string;
  runtime_policy_json: string;
  thread_id: string;
  character_id: string | null;
  character_snapshot_json: string | null;
  workspace_path: string;
  updated_at: string;
  last_active_at: string;
};

type MessageV6Row = {
  role: "user" | "assistant" | "tool" | "system";
  body: string;
  artifact_body?: string | null;
};

type ExistingMessageArtifactRow = {
  seq: number;
  artifact_body: string | null;
};

type SessionIdRow = {
  id: string;
};

function toV6State(session: Session): string {
  if (session.status === "running") {
    return "active";
  }
  return "completed";
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function encodeMessage(message: Message): string {
  return JSON.stringify(message.artifact
    ? { ...message, artifact: summarizeMessageArtifact(message.artifact) }
    : message);
}

function encodeMessageArtifact(message: Message): string | null {
  return message.artifact ? JSON.stringify(message.artifact) : null;
}

function isSameArtifactSummary(source: MessageArtifact, summary: MessageArtifact): boolean {
  return JSON.stringify(summarizeMessageArtifact(source)) === JSON.stringify(summary);
}

function isArtifactSummaryProjection(artifact: MessageArtifact): boolean {
  return artifact.detailAvailable === true &&
    (artifact.operationTimeline ?? []).every((operation) => operation.details === undefined) &&
    artifact.changedFiles.every((file) => file.diffRows.length === 0);
}

function encodeMessageArtifactForWrite(message: Message, existingArtifactBody: string | null | undefined): string | null {
  if (!message.artifact) {
    return null;
  }

  if (isArtifactSummaryProjection(message.artifact) && existingArtifactBody) {
    const existingArtifact = decodeMessageArtifact(existingArtifactBody);
    if (existingArtifact && isSameArtifactSummary(existingArtifact, message.artifact)) {
      return existingArtifactBody;
    }
  }

  return encodeMessageArtifact(message);
}

function decodeMessageArtifact(value: string | null | undefined): MessageArtifact | null {
  if (!value) {
    return null;
  }

  return normalizeMessage({
    role: "assistant",
    text: "",
    artifact: parseJsonObject(value),
  })?.artifact ?? null;
}

function decodeMessage(row: MessageV6Row): Message | null {
  const parsed = normalizeMessage(parseJsonObject(row.body));
  if (parsed) {
    return parsed;
  }
  if (row.role === "user" || row.role === "assistant") {
    return { role: row.role, text: row.body };
  }
  return null;
}

export class SessionStorageV6 {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    for (const statement of CREATE_V6_SCHEMA_SQL) {
      this.db.exec(statement);
    }
    this.ensureSchema();
  }

  listSessions(): Session[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM sessions_v6
      ORDER BY last_active_at DESC, id DESC
    `).all() as SessionV6Row[];
    return cloneSessions(rows.map((row) => this.rowToSession(row)));
  }

  listSessionSummaries(): SessionSummary[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM sessions_v6
      ORDER BY last_active_at DESC, id DESC
    `).all() as SessionV6Row[];
    return cloneSessionSummaries(rows.map((row) => this.rowToSessionSummary(row)));
  }

  getSession(sessionId: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions_v6 WHERE id = ?").get(sessionId) as SessionV6Row | undefined;
    return row ? this.rowToSession(row) : null;
  }

  getSessionMessageArtifact(sessionId: string, messageIndex: number): MessageArtifact | null {
    const row = this.db.prepare(`
      SELECT role, body, artifact_body
      FROM session_messages_v6
      WHERE session_id = ? AND seq = ?
    `).get(sessionId, messageIndex) as MessageV6Row | undefined;
    return row ? decodeMessageArtifact(row.artifact_body) ?? decodeMessage(row)?.artifact ?? null : null;
  }

  listSessionIdsLastActiveBefore(cutoff: DeleteSessionsLastActiveBeforeCutoff): string[] {
    const rows = this.db.prepare(`
      SELECT id
      FROM sessions_v6
      WHERE last_active_at < ?
      ORDER BY last_active_at ASC, id ASC
    `).all(cutoff.cutoffIso) as SessionIdRow[];
    return rows.map((row) => row.id).filter((id) => id.trim().length > 0);
  }

  upsertSession(session: Session): Session {
    const normalized = normalizeSession(session);
    if (!normalized) {
      throw new Error("SessionStorageV6 に保存できない session 形式だよ。");
    }

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.writeSession(normalized);
      this.db.exec("COMMIT");
      return this.getSession(normalized.id) ?? normalized;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  replaceSessions(nextSessions: Session[]): Session[] {
    const normalizedSessions = nextSessions.map((session) => {
      const normalized = normalizeSession(session);
      if (!normalized) {
        throw new Error("SessionStorageV6 に保存できない session 形式だよ。");
      }
      return normalized;
    });

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db.exec("DELETE FROM session_messages_v6;");
      this.db.exec("DELETE FROM sessions_v6;");
      for (const session of normalizedSessions) {
        this.writeSession(session);
      }
      this.db.exec("COMMIT");
      return this.listSessions();
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteSession(sessionId: string): void {
    this.deleteSessions([sessionId]);
  }

  deleteSessions(sessionIds: readonly string[]): void {
    const uniqueSessionIds = Array.from(new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)));
    if (uniqueSessionIds.length === 0) {
      return;
    }

    const placeholders = uniqueSessionIds.map(() => "?").join(", ");
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db.prepare(`DELETE FROM sessions_v6 WHERE id IN (${placeholders})`).run(...uniqueSessionIds);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  clearSessions(): void {
    this.db.exec("DELETE FROM session_messages_v6;");
    this.db.exec("DELETE FROM sessions_v6;");
  }

  close(): void {
    this.db.close();
  }

  private writeSession(session: Session): void {
    const snapshot = session.characterRuntimeSnapshot;
    const runtimePolicy = {
      appStatus: session.status,
      runState: session.runState,
      workspaceLabel: session.workspaceLabel,
      branch: session.branch,
      accessMode: session.accessMode,
      sourceSchemaVersion: session.sourceSchemaVersion,
      characterName: session.character,
      characterIconPath: session.characterIconPath,
      characterThemeColors: session.characterThemeColors,
    };
    this.db.prepare(`
      INSERT INTO sessions_v6 (
        id,
        title,
        state,
        session_kind,
        provider_id,
        catalog_revision,
        model_id,
        reasoning_effort,
        custom_agent_name,
        approval_mode,
        codex_sandbox_mode,
        allowed_additional_directories_json,
        runtime_policy_json,
        thread_id,
        character_id,
        character_snapshot_json,
        workspace_path,
        created_at,
        updated_at,
        last_active_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        state = excluded.state,
        session_kind = excluded.session_kind,
        provider_id = excluded.provider_id,
        catalog_revision = excluded.catalog_revision,
        model_id = excluded.model_id,
        reasoning_effort = excluded.reasoning_effort,
        custom_agent_name = excluded.custom_agent_name,
        approval_mode = excluded.approval_mode,
        codex_sandbox_mode = excluded.codex_sandbox_mode,
        allowed_additional_directories_json = excluded.allowed_additional_directories_json,
        runtime_policy_json = excluded.runtime_policy_json,
        thread_id = excluded.thread_id,
        character_id = excluded.character_id,
        character_snapshot_json = excluded.character_snapshot_json,
        workspace_path = excluded.workspace_path,
        updated_at = excluded.updated_at,
        last_active_at = excluded.last_active_at
    `).run(
      session.id,
      session.taskTitle,
      toV6State(session),
      session.sessionKind,
      session.provider,
      session.catalogRevision,
      session.model,
      session.reasoningEffort,
      session.customAgentName,
      session.approvalMode,
      session.codexSandboxMode,
      JSON.stringify(session.allowedAdditionalDirectories),
      JSON.stringify(runtimePolicy),
      session.threadId,
      snapshot ? session.characterId : null,
      snapshot ? stringifyCharacterRuntimeSnapshot(snapshot) : null,
      session.workspacePath,
      session.updatedAt,
      session.updatedAt,
      session.updatedAt,
    );

    const existingArtifactBodies = new Map(
      (this.db.prepare(`
        SELECT seq, artifact_body
        FROM session_messages_v6
        WHERE session_id = ?
      `).all(session.id) as ExistingMessageArtifactRow[])
        .map((row) => [row.seq, row.artifact_body] as const),
    );

    this.db.prepare("DELETE FROM session_messages_v6 WHERE session_id = ?").run(session.id);
    const insertMessage = this.db.prepare(`
      INSERT INTO session_messages_v6 (session_id, seq, role, body, artifact_body, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    session.messages.forEach((message, index) => {
      insertMessage.run(
        session.id,
        index,
        message.role,
        encodeMessage(message),
        encodeMessageArtifactForWrite(message, existingArtifactBodies.get(index)),
        session.updatedAt,
      );
    });
  }

  private ensureSchema(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(session_messages_v6)").all() as Array<{ name?: unknown }>)
        .map((column) => column.name)
        .filter((name): name is string => typeof name === "string"),
    );

    if (!columns.has("artifact_body")) {
      this.db.exec("ALTER TABLE session_messages_v6 ADD COLUMN artifact_body TEXT;");
    }
  }

  private rowToSessionSummary(row: SessionV6Row): SessionSummary {
    const runtimePolicy = parseJsonObject(row.runtime_policy_json);
    const snapshot = row.character_snapshot_json ? parseCharacterRuntimeSnapshotJson(row.character_snapshot_json) : null;
    const summary = normalizeSessionSummary({
      id: row.id,
      taskTitle: row.title,
      status: typeof runtimePolicy.appStatus === "string" ? runtimePolicy.appStatus : row.state === "active" ? "running" : "idle",
      updatedAt: row.updated_at || row.last_active_at,
      provider: row.provider_id,
      catalogRevision: row.catalog_revision,
      workspaceLabel: runtimePolicy.workspaceLabel,
      workspacePath: row.workspace_path,
      branch: runtimePolicy.branch,
      sessionKind: row.session_kind,
      accessMode: runtimePolicy.accessMode,
      sourceSchemaVersion: runtimePolicy.sourceSchemaVersion ?? CURRENT_SESSION_SCHEMA_VERSION,
      characterId: snapshot?.characterId ?? row.character_id ?? "",
      character: snapshot?.name ?? runtimePolicy.characterName,
      characterIconPath: snapshot?.iconFilePath ?? runtimePolicy.characterIconPath,
      characterThemeColors: snapshot?.theme ?? runtimePolicy.characterThemeColors,
      runState: runtimePolicy.runState,
      approvalMode: row.approval_mode,
      codexSandboxMode: row.codex_sandbox_mode,
      model: row.model_id,
      reasoningEffort: row.reasoning_effort,
      customAgentName: row.custom_agent_name,
      allowedAdditionalDirectories: parseJsonArray(row.allowed_additional_directories_json),
      threadId: row.thread_id,
    });
    if (!summary) {
      throw new Error(`V6 session row を summary に変換できないよ: ${row.id}`);
    }
    return summary;
  }

  private rowToSession(row: SessionV6Row): Session {
    const summary = this.rowToSessionSummary(row);
    const messageRows = this.db.prepare(`
      SELECT role, body
      FROM session_messages_v6
      WHERE session_id = ?
      ORDER BY seq ASC
    `).all(row.id) as MessageV6Row[];
    const session = normalizeSession({
      ...summary,
      characterRuntimeSnapshot: row.character_snapshot_json
        ? parseCharacterRuntimeSnapshotJson(row.character_snapshot_json)
        : null,
      messages: messageRows.map((messageRow) => decodeMessage(messageRow)).filter((message): message is Message => message !== null),
      stream: [],
    });
    if (!session) {
      throw new Error(`V6 session row を session に変換できないよ: ${row.id}`);
    }
    return session;
  }
}
