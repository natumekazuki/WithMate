import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  cloneCharacterMemoryEntries,
  cloneCharacterScopes,
  normalizeCharacterMemoryEntry,
  normalizeCharacterScope,
} from "../src/memory-state.js";
import type { CharacterMemoryEntry, CharacterScope } from "../src/memory-state.js";

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

export class CharacterMemoryStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS character_scopes (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS character_memory_entries (
        id TEXT PRIMARY KEY,
        character_scope_id TEXT NOT NULL REFERENCES character_scopes(id) ON DELETE CASCADE,
        source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        keywords_json TEXT NOT NULL DEFAULT '[]',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_character_memory_entries_scope
        ON character_memory_entries(character_scope_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_character_memory_entries_category
        ON character_memory_entries(character_scope_id, category, updated_at DESC);
    `);
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
