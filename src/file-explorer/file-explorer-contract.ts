export type SessionFileRootKind = "workspace" | "session-folder" | "additional";

export type SessionFileRoot = {
  id: string;
  kind: SessionFileRootKind;
  label: string;
  displayPath: string;
};

export type SessionDirectoryEntryKind = "directory" | "file" | "symbolic-link" | "other";

export type SessionDirectoryEntry = {
  name: string;
  relativePath: string;
  kind: SessionDirectoryEntryKind;
  byteLength: number | null;
  modifiedAt: string | null;
};

export type SessionFileResourceKind = "text" | "markdown" | "image" | "svg" | "binary";
export type SessionFileEncoding = "utf-8" | "shift_jis" | "utf-16le" | "utf-16be";

export type SessionFileRootResourceRequest = {
  sessionId: string;
  rootId: string;
  relativePath: string;
};

export type SessionFileAbsoluteResourceRequest = {
  sessionId: string;
  absolutePath: string;
};

export type SessionFileResourceRequest =
  | SessionFileRootResourceRequest
  | SessionFileAbsoluteResourceRequest;

export function isSessionFileAbsoluteResource(
  resource: SessionFileResourceRequest,
): resource is SessionFileAbsoluteResourceRequest {
  return "absolutePath" in resource;
}

export function isSessionFileRootResource(
  resource: SessionFileResourceRequest,
): resource is SessionFileRootResourceRequest {
  return "rootId" in resource;
}

export function getSessionFileResourceDisplayPath(resource: SessionFileResourceRequest): string {
  return isSessionFileAbsoluteResource(resource) ? resource.absolutePath : resource.relativePath;
}

export function areSessionFileResourcesEqual(
  left: SessionFileResourceRequest,
  right: SessionFileResourceRequest,
): boolean {
  if (left.sessionId !== right.sessionId) {
    return false;
  }
  if (isSessionFileAbsoluteResource(left) && isSessionFileAbsoluteResource(right)) {
    return left.absolutePath === right.absolutePath;
  }
  return isSessionFileRootResource(left)
    && isSessionFileRootResource(right)
    && left.rootId === right.rootId
    && left.relativePath === right.relativePath;
}

export type SessionFilePreviewWindowOpenRequest =
  | {
      kind: "resource";
      resource: SessionFileResourceRequest;
      view?: SessionFilePreviewWindowView;
    }
  | {
      kind: "link";
      sessionId: string;
      target: string;
      baseResource?: SessionFileResourceRequest;
    };

export type SessionFilePreviewWindowView =
  | { kind: "preview" }
  | { kind: "diff"; scope: FileRootGitChangeScope };

export type SessionFilePreviewWindowPayload = {
  resource: SessionFileResourceRequest;
  ownerSessionId: string;
  windowTitle: string;
  view?: SessionFilePreviewWindowView;
};

export const FILE_PREVIEW_WINDOW_TITLE_FALLBACK = "File Preview";

export function resolveSessionFilePreviewWindowTitle(fileName: string | null | undefined): string {
  const normalizedPath = fileName?.trim().replaceAll("\\", "/") ?? "";
  const candidate = normalizedPath.split("/").at(-1)?.trim() ?? "";
  return candidate && candidate !== "." && candidate !== ".." && !/[\u0000-\u001f\u007f]/u.test(candidate)
    ? candidate
    : FILE_PREVIEW_WINDOW_TITLE_FALLBACK;
}

export type SessionFilePreviewWindowOpenResult =
  | {
      status: "opened";
      targetType: "preview-window";
      disposition: "created" | "focused";
      resource: SessionFileResourceRequest;
    }
  | {
      status: "opened";
      targetType: "external-url" | "local-directory";
      target: string;
    }
  | {
      status: "not-found" | "not-previewable" | "failed";
      targetType: "local-file" | "local-path" | "unknown";
      target: string;
      message: string;
    };

export type SessionFilePreviewTargetResolution =
  | { type: "external-url"; target: string }
  | { type: "directory"; targetPath: string }
  | { type: "file"; resource: SessionFileResourceRequest }
  | {
      type: "not-found" | "not-previewable" | "failed";
      targetPath: string;
      message: string;
    };

export type SessionFilePreviewImagePoint = {
  x: number;
  y: number;
};

export type SessionFilePreviewImageActionRequest = {
  sessionId: string;
  point: SessionFilePreviewImagePoint;
};

export type SessionFilePreviewImageCopyResult =
  | { status: "copied" }
  | { status: "failed"; message: string };

export type SessionFilePreviewImageContextMenuResult =
  | SessionFilePreviewImageCopyResult
  | { status: "dismissed" };

export type SessionDirectoryRequest = SessionFileRootResourceRequest;

export type SessionFileOpenRequest = SessionFileResourceRequest & {
  reveal?: boolean;
};

export type SessionFileDescriptor = SessionFileResourceRequest & {
  name: string;
  kind: SessionFileResourceKind;
  byteLength: number;
  modifiedAt: string;
  mimeType: string;
  suggestedEncoding: SessionFileEncoding;
  revision: string;
};

export type SessionFileChunkRequest = SessionFileResourceRequest & {
  offset: number;
  length: number;
  expectedRevision: string;
};

export type SessionFileChunkResult = {
  data: ArrayBuffer;
  offset: number;
  nextOffset: number;
  totalBytes: number;
  done: boolean;
  revision: string;
};

export type FileRootGitChangeScope = "working-tree" | "staged";
export type FileRootGitChangeKind = "added" | "modified" | "deleted" | "renamed" | "untracked";

export type FileRootGitChangeEntry = {
  relativePath: string;
  previousRelativePath: string | null;
  kinds: Partial<Record<FileRootGitChangeScope, FileRootGitChangeKind>>;
  scopes: FileRootGitChangeScope[];
};

export type FileRootChangesRequest = {
  sessionId: string;
  rootId: string;
};

export type FileRootChangesResult =
  | { status: "ok"; entries: FileRootGitChangeEntry[] }
  | { status: "not-git" | "root-not-found" | "failed"; message: string };

export type FileRootFileDiffRequest = FileRootChangesRequest & {
  relativePath: string;
  scope: FileRootGitChangeScope;
};

export function buildFileRootDiffPreviewWindowRequest(
  request: FileRootFileDiffRequest,
): SessionFilePreviewWindowOpenRequest {
  return {
    kind: "resource",
    resource: {
      sessionId: request.sessionId,
      rootId: request.rootId,
      relativePath: request.relativePath,
    },
    view: { kind: "diff", scope: request.scope },
  };
}

export type FileRootFileDiffResult =
  | { status: "ok"; relativePath: string; scope: FileRootGitChangeScope; patch: string }
  | { status: "untracked" | "not-changed" | "not-git" | "root-not-found" | "failed"; message: string };
