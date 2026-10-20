import type { DatabaseSync } from "node:sqlite";
import { assertFullConversation, conversationMessageColumns, readConversationPage, readConversationQuerySnapshot, readConversationQueryBatch, type ConversationMutationSink, type ConversationQueryRow } from "../storage/conversation-query.js";
import { withMessageRunFailure } from "../../src-shared/session/message-run-failure.js";
import type { ConversationPageRequest } from "../../src-shared/session/conversation-page.js";
import { randomUUID } from "node:crypto";

import {
  normalizeAuxiliarySession,
  projectAuxiliarySessionSummary,
  buildAuxiliaryPreview,
  type AuxiliarySession,
  type AuxiliarySessionSummary,
} from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { CURRENT_SESSION_SCHEMA_VERSION, isReadOnlySession } from "../../src-shared/session/session-state.js";
import { normalizeMessage, summarizeMessageArtifact, type Message, type MessageArtifact } from "../../src-shared/session/session-state.js";
import { openAppDatabase } from "../storage/sqlite-connection.js";
import { writeSessionTurnTerminalCommit, type SessionTurnTerminalCommit } from "../session/session-turn-terminal-commit.js";
import type { ProviderRuntimeMetadataPatch } from "../providers/provider-runtime-metadata-patch.js";
import { insertSessionTurn } from "../session/session-turn-storage-v6.js";
import type { SessionTurnInput, SessionTurnRecord } from "../../src-shared/session/session-turn-state.js";
import type { SessionTurnQueueCapturedInput } from "../../src-shared/session/session-turn-queue.js";
import { assertCharacterDefinitionSnapshotUpdate } from "../session/session-running-turn-start.js";
import type {
  AuxiliaryDraftConsumeInput,
  AuxiliaryDraftConsumeResult,
  AuxiliaryDraftAck,
  AuxiliaryDraftRecord,
  AuxiliaryDraftSaveInput,
  AuxiliaryDraftSaveResult,
  AuxiliarySessionStatus,
} from "../../src-shared/auxiliary/auxiliary-draft-contract.js";

export type AuxiliaryDraftStorageSaveInput = AuxiliaryDraftSaveInput;
export type AuxiliaryDraftStorageConsumeInput = AuxiliaryDraftConsumeInput & { allowRunningInput?: boolean };

type AuxiliarySessionRow = {
  id: string;
  parent_session_id: string;
  status: "active" | "closed";
  created_at: string;
  updated_at: string;
  title: string;
  run_state: "idle" | "running" | "error";
  preview: string;
  provider_id: string;
  catalog_revision: number;
  model_id: string;
  reasoning_effort: string;
  approval_mode: string;
  codex_sandbox_mode: string;
  codex_speed: string;
  codex_reviewer: string;
  custom_agent_name: string;
  allowed_additional_directories_json: string;
  thread_id: string;
  display_after_message_index: number | null;
  closed_at: string;
  character_id: string | null;
  character_snapshot_json: string | null;
  character_snapshot_invalid: number;
  character_icon_path: string | null;
  client_request_id: string | null;
  creation_context_json: string | null;
  creation_request_json: string | null;
};

type AuxiliarySessionSummaryRow = AuxiliarySessionRow & { effective_updated_at?: string };

type AuxiliaryDraftRow = {
  id: string;
  parent_session_id: string;
  incarnation: string;
  durable_revision: number;
  draft_text: string;
  updated_at: string;
};

type ScopedAuxiliarySessionRow = AuxiliarySessionRow & {
  parent_session_id: string;
};

export type AuxiliarySessionThreadPatchInput = {
  auxiliarySessionId: string;
  parentSessionId: string;
  provider: string;
  expectedThreadId: string;
  nextThreadId: string;
  updatedAt: string;
  createdAt: string;
};

export type AuxiliarySessionRuntimeMetadataPatchInput = ProviderRuntimeMetadataPatch & {
  auxiliarySessionId: string;
  parentSessionId: string;
  createdAt: string;
};

export type AuxiliarySessionUpdateIfMatchesInput = {
  session: AuxiliarySession;
  expectedSession: AuxiliarySession;
};

export type AuxiliaryRuntimeWriteInput = {
  auxiliarySessionId: string;
  parentSessionId: string;
  createdAt: string;
  expectedMessageCount: number;
  updatedAt: string;
};
export type AuxiliaryRunningTurnStartInput = AuxiliaryRuntimeWriteInput & {
  userMessage: Message;
  characterRuntimeSnapshot?: AuxiliarySession["characterRuntimeSnapshot"];
  queuedTurn?: { queueId: string; turn: SessionTurnInput };
};
export type AuxiliarySteerAppendInput = AuxiliaryRuntimeWriteInput & { turnId: number; userMessage: Message; queuedInput?: { queueId: string; inputTurnId: string } };
export type AuxiliaryTerminalAppendInput = AuxiliaryRuntimeWriteInput & {
  assistantMessage: Message;
  runState: AuxiliarySession["runState"];
  threadId: string;
  preview: string;
  terminalCommit: SessionTurnTerminalCommit;
};

export type AuxiliaryIdentityPatchInput = {
  auxiliarySessionId: string;
  parentSessionId: string;
  createdAt: string;
  updatedAt: string;
};

export type AuxiliaryExecutionOptions = Pick<AuxiliarySession,
  "provider" | "catalogRevision" | "model" | "reasoningEffort" | "approvalMode"
  | "codexSandboxMode" | "codexSpeed" | "codexReviewer" | "customAgentName">;

export type AuxiliaryCredentialThreadInfo = Pick<AuxiliarySession,
  "id" | "parentSessionId" | "createdAt" | "provider" | "threadId" | "runState">;
export type AuxiliaryThreadPatchResult = Pick<AuxiliarySession, "id" | "parentSessionId" | "threadId">;
export type AuxiliaryRuntimeMetadataPatchResult = Pick<AuxiliarySession,
  "id" | "parentSessionId" | "createdAt" | "provider" | "catalogRevision" | "model"
  | "reasoningEffort" | "threadId" | "updatedAt">;

type TableInfoRow = {
  name: string;
};

const CREATE_AUXILIARY_SESSIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS auxiliary_sessions (
    id TEXT PRIMARY KEY,
    parent_session_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    run_state TEXT NOT NULL DEFAULT 'idle' CHECK (run_state IN ('idle', 'running', 'error')),
    preview TEXT NOT NULL DEFAULT '',
    provider_id TEXT NOT NULL DEFAULT 'codex',
    catalog_revision INTEGER NOT NULL DEFAULT 1,
    model_id TEXT NOT NULL DEFAULT '',
    reasoning_effort TEXT NOT NULL DEFAULT 'medium',
    approval_mode TEXT NOT NULL DEFAULT '',
    codex_sandbox_mode TEXT NOT NULL DEFAULT '',
    codex_speed TEXT NOT NULL DEFAULT '',
    codex_reviewer TEXT NOT NULL DEFAULT '',
    custom_agent_name TEXT NOT NULL DEFAULT '',
    allowed_additional_directories_json TEXT NOT NULL DEFAULT '[]',
    thread_id TEXT NOT NULL DEFAULT '',
    display_after_message_index INTEGER,
    closed_at TEXT NOT NULL DEFAULT '',
    character_id TEXT,
    character_snapshot_json TEXT,
    character_snapshot_invalid INTEGER NOT NULL DEFAULT 0,
    character_icon_path TEXT,
    client_request_id TEXT,
    creation_context_json TEXT,
    creation_request_json TEXT
  )
`;

const CREATE_AUXILIARY_MESSAGES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS auxiliary_session_messages (
    auxiliary_session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    body TEXT NOT NULL CHECK (json_valid(body)),
    artifact_body TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (auxiliary_session_id, seq),
    FOREIGN KEY (auxiliary_session_id) REFERENCES auxiliary_sessions(id) ON DELETE CASCADE
  )
`;

const AUXILIARY_SUMMARY_COLUMNS = `a.id, a.parent_session_id, a.status, a.created_at, a.updated_at,
  a.title, a.run_state, a.preview, a.provider_id, a.catalog_revision, a.model_id,
  a.reasoning_effort, a.approval_mode, a.codex_sandbox_mode, a.codex_speed,
  a.codex_reviewer, a.custom_agent_name, a.allowed_additional_directories_json,
  a.thread_id, a.display_after_message_index, a.closed_at, a.character_id,
  NULL AS character_snapshot_json, 0 AS character_snapshot_invalid, a.character_icon_path,
  a.client_request_id, NULL AS creation_context_json, NULL AS creation_request_json`;

const CREATE_AUXILIARY_SESSION_PARENT_UPDATED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_auxiliary_sessions_parent_updated
    ON auxiliary_sessions(parent_session_id, updated_at DESC)
`;

const CREATE_AUXILIARY_SESSION_DRAFTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS auxiliary_session_drafts (
    auxiliary_session_id TEXT PRIMARY KEY,
    parent_session_id TEXT NOT NULL,
    incarnation TEXT NOT NULL,
    durable_revision INTEGER NOT NULL DEFAULT 0,
    draft_text TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  )
`;

export class AuxiliarySessionStorage {
  private db: DatabaseSync | null;

  constructor(dbPath: string, private readonly onConversationChanged: ConversationMutationSink = () => {}) {
    this.db = openAppDatabase(dbPath);
    try {
      this.initializeSchema();
    } catch (error) {
      this.db.close();
      this.db = null;
      throw error;
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  listAllAuxiliarySessions(): AuxiliarySession[] {
    return this.withDb((db) => {
      const rows = db.prepare(`
        SELECT a.*
        FROM auxiliary_sessions a
        LEFT JOIN auxiliary_session_drafts d ON d.auxiliary_session_id = a.id
        ORDER BY MAX(d.updated_at, a.updated_at) DESC, a.id DESC
      `).all() as AuxiliarySessionRow[];
      return rows
        .map((row) => readAuxiliarySession(db, row))
        .map((session) => session ? this.composeDraft(db, session) : null)
        .filter((session): session is AuxiliarySession => session !== null);
    });
  }

  listAuxiliarySessions(parentSessionId: string): AuxiliarySessionSummary[] {
    return this.withDb((db) => {
      const rows = db.prepare(`
        SELECT ${AUXILIARY_SUMMARY_COLUMNS}, MAX(d.updated_at, a.updated_at) AS effective_updated_at
        FROM auxiliary_sessions a
        LEFT JOIN auxiliary_session_drafts d ON d.auxiliary_session_id = a.id
        WHERE a.parent_session_id = ?
        ORDER BY MAX(d.updated_at, a.updated_at) DESC, a.id DESC
      `).all(parentSessionId) as AuxiliarySessionSummaryRow[];
      return rows
        .map(parseAuxiliarySessionSummaryRow)
        .filter((summary): summary is AuxiliarySessionSummary => summary !== null);
    });
  }

  listAuxiliarySessionSummaries(parentSessionIds: readonly string[]): AuxiliarySessionSummary[] {
    const normalizedParentSessionIds = Array.from(new Set(
      parentSessionIds
        .map((parentSessionId) => parentSessionId.trim())
        .filter(Boolean),
    ));
    if (normalizedParentSessionIds.length === 0) {
      return [];
    }

    return this.withDb((db) => {
      const placeholders = normalizedParentSessionIds.map(() => "?").join(", ");
      const rows = db.prepare(`
        SELECT ${AUXILIARY_SUMMARY_COLUMNS}, MAX(d.updated_at, a.updated_at) AS effective_updated_at
        FROM auxiliary_sessions a
        LEFT JOIN auxiliary_session_drafts d ON d.auxiliary_session_id = a.id
        WHERE a.parent_session_id IN (${placeholders})
        ORDER BY a.parent_session_id ASC, MAX(d.updated_at, a.updated_at) ASC, a.id ASC
      `).all(...normalizedParentSessionIds) as AuxiliarySessionSummaryRow[];
      return rows.flatMap((row) => {
        const summary = parseAuxiliarySessionSummaryRow(row);
        if (!summary || summary.parentSessionId !== row.parent_session_id) {
          return [];
        }
        return [summary];
      });
    });
  }

  listActiveAuxiliarySessionSummaries(parentSessionIds: readonly string[]): AuxiliarySessionSummary[] {
    const normalizedParentSessionIds = Array.from(new Set(
      parentSessionIds
        .map((parentSessionId) => parentSessionId.trim())
        .filter(Boolean),
    ));
    if (normalizedParentSessionIds.length === 0) {
      return [];
    }

    return this.withDb((db) => {
      const placeholders = normalizedParentSessionIds.map(() => "?").join(", ");
      const rows = db.prepare(`
        SELECT ${AUXILIARY_SUMMARY_COLUMNS}, MAX(d.updated_at, a.updated_at) AS effective_updated_at
        FROM auxiliary_sessions a
        LEFT JOIN auxiliary_session_drafts d ON d.auxiliary_session_id = a.id
        WHERE a.status = 'active'
          AND a.parent_session_id IN (${placeholders})
        ORDER BY MAX(d.updated_at, a.updated_at) DESC, a.id DESC
      `).all(...normalizedParentSessionIds) as AuxiliarySessionSummaryRow[];
      return rows.flatMap((row) => {
        const session = parseAuxiliarySessionSummaryRow(row);
        if (
          !session
          || session.status !== "active"
          || session.parentSessionId !== row.parent_session_id
        ) {
          return [];
        }
        return [session];
      });
    });
  }

  listRunningActiveAuxiliarySessions(): AuxiliarySessionSummary[] {
    return this.withDb((db) => {
      const rows = db.prepare(`
        SELECT ${AUXILIARY_SUMMARY_COLUMNS}, MAX(d.updated_at, a.updated_at) AS effective_updated_at
        FROM auxiliary_sessions a
        LEFT JOIN auxiliary_session_drafts d ON d.auxiliary_session_id = a.id
        WHERE a.status = 'active'
        ORDER BY MAX(d.updated_at, a.updated_at) DESC, a.id DESC
      `).all() as AuxiliarySessionSummaryRow[];
      return rows
        .map(parseAuxiliarySessionSummaryRow)
        .filter((session): session is AuxiliarySessionSummary => session?.runState === "running");
    });
  }

  getActiveAuxiliarySession(parentSessionId: string): AuxiliarySession | null {
    return this.withDb((db) => {
      const row = db.prepare(`
        SELECT a.*
        FROM auxiliary_sessions a
        LEFT JOIN auxiliary_session_drafts d ON d.auxiliary_session_id = a.id
        WHERE a.parent_session_id = ?
          AND a.status = 'active'
        ORDER BY MAX(d.updated_at, a.updated_at) DESC, a.id DESC
        LIMIT 1
      `).get(parentSessionId) as AuxiliarySessionRow | undefined;
      const session = row ? readAuxiliarySession(db, row) : null;
      return session ? this.composeDraft(db, session) : null;
    });
  }

  getAuxiliarySession(auxiliarySessionId: string): AuxiliarySession | null {
    return this.withDb((db) => {
      const row = db.prepare(`
        SELECT *
        FROM auxiliary_sessions
        WHERE id = ?
      `).get(auxiliarySessionId) as AuxiliarySessionRow | undefined;
      const session = row ? readAuxiliarySession(db, row) : null;
      return session ? this.composeDraft(db, session) : null;
    });
  }

  getAuxiliarySessionMetadata(auxiliarySessionId: string): AuxiliarySession | null {
    return this.withDb((db) => readAuxiliaryMetadata(db, auxiliarySessionId));
  }

  appendAuxiliaryRunningTurnStart(input: AuxiliaryRunningTurnStartInput): (AuxiliarySession & { queuedTurn?: SessionTurnRecord }) | null {
    let queuedTurn: SessionTurnRecord | undefined;
    const result = this.writeRuntime(input, (db, current) => {
      if (current.runState === "running" || input.userMessage.role !== "user" || !input.userMessage.text.trim()) return false;
      assertCharacterDefinitionSnapshotUpdate(current.characterRuntimeSnapshot, input.characterRuntimeSnapshot,
        current.characterId ?? input.characterRuntimeSnapshot?.characterId ?? "");
      if (input.queuedTurn) {
        const row = db.prepare(`SELECT captured_json FROM session_turn_queue_v6 WHERE id = ?
          AND session_id = ? AND auxiliary_session_id = ? AND incarnation_id = ? AND state = 'starting' AND input_turn_id IS NULL`)
          .get(input.queuedTurn.queueId, current.parentSessionId, current.id, current.createdAt) as { captured_json: string } | undefined;
        if (!row) throw new Error("The Auxiliary queued turn is not starting.");
        const captured = JSON.parse(row.captured_json) as SessionTurnQueueCapturedInput;
        const turn = input.queuedTurn.turn;
        if (captured.request.userMessage !== input.userMessage.text || turn.sessionId !== current.id || turn.phase !== "running"
          || turn.userMessageSeq !== input.expectedMessageCount || turn.assistantMessageSeq !== undefined || turn.completedAt !== undefined
          || turn.provider !== captured.provider || turn.model !== captured.request.executionOptions.model
          || turn.reasoningEffort !== captured.request.executionOptions.reasoningEffort
          || turn.approvalMode !== captured.request.executionOptions.approvalMode || turn.sandboxMode !== captured.request.executionOptions.codexSandboxMode) {
          throw new Error("The Auxiliary queued turn does not match its captured request.");
        }
        queuedTurn = insertSessionTurn(db, { sessionId: null, auxiliarySessionId: current.id }, turn);
        const result = db.prepare(`UPDATE session_turn_queue_v6 SET state = 'running', turn_id = ?, user_message_seq = ?, updated_at = ?
          WHERE id = ? AND state = 'starting' AND input_turn_id IS NULL`)
          .run(String(queuedTurn.id), input.expectedMessageCount, input.updatedAt, input.queuedTurn.queueId);
        if (Number(result.changes) !== 1) throw new Error("The Auxiliary queued turn could not be committed.");
      }
      insertAuxiliaryMessage(db, current.id, input.expectedMessageCount, input.userMessage, input.updatedAt);
      db.prepare(`UPDATE auxiliary_sessions SET run_state = 'running', status = 'active', closed_at = '',
        character_id = COALESCE(character_id, ?), character_snapshot_json = ?, preview = ?, updated_at = ? WHERE id = ?`).run(
        input.characterRuntimeSnapshot?.characterId ?? null,
        input.characterRuntimeSnapshot === undefined ? (current.characterRuntimeSnapshot ? JSON.stringify(current.characterRuntimeSnapshot) : null)
          : input.characterRuntimeSnapshot === null ? null : JSON.stringify(input.characterRuntimeSnapshot),
        current.preview || buildAuxiliaryPreview([input.userMessage]), input.updatedAt, current.id);
      return true;
    }, true);
    return result ? { ...result, ...(queuedTurn ? { queuedTurn } : {}) } : null;
  }

  appendAuxiliarySteer(input: AuxiliarySteerAppendInput): AuxiliarySession | null {
    return this.writeRuntime(input, (db, current) => {
      if (current.runState !== "running" || input.userMessage.role !== "user" || !input.userMessage.text.trim()
        || !db.prepare(`SELECT id FROM session_turns_v6 WHERE id = ? AND session_id IS NULL
          AND auxiliary_session_id = ? AND phase = 'running'`).get(input.turnId, current.id)) return false;
      if (input.queuedInput) {
        if (!db.prepare("SELECT 1 FROM session_turns_v6 WHERE id = ? AND id = (SELECT MAX(id) FROM session_turns_v6 WHERE auxiliary_session_id = ?)")
          .get(input.turnId, current.id)) throw new Error("The current Auxiliary queued input turn no longer matches.");
        const receipt = db.prepare(`SELECT captured_json FROM session_turn_queue_v6 WHERE id = ?
          AND session_id = ? AND auxiliary_session_id = ? AND incarnation_id = ?
          AND state = 'starting' AND input_turn_id = ? AND user_message_seq IS NULL`)
          .get(input.queuedInput.queueId, current.parentSessionId, current.id, current.createdAt, input.queuedInput.inputTurnId) as { captured_json: string } | undefined;
        if (!receipt || (JSON.parse(receipt.captured_json) as SessionTurnQueueCapturedInput).request.userMessage !== input.userMessage.text) {
          throw new Error("The Auxiliary queued input does not match its captured message.");
        }
      }
      insertAuxiliaryMessage(db, current.id, input.expectedMessageCount, input.userMessage, input.updatedAt);
      if (input.queuedInput) {
        const result = db.prepare(`UPDATE session_turn_queue_v6 SET state = 'completed', turn_id = ?, user_message_seq = ?, updated_at = ?
          WHERE id = ? AND state = 'starting' AND input_turn_id = ?`)
          .run(String(input.turnId), input.expectedMessageCount, input.updatedAt, input.queuedInput.queueId, input.queuedInput.inputTurnId);
        if (Number(result.changes) !== 1) throw new Error("The Auxiliary queued input could not be committed.");
      }
      db.prepare("UPDATE auxiliary_sessions SET updated_at = ? WHERE id = ?").run(input.updatedAt, current.id);
      return true;
    }, true);
  }

  appendAuxiliaryTerminal(input: AuxiliaryTerminalAppendInput): AuxiliarySession | null {
    return this.writeRuntime(input, (db, current) => {
      const commit = input.terminalCommit;
      if (current.runState !== "running" || input.assistantMessage.role !== "assistant" || input.runState === "running"
        || commit.sessionId !== current.id || commit.assistantMessageSeq !== input.expectedMessageCount) return false;
      insertAuxiliaryMessage(db, current.id, input.expectedMessageCount, input.assistantMessage, input.updatedAt);
      db.prepare(`UPDATE auxiliary_sessions SET run_state = ?, status = 'active', closed_at = '',
        thread_id = ?, preview = ?, updated_at = ? WHERE id = ?`)
        .run(input.runState, input.threadId, input.preview, input.updatedAt, current.id);
      const result = db.prepare(`UPDATE session_turns_v6 SET phase = ?, assistant_message_seq = ?, thread_id = ?,
        error_summary = ?, completed_at = ?, updated_at = ? WHERE id = ? AND session_id IS NULL
        AND auxiliary_session_id = ? AND phase = 'running'`).run(commit.phase, commit.assistantMessageSeq,
        commit.threadId, commit.errorMessage, commit.completedAt, commit.completedAt, commit.turnId, current.id);
      if (Number(result.changes) !== 1) throw new Error(`Auxiliary turn terminal commit target mismatch: ${commit.turnId}`);
      const queueResult = db.prepare(`UPDATE session_turn_queue_v6 SET state = ?, reason = ?, updated_at = ?
        WHERE auxiliary_session_id = ? AND session_id = ? AND incarnation_id = ? AND turn_id = ?
          AND state = 'running' AND input_turn_id IS NULL
          AND user_message_seq = (SELECT user_message_seq FROM session_turns_v6 WHERE id = ? AND auxiliary_session_id = ?)`)
        .run(commit.phase, commit.errorMessage || null, commit.completedAt, current.id, current.parentSessionId,
          current.createdAt, String(commit.turnId), commit.turnId, current.id);
      if (Number(queueResult.changes) === 0 && db.prepare(`SELECT 1 FROM session_turn_queue_v6
        WHERE auxiliary_session_id = ? AND incarnation_id = ? AND turn_id = ? AND state = 'running' AND input_turn_id IS NULL`)
        .get(current.id, current.createdAt, String(commit.turnId))) throw new Error("The Auxiliary queued terminal receipt does not match.");
      return true;
    }, true);
  }

  checkpointAuxiliaryRuntimeMetadata(input: AuxiliaryRuntimeWriteInput & {
    threadId: string; provider: string; expectedThreadId: string; expectedRunState: AuxiliarySession["runState"];
    runState: AuxiliarySession["runState"];
  }): AuxiliarySession | null {
    return this.writeRuntime(input, (db, current) => {
      if (current.provider !== input.provider || current.threadId !== input.expectedThreadId || current.runState !== input.expectedRunState) return false;
      db.prepare("UPDATE auxiliary_sessions SET thread_id = ?, run_state = ?, updated_at = ? WHERE id = ?")
        .run(input.threadId, input.runState, input.updatedAt, current.id);
      return true;
    }, false);
  }

  private writeRuntime(input: AuxiliaryRuntimeWriteInput,
    write: (db: DatabaseSync, current: AuxiliarySession) => boolean, changesConversation: boolean): AuxiliarySession | null {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const current = readAuxiliaryMetadata(db, input.auxiliarySessionId);
        if (!Number.isSafeInteger(input.expectedMessageCount) || input.expectedMessageCount < 0
          || !current || current.parentSessionId !== input.parentSessionId || current.createdAt !== input.createdAt
          || current.characterRuntimeSnapshotInvalid || current.messageCount !== input.expectedMessageCount
          || !hasWritableAuxiliaryParent(db, current.parentSessionId) || !write(db, current)) {
          db.exec("ROLLBACK"); return null;
        }
        const saved = readAuxiliaryMetadata(db, current.id);
        if (!saved) throw new Error("The Auxiliary Session could not be read after saving.");
        db.exec("COMMIT");
        if (changesConversation) this.onConversationChanged("auxiliary_session_messages", current.id);
        return saved;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    });
  }

  getConversationPage(auxiliarySessionId: string, request?: ConversationPageRequest) {
    return this.withDb((db) => {
      const row = db.prepare("SELECT * FROM auxiliary_sessions WHERE id = ?").get(auxiliarySessionId) as AuxiliarySessionRow | undefined;
      return row ? readConversationPage(db, "auxiliary_session_messages", row.id, row.created_at, request) : null;
    });
  }

  getAuxiliarySessionView(auxiliarySessionId: string): AuxiliarySession | null {
    return this.withDb((db) => {
      const row = db.prepare("SELECT * FROM auxiliary_sessions WHERE id = ?").get(auxiliarySessionId) as AuxiliarySessionRow | undefined;
      if (!row) return null;
      const session = parseAuxiliarySessionRow(row);
      if (!session) return null;
      const page = readConversationPage(db, "auxiliary_session_messages", row.id, row.created_at);
      return this.composeDraft(db, { ...session, messages: page.messages, messageCount: page.totalCount });
    });
  }

  getConversationQuerySnapshot(sessionId: string) {
    return this.withDb((db) => readConversationQuerySnapshot(db, "auxiliary_session_messages", sessionId));
  }

  readConversationQueryBatch(sessionId: string, afterSeq: number) {
    return this.withDb((db) => readConversationQueryBatch(db, "auxiliary_session_messages", sessionId, afterSeq));
  }

  getAuxiliaryDraft(auxiliarySessionId: string): AuxiliaryDraftRecord | null {
    return this.withDb((db) => {
      const row = db.prepare(`
        SELECT auxiliary_session_id AS id, parent_session_id, incarnation,
          durable_revision, draft_text, updated_at
        FROM auxiliary_session_drafts
        WHERE auxiliary_session_id = ?
      `).get(auxiliarySessionId) as AuxiliaryDraftRow | undefined;
      return row ? toDraftRecord(row) : null;
    });
  }

  getAuxiliarySessionStatus(auxiliarySessionId: string): AuxiliarySessionStatus | null {
    return this.withDb((db) => {
      const row = db.prepare(`
        SELECT a.id, a.parent_session_id, a.status, a.created_at, a.run_state, d.incarnation
        FROM auxiliary_sessions a LEFT JOIN auxiliary_session_drafts d ON d.auxiliary_session_id = a.id
        WHERE a.id = ?
      `).get(auxiliarySessionId) as { id: string; parent_session_id: string; status: "active" | "closed"; created_at: string; run_state: AuxiliarySession["runState"]; incarnation?: string } | undefined;
      if (!row) return null;
      return {
        id: row.id,
        parentSessionId: row.parent_session_id,
        status: row.status,
        createdAt: row.created_at,
        incarnation: row.incarnation ?? "",
        runState: row.run_state,
      };
    });
  }

  saveAuxiliaryDraft(input: AuxiliaryDraftStorageSaveInput): AuxiliaryDraftSaveResult {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const session = db.prepare(`
          SELECT id, parent_session_id, status, created_at
          FROM auxiliary_sessions WHERE id = ?
        `).get(input.auxiliarySessionId) as { id: string; parent_session_id: string; status: "active" | "closed"; created_at: string } | undefined;
        const row = db.prepare(`
          SELECT auxiliary_session_id AS id, parent_session_id, incarnation,
            durable_revision, draft_text, updated_at
          FROM auxiliary_session_drafts WHERE auxiliary_session_id = ?
        `).get(input.auxiliarySessionId) as AuxiliaryDraftRow | undefined;
        if (!session) {
          db.exec("ROLLBACK");
          return { outcome: "not-found" };
        }
        if (!session || !hasWritableAuxiliaryParent(db, session.parent_session_id)) {
          db.exec("ROLLBACK");
          return { outcome: "rejected" };
        }
        if (session.parent_session_id !== input.parentSessionId) {
          db.exec("ROLLBACK");
          return { outcome: "not-found" };
        }
        if (!row || row.parent_session_id !== input.parentSessionId) {
          db.exec("ROLLBACK");
          return { outcome: "not-found" };
        }
        const current = row;
        if (current.incarnation !== input.incarnation || current.durable_revision !== input.expectedDurableRevision) {
          db.exec("ROLLBACK");
          return { outcome: "stale", ...(row ? { ack: toDraftAck(row) } : {}) };
        }
        const next: AuxiliaryDraftRecord = {
          auxiliarySessionId: input.auxiliarySessionId,
          parentSessionId: input.parentSessionId,
          incarnation: input.incarnation,
          durableRevision: current.durable_revision + 1,
          text: input.text,
          updatedAt: input.updatedAt,
        };
        const result = db.prepare(`
          UPDATE auxiliary_session_drafts
          SET durable_revision = ?, draft_text = ?, updated_at = ?
          WHERE auxiliary_session_id = ? AND parent_session_id = ?
            AND incarnation = ? AND durable_revision = ?
        `).run(
          next.durableRevision, next.text, next.updatedAt,
          next.auxiliarySessionId, next.parentSessionId, next.incarnation, input.expectedDurableRevision,
        );
        if (Number(result.changes) !== 1) {
          db.exec("ROLLBACK");
          return { outcome: "stale", ack: toDraftAck(current) };
        }
        db.exec("COMMIT");
        return { outcome: "saved", ack: toDraftAck(next) };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  consumeAuxiliaryDraft(input: AuxiliaryDraftStorageConsumeInput): AuxiliaryDraftConsumeResult {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const result = consumeAuxiliaryDraftInTransaction(db, input);
        if (result.outcome !== "consumed") { db.exec("ROLLBACK"); return result; }
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  updateAuxiliarySessionThreadIfMatches(input: AuxiliarySessionThreadPatchInput): AuxiliaryThreadPatchResult | null {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const row = db.prepare(`
          SELECT id, parent_session_id, created_at, updated_at, provider_id, thread_id
          FROM auxiliary_sessions
          WHERE id = ? AND parent_session_id = ?
        `).get(input.auxiliarySessionId, input.parentSessionId) as Pick<AuxiliarySessionRow,
          "id" | "parent_session_id" | "created_at" | "updated_at" | "provider_id" | "thread_id"> | undefined;
        if (!row || row.provider_id !== input.provider || row.thread_id !== input.expectedThreadId || (input.createdAt !== undefined && row.created_at !== input.createdAt)) {
          db.exec("ROLLBACK");
          return null;
        }
        const result = db.prepare(`
          UPDATE auxiliary_sessions SET updated_at = ?, thread_id = ?
          WHERE id = ? AND parent_session_id = ? AND updated_at = ?
        `).run(input.updatedAt, input.nextThreadId, input.auxiliarySessionId, input.parentSessionId, row.updated_at);
        if (Number(result.changes) !== 1) {
          db.exec("ROLLBACK");
          return null;
        }
        db.exec("COMMIT");
        return { id: row.id, parentSessionId: row.parent_session_id, threadId: input.nextThreadId };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  updateAuxiliarySessionRuntimeMetadataIfMatches(
    input: AuxiliarySessionRuntimeMetadataPatchInput,
  ): AuxiliaryRuntimeMetadataPatchResult | null {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const row = db.prepare(`
          SELECT id, parent_session_id, created_at, updated_at, provider_id, catalog_revision, model_id, reasoning_effort, thread_id
          FROM auxiliary_sessions
          WHERE id = ? AND parent_session_id = ?
        `).get(input.auxiliarySessionId, input.parentSessionId) as Pick<AuxiliarySessionRow,
          "id" | "parent_session_id" | "created_at" | "updated_at" | "provider_id" | "catalog_revision" | "model_id" | "reasoning_effort" | "thread_id"> | undefined;
        if (
          !row ||
          row.created_at !== input.createdAt ||
          row.provider_id !== input.expected.provider ||
          row.catalog_revision !== input.expected.catalogRevision ||
          row.model_id !== input.expected.model ||
          row.reasoning_effort !== input.expected.reasoningEffort ||
          row.thread_id !== input.expected.threadId
        ) {
          db.exec("ROLLBACK");
          return null;
        }
        const result = db.prepare(`
          UPDATE auxiliary_sessions SET updated_at = ?, provider_id = ?, catalog_revision = ?,
            model_id = ?, reasoning_effort = ?, thread_id = ?
          WHERE id = ? AND parent_session_id = ? AND created_at = ? AND updated_at = ?
        `).run(
          input.next.updatedAt,
          input.next.provider, input.next.catalogRevision, input.next.model, input.next.reasoningEffort, input.next.threadId,
          input.auxiliarySessionId,
          input.parentSessionId,
          input.createdAt,
          row.updated_at,
        );
        if (Number(result.changes) !== 1) {
          db.exec("ROLLBACK");
          return null;
        }
        db.exec("COMMIT");
        return { id: row.id, parentSessionId: row.parent_session_id, createdAt: row.created_at,
          provider: input.next.provider, catalogRevision: input.next.catalogRevision, model: input.next.model,
          reasoningEffort: input.next.reasoningEffort, threadId: input.next.threadId, updatedAt: input.next.updatedAt };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  updateAuxiliarySessionIfMatches(input: AuxiliarySessionUpdateIfMatchesInput): AuxiliarySession | null {
    return this.storeAuxiliarySessionIfMatches(input);
  }

  updateTerminalAuxiliarySessionIfMatches(
    input: AuxiliarySessionUpdateIfMatchesInput,
    terminalCommit: SessionTurnTerminalCommit,
  ): AuxiliarySession | null {
    if (terminalCommit.sessionId !== input.session.id) {
      throw new Error("The terminal Auxiliary Session owner does not match the turn marker.");
    }
    return this.storeAuxiliarySessionIfMatches(input, terminalCommit);
  }

  private storeAuxiliarySessionIfMatches(
    input: AuxiliarySessionUpdateIfMatchesInput,
    terminalCommit?: SessionTurnTerminalCommit,
  ): AuxiliarySession | null {
    assertFullConversation(input.session);
    assertFullConversation(input.expectedSession);
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const row = db.prepare(`
          SELECT *
          FROM auxiliary_sessions
          WHERE id = ? AND parent_session_id = ? AND created_at = ?
        `).get(input.expectedSession.id, input.expectedSession.parentSessionId, input.expectedSession.createdAt) as AuxiliarySessionRow | undefined;
        const current = row ? readAuxiliarySession(db, row) : null;
        const parentTables = (db.prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN ('sessions_v6', 'sessions')
        `).all() as Array<{ name: string }>);
        const hasV6ParentTable = parentTables.some(({ name }) => name === "sessions_v6");
        const parent = parentTables.filter(({ name }) => name !== (hasV6ParentTable ? "sessions" : "sessions_v6")).some(({ name }) => {
          const row = db.prepare(`SELECT 1 AS present FROM ${name} WHERE id = ? LIMIT 1`).get(input.expectedSession.parentSessionId);
          return Boolean(row);
        });
        const expected = normalizeAuxiliarySession(input.expectedSession);
        const draftRow = db.prepare("SELECT draft_text FROM auxiliary_session_drafts WHERE auxiliary_session_id = ?")
          .get(input.expectedSession.id) as { draft_text: string } | undefined;
        const currentWithDraft = current && draftRow ? { ...current, composerDraft: draftRow.draft_text } : current;
        const currentRuntime = currentWithDraft && { ...currentWithDraft, updatedAt: input.expectedSession.updatedAt,
          composerDraft: "", preview: currentWithDraft.preview ?? "",
          messages: currentWithDraft.messages.map((message) => ({ ...message, isBookmarked: undefined })) };
        const expectedRuntime = expected && { ...expected, composerDraft: "", preview: expected.preview ?? current?.preview ?? "",
          messages: expected.messages.map((message) => ({ ...message,
            artifact: message.artifact ? summarizeMessageArtifact(message.artifact) : undefined,
            isBookmarked: undefined })) };
        if (!row || !current || !expected || input.session.id !== expected.id || input.session.parentSessionId !== expected.parentSessionId
          || input.session.createdAt !== expected.createdAt || JSON.stringify(currentRuntime) !== JSON.stringify(expectedRuntime) || !parent) {
          db.exec("ROLLBACK");
          return null;
        }
        const result = db.prepare(`
          UPDATE auxiliary_sessions
          SET updated_at = ?
          WHERE id = ? AND parent_session_id = ? AND created_at = ? AND updated_at = ?
        `).run(
          input.session.updatedAt,
          input.session.id, input.expectedSession.parentSessionId, input.expectedSession.createdAt, row.updated_at,
        );
        if (Number(result.changes) !== 1) {
          db.exec("ROLLBACK");
          return null;
        }
        writeAuxiliaryMetadata(db, input.session);
        const conversationChanged = writeAuxiliaryMessages(db, input.session);
        const storedRow = db.prepare(`SELECT * FROM auxiliary_sessions WHERE id = ?`).get(input.session.id) as AuxiliarySessionRow | undefined;
        const stored = storedRow ? readAuxiliarySession(db, storedRow) : null;
        if (!stored) throw new Error("The Auxiliary Session could not be read after saving.");
        if (terminalCommit) writeSessionTurnTerminalCommit(db, terminalCommit, "auxiliary");
        db.exec("COMMIT");
        if (conversationChanged) this.onConversationChanged("auxiliary_session_messages", input.session.id);
        return { ...stored, composerDraft: currentWithDraft?.composerDraft ?? "" };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  upsertAuxiliarySession(session: AuxiliarySession): AuxiliarySession {
    assertFullConversation(session);
    return this.withDb((db) => {
      const existing = db.prepare("SELECT draft_text FROM auxiliary_session_drafts WHERE auxiliary_session_id = ?")
        .get(session.id) as { draft_text: string } | undefined;
      const persisted = existing ? { ...session, composerDraft: existing.draft_text } : session;
      const previousOwner = db.prepare("SELECT parent_session_id, created_at FROM auxiliary_sessions WHERE id = ?")
        .get(session.id) as { parent_session_id: string; created_at: string } | undefined;
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        db.prepare(`INSERT OR IGNORE INTO auxiliary_sessions
          (id, parent_session_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)`)
          .run(session.id, session.parentSessionId, session.status, session.createdAt, session.updatedAt);
        writeAuxiliaryMetadata(db, persisted);
        const conversationChanged = writeAuxiliaryMessages(db, persisted);
        db.prepare(`
          INSERT OR IGNORE INTO auxiliary_session_drafts
            (auxiliary_session_id, parent_session_id, incarnation, durable_revision, draft_text, updated_at)
          VALUES (?, ?, ?, 0, ?, ?)
        `).run(session.id, session.parentSessionId, randomUUID(), session.composerDraft, session.updatedAt);
        db.exec("COMMIT");
        if (conversationChanged || !existing || previousOwner?.parent_session_id !== session.parentSessionId || previousOwner?.created_at !== session.createdAt)
          this.onConversationChanged("auxiliary_session_messages", session.id);
        return persisted;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  deleteAuxiliarySessionsForParent(parentSessionId: string): void {
    this.withDb((db) => {
      const ids = db.prepare("SELECT id FROM auxiliary_sessions WHERE parent_session_id = ?").all(parentSessionId) as Array<{ id: string }>;
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        db.prepare("DELETE FROM auxiliary_sessions WHERE parent_session_id = ?").run(parentSessionId);
        db.prepare("DELETE FROM auxiliary_session_drafts WHERE parent_session_id = ?").run(parentSessionId);
        db.exec("COMMIT");
        ids.forEach(({ id }) => this.onConversationChanged("auxiliary_session_messages", id));
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  deleteAuxiliarySessionsExceptParents(parentSessionIds: Iterable<string>): void {
    const retainedParentSessionIds = Array.from(new Set(parentSessionIds));
    this.withDb((db) => {
      const removed = (db.prepare("SELECT id, parent_session_id FROM auxiliary_sessions").all() as Array<{ id: string; parent_session_id: string }>)
        .filter((row) => !retainedParentSessionIds.includes(row.parent_session_id));
      if (retainedParentSessionIds.length === 0) {
        db.prepare("DELETE FROM auxiliary_sessions").run();
        db.prepare("DELETE FROM auxiliary_session_drafts").run();
        removed.forEach(({ id }) => this.onConversationChanged("auxiliary_session_messages", id));
        return;
      }

      const placeholders = retainedParentSessionIds.map(() => "?").join(", ");
      db.prepare(`DELETE FROM auxiliary_sessions WHERE parent_session_id NOT IN (${placeholders})`)
        .run(...retainedParentSessionIds);
      db.prepare(`DELETE FROM auxiliary_session_drafts WHERE parent_session_id NOT IN (${placeholders})`)
        .run(...retainedParentSessionIds);
      removed.forEach(({ id }) => this.onConversationChanged("auxiliary_session_messages", id));
    });
  }

  private initializeSchema(): void {
    this.withDb((db) => {
      db.exec(CREATE_AUXILIARY_SESSIONS_TABLE_SQL);
      ensureAuxiliarySessionCreatedAtColumn(db);
      db.exec(CREATE_AUXILIARY_SESSION_PARENT_UPDATED_INDEX_SQL);
      db.exec(CREATE_AUXILIARY_SESSION_DRAFTS_TABLE_SQL);
      migrateAuxiliaryStorage(db);
      db.exec("DROP INDEX IF EXISTS idx_auxiliary_sessions_parent_created");
    });
  }

  getAuxiliarySessionSummary(auxiliarySessionId: string): AuxiliarySessionSummary | null {
    return this.withDb((db) => {
      const row = db.prepare(`SELECT ${AUXILIARY_SUMMARY_COLUMNS} FROM auxiliary_sessions a WHERE a.id = ?`)
        .get(auxiliarySessionId) as AuxiliarySessionRow | undefined;
      return row ? parseAuxiliarySessionSummaryRow(row) : null;
    });
  }

  listAuxiliaryCredentialThreads(): AuxiliaryCredentialThreadInfo[] {
    return this.withDb((db) => (db.prepare(`SELECT id, parent_session_id, created_at,
      provider_id, thread_id, run_state FROM auxiliary_sessions`)
      .all() as Array<Pick<AuxiliarySessionRow,
        "id" | "parent_session_id" | "created_at" | "provider_id" | "thread_id" | "run_state">>).map((row) => {
      return { id: row.id, parentSessionId: row.parent_session_id, createdAt: row.created_at,
        provider: row.provider_id, threadId: row.thread_id, runState: row.run_state };
    }));
  }

  getAuxiliaryMessageArtifactDetail(auxiliarySessionId: string, messageIndex: number): MessageArtifact | null {
    return this.withDb((db) => {
      const row = db.prepare(`SELECT artifact_body FROM auxiliary_session_messages
        WHERE auxiliary_session_id = ? AND seq = ?`).get(auxiliarySessionId, messageIndex) as { artifact_body: string | null } | undefined;
      if (!row || row.artifact_body === null) return null;
      const artifact: unknown = JSON.parse(row.artifact_body);
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
        throw new Error("Stored Auxiliary message artifact must be a JSON object.");
      }
      const normalized = normalizeMessage({ role: "assistant", text: "", artifact })?.artifact;
      if (!normalized) throw new Error("Stored Auxiliary message artifact could not be normalized.");
      return normalized;
    });
  }

  updateAuxiliaryTitleIfMatches(input: AuxiliaryIdentityPatchInput & { title: string }): boolean {
    return this.updateScalarIfMatches(input, "title = ?", [input.title], true);
  }

  updateAuxiliaryExecutionOptionsIfMatches(input: AuxiliaryIdentityPatchInput & { options: AuxiliaryExecutionOptions }): boolean {
    const options = input.options;
    return this.updateScalarIfMatches(input,
      `provider_id = ?, catalog_revision = ?, model_id = ?, reasoning_effort = ?, approval_mode = ?,
        codex_sandbox_mode = ?, codex_speed = ?, codex_reviewer = ?, custom_agent_name = ?`,
      [options.provider, options.catalogRevision, options.model, options.reasoningEffort,
        options.approvalMode, options.codexSandboxMode, options.codexSpeed, options.codexReviewer, options.customAgentName]);
  }

  updateAuxiliaryDisplayAnchorIfMatches(input: AuxiliaryIdentityPatchInput & { displayAfterMessageIndex: number | null }): boolean {
    return this.updateScalarIfMatches(input, "display_after_message_index = ?", [input.displayAfterMessageIndex]);
  }

  updateAuxiliaryMessageBookmarkIfMatches(input: AuxiliaryIdentityPatchInput & {
    messageIndex: number; isBookmarked: boolean;
  }): boolean {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const owner = hasWritableAuxiliaryParent(db, input.parentSessionId)
          ? db.prepare(`SELECT id FROM auxiliary_sessions WHERE id = ? AND parent_session_id = ? AND created_at = ? AND status = 'active'`)
          .get(input.auxiliarySessionId, input.parentSessionId, input.createdAt)
          : undefined;
        const row = owner ? db.prepare(`SELECT body FROM auxiliary_session_messages WHERE auxiliary_session_id = ? AND seq = ?`)
          .get(input.auxiliarySessionId, input.messageIndex) as { body: string } | undefined : undefined;
        if (!row) { db.exec("ROLLBACK"); return false; }
        const message = normalizeMessage(JSON.parse(row.body));
        if (!message) throw new Error("Invalid Auxiliary message.");
        db.prepare(`UPDATE auxiliary_session_messages SET body = ? WHERE auxiliary_session_id = ? AND seq = ?`)
          .run(JSON.stringify({ ...message, isBookmarked: input.isBookmarked ? true : undefined }), input.auxiliarySessionId, input.messageIndex);
        db.prepare(`UPDATE auxiliary_sessions SET updated_at = ? WHERE id = ?`).run(input.updatedAt, input.auxiliarySessionId);
        db.exec("COMMIT");
        if ((message.isBookmarked === true) !== input.isBookmarked) this.onConversationChanged("auxiliary_session_messages", input.auxiliarySessionId);
        return true;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    });
  }

  private updateScalarIfMatches(input: AuxiliaryIdentityPatchInput, assignments: string,
    values: Array<string | number | null>, requireIdle = false): boolean {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        if (!hasWritableAuxiliaryParent(db, input.parentSessionId)) { db.exec("ROLLBACK"); return false; }
        const result = db.prepare(`UPDATE auxiliary_sessions SET ${assignments}, updated_at = ?
          WHERE id = ? AND parent_session_id = ? AND created_at = ? AND status = 'active' ${requireIdle ? "AND run_state <> 'running'" : ""}`)
          .run(...values, input.updatedAt, input.auxiliarySessionId, input.parentSessionId, input.createdAt);
        db.exec("COMMIT");
        return Number(result.changes) === 1;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    });
  }

  private composeDraft(db: DatabaseSync, session: AuxiliarySession): AuxiliarySession {
    const row = db.prepare(`SELECT draft_text FROM auxiliary_session_drafts WHERE auxiliary_session_id = ?`)
      .get(session.id) as { draft_text: string } | undefined;
    return row ? { ...session, composerDraft: row.draft_text } : session;
  }

  private withDb<T>(runner: (db: DatabaseSync) => T): T {
    if (!this.db) {
      throw new Error("AuxiliarySessionStorage は close 済みだよ。");
    }

    return runner(this.db);
  }
}

function parseAuxiliarySessionPayload(payloadJson: string): AuxiliarySession | null {
  try {
    return normalizeAuxiliarySession(JSON.parse(payloadJson));
  } catch {
    return null;
  }
}

function parseAuxiliarySessionRow(row: AuxiliarySessionRow): AuxiliarySession | null {
  try {
    return normalizeAuxiliarySession({
      id: row.id,
      parentSessionId: row.parent_session_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      title: row.title,
      runState: row.run_state,
      preview: row.preview,
      provider: row.provider_id,
      catalogRevision: row.catalog_revision,
      model: row.model_id,
      reasoningEffort: row.reasoning_effort,
      approvalMode: row.approval_mode,
      codexSandboxMode: row.codex_sandbox_mode,
      codexSpeed: row.codex_speed,
      codexReviewer: row.codex_reviewer,
      customAgentName: row.custom_agent_name,
      allowedAdditionalDirectories: JSON.parse(row.allowed_additional_directories_json),
      threadId: row.thread_id,
      displayAfterMessageIndex: row.display_after_message_index,
      closedAt: row.closed_at,
      characterId: row.character_id ?? undefined,
      characterRuntimeSnapshot: row.character_snapshot_json ? JSON.parse(row.character_snapshot_json) : undefined,
      characterRuntimeSnapshotInvalid: row.character_snapshot_invalid === 1,
      characterIconPath: row.character_icon_path ?? undefined,
      clientRequestId: row.client_request_id ?? undefined,
      creationContext: row.creation_context_json ? JSON.parse(row.creation_context_json) : undefined,
      creationRequest: row.creation_request_json ? JSON.parse(row.creation_request_json) : undefined,
      messages: [],
    });
  } catch {
    return null;
  }
}

function readAuxiliarySession(db: DatabaseSync, row: AuxiliarySessionRow): AuxiliarySession | null {
  const session = parseAuxiliarySessionRow(row);
  if (!session) return null;
  const messages = db.prepare(`SELECT ${conversationMessageColumns("auxiliary_session_messages", db)} FROM auxiliary_session_messages
    WHERE auxiliary_session_id = ? ORDER BY seq ASC`).all(row.id) as ConversationQueryRow[];
  return { ...session, messages: messages.map(({ body, runFailure }) => {
    const message = normalizeMessage(JSON.parse(body));
    if (!message) throw new Error(`Invalid Auxiliary message: ${row.id}`);
    return withMessageRunFailure(message, runFailure);
  }) };
}

function readAuxiliaryMetadata(db: DatabaseSync, id: string): AuxiliarySession | null {
  const row = db.prepare("SELECT * FROM auxiliary_sessions WHERE id = ?").get(id) as AuxiliarySessionRow | undefined;
  const session = row ? parseAuxiliarySessionRow(row) : null;
  if (!session) return null;
  const count = db.prepare("SELECT COUNT(*) AS count FROM auxiliary_session_messages WHERE auxiliary_session_id = ?")
    .get(id) as { count: number };
  return { ...session, messageCount: count.count };
}

function insertAuxiliaryMessage(db: DatabaseSync, id: string, seq: number, message: Message, updatedAt: string): void {
  const normalized = normalizeMessage(message);
  if (!normalized) throw new Error("Invalid Auxiliary message.");
  const artifact = normalized.artifact;
  if (artifact?.detailAvailable) throw new Error("Auxiliary appended artifact must contain its full detail.");
  const body = JSON.stringify({ ...normalized, historyIndex: undefined,
    artifact: artifact ? summarizeMessageArtifact(artifact) : undefined });
  db.prepare(`INSERT INTO auxiliary_session_messages (auxiliary_session_id, seq, role, body, artifact_body, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, seq, normalized.role, body, artifact ? JSON.stringify(artifact) : null, updatedAt);
}

function writeAuxiliaryMetadata(db: DatabaseSync, session: AuxiliarySession): void {
  db.prepare(`UPDATE auxiliary_sessions SET parent_session_id = ?, status = ?, created_at = ?, updated_at = ?,
    title = ?, run_state = ?, preview = ?, provider_id = ?, catalog_revision = ?, model_id = ?, reasoning_effort = ?,
    approval_mode = ?, codex_sandbox_mode = ?, codex_speed = ?, codex_reviewer = ?, custom_agent_name = ?,
    allowed_additional_directories_json = ?, thread_id = ?, display_after_message_index = ?, closed_at = ?,
    character_id = ?, character_snapshot_json = ?, character_snapshot_invalid = ?, character_icon_path = ?,
    client_request_id = ?, creation_context_json = ?, creation_request_json = ? WHERE id = ?`).run(
    session.parentSessionId, session.status, session.createdAt, session.updatedAt,
    session.title, session.runState, session.preview ?? buildAuxiliaryPreview(session.messages),
    session.provider, session.catalogRevision, session.model, session.reasoningEffort,
    session.approvalMode, session.codexSandboxMode, session.codexSpeed, session.codexReviewer,
    session.customAgentName, JSON.stringify(session.allowedAdditionalDirectories), session.threadId,
    session.displayAfterMessageIndex, session.closedAt, session.characterId ?? null,
    session.characterRuntimeSnapshot === undefined ? null : JSON.stringify(session.characterRuntimeSnapshot),
    session.characterRuntimeSnapshotInvalid ? 1 : 0, session.characterIconPath ?? null,
    session.clientRequestId ?? null,
    session.creationContext ? JSON.stringify(session.creationContext) : null,
    session.creationRequest ? JSON.stringify(session.creationRequest) : null, session.id,
  );
}

function writeAuxiliaryMessages(db: DatabaseSync, session: AuxiliarySession): boolean {
  assertFullConversation(session);
  const existing = new Map((db.prepare(`SELECT ${conversationMessageColumns("auxiliary_session_messages", db)}, artifact_body FROM auxiliary_session_messages
    WHERE auxiliary_session_id = ?`).all(session.id) as Array<{
      seq: number; role: string; body: string; artifact_body: string | null; runFailure?: string | null;
    }>).map((row) => [row.seq, row] as const));
  const insert = db.prepare(`INSERT INTO auxiliary_session_messages
    (auxiliary_session_id, seq, role, body, artifact_body, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
  const update = db.prepare(`UPDATE auxiliary_session_messages SET role = ?, body = ?, artifact_body = ?
    WHERE auxiliary_session_id = ? AND seq = ?`);
  let conversationChanged = existing.size !== session.messages.length;
  session.messages.forEach((message, seq) => {
    const summary = message.artifact ? summarizeMessageArtifact(message.artifact) : undefined;
    let artifactBody = message.artifact ? JSON.stringify(message.artifact) : null;
    const oldRow = existing.get(seq);
    const parsed = oldRow ? normalizeMessage(JSON.parse(oldRow.body)) : null;
    const oldMessage = parsed ? withMessageRunFailure(parsed, oldRow?.runFailure) : null;
    if (oldRow && !oldMessage) throw new Error("Invalid Auxiliary message.");
    const preservedBookmark = oldMessage?.role === message.role && oldMessage.text === message.text
      ? oldMessage.isBookmarked === true : message.isBookmarked === true;
    if (!oldMessage || oldMessage.role !== message.role || oldMessage.text !== message.text
      || (oldMessage.accent === true) !== (message.accent === true)
      || (oldMessage.isBookmarked === true) !== preservedBookmark) conversationChanged = true;
    if (message.artifact?.detailAvailable && oldRow?.artifact_body) {
      const old = JSON.parse(oldRow.artifact_body) as MessageArtifact;
      if (JSON.stringify(summarizeMessageArtifact(old)) === JSON.stringify(summary)) artifactBody = oldRow.artifact_body;
    }
    const body = JSON.stringify({ ...message, artifact: summary, isBookmarked: preservedBookmark ? true : undefined });
    if (!oldRow) {
      insert.run(session.id, seq, message.role, body, artifactBody, session.updatedAt);
    } else if (oldRow.role !== message.role || oldRow.body !== body || oldRow.artifact_body !== artifactBody) {
      update.run(message.role, body, artifactBody, session.id, seq);
    }
  });
  if ([...existing.keys()].some((seq) => seq >= session.messages.length)) {
    db.prepare("DELETE FROM auxiliary_session_messages WHERE auxiliary_session_id = ? AND seq >= ?")
      .run(session.id, session.messages.length);
  }
  return conversationChanged;
}

function toDraftRecord(row: AuxiliaryDraftRow): AuxiliaryDraftRecord {
  return {
    auxiliarySessionId: row.id,
    parentSessionId: row.parent_session_id,
    incarnation: row.incarnation,
    durableRevision: row.durable_revision,
    text: row.draft_text,
    updatedAt: row.updated_at,
  };
}

function toDraftAck(row: AuxiliaryDraftRow | AuxiliaryDraftRecord): AuxiliaryDraftAck {
  const legacy = "durable_revision" in row;
  return {
    auxiliarySessionId: legacy ? row.id : row.auxiliarySessionId,
    incarnation: row.incarnation,
    durableRevision: legacy ? row.durable_revision : row.durableRevision,
    updatedAt: legacy ? row.updated_at : row.updatedAt,
  };
}

function migrateAuxiliaryDrafts(db: DatabaseSync): void {
    const rows = db.prepare(`
      SELECT id, parent_session_id, updated_at, payload_json
      FROM auxiliary_sessions
      WHERE id NOT IN (SELECT auxiliary_session_id FROM auxiliary_session_drafts)
    `).all() as Array<{ id: string; parent_session_id: string; updated_at: string; payload_json: string }>;
    const insert = db.prepare(`
      INSERT OR IGNORE INTO auxiliary_session_drafts
        (auxiliary_session_id, parent_session_id, incarnation, durable_revision, draft_text, updated_at)
      VALUES (?, ?, ?, 0, ?, ?)
    `);
    const clearPayload = db.prepare("UPDATE auxiliary_sessions SET payload_json = ? WHERE id = ?");
    for (const row of rows) {
      let draft = "";
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          throw new Error(`Auxiliary draft migration payload is invalid: ${row.id}`);
        }
        if (Object.prototype.hasOwnProperty.call(payload, "composerDraft")) {
          if (typeof payload.composerDraft !== "string") throw new Error(`Auxiliary draft migration payload is invalid: ${row.id}`);
          draft = payload.composerDraft;
        }
      } catch (error) {
        throw error instanceof Error ? error : new Error(`Auxiliary draft migration payload is invalid: ${row.id}`);
      }
      insert.run(row.id, row.parent_session_id, randomUUID(), draft, row.updated_at);
      delete payload.composerDraft;
      clearPayload.run(JSON.stringify(payload), row.id);
    }
}

function migrateAuxiliaryStorage(db: DatabaseSync): void {
  const columns = new Set((db.prepare("PRAGMA table_info(auxiliary_sessions)").all() as TableInfoRow[]).map(({ name }) => name));
  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    db.exec(CREATE_AUXILIARY_MESSAGES_TABLE_SQL);
    if (columns.has("payload_json")) {
      migrateAuxiliaryDrafts(db);
      if (!columns.has("title")) db.exec("ALTER TABLE auxiliary_sessions ADD COLUMN title TEXT NOT NULL DEFAULT ''");
      if (!columns.has("run_state")) db.exec("ALTER TABLE auxiliary_sessions ADD COLUMN run_state TEXT NOT NULL DEFAULT 'idle'");
      if (!columns.has("preview")) db.exec("ALTER TABLE auxiliary_sessions ADD COLUMN preview TEXT NOT NULL DEFAULT ''");
      const additions: Array<[string, string]> = [
        ["provider_id", "TEXT NOT NULL DEFAULT 'codex'"],
        ["catalog_revision", "INTEGER NOT NULL DEFAULT 1"],
        ["model_id", "TEXT NOT NULL DEFAULT ''"],
        ["reasoning_effort", "TEXT NOT NULL DEFAULT 'medium'"],
        ["approval_mode", "TEXT NOT NULL DEFAULT ''"],
        ["codex_sandbox_mode", "TEXT NOT NULL DEFAULT ''"],
        ["codex_speed", "TEXT NOT NULL DEFAULT ''"],
        ["codex_reviewer", "TEXT NOT NULL DEFAULT ''"],
        ["custom_agent_name", "TEXT NOT NULL DEFAULT ''"],
        ["allowed_additional_directories_json", "TEXT NOT NULL DEFAULT '[]'"],
        ["thread_id", "TEXT NOT NULL DEFAULT ''"],
        ["display_after_message_index", "INTEGER"],
        ["closed_at", "TEXT NOT NULL DEFAULT ''"],
        ["character_id", "TEXT"],
        ["character_snapshot_json", "TEXT"],
        ["character_snapshot_invalid", "INTEGER NOT NULL DEFAULT 0"],
        ["character_icon_path", "TEXT"],
        ["client_request_id", "TEXT"],
        ["creation_context_json", "TEXT"],
        ["creation_request_json", "TEXT"],
      ];
      for (const [name, definition] of additions) {
        if (!columns.has(name)) db.exec(`ALTER TABLE auxiliary_sessions ADD COLUMN ${name} ${definition}`);
      }
      const summaryExpression = columns.has("summary_json") ? "summary_json" : "'' AS summary_json";
      const rows = db.prepare(`SELECT id, parent_session_id, status, created_at, updated_at, payload_json, ${summaryExpression} FROM auxiliary_sessions`)
        .all() as Array<{ id: string; parent_session_id: string; status: string; created_at: string; updated_at: string; payload_json: string; summary_json: string }>;
      for (const row of rows) {
        const raw = JSON.parse(row.payload_json) as Record<string, unknown>;
        if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.messages)) {
          throw new Error(`Invalid Auxiliary migration payload: ${row.id}`);
        }
        const session = parseAuxiliarySessionPayload(row.payload_json);
        if (!session || session.id !== row.id || session.parentSessionId !== row.parent_session_id
          || session.messages.length !== raw.messages.length) {
          throw new Error(`Invalid Auxiliary migration payload: ${row.id}`);
        }
        const existingSummary = row.summary_json ? JSON.parse(row.summary_json) as { preview?: unknown } : null;
        const preview = typeof existingSummary?.preview === "string" ? existingSummary.preview
          : buildAuxiliaryPreview(session.messages);
        const migrated = { ...session, createdAt: session.createdAt || row.created_at,
          updatedAt: session.updatedAt || row.updated_at, status: row.status as AuxiliarySession["status"], preview };
        writeAuxiliaryMetadata(db, migrated);
        writeAuxiliaryMessages(db, migrated);
      }
      if (columns.has("summary_json")) db.exec("ALTER TABLE auxiliary_sessions DROP COLUMN summary_json");
      db.exec("ALTER TABLE auxiliary_sessions DROP COLUMN payload_json");
    }
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length) throw new Error("Auxiliary migration foreign key check failed.");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function consumeAuxiliaryDraftInTransaction(db: DatabaseSync,
  input: AuxiliaryDraftStorageConsumeInput & { expectedText?: string }): AuxiliaryDraftConsumeResult {
  const session = db.prepare("SELECT parent_session_id, run_state FROM auxiliary_sessions WHERE id = ?")
    .get(input.auxiliarySessionId) as { parent_session_id: string; run_state: string } | undefined;
  if (!session) return { outcome: "not-found" };
  if (!hasWritableAuxiliaryParent(db, session.parent_session_id)) return { outcome: "rejected" };
  const row = db.prepare(`SELECT auxiliary_session_id AS id, parent_session_id, incarnation,
    durable_revision, draft_text, updated_at FROM auxiliary_session_drafts WHERE auxiliary_session_id = ?`)
    .get(input.auxiliarySessionId) as AuxiliaryDraftRow | undefined;
  if (session.parent_session_id !== input.parentSessionId
    || (session.run_state === "running" && input.allowRunningInput !== true)
    || !row || row.parent_session_id !== input.parentSessionId) return { outcome: "not-found" };
  if (row.incarnation !== input.incarnation || row.durable_revision !== input.expectedDurableRevision
    || (input.expectedText !== undefined && row.draft_text.trim() !== input.expectedText.trim())) {
    return { outcome: "stale", ack: toDraftAck(row) };
  }
  const next = { ...toDraftRecord(row), durableRevision: row.durable_revision + 1, text: "" };
  const result = db.prepare(`UPDATE auxiliary_session_drafts SET durable_revision = ?, draft_text = '', updated_at = ?
    WHERE auxiliary_session_id = ? AND parent_session_id = ? AND durable_revision = ? AND incarnation = ?`)
    .run(next.durableRevision, next.updatedAt, input.auxiliarySessionId, input.parentSessionId,
      input.expectedDurableRevision, input.incarnation);
  if (Number(result.changes) !== 1) return { outcome: "stale", ack: toDraftAck(row) };
  return { outcome: "consumed", ack: toDraftAck(next) };
}

export function hasWritableAuxiliaryParent(db: DatabaseSync, parentSessionId: string): boolean {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name IN ('sessions_v6', 'sessions')`).all() as Array<{ name: string }>;
  if (tables.some(({ name }) => name === "sessions_v6")) {
    const row = db.prepare(`SELECT runtime_policy_json FROM sessions_v6 WHERE id = ? LIMIT 1`)
      .get(parentSessionId) as { runtime_policy_json: string } | undefined;
    if (!row) return false;
    let policy: { accessMode?: unknown; sourceSchemaVersion?: unknown } = {};
    try { policy = JSON.parse(row.runtime_policy_json) as typeof policy; } catch { return false; }
    return !isReadOnlySession({
      accessMode: policy.accessMode === "legacy_readonly" ? "legacy_readonly" : "active",
      sourceSchemaVersion: typeof policy.sourceSchemaVersion === "number"
        ? policy.sourceSchemaVersion
        : CURRENT_SESSION_SCHEMA_VERSION,
    });
  }
  return tables.some(({ name }) => {
    const row = db.prepare(`SELECT access_mode, source_schema_version FROM ${name} WHERE id = ? LIMIT 1`)
      .get(parentSessionId) as { access_mode: string; source_schema_version: number } | undefined;
    return Boolean(row && !isReadOnlySession({
      accessMode: row.access_mode === "legacy_readonly" ? "legacy_readonly" : "active",
      sourceSchemaVersion: row.source_schema_version,
    }));
  });
}

function parseAuxiliarySessionSummaryRow(
  row: AuxiliarySessionSummaryRow,
): AuxiliarySessionSummary | null {
  const session = parseAuxiliarySessionRow({ ...row,
    character_snapshot_json: null, creation_context_json: null, creation_request_json: null });
  if (!session) return null;
  const summary = projectAuxiliarySessionSummary(session);
  return row.effective_updated_at ? { ...summary, updatedAt: row.effective_updated_at } : summary;
}

export function ensureAuxiliarySessionCreatedAtColumn(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(auxiliary_sessions)").all() as TableInfoRow[];
  if (columns.some((column) => column.name === "created_at")) {
    return;
  }

  db.exec("ALTER TABLE auxiliary_sessions ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
}
