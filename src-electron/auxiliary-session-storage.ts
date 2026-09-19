import type { DatabaseSync } from "node:sqlite";

import {
  normalizeAuxiliarySession,
  projectAuxiliarySessionSummary,
  buildAuxiliaryPreview,
  type AuxiliarySession,
  type AuxiliarySessionSummary,
} from "../src/auxiliary-session-state.js";
import { openAppDatabase } from "./sqlite-connection.js";
import type { ProviderRuntimeMetadataPatch } from "./provider-runtime-metadata-patch.js";

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
  summary_json: string;
  payload_json?: string;
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

export class AuxiliarySessionStorage {
  private db: DatabaseSync | null;

  constructor(
    dbPath: string,
    private readonly resolveLegacyPreview?: LegacyAuxiliaryPreviewResolver,
  ) {
    this.db = openAppDatabase(dbPath);
    this.initializeSchema();
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  listAllAuxiliarySessions(): AuxiliarySession[] {
    return this.withDb((db) => {
      const rows = db.prepare(`
        SELECT created_at, updated_at, payload_json
        FROM auxiliary_sessions
        ORDER BY updated_at DESC, id DESC
      `).all() as AuxiliarySessionRow[];
      return rows
        .map((row) => parseAuxiliarySessionRow(row))
        .filter((session): session is AuxiliarySession => session !== null);
    });
  }

  listAuxiliarySessions(parentSessionId: string): AuxiliarySessionSummary[] {
    return this.withDb((db) => {
      const rows = db.prepare(`
        SELECT created_at, updated_at, summary_json,
          CASE WHEN summary_json = '' THEN payload_json ELSE '' END AS payload_json
        FROM auxiliary_sessions
        WHERE parent_session_id = ?
        ORDER BY updated_at DESC, id DESC
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
        SELECT parent_session_id, created_at, updated_at, summary_json,
          CASE WHEN summary_json = '' THEN payload_json ELSE '' END AS payload_json
        FROM auxiliary_sessions
        WHERE parent_session_id IN (${placeholders})
        ORDER BY parent_session_id ASC, created_at ASC, id ASC
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
        SELECT parent_session_id, created_at, updated_at, summary_json,
          CASE WHEN summary_json = '' THEN payload_json ELSE '' END AS payload_json
        FROM auxiliary_sessions
        WHERE status = 'active'
          AND parent_session_id IN (${placeholders})
        ORDER BY updated_at DESC, id DESC
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
        SELECT created_at, updated_at, summary_json,
          CASE WHEN summary_json = '' THEN payload_json ELSE '' END AS payload_json
        FROM auxiliary_sessions
        WHERE status = 'active'
        ORDER BY updated_at DESC, id DESC
      `).all() as AuxiliarySessionSummaryRow[];
      return rows
        .map(parseAuxiliarySessionSummaryRow)
        .filter((session): session is AuxiliarySessionSummary => session?.runState === "running");
    });
  }

  getActiveAuxiliarySession(parentSessionId: string): AuxiliarySession | null {
    return this.withDb((db) => {
      const row = db.prepare(`
        SELECT created_at, updated_at, payload_json
        FROM auxiliary_sessions
        WHERE parent_session_id = ?
          AND status = 'active'
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `).get(parentSessionId) as AuxiliarySessionRow | undefined;
      return row ? parseAuxiliarySessionRow(row) : null;
    });
  }

  getAuxiliarySession(auxiliarySessionId: string): AuxiliarySession | null {
    return this.withDb((db) => {
      const row = db.prepare(`
        SELECT created_at, updated_at, payload_json
        FROM auxiliary_sessions
        WHERE id = ?
      `).get(auxiliarySessionId) as AuxiliarySessionRow | undefined;
      return row ? parseAuxiliarySessionRow(row) : null;
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
        `).run(input.updatedAt, JSON.stringify(next), JSON.stringify(projectAuxiliarySessionSummary(next)), input.auxiliarySessionId, input.parentSessionId, current.updatedAt);
        if (Number(result.changes) !== 1) {
          db.exec("ROLLBACK");
          return null;
        }
        db.exec("COMMIT");
        return next;
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
          JSON.stringify(next),
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
        return next;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  upsertAuxiliarySession(session: AuxiliarySession): AuxiliarySession {
    return this.withDb((db) => {
      const payload = JSON.stringify(session);
      const summary = JSON.stringify(projectAuxiliarySessionSummary(session));
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
      return session;
    });
  }

  deleteAuxiliarySessionsForParent(parentSessionId: string): void {
    this.withDb((db) => {
      db.prepare("DELETE FROM auxiliary_sessions WHERE parent_session_id = ?").run(parentSessionId);
    });
  }

  deleteAuxiliarySessionsExceptParents(parentSessionIds: Iterable<string>): void {
    const retainedParentSessionIds = Array.from(new Set(parentSessionIds));
    this.withDb((db) => {
      if (retainedParentSessionIds.length === 0) {
        db.prepare("DELETE FROM auxiliary_sessions").run();
        return;
      }

      const placeholders = retainedParentSessionIds.map(() => "?").join(", ");
      db.prepare(`DELETE FROM auxiliary_sessions WHERE parent_session_id NOT IN (${placeholders})`)
        .run(...retainedParentSessionIds);
    });
  }

  private initializeSchema(): void {
    this.withDb((db) => {
      db.exec(CREATE_AUXILIARY_SESSIONS_TABLE_SQL);
      ensureAuxiliarySessionCreatedAtColumn(db);
      ensureAuxiliarySessionSummaryColumn(db);
      db.exec(CREATE_AUXILIARY_SESSION_PARENT_UPDATED_INDEX_SQL);
      db.exec("DROP INDEX IF EXISTS idx_auxiliary_sessions_parent_created");
    });
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
            JSON.stringify(migratedSession),
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
    return normalized ? projectAuxiliarySessionSummary(normalized) : null;
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
