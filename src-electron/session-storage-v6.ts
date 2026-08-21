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
  type SessionCharacterUsage,
  type SessionSummaryPageRequest,
  type SessionSummaryPageResult,
  type SessionSummary,
} from "../src/session-state.js";
import {
  requireSessionRoleBinding,
  sameSessionRoleBinding,
  type SessionRoleBinding,
} from "../src/session-role-binding.js";
import { normalizeProviderId } from "../src/model-catalog.js";
import {
  parseCharacterRuntimeSnapshotJson,
  stringifyCharacterRuntimeSnapshot,
} from "../src/character/character-runtime-snapshot.js";
import { DEFAULT_CHARACTER_THEME_COLORS } from "../src/character-state.js";
import {
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
  role_session_role: string | null;
  role_contract_revision: number | null;
  role_root_session_id: string | null;
  role_parent_session_id: string | null;
  role_delegation_depth: number | null;
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

type SessionV6SummaryBaseRow = Omit<SessionV6Row, "character_snapshot_json">;

type SessionV6SummaryRow = SessionV6SummaryBaseRow & {
  character_snapshot_present: number;
  snapshot_json_valid: number;
  snapshot_character_id: unknown;
  snapshot_name: unknown;
  snapshot_icon_file_path: unknown;
  snapshot_theme_main: unknown;
  snapshot_theme_sub: unknown;
  snapshot_definition_markdown_type: string | null;
};

const SESSION_SUMMARY_SELECT_COLUMNS = `
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
  workspace_path,
  is_pinned,
  updated_at,
  last_active_at,
  character_snapshot_json IS NOT NULL AS character_snapshot_present,
  CASE WHEN json_valid(character_snapshot_json) THEN 1 ELSE 0 END AS snapshot_json_valid,
  CASE WHEN json_valid(character_snapshot_json) THEN json_extract(character_snapshot_json, '$.characterId') END AS snapshot_character_id,
  CASE WHEN json_valid(character_snapshot_json) THEN json_extract(character_snapshot_json, '$.name') END AS snapshot_name,
  CASE WHEN json_valid(character_snapshot_json) THEN json_extract(character_snapshot_json, '$.iconFilePath') END AS snapshot_icon_file_path,
  CASE WHEN json_valid(character_snapshot_json) THEN json_extract(character_snapshot_json, '$.theme.main') END AS snapshot_theme_main,
  CASE WHEN json_valid(character_snapshot_json) THEN json_extract(character_snapshot_json, '$.theme.sub') END AS snapshot_theme_sub,
  CASE WHEN json_valid(character_snapshot_json) THEN json_type(character_snapshot_json, '$.definitionMarkdown') END AS snapshot_definition_markdown_type,
  (SELECT session_role FROM session_role_bindings_v6 WHERE session_id = sessions_v6.id) AS role_session_role,
  (SELECT role_contract_revision FROM session_role_bindings_v6 WHERE session_id = sessions_v6.id) AS role_contract_revision,
  (SELECT root_session_id FROM session_role_bindings_v6 WHERE session_id = sessions_v6.id) AS role_root_session_id,
  (SELECT parent_session_id FROM session_role_bindings_v6 WHERE session_id = sessions_v6.id) AS role_parent_session_id,
  (SELECT delegation_depth FROM session_role_bindings_v6 WHERE session_id = sessions_v6.id) AS role_delegation_depth
`;

type SessionCrudIdempotencyRow = {
  request_fingerprint: string;
  session_id: string;
  result_json: string;
};

type SessionRoleBindingRow = {
  session_role: string;
  role_contract_revision: number;
  root_session_id: string;
  parent_session_id: string | null;
  delegation_depth: number;
};

type SessionFileWriteIdempotencyRow = {
  request_fingerprint: string;
  session_id: string;
  relative_path: string;
  temp_name: string;
  state: "pending" | "applied" | "rejected";
  output_sha256: string | null;
  byte_length: number | null;
  file_device: string | null;
  file_inode: string | null;
  target_precondition_json: string | null;
  result_json: string | null;
};

export type SessionFileWritePreparedProof = {
  sha256: string;
  byteLength: number;
  device: string;
  inode: string;
  targetPrecondition: SessionFileTargetPrecondition;
};

export type SessionFileTargetPrecondition =
  | { kind: "absent" }
  | { kind: "file"; sha256: string; byteLength: number; device: string; inode: string };

export type SessionCrudOperation = "session.create" | "session.rename";
export type SessionCrudReplayResult =
  | { kind: "absent" }
  | { kind: "replay"; sessionId: string; result: unknown };
export type SessionSummaryPagePosition = { lastActiveAt: string; sessionId: string };
export type SessionSummaryPageEntry = { summary: SessionSummary; lastActiveAt: string };

export class SessionCrudIdempotencyConflictError extends Error {
  constructor() {
    super("The idempotency key was already used with different input.");
    this.name = "SessionCrudIdempotencyConflictError";
  }
}

export type SessionFileWriteReplayResult =
  | {
    kind: "pending";
    sessionId: string;
    relativePath: string;
    tempName: string;
    prepared: SessionFileWritePreparedProof | null;
    resumed: boolean;
  }
  | {
    kind: "replay";
    sessionId: string;
    relativePath: string;
    tempName: string;
    prepared: SessionFileWritePreparedProof | null;
    result: unknown;
  }
  | {
    kind: "rejected";
    sessionId: string;
    relativePath: string;
    tempName: string;
    prepared: SessionFileWritePreparedProof | null;
    error: unknown;
  };

export class SessionFileWriteIdempotencyConflictError extends Error {
  constructor() {
    super("The idempotency key was already used with different input.");
    this.name = "SessionFileWriteIdempotencyConflictError";
  }
}

type DecodedSessionV6RuntimeState = {
  runtimePolicy: Record<string, unknown>;
  characterId: string;
  snapshot: ReturnType<typeof parseCharacterRuntimeSnapshotJson>;
  threadId: string;
};

const AUXILIARY_SESSIONS_TABLE_NAME = "auxiliary_sessions";
const COMPANION_SESSIONS_TABLE_NAME = "companion_sessions";

const SESSION_RUN_STUCK_INVESTIGATION_LOG = "[investigate:session-run-stuck]";

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

function requireStoredRoleField<T>(value: T | null, sessionId: string): T {
  if (value === null) {
    throw new Error(`Stored normal Session Role binding is incomplete: ${sessionId}`);
  }
  return value;
}

function decodeSessionRoleBinding(sessionId: string, row: SessionRoleBindingRow): SessionRoleBinding {
  return requireSessionRoleBinding(sessionId, {
    sessionRole: row.session_role,
    roleContractRevision: row.role_contract_revision,
    rootSessionId: row.root_session_id,
    parentSessionId: row.parent_session_id,
    delegationDepth: row.delegation_depth,
  });
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
      SELECT sessions_v6.*,
        b.session_role AS role_session_role,
        b.role_contract_revision,
        b.root_session_id AS role_root_session_id,
        b.parent_session_id AS role_parent_session_id,
        b.delegation_depth AS role_delegation_depth
      FROM sessions_v6
      LEFT JOIN session_role_bindings_v6 AS b ON b.session_id = sessions_v6.id
      ORDER BY last_active_at DESC, id DESC
    `).all() as SessionV6Row[];
    return cloneSessions(rows.map((row) => this.rowToSession(row)));
  }

  listSessionSummaries(): SessionSummary[] {
    const rows = this.db.prepare(`
      SELECT ${SESSION_SUMMARY_SELECT_COLUMNS}
      FROM sessions_v6
      ORDER BY last_active_at DESC, id DESC
    `).all() as SessionV6SummaryRow[];
    return cloneSessionSummaries(rows.map((row) => this.rowToSessionSummaryProjection(row)));
  }

  listHomeSessionSummaryPage(request?: SessionSummaryPageRequest | null): SessionSummaryPageResult {
    const parsed = parseSessionSummaryPageRequest(request);
    const cursor = parsed.scope === "open"
      ? null
      : decodeSessionSummaryCursor(parsed.cursor, parsed.scope, parsed.searchText);
    const search = buildSessionSummarySearchClause("sessions_v6", parsed.searchText);
    const keyset = buildSessionSummaryKeysetClause("sessions_v6", cursor);
    const where: string[] = [];
    const params: string[] = [];

    if (parsed.scope === "pinned") {
      where.push("sessions_v6.is_pinned = 1");
    }
    if (parsed.scope === "open") {
      const sessionIds = parsed.sessionIds ?? [];
      if (sessionIds.length === 0) {
        return { entries: [], nextCursor: null, hasMore: false };
      }
      where.push(`sessions_v6.id IN (${sessionIds.map(() => "?").join(", ")})`);
      params.push(...sessionIds);
    } else if (keyset.sql) {
      where.push(keyset.sql);
      params.push(...keyset.params);
    }
    if (search.sql) {
      where.push(search.sql);
      params.push(...search.params);
    }

    const rows = this.db.prepare(`
      SELECT ${SESSION_SUMMARY_SELECT_COLUMNS}
      FROM sessions_v6
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY sessions_v6.last_active_at DESC, sessions_v6.id DESC
      LIMIT ?
    `).all(...params, parsed.limit + 1) as SessionV6SummaryRow[];
    const visibleRows = rows.slice(0, parsed.limit);
    const entries = cloneSessionSummaries(visibleRows.map((row) => this.rowToSessionSummaryProjection(row)));
    const hasMore = rows.length > parsed.limit;
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
      SELECT ${characterIdExpression} AS character_id
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
      SELECT ${SESSION_SUMMARY_SELECT_COLUMNS}
      FROM sessions_v6
      WHERE ${SESSION_PROVIDER_ID_NORMALIZER_SQL_FUNCTION}(provider_id) = ?
      ORDER BY last_active_at DESC, id DESC
      LIMIT 1
    `).get(normalizeProviderId(normalizedProviderId)) as SessionV6SummaryRow | undefined;
    return row ? this.rowToSessionSummaryProjection(row) : null;
  }

  getSession(sessionId: string): Session | null {
    const row = this.db.prepare(`
      SELECT sessions_v6.*,
        b.session_role AS role_session_role,
        b.role_contract_revision,
        b.root_session_id AS role_root_session_id,
        b.parent_session_id AS role_parent_session_id,
        b.delegation_depth AS role_delegation_depth
      FROM sessions_v6
      LEFT JOIN session_role_bindings_v6 AS b ON b.session_id = sessions_v6.id
      WHERE sessions_v6.id = ?
    `).get(sessionId) as SessionV6Row | undefined;
    return row ? this.rowToSession(row) : null;
  }

  getSessionSummary(sessionId: string): SessionSummary | null {
    const row = this.db.prepare(`
      SELECT ${SESSION_SUMMARY_SELECT_COLUMNS}
      FROM sessions_v6
      WHERE id = ?
    `).get(sessionId) as SessionV6SummaryRow | undefined;
    return row ? this.rowToSessionSummaryProjection(row) : null;
  }

  listSessionSummaryPage(
    limit: number,
    position?: SessionSummaryPagePosition,
  ): SessionSummaryPageEntry[] {
    const rows = (position
      ? this.db.prepare(`
          SELECT ${SESSION_SUMMARY_SELECT_COLUMNS}
          FROM sessions_v6
          WHERE session_kind = 'default'
            AND (last_active_at < ? OR (last_active_at = ? AND id < ?))
          ORDER BY last_active_at DESC, id DESC
          LIMIT ?
        `).all(position.lastActiveAt, position.lastActiveAt, position.sessionId, limit)
      : this.db.prepare(`
          SELECT ${SESSION_SUMMARY_SELECT_COLUMNS}
          FROM sessions_v6
          WHERE session_kind = 'default'
          ORDER BY last_active_at DESC, id DESC
          LIMIT ?
        `).all(limit)) as SessionV6SummaryRow[];
    return rows.map((row) => ({
      summary: this.rowToSessionSummaryProjection(row),
      lastActiveAt: row.last_active_at,
    }));
  }

  resolveSessionCrudIdempotency(
    operation: SessionCrudOperation,
    principalSessionId: string,
    idempotencyKey: string,
    resolveExpectedFingerprint: string | ((result: unknown) => string),
    nowIso: string,
  ): SessionCrudReplayResult {
    this.cleanupSessionCrudIdempotency(nowIso);
    return this.resolveSessionCrudIdempotencyWithoutCleanup(
      operation,
      principalSessionId,
      idempotencyKey,
      resolveExpectedFingerprint,
    );
  }

  getSessionRoleBinding(sessionId: string): SessionRoleBinding | null {
    const row = this.findSessionRoleBindingRow(sessionId);
    return row ? decodeSessionRoleBinding(sessionId, row) : null;
  }

  listSessionIdsWithChildren(sessionIds: readonly string[]): Set<string> {
    const uniqueSessionIds = Array.from(new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)));
    if (uniqueSessionIds.length === 0) return new Set();
    const placeholders = uniqueSessionIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT DISTINCT parent_session_id AS id
      FROM session_role_bindings_v6
      WHERE parent_session_id IN (${placeholders})
    `).all(...uniqueSessionIds) as SessionIdRow[];
    return new Set(rows.map((row) => row.id));
  }

  insertSessionIdempotently(
    session: Session,
    input: {
      operation: "session.create";
      principalSessionId: string;
      idempotencyKey: string;
      requestFingerprint: string;
      createdAt: string;
      expiresAt: string;
      projectResult(session: Session): unknown;
      resolveReplayFingerprint(result: unknown): string;
    },
  ): { session: Session; result: unknown; replayed: boolean } {
    const normalized = normalizeSessionForStorage(session);
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const replay = this.resolveSessionCrudIdempotencyWithoutCleanup(
        input.operation,
        input.principalSessionId,
        input.idempotencyKey,
        input.resolveReplayFingerprint,
      );
      if (replay.kind === "replay") {
        const stored = this.getSession(replay.sessionId);
        if (!stored) {
          throw new Error("Idempotent Session create result is missing its Session.");
        }
        this.db.exec("COMMIT");
        return { session: stored, result: replay.result, replayed: true };
      }

      this.writeSession(normalized, "create");
      const stored = this.getSession(normalized.id) ?? normalized;
      const result = input.projectResult(stored);
      this.insertSessionCrudIdempotency(input, stored.id, result);
      this.db.exec("COMMIT");
      return { session: stored, result, replayed: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  renameSessionIdempotently(input: {
      operation: "session.rename";
    principalSessionId?: string;
    sessionId: string;
    title: string;
    idempotencyKey: string;
    requestFingerprint: string;
    createdAt: string;
    expiresAt: string;
    projectResult(session: SessionSummary): unknown;
  }): { session: SessionSummary; result: unknown; replayed: boolean } | null {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const replay = this.resolveSessionCrudIdempotencyWithoutCleanup(
        input.operation,
        input.principalSessionId ?? "",
        input.idempotencyKey,
        input.requestFingerprint,
      );
      if (replay.kind === "replay") {
        const stored = this.getSessionSummary(replay.sessionId);
        if (!stored) {
          throw new Error("Idempotent Session rename result is missing its Session.");
        }
        this.db.exec("COMMIT");
        return { session: stored, result: replay.result, replayed: true };
      }

      const current = this.getSessionSummary(input.sessionId);
      if (!current || current.sessionKind !== "default") {
        this.db.exec("COMMIT");
        return null;
      }
      this.db.prepare(`
        UPDATE sessions_v6
        SET title = ?, updated_at = ?
        WHERE id = ? AND session_kind = 'default'
      `).run(input.title, input.createdAt, input.sessionId);
      const stored = this.getSessionSummary(input.sessionId);
      if (!stored) {
        throw new Error("Renamed Session could not be read back.");
      }
      const result = input.projectResult(stored);
      this.insertSessionCrudIdempotency(input, stored.id, result);
      this.db.exec("COMMIT");
      return { session: stored, result, replayed: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  cleanupSessionCrudIdempotency(nowIso: string): number {
    const result = this.db.prepare(`
      DELETE FROM session_crud_idempotency_v6
      WHERE expires_at <= ?
    `).run(nowIso);
    return Number(result.changes);
  }

  prepareSessionFileWrite(input: {
    idempotencyKey: string;
    requestFingerprint: string;
    sessionId: string;
    relativePath: string;
    tempName: string;
    createdAt: string;
    expiresAt: string;
  }): SessionFileWriteReplayResult {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.cleanupAppliedSessionFileWriteIdempotency(input.createdAt);
      const existing = this.findSessionFileWriteIdempotency(input.idempotencyKey);
      if (existing) {
        const resolved = resolveSessionFileWriteIdempotency(existing, input.requestFingerprint);
        this.db.exec("COMMIT");
        return resolved;
      }
      this.db.prepare(`
        INSERT INTO session_file_write_idempotency_v6 (
          operation, idempotency_key, request_fingerprint, session_id, relative_path,
          temp_name, state, result_json, created_at, expires_at
        ) VALUES ('session.files.write_text', ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
      `).run(
        input.idempotencyKey,
        input.requestFingerprint,
        input.sessionId,
        input.relativePath,
        input.tempName,
        input.createdAt,
        input.expiresAt,
      );
      this.db.exec("COMMIT");
      return {
        kind: "pending",
        sessionId: input.sessionId,
        relativePath: input.relativePath,
        tempName: input.tempName,
        prepared: null,
        resumed: false,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordPreparedSessionFileWrite(input: {
    idempotencyKey: string;
    requestFingerprint: string;
    prepared: SessionFileWritePreparedProof;
  }): void {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const existing = this.findSessionFileWriteIdempotency(input.idempotencyKey);
      if (!existing) throw new Error("Prepared Session file write idempotency record is missing.");
      const resolved = resolveSessionFileWriteIdempotency(existing, input.requestFingerprint);
      if (resolved.kind !== "pending") {
        this.db.exec("COMMIT");
        return;
      }
      if (resolved.prepared && !samePreparedProof(resolved.prepared, input.prepared)) {
        throw new Error("Pending Session file write proof changed between retries.");
      }
      this.db.prepare(`
        UPDATE session_file_write_idempotency_v6
        SET output_sha256 = ?, byte_length = ?, file_device = ?, file_inode = ?, target_precondition_json = ?
        WHERE operation = 'session.files.write_text' AND idempotency_key = ? AND state = 'pending'
      `).run(
        input.prepared.sha256,
        input.prepared.byteLength,
        input.prepared.device,
        input.prepared.inode,
        JSON.stringify(input.prepared.targetPrecondition),
        input.idempotencyKey,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeSessionFileWrite(input: {
    idempotencyKey: string;
    requestFingerprint: string;
    prepared: SessionFileWritePreparedProof;
    result: unknown;
    completedAt: string;
    expiresAt: string;
  }): unknown {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const existing = this.findSessionFileWriteIdempotency(input.idempotencyKey);
      if (!existing) {
        throw new Error("Prepared Session file write idempotency record is missing.");
      }
      const resolved = resolveSessionFileWriteIdempotency(existing, input.requestFingerprint);
      if (resolved.kind === "replay") {
        this.db.exec("COMMIT");
        return resolved.result;
      }
      if (resolved.kind === "rejected") {
        throw new Error("Rejected Session file write cannot be completed as applied.");
      }
      if (!resolved.prepared || !samePreparedProof(resolved.prepared, input.prepared)) {
        throw new Error("Session file write completion does not match the prepared proof.");
      }
      const resultJson = JSON.stringify(input.result);
      this.db.prepare(`
        UPDATE session_file_write_idempotency_v6
        SET state = 'applied', result_json = ?, created_at = ?, expires_at = ?
        WHERE operation = 'session.files.write_text' AND idempotency_key = ?
      `).run(resultJson, input.completedAt, input.expiresAt, input.idempotencyKey);
      this.db.exec("COMMIT");
      return JSON.parse(resultJson) as unknown;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  rejectSessionFileWrite(input: {
    idempotencyKey: string;
    requestFingerprint: string;
    error: unknown;
    completedAt: string;
    expiresAt: string;
  }): unknown {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const existing = this.findSessionFileWriteIdempotency(input.idempotencyKey);
      if (!existing) {
        throw new Error("Prepared Session file write idempotency record is missing.");
      }
      const resolved = resolveSessionFileWriteIdempotency(existing, input.requestFingerprint);
      if (resolved.kind === "rejected") {
        this.db.exec("COMMIT");
        return resolved.error;
      }
      if (resolved.kind === "replay") {
        throw new Error("Applied Session file write cannot be completed as rejected.");
      }
      const errorJson = JSON.stringify(input.error);
      this.db.prepare(`
        UPDATE session_file_write_idempotency_v6
        SET state = 'rejected', result_json = ?, created_at = ?, expires_at = ?
        WHERE operation = 'session.files.write_text' AND idempotency_key = ?
      `).run(errorJson, input.completedAt, input.expiresAt, input.idempotencyKey);
      this.db.exec("COMMIT");
      return JSON.parse(errorJson) as unknown;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  cleanupAppliedSessionFileWriteIdempotency(nowIso: string): number {
    const result = this.db.prepare(`
      DELETE FROM session_file_write_idempotency_v6
      WHERE state IN ('applied', 'rejected') AND expires_at <= ?
    `).run(nowIso);
    return Number(result.changes);
  }

  setSessionPinned(sessionId: string, isPinned: boolean): SessionSummary {
    this.db.prepare("UPDATE sessions_v6 SET is_pinned = ? WHERE id = ?").run(isPinned ? 1 : 0, sessionId);
    const summary = this.getSessionSummary(sessionId);
    if (!summary) {
      throw new Error("対象セッションが見つからないよ。");
    }
    return summary;
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
      for (const delegationDepth of [2, 1, 0]) {
        this.db.prepare(`
          DELETE FROM session_role_bindings_v6
          WHERE session_id IN (${placeholders}) AND delegation_depth = ?
        `).run(...uniqueSessionIds, delegationDepth);
      }
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
      this.db.exec("DELETE FROM session_role_bindings_v6 WHERE delegation_depth = 2;");
      this.db.exec("DELETE FROM session_role_bindings_v6 WHERE delegation_depth = 1;");
      this.db.exec("DELETE FROM session_role_bindings_v6 WHERE delegation_depth = 0;");
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

  private resolveSessionCrudIdempotencyWithoutCleanup(
    operation: SessionCrudOperation,
    principalSessionId: string,
    idempotencyKey: string,
    resolveExpectedFingerprint: string | ((result: unknown) => string),
  ): SessionCrudReplayResult {
    const row = this.db.prepare(`
      SELECT request_fingerprint, session_id, result_json
      FROM session_crud_idempotency_v6
      WHERE operation = ? AND principal_session_id = ? AND idempotency_key = ?
    `).get(operation, principalSessionId, idempotencyKey) as SessionCrudIdempotencyRow | undefined;
    if (!row) {
      return { kind: "absent" };
    }
    const result = JSON.parse(row.result_json) as unknown;
    const expectedFingerprint = typeof resolveExpectedFingerprint === "function"
      ? resolveExpectedFingerprint(result)
      : resolveExpectedFingerprint;
    if (row.request_fingerprint !== expectedFingerprint) {
      throw new SessionCrudIdempotencyConflictError();
    }
    return {
      kind: "replay",
      sessionId: row.session_id,
      result,
    };
  }

  private insertSessionCrudIdempotency(
    input: {
      operation: SessionCrudOperation;
      principalSessionId?: string;
      idempotencyKey: string;
      requestFingerprint: string;
      createdAt: string;
      expiresAt: string;
    },
    sessionId: string,
    result: unknown,
  ): void {
    this.db.prepare(`
      INSERT INTO session_crud_idempotency_v6 (
        operation,
        principal_session_id,
        idempotency_key,
        request_fingerprint,
        session_id,
        result_json,
        created_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.operation,
      input.principalSessionId ?? "",
      input.idempotencyKey,
      input.requestFingerprint,
      sessionId,
      JSON.stringify(result),
      input.createdAt,
      input.expiresAt,
    );
  }

  private findSessionFileWriteIdempotency(idempotencyKey: string): SessionFileWriteIdempotencyRow | undefined {
    return this.db.prepare(`
      SELECT request_fingerprint, session_id, relative_path, temp_name, state,
        output_sha256, byte_length, file_device, file_inode, target_precondition_json, result_json
      FROM session_file_write_idempotency_v6
      WHERE operation = 'session.files.write_text' AND idempotency_key = ?
    `).get(idempotencyKey) as SessionFileWriteIdempotencyRow | undefined;
  }

  private findSessionRoleBindingRow(sessionId: string): SessionRoleBindingRow | undefined {
    return this.db.prepare(`
      SELECT session_role, role_contract_revision, root_session_id, parent_session_id, delegation_depth
      FROM session_role_bindings_v6
      WHERE session_id = ?
    `).get(sessionId) as SessionRoleBindingRow | undefined;
  }

  private writeSession(session: Session, operation: "create" | "upsert" = "upsert"): void {
    const startedAt = Date.now();
    const existingRoleBindingRow = this.findSessionRoleBindingRow(session.id);
    const existingSessionRow = this.db.prepare("SELECT session_kind FROM sessions_v6 WHERE id = ?").get(session.id) as
      | { session_kind: string }
      | undefined;
    if (session.sessionKind === "default") {
      if (!session.roleBinding) {
        throw new Error(`Normal Session Role binding is missing: ${session.id}`);
      }
      if (existingRoleBindingRow) {
        const existingBinding = decodeSessionRoleBinding(session.id, existingRoleBindingRow);
        if (!sameSessionRoleBinding(existingBinding, session.roleBinding)) {
          throw new Error(`Session Role binding is immutable: ${session.id}`);
        }
      } else if (existingSessionRow) {
        throw new Error(`Stored normal Session Role binding is missing: ${session.id}`);
      }
    } else if (session.roleBinding !== null || existingRoleBindingRow) {
      throw new Error(`Non-normal Session cannot use a normal Session Role binding: ${session.id}`);
    }
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

    if (session.sessionKind === "default" && !existingRoleBindingRow) {
      const binding = requireSessionRoleBinding(session.id, session.roleBinding);
      this.db.prepare(`
        INSERT INTO session_role_bindings_v6 (
          session_id, session_role, role_contract_revision, root_session_id, parent_session_id, delegation_depth
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        session.id,
        binding.sessionRole,
        binding.roleContractRevision,
        binding.rootSessionId,
        binding.parentSessionId,
        binding.delegationDepth,
      );
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

  private rowToSessionSummaryProjection(row: SessionV6SummaryRow): SessionSummary {
    const runtimePolicy = parseJsonObject(row.runtime_policy_json);
    const runtimeCharacterId = normalizeCharacterOwnerId(runtimePolicy.characterId);
    const storedCharacterId = normalizeCharacterOwnerId(row.character_id) ?? runtimeCharacterId;
    const characterId = recoverStoredCharacterOwnerId(storedCharacterId);
    const unresolvedOwner = isUnknownCharacterOwnerId(characterId);
    const snapshotCharacterId = normalizeCharacterOwnerId(row.snapshot_character_id);
    const hasValidSnapshot = row.character_snapshot_present === 1 &&
      row.snapshot_json_valid === 1 &&
      typeof row.snapshot_name === "string" &&
      row.snapshot_definition_markdown_type === "text";
    const snapshot = hasValidSnapshot && !unresolvedOwner && snapshotCharacterId === characterId
      ? {
          characterId,
          name: row.snapshot_name as string,
          description: "",
          iconFilePath: typeof row.snapshot_icon_file_path === "string" ? row.snapshot_icon_file_path : "",
          theme: {
            main: typeof row.snapshot_theme_main === "string"
              ? row.snapshot_theme_main
              : DEFAULT_CHARACTER_THEME_COLORS.main,
            sub: typeof row.snapshot_theme_sub === "string"
              ? row.snapshot_theme_sub
              : DEFAULT_CHARACTER_THEME_COLORS.sub,
          },
          definitionMarkdown: "",
          definitionSha256: "",
          definitionByteSize: 0,
          snapshotAt: "",
        }
      : null;
    const decoded: DecodedSessionV6RuntimeState = {
      runtimePolicy,
      characterId,
      snapshot,
      threadId: unresolvedOwner || (row.character_snapshot_present === 1 && snapshot === null) ? "" : row.thread_id,
    };
    return this.rowToSessionSummary(row, decoded);
  }

  private rowToSessionSummary(
    row: SessionV6SummaryBaseRow,
    decoded?: DecodedSessionV6RuntimeState,
  ): SessionSummary {
    const resolvedDecoded = decoded ?? decodeSessionV6RuntimeState(row as SessionV6Row);
    const { runtimePolicy, snapshot, characterId, threadId } = resolvedDecoded;
    const sessionKind = row.session_kind === "character-authoring" ? "character-authoring" : "default";
    const roleBinding = sessionKind === "default"
      ? decodeSessionRoleBinding(row.id, {
          session_role: requireStoredRoleField(row.role_session_role, row.id),
          role_contract_revision: requireStoredRoleField(row.role_contract_revision, row.id),
          root_session_id: requireStoredRoleField(row.role_root_session_id, row.id),
          parent_session_id: row.role_parent_session_id,
          delegation_depth: requireStoredRoleField(row.role_delegation_depth, row.id),
        })
      : null;
    if (sessionKind === "character-authoring" && row.role_session_role !== null) {
      throw new Error(`Non-normal Session has a Role binding: ${row.id}`);
    }
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
      sessionKind,
      accessMode: runtimePolicy.accessMode,
      sourceSchemaVersion: runtimePolicy.sourceSchemaVersion ?? CURRENT_SESSION_SCHEMA_VERSION,
      roleBinding,
      characterId,
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
      threadId,
    });
    if (!summary) {
      throw new Error(`V6 session row を summary に変換できないよ: ${row.id}`);
    }
    return summary;
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
    for (const delegationDepth of [2, 1, 0]) {
      this.db.prepare(`
        DELETE FROM session_role_bindings_v6
        WHERE session_id IN (${placeholders}) AND delegation_depth = ?
      `).run(...uniqueSessionIds, delegationDepth);
    }
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

function resolveSessionFileWriteIdempotency(
  row: SessionFileWriteIdempotencyRow,
  requestFingerprint: string,
): SessionFileWriteReplayResult {
  if (row.request_fingerprint !== requestFingerprint) {
    throw new SessionFileWriteIdempotencyConflictError();
  }
  const prepared = decodePreparedProof(row);
  if (row.state === "applied") {
    if (!row.result_json) {
      throw new Error("Applied Session file write is missing its canonical result.");
    }
    return {
      kind: "replay",
      sessionId: row.session_id,
      relativePath: row.relative_path,
      tempName: row.temp_name,
      prepared,
      result: JSON.parse(row.result_json) as unknown,
    };
  }
  if (row.state === "rejected") {
    if (!row.result_json) {
      throw new Error("Rejected Session file write is missing its canonical error.");
    }
    return {
      kind: "rejected",
      sessionId: row.session_id,
      relativePath: row.relative_path,
      tempName: row.temp_name,
      prepared,
      error: JSON.parse(row.result_json) as unknown,
    };
  }
  return {
    kind: "pending",
    sessionId: row.session_id,
    relativePath: row.relative_path,
    tempName: row.temp_name,
    prepared,
    resumed: true,
  };
}

function decodePreparedProof(row: SessionFileWriteIdempotencyRow): SessionFileWritePreparedProof | null {
  const values = [row.output_sha256, row.byte_length, row.file_device, row.file_inode, row.target_precondition_json];
  if (values.every((value) => value === null)) return null;
  if (
    typeof row.output_sha256 !== "string"
    || typeof row.byte_length !== "number"
    || !Number.isSafeInteger(row.byte_length)
    || row.byte_length < 0
    || typeof row.file_device !== "string"
    || typeof row.file_inode !== "string"
    || (row.state === "pending" && typeof row.target_precondition_json !== "string")
  ) {
    throw new Error("Pending Session file write has an invalid prepared proof.");
  }
  const targetPrecondition = row.target_precondition_json === null
    ? { kind: "absent" } as const
    : JSON.parse(row.target_precondition_json) as unknown;
  if (!isTargetPrecondition(targetPrecondition)) {
    throw new Error("Pending Session file write has an invalid target precondition.");
  }
  return {
    sha256: row.output_sha256,
    byteLength: row.byte_length,
    device: row.file_device,
    inode: row.file_inode,
    targetPrecondition,
  };
}

function samePreparedProof(left: SessionFileWritePreparedProof, right: SessionFileWritePreparedProof): boolean {
  return left.sha256 === right.sha256
    && left.byteLength === right.byteLength
    && left.device === right.device
    && left.inode === right.inode
    && JSON.stringify(left.targetPrecondition) === JSON.stringify(right.targetPrecondition);
}

function isTargetPrecondition(value: unknown): value is SessionFileTargetPrecondition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<SessionFileTargetPrecondition>;
  if (candidate.kind === "absent") return Object.keys(candidate).length === 1;
  return candidate.kind === "file"
    && typeof candidate.sha256 === "string"
    && typeof candidate.byteLength === "number"
    && Number.isSafeInteger(candidate.byteLength)
    && candidate.byteLength >= 0
    && typeof candidate.device === "string"
    && typeof candidate.inode === "string";
}
