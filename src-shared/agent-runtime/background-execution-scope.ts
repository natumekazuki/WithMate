import type { MemoryTargetSelector } from "../memory/memory-contract.js";
import type { MemoryFileAccess } from "../memory/memory-file-access.js";
import type { SessionHistoryReadScope } from "../session/session-history-read-scope.js";

export type BackgroundPurpose = "character-memory" | "target-memory" | "affect";

/** Background authority captures Project identities, not caller-supplied path selectors. */
export type BackgroundMemoryTarget = MemoryTargetSelector<{ type: "id"; id: string }>;

export type BackgroundExecutionScope = Readonly<{
  purpose: BackgroundPurpose;
  history: SessionHistoryReadScope;
  memoryTargets: readonly BackgroundMemoryTarget[];
  fileAccess?: MemoryFileAccess;
}>;
