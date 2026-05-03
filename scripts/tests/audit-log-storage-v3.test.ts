import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { AUDIT_LOG_LOGICAL_PROMPT_PREVIEW_MAX_CHARS } from "../../src-electron/audit-log-detail-preview.js";
import { AuditLogStorageV3 } from "../../src-electron/audit-log-storage-v3.js";
import {
  CREATE_V3_SCHEMA_SQL,
  V3_DETAILS_PREVIEW_MAX_LENGTH,
  V3_OPERATION_SUMMARY_MAX_LENGTH,
  V3_TEXT_PREVIEW_MAX_LENGTH,
} from "../../src-electron/database-schema-v3.js";
import { TextBlobStore } from "../../src-electron/text-blob-store.js";

async function withTempV3Database<T>(fn: (input: { dbPath: string; blobRootPath: string }) => T | Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "withmate-audit-log-v3-"));
  const dbPath = path.join(dir, "withmate-v3.db");
  const blobRootPath = path.join(dir, "blobs");

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    for (const statement of CREATE_V3_SCHEMA_SQL) {
      db.exec(statement);
    }
    insertSessionHeader(db, { id: "session-v3" });
  } finally {
    db.close();
  }

  try {
    return await fn({ dbPath, blobRootPath });
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

function readRequiredRow<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T {
  const row = db.prepare(sql).get(...params) as T | undefined;
  assert.ok(row);
  return row;
}

function readCount(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): number {
  const row = readRequiredRow<{ count: number }>(db, sql, ...params);
  return Number(row.count);
}

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_"));
}

function textColumnNames(db: DatabaseSync, tableName: string): string[] {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string; type: string }>)
    .filter((row) => row.type.toUpperCase().includes("TEXT"))
    .map((row) => row.name);
}

function readAllTextValues(db: DatabaseSync): string[] {
  const values: string[] = [];
  for (const tableName of tableNames(db)) {
    for (const columnName of textColumnNames(db, tableName)) {
      const rows = db.prepare(`SELECT ${columnName} AS value FROM ${tableName}`).all() as Array<{ value: string | null }>;
      for (const row of rows) {
        if (typeof row.value === "string") {
          values.push(row.value);
        }
      }
    }
  }
  return values;
}

function readAuditBlobIds(db: DatabaseSync, auditLogId: number): string[] {
  const detailRow = readRequiredRow<{
    logical_prompt_blob_id: string;
    transport_payload_blob_id: string | null;
    assistant_text_blob_id: string;
    raw_items_blob_id: string;
  }>(
    db,
    `SELECT logical_prompt_blob_id, transport_payload_blob_id, assistant_text_blob_id, raw_items_blob_id
     FROM audit_log_details
     WHERE audit_log_id = ?`,
    auditLogId,
  );
  const operationRows = db.prepare(`
    SELECT details_blob_id
    FROM audit_log_operations
    WHERE audit_log_id = ?
    ORDER BY seq ASC
  `).all(auditLogId) as Array<{ details_blob_id: string | null }>;
  return [
    detailRow.logical_prompt_blob_id,
    detailRow.transport_payload_blob_id,
    detailRow.assistant_text_blob_id,
    detailRow.raw_items_blob_id,
    ...operationRows.map((row) => row.details_blob_id),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

describe("AuditLogStorageV3", () => {
  it("create -> summary/page -> detail を blob-backed payload で roundtrip する", async () => {
    await withTempV3Database(async ({ dbPath, blobRootPath }) => {
      const sessionId = "session-v3";
      const sentinel = "SENTINEL_RAW_PAYLOAD_ONLY_IN_BLOB_V3";
      const assistantText = `${"a".repeat(V3_TEXT_PREVIEW_MAX_LENGTH + 20)}${sentinel}:assistant`;
      const operationDetails = `${"d".repeat(V3_DETAILS_PREVIEW_MAX_LENGTH + 20)}${sentinel}:operation`;
      const longSummary = "s".repeat(V3_OPERATION_SUMMARY_MAX_LENGTH + 20);
      const logicalSystemText = `${"p".repeat(AUDIT_LOG_LOGICAL_PROMPT_PREVIEW_MAX_CHARS + 20)}${sentinel}:system`;
      const logicalInputText = `${sentinel}:input`;
      const logicalComposedText = `${logicalSystemText}\n\n${logicalInputText}`;
      const storage = new AuditLogStorageV3(dbPath, blobRootPath);

      try {
        const created = await storage.createAuditLog({
          sessionId,
          createdAt: "2026-04-27T10:00:00.000Z",
          phase: "completed",
          provider: "codex",
          model: "gpt-5.4-mini",
          reasoningEffort: "medium",
          approvalMode: DEFAULT_APPROVAL_MODE,
          threadId: "thread-v3",
          logicalPrompt: {
            systemText: logicalSystemText,
            inputText: logicalInputText,
            composedText: logicalComposedText,
          },
          transportPayload: {
            summary: `${sentinel}:transport`,
            fields: [
              {
                label: "payload",
                value: `${sentinel}:field`,
              },
            ],
          },
          assistantText,
          operations: [
            {
              type: "analysis",
              summary: longSummary,
              details: operationDetails,
            },
          ],
          rawItemsJson: JSON.stringify([{ kind: "assistant", text: `${sentinel}:raw-item` }]),
          usage: {
            inputTokens: 11,
            cachedInputTokens: 2,
            outputTokens: 6,
          },
          errorMessage: "",
        });

        assert.equal(created.assistantText, assistantText);
        assert.equal(created.logicalPrompt.systemText, logicalSystemText);
        assert.equal(created.transportPayload?.fields[0]?.value, `${sentinel}:field`);
        assert.equal(created.rawItemsJson, JSON.stringify([{ kind: "assistant", text: `${sentinel}:raw-item` }]));
        assert.equal(created.operations[0]?.details, operationDetails);

        const summaries = await storage.listSessionAuditLogSummaries(sessionId);
        assert.equal(summaries.length, 1);
        assert.equal(summaries[0]?.assistantTextPreview, assistantText.slice(0, V3_TEXT_PREVIEW_MAX_LENGTH));
        assert.equal(summaries[0]?.operations[0]?.summary, longSummary.slice(0, V3_OPERATION_SUMMARY_MAX_LENGTH));
        assert.equal(summaries[0]?.operations[0]?.details, undefined);
        assert.equal(summaries[0]?.detailAvailable, true);
        assert.equal("rawItemsJson" in (summaries[0] as object), false);

        const page = await storage.listSessionAuditLogSummaryPage(sessionId, { cursor: 0, limit: 1 });
        assert.deepEqual(page.entries.map((entry) => entry.id), [created.id]);
        assert.equal(page.nextCursor, null);
        assert.equal(page.hasMore, false);
        assert.equal(page.total, 1);

        const detail = await storage.getSessionAuditLogDetail(sessionId, created.id);
        assert.ok(detail);
        assert.equal(detail.assistantText, assistantText);
        assert.equal(detail.logicalPrompt.composedText, logicalComposedText);
        assert.equal(detail.transportPayload?.summary, `${sentinel}:transport`);
        assert.equal(detail.rawItemsJson, JSON.stringify([{ kind: "assistant", text: `${sentinel}:raw-item` }]));
        assert.deepEqual(detail.usage, {
          inputTokens: 11,
          cachedInputTokens: 2,
          outputTokens: 6,
        });
        assert.equal(detail.operations[0]?.details, operationDetails);
        assert.equal(await storage.getSessionAuditLogDetail("other-session", created.id), null);

        const logicalFragment = await storage.getSessionAuditLogDetailSection(sessionId, created.id, "logical");
        assert.deepEqual(Object.keys(logicalFragment ?? {}).sort(), ["id", "logicalPrompt", "sessionId"]);
        assert.equal(logicalFragment?.logicalPrompt?.inputText, logicalInputText);
        assert.equal(logicalFragment?.logicalPrompt?.systemText.length, AUDIT_LOG_LOGICAL_PROMPT_PREVIEW_MAX_CHARS + 30);
        assert.match(logicalFragment?.logicalPrompt?.systemText ?? "", /truncated \d+ chars/);
        assert.ok((logicalFragment?.logicalPrompt?.composedText.length ?? 0) <= AUDIT_LOG_LOGICAL_PROMPT_PREVIEW_MAX_CHARS + 64);

        const responseFragment = await storage.getSessionAuditLogDetailSection(sessionId, created.id, "response");
        assert.deepEqual(Object.keys(responseFragment ?? {}).sort(), ["assistantText", "id", "sessionId"]);
        assert.equal(responseFragment?.assistantText, assistantText);

        const operationsFragment = await storage.getSessionAuditLogDetailSection(sessionId, created.id, "operations");
        assert.deepEqual(Object.keys(operationsFragment ?? {}).sort(), ["id", "operations", "sessionId"]);
        assert.equal(operationsFragment?.operations?.[0]?.details, operationDetails.slice(0, V3_DETAILS_PREVIEW_MAX_LENGTH));

        const operationDetail = await storage.getSessionAuditLogOperationDetail(sessionId, created.id, 0);
        assert.equal(operationDetail?.details, operationDetails);
        assert.equal(await storage.getSessionAuditLogOperationDetail("other-session", created.id, 0), null);
      } finally {
        storage.close();
      }

      const db = new DatabaseSync(dbPath);
      try {
        const textValues = readAllTextValues(db);
        assert.equal(
          textValues.some((value) => value.includes(sentinel)),
          false,
          "sentinel raw payload must not be stored in sqlite text columns",
        );
        assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM blob_objects"), 5);
        assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM audit_log_details WHERE audit_log_id = 1"), 1);
        assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM audit_log_operations WHERE audit_log_id = 1"), 1);

        const summaryRow = readRequiredRow<{
          assistant_text_preview: string;
          error_message_preview: string;
          operation_count: number;
          raw_item_count: number;
        }>(
          db,
          `SELECT assistant_text_preview, error_message_preview, operation_count, raw_item_count
           FROM audit_logs
           WHERE id = 1`,
        );
        assert.equal(summaryRow.assistant_text_preview.length, V3_TEXT_PREVIEW_MAX_LENGTH);
        assert.equal(summaryRow.error_message_preview, "");
        assert.equal(summaryRow.operation_count, 1);
        assert.equal(summaryRow.raw_item_count, 1);

        const operationRow = readRequiredRow<{
          summary: string;
          details_preview: string;
          details_blob_id: string;
        }>(
          db,
          `SELECT summary, details_preview, details_blob_id
           FROM audit_log_operations
           WHERE audit_log_id = 1`,
        );
        assert.equal(operationRow.summary.length, V3_OPERATION_SUMMARY_MAX_LENGTH);
        assert.equal(operationRow.details_preview.length, V3_DETAILS_PREVIEW_MAX_LENGTH);
        assert.match(operationRow.details_blob_id, /^[a-f0-9]{64}$/);

        const detailBlobRow = readRequiredRow<{
          logical_prompt_blob_id: string;
          transport_payload_blob_id: string;
          assistant_text_blob_id: string;
          raw_items_blob_id: string;
        }>(
          db,
          `SELECT logical_prompt_blob_id, transport_payload_blob_id, assistant_text_blob_id, raw_items_blob_id
           FROM audit_log_details
           WHERE audit_log_id = 1`,
        );
        const blobIds = [
          detailBlobRow.logical_prompt_blob_id,
          detailBlobRow.transport_payload_blob_id,
          detailBlobRow.assistant_text_blob_id,
          detailBlobRow.raw_items_blob_id,
          operationRow.details_blob_id,
        ];
        for (const blobId of blobIds) {
          assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM blob_objects WHERE blob_id = ?", blobId), 1);
        }

        const blobStore = new TextBlobStore(blobRootPath);
        assert.equal((await blobStore.getJson<{ systemText: string }>(detailBlobRow.logical_prompt_blob_id)).systemText, logicalSystemText);
        assert.equal(await blobStore.getText(detailBlobRow.assistant_text_blob_id), assistantText);
        assert.equal(await blobStore.getText(operationRow.details_blob_id), operationDetails);
      } finally {
        db.close();
      }
    });
  });

  it("update と clear で参照されなくなった audit blob を cleanup する", async () => {
    await withTempV3Database(async ({ dbPath, blobRootPath }) => {
      const storage = new AuditLogStorageV3(dbPath, blobRootPath);
      const blobStore = new TextBlobStore(blobRootPath);
      const created = await storage.createAuditLog({
        sessionId: "session-v3",
        createdAt: "2026-04-27T11:00:00.000Z",
        phase: "completed",
        provider: "codex",
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
        approvalMode: DEFAULT_APPROVAL_MODE,
        threadId: "thread-v3",
        logicalPrompt: {
          systemText: "old-system",
          inputText: "old-input",
          composedText: "old-system\nold-input",
        },
        transportPayload: null,
        assistantText: "old assistant raw",
        operations: [{
          type: "analysis",
          summary: "old summary",
          details: "old operation details",
        }],
        rawItemsJson: JSON.stringify([{ text: "old raw item" }]),
        usage: null,
        errorMessage: "",
      });

      const oldBlobIds = (() => {
        const db = new DatabaseSync(dbPath);
        try {
          return readAuditBlobIds(db, created.id);
        } finally {
          db.close();
        }
      })();

      await storage.updateAuditLog(created.id, {
        sessionId: "session-v3",
        createdAt: "2026-04-27T11:01:00.000Z",
        phase: "completed",
        provider: "codex",
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
        approvalMode: DEFAULT_APPROVAL_MODE,
        threadId: "thread-v3",
        logicalPrompt: {
          systemText: "new-system",
          inputText: "new-input",
          composedText: "new-system\nnew-input",
        },
        transportPayload: null,
        assistantText: "new assistant raw",
        operations: [{
          type: "analysis",
          summary: "new summary",
          details: "new operation details",
        }],
        rawItemsJson: JSON.stringify([{ text: "new raw item" }]),
        usage: null,
        errorMessage: "",
      });

      for (const blobId of oldBlobIds) {
        assert.equal(await blobStore.stat(blobId), null);
      }

      const newBlobIds = (() => {
        const db = new DatabaseSync(dbPath);
        try {
          for (const blobId of oldBlobIds) {
            assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM blob_objects WHERE blob_id = ?", blobId), 0);
          }
          return readAuditBlobIds(db, created.id);
        } finally {
          db.close();
        }
      })();

      await storage.clearAuditLogs();
      for (const blobId of newBlobIds) {
        assert.equal(await blobStore.stat(blobId), null);
      }

      const db = new DatabaseSync(dbPath);
      try {
        assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM audit_logs"), 0);
        assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM blob_objects"), 0);
      } finally {
        db.close();
        storage.close();
      }
    });
  });

  it("DB transaction が失敗した場合は永続化されなかった audit blob file を cleanup する", async () => {
    await withTempV3Database(async ({ dbPath, blobRootPath }) => {
      const storage = new AuditLogStorageV3(dbPath, blobRootPath);

      try {
        await assert.rejects(() => storage.createAuditLog({
          sessionId: "missing-session",
          createdAt: "2026-04-27T10:00:00.000Z",
          phase: "completed",
          provider: "codex",
          model: "gpt-5.4-mini",
          reasoningEffort: "medium",
          approvalMode: DEFAULT_APPROVAL_MODE,
          threadId: "thread-v3",
          logicalPrompt: {
            systemText: "system",
            inputText: "input",
            composedText: "system\n\ninput",
          },
          transportPayload: {
            summary: "transport",
            fields: [],
          },
          assistantText: "assistant text",
          operations: [
            {
              type: "analysis",
              summary: "operation",
              details: "operation details",
            },
          ],
          rawItemsJson: JSON.stringify([{ kind: "assistant", text: "raw" }]),
          usage: null,
          errorMessage: "",
        }));

        const blobStore = new TextBlobStore(blobRootPath);
        const report = await blobStore.collectGarbage({ referencedBlobIds: [], dryRun: true });
        assert.deepEqual(report.orphanBlobIds, []);

        const db = new DatabaseSync(dbPath);
        try {
          assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM blob_objects"), 0);
        } finally {
          db.close();
        }
      } finally {
        storage.close();
      }
    });
  });
});
