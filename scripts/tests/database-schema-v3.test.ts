import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  APP_DATABASE_V3_FILENAME,
  APP_DATABASE_V3_SCHEMA_VERSION,
  CREATE_V3_SCHEMA_SQL,
  REQUIRED_V3_TABLES,
  V3_DETAILS_PREVIEW_MAX_LENGTH,
  V3_OPERATION_SUMMARY_MAX_LENGTH,
  V3_SCHEMA_STATUS,
  V3_SUMMARY_JSON_MAX_LENGTH,
  V3_TEXT_PREVIEW_MAX_LENGTH,
  isValidV3Database,
} from "../../src-electron/database-schema-v3.js";

type TableInfoRow = {
  name: string;
};

const FORBIDDEN_HEAVY_COLUMNS = [
  "logical_prompt_json",
  "transport_payload_json",
  "assistant_text",
  "raw_items_json",
  "text",
  "message_text",
  "body",
  "content",
  "artifact_json",
  "diff_snapshot_json",
  "diff_rows_json",
  "operations_json",
  "details",
  "error_message",
  "prompt_text",
  "response_text",
  "payload_json",
  "raw_json",
  "changed_files_json",
] as const;

function createV3Schema(dbPath = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  for (const statement of CREATE_V3_SCHEMA_SQL) {
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

describe("database-schema-v3", () => {
  it("withmate-v3.db 用の schema constants と required tables を固定する", () => {
    assert.equal(APP_DATABASE_V3_FILENAME, "withmate-v3.db");
    assert.equal(APP_DATABASE_V3_SCHEMA_VERSION, 3);
    assert.equal(V3_SCHEMA_STATUS, "ready-for-implementation");

    const db = createV3Schema();
    try {
      const names = tableNames(db);
      assert.deepEqual(names, [
        "app_settings",
        "audit_log_details",
        "audit_log_operations",
        "audit_logs",
        "blob_objects",
        "companion_audit_log_details",
        "companion_audit_log_operations",
        "companion_audit_logs",
        "companion_groups",
        "companion_merge_runs",
        "companion_message_artifacts",
        "companion_messages",
        "companion_sessions",
        "model_catalog_models",
        "model_catalog_providers",
        "model_catalog_revisions",
        "session_message_artifacts",
        "session_messages",
        "sessions",
      ]);
      assert.deepEqual(REQUIRED_V3_TABLES.filter((tableName) => !names.includes(tableName)), []);
    } finally {
      db.close();
    }
  });

  it("isValidV3Database は filename と required tables の両方を検証する", () => {
    const dirPath = mkdtempSync(join(tmpdir(), "withmate-v3-schema-"));
    try {
      const validDbPath = join(dirPath, APP_DATABASE_V3_FILENAME);
      const validDb = createV3Schema(validDbPath);
      validDb.close();

      const wrongNameDbPath = join(dirPath, "withmate-v2.db");
      const wrongNameDb = createV3Schema(wrongNameDbPath);
      wrongNameDb.close();

      const emptyDirPath = join(dirPath, "empty");
      const emptyV3DbPath = join(emptyDirPath, APP_DATABASE_V3_FILENAME);
      rmSync(emptyDirPath, { recursive: true, force: true });
      mkdirSync(emptyDirPath);
      closeSync(openSync(emptyV3DbPath, "w"));

      assert.equal(isValidV3Database(validDbPath), true);
      assert.equal(isValidV3Database(wrongNameDbPath), false);
      assert.equal(isValidV3Database(emptyV3DbPath), false);
    } finally {
      rmSync(dirPath, { recursive: true, force: true });
    }
  });

  it("V3 schema は V2/V1 の heavy payload column 名を持たない", () => {
    const db = createV3Schema();
    try {
      for (const tableName of tableNames(db)) {
        const columns = columnNames(db, tableName);
        for (const forbiddenColumn of FORBIDDEN_HEAVY_COLUMNS) {
          assert.equal(
            columns.includes(forbiddenColumn),
            false,
            `${tableName}.${forbiddenColumn} must not exist in V3 schema`,
          );
        }
      }
    } finally {
      db.close();
    }
  });

  it("session/audit/companion payload は preview と blob ref に分離する", () => {
    const db = createV3Schema();
    try {
      assert.deepEqual(columnNames(db, "session_messages"), [
        "id",
        "session_id",
        "seq",
        "role",
        "text_preview",
        "text_blob_id",
        "text_original_bytes",
        "text_stored_bytes",
        "accent",
        "artifact_available",
        "created_at",
      ]);
      assert.deepEqual(columnNames(db, "session_message_artifacts"), [
        "message_id",
        "artifact_summary_json",
        "artifact_blob_id",
        "artifact_original_bytes",
        "artifact_stored_bytes",
      ]);
      assert.deepEqual(columnNames(db, "audit_log_details"), [
        "audit_log_id",
        "logical_prompt_blob_id",
        "transport_payload_blob_id",
        "assistant_text_blob_id",
        "raw_items_blob_id",
        "usage_metadata_json",
        "usage_blob_id",
      ]);
      assert.deepEqual(columnNames(db, "audit_log_operations"), [
        "id",
        "audit_log_id",
        "seq",
        "operation_type",
        "summary",
        "details_preview",
        "details_blob_id",
      ]);
      assert.deepEqual(columnNames(db, "companion_messages"), [
        "id",
        "session_id",
        "position",
        "role",
        "text_preview",
        "text_blob_id",
        "text_original_bytes",
        "text_stored_bytes",
        "accent",
        "artifact_available",
        "created_at",
      ]);
      assert.deepEqual(columnNames(db, "companion_merge_runs"), [
        "id",
        "session_id",
        "group_id",
        "operation",
        "selected_paths_json",
        "changed_files_summary_json",
        "sibling_warnings_summary_json",
        "diff_snapshot_blob_id",
        "created_at",
      ]);
      assert.deepEqual(columnNames(db, "companion_audit_log_details"), [
        "audit_log_id",
        "logical_prompt_blob_id",
        "transport_payload_blob_id",
        "assistant_text_blob_id",
        "raw_items_blob_id",
        "usage_metadata_json",
        "usage_blob_id",
      ]);
    } finally {
      db.close();
    }
  });

  it("preview と summary は DB に重い payload を戻せないよう上限を持つ", () => {
    const schemaSql = CREATE_V3_SCHEMA_SQL.join("\n");

    assert.equal(V3_TEXT_PREVIEW_MAX_LENGTH, 500);
    assert.equal(V3_OPERATION_SUMMARY_MAX_LENGTH, 500);
    assert.equal(V3_DETAILS_PREVIEW_MAX_LENGTH, 500);
    assert.equal(V3_SUMMARY_JSON_MAX_LENGTH, 8192);
    assert.match(schemaSql, /CHECK \(length\(text_preview\) <= 500\)/);
    assert.match(schemaSql, /CHECK \(length\(assistant_text_preview\) <= 500\)/);
    assert.match(schemaSql, /CHECK \(length\(error_message_preview\) <= 500\)/);
    assert.match(schemaSql, /CHECK \(length\(summary\) <= 500\)/);
    assert.match(schemaSql, /CHECK \(length\(details_preview\) <= 500\)/);
    assert.match(schemaSql, /CHECK \(length\(artifact_summary_json\) <= 8192\)/);
    assert.match(schemaSql, /CHECK \(length\(changed_files_summary_json\) <= 8192\)/);
    assert.doesNotMatch(schemaSql, /\bchanged_files_json\b/);
    assert.doesNotMatch(schemaSql, /\bsibling_warnings_json\b/);
  });
});
