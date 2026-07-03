import type { ComposerAttachment } from "./runtime-state.js";

export type ComposerAttachmentDisplay = {
  kindLabel: string;
  locationLabel: string;
  primaryLabel: string;
  secondaryLabel: string;
  title: string;
};

export type ComposerAttachmentItem = ComposerAttachmentDisplay & {
  key: string;
  kind: ComposerAttachment["kind"];
  removeTargets: string[];
};

export type PathReferenceAttachmentInput = {
  kind: ComposerAttachment["kind"];
  path: string;
};

export type AdditionalDirectoryDisplay = {
  primaryLabel: string;
  secondaryLabel: string;
  title: string;
};

export type AdditionalDirectoryItem = AdditionalDirectoryDisplay & {
  canRemove: boolean;
  key: string;
  path: string;
};

export type PathReferenceInsertionState = {
  caret: number;
  draft: string;
};

export type ComposerPathPickerKind = "file" | "folder" | "image";

export type ComposerReferencePathPicker = {
  pickDirectory(initialPath?: string | null): Promise<string | null>;
  pickFile(initialPath?: string | null): Promise<string | null>;
  pickImageFile(initialPath?: string | null): Promise<string | null>;
};

export function formatPathReference(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

function escapeRegExpPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildPathReferenceInsertionState(
  draft: string,
  caret: number,
  referencePaths: readonly string[],
): PathReferenceInsertionState | null {
  if (referencePaths.length === 0) {
    return null;
  }

  const referenceTokens = referencePaths.map((referencePath) => formatPathReference(referencePath));
  const leadingSpacer = caret > 0 && !/\s/.test(draft[caret - 1] ?? "") ? " " : "";
  const trailingSpacer = draft.length > caret && !/\s/.test(draft[caret] ?? "") ? " " : "";
  const insertion = `${leadingSpacer}${referenceTokens.join(" ")}${trailingSpacer}`;
  return {
    draft: `${draft.slice(0, caret)}${insertion}${draft.slice(caret)}`,
    caret: caret + insertion.length,
  };
}

export function removePathReferenceTokensFromDraft(
  draft: string,
  referencePaths: readonly string[],
): string {
  let nextDraft = draft;
  const escapedTokens = referencePaths
    .map((referencePath) => formatPathReference(referencePath))
    .map(escapeRegExpPattern);
  for (const escapedToken of escapedTokens) {
    nextDraft = nextDraft.replace(
      new RegExp(`(^|[\\s(])${escapedToken}(?=\\s|$|[),.;:!?])`, "g"),
      (_match, leadingWhitespace: string) => leadingWhitespace || "",
    );
  }

  return nextDraft
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

export function buildPathReferenceRemovalState(
  draft: string,
  referencePaths: readonly string[],
): PathReferenceInsertionState {
  const nextDraft = removePathReferenceTokensFromDraft(draft, referencePaths);
  return {
    draft: nextDraft,
    caret: nextDraft.length,
  };
}

export function normalizePathForReference(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function resolvePathReferenceRemovalTargets(targets: readonly string[]): string[] {
  return Array.from(new Set(targets.map((target) => normalizePathForReference(target))));
}

export function splitPathForDisplay(filePath: string): { basename: string; parentPath: string } {
  const normalized = normalizePathForReference(filePath).replace(/\/+$/, "");
  if (!normalized) {
    return { basename: "", parentPath: "" };
  }

  const lastSlashIndex = normalized.lastIndexOf("/");
  if (lastSlashIndex < 0) {
    return {
      basename: normalized,
      parentPath: "",
    };
  }

  return {
    basename: normalized.slice(lastSlashIndex + 1),
    parentPath: normalized.slice(0, lastSlashIndex),
  };
}

export function compactPathForDisplay(filePath: string, maxLength = 40): string {
  if (filePath.length <= maxLength) {
    return filePath;
  }

  const headLength = Math.max(10, Math.floor((maxLength - 1) * 0.4));
  const tailLength = Math.max(14, maxLength - headLength - 1);
  return `${filePath.slice(0, headLength)}...${filePath.slice(-tailLength)}`;
}

function attachmentKindLabel(kind: ComposerAttachment["kind"]): string {
  switch (kind) {
    case "folder":
      return "フォルダ";
    case "image":
      return "画像";
    case "file":
    default:
      return "ファイル";
  }
}

export function buildComposerAttachmentDisplay(attachment: ComposerAttachment): ComposerAttachmentDisplay {
  const preferredPath = attachment.workspaceRelativePath ?? attachment.displayPath ?? normalizePathForReference(attachment.absolutePath);
  const title = attachment.isOutsideWorkspace
    ? normalizePathForReference(attachment.absolutePath)
    : preferredPath;
  const { basename, parentPath } = splitPathForDisplay(title);
  const secondaryPath = attachment.isOutsideWorkspace
    ? parentPath
      ? compactPathForDisplay(parentPath, 48)
      : compactPathForDisplay(title, 48)
    : parentPath
      ? compactPathForDisplay(parentPath, 42)
      : "ワークスペース直下";

  return {
    kindLabel: attachmentKindLabel(attachment.kind),
    locationLabel: attachment.isOutsideWorkspace ? "ワークスペース外" : "ワークスペース内",
    primaryLabel: basename || title,
    secondaryLabel: secondaryPath,
    title,
  };
}

export function buildComposerAttachmentItems(
  attachments: readonly ComposerAttachment[],
  options: { trimRemoveTargets: boolean },
): ComposerAttachmentItem[] {
  return attachments.map((attachment) => {
    const attachmentDisplay = buildComposerAttachmentDisplay(attachment);
    const removeTargetCandidates = [
      attachment.workspaceRelativePath,
      attachment.displayPath,
      normalizePathForReference(attachment.absolutePath),
    ];
    const removeTargets = options.trimRemoveTargets
      ? removeTargetCandidates.filter(
          (candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0,
        )
      : removeTargetCandidates.filter((candidate): candidate is string => !!candidate);
    return {
      key: attachment.id,
      kind: attachment.kind,
      kindLabel: attachmentDisplay.kindLabel,
      locationLabel: attachmentDisplay.locationLabel,
      primaryLabel: attachmentDisplay.primaryLabel,
      secondaryLabel: attachmentDisplay.secondaryLabel,
      title: attachmentDisplay.title,
      removeTargets,
    };
  });
}

export function buildPathReferenceAttachmentItems(
  pathReferences: readonly PathReferenceAttachmentInput[],
): ComposerAttachmentItem[] {
  return pathReferences.map((entry) => {
    const { basename, parentPath } = splitPathForDisplay(entry.path);
    return {
      key: `${entry.kind}:${entry.path}`,
      kind: entry.kind,
      kindLabel: attachmentKindLabel(entry.kind),
      locationLabel: "参照",
      primaryLabel: basename || entry.path,
      secondaryLabel: parentPath ? compactPathForDisplay(parentPath, 42) : "ルート",
      title: entry.path,
      removeTargets: [entry.path],
    };
  });
}

export function appendMissingPathReferenceAttachments(
  current: readonly PathReferenceAttachmentInput[],
  referencePaths: readonly string[],
  kind: ComposerAttachment["kind"],
): PathReferenceAttachmentInput[] {
  const existing = new Set(current.map((entry) => entry.path));
  const next = [...current];
  for (const referencePath of referencePaths) {
    if (!existing.has(referencePath)) {
      next.push({ path: referencePath, kind });
    }
  }
  return next;
}

export function removePathReferenceAttachments(
  current: readonly PathReferenceAttachmentInput[],
  referencePaths: readonly string[],
): PathReferenceAttachmentInput[] {
  const removablePaths = new Set(resolvePathReferenceRemovalTargets(referencePaths));
  return current.filter((entry) => !removablePaths.has(normalizePathForReference(entry.path)));
}

export function buildAdditionalDirectoryDisplay(directoryPath: string): AdditionalDirectoryDisplay {
  const normalizedPath = normalizePathForReference(directoryPath).replace(/\/+$/, "");
  const { basename, parentPath } = splitPathForDisplay(normalizedPath);
  return {
    primaryLabel: basename || normalizedPath,
    secondaryLabel: parentPath ? compactPathForDisplay(parentPath, 52) : "ルート",
    title: normalizedPath,
  };
}

export function buildAdditionalDirectoryItems(
  directoryPaths: readonly string[],
  canRemove: boolean,
): AdditionalDirectoryItem[] {
  return directoryPaths.map((directoryPath) => {
    const directoryDisplay = buildAdditionalDirectoryDisplay(directoryPath);
    return {
      key: directoryPath,
      path: directoryPath,
      primaryLabel: directoryDisplay.primaryLabel,
      secondaryLabel: directoryDisplay.secondaryLabel,
      title: directoryDisplay.title,
      canRemove,
    };
  });
}

export function toWorkspaceRelativeReference(workspacePath: string, selectedPath: string): string | null {
  const normalizedWorkspacePath = normalizePathForReference(workspacePath).replace(/\/+$/, "");
  const normalizedSelectedPath = normalizePathForReference(selectedPath);
  const workspacePrefix = `${normalizedWorkspacePath}/`;
  if (!normalizedSelectedPath.toLocaleLowerCase().startsWith(workspacePrefix.toLocaleLowerCase())) {
    return null;
  }

  return normalizedSelectedPath.slice(workspacePrefix.length);
}

export function resolveReferencePathsForInsertion(
  selectedPaths: readonly string[],
  workspacePath: string | null,
): string[] {
  return selectedPaths.map((selectedPath) => (
    workspacePath !== null
      ? toWorkspaceRelativeReference(workspacePath, selectedPath) ?? normalizePathForReference(selectedPath)
      : normalizePathForReference(selectedPath)
  ));
}

export function buildSelectedPathReferenceInsertionState(input: {
  caret: number;
  draft: string;
  selectedPaths: readonly string[];
  workspacePath: string | null;
}): PathReferenceInsertionState | null {
  const referencePaths = resolveReferencePathsForInsertion(input.selectedPaths, input.workspacePath);
  return buildPathReferenceInsertionState(input.draft, input.caret, referencePaths);
}

export function toDirectoryPath(selectedPath: string): string {
  const normalized = selectedPath.replace(/[\\/]+$/, "");
  const lastSlashIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (lastSlashIndex < 0) {
    return normalized;
  }

  return normalized.slice(0, lastSlashIndex);
}

export function resolvePickedPathBaseDirectory(kind: ComposerPathPickerKind, selectedPath: string): string {
  return kind === "folder" ? selectedPath : toDirectoryPath(selectedPath);
}

export async function pickComposerReferencePath(
  kind: ComposerPathPickerKind,
  initialPath: string | null,
  picker: ComposerReferencePathPicker,
): Promise<string | null> {
  switch (kind) {
    case "folder":
      return await picker.pickDirectory(initialPath);
    case "image":
      return await picker.pickImageFile(initialPath);
    case "file":
    default:
      return await picker.pickFile(initialPath);
  }
}
