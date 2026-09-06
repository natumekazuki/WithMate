import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SessionFolderResourceBudget } from "./resource-budget-files.js";

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

export async function createSessionFilesDirectory(userDataPath: string, sessionId: string): Promise<string> {
  const directoryPath = resolveSessionFilesDirectory(userDataPath, sessionId);
  await mkdir(path.dirname(directoryPath), { recursive: true });
  try {
    await mkdir(directoryPath);
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
    if (code === "EEXIST") {
      throw new Error("同じ ID の SessionFolder がすでに存在するよ。");
    }
    throw error;
  }
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

async function copyUniqueFileBounded(
  directoryPath: string,
  sourcePath: string,
  maxBytes: number,
  onTargetCreated: () => void,
): Promise<{ path: string; bytes: number }> {
  for (let index = 1; index < 10000; index += 1) {
    const candidate = buildDestinationCandidate(directoryPath, path.basename(sourcePath), index);
    let destination;
    try {
      destination = await open(candidate, "wx");
      onTargetCreated();
    } catch (error) {
      const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
      if (code === "EEXIST") continue;
      throw error;
    }

    const source = await open(sourcePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let bytes = 0;
      while (bytes < maxBytes) {
        const requested = Math.min(buffer.byteLength, maxBytes - bytes);
        const read = await source.read(buffer, 0, requested, bytes);
        if (read.bytesRead === 0) break;
        let written = 0;
        while (written < read.bytesRead) {
          const result = await destination.write(buffer, written, read.bytesRead - written, bytes + written);
          if (result.bytesWritten === 0) throw new Error("The SessionFolder copy made no write progress.");
          written += result.bytesWritten;
        }
        bytes += read.bytesRead;
      }
      const overflow = Buffer.allocUnsafe(1);
      if ((await source.read(overflow, 0, 1, bytes)).bytesRead > 0) {
        throw new Error("A source file grew beyond its reserved SessionFolder storage.");
      }
      await destination.sync();
      return { path: candidate, bytes };
    } finally {
      await Promise.allSettled([source.close(), destination.close()]);
    }
  }

  throw new Error("保存先ファイル名を決められなかったよ。");
}

export async function copyFilesToSessionFiles(
  userDataPath: string,
  sessionId: string,
  sourcePaths: readonly string[],
  resourceBudget: SessionFolderResourceBudget,
): Promise<string[]> {
  const sources: Array<{ path: string; reservedBytes: number }> = [];
  let reservedBytes = 0;
  for (const sourcePath of sourcePaths) {
    const trimmedPath = sourcePath.trim();
    if (!trimmedPath) continue;
    const sourceStats = await stat(trimmedPath);
    if (!sourceStats.isFile()) throw new Error("SessionFolder へコピーできるのはファイルだけです。");
    reservedBytes = addSafeBytes(reservedBytes, sourceStats.size);
    sources.push({ path: trimmedPath, reservedBytes: sourceStats.size });
  }
  const reservation = await resourceBudget.reserve(
    sessionId,
    reservedBytes,
    `session-files.copy:${randomOperationId()}`,
  );
  const directoryPath = resolveSessionFilesDirectory(userDataPath, sessionId);
  let effectApplied = false;
  let budgetLeaseFinished = false;
  try {
    await mkdir(directoryPath, { recursive: true });

    const savedPaths: string[] = [];
    let actualBytes = 0;
    for (const source of sources) {
      const saved = await copyUniqueFileBounded(directoryPath, source.path, source.reservedBytes, () => {
        effectApplied = true;
      });
      savedPaths.push(saved.path);
      actualBytes = addSafeBytes(actualBytes, saved.bytes);
    }
    budgetLeaseFinished = true;
    await resourceBudget.settleApplied(sessionId, reservation, actualBytes);
    return savedPaths;
  } catch (error) {
    if (!budgetLeaseFinished && effectApplied) {
      await resourceBudget.reconcileRequired(sessionId, reservation).catch(() => undefined);
    } else if (!budgetLeaseFinished) {
      resourceBudget.release(reservation);
    }
    throw error;
  }
}

export async function saveSessionFile(
  userDataPath: string,
  input: SaveSessionFileInput,
  resourceBudget: SessionFolderResourceBudget,
): Promise<string> {
  const reservation = await resourceBudget.reserve(
    input.sessionId,
    input.data.byteLength,
    `session-files.paste:${randomOperationId()}`,
  );
  const directoryPath = resolveSessionFilesDirectory(userDataPath, input.sessionId);
  let effectApplied = false;
  let budgetLeaseFinished = false;
  try {
    await mkdir(directoryPath, { recursive: true });
    const savedPath = await writeUniqueFile(directoryPath, input.fileName, input.data);
    effectApplied = true;
    budgetLeaseFinished = true;
    await resourceBudget.settleApplied(input.sessionId, reservation, input.data.byteLength);
    return savedPath;
  } catch (error) {
    if (!budgetLeaseFinished && effectApplied) {
      await resourceBudget.reconcileRequired(input.sessionId, reservation).catch(() => undefined);
    } else if (!budgetLeaseFinished) {
      resourceBudget.release(reservation);
    }
    throw error;
  }
}

function randomOperationId(): string {
  return `${Date.now()}:${randomUUID()}`;
}

function addSafeBytes(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new Error("SessionFolder storage size exceeds the supported range.");
  return total;
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
