import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";

import type {
  SessionRuntimeFileListInput,
  SessionRuntimeFileListResult,
  SessionRuntimeFileReadTextInput,
  SessionRuntimeFileReadTextResult,
  SessionRuntimeFileReference,
  SessionRuntimeFileWriteTextInput,
  SessionRuntimeFileWriteTextResult,
  SessionRuntimeEffect,
} from "../src/session-external-runtime-contract.js";
import {
  cleanupIdentityBoundFileWrite,
  IdentityBoundFileWriteError,
  writeIdentityBoundFile,
} from "./identity-bound-file-write.js";
import {
  IdentityBoundDirectoryLimitError,
  listIdentityBoundDirectory,
} from "./identity-bound-directory-listing.js";
import {
  SessionFileWriteIdempotencyConflictError,
  type SessionStorageV6,
} from "./session-storage-v6.js";

const SESSION_FILE_WRITE_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_FILE_LIST_CURSOR_VERSION = 1;
const SESSION_FILE_LIST_SORT = "relative_path_asc";
const SESSION_FILE_WRITE_TEMP_PREFIX = ".withmate-session-write-";
const SESSION_FILE_LIST_MIN_SCAN_BUDGET = 256;
const SESSION_FILE_LIST_MAX_SCAN_BUDGET = 10_000;
const SESSION_FILE_LIST_SCAN_MULTIPLIER = 100;

type SessionFileListCursor = {
  version: typeof SESSION_FILE_LIST_CURSOR_VERSION;
  operation: "session.files.list";
  sort: typeof SESSION_FILE_LIST_SORT;
  sessionId: string;
  relativePath: string;
};

export class SessionFileServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details: Record<string, string | number | boolean> = {},
    readonly effect: SessionRuntimeEffect = "not_applied",
  ) {
    super(message);
    this.name = "SessionFileServiceError";
  }
}

export type SessionFileServiceDeps = {
  storage: Pick<
    SessionStorageV6,
    | "getSessionSummary"
    | "prepareSessionFileWrite"
    | "completeSessionFileWrite"
    | "rejectSessionFileWrite"
  >;
  resolveSessionFilesDirectory(sessionId: string): string;
  now?(): Date;
  createTempName?(): string;
  onWriteIdentityBound?(): void;
};

export class SessionFileService {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SessionFileServiceDeps) {}

  async list(input: SessionRuntimeFileListInput): Promise<SessionRuntimeFileListResult> {
    this.requireDefaultSession(input.sessionId);
    const rootPath = this.deps.resolveSessionFilesDirectory(input.sessionId);
    const root = await authorizeRoot(rootPath, true);
    if (!root) {
      return { items: [] };
    }
    try {
      const afterPath = input.cursor ? decodeListCursor(input.cursor, input.sessionId) : null;
      const items: SessionRuntimeFileReference[] = [];
      const scanBudget = {
        remaining: Math.min(
          SESSION_FILE_LIST_MAX_SCAN_BUDGET,
          Math.max(SESSION_FILE_LIST_MIN_SCAN_BUDGET, (input.limit + 1) * SESSION_FILE_LIST_SCAN_MULTIPLIER),
        ),
      };
      await this.collectFiles({
        sessionId: input.sessionId,
        root,
        directoryPath: root.realPath,
        relativeDirectory: "",
        afterPath,
        limit: input.limit + 1,
        items,
        scanBudget,
      });
      const visible = items.slice(0, input.limit);
      const last = visible.at(-1);
      return {
        items: visible,
        ...(items.length > input.limit && last
          ? { nextCursor: encodeListCursor(input.sessionId, last.relativePath) }
          : {}),
      };
    } finally {
      await closeAuthorizedRoot(root);
    }
  }

  async readText(input: SessionRuntimeFileReadTextInput): Promise<SessionRuntimeFileReadTextResult> {
    this.requireDefaultSession(input.sessionId);
    const relativePath = normalizeRelativePath(input.relativePath);
    const rootPath = this.deps.resolveSessionFilesDirectory(input.sessionId);
    const root = await authorizeRoot(rootPath, false);
    if (!root) {
      throw notFound(input.sessionId, relativePath);
    }
    try {
      const targetPath = path.join(rootPath, ...relativePath.split("/"));
      const opened = await openAuthorizedFile(root, targetPath, input.sessionId, relativePath);
      try {
        if (opened.stats.size > input.maxBytes) {
          throw contentTooLarge(relativePath, opened.stats.size, input.maxBytes);
        }
        const bytes = await readBounded(opened.handle, input.maxBytes);
        const after = await opened.handle.stat();
        if (!isStableFile(opened.stats, after)) {
          throw changedPath(relativePath);
        }
        await confirmRootIdentity(root, relativePath);
        let content: string;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new SessionFileServiceError(
            "INVALID_TEXT_ENCODING",
            "The Session file is not valid UTF-8 text.",
            false,
            { relativePath },
          );
        }
        return {
          file: projectFileReference(input.sessionId, relativePath, after),
          content,
        };
      } finally {
        await opened.handle.close();
      }
    } finally {
      await closeAuthorizedRoot(root);
    }
  }

  writeText(input: SessionRuntimeFileWriteTextInput): Promise<SessionRuntimeFileWriteTextResult> {
    return this.enqueueMutation(() => this.writeTextNow(input));
  }

  private async writeTextNow(input: SessionRuntimeFileWriteTextInput): Promise<SessionRuntimeFileWriteTextResult> {
    this.requireDefaultSession(input.sessionId);
    const relativePath = normalizeRelativePath(input.relativePath);
    const contentBytes = Buffer.from(input.content, "utf8");
    if (contentBytes.byteLength > input.maxBytes) {
      throw contentTooLarge(relativePath, contentBytes.byteLength, input.maxBytes);
    }
    const requestFingerprint = fingerprintWrite({
      sessionId: input.sessionId,
      relativePath,
      contentSha256: sha256(contentBytes),
      replace: input.replace,
    });
    const now = this.now();
    let prepared;
    try {
      prepared = this.deps.storage.prepareSessionFileWrite({
        idempotencyKey: input.idempotencyKey,
        requestFingerprint,
        sessionId: input.sessionId,
        relativePath,
        tempName: this.createTempName(),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SESSION_FILE_WRITE_IDEMPOTENCY_TTL_MS).toISOString(),
      });
    } catch (error) {
      if (error instanceof SessionFileWriteIdempotencyConflictError) {
        throw new SessionFileServiceError(
          "IDEMPOTENCY_CONFLICT",
          "The idempotency key was reused with different input.",
        );
      }
      throw error;
    }
    if (prepared.kind === "replay") {
      await this.cleanupWriteTempBestEffort(input.sessionId, relativePath, prepared.tempName);
      return normalizeWriteResult(prepared.result);
    }
    if (prepared.kind === "rejected") {
      await this.cleanupWriteTempBestEffort(input.sessionId, relativePath, prepared.tempName);
      throw normalizeStoredWriteError(prepared.error);
    }

    const rootPath = this.deps.resolveSessionFilesDirectory(input.sessionId);
    const expectedParentRealPath = await ensureSessionRootDirectory(rootPath);
    const root = await authorizeRoot(rootPath, false, expectedParentRealPath);
    if (!root) {
      throw new SessionFileServiceError("RUNTIME_UNAVAILABLE", "The SessionFolder could not be created.", true);
    }
    try {
      const contentDigest = sha256(contentBytes);
      let written: Awaited<ReturnType<typeof writeIdentityBoundFile>>;
      try {
        written = await writeIdentityBoundFile({
          rootPath: root.realPath,
          rootStats: root.stats,
          relativePath,
          content: contentBytes,
          contentDigest,
          tempName: prepared.tempName,
          replace: input.replace,
          resumed: prepared.resumed,
          onIdentityBound: this.deps.onWriteIdentityBound,
        });
        try {
          await confirmRootIdentity(root, relativePath);
        } catch (error) {
          if (error instanceof SessionFileServiceError) {
            throw new SessionFileServiceError(
              error.code,
              error.message,
              error.retryable,
              { sessionId: input.sessionId, relativePath },
              "indeterminate",
            );
          }
          throw error;
        }
      } catch (error) {
        if (error instanceof IdentityBoundFileWriteError) {
          if (error.code === "FILE_ALREADY_EXISTS") {
            const terminalError = fileAlreadyExists(relativePath);
            const rejected = this.rejectWrite(input.idempotencyKey, requestFingerprint, terminalError);
            await this.cleanupWriteTempBestEffort(input.sessionId, relativePath, prepared.tempName, root);
            throw rejected;
          }
          throw new SessionFileServiceError(
            error.code === "PATH_CHANGED" ? "PATH_CHANGED" : "RUNTIME_UNAVAILABLE",
            error.code === "PATH_CHANGED"
              ? "The Session file path changed while it was being authorized."
              : "The Session file write could not be completed.",
            true,
            { sessionId: input.sessionId, relativePath },
            error.published ? "indeterminate" : "not_applied",
          );
        }
        throw error;
      }
      const result = this.completeWrite(input.idempotencyKey, requestFingerprint, {
        file: {
          sessionId: input.sessionId,
          relativePath,
          byteLength: written.byteLength,
          modifiedAt: written.modifiedAt,
        },
      });
      await this.cleanupWriteTempBestEffort(input.sessionId, relativePath, prepared.tempName, root);
      return result;
    } finally {
      await closeAuthorizedRoot(root);
    }
  }

  private completeWrite(
    idempotencyKey: string,
    requestFingerprint: string,
    result: SessionRuntimeFileWriteTextResult,
  ): SessionRuntimeFileWriteTextResult {
    const completedAt = this.now();
    return normalizeWriteResult(this.deps.storage.completeSessionFileWrite({
      idempotencyKey,
      requestFingerprint,
      result,
      completedAt: completedAt.toISOString(),
      expiresAt: new Date(completedAt.getTime() + SESSION_FILE_WRITE_IDEMPOTENCY_TTL_MS).toISOString(),
    }));
  }

  private rejectWrite(
    idempotencyKey: string,
    requestFingerprint: string,
    error: SessionFileServiceError,
  ): SessionFileServiceError {
    const completedAt = this.now();
    return normalizeStoredWriteError(this.deps.storage.rejectSessionFileWrite({
      idempotencyKey,
      requestFingerprint,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
        effect: error.effect,
      },
      completedAt: completedAt.toISOString(),
      expiresAt: new Date(completedAt.getTime() + SESSION_FILE_WRITE_IDEMPOTENCY_TTL_MS).toISOString(),
    }));
  }

  private async cleanupWriteTempBestEffort(
    sessionId: string,
    relativePath: string,
    tempName: string,
    authorizedRoot?: AuthorizedRoot,
  ): Promise<void> {
    let ownedRoot = authorizedRoot;
    try {
      ownedRoot ??= await authorizeRoot(this.deps.resolveSessionFilesDirectory(sessionId), false) ?? undefined;
      if (!ownedRoot) return;
      await cleanupIdentityBoundFileWrite({
        rootPath: ownedRoot.realPath,
        rootStats: ownedRoot.stats,
        relativePath,
        tempName,
      });
    } catch {
      // Cleanup is retried on an idempotent replay and must not change an applied result.
    } finally {
      if (ownedRoot && ownedRoot !== authorizedRoot) await closeAuthorizedRoot(ownedRoot);
    }
  }

  private async collectFiles(input: {
    sessionId: string;
    root: AuthorizedRoot;
    directoryPath: string;
    relativeDirectory: string;
    afterPath: string | null;
    limit: number;
    items: SessionRuntimeFileReference[];
    scanBudget: { remaining: number };
  }): Promise<void> {
    if (input.items.length >= input.limit) return;
    if (input.scanBudget.remaining <= 0) {
      throw new SessionFileServiceError(
        "CONTENT_TOO_LARGE",
        "The Session file listing exceeded its scan budget.",
        false,
        { maxEntries: 0 },
      );
    }
    const directory = await openAuthorizedDirectory(input.root, input.directoryPath, input.relativeDirectory || ".");
    try {
      let snapshot;
      try {
        snapshot = await listIdentityBoundDirectory(directory.realPath, {
          maxEntries: input.scanBudget.remaining,
        });
      } catch (error) {
        if (error instanceof IdentityBoundDirectoryLimitError) {
          throw new SessionFileServiceError(
            "CONTENT_TOO_LARGE",
            "The Session file listing exceeded its scan budget.",
            false,
            { maxEntries: input.scanBudget.remaining },
          );
        }
        throw error;
      }
      input.scanBudget.remaining -= snapshot.scannedEntries;
      if (snapshot.device !== directory.stats.dev || snapshot.inode !== directory.stats.ino) {
        throw changedPath(input.relativeDirectory || ".");
      }
      const entries = [...snapshot.entries].sort((left, right) => comparePortablePaths(
        left.kind === "directory" ? `${left.name}/` : left.name,
        right.kind === "directory" ? `${right.name}/` : right.name,
      ));
      for (const entry of entries) {
        if (input.items.length >= input.limit) return;
        if (entry.name.startsWith(SESSION_FILE_WRITE_TEMP_PREFIX)) continue;
        const relativePath = input.relativeDirectory
          ? `${input.relativeDirectory}/${entry.name}`
          : entry.name;
        if (entry.kind === "directory") {
          await this.collectFiles({
            ...input,
            directoryPath: path.join(directory.realPath, entry.name),
            relativeDirectory: relativePath,
          });
          continue;
        }
        if (entry.kind !== "file" || (input.afterPath && comparePortablePaths(relativePath, input.afterPath) <= 0)) continue;
        const opened = await openAuthorizedFile(
          input.root,
          path.join(directory.realPath, entry.name),
          input.sessionId,
          relativePath,
        );
        try {
          input.items.push(projectFileReference(input.sessionId, relativePath, opened.stats));
        } finally {
          await opened.handle.close();
        }
      }
    } finally {
      await directory.handle.close();
    }
  }

  private requireDefaultSession(sessionId: string): void {
    const session = this.deps.storage.getSessionSummary(sessionId);
    if (!session || session.sessionKind !== "default") {
      throw new SessionFileServiceError(
        "SESSION_NOT_FOUND",
        "The requested Session was not found.",
        false,
        { sessionId },
      );
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.mutationQueue.then(operation, operation);
    this.mutationQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private createTempName(): string {
    const supplied = this.deps.createTempName?.();
    const suffix = supplied?.trim() || randomUUID();
    if (!/^[a-zA-Z0-9._-]+$/.test(suffix)) {
      throw new Error("Session file temp name generator returned an invalid value.");
    }
    return `${SESSION_FILE_WRITE_TEMP_PREFIX}${suffix}.tmp`;
  }
}

type AuthorizedRoot = {
  parentAbsolutePath: string;
  parentRealPath: string;
  parentHandle: Awaited<ReturnType<typeof open>>;
  parentStats: Stats;
  absolutePath: string;
  realPath: string;
  handle: Awaited<ReturnType<typeof open>>;
  stats: Stats;
};

type AuthorizedDirectory = {
  realPath: string;
  handle: Awaited<ReturnType<typeof open>>;
  stats: Stats;
};

async function authorizeRoot(
  rootPath: string,
  allowMissing: boolean,
  expectedParentRealPath?: string,
): Promise<AuthorizedRoot | null> {
  const parentAbsolutePath = path.dirname(rootPath);
  let parentLexicalStats: Stats;
  try {
    parentLexicalStats = await lstat(parentAbsolutePath);
  } catch (error) {
    if (allowMissing && hasCode(error, "ENOENT")) return null;
    throw error;
  }
  if (!parentLexicalStats.isDirectory() || parentLexicalStats.isSymbolicLink()) {
    throw new SessionFileServiceError("PATH_NOT_ALLOWED", "The Session files root is not a regular directory.");
  }
  const parentHandle = await open(parentAbsolutePath, "r");
  let parentStats: Stats;
  let parentRealPath: string;
  try {
    parentStats = await parentHandle.stat();
    parentRealPath = await realpath(parentAbsolutePath);
    const confirmedParentRealPath = await realpath(parentAbsolutePath);
    const confirmedParentStats = await stat(confirmedParentRealPath);
    if (
      !parentStats.isDirectory()
      || pathKey(parentRealPath) !== pathKey(confirmedParentRealPath)
      || (expectedParentRealPath !== undefined && pathKey(parentRealPath) !== pathKey(expectedParentRealPath))
      || !isSameIdentity(parentStats, confirmedParentStats)
    ) {
      throw changedPath(".");
    }
  } catch (error) {
    await parentHandle.close();
    throw error;
  }
  let lexicalStats: Stats;
  try {
    lexicalStats = await lstat(rootPath);
  } catch (error) {
    await parentHandle.close();
    if (allowMissing && hasCode(error, "ENOENT")) return null;
    throw error;
  }
  if (!lexicalStats.isDirectory() || lexicalStats.isSymbolicLink()) {
    await parentHandle.close();
    throw new SessionFileServiceError("PATH_NOT_ALLOWED", "The SessionFolder is not a regular directory.");
  }
  const handle = await open(rootPath, "r");
  try {
    const openedStats = await handle.stat();
    const rootRealPath = await realpath(rootPath);
    const targetStats = await stat(rootRealPath);
    const confirmedParentRealPath = await realpath(parentAbsolutePath);
    const confirmedParentStats = await stat(confirmedParentRealPath);
    const confirmedRealPath = await realpath(rootPath);
    const confirmedStats = await stat(confirmedRealPath);
    if (
      !openedStats.isDirectory()
      || pathKey(confirmedParentRealPath) !== pathKey(parentRealPath)
      || pathKey(rootRealPath) !== pathKey(confirmedRealPath)
      || !isPathInside(parentRealPath, rootRealPath)
      || !isSameIdentity(parentStats, confirmedParentStats)
      || !isSameIdentity(openedStats, targetStats)
      || !isSameIdentity(openedStats, confirmedStats)
    ) {
      throw changedPath(".");
    }
    return {
      parentAbsolutePath,
      parentRealPath,
      parentHandle,
      parentStats,
      absolutePath: rootPath,
      realPath: rootRealPath,
      handle,
      stats: openedStats,
    };
  } catch (error) {
    await handle.close();
    await parentHandle.close();
    throw error;
  }
}

async function ensureSessionRootDirectory(rootPath: string): Promise<string> {
  const parentPath = path.dirname(rootPath);
  await mkdir(parentPath, { recursive: true });
  const parentStats = await lstat(parentPath);
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new SessionFileServiceError("PATH_NOT_ALLOWED", "The Session files root is not a regular directory.");
  }
  const parentRealPath = await realpath(parentPath);
  try {
    await mkdir(path.join(parentRealPath, path.basename(rootPath)));
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  return parentRealPath;
}

async function closeAuthorizedRoot(root: AuthorizedRoot): Promise<void> {
  try {
    await root.handle.close();
  } finally {
    await root.parentHandle.close();
  }
}

async function openAuthorizedFile(
  root: AuthorizedRoot,
  targetPath: string,
  sessionId: string,
  relativePath: string,
): Promise<{ path: string; handle: Awaited<ReturnType<typeof open>>; stats: Stats }> {
  const handle = await open(targetPath, "r");
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) throw notFound(sessionId, relativePath);
    const targetRealPath = await realpath(targetPath);
    const targetStats = await stat(targetRealPath);
    const confirmedRoot = await confirmRootIdentity(root, relativePath);
    const confirmedTarget = await realpath(targetPath);
    const confirmedStats = await stat(confirmedTarget);
    if (
      pathKey(confirmedRoot) !== pathKey(root.realPath)
      || pathKey(confirmedTarget) !== pathKey(targetRealPath)
      || !isPathInside(confirmedRoot, confirmedTarget)
      || !isSameIdentity(openedStats, targetStats)
      || !isSameIdentity(openedStats, confirmedStats)
    ) {
      throw changedPath(relativePath);
    }
    return { path: targetRealPath, handle, stats: openedStats };
  } catch (error) {
    await handle.close();
    if (hasCode(error, "ENOENT")) throw notFound(sessionId, relativePath);
    throw error;
  }
}

async function openAuthorizedDirectory(
  root: AuthorizedRoot,
  targetPath: string,
  relativePath: string,
): Promise<AuthorizedDirectory> {
  const handle = await open(targetPath, "r");
  try {
    const openedStats = await handle.stat();
    const targetRealPath = await realpath(targetPath);
    const targetStats = await stat(targetRealPath);
    const confirmedRoot = await confirmRootIdentity(root, relativePath);
    const confirmedTarget = await realpath(targetPath);
    const confirmedStats = await stat(confirmedTarget);
    if (
      !openedStats.isDirectory()
      || pathKey(confirmedRoot) !== pathKey(root.realPath)
      || pathKey(confirmedTarget) !== pathKey(targetRealPath)
      || !isPathInside(confirmedRoot, confirmedTarget)
      || !isSameIdentity(openedStats, targetStats)
      || !isSameIdentity(openedStats, confirmedStats)
    ) {
      throw changedPath(relativePath);
    }
    return { realPath: targetRealPath, handle, stats: openedStats };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function confirmRootIdentity(root: AuthorizedRoot, relativePath: string): Promise<string> {
  const currentParentRealPath = await realpath(root.parentAbsolutePath);
  const currentParentStats = await stat(currentParentRealPath);
  const openedParentStats = await root.parentHandle.stat();
  const currentRootRealPath = await realpath(root.absolutePath);
  const currentRootStats = await stat(currentRootRealPath);
  const openedRootStats = await root.handle.stat();
  if (
    pathKey(currentParentRealPath) !== pathKey(root.parentRealPath)
    || pathKey(currentRootRealPath) !== pathKey(root.realPath)
    || !isPathInside(currentParentRealPath, currentRootRealPath)
    || !isSameIdentity(root.parentStats, currentParentStats)
    || !isSameIdentity(root.parentStats, openedParentStats)
    || !isSameIdentity(root.stats, currentRootStats)
    || !isSameIdentity(root.stats, openedRootStats)
  ) {
    throw changedPath(relativePath);
  }
  return currentRootRealPath;
}

async function readBounded(handle: Awaited<ReturnType<typeof open>>, maxBytes: number): Promise<Uint8Array> {
  const buffer = new Uint8Array(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maxBytes) throw contentTooLarge("content", offset, maxBytes);
  return buffer.slice(0, offset);
}

function normalizeRelativePath(value: string): string {
  if (
    !value
    || value.includes("\0")
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
  ) {
    throw invalidPath(value);
  }
  const segments = value.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
    || segments.some((segment) => segment.startsWith(SESSION_FILE_WRITE_TEMP_PREFIX))
  ) {
    throw invalidPath(value);
  }
  return segments.join("/");
}

function projectFileReference(sessionId: string, relativePath: string, stats: Stats): SessionRuntimeFileReference {
  return {
    sessionId,
    relativePath,
    byteLength: stats.size,
    modifiedAt: stats.mtime.toISOString(),
  };
}

function normalizeWriteResult(value: unknown): SessionRuntimeFileWriteTextResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored Session file write result is invalid.");
  }
  const file = (value as Record<string, unknown>).file;
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    throw new Error("Stored Session file write result is invalid.");
  }
  const record = file as Record<string, unknown>;
  if (
    typeof record.sessionId !== "string"
    || typeof record.relativePath !== "string"
    || typeof record.byteLength !== "number"
    || typeof record.modifiedAt !== "string"
  ) {
    throw new Error("Stored Session file write result is invalid.");
  }
  return { file: {
    sessionId: record.sessionId,
    relativePath: record.relativePath,
    byteLength: record.byteLength,
    modifiedAt: record.modifiedAt,
  } };
}

function encodeListCursor(sessionId: string, relativePath: string): string {
  const cursor: SessionFileListCursor = {
    version: SESSION_FILE_LIST_CURSOR_VERSION,
    operation: "session.files.list",
    sort: SESSION_FILE_LIST_SORT,
    sessionId,
    relativePath,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeListCursor(cursor: string, sessionId: string): string {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<SessionFileListCursor>;
    if (
      value.version !== SESSION_FILE_LIST_CURSOR_VERSION
      || value.operation !== "session.files.list"
      || value.sort !== SESSION_FILE_LIST_SORT
      || value.sessionId !== sessionId
      || typeof value.relativePath !== "string"
      || !value.relativePath
    ) {
      throw new Error("invalid cursor");
    }
    return value.relativePath;
  } catch {
    throw new SessionFileServiceError("INVALID_CURSOR", "The pagination cursor is invalid.", false, {
      field: "cursor",
    });
  }
}

function fingerprintWrite(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function normalizeStoredWriteError(value: unknown): SessionFileServiceError {
  if (!value || typeof value !== "object") {
    throw new Error("Rejected Session file write is missing its canonical error.");
  }
  const error = value as Record<string, unknown>;
  if (
    typeof error.code !== "string"
    || typeof error.message !== "string"
    || typeof error.retryable !== "boolean"
    || !error.details
    || typeof error.details !== "object"
    || Array.isArray(error.details)
    || (error.effect !== "not_applied" && error.effect !== "applied" && error.effect !== "indeterminate")
  ) {
    throw new Error("Rejected Session file write has an invalid canonical error.");
  }
  const details: Record<string, string | number | boolean> = {};
  for (const [key, detail] of Object.entries(error.details)) {
    if (typeof detail !== "string" && typeof detail !== "number" && typeof detail !== "boolean") {
      throw new Error("Rejected Session file write has invalid error details.");
    }
    details[key] = detail;
  }
  return new SessionFileServiceError(
    error.code,
    error.message,
    error.retryable,
    details,
    error.effect,
  );
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparePortablePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isPathInside(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function pathKey(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isSameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isStableFile(before: Stats, after: Stats): boolean {
  return isSameIdentity(before, after)
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs;
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
}

function invalidPath(relativePath: string): SessionFileServiceError {
  return new SessionFileServiceError(
    "PATH_NOT_ALLOWED",
    "The Session file path must be a portable relative path inside the SessionFolder.",
    false,
    { relativePath },
  );
}

function changedPath(relativePath: string): SessionFileServiceError {
  return new SessionFileServiceError(
    "PATH_CHANGED",
    "The Session file path changed while it was being authorized.",
    true,
    { relativePath },
  );
}

function notFound(sessionId: string, relativePath: string): SessionFileServiceError {
  return new SessionFileServiceError(
    "FILE_NOT_FOUND",
    "The requested Session file was not found.",
    false,
    { sessionId, relativePath },
  );
}

function fileAlreadyExists(relativePath: string): SessionFileServiceError {
  return new SessionFileServiceError(
    "FILE_ALREADY_EXISTS",
    "The Session file already exists and replace was not enabled.",
    false,
    { relativePath },
  );
}

function contentTooLarge(relativePath: string, actualBytes: number, maxBytes: number): SessionFileServiceError {
  return new SessionFileServiceError(
    "CONTENT_TOO_LARGE",
    "The Session file exceeds the requested byte limit.",
    false,
    { relativePath, actualBytes, maxBytes },
  );
}
