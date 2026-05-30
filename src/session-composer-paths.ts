import type { ComposerAttachment } from "./runtime-state.js";
import type { WorkspacePathCandidate, WorkspacePathCandidateKind } from "./workspace-path-candidate.js";

export type ActivePathReference = {
  query: string;
  start: number;
  end: number;
};

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

export type WorkspacePathMatchDisplay = {
  kindLabel: string;
  primaryLabel: string;
  secondaryLabel: string;
  title: string;
};

export type WorkspacePathMatchItem = WorkspacePathMatchDisplay & {
  isActive: boolean;
  key: string;
  kind: WorkspacePathCandidateKind;
  path: string;
};

export type WorkspacePathMatchKeyAction =
  | { kind: "dismiss"; shouldPreventDefault: boolean }
  | { kind: "next"; shouldPreventDefault: true }
  | { kind: "previous"; shouldPreventDefault: true }
  | { kind: "select"; shouldPreventDefault: true };

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

export function getActivePathReference(value: string, caret: number): ActivePathReference | null {
  const prefix = value.slice(0, caret);
  const match = /(^|[\s(])@(?:"([^"\r\n]*)|([^\s@"\r\n]*))$/.exec(prefix);
  if (!match) {
    return null;
  }

  const query = (match[2] ?? match[3] ?? "").replace(/\\/g, "/");
  const start = (match.index ?? 0) + match[1].length;

  return {
    query,
    start,
    end: caret,
  };
}

export function removeActivePathReference(value: string, activeReference: ActivePathReference | null): string {
  if (!activeReference) {
    return value;
  }

  return `${value.slice(0, activeReference.start)}${value.slice(activeReference.end)}`;
}

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

export function buildPathReferenceReplacementState(
  draft: string,
  activeReference: ActivePathReference,
  referencePath: string,
): PathReferenceInsertionState {
  const replacement = formatPathReference(referencePath);
  return {
    draft: `${draft.slice(0, activeReference.start)}${replacement}${draft.slice(activeReference.end)}`,
    caret: activeReference.start + replacement.length,
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
      new RegExp(`(^|[\\s(])${escapedToken}(?=\\s|$|[),.;:!?])`),
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

function workspacePathCandidateKindLabel(kind: WorkspacePathCandidateKind): string {
  return kind === "folder" ? "Dir" : "File";
}

export function buildWorkspacePathMatchDisplay(pathMatch: WorkspacePathCandidate): WorkspacePathMatchDisplay {
  const normalizedPath = normalizePathForReference(pathMatch.path);
  const { basename, parentPath } = splitPathForDisplay(normalizedPath);
  return {
    kindLabel: workspacePathCandidateKindLabel(pathMatch.kind),
    primaryLabel: basename || normalizedPath,
    secondaryLabel: parentPath ? compactPathForDisplay(parentPath, 42) : "ワークスペース直下",
    title: normalizedPath,
  };
}

export function buildWorkspacePathMatchItems(
  pathMatches: readonly WorkspacePathCandidate[],
  activeIndex: number,
): WorkspacePathMatchItem[] {
  return pathMatches.map((match, index) => {
    const matchDisplay = buildWorkspacePathMatchDisplay(match);
    return {
      key: `${match.kind}:${match.path}`,
      path: match.path,
      kind: match.kind,
      kindLabel: matchDisplay.kindLabel,
      primaryLabel: matchDisplay.primaryLabel,
      secondaryLabel: matchDisplay.secondaryLabel,
      title: matchDisplay.title,
      isActive: index === activeIndex,
    };
  });
}

export function getInitialWorkspacePathMatchIndex(matchCount: number): number {
  return matchCount > 0 ? 0 : -1;
}

export function getNextWorkspacePathMatchIndex(currentIndex: number, matchCount: number): number {
  return Math.min(currentIndex + 1, matchCount - 1);
}

export function getPreviousWorkspacePathMatchIndex(currentIndex: number): number {
  return Math.max(currentIndex - 1, 0);
}

export function resolveActiveWorkspacePathMatch(
  pathMatches: readonly WorkspacePathCandidate[],
  activeIndex: number,
): WorkspacePathCandidate | null {
  return pathMatches[activeIndex] ?? pathMatches[0] ?? null;
}

export function canNavigateWorkspacePathMatches(input: {
  isComposerImeComposing: boolean;
  isNativeComposing: boolean;
  matchCount: number;
}): boolean {
  return input.matchCount > 0 && !input.isComposerImeComposing && !input.isNativeComposing;
}

export function resolveWorkspacePathMatchKeyAction(input: {
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
}): WorkspacePathMatchKeyAction | null {
  switch (input.key) {
    case "ArrowDown":
      return { kind: "next", shouldPreventDefault: true };
    case "ArrowUp":
      return { kind: "previous", shouldPreventDefault: true };
    case "Escape":
      return { kind: "dismiss", shouldPreventDefault: true };
    case "Tab":
      return { kind: "dismiss", shouldPreventDefault: false };
    case "Enter":
      return input.ctrlKey || input.metaKey
        ? null
        : { kind: "select", shouldPreventDefault: true };
    default:
      return null;
  }
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

export function appendAdditionalDirectoryPath(
  current: readonly string[],
  directoryPath: string,
): string[] {
  const normalizedPath = normalizePathForReference(directoryPath);
  return Array.from(new Set([...current, normalizedPath]));
}

export function removeAdditionalDirectoryPath(
  current: readonly string[],
  directoryPath: string,
): string[] {
  const removablePath = normalizePathForReference(directoryPath);
  return current.filter((entry) => normalizePathForReference(entry) !== removablePath);
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
