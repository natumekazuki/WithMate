import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AppSettingsStorage } from "../../src-electron/app/app-settings-storage.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { ensureV6Schema, SESSION_GRAPH_CONTRACT_INITIALIZED_KEY } from "../../src-electron/storage/database-schema-v6.js";
import { openAppDatabase } from "../../src-electron/storage/sqlite-connection.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";

const graphTables = ["session_graphs_v6", "session_graph_topics_v6", "session_graph_records_v6", "session_graph_relations_v6"];
const retainedTables = ["sessions_v6", "session_messages_v6", "auxiliary_sessions", "auxiliary_session_messages", "auxiliary_session_drafts",
  "session_turns_v6", "memory_entries_v6", "character_affect_events_v6", "characters"];

function graphFixture(db: DatabaseSync, payload: string): void {
  for (const sessionId of ["main-a", "main-b"]) {
    db.prepare("INSERT INTO session_graphs_v6 VALUES (?, 42)").run(sessionId);
    for (const topicId of ["topic-a", "topic-b"]) {
      db.prepare("INSERT INTO session_graph_topics_v6 VALUES (?, ?, ?, 'time', 'time')").run(sessionId, topicId, topicId);
      for (const suffix of ["a", "b"]) {
        db.prepare("INSERT INTO session_graph_records_v6 VALUES (?, ?, ?, 'requirement', ?, 'time')")
          .run(sessionId, `${topicId}-${suffix}`, topicId, payload);
      }
      db.prepare("INSERT INTO session_graph_relations_v6 VALUES (?, ?, ?, ?, ?)")
        .run(sessionId, topicId, `${topicId}-a`, `${topicId}-b`, '{"kind":"depends_on"}');
    }
  }
}

function retainedFixture(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO characters (id, name, created_at, updated_at) VALUES ('character', 'Character', 'time', 'time');
    INSERT INTO sessions_v6 (id, incarnation_id, title, state, provider_id, catalog_revision, model_id,
      approval_mode, character_id, character_snapshot_json, created_at, updated_at, last_active_at)
      VALUES ('main-a', 'incarnation-a', 'Main A', 'active', 'codex', 1, 'model', 'default', 'character', '{}', 'time', 'time', 'time'),
        ('main-b', 'incarnation-b', 'Main B', 'active', 'codex', 1, 'model', 'default', NULL, NULL, 'time', 'time', 'time');
    INSERT INTO session_messages_v6 (session_id, seq, role, body, created_at) VALUES ('main-a', 0, 'user', 'conversation', 'time');
    INSERT INTO auxiliary_sessions (id, parent_session_id, status, created_at, updated_at)
      VALUES ('aux', 'main-a', 'active', 'time', 'time');
    INSERT INTO auxiliary_session_messages VALUES ('aux', 0, 'user', '{"text":"aux conversation"}', NULL, 'time');
    INSERT INTO auxiliary_session_drafts VALUES ('aux', 'main-a', 'draft-incarnation', 3, 'draft', 'time');
    INSERT INTO session_turns_v6 (session_id, phase, started_at, completed_at, updated_at)
      VALUES ('main-a', 'completed', 'time', 'time', 'time');
    INSERT INTO memory_entries_v6 (id, owner_type, owner_id, scope_type, scope_id, kind, title, body, body_sha256,
      preview, state, source_type, source_session_id, created_at, updated_at)
      VALUES ('memory', 'character', 'character', 'session', 'main-a', 'note', 'Memory', 'body', 'hash', 'preview', 'active', 'agent', 'main-a', 'time', 'time');
    INSERT INTO character_affect_events_v6 (id, character_id, user_id, session_id, source_session_id, layer,
      target_type, target_id, value_json, intensity, reason, evidence, occurred_at, idempotency_key, request_fingerprint, created_at)
      VALUES ('affect', 'character', 'local-user', 'main-a', 'main-a', 'session', 'task', 'task', '{}', 0.5, 'reason', 'evidence', 'time', 'key', 'fingerprint', 'time');
  `);
}

function snapshot(db: DatabaseSync, tables: string[]) {
  return tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

// @test-value v2
// kind = "contract"
// claim = "Graph切替は全SessionとTopicを一度だけ初期化し、非Graph資産と設定reset後・再起動後の新Graphを保持する"
// oracle = { type = "contract", ref = "docs/design/database-schema.md#session-graph" }
// fault = "Graphの一部を残す、非Graphデータを削除する、marker喪失や再起動で新Graphを再削除する"
// observable = "実SQLiteの4 Graph table、非Graph行snapshot、再open後のGraph snapshot、参照先file本文、reset後の設定値"
// observation_boundary = "component-behavior"
// scope = "ensureV6SchemaとAppSettingsStorage.resetSettingsの実一時DB"
// lifecycle = "permanent"
// impact = "切替漏れの旧Graph読取と再起動時の新Graph喪失、Session等の無関係資産の喪失を防ぐ"
// distinction = "型やschema検査では観測できないDB内容とmarkerの再実行・設定reset・再openを少数fixtureで確認する"
// @end-test-value
test("Session Graph contract initializes once and preserves other assets", () => {
  const temporary = mkdtempSync(join(tmpdir(), "withmate-graph-schema-"));
  const dbPath = join(temporary, "withmate-v6.db");
  const referencedFile = join(temporary, "reference.md");
  let db = openAppDatabase(dbPath);
  try {
    ensureV6Schema(db);
    const auxiliary = new AuxiliarySessionStorage(dbPath);
    auxiliary.close();
    retainedFixture(db);
    writeFileSync(referencedFile, "reference content");
    db.prepare("DELETE FROM app_settings WHERE setting_key = ?").run(SESSION_GRAPH_CONTRACT_INITIALIZED_KEY);
    graphFixture(db, JSON.stringify({ actor: { label: "User" }, references: [{ href: referencedFile }] }));
    const retained = snapshot(db, retainedTables);
    ensureV6Schema(db);
    assert.deepEqual(snapshot(db, graphTables), [[], [], [], []]);
    assert.deepEqual(snapshot(db, retainedTables), retained);
    assert.equal(readFileSync(referencedFile, "utf8"), "reference content");
    const marker = db.prepare("SELECT * FROM app_settings WHERE setting_key = ?").get(SESSION_GRAPH_CONTRACT_INITIALIZED_KEY);
    assert.ok(marker);
    graphFixture(db, JSON.stringify({ actor: { sessionId: "main-a" }, origin: { type: "user" }, references: [] }));
    const newGraph = snapshot(db, graphTables);
    ensureV6Schema(db);
    assert.deepEqual(snapshot(db, graphTables), newGraph);
    const settings = new AppSettingsStorage(dbPath);
    try {
      settings.updateSettings({ ...settings.getSettings(), memoryGenerationEnabled: !createDefaultAppSettings().memoryGenerationEnabled });
      assert.equal(settings.resetSettings().memoryGenerationEnabled, createDefaultAppSettings().memoryGenerationEnabled);
    } finally {
      settings.close();
    }
    assert.deepEqual(db.prepare("SELECT * FROM app_settings WHERE setting_key = ?").get(SESSION_GRAPH_CONTRACT_INITIALIZED_KEY), marker);
    db.close();
    db = openAppDatabase(dbPath);
    ensureV6Schema(db);
    assert.deepEqual(snapshot(db, graphTables), newGraph);
    assert.deepEqual(snapshot(db, retainedTables), retained);
    assert.equal(readFileSync(referencedFile, "utf8"), "reference content");
  } finally {
    db.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Graph削除と切替marker保存は原子的で、marker保存失敗時には全Graphを保持して再試行できる"
// oracle = { type = "contract", ref = "docs/design/database-schema.md#session-graph" }
// fault = "marker保存失敗時にGraph削除だけがcommitされる"
// observable = "ensure例外、失敗後の全Graph snapshotとmarker不在、再試行後の空Graphとmarker存在"
// observation_boundary = "component-behavior"
// scope = "ensureV6Schemaの実SQLite savepoint"
// lifecycle = "permanent"
// impact = "中断された切替の半端な状態と予期しないGraph喪失を防ぐ"
// distinction = "DDLや型では保証できない削除とmarker保存のrollbackをSQLite triggerで一度だけ失敗させて観測する"
// @end-test-value
test("Session Graph contract initialization rolls back when marker persistence fails", () => {
  const db = openAppDatabase(":memory:");
  try {
    ensureV6Schema(db);
    db.exec("INSERT INTO sessions_v6 (id, title, state, provider_id, catalog_revision, model_id, approval_mode, created_at, updated_at, last_active_at) VALUES ('main-a', 'A', 'active', 'codex', 1, 'model', 'default', 'time', 'time', 'time'), ('main-b', 'B', 'active', 'codex', 1, 'model', 'default', 'time', 'time', 'time')");
    db.prepare("DELETE FROM app_settings WHERE setting_key = ?").run(SESSION_GRAPH_CONTRACT_INITIALIZED_KEY);
    graphFixture(db, '{"title":"payload"}');
    const graph = snapshot(db, graphTables);
    db.exec(`CREATE TRIGGER fail_graph_marker BEFORE INSERT ON app_settings
      WHEN NEW.setting_key = '${SESSION_GRAPH_CONTRACT_INITIALIZED_KEY}' BEGIN SELECT RAISE(ABORT, 'marker failure'); END;`);
    assert.throws(() => ensureV6Schema(db), /marker failure/);
    assert.deepEqual(snapshot(db, graphTables), graph);
    assert.equal(db.prepare("SELECT 1 FROM app_settings WHERE setting_key = ?").get(SESSION_GRAPH_CONTRACT_INITIALIZED_KEY), undefined);
    db.exec("DROP TRIGGER fail_graph_marker");
    ensureV6Schema(db);
    assert.deepEqual(snapshot(db, graphTables), [[], [], [], []]);
    assert.ok(db.prepare("SELECT 1 FROM app_settings WHERE setting_key = ?").get(SESSION_GRAPH_CONTRACT_INITIALIZED_KEY));
  } finally {
    db.close();
  }
});
