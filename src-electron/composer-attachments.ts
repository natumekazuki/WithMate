import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type {
  ComposerAttachment,
  ComposerAttachmentInput,
  ComposerAttachmentKind,
  ComposerPreview,
  Session,
  SessionTurnAttachmentIdentity,
  SessionTurnAttachmentReference,
} from "../src/app-state.js";
import { SESSION_RUNTIME_MAX_TURN_ATTACHMENTS } from "../src/session-external-runtime-contract.js";
import { extractComposerAttachmentReferenceCandidates } from "../src/path-reference.js";
import { isPathWithinAnyDirectory, normalizeAllowedAdditionalDirectories } from "./additional-directories.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const TRAILING_PATH_PUNCTUATION = /[),.;:!?]+$/;

type ComposerPreviewSessionContext = Pick<Session, "workspacePath" | "allowedAdditionalDirectories">;

type ComposerAttachmentResolutionPolicy = {
  rootRelativeOnly?: boolean;
  exactPath?: boolean;
};

type ManagedRootIdentity = {
  dev: number;
  ino: number;
  canonicalPath: string;
};

type ResolvedAttachmentCandidate = {
  attachment: ComposerAttachment;
  identity: SessionTurnAttachmentIdentity | null;
};

function normalizeSlash(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function trimCandidatePath(value: string): string {
  return value.trim().replace(TRAILING_PATH_PUNCTUATION, "");
}

function resolveCandidatePath(workspacePath: string, rawPath: string, exactPath = false): string {
  const trimmedPath = exactPath ? rawPath : trimCandidatePath(rawPath);
  if (!trimmedPath) {
    return "";
  }

  return path.isAbsolute(trimmedPath) ? path.normalize(trimmedPath) : path.resolve(workspacePath, trimmedPath);
}

function toWorkspaceRelativePath(workspacePath: string, absolutePath: string): string | null {
  const relativePath = path.relative(workspacePath, absolutePath);
  if (relativePath === "") {
    return ".";
  }

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }

  return normalizeSlash(relativePath);
}

function inferFileKindFromPath(filePath: string): ComposerAttachmentKind {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ? "image" : "file";
}

async function inspectManagedAttachmentRoot(rootPath: string): Promise<ManagedRootIdentity> {
  let rootStatsBefore;
  try {
    rootStatsBefore = await lstat(rootPath);
  } catch {
    throw new Error("SessionFolderが見つからないよ。");
  }
  if (!rootStatsBefore.isDirectory() || rootStatsBefore.isSymbolicLink()) {
    throw new Error("SessionFolderが実体ディレクトリではないため添付できないよ。");
  }
  const canonicalPath = await realpath(rootPath);
  const rootStatsAfter = await lstat(rootPath);
  if (
    !rootStatsAfter.isDirectory()
    || rootStatsAfter.isSymbolicLink()
    || rootStatsBefore.dev !== rootStatsAfter.dev
    || rootStatsBefore.ino !== rootStatsAfter.ino
  ) {
    throw new Error("SessionFolderが添付の解決中に変更されたため添付できないよ。");
  }
  return {
    dev: rootStatsAfter.dev,
    ino: rootStatsAfter.ino,
    canonicalPath,
  };
}

function toDisplayPath(workspacePath: string, absolutePath: string): string {
  return toWorkspaceRelativePath(workspacePath, absolutePath) ?? normalizeSlash(absolutePath);
}

async function resolveAttachmentCandidate(
  session: ComposerPreviewSessionContext,
  candidate: ComposerAttachmentInput,
  policy: ComposerAttachmentResolutionPolicy,
): Promise<ResolvedAttachmentCandidate> {
  const trimmedCandidatePath = policy.exactPath ? candidate.path : trimCandidatePath(candidate.path);
  if (policy.rootRelativeOnly) {
    if (path.isAbsolute(trimmedCandidatePath)) {
      throw new Error(`SessionFolder attachment must use a relative path: ${candidate.path}`);
    }
    if (trimmedCandidatePath.split(/[\\/]+/).includes("..")) {
      throw new Error(`SessionFolder 外のパスは添付できないよ: ${candidate.path}`);
    }
  }
  const managedRootIdentity = policy.rootRelativeOnly
    ? await inspectManagedAttachmentRoot(session.workspacePath)
    : null;
  const absolutePath = resolveCandidatePath(session.workspacePath, candidate.path, policy.exactPath);
  if (!absolutePath) {
    throw new Error("Attachment path is empty.");
  }

  let resolvedAttachmentPath: string;
  let stats;
  try {
    resolvedAttachmentPath = await realpath(absolutePath);
    stats = await stat(resolvedAttachmentPath);
  } catch {
    throw new Error(`Path not found: ${candidate.path}`);
  }

  const kind =
    candidate.kind ??
    (stats.isDirectory() ? "folder" : inferFileKindFromPath(resolvedAttachmentPath));

  if (kind === "folder" && !stats.isDirectory()) {
    throw new Error(`Expected a directory: ${candidate.path}`);
  }

  if ((kind === "file" || kind === "image") && !stats.isFile()) {
    throw new Error(`Expected a file: ${candidate.path}`);
  }

  if (policy.rootRelativeOnly) {
    const verifiedRootIdentity = await inspectManagedAttachmentRoot(session.workspacePath);
    if (
      managedRootIdentity === null
      || managedRootIdentity.dev !== verifiedRootIdentity.dev
      || managedRootIdentity.ino !== verifiedRootIdentity.ino
      || managedRootIdentity.canonicalPath !== verifiedRootIdentity.canonicalPath
    ) {
      throw new Error("SessionFolderが添付の解決中に変更されたため添付できないよ。");
    }
    if (toWorkspaceRelativePath(managedRootIdentity.canonicalPath, resolvedAttachmentPath) === null) {
      throw new Error(`SessionFolder 外のパスは添付できないよ: ${candidate.path}`);
    }
  }

  const canonicalWorkspacePath = managedRootIdentity?.canonicalPath ?? await realpath(session.workspacePath);
  const workspaceRelativePath = toWorkspaceRelativePath(canonicalWorkspacePath, resolvedAttachmentPath);
  const allowedAdditionalDirectories = await Promise.all(normalizeAllowedAdditionalDirectories(
    session.workspacePath,
    session.allowedAdditionalDirectories,
  ).map(async (directoryPath) => {
    try {
      return await realpath(directoryPath);
    } catch {
      return directoryPath;
    }
  }));
  if (workspaceRelativePath === null && !isPathWithinAnyDirectory(resolvedAttachmentPath, allowedAdditionalDirectories)) {
    throw new Error(`ワークスペース外のパスは追加ディレクトリで許可してから添付してね: ${candidate.path}`);
  }
  const displayPath = toDisplayPath(canonicalWorkspacePath, resolvedAttachmentPath);

  return {
    attachment: {
      id: `${kind}:${normalizeSlash(resolvedAttachmentPath).toLowerCase()}`,
      kind,
      source: candidate.source,
      absolutePath: resolvedAttachmentPath,
      displayPath,
      workspaceRelativePath,
      isOutsideWorkspace: workspaceRelativePath === null,
    },
    identity: managedRootIdentity && workspaceRelativePath !== null
      ? {
        rootDevice: managedRootIdentity.dev,
        rootInode: managedRootIdentity.ino,
        device: stats.dev,
        inode: stats.ino,
        canonicalRelativePath: workspaceRelativePath,
      }
      : null,
  };
}

export async function resolveComposerPreview(
  session: ComposerPreviewSessionContext,
  userMessage: string,
  policy: ComposerAttachmentResolutionPolicy = {},
): Promise<ComposerPreview> {
  const candidates = extractComposerAttachmentReferenceCandidates(userMessage);
  const attachments: ComposerAttachment[] = [];
  const errors: string[] = [];
  const seenIds = new Set<string>();

  const resolvedCandidates = await Promise.all(candidates.map(async (candidate) => {
    try {
      return await resolveAttachmentCandidate(session, candidate, policy);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Failed to resolve attachment.",
      } as const;
    }
  }));

  for (const resolved of resolvedCandidates) {
    if ("error" in resolved) {
      const errorMessage = typeof resolved.error === "string"
        ? resolved.error
        : "Failed to resolve attachment.";
      errors.push(errorMessage);
      continue;
    }

    if (seenIds.has(resolved.attachment.id)) {
      continue;
    }

    seenIds.add(resolved.attachment.id);
    attachments.push(resolved.attachment);
  }

  return {
    attachments,
    errors,
  };
}

export async function resolveSessionFolderAttachments(
  session: ComposerPreviewSessionContext,
  references: SessionTurnAttachmentReference[],
): Promise<ComposerPreview> {
  if (references.length > SESSION_RUNTIME_MAX_TURN_ATTACHMENTS) {
    return {
      attachments: [],
      errors: [`添付は最大${SESSION_RUNTIME_MAX_TURN_ATTACHMENTS}件までだよ。`],
    };
  }

  const attachments: ComposerAttachment[] = [];
  const errors: string[] = [];
  for (const reference of references) {
    try {
      const resolved = await resolveAttachmentCandidate(
        session,
        { path: reference.relativePath, source: "text", kind: reference.kind },
        { rootRelativeOnly: true, exactPath: true },
      );
      if (!resolved.identity) {
        throw new Error(`SessionFolder attachment identity could not be verified: ${reference.relativePath}`);
      }
      if (reference.identity && !sameAttachmentIdentity(reference.identity, resolved.identity)) {
        throw new Error(`SessionFolder attachment changed before dispatch: ${reference.relativePath}`);
      }
      reference.identity = resolved.identity;
      attachments.push(resolved.attachment);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "添付の解決に失敗したよ。");
    }
  }
  return { attachments, errors };
}

function sameAttachmentIdentity(
  expected: SessionTurnAttachmentIdentity,
  actual: SessionTurnAttachmentIdentity,
): boolean {
  return expected.rootDevice === actual.rootDevice
    && expected.rootInode === actual.rootInode
    && expected.device === actual.device
    && expected.inode === actual.inode
    && expected.canonicalRelativePath === actual.canonicalRelativePath;
}
