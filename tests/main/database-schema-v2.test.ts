import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  APP_DATABASE_V2_FILENAME,
  APP_DATABASE_V2_SCHEMA_VERSION,
  CREATE_V2_SCHEMA_SQL,
  V2_SCHEMA_STATUS,
  V2_SESSION_SUMMARY_COLUMNS,
} from "../../src-electron/storage/database-schema-v2.js";

type TableInfoRow = {
  name: string;
};

const EXPECTED_SESSION_SUMMARY_COLUMNS = [
  "id",
  "task_title",
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
  // @test-value v2
  // kind = "contract"
  // claim = "V2移行元のDB識別定数とCREATE_V2_SCHEMA_SQLが生成する7tableの構成を維持する"
  // oracle = { type = "contract", ref = "src-electron/storage/database-schema-v2.ts: APP_DATABASE_V2_FILENAME / APP_DATABASE_V2_SCHEMA_VERSION / V2_SCHEMA_STATUS / CREATE_V2_SCHEMA_SQL; docs/design/database-schema.md: 起動時の移行とデータ保護" }
  // fault = "V2 DBのfilename/version/statusを変えるか、CREATE_V2_SCHEMA_SQLが必要なtableを欠落・余分に作成する"
  // observable = "V2識別定数とメモリ内SQLiteのsqlite_schema table名一覧"
  // observation_boundary = "declaration"
  // scope = "main/database-schema-v2"
  // lifecycle = "permanent"
  // impact = "対応するV2移行元のschema構成を誤り、通常会話とartifactを後続migrationが読めなくなる"
  // distinction = "型検査ではSQLを実行せずtableの欠落を検出できない。移行のrow保持ではなくV2生成DDLの構成を直接確認する"
  // @end-test-value
  it("withmate-v2.db 用の実装可能 schema として固定する", () => {
    assert.equal(APP_DATABASE_V2_FILENAME, "withmate-v2.db");
    assert.equal(APP_DATABASE_V2_SCHEMA_VERSION, 2);
    assert.equal(V2_SCHEMA_STATUS, "ready-for-implementation");

    const db = createV2Schema();
    try {
      assert.deepEqual(tableNames(db), [
        "app_settings",
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

  // @test-value v2
  // kind = "contract"
  // claim = "V2は一覧用session headerと順序付きmessage、bookmark列、独立artifact detailの列を分離する"
  // oracle = { type = "contract", ref = "src-electron/storage/database-schema-v2.ts: V2_SESSION_SUMMARY_COLUMNS / CREATE_V2_SESSIONS_TABLE_SQL / CREATE_V2_SESSION_MESSAGES_TABLE_SQL / CREATE_V2_SESSION_MESSAGE_ARTIFACTS_TABLE_SQL" }
  // fault = "summary列を欠落・変更する、messageのseq/bookmark/artifact_availableを欠落させる、またはheader/messageに全量JSONを置きartifact detailを分離しない"
  // observable = "V2_SESSION_SUMMARY_COLUMNSとSQLite PRAGMA table_infoのsessions/session_messages/session_message_artifacts列名"
  // observation_boundary = "declaration"
  // scope = "database-schema-v2 session message columns"
  // lifecycle = "permanent"
  // impact = "V2 sessionのbookmark保存とV2/V3移行が成立しない"
  // distinction = "production storageのroundtripとは別に、schema contractの列有無を直接確認する"
  // @end-test-value
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
      assert.ok(messageColumns.includes("is_bookmarked"));
      assert.ok(messageColumns.includes("artifact_available"));
      assert.equal(messageColumns.includes("artifact_json"), false);
      assert.deepEqual(columnNames(db, "session_message_artifacts"), ["message_id", "artifact_json"]);
    } finally {
      db.close();
    }
  });
});
