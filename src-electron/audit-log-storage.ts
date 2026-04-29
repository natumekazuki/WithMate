import type { DatabaseSync, StatementSync } from "node:sqlite";

import {
  type AuditLogDetail,
  type AuditLogEntry,
  type AuditLogicalPrompt,
  type AuditLogOperation,
  type AuditLogPhase,
  type AuditLogSummary,
  type AuditLogSummaryPageRequest,
  type AuditLogSummaryPageResult,
  type AuditLogUsage,
  type AuditTransportPayload,
} from "../src/app-state.js";
import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode } from "../src/approval-mode.js";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID, DEFAULT_REASONING_EFFORT } from "../src/model-catalog.js";
import {
  CREATE_AUDIT_LOGS_TABLE_SQL,
  LEGACY_AUDIT_LOG_COLUMN_DEFINITIONS,
} from "./database-schema-v1.js";
import { openAppDatabase } from "./sqlite-connection.js";

type AuditLogRow = {
  id: number;
  session_id: string;
  created_at: string;
  phase: string;
  provider: string;
  model: string;
  reasoning_effort: string;
  approval_mode: string;
  thread_id: string;
  logical_prompt_json: string;
  transport_payload_json: string;
  assistant_text: string;
  operations_json: string;
  raw_items_json: string;
  usage_json: string;
  error_message: string;
};

type CreateAuditLogInput = Omit<AuditLogEntry, "id">;
type TableInfoRow = {
  name: string;
};
type AuditLogSummaryRow = Omit<
  AuditLogRow,
  "logical_prompt_json" | "transport_payload_json" | "assistant_text" | "operations_json" | "raw_items_json"
> & {
  assistant_text_preview: string;
  operation_count: number;
};
type CountRow = {
  count: number;
};

const DEFAULT_AUDIT_LOG_PAGE_LIMIT = 50;
const MAX_AUDIT_LOG_PAGE_LIMIT = 200;
const ASSISTANT_TEXT_PREVIEW_MAX_LENGTH = 500;

function toAuditLogPhase(value: string): AuditLogPhase {
  if (
    value === "running"
    || value === "started"
    || value === "completed"
    || value === "failed"
    || value === "canceled"
    || value === "background-running"
    || value === "background-completed"
    || value === "background-failed"
    || value === "background-canceled"
  ) {
    return value;
  }

  return "failed";
}

function toAuditLogUsage(value: string): AuditLogUsage | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as AuditLogUsage;
  } catch {
    return null;
  }
}

function parseOperations(value: string): AuditLogOperation[] {
  if (!value) {
    return [];
  }

  try {
    return JSON.parse(value) as AuditLogOperation[];
  } catch {
    return [];
  }
}

function parseLogicalPrompt(value: string): AuditLogicalPrompt {
  if (value) {
    try {
      const parsed = JSON.parse(value) as Partial<AuditLogicalPrompt>;
      return {
        systemText: typeof parsed.systemText === "string" ? parsed.systemText : "",
        inputText: typeof parsed.inputText === "string" ? parsed.inputText : "",
        composedText: typeof parsed.composedText === "string" ? parsed.composedText : "",
      };
    } catch {
      // fallback below
    }
  }

  return {
    systemText: "",
    inputText: "",
    composedText: "",
  };
}

function parseTransportPayload(value: string): AuditTransportPayload | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<AuditTransportPayload>;
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      fields: Array.isArray(parsed.fields)
        ? parsed.fields
            .map((field) => ({
              label:
                typeof field === "object" && field !== null && "label" in field && typeof field.label === "string"
                  ? field.label
                  : "",
              value:
                typeof field === "object" && field !== null && "value" in field && typeof field.value === "string"
                  ? field.value
                  : "",
            }))
            .filter((field) => field.label || field.value)
        : [],
    };
  } catch {
    return null;
  }
}

function rowToAuditLogEntry(row: AuditLogRow): AuditLogEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    phase: toAuditLogPhase(row.phase),
    provider: row.provider || DEFAULT_PROVIDER_ID,
    model: row.model || DEFAULT_MODEL_ID,
    reasoningEffort:
      row.reasoning_effort === "minimal" ||
      row.reasoning_effort === "low" ||
      row.reasoning_effort === "medium" ||
      row.reasoning_effort === "high" ||
      row.reasoning_effort === "xhigh"
        ? row.reasoning_effort
        : DEFAULT_REASONING_EFFORT,
    approvalMode: normalizeApprovalMode(row.approval_mode, DEFAULT_APPROVAL_MODE),
    threadId: row.thread_id || "",
    logicalPrompt: parseLogicalPrompt(row.logical_prompt_json),
    transportPayload: parseTransportPayload(row.transport_payload_json),
    assistantText: row.assistant_text || "",
    operations: parseOperations(row.operations_json),
    rawItemsJson: row.raw_items_json || "[]",
    usage: toAuditLogUsage(row.usage_json),
    errorMessage: row.error_message || "",
  };
}

function rowToAuditLogSummary(row: AuditLogRow): AuditLogSummary {
  const entry = rowToAuditLogEntry(row);
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    createdAt: entry.createdAt,
    phase: entry.phase,
    provider: entry.provider,
    model: entry.model,
    reasoningEffort: entry.reasoningEffort,
    approvalMode: entry.approvalMode,
    threadId: entry.threadId,
    assistantTextPreview: entry.assistantText.slice(0, 500),
    operations: entry.operations.map((operation) => ({
      type: operation.type,
      summary: operation.summary,
    })),
    usage: entry.usage,
    errorMessage: entry.errorMessage,
    detailAvailable: true,
  };
}

function rowToAuditLogSummaryFromSummaryRow(row: AuditLogSummaryRow): AuditLogSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    phase: toAuditLogPhase(row.phase),
    provider: row.provider || DEFAULT_PROVIDER_ID,
    model: row.model || DEFAULT_MODEL_ID,
    reasoningEffort:
      row.reasoning_effort === "minimal" ||
      row.reasoning_effort === "low" ||
      row.reasoning_effort === "medium" ||
      row.reasoning_effort === "high" ||
      row.reasoning_effort === "xhigh"
        ? row.reasoning_effort
        : DEFAULT_REASONING_EFFORT,
    approvalMode: normalizeApprovalMode(row.approval_mode, DEFAULT_APPROVAL_MODE),
    threadId: row.thread_id || "",
    assistantTextPreview: row.assistant_text_preview || "",
    operations: row.operation_count > 0
      ? [{ type: "operation", summary: `${row.operation_count} operations` }]
      : [],
    usage: toAuditLogUsage(row.usage_json),
    errorMessage: row.error_message || "",
    detailAvailable: true,
  };
}

function normalizeAuditLogSummaryPageRequest(request?: AuditLogSummaryPageRequest | null): { offset: number; limit: number } {
  const cursor = request?.cursor ?? 0;
  const requestedLimit = request?.limit ?? DEFAULT_AUDIT_LOG_PAGE_LIMIT;
  const offset = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(1, Math.floor(requestedLimit)), MAX_AUDIT_LOG_PAGE_LIMIT)
    : DEFAULT_AUDIT_LOG_PAGE_LIMIT;

  return { offset, limit };
}

function buildAuditLogSummaryPage(
  rows: AuditLogSummaryRow[],
  total: number,
  offset: number,
): AuditLogSummaryPageResult {
  const entries = rows.map(rowToAuditLogSummaryFromSummaryRow);
  const nextCursor = offset + entries.length < total ? offset + entries.length : null;

  return {
    entries,
    nextCursor,
    hasMore: nextCursor !== null,
    total,
  };
}

function entryToAuditLogDetail(entry: AuditLogEntry): AuditLogDetail {
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    logicalPrompt: entry.logicalPrompt,
    transportPayload: entry.transportPayload,
    assistantText: entry.assistantText,
    operations: entry.operations,
    rawItemsJson: entry.rawItemsJson,
    usage: entry.usage,
    errorMessage: entry.errorMessage,
  };
}

export class AuditLogStorage {
  private readonly db: DatabaseSync;
  private readonly listStatement: StatementSync;
  private readonly listSummaryStatement: StatementSync;
  private readonly listSummaryPageStatement: StatementSync;
  private readonly countSessionLogsStatement: StatementSync;
  private readonly getStatement: StatementSync;
  private readonly insertStatement: StatementSync;
  private readonly updateStatement: StatementSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    this.createTable();
    this.ensureColumns();

    this.listStatement = this.db.prepare(`
      SELECT
        id,
        session_id,
        created_at,
        phase,
        provider,
        model,
        reasoning_effort,
        approval_mode,
        thread_id,
        logical_prompt_json,
        transport_payload_json,
        assistant_text,
        operations_json,
        raw_items_json,
        usage_json,
        error_message
      FROM audit_logs
      WHERE session_id = ?
      ORDER BY id DESC
    `);

    this.listSummaryStatement = this.db.prepare(`
      SELECT
        id,
        session_id,
        created_at,
        phase,
        provider,
        model,
        reasoning_effort,
        approval_mode,
        thread_id,
        substr(COALESCE(assistant_text, ''), 1, ${ASSISTANT_TEXT_PREVIEW_MAX_LENGTH}) AS assistant_text_preview,
        CASE
          WHEN operations_json IS NULL OR operations_json = '' OR operations_json = '[]' THEN 0
          ELSE 1
        END AS operation_count,
        usage_json,
        error_message
      FROM audit_logs
      WHERE session_id = ?
      ORDER BY id DESC
    `);

    this.listSummaryPageStatement = this.db.prepare(`
      SELECT
        id,
        session_id,
        created_at,
        phase,
        provider,
        model,
        reasoning_effort,
        approval_mode,
        thread_id,
        substr(COALESCE(assistant_text, ''), 1, ${ASSISTANT_TEXT_PREVIEW_MAX_LENGTH}) AS assistant_text_preview,
        CASE
          WHEN operations_json IS NULL OR operations_json = '' OR operations_json = '[]' THEN 0
          ELSE 1
        END AS operation_count,
        usage_json,
        error_message
      FROM audit_logs
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `);

    this.countSessionLogsStatement = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM audit_logs
      WHERE session_id = ?
    `);

    this.getStatement = this.db.prepare(`
      SELECT
        id,
        session_id,
        created_at,
        phase,
        provider,
        model,
        reasoning_effort,
        approval_mode,
        thread_id,
        logical_prompt_json,
        transport_payload_json,
        assistant_text,
        operations_json,
        raw_items_json,
        usage_json,
        error_message
      FROM audit_logs
      WHERE session_id = ? AND id = ?
    `);

    this.insertStatement = this.db.prepare(`
      INSERT INTO audit_logs (
        session_id,
        created_at,
        phase,
        provider,
        model,
        reasoning_effort,
        approval_mode,
        thread_id,
        logical_prompt_json,
        transport_payload_json,
        assistant_text,
        operations_json,
        raw_items_json,
        usage_json,
        error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING
        id,
        session_id,
        created_at,
        phase,
        provider,
        model,
        reasoning_effort,
        approval_mode,
        thread_id,
        logical_prompt_json,
        transport_payload_json,
        assistant_text,
        operations_json,
        raw_items_json,
        usage_json,
        error_message
    `);

    this.updateStatement = this.db.prepare(`
      UPDATE audit_logs
      SET
        phase = ?,
        provider = ?,
        model = ?,
        reasoning_effort = ?,
        approval_mode = ?,
        thread_id = ?,
        logical_prompt_json = ?,
        transport_payload_json = ?,
        assistant_text = ?,
        operations_json = ?,
        raw_items_json = ?,
        usage_json = ?,
        error_message = ?
      WHERE id = ?
      RETURNING
        id,
        session_id,
        created_at,
        phase,
        provider,
        model,
        reasoning_effort,
        approval_mode,
        thread_id,
        logical_prompt_json,
        transport_payload_json,
        assistant_text,
        operations_json,
        raw_items_json,
        usage_json,
        error_message
    `);
  }

  private getCurrentColumnNames(): Set<string> {
    return new Set(
      (this.db.prepare(`SELECT name FROM pragma_table_info('audit_logs')`).all() as TableInfoRow[]).map((column) => column.name),
    );
  }

  private createTable(): void {
    this.db.exec(CREATE_AUDIT_LOGS_TABLE_SQL);
  }

  private ensureColumns(): void {
    const columnNames = this.getCurrentColumnNames();

    const requiredColumns = Object.entries(LEGACY_AUDIT_LOG_COLUMN_DEFINITIONS)
      .map(([name, definition]) => ({ name, definition }));

    for (const column of requiredColumns) {
      if (!columnNames.has(column.name)) {
        this.db.exec(`ALTER TABLE audit_logs ADD COLUMN ${column.name} ${column.definition};`);
      }
    }
  }

  listSessionAuditLogs(sessionId: string): AuditLogEntry[] {
    const rows = this.listStatement.all(sessionId) as AuditLogRow[];
    return rows.map(rowToAuditLogEntry);
  }

  listSessionAuditLogSummaries(sessionId: string): AuditLogSummary[] {
    const rows = this.listSummaryStatement.all(sessionId) as AuditLogSummaryRow[];
    return rows.map(rowToAuditLogSummaryFromSummaryRow);
  }

  listSessionAuditLogSummaryPage(
    sessionId: string,
    request?: AuditLogSummaryPageRequest | null,
  ): AuditLogSummaryPageResult {
    const { offset, limit } = normalizeAuditLogSummaryPageRequest(request);
    const rows = this.listSummaryPageStatement.all(sessionId, limit, offset) as AuditLogSummaryRow[];
    const countRow = this.countSessionLogsStatement.get(sessionId) as CountRow | undefined;
    return buildAuditLogSummaryPage(rows, countRow?.count ?? 0, offset);
  }

  getSessionAuditLogDetail(sessionId: string, auditLogId: number): AuditLogDetail | null {
    const row = this.getStatement.get(sessionId, auditLogId) as AuditLogRow | undefined;
    return row ? entryToAuditLogDetail(rowToAuditLogEntry(row)) : null;
  }

  createAuditLog(input: CreateAuditLogInput): AuditLogEntry {
    const row = this.insertStatement.get(
      input.sessionId,
      input.createdAt,
      input.phase,
      input.provider,
      input.model,
      input.reasoningEffort,
      input.approvalMode,
      input.threadId,
      JSON.stringify(input.logicalPrompt),
      input.transportPayload ? JSON.stringify(input.transportPayload) : "",
      input.assistantText,
      JSON.stringify(input.operations),
      input.rawItemsJson,
      input.usage ? JSON.stringify(input.usage) : "",
      input.errorMessage,
    ) as AuditLogRow;

    return rowToAuditLogEntry(row);
  }

  updateAuditLog(id: number, input: CreateAuditLogInput): AuditLogEntry {
    const row = this.updateStatement.get(
      input.phase,
      input.provider,
      input.model,
      input.reasoningEffort,
      input.approvalMode,
      input.threadId,
      JSON.stringify(input.logicalPrompt),
      input.transportPayload ? JSON.stringify(input.transportPayload) : "",
      input.assistantText,
      JSON.stringify(input.operations),
      input.rawItemsJson,
      input.usage ? JSON.stringify(input.usage) : "",
      input.errorMessage,
      id,
    ) as AuditLogRow | undefined;

    if (!row) {
      throw new Error(`audit log ${id} の更新に失敗したよ。`);
    }

    return rowToAuditLogEntry(row);
  }

  clearAuditLogs(): void {
    this.db.exec("DELETE FROM audit_logs;");
  }

  close(): void {
    this.db.close();
  }
}
