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
  // @test-value v2
  // kind = "contract"
  // claim = "V3 schema constantsとrequired tablesは現行Session/Audit/blob/catalog schemaを満たす"
  // oracle = { type = "contract", ref = "src-electron/database-schema-v3.ts" }
  // fault = "schema作成後にrequired tableが欠落するか、定義済みversion/nameと実体が不一致になる"
  // observable = "schema version, filename, table names, and required table coverage"
  // observation_boundary = "public-boundary"
  // scope = "database schema v3 table contract"
  // lifecycle = "permanent"
  // @end-test-value
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

  // @test-value v2
  // kind = "contract"
  // claim = "isValidV3Databaseはfilenameとschema versionが一致するDBだけを有効と判定する"
  // oracle = { type = "contract", ref = "src-electron/database-schema-v3.ts" }
  // fault = "異なるfilenameまたは空DBを有効DBとして受け入れる"
  // observable = "isValidV3Database result for valid, wrong-name, and empty databases"
  // observation_boundary = "public-boundary"
  // scope = "database schema v3 validation"
  // lifecycle = "permanent"
  // @end-test-value
  it("isValidV3Database は filename と schema version を検証する", () => {
    const dirPath = mkdtempSync(join(tmpdir(), "withmate-v3-schema-"));
    try {
      const validDbPath = join(dirPath, APP_DATABASE_V3_FILENAME);
      const validDb = createV3Schema(validDbPath);
      validDb.close();

      const wrongVersionDirPath = join(dirPath, "wrong-version");
      mkdirSync(wrongVersionDirPath);
      const wrongVersionDbPath = join(wrongVersionDirPath, APP_DATABASE_V3_FILENAME);
      const wrongVersionDb = createV3Schema(wrongVersionDbPath);
      try {
        wrongVersionDb.exec("PRAGMA user_version = 2;");
      } finally {
        wrongVersionDb.close();
      }

      const wrongNameDbPath = join(dirPath, "withmate-v2.db");
      const wrongNameDb = createV3Schema(wrongNameDbPath);
      wrongNameDb.close();

      const emptyDirPath = join(dirPath, "empty");
      const emptyV3DbPath = join(emptyDirPath, APP_DATABASE_V3_FILENAME);
      rmSync(emptyDirPath, { recursive: true, force: true });
      mkdirSync(emptyDirPath);
      closeSync(openSync(emptyV3DbPath, "w"));

      assert.equal(isValidV3Database(validDbPath), true);
      assert.equal(isValidV3Database(wrongVersionDbPath), false);
      assert.equal(isValidV3Database(wrongNameDbPath), false);
      assert.equal(isValidV3Database(emptyV3DbPath), false);
    } finally {
      rmSync(dirPath, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "V3 schemaはheavy payload columnを物理tableへ戻さない"
  // oracle = { type = "contract", ref = "src-electron/database-schema-v3.ts" }
  // fault = "V2/V1由来のheavy payloadを新schemaへ再導入し、保存領域の契約を壊す"
  // observable = "all V3 table column names"
  // observation_boundary = "public-boundary"
  // scope = "database schema v3 payload boundary"
  // lifecycle = "permanent"
  // @end-test-value
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

  // @test-value v2
  // kind = "contract"
  // claim = "V3 preview/summary fieldsは定義された上限内で重いpayloadを戻さない"
  // oracle = { type = "contract", ref = "src-electron/database-schema-v3.ts" }
  // fault = "preview/summaryの上限を緩め、重いpayloadがschemaへ戻る"
  // observable = "size constants and schema CHECK constraints"
  // observation_boundary = "public-boundary"
  // scope = "database schema v3 preview limits"
  // lifecycle = "permanent"
  // @end-test-value
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
    assert.doesNotMatch(schemaSql, /\bchanged_files_json\b/);
    assert.doesNotMatch(schemaSql, /\bsibling_warnings_json\b/);
  });
});
