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
import { normalizeProviderId } from "../src/model-catalog.js";
import {
  parseCharacterRuntimeSnapshotJson,
  stringifyCharacterRuntimeSnapshot,
} from "../src/character/character-runtime-snapshot.js";
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
  is_pinned: number;
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

type SessionCrudIdempotencyRow = {
  request_fingerprint: string;
  session_id: string;
  result_json: string;
};

type SessionFileWriteIdempotencyRow = {
  request_fingerprint: string;
  session_id: string;
  relative_path: string;
  temp_name: string;
  state: "pending" | "applied" | "rejected";
  result_json: string | null;
};

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
  | { kind: "pending"; sessionId: string; relativePath: string; tempName: string; resumed: boolean }
  | { kind: "replay"; sessionId: string; relativePath: string; tempName: string; result: unknown }
  | { kind: "rejected"; sessionId: string; relativePath: string; tempName: string; error: unknown };

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

  getSessionSummary(sessionId: string): SessionSummary | null {
    const row = this.db.prepare("SELECT * FROM sessions_v6 WHERE id = ?").get(sessionId) as SessionV6Row | undefined;
    return row ? this.rowToSessionSummary(row) : null;
  }

  listSessionSummaryPage(
    limit: number,
    position?: SessionSummaryPagePosition,
  ): SessionSummaryPageEntry[] {
    const rows = (position
      ? this.db.prepare(`
          SELECT *
          FROM sessions_v6
          WHERE session_kind = 'default'
            AND (last_active_at < ? OR (last_active_at = ? AND id < ?))
          ORDER BY last_active_at DESC, id DESC
          LIMIT ?
        `).all(position.lastActiveAt, position.lastActiveAt, position.sessionId, limit)
      : this.db.prepare(`
          SELECT *
          FROM sessions_v6
          WHERE session_kind = 'default'
          ORDER BY last_active_at DESC, id DESC
          LIMIT ?
        `).all(limit)) as SessionV6Row[];
    return rows.map((row) => ({
      summary: this.rowToSessionSummary(row),
      lastActiveAt: row.last_active_at,
    }));
  }

  resolveSessionCrudIdempotency(
    operation: SessionCrudOperation,
    idempotencyKey: string,
    requestFingerprint: string,
    nowIso: string,
  ): SessionCrudReplayResult {
    this.cleanupSessionCrudIdempotency(nowIso);
    return this.resolveSessionCrudIdempotencyWithoutCleanup(operation, idempotencyKey, requestFingerprint);
  }

  insertSessionIdempotently(
    session: Session,
    input: {
      operation: "session.create";
      idempotencyKey: string;
      requestFingerprint: string;
      createdAt: string;
      expiresAt: string;
      projectResult(session: Session): unknown;
    },
  ): { session: Session; result: unknown; replayed: boolean } {
    const normalized = normalizeSessionForStorage(session);
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const replay = this.resolveSessionCrudIdempotencyWithoutCleanup(
        input.operation,
        input.idempotencyKey,
        input.requestFingerprint,
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
        resumed: false,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeSessionFileWrite(input: {
    idempotencyKey: string;
    requestFingerprint: string;
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

  insertSession(session: Session): Session {
    return this.storeSession(session, "create");
  }

  private storeSession(session: Session, operation: "create" | "upsert"): Session {
    const normalized = normalizeSessionForStorage(session);

    const startedAt = Date.now();
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.writeSession(normalized, operation);
      this.db.exec("COMMIT");
      const stored = this.getSession(normalized.id) ?? normalized;
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

  private resolveSessionCrudIdempotencyWithoutCleanup(
    operation: SessionCrudOperation,
    idempotencyKey: string,
    requestFingerprint: string,
  ): SessionCrudReplayResult {
    const row = this.db.prepare(`
      SELECT request_fingerprint, session_id, result_json
      FROM session_crud_idempotency_v6
      WHERE operation = ? AND idempotency_key = ?
    `).get(operation, idempotencyKey) as SessionCrudIdempotencyRow | undefined;
    if (!row) {
      return { kind: "absent" };
    }
    if (row.request_fingerprint !== requestFingerprint) {
      throw new SessionCrudIdempotencyConflictError();
    }
    return {
      kind: "replay",
      sessionId: row.session_id,
      result: JSON.parse(row.result_json) as unknown,
    };
  }

  private insertSessionCrudIdempotency(
    input: {
      operation: SessionCrudOperation;
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
        idempotency_key,
        request_fingerprint,
        session_id,
        result_json,
        created_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.operation,
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
      SELECT request_fingerprint, session_id, relative_path, temp_name, state, result_json
      FROM session_file_write_idempotency_v6
      WHERE operation = 'session.files.write_text' AND idempotency_key = ?
    `).get(idempotencyKey) as SessionFileWriteIdempotencyRow | undefined;
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

function resolveSessionFileWriteIdempotency(
  row: SessionFileWriteIdempotencyRow,
  requestFingerprint: string,
): SessionFileWriteReplayResult {
  if (row.request_fingerprint !== requestFingerprint) {
    throw new SessionFileWriteIdempotencyConflictError();
  }
  if (row.state === "applied") {
    if (!row.result_json) {
      throw new Error("Applied Session file write is missing its canonical result.");
    }
    return {
      kind: "replay",
      sessionId: row.session_id,
      relativePath: row.relative_path,
      tempName: row.temp_name,
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
      error: JSON.parse(row.result_json) as unknown,
    };
  }
  return {
    kind: "pending",
    sessionId: row.session_id,
    relativePath: row.relative_path,
    tempName: row.temp_name,
    resumed: true,
  };
}
