import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type {
  SessionDirectoryEntry,
  SessionDirectoryRequest,
  SessionFileChunkRequest,
  SessionFileChunkResult,
  SessionImageResourceRequest,
  SessionImageChunkRequest,
  SessionFileDescriptor,
  SessionFileOpenRequest,
  SessionFileAbsoluteResourceRequest,
  SessionFilePreviewResourceRequest,
  SessionFileResourceRequest,
  SessionFileRootResourceRequest,
  SessionFilePreviewTargetResolution,
  SessionFileRoot,
  SessionFileRootKind,
  SessionFilePin,
  SessionFilePinOwner,
  SessionFilePinReference,
  StoredSessionFilePin,
  SessionFileTreePathActionNodeKind,
  SessionFileTreePathActionTargetRequest,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import {
  isSessionFileAbsoluteResource,
  isSessionFileGitCommitResource,
  isSessionFileRootResource,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import {
  detectSessionFileResourceKind,
  detectSessionFileEncoding,
} from "../../src-shared/file-explorer/file-content-detection.js";
import type { OpenPathResult } from "../../src-shared/window/withmate-window-types.js";
import {
  listIdentityBoundDirectory,
  type IdentityBoundDirectorySnapshot,
} from "./identity-bound-directory-listing.js";
import { resolveSessionFilesDirectory } from "./session-files.js";
import { resolveOpenPathTarget } from "./open-path.js";
import type { SessionFilePinStorage } from "../storage/persistent-store-lifecycle-service.js";

const MAX_CHUNK_BYTES = 1024 * 1024;
const INSPECTION_BYTES = 8192;
const MAX_CONCURRENT_DIRECTORY_LISTINGS = 4;
const MAX_PENDING_DIRECTORY_LISTINGS = 32;

function detectLocalImageResource(bytes: Uint8Array): { kind: "image" | "svg"; mimeType: string } {
  const text = new TextDecoder("latin1").decode(bytes);
  const svgEncoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  const svgHeader = new TextDecoder(svgEncoding).decode(bytes).trimStart().replace(/^<\?xml[\s\S]*?\?>\s*/i, "")
    .replace(/^(?:<!--[\s\S]*?-->\s*)+/, "")
    .replace(/^<!DOCTYPE\s+svg\b(?:[^>\[]|\[[\s\S]*?\])*>\s*/i, "")
    .replace(/^(?:<!--[\s\S]*?-->\s*)+/, "");
  if (/^<svg\b/i.test(svgHeader)) {
    return { kind: "svg", mimeType: "image/svg+xml" };
  }
  const signature = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  let mimeType: string | null = null;
  if (signature(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) mimeType = "image/png";
  else if (signature(0xff, 0xd8, 0xff)) mimeType = "image/jpeg";
  else if (/^GIF8[79]a/.test(text)) mimeType = "image/gif";
  else if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") mimeType = "image/webp";
  else if (signature(0x42, 0x4d)) mimeType = "image/bmp";
  else if (signature(0, 0, 1, 0) && bytes.length >= 6 && (bytes[4] !== 0 || bytes[5] !== 0)) mimeType = "image/x-icon";
  else if (text.slice(4, 8) === "ftyp") {
    const boxLength = bytes.length >= 4 ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0) : 0;
    for (let offset = 8; offset + 4 <= Math.min(bytes.length, boxLength); offset += 4) {
      if (offset === 12) continue;
      if (["avif", "avis"].includes(text.slice(offset, offset + 4))) {
        mimeType = "image/avif";
        break;
      }
    }
  }
  if (!mimeType) {
    throw new Error("The local image target is not a supported image.");
  }
  return { kind: "image", mimeType };
}

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
  parentIncarnationId?: string;
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
  getPinStorage?(): SessionFilePinStorage;
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

type ResolvedPathActionCandidate = {
  rootAbsolutePath: string;
  rootKind: SessionFileRootKind;
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
    throw new Error("File root path cannot be empty.");
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
    throw new TypeError("relativePath must be a string.");
  }
  if (!value) {
    if (allowRoot) {
      return "";
    }
    throw new Error("File path cannot be empty.");
  }
  if (path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\")) {
    throw new Error("relativePath must not be absolute.");
  }

  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("relativePath contains an invalid segment.");
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
      throw new Error("The session could not be found.");
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

  private async resolvePinOwner(sessionId: string): Promise<SessionFilePinOwner> {
    const context = await this.deps.getSessionContext(sessionId);
    if (!context?.parentIncarnationId) throw new Error("The File Pin owner session is not available.");
    return { sessionId: context.parentSessionId, incarnationId: context.parentIncarnationId };
  }

  private pinStorage(): SessionFilePinStorage {
    if (!this.deps.getPinStorage) throw new Error("File Pin storage is not available.");
    return this.deps.getPinStorage();
  }

  private async inspectPinTarget(request: SessionFileRootResourceRequest): Promise<"file" | "directory"> {
    const candidate = await this.resolveTargetCandidate(request, false);
    const targetStats = await (this.deps.lstatPath ?? lstat)(candidate.unresolvedTargetPath);
    const kind = targetStats.isFile() ? "file" : targetStats.isDirectory() ? "directory" : null;
    if (!kind) throw new Error("Only regular files and directories can be pinned.");
    const targetRealPath = await realpath(candidate.unresolvedTargetPath);
    if (!isPathInside(candidate.rootRealPath, targetRealPath)) throw new Error("The pinned path is outside the authorized root.");
    const confirmed = await this.resolveTargetCandidate(request, false);
    const confirmedStats = await (this.deps.lstatPath ?? lstat)(confirmed.unresolvedTargetPath);
    const confirmedTargetRealPath = await realpath(confirmed.unresolvedTargetPath);
    if (pathKey(candidate.rootAbsolutePath) !== pathKey(confirmed.rootAbsolutePath)
      || pathKey(candidate.rootRealPath) !== pathKey(confirmed.rootRealPath)
      || pathKey(targetRealPath) !== pathKey(confirmedTargetRealPath)
      || !isPathInside(confirmed.rootRealPath, confirmedTargetRealPath)
      || !isSameFileIdentity(targetStats, confirmedStats)
      || (kind === "file" ? !confirmedStats.isFile() : !confirmedStats.isDirectory())) {
      throw new Error("File root changed during Pin authorization.");
    }
    return kind;
  }

  async pinSessionFile(request: SessionFileRootResourceRequest): Promise<SessionFilePin> {
    validateRootFileResource(request);
    const storage = this.pinStorage();
    const owner = await this.resolvePinOwner(request.sessionId);
    const root = await this.resolveRoot(request.sessionId, request.rootId);
    if (!root) throw new Error("The specified file root is not available in the current session.");
    const relativePath = normalizeRelativePath(request.relativePath, false);
    const kind = await this.inspectPinTarget({ ...request, relativePath });
    const currentRoot = await this.resolveRoot(request.sessionId, request.rootId);
    if (!currentRoot || pathKey(currentRoot.absolutePath) !== pathKey(root.absolutePath)) throw new Error("File root changed during Pin authorization.");
    const pin: StoredSessionFilePin = { rootKind: root.kind, rootPath: pathKey(root.absolutePath), relativePath, kind, rootLabel: root.label };
    await storage.pinSessionFile(owner, pin);
    return { ...pin, rootId: root.id, unavailableReason: null };
  }

  async unpinSessionFile(request: SessionFilePinReference & { sessionId: string }): Promise<void> {
    if (!request || typeof request.sessionId !== "string" || !request.sessionId
      || !["workspace", "session-folder", "additional"].includes(request.rootKind)
      || typeof request.rootPath !== "string" || !path.isAbsolute(request.rootPath)) {
      throw new TypeError("File Pin reference is invalid.");
    }
    const storage = this.pinStorage();
    const owner = await this.resolvePinOwner(request.sessionId);
    await storage.unpinSessionFile(owner, { rootKind: request.rootKind, rootPath: pathKey(request.rootPath), relativePath: normalizeRelativePath(request.relativePath, false) });
  }

  async listSessionFilePins(sessionId: string): Promise<SessionFilePin[]> {
    const storage = this.pinStorage();
    const owner = await this.resolvePinOwner(sessionId);
    const pins = await storage.listSessionFilePins(owner);
    const roots = await this.resolveRoots(sessionId);
    const results = new Array<SessionFilePin>(pins.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, pins.length) }, async () => {
      while (next < pins.length) {
        const index = next++;
        const pin = pins[index]!;
        const root = roots.find((candidate) => candidate.kind === pin.rootKind && pathKey(candidate.absolutePath) === pin.rootPath);
        let unavailableReason: string | null = root ? null : "The pinned root is not authorized in the current session.";
        if (root) {
          try {
            const kind = await this.inspectPinTarget({ sessionId, rootId: root.id, relativePath: pin.relativePath });
            if (kind !== pin.kind) throw new Error("The pinned path has a different file type.");
            const currentRoot = await this.resolveRoot(sessionId, root.id);
            if (!currentRoot || pathKey(currentRoot.absolutePath) !== pin.rootPath) throw new Error("The pinned root changed during authorization.");
          } catch (error) {
            unavailableReason = error instanceof Error ? error.message : "The pinned path could not be inspected.";
          }
        }
        results[index] = { ...pin, rootId: root?.id ?? null, rootLabel: root?.label ?? pin.rootLabel, unavailableReason };
      }
    }));
    return results;
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
    const candidate = await this.resolvePathActionCandidate(request);
    if ((request.nodeKind === "root") !== (request.relativePath === "")) {
      throw new Error("File tree path action node kind does not match its path.");
    }
    await this.confirmPathActionNodeKind(candidate, request.nodeKind);
    const confirmedCandidate = await this.resolvePathActionCandidate(request);
    if (
      pathKey(confirmedCandidate.rootAbsolutePath) !== pathKey(candidate.rootAbsolutePath)
      || pathKey(confirmedCandidate.unresolvedTargetPath) !== pathKey(candidate.unresolvedTargetPath)
    ) {
      throw new Error("File tree root changed during path authorization.");
    }
    await this.confirmPathActionNodeKind(confirmedCandidate, request.nodeKind);
    return confirmedCandidate.unresolvedTargetPath;
  }

  private async resolvePathActionCandidate(
    request: SessionFileTreePathActionTargetRequest,
  ): Promise<ResolvedPathActionCandidate> {
    validateRootFileResource(request);
    const root = await this.resolveRoot(request.sessionId, request.rootId);
    if (!root) {
      throw new Error("The specified file root is not available in the current session.");
    }
    const relativePath = normalizeRelativePath(request.relativePath, request.nodeKind === "root");
    return {
      rootAbsolutePath: root.absolutePath,
      rootKind: root.kind,
      unresolvedTargetPath: relativePath
        ? path.join(root.absolutePath, ...relativePath.split("/"))
        : root.absolutePath,
    };
  }

  private async confirmPathActionNodeKind(
    candidate: ResolvedPathActionCandidate,
    nodeKind: SessionFileTreePathActionNodeKind,
  ): Promise<void> {
    try {
      const targetStats = nodeKind === "root"
        ? await (this.deps.statPath ?? stat)(candidate.unresolvedTargetPath)
        : await (this.deps.lstatPath ?? lstat)(candidate.unresolvedTargetPath);
      const kindMatches = nodeKind === "file" ? targetStats.isFile() : targetStats.isDirectory();
      if (!kindMatches) {
        throw new Error("File tree path action node kind does not match the current target.");
      }
    } catch (error) {
      if (nodeKind === "root" && candidate.rootKind === "session-folder" && isMissingPathError(error)) {
        return;
      }
      throw error;
    }
  }

  async resolvePreviewTarget(
    sessionId: string,
    target: string,
    baseResource?: SessionFilePreviewResourceRequest,
  ): Promise<SessionFilePreviewTargetResolution> {
    const context = await this.deps.getSessionContext(sessionId);
    if (!context) {
      return { type: "failed", targetPath: target, message: "The session could not be found." };
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
        message: error instanceof Error ? error.message : "The link target could not be resolved.",
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
      return { type: "directory", targetPath: targetRealPath };
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
      throw new Error("The specified file root is not available in the current session.");
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
        throw new Error(`The specified path is not a ${expectedKind}.`);
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
        throw new Error("The specified path is not a file.");
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
        throw new Error("The resource path changed during verification. Try again.");
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
      throw new Error("The specified path is outside the file root.");
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
      throw new Error("The resource path changed during authorization. Try again.");
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
          throw new Error("The directory path changed after authorization. Try again.");
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
      throw new Error("The file open service is unavailable.");
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
    return this.inspectOpenedFile(request, opened);
  }

  private async openImage(request: SessionImageResourceRequest): Promise<AuthorizedOpenedFile> {
    const context = await this.deps.getSessionContext(request.sessionId);
    if (!context) {
      throw new Error("The session could not be found.");
    }
    const target = request.target.trim();
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(target)?.[1];
    if (scheme && scheme.toLowerCase() !== "file" && !/^[a-zA-Z]:[\\/]/.test(target)) {
      throw new Error("Local image requests must use a local path or file URL.");
    }
    const absoluteTarget = /^file:/i.test(target) || path.isAbsolute(target)
      || /^[a-zA-Z]:[\\/]/.test(target) || /^\/[a-zA-Z]:[\\/]/.test(target);
    let baseDirectory = context.workspacePath;
    if (request.baseResource) {
      if (request.baseResource.sessionId !== request.sessionId) {
        throw new Error("Image base does not belong to this Session.");
      }
      if (!absoluteTarget) {
        if (isSessionFileGitCommitResource(request.baseResource)) {
          throw new Error("Relative images from a Git commit file preview are not available.");
        }
        const base = await this.openLocalFile(request.baseResource);
        try {
          baseDirectory = path.dirname(base.targetRealPath);
        } finally {
          await base.handle.close();
        }
      }
    }
    const resolved = resolveOpenPathTarget(target, { baseDirectory });
    if (resolved.type !== "local-path") {
      throw new Error("Local image requests must use a local path or file URL.");
    }
    return this.openAbsoluteFile({ sessionId: request.sessionId, absolutePath: resolved.targetPath });
  }

  async inspectImage(request: SessionImageResourceRequest): Promise<SessionFileDescriptor> {
    const opened = await this.openImage(request);
    return this.inspectOpenedFile(
      { sessionId: request.sessionId, absolutePath: opened.targetRealPath }, opened, true,
    );
  }

  private async inspectOpenedFile(
    request: SessionFileResourceRequest,
    opened: AuthorizedOpenedFile,
    imageOnly = false,
  ): Promise<SessionFileDescriptor> {
    try {
      const { handle, stats: fileStats, targetRealPath } = opened;
      const inspection = new Uint8Array(Math.min(INSPECTION_BYTES, fileStats.size));
      const { bytesRead } = await handle.read(inspection, 0, inspection.byteLength, 0);
      const fileStatsAfterInspection = await handle.stat();
      if (makeFileRevision(fileStatsAfterInspection) !== makeFileRevision(fileStats)) {
      throw new Error("The file changed during inspection. Reload and try again.");
      }
      const inspectedBytes = inspection.subarray(0, bytesRead);
      const resource = imageOnly
        ? detectLocalImageResource(inspectedBytes)
        : detectSessionFileResourceKind(targetRealPath, inspectedBytes);
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
    this.validateChunkRequest(request);
    const opened = await this.openLocalFile(request);
    return this.readOpenedFileChunk(request, opened);
  }

  async readImageChunk(request: SessionImageChunkRequest): Promise<SessionFileChunkResult> {
    this.validateChunkRequest(request);
    const opened = await this.openImage(request);
    return this.readOpenedFileChunk(request, opened, true);
  }

  private validateChunkRequest(request: Pick<SessionFileChunkRequest, "offset" | "length">): void {
    if (!Number.isSafeInteger(request.offset) || request.offset < 0) {
      throw new Error("The file chunk offset is invalid.");
    }
    if (!Number.isSafeInteger(request.length) || request.length < 1 || request.length > MAX_CHUNK_BYTES) {
      throw new Error(`File chunk length must be between 1 and ${MAX_CHUNK_BYTES} bytes.`);
    }
  }

  private async readOpenedFileChunk(
    request: Pick<SessionFileChunkRequest, "offset" | "length" | "expectedRevision">,
    opened: AuthorizedOpenedFile,
    imageOnly = false,
  ): Promise<SessionFileChunkResult> {
    try {
      const { handle, stats: fileStats } = opened;
      const revision = makeFileRevision(fileStats);
      if (request.expectedRevision !== revision) {
      throw new Error("The file changed while it was being read. Reload and try again.");
      }
      if (imageOnly) {
        const header = new Uint8Array(Math.min(INSPECTION_BYTES, fileStats.size));
        const inspection = await handle.read(header, 0, header.byteLength, 0);
        detectLocalImageResource(header.subarray(0, inspection.bytesRead));
      }
      const bytes = new Uint8Array(Math.min(request.length, Math.max(0, fileStats.size - request.offset)));
      const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, request.offset);
      const fileStatsAfterRead = await handle.stat();
      const revisionAfterRead = makeFileRevision(fileStatsAfterRead);
      if (revisionAfterRead !== revision) {
      throw new Error("The file changed while it was being read. Reload and try again.");
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
