import path from "node:path";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";

import { app } from "electron";

import {
  DEFAULT_CHARACTER_SESSION_COPY,
  DEFAULT_CHARACTER_THEME_COLORS,
  normalizeCharacterSessionCopy,
  normalizeCharacterThemeColors,
  type CharacterProfile,
  type CreateCharacterInput,
} from "../src/character-state.js";
import {
  buildCharacterMarkdownTemplate,
  buildCharacterNotesTemplate,
  buildCharacterUpdateWorkspaceFiles,
} from "./character-update-instructions.js";

type StoredCharacterMeta = {
  id: string;
  name: string;
  description: string;
  theme: {
    main: string;
    sub: string;
  };
  sessionCopy: typeof DEFAULT_CHARACTER_SESSION_COPY;
  iconFile: string | null;
  roleFile: string;
  createdAt: string;
  updatedAt: string;
};

const CHARACTER_ROOT_DIRECTORY = "characters";
const DEFAULT_ROLE_FILE = "character.md";
const DEFAULT_NOTES_FILE = "character-notes.md";
const LEGACY_SAMPLE_CHARACTER_IDS = ["kuramochi-melto", "ishigami-nozomi", "ozora-subaru", "inui-toko"];

function nowIso(): string {
  return new Date().toISOString();
}

function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }

  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function slugifyCharacterName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, "-")
      .replace(/^-+|-+$/g, "") || `character-${Date.now()}`
  );
}

function normalizeMeta(value: unknown): StoredCharacterMeta | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<StoredCharacterMeta>;
  if (typeof candidate.id !== "string" || !candidate.id.trim()) {
    return null;
  }

  if (typeof candidate.name !== "string" || !candidate.name.trim()) {
    return null;
  }

  return {
    id: candidate.id.trim(),
    name: candidate.name.trim(),
    description: typeof candidate.description === "string" ? candidate.description : "",
    theme: normalizeCharacterThemeColors(candidate.theme ?? DEFAULT_CHARACTER_THEME_COLORS),
    sessionCopy: normalizeCharacterSessionCopy(candidate.sessionCopy),
    iconFile: typeof candidate.iconFile === "string" && candidate.iconFile.trim() ? candidate.iconFile : null,
    roleFile: typeof candidate.roleFile === "string" && candidate.roleFile.trim() ? candidate.roleFile : DEFAULT_ROLE_FILE,
    createdAt: typeof candidate.createdAt === "string" && candidate.createdAt.trim() ? candidate.createdAt : nowIso(),
    updatedAt: typeof candidate.updatedAt === "string" && candidate.updatedAt.trim() ? candidate.updatedAt : nowIso(),
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function getCharacterRootPath(): string {
  return path.join(app.getPath("userData"), CHARACTER_ROOT_DIRECTORY);
}

function getCharacterDirectoryPath(characterId: string): string {
  return path.join(getCharacterRootPath(), characterId);
}

async function ensureCharacterRootPath(): Promise<string> {
  const rootPath = getCharacterRootPath();
  await mkdir(rootPath, { recursive: true });
  return rootPath;
}

async function readMetaFile(characterDirectoryPath: string): Promise<StoredCharacterMeta | null> {
  const metaPath = path.join(characterDirectoryPath, "meta.json");
  try {
    const raw = await readFile(metaPath, "utf8");
    return normalizeMeta(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

async function readOptionalText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function materializeCharacterProfile(characterDirectoryPath: string, meta: StoredCharacterMeta): Promise<CharacterProfile> {
  const roleMarkdown = await readOptionalText(path.join(characterDirectoryPath, meta.roleFile));
  const notesMarkdown = await readOptionalText(path.join(characterDirectoryPath, DEFAULT_NOTES_FILE));
  const iconPath =
    meta.iconFile && (await pathExists(path.join(characterDirectoryPath, meta.iconFile)))
      ? path.join(characterDirectoryPath, meta.iconFile)
      : "";

  return {
    id: meta.id,
    name: meta.name,
    iconPath,
    description: meta.description,
    roleMarkdown,
    notesMarkdown,
    updatedAt: formatTimestamp(meta.updatedAt),
    themeColors: normalizeCharacterThemeColors(meta.theme),
    sessionCopy: normalizeCharacterSessionCopy(meta.sessionCopy),
  };
}

async function listCharacterDirectories(): Promise<string[]> {
  const rootPath = await ensureCharacterRootPath();
  const entries = await readdir(rootPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(rootPath, entry.name));
}

async function purgeLegacySampleCharacters(): Promise<void> {
  await Promise.all(
    LEGACY_SAMPLE_CHARACTER_IDS.map((characterId) =>
      rm(getCharacterDirectoryPath(characterId), { recursive: true, force: true }),
    ),
  );
}

function inferIconFileName(sourcePath: string): string | null {
  const trimmed = sourcePath.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("data:image/")) {
    const match = trimmed.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,/);
    if (!match) {
      return "character.png";
    }

    const mimeSubtype = match[1].toLowerCase();
    const extension =
      mimeSubtype === "jpeg"
        ? ".jpg"
        : mimeSubtype === "svg+xml"
          ? ".svg"
          : `.${mimeSubtype.replace(/[^a-z0-9]+/g, "")}`;
    return `character${extension}`;
  }

  const extension = path.extname(trimmed).toLowerCase() || ".png";
  return `character${extension}`;
}

async function syncCharacterIcon(
  characterDirectoryPath: string,
  sourceIconPath: string,
  previousIconFile: string | null,
): Promise<string | null> {
  const nextIconFile = inferIconFileName(sourceIconPath);

  if (!nextIconFile) {
    if (previousIconFile) {
      await rm(path.join(characterDirectoryPath, previousIconFile), { force: true });
    }
    return null;
  }

  const targetPath = path.join(characterDirectoryPath, nextIconFile);
  const resolvedSourcePath = path.resolve(sourceIconPath);

  if (sourceIconPath.startsWith("data:image/")) {
    const base64 = sourceIconPath.split(",", 2)[1] ?? "";
    if (base64) {
      await writeFile(targetPath, Buffer.from(base64, "base64"));
    }
  } else if (await pathExists(resolvedSourcePath)) {
    if (path.normalize(resolvedSourcePath) !== path.normalize(targetPath)) {
      await copyFile(resolvedSourcePath, targetPath);
    }
  }

  if (previousIconFile && previousIconFile !== nextIconFile) {
    await rm(path.join(characterDirectoryPath, previousIconFile), { force: true });
  }

  return (await pathExists(targetPath)) ? nextIconFile : null;
}

async function writeCharacterFiles(
  characterId: string,
  input: CreateCharacterInput,
  existingMeta: StoredCharacterMeta | null,
): Promise<CharacterProfile> {
  const characterDirectoryPath = getCharacterDirectoryPath(characterId);
  await mkdir(characterDirectoryPath, { recursive: true });

  const createdAt = existingMeta?.createdAt ?? nowIso();
  const updatedAt = nowIso();
  const roleFile = existingMeta?.roleFile ?? DEFAULT_ROLE_FILE;
  const notesPath = path.join(characterDirectoryPath, DEFAULT_NOTES_FILE);
  const iconFile = await syncCharacterIcon(characterDirectoryPath, input.iconPath, existingMeta?.iconFile ?? null);

  const nextMeta: StoredCharacterMeta = {
    id: characterId,
    name: input.name.trim() || "新規キャラクター",
    description: input.description.trim(),
    theme: normalizeCharacterThemeColors(input.themeColors),
    sessionCopy: normalizeCharacterSessionCopy(input.sessionCopy),
    iconFile,
    roleFile,
    createdAt,
    updatedAt,
  };

  const workspaceFiles = buildCharacterUpdateWorkspaceFiles(nextMeta.name);
  const rolePath = path.join(characterDirectoryPath, roleFile);
  const shouldSeedRole = !(await pathExists(rolePath));
  const shouldSeedNotes = !(await pathExists(notesPath));

  await Promise.all([
    writeFile(path.join(characterDirectoryPath, "meta.json"), JSON.stringify(nextMeta, null, 2), "utf8"),
    writeFile(
      rolePath,
      input.roleMarkdown.trim() || (shouldSeedRole ? buildCharacterMarkdownTemplate(nextMeta.name) : ""),
      "utf8",
    ),
    writeFile(
      notesPath,
      input.notesMarkdown.trim() || (shouldSeedNotes ? buildCharacterNotesTemplate(nextMeta.name) : ""),
      "utf8",
    ),
    ...workspaceFiles.map(async (file) => {
      const filePath = path.join(characterDirectoryPath, file.fileName);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, file.content, "utf8");
    }),
  ]);

  return materializeCharacterProfile(characterDirectoryPath, nextMeta);
}

async function generateAvailableCharacterId(name: string): Promise<string> {
  const baseId = slugifyCharacterName(name);
  let nextId = baseId;
  let suffix = 2;

  while (await pathExists(getCharacterDirectoryPath(nextId))) {
    nextId = `${baseId}-${suffix}`;
    suffix += 1;
  }

  return nextId;
}

export async function listStoredCharacters(): Promise<CharacterProfile[]> {
  await ensureCharacterRootPath();
  await purgeLegacySampleCharacters();

  const directories = await listCharacterDirectories();
  const characters = await Promise.all(
    directories.map(async (characterDirectoryPath) => {
      const meta = await readMetaFile(characterDirectoryPath);
      if (!meta) {
        return null;
      }

      return {
        profile: await materializeCharacterProfile(characterDirectoryPath, meta),
        updatedAt: meta.updatedAt,
      };
    }),
  );

  return characters
    .filter(
      (character): character is { profile: CharacterProfile; updatedAt: string } => character !== null,
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt, "ja-JP"))
    .map((character) => character.profile);
}

export async function getStoredCharacter(characterId: string): Promise<CharacterProfile | null> {
  await ensureCharacterRootPath();
  await purgeLegacySampleCharacters();
  const characterDirectoryPath = getCharacterDirectoryPath(characterId);
  const meta = await readMetaFile(characterDirectoryPath);
  if (!meta) {
    return null;
  }

  return materializeCharacterProfile(characterDirectoryPath, meta);
}

export async function createStoredCharacter(input: CreateCharacterInput): Promise<CharacterProfile> {
  await ensureCharacterRootPath();
  await purgeLegacySampleCharacters();
  const characterId = await generateAvailableCharacterId(input.name);
  return writeCharacterFiles(characterId, input, null);
}

export async function updateStoredCharacter(character: CharacterProfile): Promise<CharacterProfile> {
  await ensureCharacterRootPath();
  await purgeLegacySampleCharacters();
  const characterDirectoryPath = getCharacterDirectoryPath(character.id);
  const existingMeta = await readMetaFile(characterDirectoryPath);
  return writeCharacterFiles(
    character.id,
    {
      name: character.name,
      iconPath: character.iconPath,
      description: character.description,
      roleMarkdown: character.roleMarkdown,
      notesMarkdown: character.notesMarkdown,
      themeColors: character.themeColors,
      sessionCopy: character.sessionCopy,
    },
    existingMeta,
  );
}

export async function deleteStoredCharacter(characterId: string): Promise<void> {
  await purgeLegacySampleCharacters();
  await rm(getCharacterDirectoryPath(characterId), { recursive: true, force: true });
}

export function getCharacterStorageRootPath(): string {
  return getCharacterRootPath();
}

export function getStoredCharacterDirectoryPath(characterId: string): string {
  return getCharacterDirectoryPath(characterId);
}

