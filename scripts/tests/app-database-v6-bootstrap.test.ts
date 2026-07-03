import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import {
  APP_DATABASE_V6_FILENAME,
  APP_DATABASE_V6_SCHEMA_VERSION,
  CREATE_V6_AUDIT_EVENTS_TABLE_SQL,
  CREATE_V6_AUXILIARY_SESSIONS_TABLE_SQL,
  CREATE_V6_SCHEMA_SQL,
  isValidV6Database,
  readV6DatabaseUserVersion,
} from "../../src-electron/database-schema-v6.js";
import { APP_DATABASE_V4_FILENAME } from "../../src-electron/database-schema-v4.js";

describe("createOrVerifyV6FreshDatabase", () => {
  it("userData 配下に fresh V6 DB を作成し、V4 active path には触れない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-v6-bootstrap-"));
    try {
      const result = await createOrVerifyV6FreshDatabase(userDataPath);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);

      assert.deepEqual(result, { dbPath: v6Path, created: true });
      assert.equal(isValidV6Database(v6Path), true);
      assert.equal(readV6DatabaseUserVersion(v6Path), APP_DATABASE_V6_SCHEMA_VERSION);
      assert.equal(existsSync(v4Path), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("既存の valid V6 DB は再作成せず検証だけ行う", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-v6-bootstrap-"));
    try {
      const created = await createOrVerifyV6FreshDatabase(userDataPath);
      const verified = await createOrVerifyV6FreshDatabase(userDataPath);

      assert.equal(created.created, true);
      assert.deepEqual(verified, { dbPath: created.dbPath, created: false });
      assert.equal(isValidV6Database(created.dbPath), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("既存の旧 V6 foundation DB は additive ensure 後に valid として扱う", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-v6-bootstrap-"));
    try {
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      const db = new DatabaseSync(v6Path);
      try {
        db.exec("PRAGMA foreign_keys = ON;");
        for (const statement of CREATE_V6_SCHEMA_SQL) {
          if (statement === CREATE_V6_AUXILIARY_SESSIONS_TABLE_SQL) {
            db.exec(`
              CREATE TABLE IF NOT EXISTS auxiliary_sessions (
                id TEXT PRIMARY KEY,
                parent_session_id TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
                updated_at TEXT NOT NULL,
                payload_json TEXT NOT NULL
              );

              CREATE INDEX IF NOT EXISTS idx_auxiliary_sessions_parent_updated
                ON auxiliary_sessions(parent_session_id, updated_at DESC);
            `);
            continue;
          }
          db.exec(statement === CREATE_V6_AUDIT_EVENTS_TABLE_SQL
            ? `
              CREATE TABLE IF NOT EXISTS audit_events_v6 (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT,
                event_type TEXT NOT NULL CHECK (event_type IN (
                  'session_turn',
                  'memory_mutation',
                  'runtime_binding',
                  'diagnostic'
                )),
                provider_id TEXT NOT NULL DEFAULT '',
                summary TEXT NOT NULL DEFAULT '',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE SET NULL
              );

              CREATE INDEX IF NOT EXISTS idx_v6_audit_events_session_created
                ON audit_events_v6(session_id, created_at DESC, id DESC);

              CREATE INDEX IF NOT EXISTS idx_v6_audit_events_type_created
                ON audit_events_v6(event_type, created_at DESC);
            `
            : statement);
        }
      } finally {
        db.close();
      }

      assert.equal(isValidV6Database(v6Path), false);
      const verified = await createOrVerifyV6FreshDatabase(userDataPath);

      assert.deepEqual(verified, { dbPath: v6Path, created: false });
      assert.equal(isValidV6Database(v6Path), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("既存の invalid V6 DB は上書きしない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-v6-bootstrap-"));
    try {
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      await writeFile(v6Path, "not sqlite");

      await assert.rejects(
        () => createOrVerifyV6FreshDatabase(userDataPath),
        /does not match the V6 foundation schema/,
      );
      assert.equal(isValidV6Database(v6Path), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("schema 途中失敗後に final DB を残さず、再実行で正常作成できる", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-v6-bootstrap-"));
    try {
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);

      await assert.rejects(
        () => createOrVerifyV6FreshDatabase(userDataPath, {
          schemaSql: [
            "CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY);",
            "CREATE TABLE broken (",
          ],
        }),
        /incomplete input|syntax error/,
      );
      assert.equal(existsSync(v6Path), false);

      const result = await createOrVerifyV6FreshDatabase(userDataPath);
      assert.deepEqual(result, { dbPath: v6Path, created: true });
      assert.equal(isValidV6Database(v6Path), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("validation failure 時に final DB と sidecar を残さない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-v6-bootstrap-"));
    try {
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);

      await assert.rejects(
        () => createOrVerifyV6FreshDatabase(userDataPath, {
          schemaSql: [
            "CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY);",
            `PRAGMA user_version = ${APP_DATABASE_V6_SCHEMA_VERSION};`,
          ],
        }),
        /Failed to create a valid/,
      );

      const files = await readdir(userDataPath);
      assert.equal(existsSync(v6Path), false);
      assert.equal(existsSync(`${v6Path}-wal`), false);
      assert.equal(existsSync(`${v6Path}-shm`), false);
      assert.deepEqual(files.filter((fileName) => fileName.includes("withmate-v6")), []);
      assert.deepEqual(files.filter((fileName) => fileName.startsWith(".withmate-v6-bootstrap-")), []);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("concurrent bootstrap では final DB を1つだけ作成する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-v6-bootstrap-"));
    try {
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);

      const results = await Promise.all([
        createOrVerifyV6FreshDatabase(userDataPath),
        createOrVerifyV6FreshDatabase(userDataPath),
      ]);

      assert.equal(results.filter((result) => result.created).length, 1);
      assert.deepEqual(results.map((result) => result.dbPath), [v6Path, v6Path]);
      assert.equal(isValidV6Database(v6Path), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});
