import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { APP_DATABASE_V1_FILENAME } from "../../src-electron/database-schema-v1.js";
import {
  APP_DATABASE_V2_FILENAME,
  CREATE_V2_SCHEMA_SQL,
  isValidV2Database,
} from "../../src-electron/database-schema-v2.js";
import {
  APP_DATABASE_V3_FILENAME,
  CREATE_V3_SCHEMA_SQL,
  isValidV3Database,
} from "../../src-electron/database-schema-v3.js";
import {
  APP_DATABASE_V4_FILENAME,
  APP_DATABASE_V4_SCHEMA_VERSION,
  CREATE_V4_SCHEMA_SQL,
  isValidV4Database,
  readV4DatabaseUserVersion,
} from "../../src-electron/database-schema-v4.js";
import {
  APP_DATABASE_V6_FILENAME,
  CREATE_V6_AUDIT_EVENTS_TABLE_SQL,
  CREATE_V6_AUXILIARY_SESSIONS_TABLE_SQL,
  CREATE_V6_SCHEMA_SQL,
  CREATE_V6_SESSION_TURN_INTERIMS_TABLE_SQL,
  CREATE_V6_SESSION_TURN_PROVIDER_OUTPUTS_TABLE_SQL,
  CREATE_V6_SESSION_TURNS_TABLE_SQL,
  isValidV6Database,
} from "../../src-electron/database-schema-v6.js";
import { resolveAppDatabasePath, resolveOrMigrateAppDatabasePath } from "../../src-electron/app-database-path.js";
import { AuditLogStorageV6 } from "../../src-electron/audit-log-storage-v6.js";
import { hasV4ToV6ReleaseDataMigrationMarker } from "../migrate-database-v4-to-v6.js";

function createV2Database(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    for (const statement of CREATE_V2_SCHEMA_SQL) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }
}

function createLegacyV2DatabaseWithoutUserVersion(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    for (const statement of CREATE_V2_SCHEMA_SQL) {
      if (!statement.trim().startsWith("PRAGMA user_version")) {
        db.exec(statement);
      }
    }
  } finally {
    db.close();
  }
}

function createV3Database(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    for (const statement of CREATE_V3_SCHEMA_SQL) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }
}

function createLegacyV3DatabaseWithoutUserVersion(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    for (const statement of CREATE_V3_SCHEMA_SQL) {
      if (!statement.trim().startsWith("PRAGMA user_version")) {
        db.exec(statement);
      }
    }
  } finally {
    db.close();
  }
}

function createV4Database(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    for (const statement of CREATE_V4_SCHEMA_SQL) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }
}

function createRepairableLegacyV6Database(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    for (const statement of CREATE_V6_SCHEMA_SQL) {
      if (
        statement === CREATE_V6_SESSION_TURNS_TABLE_SQL
        || statement === CREATE_V6_SESSION_TURN_INTERIMS_TABLE_SQL
        || statement === CREATE_V6_SESSION_TURN_PROVIDER_OUTPUTS_TABLE_SQL
      ) {
        continue;
      }
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
    db.exec("CREATE TABLE v6_only_sentinel (id TEXT PRIMARY KEY);");
    db.prepare("INSERT INTO v6_only_sentinel (id) VALUES (?)").run("keep-v6");
  } finally {
    db.close();
  }
}

function createUnrepairableV6Database(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA user_version = 6;
      CREATE VIEW sessions_v6 AS SELECT 'invalid' AS id;
    `);
  } finally {
    db.close();
  }
}

function hasTable(dbPath: string, tableName: string): boolean {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName) as
      | { name?: string }
      | undefined;
    return row?.name === tableName;
  } finally {
    db.close();
  }
}

function hasV6Setting(dbPath: string, settingKey: string): boolean {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT setting_key FROM app_settings WHERE setting_key = ?").get(settingKey) as
      | { setting_key?: string }
      | undefined;
    return row?.setting_key === settingKey;
  } finally {
    db.close();
  }
}

function createV4DatabaseWithUserVersion(dbPath: string, userVersion: number): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`PRAGMA user_version = ${userVersion};`);
  } finally {
    db.close();
  }
}

describe("resolveAppDatabasePath", () => {
  it("有効な V4/V3/V2/V1 がある場合は withmate-v4.db を最優先する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v1Path = path.join(userDataPath, APP_DATABASE_V1_FILENAME);
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      await writeFile(v1Path, "");
      createV2Database(v2Path);
      createV3Database(v3Path);
      createV4Database(v4Path);

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v4Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("有効な V3/V2/V1 がある場合は withmate-v3.db を最優先する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v1Path = path.join(userDataPath, APP_DATABASE_V1_FILENAME);
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      await writeFile(v1Path, "");
      createV2Database(v2Path);
      createV3Database(v3Path);

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v3Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("有効な withmate-v2.db が存在すれば V2 を返す", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
      createV2Database(v2Path);

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v2Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("withmate-v2.db が無い場合でも legacy withmate.db があれば返す", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v1Path = path.join(userDataPath, APP_DATABASE_V1_FILENAME);
      await writeFile(v1Path, "");

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v1Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("有効な V2 と V1 が両方ある場合は withmate-v2.db を優先する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v1Path = path.join(userDataPath, APP_DATABASE_V1_FILENAME);
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
      await writeFile(v1Path, "");
      createV2Database(v2Path);

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v2Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("どの DB も無い場合は withmate-v6.db を返す（初回起動 canonical path）", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v6Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("有効な withmate-v6.db が存在すれば active runtime DB path selection は V6 を選ぶ", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      await createOrVerifyV6FreshDatabase(userDataPath);

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v6Path);
      assert.equal(isValidV6Database(v6Path), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("V6 repair が失敗しても valid V4 があれば active path selection は V4 へ fallback する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      createV4Database(v4Path);
      createUnrepairableV6Database(v6Path);

      const selectedPath = resolveAppDatabasePath(userDataPath);

      assert.equal(selectedPath, v4Path);
      assert.equal(isValidV4Database(v4Path), true);
      assert.equal(isValidV6Database(v6Path), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("どの DB も存在しない場合でも起動時 migration や DB 作成を呼び出さない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v1Path = path.join(userDataPath, APP_DATABASE_V1_FILENAME);
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v6Path);
      assert.equal(existsSync(v1Path), false);
      assert.equal(existsSync(v2Path), false);
      assert.equal(existsSync(v3Path), false);
      assert.equal(existsSync(v6Path), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("空の withmate-v2.db が V1 を shadow しない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v1Path = path.join(userDataPath, APP_DATABASE_V1_FILENAME);
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
      await writeFile(v1Path, "");
      await writeFile(v2Path, "");

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v1Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("空の withmate-v3.db が V2 を shadow しない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      createV2Database(v2Path);
      await writeFile(v3Path, "");

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v2Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("空の withmate-v4.db が V3 を shadow しない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createV3Database(v3Path);
      await writeFile(v4Path, "");

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v3Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("user_version=0 の既存 V3 DB は required tables が揃っていれば有効扱いにする", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      createLegacyV3DatabaseWithoutUserVersion(v3Path);

      assert.equal(isValidV3Database(v3Path), true);
      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v3Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("user_version=0 の既存 V2 DB は required tables が揃っていれば有効扱いにする", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
      createLegacyV2DatabaseWithoutUserVersion(v2Path);

      assert.equal(isValidV2Database(v2Path), true);
      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v2Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("invalid な withmate-v3.db が V1 を shadow しない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-path-"));

    try {
      const v1Path = path.join(userDataPath, APP_DATABASE_V1_FILENAME);
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      await writeFile(v1Path, "");
      await writeFile(v3Path, "not sqlite");

      const selectedPath = resolveAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v1Path);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});

describe("resolveOrMigrateAppDatabasePath", () => {
  it("有効な withmate-v4.db が存在する場合は V6 へ移行して V6 を返す", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-migrate-"));

    try {
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      await writeFile(v3Path, "not sqlite");
      createV4Database(v4Path);

      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      assert.equal(selectedPath, v6Path);
      assert.equal(isValidV4Database(v4Path), true);
      assert.equal(isValidV6Database(v6Path), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("V6 DB は起動時 migration target として選ばれる", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-migrate-"));

    try {
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      await createOrVerifyV6FreshDatabase(userDataPath);

      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);
      assert.equal(selectedPath, v6Path);
      assert.equal(isValidV6Database(v6Path), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("既存 V6 DB に audit_events_v6 が残っている場合は起動時に session turn storage へ移行する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-migrate-"));

    try {
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      await createOrVerifyV6FreshDatabase(userDataPath);
      const db = new DatabaseSync(v6Path);
      try {
        db.exec("PRAGMA foreign_keys = ON;");
        db.exec(CREATE_V6_AUDIT_EVENTS_TABLE_SQL);
        db.prepare(`
          INSERT INTO sessions_v6 (
            id,
            title,
            state,
            provider_id,
            catalog_revision,
            model_id,
            approval_mode,
            created_at,
            updated_at,
            last_active_at
          ) VALUES (?, ?, 'active', 'codex', 1, 'gpt-5', 'on-request', ?, ?, ?)
        `).run(
          "session-1",
          "Session 1",
          "2026-07-05T00:00:00.000Z",
          "2026-07-05T00:00:00.000Z",
          "2026-07-05T00:00:00.000Z",
        );
        db.prepare(`
          INSERT INTO audit_events_v6 (
            session_id,
            auxiliary_session_id,
            event_type,
            provider_id,
            summary,
            metadata_json,
            created_at
          ) VALUES (?, NULL, 'session_turn', 'codex', 'summary', ?, ?)
        `).run(
          "session-1",
          JSON.stringify({
            phase: "completed",
            provider: "codex",
            model: "gpt-5",
            reasoningEffort: "medium",
            approvalMode: "on-request",
            threadId: "thread-1",
            assistantText: "final migrated",
            operations: [],
            rawItemsJson: "",
            errorMessage: "",
          }),
          "2026-07-05T00:01:00.000Z",
        );
      } finally {
        db.close();
      }

      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);

      assert.equal(selectedPath, v6Path);
      assert.equal(isValidV6Database(v6Path), true);
      const migratedDb = new DatabaseSync(v6Path, { readOnly: true });
      try {
        assert.equal(hasTable(v6Path, "audit_events_v6"), false);
        assert.equal(
          (migratedDb.prepare("SELECT COUNT(*) AS count FROM session_turns_v6").get() as { count: number }).count,
          1,
        );
        assert.equal(
          (migratedDb.prepare("SELECT COUNT(*) AS count FROM session_messages_v6 WHERE session_id = ? AND role = 'assistant'").get(
            "session-1",
          ) as { count: number }).count,
          0,
        );
        assert.equal(
          (migratedDb.prepare(`
            SELECT payload_json
            FROM session_turn_provider_outputs_v6
            WHERE kind = 'legacy_assistant_text'
          `).get() as { payload_json: string } | undefined)?.payload_json,
          JSON.stringify({ value: "final migrated" }),
        );
        const auditStorage = new AuditLogStorageV6(v6Path);
        try {
          assert.equal(auditStorage.getSessionAuditLogDetail("session-1", 1)?.assistantText, "final migrated");
        } finally {
          auditStorage.close();
        }
      } finally {
        migratedDb.close();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("既存 V6 DB の session turn storage migration に skipped row があっても valid row を非破壊移行する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-migrate-"));

    try {
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createV4Database(v4Path);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      await createOrVerifyV6FreshDatabase(userDataPath);
      const db = new DatabaseSync(v6Path);
      try {
        db.exec("CREATE TABLE project_memory_entries (id TEXT PRIMARY KEY);");
        db.prepare("INSERT INTO project_memory_entries (id) VALUES (?)").run("legacy-memory-1");
        db.exec(CREATE_V6_AUDIT_EVENTS_TABLE_SQL);
        db.prepare(`
          INSERT INTO sessions_v6 (
            id,
            title,
            state,
            provider_id,
            catalog_revision,
            model_id,
            approval_mode,
            created_at,
            updated_at,
            last_active_at
          ) VALUES (?, ?, 'active', 'codex', 1, 'gpt-5', 'on-request', ?, ?, ?)
        `).run(
          "session-1",
          "Session 1",
          "2026-07-05T00:00:00.000Z",
          "2026-07-05T00:00:00.000Z",
          "2026-07-05T00:00:00.000Z",
        );
        db.prepare(`
          INSERT INTO audit_events_v6 (
            session_id,
            auxiliary_session_id,
            event_type,
            provider_id,
            summary,
            metadata_json,
            created_at
          ) VALUES (?, NULL, 'session_turn', 'codex', 'valid session turn', ?, ?)
        `).run(
          "session-1",
          JSON.stringify({
            phase: "completed",
            provider: "codex",
            model: "gpt-5",
            reasoningEffort: "medium",
            approvalMode: "on-request",
            threadId: "thread-1",
            assistantText: "partial migrated",
            operations: [],
            rawItemsJson: "",
            errorMessage: "",
          }),
          "2026-07-05T00:01:00.000Z",
        );
        db.prepare(`
          INSERT INTO audit_events_v6 (
            session_id,
            auxiliary_session_id,
            event_type,
            provider_id,
            summary,
            metadata_json,
            created_at
          ) VALUES (NULL, NULL, 'diagnostic', 'system', 'diagnostic row', '{}', ?)
        `).run("2026-07-05T00:00:00.000Z");
      } finally {
        db.close();
      }

      const originalWarn = console.warn;
      const warnings: unknown[][] = [];
      console.warn = (...args: unknown[]) => {
        warnings.push(args);
      };
      let selectedPath = "";
      try {
        selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);
      } finally {
        console.warn = originalWarn;
      }

      assert.equal(selectedPath, v6Path);
      assert.equal(warnings.length, 0);
      assert.equal(isValidV6Database(v6Path), true);
      assert.equal(hasTable(v6Path, "audit_events_v6"), true);
      assert.equal(hasTable(v6Path, "project_memory_entries"), false);
      assert.equal(hasV6Setting(v6Path, "session_turn_storage_v6_migrated_at"), false);
      const migratedDb = new DatabaseSync(v6Path, { readOnly: true });
      try {
        assert.equal(
          (migratedDb.prepare("SELECT COUNT(*) AS count FROM session_turns_v6").get() as { count: number }).count,
          1,
        );
        assert.equal(
          (migratedDb.prepare(`
            SELECT payload_json
            FROM session_turn_provider_outputs_v6
            WHERE kind = 'legacy_assistant_text'
          `).get() as { payload_json: string } | undefined)?.payload_json,
          JSON.stringify({ value: "partial migrated" }),
        );
      } finally {
        migratedDb.close();
      }
      const auditStorage = new AuditLogStorageV6(v6Path);
      try {
        assert.equal(auditStorage.getSessionAuditLogDetail("session-1", 1)?.assistantText, "partial migrated");
      } finally {
        auditStorage.close();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("既存 V6 DB に legacy Memory table だけが残っている場合は起動時に cleanup する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-migrate-"));

    try {
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      await createOrVerifyV6FreshDatabase(userDataPath);
      const db = new DatabaseSync(v6Path);
      try {
        db.exec("CREATE TABLE project_memory_entries (id TEXT PRIMARY KEY);");
        db.prepare("INSERT INTO project_memory_entries (id) VALUES (?)").run("legacy-memory-1");
      } finally {
        db.close();
      }

      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);

      assert.equal(selectedPath, v6Path);
      assert.equal(isValidV6Database(v6Path), true);
      assert.equal(hasTable(v6Path, "project_memory_entries"), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("旧 V6 DB と valid V4 が併存する場合は V6 を repair して overwrite migration しない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-migrate-"));

    try {
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createV4Database(v4Path);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      createRepairableLegacyV6Database(v6Path);

      assert.equal(isValidV6Database(v6Path), false);
      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);

      assert.equal(selectedPath, v6Path);
      assert.equal(isValidV6Database(v6Path), true);
      assert.equal(hasTable(v6Path, "v6_only_sentinel"), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("V6 repair が失敗しても valid V4 があれば V4 から V6 へ移行する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-migrate-"));

    try {
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createV4Database(v4Path);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      createUnrepairableV6Database(v6Path);

      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);

      assert.equal(selectedPath, v6Path);
      assert.equal(isValidV4Database(v4Path), true);
      assert.equal(isValidV6Database(v6Path), true);
      assert.equal(hasTable(v6Path, "v6_only_sentinel"), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("V6 DB と V4 DB が併存しても release data migration marker 済みなら再移行しない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-migrate-"));

    try {
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createV4Database(v4Path);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);

      const firstProgress: string[] = [];
      const firstSelectedPath = await resolveOrMigrateAppDatabasePath(userDataPath, (progress) => {
        firstProgress.push(progress.title);
      });
      assert.equal(firstSelectedPath, v6Path);
      assert.equal(hasV4ToV6ReleaseDataMigrationMarker(v6Path), true);
      assert.equal(firstProgress.includes("データベースを移行しています"), true);

      const secondProgress: string[] = [];
      const secondSelectedPath = await resolveOrMigrateAppDatabasePath(userDataPath, (progress) => {
        secondProgress.push(progress.title);
      });
      assert.equal(secondSelectedPath, v6Path);
      assert.equal(secondProgress.includes("データベースを移行しています"), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("不正な withmate-v4.db が有効な V3 を shadow しない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-migrate-"));

    try {
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createV3Database(v3Path);
      await writeFile(v4Path, "not sqlite");

      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      assert.equal(selectedPath, v6Path);
      assert.equal(isValidV4Database(v4Path), true);
      assert.equal(isValidV6Database(v6Path), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("user_version=4 でも required tables が欠けた withmate-v4.db は有効な V3 を shadow しない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-migrate-"));

    try {
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createV3Database(v3Path);
      createV4DatabaseWithUserVersion(v4Path, APP_DATABASE_V4_SCHEMA_VERSION);

      assert.equal(isValidV4Database(v4Path), false);
      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      assert.equal(selectedPath, v6Path);
      assert.equal(isValidV4Database(v4Path), true);
      assert.equal(isValidV6Database(v6Path), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("対応外の新しい withmate-v4.db は legacy migration で上書きしない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-migrate-"));

    try {
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      const newerVersion = APP_DATABASE_V4_SCHEMA_VERSION + 1;
      createV3Database(v3Path);
      createV4DatabaseWithUserVersion(v4Path, newerVersion);

      await assert.rejects(
        () => resolveOrMigrateAppDatabasePath(userDataPath),
        /対応していない新しい DB バージョン/,
      );
      assert.equal(readV4DatabaseUserVersion(v4Path), newerVersion);
      assert.equal(isValidV4Database(v4Path), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("withmate-v4.db が無く V3 がある場合は同じ userData 内に V4 を作成し、V3 を残す", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-migrate-"));

    try {
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createV3Database(v3Path);

      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      assert.equal(selectedPath, v6Path);
      assert.equal(existsSync(v3Path), true);
      assert.equal(isValidV4Database(v4Path), true);
      assert.equal(isValidV6Database(v6Path), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("user_version=0 の既存 V3 DB から V4 へ自動移行する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-migrate-"));

    try {
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createLegacyV3DatabaseWithoutUserVersion(v3Path);

      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      assert.equal(selectedPath, v6Path);
      assert.equal(isValidV4Database(v4Path), true);
      assert.equal(isValidV6Database(v6Path), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("V2 しか無い場合は V2 を残したまま V3 経由で V4 を作成する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-migrate-"));

    try {
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createV2Database(v2Path);

      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      assert.equal(selectedPath, v6Path);
      assert.equal(existsSync(v2Path), true);
      assert.equal(existsSync(v3Path), true);
      assert.equal(isValidV4Database(v4Path), true);
      assert.equal(isValidV6Database(v6Path), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("user_version=0 の既存 V2 DB から V4 へ自動移行する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-migrate-"));

    try {
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      createLegacyV2DatabaseWithoutUserVersion(v2Path);

      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      assert.equal(selectedPath, v6Path);
      assert.equal(existsSync(v2Path), true);
      assert.equal(existsSync(v3Path), true);
      assert.equal(isValidV4Database(v4Path), true);
      assert.equal(isValidV6Database(v6Path), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("V1 しか無い場合は V1 を残したまま V2/V3 経由で V4 を作成する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-app-db-migrate-"));

    try {
      const v1Path = path.join(userDataPath, APP_DATABASE_V1_FILENAME);
      const v2Path = path.join(userDataPath, APP_DATABASE_V2_FILENAME);
      const v3Path = path.join(userDataPath, APP_DATABASE_V3_FILENAME);
      const v4Path = path.join(userDataPath, APP_DATABASE_V4_FILENAME);
      await writeFile(v1Path, "");

      const selectedPath = await resolveOrMigrateAppDatabasePath(userDataPath);
      const v6Path = path.join(userDataPath, APP_DATABASE_V6_FILENAME);
      assert.equal(selectedPath, v6Path);
      assert.equal(existsSync(v1Path), true);
      assert.equal(existsSync(v2Path), true);
      assert.equal(existsSync(v3Path), true);
      assert.equal(isValidV4Database(v4Path), true);
      assert.equal(isValidV6Database(v6Path), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});
