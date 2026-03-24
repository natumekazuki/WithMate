import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

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

function toAuditLogPhase(value: string): AuditLogPhase {
  if (value === "running" || value === "started" || value === "completed" || value === "failed" || value === "canceled") {
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

export class AuditLogStorage {
  private readonly db: DatabaseSync;
  private readonly listStatement: StatementSync;
  private readonly insertStatement: StatementSync;
  private readonly updateStatement: StatementSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        phase TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        approval_mode TEXT NOT NULL,
        thread_id TEXT NOT NULL DEFAULT '',
        logical_prompt_json TEXT NOT NULL DEFAULT '{}',
        transport_payload_json TEXT NOT NULL DEFAULT '',
        assistant_text TEXT NOT NULL DEFAULT '',
        operations_json TEXT NOT NULL DEFAULT '[]',
        raw_items_json TEXT NOT NULL DEFAULT '[]',
        usage_json TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `);
  }

  private ensureColumns(): void {
    const columnNames = this.getCurrentColumnNames();

    const requiredColumns = [
      { name: "logical_prompt_json", definition: "TEXT NOT NULL DEFAULT '{}'" },
      { name: "transport_payload_json", definition: "TEXT NOT NULL DEFAULT ''" },
    ];

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
