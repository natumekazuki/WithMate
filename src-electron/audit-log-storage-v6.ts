import type {
  AuditLogDetail,
  AuditLogDetailFragment,
  AuditLogDetailSection,
  AuditLogEntry,
  AuditLogOperationDetailFragment,
  AuditLogSummary,
  AuditLogSummaryPageRequest,
  AuditLogSummaryPageResult,
} from "../src/app-state.js";
import { ensureV6Schema } from "./database-schema-v6.js";
import { openAppDatabase } from "./sqlite-connection.js";

type AuditEventV6Row = {
  id: number;
  session_id: string | null;
  auxiliary_session_id: string | null;
  metadata_json: string;
};

type CountRow = {
  count: number;
};

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

function parseEntry(row: AuditEventV6Row): AuditLogEntry | null {
  try {
    const parsed = JSON.parse(row.metadata_json) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      ...(parsed as Omit<AuditLogEntry, "id">),
      id: row.id,
      sessionId: typeof (parsed as { sessionId?: unknown }).sessionId === "string"
        ? (parsed as { sessionId: string }).sessionId
        : row.session_id ?? row.auxiliary_session_id ?? "",
    } as AuditLogEntry;
  } catch {
    return null;
  }
}

function toSummary(entry: AuditLogEntry): AuditLogSummary {
  const {
    logicalPrompt: _logicalPrompt,
    transportPayload: _transportPayload,
    assistantText,
    rawItemsJson: _rawItemsJson,
    operations,
    ...summary
  } = entry;
  return {
    ...summary,
    operations: operations.map((operation) => ({
      type: operation.type,
      summary: operation.summary,
    })),
    assistantTextPreview: assistantText.length > 500 ? assistantText.slice(0, 500) : assistantText,
    detailAvailable: true,
  };
}

function normalizePageRequest(request?: AuditLogSummaryPageRequest | null): { cursor: number | null; limit: number } {
  const requestedLimit = typeof request?.limit === "number" && Number.isFinite(request.limit)
    ? Math.trunc(request.limit)
    : DEFAULT_PAGE_LIMIT;
  return {
    cursor: typeof request?.cursor === "number" && Number.isFinite(request.cursor) && request.cursor > 0
      ? Math.trunc(request.cursor)
      : null,
    limit: Math.max(1, Math.min(MAX_PAGE_LIMIT, requestedLimit)),
  };
}

export class AuditLogStorageV6 {
  private readonly db;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    ensureV6Schema(this.db);
  }

  createAuditLog(input: Omit<AuditLogEntry, "id">): AuditLogEntry {
    const target = this.resolveAuditTarget(input.sessionId);
    const result = this.db.prepare(`
      INSERT INTO audit_events_v6 (
        session_id,
        auxiliary_session_id,
        event_type,
        provider_id,
        summary,
        metadata_json,
        created_at
      )
      VALUES (?, ?, 'session_turn', ?, ?, ?, ?)
    `).run(
      target.sessionId,
      target.auxiliarySessionId,
      input.provider,
      input.transportPayload?.summary ?? input.phase,
      JSON.stringify(input),
      input.createdAt,
    );
    return { ...input, id: Number(result.lastInsertRowid) };
  }

  updateAuditLog(id: number, input: Omit<AuditLogEntry, "id">): AuditLogEntry {
    const entry = { ...input, id };
    const target = this.resolveAuditTarget(entry.sessionId);
    const result = this.db.prepare(`
      UPDATE audit_events_v6
      SET session_id = ?,
          auxiliary_session_id = ?,
          provider_id = ?,
          summary = ?,
          metadata_json = ?,
          created_at = ?
      WHERE id = ?
    `).run(
      target.sessionId,
      target.auxiliarySessionId,
      entry.provider,
      entry.transportPayload?.summary ?? entry.phase,
      JSON.stringify(input),
      entry.createdAt,
      id,
    );
    if (result.changes !== 1) {
      throw new Error(`audit log not found: ${id}`);
    }
    return entry;
  }

  listSessionAuditLogs(sessionId: string): AuditLogEntry[] {
    return this.readEntries(sessionId);
  }

  listSessionAuditLogSummaries(sessionId: string): AuditLogSummary[] {
    return this.readEntries(sessionId).map(toSummary);
  }

  listSessionAuditLogSummaryPage(
    sessionId: string,
    request?: AuditLogSummaryPageRequest | null,
  ): AuditLogSummaryPageResult {
    const { cursor, limit } = normalizePageRequest(request);
    const params: Array<string | number> = [sessionId, sessionId];
    let cursorSql = "";
    if (cursor !== null) {
      cursorSql = "AND id < ?";
      params.push(cursor);
    }
    const rows = this.db.prepare(`
      SELECT id, session_id, auxiliary_session_id, metadata_json
      FROM audit_events_v6
      WHERE (session_id = ? OR auxiliary_session_id = ?)
        ${cursorSql}
      ORDER BY id DESC
      LIMIT ?
    `).all(...params, limit + 1) as AuditEventV6Row[];
    const visibleRows = rows.slice(0, limit);
    const entries = visibleRows
      .map((row) => parseEntry(row))
      .filter((entry): entry is AuditLogEntry => entry !== null)
      .map(toSummary);
    const totalRow = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM audit_events_v6
      WHERE (session_id = ? OR auxiliary_session_id = ?)
    `).get(sessionId, sessionId) as CountRow;
    return {
      entries,
      nextCursor: rows.length > limit ? visibleRows[visibleRows.length - 1]?.id ?? null : null,
      hasMore: rows.length > limit,
      total: totalRow.count,
    };
  }

  getSessionAuditLogDetail(sessionId: string, auditLogId: number): AuditLogDetail | null {
    const entry = this.readEntry(sessionId, auditLogId);
    return entry ? {
      id: entry.id,
      sessionId: entry.sessionId,
      logicalPrompt: entry.logicalPrompt,
      transportPayload: entry.transportPayload,
      assistantText: entry.assistantText,
      operations: entry.operations,
      rawItemsJson: entry.rawItemsJson,
      usage: entry.usage,
      errorMessage: entry.errorMessage,
    } : null;
  }

  getSessionAuditLogDetailSection(
    sessionId: string,
    auditLogId: number,
    section: AuditLogDetailSection,
  ): AuditLogDetailFragment | null {
    const detail = this.getSessionAuditLogDetail(sessionId, auditLogId);
    if (!detail) {
      return null;
    }
    const base = { id: auditLogId, sessionId };
    if (section === "logical") {
      return { ...base, logicalPrompt: detail.logicalPrompt };
    }
    if (section === "transport") {
      return { ...base, transportPayload: detail.transportPayload };
    }
    if (section === "response") {
      return { ...base, assistantText: detail.assistantText };
    }
    if (section === "raw") {
      return { ...base, rawItemsJson: detail.rawItemsJson };
    }
    if (section === "operations") {
      return { ...base, operations: detail.operations };
    }
    return null;
  }

  getSessionAuditLogOperationDetail(
    sessionId: string,
    auditLogId: number,
    operationIndex: number,
  ): AuditLogOperationDetailFragment | null {
    const detail = this.getSessionAuditLogDetail(sessionId, auditLogId);
    const operation = detail?.operations[operationIndex];
    return operation ? {
      id: auditLogId,
      sessionId,
      operationIndex,
      details: operation.details ?? "",
    } : null;
  }

  clearAuditLogs(): void {
    this.db.exec("DELETE FROM audit_events_v6;");
  }

  close(): void {
    this.db.close();
  }

  private readEntries(sessionId: string): AuditLogEntry[] {
    const rows = this.db.prepare(`
      SELECT id, session_id, auxiliary_session_id, metadata_json
      FROM audit_events_v6
      WHERE (session_id = ? OR auxiliary_session_id = ?)
      ORDER BY id DESC
    `).all(sessionId, sessionId) as AuditEventV6Row[];
    return rows.map((row) => parseEntry(row)).filter((entry): entry is AuditLogEntry => entry !== null);
  }

  private readEntry(sessionId: string, auditLogId: number): AuditLogEntry | null {
    const row = this.db.prepare(`
      SELECT id, session_id, auxiliary_session_id, metadata_json
      FROM audit_events_v6
      WHERE (session_id = ? OR auxiliary_session_id = ?) AND id = ?
    `).get(sessionId, sessionId, auditLogId) as AuditEventV6Row | undefined;
    return row ? parseEntry(row) : null;
  }

  private resolveAuditTarget(sessionId: string): { sessionId: string | null; auxiliarySessionId: string | null } {
    const sessionRow = this.db.prepare(`
      SELECT id
      FROM sessions_v6
      WHERE id = ?
    `).get(sessionId) as { id: string } | undefined;
    if (sessionRow) {
      return { sessionId, auxiliarySessionId: null };
    }

    const auxiliaryRow = this.db.prepare(`
      SELECT id
      FROM auxiliary_sessions
      WHERE id = ?
    `).get(sessionId) as { id: string } | undefined;
    if (auxiliaryRow) {
      return { sessionId: null, auxiliarySessionId: sessionId };
    }

    throw new Error(`audit log target not found: ${sessionId}`);
  }
}
