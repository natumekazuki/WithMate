import type { DatabaseSync } from "node:sqlite";

import {
  normalizeAuxiliarySession,
  projectAuxiliarySessionSummary,
  buildAuxiliaryPreview,
  type AuxiliarySession,
  type AuxiliarySessionSummary,
} from "../src/auxiliary-session-state.js";
import { openAppDatabase } from "./sqlite-connection.js";

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
};

type ScopedAuxiliarySessionRow = AuxiliarySessionRow & {
  parent_session_id: string;
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

const CREATE_AUXILIARY_SESSION_PARENT_CREATED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_auxiliary_sessions_parent_created
    ON auxiliary_sessions(parent_session_id, created_at ASC)
`;

export class AuxiliarySessionStorage {
  private db: DatabaseSync | null;
  private legacySummaryBackfillDone = false;

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
    this.ensureLegacySummaryBackfill();
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
    this.ensureLegacySummaryBackfill();
    return this.withDb((db) => {
      const rows = db.prepare(`
        SELECT created_at, updated_at, summary_json
        FROM auxiliary_sessions
        WHERE parent_session_id = ?
        ORDER BY created_at ASC, id ASC
      `).all(parentSessionId) as AuxiliarySessionSummaryRow[];
      return rows
        .map(parseAuxiliarySessionSummaryRow)
        .filter((summary): summary is AuxiliarySessionSummary => summary !== null);
    });
  }

  listActiveAuxiliarySessionSummaries(parentSessionIds: readonly string[]): AuxiliarySessionSummary[] {
    this.ensureLegacySummaryBackfill();
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
        SELECT parent_session_id, created_at, updated_at, summary_json
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
    this.ensureLegacySummaryBackfill();
    return this.withDb((db) => {
      const rows = db.prepare(`
        SELECT created_at, updated_at, summary_json
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
    this.ensureLegacySummaryBackfill();
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
    this.ensureLegacySummaryBackfill();
    return this.withDb((db) => {
      const row = db.prepare(`
        SELECT created_at, updated_at, payload_json
        FROM auxiliary_sessions
        WHERE id = ?
      `).get(auxiliarySessionId) as AuxiliarySessionRow | undefined;
      return row ? parseAuxiliarySessionRow(row) : null;
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
      db.exec(CREATE_AUXILIARY_SESSION_PARENT_CREATED_INDEX_SQL);
    });
  }

  private ensureLegacySummaryBackfill(): void {
    if (this.legacySummaryBackfillDone) {
      return;
    }

    this.withDb((db) => {
      const rows = db.prepare(`
        SELECT id, payload_json
        FROM auxiliary_sessions
        WHERE summary_json = ''
      `).all() as Array<{ id: string; payload_json: string }>;
      const update = db.prepare("UPDATE auxiliary_sessions SET payload_json = ?, summary_json = ? WHERE id = ?");
      for (const row of rows) {
        const session = parseAuxiliarySessionPayload(row.payload_json);
        if (!session) {
          continue;
        }
        const confirmedFinalAssistantText = this.resolveLegacyPreview?.(row.id) ?? null;
        const preview = confirmedFinalAssistantText
          ? buildAuxiliaryPreview(session.messages, confirmedFinalAssistantText)
          : buildAuxiliaryPreview(session.messages);
        const migratedSession = {
          ...session,
          preview,
        };
        const summary = projectAuxiliarySessionSummary(migratedSession);
        update.run(JSON.stringify(migratedSession), JSON.stringify(summary), row.id);
      }
    });
    this.legacySummaryBackfillDone = true;
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
    const value = JSON.parse(row.summary_json) as unknown;
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
