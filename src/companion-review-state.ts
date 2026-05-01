import type { ChangedFile } from "./runtime-state.js";
import type { CompanionMergeRun, CompanionSession, CompanionSiblingWarningSummary } from "./companion-state.js";

export type CompanionMergeReadinessStatus = "ready" | "blocked" | "warning";

export type CompanionMergeReadinessIssue = {
  kind: "lifecycle" | "target-branch-drift" | "target-branch-mismatch" | "target-worktree-dirty" | "merge-simulation";
  message: string;
  paths?: string[];
};

export type CompanionMergeReadiness = {
  status: CompanionMergeReadinessStatus;
  blockers: CompanionMergeReadinessIssue[];
  warnings: CompanionMergeReadinessIssue[];
  targetHead: string;
  baseParent: string;
  simulatedAt: string;
};

export type CompanionSiblingCheckWarning = CompanionSiblingWarningSummary;

export type CompanionMergeSelectedFilesResult = {
  session: CompanionSession;
  siblingWarnings: CompanionSiblingCheckWarning[];
};

export type CompanionSyncTargetResult = {
  session: CompanionSession;
};

export type CompanionTargetWorkspaceStash = {
  id: string;
  ref: string;
  hash: string;
  message: string;
};

export type CompanionTargetWorkspaceStashResult = {
  stash: CompanionTargetWorkspaceStash | null;
};

export type CompanionReviewSnapshot = {
  session: CompanionSession;
  changedFiles: ChangedFile[];
  mergeRuns: CompanionMergeRun[];
  mergeReadiness: CompanionMergeReadiness;
  targetStash: CompanionTargetWorkspaceStash | null;
  generatedAt: string;
  warnings: string[];
};

export type CompanionMergeSelectedFilesRequest = {
  sessionId: string;
  selectedPaths: string[];
};

function getLocationSearch(): string {
  const browserWindow = (globalThis as typeof globalThis & { window?: { location?: { search?: string } } }).window;
  return browserWindow?.location?.search ?? "";
}

export function getCompanionSessionIdFromLocation(): string | null {
  return new URLSearchParams(getLocationSearch()).get("companionSessionId");
}
