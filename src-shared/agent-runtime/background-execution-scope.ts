import type { MemoryTargetSelector } from "../memory/memory-contract.js";
import type { SessionHistoryReadScope } from "../session/session-history-read-scope.js";

export type BackgroundPurpose = "character-memory" | "target-memory" | "affect";

/** Canonical filesystem roots captured for one invocation; absent access grants no file operation. */
export type BackgroundMemoryFileAccess = Readonly<{
  readRoots: readonly string[];
  exportRoot: string | null;
}>;

export type BackgroundExecutionScope = Readonly<{
  purpose: BackgroundPurpose;
  history: SessionHistoryReadScope;
  memoryTargets: readonly MemoryTargetSelector[];
  fileAccess?: BackgroundMemoryFileAccess;
}>;
