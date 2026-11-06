import type { DatabaseSync } from "node:sqlite";
import { assertFullConversation, conversationMessageColumns, readConversationPage, readConversationQuerySnapshot, readConversationQueryBatch, type ConversationMutationSink } from "../storage/conversation-query.js";
import { withMessageRunFailure } from "../../src-shared/session/message-run-failure.js";
import type { ConversationPageRequest } from "../../src-shared/session/conversation-page.js";
import type { SessionHistoryReadInput, SessionHistoryResult } from "../../src-shared/session-history/session-history-contract.js";
import { readSessionHistory, checkSessionHistorySource } from "../storage/session-history-read.js";
import { assertSessionHistoryReadScope, type SessionHistoryReadScope } from "../../src-shared/session/session-history-read-scope.js";
import type { BackgroundSourceRef, BackgroundSourceSnapshot, CapturedBackgroundSource } from "../../src-shared/session/background-source-snapshot.js";
import { assertRuntimeTurnAdmission } from "../platform/memory/runtime-turn-admission.js";
import type { SessionFilePinOwner, SessionFilePinReference, StoredSessionFilePin } from "../../src-shared/file-explorer/file-explorer-contract.js";
import { randomUUID } from "node:crypto";
import { assertChildSessionRole, assertSessionRole, normalizeSessionRelationship } from "../../src-shared/session/session-role.js";
import { validateSessionMetadataPatch, type SessionMetadataPatch } from "../../src-shared/session/session-metadata.js";
import { beginSessionLifecycleOperation, readSessionLifecycleOperation, type SessionLifecycleOperation } from "./session-lifecycle-operation.js";
import { listCrewCoordinationBlockers } from "../coordination/coordination-schema-v7.js";
import type { CrewDeletionBlocker, CrewDeletionStatus } from "../../src-shared/session/session-crew-deletion.js";

import {
  cloneHomeSessionSummaries,
  cloneSessionSummaries,
  cloneSessions,
  CURRENT_SESSION_SCHEMA_VERSION,
  getSessionIncarnationId,
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
} from "../../src-shared/session/session-state.js";
import { normalizeProviderId } from "../../src-shared/settings/model-catalog.js";
import {
  parseCharacterRuntimeSnapshotJson,
  stringifyCharacterRuntimeSnapshot,
} from "../../src-shared/character/character-runtime-snapshot.js";
import {
  UNKNOWN_CHARACTER_OWNER_ID,
  isUnknownCharacterOwnerId,
  normalizeCharacterOwnerId,
  recoverStoredCharacterOwnerId,
} from "../../src-shared/character/character-owner.js";
import {
  registerSessionProviderIdNormalizer,
  SESSION_PROVIDER_ID_NORMALIZER_SQL_FUNCTION,
} from "./session-provider-id-sql.js";
import { deleteSessionTurnsForTargets, insertSessionTurn } from "./session-turn-storage-v6.js";
import type { SessionTurnQueueCapturedInput } from "../../src-shared/session/session-turn-queue.js";
import type { SessionTurnRecord } from "../../src-shared/session/session-turn-state.js";
import { ensureV6Schema } from "../storage/database-schema-v6.js";
import { openAppDatabase } from "../storage/sqlite-connection.js";
import {
  SessionIdCollisionError,
  SessionNotFoundError,
  SessionRunningTurnStartConflictError,
  SessionCrewDeletionBlockedError,
} from "./session-storage-errors.js";
import {
  buildSessionSummaryKeysetClause,
  buildSessionSummarySearchClause,
  decodeSessionSummaryCursor,
  encodeSessionSummaryCursor,
  parseSessionSummaryPageRequest,
} from "./session-summary-query.js";
import type { DeleteSessionsLastActiveBeforeCutoff } from "../../src-shared/window/withmate-window-types.js";
import {
  writeSessionTurnTerminalCommit,
  type SessionTurnTerminalCommit,
} from "./session-turn-terminal-commit.js";
import type {
  SessionCharacterAuthoringRuntimeClearInput,
  SessionCharacterAuthoringRuntimeClearResult,
  SessionRunningTurnStartInput,
  SessionRunningTurnStartResult,
} from "./session-running-turn-start.js";
import { assertCharacterDefinitionSnapshotUpdate } from "./session-running-turn-start.js";
import type { ProviderRuntimeMetadataPatch } from "../providers/provider-runtime-metadata-patch.js";
import type { SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type {
  SessionMetadataResult, SessionMessageIdentityInput, SessionMessageIdentity,
  SessionSteerAppendInput, SessionSteerBeginInput, SessionSteerSettleInput, SessionTerminalAppendInput,
  SessionRunMetadataCheckpointInput,
} from "./session-runtime-storage-contract.js";

type SessionV6Row = {
  id: string;
  incarnation_id: string;
  title: string;
  description: string;
  session_role: string;
  root_session_id: string;
  parent_session_id: string | null;
  created_by_session_id: string | null;
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
  runFailure?: string | null;
};

type ExistingMessageArtifactRow = {
  seq: number;
  role: Message["role"];
  body: string;
  artifact_body: string | null;
  runFailure?: string | null;
};

type SessionIdRow = {
  id: string;
  incarnation_id?: string;
};

type SessionMessageSequenceRow = {
  seq: number;
};

type SessionCharacterUsageRow = {
  character_id: string | null;
};

export type SessionThreadPatchInput = {
  sessionId: string;
  incarnationId: string;
  provider: string;
  expectedThreadId: string;
  nextThreadId: string;
  updatedAt: string;
};

export type SessionRuntimeMetadataPatchInput = ProviderRuntimeMetadataPatch & {
  sessionId: string;
  incarnationId: string;
};

export type SessionThreadPatchResult = Pick<Session, "id" | "threadId" | "updatedAt">;
export type SessionRuntimeMetadataPatchResult = Pick<Session, "id" | "provider" | "catalogRevision" | "model" | "reasoningEffort" | "threadId" | "updatedAt">;
export type SessionCredentialThreadInfo = Pick<Session, "id" | "provider" | "threadId" | "status" | "runState"> & { incarnationId: string };

type DecodedSessionV6RuntimeState = {
  runtimePolicy: Record<string, unknown>;
  characterId: string;
  snapshot: ReturnType<typeof parseCharacterRuntimeSnapshotJson>;
  threadId: string;
};

const AUXILIARY_SESSIONS_TABLE_NAME = "auxiliary_sessions";

function readySessionClause(idExpression: string): string {
  return `NOT EXISTS (SELECT 1 FROM session_lifecycle_operations_v6 operation, json_each(operation.targets_json) target
    WHERE operation.kind = 'create' AND operation.phase <> 'complete' AND json_extract(target.value, '$.id') = ${idExpression})`;
}

const SESSION_RUN_STUCK_INVESTIGATION_LOG = "[investigate:session-run-stuck]";

// Match decodeMessage's retained rows without hydrating every message or artifact.
const NORMALIZED_MESSAGE_PREDICATE = `(CASE WHEN role IN ('user', 'assistant') THEN 1
  WHEN json_valid(body) THEN
    json_type(body) = 'object' AND json_extract(body, '$.role') IN ('user', 'assistant')
  ELSE 0 END)`;

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
const V6_HOME_CHARACTER_NAME_EXPRESSION = `CASE WHEN ${V6_HOME_SNAPSHOT_MATCH_EXPRESSION} = 1
  THEN ${v6SnapshotJsonValue("$.name")}
  ELSE ${v6RuntimeJsonValue("$.characterName")}
END`;
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
  ${V6_HOME_CHARACTER_NAME_EXPRESSION} AS character_name,
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
    throw new Error("The Session data cannot be saved because it is invalid.");
  }

  const normalized = normalizeSession(session);
  if (!normalized) {
    throw new Error("The Session data cannot be saved because it is invalid.");
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
  if (value === null || value === undefined) {
    return null;
  }
  const artifact: unknown = JSON.parse(value);
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new Error("Stored message artifact must be a JSON object.");
  }
  const normalized = normalizeMessage({
    role: "assistant",
    text: "",
    artifact,
  })?.artifact;
  if (!normalized) {
    throw new Error("Stored message artifact could not be normalized.");
  }
  return normalized;
}

function decodeMessage(row: MessageV6Row): Message | null {
  const parsed = normalizeMessage(parseJsonObject(row.body));
  if (parsed) {
    return withMessageRunFailure(parsed, row.runFailure);
  }
  if (row.role === "user" || row.role === "assistant") {
    return { role: row.role, text: row.body };
  }
  return null;
}

export class SessionStorageV6 {
  private readonly db: DatabaseSync;

  constructor(dbPath: string, private readonly onConversationChanged: ConversationMutationSink = () => {}) {
    this.db = openAppDatabase(dbPath);
    registerSessionProviderIdNormalizer(this.db);
    ensureV6Schema(this.db);
    this.ensureSchema();
  }

  listSessions(): Session[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM sessions_v6
      WHERE ${readySessionClause("sessions_v6.id")}
      ORDER BY last_active_at DESC, id DESC
    `).all() as SessionV6Row[];
    return cloneSessions(rows.map((row) => this.rowToSession(row)));
  }

  private assertFilePinOwner(owner: SessionFilePinOwner): void {
    if (!this.db.prepare("SELECT 1 FROM sessions_v6 WHERE id = ? AND incarnation_id = ?").get(owner.sessionId, owner.incarnationId)) {
      throw new Error("The File Pin owner session is no longer available.");
    }
  }

  listSessionFilePins(owner: SessionFilePinOwner): StoredSessionFilePin[] {
    this.assertFilePinOwner(owner);
    return this.db.prepare(`SELECT root_kind AS rootKind, root_path AS rootPath,
      relative_path AS relativePath, kind, root_label AS rootLabel
      FROM session_file_pins_v6 WHERE session_id = ? ORDER BY root_kind, root_path, relative_path
    `).all(owner.sessionId) as StoredSessionFilePin[];
  }

  pinSessionFile(owner: SessionFilePinOwner, pin: StoredSessionFilePin): void {
    this.assertFilePinOwner(owner);
    this.db.prepare(`INSERT INTO session_file_pins_v6
      (session_id, root_kind, root_path, relative_path, relative_path_key, kind, root_label) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id, root_kind, root_path, relative_path_key)
      DO UPDATE SET kind = excluded.kind, root_label = excluded.root_label, relative_path = excluded.relative_path
    `).run(owner.sessionId, pin.rootKind, pin.rootPath, pin.relativePath,
      process.platform === "win32" ? pin.relativePath.toLocaleLowerCase("en-US") : pin.relativePath, pin.kind, pin.rootLabel);
  }

  unpinSessionFile(owner: SessionFilePinOwner, pin: SessionFilePinReference): void {
    this.assertFilePinOwner(owner);
    this.db.prepare(`DELETE FROM session_file_pins_v6 WHERE session_id = ?
      AND root_kind = ? AND root_path = ? AND relative_path_key = ?
    `).run(owner.sessionId, pin.rootKind, pin.rootPath,
      process.platform === "win32" ? pin.relativePath.toLocaleLowerCase("en-US") : pin.relativePath);
  }

  listSessionSummaries(): SessionSummary[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM sessions_v6
      WHERE ${readySessionClause("sessions_v6.id")}
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
    const search = buildSessionSummarySearchClause("s", parsed.searchText, V6_HOME_CHARACTER_NAME_EXPRESSION);
    const keyset = buildSessionSummaryKeysetClause("s", cursor);
    const where: string[] = [readySessionClause("s.id")];
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
    const rows = this.db.prepare(`
      SELECT
        ${characterIdExpression} AS character_id
      FROM sessions_v6 AS s
      WHERE s.session_kind = 'default'
        AND ${characterIdExpression} IS NOT NULL
      ORDER BY s.last_active_at DESC, s.id DESC
    `).iterate() as Iterable<SessionCharacterUsageRow>;

    const seenCharacterIds = new Set<string | null>();
    const usage: SessionCharacterUsage[] = [];
    for (const row of rows) {
      // Deduplicate SQL IDs before owner recovery, which has different whitespace rules.
      if (seenCharacterIds.has(row.character_id)) {
        continue;
      }
      seenCharacterIds.add(row.character_id);
      const characterId = recoverStoredCharacterOwnerId(normalizeCharacterOwnerId(row.character_id));
      if (characterId) {
        usage.push({ characterId, sessionKind: "default" });
      }
    }
    return usage;
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

  getConversationPage(sessionId: string, request?: ConversationPageRequest) {
    const row = this.db.prepare("SELECT * FROM sessions_v6 WHERE id = ?").get(sessionId) as SessionV6Row | undefined;
    return row ? readConversationPage(this.db, "session_messages_v6", sessionId, row.incarnation_id?.trim() || `legacy:${sessionId}`, request) : null;
  }

  getSessionView(sessionId: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions_v6 WHERE id = ?").get(sessionId) as SessionV6Row | undefined;
    if (!row) return null;
    const page = readConversationPage(this.db, "session_messages_v6", sessionId, row.incarnation_id?.trim() || `legacy:${sessionId}`);
    const decoded = decodeSessionV6RuntimeState(row);
    const session = normalizeSession({ ...this.rowToSessionSummary(row, decoded), characterRuntimeSnapshot: decoded.snapshot, messages: page.messages, stream: [] });
    if (!session) throw new Error(`The V6 Session row could not be converted: ${sessionId}`);
    const latestUserRow = this.db.prepare("SELECT seq, role, body FROM session_messages_v6 WHERE session_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1").get(sessionId) as (MessageV6Row & { seq: number }) | undefined;
    const latestUser = latestUserRow ? decodeMessage(latestUserRow) : null;
    return { ...session, messages: page.messages, messageCount: page.totalCount, latestUserMessage: latestUser && latestUserRow ? { ...latestUser, historyIndex: latestUserRow.seq } : null };
  }

  getConversationQuerySnapshot(sessionId: string) {
    return readConversationQuerySnapshot(this.db, "session_messages_v6", sessionId);
  }

  readConversationQueryBatch(sessionId: string, afterSeq: number) {
    return readConversationQueryBatch(this.db, "session_messages_v6", sessionId, afterSeq);
  }

  readSessionHistory(input: SessionHistoryReadInput): SessionHistoryResult {
    if (input.scope.source.kind !== "main") throw new Error("Main history reads require a main source.");
    return readSessionHistory(this.db, input);
  }

  captureBackgroundSource(ref: BackgroundSourceRef): CapturedBackgroundSource | null {
    assertRuntimeTurnAdmission();
    const table = ref.kind === "main" ? "session_messages_v6" : "auxiliary_session_messages";
    const owner = ref.kind === "main" ? "session_id" : "auxiliary_session_id";
    const current = readConversationQuerySnapshot(this.db, table, ref.sessionId);
    if (!current || current.incarnationId !== ref.incarnationId) return null;
    const last = this.db.prepare(`SELECT MAX(seq) AS seq FROM ${table} WHERE ${owner} = ?`).get(ref.sessionId) as { seq: number | null };
    if (last.seq === null) return null;
    const history: SessionHistoryReadScope = { source: { ...ref, ownerIdentity: current.ownerIdentity }, fromMessageSeq: 0, throughMessageSeq: last.seq };
    const snapshot = this.readBackgroundSource(history);
    return snapshot ? { history, snapshot } : null;
  }

  readBackgroundSource(scope: SessionHistoryReadScope): BackgroundSourceSnapshot | null {
    assertRuntimeTurnAdmission();
    assertSessionHistoryReadScope(scope);
    if (checkSessionHistorySource(this.db, scope.source)) return null;
    const auxiliary = scope.source.kind === "auxiliary";
    const table = auxiliary ? "auxiliary_session_messages" : "session_messages_v6";
    const owner = auxiliary ? "auxiliary_session_id" : "session_id";
    const last = this.db.prepare(`SELECT MAX(seq) AS seq FROM ${table} WHERE ${owner} = ?`)
      .get(scope.source.sessionId) as { seq: number | null };
    if (last.seq === null || last.seq < scope.throughMessageSeq) return null;
    const parentId = scope.source.kind === "auxiliary" ? scope.source.parent.sessionId : scope.source.sessionId;
    const session = this.getSessionSummary(parentId)!;
    const aux = auxiliary ? this.db.prepare("SELECT character_id FROM auxiliary_sessions WHERE id = ?")
      .get(scope.source.sessionId) as { character_id: string | null } : null;
    const rows = this.db.prepare(`SELECT id, session_id, phase, completed_at, assistant_message_seq
      FROM session_turns_v6 WHERE ${owner} = ? AND assistant_message_seq BETWEEN ? AND ? ORDER BY id`)
      .all(scope.source.sessionId, scope.fromMessageSeq, scope.throughMessageSeq) as {
        id: number; session_id: string | null; phase: SessionTurnRecord["phase"];
        completed_at: string | null; assistant_message_seq: number;
      }[];
    const result: BackgroundSourceSnapshot = {
      session: { id: scope.source.sessionId, incarnationId: scope.source.incarnationId, characterId: aux ? recoverStoredCharacterOwnerId(aux.character_id) : session.characterId,
        accessMode: session.accessMode, sourceSchemaVersion: session.sourceSchemaVersion, sessionKind: session.sessionKind },
      ownerIdentity: scope.source.ownerIdentity,
      turns: rows.map((row) => ({ id: row.id, sessionId: row.session_id, ...(auxiliary ? { auxiliarySessionId: scope.source.sessionId } : {}), phase: row.phase,
        ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}), assistantMessageSeq: row.assistant_message_seq })),
    };
    assertRuntimeTurnAdmission();
    return result;
  }

  getSessionSummary(sessionId: string): SessionSummary | null {
    const row = this.db.prepare(`
      SELECT id, incarnation_id, title, description, session_role, root_session_id, parent_session_id, created_by_session_id, state, session_kind, provider_id,
        catalog_revision, model_id, reasoning_effort, custom_agent_name,
        approval_mode, codex_sandbox_mode, allowed_additional_directories_json,
        runtime_policy_json, thread_id, character_id, character_snapshot_json,
        workspace_path, is_pinned, updated_at, last_active_at
      FROM sessions_v6
      WHERE id = ?
    `).get(sessionId) as SessionV6Row | undefined;
    return row ? this.rowToSessionSummary(row) : null;
  }

  getSessionMetadata(sessionId: string): SessionMetadataResult | null {
    const row = this.db.prepare("SELECT * FROM sessions_v6 WHERE id = ?").get(sessionId) as SessionV6Row | undefined;
    return row ? this.rowToSessionMetadata(row) : null;
  }

  getSessionMessageIdentity(input: SessionMessageIdentityInput): SessionMessageIdentity | null {
    if (!Number.isSafeInteger(input.messageIndex) || input.messageIndex < 0) throw new Error("The message index is invalid.");
    const row = this.db.prepare(`
      SELECT seq, role, body FROM session_messages_v6
      WHERE session_id = ? AND ${NORMALIZED_MESSAGE_PREDICATE}
        AND EXISTS (SELECT 1 FROM sessions_v6 WHERE id = ? AND incarnation_id = ?)
      ORDER BY seq LIMIT 1 OFFSET ?
    `).get(input.sessionId, input.sessionId, input.incarnationId, input.messageIndex) as (MessageV6Row & { seq: number }) | undefined;
    const message = row ? decodeMessage(row) : null;
    return message && row ? { role: message.role, text: message.text, historyIndex: row.seq } : null;
  }

  private normalizedMessageCount(sessionId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS count FROM session_messages_v6
      WHERE session_id = ? AND ${NORMALIZED_MESSAGE_PREDICATE}`).get(sessionId) as { count: number }).count;
  }

  private rowToSessionMetadata(row: SessionV6Row): SessionMetadataResult {
    const decoded = decodeSessionV6RuntimeState(row);
    return {
      summary: this.rowToSessionSummary(row, decoded),
      characterRuntimeSnapshot: decoded.snapshot,
      messageCount: this.normalizedMessageCount(row.id),
    };
  }

  private assertAppendOwner(input: { sessionId: string; incarnationId: string; expectedMessageCount: number }, turnId: number): SessionV6Row {
    if (!input.sessionId.trim() || !Number.isSafeInteger(input.expectedMessageCount) || input.expectedMessageCount < 0
      || !Number.isSafeInteger(turnId) || turnId < 1) throw new Error("The Session append owner is invalid.");
    const row = this.db.prepare("SELECT * FROM sessions_v6 WHERE id = ? AND incarnation_id = ?")
      .get(input.sessionId, input.incarnationId) as SessionV6Row | undefined;
    if (!row) throw new SessionNotFoundError(input.sessionId);
    const summary = this.rowToSessionSummary(row);
    if (summary.accessMode !== "active") throw new Error("The Session is read-only.");
    if (!this.db.prepare(`SELECT 1 FROM session_turns_v6 WHERE id = ? AND session_id = ?
      AND auxiliary_session_id IS NULL AND phase = 'running'`).get(turnId, input.sessionId)) {
      throw new Error(`session turn append target mismatch: ${turnId}`);
    }
    const actual = this.normalizedMessageCount(input.sessionId);
    if (actual !== input.expectedMessageCount) throw new SessionRunningTurnStartConflictError(input.sessionId, input.expectedMessageCount, actual);
    const tail = this.db.prepare("SELECT MAX(seq) AS seq FROM session_messages_v6 WHERE session_id = ?")
      .get(input.sessionId) as { seq: number | null };
    const nextSeq = tail.seq === null ? 0 : tail.seq + 1;
    if (nextSeq !== input.expectedMessageCount) throw new SessionRunningTurnStartConflictError(input.sessionId, input.expectedMessageCount, nextSeq);
    return row;
  }

  private insertAppendedMessage(sessionId: string, message: Message, updatedAt: string): number {
    const tail = this.db.prepare("SELECT MAX(seq) AS seq FROM session_messages_v6 WHERE session_id = ?")
      .get(sessionId) as { seq: number | null };
    const seq = tail.seq === null ? 0 : tail.seq + 1;
    this.db.prepare(`INSERT INTO session_messages_v6 (session_id, seq, role, body, artifact_body, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(sessionId, seq, message.role, encodeMessage(message), encodeMessageArtifact(message), updatedAt);
    return seq;
  }

  appendSessionSteer(input: SessionSteerAppendInput): SessionMetadataResult {
    let message = normalizeMessage(input.userMessage);
    if (!message || message.role !== "user" || !message.text.trim() || !input.updatedAt.trim()) throw new Error("The steer message is invalid.");
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const row = this.assertAppendOwner(input, input.turnId);
      if (this.rowToSessionSummary(row).runState !== "running"
        || !this.db.prepare("SELECT 1 FROM session_turns_v6 WHERE id = ? AND id = (SELECT MAX(id) FROM session_turns_v6 WHERE session_id = ?)")
          .get(input.turnId, input.sessionId)) throw new Error("The current input turn no longer matches.");
      if (input.queuedInput) {
        const receipt = this.db.prepare(`SELECT dispatched_json AS captured_json FROM session_turn_queue_v6 WHERE id = ?
          AND session_id = ? AND auxiliary_session_id IS NULL AND incarnation_id = ?
          AND state = 'starting' AND input_turn_id = ? AND user_message_seq IS NULL AND turn_id = ? AND dispatched_json IS NOT NULL`)
          .get(input.queuedInput.queueId, input.sessionId, input.incarnationId, input.queuedInput.inputTurnId, String(input.turnId)) as { captured_json: string } | undefined;
        const captured = receipt ? JSON.parse(receipt.captured_json) as SessionTurnQueueCapturedInput : null;
        if (!captured || captured.request.userMessage !== message.text) {
          throw new Error("The queued input does not match its captured message.");
        }
        message = { ...message, turnInput: { turnId: String(input.turnId), nativeTurnId: input.queuedInput.inputTurnId,
          state: "confirmed", queueId: input.queuedInput.queueId, attachments: captured.attachments } };
      }
      this.insertAppendedMessage(input.sessionId, message, input.updatedAt);
      if (input.queuedInput) {
        const result = this.db.prepare(`UPDATE session_turn_queue_v6 SET state = 'completed', turn_id = ?,
          user_message_seq = ?, updated_at = ? WHERE id = ? AND state = 'starting' AND input_turn_id = ?`)
          .run(String(input.turnId), input.expectedMessageCount, input.updatedAt, input.queuedInput.queueId, input.queuedInput.inputTurnId);
        if (Number(result.changes) !== 1) throw new Error("The queued input could not be committed.");
      }
      this.db.prepare("UPDATE sessions_v6 SET updated_at = ?, last_active_at = ? WHERE id = ?")
        .run(input.updatedAt, input.updatedAt, input.sessionId);
      const result = this.rowToSessionMetadata({ ...row, updated_at: input.updatedAt, last_active_at: input.updatedAt });
      this.db.exec("COMMIT");
      this.onConversationChanged("session_messages_v6", input.sessionId);
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  beginSessionSteer(input: SessionSteerBeginInput): SessionMetadataResult {
    if (!input.nativeTurnId?.trim() || input.queuedInput) throw new Error("A direct Steer target is required.");
    return this.appendSessionSteer({ ...input, userMessage: { ...input.userMessage, turnInput: {
      turnId: String(input.turnId), nativeTurnId: input.nativeTurnId, state: "pending", attachments: input.attachments,
    } } });
  }

  settleSessionSteer(input: SessionSteerSettleInput): SessionMetadataResult {
    if (!["confirmed", "unknown", "not-sent"].includes(input.state) || !Number.isSafeInteger(input.messageSeq) || input.messageSeq < 0) throw new Error("The Steer settlement is invalid.");
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const owner = this.assertAppendOwner(input, input.turnId);
      const row = this.db.prepare("SELECT body FROM session_messages_v6 WHERE session_id = ? AND seq = ? AND role = 'user'")
        .get(input.sessionId, input.messageSeq) as { body: string } | undefined;
      const message = row ? normalizeMessage(JSON.parse(row.body)) : null;
      if (!message?.turnInput || message.turnInput.turnId !== String(input.turnId) || message.turnInput.queueId
        || (message.turnInput.state !== "pending" && message.turnInput.state !== input.state)) throw new Error("The pending Steer input no longer matches.");
      this.db.prepare("UPDATE session_messages_v6 SET body = ? WHERE session_id = ? AND seq = ?")
        .run(encodeMessage({ ...message, turnInput: { ...message.turnInput, state: input.state } }), input.sessionId, input.messageSeq);
      const result = this.rowToSessionMetadata(owner);
      this.db.exec("COMMIT");
      this.onConversationChanged("session_messages_v6", input.sessionId);
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  appendSessionTerminal(input: SessionTerminalAppendInput): SessionMetadataResult {
    const message = normalizeMessage(input.assistantMessage);
    const commit = input.terminalCommit;
    if (!message || message.role !== "assistant" || !input.metadata.updatedAt.trim()
      || !["idle", "saved"].includes(input.metadata.status)
      || commit.sessionId !== input.sessionId || commit.assistantMessageSeq !== input.expectedMessageCount) {
      throw new Error("The terminal Session append is invalid.");
    }
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const row = this.assertAppendOwner(input, commit.turnId);
      const seq = this.insertAppendedMessage(input.sessionId, message, input.metadata.updatedAt);
      const runtimePolicyJson = JSON.stringify({ ...parseJsonObject(row.runtime_policy_json),
        appStatus: input.metadata.status, runState: input.metadata.runState });
      this.db.prepare(`UPDATE sessions_v6 SET state = 'completed', runtime_policy_json = ?, thread_id = ?,
        updated_at = ?, last_active_at = ? WHERE id = ?`).run(runtimePolicyJson, input.metadata.threadId,
        input.metadata.updatedAt, input.metadata.updatedAt, input.sessionId);
      writeSessionTurnTerminalCommit(this.db, { ...commit, assistantMessageSeq: seq });
      const queueUpdate = this.db.prepare(`UPDATE session_turn_queue_v6
        SET state = ?, reason = ?, updated_at = ?
        WHERE session_id = ? AND auxiliary_session_id IS NULL AND input_turn_id IS NULL AND incarnation_id = ? AND turn_id = ? AND state = 'running'
          AND user_message_seq = (SELECT user_message_seq FROM session_turns_v6 WHERE id = ? AND session_id = ?)`)
        .run(commit.phase, commit.errorMessage || null, commit.completedAt, input.sessionId, input.incarnationId,
          String(commit.turnId), commit.turnId, input.sessionId);
      if (Number(queueUpdate.changes) === 0 && this.db.prepare(`SELECT 1 FROM session_turn_queue_v6
        WHERE session_id = ? AND auxiliary_session_id IS NULL AND input_turn_id IS NULL AND incarnation_id = ? AND turn_id = ? AND state = 'running'`)
        .get(input.sessionId, input.incarnationId, String(commit.turnId))) {
        throw new Error("The queued terminal receipt does not match its turn message sequence.");
      }
      const result = this.rowToSessionMetadata({ ...row, state: "completed", runtime_policy_json: runtimePolicyJson,
        thread_id: input.metadata.threadId, updated_at: input.metadata.updatedAt, last_active_at: input.metadata.updatedAt });
      this.db.exec("COMMIT");
      this.onConversationChanged("session_messages_v6", input.sessionId);
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  checkpointSessionRunMetadata(input: SessionRunMetadataCheckpointInput): SessionMetadataResult | null {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const row = this.db.prepare("SELECT * FROM sessions_v6 WHERE id = ? AND incarnation_id = ?")
        .get(input.sessionId, input.incarnationId) as SessionV6Row | undefined;
      if (!row) { this.db.exec("ROLLBACK"); return null; }
      const current = this.rowToSessionSummary(row);
      if (current.accessMode !== "active" || current.status !== input.expected.status
        || current.runState !== input.expected.runState || current.threadId !== input.expected.threadId) {
        this.db.exec("ROLLBACK"); return null;
      }
      if (!["running", "idle", "saved"].includes(input.next.status) || !input.next.updatedAt.trim()) {
        throw new Error("The Session run metadata is invalid.");
      }
      const policy = JSON.stringify({ ...parseJsonObject(row.runtime_policy_json), appStatus: input.next.status, runState: input.next.runState });
      const state = input.next.status === "running" ? "active" : "completed";
      this.db.prepare(`UPDATE sessions_v6 SET state = ?, runtime_policy_json = ?, thread_id = ?,
        updated_at = ?, last_active_at = ? WHERE id = ?`).run(state, policy, input.next.threadId,
        input.next.updatedAt, input.next.updatedAt, input.sessionId);
      const result = this.rowToSessionMetadata({ ...row, state, runtime_policy_json: policy, thread_id: input.next.threadId,
        updated_at: input.next.updatedAt, last_active_at: input.next.updatedAt });
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  listSessionCredentialThreads(): SessionCredentialThreadInfo[] {
    const rows = this.db.prepare(`
      SELECT id, incarnation_id, provider_id, thread_id, state, runtime_policy_json
      FROM sessions_v6
    `).all() as Array<Pick<SessionV6Row, "id" | "incarnation_id" | "provider_id" | "thread_id" | "state" | "runtime_policy_json">>;
    return rows.map((row) => {
      const policy = parseJsonObject(row.runtime_policy_json);
      return {
        id: row.id,
        incarnationId: row.incarnation_id?.trim() || `legacy:${row.id}`,
        provider: normalizeProviderId(row.provider_id),
        threadId: row.thread_id,
        status: policy.appStatus === "running" || policy.appStatus === "saved" || policy.appStatus === "idle"
          ? policy.appStatus : row.state === "active" ? "running" : "idle",
        runState: typeof policy.runState === "string" ? policy.runState : "idle",
      };
    });
  }

  setSessionTitle(sessionId: string, incarnationId: string, title: string): void {
    const result = this.db.prepare(`
      UPDATE sessions_v6 SET title = ?
      WHERE id = ? AND incarnation_id = ?
    `).run(title, sessionId, incarnationId);
    if (Number(result.changes) !== 1) throw new SessionNotFoundError(sessionId);
  }

  getSessionLifecycleOperation(operationId: string): SessionLifecycleOperation | null {
    return readSessionLifecycleOperation(this.db, operationId);
  }

  getCrewDeletionStatus(rootSessionId: string, incarnationId: string): CrewDeletionStatus {
    this.db.exec("BEGIN");
    try {
      const root = this.getSessionSummary(rootSessionId);
      if (!root || getSessionIncarnationId(root) !== incarnationId || root.parentSessionId) throw new Error("The Crew deletion root identity is invalid.");
      const ids = (this.db.prepare("SELECT id FROM sessions_v6 WHERE root_session_id = ?").all(rootSessionId) as Array<{ id: string }>).map((row) => row.id);
      const blockers = this.readCrewDeletionBlockers(ids, this.listAuxiliarySessionIdsForParentsIfTableExists(ids));
      this.db.exec("COMMIT");
      return { allowed: blockers.length === 0, blockers };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private readCrewDeletionBlockers(mainIds: string[], auxiliaryIds: string[]): CrewDeletionBlocker[] {
    if (mainIds.length === 0) return [];
    const placeholders = mainIds.map(() => "?").join(",");
    const blockers: CrewDeletionBlocker[] = [];
    for (const row of this.db.prepare(`SELECT id FROM sessions_v6 WHERE id IN (${placeholders}) AND state = 'active'`).all(...mainIds) as Array<{ id: string }>) {
      blockers.push({ kind: "running", id: row.id, sessionId: row.id, message: "A Main Session is running." });
    }
    for (const row of this.db.prepare(`SELECT id FROM auxiliary_sessions WHERE parent_session_id IN (${placeholders}) AND run_state = 'running'`).all(...mainIds) as Array<{ id: string }>) {
      blockers.push({ kind: "running", id: row.id, sessionId: row.id, message: "An Auxiliary Session is running." });
    }
    for (const row of this.db.prepare(`SELECT id, session_id FROM session_turn_queue_v6 WHERE session_id IN (${placeholders})
      AND (state IN ('queued','starting','running') OR (state='interrupted' AND released_at IS NULL))`).all(...mainIds) as Array<{ id: string; session_id: string }>) {
      blockers.push({ kind: "queue", id: row.id, sessionId: row.session_id, message: "Accepted work is pending, running, or unresolved." });
    }
    for (const row of this.db.prepare(`SELECT DISTINCT operation.operation_id FROM session_lifecycle_operations_v6 operation, json_each(operation.targets_json) target
      WHERE operation.kind='create' AND operation.phase<>'complete' AND (json_extract(target.value,'$.id') IN (${placeholders}) OR json_extract(target.value,'$.rootSessionId') IN (${placeholders}))`)
      .all(...mainIds, ...mainIds) as Array<{ operation_id: string }>) {
      blockers.push({ kind: "creation", id: row.operation_id, message: "A Session creation is incomplete." });
    }
    blockers.push(...listCrewCoordinationBlockers(this.db, [...mainIds.map((id) => ({ id, kind: "main" as const })), ...auxiliaryIds.map((id) => ({ id, kind: "auxiliary" as const }))])
      .map((item) => ({ kind: "coordination" as const, id: item.id, message: item.reason })));
    return blockers;
  }

  listPendingSessionLifecycleOperations(): SessionLifecycleOperation[] {
    const rows = this.db.prepare("SELECT operation_id FROM session_lifecycle_operations_v6 WHERE phase <> 'complete' ORDER BY created_at, operation_id").all() as Array<{ operation_id: string }>;
    return rows.map((row) => readSessionLifecycleOperation(this.db, row.operation_id)!);
  }

  beginSessionLifecycleOperation(input: Parameters<typeof beginSessionLifecycleOperation>[1]): SessionLifecycleOperation {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const result = beginSessionLifecycleOperation(this.db, input);
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  deleteSessionCrewForLifecycle(operationId: string): SessionLifecycleOperation {
    const operation = readSessionLifecycleOperation(this.db, operationId);
    if (!operation || operation.kind !== "delete") throw new Error("The Crew deletion operation could not be found.");
    if (operation.phase !== "preparing") return operation;
    for (const target of operation.targets) {
      const current = this.getSessionSummary(target.id);
      if (!current || getSessionIncarnationId(current) !== target.incarnationId) throw new Error("The Crew deletion target identity changed.");
    }
    this.deleteSessions(operation.targets.map((target) => target.id), operationId);
    return readSessionLifecycleOperation(this.db, operationId)!;
  }

  prepareSessionLifecycleCreation(operationId: string, input: import("../../src-shared/session/session-state.js").CreateSessionInput): SessionLifecycleOperation {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const operation = readSessionLifecycleOperation(this.db, operationId);
      if (!operation || operation.kind !== "create" || operation.targets[0]?.id !== input.id) throw new Error("The prepared creation owner does not match its operation.");
      if (!operation.preparedSession) this.db.prepare("UPDATE session_lifecycle_operations_v6 SET prepared_json = ?, updated_at = ? WHERE operation_id = ? AND prepared_json IS NULL")
        .run(JSON.stringify(input), new Date().toISOString(), operationId);
      const result = readSessionLifecycleOperation(this.db, operationId)!;
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  advanceSessionLifecycleOperation(operationId: string, phase: SessionLifecycleOperation["phase"], resources?: SessionLifecycleOperation["resources"]): SessionLifecycleOperation {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const operation = readSessionLifecycleOperation(this.db, operationId);
      if (!operation) throw new Error("The lifecycle operation could not be found.");
      const phases = ["preparing", "applied", "complete"];
      if (phases.indexOf(phase) < phases.indexOf(operation.phase)) throw new Error("A lifecycle operation cannot move backwards.");
      const targets = operation.kind === "create" && phase !== "preparing" ? operation.targets.map((target) => {
        const session = this.getSessionSummary(target.id);
        if (!session || (target.incarnationId && getSessionIncarnationId(session) !== target.incarnationId)) throw new Error("The creation target identity no longer matches.");
        return { ...target, incarnationId: getSessionIncarnationId(session) };
      }) : operation.targets;
      if (operation.kind === "create" && phase === "complete") {
        for (const target of targets) {
          if (!this.db.prepare(`SELECT 1 FROM auxiliary_sessions WHERE parent_session_id = ?
            AND CASE WHEN json_valid(creation_context_json) THEN json_extract(creation_context_json, '$.parentIncarnationId') ELSE NULL END = ? LIMIT 1`).get(target.id, target.incarnationId!)) {
            throw new Error("A created Main Session requires its initial Auxiliary before completion.");
          }
        }
      }
      if (resources && operation.resources.length > 0 && (resources.length !== operation.resources.length || resources.some((resource, index) => {
        const previous = operation.resources[index];
        return !previous || resource.path !== previous.path || resource.stagingPath !== previous.stagingPath || resource.device !== previous.device || resource.inode !== previous.inode || (previous.cleaned && !resource.cleaned);
      }))) throw new Error("Lifecycle resource ownership cannot be replaced.");
      if (operation.kind === "delete" && phase === "complete" && operation.phase === "preparing") throw new Error("The Crew deletion has not been applied.");
      if (operation.kind === "delete" && phase === "complete" && (resources ?? operation.resources).some((resource) => !resource.cleaned)) throw new Error("Owned resource cleanup is not complete.");
      this.db.prepare("UPDATE session_lifecycle_operations_v6 SET phase = ?, resources_json = ?, targets_json = ?, updated_at = ? WHERE operation_id = ?")
        .run(phase, JSON.stringify(resources ?? operation.resources), JSON.stringify(targets), new Date().toISOString(), operationId);
      const result = readSessionLifecycleOperation(this.db, operationId)!;
      this.db.exec("COMMIT");
      return { ...result, transitioned: operation.phase !== phase };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  patchSessionMetadata(sessionId: string, incarnationId: string, patch: SessionMetadataPatch): SessionSummary {
    const value = validateSessionMetadataPatch(patch);
    const result = this.db.prepare(`UPDATE sessions_v6 SET title = COALESCE(?, title), description = COALESCE(?, description)
      WHERE id = ? AND incarnation_id = ?`).run(value.title ?? null, value.description ?? null, sessionId, incarnationId);
    if (Number(result.changes) !== 1) throw new SessionNotFoundError(sessionId);
    return this.getSessionSummary(sessionId)!;
  }

  promoteSessionToOverallCoordinator(sessionId: string, incarnationId: string): SessionSummary {
    const result = this.db.prepare(`UPDATE sessions_v6 SET session_role = 'overall-coordinator'
      WHERE id = ? AND incarnation_id = ? AND session_role = 'standalone' AND root_session_id = id
        AND parent_session_id IS NULL AND session_kind = 'default' AND state <> 'active'`).run(sessionId, incarnationId);
    if (Number(result.changes) !== 1) throw new Error("Only an idle Standalone Session can become an overall coordinator.");
    return this.getSessionSummary(sessionId)!;
  }

  setSessionMessageBookmark(sessionId: string, incarnationId: string, messageIndex: number, isBookmarked: boolean): void {
    if (!Number.isSafeInteger(messageIndex) || messageIndex < 0) throw new Error("The message index is invalid.");
    const previous = this.db.prepare("SELECT json_type(body, '$.isBookmarked') AS bookmark FROM session_messages_v6 WHERE session_id = ? AND seq = ?")
      .get(sessionId, messageIndex) as { bookmark: string | null } | undefined;
    const result = this.db.prepare(`
      UPDATE session_messages_v6
      SET body = CASE WHEN ? = 1
        THEN json_set(body, '$.isBookmarked', json('true'))
        ELSE json_remove(body, '$.isBookmarked') END
      WHERE session_id = ? AND seq = ? AND json_valid(body)
        AND EXISTS (SELECT 1 FROM sessions_v6 WHERE id = ? AND incarnation_id = ?)
    `).run(isBookmarked ? 1 : 0, sessionId, messageIndex, sessionId, incarnationId);
    if (Number(result.changes) !== 1) throw new SessionNotFoundError(sessionId);
    if ((previous?.bookmark === "true") !== isBookmarked) this.onConversationChanged("session_messages_v6", sessionId);
  }

  setSessionExecutionOptions(sessionId: string, incarnationId: string, options: SessionExecutionOptions): void {
    const result = this.db.prepare(`
      UPDATE sessions_v6
      SET model_id = ?, reasoning_effort = ?, approval_mode = ?,
          codex_sandbox_mode = ?, custom_agent_name = ?,
          runtime_policy_json = json_set(
            CASE WHEN json_valid(runtime_policy_json) THEN runtime_policy_json ELSE '{}' END,
            '$.codexSpeed', ?, '$.codexReviewer', ?
          )
      WHERE id = ? AND incarnation_id = ?
    `).run(
      options.model, options.reasoningEffort, options.approvalMode,
      options.codexSandboxMode, options.customAgentName, options.codexSpeed, options.codexReviewer,
      sessionId, incarnationId,
    );
    if (Number(result.changes) !== 1) throw new SessionNotFoundError(sessionId);
  }

  setSessionPinned(sessionId: string, isPinned: boolean): SessionSummary {
    this.db.prepare("UPDATE sessions_v6 SET is_pinned = ? WHERE id = ?").run(isPinned ? 1 : 0, sessionId);
    const row = this.db.prepare("SELECT * FROM sessions_v6 WHERE id = ?").get(sessionId) as SessionV6Row | undefined;
    if (!row) {
      throw new Error("The session could not be found.");
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
    const includeDrafts = this.auxiliaryDraftsTableExists();
    const rows = this.db.prepare(`
      SELECT root.id FROM sessions_v6 root
      WHERE root.parent_session_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM sessions_v6 member
          WHERE COALESCE(member.root_session_id, member.id) = root.id AND member.last_active_at >= ?)
        AND NOT EXISTS (SELECT 1 FROM auxiliary_sessions auxiliary JOIN sessions_v6 member ON member.id = auxiliary.parent_session_id
          WHERE COALESCE(member.root_session_id, member.id) = root.id AND auxiliary.updated_at >= ?)
        ${includeDrafts ? `AND NOT EXISTS (SELECT 1 FROM auxiliary_session_drafts draft JOIN sessions_v6 member ON member.id = draft.parent_session_id
          WHERE COALESCE(member.root_session_id, member.id) = root.id AND draft.updated_at >= ?)` : ""}
      ORDER BY root.last_active_at ASC, root.id ASC
    `).all(cutoff.cutoffIso, cutoff.cutoffIso, ...(includeDrafts ? [cutoff.cutoffIso] : [])) as SessionIdRow[];
    return rows.map((row) => row.id).filter((id) => id.trim().length > 0);
  }

  upsertSession(session: Session): Session {
    return this.storeSession(session, "upsert");
  }

  updateSessionThreadIfMatches(input: SessionThreadPatchInput): SessionThreadPatchResult | null {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const result = this.db.prepare(`
        UPDATE sessions_v6
        SET thread_id = ?, updated_at = ?, last_active_at = ?
        WHERE id = ? AND incarnation_id = ? AND provider_id = ? AND thread_id = ?
      `).run(input.nextThreadId, input.updatedAt, input.updatedAt, input.sessionId, input.incarnationId, input.provider, input.expectedThreadId);
      if (Number(result.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.db.exec("COMMIT");
      return { id: input.sessionId, threadId: input.nextThreadId, updatedAt: input.updatedAt };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateSessionRuntimeMetadataIfMatches(input: SessionRuntimeMetadataPatchInput): SessionRuntimeMetadataPatchResult | null {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const result = this.db.prepare(`
        UPDATE sessions_v6
        SET provider_id = ?, catalog_revision = ?, model_id = ?, reasoning_effort = ?,
            thread_id = ?, updated_at = ?, last_active_at = ?
        WHERE id = ? AND incarnation_id = ? AND provider_id = ? AND catalog_revision = ?
          AND model_id = ? AND reasoning_effort = ? AND thread_id = ?
      `).run(
        input.next.provider,
        input.next.catalogRevision,
        input.next.model,
        input.next.reasoningEffort,
        input.next.threadId,
        input.next.updatedAt,
        input.next.updatedAt,
        input.sessionId,
        input.incarnationId,
        input.expected.provider,
        input.expected.catalogRevision,
        input.expected.model,
        input.expected.reasoningEffort,
        input.expected.threadId,
      );
      if (Number(result.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.db.exec("COMMIT");
      return { id: input.sessionId, ...input.next };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateSession(session: Session): Session {
    return this.storeSession(session, "update");
  }

  upsertTerminalSession(session: Session, terminalCommit: SessionTurnTerminalCommit): Session {
    return this.storeSession(session, "upsert", terminalCommit);
  }

  updateTerminalSession(session: Session, terminalCommit: SessionTurnTerminalCommit): Session {
    return this.storeSession(session, "update", terminalCommit);
  }

  clearCharacterAuthoringRuntimeState(
    input: SessionCharacterAuthoringRuntimeClearInput,
  ): SessionCharacterAuthoringRuntimeClearResult {
    const sessionId = input.sessionId.trim();
    if (!sessionId) {
      throw new Error("Character authoring runtime state format is invalid.");
    }

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const currentRow = this.db.prepare("SELECT * FROM sessions_v6 WHERE id = ?").get(sessionId) as SessionV6Row | undefined;
      if (!currentRow) {
      throw new Error("The session could not be found.");
      }
      if (currentRow.incarnation_id.trim() !== getSessionIncarnationId({
        id: sessionId,
        incarnationId: input.incarnationId,
      })) {
        throw new SessionNotFoundError(sessionId);
      }
      if (currentRow.session_kind !== "character-authoring") {
      throw new Error("The Character authoring runtime owner does not match the Session.");
      }

      const updateResult = this.db.prepare(`
        UPDATE sessions_v6
        SET character_snapshot_json = NULL,
            character_id = NULL,
            thread_id = ''
        WHERE id = ?
      `).run(sessionId);
      if (Number(updateResult.changes) !== 1) {
      throw new Error("Character authoring runtime state could not be cleared.");
      }

      const storedRow: SessionV6Row = {
        ...currentRow,
        character_snapshot_json: null,
        character_id: null,
        thread_id: "",
      };
      const storedResult: SessionCharacterAuthoringRuntimeClearResult = {
        summary: this.rowToSessionSummary(storedRow, decodeSessionV6RuntimeState(storedRow)),
        characterRuntimeSnapshot: null,
      };
      this.db.exec("COMMIT");
      return storedResult;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  appendRunningTurnStart(input: SessionRunningTurnStartInput): SessionRunningTurnStartResult {
    const sessionId = input.sessionId.trim();
    if (
      !sessionId
      || !Number.isSafeInteger(input.expectedMessageCount)
      || input.expectedMessageCount < 0
      || input.userMessage.role !== "user"
      || !input.userMessage.text.trim()
      || !input.updatedAt.trim()
    ) {
      throw new Error("The Session data is invalid for starting a running turn.");
    }

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const currentRow = this.db.prepare("SELECT * FROM sessions_v6 WHERE id = ?").get(sessionId) as SessionV6Row | undefined;
      if (!currentRow) {
      throw new Error("The session could not be found.");
      }
      if (currentRow.incarnation_id.trim() !== getSessionIncarnationId({
        id: sessionId,
        incarnationId: input.incarnationId,
      })) {
        throw new SessionNotFoundError(sessionId);
      }

      const updatesCharacterSnapshot = input.characterRuntimeSnapshot !== undefined;
      const nextCharacterSnapshot = input.characterRuntimeSnapshot;
      const currentRuntimeState = decodeSessionV6RuntimeState(currentRow);
      if (updatesCharacterSnapshot) {
        if (currentRow.session_kind !== "character-authoring") {
          assertCharacterDefinitionSnapshotUpdate(currentRuntimeState.snapshot, nextCharacterSnapshot, currentRuntimeState.characterId);
        }
        if (
          nextCharacterSnapshot
          && nextCharacterSnapshot.characterId !== currentRuntimeState.characterId
        ) {
      throw new Error("The Character snapshot owner does not match the Session.");
        }
      }

      const tailRow = this.db.prepare(`
        SELECT seq
        FROM session_messages_v6
        WHERE session_id = ?
        ORDER BY seq DESC
        LIMIT 1
      `).get(sessionId) as SessionMessageSequenceRow | undefined;
      const actualMessageCount = tailRow ? tailRow.seq + 1 : 0;
      if (actualMessageCount !== input.expectedMessageCount) {
        throw new SessionRunningTurnStartConflictError(
          sessionId,
          input.expectedMessageCount,
          actualMessageCount,
        );
      }

      if (input.queuedTurn) {
        const { queueId, turn } = input.queuedTurn;
        const queueRow = this.db.prepare(`SELECT dispatched_json AS captured_json, request_id FROM session_turn_queue_v6
          WHERE id = ? AND session_id = ? AND auxiliary_session_id IS NULL AND input_turn_id IS NULL AND incarnation_id = ? AND state = 'starting' AND dispatched_json IS NOT NULL`)
          .get(queueId, sessionId, currentRow.incarnation_id) as { captured_json: string; request_id: string } | undefined;
        if (!queueRow) throw new Error("The queued turn is not starting for the current Session owner.");
        const captured = JSON.parse(queueRow.captured_json) as SessionTurnQueueCapturedInput;
        const options = captured.request.executionOptions;
        if (captured.request.clientRequestId !== queueRow.request_id
          || captured.request.userMessage !== input.userMessage.text
          || turn.sessionId !== sessionId || turn.phase !== "running"
          || turn.userMessageSeq !== input.expectedMessageCount
          || turn.assistantMessageSeq !== undefined || turn.completedAt !== undefined
          || turn.provider !== captured.provider || turn.model !== options.model
          || turn.reasoningEffort !== options.reasoningEffort || turn.approvalMode !== options.approvalMode
          || turn.sandboxMode !== options.codexSandboxMode) {
          throw new Error("The queued turn start does not match its captured request and message sequence.");
        }
      }

      const runtimePolicyJson = JSON.stringify({
        ...parseJsonObject(currentRow.runtime_policy_json),
        appStatus: "running",
        runState: "running",
        ...(nextCharacterSnapshot && currentRow.session_kind === "character-authoring" ? {
          characterName: nextCharacterSnapshot.name,
          characterIconPath: nextCharacterSnapshot.iconFilePath,
          characterThemeColors: nextCharacterSnapshot.theme,
        } : {}),
      });
      const characterSnapshotJson = updatesCharacterSnapshot
        ? nextCharacterSnapshot
          ? stringifyCharacterRuntimeSnapshot(nextCharacterSnapshot)
          : null
        : currentRow.character_snapshot_json;
      const clearsProviderThread = currentRow.session_kind === "character-authoring"
        && updatesCharacterSnapshot && nextCharacterSnapshot === null;
      const updateResult = this.db.prepare(`
        UPDATE sessions_v6
        SET state = 'active',
            runtime_policy_json = ?,
            character_snapshot_json = CASE WHEN ? = 1 THEN ? ELSE character_snapshot_json END,
            character_id = CASE WHEN ? = 1 THEN NULL ELSE character_id END,
            thread_id = CASE WHEN ? = 1 THEN '' ELSE thread_id END,
            updated_at = ?,
            last_active_at = ?
        WHERE id = ?
      `).run(
        runtimePolicyJson,
        updatesCharacterSnapshot ? 1 : 0,
        characterSnapshotJson,
        clearsProviderThread ? 1 : 0,
        clearsProviderThread ? 1 : 0,
        input.updatedAt,
        input.updatedAt,
        sessionId,
      );
      if (Number(updateResult.changes) !== 1) {
      throw new Error("The running turn Session metadata could not be updated.");
      }

      this.db.prepare(`
        INSERT INTO session_messages_v6 (session_id, seq, role, body, artifact_body, created_at)
        VALUES (?, ?, 'user', ?, NULL, ?)
      `).run(
        sessionId,
        input.expectedMessageCount,
        encodeMessage(input.userMessage),
        input.updatedAt,
      );
      let queuedTurn: SessionTurnRecord | undefined;
      if (input.queuedTurn) {
        queuedTurn = insertSessionTurn(this.db, { sessionId, auxiliarySessionId: null }, input.queuedTurn.turn);
        const queueUpdate = this.db.prepare(`UPDATE session_turn_queue_v6
          SET state = 'running', turn_id = ?, user_message_seq = ?, updated_at = ?
          WHERE id = ? AND session_id = ? AND auxiliary_session_id IS NULL AND input_turn_id IS NULL AND incarnation_id = ? AND state = 'starting'`)
          .run(String(queuedTurn.id), input.expectedMessageCount, input.updatedAt,
            input.queuedTurn.queueId, sessionId, currentRow.incarnation_id);
        if (Number(queueUpdate.changes) !== 1) throw new Error("The queued turn start could not be committed.");
      }
      const storedRow: SessionV6Row = {
        ...currentRow,
        state: "active",
        runtime_policy_json: runtimePolicyJson,
        character_snapshot_json: characterSnapshotJson,
        character_id: clearsProviderThread ? null : currentRow.character_id,
        thread_id: clearsProviderThread ? "" : currentRow.thread_id,
        updated_at: input.updatedAt,
        last_active_at: input.updatedAt,
      };
      const decodedStoredRow = decodeSessionV6RuntimeState(storedRow);
      const storedResult: SessionRunningTurnStartResult = {
        summary: this.rowToSessionSummary(storedRow, decodedStoredRow),
        characterRuntimeSnapshot: decodedStoredRow.snapshot,
        ...(queuedTurn ? { queuedTurn } : {}),
      };
      this.db.exec("COMMIT");
      this.onConversationChanged("session_messages_v6", sessionId);
      return storedResult;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  insertSession(session: Session): Session {
    return this.storeSession(session, "create");
  }

  private storeSession(
    session: Session,
    operation: "create" | "upsert" | "update",
    terminalCommit?: SessionTurnTerminalCommit,
  ): Session {
    assertFullConversation(session);
    const normalized = normalizeSessionForStorage(session);
    if (terminalCommit && terminalCommit.sessionId !== normalized.id) {
      throw new Error("The terminal Session owner does not match the turn marker.");
    }

    const startedAt = Date.now();
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const existing = operation === "create"
        ? undefined
        : this.db.prepare("SELECT * FROM sessions_v6 WHERE id = ?").get(normalized.id) as SessionV6Row | undefined;
      if (existing) {
        normalized.taskTitle = existing.title;
        normalized.description = existing.description;
        Object.assign(normalized, normalizeSessionRelationship({ id: existing.id,
          sessionRole: existing.session_role as import("../../src-shared/session/session-role.js").SessionRole,
          rootSessionId: existing.root_session_id, parentSessionId: existing.parent_session_id, createdBySessionId: existing.created_by_session_id }));
      } else {
        const relationship = normalizeSessionRelationship(normalized);
        assertSessionRole(relationship.sessionRole);
        if (normalized.sessionKind !== "default" && relationship.sessionRole !== "standalone") throw new Error("Only normal Sessions can have a coordination Role.");
        if (relationship.parentSessionId) {
          const parent = this.getSessionSummary(relationship.parentSessionId);
          if (!parent) throw new SessionNotFoundError(relationship.parentSessionId);
          const parentRelationship = normalizeSessionRelationship(parent);
          assertChildSessionRole(parentRelationship.sessionRole, relationship.sessionRole);
          if (relationship.rootSessionId !== parentRelationship.rootSessionId || relationship.createdBySessionId !== parent.id) {
            throw new Error("The child Session relationship does not match its saved creator.");
          }
        } else if (relationship.rootSessionId !== normalized.id || relationship.createdBySessionId !== null
          || (relationship.sessionRole !== "standalone" && relationship.sessionRole !== "overall-coordinator")) {
          throw new Error("Invalid root Session relationship.");
        }
      }
      const requestedIncarnationId = getSessionIncarnationId(normalized);
      if (operation === "update") {
        if (!existing) {
          throw new SessionNotFoundError(normalized.id);
        }
        const currentIncarnationId = existing.incarnation_id?.trim() || `legacy:${normalized.id}`;
        if (currentIncarnationId !== requestedIncarnationId) {
          throw new SessionNotFoundError(normalized.id);
        }
      }
      const incarnationId = operation === "create"
        ? randomUUID()
        : existing
          ? existing.incarnation_id?.trim() || `legacy:${normalized.id}`
          : randomUUID();
      normalized.incarnationId = incarnationId;
      const conversationChanged = this.writeSession(normalized, operation, incarnationId);
      if (terminalCommit) {
        writeSessionTurnTerminalCommit(this.db, terminalCommit);
      }
      this.db.exec("COMMIT");
      if (conversationChanged || !existing) this.onConversationChanged("session_messages_v6", normalized.id);
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
    nextSessions.forEach(assertFullConversation);
    const normalizedSessions = nextSessions.map((session) => normalizeSessionForStorage(session));

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const retainedSessionIds = normalizedSessions.map((session) => session.id);
      const removedSessionIds = this.listStoredSessionIdsExcept(retainedSessionIds);
      const removedAuxiliarySessionIds = this.listAuxiliarySessionIdsWithoutValidParents(retainedSessionIds);
      deleteSessionTurnsForTargets(this.db, {
        sessionIds: removedSessionIds,
        auxiliarySessionIds: removedAuxiliarySessionIds,
      });
      this.db.exec("DELETE FROM session_messages_v6;");
      if (normalizedSessions.length === 0) this.db.exec("DELETE FROM session_lifecycle_operations_v6;");
      this.deleteStoredSessionsByIds(removedSessionIds);
      for (const session of normalizedSessions) {
        const existing = this.db.prepare(
          "SELECT incarnation_id FROM sessions_v6 WHERE id = ?",
        ).get(session.id) as { incarnation_id?: string } | undefined;
        this.writeSession(
          session,
          "upsert",
          existing ? existing.incarnation_id?.trim() || `legacy:${session.id}` : randomUUID(),
        );
      }
      this.deleteAuxiliarySessionsByIdsIfTableExists(removedAuxiliarySessionIds);
      this.db.exec("COMMIT");
      this.onConversationChanged("session_messages_v6");
      removedAuxiliarySessionIds.forEach((id) => this.onConversationChanged("auxiliary_session_messages", id));
      return this.listSessions();
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteSession(sessionId: string): void {
    const session = this.getSessionSummary(sessionId);
    if (session?.parentSessionId) throw new Error("Only an entire Crew can be deleted from its root Session.");
    this.deleteSessions([sessionId]);
  }

  deleteSessions(sessionIds: readonly string[], lifecycleOperationId?: string): void {
    const uniqueSessionIds = Array.from(new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)));
    if (uniqueSessionIds.length === 0) {
      return;
    }

    const placeholders = uniqueSessionIds.map(() => "?").join(", ");
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const members = this.db.prepare(`SELECT id, incarnation_id, root_session_id, parent_session_id, state FROM sessions_v6
        WHERE root_session_id IN (SELECT root_session_id FROM sessions_v6 WHERE id IN (${placeholders}))`).all(...uniqueSessionIds) as Array<{ id: string; incarnation_id: string; root_session_id: string; parent_session_id: string | null; state: string }>;
      if (lifecycleOperationId) {
        const operation = readSessionLifecycleOperation(this.db, lifecycleOperationId);
        if (!operation || operation.kind !== "delete" || operation.targets.some((target) => !members.some((member) => member.id === target.id && member.incarnation_id === target.incarnationId))) {
          throw new Error("The Crew deletion target identity changed.");
        }
        const cutoffIso = (operation.input as { cutoffIso?: string }).cutoffIso;
        if (cutoffIso) {
          const includeDrafts = this.auxiliaryDraftsTableExists();
          const changedActivity = this.db.prepare(`SELECT 1 FROM sessions_v6 WHERE id IN (${placeholders}) AND last_active_at >= ?
            UNION ALL SELECT 1 FROM auxiliary_sessions WHERE parent_session_id IN (${placeholders}) AND updated_at >= ?
            ${includeDrafts ? `UNION ALL SELECT 1 FROM auxiliary_session_drafts WHERE parent_session_id IN (${placeholders}) AND updated_at >= ?` : ""} LIMIT 1`)
            .get(...uniqueSessionIds, cutoffIso, ...uniqueSessionIds, cutoffIso, ...(includeDrafts ? [...uniqueSessionIds, cutoffIso] : []));
          if (changedActivity) throw new SessionCrewDeletionBlockedError("The Crew no longer meets the activity cutoff.");
        }
      }
      const requestedIds = new Set(uniqueSessionIds);
      if (members.some((member) => !requestedIds.has(member.id))) throw new Error("A Crew must be deleted as a whole.");
      const auxiliarySessionIds = this.listAuxiliarySessionIdsForParentsIfTableExists(uniqueSessionIds);
      const blockers = this.readCrewDeletionBlockers(uniqueSessionIds, auxiliarySessionIds);
      if (blockers.length > 0) throw new SessionCrewDeletionBlockedError(blockers.map((blocker) => blocker.message).join(" "));
      deleteSessionTurnsForTargets(this.db, {
        sessionIds: uniqueSessionIds,
        auxiliarySessionIds,
      });
      this.db.prepare(`DELETE FROM sessions_v6 WHERE id IN (${placeholders})`).run(...uniqueSessionIds);
      this.deleteAuxiliarySessionsForParentsIfTableExists(uniqueSessionIds);
      if (lifecycleOperationId) this.db.prepare("UPDATE session_lifecycle_operations_v6 SET phase = 'applied', updated_at = ? WHERE operation_id = ? AND kind = 'delete'")
        .run(new Date().toISOString(), lifecycleOperationId);
      this.db.exec("COMMIT");
      uniqueSessionIds.forEach((id) => this.onConversationChanged("session_messages_v6", id));
      auxiliarySessionIds.forEach((id) => this.onConversationChanged("auxiliary_session_messages", id));
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  clearSessions(): void {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      deleteSessionTurnsForTargets(this.db, { allSessionTargets: true });
      this.db.exec("DELETE FROM session_lifecycle_operations_v6;");
      this.db.exec("DELETE FROM session_messages_v6;");
      this.db.exec("DELETE FROM sessions_v6;");
      this.deleteAllAuxiliarySessionsIfTableExists();
      this.db.exec("COMMIT");
      this.onConversationChanged("session_messages_v6");
      this.onConversationChanged("auxiliary_session_messages");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private writeSession(
    session: Session,
    operation: "create" | "upsert" | "update" = "upsert",
    incarnationId = getSessionIncarnationId(session),
  ): boolean {
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
      codexSpeed: session.codexSpeed,
      codexReviewer: session.codexReviewer,
    };
    const conflictClause = operation === "create"
      ? "ON CONFLICT(id) DO NOTHING"
      : `
        ON CONFLICT(id) DO UPDATE SET
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
        incarnation_id,
        title,
        description,
        session_role,
        root_session_id,
        parent_session_id,
        created_by_session_id,
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ${conflictClause}
    `).run(
      session.id,
      incarnationId,
      session.taskTitle,
      session.description ?? "",
      session.sessionRole ?? "standalone",
      session.rootSessionId ?? session.id,
      session.parentSessionId ?? null,
      session.createdBySessionId ?? null,
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
        SELECT ${conversationMessageColumns("session_messages_v6", this.db)}, artifact_body
        FROM session_messages_v6
        WHERE session_id = ?
      `).all(session.id) as ExistingMessageArtifactRow[])
        .map((row) => [row.seq, row] as const),
    );

    const insertMessage = this.db.prepare(`
      INSERT INTO session_messages_v6 (session_id, seq, role, body, artifact_body, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const updateMessage = this.db.prepare(`
      UPDATE session_messages_v6
      SET role = ?, body = ?, artifact_body = ?, created_at = ?
      WHERE session_id = ? AND seq = ?
    `);
    let conversationChanged = existingArtifactBodies.size !== session.messages.length;
    session.messages.forEach((message, index) => {
      const previous = existingArtifactBodies.get(index);
      const previousMessage = previous ? decodeMessage(previous) : null;
      const preservedBookmark = previousMessage?.role === message.role && previousMessage.text === message.text
        ? previousMessage.isBookmarked === true : message.isBookmarked === true;
      if (!previousMessage || previousMessage.role !== message.role || previousMessage.text !== message.text
        || (previousMessage.accent === true) !== (message.accent === true)
        || (previousMessage.isBookmarked === true) !== preservedBookmark) conversationChanged = true;
      const body = encodeMessage({ ...message, isBookmarked: preservedBookmark ? true : undefined });
      const artifactBody = encodeMessageArtifactForWrite(message, previous?.artifact_body);
      if (!previous) {
        insertMessage.run(session.id, index, message.role, body, artifactBody, session.updatedAt);
      } else if (previous.role !== message.role || previous.body !== body || previous.artifact_body !== artifactBody) {
        updateMessage.run(message.role, body, artifactBody, session.updatedAt, session.id, index);
      }
    });
    this.db.prepare("DELETE FROM session_messages_v6 WHERE session_id = ? AND seq >= ?")
      .run(session.id, session.messages.length);
    logSessionRunStuckInvestigation("storage-v6.write-session.done", {
      sessionId: session.id,
      durationMs: Date.now() - startedAt,
      messageCount: session.messages.length,
      existingArtifactBodyCount: existingArtifactBodies.size,
      runState: session.runState,
      status: session.status,
    });
    return conversationChanged;
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
      incarnationId: row.incarnation_id?.trim() || `legacy:${row.id}`,
      taskTitle: row.title,
      description: row.description,
      sessionRole: row.session_role,
      rootSessionId: row.root_session_id,
      parentSessionId: row.parent_session_id,
      createdBySessionId: row.created_by_session_id,
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
      codexSpeed: runtimePolicy.codexSpeed,
      codexReviewer: runtimePolicy.codexReviewer,
      model: row.model_id,
      reasoningEffort: row.reasoning_effort,
      customAgentName: row.custom_agent_name,
      allowedAdditionalDirectories: parseJsonArray(row.allowed_additional_directories_json),
      threadId: decoded.threadId,
    });
    if (!summary) {
      throw new Error(`The V6 Session row could not be converted to a summary: ${row.id}`);
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
      SELECT ${conversationMessageColumns("session_messages_v6", this.db)}
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
      throw new Error(`The V6 Session row could not be converted to a Session: ${row.id}`);
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
    if (this.auxiliaryDraftsTableExists()) {
      this.db.prepare(`DELETE FROM auxiliary_session_drafts WHERE parent_session_id IN (${placeholders})`).run(...uniqueParentIds);
    }
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
    if (this.auxiliaryDraftsTableExists()) {
      this.db.prepare(`DELETE FROM auxiliary_session_drafts WHERE auxiliary_session_id IN (${placeholders})`).run(...uniqueAuxiliarySessionIds);
    }
  }

  private deleteAllAuxiliarySessionsIfTableExists(): void {
    if (!this.auxiliarySessionsTableExists()) {
      return;
    }

    this.db.prepare("DELETE FROM auxiliary_sessions").run();
    if (this.auxiliaryDraftsTableExists()) this.db.prepare("DELETE FROM auxiliary_session_drafts").run();
  }

  private auxiliaryDraftsTableExists(): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auxiliary_session_drafts'`).get());
  }

  private listAuxiliarySessionIdsWithoutValidParents(retainedParentSessionIds: Iterable<string>): string[] {
    if (!this.auxiliarySessionsTableExists()) {
      return [];
    }

    const validParentSessionIds = Array.from(new Set([
      ...retainedParentSessionIds,
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
