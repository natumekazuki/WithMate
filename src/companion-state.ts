import type { ApprovalMode } from "./approval-mode.js";
import type { CodexSandboxMode } from "./codex-sandbox-mode.js";
import type { ModelReasoningEffort } from "./model-catalog.js";
import type { Message } from "./session-state.js";

export type CompanionSessionStatus = "active" | "merged" | "discarded" | "recovery-required";

export type CompanionChangedFileSummary = {
  kind: "add" | "edit" | "delete";
  path: string;
};

export type CompanionSiblingWarningSummary = {
  sessionId: string;
  taskTitle: string;
  paths: string[];
  message: string;
};

export type CompanionMergeRunOperation = "merge" | "discard";

export type CompanionMergeRun = {
  id: string;
  sessionId: string;
  groupId: string;
  operation: CompanionMergeRunOperation;
  selectedPaths: string[];
  changedFiles: CompanionChangedFileSummary[];
  siblingWarnings: CompanionSiblingWarningSummary[];
  createdAt: string;
};

export type CreateCompanionSessionInput = {
  taskTitle: string;
  workspacePath: string;
  provider: string;
  catalogRevision?: number;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  customAgentName?: string;
  approvalMode: ApprovalMode;
  codexSandboxMode: CodexSandboxMode;
  characterId: string;
  character: string;
  characterRoleMarkdown: string;
  characterIconPath: string;
  characterThemeColors: {
    main: string;
    sub: string;
  };
};

export type CompanionGroup = {
  id: string;
  repoRoot: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
};

export type CompanionSession = {
  id: string;
  groupId: string;
  taskTitle: string;
  status: CompanionSessionStatus;
  repoRoot: string;
  focusPath: string;
  targetBranch: string;
  baseSnapshotRef: string;
  baseSnapshotCommit: string;
  companionBranch: string;
  worktreePath: string;
  selectedPaths: string[];
  changedFiles: CompanionChangedFileSummary[];
  siblingWarnings: CompanionSiblingWarningSummary[];
  runState: "idle" | "running" | "error";
  threadId: string;
  provider: string;
  catalogRevision: number;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  customAgentName: string;
  approvalMode: ApprovalMode;
  codexSandboxMode: CodexSandboxMode;
  characterId: string;
  character: string;
  characterRoleMarkdown: string;
  characterIconPath: string;
  characterThemeColors: {
    main: string;
    sub: string;
  };
  createdAt: string;
  updatedAt: string;
  messages: Message[];
};

export type CompanionSessionSummary = Pick<
  CompanionSession,
  | "id"
  | "groupId"
  | "taskTitle"
  | "status"
  | "repoRoot"
  | "focusPath"
  | "targetBranch"
  | "baseSnapshotRef"
  | "baseSnapshotCommit"
  | "selectedPaths"
  | "changedFiles"
  | "siblingWarnings"
  | "runState"
  | "threadId"
  | "provider"
  | "model"
  | "reasoningEffort"
  | "approvalMode"
  | "codexSandboxMode"
  | "character"
  | "characterRoleMarkdown"
  | "characterIconPath"
  | "characterThemeColors"
  | "updatedAt"
>;

export function cloneCompanionSession(session: CompanionSession): CompanionSession {
  return {
    ...session,
    selectedPaths: [...session.selectedPaths],
    changedFiles: session.changedFiles.map((file) => ({ ...file })),
    siblingWarnings: session.siblingWarnings.map((warning) => ({
      ...warning,
      paths: [...warning.paths],
    })),
    characterThemeColors: { ...session.characterThemeColors },
    messages: session.messages.map((message) => ({
      ...message,
      artifact: message.artifact
        ? {
          ...message.artifact,
          activitySummary: [...message.artifact.activitySummary],
          operationTimeline: message.artifact.operationTimeline
            ? [...message.artifact.operationTimeline]
            : undefined,
          changedFiles: message.artifact.changedFiles.map((file) => ({
            ...file,
            diffRows: file.diffRows.map((row) => ({ ...row })),
          })),
          runChecks: message.artifact.runChecks.map((check) => ({ ...check })),
        }
        : undefined,
    })),
  };
}

export function cloneCompanionMergeRun(run: CompanionMergeRun): CompanionMergeRun {
  return {
    ...run,
    selectedPaths: [...run.selectedPaths],
    changedFiles: run.changedFiles.map((file) => ({ ...file })),
    siblingWarnings: run.siblingWarnings.map((warning) => ({
      ...warning,
      paths: [...warning.paths],
    })),
  };
}

export function cloneCompanionMergeRuns(runs: readonly CompanionMergeRun[]): CompanionMergeRun[] {
  return runs.map(cloneCompanionMergeRun);
}

export function cloneCompanionSessions(sessions: readonly CompanionSession[]): CompanionSession[] {
  return sessions.map(cloneCompanionSession);
}

export function cloneCompanionSessionSummary(summary: CompanionSessionSummary): CompanionSessionSummary {
  return {
    ...summary,
    selectedPaths: [...summary.selectedPaths],
    changedFiles: summary.changedFiles.map((file) => ({ ...file })),
    siblingWarnings: summary.siblingWarnings.map((warning) => ({
      ...warning,
      paths: [...warning.paths],
    })),
    characterThemeColors: { ...summary.characterThemeColors },
  };
}

export function cloneCompanionSessionSummaries(
  summaries: readonly CompanionSessionSummary[],
): CompanionSessionSummary[] {
  return summaries.map(cloneCompanionSessionSummary);
}
