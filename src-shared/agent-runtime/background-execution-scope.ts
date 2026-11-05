import type { MemoryTargetSelector } from "../memory/memory-contract.js";
import type { SessionHistoryReadScope } from "../session/session-history-read-scope.js";

export type BackgroundPurpose = "character-memory" | "target-memory" | "affect";

export type BackgroundExecutionScope = Readonly<{
  purpose: BackgroundPurpose;
  history: SessionHistoryReadScope;
  memoryTargets: readonly MemoryTargetSelector[];
}>;
