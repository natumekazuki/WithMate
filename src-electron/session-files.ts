import { constants, type Dirent } from "node:fs";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type SaveSessionFileInput = {
  sessionId: string;
  fileName: string;
  data: Uint8Array;
};

const SESSION_FILES_ROOT = "session-files";
const MATE_TALK_SESSION_FILES_PREFIX = "mate-talk-";

function safePathSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error("Session files の ID が不正だよ。");
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

async function writeUniqueFile(directoryPath: string, requestedFileName: string, data: Uint8Array): Promise<string> {
  for (let index = 1; index < 10000; index += 1) {
    const candidate = buildDestinationCandidate(directoryPath, requestedFileName, index);
    try {
      await writeFile(candidate, data, { flag: "wx" });
      return candidate;
    } catch (error) {
      const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
      if (code !== "EEXIST") {
        throw error;
      }
    }
  }

  throw new Error("保存先ファイル名を決められなかったよ。");
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

  throw new Error("保存先ファイル名を決められなかったよ。");
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

export async function saveSessionFile(userDataPath: string, input: SaveSessionFileInput): Promise<string> {
  const directoryPath = resolveSessionFilesDirectory(userDataPath, input.sessionId);
  await mkdir(directoryPath, { recursive: true });
  return writeUniqueFile(directoryPath, input.fileName, input.data);
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
