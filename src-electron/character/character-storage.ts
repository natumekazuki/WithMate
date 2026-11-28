import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  copyFile,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  parseCharacterDefinitionMarkdown,
  validateCharacterNotesMarkdown,
} from "../../src-shared/character/character-definition.js";
import {
  buildDefaultCharacterDefinition,
  buildDefaultCharacterNotes,
} from "../../src-shared/character/character-definition-template.js";
import { isUnknownCharacterOwnerId } from "../../src-shared/character/character-owner.js";
import {
  DEFAULT_CHARACTER_THEME,
  type CharacterCatalogEntry,
  type CharacterCatalogState,
  type CharacterDetail,
  type CharacterRuntimeSnapshot,
  type CharacterTheme,
  type CreateCharacterInput,
  type ResolveLaunchCharacterInput,
  type UpdateCharacterDefinitionInput,
  type UpdateCharacterMetadataInput,
} from "../../src-shared/character/character-catalog.js";
import {
  areCharacterIconPathReferencesEquivalent,
  hasCharacterIconPathScheme,
  validateCharacterIconRegistrationPath,
} from "../../src-shared/character/character-icon.js";
import {
  APP_DATABASE_V4_FILENAME,
  assertV4SchemaInitializationAllowed,
} from "../storage/database-schema-v4.js";
import { openAppDatabase } from "../storage/sqlite-connection.js";

const CHARACTER_ROOT_DIRECTORY = "characters";
const CHARACTER_DEFINITION_FILE = "character.md";
const CHARACTER_NOTES_FILE = "character-notes.md";
const CHARACTER_ICON_FILE_BASE = "icon";
const CHARACTER_ICON_MAX_BYTE_SIZE = 10 * 1024 * 1024;
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
    -- Legacy metadata retained until a future table-rebuild migration; runtime code does not read or write it.
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

/** Character カタログの SQLite 行。定義とノートの本文はこの行に含まれない。 */
type CharacterRow = {
  id: string;
  name: string;
  description: string;
  icon_file_path: string;
  theme_main: string;
  theme_sub: string;
  state: CharacterCatalogState;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

/** 登録・更新・スナップショットの時刻を同じ ISO 形式で記録する。 */
function nowIso(): string {
  return new Date().toISOString();
}

/** 定義本文の UTF-8 表現を SHA-256 の16進文字列で識別する。 */
function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** 定義本文のサイズを保存データと同じ UTF-8 バイト数で数える。 */
function byteSize(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

/** 名前の余分な空白を詰め、文字列でない値と空の名前を拒否する。 */
function normalizeName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Character name must be a string.");
  }

  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw new Error("Character name cannot be empty.");
  }
  return normalized;
}

/** 説明の空白を整える。未指定や文字列以外の場合は指定された代替を使う。 */
function normalizeDescription(value: unknown, fallback = ""): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string") {
    return fallback;
  }
  return value.trim().replace(/\s+/g, " ");
}

/** アイコン指定を空白除去した文字列として扱う。未指定は代替を使い、明示した非文字列は拒否する。 */
function normalizeCharacterIconPathInput(
  value: unknown,
  fallback = "",
): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new Error("Character icon path must be a string.");
  }
  return value.trim();
}

/** DB の相対パスで使う区切り文字をスラッシュに統一する。 */
function normalizeDbRelativePath(value: string): string {
  return value.replace(/\\/g, "/");
}

/** 保存済みの相対アイコンパスを userData から解決する。絶対パス・スキーム付き参照は変換しない。 */
export function materializeCharacterIconFilePath(
  userDataPath: string,
  filePath: string,
): string {
  const trimmed = filePath.trim();
  if (
    !trimmed ||
    path.isAbsolute(trimmed) ||
    hasCharacterIconPathScheme(trimmed)
  ) {
    return trimmed;
  }

  return path.join(userDataPath, trimmed);
}

/** アイコンの拡張子を小文字で取得する。絶対パスなら通常ファイルであることと容量上限も確認する。 */
async function safeIconExtension(sourcePath: string): Promise<string> {
  const extension = path.extname(sourcePath).toLowerCase();
  if (!path.isAbsolute(sourcePath)) {
    return extension;
  }

  const stats = await stat(sourcePath);
  if (!stats.isFile()) {
    throw new Error("Character icon must be a regular file.");
  }
  if (stats.size > CHARACTER_ICON_MAX_BYTE_SIZE) {
    throw new Error(
      "Character icon must be an image file no larger than 10 MiB.",
    );
  }

  return extension;
}

/** 有効な6桁の16進色を小文字にそろえ、形式違反は代替色に置き換える。 */
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

/** テーマの主色・副色を別々に検証し、不足や不正な色を既定の組で補う。 */
function normalizeTheme(
  value: Partial<CharacterTheme> | undefined,
  fallback = DEFAULT_CHARACTER_THEME,
): CharacterTheme {
  return {
    main: normalizeHexColor(value?.main, fallback.main),
    sub: normalizeHexColor(value?.sub, fallback.sub),
  };
}

/** Character 名を保存ディレクトリにも使える短い ASCII スラッグに寄せる。 */
function slugifyCharacterId(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, CHARACTER_ID_MAX_LENGTH);

  return normalized || "character";
}

/** カタログを SQLite に、定義・ノート・管理アイコンを Character 別のワークスペースに保存する。 */
export class CharacterStorage {
  private readonly db: DatabaseSync;
  private readonly userDataPath: string;
  private readonly characterRootPath: string;

  /** 対応データベースを検証して接続を開き、カタログスキーマとファイルの基準パスを用意する。 */
  constructor(dbPath: string, userDataPath: string) {
    assertV4SchemaInitializationAllowed(dbPath, "CharacterStorage");
    this.db = openAppDatabase(dbPath);
    this.userDataPath = userDataPath;
    this.characterRootPath = path.join(userDataPath, CHARACTER_ROOT_DIRECTORY);
    this.ensureSchema();
  }

  /** 既存のカタログ行を維持したまま、必要なテーブルと索引を作る。 */
  private ensureSchema(): void {
    this.db.exec(CREATE_CHARACTER_TABLE_SQL);
  }

  /** 識別子が単一の許可済みパス要素か検証し、Character の専用パスを求める。 */
  private characterDirectory(characterId: string): string {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(characterId)) {
      throw new Error("Character ID is invalid.");
    }
    return path.join(this.characterRootPath, characterId);
  }

  /** 指定 Character のワークスペースパスを返す。ディレクトリの作成は行わない。 */
  getCharacterDirectory(characterId: string): string {
    return this.characterDirectory(characterId);
  }

  /** Character の専用ディレクトリから、内部で扱う任意の資材ファイルのパスを組み立てる。 */
  private characterFilePath(characterId: string, fileName: string): string {
    return path.join(this.characterDirectory(characterId), fileName);
  }

  /** 管理アイコンを保存するための、拡張子を含む userData 相対パスを組み立てる。 */
  private characterIconRelativePath(
    characterId: string,
    extension: string,
  ): string {
    return normalizeDbRelativePath(
      path.join(
        CHARACTER_ROOT_DIRECTORY,
        characterId,
        `${CHARACTER_ICON_FILE_BASE}${extension}`,
      ),
    );
  }

  /** 指定した絶対パスが同じ Character のディレクトリ内なら、DB に保存する相対参照へ変換する。 */
  private maybeGetManagedIconRelativePath(
    characterId: string,
    iconFilePath: string,
  ): string | null {
    const trimmed = iconFilePath.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) {
      return null;
    }

    const characterDirectoryPath = path.resolve(
      this.characterDirectory(characterId),
    );
    const resolvedIconPath = path.resolve(trimmed);
    const relativePath = path.relative(
      characterDirectoryPath,
      resolvedIconPath,
    );
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return null;
    }

    return normalizeDbRelativePath(
      path.join(CHARACTER_ROOT_DIRECTORY, characterId, relativePath),
    );
  }

  /** このストレージの userData を使い、DB のアイコン参照を公開用パスへ変換する。 */
  private materializeIconFilePath(iconFilePath: string): string {
    return materializeCharacterIconFilePath(this.userDataPath, iconFilePath);
  }

  /** 置き換え時に削除してよい候補を、Character 内の管理用アイコン名を持つ相対参照に限る。 */
  private getManagedIconAbsolutePath(
    characterId: string,
    iconFilePath: string,
  ): string | null {
    const rawPath = iconFilePath.trim();
    const trimmed =
      process.platform === "win32" ? normalizeDbRelativePath(rawPath) : rawPath;
    if (
      !trimmed ||
      path.isAbsolute(trimmed) ||
      hasCharacterIconPathScheme(trimmed)
    ) {
      return null;
    }

    const resolvedIconPath = path.resolve(this.userDataPath, trimmed);
    const basename = path.basename(resolvedIconPath);
    const comparableBasename =
      process.platform === "win32" ? basename.toLowerCase() : basename;
    if (!/^icon\.[a-z0-9]+$/.test(comparableBasename)) {
      return null;
    }

    const characterDirectoryPath = path.resolve(
      this.characterDirectory(characterId),
    );
    const relativePath = path.relative(
      characterDirectoryPath,
      resolvedIconPath,
    );
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return null;
    }

    return resolvedIconPath;
  }

  /** 参照が実際に変わった管理アイコンだけを削除する。削除に失敗してもカタログ更新は取り消さない。 */
  private async cleanupReplacedManagedIcon(
    characterId: string,
    previousIconFilePath: string,
    nextIconFilePath: string,
  ): Promise<void> {
    if (
      areCharacterIconPathReferencesEquivalent(
        previousIconFilePath,
        nextIconFilePath,
        { fileSystemStyle: process.platform === "win32" ? "windows" : "posix" },
      )
    ) {
      return;
    }

    const previousIconAbsolutePath = this.getManagedIconAbsolutePath(
      characterId,
      previousIconFilePath,
    );
    if (!previousIconAbsolutePath) {
      return;
    }
    const nextIconAbsolutePath = this.getManagedIconAbsolutePath(
      characterId,
      nextIconFilePath,
    );
    if (
      nextIconAbsolutePath &&
      areCharacterIconPathReferencesEquivalent(
        previousIconAbsolutePath,
        nextIconAbsolutePath,
        { fileSystemStyle: process.platform === "win32" ? "windows" : "posix" },
      )
    ) {
      return;
    }

    try {
      await rm(previousIconAbsolutePath, { force: true });
    } catch (error) {
      console.warn("Character icon cleanup failed", {
        characterId,
        iconFilePath: previousIconFilePath,
        error,
      });
    }
  }

  /** 直接参照・管理領域への相対化・絶対化のいずれでも同じアイコンを指すか照合する。 */
  private isCurrentIconReference(
    currentIconFilePath: string,
    sourceIconFilePath: string,
    managedRelativePath: string | null,
  ): boolean {
    if (!currentIconFilePath) {
      return false;
    }

    const comparisonOptions = {
      fileSystemStyle: process.platform === "win32" ? "windows" : "posix",
    } as const;
    return (
      areCharacterIconPathReferencesEquivalent(
        sourceIconFilePath,
        currentIconFilePath,
        comparisonOptions,
      ) ||
      (managedRelativePath !== null &&
        areCharacterIconPathReferencesEquivalent(
          managedRelativePath,
          currentIconFilePath,
          comparisonOptions,
        )) ||
      areCharacterIconPathReferencesEquivalent(
        sourceIconFilePath,
        this.materializeIconFilePath(currentIconFilePath),
        comparisonOptions,
      )
    );
  }

  /** 同じ参照は再利用する。新しいアイコン指定は検証し、外部の絶対ファイルが必要なら管理領域へコピーする。 */
  private async copyIconFromSourcePath(
    characterId: string,
    sourceIconFilePath: string,
    currentIconFilePath = "",
  ): Promise<string> {
    if (!sourceIconFilePath) {
      return "";
    }

    const managedRelativePath = this.maybeGetManagedIconRelativePath(
      characterId,
      sourceIconFilePath,
    );
    if (
      this.isCurrentIconReference(
        currentIconFilePath,
        sourceIconFilePath,
        managedRelativePath,
      )
    ) {
      return currentIconFilePath;
    }
    const registrationPathError =
      validateCharacterIconRegistrationPath(sourceIconFilePath);
    if (registrationPathError) {
      throw new Error(registrationPathError);
    }

    const extension = await safeIconExtension(sourceIconFilePath);
    if (!path.isAbsolute(sourceIconFilePath)) {
      return sourceIconFilePath;
    }
    if (managedRelativePath) {
      return managedRelativePath;
    }

    const relativeIconPath = this.characterIconRelativePath(
      characterId,
      extension,
    );
    const destinationPath = path.join(this.userDataPath, relativeIconPath);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(sourceIconFilePath, destinationPath);
    return relativeIconPath;
  }

  /** カタログ行を公開用の項目に変換し、アイコンの参照も表示時に使える形へ解決する。 */
  private toEntry(row: CharacterRow): CharacterCatalogEntry {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      iconFilePath: this.materializeIconFilePath(row.icon_file_path),
      theme: {
        main: row.theme_main,
        sub: row.theme_sub,
      },
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
    };
  }

  /** 指定 ID に該当するカタログ行を取得し、未登録なら null とする。 */
  private readCharacterRow(characterId: string): CharacterRow | null {
    return (
      (this.db
        .prepare(
          `
      SELECT id, name, description, icon_file_path, theme_main, theme_sub, state,
        created_at, updated_at, archived_at
      FROM characters
      WHERE id = ?
    `,
        )
        .get(characterId) as CharacterRow | undefined) ?? null
    );
  }

  /** 必須の定義ファイルを UTF-8 として読む。読み取りエラーは呼び出し側に伝える。 */
  private async readDefinitionMarkdown(characterId: string): Promise<string> {
    return await readFile(
      this.characterFilePath(characterId, CHARACTER_DEFINITION_FILE),
      "utf8",
    );
  }

  /** 任意の補助ノートを UTF-8 として読む。読み取れない場合は空の本文を返す。 */
  private async readNotesMarkdown(characterId: string): Promise<string> {
    try {
      return await readFile(
        this.characterFilePath(characterId, CHARACTER_NOTES_FILE),
        "utf8",
      );
    } catch {
      return "";
    }
  }

  /** 定義と指定されたノートを先に検証し、定義を保存する。ノートが未指定なら既存ファイルを更新しない。 */
  private async writeDefinitionFiles(
    characterId: string,
    definitionMarkdown: string,
    notesMarkdown?: string,
  ): Promise<void> {
    const definitionResult =
      parseCharacterDefinitionMarkdown(definitionMarkdown);
    if (!definitionResult.ok) {
      throw new Error(
        `character.md validation failed: ${definitionResult.issues.map((issue) => issue.code).join(", ")}`,
      );
    }

    if (notesMarkdown !== undefined) {
      const notesIssues = validateCharacterNotesMarkdown(notesMarkdown);
      if (notesIssues.length > 0) {
        throw new Error(
          `character-notes.md validation failed: ${notesIssues.map((issue) => issue.code).join(", ")}`,
        );
      }
    }

    await mkdir(this.characterDirectory(characterId), { recursive: true });
    await writeFile(
      this.characterFilePath(characterId, CHARACTER_DEFINITION_FILE),
      definitionMarkdown,
      "utf8",
    );
    if (notesMarkdown !== undefined) {
      await writeFile(
        this.characterFilePath(characterId, CHARACTER_NOTES_FILE),
        notesMarkdown,
        "utf8",
      );
    }
  }

  /** 名前をもとに未使用の ID を探し、通常の番号候補を使い切った場合は乱数を含む候補を返す。 */
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

  /** 有効な Character を新しい更新順に返す。アーカイブを含める場合は状態別にまとめる。 */
  listCharacters(
    options: { includeArchived?: boolean } = {},
  ): CharacterCatalogEntry[] {
    const rows = options.includeArchived
      ? (this.db
          .prepare(
            `
        SELECT id, name, description, icon_file_path, theme_main, theme_sub, state,
          created_at, updated_at, archived_at
        FROM characters
        ORDER BY state ASC, updated_at DESC, name ASC
      `,
          )
          .all() as CharacterRow[])
      : (this.db
          .prepare(
            `
        SELECT id, name, description, icon_file_path, theme_main, theme_sub, state,
          created_at, updated_at, archived_at
        FROM characters
        WHERE state = 'active'
        ORDER BY updated_at DESC, name ASC
      `,
          )
          .all() as CharacterRow[]);

    return rows.map((row) => this.toEntry(row));
  }

  /** 指定 ID の表示用カタログ項目だけを返す。定義ファイルは読まない。 */
  getCharacterCatalogEntry(characterId: string): CharacterCatalogEntry | null {
    const row = this.readCharacterRow(characterId);
    return row ? this.toEntry(row) : null;
  }

  /** カタログ項目に定義とノートを添えて返す。該当行がなければ null。 */
  async getCharacter(characterId: string): Promise<CharacterDetail | null> {
    const row = this.readCharacterRow(characterId);
    if (!row) {
      return null;
    }

    return {
      ...this.toEntry(row),
      definitionMarkdown: await this.readDefinitionMarkdown(characterId),
      notesMarkdown: await this.readNotesMarkdown(characterId),
    };
  }

  /** 初期ファイルを用意してからカタログ行を確定し、失敗時は今回新たに作ったディレクトリを片付ける。 */
  async createCharacter(input: CreateCharacterInput): Promise<CharacterDetail> {
    const name = normalizeName(input.name);
    const description = normalizeDescription(input.description);
    const theme = normalizeTheme(input.theme);
    const characterId = this.createUniqueCharacterId(name);
    const sourceIconFilePath = normalizeCharacterIconPathInput(
      input.iconFilePath,
    );
    const createdAt = nowIso();
    const definitionMarkdown =
      input.definitionMarkdown ??
      buildDefaultCharacterDefinition(name, description);
    const notesMarkdown = input.notesMarkdown ?? buildDefaultCharacterNotes();
    let transactionStarted = false;
    let characterDirectoryCreated = false;
    try {
      try {
        await stat(this.characterDirectory(characterId));
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== "ENOENT") {
          throw error;
        }
        await mkdir(this.characterDirectory(characterId), { recursive: true });
        characterDirectoryCreated = true;
      }
      const iconFilePath = await this.copyIconFromSourcePath(
        characterId,
        sourceIconFilePath,
      );
      await this.writeDefinitionFiles(
        characterId,
        definitionMarkdown,
        notesMarkdown,
      );
      this.db.exec("BEGIN IMMEDIATE TRANSACTION");
      transactionStarted = true;
      this.db
        .prepare(
          `
        INSERT INTO characters (
          id, name, description, icon_file_path, theme_main, theme_sub,
          state, created_at, updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
      `,
        )
        .run(
          characterId,
          name,
          description,
          iconFilePath,
          theme.main,
          theme.sub,
          createdAt,
          createdAt,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      if (transactionStarted) {
        this.db.exec("ROLLBACK");
      }
      if (characterDirectoryCreated) {
        await rm(this.characterDirectory(characterId), {
          recursive: true,
          force: true,
        });
      }
      throw error;
    }

    const created = await this.getCharacter(characterId);
    if (!created) {
      throw new Error("The created Character could not be loaded.");
    }
    return created;
  }

  /** 未指定の項目を保持し、メタデータを更新してから不要になった管理アイコンを片付ける。 */
  async updateCharacterMetadata(
    input: UpdateCharacterMetadataInput,
  ): Promise<CharacterDetail> {
    const current = await this.getCharacter(input.characterId);
    if (!current) {
      throw new Error("The Character could not be found.");
    }
    const currentRow = this.readCharacterRow(input.characterId);
    if (!currentRow) {
      throw new Error("The Character could not be found.");
    }

    const name =
      input.name === undefined ? current.name : normalizeName(input.name);
    const description =
      input.description === undefined
        ? current.description
        : normalizeDescription(input.description);
    const iconFilePath =
      input.iconFilePath === undefined
        ? currentRow.icon_file_path
        : await this.copyIconFromSourcePath(
            input.characterId,
            normalizeCharacterIconPathInput(input.iconFilePath),
            currentRow.icon_file_path,
          );
    const theme = normalizeTheme(input.theme, current.theme);
    const updatedAt = nowIso();

    this.db
      .prepare(
        `
      UPDATE characters
      SET name = ?, description = ?, icon_file_path = ?, theme_main = ?, theme_sub = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run(
        name,
        description,
        iconFilePath,
        theme.main,
        theme.sub,
        updatedAt,
        input.characterId,
      );
    await this.cleanupReplacedManagedIcon(
      input.characterId,
      currentRow.icon_file_path,
      iconFilePath,
    );

    const updated = await this.getCharacter(input.characterId);
    if (!updated) {
      throw new Error("The updated Character could not be loaded.");
    }
    return updated;
  }

  /** 定義ファイルを検証して更新し、カタログの更新日時も進めた状態を返す。 */
  async updateCharacterDefinition(
    input: UpdateCharacterDefinitionInput,
  ): Promise<CharacterDetail> {
    const current = await this.getCharacter(input.characterId);
    if (!current) {
      throw new Error("The Character could not be found.");
    }

    await this.writeDefinitionFiles(
      input.characterId,
      input.definitionMarkdown,
      input.notesMarkdown,
    );
    this.db
      .prepare("UPDATE characters SET updated_at = ? WHERE id = ?")
      .run(nowIso(), input.characterId);

    const updated = await this.getCharacter(input.characterId);
    if (!updated) {
      throw new Error("The updated Character could not be loaded.");
    }
    return updated;
  }

  /** 定義ファイルを削除せず、カタログから新規起動に選べない状態へ移す。 */
  async archiveCharacter(characterId: string): Promise<CharacterCatalogEntry> {
    const current = await this.getCharacter(characterId);
    if (!current) {
      throw new Error("The Character could not be found.");
    }

    const archivedAt = nowIso();
    this.db
      .prepare(
        `
      UPDATE characters
      SET state = 'archived', archived_at = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run(archivedAt, archivedAt, characterId);

    const archived = this.readCharacterRow(characterId);
    if (!archived) {
      throw new Error("The archived Character could not be loaded.");
    }
    return this.toEntry(archived);
  }

  /** 明示された Character が有効な場合だけ起動対象として返し、別の Character で代用しない。 */
  async resolveLaunchCharacter(
    input: ResolveLaunchCharacterInput = {},
  ): Promise<CharacterDetail | null> {
    if (!input.characterId) {
      return null;
    }

    const preferred = await this.getCharacter(input.characterId);
    return preferred?.state === "active" ? preferred : null;
  }

  /** 利用できる有効な定義を取り込み、本文の識別値とサイズを記録する。無効な定義では null。 */
  async createRuntimeSnapshot(
    characterId: string,
  ): Promise<CharacterRuntimeSnapshot | null> {
    if (isUnknownCharacterOwnerId(characterId)) {
      return null;
    }
    let detail: CharacterDetail | null;
    try {
      detail = await this.getCharacter(characterId);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    if (!detail || detail.state !== "active") {
      return null;
    }
    if (!parseCharacterDefinitionMarkdown(detail.definitionMarkdown).ok) {
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

  /** 所有者を照合し、アーカイブ時や本文変更がない場合は既存のスナップショットを使う。 */
  async refreshRuntimeSnapshot(
    characterId: string,
    previousSnapshot: CharacterRuntimeSnapshot | null,
  ): Promise<CharacterRuntimeSnapshot> {
    if (isUnknownCharacterOwnerId(characterId)) {
      throw new Error("The Character owner is unresolved.");
    }
    if (previousSnapshot && previousSnapshot.characterId !== characterId) {
      throw new Error("The Character snapshot owner does not match.");
    }
    const row = this.readCharacterRow(characterId);
    if (!row) {
      throw new Error("The Character could not be found.");
    }
    if (row.state === "archived") {
      if (!previousSnapshot) {
        throw new Error(
          "The archived Character has no saved runtime snapshot.",
        );
      }
      return previousSnapshot;
    }

    const definitionMarkdown = await this.readDefinitionMarkdown(characterId);
    if (previousSnapshot?.definitionMarkdown === definitionMarkdown) {
      return previousSnapshot;
    }
    const definitionResult =
      parseCharacterDefinitionMarkdown(definitionMarkdown);
    if (!definitionResult.ok) {
      throw new Error(
        `character.md validation failed: ${definitionResult.issues.map((issue) => issue.code).join(", ")}`,
      );
    }
    const entry = this.toEntry(row);
    return {
      ...(previousSnapshot ?? {
        characterId: entry.id,
        name: entry.name,
        description: entry.description,
        iconFilePath: entry.iconFilePath,
        theme: entry.theme,
      }),
      definitionMarkdown,
      definitionSha256: sha256Hex(definitionMarkdown),
      definitionByteSize: byteSize(definitionMarkdown),
      snapshotAt: nowIso(),
    };
  }

  /** Character の全ファイルを削除し、空の基準ディレクトリを作り直す。 */
  async deleteCharacterRootDirectory(): Promise<void> {
    await rm(this.characterRootPath, { recursive: true, force: true });
    await mkdir(this.characterRootPath, { recursive: true });
  }

  /** カタログの SQLite 接続を閉じる。ワークスペースは保持する。 */
  close(): void {
    this.db.close();
  }
}

/** ファイル名から、このスキーマの初期化対象となる V4 データベースか判定する。 */
export function isCharacterStorageSupportedDatabase(dbPath: string): boolean {
  return path.basename(dbPath) === APP_DATABASE_V4_FILENAME;
}
