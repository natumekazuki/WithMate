import { constants, mkdirSync, type Dirent } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { SavePastedSessionFileResult } from "../../src-shared/window/withmate-window-types.js";

/** SessionFolder に保存する貼り付けデータと、名前の衝突時に使う上書き確認または別名保存の指定。 */
export type SaveSessionFileInput = {
  sessionId: string;
  fileName: string;
  data: Uint8Array;
  replaceExistingHash?: string;
  saveAsCopy?: boolean;
};

const SESSION_FILES_ROOT = "session-files";
const MATE_TALK_SESSION_FILES_PREFIX = "mate-talk-";

/** Session の識別子を単一のパス要素に整え、空または相対移動を表す要素を拒否する。 */
function safePathSegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error("The Session files ID is invalid.");
  }
  return normalized;
}

/** パスではなく末尾のファイル名を使い、空や使用不能な名前は既定名に置き換える。 */
function safeFileName(value: string): string {
  const basename = path
    .basename(value.trim())
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .trim();
  if (!basename || basename === "." || basename === "..") {
    return "pasted-file";
  }
  return basename;
}

/** userData から指定 Session の専用ディレクトリのパスを求める。作成は行わない。 */
export function resolveSessionFilesDirectory(
  userDataPath: string,
  sessionId: string,
): string {
  return path.join(
    userDataPath,
    SESSION_FILES_ROOT,
    safePathSegment(sessionId),
  );
}

/** userData から Crew ルートに対応する共有ファイルディレクトリのパスを求める。 */
export function resolveCrewFilesDirectory(
  userDataPath: string,
  rootSessionId: string,
): string {
  return path.join(userDataPath, "crew-files", safePathSegment(rootSessionId));
}

/** Crew のファイル置き場を必要な親ごと作成し、既にある場合はそのまま使う。 */
export function ensureCrewFilesDirectory(
  userDataPath: string,
  rootSessionId: string,
): string {
  const directoryPath = resolveCrewFilesDirectory(userDataPath, rootSessionId);
  mkdirSync(directoryPath, { recursive: true });
  return directoryPath;
}

/** Crew の共有フォルダーを用意し、まだ含まれていなければ Session の追加ディレクトリに加える。 */
export function appendCrewFilesDirectory<
  TSession extends { allowedAdditionalDirectories: string[] },
>(userDataPath: string, session: TSession, rootSessionId: string): TSession {
  const directoryPath = ensureCrewFilesDirectory(userDataPath, rootSessionId);
  if (
    session.allowedAdditionalDirectories.some(
      (entry) => path.resolve(entry) === path.resolve(directoryPath),
    )
  )
    return session;
  return {
    ...session,
    allowedAdditionalDirectories: [
      ...session.allowedAdditionalDirectories,
      directoryPath,
    ],
  };
}

/** 新しい専用ディレクトリを作る。既存の同じ ID のディレクトリを引き継がない。 */
export async function createSessionFilesDirectory(
  userDataPath: string,
  sessionId: string,
): Promise<string> {
  const directoryPath = resolveSessionFilesDirectory(userDataPath, sessionId);
  await mkdir(path.dirname(directoryPath), { recursive: true });
  try {
    await mkdir(directoryPath);
  } catch (error) {
    const code =
      error && typeof error === "object"
        ? (error as { code?: unknown }).code
        : null;
    if (code === "EEXIST") {
      throw new Error("A SessionFolder with the same ID already exists.");
    }
    throw error;
  }
  return directoryPath;
}

/** Session の専用ディレクトリを同期で用意し、既存のものはそのまま使う。 */
export function ensureSessionFilesDirectory(
  userDataPath: string,
  sessionId: string,
): string {
  const directoryPath = resolveSessionFilesDirectory(userDataPath, sessionId);
  mkdirSync(directoryPath, { recursive: true });
  return directoryPath;
}

/** Session 自身の ID に対応する専用ディレクトリを、その Session の追加ディレクトリへ加える。 */
export function appendSessionFilesDirectory<
  TSession extends { id: string; allowedAdditionalDirectories: string[] },
>(userDataPath: string, session: TSession): TSession {
  return appendSessionFilesDirectoryForSessionId(
    userDataPath,
    session,
    session.id,
  );
}

/** 指定 ID の専用パスを追加対象とし、作成や同一パスの二重登録は行わない。 */
export function appendSessionFilesDirectoryForSessionId<
  TSession extends { allowedAdditionalDirectories: string[] },
>(userDataPath: string, session: TSession, sessionId: string): TSession {
  const sessionFilesDirectory = resolveSessionFilesDirectory(
    userDataPath,
    sessionId,
  );
  if (
    session.allowedAdditionalDirectories.some(
      (entry) => path.resolve(entry) === path.resolve(sessionFilesDirectory),
    )
  ) {
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

/** 元の拡張子を保ち、名前の衝突時に使う番号付きの保存先候補を組み立てる。 */
function buildDestinationCandidate(
  directoryPath: string,
  requestedFileName: string,
  index: number,
): string {
  const parsed = path.parse(safeFileName(requestedFileName));
  const baseName = parsed.name || "file";
  const extension = parsed.ext;
  const fileName =
    index === 1
      ? `${baseName}${extension}`
      : `${baseName}-${index}${extension}`;
  return path.join(directoryPath, fileName);
}

/** 上書きしないコピーを試し、衝突の場合だけ次の番号候補を使う。 */
async function copyUniqueFile(
  directoryPath: string,
  sourcePath: string,
): Promise<string> {
  for (let index = 1; index < 10000; index += 1) {
    const candidate = buildDestinationCandidate(
      directoryPath,
      path.basename(sourcePath),
      index,
    );
    try {
      await copyFile(sourcePath, candidate, constants.COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      const code =
        error && typeof error === "object"
          ? (error as { code?: unknown }).code
          : null;
      if (code !== "EEXIST") {
        throw error;
      }
    }
  }

  throw new Error("Could not choose a destination file name.");
}

/** 空の参照を飛ばし、入力順に SessionFolder 内へ既存ファイルを上書きせずコピーする。 */
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

/** 別名指定では番号付きの新規名へ保存する。通常の貼り付けでは同じ内容を再利用し、置き換えには確認したハッシュの一致を要する。 */
export async function saveSessionFile(
  userDataPath: string,
  input: SaveSessionFileInput,
): Promise<SavePastedSessionFileResult> {
  const directoryPath = resolveSessionFilesDirectory(
    userDataPath,
    input.sessionId,
  );
  await mkdir(directoryPath, { recursive: true });
  const fileName = safeFileName(input.fileName);
  const destination = path.join(directoryPath, fileName);
  if (input.saveAsCopy) {
    for (let index = 2; index < 10000; index += 1) {
      const candidate = buildDestinationCandidate(
        directoryPath,
        fileName,
        index,
      );
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
    throw new Error(
      `Cannot paste "${fileName}": the existing entry is not a regular file.`,
    );
  }
  const existing = await open(destination, "r");
  let existingHash: string;
  try {
    const hash = createHash("sha256");
    for await (const chunk of existing.createReadStream({ autoClose: false }))
      hash.update(chunk);
    existingHash = hash.digest("hex");
  } finally {
    await existing.close();
  }
  if (existingHash === createHash("sha256").update(input.data).digest("hex"))
    return { status: "reused", path: destination };
  if (input.replaceExistingHash !== existingHash)
    return { status: "conflict", fileName, existingHash };

  const temporaryPath = path.join(directoryPath, `.paste-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, input.data, { flag: "wx" });
    await rename(temporaryPath, destination);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return destination;
}

/** 対象 Session の専用ディレクトリと内容を削除する。存在しない場合も完了とする。 */
export async function deleteSessionFilesDirectory(
  userDataPath: string,
  sessionId: string,
): Promise<void> {
  await rm(resolveSessionFilesDirectory(userDataPath, sessionId), {
    recursive: true,
    force: true,
  });
}

/** 廃止した Mate Talk の接頭辞を持つディレクトリだけを掃除し、削除した件数を返す。 */
export async function cleanupMateTalkSessionFilesDirectories(
  userDataPath: string,
): Promise<number> {
  const rootPath = path.join(userDataPath, SESSION_FILES_ROOT);
  let entries: Dirent[];
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    const code =
      error && typeof error === "object"
        ? (error as { code?: unknown }).code
        : null;
    if (code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  let deletedCount = 0;
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !entry.name.startsWith(MATE_TALK_SESSION_FILES_PREFIX)
    ) {
      continue;
    }

    await rm(path.join(rootPath, entry.name), { recursive: true, force: true });
    deletedCount += 1;
  }

  return deletedCount;
}
