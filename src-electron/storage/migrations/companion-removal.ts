import { lstat, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { openAppDatabase, openAppDatabaseReadOnly } from "../sqlite-connection.js";
import { TextBlobStore } from "../text-blob-store.js";
import { resolveSessionFilesDirectory } from "../../files/session-files.js";
import { MemoryProtectedObjectStore } from "../../memory/memory-protected-object-store.js";
import {
  applyCompanionRemovalDatabaseTarget,
  collectCompanionRemovalDatabaseTarget,
  collectCompanionRemovalFileReferences,
  type CompanionRemovalDatabaseTarget,
} from "./companion-removal-database.js";
import { captureCompanionGitRemovalProgress, removeCompanionGitAssets, type CompanionRemovalGitProgress } from "./companion-removal-git.js";

const COMPLETED_KEY = "companion_removal_completed_at";
const PENDING_KEY = "companion_removal_pending";
const DATABASE_NAME = /^(?:withmate(?:-v[2346])?\.db)(?:\.migration-backup-\d+-\d+|\.migration-\d+-\d+\.tmp)?$/;
const BLOB_ROOT_NAME = /^v3(?:\.migration-backup-\d+-\d+)?$/;

type FileIdentity = { device: number; inode: number; born: number };
type FileTarget = { path: string; identity: FileIdentity; done: boolean };
type PersistedDatabaseTarget = FileTarget & {
  data: Pick<CompanionRemovalDatabaseTarget,
    "sessions" | "auxiliarySessionIds" | "ownedBlobIds" | "ownedMemoryEntryIds"
    | "ownedProtectedObjectIds" | "dropTables">
};
type GitTarget = {
  session: CompanionRemovalDatabaseTarget["sessions"][number];
  worktree: FileTarget | null;
  progress: CompanionRemovalGitProgress;
  done: boolean;
};
type RemovalPlan = { userDataPath: string; databasePaths: string[]; databases: PersistedDatabaseTarget[]; files: FileTarget[]; git: GitTarget[] };
export type CompanionRemovalPhase = "prepare" | "files" | "git" | "database";

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function statIfPresent(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Reject links in the complete ancestor chain before opening or deleting managed data. */
async function assertManagedPath(root: string, candidate: string): Promise<void> {
  if (!path.isAbsolute(candidate) || !isWithin(root, candidate)) {
    throw new Error("Companion removal target is outside the managed data directory.");
  }
  let current = path.resolve(root);
  const rootStats = await statIfPresent(current);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("Companion removal requires a real managed data directory.");
  }
  if (!samePath(await realpath(current), current)) {
    throw new Error("Companion removal data directory has a linked ancestor.");
  }
  for (const segment of path.relative(root, candidate).split(path.sep)) {
    current = path.join(current, segment);
    const stats = await statIfPresent(current);
    if (stats?.isSymbolicLink()) throw new Error("Companion removal target contains a symbolic link.");
    if (!stats) break;
  }
}

async function captureFile(root: string, candidate: string): Promise<FileTarget | null> {
  await assertManagedPath(root, candidate);
  const stats = await statIfPresent(candidate);
  return stats ? {
    path: candidate,
    identity: { device: stats.dev, inode: stats.ino, born: stats.birthtimeMs },
    done: false,
  } : null;
}

async function assertSameFile(root: string, target: FileTarget, allowMissing: boolean): Promise<boolean> {
  await assertManagedPath(root, target.path);
  const stats = await statIfPresent(target.path);
  if (!stats) {
    if (allowMissing) return false;
    throw new Error("A database needed for Companion removal is missing.");
  }
  if (stats.dev !== target.identity.device || stats.ino !== target.identity.inode || stats.birthtimeMs !== target.identity.born) {
    throw new Error("A Companion removal target was replaced; the replacement will not be deleted.");
  }
  return true;
}

function withDatabase<T>(databasePath: string, action: (db: DatabaseSync) => T): T {
  const db = openAppDatabase(databasePath);
  try {
    return action(db);
  } finally {
    db.close();
  }
}

function readSetting(db: DatabaseSync, key: string): string | null {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'app_settings'").get()) return null;
  const row = db.prepare("SELECT setting_value FROM app_settings WHERE setting_key = ?").get(key) as { setting_value: string } | undefined;
  return row?.setting_value ?? null;
}

function writeSetting(db: DatabaseSync, key: string, value: string): void {
  db.exec("CREATE TABLE IF NOT EXISTS app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at")
    .run(key, value, new Date().toISOString());
}

async function listDatabasePaths(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if (DATABASE_NAME.test(entry.name)) {
      const databasePath = path.join(root, entry.name);
      await assertManagedPath(root, databasePath);
      if (!entry.isFile()) throw new Error("Managed database path is not a regular file.");
      result.push(databasePath);
    } else if (/^\.withmate-v6-bootstrap-[A-Za-z0-9_-]+$/.test(entry.name)) {
      const bootstrapPath = path.join(root, entry.name);
      await assertManagedPath(root, bootstrapPath);
      const databasePath = path.join(bootstrapPath, "withmate-v6.db");
      if (await statIfPresent(databasePath)) {
        await assertManagedPath(root, databasePath);
        result.push(databasePath);
      }
    }
  }
  // Interrupted older migrations moved sidecars before changing their basename.
  // Restore SQLite's normal sidecar naming in place, never overwrite another file.
  for (const databasePath of result) {
    const match = /^(.*\.db)(\.migration-backup-\d+-\d+)$/.exec(databasePath);
    if (!match) continue;
    for (const suffix of ["-wal", "-shm"]) {
      const oldPath = `${match[1]}${suffix}${match[2]}`;
      const sqlitePath = `${databasePath}${suffix}`;
      await assertManagedPath(root, oldPath);
      await assertManagedPath(root, sqlitePath);
      if (await statIfPresent(oldPath)) {
        if (await statIfPresent(sqlitePath)) throw new Error("Companion removal found conflicting migration backup sidecars.");
        await rename(oldPath, sqlitePath);
      }
    }
  }
  for (const entry of entries) {
    const sidecar = /^(withmate(?:-v[2346])?\.db)-(?:wal|shm)(\.migration-backup-\d+-\d+)$/.exec(entry.name);
    if (sidecar && !result.some((databasePath) => path.basename(databasePath) === `${sidecar[1]}${sidecar[2]}`)) {
      throw new Error("A managed migration backup sidecar has no database; ownership cannot be resolved.");
    }
  }
  for (const databasePath of result) {
    const db = openAppDatabaseReadOnly(databasePath);
    try {
      const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      const generation = Number(/withmate-v([2346])\.db/.exec(path.basename(databasePath))?.[1] ?? 1);
      if (version > generation) throw new Error(`Managed database has an unsupported newer version: user_version=${version}.`);
    } finally { db.close(); }
  }
  return result.sort((left, right) => Number(path.basename(right) === "withmate-v6.db") - Number(path.basename(left) === "withmate-v6.db") || left.localeCompare(right));
}

async function listBlobRoots(root: string): Promise<string[]> {
  const blobParent = path.join(root, "blobs");
  if (!(await statIfPresent(blobParent))) return [];
  await assertManagedPath(root, blobParent);
  const entries = await readdir(blobParent, { withFileTypes: true });
  const roots: string[] = [];
  for (const entry of entries) {
    if (!BLOB_ROOT_NAME.test(entry.name)) continue;
    const blobRoot = path.join(blobParent, entry.name);
    await assertManagedPath(root, blobRoot);
    if (!entry.isDirectory()) throw new Error("Managed blob root is not a directory.");
    roots.push(blobRoot);
  }
  return roots;
}

async function collectFileTargets(root: string, data: CompanionRemovalDatabaseTarget[]): Promise<FileTarget[]> {
  const targets: FileTarget[] = [];
  const preservedIds = new Set(data.flatMap((item) => item.preservedSessionIds));
  const protectedPaths = data.flatMap((item) => item.survivingFilePaths).filter((value) => path.isAbsolute(value));
  for (const sessionId of preservedIds) protectedPaths.push(resolveSessionFilesDirectory(root, sessionId));
  const blobRoots = await listBlobRoots(root);
  const survivingBlobs = new Set(data.flatMap((item) => item.survivingBlobIds));
  const removedIds = new Set(data.flatMap((item) => [...item.sessions.map((session) => session.id), ...item.auxiliarySessionIds]));
  const removalDirectories = [
    ...[...removedIds].map((id) => resolveSessionFilesDirectory(root, id)),
    ...data.flatMap((item) => item.sessions.map((session) => session.worktreePath)),
  ];
  let hasRemovalDirectory = false;
  for (const directory of removalDirectories) {
    if (await statIfPresent(directory)) {
      hasRemovalDirectory = true;
      break;
    }
  }
  if (hasRemovalDirectory) {
    // Legacy message previews may omit an attachment reference. Inspect the
    // surviving full blobs before removing a folder shared by a live message.
    // If all retired folders are already absent, no attachment can be deleted.
    const preserveReferences = (value: unknown): void => {
      if (typeof value === "string") {
        protectedPaths.push(...collectCompanionRemovalFileReferences(value));
      } else if (Array.isArray(value)) value.forEach(preserveReferences);
      else if (value && typeof value === "object") Object.values(value).forEach(preserveReferences);
    };
    for (const blobId of survivingBlobs) {
      for (const blobRoot of blobRoots) {
        const blobPath = path.join(blobRoot, blobId.slice(0, 2), blobId.slice(2, 4), `${blobId}.br`);
        await assertManagedPath(root, blobPath);
        if (!(await statIfPresent(blobPath))) continue;
        const content = await new TextBlobStore(blobRoot).getText(blobId);
        preserveReferences(content);
        let structured: unknown;
        try { structured = JSON.parse(content); } catch { continue; }
        preserveReferences(structured);
      }
    }
  }
  for (const session of data.flatMap((item) => item.sessions)) {
    if (await statIfPresent(session.worktreePath) && protectedPaths.some((preserved) => samePath(preserved, session.worktreePath)
      || isWithin(session.worktreePath, preserved) || isWithin(preserved, session.worktreePath))) {
      throw new Error("A live owner references the Companion worktree; shared files will not be deleted.");
    }
  }

  async function add(candidate: string): Promise<void> {
    if (protectedPaths.some((preserved) => samePath(preserved, candidate) || isWithin(preserved, candidate))) return;
    const target = await captureFile(root, candidate);
    if (!target) return;
    const protectedChildren = protectedPaths.some((preserved) => isWithin(candidate, preserved));
    if (protectedChildren) {
      const stats = await lstat(candidate);
      if (!stats.isDirectory()) throw new Error("A shared file reference conflicts with a removal target.");
      for (const entry of await readdir(candidate)) await add(path.join(candidate, entry));
      return;
    }
    targets.push(target);
  }

  for (const sessionId of removedIds) {
    if (preservedIds.has(sessionId)) throw new Error("Companion and active Session ownership overlap.");
    const candidate = resolveSessionFilesDirectory(root, sessionId);
    if (path.basename(candidate) !== sessionId) throw new Error("Companion removal cannot safely resolve a malformed Session ID.");
    await add(candidate);
  }
  for (const blobId of new Set(data.flatMap((item) => item.ownedBlobIds))) {
    if (survivingBlobs.has(blobId)) continue;
    if (!/^[a-f0-9]{64}$/.test(blobId)) throw new Error("Companion removal found an invalid blob ID.");
    for (const blobRoot of blobRoots) {
      for (const extension of ["br", "json"]) {
        await add(path.join(blobRoot, blobId.slice(0, 2), blobId.slice(2, 4), `${blobId}.${extension}`));
      }
    }
  }
  const survivingObjects = new Set(data.flatMap((item) => item.survivingProtectedObjectIds));
  const objectStore = MemoryProtectedObjectStore.fromUserDataPath(root);
  for (const objectId of new Set(data.flatMap((item) => item.ownedProtectedObjectIds))) {
    if (!survivingObjects.has(objectId)) await add(objectStore.resolveObjectPath(objectId));
  }
  return targets.filter((target, index) => targets.findIndex((other) => samePath(other.path, target.path)) === index);
}

function parsePlan(value: string, root: string, paths: string[]): RemovalPlan {
  const plan = JSON.parse(value) as RemovalPlan;
  if (!plan || plan.userDataPath !== root || !Array.isArray(plan.databases) || !Array.isArray(plan.files) || !Array.isArray(plan.git)) {
    throw new Error("Companion removal progress is invalid.");
  }
  if (!plan.databases.length || !Array.isArray(plan.databasePaths)
    || plan.databasePaths.length !== paths.length || plan.databasePaths.some((databasePath) => !paths.includes(databasePath))
    || plan.databases.some((database) => !paths.includes(database.path))) {
    throw new Error("Managed databases changed while Companion removal was pending.");
  }
  for (const target of [...plan.databases, ...plan.files, ...plan.git.flatMap((target) => target.worktree ? [target.worktree] : [])]) {
    if (typeof target.path !== "string" || !isWithin(root, target.path) || typeof target.done !== "boolean"
      || !target.identity || ![target.identity.device, target.identity.inode, target.identity.born].every(Number.isFinite)) {
      throw new Error("Companion removal target metadata is invalid.");
    }
  }
  const inventories = plan.databases.map((database) => database.data);
  const sessionFolders = inventories.flatMap((data) => [...data.sessions.map((session) => session.id), ...data.auxiliarySessionIds])
    .map((id) => {
      const folder = resolveSessionFilesDirectory(root, id);
      if (path.basename(folder) !== id) throw new Error("Invalid Session ID in removal progress.");
      return folder;
    });
  const objectStore = MemoryProtectedObjectStore.fromUserDataPath(root);
  const objectPaths = inventories.flatMap((data) => data.ownedProtectedObjectIds).map((id) => objectStore.resolveObjectPath(id));
  const blobIds = new Set(inventories.flatMap((data) => data.ownedBlobIds));
  for (const file of plan.files) {
    const segments = path.relative(root, file.path).split(path.sep);
    const blob = segments.length === 5 && segments[0] === "blobs" && BLOB_ROOT_NAME.test(segments[1])
      && /^([a-f0-9]{64})\.(?:br|json)$/.exec(segments[4]);
    const ownedBlob = blob && blobIds.has(blob[1]) && segments[2] === blob[1].slice(0, 2) && segments[3] === blob[1].slice(2, 4);
    if (!ownedBlob && !objectPaths.some((candidate) => samePath(candidate, file.path))
      && !sessionFolders.some((folder) => samePath(folder, file.path) || isWithin(folder, file.path))) {
      throw new Error("Removal progress contains a file outside the recorded owners.");
    }
  }
  return plan;
}

/** Runs on the bootstrap storage worker, before any runtime/store can recreate old data. */
export async function removeCompanionData(
  userDataPath: string,
  onProgress?: (phase: CompanionRemovalPhase) => void,
): Promise<void> {
  const root = path.resolve(userDataPath);
  if (!(await statIfPresent(root))) return;
  try {
    const databasePaths = await listDatabasePaths(root);
    if (!databasePaths.length) return;
    const pending = databasePaths.flatMap((databasePath) => {
      const saved = withDatabase(databasePath, (db) => readSetting(db, PENDING_KEY));
      return saved ? [{ databasePath, saved }] : [];
    });
    if (pending.length > 1) throw new Error("Multiple pending Companion removal operations need resolution.");
    let anchor: string;
    let plan: RemovalPlan;
    if (pending.length) {
      anchor = pending[0].databasePath;
      plan = parsePlan(pending[0].saved, root, databasePaths);
    } else {
      const unfinished = databasePaths.filter((databasePath) => !withDatabase(databasePath, (db) => readSetting(db, COMPLETED_KEY)));
      if (!unfinished.length) return;
      onProgress?.("prepare");
      // Include completed databases in reference checks: their live owners may
      // still share files/blobs with a newly discovered migration backup.
      let inventories = databasePaths.map((databasePath) => withDatabase(databasePath,
        (db) => collectCompanionRemovalDatabaseTarget(db, { includeFileReferences: false })));
      // Shared paths matter only when any managed database has physical removal
      // candidates. Include all databases then, not just the one owning them.
      if (inventories.some((data) => data.sessions.length || data.auxiliarySessionIds.length
        || data.ownedBlobIds.length || data.ownedProtectedObjectIds.length)) {
        inventories = databasePaths.map((databasePath) => withDatabase(databasePath, collectCompanionRemovalDatabaseTarget));
      }
      const databases: PersistedDatabaseTarget[] = [];
      for (const databasePath of unfinished) {
        const file = await captureFile(root, databasePath);
        if (!file) throw new Error("A database disappeared while preparing Companion removal.");
        const data = inventories[databasePaths.indexOf(databasePath)];
        databases.push({
          ...file,
          data: {
            sessions: data.sessions,
            auxiliarySessionIds: data.auxiliarySessionIds,
            ownedBlobIds: data.ownedBlobIds,
            ownedMemoryEntryIds: data.ownedMemoryEntryIds,
            ownedProtectedObjectIds: data.ownedProtectedObjectIds,
            dropTables: data.dropTables,
          },
        });
      }
      const sessions = databases.flatMap((database) => database.data.sessions);
      const git: GitTarget[] = [];
      for (const session of sessions) {
        const duplicate = git.some((item) => item.session.id === session.id
          && samePath(item.session.repoRoot, session.repoRoot)
          && samePath(item.session.worktreePath, session.worktreePath)
          && item.session.companionBranch === session.companionBranch
          && item.session.baseSnapshotRef === session.baseSnapshotRef);
        if (!duplicate) git.push({
          session,
          worktree: await statIfPresent(session.worktreePath) ? await captureFile(root, session.worktreePath) : null,
          progress: await captureCompanionGitRemovalProgress({ ...session, sessionId: session.id, userDataPath: root }),
          done: false,
        });
      }
      anchor = databases[0].path;
      plan = { userDataPath: root, databasePaths, databases, files: await collectFileTargets(root, inventories), git };
      withDatabase(anchor, (db) => writeSetting(db, PENDING_KEY, JSON.stringify(plan)));
    }
    const save = () => withDatabase(anchor, (db) => writeSetting(db, PENDING_KEY, JSON.stringify(plan)));
    for (const database of plan.databases) await assertSameFile(root, database, false);
    for (const file of plan.files) {
      if (file.done) continue;
      onProgress?.("files");
      if (await assertSameFile(root, file, true)) await rm(file.path, { recursive: true, force: true });
      file.done = true;
      save();
    }
    for (const target of plan.git) {
      if (target.done) continue;
      onProgress?.("git");
      if (!target.progress.worktreeDone) {
        if (target.worktree) await assertSameFile(root, target.worktree, true);
        else if (await statIfPresent(target.session.worktreePath)) {
          throw new Error("A Companion removal worktree appeared after preparation; it will not be deleted.");
        }
      }
      await removeCompanionGitAssets({ ...target.session, sessionId: target.session.id, userDataPath: root }, target.progress, save);
      target.done = true;
      save();
    }
    const survivingBlobs = new Set(databasePaths.flatMap((databasePath) => withDatabase(databasePath,
      (db) => collectCompanionRemovalDatabaseTarget(db, { includeFileReferences: false })).survivingBlobIds));
    for (const database of plan.databases) {
      if (database.done) continue;
      onProgress?.("database");
      await assertSameFile(root, database, false);
      withDatabase(database.path, (db) => {
        applyCompanionRemovalDatabaseTarget(db, { ...database.data, survivingBlobIds: [...survivingBlobs] });
        writeSetting(db, COMPLETED_KEY, new Date().toISOString());
        const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
        if (checkpoint.busy) throw new Error("Companion removal database checkpoint is busy.");
      });
      database.done = true;
      save();
    }
    withDatabase(anchor, (db) => { db.prepare("DELETE FROM app_settings WHERE setting_key = ?").run(PENDING_KEY); });
  } catch (error) {
    throw new Error(`Companion data removal is incomplete. Resolve the reported problem and restart to resume: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
