import { formatMarkdownImageReference } from "../../../src-shared/files/composer-image-reference.js";

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

export type ComposerReferenceInput = {
  path: string;
  presentation: "image" | "path";
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

export function buildComposerReferenceInsertionState(
  draft: string,
  caret: number,
  references: readonly ComposerReferenceInput[],
): PathReferenceInsertionState | null {
  if (references.length === 0) {
    return null;
  }

  const referenceTokens = references.map((reference) => (
    reference.presentation === "image"
      ? formatMarkdownImageReference(reference.path)
      : formatPathReference(reference.path)
  ));
  const leadingSpacer = caret > 0 && !/\s/.test(draft[caret - 1] ?? "") ? " " : "";
  const trailingSpacer = draft.length > caret && !/\s/.test(draft[caret] ?? "") ? " " : "";
  const insertion = `${leadingSpacer}${referenceTokens.join(" ")}${trailingSpacer}`;
  return {
    draft: `${draft.slice(0, caret)}${insertion}${draft.slice(caret)}`,
    caret: caret + insertion.length,
  };
}

export function normalizePathForReference(filePath: string): string {
  return filePath.replace(/\\/g, "/");
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

export function buildAdditionalDirectoryDisplay(directoryPath: string): AdditionalDirectoryDisplay {
  const normalizedPath = normalizePathForReference(directoryPath).replace(/\/+$/, "");
  const { basename, parentPath } = splitPathForDisplay(normalizedPath);
  return {
    primaryLabel: basename || normalizedPath,
    secondaryLabel: parentPath ? compactPathForDisplay(parentPath, 52) : "Root",
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
