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

test("旧v6はvalidのままschedule schemaをadditiveかつidempotentに適用できる", () => {
  const directory = mkdtempSync(join(tmpdir(), "withmate-schedule-schema-"));
  const dbPath = join(directory, APP_DATABASE_V6_FILENAME);
  const db = new DatabaseSync(dbPath);
  try {
    createLegacyV6(db);
    assert.equal(isValidV6Database(dbPath), true);

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

test("schedule schemaが片側だけまたはindex欠落ならdeep validationで拒否する", () => {
  const directory = mkdtempSync(join(tmpdir(), "withmate-schedule-invalid-"));
  const dbPath = join(directory, APP_DATABASE_V6_FILENAME);
  const db = new DatabaseSync(dbPath);
  try {
    createLegacyV6(db);
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
