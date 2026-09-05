import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  APP_DATABASE_V6_FILENAME,
  CREATE_V6_SCHEMA_SQL,
  CREATE_V6_SESSION_SCHEDULES_TABLE_SQL,
  CREATE_V6_SESSION_SCHEDULE_FIRES_TABLE_SQL,
  ensureV6Schema,
  isValidV6Database,
} from "../../src-electron/database-schema-v6.js";

function createLegacyV6(db: DatabaseSync): void {
  for (const statement of CREATE_V6_SCHEMA_SQL) {
    if (
      statement !== CREATE_V6_SESSION_SCHEDULES_TABLE_SQL &&
      statement !== CREATE_V6_SESSION_SCHEDULE_FIRES_TABLE_SQL
    ) {
      db.exec(statement);
    }
  }
}

// @test-value v1
// kind = "compatibility"
// claim = "現行必須tableを欠く旧V6はmigration前にinvalidであり、additive migrationを再実行するとdataを破壊せずvalidへ収束する"
// oracle = { type = "contract", ref = "MIGRATION-09" }
// failure_mode = "旧V6を現行schemaと誤認するか、migration再実行で失敗して起動不能になる"
// scope = "V6 schema migration and deep validation"
// lifecycle = "permanent"
// @end-test-value
test("旧v6へscheduleを含む現行schemaをadditiveかつidempotentに適用できる", () => {
  const directory = mkdtempSync(join(tmpdir(), "withmate-schedule-schema-"));
  const dbPath = join(directory, APP_DATABASE_V6_FILENAME);
  const db = new DatabaseSync(dbPath);
  try {
    createLegacyV6(db);
    assert.equal(isValidV6Database(dbPath), false);

    ensureV6Schema(db);
    ensureV6Schema(db);
    for (const table of ["session_schedules_v6", "session_schedule_fires_v6"]) {
      assert.equal(
        (
          db
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type='table' AND name=?",
            )
            .get(table) as { name?: string } | undefined
        )?.name,
        table,
      );
    }
    assert.equal(isValidV6Database(dbPath), true);
    assert.throws(() =>
      db
        .prepare(
          "INSERT INTO session_schedules_v6 (id,session_id,revision,name,trigger_type,time_zone,cron_expression,turn_json,state,created_at,updated_at) VALUES ('x','missing',1,'x','cron','UTC','* * * * *','{}','active','now','now')",
        )
        .run(),
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schedule schemaの途中失敗はsavepointで片側tableを残さない", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createLegacyV6(db);
    db.exec("CREATE VIEW session_schedule_fires_v6 AS SELECT 1 AS id");
    assert.throws(() => ensureV6Schema(db));
    assert.equal(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name='session_schedules_v6'",
        )
        .get(),
      undefined,
    );
    assert.equal(
      (
        db
          .prepare(
            "SELECT type FROM sqlite_schema WHERE name='session_schedule_fires_v6'",
          )
          .get() as { type: string }
      ).type,
      "view",
    );
  } finally {
    db.close();
  }
});

// @test-value v1
// kind = "invariant"
// claim = "schedule table片側または必須indexを欠く部分schemaをdeep validationがvalidとして受理しない"
// oracle = { type = "schema", ref = "CREATE_V6_SESSION_SCHEDULES_TABLE_SQL / CREATE_V6_SESSION_SCHEDULE_FIRES_TABLE_SQL" }
// failure_mode = "部分適用databaseをvalidと判定し、後続schedule read/writeが欠落tableまたはindex前提で動作する"
// scope = "V6 schema deep validation"
// lifecycle = "permanent"
// distinction = "migration成功ではなく、片側table欠落と必須index欠落のnegative validationを観測する"
// @end-test-value
test("schedule schemaが片側だけまたはindex欠落ならdeep validationで拒否する", () => {
  const directory = mkdtempSync(join(tmpdir(), "withmate-schedule-invalid-"));
  const dbPath = join(directory, APP_DATABASE_V6_FILENAME);
  const db = new DatabaseSync(dbPath);
  try {
    createLegacyV6(db);
    ensureV6Schema(db);
    db.exec("DROP TABLE session_schedule_fires_v6");
    db.exec("DROP TABLE session_schedules_v6");
    db.exec(CREATE_V6_SESSION_SCHEDULES_TABLE_SQL);
    assert.equal(isValidV6Database(dbPath), false);

    db.exec(CREATE_V6_SESSION_SCHEDULE_FIRES_TABLE_SQL);
    assert.equal(isValidV6Database(dbPath), true);
    db.exec("DROP INDEX idx_v6_session_schedule_fires_logical");
    assert.equal(isValidV6Database(dbPath), false);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
