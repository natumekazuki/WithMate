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
  CREATE_V6_CHARACTER_AFFECT_TABLES_SQL,
  CREATE_V6_COORDINATION_EVENT_TABLES_SQL,
  CREATE_V6_CHARACTERS_TABLE_SQL,
  CREATE_V6_MEMORY_PROTECTED_OBJECTS_TABLE_SQL,
  CREATE_V6_PROJECT_SCOPES_TABLE_SQL,
  CREATE_V6_SCHEMA_SQL,
  CREATE_V6_SESSIONS_TABLE_SQL,
  CREATE_V6_SESSION_CRUD_IDEMPOTENCY_TABLE_SQL,
  CREATE_V6_SESSION_EXECUTIONS_TABLE_SQL,
  CREATE_V6_SESSION_EXECUTION_IDEMPOTENCY_TABLE_SQL,
  CREATE_V6_SESSION_FILE_WRITE_IDEMPOTENCY_TABLE_SQL,
  CREATE_V6_SESSION_INTERACTIONS_TABLE_SQL,
  CREATE_V6_SESSION_INTERACTION_IDEMPOTENCY_TABLE_SQL,
  CREATE_V6_SESSION_TRANSCRIPT_EXPORT_IDEMPOTENCY_TABLE_SQL,
  CREATE_V6_SESSION_TERMINAL_FAILURE_NOTIFICATION_DELIVERIES_TABLE_SQL,
  CREATE_V6_SESSION_TURN_PUBLIC_CONTEXT_TABLE_SQL,
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
import { AuditLogStorageV6 } from "../../src-electron/audit-log-storage-v6.js";

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
  db.exec(`
    CREATE TRIGGER test_default_session_role_binding
    AFTER INSERT ON sessions_v6
    WHEN NEW.session_kind = 'default'
    BEGIN
      INSERT INTO session_role_bindings_v6 (
        session_id, session_role, role_contract_revision,
        root_session_id, parent_session_id, delegation_depth
      ) VALUES (NEW.id, 'standalone', 1, NEW.id, NULL, 0);
    END;
  `);
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

function insertStandaloneRoleBinding(db: DatabaseSync, sessionId: string): void {
  db.prepare(`
    INSERT INTO session_role_bindings_v6 (
      session_id, session_role, role_contract_revision,
      root_session_id, parent_session_id, delegation_depth
    ) VALUES (?, 'standalone', 1, ?, NULL, 0)
  `).run(sessionId, sessionId);
}

function createLegacySessionSchema(db: DatabaseSync, withoutPinned = false): void {
  db.exec(CREATE_V6_CHARACTERS_TABLE_SQL);
  db.exec(CREATE_V6_PROJECT_SCOPES_TABLE_SQL);
  db.exec(withoutPinned
    ? CREATE_V6_SESSIONS_TABLE_SQL.replace(
      "    is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),\n",
      "",
    )
    : CREATE_V6_SESSIONS_TABLE_SQL);
}

describe("database-schema-v6", () => {
  it("ensureV6Schemaは既存sessionを保持してis_pinnedを既定falseで追加する", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(CREATE_V6_CHARACTERS_TABLE_SQL);
      db.exec(CREATE_V6_PROJECT_SCOPES_TABLE_SQL);
      db.exec(CREATE_V6_SESSIONS_TABLE_SQL.replace(
        "    is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),\n",
        "",
      ));
      db.prepare(`
        INSERT INTO sessions_v6 (
          id, title, state, session_kind, provider_id, catalog_revision, model_id,
          reasoning_effort, custom_agent_name, approval_mode, codex_sandbox_mode,
          allowed_additional_directories_json, runtime_policy_json, thread_id,
          workspace_path, created_at, updated_at, last_active_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "existing-session", "Existing", "active", "default", "codex", 1, "gpt-test",
        "high", "", "never", "danger-full-access", "[]", "{}", "", "C:/workspace",
        "2026-08-01T00:00:00.000Z", "2026-08-09T04:38:00.000Z", "2026-08-09T04:38:00.000Z",
      );

      ensureV6Schema(db);
      ensureV6Schema(db);

      const row = db.prepare("SELECT id, is_pinned FROM sessions_v6").get() as {
        id: string;
        is_pinned: number;
      };
      assert.equal(row.id, "existing-session");
      assert.equal(row.is_pinned, 0);
      assert.equal(tableNames(db).includes("character_affect_events_v6"), true);
      assert.equal(hasForeignKey(db, "character_affect_events_v6", "memory_entry_id", "memory_entries_v6"), true);
      assert.equal(
        hasForeignKey(db, "character_affect_events_v6", "supersedes_memory_entry_id", "memory_entries_v6"),
        true,
      );
      assert.equal(
        hasForeignKey(db, "character_affect_mutations_v6", "source_session_id", "sessions_v6"),
        true,
      );
    } finally {
      db.close();
    }
  });

  it("withmate-v6.db 用の schema constants、fresh path、required tables を固定する", () => {
    assert.equal(APP_DATABASE_V6_FILENAME, "withmate-v6.db");
    assert.equal(APP_DATABASE_V6_SCHEMA_VERSION, 6);
    assert.equal(V6_SCHEMA_STATUS, "foundation");
    assert.equal(resolveV6FreshDatabasePath("user-data"), join("user-data", APP_DATABASE_V6_FILENAME));

    const db = createV6Schema();
    try {
      const names = tableNames(db).sort();
      assert.deepEqual(names, [
        ...REQUIRED_V6_TABLES,
        "session_crud_idempotency_v6",
        "session_executions_v6",
        "session_execution_idempotency_v6",
        "session_file_write_idempotency_v6",
        "session_schedules_v6",
        "session_schedule_fires_v6",
        "session_terminal_failure_notification_deliveries_v6",
      ].sort());
      const userVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
      assert.equal(userVersion.user_version, APP_DATABASE_V6_SCHEMA_VERSION);
      assert.equal(CREATE_V6_SCHEMA_SQL.includes(CREATE_V6_SESSION_EXECUTIONS_TABLE_SQL), true);
      assert.equal(CREATE_V6_SCHEMA_SQL.includes(CREATE_V6_SESSION_EXECUTION_IDEMPOTENCY_TABLE_SQL), true);
      assert.equal(CREATE_V6_SCHEMA_SQL.includes(CREATE_V6_SESSION_CRUD_IDEMPOTENCY_TABLE_SQL), true);
      assert.equal(CREATE_V6_SCHEMA_SQL.includes(CREATE_V6_SESSION_FILE_WRITE_IDEMPOTENCY_TABLE_SQL), true);
      assert.equal(CREATE_V6_SCHEMA_SQL.includes(CREATE_V6_COORDINATION_EVENT_TABLES_SQL), true);
      assert.equal(CREATE_V6_SCHEMA_SQL.includes(CREATE_V6_SESSION_TURN_PUBLIC_CONTEXT_TABLE_SQL), true);
      assert.equal(CREATE_V6_SCHEMA_SQL.includes(CREATE_V6_SESSION_TRANSCRIPT_EXPORT_IDEMPOTENCY_TABLE_SQL), true);
      assert.equal(
        CREATE_V6_SCHEMA_SQL.includes(CREATE_V6_SESSION_TERMINAL_FAILURE_NOTIFICATION_DELIVERIES_TABLE_SQL),
        true,
      );
    } finally {
      db.close();
    }
  });

  it("既存V6 DBを有効と判定したままexternal runtime tablesをadditiveに適用する", () => {
    const dirPath = mkdtempSync(join(tmpdir(), "withmate-v6-execution-schema-"));
    const dbPath = join(dirPath, APP_DATABASE_V6_FILENAME);
    try {
      const oldDb = new DatabaseSync(dbPath);
      try {
        for (const statement of CREATE_V6_SCHEMA_SQL) {
          if (
            statement !== CREATE_V6_SESSION_EXECUTIONS_TABLE_SQL
            && statement !== CREATE_V6_SESSION_EXECUTION_IDEMPOTENCY_TABLE_SQL
            && statement !== CREATE_V6_SESSION_CRUD_IDEMPOTENCY_TABLE_SQL
            && statement !== CREATE_V6_SESSION_FILE_WRITE_IDEMPOTENCY_TABLE_SQL
            && statement !== CREATE_V6_SESSION_TERMINAL_FAILURE_NOTIFICATION_DELIVERIES_TABLE_SQL
          ) {
            oldDb.exec(statement);
          }
        }
      } finally {
        oldDb.close();
      }

      assert.equal(isValidV6Database(dbPath), true);

      const upgradedDb = new DatabaseSync(dbPath);
      try {
        upgradedDb.exec("PRAGMA foreign_keys = ON;");
        ensureV6Schema(upgradedDb);
        assert.equal(tableNames(upgradedDb).includes("session_executions_v6"), true);
        assert.equal(tableNames(upgradedDb).includes("session_execution_idempotency_v6"), true);
        assert.equal(tableNames(upgradedDb).includes("session_crud_idempotency_v6"), true);
        assert.equal(tableNames(upgradedDb).includes("session_file_write_idempotency_v6"), true);
        assert.equal(
          tableNames(upgradedDb).includes("session_terminal_failure_notification_deliveries_v6"),
          true,
        );
        ensureV6Schema(upgradedDb);
        assert.equal(tableNames(upgradedDb).filter((name) => name === "session_crud_idempotency_v6").length, 1);
        assert.equal(
          tableNames(upgradedDb).filter((name) => name === "session_terminal_failure_notification_deliveries_v6").length,
          1,
        );
      } finally {
        upgradedDb.close();
      }
    } finally {
      rmSync(dirPath, { recursive: true, force: true });
    }
  });

  it("TN-MIGRATE-07: delivery migrationはempty/populated DBへ再実行可能で既存executionを保持する", () => {
    const db = createV6Schema();
    try {
      db.exec("DROP TABLE session_terminal_failure_notification_deliveries_v6;");
      db.prepare(`
        INSERT INTO sessions_v6 (
          id, title, state, provider_id, catalog_revision, model_id,
          approval_mode, created_at, updated_at, last_active_at
        ) VALUES (?, ?, 'active', 'codex', 1, 'gpt-5', 'on-request', ?, ?, ?)
      `).run(
        "existing-session",
        "Existing",
        "2026-08-18T00:00:00.000Z",
        "2026-08-18T00:00:00.000Z",
        "2026-08-18T00:00:00.000Z",
      );
      db.prepare(`
        INSERT INTO session_executions_v6 (
          id, session_id, operation, state, request_json, created_at, updated_at
        ) VALUES (?, ?, 'turn.enqueue', 'queued', '{}', ?, ?)
      `).run(
        "existing-execution",
        "existing-session",
        "2026-08-18T00:00:00.000Z",
        "2026-08-18T00:00:00.000Z",
      );

      ensureV6Schema(db);
      ensureV6Schema(db);

      assert.equal(tableNames(db).filter((name) =>
        name === "session_terminal_failure_notification_deliveries_v6").length, 1);
      assert.equal(
        (db.prepare("SELECT COUNT(*) AS count FROM session_executions_v6").get() as { count: number }).count,
        1,
      );
    } finally {
      db.close();
    }
  });

  it("ORCH-OUTBOUND-MIGRATE-01: 既存cross-Session executionをorigin snapshotへ一度だけ補完する", () => {
    const db = createV6Schema();
    try {
      db.exec("DROP TABLE session_execution_origins_v6;");
      const insertSession = db.prepare(`
        INSERT INTO sessions_v6 (
          id, title, state, provider_id, catalog_revision, model_id,
          approval_mode, created_at, updated_at, last_active_at
        ) VALUES (?, ?, 'active', 'codex', 1, 'gpt-5', 'on-request', ?, ?, ?)
      `);
      insertSession.run("source-session", "Source", "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z");
      insertSession.run("target-session", "Target snapshot", "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z");
      db.prepare(`
        INSERT INTO session_messages_v6 (session_id, seq, role, body, created_at)
        VALUES ('source-session', 2, 'user', '{}', '2026-08-23T00:02:00.000Z')
      `).run();
      db.prepare(`
        INSERT INTO session_turns_v6 (
          session_id, phase, user_message_seq, started_at, updated_at
        ) VALUES ('source-session', 'running', 2, '2026-08-23T00:00:00.500Z', '2026-08-23T00:00:00.500Z')
      `).run();
      db.prepare(`
        INSERT INTO session_executions_v6 (
          id, session_id, operation, state, request_json, created_at, updated_at
        ) VALUES (?, ?, 'turn.enqueue', 'queued', ?, ?, ?)
      `).run(
        "legacy-cross-session",
        "target-session",
        JSON.stringify({
          initiator: { kind: "session", sessionId: "source-session" },
          turn: { userMessage: "legacy request" },
        }),
        "2026-08-23T00:00:01.000Z",
        "2026-08-23T00:00:01.000Z",
      );

      ensureV6Schema(db);
      db.prepare(`
        INSERT INTO session_executions_v6 (
          id, session_id, operation, state, request_json, created_at, updated_at
        ) VALUES (?, ?, 'turn.enqueue', 'queued', ?, ?, ?)
      `).run(
        "post-migration-cross-session",
        "target-session",
        JSON.stringify({
          initiator: { kind: "session", sessionId: "source-session" },
          turn: { userMessage: "must not be runtime-backfilled" },
        }),
        "2026-08-23T00:00:02.000Z",
        "2026-08-23T00:00:02.000Z",
      );
      ensureV6Schema(db);

      const origins = db.prepare(`
        SELECT execution_id, source_session_id, target_session_id,
               target_session_title_snapshot, target_session_role_snapshot,
               source_message_seq_anchor, user_message
        FROM session_execution_origins_v6
      `).all() as Array<Record<string, unknown>>;
      assert.deepEqual(origins.map((origin) => ({ ...origin })), [{
        execution_id: "legacy-cross-session",
        source_session_id: "source-session",
        target_session_id: "target-session",
        target_session_title_snapshot: "Target snapshot",
        target_session_role_snapshot: "standalone",
        source_message_seq_anchor: 2,
        user_message: "legacy request",
      }]);
      assert.equal(
        (db.prepare("SELECT COUNT(*) AS count FROM app_settings WHERE setting_key = 'session_execution_origins_v6_migrated_at'").get() as { count: number }).count,
        1,
      );
    } finally {
      db.close();
    }
  });

  it("ORCH-OUTBOUND-MIGRATE-02: terminal failure通知executionをAgent-originへ変換しない", () => {
    const db = createV6Schema();
    try {
      const insertSession = db.prepare(`
        INSERT INTO sessions_v6 (
          id, title, state, provider_id, catalog_revision, model_id,
          approval_mode, created_at, updated_at, last_active_at
        ) VALUES (?, ?, 'active', 'codex', 1, 'gpt-5', 'on-request', ?, ?, ?)
      `);
      insertSession.run("source-session", "Source", "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z");
      insertSession.run("target-session", "Target", "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z");
      const insertExecution = db.prepare(`
        INSERT INTO session_executions_v6 (
          id, session_id, operation, state, request_json, created_at, updated_at
        ) VALUES (?, ?, 'turn.enqueue', ?, ?, ?, ?)
      `);
      insertExecution.run(
        "source-execution",
        "source-session",
        "failed",
        JSON.stringify({ initiator: { kind: "user" }, turn: { userMessage: "failed" } }),
        "2026-08-23T00:00:01.000Z",
        "2026-08-23T00:00:01.000Z",
      );
      insertExecution.run(
        "notification-execution",
        "target-session",
        "queued",
        JSON.stringify({
          initiator: { kind: "session", sessionId: "source-session" },
          turn: { userMessage: "terminal failure notification" },
        }),
        "2026-08-23T00:00:02.000Z",
        "2026-08-23T00:00:02.000Z",
      );
      db.prepare(`
        INSERT INTO session_terminal_failure_notification_deliveries_v6 (
          id, source_execution_id, source_session_id, terminal_state, target_session_id,
          contract_version, state, enqueue_idempotency_key, notification_execution_id,
          attempt_count, next_attempt_at, deadline_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'failed', ?, 1, 'enqueued', ?, ?, 1, ?, ?, ?, ?)
      `).run(
        "delivery-1",
        "source-execution",
        "source-session",
        "target-session",
        "notification-key",
        "notification-execution",
        "2026-08-23T00:00:03.000Z",
        "2026-08-24T00:00:00.000Z",
        "2026-08-23T00:00:02.000Z",
        "2026-08-23T00:00:02.000Z",
      );

      ensureV6Schema(db);

      assert.equal(
        (db.prepare("SELECT COUNT(*) AS count FROM session_execution_origins_v6").get() as { count: number }).count,
        0,
      );
    } finally {
      db.close();
    }
  });

  it("ORCH-OUTBOUND-SCHEMA-01: origin tableのPK・UNIQUE・CHECK欠落を有効なV6 DBとして受理しない", () => {
    const dirPath = mkdtempSync(join(tmpdir(), "withmate-v6-origin-schema-"));
    try {
      const dbPath = join(dirPath, APP_DATABASE_V6_FILENAME);
      const db = createV6Schema(dbPath);
      db.exec(`
        PRAGMA foreign_keys = OFF;
        DROP TABLE session_execution_origins_v6;
        CREATE TABLE session_execution_origins_v6 (
          execution_id TEXT,
          execution_sequence INTEGER,
          source_session_id TEXT,
          target_session_id TEXT,
          operation TEXT,
          target_session_title_snapshot TEXT,
          target_session_role_snapshot TEXT,
          source_message_seq_anchor INTEGER,
          user_message TEXT,
          accepted_at TEXT
        );
        CREATE INDEX idx_v6_session_execution_origins_source_sequence
          ON session_execution_origins_v6(source_session_id, execution_sequence ASC);
      `);
      db.close();

      assert.equal(isValidV6Database(dbPath), false);
    } finally {
      rmSync(dirPath, { recursive: true, force: true });
    }
  });

  it("COORD-MIGRATE-01: Coordination storageはempty/populated DBへadditiveかつ再実行可能に適用する", () => {
    for (const populated of [false, true]) {
      const db = createV6Schema();
      try {
        db.exec("DROP TABLE coordination_event_idempotency_v6; DROP TABLE coordination_event_actions_v6; DROP TABLE coordination_events_v6;");
        if (populated) {
          db.prepare(`
            INSERT INTO sessions_v6 (
              id, title, state, provider_id, catalog_revision, model_id,
              approval_mode, created_at, updated_at, last_active_at
            ) VALUES ('coordination-existing', 'Existing', 'active', 'codex', 1, 'gpt-5',
              'on-request', ?, ?, ?)
          `).run("2026-08-21T00:00:00.000Z", "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:00.000Z");
        }
        ensureV6Schema(db);
        ensureV6Schema(db);
        assert.equal(tableNames(db).filter((name) => name === "coordination_events_v6").length, 1);
        assert.equal(tableSql(db, "coordination_events_v6").includes("json_array_length(options_json) BETWEEN 2 AND 8"), true);
        assert.equal(
          (db.prepare("SELECT COUNT(*) AS count FROM sessions_v6").get() as { count: number }).count,
          populated ? 1 : 0,
        );
      } finally {
        db.close();
      }
    }
  });

  it("COORD-RESPONSE-MIGRATE-01: 既存actionを保持しtrusted GUIのblocker responseをrespondedへ移行する", () => {
    const db = createV6Schema();
    try {
      db.exec("DROP TABLE coordination_event_idempotency_v6; DROP TABLE coordination_event_actions_v6;");
      const legacySql = CREATE_V6_COORDINATION_EVENT_TABLES_SQL
        .replace("'responded', 'resolved', 'cancelled', 'superseded', 'consumed'", "'resolved', 'cancelled', 'superseded'")
        .replace(`,
    CHECK (
      action_type <> 'consumed'
      OR (
        actor_type = 'session'
        AND actor_session_id IS NOT NULL
        AND option_id IS NULL
        AND note IS NULL
        AND related_event_id IS NULL
      )
    )`, "")
        .replace("'coordination.event.resolve', 'coordination.event.consume', 'coordination.event.cancel'", "'coordination.event.resolve', 'coordination.event.cancel'");
      db.exec(legacySql);
      db.prepare(`
        INSERT INTO sessions_v6 (
          id, title, state, provider_id, catalog_revision, model_id,
          approval_mode, created_at, updated_at, last_active_at
        ) VALUES ('consume-owner', 'Owner', 'active', 'codex', 1, 'gpt-5',
          'on-request', ?, ?, ?)
      `).run("2026-08-22T00:00:00.000Z", "2026-08-22T00:00:00.000Z", "2026-08-22T00:00:00.000Z");
      db.prepare(`
        INSERT INTO coordination_events_v6 (
          id, actor_session_id, session_role, role_contract_revision,
          root_session_id, parent_session_id, delegation_depth, kind,
          summary, payload_json, options_json, created_at
        ) VALUES (?, ?, 'standalone', 1, ?, NULL, 0, 'user_decision_required', ?, ?, ?, ?)
      `).run(
        "event-before-consume",
        "consume-owner",
        "consume-owner",
        "Which?",
        JSON.stringify({ summary: "Which?" }),
        JSON.stringify([{ id: "yes", label: "Yes" }, { id: "no", label: "No" }]),
        "2026-08-22T00:01:00.000Z",
      );
      db.prepare(`
        INSERT INTO coordination_event_actions_v6 (
          id, event_id, action_type, actor_type, actor_session_id,
          option_id, note, related_event_id, created_at
        ) VALUES (?, ?, 'resolved', 'trusted_gui', NULL, 'yes', NULL, NULL, ?)
      `).run("resolve-before-consume", "event-before-consume", "2026-08-22T00:02:00.000Z");
      db.prepare(`
        INSERT INTO coordination_events_v6 (
          id, actor_session_id, session_role, role_contract_revision,
          root_session_id, parent_session_id, delegation_depth, kind,
          summary, payload_json, options_json, created_at
        ) VALUES (?, ?, 'standalone', 1, ?, NULL, 0, 'blocker', ?, ?, '[]', ?)
      `).run(
        "blocker-before-responded",
        "consume-owner",
        "consume-owner",
        "Narrow layout",
        JSON.stringify({ summary: "Narrow layout" }),
        "2026-08-22T00:03:00.000Z",
      );
      db.prepare(`
        INSERT INTO coordination_event_actions_v6 (
          id, event_id, action_type, actor_type, actor_session_id,
          option_id, note, related_event_id, created_at
        ) VALUES (?, ?, 'resolved', 'trusted_gui', NULL, NULL, ?, NULL, ?)
      `).run(
        "blocker-response-before-responded",
        "blocker-before-responded",
        "タイトルとアイコンが若干重なっている",
        "2026-08-22T00:04:00.000Z",
      );
      db.prepare(`
        INSERT INTO coordination_event_idempotency_v6 (
          operation, principal_session_id, idempotency_key, request_fingerprint,
          result_event_id, target_event_id, created_at
        ) VALUES ('coordination.event.resolve', ?, ?, ?, ?, ?, ?)
      `).run(
        "consume-owner",
        "resolve-before-consume-key",
        "fingerprint",
        "event-before-consume",
        "event-before-consume",
        "2026-08-22T00:02:00.000Z",
      );

      ensureV6Schema(db);
      ensureV6Schema(db);

      assert.equal(tableSql(db, "coordination_event_actions_v6").includes("'consumed'"), true);
      assert.equal(tableSql(db, "coordination_event_actions_v6").includes("'responded'"), true);
      assert.equal(tableSql(db, "coordination_event_idempotency_v6").includes("'coordination.event.consume'"), true);
      assert.equal(
        (db.prepare("SELECT COUNT(*) AS count FROM coordination_event_actions_v6 WHERE id = ?").get("resolve-before-consume") as { count: number }).count,
        1,
      );
      assert.equal(
        (db.prepare("SELECT action_type FROM coordination_event_actions_v6 WHERE id = ?")
          .get("blocker-response-before-responded") as { action_type: string }).action_type,
        "responded",
      );
      assert.equal(
        (db.prepare("SELECT COUNT(*) AS count FROM coordination_event_idempotency_v6 WHERE idempotency_key = ?").get("resolve-before-consume-key") as { count: number }).count,
        1,
      );
    } finally {
      db.close();
    }
  });

  it("COORD-RESPONSE-MIGRATE-02: consume対応済みschemaにもrespondedを再実行可能に追加する", () => {
    const db = createV6Schema();
    try {
      db.exec("DROP TABLE coordination_event_idempotency_v6; DROP TABLE coordination_event_actions_v6;");
      db.exec(CREATE_V6_COORDINATION_EVENT_TABLES_SQL.replace(
        "'responded', 'resolved', 'cancelled', 'superseded', 'consumed'",
        "'resolved', 'cancelled', 'superseded', 'consumed'",
      ));
      db.prepare(`
        INSERT INTO sessions_v6 (
          id, title, state, provider_id, catalog_revision, model_id,
          approval_mode, created_at, updated_at, last_active_at
        ) VALUES ('response-owner', 'Owner', 'active', 'codex', 1, 'gpt-5',
          'on-request', ?, ?, ?)
      `).run("2026-08-22T00:00:00.000Z", "2026-08-22T00:00:00.000Z", "2026-08-22T00:00:00.000Z");
      db.prepare(`
        INSERT INTO coordination_events_v6 (
          id, actor_session_id, session_role, role_contract_revision,
          root_session_id, parent_session_id, delegation_depth, kind,
          summary, payload_json, options_json, created_at
        ) VALUES (?, ?, 'standalone', 1, ?, NULL, 0, 'blocker', ?, ?, '[]', ?)
      `).run(
        "current-blocker-response",
        "response-owner",
        "response-owner",
        "Narrow layout",
        JSON.stringify({ summary: "Narrow layout" }),
        "2026-08-22T00:01:00.000Z",
      );
      db.prepare(`
        INSERT INTO coordination_event_actions_v6 (
          id, event_id, action_type, actor_type, actor_session_id,
          option_id, note, related_event_id, created_at
        ) VALUES (?, ?, 'resolved', 'trusted_gui', NULL, NULL, ?, NULL, ?)
      `).run(
        "current-blocker-response-action",
        "current-blocker-response",
        "タイトルとアイコンが若干重なっている",
        "2026-08-22T00:02:00.000Z",
      );

      ensureV6Schema(db);
      ensureV6Schema(db);

      assert.equal(
        (db.prepare("SELECT action_type FROM coordination_event_actions_v6 WHERE id = ?")
          .get("current-blocker-response-action") as { action_type: string }).action_type,
        "responded",
      );
      assert.equal(tableNames(db).filter((name) => name === "coordination_event_actions_v6").length, 1);
    } finally {
      db.close();
    }
  });

  it("COORD-MIGRATE-01: malformed Coordination tableは途中適用せずmigrationを拒否する", () => {
    const db = createV6Schema();
    try {
      db.exec("DROP TABLE coordination_event_idempotency_v6; DROP TABLE coordination_event_actions_v6; DROP TABLE coordination_events_v6;");
      db.exec("CREATE TABLE coordination_events_v6 (id TEXT PRIMARY KEY);");
      const beforeTables = tableNames(db);
      assert.throws(() => ensureV6Schema(db), /Coordination event schema is invalid/);
      assert.deepEqual(tableNames(db), beforeTables);
      assert.deepEqual(columnNames(db, "coordination_events_v6"), ["id"]);
    } finally {
      db.close();
    }
  });

  it("COORD-MIGRATE-01: 必要列が揃っていてもCoordination CHECKが一つ欠けたschemaを拒否する", () => {
    const cases = [
      {
        tableName: "coordination_events_v6",
        fragment: "kind TEXT NOT NULL CHECK (kind IN ('progress', 'decision', 'escalation', 'user_decision_required', 'blocker', 'result', 'correction'))",
        replacement: "kind TEXT NOT NULL",
      },
      {
        tableName: "coordination_events_v6",
        fragment: "CHECK ((kind = 'escalation') = (target_session_id IS NOT NULL))",
        replacement: "CHECK (1)",
      },
      {
        tableName: "coordination_event_actions_v6",
        fragment: "action_type TEXT NOT NULL CHECK (action_type IN ('responded', 'resolved', 'cancelled', 'superseded', 'consumed'))",
        replacement: "action_type TEXT NOT NULL",
      },
      {
        tableName: "coordination_event_actions_v6",
        fragment: `CHECK (
      action_type <> 'consumed'
      OR (
        actor_type = 'session'
        AND actor_session_id IS NOT NULL
        AND option_id IS NULL
        AND note IS NULL
        AND related_event_id IS NULL
      )
    )`,
        replacement: "CHECK (1)",
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const directory = mkdtempSync(join(tmpdir(), `withmate-coordination-near-miss-${index}-`));
      const dbPath = join(directory, APP_DATABASE_V6_FILENAME);
      const db = createV6Schema(dbPath);
      try {
        const originalSql = tableSql(db, testCase.tableName);
        assert.equal(originalSql.includes(testCase.fragment), true);
        db.exec("PRAGMA foreign_keys = OFF;");
        db.exec(originalSql
          .replace(`CREATE TABLE ${testCase.tableName}`, `CREATE TABLE ${testCase.tableName}_rebuilt`)
          .replace(testCase.fragment, testCase.replacement));
        db.exec(`DROP TABLE ${testCase.tableName};`);
        db.exec(`ALTER TABLE ${testCase.tableName}_rebuilt RENAME TO ${testCase.tableName};`);
        if (testCase.tableName === "coordination_events_v6") {
          db.exec(`
            CREATE INDEX idx_v6_coordination_events_actor_sequence
              ON coordination_events_v6(actor_session_id, sequence DESC);
            CREATE INDEX idx_v6_coordination_events_root_sequence
              ON coordination_events_v6(root_session_id, sequence DESC);
            CREATE INDEX idx_v6_coordination_events_target
              ON coordination_events_v6(target_session_id, sequence DESC);
          `);
        } else {
          db.exec(`
            CREATE INDEX idx_v6_coordination_event_actions_event_sequence
              ON coordination_event_actions_v6(event_id, sequence ASC);
          `);
        }

        assert.throws(() => ensureV6Schema(db), /Coordination event schema is invalid/);
      } finally {
        db.close();
      }
      try {
        assert.equal(isValidV6Database(dbPath), false);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("TN-MIGRATE-07: malformed delivery tableは途中適用せずmigrationを拒否する", () => {
    const db = createV6Schema();
    try {
      db.exec("DROP TABLE session_terminal_failure_notification_deliveries_v6;");
      db.exec("CREATE TABLE session_terminal_failure_notification_deliveries_v6 (id TEXT PRIMARY KEY);");
      const beforeTables = tableNames(db);

      assert.throws(() => ensureV6Schema(db), /delivery schema is invalid/);
      assert.deepEqual(tableNames(db), beforeTables);
      assert.deepEqual(columnNames(db, "session_terminal_failure_notification_deliveries_v6"), ["id"]);
    } finally {
      db.close();
    }
  });

  it("TN-SCHEMA-11: delivery schemaはidentity uniquenessとclaim/state tuple制約を必須にする", () => {
    const variants = [
      CREATE_V6_SESSION_TERMINAL_FAILURE_NOTIFICATION_DELIVERIES_TABLE_SQL.replace(
        "source_execution_id TEXT NOT NULL UNIQUE",
        "source_execution_id TEXT NOT NULL",
      ),
      CREATE_V6_SESSION_TERMINAL_FAILURE_NOTIFICATION_DELIVERIES_TABLE_SQL.replace(
        "enqueue_idempotency_key TEXT NOT NULL UNIQUE",
        "enqueue_idempotency_key TEXT NOT NULL",
      ),
      CREATE_V6_SESSION_TERMINAL_FAILURE_NOTIFICATION_DELIVERIES_TABLE_SQL.replace(
        "    CHECK ((claim_token IS NULL) = (claimed_at IS NULL)),\n",
        "",
      ),
      CREATE_V6_SESSION_TERMINAL_FAILURE_NOTIFICATION_DELIVERIES_TABLE_SQL.replace(
        `    CHECK ((claim_token IS NULL) = (claimed_at IS NULL)),
    CHECK (
      (state = 'pending' AND notification_execution_id IS NULL AND error_code IS NULL)
      OR (state = 'enqueued' AND notification_execution_id IS NOT NULL AND error_code IS NULL AND claim_token IS NULL)
      OR (state = 'failed' AND notification_execution_id IS NULL AND error_code IS NOT NULL AND claim_token IS NULL)
    )\n`,
        "    CHECK ((claim_token IS NULL) = (claimed_at IS NULL))\n",
      ),
    ];

    for (const malformedSql of variants) {
      const db = createV6Schema();
      try {
        db.exec("DROP TABLE session_terminal_failure_notification_deliveries_v6;");
        db.exec(malformedSql);
        assert.throws(() => ensureV6Schema(db), /delivery schema is invalid/);
      } finally {
        db.close();
      }
    }
  });

  it("ensureV6Schemaは既存Session file write tableをrejected対応へ更新する", () => {
    const db = createV6Schema();
    try {
      db.exec("DROP TABLE session_file_write_idempotency_v6;");
      db.exec(`
        CREATE TABLE session_file_write_idempotency_v6 (
          operation TEXT NOT NULL CHECK (operation = 'session.files.write_text'),
          idempotency_key TEXT NOT NULL,
          request_fingerprint TEXT NOT NULL,
          session_id TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          temp_name TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending', 'applied')),
          output_sha256 TEXT,
          byte_length INTEGER,
          file_device TEXT,
          file_inode TEXT,
          result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          PRIMARY KEY (operation, idempotency_key),
          FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE
        );
      `);
      db.prepare(`
        INSERT INTO sessions_v6 (
          id, title, state, provider_id, catalog_revision, model_id, approval_mode,
          created_at, updated_at, last_active_at
        ) VALUES (?, ?, 'active', 'codex', 1, 'gpt-5', 'on-request', ?, ?, ?)
      `).run(
        "session-files-migration",
        "Session files migration",
        "2026-08-12T00:00:00.000Z",
        "2026-08-12T00:00:00.000Z",
        "2026-08-12T00:00:00.000Z",
      );
      const insertLegacyWrite = db.prepare(`
        INSERT INTO session_file_write_idempotency_v6 (
          operation, idempotency_key, request_fingerprint, session_id, relative_path,
          temp_name, state, output_sha256, byte_length, file_device, file_inode,
          result_json, created_at, expires_at
        ) VALUES ('session.files.write_text', ?, ?, 'session-files-migration', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertLegacyWrite.run(
        "pending-key", "pending-fingerprint", "pending.txt", ".pending.tmp", "pending",
        "a".repeat(64), 12, "1", "2", null,
        "2026-08-12T00:00:00.000Z", "2026-08-13T00:00:00.000Z",
      );
      insertLegacyWrite.run(
        "applied-key", "applied-fingerprint", "applied.txt", ".applied.tmp", "applied",
        "b".repeat(64), 13, "1", "3",
        JSON.stringify({ file: { sessionId: "session-files-migration", relativePath: "applied.txt" } }),
        "2026-08-12T00:01:00.000Z", "2026-08-13T00:01:00.000Z",
      );
      db.exec(`
        DROP TABLE session_transcript_export_idempotency_v6;
        CREATE TABLE session_transcript_export_idempotency_v6 (
          operation TEXT NOT NULL CHECK (operation = 'transcript.export'),
          idempotency_key TEXT NOT NULL,
          request_fingerprint TEXT NOT NULL,
          session_id TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          temp_name TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'rejected')),
          output_sha256 TEXT,
          byte_length INTEGER,
          result_json TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          PRIMARY KEY (operation, idempotency_key),
          FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE
        );
        INSERT INTO session_transcript_export_idempotency_v6 (
          operation, idempotency_key, request_fingerprint, session_id, relative_path,
          temp_name, state, output_sha256, byte_length, created_at, expires_at
        ) VALUES (
          'transcript.export', 'legacy-prepared', 'legacy-fingerprint',
          'session-files-migration', 'legacy.json', '.legacy.tmp', 'pending',
          '${"c".repeat(64)}', 42, '2026-08-12T00:00:00.000Z', '2026-08-13T00:00:00.000Z'
        );
      `);

      ensureV6Schema(db);
      ensureV6Schema(db);

      assert.equal(tableSql(db, "session_file_write_idempotency_v6").includes("'rejected'"), true);
      assert.equal(tableSql(db, "session_file_write_idempotency_v6").includes("file_device TEXT"), true);
      assert.equal(tableSql(db, "session_file_write_idempotency_v6").includes("file_inode TEXT"), true);
      assert.equal(tableNames(db).includes("session_file_write_idempotency_v6_legacy"), false);
      const migratedWrites = db.prepare(`
          SELECT idempotency_key, state, result_json
          FROM session_file_write_idempotency_v6
          ORDER BY idempotency_key
        `).all() as Array<{
          idempotency_key: string;
          state: string;
          result_json: string | null;
        }>;
      assert.deepEqual(
        migratedWrites.map((row) => ({ ...row })),
        [
          {
            idempotency_key: "applied-key",
            state: "applied",
            result_json: JSON.stringify({
              file: { sessionId: "session-files-migration", relativePath: "applied.txt" },
            }),
          },
          {
            idempotency_key: "pending-key",
            state: "rejected",
            result_json: JSON.stringify({
              code: "RUNTIME_UNAVAILABLE",
              message: "A legacy pending file publish proof cannot be recovered safely.",
              retryable: false,
              details: { reason: "legacy_publish_proof_missing_target_precondition" },
              effect: "indeterminate",
            }),
          },
        ],
      );
      const transcriptProof = db.prepare(`
        SELECT state, result_json, output_sha256, byte_length, output_device, output_inode
        FROM session_transcript_export_idempotency_v6
        WHERE idempotency_key = 'legacy-prepared'
      `).get() as {
        state: string;
        result_json: string | null;
        output_sha256: string | null;
        byte_length: number | null;
        output_device: string | null;
        output_inode: string | null;
      };
      assert.deepEqual({ ...transcriptProof }, {
        state: "rejected",
        result_json: JSON.stringify({
          code: "EXPORT_FAILED",
          message: "A legacy pending transcript publish proof cannot be recovered safely.",
          retryable: false,
          details: { reason: "legacy_publish_proof_missing_target_precondition" },
          effect: "indeterminate",
        }),
        output_sha256: null,
        byte_length: null,
        output_device: null,
        output_inode: null,
      });
    } finally {
      db.close();
    }
  });

  it("ensureV6Schemaは既存interactionとidempotencyを保持してexecution expiry reasonを追加する", () => {
    const db = createV6Schema();
    try {
      db.exec("PRAGMA foreign_keys = ON;");
      db.prepare(`
        INSERT INTO sessions_v6 (
          id, title, state, provider_id, catalog_revision, model_id, approval_mode,
          created_at, updated_at, last_active_at
        ) VALUES ('interaction-migration', 'Migration', 'active', 'codex', 1, 'gpt-5',
          'on-request', ?, ?, ?)
      `).run("2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
      db.prepare(`
        INSERT INTO session_executions_v6 (
          id, session_id, operation, state, request_json, created_at, updated_at
        ) VALUES ('execution-migration', 'interaction-migration', 'turn.run', 'running', '{}', ?, ?)
      `).run("2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
      db.exec("DROP TABLE session_interaction_idempotency_v6; DROP TABLE session_interactions_v6;");
      db.exec(CREATE_V6_SESSION_INTERACTIONS_TABLE_SQL
        .replace("'runtime_shutdown',\n      'execution_canceled',\n      'execution_terminal'", "'runtime_shutdown'"));
      db.exec(CREATE_V6_SESSION_INTERACTION_IDEMPOTENCY_TABLE_SQL);
      db.prepare(`
        INSERT INTO session_interactions_v6 (
          id, execution_id, kind, state, public_payload_json, created_at, updated_at
        ) VALUES ('interaction-legacy', 'execution-migration', 'approval', 'pending', '{}', ?, ?)
      `).run("2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
      db.prepare(`
        INSERT INTO session_interaction_idempotency_v6 (
          operation, idempotency_key, request_fingerprint, interaction_id, created_at, expires_at
        ) VALUES ('interaction.respond', 'response-legacy', 'fingerprint', 'interaction-legacy', ?, ?)
      `).run("2026-08-13T00:00:00.000Z", "2026-08-14T00:00:00.000Z");

      ensureV6Schema(db);

      const schema = db.prepare(`
        SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'session_interactions_v6'
      `).get() as { sql: string };
      assert.equal(schema.sql.includes("'execution_terminal'"), true);
      assert.equal((db.prepare(`
        SELECT COUNT(*) AS count FROM session_interactions_v6 WHERE id = 'interaction-legacy'
      `).get() as { count: number }).count, 1);
      assert.equal((db.prepare(`
        SELECT COUNT(*) AS count FROM session_interaction_idempotency_v6 WHERE idempotency_key = 'response-legacy'
      `).get() as { count: number }).count, 1);
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

      const missingAffectProvenanceDir = join(dirPath, "missing-affect-provenance");
      mkdirSync(missingAffectProvenanceDir);
      const missingAffectProvenancePath = join(missingAffectProvenanceDir, APP_DATABASE_V6_FILENAME);
      const missingAffectProvenanceDb = createV6Schema(missingAffectProvenancePath);
      const mutationSql = tableSql(missingAffectProvenanceDb, "character_affect_mutations_v6");
      missingAffectProvenanceDb.exec("PRAGMA foreign_keys = OFF;");
      missingAffectProvenanceDb.exec(mutationSql
        .replace("CREATE TABLE character_affect_mutations_v6", "CREATE TABLE character_affect_mutations_v6_rebuilt")
        .replace("    FOREIGN KEY (source_session_id) REFERENCES sessions_v6(id) ON DELETE SET NULL,\n", ""));
      missingAffectProvenanceDb.exec("DROP TABLE character_affect_mutations_v6;");
      missingAffectProvenanceDb.exec(
        "ALTER TABLE character_affect_mutations_v6_rebuilt RENAME TO character_affect_mutations_v6;",
      );
      missingAffectProvenanceDb.exec(`
        CREATE INDEX idx_v6_character_affect_mutations_scope
        ON character_affect_mutations_v6(character_id, user_id, created_at DESC, id DESC)
      `);
      assert.equal(columnNames(missingAffectProvenanceDb, "character_affect_mutations_v6").includes("source_session_id"), true);
      assert.equal(
        hasForeignKey(missingAffectProvenanceDb, "character_affect_mutations_v6", "source_session_id", "sessions_v6"),
        false,
      );
      missingAffectProvenanceDb.close();

      const wrongAffectProvenanceDeleteDir = join(dirPath, "wrong-affect-provenance-delete");
      mkdirSync(wrongAffectProvenanceDeleteDir);
      const wrongAffectProvenanceDeletePath = join(
        wrongAffectProvenanceDeleteDir,
        APP_DATABASE_V6_FILENAME,
      );
      const wrongAffectProvenanceDeleteDb = createV6Schema(wrongAffectProvenanceDeletePath);
      const wrongDeleteMutationSql = tableSql(wrongAffectProvenanceDeleteDb, "character_affect_mutations_v6");
      wrongAffectProvenanceDeleteDb.exec("PRAGMA foreign_keys = OFF;");
      wrongAffectProvenanceDeleteDb.exec(wrongDeleteMutationSql
        .replace("CREATE TABLE character_affect_mutations_v6", "CREATE TABLE character_affect_mutations_v6_rebuilt")
        .replace(
          "FOREIGN KEY (source_session_id) REFERENCES sessions_v6(id) ON DELETE SET NULL",
          "FOREIGN KEY (source_session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE",
        ));
      wrongAffectProvenanceDeleteDb.exec("DROP TABLE character_affect_mutations_v6;");
      wrongAffectProvenanceDeleteDb.exec(
        "ALTER TABLE character_affect_mutations_v6_rebuilt RENAME TO character_affect_mutations_v6;",
      );
      wrongAffectProvenanceDeleteDb.exec(`
        CREATE INDEX idx_v6_character_affect_mutations_scope
        ON character_affect_mutations_v6(character_id, user_id, created_at DESC, id DESC)
      `);
      wrongAffectProvenanceDeleteDb.close();

      const missingAffectStateCheckDir = join(dirPath, "missing-affect-state-check");
      mkdirSync(missingAffectStateCheckDir);
      const missingAffectStateCheckPath = join(missingAffectStateCheckDir, APP_DATABASE_V6_FILENAME);
      const missingAffectStateCheckDb = createV6Schema(missingAffectStateCheckPath);
      const affectEventsSql = tableSql(missingAffectStateCheckDb, "character_affect_events_v6");
      missingAffectStateCheckDb.exec("PRAGMA foreign_keys = OFF;");
      missingAffectStateCheckDb.exec(affectEventsSql
        .replace("CREATE TABLE character_affect_events_v6", "CREATE TABLE character_affect_events_v6_rebuilt")
        .replace("state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'corrected'))", "state TEXT NOT NULL DEFAULT 'active'"));
      missingAffectStateCheckDb.exec("DROP TABLE character_affect_events_v6;");
      missingAffectStateCheckDb.exec(
        "ALTER TABLE character_affect_events_v6_rebuilt RENAME TO character_affect_events_v6;",
      );
      missingAffectStateCheckDb.exec(`
        CREATE INDEX idx_v6_character_affect_events_effective
        ON character_affect_events_v6(character_id, user_id, layer, session_id, state, occurred_at, id);

        CREATE INDEX idx_v6_character_affect_events_target
        ON character_affect_events_v6(character_id, user_id, target_type, target_id, occurred_at, id)
      `);
      missingAffectStateCheckDb.close();

      assert.equal(isValidV6Database(validDbPath), true);
      assert.equal(readV6DatabaseUserVersion(validDbPath), APP_DATABASE_V6_SCHEMA_VERSION);
      assert.equal(isValidV6Database(wrongNameDbPath), false);
      assert.equal(readV6DatabaseUserVersion(wrongNameDbPath), null);
      assert.equal(isValidV6Database(emptyV6DbPath), false);
      assert.equal(isValidV6Database(partialV6DbPath), false);
      assert.equal(isValidV6Database(malformedV6DbPath), false);
      assert.equal(isValidV6Database(legacyMixedV6DbPath), false);
      assert.equal(isValidV6Database(missingAffectProvenancePath), false);
      assert.equal(isValidV6Database(wrongAffectProvenanceDeletePath), false);
      assert.equal(isValidV6Database(missingAffectStateCheckPath), false);
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
        "is_pinned",
        "created_at",
        "updated_at",
        "last_active_at",
      ]);
      assert.equal(findForeignKey(db, "sessions_v6", "character_id")?.table, "characters");
      assert.equal(findForeignKey(db, "sessions_v6", "project_scope_id")?.table, "project_scopes_v6");
      assert.equal(tableSql(db, "sessions_v6").includes("json_valid(character_snapshot_json)"), true);
      assert.equal(tableSql(db, "sessions_v6").includes("allowed_additional_directories_json TEXT NOT NULL DEFAULT '[]'"), true);
      assert.equal(tableSql(db, "sessions_v6").includes("is_pinned INTEGER NOT NULL DEFAULT 0"), true);

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
        "cleanup_pending_count",
        "created_at",
      ]);
      assert.equal(
        tableSql(db, "memory_idempotency_keys_v6").includes(
          "PRIMARY KEY (binding_id_hash, key, operation, owner_type, owner_id, scope_type, scope_id)",
        ),
        true,
      );
      assert.equal(tableSql(db, "memory_idempotency_keys_v6").includes("request_fingerprint TEXT NOT NULL"), true);
      assert.equal(tableSql(db, "memory_idempotency_keys_v6").includes("cleanup_pending_count INTEGER NOT NULL DEFAULT 0"), true);
      assert.deepEqual(columnNames(db, "memory_target_tag_stats_v6"), [
        "owner_type",
        "owner_id",
        "scope_type",
        "scope_id",
        "tag_type",
        "tag_value",
        "tag_type_canonical",
        "tag_value_canonical",
        "usage_count",
        "latest_entry_updated_at",
      ]);

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
      assert.equal(tableSql(db, "memory_mutation_events_v6").includes("source_message_id TEXT"), true);
      assert.equal(tableSql(db, "memory_mutation_events_v6").includes("result_status TEXT NOT NULL"), true);
      assert.equal(tableSql(db, "memory_mutation_events_v6").includes("'already_forgotten'"), true);
      assert.equal(tableSql(db, "memory_move_events_v6").includes("reason TEXT NOT NULL"), true);

      assert.deepEqual(columnNames(db, "memory_protected_objects_v6"), [
        "object_id",
        "entry_id",
        "state",
        "role",
        "media_kind",
        "content_type",
        "display_name",
        "summary",
        "original_bytes",
        "stored_bytes",
        "sha256",
        "key_id",
        "created_at",
        "updated_at",
        "deleted_at",
      ]);
      assert.equal(findForeignKey(db, "memory_protected_objects_v6", "entry_id")?.table, "memory_entries_v6");
      assert.equal(tableSql(db, "memory_protected_objects_v6").includes("'active', 'delete_pending', 'deleted'"), true);
      assert.equal(tableSql(db, "memory_protected_objects_v6").includes("'evidence', 'source', 'snapshot', 'artifact', 'reference', 'other'"), true);
      assert.equal(tableSql(db, "memory_protected_objects_v6").includes("original_bytes >= 0"), true);
      assert.equal(tableSql(db, "memory_protected_objects_v6").includes("stored_bytes >= 0"), true);
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

  it("ensureV6Schema は既存Memory idempotencyとmutation/move eventへ列をadditive追加する", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE memory_idempotency_keys_v6 (
          key TEXT NOT NULL,
          operation TEXT NOT NULL,
          binding_id_hash TEXT NOT NULL,
          owner_type TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          scope_type TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          response_entry_id TEXT,
          operation_created INTEGER NOT NULL,
          request_fingerprint TEXT NOT NULL,
          cleanup_required INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          PRIMARY KEY (binding_id_hash, key, operation, owner_type, owner_id, scope_type, scope_id)
        );
        CREATE TABLE memory_mutation_events_v6 (
          id TEXT PRIMARY KEY,
          operation TEXT NOT NULL,
          entry_id TEXT,
          binding_id_hash TEXT,
          session_id TEXT,
          result_status TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );
        CREATE TABLE memory_move_events_v6 (
          id TEXT PRIMARY KEY,
          entry_id TEXT NOT NULL,
          from_owner_type TEXT NOT NULL,
          from_owner_id TEXT NOT NULL,
          from_scope_type TEXT NOT NULL,
          from_scope_id TEXT NOT NULL,
          to_owner_type TEXT NOT NULL,
          to_owner_id TEXT NOT NULL,
          to_scope_type TEXT NOT NULL,
          to_scope_id TEXT NOT NULL,
          binding_id_hash TEXT NOT NULL,
          idempotency_key TEXT,
          request_fingerprint TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO memory_idempotency_keys_v6 (
          key, operation, binding_id_hash, owner_type, owner_id, scope_type, scope_id,
          response_entry_id, operation_created, request_fingerprint, cleanup_required, created_at
        ) VALUES (
          'cleanup-key', 'append', 'local-user', 'project', 'project-a', 'project', 'project-a',
          NULL, 1, 'fingerprint', 1, '2026-08-13T00:00:00.000Z'
        );
      `);

      ensureV6Schema(db);

      assert.equal(columnNames(db, "memory_idempotency_keys_v6").includes("cleanup_pending_count"), true);
      assert.equal(
        (db.prepare("SELECT cleanup_pending_count FROM memory_idempotency_keys_v6 WHERE key = 'cleanup-key'").get() as { cleanup_pending_count: number }).cleanup_pending_count,
        1,
      );
      assert.equal(columnNames(db, "memory_mutation_events_v6").includes("source_message_id"), true);
      assert.equal(columnNames(db, "memory_move_events_v6").includes("reason"), true);
    } finally {
      db.close();
    }
  });

  it("ensureV6Schemaは既存Affect eventを再分類せずnullable familyとCHECKをadditive追加する", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON;");
      for (const statement of CREATE_V6_SCHEMA_SQL) {
        if (statement !== CREATE_V6_CHARACTER_AFFECT_TABLES_SQL) {
          db.exec(statement);
        }
      }
      db.exec(CREATE_V6_CHARACTER_AFFECT_TABLES_SQL.replace(
        "    family TEXT CHECK (family IS NULL OR family IN ('joy', 'relief', 'interest', 'anticipation', 'affinity', 'gratitude', 'concern', 'frustration', 'disappointment', 'regret', 'determination', 'other')),\n",
        "",
      ));
      db.prepare("INSERT INTO characters (id, name, created_at, updated_at) VALUES ('character-a', 'A', ?, ?)")
        .run("2026-08-09T00:00:00.000Z", "2026-08-09T00:00:00.000Z");
      db.prepare(`
        INSERT INTO sessions_v6 (
          id, title, state, provider_id, catalog_revision, model_id, approval_mode,
          character_id, character_snapshot_json, created_at, updated_at, last_active_at
        ) VALUES ('session-a', 'A', 'active', 'codex', 1, 'gpt-5', 'on-request', 'character-a', '{}', ?, ?, ?)
      `).run("2026-08-09T00:00:00.000Z", "2026-08-09T00:00:00.000Z", "2026-08-09T00:00:00.000Z");
      insertStandaloneRoleBinding(db, "session-a");
      db.prepare(`
        INSERT INTO character_affect_events_v6 (
          id, character_id, user_id, session_id, source_session_id, layer, target_type, target_id,
          value_json, intensity, reason, evidence, occurred_at, idempotency_key,
          request_fingerprint, state, created_at
        ) VALUES ('legacy-event', 'character-a', 'local-user', 'session-a', 'session-a', 'session',
          'bug', 'bug-1', '{"label":"legacy","valence":-0.2}', 0.5, 'reason', 'evidence',
          '2026-08-09T01:00:00.000Z', 'legacy-key', 'legacy-fingerprint', 'active', '2026-08-09T01:00:00.000Z')
      `).run();

      ensureV6Schema(db);
      ensureV6Schema(db);

      assert.equal(columnNames(db, "character_affect_events_v6").includes("family"), true);
      assert.equal(
        (db.prepare("SELECT family FROM character_affect_events_v6 WHERE id = 'legacy-event'").get() as { family: string | null }).family,
        null,
      );
      assert.throws(
        () => db.prepare("UPDATE character_affect_events_v6 SET family = 'unknown' WHERE id = 'legacy-event'").run(),
        /CHECK constraint failed/,
      );
      db.prepare("UPDATE character_affect_events_v6 SET family = 'other' WHERE id = 'legacy-event'").run();
      assert.equal(
        (db.prepare("SELECT family FROM character_affect_events_v6 WHERE id = 'legacy-event'").get() as { family: string }).family,
        "other",
      );
    } finally {
      db.close();
    }
  });

  it("ensureV6Schema は既存 protected object metadata に role を backfill する", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
      `);

      for (const statement of CREATE_V6_SCHEMA_SQL) {
        if (statement !== CREATE_V6_MEMORY_PROTECTED_OBJECTS_TABLE_SQL) {
          db.exec(statement);
        }
      }

      db.exec(`
        CREATE TABLE memory_protected_objects_v6 (
          object_id TEXT PRIMARY KEY,
          entry_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('active', 'delete_pending', 'deleted')),
          media_kind TEXT NOT NULL DEFAULT 'other',
          content_type TEXT NOT NULL DEFAULT '',
          display_name TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL,
          original_bytes INTEGER NOT NULL CHECK (original_bytes >= 0),
          stored_bytes INTEGER NOT NULL CHECK (stored_bytes >= 0),
          sha256 TEXT NOT NULL DEFAULT '',
          key_id TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT,
          FOREIGN KEY (entry_id) REFERENCES memory_entries_v6(id) ON DELETE CASCADE,
          CHECK ((state = 'deleted') = (deleted_at IS NOT NULL))
        );
      `);

      ensureV6Schema(db);

      assert.equal(columnNames(db, "memory_protected_objects_v6").includes("role"), true);
      assert.equal(tableSql(db, "memory_protected_objects_v6").includes("'evidence', 'source', 'snapshot', 'artifact', 'reference', 'other'"), true);
    } finally {
      db.close();
    }
  });

  it("ensureV6Schema はデータ入り auxiliary_sessions rebuild 後も Turn graph と audit owner を保持して再実行時に収束する", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "withmate-v6-schema-"));
    const dbPath = join(tempDir, APP_DATABASE_V6_FILENAME);
    let db: DatabaseSync | null = null;
    let auditStorage: AuditLogStorageV6 | null = null;
    try {
      db = new DatabaseSync(dbPath);
      db.exec("PRAGMA foreign_keys = ON;");

      for (const statement of CREATE_V6_SCHEMA_SQL) {
        if (
          statement !== CREATE_V6_AUXILIARY_SESSIONS_TABLE_SQL
          && statement !== CREATE_V6_SESSION_TURN_PUBLIC_CONTEXT_TABLE_SQL
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
          updated_at TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          FOREIGN KEY (parent_session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE
        );

        CREATE TABLE audit_events_v6 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT,
          auxiliary_session_id TEXT,
          event_type TEXT NOT NULL,
          provider_id TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL DEFAULT '',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE SET NULL,
          FOREIGN KEY (auxiliary_session_id) REFERENCES auxiliary_sessions(id) ON DELETE SET NULL
        );

        CREATE TABLE session_turn_public_context_v6 (
          turn_id INTEGER PRIMARY KEY,
          session_id TEXT NOT NULL,
          execution_id TEXT NOT NULL UNIQUE,
          effective_turn_json TEXT NOT NULL CHECK (json_valid(effective_turn_json)),
          attachments_json TEXT NOT NULL CHECK (json_valid(attachments_json)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (turn_id) REFERENCES session_turns_v6(id) ON DELETE CASCADE,
          FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE,
          FOREIGN KEY (execution_id) REFERENCES session_executions_v6(id) ON DELETE CASCADE
        );

        CREATE INDEX idx_audit_events_v6_session_created
          ON audit_events_v6(session_id, created_at DESC, id DESC);
        CREATE INDEX idx_audit_events_v6_auxiliary_created
          ON audit_events_v6(auxiliary_session_id, created_at DESC, id DESC);
        CREATE INDEX idx_audit_events_v6_event_type_created
          ON audit_events_v6(event_type, created_at DESC);

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
          'aux-1',
          'session-1',
          'active',
          '2026-07-04T01:00:00.000Z',
          '{}'
        );

        INSERT INTO session_executions_v6 (
          id,
          session_id,
          operation,
          state,
          request_json,
          created_at,
          updated_at
        ) VALUES (
          'execution-aux-1',
          'session-1',
          'turn.run',
          'completed',
          '{}',
          '2026-07-04T01:01:00.000Z',
          '2026-07-04T01:03:00.000Z'
        );

        INSERT INTO session_turns_v6 (
          id,
          auxiliary_session_id,
          phase,
          provider_id,
          model_id,
          reasoning_effort,
          approval_mode,
          sandbox_mode,
          thread_id,
          summary,
          started_at,
          completed_at,
          updated_at
        ) VALUES (
          41,
          'aux-1',
          'completed',
          'codex',
          'gpt-5',
          'medium',
          'on-request',
          'workspace-write',
          'thread-aux-1',
          'Auxiliary summary',
          '2026-07-04T01:01:00.000Z',
          '2026-07-04T01:03:00.000Z',
          '2026-07-04T01:03:00.000Z'
        );

        INSERT INTO session_turn_interims_v6 (
          id, turn_id, seq, body, source, created_at
        ) VALUES (
          51, 41, 0, 'interim response', 'running_snapshot', '2026-07-04T01:02:00.000Z'
        );

        INSERT INTO session_turn_provider_outputs_v6 (
          id, turn_id, seq, provider_id, kind, summary, payload_json, created_at
        ) VALUES (
          61, 41, 0, 'codex', 'usage', 'usage summary', '{"inputTokens":3}',
          '2026-07-04T01:03:00.000Z'
        );

        INSERT INTO session_turn_public_context_v6 (
          turn_id,
          session_id,
          execution_id,
          effective_turn_json,
          attachments_json,
          created_at,
          updated_at
        ) VALUES (
          41,
          'session-1',
          'execution-aux-1',
          '{"provider":"codex"}',
          '[{"name":"evidence.txt"}]',
          '2026-07-04T01:01:00.000Z',
          '2026-07-04T01:03:00.000Z'
        );
      `);

      db.prepare(`
        INSERT INTO audit_events_v6 (
          session_id,
          auxiliary_session_id,
          event_type,
          provider_id,
          summary,
          metadata_json,
          created_at
        ) VALUES (?, ?, 'session_turn', 'codex', 'Auxiliary summary', ?, ?)
      `).run(
        null,
        "aux-1",
        JSON.stringify({
          sessionId: "aux-1",
          createdAt: "2026-07-04T01:02:00.000Z",
          phase: "turn",
          provider: "codex",
          model: "gpt-5",
          reasoningEffort: "medium",
          approvalMode: "on-request",
          threadId: "",
          logicalPrompt: { messages: [] },
          transportPayload: null,
          assistantText: "assistant response",
          operations: [],
          rawItemsJson: "[]",
          usage: null,
          errorMessage: "",
        }),
        "2026-07-04T01:02:00.000Z",
      );

      insertStandaloneRoleBinding(db, "session-1");
      ensureV6Schema(db);
      ensureV6Schema(db);

      const auxiliaryTurn = db.prepare(`
        SELECT id, auxiliary_session_id, phase, summary
        FROM session_turns_v6
        WHERE id = 41
      `).get() as {
        id: number;
        auxiliary_session_id: string;
        phase: string;
        summary: string;
      } | undefined;
      assert.deepEqual({ ...auxiliaryTurn }, {
        id: 41,
        auxiliary_session_id: "aux-1",
        phase: "completed",
        summary: "Auxiliary summary",
      });

      const interim = db.prepare(`
        SELECT id, turn_id, seq, body, source
        FROM session_turn_interims_v6
        WHERE id = 51
      `).get();
      assert.deepEqual({ ...interim }, {
        id: 51,
        turn_id: 41,
        seq: 0,
        body: "interim response",
        source: "running_snapshot",
      });

      const providerOutput = db.prepare(`
        SELECT id, turn_id, seq, kind, payload_json
        FROM session_turn_provider_outputs_v6
        WHERE id = 61
      `).get();
      assert.deepEqual({ ...providerOutput }, {
        id: 61,
        turn_id: 41,
        seq: 0,
        kind: "usage",
        payload_json: '{"inputTokens":3}',
      });

      const publicContext = db.prepare(`
        SELECT turn_id, session_id, execution_id, effective_turn_json, attachments_json
        FROM session_turn_public_context_v6
        WHERE turn_id = 41
      `).get();
      assert.deepEqual({ ...publicContext }, {
        turn_id: 41,
        session_id: "session-1",
        execution_id: "execution-aux-1",
        effective_turn_json: '{"provider":"codex"}',
        attachments_json: '[{"name":"evidence.txt"}]',
      });

      const auditOwner = db.prepare(`
        SELECT auxiliary_session_id
        FROM audit_events_v6
        WHERE id = 1
      `).get() as { auxiliary_session_id: string | null } | undefined;
      assert.equal(auditOwner?.auxiliary_session_id, "aux-1");
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(
        (db.prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_temp_schema
          WHERE name LIKE '%_auxiliary_restore'
        `).get() as { count: number }).count,
        0,
      );

      db.close();
      db = null;

      auditStorage = new AuditLogStorageV6(dbPath);
      const summaries = auditStorage.listSessionAuditLogSummaries("aux-1");
      const restoredAuditSummary = summaries.find((summary) => summary.assistantTextPreview === "assistant response");
      assert.equal(restoredAuditSummary?.sessionId, "aux-1");
    } finally {
      auditStorage?.close();
      db?.close();
      rmSync(tempDir, { recursive: true, force: true });
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
          && statement !== CREATE_V6_CHARACTER_AFFECT_TABLES_SQL
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
        INSERT INTO session_role_bindings_v6 (
          session_id,
          session_role,
          role_contract_revision,
          root_session_id,
          parent_session_id,
          delegation_depth
        ) VALUES (
          'session-1',
          'standalone',
          1,
          'session-1',
          NULL,
          0
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

      assert.equal(tableNames(db).includes("character_affect_events_v6"), false);
      assert.equal(tableNames(db).includes("character_affect_idempotency_v6"), false);

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

  it("通常Session Role migrationはempty/populated DBへ一度だけstandalone rootをbackfillする", () => {
    for (const populated of [false, true]) {
      const db = new DatabaseSync(":memory:");
      try {
        db.exec("PRAGMA foreign_keys = ON;");
        createLegacySessionSchema(db);
        if (populated) {
          db.exec(`
            INSERT INTO sessions_v6 (
              id, title, state, session_kind, provider_id, catalog_revision,
              model_id, approval_mode, runtime_policy_json, created_at, updated_at, last_active_at
            ) VALUES
              ('normal-session', 'Normal', 'active', 'default', 'codex', 1,
                'gpt-5', 'on-request', '{"sourceSchemaVersion":5}', 'now', 'now', 'now'),
              ('authoring-session', 'Authoring', 'active', 'character-authoring', 'codex', 1,
                'gpt-5', 'on-request', '{"sourceSchemaVersion":5}', 'now', 'now', 'now'),
              ('legacy-session', 'Legacy', 'active', 'default', 'codex', 1,
                'gpt-5', 'on-request', '{"sourceSchemaVersion":4}', 'now', 'now', 'now');
          `);
        }

        ensureV6Schema(db);
        ensureV6Schema(db);

        const rows = db.prepare(`
          SELECT session_id, session_role, role_contract_revision,
                 root_session_id, parent_session_id, delegation_depth
          FROM session_role_bindings_v6
          ORDER BY session_id
        `).all();
        assert.deepEqual(rows.map((row) => ({ ...row })), populated ? [
          {
            session_id: "legacy-session",
            session_role: "standalone",
            role_contract_revision: 1,
            root_session_id: "legacy-session",
            parent_session_id: null,
            delegation_depth: 0,
          },
          {
            session_id: "normal-session",
            session_role: "standalone",
            role_contract_revision: 1,
            root_session_id: "normal-session",
            parent_session_id: null,
            delegation_depth: 0,
          },
        ] : []);
        if (populated) {
          const revisions = db.prepare(`
            SELECT id, json_extract(runtime_policy_json, '$.sourceSchemaVersion') AS revision
            FROM sessions_v6
            ORDER BY id
          `).all();
          assert.deepEqual(revisions.map((row) => ({ ...row })), [
            { id: "authoring-session", revision: 6 },
            { id: "legacy-session", revision: 4 },
            { id: "normal-session", revision: 6 },
          ]);
        }
      } finally {
        db.close();
      }
    }
  });

  it("通常Session Role migrationはunknown Role、unsupported revision、壊れたtupleを拒否し途中変更をrollbackする", () => {
    const invalidBindings = [
      ["unknown", 1, "session-a", null, 0],
      ["standalone", 2, "session-a", null, 0],
      ["standalone", 1, "other-root", null, 0],
    ] as const;
    for (const invalidBinding of invalidBindings) {
      const db = new DatabaseSync(":memory:");
      try {
        db.exec("PRAGMA foreign_keys = ON;");
        createLegacySessionSchema(db, true);
        db.exec(`
          CREATE TABLE session_role_bindings_v6 (
            session_id TEXT PRIMARY KEY,
            session_role TEXT NOT NULL,
            role_contract_revision INTEGER NOT NULL,
            root_session_id TEXT NOT NULL,
            parent_session_id TEXT,
            delegation_depth INTEGER NOT NULL
          );
          INSERT INTO sessions_v6 (
            id, title, state, session_kind, provider_id, catalog_revision,
            model_id, approval_mode, created_at, updated_at, last_active_at
          ) VALUES ('session-a', 'A', 'active', 'default', 'codex', 1,
            'gpt-5', 'on-request', 'now', 'now', 'now');
        `);
        db.prepare(`
          INSERT INTO session_role_bindings_v6 (
            session_id, session_role, role_contract_revision,
            root_session_id, parent_session_id, delegation_depth
          ) VALUES ('session-a', ?, ?, ?, ?, ?)
        `).run(...invalidBinding);

        assert.throws(() => ensureV6Schema(db), /Session Role binding data is invalid/);
        assert.equal(columnNames(db, "sessions_v6").includes("is_pinned"), false);
        assert.equal(tableNames(db).includes("character_affect_events_v6"), false);
      } finally {
        db.close();
      }
    }
  });
});
