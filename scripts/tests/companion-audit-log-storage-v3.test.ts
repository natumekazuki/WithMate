import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { CompanionAuditLogStorageV3 } from "../../src-electron/companion-audit-log-storage-v3.js";
import {
  CREATE_V3_SCHEMA_SQL,
  V3_DETAILS_PREVIEW_MAX_LENGTH,
  V3_OPERATION_SUMMARY_MAX_LENGTH,
  V3_TEXT_PREVIEW_MAX_LENGTH,
} from "../../src-electron/database-schema-v3.js";
import { TextBlobStore } from "../../src-electron/text-blob-store.js";

async function withTempV3Database<T>(fn: (input: { dbPath: string; blobRootPath: string }) => T | Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "withmate-companion-audit-log-v3-"));
  const dbPath = path.join(dir, "withmate-v3.db");
  const blobRootPath = path.join(dir, "blobs");

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    for (const statement of CREATE_V3_SCHEMA_SQL) {
      db.exec(statement);
    }
    insertCompanionSessionHeader(db, { id: "companion-session-v3" });
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
  groupId?: string;
  taskTitle?: string;
  workspacePath?: string;
  workspaceLabel?: string;
  threadId?: string;
};

function insertCompanionSessionHeader(db: DatabaseSync, input: SessionHeaderInput): string {
  const {
    id,
    groupId = "companion-group-v3",
    taskTitle = "Companion task",
    workspacePath = "workspace-a",
    workspaceLabel = "Workspace A",
    threadId = "thread-Companion",
  } = input;

  db.prepare(`
    INSERT INTO companion_groups (
      id,
      repo_root,
      display_name,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    groupId,
    workspacePath,
    workspaceLabel,
    "2026-04-27T00:00:00.000Z",
    "2026-04-27T00:00:00.000Z",
  );

  db.prepare(`
    INSERT INTO companion_sessions (
      id,
      group_id,
      task_title,
      status,
      repo_root,
      focus_path,
      target_branch,
      base_snapshot_ref,
      base_snapshot_commit,
      companion_branch,
      worktree_path,
      selected_paths_json,
      changed_files_summary_json,
      sibling_warnings_summary_json,
      allowed_additional_directories_json,
      run_state,
      thread_id,
      provider,
      catalog_revision,
      model,
      reasoning_effort,
      custom_agent_name,
      approval_mode,
      codex_sandbox_mode,
      character_id,
      character_name,
      character_role_preview,
      character_role_blob_id,
      character_icon_path,
      character_theme_main,
      character_theme_sub,
      message_count,
      audit_log_count,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    groupId,
    taskTitle,
    "active",
    workspacePath,
    "src",
    "main",
    "HEAD",
    "abc123",
    "companion/audit-log",
    path.join(workspacePath, ".withmate", id),
    JSON.stringify(["src"]),
    JSON.stringify([]),
    JSON.stringify([]),
    JSON.stringify(["shared/reference"]),
    "idle",
    threadId,
    "codex",
    1,
    "gpt-5.4-mini",
    "medium",
    "",
    "untrusted",
    "workspace-write",
    "char-a",
    "A",
    "",
    null,
    "",
    "#6f8cff",
    "#6fb8c7",
    0,
    0,
    "2026-04-27T00:00:00.000Z",
    "2026-04-27T00:00:00.000Z",
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
     FROM companion_audit_log_details
     WHERE audit_log_id = ?`,
    auditLogId,
  );
  const operationRows = db.prepare(`
    SELECT details_blob_id
    FROM companion_audit_log_operations
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

describe("CompanionAuditLogStorageV3", () => {
  it("create -> summary/page -> detail を blob-backed payload で roundtrip する", async () => {
    await withTempV3Database(async ({ dbPath, blobRootPath }) => {
      const sessionId = "companion-session-v3";
      const sentinel = "SENTINEL_RAW_PAYLOAD_ONLY_IN_BLOB_V3";
      const assistantText = `${"a".repeat(V3_TEXT_PREVIEW_MAX_LENGTH + 20)}${sentinel}:assistant`;
      const operationDetails = `${"d".repeat(V3_DETAILS_PREVIEW_MAX_LENGTH + 20)}${sentinel}:operation`;
      const longSummary = "s".repeat(V3_OPERATION_SUMMARY_MAX_LENGTH + 20);
      const storage = new CompanionAuditLogStorageV3(dbPath, blobRootPath);

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
            systemText: `${sentinel}:system`,
            inputText: `${sentinel}:input`,
            composedText: `${sentinel}:system\n\n${sentinel}:input`,
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
        assert.equal(created.logicalPrompt.systemText, `${sentinel}:system`);
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
        assert.equal(detail.logicalPrompt.composedText, `${sentinel}:system\n\n${sentinel}:input`);
        assert.equal(detail.transportPayload?.summary, `${sentinel}:transport`);
        assert.equal(detail.rawItemsJson, JSON.stringify([{ kind: "assistant", text: `${sentinel}:raw-item` }]));
        assert.deepEqual(detail.usage, {
          inputTokens: 11,
          cachedInputTokens: 2,
          outputTokens: 6,
        });
        assert.equal(detail.operations[0]?.details, operationDetails);
        assert.equal(await storage.getSessionAuditLogDetail("other-session", created.id), null);
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
        assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM companion_audit_log_details WHERE audit_log_id = 1"), 1);
        assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM companion_audit_log_operations WHERE audit_log_id = 1"), 1);
        assert.equal(
          readCount(db, "SELECT audit_log_count AS count FROM companion_sessions WHERE id = ?", sessionId),
          1,
        );

        const summaryRow = readRequiredRow<{
          assistant_text_preview: string;
          error_message_preview: string;
          operation_count: number;
          raw_item_count: number;
        }>(
          db,
          `SELECT assistant_text_preview, error_message_preview, operation_count, raw_item_count
           FROM companion_audit_logs
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
           FROM companion_audit_log_operations
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
           FROM companion_audit_log_details
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
        assert.equal((await blobStore.getJson<{ systemText: string }>(detailBlobRow.logical_prompt_blob_id)).systemText, `${sentinel}:system`);
        assert.equal(await blobStore.getText(detailBlobRow.assistant_text_blob_id), assistantText);
        assert.equal(await blobStore.getText(operationRow.details_blob_id), operationDetails);
      } finally {
        db.close();
      }
    });
  });

  it("update と clear で参照されなくなった audit blob を cleanup する", async () => {
    await withTempV3Database(async ({ dbPath, blobRootPath }) => {
      const storage = new CompanionAuditLogStorageV3(dbPath, blobRootPath);
      const blobStore = new TextBlobStore(blobRootPath);
      const created = await storage.createAuditLog({
        sessionId: "companion-session-v3",
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
        sessionId: "companion-session-v3",
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
        assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM companion_audit_logs"), 0);
        assert.equal(readCount(db, "SELECT COUNT(*) AS count FROM blob_objects"), 0);
        assert.equal(
          readCount(db, "SELECT audit_log_count AS count FROM companion_sessions WHERE id = ?", "companion-session-v3"),
          0,
        );
      } finally {
        db.close();
        storage.close();
      }
    });
  });
});
