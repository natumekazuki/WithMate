import type { DatabaseSync } from "node:sqlite";

import {
  cloneHomeSessionSummaries,
  cloneSessionSummaries,
  cloneSessions,
  CURRENT_SESSION_SCHEMA_VERSION,
  normalizeMessage,
  normalizeHomeSessionSummary,
  normalizeSession,
  normalizeSessionSummary,
  summarizeMessageArtifact,
  type Message,
  type MessageArtifact,
  type HomeSessionSummary,
  type Session,
  type SessionCharacterUsage,
  type SessionSummaryPageRequest,
  type HomeSessionSummaryPageResult,
  type SessionSummary,
} from "../src/session-state.js";
import { normalizeProviderId } from "../src/model-catalog.js";
import {
  parseCharacterRuntimeSnapshotJson,
  stringifyCharacterRuntimeSnapshot,
} from "../src/character/character-runtime-snapshot.js";
import {
  UNKNOWN_CHARACTER_OWNER_ID,
  isUnknownCharacterOwnerId,
  normalizeCharacterOwnerId,
  recoverStoredCharacterOwnerId,
} from "../src/character/character-owner.js";
import {
  registerSessionProviderIdNormalizer,
  SESSION_PROVIDER_ID_NORMALIZER_SQL_FUNCTION,
} from "./session-provider-id-sql.js";
import { deleteAuditEventsForSessionTargets } from "./audit-log-storage-v6.js";
import { ensureV6Schema } from "./database-schema-v6.js";
import { openAppDatabase } from "./sqlite-connection.js";
import { SessionIdCollisionError } from "./session-storage-errors.js";
import {
  buildSessionSummaryKeysetClause,
  buildSessionSummarySearchClause,
  decodeSessionSummaryCursor,
  encodeSessionSummaryCursor,
  parseSessionSummaryPageRequest,
} from "./session-summary-query.js";
import type { DeleteSessionsLastActiveBeforeCutoff } from "../src/withmate-window-types.js";
import {
  writeSessionTurnTerminalCommit,
  type SessionTurnTerminalCommit,
} from "./session-turn-terminal-commit.js";

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
  is_pinned: number;
  updated_at: string;
  last_active_at: string;
};

type HomeSessionSummaryV6Row = {
  id: string;
  task_title: string;
  status: string;
  updated_at: string;
  workspace_label: string;
  workspace_path: string;
  session_kind: string;
  access_mode: string;
  source_schema_version: number;
  character_id: string;
  character_name: string | null;
  character_icon_path: string | null;
  character_theme_main: string | null;
  character_theme_sub: string | null;
  run_state: string | null;
  is_pinned: number;
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

type SessionCharacterUsageRow = {
  character_id: string | null;
};

type DecodedSessionV6RuntimeState = {
  runtimePolicy: Record<string, unknown>;
  characterId: string;
  snapshot: ReturnType<typeof parseCharacterRuntimeSnapshotJson>;
  threadId: string;
};

const AUXILIARY_SESSIONS_TABLE_NAME = "auxiliary_sessions";
const COMPANION_SESSIONS_TABLE_NAME = "companion_sessions";

const SESSION_RUN_STUCK_INVESTIGATION_LOG = "[investigate:session-run-stuck]";

function v6RuntimeJsonValue(path: string): string {
  return `CASE WHEN json_valid(s.runtime_policy_json) THEN json_extract(s.runtime_policy_json, '${path}') ELSE NULL END`;
}

function v6SnapshotJsonValue(path: string): string {
  return `CASE WHEN json_valid(s.character_snapshot_json) THEN json_extract(s.character_snapshot_json, '${path}') ELSE NULL END`;
}

const V6_HOME_RUNTIME_CHARACTER_ID_EXPRESSION = v6RuntimeJsonValue("$.characterId");
const V6_HOME_CHARACTER_ID_EXPRESSION = `COALESCE(
  NULLIF(TRIM(s.character_id), ''),
  NULLIF(TRIM(CAST(${V6_HOME_RUNTIME_CHARACTER_ID_EXPRESSION} AS TEXT)), ''),
  '${UNKNOWN_CHARACTER_OWNER_ID}'
)`;
const V6_HOME_SNAPSHOT_STRUCTURE_EXPRESSION = `CASE WHEN json_valid(s.character_snapshot_json) THEN
  CASE WHEN json_type(s.character_snapshot_json, '$.characterId') = 'text'
    AND json_type(s.character_snapshot_json, '$.name') = 'text'
    AND json_type(s.character_snapshot_json, '$.definitionMarkdown') = 'text'
    THEN 1 ELSE 0 END
  ELSE 0 END`;
const V6_HOME_SNAPSHOT_MATCH_EXPRESSION = `CASE WHEN ${V6_HOME_SNAPSHOT_STRUCTURE_EXPRESSION} = 1 THEN
  CASE WHEN TRIM(COALESCE(json_extract(s.character_snapshot_json, '$.characterId'), '')) = TRIM(${V6_HOME_CHARACTER_ID_EXPRESSION})
    AND TRIM(${V6_HOME_CHARACTER_ID_EXPRESSION}) <> '${UNKNOWN_CHARACTER_OWNER_ID}'
    THEN 1 ELSE 0 END
  ELSE 0 END`;
const HOME_SESSION_SUMMARY_SELECT_COLUMNS = `
  s.id,
  s.title AS task_title,
  CASE
    WHEN ${v6RuntimeJsonValue("$.appStatus")} IN ('running', 'idle', 'saved') THEN ${v6RuntimeJsonValue("$.appStatus")}
    WHEN s.state = 'active' THEN 'running'
    ELSE 'idle'
  END AS status,
  COALESCE(NULLIF(s.updated_at, ''), s.last_active_at) AS updated_at,
  COALESCE(${v6RuntimeJsonValue("$.workspaceLabel")}, '') AS workspace_label,
  s.workspace_path,
  s.session_kind,
  COALESCE(${v6RuntimeJsonValue("$.accessMode")}, 'active') AS access_mode,
  COALESCE(${v6RuntimeJsonValue("$.sourceSchemaVersion")}, ${CURRENT_SESSION_SCHEMA_VERSION}) AS source_schema_version,
  ${V6_HOME_CHARACTER_ID_EXPRESSION} AS character_id,
  CASE WHEN ${V6_HOME_SNAPSHOT_MATCH_EXPRESSION} = 1
    THEN ${v6SnapshotJsonValue("$.name")}
    ELSE ${v6RuntimeJsonValue("$.characterName")}
  END AS character_name,
  CASE WHEN ${V6_HOME_SNAPSHOT_MATCH_EXPRESSION} = 1
    THEN ${v6SnapshotJsonValue("$.iconFilePath")}
    ELSE ${v6RuntimeJsonValue("$.characterIconPath")}
  END AS character_icon_path,
  CASE WHEN ${V6_HOME_SNAPSHOT_MATCH_EXPRESSION} = 1
    THEN ${v6SnapshotJsonValue("$.theme.main")}
    ELSE ${v6RuntimeJsonValue("$.characterThemeColors.main")}
  END AS character_theme_main,
  CASE WHEN ${V6_HOME_SNAPSHOT_MATCH_EXPRESSION} = 1
    THEN ${v6SnapshotJsonValue("$.theme.sub")}
    ELSE ${v6RuntimeJsonValue("$.characterThemeColors.sub")}
  END AS character_theme_sub,
  COALESCE(${v6RuntimeJsonValue("$.runState")}, 'idle') AS run_state,
  s.is_pinned,
  s.last_active_at
`;

function logSessionRunStuckInvestigation(
  event: string,
  details: Record<string, unknown>,
): void {
  console.info(SESSION_RUN_STUCK_INVESTIGATION_LOG, event, details);
}

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

function decodeSessionV6RuntimeState(row: SessionV6Row): DecodedSessionV6RuntimeState {
  const runtimePolicy = parseJsonObject(row.runtime_policy_json);
  const runtimeCharacterId = normalizeCharacterOwnerId(runtimePolicy.characterId);
  const storedCharacterId = normalizeCharacterOwnerId(row.character_id) ?? runtimeCharacterId;
  const characterId = recoverStoredCharacterOwnerId(storedCharacterId);
  const unresolvedOwner = isUnknownCharacterOwnerId(characterId);
  const parsedSnapshot = row.character_snapshot_json
    ? parseCharacterRuntimeSnapshotJson(row.character_snapshot_json)
    : null;
  const snapshot = !unresolvedOwner && parsedSnapshot
    && parsedSnapshot.characterId === characterId
    ? parsedSnapshot
    : null;
  const rejectedStoredSnapshot = row.character_snapshot_json !== null && snapshot === null;

  return {
    runtimePolicy,
    characterId,
    snapshot,
    threadId: unresolvedOwner || rejectedStoredSnapshot ? "" : row.thread_id,
  };
}

function normalizeSessionForStorage(session: Session): Session {
  const ownerId = normalizeCharacterOwnerId(session.characterId);
  const snapshotOwnerId = normalizeCharacterOwnerId(session.characterRuntimeSnapshot?.characterId);
  if (session.characterRuntimeSnapshot && (!ownerId || snapshotOwnerId !== ownerId)) {
    throw new Error("SessionStorageV6 に保存できない session 形式だよ。");
  }

  const normalized = normalizeSession(session);
  if (!normalized) {
    throw new Error("SessionStorageV6 に保存できない session 形式だよ。");
  }
  return normalized;
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
    registerSessionProviderIdNormalizer(this.db);
    ensureV6Schema(this.db);
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

  listSessionSummaryPage(request?: SessionSummaryPageRequest | null): HomeSessionSummaryPageResult {
    const parsed = parseSessionSummaryPageRequest(request);
    const isOpenScope = parsed.scope === "open";
    const cursor = parsed.scope === "open"
      ? null
      : decodeSessionSummaryCursor(parsed.cursor, parsed.scope, parsed.searchText);
    const search = buildSessionSummarySearchClause("s", parsed.searchText);
    const keyset = buildSessionSummaryKeysetClause("s", cursor);
    const where: string[] = [];
    const params: string[] = [];

    if (parsed.scope === "pinned") {
      where.push("s.is_pinned = 1");
    }
    if (isOpenScope) {
      const sessionIds = parsed.sessionIds ?? [];
      if (sessionIds.length === 0) {
        return { entries: [], nextCursor: null, hasMore: false };
      }
      where.push(`s.id IN (${sessionIds.map(() => "?").join(", ")})`);
      params.push(...sessionIds);
    } else if (keyset.sql) {
      where.push(keyset.sql);
      params.push(...keyset.params);
    }
    if (!isOpenScope && search.sql) {
      where.push(search.sql);
      params.push(...search.params);
    }

    const rows = this.db.prepare(`
      SELECT ${HOME_SESSION_SUMMARY_SELECT_COLUMNS}
      FROM sessions_v6 AS s
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY s.last_active_at DESC, s.id DESC
      LIMIT ?
    `).all(...params, parsed.limit + 1) as HomeSessionSummaryV6Row[];
    const visibleRows = rows.slice(0, parsed.limit);
    const entries = cloneHomeSessionSummaries(
      visibleRows
        .map((row) => this.rowToHomeSessionSummary(row))
        .filter((summary): summary is HomeSessionSummary => summary !== null),
    );
    const hasMore = parsed.scope !== "open" && rows.length > parsed.limit;
    const lastRow = visibleRows.at(-1);

    return {
      entries,
      hasMore,
      nextCursor: hasMore && lastRow && parsed.scope !== "open"
        ? encodeSessionSummaryCursor(parsed.scope, lastRow.last_active_at, lastRow.id, parsed.searchText)
        : null,
    };
  }

  listSessionCharacterUsage(): SessionCharacterUsage[] {
    const characterIdExpression = `COALESCE(
      NULLIF(TRIM(s.character_id), ''),
      NULLIF(TRIM(CASE WHEN json_valid(s.runtime_policy_json) THEN json_extract(s.runtime_policy_json, '$.characterId') ELSE '' END), '')
    )`;
    const newerCharacterIdExpression = `COALESCE(
      NULLIF(TRIM(newer.character_id), ''),
      NULLIF(TRIM(CASE WHEN json_valid(newer.runtime_policy_json) THEN json_extract(newer.runtime_policy_json, '$.characterId') ELSE '' END), '')
    )`;
    const rows = this.db.prepare(`
      SELECT
        ${characterIdExpression} AS character_id
      FROM sessions_v6 AS s
      WHERE s.session_kind = 'default'
        AND ${characterIdExpression} IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM sessions_v6 AS newer
            WHERE newer.session_kind = 'default'
            AND ${newerCharacterIdExpression} = ${characterIdExpression}
            AND (
              newer.last_active_at > s.last_active_at
              OR (newer.last_active_at = s.last_active_at AND newer.id > s.id)
            )
        )
      ORDER BY s.last_active_at DESC, s.id DESC
    `).all() as SessionCharacterUsageRow[];

    return rows
      .map((row) => recoverStoredCharacterOwnerId(normalizeCharacterOwnerId(row.character_id)))
      .filter((characterId): characterId is string => Boolean(characterId))
      .map((characterId) => ({ characterId, sessionKind: "default" as const }));
  }

  getLatestSessionSummaryForProvider(providerId: string): SessionSummary | null {
    const normalizedProviderId = providerId.trim();
    if (!normalizedProviderId) {
      return null;
    }
    const row = this.db.prepare(`
      SELECT *
      FROM sessions_v6
      WHERE ${SESSION_PROVIDER_ID_NORMALIZER_SQL_FUNCTION}(provider_id) = ?
      ORDER BY last_active_at DESC, id DESC
      LIMIT 1
    `).get(normalizeProviderId(normalizedProviderId)) as SessionV6Row | undefined;
    return row ? this.rowToSessionSummary(row) : null;
  }

  getSession(sessionId: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions_v6 WHERE id = ?").get(sessionId) as SessionV6Row | undefined;
    return row ? this.rowToSession(row) : null;
  }

  setSessionPinned(sessionId: string, isPinned: boolean): SessionSummary {
    this.db.prepare("UPDATE sessions_v6 SET is_pinned = ? WHERE id = ?").run(isPinned ? 1 : 0, sessionId);
    const row = this.db.prepare("SELECT * FROM sessions_v6 WHERE id = ?").get(sessionId) as SessionV6Row | undefined;
    if (!row) {
      throw new Error("対象セッションが見つからないよ。");
    }
    return this.rowToSessionSummary(row);
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
    return this.storeSession(session, "upsert");
  }

  upsertTerminalSession(session: Session, terminalCommit: SessionTurnTerminalCommit): Session {
    return this.storeSession(session, "upsert", terminalCommit);
  }

  insertSession(session: Session): Session {
    return this.storeSession(session, "create");
  }

  private storeSession(
    session: Session,
    operation: "create" | "upsert",
    terminalCommit?: SessionTurnTerminalCommit,
  ): Session {
    const normalized = normalizeSessionForStorage(session);
    if (terminalCommit && terminalCommit.sessionId !== normalized.id) {
      throw new Error("terminal Session と audit marker の owner が一致しないよ。");
    }

    const startedAt = Date.now();
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.writeSession(normalized, operation);
      if (terminalCommit) {
        writeSessionTurnTerminalCommit(this.db, terminalCommit);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      logSessionRunStuckInvestigation(`storage-v6.${operation}-session.failed`, {
        sessionId: normalized.id,
        durationMs: Date.now() - startedAt,
        messageCount: normalized.messages.length,
        runState: normalized.runState,
        status: normalized.status,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    let stored = normalized;
    try {
      stored = this.getSession(normalized.id) ?? normalized;
    } catch (error) {
      console.warn("Committed Session read-back failed", error);
    }
    logSessionRunStuckInvestigation(`storage-v6.${operation}-session.done`, {
      sessionId: normalized.id,
      durationMs: Date.now() - startedAt,
      messageCount: normalized.messages.length,
      runState: normalized.runState,
      status: normalized.status,
      storedRunState: stored.runState,
      storedStatus: stored.status,
    });
    return stored;
  }

  replaceSessions(nextSessions: Session[]): Session[] {
    const normalizedSessions = nextSessions.map((session) => normalizeSessionForStorage(session));

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const retainedSessionIds = normalizedSessions.map((session) => session.id);
      const removedSessionIds = this.listStoredSessionIdsExcept(retainedSessionIds);
      const removedAuxiliarySessionIds = this.listAuxiliarySessionIdsWithoutValidParents(retainedSessionIds);
      deleteAuditEventsForSessionTargets(this.db, {
        sessionIds: removedSessionIds,
        auxiliarySessionIds: removedAuxiliarySessionIds,
      });
      this.db.exec("DELETE FROM session_messages_v6;");
      this.deleteStoredSessionsByIds(removedSessionIds);
      for (const session of normalizedSessions) {
        this.writeSession(session);
      }
      this.deleteAuxiliarySessionsByIdsIfTableExists(removedAuxiliarySessionIds);
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
      const auxiliarySessionIds = this.listAuxiliarySessionIdsForParentsIfTableExists(uniqueSessionIds);
      deleteAuditEventsForSessionTargets(this.db, {
        sessionIds: uniqueSessionIds,
        auxiliarySessionIds,
      });
      this.db.prepare(`DELETE FROM sessions_v6 WHERE id IN (${placeholders})`).run(...uniqueSessionIds);
      this.deleteAuxiliarySessionsForParentsIfTableExists(uniqueSessionIds);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  clearSessions(): void {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      deleteAuditEventsForSessionTargets(this.db, { allSessionTargets: true });
      this.db.exec("DELETE FROM session_messages_v6;");
      this.db.exec("DELETE FROM sessions_v6;");
      this.deleteAllAuxiliarySessionsIfTableExists();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private writeSession(session: Session, operation: "create" | "upsert" = "upsert"): void {
    const startedAt = Date.now();
    const snapshot = session.characterRuntimeSnapshot;
    const runtimePolicy = {
      appStatus: session.status,
      runState: session.runState,
      workspaceLabel: session.workspaceLabel,
      branch: session.branch,
      accessMode: session.accessMode,
      sourceSchemaVersion: session.sourceSchemaVersion,
      characterId: session.characterId,
      characterName: session.character,
      characterIconPath: session.characterIconPath,
      characterThemeColors: session.characterThemeColors,
    };
    const conflictClause = operation === "create"
      ? "ON CONFLICT(id) DO NOTHING"
      : `
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
      `;
    const result = this.db.prepare(`
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
        is_pinned,
        created_at,
        updated_at,
        last_active_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ${conflictClause}
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
      session.isPinned === true ? 1 : 0,
      session.updatedAt,
      session.updatedAt,
      session.updatedAt,
    );
    if (operation === "create" && Number(result.changes) === 0) {
      throw new SessionIdCollisionError(session.id);
    }

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
    logSessionRunStuckInvestigation("storage-v6.write-session.done", {
      sessionId: session.id,
      durationMs: Date.now() - startedAt,
      messageCount: session.messages.length,
      existingArtifactBodyCount: existingArtifactBodies.size,
      runState: session.runState,
      status: session.status,
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

  private rowToSessionSummary(
    row: SessionV6Row,
    decoded = decodeSessionV6RuntimeState(row),
  ): SessionSummary {
    const { runtimePolicy, snapshot } = decoded;
    const summary = normalizeSessionSummary({
      id: row.id,
      taskTitle: row.title,
      status: typeof runtimePolicy.appStatus === "string" ? runtimePolicy.appStatus : row.state === "active" ? "running" : "idle",
      updatedAt: row.updated_at || row.last_active_at,
      isPinned: row.is_pinned === 1,
      provider: row.provider_id,
      catalogRevision: row.catalog_revision,
      workspaceLabel: runtimePolicy.workspaceLabel,
      workspacePath: row.workspace_path,
      branch: runtimePolicy.branch,
      sessionKind: row.session_kind,
      accessMode: runtimePolicy.accessMode,
      sourceSchemaVersion: runtimePolicy.sourceSchemaVersion ?? CURRENT_SESSION_SCHEMA_VERSION,
      characterId: decoded.characterId,
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
      threadId: decoded.threadId,
    });
    if (!summary) {
      throw new Error(`V6 session row を summary に変換できないよ: ${row.id}`);
    }
    return summary;
  }

  private rowToHomeSessionSummary(row: HomeSessionSummaryV6Row): HomeSessionSummary | null {
    return normalizeHomeSessionSummary({
      id: row.id,
      taskTitle: row.task_title,
      status: row.status,
      updatedAt: row.updated_at,
      isPinned: row.is_pinned === 1,
      workspaceLabel: row.workspace_label,
      workspacePath: row.workspace_path,
      sessionKind: row.session_kind,
      accessMode: row.access_mode,
      sourceSchemaVersion: row.source_schema_version,
      characterId: row.character_id,
      character: row.character_name,
      characterIconPath: row.character_icon_path,
      characterThemeColors: {
        main: row.character_theme_main,
        sub: row.character_theme_sub,
      },
      runState: row.run_state,
    });
  }

  private rowToSession(row: SessionV6Row): Session {
    const decoded = decodeSessionV6RuntimeState(row);
    const summary = this.rowToSessionSummary(row, decoded);
    const messageRows = this.db.prepare(`
      SELECT role, body
      FROM session_messages_v6
      WHERE session_id = ?
      ORDER BY seq ASC
    `).all(row.id) as MessageV6Row[];
    const session = normalizeSession({
      ...summary,
      characterRuntimeSnapshot: decoded.snapshot,
      messages: messageRows.map((messageRow) => decodeMessage(messageRow)).filter((message): message is Message => message !== null),
      stream: [],
    });
    if (!session) {
      throw new Error(`V6 session row を session に変換できないよ: ${row.id}`);
    }
    return session;
  }

  private auxiliarySessionsTableExists(): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table'
        AND name = ?
    `).get(AUXILIARY_SESSIONS_TABLE_NAME));
  }

  private listStoredSessionIdsExcept(retainedSessionIds: Iterable<string>): string[] {
    const retained = new Set(Array.from(retainedSessionIds).map((sessionId) => sessionId.trim()).filter(Boolean));
    const rows = this.db.prepare("SELECT id FROM sessions_v6").all() as SessionIdRow[];
    return rows.map((row) => row.id).filter((id) => !retained.has(id));
  }

  private deleteStoredSessionsByIds(sessionIds: readonly string[]): void {
    const uniqueSessionIds = Array.from(new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)));
    if (uniqueSessionIds.length === 0) {
      return;
    }

    const placeholders = uniqueSessionIds.map(() => "?").join(", ");
    this.db.prepare(`DELETE FROM sessions_v6 WHERE id IN (${placeholders})`).run(...uniqueSessionIds);
  }

  private listAuxiliarySessionIdsForParentsIfTableExists(parentSessionIds: readonly string[]): string[] {
    if (!this.auxiliarySessionsTableExists()) {
      return [];
    }

    const uniqueParentIds = Array.from(new Set(parentSessionIds.map((parentSessionId) => parentSessionId.trim()).filter(Boolean)));
    if (uniqueParentIds.length === 0) {
      return [];
    }

    const placeholders = uniqueParentIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT id
      FROM auxiliary_sessions
      WHERE parent_session_id IN (${placeholders})
    `).all(...uniqueParentIds) as SessionIdRow[];
    return rows.map((row) => row.id).filter((id) => id.trim().length > 0);
  }

  private deleteAuxiliarySessionsForParentsIfTableExists(parentSessionIds: readonly string[]): void {
    if (!this.auxiliarySessionsTableExists()) {
      return;
    }

    const uniqueParentIds = Array.from(new Set(parentSessionIds.map((parentSessionId) => parentSessionId.trim()).filter(Boolean)));
    if (uniqueParentIds.length === 0) {
      return;
    }

    const placeholders = uniqueParentIds.map(() => "?").join(", ");
    this.db.prepare(`DELETE FROM auxiliary_sessions WHERE parent_session_id IN (${placeholders})`).run(...uniqueParentIds);
  }

  private deleteAuxiliarySessionsByIdsIfTableExists(auxiliarySessionIds: readonly string[]): void {
    if (!this.auxiliarySessionsTableExists()) {
      return;
    }

    const uniqueAuxiliarySessionIds = Array.from(new Set(auxiliarySessionIds.map((auxiliarySessionId) => auxiliarySessionId.trim()).filter(Boolean)));
    if (uniqueAuxiliarySessionIds.length === 0) {
      return;
    }

    const placeholders = uniqueAuxiliarySessionIds.map(() => "?").join(", ");
    this.db.prepare(`DELETE FROM auxiliary_sessions WHERE id IN (${placeholders})`).run(...uniqueAuxiliarySessionIds);
  }

  private deleteAllAuxiliarySessionsIfTableExists(): void {
    if (!this.auxiliarySessionsTableExists()) {
      return;
    }

    this.db.prepare("DELETE FROM auxiliary_sessions").run();
  }

  private companionSessionsTableExists(): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table'
        AND name = ?
    `).get(COMPANION_SESSIONS_TABLE_NAME));
  }

  private listRetainedCompanionSessionIds(): string[] {
    if (!this.companionSessionsTableExists()) {
      return [];
    }

    const rows = this.db
      .prepare("SELECT id FROM companion_sessions WHERE status NOT IN ('merged', 'discarded')")
      .all() as SessionIdRow[];
    return rows.map((row) => row.id).filter((id) => id.trim().length > 0);
  }

  private listAuxiliarySessionIdsWithoutValidParents(retainedParentSessionIds: Iterable<string>): string[] {
    if (!this.auxiliarySessionsTableExists()) {
      return [];
    }

    const validParentSessionIds = Array.from(new Set([
      ...retainedParentSessionIds,
      ...this.listRetainedCompanionSessionIds(),
    ]));
    if (validParentSessionIds.length === 0) {
      const rows = this.db.prepare("SELECT id FROM auxiliary_sessions").all() as SessionIdRow[];
      return rows.map((row) => row.id).filter((id) => id.trim().length > 0);
    }

    const placeholders = validParentSessionIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT id
      FROM auxiliary_sessions
      WHERE parent_session_id NOT IN (${placeholders})
    `).all(...validParentSessionIds) as SessionIdRow[];
    return rows.map((row) => row.id).filter((id) => id.trim().length > 0);
  }
}
