import { constants, mkdirSync, type Dirent } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SavePastedSessionFileResult } from "../../src-shared/window/withmate-window-types.js";

export type SaveSessionFileInput = {
  sessionId: string;
  fileName: string;
  data: Uint8Array;
  replaceExistingHash?: string;
  saveAsCopy?: boolean;
};

const SESSION_FILES_ROOT = "session-files";
const MATE_TALK_SESSION_FILES_PREFIX = "mate-talk-";

function safePathSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error("The Session files ID is invalid.");
  }
  return normalized;
}

function safeFileName(value: string): string {
  const basename = path.basename(value.trim()).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-").trim();
  if (!basename || basename === "." || basename === "..") {
    return "pasted-file";
  }
  return basename;
}

export function resolveSessionFilesDirectory(userDataPath: string, sessionId: string): string {
  return path.join(userDataPath, SESSION_FILES_ROOT, safePathSegment(sessionId));
}

export async function createSessionFilesDirectory(userDataPath: string, sessionId: string): Promise<string> {
  const directoryPath = resolveSessionFilesDirectory(userDataPath, sessionId);
  await mkdir(path.dirname(directoryPath), { recursive: true });
  try {
    await mkdir(directoryPath);
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
    if (code === "EEXIST") {
      throw new Error("A SessionFolder with the same ID already exists.");
    }
    throw error;
  }
  return directoryPath;
}

export function ensureSessionFilesDirectory(userDataPath: string, sessionId: string): string {
  const directoryPath = resolveSessionFilesDirectory(userDataPath, sessionId);
  mkdirSync(directoryPath, { recursive: true });
  return directoryPath;
}

export function appendSessionFilesDirectory<TSession extends { id: string; allowedAdditionalDirectories: string[] }>(
  userDataPath: string,
  session: TSession,
): TSession {
  return appendSessionFilesDirectoryForSessionId(userDataPath, session, session.id);
}

export function appendSessionFilesDirectoryForSessionId<TSession extends { allowedAdditionalDirectories: string[] }>(
  userDataPath: string,
  session: TSession,
  sessionId: string,
): TSession {
  const sessionFilesDirectory = resolveSessionFilesDirectory(userDataPath, sessionId);
  if (session.allowedAdditionalDirectories.some((entry) => path.resolve(entry) === path.resolve(sessionFilesDirectory))) {
    return session;
  }

  return {
    ...session,
    allowedAdditionalDirectories: [
      ...session.allowedAdditionalDirectories,
      sessionFilesDirectory,
    ],
  };
}

function buildDestinationCandidate(directoryPath: string, requestedFileName: string, index: number): string {
  const parsed = path.parse(safeFileName(requestedFileName));
  const baseName = parsed.name || "file";
  const extension = parsed.ext;
  const fileName = index === 1 ? `${baseName}${extension}` : `${baseName}-${index}${extension}`;
  return path.join(directoryPath, fileName);
}

async function copyUniqueFile(directoryPath: string, sourcePath: string): Promise<string> {
  for (let index = 1; index < 10000; index += 1) {
    const candidate = buildDestinationCandidate(directoryPath, path.basename(sourcePath), index);
    try {
      await copyFile(sourcePath, candidate, constants.COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
      if (code !== "EEXIST") {
        throw error;
      }
    }
  }

  throw new Error("Could not choose a destination file name.");
}

export async function copyFilesToSessionFiles(
  userDataPath: string,
  sessionId: string,
  sourcePaths: readonly string[],
): Promise<string[]> {
  const directoryPath = resolveSessionFilesDirectory(userDataPath, sessionId);
  await mkdir(directoryPath, { recursive: true });

  const savedPaths: string[] = [];
  for (const sourcePath of sourcePaths) {
    const trimmedPath = sourcePath.trim();
    if (!trimmedPath) {
      continue;
    }
    savedPaths.push(await copyUniqueFile(directoryPath, trimmedPath));
  }

  return savedPaths;
}

export async function saveSessionFile(userDataPath: string, input: SaveSessionFileInput): Promise<SavePastedSessionFileResult> {
  const directoryPath = resolveSessionFilesDirectory(userDataPath, input.sessionId);
  await mkdir(directoryPath, { recursive: true });
  const fileName = safeFileName(input.fileName);
  const destination = path.join(directoryPath, fileName);
  if (input.saveAsCopy) {
    for (let index = 2; index < 10000; index += 1) {
      const candidate = buildDestinationCandidate(directoryPath, fileName, index);
      try {
        await writeFile(candidate, input.data, { flag: "wx" });
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new Error("Could not choose a destination file name.");
  }
  try {
    await writeFile(destination, input.data, { flag: "wx" });
    return destination;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  if (!(await lstat(destination)).isFile()) {
    throw new Error(`Cannot paste "${fileName}": the existing entry is not a regular file.`);
  }
  const existing = await open(destination, "r");
  let existingHash: string;
  try {
    const hash = createHash("sha256");
    for await (const chunk of existing.createReadStream({ autoClose: false })) hash.update(chunk);
    existingHash = hash.digest("hex");
  } finally {
    await existing.close();
  }
  if (existingHash === createHash("sha256").update(input.data).digest("hex")) return { status: "reused", path: destination };
  if (input.replaceExistingHash !== existingHash) return { status: "conflict", fileName, existingHash };

  const temporaryPath = path.join(directoryPath, `.paste-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, input.data, { flag: "wx" });
    await rename(temporaryPath, destination);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return destination;
}

export async function deleteSessionFilesDirectory(userDataPath: string, sessionId: string): Promise<void> {
  await rm(resolveSessionFilesDirectory(userDataPath, sessionId), { recursive: true, force: true });
}

export async function cleanupMateTalkSessionFilesDirectories(userDataPath: string): Promise<number> {
  const rootPath = path.join(userDataPath, SESSION_FILES_ROOT);
  let entries: Dirent[];
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
    if (code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  let deletedCount = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(MATE_TALK_SESSION_FILES_PREFIX)) {
      continue;
    }

    await rm(path.join(rootPath, entry.name), { recursive: true, force: true });
    deletedCount += 1;
  }

  return deletedCount;
}
