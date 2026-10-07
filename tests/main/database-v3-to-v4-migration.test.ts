import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src-shared/settings/codex-sandbox-mode.js";
import { DEFAULT_CATALOG_REVISION, DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT } from "../../src-shared/settings/model-catalog.js";
import { CREATE_V3_SCHEMA_SQL, V3_TEXT_PREVIEW_MAX_LENGTH } from "../../src-electron/storage/database-schema-v3.js";
import { isValidV4Database } from "../../src-electron/storage/database-schema-v4.js";
import { SessionStorage } from "../../src-electron/session/session-storage.js";
import { SessionStorageV3 } from "../../src-electron/session/session-storage-v3.js";
import {
  OBSOLETE_V4_IMPORT_TARGET_TABLES,
  createMigrationDryRunReport,
  createMigrationWriteReport,
} from "../../src-electron/storage/migrations/migrate-database-v3-to-v4.js";

type Fixture = {
  dirPath: string;
  dbPath: string;
  blobRootPath: string;
  cleanup(): void;
};

function createV3FixtureDatabase(): Fixture {
  const dirPath = mkdtempSync(join(tmpdir(), "withmate-v3-to-v4-"));
  const dbPath = join(dirPath, "withmate-v3.db");
  const blobRootPath = join(dirPath, "blobs", "v3");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    for (const statement of CREATE_V3_SCHEMA_SQL) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }

  return {
    dirPath,
    dbPath,
    blobRootPath,
    cleanup: () => rmSync(dirPath, { recursive: true, force: true }),
  };
}

function readRequiredRow<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T {
  const row = db.prepare(sql).get(...params) as T | undefined;
  assert.ok(row);
  return row;
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  return db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName) !== undefined;
}

function readDatabaseSnapshot(dbPath: string): {
  bytes: Buffer;
  journalMode: string;
  schema: Array<Record<string, unknown>>;
  rows: Record<string, Array<Record<string, unknown>>>;
} {
  const bytes = readFileSync(dbPath);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const schema = db.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name",
    ).all() as Array<Record<string, unknown>>;
    const tableNames = (db.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name);
    const rows = Object.fromEntries(tableNames.map((tableName) => {
      const columns = (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((row) => row.name);
      return [tableName, db.prepare(`SELECT ${columns.join(", ")} FROM ${tableName} ORDER BY rowid`).all() as Array<Record<string, unknown>>];
    }));
    const journalMode = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    return { bytes, journalMode, schema, rows };
  } finally {
    db.close();
  }
}

function prepareLegacyV3Source(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec("ALTER TABLE sessions DROP COLUMN character_runtime_snapshot_json;");
    db.exec("ALTER TABLE session_messages DROP COLUMN is_bookmarked;");
  } finally {
    db.close();
  }
}

async function seedV3Fixture(fixture: Fixture): Promise<void> {
  const sessionStorage = new SessionStorageV3(fixture.dbPath, fixture.blobRootPath);
  const session = buildNewSession({
    taskTitle: "V3 import fixture",
    workspaceLabel: "workspace",
    workspacePath: "/workspace",
    branch: "main",
    characterId: "char-v3",
    character: "V3",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE,
  });
  const sentinel = "SENTINEL_V3_TO_V4";

  try {
    await sessionStorage.upsertSession({
      ...session,
      id: "session-v3-to-v4",
      threadId: "thread-v3-to-v4",
      messages: [
        { role: "user", text: `${"u".repeat(V3_TEXT_PREVIEW_MAX_LENGTH + 20)}${sentinel}:user` },
        { role: "assistant", text: `${sentinel}:assistant` },
      ],
    });

  } finally {
    sessionStorage.close();
  }

  const db = new DatabaseSync(fixture.dbPath);
  try {
    db.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)").run(
      "auto_collapse_action_dock_on_send",
      "true",
      "2026-05-14T00:00:00.000Z",
    );
    db.prepare("INSERT INTO model_catalog_revisions (revision, source, imported_at, is_active) VALUES (?, ?, ?, ?)").run(
      77,
      "fixture",
      "2026-05-14T00:00:00.000Z",
      1,
    );
    db.prepare(
      "INSERT INTO model_catalog_providers (revision, provider_id, label, default_model_id, default_reasoning_effort, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(77, "codex", "Codex", "gpt-5.4-mini", "medium", 1);
    db.prepare(
      "INSERT INTO model_catalog_models (revision, provider_id, model_id, label, reasoning_efforts_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(77, "codex", "gpt-5.4-mini", "GPT 5.4 mini", JSON.stringify(["medium"]), 1);
  } finally {
    db.close();
  }
}

describe("migrate-database-v3-to-v4", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "V3からV4へのdry-runは全import対象の入力件数と予定件数を報告する"
  // oracle = { type = "contract", ref = "src-electron/storage/migrations/migrate-database-v3-to-v4.ts" }
  // fault = "移行対象件数またはblob入力を誤って報告し、書き込み前の確認を誤らせる"
  // observable = "dry-run migrationの全countsとblobRootPath"
  // observation_boundary = "public-boundary"
  // scope = "database-v3-to-v4 dry-run"
  // lifecycle = "permanent"
  // @end-test-value
  it("dry-run で v3 から v4 への import 対象件数を返す", async () => {
    const fixture = createV3FixtureDatabase();
    try {
      await seedV3Fixture(fixture);
      const report = createMigrationDryRunReport(fixture.dbPath, { blobRootPath: fixture.blobRootPath });
      assert.equal(report.mode, "dry-run");
      assert.deepEqual(report.plannedV4Counts, report.v3Counts);
      assert.equal(report.input.blobRootPath, fixture.blobRootPath);
    } finally {
      fixture.cleanup();
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "V3からV4へのwriteは通常Session/設定/model catalogを移行し、旧import対象を残さない"
  // oracle = { type = "contract", ref = "src-electron/storage/migrations/migrate-database-v3-to-v4.ts" }
  // fault = "通常データを欠落させるか、廃止済みのimport targetをV4へ持ち込む"
  // observable = "migrated counts, both imported session messages, and target schema"
  // observation_boundary = "public-boundary"
  // scope = "database-v3-to-v4 write"
  // lifecycle = "permanent"
  // @end-test-value
  it("write で v4 DB を作成し、session / settings / model catalog を import する", async () => {
    const fixture = createV3FixtureDatabase();
    const targetDirPath = mkdtempSync(join(tmpdir(), "withmate-v3-to-v4-target-"));
    const targetDbPath = join(targetDirPath, "withmate-v4.db");
    const targetBlobRootPath = join(targetDirPath, "blobs", "v3");
    try {
      await seedV3Fixture(fixture);
      const report = await createMigrationWriteReport({
        sourceDatabaseFile: fixture.dbPath,
        targetDatabaseFile: targetDbPath,
        blobRootPath: fixture.blobRootPath,
      });

      assert.equal(report.mode, "write");
      assert.equal(isValidV4Database(targetDbPath), true);
      assert.equal(
        readdirSync(targetDirPath).some((entry) => entry.includes("withmate-v4.db.migration-")),
        false,
      );

      const sessionStorage = new SessionStorage(targetDbPath);
      const db = new DatabaseSync(targetDbPath);
      try {
        const importedSession = await sessionStorage.getSession("session-v3-to-v4");
        assert.ok(importedSession);
        assert.equal(importedSession.accessMode, "legacy_readonly");
        assert.equal(importedSession.sourceSchemaVersion, 3);
        assert.equal(importedSession.characterIconPath, "");
        assert.match(importedSession.messages[0]?.text ?? "", /SENTINEL_V3_TO_V4:user/);
        assert.equal(importedSession.messages[1]?.role, "assistant");
        assert.equal(importedSession.messages[1]?.text, "SENTINEL_V3_TO_V4:assistant");
        assert.equal(existsSync(targetBlobRootPath), false);
        const setting = readRequiredRow<{ setting_value: string }>(
          db,
          "SELECT setting_value FROM app_settings WHERE setting_key = ?",
          "auto_collapse_action_dock_on_send",
        );
        assert.equal(setting.setting_value, "true");
        const catalog = readRequiredRow<{ model_id: string }>(
          db,
          "SELECT model_id FROM model_catalog_models WHERE revision = ? AND provider_id = ?",
          77,
          "codex",
        );
        assert.equal(catalog.model_id, "gpt-5.4-mini");
        for (const tableName of OBSOLETE_V4_IMPORT_TARGET_TABLES) {
          assert.equal(tableExists(db, tableName), false, `${tableName} は V4 import target に残さない`);
        }
      } finally {
        db.close();
        sessionStorage.close();
      }
    } finally {
      fixture.cleanup();
      rmSync(targetDirPath, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "旧V3任意列が不足していてもV3からV4へのwriteはsource DBを変更しない"
  // oracle = { type = "contract", ref = "docs/design/database-schema.md#起動時の移行とデータ保護" }
  // fault = "V3 sourceの不足列を補うためALTER TABLEやWAL設定を実行し、sourceのschema・rows・bytesを変更する"
  // observable = "migration前後のsource DB raw bytes、schema、rows、journal mode"
  // observation_boundary = "public-boundary"
  // scope = "database-v3-to-v4 source preservation"
  // lifecycle = "permanent"
  // risk_tags = ["irreversible-data-loss"]
  // @end-test-value
  it("旧V3任意列が不足していても source DB を変更しない", async () => {
    const fixture = createV3FixtureDatabase();
    const targetDirPath = mkdtempSync(join(tmpdir(), "withmate-v3-to-v4-read-only-source-"));
    const targetDbPath = join(targetDirPath, "withmate-v4.db");
    try {
      await seedV3Fixture(fixture);
      prepareLegacyV3Source(fixture.dbPath);
      const sourceBefore = readDatabaseSnapshot(fixture.dbPath);
      assert.equal(sourceBefore.journalMode, "delete");

      const report = await createMigrationWriteReport({
        sourceDatabaseFile: fixture.dbPath,
        targetDatabaseFile: targetDbPath,
        blobRootPath: fixture.blobRootPath,
      });

      assert.equal(report.mode, "write");
      assert.equal(report.migratedV4Counts.sessions, 1);
      const sourceAfter = readDatabaseSnapshot(fixture.dbPath);
      assert.deepEqual(sourceAfter.bytes, sourceBefore.bytes);
      assert.deepEqual(sourceAfter.schema, sourceBefore.schema);
      assert.deepEqual(sourceAfter.rows, sourceBefore.rows);
      assert.equal(sourceAfter.journalMode, sourceBefore.journalMode);
    } finally {
      fixture.cleanup();
      rmSync(targetDirPath, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "V3からV4へのwrite失敗時は中途半端なtarget DBとmigration一時ファイルを残さない"
  // oracle = { type = "contract", ref = "src-electron/storage/migrations/migrate-database-v3-to-v4.ts" }
  // fault = "失敗した移行の部分生成物を次回処理や利用者のDBとして残す"
  // observable = "target database and migration temporary file absence"
  // observation_boundary = "public-boundary"
  // scope = "database-v3-to-v4 failure cleanup"
  // lifecycle = "permanent"
  // @end-test-value
  it("write 失敗時は中途半端な v4 DB を残さない", async () => {
    const fixture = createV3FixtureDatabase();
    const targetDbPath = join(fixture.dirPath, "withmate-v4.db");
    try {
      await seedV3Fixture(fixture);
      rmSync(fixture.blobRootPath, { recursive: true, force: true });
      await assert.rejects(
        () => createMigrationWriteReport({
          sourceDatabaseFile: fixture.dbPath,
          targetDatabaseFile: targetDbPath,
          blobRootPath: fixture.blobRootPath,
        }),
        /blob|ENOENT|no such file/i,
      );
      assert.equal(existsSync(targetDbPath), false);
      assert.equal(existsSync(`${targetDbPath}-wal`), false);
      assert.equal(existsSync(`${targetDbPath}-shm`), false);
      assert.equal(
        readdirSync(fixture.dirPath).some((entry) => entry.includes("withmate-v4.db.migration-")),
        false,
      );
    } finally {
      fixture.cleanup();
    }
  });
});
