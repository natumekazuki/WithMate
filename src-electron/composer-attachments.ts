import { stat } from "node:fs/promises";
import path from "node:path";

import type { ComposerAttachment, ComposerAttachmentInput, ComposerAttachmentKind, ComposerPreview, Session } from "../src/app-state.js";
import { isPathWithinAnyDirectory, normalizeAllowedAdditionalDirectories } from "./additional-directories.js";

const TEXT_PATH_REFERENCE_PATTERN = /(^|[\s(])@(?:"([^"\r\n]+)"|([^\s@]+))/gm;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const TRAILING_PATH_PUNCTUATION = /[),.;:!?]+$/;

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
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }

  return normalizeSlash(relativePath);
}

function inferFileKindFromPath(filePath: string): ComposerAttachmentKind {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ? "image" : "file";
}

function toDisplayPath(workspacePath: string, absolutePath: string): string {
  return toWorkspaceRelativePath(workspacePath, absolutePath) ?? normalizeSlash(absolutePath);
}

export function extractTextReferenceCandidates(userMessage: string): string[] {
  const candidates: string[] = [];
  const expression = new RegExp(TEXT_PATH_REFERENCE_PATTERN);

  for (const match of userMessage.matchAll(expression)) {
    const quotedPath = match[2];
    const plainPath = match[3];
    const candidatePath = quotedPath ?? plainPath ?? "";
    if (candidatePath.trim()) {
      candidates.push(candidatePath.trim());
    }
  }

  return candidates;
}

async function resolveAttachmentCandidate(
  session: Session,
  candidate: ComposerAttachmentInput,
): Promise<ComposerAttachment> {
  const absolutePath = resolveCandidatePath(session.workspacePath, candidate.path);
  if (!absolutePath) {
    throw new Error("空のパスは添付できないよ。");
  }

  let stats;
  try {
    stats = await stat(absolutePath);
  } catch {
    throw new Error(`${candidate.source === "text" ? "@" : "添付"} のパスが見つからないよ: ${candidate.path}`);
  }

  const kind =
    candidate.kind ??
    (stats.isDirectory() ? "folder" : inferFileKindFromPath(absolutePath));

  if (kind === "folder" && !stats.isDirectory()) {
    throw new Error(`フォルダとして指定したパスがフォルダじゃないよ: ${candidate.path}`);
  }

  if ((kind === "file" || kind === "image") && !stats.isFile()) {
    throw new Error(`ファイルとして指定したパスがファイルじゃないよ: ${candidate.path}`);
  }

  const workspaceRelativePath = toWorkspaceRelativePath(session.workspacePath, absolutePath);
  const allowedAdditionalDirectories = normalizeAllowedAdditionalDirectories(
    session.workspacePath,
    session.allowedAdditionalDirectories,
  );
  if (workspaceRelativePath === null && !isPathWithinAnyDirectory(absolutePath, allowedAdditionalDirectories)) {
    throw new Error(`ワークスペース外のパスは追加ディレクトリで許可してから添付してね: ${candidate.path}`);
  }
  const displayPath = toDisplayPath(session.workspacePath, absolutePath);

  return {
    id: `${kind}:${normalizeSlash(absolutePath).toLowerCase()}`,
    kind,
    source: candidate.source,
    absolutePath,
    displayPath,
    workspaceRelativePath,
    isOutsideWorkspace: workspaceRelativePath === null,
  };
}

export async function resolveComposerPreview(
  session: Session,
  userMessage: string,
): Promise<ComposerPreview> {
  const textCandidates = extractTextReferenceCandidates(userMessage).map<ComposerAttachmentInput>((entry) => ({
    path: entry,
    source: "text",
  }));
  const candidates = [...textCandidates];
  const attachments: ComposerAttachment[] = [];
  const errors: string[] = [];
  const seenIds = new Set<string>();

  const resolvedCandidates = await Promise.all(candidates.map(async (candidate) => {
    try {
      return { attachment: await resolveAttachmentCandidate(session, candidate) } as const;
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
