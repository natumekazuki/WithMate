/** Agent に紐付く一つのファイル操作の正規ルート。アクセス情報がなければファイル I/O は許可しない。 */
export type MemoryFileAccess = Readonly<{
  readRoots: readonly string[];
  exportRoot: string | null;
}>;

export const MEMORY_FILE_ACCESS_USAGE = "Session-bound attachments may only be imported from the Session Workspace, allowed Additional Directories, or SessionFolder. Normal turns may explicitly restore files within those roots; background restoration is restricted to SessionFolder/memory-exports. Auxiliary uses its own Workspace and Additional Directories and its parent Main SessionFolder. Restoration is a local write: plan and Codex read-only modes forbid it. Missing file authority and symlink/junction escapes are rejected; existing output files are never overwritten.";
