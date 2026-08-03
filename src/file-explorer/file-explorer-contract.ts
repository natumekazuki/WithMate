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

export type SessionFileResourceRequest = {
  sessionId: string;
  rootId: string;
  relativePath: string;
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

export type SessionDirectoryRequest = SessionFileResourceRequest;

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

export type FileRootFileDiffResult =
  | { status: "ok"; relativePath: string; scope: FileRootGitChangeScope; patch: string }
  | { status: "untracked" | "not-changed" | "not-git" | "root-not-found" | "failed"; message: string };
