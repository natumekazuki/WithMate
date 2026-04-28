import type { DatabaseSync } from "node:sqlite";

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
import { openAppDatabase } from "./sqlite-connection.js";

type AuditLogSummaryRow = {
  id: number;
  session_id: string;
  created_at: string;
  phase: string;
  provider: string;
  model: string;
  reasoning_effort: string;
  approval_mode: string;
  thread_id: string;
  assistant_text_preview: string;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  error_message: string;
  detail_available: number;
  logical_prompt_json: string | null;
  transport_payload_json: string | null;
  assistant_text: string | null;
  raw_items_json: string | null;
  usage_json: string | null;
};

type AuditLogOperationRow = {
  audit_log_id: number;
  seq: number;
  operation_type: string;
  summary: string;
  details: string;
};

type CreateAuditLogInput = Omit<AuditLogEntry, "id">;

type AuditLogUsageColumns = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
};

type AuditLogSessionIdRow = {
  session_id: string;
};

type CountRow = {
  count: number;
};

const ASSISTANT_TEXT_PREVIEW_MAX_LENGTH = 500;
const DEFAULT_AUDIT_LOG_PAGE_LIMIT = 50;
const MAX_AUDIT_LOG_PAGE_LIMIT = 200;

const DEFAULT_LOGICAL_PROMPT: AuditLogicalPrompt = {
  systemText: "",
  inputText: "",
  composedText: "",
};

const INSERT_AUDIT_LOG_SQL = `
  INSERT INTO audit_logs (
    session_id,
    created_at,
    phase,
    provider,
    model,
    reasoning_effort,
    approval_mode,
    thread_id,
    assistant_text_preview,
    operation_count,
    raw_item_count,
    input_tokens,
    cached_input_tokens,
    output_tokens,
    has_error,
    error_message,
    detail_available
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_AUDIT_LOG_DETAIL_SQL = `
  INSERT INTO audit_log_details (
    audit_log_id,
    logical_prompt_json,
    transport_payload_json,
    assistant_text,
    raw_items_json,
    usage_json
  ) VALUES (?, ?, ?, ?, ?, ?)
`;

const INSERT_AUDIT_LOG_OPERATION_SQL = `
  INSERT INTO audit_log_operations (
    audit_log_id,
    seq,
    operation_type,
    summary,
    details
  ) VALUES (?, ?, ?, ?, ?)
`;

const UPDATE_AUDIT_LOG_SQL = `
  UPDATE audit_logs
  SET
    phase = ?,
    provider = ?,
    model = ?,
    reasoning_effort = ?,
    approval_mode = ?,
    thread_id = ?,
    assistant_text_preview = ?,
    operation_count = ?,
    raw_item_count = ?,
    input_tokens = ?,
    cached_input_tokens = ?,
    output_tokens = ?,
    has_error = ?,
    error_message = ?,
    detail_available = ?
  WHERE id = ?
`;

const DELETE_AUDIT_LOGS_SQL = "DELETE FROM audit_logs";
const DELETE_AUDIT_LOG_DETAIL_SQL = "DELETE FROM audit_log_details WHERE audit_log_id = ?";
const DELETE_AUDIT_LOG_OPERATION_SQL = "DELETE FROM audit_log_operations WHERE audit_log_id = ?";
const GET_AUDIT_LOG_SESSION_ID_SQL = "SELECT session_id FROM audit_logs WHERE id = ?";
const INCREMENT_SESSION_AUDIT_LOG_COUNT_SQL = `
  UPDATE sessions
  SET audit_log_count = audit_log_count + 1
  WHERE id = ?
`;
const RESET_SESSION_AUDIT_LOG_COUNTS_SQL = `
  UPDATE sessions
  SET audit_log_count = 0
`;

const LIST_SESSION_AUDIT_LOGS_SQL = `
  SELECT
    a.id,
    a.session_id,
    a.created_at,
    a.phase,
    a.provider,
    a.model,
    a.reasoning_effort,
    a.approval_mode,
    a.thread_id,
    a.assistant_text_preview,
    a.input_tokens,
    a.cached_input_tokens,
    a.output_tokens,
    a.error_message,
    a.detail_available,
    d.logical_prompt_json,
    d.transport_payload_json,
    d.assistant_text,
    d.raw_items_json,
    d.usage_json
  FROM audit_logs AS a
  LEFT JOIN audit_log_details AS d
    ON d.audit_log_id = a.id
  WHERE a.session_id = ?
  ORDER BY a.id DESC
`;

const LIST_SESSION_AUDIT_LOG_OPERATIONS_SQL = `
  SELECT
    o.audit_log_id,
    o.seq,
    o.operation_type,
    o.summary,
    o.details
  FROM audit_log_operations AS o
  INNER JOIN audit_logs AS a
    ON a.id = o.audit_log_id
  WHERE a.session_id = ?
  ORDER BY o.audit_log_id ASC, o.seq ASC
`;

const LIST_SESSION_AUDIT_LOG_OPERATION_SUMMARIES_SQL = `
  SELECT
    o.audit_log_id,
    o.seq,
    o.operation_type,
    o.summary,
    '' AS details
  FROM audit_log_operations AS o
  INNER JOIN audit_logs AS a
    ON a.id = o.audit_log_id
  WHERE a.session_id = ?
  ORDER BY o.audit_log_id ASC, o.seq ASC
`;

const LIST_AUDIT_LOG_OPERATIONS_SQL = `
  SELECT
    o.audit_log_id,
    o.seq,
    o.operation_type,
    o.summary,
    o.details
  FROM audit_log_operations AS o
  WHERE o.audit_log_id = ?
  ORDER BY o.seq ASC
`;

const LIST_SESSION_AUDIT_LOG_SUMMARIES_SQL = `
  SELECT
    a.id,
    a.session_id,
    a.created_at,
    a.phase,
    a.provider,
    a.model,
    a.reasoning_effort,
    a.approval_mode,
    a.thread_id,
    a.assistant_text_preview,
    a.input_tokens,
    a.cached_input_tokens,
    a.output_tokens,
    a.error_message,
    a.detail_available,
    NULL AS logical_prompt_json,
    NULL AS transport_payload_json,
    NULL AS assistant_text,
    NULL AS raw_items_json,
    NULL AS usage_json
  FROM audit_logs AS a
  WHERE a.session_id = ?
  ORDER BY a.id DESC
`;

const LIST_SESSION_AUDIT_LOG_SUMMARY_PAGE_SQL = `
  SELECT
    a.id,
    a.session_id,
    a.created_at,
    a.phase,
    a.provider,
    a.model,
    a.reasoning_effort,
    a.approval_mode,
    a.thread_id,
    a.assistant_text_preview,
    a.input_tokens,
    a.cached_input_tokens,
    a.output_tokens,
    a.error_message,
    a.detail_available,
    NULL AS logical_prompt_json,
    NULL AS transport_payload_json,
    NULL AS assistant_text,
    NULL AS raw_items_json,
    NULL AS usage_json
  FROM audit_logs AS a
  WHERE a.session_id = ?
  ORDER BY a.id DESC
  LIMIT ? OFFSET ?
`;

const LIST_SESSION_AUDIT_LOG_OPERATION_SUMMARY_PAGE_SQL = `
  SELECT
    o.audit_log_id,
    o.seq,
    o.operation_type,
    o.summary,
    '' AS details
  FROM audit_log_operations AS o
  INNER JOIN audit_logs AS a
    ON a.id = o.audit_log_id
  WHERE a.session_id = ?
    AND o.audit_log_id IN (
      SELECT id
      FROM audit_logs
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    )
  ORDER BY o.audit_log_id ASC, o.seq ASC
`;

const COUNT_SESSION_AUDIT_LOGS_SQL = `
  SELECT COUNT(*) AS count
  FROM audit_logs
  WHERE session_id = ?
`;

const GET_SESSION_AUDIT_LOG_DETAIL_SQL = `
  SELECT
    a.id,
    a.session_id,
    a.created_at,
    a.phase,
    a.provider,
    a.model,
    a.reasoning_effort,
    a.approval_mode,
    a.thread_id,
    a.assistant_text_preview,
    a.input_tokens,
    a.cached_input_tokens,
    a.output_tokens,
    a.error_message,
    a.detail_available,
    d.logical_prompt_json,
    d.transport_payload_json,
    d.assistant_text,
    d.raw_items_json,
    d.usage_json
  FROM audit_logs AS a
  LEFT JOIN audit_log_details AS d
    ON d.audit_log_id = a.id
  WHERE a.session_id = ? AND a.id = ?
`;

function buildAssistantTextPreview(value: string): string {
  return value.length > ASSISTANT_TEXT_PREVIEW_MAX_LENGTH ? value.slice(0, ASSISTANT_TEXT_PREVIEW_MAX_LENGTH) : value;
}

function calculateRawItemCount(rawItemsJson: string): number {
  try {
    const parsed = JSON.parse(rawItemsJson);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function toAuditLogUsageColumns(usage: AuditLogUsage | null): AuditLogUsageColumns {
  return {
    inputTokens: usage ? usage.inputTokens : null,
    cachedInputTokens: usage ? usage.cachedInputTokens : null,
    outputTokens: usage ? usage.outputTokens : null,
  };
}

function getAuditLogSessionId(db: DatabaseSync, auditLogId: number): string | null {
  const row = db.prepare(GET_AUDIT_LOG_SESSION_ID_SQL).get(auditLogId) as AuditLogSessionIdRow | undefined;
  return row?.session_id ?? null;
}

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

function parseLogicalPrompt(value: string | null): AuditLogicalPrompt {
  if (!value) {
    return DEFAULT_LOGICAL_PROMPT;
  }

  try {
    const parsed = JSON.parse(value) as Partial<AuditLogicalPrompt>;
    return {
      systemText: typeof parsed.systemText === "string" ? parsed.systemText : "",
      inputText: typeof parsed.inputText === "string" ? parsed.inputText : "",
      composedText: typeof parsed.composedText === "string" ? parsed.composedText : "",
    };
  } catch {
    return DEFAULT_LOGICAL_PROMPT;
  }
}

function parseTransportPayload(value: string | null): AuditTransportPayload | null {
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

function parseUsageFromJson(value: string | null): AuditLogUsage | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<AuditLogUsage>;
    if (
      typeof parsed.inputTokens === "number"
      && typeof parsed.cachedInputTokens === "number"
      && typeof parsed.outputTokens === "number"
    ) {
      return {
        inputTokens: parsed.inputTokens,
        cachedInputTokens: parsed.cachedInputTokens,
        outputTokens: parsed.outputTokens,
      };
    }
  } catch {
    // fallback below
  }

  return null;
}

function isUsableUsageToken(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function reconstructUsageFromSummary(row: Pick<
  AuditLogSummaryRow,
  "input_tokens" | "cached_input_tokens" | "output_tokens"
>): AuditLogUsage | null {
  if (
    isUsableUsageToken(row.input_tokens)
    && isUsableUsageToken(row.cached_input_tokens)
    && isUsableUsageToken(row.output_tokens)
  ) {
    return {
      inputTokens: row.input_tokens,
      cachedInputTokens: row.cached_input_tokens,
      outputTokens: row.output_tokens,
    };
  }

  return null;
}

function parseAuditLogOperation(row: AuditLogOperationRow): AuditLogOperation {
  return {
    type: row.operation_type,
    summary: row.summary,
    details: row.details || undefined,
  };
}

function buildAuditLogEntries(rows: AuditLogSummaryRow[], operationRows: AuditLogOperationRow[]): AuditLogEntry[] {
  const operationMap = new Map<number, AuditLogOperation[]>();

  for (const row of operationRows) {
    const operations = operationMap.get(row.audit_log_id);
    const operation = parseAuditLogOperation(row);

    if (operations) {
      operations.push(operation);
    } else {
      operationMap.set(row.audit_log_id, [operation]);
    }
  }

  return rows.map((row) => rowToAuditLogEntry(row, operationMap.get(row.id) ?? []));
}

function buildAuditLogSummaries(rows: AuditLogSummaryRow[], operationRows: AuditLogOperationRow[]): AuditLogSummary[] {
  const operationMap = new Map<number, AuditLogOperation[]>();

  for (const row of operationRows) {
    const operations = operationMap.get(row.audit_log_id);
    const operation = parseAuditLogOperation(row);

    if (operations) {
      operations.push(operation);
    } else {
      operationMap.set(row.audit_log_id, [operation]);
    }
  }

  return rows.map((row) => rowToAuditLogSummary(row, operationMap.get(row.id) ?? []));
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
  operationRows: AuditLogOperationRow[],
  total: number,
  offset: number,
): AuditLogSummaryPageResult {
  const entries = buildAuditLogSummaries(rows, operationRows);
  const nextCursor = offset + entries.length < total ? offset + entries.length : null;

  return {
    entries,
    nextCursor,
    hasMore: nextCursor !== null,
    total,
  };
}

function rowToAuditLogSummary(row: AuditLogSummaryRow, operations: AuditLogOperation[]): AuditLogSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    phase: toAuditLogPhase(row.phase),
    provider: row.provider || DEFAULT_PROVIDER_ID,
    model: row.model || DEFAULT_MODEL_ID,
    reasoningEffort:
      row.reasoning_effort === "minimal"
      || row.reasoning_effort === "low"
      || row.reasoning_effort === "medium"
      || row.reasoning_effort === "high"
      || row.reasoning_effort === "xhigh"
        ? row.reasoning_effort
        : DEFAULT_REASONING_EFFORT,
    approvalMode: normalizeApprovalMode(row.approval_mode, DEFAULT_APPROVAL_MODE),
    threadId: row.thread_id || "",
    assistantTextPreview: row.assistant_text_preview || "",
    operations,
    usage: reconstructUsageFromSummary(row),
    errorMessage: row.error_message || "",
    detailAvailable: row.detail_available === 1,
  };
}

function rowToAuditLogEntry(row: AuditLogSummaryRow, operations: AuditLogOperation[]): AuditLogEntry {
  const hasDetails = row.logical_prompt_json !== null
    || row.transport_payload_json !== null
    || row.assistant_text !== null
    || row.raw_items_json !== null
    || row.usage_json !== null;

  const usageFromDetails = parseUsageFromJson(hasDetails ? row.usage_json : null);
  const usage = usageFromDetails ?? (hasDetails ? reconstructUsageFromSummary(row) : null);

  return {
    id: row.id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    phase: toAuditLogPhase(row.phase),
    provider: row.provider || DEFAULT_PROVIDER_ID,
    model: row.model || DEFAULT_MODEL_ID,
    reasoningEffort:
      row.reasoning_effort === "minimal"
      || row.reasoning_effort === "low"
      || row.reasoning_effort === "medium"
      || row.reasoning_effort === "high"
      || row.reasoning_effort === "xhigh"
        ? row.reasoning_effort
        : DEFAULT_REASONING_EFFORT,
    approvalMode: normalizeApprovalMode(row.approval_mode, DEFAULT_APPROVAL_MODE),
    threadId: row.thread_id || "",
    logicalPrompt: hasDetails ? parseLogicalPrompt(row.logical_prompt_json) : DEFAULT_LOGICAL_PROMPT,
    transportPayload: hasDetails ? parseTransportPayload(row.transport_payload_json) : null,
    assistantText: hasDetails ? row.assistant_text || "" : "",
    operations,
    rawItemsJson: hasDetails ? row.raw_items_json || "[]" : "[]",
    usage,
    errorMessage: row.error_message || "",
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

export class AuditLogStorageV2Read {
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  private withDb<T>(runner: (db: DatabaseSync) => T): T {
    const db = openAppDatabase(this.dbPath);
    try {
      return runner(db);
    } finally {
      db.close();
    }
  }

  listSessionAuditLogs(sessionId: string): AuditLogEntry[] {
    return this.withDb((db) => {
      const rows = db.prepare(LIST_SESSION_AUDIT_LOGS_SQL).all(sessionId) as AuditLogSummaryRow[];
      const operationRows = db.prepare(LIST_SESSION_AUDIT_LOG_OPERATIONS_SQL).all(sessionId) as AuditLogOperationRow[];

      return buildAuditLogEntries(rows, operationRows);
    });
  }

  listSessionAuditLogSummaries(sessionId: string): AuditLogSummary[] {
    return this.withDb((db) => {
      const rows = db.prepare(LIST_SESSION_AUDIT_LOG_SUMMARIES_SQL).all(sessionId) as AuditLogSummaryRow[];
      const operationRows = db.prepare(LIST_SESSION_AUDIT_LOG_OPERATION_SUMMARIES_SQL).all(sessionId) as AuditLogOperationRow[];

      return buildAuditLogSummaries(rows, operationRows);
    });
  }

  listSessionAuditLogSummaryPage(
    sessionId: string,
    request?: AuditLogSummaryPageRequest | null,
  ): AuditLogSummaryPageResult {
    const { offset, limit } = normalizeAuditLogSummaryPageRequest(request);

    return this.withDb((db) => {
      const rows = db.prepare(LIST_SESSION_AUDIT_LOG_SUMMARY_PAGE_SQL).all(sessionId, limit, offset) as AuditLogSummaryRow[];
      const operationRows = db.prepare(LIST_SESSION_AUDIT_LOG_OPERATION_SUMMARY_PAGE_SQL).all(
        sessionId,
        sessionId,
        limit,
        offset,
      ) as AuditLogOperationRow[];
      const countRow = db.prepare(COUNT_SESSION_AUDIT_LOGS_SQL).get(sessionId) as CountRow | undefined;

      return buildAuditLogSummaryPage(rows, operationRows, countRow?.count ?? 0, offset);
    });
  }

  getSessionAuditLogDetail(sessionId: string, auditLogId: number): AuditLogDetail | null {
    return this.withDb((db) => {
      const row = db.prepare(GET_SESSION_AUDIT_LOG_DETAIL_SQL).get(sessionId, auditLogId) as AuditLogSummaryRow | undefined;
      if (!row) {
        return null;
      }

      const operationRows = db.prepare(LIST_AUDIT_LOG_OPERATIONS_SQL).all(auditLogId) as AuditLogOperationRow[];
      return entryToAuditLogDetail(rowToAuditLogEntry(row, operationRows.map(parseAuditLogOperation)));
    });
  }

  createAuditLog(input: CreateAuditLogInput): AuditLogEntry {
    const usageColumns = toAuditLogUsageColumns(input.usage);
    const auditLogId = this.withDb((db) => {
      const insertAuditLogStatement = db.prepare(INSERT_AUDIT_LOG_SQL);
      const insertDetailStatement = db.prepare(INSERT_AUDIT_LOG_DETAIL_SQL);
      const insertOperationStatement = db.prepare(INSERT_AUDIT_LOG_OPERATION_SQL);
      const incrementSessionAuditLogCountStatement = db.prepare(INCREMENT_SESSION_AUDIT_LOG_COUNT_SQL);

      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const result = insertAuditLogStatement.run(
          input.sessionId,
          input.createdAt,
          input.phase,
          input.provider,
          input.model,
          input.reasoningEffort,
          input.approvalMode,
          input.threadId,
          buildAssistantTextPreview(input.assistantText),
          input.operations.length,
          calculateRawItemCount(input.rawItemsJson),
          usageColumns.inputTokens,
          usageColumns.cachedInputTokens,
          usageColumns.outputTokens,
          input.errorMessage ? 1 : 0,
          input.errorMessage,
          1,
        );
        const id = Number(result.lastInsertRowid);

        insertDetailStatement.run(
          id,
          JSON.stringify(input.logicalPrompt),
          input.transportPayload ? JSON.stringify(input.transportPayload) : "",
          input.assistantText,
          input.rawItemsJson,
          input.usage ? JSON.stringify(input.usage) : "",
        );
        input.operations.forEach((operation, index) => {
          insertOperationStatement.run(id, index, operation.type, operation.summary, operation.details ?? "");
        });
        incrementSessionAuditLogCountStatement.run(input.sessionId);

        db.exec("COMMIT");
        return id;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });

    const created = this.listSessionAuditLogs(input.sessionId).find((entry) => entry.id === auditLogId);
    if (!created) {
      throw new Error(`audit log ${auditLogId} の再取得に失敗したよ。`);
    }
    return created;
  }

  updateAuditLog(id: number, input: CreateAuditLogInput): AuditLogEntry {
    const usageColumns = toAuditLogUsageColumns(input.usage);
    this.withDb((db) => {
      const updateAuditLogStatement = db.prepare(UPDATE_AUDIT_LOG_SQL);
      const deleteDetailStatement = db.prepare(DELETE_AUDIT_LOG_DETAIL_SQL);
      const deleteOperationStatement = db.prepare(DELETE_AUDIT_LOG_OPERATION_SQL);
      const insertDetailStatement = db.prepare(INSERT_AUDIT_LOG_DETAIL_SQL);
      const insertOperationStatement = db.prepare(INSERT_AUDIT_LOG_OPERATION_SQL);

      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const currentSessionId = getAuditLogSessionId(db, id);
        if (!currentSessionId || currentSessionId !== input.sessionId) {
          throw new Error(`audit log ${id} の更新に失敗したよ。`);
        }

        const result = updateAuditLogStatement.run(
          input.phase,
          input.provider,
          input.model,
          input.reasoningEffort,
          input.approvalMode,
          input.threadId,
          buildAssistantTextPreview(input.assistantText),
          input.operations.length,
          calculateRawItemCount(input.rawItemsJson),
          usageColumns.inputTokens,
          usageColumns.cachedInputTokens,
          usageColumns.outputTokens,
          input.errorMessage ? 1 : 0,
          input.errorMessage,
          1,
          id,
        );

        if (result.changes === 0) {
          throw new Error(`audit log ${id} の更新に失敗したよ。`);
        }

        deleteDetailStatement.run(id);
        deleteOperationStatement.run(id);
        insertDetailStatement.run(
          id,
          JSON.stringify(input.logicalPrompt),
          input.transportPayload ? JSON.stringify(input.transportPayload) : "",
          input.assistantText,
          input.rawItemsJson,
          input.usage ? JSON.stringify(input.usage) : "",
        );
        input.operations.forEach((operation, index) => {
          insertOperationStatement.run(id, index, operation.type, operation.summary, operation.details ?? "");
        });

        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });

    const updated = this.listSessionAuditLogs(input.sessionId).find((entry) => entry.id === id);
    if (!updated) {
      throw new Error(`audit log ${id} の再取得に失敗したよ。`);
    }
    return updated;
  }

  clearAuditLogs(): void {
    this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        db.prepare(DELETE_AUDIT_LOGS_SQL).run();
        db.prepare(RESET_SESSION_AUDIT_LOG_COUNTS_SQL).run();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  close(): void {
    return;
  }
}
