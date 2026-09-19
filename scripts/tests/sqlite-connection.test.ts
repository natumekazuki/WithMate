import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  openAppDatabase,
  markMainThreadAsNonStorageOwner,
  openAppDatabaseReadOnly,
  SQLITE_MAINTENANCE_BUSY_TIMEOUT_MS,
  SQLITE_JOURNAL_SIZE_LIMIT_BYTES,
  SQLITE_WAL_AUTOCHECKPOINT_PAGES,
  truncateAppDatabaseWal,
  truncateAppDatabaseWalIfLargerThan,
} from "../../src-electron/sqlite-connection.js";

function firstPragmaValue(row: unknown): unknown {
  assert.ok(row && typeof row === "object");
  return Object.values(row)[0];
}

describe("sqlite-connection", () => {
  it("WithMate の SQLite 接続設定を共通適用する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-sqlite-connection-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const db = openAppDatabase(dbPath);
      try {
        const journalMode = firstPragmaValue(db.prepare("PRAGMA journal_mode").get());
        const walAutocheckpoint = firstPragmaValue(db.prepare("PRAGMA wal_autocheckpoint").get());
        const journalSizeLimit = firstPragmaValue(db.prepare("PRAGMA journal_size_limit").get());
        const foreignKeys = firstPragmaValue(db.prepare("PRAGMA foreign_keys").get());

        assert.equal(journalMode, "wal");
        assert.equal(walAutocheckpoint, SQLITE_WAL_AUTOCHECKPOINT_PAGES);
        assert.equal(journalSizeLimit, SQLITE_JOURNAL_SIZE_LIMIT_BYTES);
        assert.equal(foreignKeys, 1);
      } finally {
        db.close();
      }
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("DB が存在しない場合は WAL truncate 用の空 DB を作らない", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-sqlite-connection-"));
    const dbPath = path.join(tempDirectory, "missing.db");

    try {
      truncateAppDatabaseWal(dbPath);
      assert.equal(existsSync(dbPath), false);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("WAL truncate 前に共通接続設定を適用し、WAL mode へ戻す", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-sqlite-connection-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const initialDb = openAppDatabase(dbPath);
      try {
        initialDb.exec("PRAGMA journal_mode = DELETE;");
      } finally {
        initialDb.close();
      }

      truncateAppDatabaseWal(dbPath);

      const reopened = openAppDatabase(dbPath);
      try {
        const journalMode = firstPragmaValue(reopened.prepare("PRAGMA journal_mode").get());
        assert.equal(journalMode, "wal");
      } finally {
        reopened.close();
      }
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("WAL が上限以下の場合は truncate checkpoint を実行しない", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-sqlite-connection-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    const walPath = `${dbPath}-wal`;

    try {
      const db = openAppDatabase(dbPath);
      try {
        db.exec("CREATE TABLE IF NOT EXISTS test_items (id TEXT PRIMARY KEY);");
      } finally {
        db.close();
      }

      await writeFile(walPath, "small");
      assert.equal(truncateAppDatabaseWalIfLargerThan(dbPath, 1024), false);
      assert.equal(existsSync(walPath), true);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "WALの上限超過時にtruncate checkpointを実行する"
  // oracle = { type = "contract", ref = "src-electron/sqlite-connection.ts#truncateAppDatabaseWalIfLargerThan" }
  // fault = "WAL maintenanceが上限判定を無視してtruncate checkpointを実行しない"
  // observable = "truncate結果とWAL file size"
  // observation_boundary = "public-boundary"
  // scope = "sqlite-wal-maintenance"
  // lifecycle = "permanent"
  // @end-test-value
  it("WAL が上限を超える場合は truncate checkpoint を実行する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-sqlite-connection-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    const walPath = `${dbPath}-wal`;

    try {
      const db = openAppDatabase(dbPath);
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS test_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            value TEXT NOT NULL
          );
          INSERT INTO test_items (value) VALUES ('before truncate');
        `);
        assert.equal(existsSync(walPath), true);
        const walSizeBefore = statSync(walPath).size;

        const truncated = truncateAppDatabaseWalIfLargerThan(dbPath, 0, {
          busyTimeoutMs: SQLITE_MAINTENANCE_BUSY_TIMEOUT_MS,
        });

        assert.equal(truncated, true);
        assert.ok(statSync(walPath).size < walSizeBefore);
      } finally {
        db.close();
      }
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Main threadをstorage ownerとして明示的に無効化した後は同期SQLite接続を開始できない"
  // oracle = { type = "contract", ref = "src-electron/sqlite-connection.ts#markMainThreadAsNonStorageOwner" }
  // fault = "Main processが同期SQLite接続を開き、storage workerと競合する"
  // observable = "openAppDatabase/openAppDatabaseReadOnly/truncateAppDatabaseWalのthrow結果"
  // observation_boundary = "public-boundary"
  // scope = "sqlite-storage-owner-boundary"
  // lifecycle = "permanent"
  // @end-test-value
  it("Main threadをstorage owner外としてマークすると同期接続を拒否する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-sqlite-connection-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      markMainThreadAsNonStorageOwner();
      assert.throws(() => openAppDatabase(dbPath), /storage worker/);
      assert.throws(() => openAppDatabaseReadOnly(dbPath), /storage worker/);
      assert.throws(() => truncateAppDatabaseWal(dbPath), /storage worker/);
      assert.throws(() => truncateAppDatabaseWalIfLargerThan(dbPath), /storage worker/);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
