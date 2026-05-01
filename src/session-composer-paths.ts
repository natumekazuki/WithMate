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

export type WorkspacePathMatchDisplay = {
  kindLabel: string;
  primaryLabel: string;
  secondaryLabel: string;
  title: string;
};

export type AdditionalDirectoryDisplay = {
  primaryLabel: string;
  secondaryLabel: string;
  title: string;
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

export function buildAdditionalDirectoryDisplay(directoryPath: string): AdditionalDirectoryDisplay {
  const normalizedPath = normalizePathForReference(directoryPath).replace(/\/+$/, "");
  const { basename, parentPath } = splitPathForDisplay(normalizedPath);
  return {
    primaryLabel: basename || normalizedPath,
    secondaryLabel: parentPath ? compactPathForDisplay(parentPath, 52) : "ルート",
    title: normalizedPath,
  };
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

export function toDirectoryPath(selectedPath: string): string {
  const normalized = selectedPath.replace(/[\\/]+$/, "");
  const lastSlashIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (lastSlashIndex < 0) {
    return normalized;
  }

  return normalized.slice(0, lastSlashIndex);
}
