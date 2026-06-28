import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  createMigrationDryRunReport,
  createMigrationWriteReport,
} from "../migrate-database-v4-to-v6.js";
import { CREATE_APP_SETTINGS_TABLE_SQL, CREATE_MODEL_CATALOG_TABLES_SQL } from "../../src-electron/database-schema-v1.js";
import { CREATE_V4_SCHEMA_SQL } from "../../src-electron/database-schema-v4.js";
import {
  APP_DATABASE_V6_FILENAME,
  CREATE_V6_SCHEMA_SQL,
  isValidV6Database,
} from "../../src-electron/database-schema-v6.js";

function createFixture(): { dir: string; v4Path: string; v6Path: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "withmate-v4-to-v6-"));
  return {
    dir,
    v4Path: join(dir, "withmate-v4.db"),
    v6Path: join(dir, APP_DATABASE_V6_FILENAME),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function createV4FixtureDatabase(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    for (const statement of CREATE_V4_SCHEMA_SQL) {
      db.exec(statement);
    }
    db.exec(CREATE_APP_SETTINGS_TABLE_SQL);
    db.exec(CREATE_MODEL_CATALOG_TABLES_SQL);
    db.exec(`
      CREATE TABLE IF NOT EXISTS characters (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        icon_file_path TEXT NOT NULL DEFAULT '',
        theme_main TEXT NOT NULL DEFAULT '#6f8cff',
        theme_sub TEXT NOT NULL DEFAULT '#6fb8c7',
        state TEXT NOT NULL DEFAULT 'active',
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
    `);
    db.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, task_title TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL);");
    db.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)").run(
      "coding_provider_settings_json",
      JSON.stringify({ codex: { enabled: true, apiKey: "secret", skillRootPath: "", skillRelativePath: "", instructionRelativePath: "" } }),
      "2026-06-28T00:00:00.000Z",
    );
    db.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)").run(
      "memory_extraction_provider_settings_json",
      "{}",
      "2026-06-28T00:00:00.000Z",
    );
    db.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)").run(
      "auto_collapse_action_dock_on_send",
      "true",
      "2026-06-28T00:00:00.000Z",
    );
    db.prepare("INSERT INTO model_catalog_revisions (revision, source, imported_at, is_active) VALUES (?, ?, ?, ?)").run(
      12,
      "fixture",
      "2026-06-28T00:00:00.000Z",
      1,
    );
    db.prepare(
      "INSERT INTO model_catalog_providers (revision, provider_id, label, default_model_id, default_reasoning_effort, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(12, "codex", "Codex", "gpt-5.4", "medium", 1);
    db.prepare(
      "INSERT INTO model_catalog_models (revision, provider_id, model_id, label, reasoning_efforts_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(12, "codex", "gpt-5.4", "GPT 5.4", JSON.stringify(["medium"]), 1);
    db.prepare(
      "INSERT INTO characters (id, name, description, icon_file_path, theme_main, theme_sub, state, is_default, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "char-a",
      "Char A",
      "A character",
      "characters/char-a/icon.png",
      "#112233",
      "#445566",
      "active",
      1,
      "2026-06-28T00:00:00.000Z",
      "2026-06-28T00:00:00.000Z",
      null,
    );
    db.prepare("INSERT INTO sessions (id, task_title, status, updated_at) VALUES (?, ?, ?, ?)").run(
      "session-a",
      "捨てる session",
      "completed",
      "2026-06-28T00:00:00.000Z",
    );
    db.prepare("INSERT INTO mate_profile (id, state, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      "current",
      "active",
      "legacy mate",
      "2026-06-28T00:00:00.000Z",
      "2026-06-28T00:00:00.000Z",
    );
  } finally {
    db.close();
  }
}

function readCount(dbPath: string, tableName: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

function tableExists(dbPath: string, tableName: string): boolean {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName) !== undefined;
  } finally {
    db.close();
  }
}

describe("migrate-database-v4-to-v6", () => {
  it("dry-run で V6 移行対象と skip 対象を分けて返す", () => {
    const fixture = createFixture();
    try {
      createV4FixtureDatabase(fixture.v4Path);

      const report = createMigrationDryRunReport(fixture.v4Path);

      assert.equal(report.plannedV6Counts.appSettings, 2);
      assert.equal(report.plannedV6Counts.modelCatalogModels, 1);
      assert.equal(report.plannedV6Counts.characters, 1);
      assert.equal(report.v4Counts.skippedAppSettings, 1);
      assert.equal(report.v4Counts.skippedSessions, 1);
      assert.equal(report.v4Counts.skippedMateRows, 1);
      assert.equal(report.plannedV6Counts.skippedSessions, 0);
    } finally {
      fixture.cleanup();
    }
  });

  it("write で settings/catalog/characters だけを V6 DB へ移行する", async () => {
    const fixture = createFixture();
    try {
      createV4FixtureDatabase(fixture.v4Path);

      const report = await createMigrationWriteReport({
        sourceDatabaseFile: fixture.v4Path,
        targetDatabaseFile: fixture.v6Path,
      });

      assert.equal(report.migratedV6Counts.appSettings, 2);
      assert.equal(report.migratedV6Counts.modelCatalogRevisions, 1);
      assert.equal(report.migratedV6Counts.characters, 1);
      assert.equal(isValidV6Database(fixture.v6Path), true);
      assert.equal(readCount(fixture.v6Path, "app_settings"), 2);
      assert.equal(readCount(fixture.v6Path, "model_catalog_models"), 1);
      assert.equal(readCount(fixture.v6Path, "characters"), 1);
      assert.equal(readCount(fixture.v6Path, "sessions_v6"), 0);
      assert.equal(tableExists(fixture.v6Path, "sessions"), false);
      assert.equal(tableExists(fixture.v6Path, "mate_profile"), false);
      assert.equal(tableExists(fixture.v6Path, "project_memory_entries"), false);
    } finally {
      fixture.cleanup();
    }
  });

  it("既存の empty V6 bootstrap DB にも release data を投入できる", async () => {
    const fixture = createFixture();
    try {
      createV4FixtureDatabase(fixture.v4Path);
      const db = new DatabaseSync(fixture.v6Path);
      try {
        for (const statement of CREATE_V6_SCHEMA_SQL) {
          db.exec(statement);
        }
      } finally {
        db.close();
      }

      assert.equal(existsSync(fixture.v6Path), true);
      await createMigrationWriteReport({
        sourceDatabaseFile: fixture.v4Path,
        targetDatabaseFile: fixture.v6Path,
      });

      assert.equal(readCount(fixture.v6Path, "app_settings"), 2);
      assert.equal(readCount(fixture.v6Path, "characters"), 1);
    } finally {
      fixture.cleanup();
    }
  });
});
