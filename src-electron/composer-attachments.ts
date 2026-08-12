import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { ComposerAttachment, ComposerAttachmentInput, ComposerAttachmentKind, ComposerPreview, Session } from "../src/app-state.js";
import { extractComposerAttachmentReferenceCandidates } from "../src/path-reference.js";
import { isPathWithinAnyDirectory, normalizeAllowedAdditionalDirectories } from "./additional-directories.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const TRAILING_PATH_PUNCTUATION = /[),.;:!?]+$/;

type ComposerPreviewSessionContext = Pick<Session, "workspacePath" | "allowedAdditionalDirectories">;

type ComposerAttachmentResolutionPolicy = {
  rootRelativeOnly?: boolean;
};

type ManagedRootIdentity = {
  dev: number;
  ino: number;
  canonicalPath: string;
};

function normalizeSlash(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function trimCandidatePath(value: string): string {
  return value.trim().replace(TRAILING_PATH_PUNCTUATION, "");
}

function resolveCandidatePath(workspacePath: string, rawPath: string): string {
  const trimmedPath = trimCandidatePath(rawPath);
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
): Promise<ComposerAttachment> {
  const trimmedCandidatePath = trimCandidatePath(candidate.path);
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
  const absolutePath = resolveCandidatePath(session.workspacePath, candidate.path);
  if (!absolutePath) {
    throw new Error("空のパスは添付できないよ。");
  }

  let resolvedAttachmentPath: string;
  let stats;
  try {
    resolvedAttachmentPath = await realpath(absolutePath);
    stats = await stat(resolvedAttachmentPath);
  } catch {
    throw new Error(`${candidate.source === "text" ? "@" : "添付"} のパスが見つからないよ: ${candidate.path}`);
  }

  const kind =
    candidate.kind ??
    (stats.isDirectory() ? "folder" : inferFileKindFromPath(resolvedAttachmentPath));

  if (kind === "folder" && !stats.isDirectory()) {
    throw new Error(`フォルダとして指定したパスがフォルダじゃないよ: ${candidate.path}`);
  }

  if ((kind === "file" || kind === "image") && !stats.isFile()) {
    throw new Error(`ファイルとして指定したパスがファイルじゃないよ: ${candidate.path}`);
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
    id: `${kind}:${normalizeSlash(resolvedAttachmentPath).toLowerCase()}`,
    kind,
    source: candidate.source,
    absolutePath: resolvedAttachmentPath,
    displayPath,
    workspaceRelativePath,
    isOutsideWorkspace: workspaceRelativePath === null,
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
      return { attachment: await resolveAttachmentCandidate(session, candidate, policy) } as const;
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "添付の解決に失敗したよ。",
      } as const;
    }
  }));

  for (const resolved of resolvedCandidates) {
    if ("error" in resolved) {
      const errorMessage = typeof resolved.error === "string"
        ? resolved.error
        : "添付の解決に失敗したよ。";
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
