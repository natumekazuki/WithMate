import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  APP_DATABASE_V2_FILENAME,
  APP_DATABASE_V2_SCHEMA_VERSION,
  CREATE_V2_SCHEMA_SQL,
  V2_AUDIT_LOG_SUMMARY_COLUMNS,
  V2_SCHEMA_STATUS,
  V2_SESSION_SUMMARY_COLUMNS,
} from "../../src-electron/database-schema-v2.js";

type TableInfoRow = {
  name: string;
};

const EXPECTED_SESSION_SUMMARY_COLUMNS = [
  "id",
  "task_title",
  "task_summary",
  "status",
  "updated_at",
  "provider",
  "catalog_revision",
  "workspace_label",
  "workspace_path",
  "branch",
  "session_kind",
  "character_id",
  "character_name",
  "character_icon_path",
  "character_theme_main",
  "character_theme_sub",
  "run_state",
  "approval_mode",
  "codex_sandbox_mode",
  "model",
  "reasoning_effort",
  "custom_agent_name",
  "allowed_additional_directories_json",
  "thread_id",
  "message_count",
  "audit_log_count",
] as const;

const EXPECTED_AUDIT_LOG_SUMMARY_COLUMNS = [
  "id",
  "session_id",
  "created_at",
  "phase",
  "provider",
  "model",
  "reasoning_effort",
  "approval_mode",
  "thread_id",
  "assistant_text_preview",
  "operation_count",
  "raw_item_count",
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "has_error",
  "error_message",
  "detail_available",
] as const;

const AUDIT_DETAIL_PAYLOAD_COLUMNS = [
  "logical_prompt_json",
  "transport_payload_json",
  "assistant_text",
  "raw_items_json",
  "usage_json",
] as const;

function createV2Schema(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const statement of CREATE_V2_SCHEMA_SQL) {
    db.exec(statement);
  }
  return db;
}

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as TableInfoRow[])
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_"));
}

function columnNames(db: DatabaseSync, tableName: string): string[] {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[]).map((row) => row.name);
}

describe("database-schema-v2", () => {
  it("withmate-v2.db 用の実装可能 schema として固定する", () => {
    assert.equal(APP_DATABASE_V2_FILENAME, "withmate-v2.db");
    assert.equal(APP_DATABASE_V2_SCHEMA_VERSION, 2);
    assert.equal(V2_SCHEMA_STATUS, "ready-for-implementation");

    const db = createV2Schema();
    try {
      assert.deepEqual(tableNames(db), [
        "app_settings",
        "audit_log_details",
        "audit_log_operations",
        "audit_logs",
        "model_catalog_models",
        "model_catalog_providers",
        "model_catalog_revisions",
        "session_message_artifacts",
        "session_messages",
        "sessions",
      ]);
    } finally {
      db.close();
    }
  });

  it("sessions は一覧 header と message detail を分離し、legacy JSON を持たない", () => {
    const db = createV2Schema();
    try {
      const sessionColumns = columnNames(db, "sessions");
      const messageColumns = columnNames(db, "session_messages");

      assert.deepEqual(V2_SESSION_SUMMARY_COLUMNS, EXPECTED_SESSION_SUMMARY_COLUMNS);
      assert.deepEqual(V2_SESSION_SUMMARY_COLUMNS.filter((column) => !sessionColumns.includes(column)), []);
      assert.equal(sessionColumns.includes("messages_json"), false);
      assert.equal(sessionColumns.includes("stream_json"), false);
      assert.ok(messageColumns.includes("session_id"));
      assert.ok(messageColumns.includes("seq"));
      assert.ok(messageColumns.includes("text"));
      assert.ok(messageColumns.includes("artifact_available"));
      assert.equal(messageColumns.includes("artifact_json"), false);
      assert.deepEqual(columnNames(db, "session_message_artifacts"), ["message_id", "artifact_json"]);
    } finally {
      db.close();
    }
  });

  it("audit log は一覧 summary と detail payload を分離する", () => {
    const db = createV2Schema();
    try {
      const auditColumns = columnNames(db, "audit_logs");
      const detailColumns = columnNames(db, "audit_log_details");
      const operationColumns = columnNames(db, "audit_log_operations");

      assert.deepEqual(V2_AUDIT_LOG_SUMMARY_COLUMNS, EXPECTED_AUDIT_LOG_SUMMARY_COLUMNS);
      assert.deepEqual(auditColumns, [...EXPECTED_AUDIT_LOG_SUMMARY_COLUMNS]);
      assert.deepEqual(detailColumns, ["audit_log_id", ...AUDIT_DETAIL_PAYLOAD_COLUMNS]);
      for (const column of AUDIT_DETAIL_PAYLOAD_COLUMNS) {
        assert.equal(auditColumns.includes(column), false);
      }
      assert.equal(auditColumns.includes("operations_json"), false);
      assert.equal(detailColumns.includes("operations_json"), false);
      assert.deepEqual(operationColumns, ["id", "audit_log_id", "seq", "operation_type", "summary", "details"]);
    } finally {
      db.close();
    }
  });

  it("MemoryGeneration と独り言の legacy tables を V2 正本 schema に含めない", () => {
    const db = createV2Schema();
    try {
      const names = tableNames(db);
      assert.equal(names.includes("session_memories"), false);
      assert.equal(names.includes("project_scopes"), false);
      assert.equal(names.includes("project_memory_entries"), false);
      assert.equal(names.includes("character_scopes"), false);
      assert.equal(names.includes("character_memory_entries"), false);
      assert.equal(names.some((name) => name.includes("monologue")), false);
    } finally {
      db.close();
    }
  });
});
