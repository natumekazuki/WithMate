import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  CREATE_V4_MATE_GROWTH_EVENTS_TABLE_SQL,
  CREATE_V4_MATE_GROWTH_RUNS_TABLE_SQL,
  CREATE_V4_SCHEMA_SQL,
} from "../../src-electron/storage/database-schema-v4.js";
import { ensureSourceTypeCheckSupportsMateTalk } from "../../src-electron/mate/mate-source-type-migration.js";

const BASE_EVENT_TIME = "2026-05-04T00:00:00.000Z";
const TABLE_NAME = "mate_growth_events";
const RUNS_TABLE_NAME = "mate_growth_runs";
const MIGRATION_TEMP_SUFFIX = "__mate_talk_migration";

const LEGACY_GROWTH_EVENTS_TABLE_SQL = CREATE_V4_MATE_GROWTH_EVENTS_TABLE_SQL.replace(
  /source_type TEXT NOT NULL CHECK \(source_type IN \('session', 'manual', 'system', 'mate_talk'\)\)/i,
  "source_type TEXT NOT NULL CHECK (source_type IN ('session', 'manual', 'system'))",
);

const LEGACY_GROWTH_RUNS_TABLE_SQL = CREATE_V4_MATE_GROWTH_RUNS_TABLE_SQL.replace(
  /source_type TEXT NOT NULL CHECK \(source_type IN \('session', 'manual', 'system', 'mate_talk'\)\)/i,
  "source_type TEXT NOT NULL CHECK (source_type IN ('session', 'manual', 'system'))",
);

type CountRow = {
  count: number;
};

function createLegacyGrowthEventsDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mate_profile (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS mate_profile_revisions (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS mate_project_digests (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS mate_growth_runs (id INTEGER PRIMARY KEY);
    `);
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(LEGACY_GROWTH_EVENTS_TABLE_SQL);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function createSupportedGrowthEventsDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mate_profile (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS mate_profile_revisions (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS mate_project_digests (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS mate_growth_runs (id INTEGER PRIMARY KEY);
    `);
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(CREATE_V4_MATE_GROWTH_EVENTS_TABLE_SQL);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function seedParentRows(db: DatabaseSync): void {
  db.prepare("INSERT OR IGNORE INTO mate_profile (id) VALUES ('current')").run();
}

function seedFullCurrentMateProfile(db: DatabaseSync): void {
  db.prepare(`
    INSERT OR IGNORE INTO mate_profile (
      id,
      state,
      display_name,
      description,
      theme_main,
      theme_sub,
      avatar_file_path,
      avatar_sha256,
      avatar_byte_size,
      profile_generation,
      created_at,
      updated_at
    ) VALUES ('current', 'active', 'current', '', '', '', '', '', 0, 1, ?, ?)
  `).run(BASE_EVENT_TIME, BASE_EVENT_TIME);
}

function ensureMigrationTempTableNotExists(db: DatabaseSync): void {
  const table = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(
    `${TABLE_NAME}${MIGRATION_TEMP_SUFFIX}`,
  ) as { name: string } | undefined;
  assert.equal(table?.name, undefined);
}

function insertGrowthEvent(db: DatabaseSync, input: { id: string; sourceType: string }): void {
  db.prepare(`
    INSERT INTO ${TABLE_NAME} (
      id,
      mate_id,
      source_type,
      growth_source_type,
      kind,
      target_section,
      statement,
      state,
      first_seen_at,
      last_seen_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    "current",
    input.sourceType,
    "assistant_inference",
    "observation",
    "none",
    "migration test event",
    "candidate",
    BASE_EVENT_TIME,
    BASE_EVENT_TIME,
    BASE_EVENT_TIME,
    BASE_EVENT_TIME,
  );
}

function tableSql(db: DatabaseSync, tableName = TABLE_NAME): string {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName) as {
    sql: string | null;
  } | undefined;
  return row?.sql ?? "";
}

function listTablesReferencingMigrationTempTable(db: DatabaseSync, tableName = TABLE_NAME): string[] {
  return (db.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND sql LIKE ? ORDER BY name",
  ).all(`%${tableName}${MIGRATION_TEMP_SUFFIX}%`) as Array<{ name: string }>).map((row) => row.name);
}

function rowCount(db: DatabaseSync, sourceType: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${TABLE_NAME} WHERE source_type = ?`).get(sourceType) as CountRow;
  return row.count;
}

function insertGrowthRun(db: DatabaseSync, sourceType: string): void {
  db.prepare(`
    INSERT INTO ${RUNS_TABLE_NAME} (
      mate_id,
      source_type,
      trigger_reason,
      status,
      started_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run("current", sourceType, "migration test run", "completed", BASE_EVENT_TIME);
}

describe("mate-source-type-migration", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "旧mate growth eventsのsource_type制約をmate_talk対応へ再構築し、既存行とindexを保持する"
  // oracle = { type = "contract", ref = "src-electron/mate/mate-source-type-migration.ts" }
  // fault = "旧制約を残すかtemp table参照を残し、既存growth eventを移行後に扱えなくする"
  // observable = "table check, row counts, temp table absence, and index count"
  // observation_boundary = "public-boundary"
  // scope = "mate growth event source type migration"
  // lifecycle = "permanent"
  // @end-test-value
  it("legacy source_type CHECK テーブルを migration して mate_talk を許可し、temp table と index 再作成を完了する", () => {
    const db = createLegacyGrowthEventsDb();

    try {
      seedParentRows(db);
      insertGrowthEvent(db, { id: "legacy-session", sourceType: "session" });
      const legacyRow = db.prepare(
        `SELECT id, source_type, statement FROM ${TABLE_NAME} WHERE id = ?`,
      ).get("legacy-session");

      assert.equal(tableSql(db).includes("source_type IN ('session', 'manual', 'system')"), true);
      assert.equal(rowCount(db, "mate_talk"), 0);

      ensureSourceTypeCheckSupportsMateTalk(db, TABLE_NAME, CREATE_V4_MATE_GROWTH_EVENTS_TABLE_SQL);

      assert.equal(tableSql(db).includes("source_type IN ('session', 'manual', 'system', 'mate_talk')"), true);
      ensureMigrationTempTableNotExists(db);
      const indexNames = (db.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? ORDER BY name",
      ).all(TABLE_NAME) as Array<{ name: string }>).map((row) => row.name);
      assert.deepEqual(indexNames, [
        "idx_mate_growth_events_fingerprint",
        "idx_mate_growth_events_project",
        "idx_mate_growth_events_seen",
        "idx_mate_growth_events_state_created",
        "idx_mate_growth_events_target_state",
        "sqlite_autoindex_mate_growth_events_1",
      ]);
      assert.deepEqual(db.prepare(
        `SELECT id, source_type, statement FROM ${TABLE_NAME} WHERE id = ?`,
      ).get("legacy-session"), legacyRow);
      insertGrowthEvent(db, { id: "legacy-mate-talk", sourceType: "mate_talk" });
      assert.equal(rowCount(db, "session"), 1);
      assert.equal(rowCount(db, "mate_talk"), 1);
    } finally {
      db.close();
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "既にmate_talk対応済みのgrowth events tableへのsource_type migrationはno-opである"
  // oracle = { type = "contract", ref = "src-electron/mate-source-type-migration.ts" }
  // fault = "既存のmate_talk行を重複移行または削除し、再実行を非冪等にする"
  // observable = "mate_talk row count and table constraint"
  // observation_boundary = "public-boundary"
  // scope = "mate growth event migration idempotency"
  // lifecycle = "permanent"
  // @end-test-value
  it("既に mate_talk 対応済み DB は no-op で、INSERT が成功する", () => {
    const db = createSupportedGrowthEventsDb();

    try {
      seedParentRows(db);
      insertGrowthEvent(db, { id: "already-supported", sourceType: "mate_talk" });
      const beforeCount = rowCount(db, "mate_talk");

      ensureSourceTypeCheckSupportsMateTalk(db, TABLE_NAME, CREATE_V4_MATE_GROWTH_EVENTS_TABLE_SQL);

      assert.equal(rowCount(db, "mate_talk"), beforeCount);
      assert.equal(tableSql(db).includes("source_type IN ('session', 'manual', 'system', 'mate_talk')"), true);
      ensureMigrationTempTableNotExists(db);
    } finally {
      db.close();
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "full schemaでgrowth event source_type migration後のforeign keyはtemp tableを参照しない"
  // oracle = { type = "contract", ref = "src-electron/mate-source-type-migration.ts" }
  // fault = "再構築後の関連tableが一時tableへ接続し、migration完了後のINSERTを壊す"
  // observable = "foreign-key references and mate_talk insert"
  // observation_boundary = "public-boundary"
  // scope = "mate growth event schema migration"
  // lifecycle = "permanent"
  // @end-test-value
  it("full schema でも関連 table の foreign key が migration temp table を参照しない", () => {
    const db = new DatabaseSync(":memory:");

    try {
      const legacySchemaSql = CREATE_V4_SCHEMA_SQL.map((statement) => statement === CREATE_V4_MATE_GROWTH_EVENTS_TABLE_SQL
        ? LEGACY_GROWTH_EVENTS_TABLE_SQL
        : statement);

      db.exec("PRAGMA foreign_keys = ON;");
      for (const statement of legacySchemaSql) {
        db.exec(statement);
      }
      seedFullCurrentMateProfile(db);

      ensureSourceTypeCheckSupportsMateTalk(db, TABLE_NAME, CREATE_V4_MATE_GROWTH_EVENTS_TABLE_SQL);

      assert.deepEqual(listTablesReferencingMigrationTempTable(db), []);
      insertGrowthEvent(db, { id: "full-schema-mate-talk", sourceType: "mate_talk" });
      assert.equal(rowCount(db, "mate_talk"), 1);
    } finally {
      db.close();
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "mate growth runsの旧source_type制約もmate_talk対応へ移行できる"
  // oracle = { type = "contract", ref = "src-electron/mate-source-type-migration.ts" }
  // fault = "eventsだけを移行してrunsのsource_type制約を旧状態に残す"
  // observable = "runs table check, temp table references, and mate_talk row"
  // observation_boundary = "public-boundary"
  // scope = "mate growth run source type migration"
  // lifecycle = "permanent"
  // @end-test-value
  it("mate_growth_runs も legacy source_type CHECK から mate_talk 対応へ migration できる", () => {
    const db = new DatabaseSync(":memory:");

    try {
      const legacySchemaSql = CREATE_V4_SCHEMA_SQL.map((statement) => statement === CREATE_V4_MATE_GROWTH_RUNS_TABLE_SQL
        ? LEGACY_GROWTH_RUNS_TABLE_SQL
        : statement);

      db.exec("PRAGMA foreign_keys = ON;");
      for (const statement of legacySchemaSql) {
        db.exec(statement);
      }
      seedFullCurrentMateProfile(db);

      assert.equal(tableSql(db, RUNS_TABLE_NAME).includes("source_type IN ('session', 'manual', 'system')"), true);

      ensureSourceTypeCheckSupportsMateTalk(db, RUNS_TABLE_NAME, CREATE_V4_MATE_GROWTH_RUNS_TABLE_SQL);

      assert.equal(tableSql(db, RUNS_TABLE_NAME).includes("source_type IN ('session', 'manual', 'system', 'mate_talk')"), true);
      assert.deepEqual(listTablesReferencingMigrationTempTable(db, RUNS_TABLE_NAME), []);
      insertGrowthRun(db, "mate_talk");
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${RUNS_TABLE_NAME} WHERE source_type = 'mate_talk'`).get() as CountRow;
      assert.equal(row.count, 1);
    } finally {
      db.close();
    }
  });
});
