import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { resolveOrMigrateAppDatabasePath } from "../../src-electron/storage/app-database-path.js";
import { CREATE_APP_SETTINGS_TABLE_SQL } from "../../src-electron/storage/database-schema-v1.js";
import {
  CREATE_V4_SCHEMA_SQL,
  isValidV4Database,
} from "../../src-electron/storage/database-schema-v4.js";
import {
  isValidV6Database,
  REQUIRED_V6_TABLES,
} from "../../src-electron/storage/database-schema-v6.js";
import { RELEASED_V6_SCHEMA_SQL } from "./fixtures/released-v6-schema.js";

// 廃止対象を独立に定義する。リリース済み fixture に記録された非公開テーブル 15 個に、
// 旧精算キューを加える。この期待値はテスト対象の実装から導出しない。
const EXPECTED_RETIRED_TABLES = [
  "memory_entries_v6",
  "memory_entry_tags_v6",
  "memory_entry_relations_v6",
  "memory_tag_catalog_v6",
  "memory_target_tag_stats_v6",
  "memory_mutation_events_v6",
  "memory_idempotency_keys_v6",
  "memory_idempotency_forget_results_v6",
  "memory_move_events_v6",
  "memory_protected_objects_v6",
  "character_affect_events_v6",
  "character_affect_resets_v6",
  "character_affect_idempotency_v6",
  "character_affect_mutations_v6",
  "character_affect_observations_v6",
  "character_affect_turn_settlements",
] as const;

/** 廃止対象と保持対象を同居させたリリース版DBを作り、保持テーブルの移行前の行を採取する。 */
async function fixture(t: TestContext) {
  const root = await mkdtemp(
    path.join(tmpdir(), "withmate-memory-retirement-"),
  );
  /** ケース終了後に、隔離した移行用データディレクトリを取り除く。 */
  t.after(() => rm(root, { recursive: true, force: true }));
  const userData = path.join(root, "data");
  await mkdir(userData);
  const dbPath = path.join(userData, "withmate-v6.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(RELEASED_V6_SCHEMA_SQL);
  db.exec(`
    -- Minimal synthetic row shape from the former character-affect-turn-settlements.sql fixture.
    CREATE TABLE character_affect_turn_settlements (
      correlation_id TEXT PRIMARY KEY, character_id TEXT NOT NULL, session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'settled')),
      user_message TEXT NOT NULL, assistant_message TEXT NOT NULL
    );
    INSERT INTO character_affect_turn_settlements VALUES ('pending','char','session','pending','discard user','discard assistant');
    INSERT INTO app_settings VALUES ('v4_to_v6_release_data_migrated_at','now','now');
    INSERT INTO app_settings VALUES ('session_selection_policy_json','{}','now');
    INSERT INTO app_settings VALUES ('memory_generation_enabled','true','now');
    INSERT INTO app_settings VALUES ('memory_extraction_provider_settings_json','{}','now');
    INSERT INTO app_settings VALUES ('mate_memory_generation_settings_json','{}','now');
    INSERT INTO app_settings VALUES ('memory_file_quota_bytes','1024','now');
    INSERT INTO app_settings VALUES ('character_affect_context_enabled','true','now');
    INSERT INTO app_settings VALUES ('memory_recording_frequencies_json','{}','now');
    INSERT INTO app_settings VALUES ('background_execution_settings_json','{}','now');
    INSERT INTO characters (id,name,created_at,updated_at) VALUES ('char','Character','now','now');
    INSERT INTO project_scopes_v6 (id,project_type,project_key,workspace_path,display_name,created_at,updated_at)
      VALUES ('project','directory','fixture','/fixture','Fixture','now','now');
    INSERT INTO sessions_v6 (id,incarnation_id,title,state,root_session_id,provider_id,catalog_revision,model_id,
      approval_mode,character_id,character_snapshot_json,project_scope_id,created_at,updated_at,last_active_at)
      VALUES ('session','incarnation','Keep','active','session','codex',1,'fixture','on-request','char','{}','project','now','now','now');
    INSERT INTO session_messages_v6 (session_id,seq,role,body,created_at) VALUES ('session',0,'user','{"text":"kept history"}','now');
    INSERT INTO auxiliary_sessions (id,parent_session_id,created_at,updated_at,title) VALUES ('aux','session','now','now','Keep auxiliary');
    INSERT INTO auxiliary_session_messages VALUES ('aux',0,'user','{"text":"kept auxiliary"}',NULL,'now');
    INSERT INTO coordination_records_v7 VALUES ('coordination','session','session','main','incarnation',NULL,'user','open','{}');
    INSERT INTO prompt_templates VALUES ('prompt','Keep prompt','Keep body','now','now');
    INSERT INTO memory_entries_v6 (id,owner_type,owner_id,scope_type,scope_id,kind,title,body,body_sha256,preview,state,source_type,created_at,updated_at)
      VALUES ('new','user','local-user','global','global','note','discard','discard','hash','discard','active','manual','now','now');
    INSERT INTO memory_entries_v6 (id,owner_type,owner_id,scope_type,scope_id,kind,title,body,body_sha256,preview,state,source_type,superseded_by_id,created_at,updated_at)
      VALUES ('old','user','local-user','global','global','note','discard','discard','hash','discard','superseded','manual','new','now','now');
    INSERT INTO character_affect_events_v6 (id,character_id,user_id,source_session_id,layer,target_type,target_id,value_json,intensity,reason,evidence,
      occurred_at,idempotency_key,request_fingerprint,memory_entry_id,created_at)
      VALUES ('event','char','local-user','session','relationship','user','local-user','{}',0.5,'discard','discard','now','key','fingerprint','new','now');
  `);
  const names = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  assert.deepEqual(
    EXPECTED_RETIRED_TABLES.filter((name) => names.includes(name)),
    EXPECTED_RETIRED_TABLES,
  );
  const shared = Object.fromEntries(
    REQUIRED_V6_TABLES.filter((name) => name !== "app_settings").map((name) => [
      name,
      db.prepare(`SELECT * FROM ${name}`).all(),
    ]),
  );
  db.close();
  return { root, userData, dbPath, shared };
}

// @test-value v2
// kind = "contract"
// claim = "更新起動は廃止専用データだけを退避せず破棄し、通常履歴・Character・Coordination・Projectを保持して再起動できる"
// oracle = { type = "contract", ref = "docs/design/database-schema.md: Memory/Affect廃止と共有保存データの継続" }
// fault = "起動更新が専用table/設定/暗号添付を残す、再作成する、または共有データを削除する"
// observable = "廃止tableの不在、本番bootstrap後と再実行後の共有列の値と追加Reviewer/Instructions列の既定値、設定とfileの存否/内容"
// observation_boundary = "public-boundary"
// scope = "preview.6相当のsynthetic DBとuserDataから起動するstorage更新"
// lifecycle = "permanent"
// impact = "廃止データの残存はprivacy方針違反、広すぎる削除は利用者の通常会話/Character資産を失う"
// distinction = "新規schemaや型検査では既存行と暗号化fileの破棄境界・再起動・共有行保持を検出できず、短いsynthetic起動を継続検証する"
// risk_tags = ["irreversible-data-loss", "privacy"]
// @end-test-value
/** リリース版からの更新では、既存の共有値を維持し、追加された Reviewer と Instructions の列をどちらの起動でも初期化する。 */
test("released data retirement preserves shared storage across repeated bootstrap", async (t) => {
  const f = await fixture(t);
  const object = path.join(
    f.userData,
    "memory-objects",
    "v6",
    "aa",
    "a".repeat(32) + ".bin",
  );
  const staging = path.join(
    f.userData,
    "memory-objects",
    "v6",
    ".staging",
    "pending.tmp",
  );
  const keyring = path.join(f.userData, "memory-keys", "v6-keyring.json");
  const sharedFile = path.join(
    f.userData,
    "characters",
    "char",
    "character.md",
  );
  const exported = path.join(
    f.userData,
    "session-files",
    "memory-exports",
    "kept.txt",
  );
  const v4Source = path.join(f.userData, "withmate-v4.db");
  const source = new DatabaseSync(v4Source);
  source.exec(
    "CREATE TABLE unrelated_source (body TEXT); INSERT INTO unrelated_source VALUES ('keep V4');",
  );
  source.close();
  for (const file of [object, staging, keyring, sharedFile, exported]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "synthetic file");
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal(await resolveOrMigrateAppDatabasePath(f.userData), f.dbPath);
    assert.equal(isValidV6Database(f.dbPath), true);
    const db = new DatabaseSync(f.dbPath, { readOnly: true });
    try {
      const names = db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .all()
        .map((row) => row.name);
      assert.deepEqual(
        EXPECTED_RETIRED_TABLES.filter((name) => names.includes(name)),
        [],
        "retired private tables must not survive",
      );
      assert.deepEqual(
        db
          .prepare("SELECT setting_key FROM app_settings ORDER BY setting_key")
          .all()
          .map((row) => row.setting_key),
        [
          "companion_removal_completed_at",
          "session_selection_policy_json",
          "v4_to_v6_release_data_migrated_at",
        ],
      );
      for (const [table, rows] of Object.entries(f.shared)) {
        const actual = db.prepare(`SELECT * FROM ${table}`).all();
        // 従来と同じく既存の値をすべて比較し、追加された各列の既定値も厳密に比較する。
        const additions =
          table === "auxiliary_sessions"
            ? { withmate_reviewer_explicit: 0, instructions_json: '""' }
            : table === "sessions_v6"
              ? { instructions_json: '""' }
              : {};
        assert.deepEqual(
          actual,
          rows.map((row) => Object.assign(Object.create(null), row, additions)),
          table,
        );
      }
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      db.close();
    }
    for (const file of [object, staging, keyring])
      assert.equal(existsSync(file), false);
    for (const file of [sharedFile, exported])
      assert.equal(await readFile(file, "utf8"), "synthetic file");
    const keptSource = new DatabaseSync(v4Source, { readOnly: true });
    try {
      assert.deepEqual(
        keptSource
          .prepare("SELECT body FROM unrelated_source")
          .all()
          .map((row) => row.body),
        ["keep V4"],
      );
    } finally {
      keptSource.close();
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "valid V4が同居しても専用データ更新のSQL失敗を起動成功やV4からの置換へ変換せず、V6をrollbackして両DBの異なる継続データを保持する"
// oracle = { type = "contract", ref = "docs/design/database-schema.md: 起動更新の失敗とデータ保護" }
// fault = "設定削除の失敗を握り潰してvalid V4からV6を上書きするか、先行DROPだけcommitして既存DBを部分破壊する"
// observable = "bootstrap rejection、再接続後の専用entry/event・設定行・V6共有履歴、V4/V6それぞれの異なる通常設定値、retry後の正常起動と同じ継続データ"
// observation_boundary = "public-boundary"
// scope = "Companion cleanup済みのvalid V4とreleased V6が同居する実SQLiteの起動schema savepoint・fallback・再試行"
// lifecycle = "permanent"
// impact = "失敗した更新を成功扱いすると利用者の保存状態と起動結果が食い違う"
// distinction = "型検査と正常起動testではSQLiteのDDL rollbackとruntime fallbackを検証できない"
// risk_tags = ["irreversible-data-loss"]
// @end-test-value
/** 廃止途中のSQLエラーで削除をロールバックし、有効なV4で代用せず、制約除去後には元のV6で再試行できることを確認する。 */
test("failed retirement rolls back and rejects bootstrap instead of replacing the database", async (t) => {
  const f = await fixture(t);
  const v4Path = path.join(f.userData, "withmate-v4.db");
  const source = new DatabaseSync(v4Path);
  try {
    for (const statement of CREATE_V4_SCHEMA_SQL) source.exec(statement);
    source.exec(CREATE_APP_SETTINGS_TABLE_SQL);
    source.exec(`INSERT INTO app_settings VALUES ('companion_removal_completed_at','now','now');
      INSERT INTO app_settings VALUES ('launch_at_login_enabled','false','now');`);
  } finally {
    source.close();
  }
  assert.equal(isValidV4Database(v4Path), true);
  const db = new DatabaseSync(f.dbPath);
  // この廃止処理を別の Companion 後処理から切り分け、V4 をフォールバック候補に残す。
  db.exec(`INSERT INTO app_settings VALUES ('companion_removal_completed_at','now','now');
    INSERT INTO app_settings VALUES ('launch_at_login_enabled','true','now');`);
  db.exec(
    "CREATE TRIGGER reject_retirement BEFORE DELETE ON app_settings WHEN OLD.setting_key = 'memory_file_quota_bytes' BEGIN SELECT RAISE(ABORT, 'retirement denied'); END;",
  );
  db.close();
  await assert.rejects(
    resolveOrMigrateAppDatabasePath(f.userData),
    /retirement denied/,
  );
  const check = new DatabaseSync(f.dbPath);
  try {
    assert.equal(
      check.prepare("SELECT count(*) AS n FROM memory_entries_v6").get()?.n,
      2,
    );
    assert.equal(
      check
        .prepare("SELECT count(*) AS n FROM character_affect_events_v6")
        .get()?.n,
      1,
    );
    assert.equal(
      check
        .prepare(
          "SELECT setting_value FROM app_settings WHERE setting_key = 'memory_file_quota_bytes'",
        )
        .get()?.setting_value,
      "1024",
    );
    assert.equal(
      check.prepare("SELECT body FROM session_messages_v6").get()?.body,
      '{"text":"kept history"}',
    );
    assert.equal(
      check
        .prepare(
          "SELECT setting_value FROM app_settings WHERE setting_key = 'launch_at_login_enabled'",
        )
        .get()?.setting_value,
      "true",
    );
    check.exec("DROP TRIGGER reject_retirement;");
  } finally {
    check.close();
  }
  assert.equal(isValidV4Database(v4Path), true);
  const keptSource = new DatabaseSync(v4Path, { readOnly: true });
  try {
    assert.equal(
      keptSource
        .prepare(
          "SELECT setting_value FROM app_settings WHERE setting_key = 'launch_at_login_enabled'",
        )
        .get()?.setting_value,
      "false",
    );
  } finally {
    keptSource.close();
  }
  assert.equal(await resolveOrMigrateAppDatabasePath(f.userData), f.dbPath);
  const retried = new DatabaseSync(f.dbPath, { readOnly: true });
  const sourceAfterRetry = new DatabaseSync(v4Path, { readOnly: true });
  try {
    assert.equal(
      retried.prepare("SELECT body FROM session_messages_v6").get()?.body,
      '{"text":"kept history"}',
    );
    assert.equal(
      retried
        .prepare(
          "SELECT setting_value FROM app_settings WHERE setting_key = 'launch_at_login_enabled'",
        )
        .get()?.setting_value,
      "true",
    );
    assert.equal(
      sourceAfterRetry
        .prepare(
          "SELECT setting_value FROM app_settings WHERE setting_key = 'launch_at_login_enabled'",
        )
        .get()?.setting_value,
      "false",
    );
  } finally {
    retried.close();
    sourceAfterRetry.close();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "junction/symlinkを含むcleanup先を拒否して対象外fileや実DBへ破棄を広げない"
// oracle = { type = "contract", ref = "docs/design/database-schema.md: 専用データ破棄のfilesystem境界" }
// fault = "専用root/descendant/key親のlinkを辿って共有fileを削除する"
// observable = "cleanup rejectionとlink先の共有file内容、未変更の専用DB entry"
// observation_boundary = "public-boundary"
// scope = "Windows junctionを含む実filesystem containmentと本番起動入口"
// lifecycle = "permanent"
// impact = "名前だけで削除すると専用データ外の資産を不可逆に失う"
// distinction = "path文字列のunit testでは実junction/realpathの包含性と削除の副作用を確認できない"
// risk_tags = ["irreversible-data-loss", "privacy"]
// @end-test-value
/** 廃止対象やDBの祖先がリンクなら起動を中断し、リンク先の内容やDB行を残すことを確認する。 */
test("linked cleanup targets and linked database ancestors fail without deleting their destinations", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  await mkdir(outside);
  const keep = path.join(outside, "keep.txt");
  await writeFile(keep, "keep outside");
  const kind = process.platform === "win32" ? "junction" : "dir";
  for (const segments of [
    ["memory-objects"],
    ["memory-objects", "v6", "aa"],
    ["memory-keys"],
  ]) {
    const target = path.join(f.userData, ...segments);
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(outside, target, kind);
    await assert.rejects(resolveOrMigrateAppDatabasePath(f.userData), /linked/);
    assert.equal(await readFile(keep, "utf8"), "keep outside");
    await rm(target);
  }
  const alias = path.join(f.root, "alias");
  await symlink(f.userData, alias, kind);
  await assert.rejects(
    resolveOrMigrateAppDatabasePath(alias),
    /linked|real managed/,
  );
  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  try {
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM memory_entries_v6").get()?.n,
      2,
    );
  } finally {
    db.close();
  }
});
