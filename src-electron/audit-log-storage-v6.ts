import type { DatabaseSync } from "node:sqlite";

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

type SessionTurnV6Row = {
  id: number;
  session_id: string | null;
  auxiliary_session_id: string | null;
  phase: "running" | "completed" | "failed" | "canceled";
  provider_id: string;
  model_id: string;
  reasoning_effort: string;
  approval_mode: string;
  sandbox_mode: string;
  user_message_seq: number | null;
  assistant_message_seq: number | null;
  thread_id: string;
  summary: string;
  error_summary: string;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
};

type LegacyAuditEventV6Row = {
  id: number;
  session_id: string | null;
  auxiliary_session_id: string | null;
  provider_id: string;
  summary: string;
  metadata_json: string;
  created_at: string;
};

type AuditLogPageRow = {
  id: number;
  source: "turn" | "legacy";
};

type ProviderOutputV6Row = {
  kind: string;
  summary: string;
  payload_json: string;
};

type InterimMessageV6Row = {
  seq: number;
  body: string;
  source: "stream_delta" | "running_snapshot" | "migration";
  created_at: string;
};

type LatestInterimV6Row = {
  seq: number;
  body: string;
};

type AuditTargetCleanupInput = {
  sessionIds?: readonly string[];
  auxiliarySessionIds?: readonly string[];
  allSessionTargets?: boolean;
};

type AuditLogOperationV6 = AuditLogEntry["operations"][number];

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const SESSION_AUDIT_OWNER_WHERE = `
  (
    session_id = ?
    OR auxiliary_session_id = ?
    OR auxiliary_session_id IN (
      SELECT id
      FROM auxiliary_sessions
      WHERE parent_session_id = ?
    )
  )
`;

function normalizePhase(phase: AuditLogEntry["phase"]): SessionTurnV6Row["phase"] {
  if (phase === "completed" || phase === "background-completed") {
    return "completed";
  }
  if (phase === "failed" || phase === "background-failed") {
    return "failed";
  }
  if (phase === "canceled" || phase === "background-canceled") {
    return "canceled";
  }
  return "running";
}

function toSummary(entry: AuditLogEntry): AuditLogSummary {
  const {
    logicalPrompt: _logicalPrompt,
    transportPayload: _transportPayload,
    assistantText,
    rawItemsJson: _rawItemsJson,
    providerMetadata: _providerMetadata,
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

function normalizeIds(ids: readonly string[] | undefined): string[] {
  return Array.from(new Set((ids ?? []).map((id) => id.trim()).filter(Boolean)));
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function outputPayload(value: unknown): string {
  return JSON.stringify({ value });
}

function outputValue<T>(row: ProviderOutputV6Row | undefined, fallback: T): T {
  if (!row) {
    return fallback;
  }
  const parsed = parseJson<{ value?: unknown }>(row.payload_json, {});
  return parsed.value === undefined ? fallback : parsed.value as T;
}

function operationSummaryPayload(operation: AuditLogOperationV6): string {
  return JSON.stringify({
    type: operation.type,
    summary: operation.summary,
  });
}

function parseOperationSummary(row: ProviderOutputV6Row): AuditLogOperationV6 {
  const parsed = parseJson<{ type?: unknown; summary?: unknown }>(row.summary, {});
  if (typeof parsed.type === "string" && typeof parsed.summary === "string") {
    return {
      type: parsed.type,
      summary: parsed.summary,
      detailAvailable: true,
    };
  }

  const legacyOperation = outputValue<AuditLogOperationV6>(row, {
    type: "",
    summary: row.summary,
    details: "",
  });
  return {
    type: legacyOperation.type,
    summary: legacyOperation.summary,
    detailAvailable: true,
  };
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName) as
    | { name?: string }
    | undefined;
  return row?.name === tableName;
}

function tableColumnNames(db: DatabaseSync, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === "string"));
}

function legacyAuditEventsTableExists(db: DatabaseSync): boolean {
  return tableExists(db, "audit_events_v6");
}

function legacyAuditEventsHasAuxiliarySessionId(db: DatabaseSync): boolean {
  return legacyAuditEventsTableExists(db) && tableColumnNames(db, "audit_events_v6").has("auxiliary_session_id");
}

function deleteLegacySessionTurnAuditEvents(db: DatabaseSync, input: AuditTargetCleanupInput): void {
  if (!legacyAuditEventsTableExists(db)) {
    return;
  }

  if (input.allSessionTargets) {
    db.prepare("DELETE FROM audit_events_v6 WHERE event_type = 'session_turn'").run();
    return;
  }

  const conditions: string[] = [];
  const params: string[] = [];
  const sessionIds = normalizeIds(input.sessionIds);
  if (sessionIds.length > 0) {
    conditions.push(`session_id IN (${sessionIds.map(() => "?").join(", ")})`);
    params.push(...sessionIds);
  }

  const auxiliarySessionIds = normalizeIds(input.auxiliarySessionIds);
  if (auxiliarySessionIds.length > 0 && legacyAuditEventsHasAuxiliarySessionId(db)) {
    conditions.push(`auxiliary_session_id IN (${auxiliarySessionIds.map(() => "?").join(", ")})`);
    params.push(...auxiliarySessionIds);
  }

  if (conditions.length === 0) {
    return;
  }

  db.prepare(`DELETE FROM audit_events_v6 WHERE event_type = 'session_turn' AND (${conditions.join(" OR ")})`).run(...params);
}

export function deleteAuditEventsForSessionTargets(db: DatabaseSync, input: AuditTargetCleanupInput): void {
  if (input.allSessionTargets) {
    db.prepare("DELETE FROM session_turns_v6").run();
    deleteLegacySessionTurnAuditEvents(db, input);
    return;
  }

  const conditions: string[] = [];
  const params: string[] = [];
  const sessionIds = normalizeIds(input.sessionIds);
  if (sessionIds.length > 0) {
    conditions.push(`session_id IN (${sessionIds.map(() => "?").join(", ")})`);
    params.push(...sessionIds);
  }

  const auxiliarySessionIds = normalizeIds(input.auxiliarySessionIds);
  if (auxiliarySessionIds.length > 0) {
    conditions.push(`auxiliary_session_id IN (${auxiliarySessionIds.map(() => "?").join(", ")})`);
    params.push(...auxiliarySessionIds);
  }

  if (conditions.length === 0) {
    return;
  }

  db.prepare(`DELETE FROM session_turns_v6 WHERE ${conditions.join(" OR ")}`).run(...params);
  deleteLegacySessionTurnAuditEvents(db, input);
}

export class AuditLogStorageV6 {
  private readonly db;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    ensureV6Schema(this.db);
  }

  createAuditLog(input: Omit<AuditLogEntry, "id">): AuditLogEntry {
    return this.transaction(() => {
      const target = this.resolveAuditTarget(input.sessionId);
      const result = this.db.prepare(`
        INSERT INTO session_turns_v6 (
          session_id,
          auxiliary_session_id,
          phase,
          provider_id,
          model_id,
          reasoning_effort,
          approval_mode,
          sandbox_mode,
          user_message_seq,
          assistant_message_seq,
          thread_id,
          summary,
          error_summary,
          started_at,
          completed_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        target.sessionId,
        target.auxiliarySessionId,
        normalizePhase(input.phase),
        input.provider,
        input.model,
        input.reasoningEffort,
        input.approvalMode,
        input.sandboxMode ?? "",
        input.userMessageSeq ?? null,
        input.assistantMessageSeq ?? null,
        input.threadId,
        input.transportPayload?.summary ?? input.phase,
        input.errorMessage,
        input.createdAt,
        normalizePhase(input.phase) === "running" ? null : input.createdAt,
        input.createdAt,
      );
      const id = Number(result.lastInsertRowid);
      this.appendRunningInterimSnapshot(id, input);
      this.replaceProviderOutputs(id, input);
      return { ...input, id };
    });
  }

  updateAuditLog(id: number, input: Omit<AuditLogEntry, "id">): AuditLogEntry {
    return this.transaction(() => {
      const entry = { ...input, id };
      const target = this.resolveAuditTarget(entry.sessionId);
      const result = this.db.prepare(`
        UPDATE session_turns_v6
        SET phase = ?,
            provider_id = ?,
            model_id = ?,
            reasoning_effort = ?,
            approval_mode = ?,
            sandbox_mode = ?,
            user_message_seq = COALESCE(?, user_message_seq),
            assistant_message_seq = ?,
            thread_id = ?,
            summary = ?,
            error_summary = ?,
            completed_at = ?,
            updated_at = ?
        WHERE id = ?
          AND session_id IS ?
          AND auxiliary_session_id IS ?
      `).run(
        normalizePhase(entry.phase),
        entry.provider,
        entry.model,
        entry.reasoningEffort,
        entry.approvalMode,
        entry.sandboxMode ?? "",
        entry.userMessageSeq ?? null,
        entry.assistantMessageSeq ?? null,
        entry.threadId,
        entry.transportPayload?.summary ?? entry.phase,
        entry.errorMessage,
        normalizePhase(entry.phase) === "running" ? null : entry.createdAt,
        entry.createdAt,
        id,
        target.sessionId,
        target.auxiliarySessionId,
      );
      if (result.changes !== 1) {
        throw new Error(`audit log not found or target mismatch: ${id}`);
      }
      this.appendRunningInterimSnapshot(id, entry);
      this.replaceProviderOutputs(id, entry);
      return entry;
    });
  }

  listSessionAuditLogs(sessionId: string): AuditLogEntry[] {
    return this.readEntries(sessionId, { includeOperationDetails: true });
  }

  listSessionAuditLogSummaries(sessionId: string): AuditLogSummary[] {
    return this.readEntries(sessionId, { includeOperationDetails: false }).map(toSummary);
  }

  listSessionAuditLogSummaryPage(
    sessionId: string,
    request?: AuditLogSummaryPageRequest | null,
  ): AuditLogSummaryPageResult {
    const { cursor, limit } = normalizePageRequest(request);
    const rows = this.readSummaryPageRows(sessionId, cursor, limit + 1);
    const visibleRows = rows.slice(0, limit);
    const entries = visibleRows
      .map((row) => this.readSummaryEntry(sessionId, row))
      .filter((entry): entry is AuditLogEntry => entry !== null);
    return {
      entries: entries.map(toSummary),
      nextCursor: rows.length > limit ? visibleRows[visibleRows.length - 1]?.id ?? null : null,
      hasMore: rows.length > limit,
      total: this.countEntries(sessionId),
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
      interimMessages: this.readInterimMessages(entry.id, entry.assistantText),
      operations: entry.operations,
      rawItemsJson: entry.rawItemsJson,
      providerMetadata: entry.providerMetadata ?? [],
      usage: entry.usage,
      errorMessage: entry.errorMessage,
    } : null;
  }

  getSessionAuditLogDetailSection(
    sessionId: string,
    auditLogId: number,
    section: AuditLogDetailSection,
  ): AuditLogDetailFragment | null {
    const row = this.readTurnRow(sessionId, auditLogId);
    if (!row) {
      const legacyEntry = this.readLegacyEntry(sessionId, auditLogId);
      if (!legacyEntry) {
        return null;
      }
      const base = { id: auditLogId, sessionId };
      if (section === "logical") {
        return { ...base, logicalPrompt: legacyEntry.logicalPrompt };
      }
      if (section === "transport") {
        return { ...base, transportPayload: legacyEntry.transportPayload };
      }
      if (section === "response") {
        return { ...base, assistantText: legacyEntry.assistantText, interimMessages: [] };
      }
      if (section === "raw") {
        return {
          ...base,
          rawItemsJson: legacyEntry.rawItemsJson,
          providerMetadata: legacyEntry.providerMetadata ?? [],
        };
      }
      if (section === "operations") {
        return { ...base, operations: legacyEntry.operations.map(({ details: _details, ...operation }) => operation) };
      }
      return null;
    }
    const base = { id: auditLogId, sessionId: detail.sessionId };
    if (section === "logical") {
      return {
        ...base,
        logicalPrompt: outputValue(
          this.readFirstProviderOutput(row.id, "logical_prompt"),
          { systemText: "", inputText: "", composedText: "" },
        ),
      };
    }
    if (section === "transport") {
      return { ...base, transportPayload: outputValue(this.readFirstProviderOutput(row.id, "transport_payload"), null) };
    }
    if (section === "response") {
      const assistantText = this.readAssistantText(row);
      return { ...base, assistantText, interimMessages: this.readInterimMessages(row.id, assistantText) };
    }
    if (section === "raw") {
      return {
        ...base,
        rawItemsJson: outputValue(this.readFirstProviderOutput(row.id, "raw_items"), ""),
        providerMetadata: this.readProviderMetadata(row.id),
      };
    }
    if (section === "operations") {
      return { ...base, operations: this.readOperationSummaries(row.id) };
    }
    return null;
  }

  getSessionAuditLogOperationDetail(
    sessionId: string,
    auditLogId: number,
    operationIndex: number,
  ): AuditLogOperationDetailFragment | null {
    const row = this.readTurnRow(sessionId, auditLogId);
    if (!row) {
      const legacyOperation = this.readLegacyEntry(sessionId, auditLogId)?.operations[operationIndex];
      return legacyOperation ? {
        id: auditLogId,
        sessionId,
        operationIndex,
        details: legacyOperation.details ?? "",
      } : null;
    }
    const details = this.readOperationDetail(row.id, operationIndex);
    return details !== null ? {
      id: auditLogId,
      sessionId: detail.sessionId,
      operationIndex,
      details,
    } : null;
  }

  clearAuditLogs(): void {
    this.transaction(() => {
      this.db.exec("DELETE FROM session_turns_v6;");
      deleteLegacySessionTurnAuditEvents(this.db, { allSessionTargets: true });
    });
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private replaceProviderOutputs(turnId: number, entry: Omit<AuditLogEntry, "id">): void {
    this.db.prepare("DELETE FROM session_turn_provider_outputs_v6 WHERE turn_id = ?").run(turnId);
    let seq = 0;
    const insertOutput = (kind: string, summary: string, value: unknown): void => {
      this.db.prepare(`
        INSERT INTO session_turn_provider_outputs_v6 (
          turn_id,
          seq,
          provider_id,
          kind,
          summary,
          payload_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(turnId, seq, entry.provider, kind, summary, outputPayload(value), entry.createdAt);
      seq += 1;
    };

    insertOutput("logical_prompt", "Logical Prompt", entry.logicalPrompt);
    if (entry.transportPayload) {
      insertOutput("transport_payload", entry.transportPayload.summary, entry.transportPayload);
    }
    for (const operation of entry.operations) {
      insertOutput("operation", operationSummaryPayload(operation), operation);
    }
    if (entry.rawItemsJson.trim() !== "") {
      insertOutput("raw_items", "Raw Items", entry.rawItemsJson);
    }
    if (entry.usage) {
      insertOutput("usage", "Usage", entry.usage);
    }
    if (entry.errorMessage.trim() !== "") {
      insertOutput("provider_error", "Provider Error", entry.errorMessage);
    }
    for (const metadata of entry.providerMetadata ?? []) {
      insertOutput("provider_metadata", metadata.summary, metadata);
    }
    if (
      normalizePhase(entry.phase) !== "running"
      && entry.assistantText.trim() !== ""
    ) {
      insertOutput("legacy_assistant_text", "Assistant Text", entry.assistantText);
    }
  }

  private appendRunningInterimSnapshot(turnId: number, entry: Omit<AuditLogEntry, "id">): void {
    if (normalizePhase(entry.phase) !== "running") {
      return;
    }

    const body = entry.assistantText.trim();
    if (body === "") {
      return;
    }

    const latest = this.db.prepare(`
      SELECT seq, body
      FROM session_turn_interims_v6
      WHERE turn_id = ?
      ORDER BY seq DESC
      LIMIT 1
    `).get(turnId) as LatestInterimV6Row | undefined;
    if (latest?.body === body) {
      return;
    }

    this.db.prepare(`
      INSERT INTO session_turn_interims_v6 (
        turn_id,
        seq,
        body,
        source,
        created_at
      ) VALUES (?, ?, ?, 'running_snapshot', ?)
    `).run(turnId, (latest?.seq ?? -1) + 1, body, entry.createdAt);
  }

  private readSummaryPageRows(sessionId: string, cursor: number | null, limit: number): AuditLogPageRow[] {
    const turnSelect = `
      SELECT id, 'turn' AS source
      FROM session_turns_v6
      WHERE (session_id = ? OR auxiliary_session_id = ?)
        AND (? IS NULL OR id < ?)
    `;
    const params: Array<string | number | null> = [sessionId, sessionId, cursor, cursor];
    const legacySelect = this.buildLegacyPageSelect(sessionId, cursor, params);
    const sql = `
      SELECT id, source
      FROM (
        ${legacySelect ? `${turnSelect}\n        UNION ALL\n        ${legacySelect}` : turnSelect}
      )
      ORDER BY id DESC
      LIMIT ?
    `;
    return this.db.prepare(sql).all(...params, limit) as AuditLogPageRow[];
  }

  private countEntries(sessionId: string): number {
    const turnCount = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM session_turns_v6
      WHERE session_id = ? OR auxiliary_session_id = ?
    `).get(sessionId, sessionId) as { count: number };
    return turnCount.count + this.countLegacyEntries(sessionId);
  }

  private countLegacyEntries(sessionId: string): number {
    if (!legacyAuditEventsTableExists(this.db)) {
      return 0;
    }
    const hasAuxiliarySessionId = legacyAuditEventsHasAuxiliarySessionId(this.db);
    const targetCondition = hasAuxiliarySessionId ? "(session_id = ? OR auxiliary_session_id = ?)" : "session_id = ?";
    const params = hasAuxiliarySessionId ? [sessionId, sessionId] : [sessionId];
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM audit_events_v6
      WHERE event_type = 'session_turn'
        AND ${targetCondition}
        AND NOT EXISTS (
          SELECT 1
          FROM session_turns_v6
          WHERE session_turns_v6.id = audit_events_v6.id
        )
    `).get(...params) as { count: number };
    return row.count;
  }

  private buildLegacyPageSelect(
    sessionId: string,
    cursor: number | null,
    params: Array<string | number | null>,
  ): string | null {
    if (!legacyAuditEventsTableExists(this.db)) {
      return null;
    }
    const hasAuxiliarySessionId = legacyAuditEventsHasAuxiliarySessionId(this.db);
    const targetCondition = hasAuxiliarySessionId ? "(session_id = ? OR auxiliary_session_id = ?)" : "session_id = ?";
    if (hasAuxiliarySessionId) {
      params.push(sessionId, sessionId);
    } else {
      params.push(sessionId);
    }
    params.push(cursor, cursor);
    return `
      SELECT id, 'legacy' AS source
      FROM audit_events_v6
      WHERE event_type = 'session_turn'
        AND ${targetCondition}
        AND (? IS NULL OR id < ?)
        AND NOT EXISTS (
          SELECT 1
          FROM session_turns_v6
          WHERE session_turns_v6.id = audit_events_v6.id
        )
    `;
  }

  private readEntries(sessionId: string, options: { includeOperationDetails: boolean }): AuditLogEntry[] {
    const rows = this.db.prepare(`
      SELECT id, session_id, auxiliary_session_id, phase, provider_id, model_id, reasoning_effort,
        approval_mode, sandbox_mode, user_message_seq, assistant_message_seq, thread_id,
        summary, error_summary, started_at, completed_at, updated_at
      FROM session_turns_v6
      WHERE (session_id = ? OR auxiliary_session_id = ?)
      ORDER BY id DESC
    `).all(sessionId, sessionId) as SessionTurnV6Row[];
    return [
      ...rows.map((row) => this.parseEntry(row, options)),
      ...this.readLegacyEntries(sessionId, options),
    ].sort((left, right) => right.id - left.id);
  }

  private readEntry(sessionId: string, auditLogId: number): AuditLogEntry | null {
    const row = this.readTurnRow(sessionId, auditLogId);
    return row
      ? this.parseEntry(row, { includeOperationDetails: true })
      : this.readLegacyEntry(sessionId, auditLogId);
  }

  private readSummaryEntry(sessionId: string, row: AuditLogPageRow): AuditLogEntry | null {
    if (row.source === "legacy") {
      return this.readLegacyEntryWithOptions(sessionId, row.id, { includeOperationDetails: false });
    }
    const turnRow = this.readTurnRow(sessionId, row.id);
    return turnRow ? this.parseEntry(turnRow, { includeOperationDetails: false }) : null;
  }

  private readTurnRow(sessionId: string, auditLogId: number): SessionTurnV6Row | null {
    const row = this.db.prepare(`
      SELECT id, session_id, auxiliary_session_id, phase, provider_id, model_id, reasoning_effort,
        approval_mode, sandbox_mode, user_message_seq, assistant_message_seq, thread_id,
        summary, error_summary, started_at, completed_at, updated_at
      FROM session_turns_v6
      WHERE (session_id = ? OR auxiliary_session_id = ?) AND id = ?
    `).get(sessionId, sessionId, auditLogId) as SessionTurnV6Row | undefined;
    return row ?? null;
  }

  private readLegacyEntries(sessionId: string, options: { includeOperationDetails: boolean }): AuditLogEntry[] {
    if (!legacyAuditEventsTableExists(this.db)) {
      return [];
    }
    const hasAuxiliarySessionId = legacyAuditEventsHasAuxiliarySessionId(this.db);
    const auxiliarySessionIdSelect = hasAuxiliarySessionId ? "auxiliary_session_id" : "NULL AS auxiliary_session_id";
    const targetCondition = hasAuxiliarySessionId ? "(session_id = ? OR auxiliary_session_id = ?)" : "session_id = ?";
    const params = hasAuxiliarySessionId ? [sessionId, sessionId] : [sessionId];
    const rows = this.db.prepare(`
      SELECT id, session_id, ${auxiliarySessionIdSelect}, provider_id, summary, metadata_json, created_at
      FROM audit_events_v6
      WHERE event_type = 'session_turn'
        AND ${targetCondition}
        AND NOT EXISTS (
          SELECT 1
          FROM session_turns_v6
          WHERE session_turns_v6.id = audit_events_v6.id
        )
      ORDER BY id DESC
    `).all(...params) as LegacyAuditEventV6Row[];
    return rows
      .map((row) => this.parseLegacyEntry(row, options))
      .filter((entry): entry is AuditLogEntry => entry !== null);
  }

  private readLegacyEntry(sessionId: string, auditLogId: number): AuditLogEntry | null {
    return this.readLegacyEntryWithOptions(sessionId, auditLogId, { includeOperationDetails: true });
  }

  private readLegacyEntryWithOptions(
    sessionId: string,
    auditLogId: number,
    options: { includeOperationDetails: boolean },
  ): AuditLogEntry | null {
    if (!legacyAuditEventsTableExists(this.db)) {
      return null;
    }
    const hasAuxiliarySessionId = legacyAuditEventsHasAuxiliarySessionId(this.db);
    const auxiliarySessionIdSelect = hasAuxiliarySessionId ? "auxiliary_session_id" : "NULL AS auxiliary_session_id";
    const targetCondition = hasAuxiliarySessionId ? "(session_id = ? OR auxiliary_session_id = ?)" : "session_id = ?";
    const params = hasAuxiliarySessionId ? [sessionId, sessionId, auditLogId] : [sessionId, auditLogId];
    const row = this.db.prepare(`
      SELECT id, session_id, ${auxiliarySessionIdSelect}, provider_id, summary, metadata_json, created_at
      FROM audit_events_v6
      WHERE event_type = 'session_turn'
        AND ${targetCondition}
        AND id = ?
        AND NOT EXISTS (
          SELECT 1
          FROM session_turns_v6
          WHERE session_turns_v6.id = audit_events_v6.id
        )
    `).get(...params) as LegacyAuditEventV6Row | undefined;
    return row ? this.parseLegacyEntry(row, options) : null;
  }

  private parseEntry(row: SessionTurnV6Row, options: { includeOperationDetails: boolean }): AuditLogEntry {
    const outputRows = this.db.prepare(`
      SELECT kind, summary, ${
        options.includeOperationDetails
          ? "payload_json"
          : "CASE WHEN kind IN ('operation', 'raw_items', 'logical_prompt', 'transport_payload', 'provider_metadata') THEN '' ELSE payload_json END AS payload_json"
      }
      FROM session_turn_provider_outputs_v6
      WHERE turn_id = ?
      ORDER BY seq ASC
    `).all(row.id) as ProviderOutputV6Row[];
    const firstOutput = (kind: string): ProviderOutputV6Row | undefined => outputRows.find((output) => output.kind === kind);
    const operationRows = outputRows.filter((output) => output.kind === "operation");
    return {
      id: row.id,
      sessionId: row.session_id ?? row.auxiliary_session_id ?? "",
      createdAt: row.started_at,
      phase: row.phase,
      provider: row.provider_id,
      model: row.model_id,
      reasoningEffort: row.reasoning_effort as AuditLogEntry["reasoningEffort"],
      approvalMode: row.approval_mode as AuditLogEntry["approvalMode"],
      sandboxMode: row.sandbox_mode as AuditLogEntry["sandboxMode"],
      userMessageSeq: row.user_message_seq,
      assistantMessageSeq: row.assistant_message_seq,
      threadId: row.thread_id,
      logicalPrompt: outputValue(firstOutput("logical_prompt"), { systemText: "", inputText: "", composedText: "" }),
      transportPayload: outputValue(firstOutput("transport_payload"), null),
      assistantText: this.readAssistantText(row, firstOutput("legacy_assistant_text")),
      operations: options.includeOperationDetails
        ? operationRows.map((operation) => outputValue(operation, { type: "", summary: operation.summary, details: "" }))
        : operationRows.map(parseOperationSummary),
      rawItemsJson: outputValue(firstOutput("raw_items"), ""),
      providerMetadata: outputRows
        .filter((output) => output.kind === "provider_metadata")
        .map((output) => outputValue<NonNullable<AuditLogEntry["providerMetadata"]>[number] | null>(output, null))
        .filter((metadata): metadata is NonNullable<AuditLogEntry["providerMetadata"]>[number] => Boolean(metadata)),
      usage: outputValue(firstOutput("usage"), null),
      errorMessage: outputValue(firstOutput("provider_error"), row.error_summary),
    };
  }

  private parseLegacyEntry(
    row: LegacyAuditEventV6Row,
    options: { includeOperationDetails: boolean },
  ): AuditLogEntry | null {
    const metadata = parseJson<Record<string, unknown> | null>(row.metadata_json, null);
    if (!metadata || typeof metadata !== "object") {
      return null;
    }
    const operations: AuditLogOperationV6[] = Array.isArray(metadata.operations)
      ? metadata.operations
        .filter((operation): operation is Record<string, unknown> => typeof operation === "object" && operation !== null)
        .map((operation) => ({
          type: typeof operation.type === "string" ? operation.type : "",
          summary: typeof operation.summary === "string" ? operation.summary : "Operation",
          details: options.includeOperationDetails && typeof operation.details === "string" ? operation.details : undefined,
          detailAvailable: !options.includeOperationDetails ? true : undefined,
        }))
      : [];
    const providerMetadata = Array.isArray(metadata.providerMetadata)
      ? metadata.providerMetadata.filter((value): value is NonNullable<AuditLogEntry["providerMetadata"]>[number] => (
        typeof value === "object" && value !== null
      ))
      : [];
    return {
      id: row.id,
      sessionId: row.session_id ?? row.auxiliary_session_id ?? "",
      createdAt: row.created_at,
      phase: normalizePhase(typeof metadata.phase === "string" ? metadata.phase as AuditLogEntry["phase"] : "running"),
      provider: typeof metadata.provider === "string" ? metadata.provider : row.provider_id,
      model: typeof metadata.model === "string" ? metadata.model : "",
      reasoningEffort: (
        typeof metadata.reasoningEffort === "string" ? metadata.reasoningEffort : ""
      ) as AuditLogEntry["reasoningEffort"],
      approvalMode: (
        typeof metadata.approvalMode === "string" ? metadata.approvalMode : ""
      ) as AuditLogEntry["approvalMode"],
      sandboxMode: typeof metadata.sandboxMode === "string" ? metadata.sandboxMode as AuditLogEntry["sandboxMode"] : "",
      userMessageSeq: typeof metadata.userMessageSeq === "number" ? metadata.userMessageSeq : null,
      assistantMessageSeq: typeof metadata.assistantMessageSeq === "number" ? metadata.assistantMessageSeq : null,
      threadId: typeof metadata.threadId === "string" ? metadata.threadId : "",
      logicalPrompt: typeof metadata.logicalPrompt === "object" && metadata.logicalPrompt !== null
        ? metadata.logicalPrompt as AuditLogEntry["logicalPrompt"]
        : { systemText: "", inputText: "", composedText: "" },
      transportPayload: typeof metadata.transportPayload === "object" && metadata.transportPayload !== null
        ? metadata.transportPayload as AuditLogEntry["transportPayload"]
        : null,
      assistantText: typeof metadata.assistantText === "string" ? metadata.assistantText : "",
      operations,
      rawItemsJson: typeof metadata.rawItemsJson === "string" ? metadata.rawItemsJson : "",
      providerMetadata,
      usage: typeof metadata.usage === "object" && metadata.usage !== null ? metadata.usage as AuditLogEntry["usage"] : null,
      errorMessage: typeof metadata.errorMessage === "string" ? metadata.errorMessage : "",
    };
  }

  private readAssistantText(row: SessionTurnV6Row, legacyOutput?: ProviderOutputV6Row): string {
    const legacyAssistantText = outputValue(legacyOutput ?? this.readFirstProviderOutput(row.id, "legacy_assistant_text"), "");
    if (legacyAssistantText.trim() !== "") {
      return legacyAssistantText;
    }
    if (!row.session_id || row.assistant_message_seq === null) {
      return "";
    }
    const messageRow = this.db.prepare(`
      SELECT body
      FROM session_messages_v6
      WHERE session_id = ? AND seq = ? AND role = 'assistant'
      LIMIT 1
    `).get(row.session_id, row.assistant_message_seq) as { body?: string } | undefined;
    return typeof messageRow?.body === "string" ? messageRow.body : "";
  }

  private readProviderMetadata(turnId: number): NonNullable<AuditLogEntry["providerMetadata"]> {
    const rows = this.db.prepare(`
      SELECT kind, summary, payload_json
      FROM session_turn_provider_outputs_v6
      WHERE turn_id = ? AND kind = 'provider_metadata'
      ORDER BY seq ASC
    `).all(turnId) as ProviderOutputV6Row[];
    return rows
      .map((row) => outputValue<NonNullable<AuditLogEntry["providerMetadata"]>[number] | null>(row, null))
      .filter((metadata): metadata is NonNullable<AuditLogEntry["providerMetadata"]>[number] => Boolean(metadata));
  }

  private readFirstProviderOutput(turnId: number, kind: string): ProviderOutputV6Row | undefined {
    return this.db.prepare(`
      SELECT kind, summary, payload_json
      FROM session_turn_provider_outputs_v6
      WHERE turn_id = ? AND kind = ?
      ORDER BY seq ASC
      LIMIT 1
    `).get(turnId, kind) as ProviderOutputV6Row | undefined;
  }

  private readOperationSummaries(turnId: number): AuditLogEntry["operations"] {
    const rows = this.db.prepare(`
      SELECT kind, summary, '' AS payload_json
      FROM session_turn_provider_outputs_v6
      WHERE turn_id = ? AND kind = 'operation'
      ORDER BY seq ASC
    `).all(turnId) as ProviderOutputV6Row[];
    return rows.map(parseOperationSummary);
  }

  private readOperationDetail(turnId: number, operationIndex: number): string | null {
    if (!Number.isInteger(operationIndex) || operationIndex < 0) {
      return null;
    }
    const row = this.db.prepare(`
      SELECT kind, summary, payload_json
      FROM session_turn_provider_outputs_v6
      WHERE turn_id = ? AND kind = 'operation'
      ORDER BY seq ASC
      LIMIT 1 OFFSET ?
    `).get(turnId, operationIndex) as ProviderOutputV6Row | undefined;
    if (!row) {
      return null;
    }
    return outputValue<AuditLogOperationV6>(row, { type: "", summary: row.summary, details: "" }).details ?? "";
  }

  private readInterimMessages(turnId: number, finalAssistantText: string): AuditLogDetail["interimMessages"] {
    const finalText = finalAssistantText.trim();
    const rows = this.db.prepare(`
      SELECT seq, body, source, created_at
      FROM session_turn_interims_v6
      WHERE turn_id = ?
      ORDER BY seq ASC
    `).all(turnId) as InterimMessageV6Row[];
    return rows
      .filter((row) => row.body.trim() !== "" && row.body.trim() !== finalText)
      .map((row) => ({
        seq: row.seq,
        body: row.body,
        source: row.source,
        createdAt: row.created_at,
      }));
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
