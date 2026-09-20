import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  applyCompanionRemovalDatabaseTarget,
  collectCompanionRemovalDatabaseTarget,
} from "../../src-electron/companion-removal-database.js";
import { ensureV6Schema } from "../../src-electron/database-schema-v6.js";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  ensureV6Schema(db);
  db.exec(`
    CREATE TABLE companion_groups (id TEXT PRIMARY KEY, repo_root TEXT NOT NULL);
    CREATE TABLE companion_sessions (
      id TEXT PRIMARY KEY, group_id TEXT, repo_root TEXT, target_branch TEXT,
      base_snapshot_ref TEXT, base_snapshot_commit TEXT, companion_branch TEXT, worktree_path TEXT
    );
    CREATE TABLE companion_messages (id INTEGER PRIMARY KEY, session_id TEXT, text_blob_id TEXT);
    CREATE TABLE companion_message_artifacts (message_id INTEGER, artifact_blob_id TEXT);
    CREATE TABLE companion_merge_runs (id TEXT PRIMARY KEY, session_id TEXT, diff_snapshot_blob_id TEXT);
    CREATE TABLE companion_audit_logs (id TEXT PRIMARY KEY, session_id TEXT, summary TEXT);
    CREATE TABLE character_memory_entries (id TEXT PRIMARY KEY, body TEXT NOT NULL, source_session_id TEXT);
    CREATE TABLE auxiliary_session_drafts (id TEXT PRIMARY KEY, auxiliary_session_id TEXT);
    CREATE TABLE blob_objects (blob_id TEXT PRIMARY KEY);
  `);
  return db;
}

describe("companion removal database", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "専用行・親Auxiliary・blob参照を特定し、共有blobと通常sessionを保全する"
  // oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
  // fault = "Companion専有blobまたは通常sessionを削除対象として誤分類する"
  // observable = "collect結果の専有ID・保全ID配列"
  // observation_boundary = "public-boundary"
  // scope = "companion-removal-database"
  // lifecycle = "permanent"
  // @end-test-value
  it("collects owned metadata and surviving references", () => {
    const db = database();
    try {
      db.exec(`
        INSERT INTO companion_groups VALUES ('g1', '/repo');
        INSERT INTO companion_sessions VALUES ('c1', 'g1', '/repo', 'main', 'refs/base', 'abc', 'companion/c1', '/tmp/wt');
        INSERT INTO companion_messages VALUES (1, 'c1', 'shared');
        INSERT INTO companion_message_artifacts VALUES (1, 'owned');
        INSERT INTO companion_merge_runs VALUES ('m1', 'c1', 'owned');
        INSERT INTO auxiliary_sessions (id, parent_session_id, status, created_at, updated_at, payload_json) VALUES ('a1', 'c1', 'active', 'now', 'now', '{}');
        INSERT INTO auxiliary_session_drafts VALUES ('d1', 'a1');
        INSERT INTO sessions_v6 (id, title, state, provider_id, catalog_revision, model_id, approval_mode, workspace_path, created_at, updated_at, last_active_at)
          VALUES ('normal', 'Normal', 'active', 'test', 1, 'model', 'never', '/normal/session', 'now', 'now', 'now');
        INSERT INTO memory_entries_v6 (id, owner_type, owner_id, scope_type, scope_id, kind, title, body, body_sha256, preview, state, source_type, created_at, updated_at)
          VALUES ('memory-1', 'character', 'char', 'character', 'char', 'note', 'keep', 'keep body', 'hash', 'keep body', 'active', 'manual', 'now', 'now');
        INSERT INTO blob_objects VALUES ('shared');
        INSERT INTO blob_objects VALUES ('owned');
        INSERT INTO session_turns_v6 (session_id, phase, started_at, updated_at) VALUES ('normal', 'completed', 'now', 'now');
        INSERT INTO session_turn_provider_outputs_v6 (turn_id, seq, kind, payload_blob_id, created_at) VALUES (last_insert_rowid(), 0, 'operation', 'shared', 'now');
      `);
      const target = collectCompanionRemovalDatabaseTarget(db);
      assert.deepEqual(target.sessions, [{
        id: "c1", groupId: "g1", repoRoot: "/repo", targetBranch: "main", baseSnapshotRef: "refs/base",
        baseSnapshotCommit: "abc", companionBranch: "companion/c1", worktreePath: "/tmp/wt",
      }]);
      assert.deepEqual(target.auxiliarySessionIds, ["a1"]);
      assert.deepEqual(target.ownedBlobIds, ["owned", "shared"]);
      assert.deepEqual(target.survivingBlobIds, ["shared"]);
      assert.deepEqual(target.preservedSessionIds, ["normal"]);
      assert.deepEqual(target.survivingFilePaths, ["/normal/session"]);
    } finally { db.close(); }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "削除対象のblob分類はprovider出力本文をmaterializeせず、通常ownerとCompanion配下Auxiliaryの共有参照を保全する"
  // oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
  // fault = "blob参照走査が不要なprovider payloadを読み、大規模履歴でheapを使い切って起動できなくなる"
  // observable = "SQLiteのpayload評価回数0と、専有blob・共有blob・通常SessionのID集合"
  // observation_boundary = "public-boundary"
  // scope = "companion removal provider output metadata scan"
  // lifecycle = "permanent"
  // impact = "更新時の削除migrationで大きな既存DBから起動できなくなることと、共有blobの誤削除を防ぐ"
  // distinction = "実SQLiteの遅延評価payloadで本文取得を検出し、巨大fixtureや不安定な壁時計・heap測定をCIへ持ち込まない"
  // @end-test-value
  it("classifies provider blobs without materializing provider payloads", () => {
    const db = database();
    let payloadReads = 0;
    // A virtual column makes payload materialization observable without a multi-GB fixture.
    db.function("provider_payload", { deterministic: true }, () => {
      payloadReads++;
      return '{"text":"provider response"}';
    });
    try {
      db.exec(`
        DROP TABLE session_turn_provider_outputs_v6;
        CREATE TABLE session_turn_provider_outputs_v6 (
          id INTEGER PRIMARY KEY, turn_id INTEGER REFERENCES session_turns_v6(id), payload_blob_id TEXT,
          payload_json TEXT GENERATED ALWAYS AS (provider_payload()) VIRTUAL
        );
        INSERT INTO companion_sessions VALUES ('c1', 'g1', '/repo', 'main', '', '', 'branch', '/tmp/wt');
        INSERT INTO auxiliary_sessions (id, parent_session_id, status, created_at, updated_at, payload_json)
          VALUES ('a1', 'c1', 'active', 'now', 'now', '{}');
        INSERT INTO sessions_v6 (id, title, state, provider_id, catalog_revision, model_id, approval_mode, created_at, updated_at, last_active_at)
          VALUES ('normal', 'Normal', 'active', 'test', 1, 'model', 'never', 'now', 'now', 'now');
        INSERT INTO session_turns_v6 (id, auxiliary_session_id, phase, started_at, updated_at) VALUES (1, 'a1', 'completed', 'now', 'now');
        INSERT INTO session_turns_v6 (id, session_id, phase, started_at, updated_at) VALUES (2, 'normal', 'completed', 'now', 'now');
        INSERT INTO session_turn_provider_outputs_v6 (id, turn_id, payload_blob_id)
          VALUES (1, 1, 'owned'), (2, 1, 'shared'), (3, 2, 'shared'), (4, 2, 'live-only');
      `);
      assert.equal(db.prepare("SELECT payload_json FROM session_turn_provider_outputs_v6 LIMIT 1").get()?.payload_json, '{"text":"provider response"}');
      assert.ok(payloadReads > 0);
      payloadReads = 0;

      const target = collectCompanionRemovalDatabaseTarget(db);

      assert.equal(payloadReads, 0);
      assert.deepEqual(target.ownedBlobIds, ["owned", "shared"]);
      assert.deepEqual(target.survivingBlobIds, ["live-only", "shared"]);
      assert.deepEqual(target.preservedSessionIds, ["normal"]);
      assert.deepEqual(target.auxiliarySessionIds, ["a1"]);
    } finally { db.close(); }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Companion削除候補の有無を確認する軽量走査は通常SessionのJSON本文を読まず、不正JSONでも削除対象の収集を継続する"
  // oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
  // fault = "退役CompanionがないDBの通常Sessionに残った不正な補助JSONで起動を拒否する"
  // observable = "軽量収集の完了・専有ID集合・survivingFilePathsが空であること"
  // observation_boundary = "public-boundary"
  // scope = "companion-removal-database lightweight collection"
  // lifecycle = "permanent"
  // impact = "全DBの事前棚卸しで、削除候補がないDBの本文・draft解析を避けて起動を継続する"
  // distinction = "通常Sessionの不正JSONを含む最小SQLiteで軽量経路と従来の参照収集経路を分離して確認する"
  // @end-test-value
  it("skips normal-session JSON and file references in lightweight collection", () => {
    const db = database();
    try {
      db.exec("ALTER TABLE sessions_v6 ADD COLUMN payload_json TEXT; ALTER TABLE sessions_v6 ADD COLUMN messages_json TEXT;");
      db.exec(`
        INSERT INTO sessions_v6 (id, title, state, provider_id, catalog_revision, model_id, approval_mode,
          allowed_additional_directories_json, payload_json, messages_json, created_at, updated_at, last_active_at)
          VALUES ('normal', 'Normal', 'active', 'test', 1, 'model', 'never',
            '{not-json', '{also-not-json', '{still-not-json', 'now', 'now', 'now');
      `);
      const target = collectCompanionRemovalDatabaseTarget(db, { includeFileReferences: false });
      assert.deepEqual(target.sessions, []);
      assert.deepEqual(target.preservedSessionIds, ["normal"]);
      assert.deepEqual(target.survivingFilePaths, []);
      assert.throws(() => collectCompanionRemovalDatabaseTarget(db), /JSON|Unexpected token/);
    } finally { db.close(); }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "FS処理後のDB transactionで専用schemaだけを除去し本文を保持する"
  // oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
  // fault = "専用schema削除時に共有Memory本文を消去する"
  // observable = "sqlite schema・Memory本文・source参照・blob行"
  // observation_boundary = "public-boundary"
  // scope = "companion-removal-database"
  // lifecycle = "permanent"
  // @end-test-value
  it("removes companion rows and source references while preserving bodies", () => {
    const db = database();
    try {
      db.exec(`
        INSERT INTO characters (id, name, created_at, updated_at) VALUES ('char-1', 'Shared Character', 'now', 'now');
        INSERT INTO app_settings VALUES ('theme', 'dark', 'now');
        INSERT INTO companion_groups VALUES ('g1', '/repo');
        INSERT INTO companion_sessions VALUES ('c1', 'g1', '/repo', 'main', '', '', 'branch', '/tmp/wt');
        INSERT INTO companion_messages VALUES (1, 'c1', 'owned');
        INSERT INTO companion_message_artifacts VALUES (1, 'owned');
        INSERT INTO companion_merge_runs VALUES ('merge-1', 'c1', 'owned');
        INSERT INTO character_memory_entries VALUES ('legacy-shared', 'legacy body', 'c1');
        INSERT INTO sessions_v6 (id, title, state, provider_id, catalog_revision, model_id, approval_mode, character_id, character_snapshot_json, workspace_path, created_at, updated_at, last_active_at)
          VALUES ('normal', 'Normal', 'active', 'test', 1, 'model', 'never', 'char-1', '{}', '/normal/session', 'now', 'now', 'now');
        INSERT INTO auxiliary_sessions (id, parent_session_id, status, created_at, updated_at, payload_json) VALUES ('a1', 'c1', 'active', 'now', 'now', '{}');
        INSERT INTO auxiliary_sessions (id, parent_session_id, status, created_at, updated_at, payload_json) VALUES ('a-normal', 'normal', 'active', 'now', 'now', '{}');
        INSERT INTO auxiliary_session_drafts VALUES ('d1', 'a1');
        INSERT INTO session_turns_v6 (auxiliary_session_id, phase, started_at, updated_at) VALUES ('a1', 'completed', 'now', 'now');
        INSERT INTO session_turn_provider_outputs_v6 (turn_id, seq, kind, payload_blob_id, created_at) VALUES (last_insert_rowid(), 0, 'operation', 'owned', 'now');
        INSERT INTO companion_audit_logs VALUES ('audit-1', 'c1', 'owned audit');
        INSERT INTO session_turns_v6 (session_id, phase, started_at, updated_at) VALUES ('normal', 'completed', 'now', 'now');
        INSERT INTO session_turn_provider_outputs_v6 (turn_id, seq, kind, payload_blob_id, created_at) VALUES (last_insert_rowid(), 0, 'operation', 'shared', 'now');
        INSERT INTO memory_entries_v6 (id, owner_type, owner_id, scope_type, scope_id, kind, title, body, body_sha256, preview, state, source_type, superseded_by_id, created_at, updated_at)
          VALUES ('owned-new', 'character', 'char-1', 'session', 'c1', 'note', 'owned new', 'owned new body', 'hash', 'owned new body', 'active', 'manual', NULL, 'now', 'now');
        INSERT INTO memory_entries_v6 (id, owner_type, owner_id, scope_type, scope_id, kind, title, body, body_sha256, preview, state, source_type, superseded_by_id, created_at, updated_at)
          VALUES ('owned-old', 'character', 'char-1', 'session', 'c1', 'note', 'owned old', 'owned old body', 'hash', 'owned old body', 'superseded', 'manual', 'owned-new', 'now', 'now');
        INSERT INTO memory_entries_v6 (id, owner_type, owner_id, scope_type, scope_id, kind, title, body, body_sha256, preview, state, source_type, created_at, updated_at)
          VALUES ('shared-memory', 'character', 'char-1', 'character', 'char-1', 'note', 'shared', 'shared body', 'hash', 'shared body', 'active', 'manual', 'now', 'now');
        INSERT INTO memory_entry_tags_v6 VALUES ('owned-new', 'topic', 'Shared', 'topic', 'shared', 'now');
        INSERT INTO memory_entry_tags_v6 VALUES ('shared-memory', 'topic', 'Shared', 'topic', 'shared', 'now');
        INSERT INTO memory_entry_relations_v6 VALUES ('owned-new', 'owned-old', 'supersedes', 'now');
        INSERT INTO memory_tag_catalog_v6 VALUES ('topic', 'Shared', 'topic', 'shared', '', '[]', 'active', 2, 'now', 'now');
        INSERT INTO memory_target_tag_stats_v6 VALUES ('character', 'char-1', 'session', 'c1', 'topic', 'Shared', 'topic', 'shared', 1, 'now');
        INSERT INTO memory_target_tag_stats_v6 VALUES ('character', 'char-1', 'character', 'char-1', 'topic', 'Shared', 'topic', 'shared', 1, 'now');
        INSERT INTO memory_protected_objects_v6 (object_id, entry_id, state, role, summary, original_bytes, stored_bytes, created_at, updated_at)
          VALUES ('owned-object', 'owned-new', 'active', 'evidence', 'owned', 1, 1, 'now', 'now');
        INSERT INTO memory_protected_objects_v6 (object_id, entry_id, state, role, summary, original_bytes, stored_bytes, created_at, updated_at)
          VALUES ('shared-object', 'shared-memory', 'active', 'evidence', 'shared', 1, 1, 'now', 'now');
        INSERT INTO character_affect_events_v6 (id, character_id, user_id, layer, target_type, target_id, value_json, intensity, reason, evidence, occurred_at, idempotency_key, request_fingerprint, created_at)
          VALUES ('affect-1', 'char-1', 'local-user', 'relationship', 'user', 'local-user', '{}', 0.5, 'keep', 'keep', 'now', 'affect-1', 'hash', 'now');
        INSERT INTO blob_objects VALUES ('owned');
        INSERT INTO blob_objects VALUES ('shared');
      `);
      const target = collectCompanionRemovalDatabaseTarget(db);
      applyCompanionRemovalDatabaseTarget(db, target);
      assert.equal((db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'companion_sessions'").get() as { n: number }).n, 0);
      assert.equal((db.prepare("SELECT count(*) AS n FROM auxiliary_sessions").get() as { n: number }).n, 1);
      assert.deepEqual(db.prepare("SELECT id, body, source_session_id FROM memory_entries_v6 ORDER BY id").all().map((row) => ({ ...row })), [
        { id: "shared-memory", body: "shared body", source_session_id: null },
      ]);
      assert.deepEqual(db.prepare("SELECT id, body, source_session_id FROM character_memory_entries").all().map((row) => ({ ...row })), [
        { id: "legacy-shared", body: "legacy body", source_session_id: null },
      ]);
      assert.equal((db.prepare("SELECT count(*) AS n FROM characters WHERE id = 'char-1'").get() as { n: number }).n, 1);
      assert.equal((db.prepare("SELECT count(*) AS n FROM app_settings WHERE setting_key = 'theme'").get() as { n: number }).n, 1);
      assert.equal((db.prepare("SELECT count(*) AS n FROM auxiliary_sessions WHERE id = 'a-normal'").get() as { n: number }).n, 1);
      assert.equal((db.prepare("SELECT count(*) AS n FROM session_turns_v6 WHERE session_id = 'normal'").get() as { n: number }).n, 1);
      assert.equal((db.prepare("SELECT count(*) AS n FROM session_turn_provider_outputs_v6 WHERE payload_blob_id = 'shared'").get() as { n: number }).n, 1);
      assert.equal((db.prepare("SELECT count(*) AS n FROM character_affect_events_v6 WHERE id = 'affect-1'").get() as { n: number }).n, 1);
      assert.deepEqual(db.prepare("SELECT object_id FROM memory_protected_objects_v6 ORDER BY object_id").all().map((row) => ({ ...row })), [{ object_id: "shared-object" }]);
      assert.deepEqual(db.prepare("SELECT tag_type_canonical, usage_count FROM memory_tag_catalog_v6").all().map((row) => ({ ...row })), [{ tag_type_canonical: "topic", usage_count: 1 }]);
      assert.deepEqual(db.prepare("SELECT scope_type, scope_id FROM memory_target_tag_stats_v6").all().map((row) => ({ ...row })), [{ scope_type: "character", scope_id: "char-1" }]);
      assert.equal((db.prepare("SELECT count(*) AS n FROM sessions_v6 WHERE id = 'normal'").get() as { n: number }).n, 1);
      assert.equal((db.prepare("SELECT count(*) AS n FROM blob_objects WHERE blob_id = 'shared'").get() as { n: number }).n, 1);
      assert.equal((db.prepare("SELECT count(*) AS n FROM blob_objects WHERE blob_id = 'owned'").get() as { n: number }).n, 0);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { db.close(); }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "途中失敗時に専用schemaと本文をtransaction rollbackする"
  // oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
  // fault = "DB削除途中のエラーで専用schemaだけが部分削除される"
  // observable = "rollback後の専用table行"
  // observation_boundary = "public-boundary"
  // scope = "companion-removal-database"
  // lifecycle = "permanent"
  // @end-test-value
  it("rolls back when the database operation fails", () => {
    const db = database();
    try {
      db.exec("INSERT INTO companion_sessions VALUES ('c1', 'g1', '/repo', 'main', '', '', 'branch', '/tmp/wt');");
      db.exec("INSERT INTO auxiliary_sessions (id, parent_session_id, status, created_at, updated_at, payload_json) VALUES ('a1', 'c1', 'active', 'now', 'now', '{}');");
      db.exec("CREATE TRIGGER fail_companion_removal BEFORE DELETE ON auxiliary_sessions BEGIN SELECT RAISE(ABORT, 'forced'); END;");
      const target = collectCompanionRemovalDatabaseTarget(db);
      assert.throws(() => applyCompanionRemovalDatabaseTarget(db, target), /forced/);
      assert.equal((db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'companion_sessions'").get() as { n: number }).n, 1);
      db.exec("DROP TRIGGER fail_companion_removal;");
      applyCompanionRemovalDatabaseTarget(db, target);
      assert.equal((db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'companion_sessions'").get() as { n: number }).n, 0);
    } finally { db.close(); }
  });
});
