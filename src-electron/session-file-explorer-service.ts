import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type {
  SessionDirectoryEntry,
  SessionDirectoryRequest,
  SessionFileChunkRequest,
  SessionFileChunkResult,
  SessionFileDescriptor,
  SessionFileOpenRequest,
  SessionFileAbsoluteResourceRequest,
  SessionFilePreviewResourceRequest,
  SessionFileResourceRequest,
  SessionFileRootResourceRequest,
  SessionFilePreviewTargetResolution,
  SessionFileRoot,
  SessionFileRootKind,
  SessionFileTreePathActionTargetRequest,
} from "../src/file-explorer/file-explorer-contract.js";
import {
  isSessionFileAbsoluteResource,
  isSessionFileGitCommitResource,
  isSessionFileRootResource,
} from "../src/file-explorer/file-explorer-contract.js";
import {
  detectSessionFileResourceKind,
  detectSessionFileEncoding,
} from "../src/file-explorer/file-content-detection.js";
import type { OpenPathResult } from "../src/withmate-window-types.js";
import {
  listIdentityBoundDirectory,
  type IdentityBoundDirectorySnapshot,
} from "./identity-bound-directory-listing.js";
import { resolveSessionFilesDirectory } from "./session-files.js";
import { resolveOpenPathTarget } from "./open-path.js";

const MAX_CHUNK_BYTES = 1024 * 1024;
const INSPECTION_BYTES = 8192;
const MAX_CONCURRENT_DIRECTORY_LISTINGS = 4;
const MAX_PENDING_DIRECTORY_LISTINGS = 32;

type DirectoryListingJob = {
  supersessionKey: string;
  execute(): Promise<IdentityBoundDirectorySnapshot>;
  resolve(snapshot: IdentityBoundDirectorySnapshot): void;
  reject(error: unknown): void;
};

const pendingDirectoryListings: DirectoryListingJob[] = [];
let activeDirectoryListings = 0;

function drainDirectoryListingQueue(): void {
  while (
    activeDirectoryListings < MAX_CONCURRENT_DIRECTORY_LISTINGS &&
    pendingDirectoryListings.length > 0
  ) {
    const job = pendingDirectoryListings.pop()!;
    activeDirectoryListings += 1;
    Promise.resolve()
      .then(() => job.execute())
      .then(job.resolve, job.reject)
      .finally(() => {
        activeDirectoryListings -= 1;
        drainDirectoryListingQueue();
      });
  }
}

function listDirectoryWithAdmission(
  supersessionKey: string,
  execute: () => Promise<IdentityBoundDirectorySnapshot>,
): Promise<IdentityBoundDirectorySnapshot> {
  return new Promise((resolve, reject) => {
    if (pendingDirectoryListings.length >= MAX_PENDING_DIRECTORY_LISTINGS) {
      const supersededIndex = pendingDirectoryListings.findIndex(
        (job) => job.supersessionKey === supersessionKey,
      );
      if (supersededIndex >= 0) {
        pendingDirectoryListings.splice(supersededIndex, 1)[0]?.reject(
          new Error("Directory listing was superseded by a newer request for the same directory."),
        );
      } else {
        reject(new Error("Too many directory listings are already waiting."));
        return;
      }
    }
    pendingDirectoryListings.push({
      supersessionKey,
      execute,
      resolve,
      reject,
    });
    drainDirectoryListingQueue();
  });
}

export type SessionFileExplorerContext = {
  workspacePath: string;
  parentSessionId: string;
  allowedAdditionalDirectories: string[];
};

type ReadableFileHandle = {
  stat(): Promise<Stats>;
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
};

export type SessionFileExplorerServiceDeps = {
  userDataPath: string;
  getSessionContext(sessionId: string): Promise<SessionFileExplorerContext | null>;
  statPath?(targetPath: string): Promise<Stats>;
  lstatPath?(targetPath: string): Promise<Stats>;
  openFile?(targetPath: string, flags: "r"): Promise<ReadableFileHandle>;
  listDirectory?(targetPath: string): Promise<IdentityBoundDirectorySnapshot>;
  openResolvedPath?(targetPath: string, reveal: boolean): Promise<OpenPathResult>;
};

export type AuthorizedSessionFileOperationResult<T> = {
  result: T;
  targetStillCurrent: boolean;
};

export type ResolvedSessionFileRoot = SessionFileRoot & { absolutePath: string };

type ResolvedTargetCandidate = {
  rootAbsolutePath: string;
  rootRealPath: string;
  unresolvedTargetPath: string;
};

type AuthorizedOpenedFile = {
  candidate: ResolvedTargetCandidate;
  handle: ReadableFileHandle;
  stats: Stats;
  targetRealPath: string;
};

type AuthorizedResourceKind = "file" | "directory";

function validateAbsoluteFileResource(
  request: SessionFileAbsoluteResourceRequest,
): string {
  if (
    typeof request.sessionId !== "string"
    || !request.sessionId
    || typeof request.absolutePath !== "string"
    || !request.absolutePath
    || !path.isAbsolute(request.absolutePath)
    || "rootId" in request
    || "relativePath" in request
  ) {
    throw new TypeError("Absolute file preview resource is invalid.");
  }
  return path.resolve(request.absolutePath);
}

function validateRootFileResource(
  request: SessionFileRootResourceRequest,
): void {
  if (
    typeof request.sessionId !== "string"
    || !request.sessionId
    || typeof request.rootId !== "string"
    || !request.rootId
    || typeof request.relativePath !== "string"
    || "absolutePath" in request
  ) {
    throw new TypeError("Root-scoped file resource is invalid.");
  }
}

function pathKey(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function makeAdditionalRootId(absolutePath: string): string {
  return `additional:${createHash("sha256").update(pathKey(absolutePath)).digest("hex").slice(0, 16)}`;
}

function makeRoot(kind: SessionFileRootKind, absolutePath: string, id: string, label: string): ResolvedSessionFileRoot {
  if (typeof absolutePath !== "string" || !absolutePath.trim()) {
    throw new Error("file root path が空だよ。");
  }
  return {
    id,
    kind,
    label,
    displayPath: absolutePath,
    absolutePath: path.resolve(absolutePath),
  };
}

function normalizeRelativePath(value: string, allowRoot: boolean): string {
  if (typeof value !== "string") {
    throw new TypeError("relativePath は文字列で指定してね。");
  }
  if (!value) {
    if (allowRoot) {
      return "";
    }
    throw new Error("ファイル path が空だよ。");
  }
  if (path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\")) {
    throw new Error("relativePath に絶対 path は指定できないよ。");
  }

  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("relativePath に不正な segment があるよ。");
  }
  return segments.join("/");
}

function isPathInside(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isSameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isMissingPathError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
  return code === "ENOENT" || code === "ENOTDIR";
}

function makeFileRevision(stats: Stats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

export class SessionFileExplorerService {
  constructor(private readonly deps: SessionFileExplorerServiceDeps) {}

  private async resolveRoots(sessionId: string): Promise<ResolvedSessionFileRoot[]> {
    const context = await this.deps.getSessionContext(sessionId);
    if (!context) {
      throw new Error("Session が見つからないよ。");
    }

    const workspace = makeRoot("workspace", context.workspacePath, "workspace", "Workspace");
    const sessionFolderPath = resolveSessionFilesDirectory(this.deps.userDataPath, context.parentSessionId);
    const sessionFolder = makeRoot("session-folder", sessionFolderPath, "session-folder", "Session Folder");
    const seen = new Set([pathKey(workspace.absolutePath), pathKey(sessionFolder.absolutePath)]);
    const additionalRoots: ResolvedSessionFileRoot[] = [];
    for (const directoryPath of context.allowedAdditionalDirectories) {
      const absolutePath = path.resolve(directoryPath);
      const key = pathKey(absolutePath);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      additionalRoots.push(makeRoot("additional", absolutePath, makeAdditionalRootId(absolutePath), path.basename(absolutePath)));
    }
    return [workspace, sessionFolder, ...additionalRoots];
  }

  async listRoots(sessionId: string): Promise<SessionFileRoot[]> {
    return (await this.resolveRoots(sessionId)).map(({ absolutePath: _absolutePath, ...root }) => root);
  }

  async resolveRoot(sessionId: string, rootId: string): Promise<ResolvedSessionFileRoot | null> {
    return (await this.resolveRoots(sessionId)).find((candidate) => candidate.id === rootId) ?? null;
  }

  async resolveHistoryRoots(sessionId: string): Promise<ResolvedSessionFileRoot[]> {
    return (await this.resolveRoots(sessionId)).filter((root) => root.kind !== "session-folder");
  }

  async resolveHistoryRoot(sessionId: string, rootId: string): Promise<ResolvedSessionFileRoot | null> {
    return (await this.resolveHistoryRoots(sessionId)).find((candidate) => candidate.id === rootId) ?? null;
  }

  async resolvePathActionTarget(request: SessionFileTreePathActionTargetRequest): Promise<string> {
    if (!(["root", "directory", "file"] as const).includes(request.nodeKind)) {
      throw new TypeError("File tree path action node kind is invalid.");
    }
    const candidate = await this.resolveTargetCandidate(
      {
        sessionId: request.sessionId,
        rootId: request.rootId,
        relativePath: request.relativePath,
      },
      request.nodeKind === "root",
    );
    if ((request.nodeKind === "root") !== (request.relativePath === "")) {
      throw new Error("File tree path action node kind does not match its path.");
    }
    const targetStats = request.nodeKind === "root"
      ? await (this.deps.statPath ?? stat)(candidate.unresolvedTargetPath)
      : await (this.deps.lstatPath ?? lstat)(candidate.unresolvedTargetPath);
    const kindMatches = request.nodeKind === "file"
      ? targetStats.isFile()
      : targetStats.isDirectory();
    if (!kindMatches) {
      throw new Error("File tree path action node kind does not match the current target.");
    }
    const confirmedCandidate = await this.resolveTargetCandidate(
      {
        sessionId: request.sessionId,
        rootId: request.rootId,
        relativePath: request.relativePath,
      },
      request.nodeKind === "root",
    );
    if (
      pathKey(confirmedCandidate.rootAbsolutePath) !== pathKey(candidate.rootAbsolutePath)
      || pathKey(confirmedCandidate.unresolvedTargetPath) !== pathKey(candidate.unresolvedTargetPath)
    ) {
      throw new Error("File tree root changed during path authorization.");
    }
    const confirmedStats = request.nodeKind === "root"
      ? await (this.deps.statPath ?? stat)(confirmedCandidate.unresolvedTargetPath)
      : await (this.deps.lstatPath ?? lstat)(confirmedCandidate.unresolvedTargetPath);
    const confirmedKindMatches = request.nodeKind === "file"
      ? confirmedStats.isFile()
      : confirmedStats.isDirectory();
    if (!confirmedKindMatches) {
      throw new Error("File tree target changed during path authorization.");
    }
    return confirmedCandidate.unresolvedTargetPath;
  }

  async resolvePreviewTarget(
    sessionId: string,
    target: string,
    baseResource?: SessionFilePreviewResourceRequest,
  ): Promise<SessionFilePreviewTargetResolution> {
    const context = await this.deps.getSessionContext(sessionId);
    if (!context) {
      return { type: "failed", targetPath: target, message: "Session が見つからないよ。" };
    }

    try {
      const externalTarget = resolveOpenPathTarget(target, { baseDirectory: context.workspacePath });
      if (externalTarget.type === "external-url") {
        return externalTarget;
      }
    } catch {
      // Local target failures are reported after applying the appropriate preview base.
    }

    if (baseResource && isSessionFileGitCommitResource(baseResource)) {
      return {
        type: "not-previewable",
        targetPath: target,
        message: "Relative links from a Git commit file preview are not available.",
      };
    }

    let baseDirectory = context.workspacePath;
    if (baseResource) {
      if (baseResource.sessionId !== sessionId) {
        return { type: "failed", targetPath: target, message: "Preview link base does not belong to this Session." };
      }
      try {
        if (isSessionFileAbsoluteResource(baseResource)) {
          baseDirectory = path.dirname(validateAbsoluteFileResource(baseResource));
        } else {
          validateRootFileResource(baseResource);
          const candidate = await this.resolveTargetCandidate(baseResource, false);
          baseDirectory = path.dirname(await realpath(candidate.unresolvedTargetPath));
        }
      } catch (error) {
        return {
          type: "failed",
          targetPath: target,
          message: error instanceof Error ? error.message : "Preview link base could not be resolved.",
        };
      }
    }

    let resolvedTarget: ReturnType<typeof resolveOpenPathTarget>;
    try {
      resolvedTarget = resolveOpenPathTarget(target, { baseDirectory });
    } catch (error) {
      return {
        type: "failed",
        targetPath: target,
        message: error instanceof Error ? error.message : "リンク先を解決できなかったよ。",
      };
    }
    if (resolvedTarget.type === "external-url") {
      return resolvedTarget;
    }

    const roots = await this.resolveRoots(sessionId);
    const resolvedRoots: Array<{ root: ResolvedSessionFileRoot; realPath: string }> = [];
    for (const root of roots) {
      try {
        resolvedRoots.push({ root, realPath: await realpath(root.absolutePath) });
      } catch {
        // A currently unavailable root cannot provide a root-scoped resource.
      }
    }

    let targetPath = resolvedTarget.targetPath;
    const fallbackPath = /^(.*):[1-9]\d*:[1-9]\d*$/.exec(targetPath)?.[1]
      ?? /^(.*):[1-9]\d*$/.exec(targetPath)?.[1]
      ?? "";
    const lexicalCandidates = fallbackPath ? [targetPath, fallbackPath] : [targetPath];
    const priority: Record<SessionFileRootKind, number> = {
      workspace: 0,
      "session-folder": 1,
      additional: 2,
    };
    const lstatPath = this.deps.lstatPath ?? lstat;
    let targetStats: Stats | null = null;
    let targetRealPath = "";
    let selectedTargetPath = "";
    for (const candidatePath of lexicalCandidates) {
      const absoluteCandidate = path.resolve(candidatePath);
      try {
        await lstatPath(absoluteCandidate);
        targetRealPath = await realpath(absoluteCandidate);
        targetStats = await (this.deps.statPath ?? stat)(targetRealPath);
        selectedTargetPath = absoluteCandidate;
        break;
      } catch (error) {
        if (!isMissingPathError(error)) {
          return {
            type: "failed",
            targetPath: absoluteCandidate,
            message: error instanceof Error ? error.message : "The local path could not be inspected.",
          };
        }
      }
    }
    if (!targetStats || !selectedTargetPath) {
      return { type: "not-found", targetPath, message: "The local path was not found." };
    }
    targetPath = selectedTargetPath;

    if (targetStats.isDirectory()) {
      const directoryRoot = resolvedRoots.find(({ realPath: rootRealPath }) => (
        isPathInside(rootRealPath, targetRealPath)
      ));
      return directoryRoot
        ? { type: "directory", targetPath: targetRealPath }
        : {
            type: "not-previewable",
            targetPath,
            message: "The directory is outside the current Session file roots.",
          };
    }
    if (!targetStats.isFile()) {
      return { type: "not-previewable", targetPath, message: "The local path is not a file or directory." };
    }

    try {
      const matchingRoots = resolvedRoots.filter(({ realPath: rootRealPath }) => (
        isPathInside(rootRealPath, targetRealPath)
      ));
      matchingRoots.sort((left, right) => (
        right.realPath.length - left.realPath.length
        || priority[left.root.kind] - priority[right.root.kind]
      ));
      const match = matchingRoots[0];
      if (!match) {
        return {
          type: "file",
          resource: { sessionId, absolutePath: targetRealPath },
        };
      }
      const relativePath = path.relative(match.realPath, targetRealPath).split(path.sep).join("/");
      return {
        type: "file",
        resource: { sessionId, rootId: match.root.id, relativePath },
      };
    } catch (error) {
      return {
        type: "failed",
        targetPath,
        message: error instanceof Error ? error.message : "The file could not be resolved.",
      };
    }
  }

  private async resolveTargetCandidate(
    request: SessionFileRootResourceRequest,
    allowRoot: boolean,
  ): Promise<ResolvedTargetCandidate> {
    validateRootFileResource(request);
    const root = await this.resolveRoot(request.sessionId, request.rootId);
    if (!root) {
      throw new Error("指定された file root は現在の Session で利用できないよ。");
    }
    const relativePath = normalizeRelativePath(request.relativePath, allowRoot);
    if (allowRoot && !relativePath && root.kind === "session-folder") {
      await mkdir(root.absolutePath, { recursive: true });
    }
    const rootRealPath = await realpath(root.absolutePath);
    const unresolvedTarget = relativePath
      ? path.join(root.absolutePath, ...relativePath.split("/"))
      : root.absolutePath;
    return {
      rootAbsolutePath: root.absolutePath,
      rootRealPath,
      unresolvedTargetPath: unresolvedTarget,
    };
  }

  private async openAuthorizedTarget(
    request: SessionFileRootResourceRequest,
    allowRoot: boolean,
    expectedKind: AuthorizedResourceKind,
  ): Promise<AuthorizedOpenedFile> {
    const candidate = await this.resolveTargetCandidate(request, allowRoot);
    return this.openAuthorizedCandidate(candidate, expectedKind);
  }

  private async openAuthorizedCandidate(
    candidate: ResolvedTargetCandidate,
    expectedKind: AuthorizedResourceKind,
  ): Promise<AuthorizedOpenedFile> {
    const handle = await (this.deps.openFile ?? open)(candidate.unresolvedTargetPath, "r");
    try {
      const openedStats = await handle.stat();
      if (expectedKind === "file" ? !openedStats.isFile() : !openedStats.isDirectory()) {
        throw new Error(`指定 path は ${expectedKind} ではないよ。`);
      }
      const targetRealPath = await this.confirmOpenedTarget(candidate, openedStats);
      return { candidate, handle, stats: openedStats, targetRealPath };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private openAuthorizedFile(request: SessionFileRootResourceRequest): Promise<AuthorizedOpenedFile> {
    return this.openAuthorizedTarget(request, false, "file");
  }

  private async openAbsoluteFile(
    request: SessionFileAbsoluteResourceRequest,
  ): Promise<AuthorizedOpenedFile> {
    const absolutePath = validateAbsoluteFileResource(request);
    const handle = await (this.deps.openFile ?? open)(absolutePath, "r");
    try {
      const openedStats = await handle.stat();
      if (!openedStats.isFile()) {
        throw new Error("指定 path は file ではないよ。");
      }
      const targetRealPath = await realpath(absolutePath);
      const statPath = this.deps.statPath ?? stat;
      const targetStats = await statPath(targetRealPath);
      const confirmedTargetRealPath = await realpath(absolutePath);
      const confirmedTargetStats = await statPath(confirmedTargetRealPath);
      if (
        pathKey(confirmedTargetRealPath) !== pathKey(targetRealPath)
        || !isSameFileIdentity(openedStats, targetStats)
        || !isSameFileIdentity(openedStats, confirmedTargetStats)
      ) {
        throw new Error("resource path が確認中に変更されたよ。再実行してね。");
      }
      return {
        candidate: {
          rootAbsolutePath: path.dirname(targetRealPath),
          rootRealPath: path.dirname(targetRealPath),
          unresolvedTargetPath: absolutePath,
        },
        handle,
        stats: openedStats,
        targetRealPath,
      };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private openLocalFile(request: SessionFileResourceRequest): Promise<AuthorizedOpenedFile> {
    if (isSessionFileAbsoluteResource(request)) {
      return this.openAbsoluteFile(request);
    }
    if (isSessionFileRootResource(request)) {
      return this.openAuthorizedFile(request);
    }
    throw new TypeError("File resource is invalid.");
  }

  private async confirmOpenedTarget(candidate: ResolvedTargetCandidate, openedStats: Stats): Promise<string> {
    const targetRealPath = await realpath(candidate.unresolvedTargetPath);
    if (!isPathInside(candidate.rootRealPath, targetRealPath)) {
      throw new Error("指定 path は file root の外側を参照しているよ。");
    }
    const statPath = this.deps.statPath ?? stat;
    const targetStats = await statPath(targetRealPath);
    const confirmedRootRealPath = await realpath(candidate.rootAbsolutePath);
    const confirmedTargetRealPath = await realpath(candidate.unresolvedTargetPath);
    const confirmedTargetStats = await statPath(confirmedTargetRealPath);
    if (
      pathKey(confirmedRootRealPath) !== pathKey(candidate.rootRealPath) ||
      pathKey(confirmedTargetRealPath) !== pathKey(targetRealPath) ||
      !isPathInside(confirmedRootRealPath, confirmedTargetRealPath) ||
      !isSameFileIdentity(openedStats, targetStats) ||
      !isSameFileIdentity(openedStats, confirmedTargetStats)
    ) {
      throw new Error("resource path が認可中に変更されたよ。再実行してね。");
    }
    return targetRealPath;
  }

  async listDirectory(request: SessionDirectoryRequest): Promise<SessionDirectoryEntry[]> {
    const supersessionKey = JSON.stringify([request.sessionId, request.rootId, request.relativePath]);
    const snapshot = await listDirectoryWithAdmission(supersessionKey, async () => {
      const opened = await this.openAuthorizedTarget(request, true, "directory");
      try {
        const result = await (this.deps.listDirectory ?? listIdentityBoundDirectory)(opened.targetRealPath);
        if (result.device !== opened.stats.dev || result.inode !== opened.stats.ino) {
          throw new Error("directory path が認可後に変更されたよ。再実行してね。");
        }
        return result;
      } finally {
        await opened.handle.close();
      }
    });
    const results = snapshot.entries.map((entry): SessionDirectoryEntry => {
      const relativePath = request.relativePath ? `${request.relativePath}/${entry.name}` : entry.name;
      return { ...entry, relativePath };
    });
    return results.sort((left, right) => {
      const leftDirectory = left.kind === "directory" ? 0 : 1;
      const rightDirectory = right.kind === "directory" ? 0 : 1;
      return leftDirectory - rightDirectory || left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });
  }

  async openFile(request: SessionFileOpenRequest): Promise<OpenPathResult> {
    if (!this.deps.openResolvedPath) {
      throw new Error("file open service を利用できないよ。");
    }
    const opened = await this.openLocalFile(request);
    try {
      // Electron can hand the OS only a path here; preserving edits to the original file
      // intentionally accepts the path re-resolution boundary documented in ADR 013.
      return await this.deps.openResolvedPath(opened.targetRealPath, request.reveal === true);
    } finally {
      await opened.handle.close();
    }
  }

  async withAuthorizedFilePath<T>(
    request: SessionFileResourceRequest,
    operation: (targetRealPath: string) => Promise<T>,
  ): Promise<AuthorizedSessionFileOperationResult<T>> {
    const opened = await this.openLocalFile(request);
    try {
      const result = await operation(opened.targetRealPath);
      let targetStillCurrent = false;
      try {
        const confirmedTargetRealPath = await this.confirmOpenedTarget(opened.candidate, opened.stats);
        targetStillCurrent = pathKey(confirmedTargetRealPath) === pathKey(opened.targetRealPath);
      } catch {
        targetStillCurrent = false;
      }
      return { result, targetStillCurrent };
    } finally {
      await opened.handle.close();
    }
  }

  async withAuthorizedTreeFilePath<T>(
    request: SessionFileRootResourceRequest,
    operation: (targetRealPath: string) => Promise<T>,
  ): Promise<AuthorizedSessionFileOperationResult<T>> {
    const candidate = await this.resolveTargetCandidate(request, false);
    const lstatPath = this.deps.lstatPath ?? lstat;
    const lexicalStats = await lstatPath(candidate.unresolvedTargetPath);
    if (!lexicalStats.isFile()) {
      throw new Error("File tree target is not a regular file.");
    }
    const opened = await this.openAuthorizedCandidate(candidate, "file");
    try {
      const confirmedLexicalStats = await lstatPath(candidate.unresolvedTargetPath);
      if (!confirmedLexicalStats.isFile() || !isSameFileIdentity(opened.stats, confirmedLexicalStats)) {
        throw new Error("File tree target changed during authorization.");
      }
      const result = await operation(opened.targetRealPath);
      let targetStillCurrent = false;
      try {
        const finalLexicalStats = await lstatPath(candidate.unresolvedTargetPath);
        const confirmedTargetRealPath = await this.confirmOpenedTarget(candidate, opened.stats);
        targetStillCurrent = finalLexicalStats.isFile()
          && isSameFileIdentity(opened.stats, finalLexicalStats)
          && pathKey(confirmedTargetRealPath) === pathKey(opened.targetRealPath);
      } catch {
        targetStillCurrent = false;
      }
      return { result, targetStillCurrent };
    } finally {
      await opened.handle.close();
    }
  }

  async inspectFile(request: SessionFileResourceRequest): Promise<SessionFileDescriptor> {
    const opened = await this.openLocalFile(request);
    try {
      const { handle, stats: fileStats, targetRealPath } = opened;
      const inspection = new Uint8Array(Math.min(INSPECTION_BYTES, fileStats.size));
      const { bytesRead } = await handle.read(inspection, 0, inspection.byteLength, 0);
      const fileStatsAfterInspection = await handle.stat();
      if (makeFileRevision(fileStatsAfterInspection) !== makeFileRevision(fileStats)) {
        throw new Error("inspection 中に file が変更されたよ。再読み込みしてね。");
      }
      const inspectedBytes = inspection.subarray(0, bytesRead);
      const resource = detectSessionFileResourceKind(targetRealPath, inspectedBytes);
      return {
        ...request,
        name: path.basename(targetRealPath),
        kind: resource.kind,
        byteLength: fileStats.size,
        modifiedAt: fileStats.mtime.toISOString(),
        mimeType: resource.mimeType,
        suggestedEncoding: detectSessionFileEncoding(inspectedBytes),
        revision: makeFileRevision(fileStats),
      };
    } finally {
      await opened.handle.close();
    }
  }

  async readFileChunk(request: SessionFileChunkRequest): Promise<SessionFileChunkResult> {
    if (!Number.isSafeInteger(request.offset) || request.offset < 0) {
      throw new Error("file chunk offset が不正だよ。");
    }
    if (!Number.isSafeInteger(request.length) || request.length < 1 || request.length > MAX_CHUNK_BYTES) {
      throw new Error(`file chunk length は 1 から ${MAX_CHUNK_BYTES} bytes で指定してね。`);
    }
    const opened = await this.openLocalFile(request);
    try {
      const { handle, stats: fileStats } = opened;
      const revision = makeFileRevision(fileStats);
      if (request.expectedRevision !== revision) {
        throw new Error("読み込み中に file が変更されたよ。再読み込みしてね。");
      }
      const bytes = new Uint8Array(Math.min(request.length, Math.max(0, fileStats.size - request.offset)));
      const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, request.offset);
      const fileStatsAfterRead = await handle.stat();
      const revisionAfterRead = makeFileRevision(fileStatsAfterRead);
      if (revisionAfterRead !== revision) {
        throw new Error("読み込み中に file が変更されたよ。再読み込みしてね。");
      }
      const data = bytes.slice(0, bytesRead).buffer;
      const nextOffset = request.offset + bytesRead;
      return {
        data,
        offset: request.offset,
        nextOffset,
        totalBytes: fileStats.size,
        done: nextOffset >= fileStats.size,
        revision,
      };
    } finally {
      await opened.handle.close();
    }
  }
}
