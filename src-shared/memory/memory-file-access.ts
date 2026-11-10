/** Canonical roots for one agent-bound file operation; absent access permits no file I/O. */
export type MemoryFileAccess = Readonly<{
  readRoots: readonly string[];
  exportRoot: string | null;
}>;

export const MEMORY_FILE_ACCESS_USAGE = "Session-bound attachments may only be imported from the Session Workspace, allowed Additional Directories, or SessionFolder. Normal turns may explicitly restore files within those roots; background restoration is restricted to SessionFolder/memory-exports. Auxiliary uses its own Workspace and Additional Directories and its parent Main SessionFolder. Restoration is a local write: plan and Codex read-only modes forbid it. Missing file authority and symlink/junction escapes are rejected; existing output files are never overwritten.";
