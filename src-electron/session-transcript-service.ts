import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  SESSION_TRANSCRIPT_FOLDER_HARD_MAX_BYTES,
  SESSION_TRANSCRIPT_INLINE_HARD_MAX_BYTES,
  createPublicTranscriptV1,
  serializePublicTranscriptChunks,
  type PublicTranscriptV1,
  type PublicTranscriptV1Input,
  type SessionTranscriptExportInput,
  type SessionTranscriptExportResult,
  type SessionTranscriptFolderResult,
} from "../src/session-transcript.js";
import {
  SessionTranscriptIdempotencyConflictError,
  type SessionTranscriptBaseProjection,
  type SessionTranscriptStorageV6,
} from "./session-transcript-storage-v6.js";
import {
  cleanupIdentityBoundTranscript,
  exportIdentityBoundTranscript,
  IdentityBoundTranscriptExportError,
} from "./identity-bound-transcript-export.js";

const EXPORT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const EXPORT_TEMP_PREFIX = ".withmate-transcript-export-";

export type SessionTranscriptProjectionSource = {
  project(
    sessionId: string,
    base: SessionTranscriptBaseProjection,
  ): PublicTranscriptV1Input | Promise<PublicTranscriptV1Input>;
};

export type SessionTranscriptServiceDeps = {
  storage: Pick<
    SessionTranscriptStorageV6,
    | "readBaseProjection"
    | "readBaseProjectionStream"
    | "prepareExport"
    | "recordPreparedOutput"
    | "completeExport"
    | "rejectExport"
  >;
  resolveSessionFilesDirectory(sessionId: string): string;
  projectionSource?: SessionTranscriptProjectionSource;
  now?(): Date;
  createTempName?(): string;
  onBeforePublish?(): void;
  onAfterReplaceRename?(): void;
  onAfterPublish?(): void;
};

export class SessionTranscriptServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details: Record<string, string | number | boolean> = {},
    readonly effect: "not_applied" | "applied" | "indeterminate" = "not_applied",
  ) {
    super(message);
    this.name = "SessionTranscriptServiceError";
  }
}

export class SessionTranscriptService {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SessionTranscriptServiceDeps) {}

  export(input: SessionTranscriptExportInput): Promise<SessionTranscriptExportResult> {
    validateMaxBytes(input);
    return input.destination.kind === "inline"
      ? this.exportInline(input)
      : this.enqueueMutation(() => this.exportFolder(input));
  }

  private async exportInline(input: SessionTranscriptExportInput): Promise<SessionTranscriptExportResult> {
    const transcript = await this.project(input.sessionId);
    const serialized = collectBounded(
      serializePublicTranscriptChunks(transcript, input.format),
      input.maxBytes,
    );
    return {
      destination: "inline",
      format: input.format,
      byteLength: serialized.byteLength,
      content: serialized.content,
    };
  }

  private async exportFolder(input: SessionTranscriptExportInput): Promise<SessionTranscriptFolderResult> {
    if (input.destination.kind !== "session_folder") {
      throw new TypeError("SessionFolder transcript export requires a SessionFolder destination.");
    }
    const idempotencyKey = input.destination.idempotencyKey;
    const relativePath = normalizeRelativePath(input.destination.relativePath);
    const initialStream = this.deps.storage.readBaseProjectionStream(input.sessionId);
    if (!initialStream) this.throwSessionNotFound(input.sessionId);
    const fingerprint = sha256(JSON.stringify({
      operation: "transcript.export",
      sessionId: input.sessionId,
      format: input.format,
      maxBytes: input.maxBytes,
      relativePath,
      replace: input.destination.replace,
    }));
    const now = this.now();
    let prepared;
    try {
      prepared = this.deps.storage.prepareExport({
        idempotencyKey: input.destination.idempotencyKey,
        requestFingerprint: fingerprint,
        sessionId: input.sessionId,
        relativePath,
        tempName: this.createTempName(),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + EXPORT_IDEMPOTENCY_TTL_MS).toISOString(),
      });
    } catch (error) {
      if (error instanceof SessionTranscriptIdempotencyConflictError) {
        throw new SessionTranscriptServiceError(
          "IDEMPOTENCY_CONFLICT",
          "The transcript export idempotency key was reused with different input.",
        );
      }
      throw error;
    }
    if (prepared.kind === "replay") return normalizeFolderResult(prepared.result);
    if (prepared.kind === "rejected") throw normalizeStoredError(prepared.error);

    const root = await authorizeRoot(this.deps.resolveSessionFilesDirectory(input.sessionId));
    let cleanupParent: AuthorizedParent | undefined;
    let cleanupTempPath: string | undefined;
    let stagedIdentity: { dev: number | bigint; ino: number | bigint } | undefined;
    let cleanupOnFailure = false;
    try {
      const parent = await authorizeDestinationParent(root, relativePath);
      cleanupParent = parent;
      const targetName = path.basename(relativePath);
      const tempPath = path.join(parent.realPath, prepared.tempName);
      cleanupTempPath = tempPath;
      let outputSha256 = prepared.outputSha256;
      let byteLength = prepared.byteLength;
      let publishedModifiedAt: string;

      try {
        const published = outputSha256 !== null && byteLength !== null
          ? await exportIdentityBoundTranscript({
            action: "recover",
            parentPath: parent.realPath,
            parentStats: parent.stats,
            targetName,
            tempName: prepared.tempName,
            replace: input.destination.replace,
            expectedSha256: outputSha256,
            expectedByteLength: byteLength,
            onAfterReplaceRename: this.deps.onAfterReplaceRename,
          })
          : await exportIdentityBoundTranscript({
            action: "stage",
            parentPath: parent.realPath,
            parentStats: parent.stats,
            targetName,
            tempName: prepared.tempName,
            replace: input.destination.replace,
            chunks: this.deps.projectionSource
              ? serializePublicTranscriptChunks(await this.project(input.sessionId), input.format)
              : serializePublicTranscriptChunks(initialStream, input.format),
            maxBytes: input.maxBytes,
            resumed: prepared.resumed,
            onPrepared: (staged) => {
              outputSha256 = staged.sha256;
              byteLength = staged.byteLength;
              stagedIdentity = { dev: staged.device, ino: staged.inode };
              this.deps.storage.recordPreparedOutput({
                idempotencyKey,
                requestFingerprint: fingerprint,
                outputSha256,
                byteLength,
              });
              this.deps.onBeforePublish?.();
            },
            onAfterReplaceRename: this.deps.onAfterReplaceRename,
          });
        outputSha256 = published.sha256;
        byteLength = published.byteLength;
        stagedIdentity = { dev: published.device, ino: published.inode };
        publishedModifiedAt = published.modifiedAt;
      } catch (error) {
        throw normalizeIdentityBoundError(error, relativePath, input.maxBytes);
      }

      await confirmDirectoryIdentities(root, parent, "indeterminate");
      if (outputSha256 === null || byteLength === null) throw new Error("Transcript export output was not prepared.");

      this.deps.onAfterPublish?.();
      const result: SessionTranscriptFolderResult = {
        destination: "session_folder",
        format: input.format,
        file: {
          sessionId: input.sessionId,
          relativePath,
          byteLength,
          modifiedAt: publishedModifiedAt,
          sha256: outputSha256,
        },
      };
      const completedAt = this.now();
      const canonical = normalizeFolderResult(this.deps.storage.completeExport({
        idempotencyKey: input.destination.idempotencyKey,
        requestFingerprint: fingerprint,
        outputSha256,
        byteLength,
        result,
        completedAt: completedAt.toISOString(),
        expiresAt: new Date(completedAt.getTime() + EXPORT_IDEMPOTENCY_TTL_MS).toISOString(),
      }));
      await cleanupIdentityBoundTranscript({
        parentPath: parent.realPath,
        parentStats: parent.stats,
        tempName: prepared.tempName,
      });
      return canonical;
    } catch (error) {
      cleanupOnFailure = error instanceof SessionTranscriptServiceError
        && (error.code === "PATH_OUTSIDE_SESSION_FOLDER"
          || (error.code === "EXPORT_FAILED" && error.message.includes("identity")));
      if (
        error instanceof SessionTranscriptServiceError
        && error.effect === "not_applied"
        && !error.retryable
      ) {
        const terminal = this.reject(input.destination.idempotencyKey, fingerprint, error);
        throw terminal;
      }
      throw error;
    } finally {
      if (cleanupOnFailure && cleanupParent && cleanupTempPath) {
        await cleanupExportTemp({
          root,
          parent: cleanupParent,
          tempPath: cleanupTempPath,
          tempName: prepared.tempName,
          stagedIdentity,
        });
      }
      await root.handle.close();
    }
  }

  private async project(
    sessionId: string,
    base = this.requireBaseProjection(sessionId),
  ): Promise<PublicTranscriptV1> {
    const projected = this.deps.projectionSource
      ? await this.deps.projectionSource.project(sessionId, base)
      : {
        completeness: base.legacyTurns.length > 0 ? "legacy_partial" as const : "complete" as const,
        session: base.session,
        messages: base.messages,
        turns: [...base.legacyTurns, ...base.publicTurns]
          .sort((left, right) => left.sequence - right.sequence),
        interactions: base.interactions,
      };
    return createPublicTranscriptV1(projected);
  }

  private requireBaseProjection(sessionId: string): SessionTranscriptBaseProjection {
    const base = this.deps.storage.readBaseProjection(sessionId);
    if (base) return base;
    return this.throwSessionNotFound(sessionId);
  }

  private throwSessionNotFound(sessionId: string): never {
    throw new SessionTranscriptServiceError(
      "SESSION_NOT_FOUND",
      "The requested Session was not found.",
      false,
      { sessionId },
    );
  }

  private reject(
    idempotencyKey: string,
    requestFingerprint: string,
    error: SessionTranscriptServiceError,
  ): SessionTranscriptServiceError {
    const completedAt = this.now();
    return normalizeStoredError(this.deps.storage.rejectExport({
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
      expiresAt: new Date(completedAt.getTime() + EXPORT_IDEMPOTENCY_TTL_MS).toISOString(),
    }));
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
    const suffix = this.deps.createTempName?.().trim() || randomUUID();
    if (!/^[a-zA-Z0-9._-]+$/.test(suffix)) {
      throw new TypeError("Transcript export temp name must be a portable file name.");
    }
    return `${EXPORT_TEMP_PREFIX}${suffix}.tmp`;
  }
}

type AuthorizedRoot = {
  absolutePath: string;
  realPath: string;
  handle: FileHandle;
  stats: Stats;
};

type AuthorizedParent = {
  realPath: string;
  stats: Stats;
};

async function authorizeRoot(rootPath: string): Promise<AuthorizedRoot> {
  const lexical = await lstat(rootPath);
  if (!lexical.isDirectory() || lexical.isSymbolicLink()) throw pathChanged(".");
  const handle = await open(rootPath, "r");
  try {
    const opened = await handle.stat();
    const realPath = await realpath(rootPath);
    const confirmed = await stat(realPath);
    if (!opened.isDirectory() || !sameIdentity(opened, confirmed)) throw pathChanged(".");
    return { absolutePath: rootPath, realPath, handle, stats: opened };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function authorizeDestinationParent(root: AuthorizedRoot, relativePath: string): Promise<AuthorizedParent> {
  const segments = relativePath.split("/");
  segments.pop();
  let current = root.realPath;
  for (const segment of segments) {
    const next = path.join(current, segment);
    try {
      await mkdir(next);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    const lexical = await lstat(next);
    if (!lexical.isDirectory() || lexical.isSymbolicLink()) throw pathChanged(relativePath);
    const real = await realpath(next);
    const currentStats = await stat(real);
    if (!isInside(root.realPath, real) || !sameIdentity(lexical, currentStats)) throw pathChanged(relativePath);
    current = real;
  }
  return { realPath: current, stats: await stat(current) };
}

async function confirmDirectoryIdentities(
  root: AuthorizedRoot,
  parent: AuthorizedParent,
  effect: "not_applied" | "indeterminate" = "not_applied",
): Promise<void> {
  const currentRootReal = await realpath(root.absolutePath);
  const currentRoot = await stat(currentRootReal);
  const currentParentLexical = await lstat(parent.realPath);
  const currentParentReal = await realpath(parent.realPath);
  const currentParent = await stat(currentParentReal);
  if (
    pathKey(currentRootReal) !== pathKey(root.realPath)
    || !sameIdentity(root.stats, currentRoot)
    || !currentParentLexical.isDirectory()
    || currentParentLexical.isSymbolicLink()
    || pathKey(currentParentReal) !== pathKey(parent.realPath)
    || !sameIdentity(currentParentLexical, currentParent)
    || !sameIdentity(parent.stats, currentParent)
    || !isInside(currentRootReal, currentParentReal)
  ) {
    throw pathChanged(parent.realPath, effect);
  }
}

async function unlinkRegularFileBestEffort(filePath: string): Promise<void> {
  try {
    const lexical = await lstat(filePath);
    if (!lexical.isFile() || lexical.isSymbolicLink()) return;
    await unlink(filePath);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) return;
  }
}

async function cleanupExportTemp(input: {
  root: AuthorizedRoot;
  parent: AuthorizedParent;
  tempPath: string;
  tempName: string;
  stagedIdentity?: { dev: number | bigint; ino: number | bigint };
}): Promise<void> {
  if (!input.stagedIdentity) return;
  const candidates = new Set<string>([input.tempPath]);
  await collectMatchingParentTempPaths(input.root.realPath, input.parent.stats, input.tempName, candidates);
  for (const candidate of candidates) {
    try {
      const lexical = await lstat(candidate);
      if (!lexical.isFile() || lexical.isSymbolicLink() || !sameIdentity(lexical, input.stagedIdentity)) continue;
      await unlink(candidate);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) continue;
    }
  }
}

async function collectMatchingParentTempPaths(
  directory: string,
  parentStats: { dev: number | bigint; ino: number | bigint },
  tempName: string,
  candidates: Set<string>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    let stats: Stats;
    try {
      stats = await stat(entryPath);
    } catch {
      continue;
    }
    if (sameIdentity(stats, parentStats)) candidates.add(path.join(entryPath, tempName));
    await collectMatchingParentTempPaths(entryPath, parentStats, tempName, candidates);
  }
}

function normalizeIdentityBoundError(
  error: unknown,
  relativePath: string,
  maxBytes: number,
): unknown {
  if (!(error instanceof IdentityBoundTranscriptExportError)) return error;
  if (error.code === "PATH_CHANGED") {
    return pathChanged(relativePath, error.published ? "indeterminate" : "not_applied");
  }
  if (error.code === "CONTENT_TOO_LARGE") {
    return contentTooLarge(error.actualBytes ?? maxBytes + 1, maxBytes);
  }
  if (error.code === "FILE_ALREADY_EXISTS") {
    return new SessionTranscriptServiceError(
      "FILE_ALREADY_EXISTS",
      "The transcript destination already exists and replace was not enabled.",
    );
  }
  if (error.code === "NOT_RECOVERABLE") {
    return new SessionTranscriptServiceError(
      "EXPORT_FAILED",
      "The prepared transcript export could not be recovered safely.",
      true,
    );
  }
  return new SessionTranscriptServiceError(
    "EXPORT_FAILED",
    "The transcript export worker failed.",
    true,
    { relativePath },
    error.published ? "indeterminate" : "not_applied",
  );
}

function validateMaxBytes(input: SessionTranscriptExportInput): void {
  const hard = input.destination.kind === "inline"
    ? SESSION_TRANSCRIPT_INLINE_HARD_MAX_BYTES
    : SESSION_TRANSCRIPT_FOLDER_HARD_MAX_BYTES;
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > hard) {
    throw new SessionTranscriptServiceError(
      "LIMIT_EXCEEDED",
      `Transcript maxBytes must be between 1 and ${hard}.`,
      false,
      { hardMaximum: hard },
    );
  }
}

function normalizeRelativePath(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.includes("\\")
    || normalized.startsWith("/")
    || /^[a-zA-Z]:/.test(normalized)
    || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new SessionTranscriptServiceError(
      "PATH_OUTSIDE_SESSION_FOLDER",
      "Transcript destination must be a portable relative SessionFolder path.",
    );
  }
  return normalized;
}

function collectBounded(chunks: Iterable<string>, maxBytes: number): { content: string; byteLength: number } {
  const values: string[] = [];
  let byteLength = 0;
  for (const chunk of chunks) {
    byteLength += Buffer.byteLength(chunk, "utf8");
    if (byteLength > maxBytes) throw contentTooLarge(byteLength, maxBytes);
    values.push(chunk);
  }
  return { content: values.join(""), byteLength };
}

function contentTooLarge(actualBytes: number, maxBytes: number): SessionTranscriptServiceError {
  return new SessionTranscriptServiceError(
    "CONTENT_TOO_LARGE",
    "The public transcript exceeds maxBytes.",
    false,
    { actualBytes, maxBytes },
  );
}

function pathChanged(
  relativePath: string,
  effect: "not_applied" | "indeterminate" = "not_applied",
): SessionTranscriptServiceError {
  return new SessionTranscriptServiceError(
    "PATH_OUTSIDE_SESSION_FOLDER",
    "The SessionFolder path identity changed while exporting the transcript.",
    true,
    { relativePath },
    effect,
  );
}

function normalizeFolderResult(value: unknown): SessionTranscriptFolderResult {
  const result = value as SessionTranscriptFolderResult;
  if (
    !result
    || result.destination !== "session_folder"
    || (result.format !== "json" && result.format !== "markdown")
    || typeof result.file?.sessionId !== "string"
    || typeof result.file.relativePath !== "string"
    || typeof result.file.byteLength !== "number"
    || typeof result.file.modifiedAt !== "string"
    || typeof result.file.sha256 !== "string"
  ) {
    throw new Error("Stored transcript export result is invalid.");
  }
  return result;
}

function normalizeStoredError(value: unknown): SessionTranscriptServiceError {
  const error = value as {
    code?: unknown;
    message?: unknown;
    retryable?: unknown;
    details?: unknown;
    effect?: unknown;
  };
  if (typeof error?.code !== "string" || typeof error.message !== "string") {
    throw new Error("Stored transcript export error is invalid.");
  }
  const effect = error.effect === "applied" || error.effect === "indeterminate"
    ? error.effect
    : "not_applied";
  return new SessionTranscriptServiceError(
    error.code,
    error.message,
    error.retryable === true,
    error.details && typeof error.details === "object" && !Array.isArray(error.details)
      ? error.details as Record<string, string | number | boolean>
      : {},
    effect,
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sameIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function pathKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
}
