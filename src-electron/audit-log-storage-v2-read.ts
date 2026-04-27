import type { DatabaseSync } from "node:sqlite";

import {
  type AuditLogEntry,
  type AuditLogicalPrompt,
  type AuditLogOperation,
  type AuditLogPhase,
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

const DEFAULT_LOGICAL_PROMPT: AuditLogicalPrompt = {
  systemText: "",
  inputText: "",
  composedText: "",
};

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
    });
  }

  close(): void {
    return;
  }
}