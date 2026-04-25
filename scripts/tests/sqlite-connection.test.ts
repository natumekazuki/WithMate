import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  openAppDatabase,
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
});
