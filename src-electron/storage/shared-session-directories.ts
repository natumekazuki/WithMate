import type { DatabaseSync } from "node:sqlite";

import { normalizeAllowedAdditionalDirectories } from "../files/additional-directories.js";

export function readParentDirectoriesJson(db: DatabaseSync, parentSessionId: string): string | undefined {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions_v6'").get()) return undefined;
  const parent = db.prepare("SELECT allowed_additional_directories_json FROM sessions_v6 WHERE id = ?")
    .get(parentSessionId) as { allowed_additional_directories_json: string } | undefined;
  if (!parent) throw new Error("The parent Session could not be found.");
  return parent.allowed_additional_directories_json;
}

export function synchronizeAuxiliaryDirectories(db: DatabaseSync, parentSessionId: string, directoriesJson: string): void {
  db.prepare(`UPDATE auxiliary_sessions SET allowed_additional_directories_json = ?
    WHERE parent_session_id = ? AND allowed_additional_directories_json <> ?`)
    .run(directoriesJson, parentSessionId, directoriesJson);
}

function parseDirectories(value: string): string[] {
  const directories: unknown = JSON.parse(value);
  if (!Array.isArray(directories) || !directories.every((entry) => typeof entry === "string")) {
    throw new Error("Stored Additional Directories must be a string array.");
  }
  return directories;
}

export function mergeParentDirectories(db: DatabaseSync, parentSessionId: string, directories: readonly string[]): void {
  const parent = db.prepare("SELECT workspace_path, allowed_additional_directories_json FROM sessions_v6 WHERE id = ?")
    .get(parentSessionId) as { workspace_path: string; allowed_additional_directories_json: string } | undefined;
  if (!parent) throw new Error("The parent Session could not be found.");
  const merged = normalizeAllowedAdditionalDirectories(parent.workspace_path, [
    ...parseDirectories(parent.allowed_additional_directories_json), ...directories,
  ]);
  const json = JSON.stringify(merged);
  db.prepare("UPDATE sessions_v6 SET allowed_additional_directories_json = ? WHERE id = ?").run(json, parentSessionId);
}

export function migrateSharedSessionDirectories(db: DatabaseSync): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions_v6'").get()) return;
  const parents = db.prepare("SELECT id FROM sessions_v6 WHERE id IN (SELECT parent_session_id FROM auxiliary_sessions)")
    .all() as Array<{ id: string }>;
  for (const { id } of parents) {
    const children = db.prepare(`SELECT allowed_additional_directories_json FROM auxiliary_sessions
      WHERE parent_session_id = ? ORDER BY id`).all(id) as Array<{ allowed_additional_directories_json: string }>;
    mergeParentDirectories(db, id, children.flatMap((row) => parseDirectories(row.allowed_additional_directories_json)));
    synchronizeAuxiliaryDirectories(db, id, readParentDirectoriesJson(db, id)!);
  }
}
