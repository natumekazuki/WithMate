import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import type {
  ComposerAttachment,
  ComposerAttachmentInput,
  ComposerAttachmentKind,
  ComposerPreview,
} from "../../src-shared/session/runtime-state.js";
import type { Session } from "../../src-shared/session/session-state.js";
import { extractComposerAttachmentReferenceCandidates } from "../../src-shared/files/path-reference.js";
import {
  isPathWithinDirectory,
  normalizeAllowedAdditionalDirectories,
} from "./additional-directories.js";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
]);
const TRAILING_PATH_PUNCTUATION = /[),.;:!?]+$/;

/** 添付先を解決し許可された作業範囲を確認するために必要な Session の項目。 */
type ComposerPreviewSessionContext = Pick<
  Session,
  "workspacePath" | "allowedAdditionalDirectories"
>;

/** 添付の表示と識別子に使う区切り文字をスラッシュへ統一する。 */
function normalizeSlash(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

/** 文中から抽出された候補の空白と、パス末尾に付いた句読点を除く。 */
function trimCandidatePath(value: string): string {
  return value.trim().replace(TRAILING_PATH_PUNCTUATION, "");
}

/** 空でないパス候補を、相対指定ならワークスペースを基準にして絶対化する。 */
function resolveCandidatePath(workspacePath: string, rawPath: string): string {
  const trimmedPath = trimCandidatePath(rawPath);
  if (!trimmedPath) {
    return "";
  }

  return path.isAbsolute(trimmedPath)
    ? path.normalize(trimmedPath)
    : path.resolve(workspacePath, trimmedPath);
}

/** ワークスペース自身はドット、配下は相対パス、それ以外は null を返す。 */
function toWorkspaceRelativePath(
  workspacePath: string,
  absolutePath: string,
): string | null {
  const relativePath = path.relative(workspacePath, absolutePath);
  if (relativePath === "") {
    return ".";
  }

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }

  return normalizeSlash(relativePath);
}

/** 拡張子が対象の画像形式なら image、それ以外なら file と分類する。 */
function inferFileKindFromPath(filePath: string): ComposerAttachmentKind {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
    ? "image"
    : "file";
}

/** 配下はワークスペースからの相対表示、そうでなければ絶対パス表示にする。 */
function toDisplayPath(workspacePath: string, absolutePath: string): string {
  return (
    toWorkspaceRelativePath(workspacePath, absolutePath) ??
    normalizeSlash(absolutePath)
  );
}

/** 添付の存在と種類を調べ、リンクを解決した実パスが現在許可された範囲にある場合だけ取り込む。 */
async function resolveAttachmentCandidate(
  session: ComposerPreviewSessionContext,
  candidate: ComposerAttachmentInput,
  capturedAbsolutePath?: string,
): Promise<ComposerAttachment> {
  const absolutePath =
    capturedAbsolutePath ??
    resolveCandidatePath(session.workspacePath, candidate.path);
  if (!absolutePath) {
    throw new Error("Attachment path is empty.");
  }

  let stats;
  try {
    stats = await stat(absolutePath);
  } catch {
    throw new Error(`Path not found: ${candidate.path}`);
  }

  const kind =
    candidate.kind ??
    (stats.isDirectory() ? "folder" : inferFileKindFromPath(absolutePath));

  if (kind === "folder" && !stats.isDirectory()) {
    throw new Error(`Expected a directory: ${candidate.path}`);
  }

  if ((kind === "file" || kind === "image") && !stats.isFile()) {
    throw new Error(`Expected a file: ${candidate.path}`);
  }

  const targetRealPath = await realpath(absolutePath);
  const directories = [
    session.workspacePath,
    ...normalizeAllowedAdditionalDirectories(
      session.workspacePath,
      session.allowedAdditionalDirectories,
    ),
  ];
  let withinWorkScope = false;
  for (const directory of directories) {
    const directoryRealPath = await realpath(directory).catch(() => null);
    if (
      directoryRealPath &&
      isPathWithinDirectory(targetRealPath, directoryRealPath)
    ) {
      withinWorkScope = true;
      break;
    }
  }
  if (!withinWorkScope) {
    throw new Error(
      `Path is outside the workspace. Add its directory before attaching: ${candidate.path}`,
    );
  }
  const workspaceRelativePath = toWorkspaceRelativePath(
    session.workspacePath,
    absolutePath,
  );
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

/** 保存した各添付が絶対パスで、現在も同じ種類・許可範囲で利用できることを再確認する。 */
export async function assertCapturedComposerAttachmentsAvailable(
  session: ComposerPreviewSessionContext,
  attachments: readonly ComposerAttachment[],
): Promise<void> {
  await Promise.all(
    attachments.map(async (attachment) => {
      if (!path.isAbsolute(attachment.absolutePath))
        throw new Error("Captured attachment path must be absolute.");
      await resolveAttachmentCandidate(
        session,
        {
          path: attachment.absolutePath,
          kind: attachment.kind,
          source: attachment.source,
        },
        attachment.absolutePath,
      );
    }),
  );
}

/** 本文中の参照候補を解決して重複を除き、個別の失敗は利用できる添付と分けて返す。 */
export async function resolveComposerPreview(
  session: ComposerPreviewSessionContext,
  userMessage: string,
): Promise<ComposerPreview> {
  const candidates = extractComposerAttachmentReferenceCandidates(userMessage);
  const attachments: ComposerAttachment[] = [];
  const errors: string[] = [];
  const seenIds = new Set<string>();

  const resolvedCandidates = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        return {
          attachment: await resolveAttachmentCandidate(session, candidate),
        } as const;
      } catch (error) {
        return {
          error:
            error instanceof Error
              ? error.message
              : "Failed to resolve attachment.",
        } as const;
      }
    }),
  );

  for (const resolved of resolvedCandidates) {
    if ("error" in resolved) {
      const errorMessage =
        typeof resolved.error === "string"
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
