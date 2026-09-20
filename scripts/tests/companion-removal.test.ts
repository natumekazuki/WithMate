import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { ensureV6Schema } from "../../src-electron/database-schema-v6.js";
import { removeCompanionData } from "../../src-electron/companion-removal.js";
import { resolveOrMigrateAppDatabasePath } from "../../src-electron/app-database-path.js";
import { SyncTextBlobStore } from "../../src-electron/text-blob-store.js";
import { CREATE_V3_SCHEMA_SQL } from "../../src-electron/database-schema-v3.js";

const execFileAsync = promisify(execFile);
const sessionId = "companion-session-729";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], { windowsHide: true });
  return result.stdout.trim();
}

async function fixture(t: TestContext, sharedAttachment = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-removal-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const userData = path.join(root, "data");
  const repo = path.join(root, "repo");
  await mkdir(repo);
  await mkdir(userData);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Fixture");
  await git(repo, "config", "user.email", "fixture@example.invalid");
  await writeFile(path.join(repo, "keep.txt"), "normal workspace");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "base");
  const base = await git(repo, "rev-parse", "HEAD");
  const ref = `refs/withmate/companion/${sessionId}/base`;
  const branch = `withmate/companion/${sessionId}`;
  const worktree = path.join(userData, "cw", "cs-729");
  await git(repo, "update-ref", ref, base);
  await mkdir(path.dirname(worktree));
  await git(repo, "worktree", "add", "-b", branch, worktree, base);
  await writeFile(path.join(worktree, "uncommitted.txt"), "owned unmerged work");
  const dbPath = path.join(userData, "withmate-v6.db");
  const blobStore = new SyncTextBlobStore(path.join(userData, "blobs", "v3"));
  const ownedBlob = blobStore.putText({ contentType: "text/plain", text: "owned message" }).blobId;
  const sharedBlob = blobStore.putText({
    contentType: "text/plain",
    text: sharedAttachment ? `Shared attachment [file](<${path.join(userData, "session-files", sessionId, "shared.txt").replaceAll("\\", "/")}>)` : "shared message",
  }).blobId;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    ensureV6Schema(db);
    db.exec(`
      CREATE TABLE companion_groups (id TEXT PRIMARY KEY);
      CREATE TABLE companion_sessions (id TEXT PRIMARY KEY, group_id TEXT REFERENCES companion_groups(id), repo_root TEXT, target_branch TEXT, base_snapshot_ref TEXT, base_snapshot_commit TEXT, companion_branch TEXT, worktree_path TEXT);
      CREATE TABLE companion_messages (id INTEGER PRIMARY KEY, session_id TEXT REFERENCES companion_sessions(id) ON DELETE CASCADE, text_blob_id TEXT);
      CREATE TABLE blob_objects (blob_id TEXT PRIMARY KEY);
      CREATE TABLE session_message_artifacts (id INTEGER PRIMARY KEY, artifact_blob_id TEXT);
      INSERT INTO companion_groups VALUES ('group-729');
      INSERT INTO sessions_v6 (id, title, state, provider_id, catalog_revision, model_id, approval_mode, created_at, updated_at, last_active_at, thread_id)
        VALUES ('main-729', 'Main task', 'active', 'codex', 1, 'fixture', 'never', 'now', 'now', 'now', 'keep-thread');
      INSERT INTO auxiliary_sessions (id, parent_session_id, status, created_at, updated_at, payload_json)
        VALUES ('aux-owned', '${sessionId}', 'active', 'now', 'now', '{}'), ('aux-keep', 'main-729', 'active', 'now', 'now', '{}');
      INSERT INTO app_settings VALUES ('ordinary-preference', 'keep-setting', 'now');
    `);
    db.prepare("INSERT INTO companion_sessions VALUES (?, 'group-729', ?, 'main', ?, ?, ?, ?)").run(sessionId, repo, ref, base, branch, worktree);
    db.prepare("INSERT INTO companion_messages VALUES (1, ?, ?), (2, ?, ?)").run(sessionId, ownedBlob, sessionId, sharedBlob);
    db.prepare("INSERT INTO blob_objects VALUES (?), (?)").run(ownedBlob, sharedBlob);
    db.prepare("INSERT INTO session_message_artifacts VALUES (1, ?)").run(sharedBlob);
  } finally { db.close(); }
  for (const id of [sessionId, "aux-owned", "main-729", "aux-keep", "unrelated-companion-name"]) {
    const directory = path.join(userData, "session-files", id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "file.txt"), id);
  }
  if (sharedAttachment) await writeFile(path.join(userData, "session-files", sessionId, "shared.txt"), "live attachment");
  return { root, userData, repo, worktree, dbPath, ref, branch, ownedBlob, sharedBlob };
}

function query<T>(dbPath: string, sql: string): T {
  const db = new DatabaseSync(dbPath);
  try { return db.prepare(sql).get() as T; } finally { db.close(); }
}

// @test-value v2
// kind = "invariant"
// claim = "起動前migrationは混在DBと保存領域から専有物を削除し、通常会話・共有blob・設定を維持する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
// fault = "単一DBだけを削除して旧DBから専有物を残す、または共有保存物を巻き込む"
// observable = "実DBのschema/行、SessionFolder/blobの存在、Git refとWorkspace内容、更新後の再起動結果"
// observation_boundary = "public-boundary"
// scope = "bootstrap data removal"
// lifecycle = "permanent"
// impact = "リリース更新時の実データ誤削除と専有データ取り残しを防ぐ"
// distinction = "型・buildでは保証できない複数実SQLiteとfilesystem/Gitの更新境界を確認する"
// risk_tags = ["irreversible-data-loss", "privacy"]
// @end-test-value
test("bootstrap removes owned data across managed database copies and preserves live owners", async (t) => {
  const f = await fixture(t);
  const backup = path.join(f.userData, "withmate-v6.db.migration-backup-123-456");
  await copyFile(f.dbPath, backup);
  await removeCompanionData(f.userData);
  for (const dbPath of [f.dbPath, backup]) {
    assert.equal(query(dbPath, "SELECT name FROM sqlite_schema WHERE name='companion_sessions'"), undefined);
    assert.deepEqual({ ...query<Record<string, unknown>>(dbPath, "SELECT thread_id FROM sessions_v6 WHERE id='main-729'") }, { thread_id: "keep-thread" });
    assert.equal(query<{ n: number }>(dbPath, "SELECT count(*) n FROM auxiliary_sessions").n, 1);
    assert.equal(query<{ setting_value: string }>(dbPath, "SELECT setting_value FROM app_settings WHERE setting_key='ordinary-preference'").setting_value, "keep-setting");
  }
  assert.equal(existsSync(path.join(f.userData, "session-files", sessionId)), false);
  assert.equal(existsSync(path.join(f.userData, "session-files", "aux-owned")), false);
  for (const id of ["main-729", "aux-keep", "unrelated-companion-name"]) assert.equal(await readFile(path.join(f.userData, "session-files", id, "file.txt"), "utf8"), id);
  assert.equal(existsSync(path.join(f.userData, "blobs", "v3", f.ownedBlob.slice(0, 2), f.ownedBlob.slice(2, 4), `${f.ownedBlob}.br`)), false);
  assert.equal(existsSync(path.join(f.userData, "blobs", "v3", f.sharedBlob.slice(0, 2), f.sharedBlob.slice(2, 4), `${f.sharedBlob}.br`)), true);
  assert.equal(existsSync(f.worktree), false);
  assert.equal(await readFile(path.join(f.repo, "keep.txt"), "utf8"), "normal workspace");
  assert.equal(await git(f.repo, "for-each-ref", "--format=%(refname)", "refs/withmate", "refs/heads/withmate"), "");
  assert.equal(query(f.dbPath, "SELECT setting_value FROM app_settings WHERE setting_key='companion_removal_pending'"), undefined);
  let phases = 0;
  await removeCompanionData(f.userData, () => { phases++; });
  assert.equal(phases, 0);
  assert.equal(await resolveOrMigrateAppDatabasePath(f.userData), f.dbPath);
});

// @test-value v2
// kind = "invariant"
// claim = "過去のrepositoryとworktreeが既にない記録も撤去し、通常Sessionを保持してDB起動を継続する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
// fault = "退役済みCompanionの古い参照先を必須にして通常Sessionの起動を止める"
// observable = "bootstrapのDB path、専用schema/pendingの不在、通常会話・移動済みWorkspaceの本文"
// observation_boundary = "public-boundary"
// scope = "bootstrap removal with obsolete repository paths"
// lifecycle = "permanent"
// impact = "過去の作業directoryを削除・移動した利用者の更新後の起動不能を防ぐ"
// distinction = "実SQLiteとfilesystemを用いて過去path不在のままbootstrapを通し、型検査では判定できない更新時の契約を検証する"
// @end-test-value
test("bootstrap clears obsolete Companion paths without requiring the retired repository", async (t) => {
  const f = await fixture(t);
  const retainedRepo = path.join(f.root, "moved-repository");
  const retainedWorktree = path.join(f.root, "moved-worktree");
  await rename(f.repo, retainedRepo);
  await rename(f.worktree, retainedWorktree);
  const db = new DatabaseSync(f.dbPath);
  try {
    // A copied database may still refer to its former userData directory.
    db.prepare("UPDATE companion_sessions SET worktree_path = ?")
      .run(path.join(f.root, "old-userdata", "cw", "cs-729"));
  } finally { db.close(); }
  const backup = path.join(f.userData, "withmate-v6.db.migration-backup-456-789");
  await copyFile(f.dbPath, backup);

  assert.equal(await resolveOrMigrateAppDatabasePath(f.userData), f.dbPath);

  for (const dbPath of [f.dbPath, backup]) {
    assert.equal(query(dbPath, "SELECT name FROM sqlite_schema WHERE name='companion_sessions'"), undefined);
    assert.equal(query(dbPath, "SELECT setting_value FROM app_settings WHERE setting_key='companion_removal_pending'"), undefined);
    assert.equal(query<{ thread_id: string }>(dbPath, "SELECT thread_id FROM sessions_v6 WHERE id='main-729'").thread_id, "keep-thread");
    assert.equal(query<{ n: number }>(dbPath, "SELECT count(*) n FROM auxiliary_sessions WHERE id='aux-keep'").n, 1);
  }
  assert.equal(existsSync(path.join(f.userData, "session-files", sessionId)), false);
  assert.equal(await readFile(path.join(f.userData, "session-files", "main-729", "file.txt"), "utf8"), "main-729");
  assert.equal(await readFile(path.join(retainedRepo, "keep.txt"), "utf8"), "normal workspace");
  assert.equal(await readFile(path.join(retainedWorktree, "uncommitted.txt"), "utf8"), "owned unmerged work");
  assert.equal(await resolveOrMigrateAppDatabasePath(f.userData), f.dbPath);
});

// @test-value v2
// kind = "invariant"
// claim = "ファイル削除とDB適用の中断後に対象情報を保持し未完了段階を再開する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
// fault = "失敗を完了扱いし、ファイル位置や専有IDを失って残件を再開できない"
// observable = "中断時の例外/pendingと専用schema、再実行後の物理削除/進捗消去"
// observation_boundary = "public-boundary"
// scope = "bootstrap removal interruption"
// lifecycle = "permanent"
// impact = "更新途中の中断で専有データが永久に残ることを防ぐ"
// distinction = "実処理の段階間で停止し永続化された進捗を次の呼出しで利用する"
// @end-test-value
test("resumes after file and database phase interruptions", async (t) => {
  const f = await fixture(t);
  let files = 0;
  await assert.rejects(removeCompanionData(f.userData, (phase) => {
    if (phase === "files" && ++files === 2) throw new Error("interrupt files");
  }), /incomplete.*interrupt files/);
  assert.ok(query(f.dbPath, "SELECT name FROM sqlite_schema WHERE name='companion_sessions'"));
  assert.ok(query(f.dbPath, "SELECT setting_value FROM app_settings WHERE setting_key='companion_removal_pending'"));
  await assert.rejects(removeCompanionData(f.userData, (phase) => {
    if (phase === "database") throw new Error("interrupt database");
  }), /incomplete.*interrupt database/);
  assert.equal(existsSync(f.worktree), false);
  await removeCompanionData(f.userData);
  assert.equal(query(f.dbPath, "SELECT name FROM sqlite_schema WHERE name='companion_sessions'"), undefined);
  assert.equal(query(f.dbPath, "SELECT setting_value FROM app_settings WHERE setting_key='companion_removal_pending'"), undefined);
});

// @test-value v2
// kind = "invariant"
// claim = "中断後に同名で作られた別directoryへ古い削除要求を適用しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
// fault = "保存済みpathだけで再削除し置き換え後の無関係な内容を消す"
// observable = "再実行の拒否、置換directory内ファイルの保全、未完了進捗"
// observation_boundary = "public-boundary"
// scope = "removal replay ownership"
// lifecycle = "permanent"
// impact = "再開処理による利用者データの不可逆な誤削除を防ぐ"
// distinction = "一時filesystemの実directory identity変化を用いる"
// risk_tags = ["irreversible-data-loss"]
// @end-test-value
test("refuses replacement directories when replaying a pending removal", async (t) => {
  const f = await fixture(t);
  await assert.rejects(removeCompanionData(f.userData, (phase) => {
    if (phase === "files") throw new Error("interrupt");
  }), /incomplete/);
  const directory = path.join(f.userData, "session-files", sessionId);
  await rename(directory, path.join(f.root, "retained-original"));
  await mkdir(directory);
  await writeFile(path.join(directory, "keep.txt"), "unrelated replacement");
  await assert.rejects(removeCompanionData(f.userData), /replaced/);
  assert.equal(await readFile(path.join(directory, "keep.txt"), "utf8"), "unrelated replacement");
});

// @test-value v2
// kind = "invariant"
// claim = "SessionFolderが共有先へのlinkならmigrationは削除せず明示的に停止する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
// fault = "リンクを辿り通常WorkspaceやuserData外を再帰削除する"
// observable = "migrationエラーとリンク先の通常ファイル保全"
// observation_boundary = "public-boundary"
// scope = "removal filesystem boundary"
// lifecycle = "permanent"
// impact = "共有directoryと任意パスの誤削除を防ぐ"
// distinction = "OS上のsymlink/junctionで実境界を確認する"
// risk_tags = ["irreversible-data-loss"]
// @end-test-value
test("rejects a linked SessionFolder before deleting its target", async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.userData, "session-files", sessionId);
  await rm(directory, { recursive: true });
  await symlink(f.repo, directory, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(removeCompanionData(f.userData), /symbolic link/);
  assert.equal(await readFile(path.join(f.repo, "keep.txt"), "utf8"), "normal workspace");
  assert.ok(query(f.dbPath, "SELECT name FROM sqlite_schema WHERE name='companion_sessions'"));
});

// @test-value v2
// kind = "invariant"
// claim = "通常会話の全文blobが参照する共有添付を保持し、同じSessionFolder内の専有ファイルだけ削除する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
// fault = "DB previewに現れない共有添付参照を見落としてdirectoryごと削除する"
// observable = "共有添付の内容と専有ファイルの不在、管理blob backupの専有blob削除"
// observation_boundary = "public-boundary"
// scope = "shared attachment and blob backup preservation"
// lifecycle = "permanent"
// impact = "現役会話から参照できる添付の実データ損失を防ぐ"
// distinction = "実blob復号とfile境界はtype/schemaだけでは保証できない"
// @end-test-value
test("keeps attachment references from full shared blobs and cleans blob backups", async (t) => {
  const f = await fixture(t, true);
  const backupRoot = path.join(f.userData, "blobs", "v3.migration-backup-123-456");
  await cp(path.join(f.userData, "blobs", "v3"), backupRoot, { recursive: true });
  await removeCompanionData(f.userData);
  assert.equal(await readFile(path.join(f.userData, "session-files", sessionId, "shared.txt"), "utf8"), "live attachment");
  assert.equal(existsSync(path.join(f.userData, "session-files", sessionId, "file.txt")), false);
  assert.equal(existsSync(path.join(backupRoot, f.ownedBlob.slice(0, 2), f.ownedBlob.slice(2, 4), `${f.ownedBlob}.br`)), false);
  assert.equal(new SyncTextBlobStore(backupRoot).getText(f.sharedBlob).includes("Shared attachment"), true);
});

// @test-value v2
// kind = "invariant"
// claim = "backupと現DBのbase commitが異なっても退役済みGit資産を撤去し、ref削除の各中断点からmigrationを再開する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
// fault = "backupの古いbase値で拒否する、またはworktree/branch削除後に削除対象情報を失う"
// observable = "2段階のlock失敗とpending/schema保持、解除後のref/schema削除"
// observation_boundary = "public-boundary"
// scope = "multi-generation Git removal recovery"
// lifecycle = "permanent"
// impact = "更新時の部分削除でアプリが恒久的に起動不能になることを防ぐ"
// distinction = "保存済みDBとGit lockを使用しhelper単体ではなくbootstrapの進捗引継ぎを通す"
// @end-test-value
test("resumes branch and base ref failures across differing database snapshots", async (t) => {
  const f = await fixture(t);
  const backup = path.join(f.userData, "withmate-v6.db.migration-backup-789-123");
  await copyFile(f.dbPath, backup);
  await git(f.worktree, "add", ".");
  await git(f.worktree, "commit", "-m", "updated base snapshot");
  const currentBase = await git(f.worktree, "rev-parse", "HEAD");
  await git(f.repo, "update-ref", f.ref, currentBase);
  const db = new DatabaseSync(f.dbPath);
  db.prepare("UPDATE companion_sessions SET base_snapshot_commit = ?").run(currentBase);
  db.close();
  const branchLock = path.join(f.repo, ".git", "refs", "heads", `${f.branch}.lock`);
  const baseLock = path.join(f.repo, ".git", `${f.ref}.lock`);
  await writeFile(branchLock, "fixture lock");
  await assert.rejects(removeCompanionData(f.userData), /incomplete/);
  assert.equal(existsSync(f.worktree), false);
  assert.ok(query(f.dbPath, "SELECT name FROM sqlite_schema WHERE name='companion_sessions'"));
  await rm(branchLock);
  await writeFile(baseLock, "fixture lock");
  await assert.rejects(removeCompanionData(f.userData), /incomplete/);
  assert.equal(await git(f.repo, "for-each-ref", "--format=%(refname)", `refs/heads/${f.branch}`), "");
  assert.ok(query(f.dbPath, "SELECT setting_value FROM app_settings WHERE setting_key='companion_removal_pending'"));
  await rm(baseLock);
  await removeCompanionData(f.userData);
  assert.equal(await git(f.repo, "for-each-ref", "--format=%(refname)", f.ref), "");
  for (const dbPath of [f.dbPath, backup]) assert.equal(query(dbPath, "SELECT name FROM sqlite_schema WHERE name='companion_sessions'"), undefined);
});

// @test-value v2
// kind = "invariant"
// claim = "旧V3管理DBでも共有schema/設定を保持して専有dataを除去し、現役Sessionが使うworktreeは保全する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
// fault = "V6だけを清掃して旧DBを残す、または通常Workspaceとしても使われるworktreeを削除する"
// observable = "初回拒否時のWorkspace保全と、専有関係解決後のV3専用schema除去/通常設定保持"
// observation_boundary = "public-boundary"
// scope = "legacy database and shared workspace removal boundary"
// lifecycle = "permanent"
// impact = "移行対象世代の取り残しと現役Workspaceのデータ損失を防ぐ"
// distinction = "現行schemaのみのtestでは旧DBの保存形態と世代横断参照を検証できない"
// @end-test-value
test("cleans an actual V3 schema but refuses a worktree shared with a live workspace", async (t) => {
  const f = await fixture(t);
  const legacyPath = path.join(f.userData, "withmate-v3.db");
  const current = new DatabaseSync(f.dbPath);
  const session = current.prepare("SELECT * FROM companion_sessions").get() as Record<string, string>;
  current.prepare("UPDATE sessions_v6 SET workspace_path = ? WHERE id='main-729'").run(f.worktree);
  current.close();
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(CREATE_V3_SCHEMA_SQL.join("\n"));
  legacy.exec("CREATE TABLE companion_sessions (id TEXT PRIMARY KEY, group_id TEXT, repo_root TEXT, target_branch TEXT, base_snapshot_ref TEXT, base_snapshot_commit TEXT, companion_branch TEXT, worktree_path TEXT)");
  legacy.prepare("INSERT INTO companion_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(...Object.values(session));
  legacy.prepare("INSERT INTO app_settings VALUES ('ordinary-setting', 'legacy-value', 'now')").run();
  legacy.close();
  await assert.rejects(removeCompanionData(f.userData), /live owner references/);
  assert.equal(await readFile(path.join(f.worktree, "uncommitted.txt"), "utf8"), "owned unmerged work");
  const resumed = new DatabaseSync(f.dbPath);
  resumed.prepare("UPDATE sessions_v6 SET workspace_path = ? WHERE id='main-729'").run(f.repo);
  resumed.close();
  await removeCompanionData(f.userData);
  assert.equal(query(legacyPath, "SELECT name FROM sqlite_schema WHERE name='companion_sessions'"), undefined);
  assert.ok(query(legacyPath, "SELECT name FROM sqlite_schema WHERE name='sessions'"));
  assert.equal(query<{ setting_value: string }>(legacyPath, "SELECT setting_value FROM app_settings WHERE setting_key='ordinary-setting'").setting_value, "legacy-value");
});
