import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import {
  cloneCharacterMemoryEntries,
  cloneCharacterScopes,
  normalizeCharacterMemoryEntry,
  normalizeCharacterScope,
} from "../src/memory-state.js";
import type { ManagedCharacterMemoryGroup, MemoryManagementPageRequest } from "../src/memory-management-state.js";
import type { CharacterMemoryEntry, CharacterScope } from "../src/memory-state.js";
import { CREATE_CHARACTER_MEMORY_TABLES_SQL } from "./database-schema-v1.js";
import { openAppDatabase } from "./sqlite-connection.js";

type CharacterScopeRow = {
  id: string;
  character_id: string;
  display_name: string;
  created_at: string;
  updated_at: string;
};

type CharacterMemoryEntryRow = {
  id: string;
  character_scope_id: string;
  source_session_id: string | null;
  category: string;
  title: string;
  detail: string;
  keywords_json: string;
  evidence_json: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
};

const CHARACTER_SCOPE_SELECT_COLUMNS = `
  id,
  character_id,
  display_name,
  created_at,
  updated_at
`;

const CHARACTER_MEMORY_ENTRY_SELECT_COLUMNS = `
  id,
  character_scope_id,
  source_session_id,
  category,
  title,
  detail,
  keywords_json,
  evidence_json,
  created_at,
  updated_at,
  last_used_at
`;

function rowToCharacterScope(row: CharacterScopeRow): CharacterScope | null {
  return normalizeCharacterScope({
    id: row.id,
    characterId: row.character_id,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function rowToCharacterMemoryEntry(row: CharacterMemoryEntryRow): CharacterMemoryEntry | null {
  return normalizeCharacterMemoryEntry({
    id: row.id,
    characterScopeId: row.character_scope_id,
    sourceSessionId: row.source_session_id,
    category: row.category,
    title: row.title,
    detail: row.detail,
    keywords: JSON.parse(row.keywords_json),
    evidence: JSON.parse(row.evidence_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  });
}

type CharacterMemoryPageRow = CharacterMemoryEntryRow & {
  scope_id: string;
  scope_character_id: string;
  scope_display_name: string;
  scope_created_at: string;
  scope_updated_at: string;
};

function normalizePageCursor(cursor: MemoryManagementPageRequest["cursor"]): number {
  return typeof cursor === "number" && Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
}

function normalizePageLimit(limit: MemoryManagementPageRequest["limit"]): number {
  return typeof limit === "number" && Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 50;
}

function pushSearchParam(params: SQLInputValue[], searchText: string): void {
  params.push(searchText);
}

function buildCharacterMemoryPageWhere(request: MemoryManagementPageRequest): { sql: string; params: SQLInputValue[] } {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  const searchText = typeof request.searchText === "string" ? request.searchText.trim().toLowerCase() : "";

  if (request.characterCategory && request.characterCategory !== "all") {
    clauses.push("e.category = ?");
    params.push(request.characterCategory);
  }

  if (searchText) {
    clauses.push(`
      (
        instr(lower(
          s.display_name || char(10) ||
          s.character_id || char(10) ||
          e.title || char(10) ||
          e.detail || char(10) ||
          e.category
        ), ?) > 0
        OR EXISTS (SELECT 1 FROM json_each(e.keywords_json) WHERE instr(lower(CAST(value AS TEXT)), ?) > 0)
        OR EXISTS (SELECT 1 FROM json_each(e.evidence_json) WHERE instr(lower(CAST(value AS TEXT)), ?) > 0)
      )
    `);
    pushSearchParam(params, searchText);
    pushSearchParam(params, searchText);
    pushSearchParam(params, searchText);
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function groupCharacterMemoryPageRows(rows: CharacterMemoryPageRow[]): ManagedCharacterMemoryGroup[] {
  const groups = new Map<string, ManagedCharacterMemoryGroup>();

  for (const row of rows) {
    const scope = rowToCharacterScope({
      id: row.scope_id,
      character_id: row.scope_character_id,
      display_name: row.scope_display_name,
      created_at: row.scope_created_at,
      updated_at: row.scope_updated_at,
    });
    const entry = rowToCharacterMemoryEntry(row);
    if (!scope || !entry) {
      continue;
    }

    const existing = groups.get(scope.id);
    if (existing) {
      existing.entries.push(entry);
      continue;
    }

    groups.set(scope.id, { scope, entries: [entry] });
  }

  return [...groups.values()];
}

export class CharacterMemoryStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(CREATE_CHARACTER_MEMORY_TABLES_SQL);
  }

  listCharacterScopes(): CharacterScope[] {
    const rows = this.db.prepare(`
      SELECT ${CHARACTER_SCOPE_SELECT_COLUMNS}
      FROM character_scopes
      ORDER BY updated_at DESC, id DESC
    `).all() as CharacterScopeRow[];
    return cloneCharacterScopes(rows.map(rowToCharacterScope).filter((row): row is CharacterScope => row !== null));
  }

  getCharacterScopeById(characterScopeId: string): CharacterScope | null {
    const row = this.db.prepare(`
      SELECT ${CHARACTER_SCOPE_SELECT_COLUMNS}
      FROM character_scopes
      WHERE id = ?
    `).get(characterScopeId) as CharacterScopeRow | undefined;
    if (!row) {
      return null;
    }

    return rowToCharacterScope(row);
  }

  getCharacterScopeByCharacterId(characterId: string): CharacterScope | null {
    const row = this.db.prepare(`
      SELECT ${CHARACTER_SCOPE_SELECT_COLUMNS}
      FROM character_scopes
      WHERE character_id = ?
    `).get(characterId) as CharacterScopeRow | undefined;
    if (!row) {
      return null;
    }

    return rowToCharacterScope(row);
  }

  ensureCharacterScope(input: Pick<CharacterScope, "characterId" | "displayName">): CharacterScope {
    const characterId = input.characterId.trim();
    if (!characterId) {
      throw new Error("character scope の characterId が空だよ。");
    }

    const displayName = input.displayName.trim() || characterId;
    const now = new Date().toISOString();
    const existing = this.getCharacterScopeByCharacterId(characterId);
    if (existing) {
      this.db.prepare(`
        UPDATE character_scopes
        SET
          display_name = ?,
          updated_at = ?
        WHERE character_id = ?
      `).run(displayName, now, characterId);

      const updated = this.getCharacterScopeByCharacterId(characterId);
      if (!updated) {
        throw new Error("character scope の更新後に再読込できないよ。");
      }

      return updated;
    }

    const characterScopeId = randomUUID();
    this.db.prepare(`
      INSERT INTO character_scopes (
        id,
        character_id,
        display_name,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(characterScopeId, characterId, displayName, now, now);

    const created = this.getCharacterScopeById(characterScopeId);
    if (!created) {
      throw new Error("character scope の作成後に再読込できないよ。");
    }

    return created;
  }

  listCharacterMemoryEntries(characterScopeId: string): CharacterMemoryEntry[] {
    const rows = this.db.prepare(`
      SELECT ${CHARACTER_MEMORY_ENTRY_SELECT_COLUMNS}
      FROM character_memory_entries
      WHERE character_scope_id = ?
      ORDER BY updated_at DESC, id DESC
    `).all(characterScopeId) as CharacterMemoryEntryRow[];
    return cloneCharacterMemoryEntries(
      rows.map(rowToCharacterMemoryEntry).filter((row): row is CharacterMemoryEntry => row !== null),
    );
  }

  listCharacterMemoryPage(request: MemoryManagementPageRequest = {}): { groups: ManagedCharacterMemoryGroup[]; total: number } {
    const cursor = normalizePageCursor(request.cursor);
    const limit = normalizePageLimit(request.limit);
    const direction = request.sort === "updated-asc" ? "ASC" : "DESC";
    const where = buildCharacterMemoryPageWhere(request);
    const totalRow = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM character_memory_entries AS e
      INNER JOIN character_scopes AS s ON s.id = e.character_scope_id
      ${where.sql}
    `).get(...where.params) as { count: number };
    const rows = this.db.prepare(`
      SELECT
        e.id,
        e.character_scope_id,
        e.source_session_id,
        e.category,
        e.title,
        e.detail,
        e.keywords_json,
        e.evidence_json,
        e.created_at,
        e.updated_at,
        e.last_used_at,
        s.id AS scope_id,
        s.character_id AS scope_character_id,
        s.display_name AS scope_display_name,
        s.created_at AS scope_created_at,
        s.updated_at AS scope_updated_at
      FROM character_memory_entries AS e
      INNER JOIN character_scopes AS s ON s.id = e.character_scope_id
      ${where.sql}
      ORDER BY e.updated_at ${direction}, e.id ASC
      LIMIT ? OFFSET ?
    `).all(...where.params, limit, cursor) as CharacterMemoryPageRow[];

    return {
      groups: groupCharacterMemoryPageRows(rows),
      total: totalRow.count,
    };
  }

  deleteCharacterMemoryEntry(entryId: string): void {
    const existing = this.db.prepare(`
      SELECT character_scope_id
      FROM character_memory_entries
      WHERE id = ?
    `).get(entryId) as { character_scope_id: string } | undefined;
    if (!existing) {
      return;
    }

    this.db.prepare(`
      DELETE FROM character_memory_entries
      WHERE id = ?
    `).run(entryId);

    const remaining = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM character_memory_entries
      WHERE character_scope_id = ?
    `).get(existing.character_scope_id) as { count: number };

    if (remaining.count === 0) {
      this.db.prepare(`
        DELETE FROM character_scopes
        WHERE id = ?
      `).run(existing.character_scope_id);
    }
  }

  markCharacterMemoryEntriesUsed(entryIds: string[]): void {
    const uniqueIds = [...new Set(entryIds.map((id) => id.trim()).filter((id) => id.length > 0))];
    if (uniqueIds.length === 0) {
      return;
    }

    const now = new Date().toISOString();
    const placeholders = uniqueIds.map(() => "?").join(", ");
    this.db.prepare(`
      UPDATE character_memory_entries
      SET last_used_at = ?, updated_at = updated_at
      WHERE id IN (${placeholders})
    `).run(now, ...uniqueIds);
  }

  upsertCharacterMemoryEntry(
    input: Omit<CharacterMemoryEntry, "id" | "createdAt" | "updatedAt" | "lastUsedAt"> & { id?: string },
  ): CharacterMemoryEntry {
    const normalized = normalizeCharacterMemoryEntry({
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUsedAt: null,
    });
    if (!normalized) {
      throw new Error("保存する character memory entry の形式が不正だよ。");
    }

    const existing = this.db.prepare(`
      SELECT ${CHARACTER_MEMORY_ENTRY_SELECT_COLUMNS}
      FROM character_memory_entries
      WHERE character_scope_id = ?
        AND category = ?
        AND title = ?
        AND detail = ?
      LIMIT 1
    `).get(
      normalized.characterScopeId,
      normalized.category,
      normalized.title,
      normalized.detail,
    ) as CharacterMemoryEntryRow | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE character_memory_entries
        SET
          source_session_id = ?,
          keywords_json = ?,
          evidence_json = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        normalized.sourceSessionId,
        JSON.stringify(normalized.keywords),
        JSON.stringify(normalized.evidence),
        normalized.updatedAt,
        existing.id,
      );

      const updated = this.db.prepare(`
        SELECT ${CHARACTER_MEMORY_ENTRY_SELECT_COLUMNS}
        FROM character_memory_entries
        WHERE id = ?
      `).get(existing.id) as CharacterMemoryEntryRow | undefined;
      if (!updated) {
        throw new Error("character memory entry の更新後に再読込できないよ。");
      }

      const resolved = rowToCharacterMemoryEntry(updated);
      if (!resolved) {
        throw new Error("character memory entry の更新結果が不正だよ。");
      }

      return resolved;
    }

    this.db.prepare(`
      INSERT INTO character_memory_entries (
        id,
        character_scope_id,
        source_session_id,
        category,
        title,
        detail,
        keywords_json,
        evidence_json,
        created_at,
        updated_at,
        last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.id,
      normalized.characterScopeId,
      normalized.sourceSessionId,
      normalized.category,
      normalized.title,
      normalized.detail,
      JSON.stringify(normalized.keywords),
      JSON.stringify(normalized.evidence),
      normalized.createdAt,
      normalized.updatedAt,
      normalized.lastUsedAt,
    );

    const created = this.db.prepare(`
      SELECT ${CHARACTER_MEMORY_ENTRY_SELECT_COLUMNS}
      FROM character_memory_entries
      WHERE id = ?
    `).get(normalized.id) as CharacterMemoryEntryRow | undefined;
    if (!created) {
      throw new Error("character memory entry の作成後に再読込できないよ。");
    }

    const resolved = rowToCharacterMemoryEntry(created);
    if (!resolved) {
      throw new Error("character memory entry の作成結果が不正だよ。");
    }

    return resolved;
  }

  clearCharacterMemories(): void {
    this.db.exec("DELETE FROM character_memory_entries;");
    this.db.exec("DELETE FROM character_scopes;");
  }

  close(): void {
    this.db.close();
  }
}
