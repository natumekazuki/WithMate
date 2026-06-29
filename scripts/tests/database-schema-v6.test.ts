import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  APP_DATABASE_V6_FILENAME,
  APP_DATABASE_V6_SCHEMA_VERSION,
  CREATE_V6_SCHEMA_SQL,
  REQUIRED_V6_TABLES,
  V6_SCHEMA_STATUS,
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
        "created_at",
      ]);
      assert.equal(findForeignKey(db, "session_messages_v6", "session_id")?.on_delete.toUpperCase(), "CASCADE");

      assert.deepEqual(columnNames(db, "audit_events_v6"), [
        "id",
        "session_id",
        "event_type",
        "provider_id",
        "summary",
        "metadata_json",
        "created_at",
      ]);
      assert.equal(tableSql(db, "audit_events_v6").includes("'memory_mutation'"), true);
      assert.equal(tableSql(db, "audit_events_v6").includes("'runtime_binding'"), true);
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
});
