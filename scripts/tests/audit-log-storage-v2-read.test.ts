import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

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
});
