import { lstatSync, realpathSync } from "node:fs";
import { lstat, readdir, realpath, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

// 親テーブルより先に子テーブルを並べる。エントリの置換関係に使う外部キー制約は、
// 外側のスキーマトランザクションの終了まで検証を遅延するが、無効にはしない。
export const RETIRED_MEMORY_AFFECT_TABLES = [
  "character_affect_turn_settlements",
  "character_affect_observations_v6",
  "character_affect_mutations_v6",
  "character_affect_idempotency_v6",
  "character_affect_resets_v6",
  "character_affect_events_v6",
  "memory_entry_relations_v6",
  "memory_entry_tags_v6",
  "memory_idempotency_forget_results_v6",
  "memory_idempotency_keys_v6",
  "memory_move_events_v6",
  "memory_mutation_events_v6",
  "memory_protected_objects_v6",
  "memory_target_tag_stats_v6",
  "memory_tag_catalog_v6",
  "memory_entries_v6",
] as const;

const RETIRED_SETTING_KEYS = [
  "memory_generation_enabled",
  "memory_extraction_provider_settings_json",
  "mate_memory_generation_settings_json",
  "memory_file_quota_bytes",
  "character_affect_context_enabled",
  "memory_recording_frequencies_json",
  "background_execution_settings_json",
] as const;

/** ストレージ所有者が実行する既存のスキーマセーブポイント内でだけ呼び出す。 */
export function removeRetiredMemoryAffectDatabaseData(db: DatabaseSync): void {
  const existing = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()
    .map((row) => String(row.name)));
  if (RETIRED_MEMORY_AFFECT_TABLES.some((name) => existing.has(name))) {
    db.exec("PRAGMA defer_foreign_keys = ON;");
    for (const name of RETIRED_MEMORY_AFFECT_TABLES) db.exec(`DROP TABLE IF EXISTS ${name};`);
  }
  if (existing.has("app_settings")) {
    const remove = db.prepare("DELETE FROM app_settings WHERE setting_key = ?");
    for (const key of RETIRED_SETTING_KEYS) remove.run(key);
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function assertWithin(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Retired Memory data is outside the managed directory.");
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

/** 既存データベースに変更を加える前に、DB 自体やその祖先がリンクなら拒否する。 */
export function assertRetiredMemoryAffectDatabasePath(dbPath: string): void {
  const absolute = path.resolve(dbPath);
  const root = path.dirname(absolute);
  const stats = lstatSync(absolute);
  if (!stats.isFile() || stats.isSymbolicLink() || !samePath(realpathSync(root), root)
    || !samePath(realpathSync(absolute), absolute)) {
    throw new Error("Retired Memory cleanup requires an unlinked managed database.");
  }
}

async function inspect(root: string, candidate: string) {
  assertWithin(root, candidate);
  let current = root;
  for (const segment of path.relative(root, candidate).split(path.sep)) {
    current = path.join(current, segment);
    let stats;
    try { stats = await lstat(current); } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (stats.isSymbolicLink() || !samePath(await realpath(current), current)) {
      throw new Error("Retired Memory cleanup refuses linked paths.");
    }
  }
  return lstat(candidate);
}

async function visit(root: string, candidate: string, remove: boolean): Promise<void> {
  const stats = await inspect(root, candidate);
  if (!stats) return;
  if (stats.isDirectory()) {
    for (const name of await readdir(candidate)) await visit(root, path.join(candidate, name), remove);
    if (remove) {
      await inspect(root, candidate);
      await rmdir(candidate);
    }
  } else if (stats.isFile()) {
    if (remove) {
      await inspect(root, candidate);
      await rm(candidate);
    }
  } else {
    throw new Error("Retired Memory cleanup found an unsupported file type.");
  }
}

/** 所有範囲にある V6 のペイロードとステージングデータ、およびラップ済み鍵だけを削除する。外部の登録は削除しない。 */
export async function removeRetiredMemoryAffectFiles(userDataPath: string): Promise<void> {
  const root = path.resolve(userDataPath);
  let stats;
  try { stats = await lstat(root); } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink() || !samePath(await realpath(root), root)) {
    throw new Error("Retired Memory cleanup requires a real managed directory.");
  }
  const objects = path.join(root, "memory-objects", "v6");
  const keyring = path.join(root, "memory-keys", "v6-keyring.json");
  // どちらかを削除する前に両方の対象を検査する。再帰処理中にリンクをたどらない。
  await visit(root, objects, false);
  const key = await inspect(root, keyring);
  if (key && !key.isFile()) throw new Error("Retired Memory keyring is not a regular file.");
  await visit(root, objects, true);
  if (key) {
    await inspect(root, keyring);
    await rm(keyring);
  }
}
