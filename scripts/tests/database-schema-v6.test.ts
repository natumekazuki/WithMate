import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  APP_DATABASE_V6_FILENAME,
  APP_DATABASE_V6_SCHEMA_VERSION,
  CREATE_V6_AUDIT_EVENTS_TABLE_SQL,
  CREATE_V6_AUXILIARY_SESSIONS_TABLE_SQL,
  CREATE_V6_SCHEMA_SQL,
  CREATE_V6_SESSION_TURN_INTERIMS_TABLE_SQL,
  CREATE_V6_SESSION_TURN_PROVIDER_OUTPUTS_TABLE_SQL,
  CREATE_V6_SESSION_TURNS_TABLE_SQL,
  REQUIRED_V6_TABLES,
  V6_SCHEMA_STATUS,
  cleanupForbiddenV6Tables,
  ensureV6Schema,
  isValidV6Database,
  readV6DatabaseUserVersion,
  resolveV6FreshDatabasePath,
} from "../../src-electron/database-schema-v6.js";

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
};

const LEGACY_MEMORY_TABLES = [
  "session_memories",
  "project_scopes",
  "project_memory_entries",
  "character_scopes",
  "character_memory_entries",
] as const;

function createV6Schema(dbPath = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  for (const statement of CREATE_V6_SCHEMA_SQL) {
    db.exec(statement);
  }
  return db;
}

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as TableInfoRow[])
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_"));
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

function hasForeignKey(db: DatabaseSync, tableName: string, fromColumn: string, targetTable: string): boolean {
  const keys = db.prepare(`PRAGMA foreign_key_list(${tableName})`).all() as ForeignKeyRow[];
  return keys.some((row) => row.from === fromColumn && row.table === targetTable);
}

function createV6DatabaseWithEmptyRequiredTables(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    for (const tableName of REQUIRED_V6_TABLES) {
      db.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (id TEXT PRIMARY KEY);`);
    }
    db.exec(`PRAGMA user_version = ${APP_DATABASE_V6_SCHEMA_VERSION};`);
  } finally {
    db.close();
  }
}

describe("database-schema-v6", () => {
  it("withmate-v6.db 用の schema constants、fresh path、required tables を固定する", () => {
    assert.equal(APP_DATABASE_V6_FILENAME, "withmate-v6.db");
    assert.equal(APP_DATABASE_V6_SCHEMA_VERSION, 6);
    assert.equal(V6_SCHEMA_STATUS, "foundation");
    assert.equal(resolveV6FreshDatabasePath("user-data"), join("user-data", APP_DATABASE_V6_FILENAME));

    const db = createV6Schema();
    try {
      const names = tableNames(db).sort();
      assert.deepEqual(names, [...REQUIRED_V6_TABLES].sort());
      const userVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
      assert.equal(userVersion.user_version, APP_DATABASE_V6_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("isValidV6Database は filename、schema version、required tables を検証する", () => {
    const dirPath = mkdtempSync(join(tmpdir(), "withmate-v6-schema-"));
    try {
      const validDbPath = join(dirPath, APP_DATABASE_V6_FILENAME);
      const validDb = createV6Schema(validDbPath);
      validDb.close();

      const wrongNameDbPath = join(dirPath, "withmate-v4.db");
      const wrongNameDb = createV6Schema(wrongNameDbPath);
      wrongNameDb.close();

      const emptyDirPath = join(dirPath, "empty");
      const emptyV6DbPath = join(emptyDirPath, APP_DATABASE_V6_FILENAME);
      rmSync(emptyDirPath, { recursive: true, force: true });
      mkdirSync(emptyDirPath);
      closeSync(openSync(emptyV6DbPath, "w"));

      const partialV6DbPath = join(dirPath, "partial", APP_DATABASE_V6_FILENAME);
      mkdirSync(join(dirPath, "partial"));
      const partialV6Db = new DatabaseSync(partialV6DbPath);
      partialV6Db.exec(`PRAGMA user_version = ${APP_DATABASE_V6_SCHEMA_VERSION};`);
      partialV6Db.close();

      const malformedV6DbPath = join(dirPath, "malformed", APP_DATABASE_V6_FILENAME);
      mkdirSync(join(dirPath, "malformed"));
      createV6DatabaseWithEmptyRequiredTables(malformedV6DbPath);

      const legacyMixedV6DbPath = join(dirPath, "legacy-mixed", APP_DATABASE_V6_FILENAME);
      mkdirSync(join(dirPath, "legacy-mixed"));
      const legacyMixedDb = createV6Schema(legacyMixedV6DbPath);
      legacyMixedDb.exec("CREATE TABLE IF NOT EXISTS project_memory_entries (id TEXT PRIMARY KEY);");
      legacyMixedDb.close();

      assert.equal(isValidV6Database(validDbPath), true);
      assert.equal(readV6DatabaseUserVersion(validDbPath), APP_DATABASE_V6_SCHEMA_VERSION);
      assert.equal(isValidV6Database(wrongNameDbPath), false);
      assert.equal(readV6DatabaseUserVersion(wrongNameDbPath), null);
      assert.equal(isValidV6Database(emptyV6DbPath), false);
      assert.equal(isValidV6Database(partialV6DbPath), false);
      assert.equal(isValidV6Database(malformedV6DbPath), false);
      assert.equal(isValidV6Database(legacyMixedV6DbPath), false);
    } finally {
      rmSync(dirPath, { recursive: true, force: true });
    }
  });

  it("V6 schema は legacy Memory table を再利用しない", () => {
    const db = createV6Schema();
    try {
      const names = tableNames(db);
      for (const tableName of LEGACY_MEMORY_TABLES) {
        assert.equal(names.includes(tableName), false, `${tableName} must not exist in V6 schema`);
      }
    } finally {
      db.close();
    }
  });

  it("ensureV6Schema は V6 DB に紛れた legacy Memory table を削除しない", () => {
    const db = createV6Schema();
    try {
      db.exec("CREATE TABLE companion_groups (id TEXT PRIMARY KEY);");
      db.exec("CREATE TABLE companion_sessions (id TEXT PRIMARY KEY);");
      db.exec("CREATE TABLE companion_messages (id TEXT PRIMARY KEY);");
      db.exec("CREATE TABLE project_memory_entries (id TEXT PRIMARY KEY);");

      ensureV6Schema(db);

      const names = tableNames(db);
      assert.equal(names.includes("companion_groups"), true);
      assert.equal(names.includes("companion_sessions"), true);
      assert.equal(names.includes("companion_messages"), true);
      assert.equal(names.includes("project_memory_entries"), true);
    } finally {
      db.close();
    }
  });

  it("cleanupForbiddenV6Tables は legacy Memory table を削除し、Companion table は保持する", () => {
    const db = createV6Schema();
    try {
      db.exec("CREATE TABLE companion_groups (id TEXT PRIMARY KEY);");
      db.exec("CREATE TABLE companion_sessions (id TEXT PRIMARY KEY);");
      db.exec("CREATE TABLE companion_messages (id TEXT PRIMARY KEY);");
      db.exec("CREATE TABLE project_memory_entries (id TEXT PRIMARY KEY);");

      cleanupForbiddenV6Tables(db);

      const names = tableNames(db);
      assert.equal(names.includes("companion_groups"), true);
      assert.equal(names.includes("companion_sessions"), true);
      assert.equal(names.includes("companion_messages"), true);
      assert.equal(names.includes("project_memory_entries"), false);
    } finally {
      db.close();
    }
  });

  it("V6 project scope と session/message/audit の最小 schema を固定する", () => {
    const db = createV6Schema();
    try {
      assert.deepEqual(columnNames(db, "project_scopes_v6"), [
        "id",
        "project_type",
        "project_key",
        "workspace_path",
        "git_root",
        "git_remote_url",
        "display_name",
        "created_at",
        "updated_at",
      ]);
      assert.equal(tableSql(db, "project_scopes_v6").includes("UNIQUE (project_type, project_key)"), true);

      assert.deepEqual(columnNames(db, "sessions_v6"), [
        "id",
        "title",
        "state",
        "session_kind",
        "provider_id",
        "catalog_revision",
        "model_id",
        "reasoning_effort",
        "custom_agent_name",
        "approval_mode",
        "codex_sandbox_mode",
        "allowed_additional_directories_json",
        "runtime_policy_json",
        "thread_id",
        "character_id",
        "character_snapshot_json",
        "project_scope_id",
        "workspace_path",
        "created_at",
        "updated_at",
        "last_active_at",
      ]);
      assert.equal(findForeignKey(db, "sessions_v6", "character_id")?.table, "characters");
      assert.equal(findForeignKey(db, "sessions_v6", "project_scope_id")?.table, "project_scopes_v6");
      assert.equal(tableSql(db, "sessions_v6").includes("json_valid(character_snapshot_json)"), true);
      assert.equal(tableSql(db, "sessions_v6").includes("allowed_additional_directories_json TEXT NOT NULL DEFAULT '[]'"), true);

      assert.deepEqual(columnNames(db, "session_messages_v6"), [
        "id",
        "session_id",
        "seq",
        "role",
        "body",
        "artifact_body",
        "created_at",
      ]);
      assert.equal(findForeignKey(db, "session_messages_v6", "session_id")?.on_delete.toUpperCase(), "CASCADE");

      assert.deepEqual(columnNames(db, "auxiliary_sessions"), [
        "id",
        "parent_session_id",
        "status",
        "created_at",
        "updated_at",
        "payload_json",
      ]);
      assert.equal(findForeignKey(db, "auxiliary_sessions", "parent_session_id"), undefined);
      assert.equal(tableSql(db, "auxiliary_sessions").includes("status IN ('active', 'closed')"), true);

      assert.deepEqual(columnNames(db, "session_turns_v6"), [
        "id",
        "session_id",
        "auxiliary_session_id",
        "phase",
        "provider_id",
        "model_id",
        "reasoning_effort",
        "approval_mode",
        "sandbox_mode",
        "user_message_seq",
        "assistant_message_seq",
        "thread_id",
        "summary",
        "error_summary",
        "started_at",
        "completed_at",
        "updated_at",
      ]);
      assert.equal(findForeignKey(db, "session_turns_v6", "session_id")?.table, "sessions_v6");
      assert.equal(findForeignKey(db, "session_turns_v6", "session_id")?.on_delete.toUpperCase(), "CASCADE");
      assert.equal(findForeignKey(db, "session_turns_v6", "auxiliary_session_id")?.table, "auxiliary_sessions");
      assert.equal(findForeignKey(db, "session_turns_v6", "auxiliary_session_id")?.on_delete.toUpperCase(), "CASCADE");
      assert.equal(tableSql(db, "session_turns_v6").includes("phase IN ('running', 'completed', 'failed', 'canceled')"), true);
      assert.equal(tableSql(db, "session_turns_v6").includes("session_id IS NOT NULL OR auxiliary_session_id IS NOT NULL"), true);
      assert.equal(tableSql(db, "session_turns_v6").includes("NOT (session_id IS NOT NULL AND auxiliary_session_id IS NOT NULL)"), true);

      assert.deepEqual(columnNames(db, "session_turn_interims_v6"), [
        "id",
        "turn_id",
        "seq",
        "body",
        "source",
        "created_at",
      ]);
      assert.equal(findForeignKey(db, "session_turn_interims_v6", "turn_id")?.table, "session_turns_v6");
      assert.equal(findForeignKey(db, "session_turn_interims_v6", "turn_id")?.on_delete.toUpperCase(), "CASCADE");
      assert.equal(tableSql(db, "session_turn_interims_v6").includes("source IN ('stream_delta', 'running_snapshot', 'migration')"), true);

      assert.deepEqual(columnNames(db, "session_turn_provider_outputs_v6"), [
        "id",
        "turn_id",
        "seq",
        "provider_id",
        "kind",
        "summary",
        "payload_json",
        "payload_blob_id",
        "created_at",
      ]);
      assert.equal(findForeignKey(db, "session_turn_provider_outputs_v6", "turn_id")?.table, "session_turns_v6");
      assert.equal(findForeignKey(db, "session_turn_provider_outputs_v6", "turn_id")?.on_delete.toUpperCase(), "CASCADE");
      assert.equal(tableSql(db, "session_turn_provider_outputs_v6").includes("'logical_prompt'"), true);
      assert.equal(tableSql(db, "session_turn_provider_outputs_v6").includes("'context_telemetry'"), true);
      assert.equal(tableSql(db, "session_turn_provider_outputs_v6").includes("json_valid(payload_json)"), true);

    } finally {
      db.close();
    }
  });

  it("V6 Memory tables は contract の state/idempotency/tag 境界を保持する", () => {
    const db = createV6Schema();
    try {
      assert.deepEqual(columnNames(db, "memory_entries_v6"), [
        "id",
        "owner_type",
        "owner_id",
        "scope_type",
        "scope_id",
        "kind",
        "title",
        "body",
        "body_sha256",
        "preview",
        "state",
        "source_type",
        "source_session_id",
        "source_app_message_id",
        "source_provider_message_id",
        "source_provider_id",
        "superseded_by_id",
        "created_at",
        "updated_at",
        "forgotten_at",
      ]);
      assert.equal(tableSql(db, "memory_entries_v6").includes("'active', 'superseded', 'forgotten'"), true);
      assert.equal(tableSql(db, "memory_entries_v6").includes("superseded_by_id IS NOT NULL"), true);
      assert.equal(tableSql(db, "memory_entries_v6").includes("forgotten_at IS NOT NULL"), true);
      assert.equal(tableSql(db, "memory_entries_v6").includes("owner_type <> 'user' OR owner_id = 'local-user'"), true);
      assert.equal(tableSql(db, "memory_entries_v6").includes("scope_type <> 'global' OR scope_id = 'global'"), true);
      assert.throws(() => {
        db.prepare(`
          INSERT INTO memory_entries_v6 (
            id,
            owner_type,
            owner_id,
            scope_type,
            scope_id,
            kind,
            title,
            body,
            body_sha256,
            preview,
            state,
            source_type,
            source_session_id,
            source_app_message_id,
            source_provider_message_id,
            source_provider_id,
            superseded_by_id,
            created_at,
            updated_at,
            forgotten_at
          ) VALUES (
            'mem-malformed-user-global',
            'user',
            'other-user',
            'global',
            'global',
            'note',
            'bad',
            'bad',
            'sha',
            'bad',
            'active',
            'agent',
            NULL,
            NULL,
            NULL,
            'codex',
            NULL,
            '2026-06-29T00:00:00.000Z',
            '2026-06-29T00:00:00.000Z',
            NULL
          )
        `).run();
      });
      assert.equal(hasForeignKey(db, "memory_entries_v6", "source_session_id", "sessions_v6"), true);
      assert.equal(hasForeignKey(db, "memory_entries_v6", "source_session_id", "session_messages_v6"), true);
      assert.equal(findForeignKey(db, "memory_entries_v6", "source_app_message_id")?.table, "session_messages_v6");
      assert.equal(findForeignKey(db, "memory_entries_v6", "superseded_by_id")?.on_delete.toUpperCase(), "RESTRICT");

      assert.deepEqual(columnNames(db, "memory_entry_tags_v6"), [
        "entry_id",
        "tag_type",
        "tag_value",
        "tag_type_canonical",
        "tag_value_canonical",
        "created_at",
      ]);
      assert.equal(tableSql(db, "memory_entry_tags_v6").includes("PRIMARY KEY (entry_id, tag_type_canonical, tag_value_canonical)"), true);

      assert.deepEqual(columnNames(db, "memory_idempotency_keys_v6"), [
        "key",
        "operation",
        "binding_id_hash",
        "owner_type",
        "owner_id",
        "scope_type",
        "scope_id",
        "response_entry_id",
        "operation_created",
        "request_fingerprint",
        "created_at",
      ]);
      assert.equal(
        tableSql(db, "memory_idempotency_keys_v6").includes(
          "PRIMARY KEY (binding_id_hash, key, operation, owner_type, owner_id, scope_type, scope_id)",
        ),
        true,
      );
      assert.equal(tableSql(db, "memory_idempotency_keys_v6").includes("request_fingerprint TEXT NOT NULL"), true);

      assert.deepEqual(columnNames(db, "memory_idempotency_forget_results_v6"), [
        "key",
        "operation",
        "binding_id_hash",
        "owner_type",
        "owner_id",
        "scope_type",
        "scope_id",
        "entry_id",
        "result_status",
        "created_at",
      ]);

      assert.equal(tableSql(db, "memory_tag_catalog_v6").includes("PRIMARY KEY (tag_type_canonical, tag_value_canonical)"), true);
      assert.equal(tableSql(db, "memory_mutation_events_v6").includes("binding_id_hash"), true);
      assert.equal(tableSql(db, "memory_mutation_events_v6").includes("result_status TEXT NOT NULL"), true);
      assert.equal(tableSql(db, "memory_mutation_events_v6").includes("'already_forgotten'"), true);
    } finally {
      db.close();
    }
  });

  it("Character付きsessionではvalid JSON snapshotを必須にする", () => {
    const db = createV6Schema();
    try {
      db.prepare(`
        INSERT INTO characters (
          id,
          name,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?)
      `).run("char-a", "Character A", "2026-06-23T00:00:00.000Z", "2026-06-23T00:00:00.000Z");

      const insertSession = db.prepare(`
        INSERT INTO sessions_v6 (
          id,
          title,
          state,
          provider_id,
          catalog_revision,
          model_id,
          approval_mode,
          character_id,
          character_snapshot_json,
          created_at,
          updated_at,
          last_active_at
        ) VALUES (?, ?, 'active', 'codex', 1, 'gpt-5', 'on-request', ?, ?, ?, ?, ?)
      `);

      assert.throws(() => {
        insertSession.run(
          "session-invalid",
          "Invalid",
          "char-a",
          "",
          "2026-06-23T00:00:00.000Z",
          "2026-06-23T00:00:00.000Z",
          "2026-06-23T00:00:00.000Z",
        );
      });

      insertSession.run(
        "session-valid",
        "Valid",
        "char-a",
        JSON.stringify({ characterId: "char-a", definitionSha256: "sha", snapshotAt: "2026-06-23T00:00:00.000Z" }),
        "2026-06-23T00:00:00.000Z",
        "2026-06-23T00:00:00.000Z",
        "2026-06-23T00:00:00.000Z",
      );

      const count = db.prepare("SELECT COUNT(*) AS count FROM sessions_v6").get() as { count: number };
      assert.equal(count.count, 1);
    } finally {
      db.close();
    }
  });

  it("ensureV6Schema は旧 auxiliary_sessions の created_at を updated_at で backfill する", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;

        CREATE TABLE auxiliary_sessions (
          id TEXT PRIMARY KEY,
          parent_session_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
          updated_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );

        INSERT INTO auxiliary_sessions (
          id,
          parent_session_id,
          status,
          updated_at,
          payload_json
        ) VALUES (
          'aux-1',
          'session-1',
          'active',
          '2026-07-04T00:00:00.000Z',
          '{}'
        );
      `);

      ensureV6Schema(db);

      assert.deepEqual(columnNames(db, "auxiliary_sessions"), [
        "id",
        "parent_session_id",
        "status",
        "updated_at",
        "payload_json",
        "created_at",
      ]);
      const row = db.prepare("SELECT created_at, updated_at FROM auxiliary_sessions WHERE id = ?").get("aux-1") as
        | { created_at: string; updated_at: string }
        | undefined;
      assert.equal(row?.created_at, "2026-07-04T00:00:00.000Z");
      assert.equal(row?.updated_at, "2026-07-04T00:00:00.000Z");
    } finally {
      db.close();
    }
  });

  it("ensureV6Schema は auxiliary_sessions repair 失敗時に部分適用を rollback する", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
      `);

      for (const statement of CREATE_V6_SCHEMA_SQL) {
        if (
          statement !== CREATE_V6_AUXILIARY_SESSIONS_TABLE_SQL
          && statement !== CREATE_V6_SESSION_TURNS_TABLE_SQL
          && statement !== CREATE_V6_SESSION_TURN_INTERIMS_TABLE_SQL
          && statement !== CREATE_V6_SESSION_TURN_PROVIDER_OUTPUTS_TABLE_SQL
          && statement !== CREATE_V6_AUDIT_EVENTS_TABLE_SQL
        ) {
          db.exec(statement);
        }
      }

      db.exec(`
        CREATE TABLE auxiliary_sessions (
          id TEXT PRIMARY KEY,
          parent_session_id TEXT NOT NULL,
          status TEXT NOT NULL,
          updated_at TEXT,
          payload_json TEXT NOT NULL,
          FOREIGN KEY (parent_session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE
        );

        CREATE TABLE audit_events_v6 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT,
          event_type TEXT NOT NULL,
          provider_id TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL DEFAULT '',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );

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
        ) VALUES (
          'session-1',
          'Session 1',
          'active',
          'codex',
          1,
          'gpt-5',
          'on-request',
          '2026-07-04T00:00:00.000Z',
          '2026-07-04T00:00:00.000Z',
          '2026-07-04T00:00:00.000Z'
        );
        INSERT INTO auxiliary_sessions (
          id,
          parent_session_id,
          status,
          updated_at,
          payload_json
        ) VALUES (
          'aux-rollback',
          'session-1',
          'active',
          NULL,
          '{}'
        );
        INSERT INTO audit_events_v6 (
          session_id,
          event_type,
          provider_id,
          summary,
          metadata_json,
          created_at
        ) VALUES (
          'session-1',
          'session_turn',
          'codex',
          'summary',
          '{"prompt":"kept"}',
          '2026-07-04T00:00:00.000Z'
        );
      `);

      assert.throws(() => ensureV6Schema(db), /NOT NULL constraint failed/);

      assert.deepEqual(columnNames(db, "auxiliary_sessions"), [
        "id",
        "parent_session_id",
        "status",
        "updated_at",
        "payload_json",
      ]);
      assert.equal(tableNames(db).includes("auxiliary_sessions_v6_rebuild"), false);
      const auxiliaryRow = db.prepare("SELECT id, updated_at FROM auxiliary_sessions WHERE id = ?").get("aux-rollback") as
        | { id: string; updated_at: string | null }
        | undefined;
      assert.equal(auxiliaryRow?.id, "aux-rollback");
      assert.equal(auxiliaryRow?.updated_at, null);
      const auditRow = db.prepare("SELECT metadata_json FROM audit_events_v6 WHERE session_id = ?").get("session-1") as
        | { metadata_json: string }
        | undefined;
      assert.equal(auditRow?.metadata_json, '{"prompt":"kept"}');
    } finally {
      db.close();
    }
  });
});
