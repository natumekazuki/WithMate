import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";
import { extractComposerAttachmentReferenceCandidates } from "../src/path-reference.js";

export interface CompanionRemovalSessionTarget {
  id: string;
  groupId: string;
  repoRoot: string;
  targetBranch: string;
  baseSnapshotRef: string;
  baseSnapshotCommit: string;
  companionBranch: string;
  worktreePath: string;
}

export interface CompanionRemovalDatabaseTarget {
  sessions: CompanionRemovalSessionTarget[];
  auxiliarySessionIds: string[];
  preservedSessionIds: string[];
  ownedBlobIds: string[];
  survivingBlobIds: string[];
  survivingFilePaths: string[];
  ownedMemoryEntryIds: string[];
  survivingMemoryEntryIds: string[];
  ownedProtectedObjectIds: string[];
  survivingProtectedObjectIds: string[];
  dropTables: string[];
}

type Row = Record<string, unknown>;

/** Local attachments and ordinary Markdown links both remain usable by live conversations. */
export function collectCompanionRemovalFileReferences(value: string): string[] {
  const result = extractComposerAttachmentReferenceCandidates(value).map((reference) => reference.path);
  const visit = (node: { url?: string; children?: unknown[] }): void => {
    if (typeof node.url === "string") {
      try {
        const target = node.url.startsWith("file:") ? fileURLToPath(node.url) : decodeURIComponent(node.url);
        if (path.isAbsolute(target)) result.push(target.replace(/:\d+(?::\d+)?$/, ""));
      } catch { /* An invalid URL cannot resolve to a local attachment. */ }
    }
    for (const child of node.children ?? []) visit(child as Parameters<typeof visit>[0]);
  };
  visit(fromMarkdown(value));
  return result.filter((target) => path.isAbsolute(target));
}

const identifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

function tableNames(db: DatabaseSync): Set<string> {
  return new Set((db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as Row[])
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string"));
}

function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${identifier(table)})`).all() as Row[])
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string"));
}

function* rows(db: DatabaseSync, table: string, requestedColumns: string[]): Generator<Row> {
  const availableColumns = columns(db, table);
  const selectedColumns = [...new Set(requestedColumns)].filter((column) => availableColumns.has(column));
  if (selectedColumns.length === 0) return;
  // Project only removal metadata. Provider payloads can exceed the JS heap,
  // and conversation text needed for attachment protection is read one row at a time.
  yield* db.prepare(`SELECT ${selectedColumns.map(identifier).join(", ")} FROM ${identifier(table)}`).iterate();
}

function text(row: Row, name: string): string {
  return typeof row[name] === "string" ? row[name] as string : "";
}

function key(row: Row, name: string): string {
  return typeof row[name] === "number" ? String(row[name]) : text(row, name);
}

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))].sort();
}

function isCompanionTable(name: string): boolean {
  return COMPANION_TABLES.has(name);
}

const COMPANION_TABLES = new Set([
  "companion_audit_log_details",
  "companion_audit_log_operations",
  "companion_audit_logs",
  "companion_message_artifacts",
  "companion_messages",
  "companion_merge_runs",
  "companion_sessions",
  "companion_groups",
]);

const CONVERSATION_OWNER_COLUMNS = ["session_id", "parent_session_id", "auxiliary_session_id"];

function deletedConversationRow(row: Row, ids: Set<string>): boolean {
  return CONVERSATION_OWNER_COLUMNS.some((column) => ids.has(text(row, column)));
}

function collectBlobReferences(db: DatabaseSync, names: Set<string>, deletedSessionIds: Set<string>): { owned: Set<string>; surviving: Set<string> } {
  const owned = new Set<string>();
  const surviving = new Set<string>();
  for (const table of names) {
    if (table === "blob_objects") continue;
    const tableColumns = [...columns(db, table)].filter((column) => column.endsWith("blob_id"));
    if (tableColumns.length === 0) continue;
    const companionTable = isCompanionTable(table);
    const parent = {
      audit_log_details: ["audit_logs", "audit_log_id"],
      audit_log_operations: ["audit_logs", "audit_log_id"],
      session_message_artifacts: ["session_messages", "message_id"],
      session_turn_provider_outputs_v6: ["session_turns_v6", "turn_id"],
    }[table];
    const ownedParentIds = new Set<string>();
    if (parent && names.has(parent[0]) && deletedSessionIds.size > 0) {
      for (const row of rows(db, parent[0], ["id", ...CONVERSATION_OWNER_COLUMNS])) {
        if (deletedConversationRow(row, deletedSessionIds)) ownedParentIds.add(key(row, "id"));
      }
    }
    for (const row of rows(db, table, [
      ...tableColumns, ...CONVERSATION_OWNER_COLUMNS, ...(parent ? [parent[1]] : []),
    ])) {
      const ownedRow = companionTable
        || (["session_messages", "audit_logs"].includes(table) && deletedConversationRow(row, deletedSessionIds))
        || (parent !== undefined && ownedParentIds.has(key(row, parent[1])));
      for (const column of tableColumns) {
        const blobId = text(row, column);
        if (!blobId) continue;
        (ownedRow ? owned : surviving).add(blobId);
      }
    }
  }
  return { owned, surviving };
}

/** Read removal metadata while the existing storage owner still has the database open. */
export function collectCompanionRemovalDatabaseTarget(db: DatabaseSync): CompanionRemovalDatabaseTarget {
  const names = tableNames(db);
  const sessions: CompanionRemovalSessionTarget[] = [];
  const companionSessionIds = new Set<string>();
  if (names.has("companion_sessions")) {
    for (const row of rows(db, "companion_sessions", [
      "id", "group_id", "repo_root", "target_branch", "base_snapshot_ref",
      "base_snapshot_commit", "companion_branch", "worktree_path",
    ])) {
      const id = text(row, "id");
      if (!id) continue;
      companionSessionIds.add(id);
      sessions.push({
        id,
        groupId: text(row, "group_id"),
        repoRoot: text(row, "repo_root"),
        targetBranch: text(row, "target_branch"),
        baseSnapshotRef: text(row, "base_snapshot_ref"),
        baseSnapshotCommit: text(row, "base_snapshot_commit"),
        companionBranch: text(row, "companion_branch"),
        worktreePath: text(row, "worktree_path"),
      });
    }
  }
  const auxiliarySessionIds = new Set<string>();
  if (names.has("auxiliary_sessions")) {
    const auxiliaryColumns = columns(db, "auxiliary_sessions");
    if (auxiliaryColumns.has("parent_session_id")) {
      for (const row of rows(db, "auxiliary_sessions", ["id", "parent_session_id"])) {
        if (companionSessionIds.has(text(row, "parent_session_id"))) auxiliarySessionIds.add(text(row, "id"));
      }
    }
  }
  const deletedSessionIds = new Set([...companionSessionIds, ...auxiliarySessionIds]);
  for (const table of ["sessions", "sessions_v6"]) {
    if (names.has(table)) {
      for (const row of rows(db, table, ["id"])) {
        if (deletedSessionIds.has(text(row, "id"))) {
          throw new Error("Companion session ID collides with a normal session.");
        }
      }
    }
  }
  const preservedSessionIds = new Set<string>();
  const survivingFilePaths = new Set<string>();
  function preserveTextReferences(value: string): void {
    for (const reference of collectCompanionRemovalFileReferences(value)) survivingFilePaths.add(reference);
  }
  function preservePaths(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const record = value as Row;
    for (const field of ["workspacePath", "sessionFolderPath"]) {
      if (typeof record[field] === "string") survivingFilePaths.add(record[field]);
    }
    if (Array.isArray(record.allowedAdditionalDirectories)) {
      for (const directory of record.allowedAdditionalDirectories) if (typeof directory === "string") survivingFilePaths.add(directory);
    }
    for (const field of ["draft", "composerDraft"]) if (typeof record[field] === "string") preserveTextReferences(record[field]);
    if (Array.isArray(record.messages)) {
      for (const message of record.messages) if (message && typeof message.text === "string") preserveTextReferences(message.text);
    }
  }
  for (const table of ["sessions", "sessions_v6", "auxiliary_sessions"]) {
    if (!names.has(table)) continue;
    for (const row of rows(db, table, [
      "id", "workspace_path", "session_folder_path", "folder_path",
      "allowed_additional_directories_json", "payload_json", "messages_json",
    ])) {
      const id = text(row, "id");
      if (id && !deletedSessionIds.has(id)) preservedSessionIds.add(id);
      if (deletedSessionIds.has(id)) continue;
      for (const column of ["workspace_path", "session_folder_path", "folder_path"]) {
        const filePath = text(row, column);
        if (filePath && !deletedSessionIds.has(id)) survivingFilePaths.add(filePath);
      }
      if (text(row, "allowed_additional_directories_json")) {
        preservePaths({ allowedAdditionalDirectories: JSON.parse(text(row, "allowed_additional_directories_json")) });
      }
      if (text(row, "payload_json")) preservePaths(JSON.parse(text(row, "payload_json")));
      if (text(row, "messages_json")) preservePaths({ messages: JSON.parse(text(row, "messages_json")) });
    }
  }
  for (const table of ["session_messages", "session_messages_v6", "auxiliary_session_drafts"]) {
    if (!names.has(table)) continue;
    for (const row of rows(db, table, [...CONVERSATION_OWNER_COLUMNS, "text", "body", "text_preview", "draft_text"])) {
      if (deletedConversationRow(row, deletedSessionIds)) continue;
      for (const field of ["text", "body", "text_preview", "draft_text"]) preserveTextReferences(text(row, field));
    }
  }
  const blobRefs = collectBlobReferences(db, names, deletedSessionIds);
  const ownedMemorySet = new Set<string>();
  const survivingMemorySet = new Set<string>();
  if (names.has("memory_entries_v6")) {
    for (const row of rows(db, "memory_entries_v6", ["id", "scope_type", "scope_id"])) {
      const owned = text(row, "scope_type") === "session" && deletedSessionIds.has(text(row, "scope_id"));
      const id = text(row, "id");
      if (id) (owned ? ownedMemorySet : survivingMemorySet).add(id);
    }
    for (const row of rows(db, "memory_entries_v6", ["id", "superseded_by_id"])) {
      if (!ownedMemorySet.has(text(row, "id")) && ownedMemorySet.has(text(row, "superseded_by_id"))) {
        throw new Error("A shared Memory entry depends on a session-owned replacement; ownership needs resolution.");
      }
    }
  }
  const ownedProtectedObjectIds = new Set<string>();
  const survivingProtectedObjectIds = new Set<string>();
  if (names.has("memory_protected_objects_v6")) {
    for (const row of rows(db, "memory_protected_objects_v6", ["object_id", "entry_id"])) {
      (ownedMemorySet.has(text(row, "entry_id")) ? ownedProtectedObjectIds : survivingProtectedObjectIds)
        .add(text(row, "object_id"));
    }
  }
  return {
    sessions,
    auxiliarySessionIds: unique(auxiliarySessionIds),
    preservedSessionIds: unique(preservedSessionIds),
    ownedBlobIds: unique(blobRefs.owned),
    survivingBlobIds: unique(blobRefs.surviving),
    survivingFilePaths: unique(survivingFilePaths),
    ownedMemoryEntryIds: unique(ownedMemorySet),
    survivingMemoryEntryIds: unique(survivingMemorySet),
    ownedProtectedObjectIds: unique(ownedProtectedObjectIds),
    survivingProtectedObjectIds: unique(survivingProtectedObjectIds),
    // Drop dependants first so existing V3/V6 foreign-key enforcement cannot
    // reject removal of the companion group/session roots.
    dropTables: [...COMPANION_TABLES].filter((name) => names.has(name)),
  };
}

function deleteByIds(db: DatabaseSync, table: string, column: string, ids: Set<string>): void {
  if (ids.size === 0) return;
  const placeholders = [...ids].map(() => "?").join(", ");
  db.prepare(`DELETE FROM ${identifier(table)} WHERE ${identifier(column)} IN (${placeholders})`).run(...ids);
}

/** Apply only after filesystem/Git removal has succeeded. The transaction contains DB work only. */
export function applyCompanionRemovalDatabaseTarget(
  db: DatabaseSync,
  target: CompanionRemovalDatabaseTarget,
  survivingBlobIds: Iterable<string> = target.survivingBlobIds,
): void {
  const names = tableNames(db);
  const companionSessionIds = new Set(target.sessions.map((session) => session.id));
  const auxiliaryIds = new Set(target.auxiliarySessionIds);
  const deletedIds = new Set([...companionSessionIds, ...auxiliaryIds]);
  const survive = new Set(survivingBlobIds);
  db.exec("BEGIN IMMEDIATE");
  try {
    // Owned supersession chains can reference another entry removed by this
    // same transaction. Enforce every FK at commit, without disabling it.
    db.exec("PRAGMA defer_foreign_keys = ON");
    // Remove audit rows before deleting their owner: legacy audit events use SET
    // NULL rather than CASCADE, which would otherwise erase ownership evidence.
    for (const table of ["audit_logs", "audit_events_v6", "character_affect_events_v6", "character_affect_resets_v6", "character_affect_mutations_v6", "character_affect_observations_v6", "character_affect_turn_settlements", "session_memories", "memory_mutation_events_v6"]) {
      if (!names.has(table)) continue;
      const tableColumns = columns(db, table);
      if (tableColumns.has("session_id")) deleteByIds(db, table, "session_id", deletedIds);
      if (tableColumns.has("auxiliary_session_id")) deleteByIds(db, table, "auxiliary_session_id", auxiliaryIds);
    }
    for (const table of ["session_turns_v6", "session_messages", "session_messages_v6"]) {
      if (!names.has(table)) continue;
      const tableColumns = columns(db, table);
      if (tableColumns.has("session_id")) deleteByIds(db, table, "session_id", deletedIds);
      if (tableColumns.has("auxiliary_session_id")) deleteByIds(db, table, "auxiliary_session_id", auxiliaryIds);
    }
    for (const table of ["auxiliary_session_drafts", "auxiliary_sessions"]) {
      if (!names.has(table)) continue;
      const tableColumns = columns(db, table);
      if (tableColumns.has("auxiliary_session_id")) deleteByIds(db, table, "auxiliary_session_id", auxiliaryIds);
      if (tableColumns.has("parent_session_id")) deleteByIds(db, table, "parent_session_id", companionSessionIds);
    }

    const ownedMemoryIds = new Set(target.ownedMemoryEntryIds);
    if (ownedMemoryIds.size > 0) {
      if (names.has("memory_tag_catalog_v6") && names.has("memory_entry_tags_v6")) {
        const placeholders = [...ownedMemoryIds].map(() => "?").join(",");
        const tags = db.prepare(`
          SELECT t.tag_type_canonical, t.tag_value_canonical, SUM(e.state = 'active') AS active_count
          FROM memory_entry_tags_v6 t JOIN memory_entries_v6 e ON e.id = t.entry_id
          WHERE e.id IN (${placeholders}) GROUP BY t.tag_type_canonical, t.tag_value_canonical
        `).all(...ownedMemoryIds) as Array<{ tag_type_canonical: string; tag_value_canonical: string; active_count: number }>;
        for (const tag of tags) {
          const remaining = db.prepare(`SELECT 1 FROM memory_entry_tags_v6 WHERE tag_type_canonical = ? AND tag_value_canonical = ? AND entry_id NOT IN (${placeholders}) LIMIT 1`)
            .get(tag.tag_type_canonical, tag.tag_value_canonical, ...ownedMemoryIds);
          if (remaining) {
            db.prepare("UPDATE memory_tag_catalog_v6 SET usage_count = MAX(0, usage_count - ?) WHERE tag_type_canonical = ? AND tag_value_canonical = ?")
              .run(tag.active_count, tag.tag_type_canonical, tag.tag_value_canonical);
          } else {
            db.prepare("DELETE FROM memory_tag_catalog_v6 WHERE tag_type_canonical = ? AND tag_value_canonical = ?")
              .run(tag.tag_type_canonical, tag.tag_value_canonical);
          }
        }
      }
      for (const [table, column] of [
        ["memory_entry_tags_v6", "entry_id"], ["memory_entry_relations_v6", "source_entry_id"],
        ["memory_entry_relations_v6", "target_entry_id"], ["memory_idempotency_keys_v6", "response_entry_id"],
        ["memory_idempotency_forget_results_v6", "entry_id"], ["memory_move_events_v6", "entry_id"],
        ["memory_protected_objects_v6", "entry_id"], ["memory_mutation_events_v6", "entry_id"],
      ] as const) {
        if (names.has(table) && columns(db, table).has(column)) deleteByIds(db, table, column, ownedMemoryIds);
      }
      if (names.has("memory_entries_v6")) deleteByIds(db, "memory_entries_v6", "id", ownedMemoryIds);
    }
    for (const table of ["memory_target_tag_stats_v6", "memory_idempotency_keys_v6", "memory_idempotency_forget_results_v6"]) {
      if (!names.has(table) || !columns(db, table).has("scope_id")) continue;
      const tableColumns = columns(db, table);
      if (tableColumns.has("scope_type")) {
        const placeholders = [...deletedIds].map(() => "?").join(", ");
        if (placeholders) db.prepare(`DELETE FROM ${identifier(table)} WHERE scope_type = 'session' AND scope_id IN (${placeholders})`).run(...deletedIds);
      }
    }
    if (names.has("memory_move_events_v6") && deletedIds.size) {
      const placeholders = [...deletedIds].map(() => "?").join(",");
      db.prepare(`DELETE FROM memory_move_events_v6 WHERE (from_scope_type = 'session' AND from_scope_id IN (${placeholders})) OR (to_scope_type = 'session' AND to_scope_id IN (${placeholders}))`)
        .run(...deletedIds, ...deletedIds);
    }
    // Shared Memory and relationship Affect bodies remain; only source linkage is removed.
    if (deletedIds.size) {
      const placeholders = [...deletedIds].map(() => "?").join(",");
      for (const table of ["memory_entries_v6", "project_memory_entries", "character_memory_entries", "character_affect_events_v6", "character_affect_mutations_v6"]) {
        if (!names.has(table)) continue;
        const tableColumns = columns(db, table);
        if (!tableColumns.has("source_session_id")) continue;
        const references = ["source_session_id", "source_app_message_id", "source_provider_message_id", "source_provider_id"]
          .filter((column) => tableColumns.has(column));
        db.prepare(`UPDATE ${identifier(table)} SET ${references.map((column) => `${identifier(column)} = NULL`).join(",")} WHERE source_session_id IN (${placeholders})`)
          .run(...deletedIds);
      }
      for (const table of ["mate_growth_event_evidence", "mate_growth_runs"]) {
        if (names.has(table) && columns(db, table).has("source_session_id")) deleteByIds(db, table, "source_session_id", deletedIds);
      }
      if (names.has("mate_growth_events")) {
        db.prepare(`UPDATE mate_growth_events SET source_session_id = NULL, source_audit_log_id = NULL WHERE source_session_id IN (${placeholders})`)
          .run(...deletedIds);
      }
    }
    // Older Character growth output is independent Memory. Preserve its content
    // while removing the retired source linkage and its execution-only records.
    if (names.has("mate_growth_runs")) db.exec("DELETE FROM mate_growth_runs WHERE source_type = 'companion'");
    if (names.has("mate_growth_cursors")) db.exec("DELETE FROM mate_growth_cursors WHERE scope_type = 'companion'");
    if (names.has("mate_growth_events")) db.exec("UPDATE mate_growth_events SET source_type = 'session', source_session_id = NULL, source_audit_log_id = NULL WHERE source_type = 'companion'");
    for (const table of target.dropTables) {
      if (!COMPANION_TABLES.has(table)) throw new Error("Unknown table in Companion removal target.");
      if (names.has(table)) db.exec(`DROP TABLE ${identifier(table)}`);
    }
    if (names.has("blob_objects")) {
      const removable = target.ownedBlobIds.filter((blobId) => !survive.has(blobId));
      deleteByIds(db, "blob_objects", "blob_id", new Set(removable));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
