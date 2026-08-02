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

export type WorkspaceChangeScope = "working-tree" | "staged";
export type WorkspaceChangeKind = "added" | "modified" | "deleted" | "renamed" | "untracked";

export type WorkspaceChangeEntry = {
  relativePath: string;
  previousRelativePath: string | null;
  kinds: Partial<Record<WorkspaceChangeScope, WorkspaceChangeKind>>;
  scopes: WorkspaceChangeScope[];
};

export type WorkspaceChangesResult =
  | { status: "ok"; entries: WorkspaceChangeEntry[] }
  | { status: "not-git" | "workspace-not-found" | "failed"; message: string };

export type WorkspaceFileDiffRequest = {
  sessionId: string;
  relativePath: string;
  scope: WorkspaceChangeScope;
};

export type WorkspaceFileDiffResult =
  | { status: "ok"; relativePath: string; scope: WorkspaceChangeScope; patch: string }
  | { status: "untracked" | "not-changed" | "not-git" | "workspace-not-found" | "failed"; message: string };
