import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  APP_DATABASE_V4_FILENAME,
  APP_DATABASE_V4_SCHEMA_VERSION,
  CREATE_V4_SCHEMA_SQL,
  V4_SCHEMA_STATUS,
  isValidV4Database,
  REQUIRED_V4_TABLES,
} from "../../src-electron/database-schema-v4.js";

type TableInfoRow = {
  name: string;
  notnull: number;
};

type TableSqlRow = {
  sql: string | null;
};

type ForeignKeyRow = {
  table: string;
  from: string;
  to: string;
  on_delete: string;
  on_update: string;
};

function createV4Schema(dbPath = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  for (const statement of CREATE_V4_SCHEMA_SQL) {
    db.exec(statement);
  }
  return db;
}

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as TableInfoRow[]).map(
    (row) => row.name,
  ).filter((name) => !name.startsWith("sqlite_"));
}

function columnInfo(db: DatabaseSync, tableName: string): TableInfoRow[] {
  return db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[];
}

function columnNames(db: DatabaseSync, tableName: string): string[] {
  return columnInfo(db, tableName).map((row) => row.name);
}

function tableSql(db: DatabaseSync, tableName: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName) as
    | TableSqlRow
    | undefined;
  return row?.sql ?? "";
}

function findForeignKey(db: DatabaseSync, tableName: string, fromColumn: string): ForeignKeyRow | undefined {
  const keys = db.prepare(`PRAGMA foreign_key_list(${tableName})`).all() as ForeignKeyRow[];
  return keys.find((row) => row.from === fromColumn);
}

describe("database-schema-v4", () => {
  it("withmate-v4.db 用の schema constants と required tables を固定する", () => {
    assert.equal(APP_DATABASE_V4_FILENAME, "withmate-v4.db");
    assert.equal(APP_DATABASE_V4_SCHEMA_VERSION, 4);
    assert.equal(V4_SCHEMA_STATUS, "ready-for-implementation");

    const db = createV4Schema();
    try {
      const names = tableNames(db).sort();
      assert.deepEqual(names, [...REQUIRED_V4_TABLES].sort());
      assert.equal(REQUIRED_V4_TABLES.every((tableName) => names.includes(tableName)), true);
    } finally {
      db.close();
    }
  });

  it("isValidV4Database は filename と required tables の両方を検証する", () => {
    const dirPath = mkdtempSync(join(tmpdir(), "withmate-v4-schema-"));
    try {
      const validDbPath = join(dirPath, APP_DATABASE_V4_FILENAME);
      const validDb = createV4Schema(validDbPath);
      validDb.close();

      const wrongNameDbPath = join(dirPath, "withmate-v3.db");
      const wrongNameDb = createV4Schema(wrongNameDbPath);
      wrongNameDb.close();

      const emptyDirPath = join(dirPath, "empty");
      const emptyV4DbPath = join(emptyDirPath, APP_DATABASE_V4_FILENAME);
      rmSync(emptyDirPath, { recursive: true, force: true });
      mkdirSync(emptyDirPath);
      closeSync(openSync(emptyV4DbPath, "w"));

      assert.equal(isValidV4Database(validDbPath), true);
      assert.equal(isValidV4Database(wrongNameDbPath), false);
      assert.equal(isValidV4Database(emptyV4DbPath), false);
    } finally {
      rmSync(dirPath, { recursive: true, force: true });
    }
  });

  it("主要 table/column が v4 仕様を満たし、mate_profile と growth 主要制約が揃う", () => {
    const db = createV4Schema();
    try {
      const mateProfileColumns = columnNames(db, "mate_profile");
      const growthSettingsColumns = columnNames(db, "mate_growth_settings");
      const profileRevisionsColumns = columnNames(db, "mate_profile_revisions");
      const tagCatalogColumns = columnNames(db, "mate_memory_tag_catalog");
      const providerSyncRunColumns = columnNames(db, "provider_instruction_sync_runs");

      assert.equal(mateProfileColumns.includes("id"), true);
      assert.equal(mateProfileColumns.includes("state"), true);
      assert.equal(mateProfileColumns.includes("display_name"), true);
      assert.equal(mateProfileColumns.includes("active_revision_id"), true);
      assert.equal(tableSql(db, "mate_profile").includes("CHECK (id = 'current')"), true);

      assert.equal(growthSettingsColumns.includes("memory_candidate_mode"), true);
      assert.equal(growthSettingsColumns.includes("apply_interval_minutes"), true);
      assert.equal(tableSql(db, "mate_growth_settings").includes("memory_candidate_mode TEXT NOT NULL DEFAULT 'every_turn'"), true);
      assert.equal(
        tableSql(db, "mate_growth_settings").includes("apply_interval_minutes INTEGER NOT NULL DEFAULT 60"),
        true,
      );

      assert.equal(profileRevisionsColumns.includes("status"), true);
      assert.equal(profileRevisionsColumns.includes("summary"), true);
      assert.equal(
        tableSql(db, "mate_profile_revisions").includes("'staging'") &&
          tableSql(db, "mate_profile_revisions").includes("'committing_files'") &&
          tableSql(db, "mate_profile_revisions").includes("'ready'") &&
          tableSql(db, "mate_profile_revisions").includes("'failed'"),
        true,
      );

      assert.equal(tagCatalogColumns.includes("state"), true);
      assert.equal(tableSql(db, "mate_memory_tag_catalog").includes("state TEXT NOT NULL DEFAULT 'active'"), true);
      assert.equal(tableSql(db, "mate_memory_tag_catalog").includes("'active', 'disabled'"), true);

      assert.equal(providerSyncRunColumns.includes("mate_revision_id"), true);
      assert.equal(providerSyncRunColumns.includes("projection_sha256"), true);
      assert.equal(providerSyncRunColumns.includes("status"), true);
      const mateRevisionColumn = columnInfo(db, "provider_instruction_sync_runs").find((column) => {
        return column.name === "mate_revision_id";
      });
      assert.equal(mateRevisionColumn?.notnull, 0);
    } finally {
      db.close();
    }
  });

  it("reset/履歴参照で重要な外部キー制約を検証する", () => {
    const db = createV4Schema();
    try {
      const providerRunRevFk = findForeignKey(db, "provider_instruction_sync_runs", "mate_revision_id");
      assert.equal(providerRunRevFk?.table, "mate_profile_revisions");
      assert.equal(providerRunRevFk?.to, "id");
      assert.equal(providerRunRevFk?.on_delete.toUpperCase(), "SET NULL");

      const profileSectionsFk = findForeignKey(db, "mate_profile_sections", "mate_id");
      assert.equal(profileSectionsFk?.table, "mate_profile");
      assert.equal(profileSectionsFk?.on_delete.toUpperCase(), "CASCADE");

      const profileItemFk = findForeignKey(db, "mate_profile_items", "mate_id");
      assert.equal(profileItemFk?.table, "mate_profile");
      assert.equal(profileItemFk?.on_delete.toUpperCase(), "CASCADE");

      const syncRunTargetFk = findForeignKey(db, "provider_instruction_sync_runs", "provider_id");
      assert.equal(syncRunTargetFk?.table, "provider_instruction_targets");
      assert.equal(syncRunTargetFk?.on_delete.toUpperCase(), "CASCADE");
    } finally {
      db.close();
    }
  });
});
