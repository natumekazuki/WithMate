import type { DatabaseSync } from "node:sqlite";

import {
  type AuditLogDetail,
  type AuditLogDetailFragment,
  type AuditLogDetailSection,
  type AuditLogEntry,
  type AuditLogicalPrompt,
  type AuditLogOperationDetailFragment,
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
import { previewAuditLogicalPrompt } from "./audit-log-detail-preview.js";
import {
  V3_DETAILS_PREVIEW_MAX_LENGTH,
  V3_OPERATION_SUMMARY_MAX_LENGTH,
  V3_TEXT_PREVIEW_MAX_LENGTH,
} from "./database-schema-v3.js";
import { openAppDatabase } from "./sqlite-connection.js";
import { type BlobRef, TextBlobStore } from "./text-blob-store.js";

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
  error_message_preview: string;
  detail_available: number;
};

type AuditLogDetailRow = AuditLogSummaryRow & {
  logical_prompt_blob_id: string | null;
  transport_payload_blob_id: string | null;
  assistant_text_blob_id: string | null;
  raw_items_blob_id: string | null;
  usage_metadata_json: string;
};

type AuditLogOperationRow = {
  audit_log_id: number;
  seq: number;
  operation_type: string;
  summary: string;
  details_preview: string;
  details_blob_id: string | null;
};

type CreateAuditLogInput = Omit<AuditLogEntry, "id">;

type AuditLogUsageColumns = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
};

type StoredAuditPayload = {
  logicalPrompt: BlobRef;
  transportPayload: BlobRef | null;
  assistantText: BlobRef;
  rawItems: BlobRef;
  operationDetails: Array<BlobRef | null>;
};

type AuditLogSessionIdRow = {
  session_id: string;
};

type CountRow = {
  count: number;
};

type AuditLogBlobIdRow = {
  logical_prompt_blob_id: string | null;
  transport_payload_blob_id: string | null;
  assistant_text_blob_id: string | null;
  raw_items_blob_id: string | null;
  usage_blob_id: string | null;
};

type OperationBlobIdRow = {
  details_blob_id: string | null;
};

const DEFAULT_AUDIT_LOG_PAGE_LIMIT = 50;
const MAX_AUDIT_LOG_PAGE_LIMIT = 200;

const DEFAULT_LOGICAL_PROMPT: AuditLogicalPrompt = {
  systemText: "",
  inputText: "",
  composedText: "",
};

const INSERT_BLOB_OBJECT_SQL = `
  INSERT OR IGNORE INTO blob_objects (
    blob_id,
    codec,
    content_type,
    original_bytes,
    stored_bytes,
    raw_sha256,
    stored_sha256,
    state,
    created_at,
    last_verified_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, '')
`;

const INSERT_AUDIT_LOG_SQL = `
  INSERT INTO companion_audit_logs (
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
    error_message_preview,
    detail_available
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_AUDIT_LOG_DETAIL_SQL = `
  INSERT INTO companion_audit_log_details (
    audit_log_id,
    logical_prompt_blob_id,
    transport_payload_blob_id,
    assistant_text_blob_id,
    raw_items_blob_id,
    usage_metadata_json,
    usage_blob_id
  ) VALUES (?, ?, ?, ?, ?, ?, NULL)
`;

const INSERT_AUDIT_LOG_OPERATION_SQL = `
  INSERT INTO companion_audit_log_operations (
    audit_log_id,
    seq,
    operation_type,
    summary,
    details_preview,
    details_blob_id
  ) VALUES (?, ?, ?, ?, ?, ?)
`;

const UPDATE_AUDIT_LOG_SQL = `
  UPDATE companion_audit_logs
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
    error_message_preview = ?,
    detail_available = ?
  WHERE id = ?
`;

const DELETE_AUDIT_LOGS_SQL = "DELETE FROM companion_audit_logs";
const DELETE_AUDIT_LOG_DETAIL_SQL = "DELETE FROM companion_audit_log_details WHERE audit_log_id = ?";
const DELETE_AUDIT_LOG_OPERATION_SQL = "DELETE FROM companion_audit_log_operations WHERE audit_log_id = ?";
const GET_AUDIT_LOG_SESSION_ID_SQL = "SELECT session_id FROM companion_audit_logs WHERE id = ?";
const INCREMENT_SESSION_AUDIT_LOG_COUNT_SQL = `
  UPDATE companion_sessions
  SET audit_log_count = audit_log_count + 1
  WHERE id = ?
`;
const RESET_SESSION_AUDIT_LOG_COUNTS_SQL = `
  UPDATE companion_sessions
  SET audit_log_count = 0
`;
const DELETE_BLOB_OBJECT_SQL = "DELETE FROM blob_objects WHERE blob_id = ?";
const IS_BLOB_OBJECT_PERSISTED_SQL = "SELECT 1 FROM blob_objects WHERE blob_id = ? LIMIT 1";

const GET_AUDIT_LOG_BLOB_IDS_SQL = `
  SELECT
    logical_prompt_blob_id,
    transport_payload_blob_id,
    assistant_text_blob_id,
    raw_items_blob_id,
    usage_blob_id
  FROM companion_audit_log_details
  WHERE audit_log_id = ?
`;

const LIST_AUDIT_LOG_DETAIL_BLOB_IDS_SQL = `
  SELECT
    logical_prompt_blob_id,
    transport_payload_blob_id,
    assistant_text_blob_id,
    raw_items_blob_id,
    usage_blob_id
  FROM companion_audit_log_details
`;

const GET_AUDIT_LOG_OPERATION_BLOB_IDS_SQL = `
  SELECT details_blob_id
  FROM companion_audit_log_operations
  WHERE audit_log_id = ?
`;

const LIST_AUDIT_LOG_OPERATION_BLOB_IDS_SQL = `
  SELECT details_blob_id
  FROM companion_audit_log_operations
`;

const LIVE_BLOB_REF_QUERIES = [
  "SELECT 1 FROM session_messages WHERE text_blob_id = ? LIMIT 1",
  "SELECT 1 FROM session_message_artifacts WHERE artifact_blob_id = ? LIMIT 1",
  "SELECT 1 FROM audit_log_details WHERE logical_prompt_blob_id = ? OR transport_payload_blob_id = ? OR assistant_text_blob_id = ? OR raw_items_blob_id = ? OR usage_blob_id = ? LIMIT 1",
  "SELECT 1 FROM audit_log_operations WHERE details_blob_id = ? LIMIT 1",
  "SELECT 1 FROM companion_sessions WHERE character_role_blob_id = ? LIMIT 1",
  "SELECT 1 FROM companion_messages WHERE text_blob_id = ? LIMIT 1",
  "SELECT 1 FROM companion_message_artifacts WHERE artifact_blob_id = ? LIMIT 1",
  "SELECT 1 FROM companion_merge_runs WHERE diff_snapshot_blob_id = ? LIMIT 1",
  "SELECT 1 FROM companion_audit_log_details WHERE logical_prompt_blob_id = ? OR transport_payload_blob_id = ? OR assistant_text_blob_id = ? OR raw_items_blob_id = ? OR usage_blob_id = ? LIMIT 1",
  "SELECT 1 FROM companion_audit_log_operations WHERE details_blob_id = ? LIMIT 1",
] as const;

const LIST_SESSION_companion_audit_logs_SQL = `
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
    a.error_message_preview,
    a.detail_available,
    d.logical_prompt_blob_id,
    d.transport_payload_blob_id,
    d.assistant_text_blob_id,
    d.raw_items_blob_id,
    d.usage_metadata_json
  FROM companion_audit_logs AS a
  LEFT JOIN companion_audit_log_details AS d
    ON d.audit_log_id = a.id
  WHERE a.session_id = ?
  ORDER BY a.id DESC
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
    a.error_message_preview,
    a.detail_available
  FROM companion_audit_logs AS a
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
    a.error_message_preview,
    a.detail_available
  FROM companion_audit_logs AS a
  WHERE a.session_id = ?
  ORDER BY a.id DESC
  LIMIT ? OFFSET ?
`;

const LIST_SESSION_companion_audit_log_operations_SQL = `
  SELECT
    o.audit_log_id,
    o.seq,
    o.operation_type,
    o.summary,
    o.details_preview,
    o.details_blob_id
  FROM companion_audit_log_operations AS o
  INNER JOIN companion_audit_logs AS a
    ON a.id = o.audit_log_id
  WHERE a.session_id = ?
  ORDER BY o.audit_log_id ASC, o.seq ASC
`;

const LIST_SESSION_AUDIT_LOG_OPERATION_SUMMARY_PAGE_SQL = `
  SELECT
    o.audit_log_id,
    o.seq,
    o.operation_type,
    o.summary,
    o.details_preview,
    o.details_blob_id
  FROM companion_audit_log_operations AS o
  INNER JOIN companion_audit_logs AS a
    ON a.id = o.audit_log_id
  WHERE a.session_id = ?
    AND o.audit_log_id IN (
      SELECT id
      FROM companion_audit_logs
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    )
  ORDER BY o.audit_log_id ASC, o.seq ASC
`;

const LIST_companion_audit_log_operations_SQL = `
  SELECT
    o.audit_log_id,
    o.seq,
    o.operation_type,
    o.summary,
    o.details_preview,
    o.details_blob_id
  FROM companion_audit_log_operations AS o
  WHERE o.audit_log_id = ?
  ORDER BY o.seq ASC
`;

const GET_COMPANION_AUDIT_LOG_OPERATION_SQL = `
  SELECT
    o.audit_log_id,
    o.seq,
    o.operation_type,
    o.summary,
    o.details_preview,
    o.details_blob_id
  FROM companion_audit_log_operations AS o
  INNER JOIN companion_audit_logs AS a
    ON a.id = o.audit_log_id
  WHERE a.session_id = ?
    AND o.audit_log_id = ?
    AND o.seq = ?
`;

const COUNT_SESSION_companion_audit_logs_SQL = `
  SELECT COUNT(*) AS count
  FROM companion_audit_logs
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
    a.error_message_preview,
    a.detail_available,
    d.logical_prompt_blob_id,
    d.transport_payload_blob_id,
    d.assistant_text_blob_id,
    d.raw_items_blob_id,
    d.usage_metadata_json
  FROM companion_audit_logs AS a
  LEFT JOIN companion_audit_log_details AS d
    ON d.audit_log_id = a.id
  WHERE a.session_id = ? AND a.id = ?
`;

function preview(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
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

function parseUsageFromMetadata(value: string | null | undefined): AuditLogUsage | null {
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

function parseAuditLogOperationPreview(row: AuditLogOperationRow): AuditLogOperation {
  return {
    type: row.operation_type,
    summary: row.summary,
    details: undefined,
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
    errorMessage: row.error_message_preview || "",
    detailAvailable: row.detail_available === 1,
  };
}

function buildAuditLogSummaries(rows: AuditLogSummaryRow[], operationRows: AuditLogOperationRow[]): AuditLogSummary[] {
  const operationMap = new Map<number, AuditLogOperation[]>();

  for (const row of operationRows) {
    const operations = operationMap.get(row.audit_log_id);
    const operation = parseAuditLogOperationPreview(row);

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

function getAuditLogSessionId(db: DatabaseSync, auditLogId: number): string | null {
  const row = db.prepare(GET_AUDIT_LOG_SESSION_ID_SQL).get(auditLogId) as AuditLogSessionIdRow | undefined;
  return row?.session_id ?? null;
}

function insertBlobObject(db: DatabaseSync, ref: BlobRef, createdAt: string): void {
  db.prepare(INSERT_BLOB_OBJECT_SQL).run(
    ref.blobId,
    ref.codec,
    ref.contentType,
    ref.originalBytes,
    ref.storedBytes,
    ref.rawSha256,
    ref.storedSha256,
    createdAt,
  );
}

function insertBlobObjects(db: DatabaseSync, refs: ReadonlyArray<BlobRef | null>, createdAt: string): void {
  for (const ref of refs) {
    if (ref) {
      insertBlobObject(db, ref, createdAt);
    }
  }
}

function compactBlobIds(values: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function auditPayloadBlobIds(payload: StoredAuditPayload): string[] {
  return compactBlobIds([
    payload.logicalPrompt.blobId,
    payload.transportPayload?.blobId,
    payload.assistantText.blobId,
    payload.rawItems.blobId,
    ...payload.operationDetails.map((ref) => ref?.blobId),
  ]);
}

function collectBlobIdsFromDetailRows(rows: AuditLogBlobIdRow[]): string[] {
  return compactBlobIds(rows.flatMap((row) => [
    row.logical_prompt_blob_id,
    row.transport_payload_blob_id,
    row.assistant_text_blob_id,
    row.raw_items_blob_id,
    row.usage_blob_id,
  ]));
}

function collectAuditLogBlobIds(db: DatabaseSync, auditLogId: number): string[] {
  const detailRows = db.prepare(GET_AUDIT_LOG_BLOB_IDS_SQL).all(auditLogId) as AuditLogBlobIdRow[];
  const operationRows = db.prepare(GET_AUDIT_LOG_OPERATION_BLOB_IDS_SQL).all(auditLogId) as OperationBlobIdRow[];
  return compactBlobIds([
    ...collectBlobIdsFromDetailRows(detailRows),
    ...operationRows.map((row) => row.details_blob_id),
  ]);
}

function collectAllAuditLogBlobIds(db: DatabaseSync): string[] {
  const detailRows = db.prepare(LIST_AUDIT_LOG_DETAIL_BLOB_IDS_SQL).all() as AuditLogBlobIdRow[];
  const operationRows = db.prepare(LIST_AUDIT_LOG_OPERATION_BLOB_IDS_SQL).all() as OperationBlobIdRow[];
  return compactBlobIds([
    ...collectBlobIdsFromDetailRows(detailRows),
    ...operationRows.map((row) => row.details_blob_id),
  ]);
}

function isBlobReferenced(db: DatabaseSync, blobId: string): boolean {
  return LIVE_BLOB_REF_QUERIES.some((query) => {
    const parameterCount = (query.match(/\?/g) ?? []).length;
    return db.prepare(query).get(...Array.from({ length: parameterCount }, () => blobId)) !== undefined;
  });
}

function deleteUnreferencedBlobObjectRows(db: DatabaseSync, blobIds: readonly string[]): string[] {
  const deletedBlobIds: string[] = [];
  const deleteBlobObjectStatement = db.prepare(DELETE_BLOB_OBJECT_SQL);
  for (const blobId of compactBlobIds(blobIds)) {
    if (isBlobReferenced(db, blobId)) {
      continue;
    }
    deleteBlobObjectStatement.run(blobId);
    deletedBlobIds.push(blobId);
  }
  return deletedBlobIds;
}

async function storeAuditPayload(blobStore: TextBlobStore, input: CreateAuditLogInput): Promise<StoredAuditPayload> {
  const operationDetails = await Promise.all(input.operations.map((operation) => (
    operation.details
      ? blobStore.putText({ contentType: "text/plain", text: operation.details })
      : Promise.resolve(null)
  )));

  return {
    logicalPrompt: await blobStore.putJson({ value: input.logicalPrompt }),
    transportPayload: input.transportPayload ? await blobStore.putJson({ value: input.transportPayload }) : null,
    assistantText: await blobStore.putText({ contentType: "text/plain", text: input.assistantText }),
    rawItems: await blobStore.putText({ contentType: "application/json", text: input.rawItemsJson }),
    operationDetails,
  };
}

export class CompanionAuditLogStorageV3 {
  private readonly dbPath: string;
  private readonly blobStore: TextBlobStore;

  constructor(dbPath: string, blobRootPath: string) {
    this.dbPath = dbPath;
    this.blobStore = new TextBlobStore(blobRootPath);
  }

  private withDb<T>(runner: (db: DatabaseSync) => T): T {
    const db = openAppDatabase(this.dbPath);
    try {
      return runner(db);
    } finally {
      db.close();
    }
  }

  private async rowToAuditLogEntry(row: AuditLogDetailRow, operationRows: AuditLogOperationRow[]): Promise<AuditLogEntry> {
    const hasDetails = row.logical_prompt_blob_id !== null
      || row.transport_payload_blob_id !== null
      || row.assistant_text_blob_id !== null
      || row.raw_items_blob_id !== null;
    const operations = await Promise.all(operationRows.map(async (operationRow) => ({
      type: operationRow.operation_type,
      summary: operationRow.summary,
      details: operationRow.details_blob_id
        ? await this.blobStore.getText(operationRow.details_blob_id)
        : operationRow.details_preview || undefined,
    })));

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
      logicalPrompt: hasDetails && row.logical_prompt_blob_id
        ? await this.blobStore.getJson<AuditLogicalPrompt>(row.logical_prompt_blob_id)
        : DEFAULT_LOGICAL_PROMPT,
      transportPayload: hasDetails && row.transport_payload_blob_id
        ? await this.blobStore.getJson<AuditTransportPayload>(row.transport_payload_blob_id)
        : null,
      assistantText: hasDetails && row.assistant_text_blob_id
        ? await this.blobStore.getText(row.assistant_text_blob_id)
        : "",
      operations,
      rawItemsJson: hasDetails && row.raw_items_blob_id
        ? await this.blobStore.getText(row.raw_items_blob_id)
        : "[]",
      usage: parseUsageFromMetadata(row.usage_metadata_json) ?? reconstructUsageFromSummary(row),
      errorMessage: row.error_message_preview || "",
    };
  }

  private async getSessionAuditLogEntry(sessionId: string, auditLogId: number): Promise<AuditLogEntry | null> {
    const result = this.withDb((db) => {
      const row = db.prepare(GET_SESSION_AUDIT_LOG_DETAIL_SQL).get(sessionId, auditLogId) as AuditLogDetailRow | undefined;
      if (!row) {
        return null;
      }

      const operationRows = db.prepare(LIST_companion_audit_log_operations_SQL).all(auditLogId) as AuditLogOperationRow[];
      return { row, operationRows };
    });

    return result ? await this.rowToAuditLogEntry(result.row, result.operationRows) : null;
  }

  async listSessionAuditLogs(sessionId: string): Promise<AuditLogEntry[]> {
    const { rows, operationRows } = this.withDb((db) => ({
      rows: db.prepare(LIST_SESSION_companion_audit_logs_SQL).all(sessionId) as AuditLogDetailRow[],
      operationRows: db.prepare(LIST_SESSION_companion_audit_log_operations_SQL).all(sessionId) as AuditLogOperationRow[],
    }));
    const operationMap = new Map<number, AuditLogOperationRow[]>();

    for (const row of operationRows) {
      const operations = operationMap.get(row.audit_log_id);
      if (operations) {
        operations.push(row);
      } else {
        operationMap.set(row.audit_log_id, [row]);
      }
    }

    return Promise.all(rows.map((row) => this.rowToAuditLogEntry(row, operationMap.get(row.id) ?? [])));
  }

  async listSessionAuditLogSummaries(sessionId: string): Promise<AuditLogSummary[]> {
    return this.withDb((db) => {
      const rows = db.prepare(LIST_SESSION_AUDIT_LOG_SUMMARIES_SQL).all(sessionId) as AuditLogSummaryRow[];
      const operationRows = db.prepare(LIST_SESSION_companion_audit_log_operations_SQL).all(sessionId) as AuditLogOperationRow[];

      return buildAuditLogSummaries(rows, operationRows);
    });
  }

  async listSessionAuditLogSummaryPage(
    sessionId: string,
    request?: AuditLogSummaryPageRequest | null,
  ): Promise<AuditLogSummaryPageResult> {
    const { offset, limit } = normalizeAuditLogSummaryPageRequest(request);

    return this.withDb((db) => {
      const rows = db.prepare(LIST_SESSION_AUDIT_LOG_SUMMARY_PAGE_SQL).all(sessionId, limit, offset) as AuditLogSummaryRow[];
      const operationRows = db.prepare(LIST_SESSION_AUDIT_LOG_OPERATION_SUMMARY_PAGE_SQL).all(
        sessionId,
        sessionId,
        limit,
        offset,
      ) as AuditLogOperationRow[];
      const countRow = db.prepare(COUNT_SESSION_companion_audit_logs_SQL).get(sessionId) as CountRow | undefined;

      return buildAuditLogSummaryPage(rows, operationRows, countRow?.count ?? 0, offset);
    });
  }

  async getSessionAuditLogDetail(sessionId: string, auditLogId: number): Promise<AuditLogDetail | null> {
    const entry = await this.getSessionAuditLogEntry(sessionId, auditLogId);
    return entry
      ? {
          id: entry.id,
          sessionId: entry.sessionId,
          logicalPrompt: entry.logicalPrompt,
          transportPayload: entry.transportPayload,
          assistantText: entry.assistantText,
          operations: entry.operations,
          rawItemsJson: entry.rawItemsJson,
          usage: entry.usage,
          errorMessage: entry.errorMessage,
        }
      : null;
  }

  async getSessionAuditLogDetailSection(
    sessionId: string,
    auditLogId: number,
    section: AuditLogDetailSection,
  ): Promise<AuditLogDetailFragment | null> {
    const result = this.withDb((db) => {
      const row = db.prepare(GET_SESSION_AUDIT_LOG_DETAIL_SQL).get(sessionId, auditLogId) as AuditLogDetailRow | undefined;
      if (!row) {
        return null;
      }

      const operationRows = section === "operations"
        ? db.prepare(LIST_companion_audit_log_operations_SQL).all(auditLogId) as AuditLogOperationRow[]
        : [];
      return { row, operationRows };
    });

    if (!result) {
      return null;
    }

    const { row, operationRows } = result;
    const fragment: AuditLogDetailFragment = {
      id: row.id,
      sessionId: row.session_id,
    };

    switch (section) {
      case "logical":
        fragment.logicalPrompt = previewAuditLogicalPrompt(
          row.logical_prompt_blob_id
            ? await this.blobStore.getJson<AuditLogicalPrompt>(row.logical_prompt_blob_id)
            : DEFAULT_LOGICAL_PROMPT,
        );
        break;
      case "transport":
        fragment.transportPayload = row.transport_payload_blob_id
          ? await this.blobStore.getJson<AuditTransportPayload>(row.transport_payload_blob_id)
          : null;
        break;
      case "response":
        fragment.assistantText = row.assistant_text_blob_id
          ? await this.blobStore.getText(row.assistant_text_blob_id)
          : "";
        break;
      case "operations":
        fragment.operations = await Promise.all(operationRows.map(async (operationRow) => ({
          type: operationRow.operation_type,
          summary: operationRow.summary,
          details: operationRow.details_preview || undefined,
        })));
        break;
      case "raw":
        fragment.rawItemsJson = row.raw_items_blob_id
          ? await this.blobStore.getText(row.raw_items_blob_id)
          : "[]";
        break;
      default: {
        const exhaustive: never = section;
        throw new Error(`unsupported companion audit log detail section: ${exhaustive}`);
      }
    }

    return fragment;
  }

  async getSessionAuditLogOperationDetail(
    sessionId: string,
    auditLogId: number,
    operationIndex: number,
  ): Promise<AuditLogOperationDetailFragment | null> {
    if (!Number.isInteger(operationIndex) || operationIndex < 0) {
      return null;
    }

    const operationRow = this.withDb((db) =>
      db.prepare(GET_COMPANION_AUDIT_LOG_OPERATION_SQL).get(sessionId, auditLogId, operationIndex) as AuditLogOperationRow | undefined
    );
    if (!operationRow) {
      return null;
    }

    return {
      id: auditLogId,
      sessionId,
      operationIndex,
      details: operationRow.details_blob_id
        ? await this.blobStore.getText(operationRow.details_blob_id)
        : operationRow.details_preview,
    };
  }

  async createAuditLog(input: CreateAuditLogInput): Promise<AuditLogEntry> {
    const payload = await storeAuditPayload(this.blobStore, input);
    const usageColumns = toAuditLogUsageColumns(input.usage);
    let auditLogId: number;
    try {
      auditLogId = this.withDb((db) => {
        const allBlobRefs = [
          payload.logicalPrompt,
          payload.transportPayload,
          payload.assistantText,
          payload.rawItems,
          ...payload.operationDetails,
        ];

        db.exec("BEGIN IMMEDIATE TRANSACTION");
        try {
          insertBlobObjects(db, allBlobRefs, input.createdAt);
          const result = db.prepare(INSERT_AUDIT_LOG_SQL).run(
            input.sessionId,
            input.createdAt,
            input.phase,
            input.provider,
            input.model,
            input.reasoningEffort,
            input.approvalMode,
            input.threadId,
            preview(input.assistantText, V3_TEXT_PREVIEW_MAX_LENGTH),
            input.operations.length,
            calculateRawItemCount(input.rawItemsJson),
            usageColumns.inputTokens,
            usageColumns.cachedInputTokens,
            usageColumns.outputTokens,
            input.errorMessage ? 1 : 0,
            preview(input.errorMessage, V3_TEXT_PREVIEW_MAX_LENGTH),
            1,
          );
          const id = Number(result.lastInsertRowid);

          db.prepare(INSERT_AUDIT_LOG_DETAIL_SQL).run(
            id,
            payload.logicalPrompt.blobId,
            payload.transportPayload?.blobId ?? null,
            payload.assistantText.blobId,
            payload.rawItems.blobId,
            input.usage ? JSON.stringify(input.usage) : "",
          );
          input.operations.forEach((operation, index) => {
            db.prepare(INSERT_AUDIT_LOG_OPERATION_SQL).run(
              id,
              index,
              operation.type,
              preview(operation.summary, V3_OPERATION_SUMMARY_MAX_LENGTH),
              preview(operation.details ?? "", V3_DETAILS_PREVIEW_MAX_LENGTH),
              payload.operationDetails[index]?.blobId ?? null,
            );
          });
          db.prepare(INCREMENT_SESSION_AUDIT_LOG_COUNT_SQL).run(input.sessionId);

          db.exec("COMMIT");
          return id;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
    } catch (error) {
      await this.deleteUnpersistedBlobs(auditPayloadBlobIds(payload));
      throw error;
    }

    const created = await this.getSessionAuditLogEntry(input.sessionId, auditLogId);
    if (!created) {
      throw new Error(`audit log ${auditLogId} の再取得に失敗したよ。`);
    }
    return created;
  }

  async updateAuditLog(id: number, input: CreateAuditLogInput): Promise<AuditLogEntry> {
    const payload = await storeAuditPayload(this.blobStore, input);
    const usageColumns = toAuditLogUsageColumns(input.usage);
    let blobIdsToDelete: string[];
    try {
      blobIdsToDelete = this.withDb((db) => {
        const allBlobRefs = [
          payload.logicalPrompt,
          payload.transportPayload,
          payload.assistantText,
          payload.rawItems,
          ...payload.operationDetails,
        ];

        db.exec("BEGIN IMMEDIATE TRANSACTION");
        try {
          const currentSessionId = getAuditLogSessionId(db, id);
          if (!currentSessionId || currentSessionId !== input.sessionId) {
            throw new Error(`audit log ${id} の更新に失敗したよ。`);
          }

          const previousBlobIds = collectAuditLogBlobIds(db, id);
          insertBlobObjects(db, allBlobRefs, input.createdAt);
          const result = db.prepare(UPDATE_AUDIT_LOG_SQL).run(
            input.phase,
            input.provider,
            input.model,
            input.reasoningEffort,
            input.approvalMode,
            input.threadId,
            preview(input.assistantText, V3_TEXT_PREVIEW_MAX_LENGTH),
            input.operations.length,
            calculateRawItemCount(input.rawItemsJson),
            usageColumns.inputTokens,
            usageColumns.cachedInputTokens,
            usageColumns.outputTokens,
            input.errorMessage ? 1 : 0,
            preview(input.errorMessage, V3_TEXT_PREVIEW_MAX_LENGTH),
            1,
            id,
          );

          if (result.changes === 0) {
            throw new Error(`audit log ${id} の更新に失敗したよ。`);
          }

          db.prepare(DELETE_AUDIT_LOG_DETAIL_SQL).run(id);
          db.prepare(DELETE_AUDIT_LOG_OPERATION_SQL).run(id);
          db.prepare(INSERT_AUDIT_LOG_DETAIL_SQL).run(
            id,
            payload.logicalPrompt.blobId,
            payload.transportPayload?.blobId ?? null,
            payload.assistantText.blobId,
            payload.rawItems.blobId,
            input.usage ? JSON.stringify(input.usage) : "",
          );
          input.operations.forEach((operation, index) => {
            db.prepare(INSERT_AUDIT_LOG_OPERATION_SQL).run(
              id,
              index,
              operation.type,
              preview(operation.summary, V3_OPERATION_SUMMARY_MAX_LENGTH),
              preview(operation.details ?? "", V3_DETAILS_PREVIEW_MAX_LENGTH),
              payload.operationDetails[index]?.blobId ?? null,
            );
          });

          const blobIdsToDelete = deleteUnreferencedBlobObjectRows(db, previousBlobIds);
          db.exec("COMMIT");
          return blobIdsToDelete;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
    } catch (error) {
      await this.deleteUnpersistedBlobs(auditPayloadBlobIds(payload));
      throw error;
    }
    await this.blobStore.deleteUnreferenced(blobIdsToDelete);

    const updated = await this.getSessionAuditLogEntry(input.sessionId, id);
    if (!updated) {
      throw new Error(`audit log ${id} の再取得に失敗したよ。`);
    }
    return updated;
  }

  async clearAuditLogs(): Promise<void> {
    const blobIdsToDelete = this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const previousBlobIds = collectAllAuditLogBlobIds(db);
        db.prepare(DELETE_AUDIT_LOGS_SQL).run();
        db.prepare(RESET_SESSION_AUDIT_LOG_COUNTS_SQL).run();
        const blobIdsToDelete = deleteUnreferencedBlobObjectRows(db, previousBlobIds);
        db.exec("COMMIT");
        return blobIdsToDelete;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
    await this.blobStore.deleteUnreferenced(blobIdsToDelete);
  }

  private async deleteUnpersistedBlobs(blobIds: readonly string[]): Promise<void> {
    const unpersistedBlobIds = this.withDb((db) => {
      const statement = db.prepare(IS_BLOB_OBJECT_PERSISTED_SQL);
      return compactBlobIds(blobIds).filter((blobId) => !statement.get(blobId));
    });
    await this.blobStore.deleteUnreferenced(unpersistedBlobIds);
  }

  close(): void {
    return;
  }
}
