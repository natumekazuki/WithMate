import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  CHARACTER_DEFINITION_SCHEMA,
  parseCharacterDefinitionMarkdown,
  validateCharacterNotesMarkdown,
} from "../src/character/character-definition.js";
import {
  DEFAULT_CHARACTER_THEME,
  type CharacterCatalogEntry,
  type CharacterCatalogState,
  type CharacterDetail,
  type CharacterRuntimeSnapshot,
  type CharacterTheme,
  type CreateCharacterInput,
  type ImportCharacterPackFileResult,
  type ResolveLaunchCharacterInput,
  type UpdateCharacterDefinitionInput,
  type UpdateCharacterMetadataInput,
} from "../src/character/character-catalog.js";
import { parseCharacterPackZipFile } from "./character-pack-import.js";
import {
  APP_DATABASE_V4_FILENAME,
  assertV4SchemaInitializationAllowed,
} from "./database-schema-v4.js";
import { openAppDatabase } from "./sqlite-connection.js";

const CHARACTER_ROOT_DIRECTORY = "characters";
const CHARACTER_DEFINITION_FILE = "character.md";
const CHARACTER_NOTES_FILE = "character-notes.md";
const CHARACTER_ID_MAX_LENGTH = 80;

const CREATE_CHARACTER_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    icon_file_path TEXT NOT NULL DEFAULT '',
    theme_main TEXT NOT NULL DEFAULT '#6f8cff',
    theme_sub TEXT NOT NULL DEFAULT '#6fb8c7',
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_characters_single_default
    ON characters(is_default)
    WHERE is_default = 1;

  CREATE INDEX IF NOT EXISTS idx_characters_state_updated
    ON characters(state, updated_at DESC);
`;

type CharacterRow = {
  id: string;
  name: string;
  description: string;
  icon_file_path: string;
  theme_main: string;
  theme_sub: string;
  state: CharacterCatalogState;
  is_default: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function byteSize(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Character name は文字列で指定してね。");
  }

  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw new Error("Character name は空にできないよ。");
  }
  return normalized;
}

function normalizeDescription(value: unknown, fallback = ""): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string") {
    return fallback;
  }
  return value.trim().replace(/\s+/g, " ");
}

function normalizeOptionalPath(value: unknown, fallback = ""): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string") {
    return fallback;
  }
  return value.trim();
}

function normalizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    return fallback;
  }
  return normalized.toLowerCase();
}

function normalizeTheme(value: Partial<CharacterTheme> | undefined, fallback = DEFAULT_CHARACTER_THEME): CharacterTheme {
  return {
    main: normalizeHexColor(value?.main, fallback.main),
    sub: normalizeHexColor(value?.sub, fallback.sub),
  };
}

function slugifyCharacterId(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, CHARACTER_ID_MAX_LENGTH);

  return normalized || "character";
}

function buildDefaultDefinitionMarkdown(name: string, description: string): string {
  return `---
schema: ${CHARACTER_DEFINITION_SCHEMA}
name: "${name.replaceAll("\"", "\\\"")}"
description: "${description.replaceAll("\"", "\\\"")}"
---

# Character Runtime Definition

## Identity
- ${name}
`;
}

function buildDefaultNotesMarkdown(name: string): string {
  return `# Character Notes

## Evidence / Sources

## Interpretation Notes

## Rejected Ideas

## Revision Notes
- Created initial V5 Core character entry for ${name}.

## Future Improvements

## Long Knowledge
`;
}

export class CharacterStorage {
  private readonly db: DatabaseSync;
  private readonly characterRootPath: string;

  constructor(dbPath: string, userDataPath: string) {
    assertV4SchemaInitializationAllowed(dbPath, "CharacterStorage");
    this.db = openAppDatabase(dbPath);
    this.characterRootPath = path.join(userDataPath, CHARACTER_ROOT_DIRECTORY);
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(CREATE_CHARACTER_TABLE_SQL);
    mkdirSync(this.characterRootPath, { recursive: true });
  }

  private characterDirectory(characterId: string): string {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(characterId)) {
      throw new Error("Character id が不正です。");
    }
    return path.join(this.characterRootPath, characterId);
  }

  private characterFilePath(characterId: string, fileName: string): string {
    return path.join(this.characterDirectory(characterId), fileName);
  }

  private toEntry(row: CharacterRow): CharacterCatalogEntry {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      iconFilePath: row.icon_file_path,
      theme: {
        main: row.theme_main,
        sub: row.theme_sub,
      },
      state: row.state,
      isDefault: row.is_default === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
    };
  }

  private readCharacterRow(characterId: string): CharacterRow | null {
    return this.db.prepare(`
      SELECT id, name, description, icon_file_path, theme_main, theme_sub, state,
        is_default, created_at, updated_at, archived_at
      FROM characters
      WHERE id = ?
    `).get(characterId) as CharacterRow | undefined ?? null;
  }

  private readDefinitionMarkdown(characterId: string): string {
    return readFileSync(this.characterFilePath(characterId, CHARACTER_DEFINITION_FILE), "utf8");
  }

  private readNotesMarkdown(characterId: string): string {
    try {
      return readFileSync(this.characterFilePath(characterId, CHARACTER_NOTES_FILE), "utf8");
    } catch {
      return "";
    }
  }

  private writeDefinitionFiles(characterId: string, definitionMarkdown: string, notesMarkdown?: string): void {
    const definitionResult = parseCharacterDefinitionMarkdown(definitionMarkdown);
    if (!definitionResult.ok) {
      throw new Error(`character.md validation failed: ${definitionResult.issues.map((issue) => issue.code).join(", ")}`);
    }

    if (notesMarkdown !== undefined) {
      const notesIssues = validateCharacterNotesMarkdown(notesMarkdown);
      if (notesIssues.length > 0) {
        throw new Error(`character-notes.md validation failed: ${notesIssues.map((issue) => issue.code).join(", ")}`);
      }
    }

    mkdirSync(this.characterDirectory(characterId), { recursive: true });
    writeFileSync(this.characterFilePath(characterId, CHARACTER_DEFINITION_FILE), definitionMarkdown, "utf8");
    if (notesMarkdown !== undefined) {
      writeFileSync(this.characterFilePath(characterId, CHARACTER_NOTES_FILE), notesMarkdown, "utf8");
    }
  }

  private createUniqueCharacterId(name: string): string {
    const baseId = slugifyCharacterId(name);
    if (!this.readCharacterRow(baseId)) {
      return baseId;
    }

    for (let index = 2; index <= 999; index += 1) {
      const candidate = `${baseId}-${index}`;
      if (!this.readCharacterRow(candidate)) {
        return candidate;
      }
    }

    return `${baseId}-${randomUUID().slice(0, 8)}`;
  }

  listCharacters(options: { includeArchived?: boolean } = {}): CharacterCatalogEntry[] {
    const rows = options.includeArchived
      ? this.db.prepare(`
        SELECT id, name, description, icon_file_path, theme_main, theme_sub, state,
          is_default, created_at, updated_at, archived_at
        FROM characters
        ORDER BY is_default DESC, state ASC, updated_at DESC, name ASC
      `).all() as CharacterRow[]
      : this.db.prepare(`
        SELECT id, name, description, icon_file_path, theme_main, theme_sub, state,
          is_default, created_at, updated_at, archived_at
        FROM characters
        WHERE state = 'active'
        ORDER BY is_default DESC, updated_at DESC, name ASC
      `).all() as CharacterRow[];

    return rows.map((row) => this.toEntry(row));
  }

  getCharacter(characterId: string): CharacterDetail | null {
    const row = this.readCharacterRow(characterId);
    if (!row) {
      return null;
    }

    return {
      ...this.toEntry(row),
      definitionMarkdown: this.readDefinitionMarkdown(characterId),
      notesMarkdown: this.readNotesMarkdown(characterId),
    };
  }

  createCharacter(input: CreateCharacterInput): CharacterDetail {
    const name = normalizeName(input.name);
    const description = normalizeDescription(input.description);
    const iconFilePath = normalizeOptionalPath(input.iconFilePath);
    const theme = normalizeTheme(input.theme);
    const characterId = this.createUniqueCharacterId(name);
    const createdAt = nowIso();
    const definitionMarkdown = input.definitionMarkdown ?? buildDefaultDefinitionMarkdown(name, description);
    const notesMarkdown = input.notesMarkdown ?? buildDefaultNotesMarkdown(name);
    const shouldSetDefault = input.setDefault ?? this.listCharacters().length === 0;

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      if (shouldSetDefault) {
        this.db.prepare("UPDATE characters SET is_default = 0 WHERE is_default = 1").run();
      }
      this.db.prepare(`
        INSERT INTO characters (
          id, name, description, icon_file_path, theme_main, theme_sub,
          state, is_default, created_at, updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)
      `).run(
        characterId,
        name,
        description,
        iconFilePath,
        theme.main,
        theme.sub,
        shouldSetDefault ? 1 : 0,
        createdAt,
        createdAt,
      );
      this.writeDefinitionFiles(characterId, definitionMarkdown, notesMarkdown);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    const created = this.getCharacter(characterId);
    if (!created) {
      throw new Error("作成した Character を読み込めませんでした。");
    }
    return created;
  }

  importCharacterPackFile(filePath: string): ImportCharacterPackFileResult {
    const pack = parseCharacterPackZipFile(filePath);
    const created = this.createCharacter({
      name: pack.name,
      description: pack.description,
      definitionMarkdown: pack.definitionMarkdown,
      notesMarkdown: pack.notesMarkdown,
    });

    try {
      let character = created;
      if (pack.iconAsset) {
        const assetsDirectory = path.join(this.characterDirectory(created.id), "assets");
        mkdirSync(assetsDirectory, { recursive: true });
        const iconFilePath = path.join(assetsDirectory, pack.iconAsset.fileName);
        writeFileSync(iconFilePath, pack.iconAsset.data);
        character = this.updateCharacterMetadata({
          characterId: created.id,
          iconFilePath,
        });
      }

      return {
        character,
        importedFiles: pack.importedFiles,
      };
    } catch (error) {
      this.db.prepare("DELETE FROM characters WHERE id = ?").run(created.id);
      rmSync(this.characterDirectory(created.id), { recursive: true, force: true });
      throw error;
    }
  }

  updateCharacterMetadata(input: UpdateCharacterMetadataInput): CharacterDetail {
    const current = this.getCharacter(input.characterId);
    if (!current) {
      throw new Error("Character が見つかりません。");
    }

    const name = input.name === undefined ? current.name : normalizeName(input.name);
    const description = input.description === undefined
      ? current.description
      : normalizeDescription(input.description);
    const iconFilePath = input.iconFilePath === undefined
      ? current.iconFilePath
      : normalizeOptionalPath(input.iconFilePath);
    const theme = normalizeTheme(input.theme, current.theme);
    const updatedAt = nowIso();

    this.db.prepare(`
      UPDATE characters
      SET name = ?, description = ?, icon_file_path = ?, theme_main = ?, theme_sub = ?, updated_at = ?
      WHERE id = ?
    `).run(name, description, iconFilePath, theme.main, theme.sub, updatedAt, input.characterId);

    const updated = this.getCharacter(input.characterId);
    if (!updated) {
      throw new Error("更新した Character を読み込めませんでした。");
    }
    return updated;
  }

  updateCharacterDefinition(input: UpdateCharacterDefinitionInput): CharacterDetail {
    const current = this.getCharacter(input.characterId);
    if (!current) {
      throw new Error("Character が見つかりません。");
    }

    this.writeDefinitionFiles(input.characterId, input.definitionMarkdown, input.notesMarkdown);
    this.db.prepare("UPDATE characters SET updated_at = ? WHERE id = ?").run(nowIso(), input.characterId);

    const updated = this.getCharacter(input.characterId);
    if (!updated) {
      throw new Error("更新した Character を読み込めませんでした。");
    }
    return updated;
  }

  archiveCharacter(characterId: string): CharacterCatalogEntry {
    const current = this.getCharacter(characterId);
    if (!current) {
      throw new Error("Character が見つかりません。");
    }

    const archivedAt = nowIso();
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db.prepare(`
        UPDATE characters
        SET state = 'archived', is_default = 0, archived_at = ?, updated_at = ?
        WHERE id = ?
      `).run(archivedAt, archivedAt, characterId);

      const activeDefault = this.db.prepare(`
        SELECT id
        FROM characters
        WHERE state = 'active' AND is_default = 1
        LIMIT 1
      `).get() as { id: string } | undefined;
      if (!activeDefault) {
        const fallback = this.db.prepare(`
          SELECT id
          FROM characters
          WHERE state = 'active'
          ORDER BY updated_at DESC, name ASC
          LIMIT 1
        `).get() as { id: string } | undefined;
        if (fallback) {
          this.db.prepare("UPDATE characters SET is_default = 1 WHERE id = ?").run(fallback.id);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    const archived = this.readCharacterRow(characterId);
    if (!archived) {
      throw new Error("archive した Character を読み込めませんでした。");
    }
    return this.toEntry(archived);
  }

  setDefaultCharacter(characterId: string): CharacterCatalogEntry {
    const current = this.readCharacterRow(characterId);
    if (!current || current.state !== "active") {
      throw new Error("Default にできる active Character が見つかりません。");
    }

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db.prepare("UPDATE characters SET is_default = 0 WHERE is_default = 1").run();
      this.db.prepare("UPDATE characters SET is_default = 1, updated_at = ? WHERE id = ?").run(nowIso(), characterId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    const updated = this.readCharacterRow(characterId);
    if (!updated) {
      throw new Error("Default Character を読み込めませんでした。");
    }
    return this.toEntry(updated);
  }

  resolveLaunchCharacter(input: ResolveLaunchCharacterInput = {}): CharacterDetail | null {
    if (input.characterId) {
      const preferred = this.getCharacter(input.characterId);
      if (preferred?.state === "active") {
        return preferred;
      }
    }

    const row = this.db.prepare(`
      SELECT id, name, description, icon_file_path, theme_main, theme_sub, state,
        is_default, created_at, updated_at, archived_at
      FROM characters
      WHERE state = 'active'
      ORDER BY is_default DESC, updated_at DESC, name ASC
      LIMIT 1
    `).get() as CharacterRow | undefined;

    return row ? this.getCharacter(row.id) : null;
  }

  createRuntimeSnapshot(characterId: string): CharacterRuntimeSnapshot | null {
    const detail = this.getCharacter(characterId);
    if (!detail || detail.state !== "active") {
      return null;
    }

    return {
      characterId: detail.id,
      name: detail.name,
      description: detail.description,
      iconFilePath: detail.iconFilePath,
      theme: detail.theme,
      definitionMarkdown: detail.definitionMarkdown,
      definitionSha256: sha256Hex(detail.definitionMarkdown),
      definitionByteSize: byteSize(detail.definitionMarkdown),
      snapshotAt: nowIso(),
    };
  }

  async deleteCharacterRootDirectory(): Promise<void> {
    await rm(this.characterRootPath, { recursive: true, force: true });
    mkdirSync(this.characterRootPath, { recursive: true });
  }

  close(): void {
    this.db.close();
  }
}

export function isCharacterStorageSupportedDatabase(dbPath: string): boolean {
  return path.basename(dbPath) === APP_DATABASE_V4_FILENAME;
}
