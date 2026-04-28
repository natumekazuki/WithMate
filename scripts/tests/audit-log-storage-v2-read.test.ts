import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { CREATE_V2_SCHEMA_SQL } from "../../src-electron/database-schema-v2.js";
import { AuditLogStorageV2Read } from "../../src-electron/audit-log-storage-v2-read.js";

async function withTempV2Database<T>(fn: (dbPath: string) => T | Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "withmate-audit-log-v2-read-"));
  const dbPath = path.join(dir, "withmate-v2.db");

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    for (const statement of CREATE_V2_SCHEMA_SQL) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }

  try {
    return await fn(dbPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type SessionHeaderInput = {
  id: string;
  taskTitle?: string;
  workspacePath?: string;
  workspaceLabel?: string;
  threadId?: string;
};

function insertSessionHeader(db: DatabaseSync, input: SessionHeaderInput): string {
  const {
    id,
    taskTitle = "Runtime task",
    workspacePath = "workspace-a",
    workspaceLabel = "Workspace A",
    threadId = "thread-runtime",
  } = input;

  db.prepare(`
    INSERT INTO sessions (
      id,
      task_title,
      task_summary,
      status,
      updated_at,
      provider,
      catalog_revision,
      workspace_label,
      workspace_path,
      branch,
      session_kind,
      character_id,
      character_name,
      character_icon_path,
      character_theme_main,
      character_theme_sub,
      run_state,
      approval_mode,
      codex_sandbox_mode,
      model,
      reasoning_effort,
      custom_agent_name,
      allowed_additional_directories_json,
      thread_id,
      message_count,
      audit_log_count,
      last_active_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    taskTitle,
    "runtime summary",
    "idle",
    "2026-04-27T00:00:00.000Z",
    "codex",
    1,
    workspaceLabel,
    workspacePath,
    "main",
    "default",
    "char-a",
    "A",
    "",
    "#6f8cff",
    "#6fb8c7",
    "idle",
    "untrusted",
    "workspace-write",
    "gpt-5.4-mini",
    "medium",
    "",
    JSON.stringify(["shared/reference"]),
    threadId,
    0,
    0,
    1,
  );

  return id;
}

type AuditLogSummaryInput = {
  sessionId: string;
  createdAt?: string;
  phase?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  approvalMode?: string;
  threadId?: string;
  assistantTextPreview?: string;
  operationCount?: number;
  rawItemCount?: number;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  hasError?: number;
  errorMessage?: string;
  detailAvailable?: number;
};

function insertAuditLogSummary(db: DatabaseSync, input: AuditLogSummaryInput): number {
  const {
    sessionId,
    createdAt = "2026-04-27T10:00:00.000Z",
    phase = "completed",
    provider = "codex",
    model = "gpt-5.4-mini",
    reasoningEffort = "medium",
    approvalMode = "never",
    threadId = "thread-1",
    assistantTextPreview = "",
    operationCount = 0,
    rawItemCount = 0,
    inputTokens = null,
    cachedInputTokens = null,
    outputTokens = null,
    hasError = 0,
    errorMessage = "",
    detailAvailable = 1,
  } = input;

  const result = db.prepare(`
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
  `).run(
    sessionId,
    createdAt,
    phase,
    provider,
    model,
    reasoningEffort,
    approvalMode,
    threadId,
    assistantTextPreview,
    operationCount,
    rawItemCount,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    hasError,
    errorMessage,
    detailAvailable,
  );

  return Number(result.lastInsertRowid);
}

function insertAuditLogDetails(
  db: DatabaseSync,
  auditLogId: number,
  input: {
    logicalPromptJson: string;
    transportPayloadJson: string;
    assistantText: string;
    rawItemsJson: string;
    usageJson: string;
  },
): void {
  db.prepare(`
    INSERT INTO audit_log_details (
      audit_log_id,
      logical_prompt_json,
      transport_payload_json,
      assistant_text,
      raw_items_json,
      usage_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    auditLogId,
    input.logicalPromptJson,
    input.transportPayloadJson,
    input.assistantText,
    input.rawItemsJson,
    input.usageJson,
  );
}

function insertAuditLogOperation(
  db: DatabaseSync,
  input: {
    auditLogId: number;
    seq: number;
    type: string;
    summary: string;
    details: string;
  },
): void {
  db.prepare(`
    INSERT INTO audit_log_operations (
      audit_log_id,
      seq,
      operation_type,
      summary,
      details
    ) VALUES (?, ?, ?, ?, ?)
  `).run(input.auditLogId, input.seq, input.type, input.summary, input.details);
}

function readCount(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): number {
  const row = db.prepare(sql).get(...params) as { count: number };
  return Number(row.count);
}

function readRequiredRow<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T {
  const row = db.prepare(sql).get(...params) as T | undefined;
  assert.ok(row);
  return row;
}

describe("AuditLogStorageV2Read", () => {
  it("listSessionAuditLogs は sessionId で絞り込み、id DESC で返す", async () => {
    await withTempV2Database((dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        const targetSessionId = insertSessionHeader(db, { id: "session-target" });
        const otherSessionId = insertSessionHeader(db, { id: "session-other" });

        const targetFirstLog = insertAuditLogSummary(db, {
          sessionId: targetSessionId,
          assistantTextPreview: "target preview 1",
        });
        insertAuditLogDetails(db, targetFirstLog, {
          logicalPromptJson: "{}",
          transportPayloadJson: "",
          assistantText: "",
          rawItemsJson: "[]",
          usageJson: "",
        });

        insertAuditLogSummary(db, {
          sessionId: otherSessionId,
          assistantTextPreview: "other preview",
        });

        const targetSecondLog = insertAuditLogSummary(db, {
          sessionId: targetSessionId,
          assistantTextPreview: "target preview 2",
        });
        insertAuditLogDetails(db, targetSecondLog, {
          logicalPromptJson: "{}",
          transportPayloadJson: "",
          assistantText: "",
          rawItemsJson: "[]",
          usageJson: "",
        });

        const targetThirdLog = insertAuditLogSummary(db, {
          sessionId: targetSessionId,
          assistantTextPreview: "target preview 3",
        });
        insertAuditLogDetails(db, targetThirdLog, {
          logicalPromptJson: "{}",
          transportPayloadJson: "",
          assistantText: "",
          rawItemsJson: "[]",
          usageJson: "",
        });

        const storage = new AuditLogStorageV2Read(dbPath);
        const entries = storage.listSessionAuditLogs(targetSessionId);

        assert.equal(entries.length, 3);
        assert.equal(entries[0]?.sessionId, targetSessionId);
        assert.deepEqual(entries.map((entry) => entry.id), [targetThirdLog, targetSecondLog, targetFirstLog]);
        assert.equal(entries.every((entry) => entry.sessionId === targetSessionId), true);
        storage.close();
      } finally {
        db.close();
      }
    });
  });

  it("summary + detail + operations から AuditLogEntry を復元し、assistantText は detail を優先し、operations は seq ASC", async () => {
    await withTempV2Database((dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        const sessionId = insertSessionHeader(db, { id: "session-detail" });

        const auditLogId = insertAuditLogSummary(db, {
          sessionId,
          phase: "completed",
          assistantTextPreview: "assistant preview should be ignored",
          operationCount: 3,
          rawItemCount: 2,
        });
        insertAuditLogDetails(db, auditLogId, {
          logicalPromptJson: JSON.stringify({
            systemText: "system",
            inputText: "input",
            composedText: "system\n\ninput",
          }),
          transportPayloadJson: JSON.stringify({
            summary: "payload summary",
            fields: [
              { label: "label", value: "value" },
            ],
          }),
          assistantText: "assistant from detail table",
          rawItemsJson: '[{"kind":"assistant","id":1}]',
          usageJson: JSON.stringify({ inputTokens: 21, cachedInputTokens: 3, outputTokens: 8 }),
        });
        insertAuditLogOperation(db, {
          auditLogId,
          seq: 10,
          type: "file-edit",
          summary: "updated file",
          details: "src/main.ts",
        });
        insertAuditLogOperation(db, {
          auditLogId,
          seq: 30,
          type: "approval",
          summary: "confirmed",
          details: "approved by user",
        });
        insertAuditLogOperation(db, {
          auditLogId,
          seq: 20,
          type: "analysis",
          summary: "analyzed",
          details: "analysis complete",
        });

        const storage = new AuditLogStorageV2Read(dbPath);
        const entries = storage.listSessionAuditLogs(sessionId);
        assert.equal(entries.length, 1);

        const entry = entries[0] as {
          assistantText: string;
          logicalPrompt: { systemText: string; inputText: string; composedText: string };
          rawItemsJson: string;
          transportPayload: { summary: string; fields: { label: string; value: string }[] } | null;
          usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null;
          operations: { type: string; summary: string; details?: string }[];
          operationCount?: number;
        };

        assert.equal(entry.assistantText, "assistant from detail table");
        assert.deepEqual(entry.logicalPrompt, {
          systemText: "system",
          inputText: "input",
          composedText: "system\n\ninput",
        });
        assert.equal(entry.transportPayload?.summary, "payload summary");
        assert.deepEqual(entry.rawItemsJson, '[{"kind":"assistant","id":1}]');
        assert.deepEqual(entry.usage, {
          inputTokens: 21,
          cachedInputTokens: 3,
          outputTokens: 8,
        });
        assert.deepEqual(entry.operations.map((operation) => operation.type), ["file-edit", "analysis", "approval"]);
        assert.deepEqual(
          entry.operations.map((operation) => [operation.summary, operation.details]),
          [["updated file", "src/main.ts"], ["analyzed", "analysis complete"], ["confirmed", "approved by user"]],
        );
        storage.close();
      } finally {
        db.close();
      }
    });
  });

  it("listSessionAuditLogSummaries は detail payload を返さず、getSessionAuditLogDetail で detail を取得する", async () => {
    await withTempV2Database((dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        const sessionId = insertSessionHeader(db, { id: "session-lazy-detail" });
        const auditLogId = insertAuditLogSummary(db, {
          sessionId,
          phase: "completed",
          assistantTextPreview: "summary preview",
          operationCount: 1,
          rawItemCount: 1,
          inputTokens: 12,
          cachedInputTokens: 2,
          outputTokens: 5,
        });
        insertAuditLogDetails(db, auditLogId, {
          logicalPromptJson: JSON.stringify({
            systemText: "detail system",
            inputText: "detail input",
            composedText: "detail system\n\ndetail input",
          }),
          transportPayloadJson: JSON.stringify({
            summary: "detail transport",
            fields: [
              { label: "detail", value: "payload" },
            ],
          }),
          assistantText: "detail assistant",
          rawItemsJson: '[{"kind":"assistant","id":1}]',
          usageJson: JSON.stringify({ inputTokens: 12, cachedInputTokens: 2, outputTokens: 5 }),
        });
        insertAuditLogOperation(db, {
          auditLogId,
          seq: 0,
          type: "analysis",
          summary: "operation summary",
          details: "operation detail",
        });

        const storage = new AuditLogStorageV2Read(dbPath);
        const summaries = storage.listSessionAuditLogSummaries(sessionId);
        assert.equal(summaries.length, 1);
        assert.equal(summaries[0]?.assistantTextPreview, "summary preview");
        assert.deepEqual(summaries[0]?.usage, {
          inputTokens: 12,
          cachedInputTokens: 2,
          outputTokens: 5,
        });
        assert.deepEqual(summaries[0]?.operations.map((operation) => operation.summary), ["operation summary"]);
        assert.deepEqual(summaries[0]?.operations.map((operation) => operation.details), [undefined]);
        assert.equal(summaries[0]?.detailAvailable, true);
        assert.equal("logicalPrompt" in (summaries[0] as object), false);
        assert.equal("rawItemsJson" in (summaries[0] as object), false);

        const detail = storage.getSessionAuditLogDetail(sessionId, auditLogId);
        assert.ok(detail);
        assert.deepEqual(detail.logicalPrompt, {
          systemText: "detail system",
          inputText: "detail input",
          composedText: "detail system\n\ndetail input",
        });
        assert.equal(detail.assistantText, "detail assistant");
        assert.equal(detail.rawItemsJson, '[{"kind":"assistant","id":1}]');
        assert.deepEqual(detail.operations.map((operation) => operation.details), ["operation detail"]);
        assert.equal(storage.getSessionAuditLogDetail("other-session", auditLogId), null);
        storage.close();
      } finally {
        db.close();
      }
    });
  });

  it("usage_json が空でも usage 列を使える形で復元し、未提供時は null でも許容する", async () => {
    await withTempV2Database((dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        const sessionId = insertSessionHeader(db, { id: "session-usage" });

        const hasUsageLog = insertAuditLogSummary(db, {
          sessionId,
          assistantTextPreview: "has usage_json",
          inputTokens: 11,
          cachedInputTokens: 0,
          outputTokens: 40,
        });
        insertAuditLogDetails(db, hasUsageLog, {
          logicalPromptJson: "{}",
          transportPayloadJson: "",
          assistantText: "usage from json",
          rawItemsJson: "[]",
          usageJson: JSON.stringify({ inputTokens: 1, cachedInputTokens: 2, outputTokens: 3 }),
        });

        const missingUsageLog = insertAuditLogSummary(db, {
          sessionId,
          assistantTextPreview: "missing usage_json",
          inputTokens: 11,
          cachedInputTokens: 2,
          outputTokens: 3,
        });
        insertAuditLogDetails(db, missingUsageLog, {
          logicalPromptJson: "{}",
          transportPayloadJson: "",
          assistantText: "fallback",
          rawItemsJson: "[]",
          usageJson: "",
        });

        const storage = new AuditLogStorageV2Read(dbPath);
        const entries = storage.listSessionAuditLogs(sessionId);
        assert.equal(entries.length, 2);

        const withUsageEntry = entries.find((entry) => entry.id === hasUsageLog);
        const missingUsageEntry = entries.find((entry) => entry.id === missingUsageLog);

        assert.equal(withUsageEntry?.id, hasUsageLog);
        assert.deepEqual(withUsageEntry?.usage, {
          inputTokens: 1,
          cachedInputTokens: 2,
          outputTokens: 3,
        });

        if (missingUsageEntry?.usage !== null) {
          assert.deepEqual(missingUsageEntry.usage, {
            inputTokens: 11,
            cachedInputTokens: 2,
            outputTokens: 3,
          });
        }

        storage.close();
      } finally {
        db.close();
      }
    });
  });

  it("audit_log_details が無い場合でも空フィールドで復元し続ける", async () => {
    await withTempV2Database((dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        const sessionId = insertSessionHeader(db, { id: "session-missing-detail" });
        const auditLogId = insertAuditLogSummary(db, {
          sessionId,
          assistantTextPreview: "missing detail preview",
        });

        const storage = new AuditLogStorageV2Read(dbPath);
        const entries = storage.listSessionAuditLogs(sessionId);
        assert.equal(entries.length, 1);
        const entry = entries[0];

        assert.equal(entry.id, auditLogId);
        assert.equal(entry.assistantText, "");
        assert.deepEqual(entry.logicalPrompt, {
          systemText: "",
          inputText: "",
          composedText: "",
        });
        assert.equal(entry.transportPayload, null);
        assert.equal(entry.rawItemsJson, "[]");
        assert.equal(entry.usage, null);
        assert.deepEqual(entry.operations, []);

        storage.close();
      } finally {
        db.close();
      }
    });
  });

  it("createAuditLog は summary/detail/operations を保存し、listSessionAuditLogs で full 形を復元する", async () => {
    await withTempV2Database((dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        const sessionId = insertSessionHeader(db, { id: "session-create" });
        const storage = new AuditLogStorageV2Read(dbPath);

        try {
          const assistantText = "a".repeat(600);
          const created = storage.createAuditLog({
            sessionId,
            createdAt: "2026-04-27T10:00:00.000Z",
            phase: "completed",
            provider: "codex",
            model: "gpt-5.4-mini",
            reasoningEffort: "medium",
            approvalMode: DEFAULT_APPROVAL_MODE,
            threadId: "thread-create",
            logicalPrompt: {
              systemText: "system prompt",
              inputText: "user prompt",
              composedText: "system prompt\n\nuser prompt",
            },
            transportPayload: {
              summary: "thread summary",
              fields: [
                {
                  label: "scenario",
                  value: "create path",
                },
              ],
            },
            assistantText,
            operations: [
              {
                type: "analysis",
                summary: "analyzed",
                details: "analysis output",
              },
              {
                type: "approval",
                summary: "approved",
                details: "approved by user",
              },
            ],
            rawItemsJson: '[{"kind":"assistant","id":1}]',
            usage: {
              inputTokens: 11,
              cachedInputTokens: 2,
              outputTokens: 6,
            },
            errorMessage: "",
          });

          const entries = storage.listSessionAuditLogs(sessionId);
          assert.equal(entries.length, 1);
          assert.equal(entries[0]?.id, created.id);
          assert.equal(entries[0]?.sessionId, sessionId);
          assert.equal(entries[0]?.provider, "codex");
          assert.equal(entries[0]?.model, "gpt-5.4-mini");
          assert.equal(entries[0]?.reasoningEffort, "medium");
          assert.equal(entries[0]?.threadId, "thread-create");
          assert.deepEqual(entries[0]?.logicalPrompt, {
            systemText: "system prompt",
            inputText: "user prompt",
            composedText: "system prompt\n\nuser prompt",
          });
          assert.equal(entries[0]?.assistantText, assistantText);
          assert.deepEqual(entries[0]?.transportPayload, {
            summary: "thread summary",
            fields: [
              {
                label: "scenario",
                value: "create path",
              },
            ],
          });
          assert.equal(entries[0]?.rawItemsJson, '[{"kind":"assistant","id":1}]');
          assert.deepEqual(entries[0]?.usage, {
            inputTokens: 11,
            cachedInputTokens: 2,
            outputTokens: 6,
          });
          assert.deepEqual(entries[0]?.operations.map((operation) => operation.summary), ["analyzed", "approved"]);
          assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM audit_logs"), 1);
          assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM audit_log_details WHERE audit_log_id = ?", created.id), 1);
          assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM audit_log_operations WHERE audit_log_id = ?", created.id), 2);
          const summaryRow = readRequiredRow<{
            assistant_text_preview: string;
            operation_count: number;
            raw_item_count: number;
            input_tokens: number;
            cached_input_tokens: number;
            output_tokens: number;
            has_error: number;
            error_message: string;
          }>(
            db,
            `SELECT
              assistant_text_preview,
              operation_count,
              raw_item_count,
              input_tokens,
              cached_input_tokens,
              output_tokens,
              has_error,
              error_message
            FROM audit_logs
            WHERE id = ?`,
            created.id,
          );
          assert.equal(summaryRow.assistant_text_preview, assistantText.slice(0, 500));
          assert.equal(summaryRow.operation_count, 2);
          assert.equal(summaryRow.raw_item_count, 1);
          assert.equal(summaryRow.input_tokens, 11);
          assert.equal(summaryRow.cached_input_tokens, 2);
          assert.equal(summaryRow.output_tokens, 6);
          assert.equal(summaryRow.has_error, 0);
          assert.equal(summaryRow.error_message, "");
          const sessionRow = readRequiredRow<{ audit_log_count: number }>(
            db,
            "SELECT audit_log_count FROM sessions WHERE id = ?",
            sessionId,
          );
          assert.equal(sessionRow.audit_log_count, 1);
        } finally {
          storage.close();
        }
      } finally {
        db.close();
      }
    });
  });

  it("updateAuditLog は summary/detail/operations を置換し、旧 operations を残さない", async () => {
    await withTempV2Database((dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        const sessionId = insertSessionHeader(db, { id: "session-update" });
        const storage = new AuditLogStorageV2Read(dbPath);

        try {
          const created = storage.createAuditLog({
            sessionId,
            createdAt: "2026-04-27T11:00:00.000Z",
            phase: "running",
            provider: "codex",
            model: "gpt-5.4-mini",
            reasoningEffort: "medium",
            approvalMode: DEFAULT_APPROVAL_MODE,
            threadId: "thread-update",
            logicalPrompt: {
              systemText: "old system",
              inputText: "old input",
              composedText: "old system\n\nold input",
            },
            transportPayload: {
              summary: "old summary",
              fields: [
                {
                  label: "version",
                  value: "old",
                },
              ],
            },
            assistantText: "assistant old",
            operations: [
              {
                type: "analysis",
                summary: "old summary op",
                details: "old analysis",
              },
            ],
            rawItemsJson: '[{"kind":"assistant","id":1}]',
            usage: {
              inputTokens: 10,
              cachedInputTokens: 1,
              outputTokens: 2,
            },
            errorMessage: "",
          });

          storage.updateAuditLog(created.id, {
            ...created,
            phase: "completed",
            logicalPrompt: {
              systemText: "new system",
              inputText: "new input",
              composedText: "new system\n\nnew input",
            },
            transportPayload: {
              summary: "new summary",
              fields: [
                {
                  label: "version",
                  value: "new",
                },
              ],
            },
            assistantText: "assistant updated",
            rawItemsJson: "[]",
            usage: {
              inputTokens: 20,
              cachedInputTokens: 2,
              outputTokens: 4,
            },
            operations: [
              {
                type: "approval",
                summary: "approved",
                details: "approved by user",
              },
            ],
            errorMessage: "updated error",
          });

          const updatedEntries = storage.listSessionAuditLogs(sessionId);
          const updatedEntry = updatedEntries[0];

          assert.equal(updatedEntries.length, 1);
          assert.equal(updatedEntry?.id, created.id);
          assert.equal(updatedEntry?.phase, "completed");
          assert.equal(updatedEntry?.assistantText, "assistant updated");
          assert.deepEqual(updatedEntry?.logicalPrompt, {
            systemText: "new system",
            inputText: "new input",
            composedText: "new system\n\nnew input",
          });
          assert.deepEqual(updatedEntry?.transportPayload, {
            summary: "new summary",
            fields: [
              {
                label: "version",
                value: "new",
              },
            ],
          });
          assert.deepEqual(updatedEntry?.operations.map((operation) => operation.summary), ["approved"]);
          assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM audit_log_details WHERE audit_log_id = ?", created.id), 1);
          assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM audit_log_operations WHERE audit_log_id = ?", created.id), 1);
          assert.equal(
            readCount(
              db,
              "SELECT COUNT(*) AS count FROM audit_log_operations WHERE audit_log_id = ? AND summary = ?",
              created.id,
              "old summary op",
            ),
            0,
          );
          const summaryRow = readRequiredRow<{
            phase: string;
            assistant_text_preview: string;
            operation_count: number;
            raw_item_count: number;
            input_tokens: number;
            cached_input_tokens: number;
            output_tokens: number;
            has_error: number;
            error_message: string;
          }>(
            db,
            `SELECT
              phase,
              assistant_text_preview,
              operation_count,
              raw_item_count,
              input_tokens,
              cached_input_tokens,
              output_tokens,
              has_error,
              error_message
            FROM audit_logs
            WHERE id = ?`,
            created.id,
          );
          assert.equal(summaryRow.phase, "completed");
          assert.equal(summaryRow.assistant_text_preview, "assistant updated");
          assert.equal(summaryRow.operation_count, 1);
          assert.equal(summaryRow.raw_item_count, 0);
          assert.equal(summaryRow.input_tokens, 20);
          assert.equal(summaryRow.cached_input_tokens, 2);
          assert.equal(summaryRow.output_tokens, 4);
          assert.equal(summaryRow.has_error, 1);
          assert.equal(summaryRow.error_message, "updated error");
          const sessionRow = readRequiredRow<{ audit_log_count: number }>(
            db,
            "SELECT audit_log_count FROM sessions WHERE id = ?",
            sessionId,
          );
          assert.equal(sessionRow.audit_log_count, 1);
        } finally {
          storage.close();
        }
      } finally {
        db.close();
      }
    });
  });

  it("updateAuditLog は異なる sessionId の更新を拒否し、既存 summary/detail/operations を変更しない", async () => {
    await withTempV2Database((dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        const sourceSessionId = insertSessionHeader(db, { id: "session-update-source" });
        const otherSessionId = insertSessionHeader(db, { id: "session-update-other" });
        const storage = new AuditLogStorageV2Read(dbPath);

        try {
          const created = storage.createAuditLog({
            sessionId: sourceSessionId,
            createdAt: "2026-04-27T11:30:00.000Z",
            phase: "running",
            provider: "codex",
            model: "gpt-5.4-mini",
            reasoningEffort: "medium",
            approvalMode: DEFAULT_APPROVAL_MODE,
            threadId: "thread-update-mismatch",
            logicalPrompt: {
              systemText: "system",
              inputText: "input",
              composedText: "system\n\ninput",
            },
            transportPayload: null,
            assistantText: "assistant original",
            operations: [
              {
                type: "analysis",
                summary: "original operation",
                details: "original details",
              },
            ],
            rawItemsJson: '[{"kind":"assistant","id":1}]',
            usage: {
              inputTokens: 5,
              cachedInputTokens: 1,
              outputTokens: 3,
            },
            errorMessage: "",
          });

          assert.throws(() => {
            storage.updateAuditLog(created.id, {
              ...created,
              sessionId: otherSessionId,
              phase: "failed",
              assistantText: "mutated assistant",
              operations: [
                {
                  type: "approval",
                  summary: "mutated operation",
                  details: "mutated details",
                },
              ],
              errorMessage: "must not be saved",
            });
          });

          const entries = storage.listSessionAuditLogs(sourceSessionId);
          assert.equal(entries.length, 1);
          assert.equal(entries[0]?.phase, "running");
          assert.equal(entries[0]?.assistantText, "assistant original");
          assert.deepEqual(entries[0]?.operations.map((operation) => operation.summary), ["original operation"]);
          assert.deepEqual(storage.listSessionAuditLogs(otherSessionId), []);

          const summaryRow = readRequiredRow<{ phase: string; error_message: string; has_error: number }>(
            db,
            "SELECT phase, error_message, has_error FROM audit_logs WHERE id = ?",
            created.id,
          );
          assert.equal(summaryRow.phase, "running");
          assert.equal(summaryRow.error_message, "");
          assert.equal(summaryRow.has_error, 0);
          assert.equal(
            readCount(
              db,
              "SELECT COUNT(*) AS count FROM audit_log_operations WHERE audit_log_id = ? AND summary = ?",
              created.id,
              "mutated operation",
            ),
            0,
          );

          const sourceSessionRow = readRequiredRow<{ audit_log_count: number }>(
            db,
            "SELECT audit_log_count FROM sessions WHERE id = ?",
            sourceSessionId,
          );
          const otherSessionRow = readRequiredRow<{ audit_log_count: number }>(
            db,
            "SELECT audit_log_count FROM sessions WHERE id = ?",
            otherSessionId,
          );
          assert.equal(sourceSessionRow.audit_log_count, 1);
          assert.equal(otherSessionRow.audit_log_count, 0);
        } finally {
          storage.close();
        }
      } finally {
        db.close();
      }
    });
  });

  it("clearAuditLogs は audit_log_details と audit_log_operations を残さない", async () => {
    await withTempV2Database((dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        const sessionId = insertSessionHeader(db, { id: "session-clear" });
        const storage = new AuditLogStorageV2Read(dbPath);

        try {
          storage.createAuditLog({
            sessionId,
            createdAt: "2026-04-27T12:00:00.000Z",
            phase: "completed",
            provider: "codex",
            model: "gpt-5.4-mini",
            reasoningEffort: "medium",
            approvalMode: DEFAULT_APPROVAL_MODE,
            threadId: "thread-clear-1",
            logicalPrompt: {
              systemText: "system-1",
              inputText: "input-1",
              composedText: "system-1\n\ninput-1",
            },
            transportPayload: null,
            assistantText: "assistant 1",
            operations: [
              {
                type: "analysis",
                summary: "first",
                details: "first op",
              },
            ],
            rawItemsJson: "[]",
            usage: null,
            errorMessage: "",
          });
          storage.createAuditLog({
            sessionId,
            createdAt: "2026-04-27T12:01:00.000Z",
            phase: "completed",
            provider: "codex",
            model: "gpt-5.4-mini",
            reasoningEffort: "medium",
            approvalMode: DEFAULT_APPROVAL_MODE,
            threadId: "thread-clear-2",
            logicalPrompt: {
              systemText: "system-2",
              inputText: "input-2",
              composedText: "system-2\n\ninput-2",
            },
            transportPayload: null,
            assistantText: "assistant 2",
            operations: [
              {
                type: "approval",
                summary: "second",
                details: "second op",
              },
            ],
            rawItemsJson: "[]",
            usage: null,
            errorMessage: "",
          });

          assert.equal(storage.listSessionAuditLogs(sessionId).length, 2);

          storage.clearAuditLogs();

          assert.equal(storage.listSessionAuditLogs(sessionId).length, 0);
          assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM audit_logs"), 0);
          assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM audit_log_details"), 0);
          assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM audit_log_operations"), 0);
          const sessionRow = readRequiredRow<{ audit_log_count: number }>(
            db,
            "SELECT audit_log_count FROM sessions WHERE id = ?",
            sessionId,
          );
          assert.equal(sessionRow.audit_log_count, 0);
        } finally {
          storage.close();
        }
      } finally {
        db.close();
      }
    });
  });
});
