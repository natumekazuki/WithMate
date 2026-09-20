import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import {
  normalizeAuxiliarySession,
  projectAuxiliarySessionSummary,
  buildAuxiliaryPreview,
  type AuxiliarySession,
  type AuxiliarySessionSummary,
} from "../src/auxiliary-session-state.js";
import { CURRENT_SESSION_SCHEMA_VERSION, isReadOnlySession } from "../src/session-state.js";
import { openAppDatabase } from "./sqlite-connection.js";
import type { ProviderRuntimeMetadataPatch } from "./provider-runtime-metadata-patch.js";
import type {
  AuxiliaryDraftConsumeInput,
  AuxiliaryDraftConsumeResult,
  AuxiliaryDraftAck,
  AuxiliaryDraftRecord,
  AuxiliaryDraftSaveInput,
  AuxiliaryDraftSaveResult,
  AuxiliarySessionStatus,
} from "../src/auxiliary-draft-contract.js";

type LegacyAuxiliaryPreviewResolver = (auxiliarySessionId: string) => string | null;

type LegacyAuditEntryForPreview = {
  phase: string;
  rawItemsJson: string;
};

type AuxiliarySessionRow = {
  created_at: string;
  updated_at: string;
  payload_json: string;
};

type AuxiliarySessionSummaryRow = {
  created_at: string;
  updated_at: string;
  effective_updated_at?: string;
  summary_json: string;
  payload_json?: string;
};

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
    payload_json TEXT NOT NULL,
    summary_json TEXT NOT NULL DEFAULT ''
  )
`;

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

  constructor(
    dbPath: string,
    private readonly resolveLegacyPreview?: LegacyAuxiliaryPreviewResolver,
  ) {
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
        SELECT a.created_at, a.updated_at, a.payload_json
        FROM auxiliary_sessions a
        LEFT JOIN auxiliary_session_drafts d ON d.auxiliary_session_id = a.id
        ORDER BY MAX(d.updated_at, a.updated_at) DESC, a.id DESC
      `).all() as AuxiliarySessionRow[];
      return rows
        .map((row) => parseAuxiliarySessionRow(row))
        .map((session) => session ? this.composeDraft(db, session) : null)
        .filter((session): session is AuxiliarySession => session !== null);
    });
  }

  listAuxiliarySessions(parentSessionId: string): AuxiliarySessionSummary[] {
    return this.withDb((db) => {
      const rows = db.prepare(`
        SELECT a.created_at, a.updated_at, a.summary_json,
          MAX(d.updated_at, a.updated_at) AS effective_updated_at,
          CASE WHEN a.summary_json = '' THEN a.payload_json ELSE '' END AS payload_json
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
        SELECT a.parent_session_id, a.created_at, a.updated_at, a.summary_json,
          MAX(d.updated_at, a.updated_at) AS effective_updated_at,
          CASE WHEN a.summary_json = '' THEN a.payload_json ELSE '' END AS payload_json
        FROM auxiliary_sessions a
        LEFT JOIN auxiliary_session_drafts d ON d.auxiliary_session_id = a.id
        WHERE a.parent_session_id IN (${placeholders})
        ORDER BY a.parent_session_id ASC, MAX(d.updated_at, a.updated_at) ASC, a.id ASC
      `).all(...normalizedParentSessionIds) as Array<ScopedAuxiliarySessionRow & { summary_json: string }>;
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
        SELECT a.parent_session_id, a.created_at, a.updated_at, a.summary_json,
          MAX(d.updated_at, a.updated_at) AS effective_updated_at,
          CASE WHEN a.summary_json = '' THEN a.payload_json ELSE '' END AS payload_json
        FROM auxiliary_sessions a
        LEFT JOIN auxiliary_session_drafts d ON d.auxiliary_session_id = a.id
        WHERE a.status = 'active'
          AND a.parent_session_id IN (${placeholders})
        ORDER BY MAX(d.updated_at, a.updated_at) DESC, a.id DESC
      `).all(...normalizedParentSessionIds) as Array<ScopedAuxiliarySessionRow & { summary_json: string }>;
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
        SELECT a.created_at, a.updated_at, summary_json,
          MAX(d.updated_at, a.updated_at) AS effective_updated_at,
          CASE WHEN summary_json = '' THEN payload_json ELSE '' END AS payload_json
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
        SELECT a.created_at, a.updated_at, a.payload_json
        FROM auxiliary_sessions a
        LEFT JOIN auxiliary_session_drafts d ON d.auxiliary_session_id = a.id
        WHERE a.parent_session_id = ?
          AND a.status = 'active'
        ORDER BY MAX(d.updated_at, a.updated_at) DESC, a.id DESC
        LIMIT 1
      `).get(parentSessionId) as AuxiliarySessionRow | undefined;
      const session = row ? parseAuxiliarySessionRow(row) : null;
      return session ? this.composeDraft(db, session) : null;
    });
  }

  getAuxiliarySession(auxiliarySessionId: string): AuxiliarySession | null {
    return this.withDb((db) => {
      const row = db.prepare(`
        SELECT created_at, updated_at, payload_json
        FROM auxiliary_sessions
        WHERE id = ?
      `).get(auxiliarySessionId) as AuxiliarySessionRow | undefined;
      const session = row ? parseAuxiliarySessionRow(row) : null;
      return session ? this.composeDraft(db, session) : null;
    });
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
        SELECT a.id, a.parent_session_id, a.status, a.created_at, a.summary_json, d.incarnation
        FROM auxiliary_sessions a LEFT JOIN auxiliary_session_drafts d ON d.auxiliary_session_id = a.id
        WHERE a.id = ?
      `).get(auxiliarySessionId) as { id: string; parent_session_id: string; status: "active" | "closed"; created_at: string; summary_json: string; incarnation?: string } | undefined;
      if (!row) return null;
      let summary: { runState?: unknown; createdAt?: unknown } | null = null;
      try { summary = JSON.parse(row.summary_json) as { runState?: unknown; createdAt?: unknown }; } catch { return null; }
      return typeof summary.runState === "string" ? {
        id: row.id,
        parentSessionId: row.parent_session_id,
        status: row.status,
        createdAt: typeof summary.createdAt === "string" && summary.createdAt ? summary.createdAt : row.created_at,
        incarnation: row.incarnation ?? "",
        runState: summary.runState as AuxiliarySession["runState"],
      } : null;
    });
  }

  saveAuxiliaryDraft(input: AuxiliaryDraftSaveInput): AuxiliaryDraftSaveResult {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const session = db.prepare(`
          SELECT id, parent_session_id, status, created_at, summary_json
          FROM auxiliary_sessions WHERE id = ?
        `).get(input.auxiliarySessionId) as { id: string; parent_session_id: string; status: "active" | "closed"; created_at: string; summary_json: string } | undefined;
        const row = db.prepare(`
          SELECT auxiliary_session_id AS id, parent_session_id, incarnation,
            durable_revision, draft_text, updated_at
          FROM auxiliary_session_drafts WHERE auxiliary_session_id = ?
        `).get(input.auxiliarySessionId) as AuxiliaryDraftRow | undefined;
        if (!session) {
          db.exec("ROLLBACK");
          return { outcome: "not-found" };
        }
        let summary: { runState?: unknown };
        try { summary = JSON.parse(session.summary_json) as { runState?: unknown }; } catch {
          db.exec("ROLLBACK");
          return { outcome: "rejected" };
        }
        if (!session || !hasWritableAuxiliaryParent(db, session.parent_session_id)) {
          db.exec("ROLLBACK");
          return { outcome: "rejected" };
        }
        if (session.parent_session_id !== input.parentSessionId
          || summary.runState === "running") {
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
        touchAuxiliarySummaryRecency(db, next.auxiliarySessionId, next.updatedAt);
        db.exec("COMMIT");
        return { outcome: "saved", ack: toDraftAck(next) };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  consumeAuxiliaryDraft(input: AuxiliaryDraftConsumeInput): AuxiliaryDraftConsumeResult {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const session = db.prepare(`
          SELECT parent_session_id, status, created_at, summary_json
          FROM auxiliary_sessions WHERE id = ?
        `).get(input.auxiliarySessionId) as { parent_session_id: string; status: "active" | "closed"; created_at: string; summary_json: string } | undefined;
        if (!session) {
          db.exec("ROLLBACK");
          return { outcome: "not-found" };
        }
        let summary: { runState?: unknown };
        try { summary = JSON.parse(session.summary_json) as { runState?: unknown }; } catch {
          db.exec("ROLLBACK");
          return { outcome: "rejected" };
        }
        if (!session || !hasWritableAuxiliaryParent(db, session.parent_session_id)) {
          db.exec("ROLLBACK");
          return { outcome: "rejected" };
        }
        const row = db.prepare(`
          SELECT auxiliary_session_id AS id, parent_session_id, incarnation,
            durable_revision, draft_text, updated_at
          FROM auxiliary_session_drafts
          WHERE auxiliary_session_id = ?
        `).get(input.auxiliarySessionId) as AuxiliaryDraftRow | undefined;
        if (session.parent_session_id !== input.parentSessionId
          || summary.runState === "running" || !row || row.parent_session_id !== input.parentSessionId) {
          db.exec("ROLLBACK");
          return { outcome: "not-found" };
        }
        if (row.incarnation !== input.incarnation || row.durable_revision !== input.expectedDurableRevision) {
          db.exec("ROLLBACK");
          return { outcome: "stale", ack: toDraftAck(row) };
        }
        const next = { ...toDraftRecord(row), durableRevision: row.durable_revision + 1, text: "" };
        db.prepare(`UPDATE auxiliary_session_drafts
          SET durable_revision = ?, draft_text = '', updated_at = ?
          WHERE auxiliary_session_id = ? AND durable_revision = ? AND incarnation = ?
        `).run(next.durableRevision, next.updatedAt, input.auxiliarySessionId, input.expectedDurableRevision, input.incarnation);
        db.exec("COMMIT");
        return { outcome: "consumed", ack: toDraftAck(next) };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  updateAuxiliarySessionThreadIfMatches(input: AuxiliarySessionThreadPatchInput): AuxiliarySession | null {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const row = db.prepare(`
          SELECT created_at, updated_at, payload_json
          FROM auxiliary_sessions
          WHERE id = ? AND parent_session_id = ?
        `).get(input.auxiliarySessionId, input.parentSessionId) as AuxiliarySessionRow | undefined;
        const current = row ? parseAuxiliarySessionRow(row) : null;
        if (!current || current.provider !== input.provider || current.threadId !== input.expectedThreadId || (input.createdAt !== undefined && current.createdAt !== input.createdAt)) {
          db.exec("ROLLBACK");
          return null;
        }
        const next = { ...current, threadId: input.nextThreadId, updatedAt: input.updatedAt };
        const result = db.prepare(`
          UPDATE auxiliary_sessions SET updated_at = ?, payload_json = ?, summary_json = ?
          WHERE id = ? AND parent_session_id = ? AND updated_at = ?
        `).run(input.updatedAt, serializeAuxiliarySessionPayload(next), JSON.stringify(projectAuxiliarySessionSummary(next)), input.auxiliarySessionId, input.parentSessionId, current.updatedAt);
        if (Number(result.changes) !== 1) {
          db.exec("ROLLBACK");
          return null;
        }
        db.exec("COMMIT");
        return this.composeDraft(db, next);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  updateAuxiliarySessionRuntimeMetadataIfMatches(
    input: AuxiliarySessionRuntimeMetadataPatchInput,
  ): AuxiliarySession | null {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const row = db.prepare(`
          SELECT created_at, updated_at, payload_json
          FROM auxiliary_sessions
          WHERE id = ? AND parent_session_id = ?
        `).get(input.auxiliarySessionId, input.parentSessionId) as AuxiliarySessionRow | undefined;
        const current = row ? parseAuxiliarySessionRow(row) : null;
        if (
          !current ||
          current.createdAt !== input.createdAt ||
          current.provider !== input.expected.provider ||
          current.catalogRevision !== input.expected.catalogRevision ||
          current.model !== input.expected.model ||
          current.reasoningEffort !== input.expected.reasoningEffort ||
          current.threadId !== input.expected.threadId
        ) {
          db.exec("ROLLBACK");
          return null;
        }
        const next = {
          ...current,
          provider: input.next.provider,
          catalogRevision: input.next.catalogRevision,
          model: input.next.model,
          reasoningEffort: input.next.reasoningEffort,
          threadId: input.next.threadId,
          updatedAt: input.next.updatedAt,
        };
        const result = db.prepare(`
          UPDATE auxiliary_sessions SET updated_at = ?, payload_json = ?, summary_json = ?
          WHERE id = ? AND parent_session_id = ? AND created_at = ? AND updated_at = ?
        `).run(
          next.updatedAt,
          serializeAuxiliarySessionPayload(next),
          JSON.stringify(projectAuxiliarySessionSummary(next)),
          input.auxiliarySessionId,
          input.parentSessionId,
          input.createdAt,
          current.updatedAt,
        );
        if (Number(result.changes) !== 1) {
          db.exec("ROLLBACK");
          return null;
        }
        db.exec("COMMIT");
        return this.composeDraft(db, next);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  updateAuxiliarySessionIfMatches(input: AuxiliarySessionUpdateIfMatchesInput): AuxiliarySession | null {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const row = db.prepare(`
          SELECT created_at, updated_at, payload_json
          FROM auxiliary_sessions
          WHERE id = ? AND parent_session_id = ? AND created_at = ? AND updated_at = ?
        `).get(input.expectedSession.id, input.expectedSession.parentSessionId, input.expectedSession.createdAt, input.expectedSession.updatedAt) as AuxiliarySessionRow | undefined;
        const current = row ? parseAuxiliarySessionRow(row) : null;
        const parentTables = (db.prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN ('sessions_v6', 'companion_sessions', 'sessions')
        `).all() as Array<{ name: string }>);
        const hasV6ParentTable = parentTables.some(({ name }) => name === "sessions_v6");
        const parent = parentTables.filter(({ name }) => name !== (hasV6ParentTable ? "sessions" : "sessions_v6")).some(({ name }) => {
          const row = name === "companion_sessions"
            ? db.prepare(`SELECT 1 AS present FROM ${name} WHERE id = ? AND status IN ('active', 'recovery-required') LIMIT 1`).get(input.expectedSession.parentSessionId)
            : db.prepare(`SELECT 1 AS present FROM ${name} WHERE id = ? LIMIT 1`).get(input.expectedSession.parentSessionId);
          return Boolean(row);
        });
        const expected = normalizeAuxiliarySession(input.expectedSession);
        const draftRow = db.prepare("SELECT draft_text FROM auxiliary_session_drafts WHERE auxiliary_session_id = ?")
          .get(input.expectedSession.id) as { draft_text: string } | undefined;
        const currentWithDraft = current && draftRow ? { ...current, composerDraft: draftRow.draft_text } : current;
        const currentRuntime = currentWithDraft && { ...currentWithDraft, composerDraft: "" };
        const expectedRuntime = expected && { ...expected, composerDraft: "" };
        if (!current || !expected || input.session.id !== expected.id || input.session.parentSessionId !== expected.parentSessionId
          || input.session.createdAt !== expected.createdAt || JSON.stringify(currentRuntime) !== JSON.stringify(expectedRuntime) || !parent) {
          db.exec("ROLLBACK");
          return null;
        }
        const result = db.prepare(`
          UPDATE auxiliary_sessions
          SET parent_session_id = ?, status = ?, created_at = ?, updated_at = ?, payload_json = ?, summary_json = ?
          WHERE id = ? AND parent_session_id = ? AND created_at = ? AND updated_at = ?
        `).run(
          input.session.parentSessionId, input.session.status, input.session.createdAt, input.session.updatedAt,
          serializeAuxiliarySessionPayload(input.session),
          JSON.stringify(projectAuxiliarySessionSummary({ ...input.session, composerDraft: currentWithDraft?.composerDraft ?? input.session.composerDraft })),
          input.session.id, input.expectedSession.parentSessionId, input.expectedSession.createdAt, input.expectedSession.updatedAt,
        );
        if (Number(result.changes) !== 1) {
          db.exec("ROLLBACK");
          return null;
        }
        db.exec("COMMIT");
        return { ...input.session, composerDraft: currentWithDraft?.composerDraft ?? "" };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  upsertAuxiliarySession(session: AuxiliarySession): AuxiliarySession {
    return this.withDb((db) => {
      const existing = db.prepare("SELECT draft_text FROM auxiliary_session_drafts WHERE auxiliary_session_id = ?")
        .get(session.id) as { draft_text: string } | undefined;
      const persisted = existing ? { ...session, composerDraft: existing.draft_text } : session;
      const payload = serializeAuxiliarySessionPayload(persisted);
      const summary = JSON.stringify(projectAuxiliarySessionSummary(persisted));
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        db.prepare(`
          INSERT INTO auxiliary_sessions (
            id,
            parent_session_id,
            status,
            created_at,
            updated_at,
            payload_json,
            summary_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            parent_session_id = excluded.parent_session_id,
            status = excluded.status,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            payload_json = excluded.payload_json,
            summary_json = excluded.summary_json
        `).run(session.id, session.parentSessionId, session.status, session.createdAt, session.updatedAt, payload, summary);
        db.prepare(`
          INSERT OR IGNORE INTO auxiliary_session_drafts
            (auxiliary_session_id, parent_session_id, incarnation, durable_revision, draft_text, updated_at)
          VALUES (?, ?, ?, 0, ?, ?)
        `).run(session.id, session.parentSessionId, randomUUID(), session.composerDraft, session.updatedAt);
        db.exec("COMMIT");
        return persisted;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  deleteAuxiliarySessionsForParent(parentSessionId: string): void {
    this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        db.prepare("DELETE FROM auxiliary_sessions WHERE parent_session_id = ?").run(parentSessionId);
        db.prepare("DELETE FROM auxiliary_session_drafts WHERE parent_session_id = ?").run(parentSessionId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  deleteAuxiliarySessionsExceptParents(parentSessionIds: Iterable<string>): void {
    const retainedParentSessionIds = Array.from(new Set(parentSessionIds));
    this.withDb((db) => {
      if (retainedParentSessionIds.length === 0) {
        db.prepare("DELETE FROM auxiliary_sessions").run();
        db.prepare("DELETE FROM auxiliary_session_drafts").run();
        return;
      }

      const placeholders = retainedParentSessionIds.map(() => "?").join(", ");
      db.prepare(`DELETE FROM auxiliary_sessions WHERE parent_session_id NOT IN (${placeholders})`)
        .run(...retainedParentSessionIds);
      db.prepare(`DELETE FROM auxiliary_session_drafts WHERE parent_session_id NOT IN (${placeholders})`)
        .run(...retainedParentSessionIds);
    });
  }

  private initializeSchema(): void {
    this.withDb((db) => {
      db.exec(CREATE_AUXILIARY_SESSIONS_TABLE_SQL);
      ensureAuxiliarySessionCreatedAtColumn(db);
      ensureAuxiliarySessionSummaryColumn(db);
      db.exec(CREATE_AUXILIARY_SESSION_PARENT_UPDATED_INDEX_SQL);
      db.exec(CREATE_AUXILIARY_SESSION_DRAFTS_TABLE_SQL);
      migrateAuxiliaryDrafts(db);
      db.exec("DROP INDEX IF EXISTS idx_auxiliary_sessions_parent_created");
    });
  }

  private composeDraft(db: DatabaseSync, session: AuxiliarySession): AuxiliarySession {
    const row = db.prepare(`SELECT draft_text FROM auxiliary_session_drafts WHERE auxiliary_session_id = ?`)
      .get(session.id) as { draft_text: string } | undefined;
    return row ? { ...session, composerDraft: row.draft_text } : session;
  }

  /**
   * Projects at most one bounded batch. Callers may invoke this repeatedly
   * until `remaining` reaches zero. Keeping the progress in the database
   * (summary_json) makes interruption and restart resumable without passing
   * callbacks or functions through the storage-worker boundary.
   */
  backfillAuxiliarySessionSummaries(options: { batchSize?: number } = {}): {
    processed: number;
    updated: number;
    remaining: number;
    error?: { id: string; message: string };
  } {
    const batchSize = Math.max(1, Math.floor(options.batchSize ?? 100));
    const batch = this.withDb((db) => db.prepare(`
      SELECT id, payload_json
      FROM auxiliary_sessions
      WHERE summary_json = ''
      ORDER BY updated_at ASC, id ASC
      LIMIT ?
    `).all(batchSize) as Array<{ id: string; payload_json: string }>);
    let updated = 0;
    let error: { id: string; message: string } | undefined;
    this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const update = db.prepare("UPDATE auxiliary_sessions SET payload_json = ?, summary_json = ? WHERE id = ? AND summary_json = ''");
        for (const row of batch) {
          const session = parseAuxiliarySessionPayload(row.payload_json);
          if (!session) {
            error = { id: row.id, message: "Auxiliary session backfill payload is invalid." };
            break;
          }
          const confirmedFinalAssistantText = this.resolveLegacyPreview?.(row.id) ?? null;
          const preview = confirmedFinalAssistantText
            ? buildAuxiliaryPreview(session.messages, confirmedFinalAssistantText)
            : buildAuxiliaryPreview(session.messages);
          const migratedSession = { ...session, preview };
          const result = update.run(
            serializeAuxiliarySessionPayload(migratedSession),
            JSON.stringify(projectAuxiliarySessionSummary(migratedSession)),
            row.id,
          );
          updated += Number(result.changes);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
    const remaining = this.withDb((db) => (
      db.prepare("SELECT COUNT(*) AS count FROM auxiliary_sessions WHERE summary_json = ''").get() as { count: number }
    ).count);
    return { processed: batch.length, updated, remaining, ...(error ? { error } : {}) };
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
  const session = parseAuxiliarySessionPayload(row.payload_json);
  if (!session) {
    return null;
  }

  return {
    ...session,
    createdAt: session.createdAt || row.created_at,
    updatedAt: session.updatedAt || row.updated_at,
  };
}

function serializeAuxiliarySessionPayload(session: AuxiliarySession): string {
  const { composerDraft: _composerDraft, ...payload } = session;
  return JSON.stringify(payload);
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
  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
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
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function touchAuxiliarySummaryRecency(db: DatabaseSync, auxiliarySessionId: string, updatedAt: string): void {
  const row = db.prepare("SELECT summary_json FROM auxiliary_sessions WHERE id = ?")
    .get(auxiliarySessionId) as { summary_json: string } | undefined;
  if (!row || !row.summary_json) return;
  try {
    const summary = JSON.parse(row.summary_json) as Record<string, unknown>;
    summary.updatedAt = updatedAt;
    db.prepare("UPDATE auxiliary_sessions SET summary_json = ? WHERE id = ?")
      .run(JSON.stringify(summary), auxiliarySessionId);
  } catch (error) {
    throw error instanceof Error ? error : new Error("Auxiliary draft recency projection failed.");
  }
}

function hasWritableAuxiliaryParent(db: DatabaseSync, parentSessionId: string): boolean {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name IN ('sessions_v6', 'companion_sessions', 'sessions')`).all() as Array<{ name: string }>;
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
    if (name === "companion_sessions") {
      return Boolean(db.prepare(`SELECT 1 AS present FROM ${name} WHERE id = ? AND status IN ('active', 'recovery-required') LIMIT 1`).get(parentSessionId));
    }
    const row = db.prepare(`SELECT access_mode, source_schema_version FROM ${name} WHERE id = ? LIMIT 1`)
      .get(parentSessionId) as { access_mode: string; source_schema_version: number } | undefined;
    return Boolean(row && !isReadOnlySession({
      accessMode: row.access_mode === "legacy_readonly" ? "legacy_readonly" : "active",
      sourceSchemaVersion: row.source_schema_version,
    }));
  });
}

/** Extracts a final provider block only from an untruncated completed audit item list. */
export function resolveLegacyAuxiliaryPreviewFromAuditEntries(
  entries: readonly LegacyAuditEntryForPreview[],
): string | null {
  for (const entry of entries) {
    if (entry.phase !== "completed" && entry.phase !== "background-completed") {
      continue;
    }

    let items: unknown;
    try {
      items = JSON.parse(entry.rawItemsJson);
    } catch {
      continue;
    }
    if (!Array.isArray(items) || containsRawItemTruncationMarker(items)) {
      continue;
    }

    for (const item of [...items].reverse()) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const candidate = item as { type?: unknown; data?: unknown; agentId?: unknown };
      if (!candidate.data || typeof candidate.data !== "object") {
        continue;
      }
      const data = candidate.data as {
        text?: unknown;
        content?: unknown;
        parentToolCallId?: unknown;
        agentId?: unknown;
      };
      const isSubAgentMessage = candidate.agentId != null || data.agentId != null;
      const text = candidate.type === "agent_message"
        ? data.text
        : candidate.type === "assistant.message" && data.parentToolCallId == null && !isSubAgentMessage
          ? data.content
          : null;
      if (typeof text === "string" && text.trim()) {
        return text;
      }
    }
  }
  return null;
}

function containsRawItemTruncationMarker(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsRawItemTruncationMarker);
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    record.type === "withmate.value_truncated"
    || record.type === "withmate.raw_items_truncated"
    || record.truncated === true
  ) {
    return true;
  }
  return Object.values(record).some(containsRawItemTruncationMarker);
}

function parseAuxiliarySessionSummaryRow(
  row: AuxiliarySessionSummaryRow,
): AuxiliarySessionSummary | null {
  try {
    const value = row.summary_json
      ? JSON.parse(row.summary_json) as unknown
      : row.payload_json
        ? JSON.parse(row.payload_json) as unknown
        : null;
    const normalized = normalizeAuxiliarySession(value);
    if (!normalized) return null;
    const summary = projectAuxiliarySessionSummary(normalized);
    return row.effective_updated_at ? { ...summary, updatedAt: row.effective_updated_at } : summary;
  } catch {
    return null;
  }

}

export function ensureAuxiliarySessionCreatedAtColumn(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(auxiliary_sessions)").all() as TableInfoRow[];
  if (columns.some((column) => column.name === "created_at")) {
    return;
  }

  db.exec("ALTER TABLE auxiliary_sessions ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
}

export function ensureAuxiliarySessionSummaryColumn(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(auxiliary_sessions)").all() as TableInfoRow[];
  if (!columns.some((column) => column.name === "summary_json")) {
    db.exec("ALTER TABLE auxiliary_sessions ADD COLUMN summary_json TEXT NOT NULL DEFAULT ''");
  }
}
