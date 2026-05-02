import type { ApprovalMode } from "./approval-mode.js";
import type { CodexSandboxMode } from "./codex-sandbox-mode.js";
import type { ModelReasoningEffort } from "./model-catalog.js";
import type { ChangedFile } from "./runtime-state.js";
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
  diffSnapshot: ChangedFile[];
  siblingWarnings: CompanionSiblingWarningSummary[];
  createdAt: string;
};

export type CompanionMergeRunSummary = Omit<CompanionMergeRun, "diffSnapshot"> & {
  diffSnapshotAvailable: boolean;
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
  allowedAdditionalDirectories?: string[];
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
  | "allowedAdditionalDirectories"
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
> & {
  latestMergeRun: CompanionMergeRunSummary | null;
};

export function cloneCompanionSession(session: CompanionSession): CompanionSession {
  return {
    ...session,
    selectedPaths: [...session.selectedPaths],
    changedFiles: session.changedFiles.map((file) => ({ ...file })),
    siblingWarnings: session.siblingWarnings.map((warning) => ({
      ...warning,
      paths: [...warning.paths],
    })),
    allowedAdditionalDirectories: [...(session.allowedAdditionalDirectories ?? [])],
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
    diffSnapshot: run.diffSnapshot.map((file) => ({
      ...file,
      diffRows: file.diffRows.map((row) => ({ ...row })),
    })),
    siblingWarnings: run.siblingWarnings.map((warning) => ({
      ...warning,
      paths: [...warning.paths],
    })),
  };
}

export function cloneCompanionMergeRuns(runs: readonly CompanionMergeRun[]): CompanionMergeRun[] {
  return runs.map(cloneCompanionMergeRun);
}

export function companionMergeRunToSummary(run: CompanionMergeRun): CompanionMergeRunSummary {
  return {
    id: run.id,
    sessionId: run.sessionId,
    groupId: run.groupId,
    operation: run.operation,
    selectedPaths: [...run.selectedPaths],
    changedFiles: run.changedFiles.map((file) => ({ ...file })),
    siblingWarnings: run.siblingWarnings.map((warning) => ({
      ...warning,
      paths: [...warning.paths],
    })),
    diffSnapshotAvailable: run.diffSnapshot.length > 0,
    createdAt: run.createdAt,
  };
}

export function cloneCompanionMergeRunSummary(run: CompanionMergeRunSummary): CompanionMergeRunSummary {
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

export function cloneCompanionMergeRunSummaries(
  runs: readonly CompanionMergeRunSummary[],
): CompanionMergeRunSummary[] {
  return runs.map(cloneCompanionMergeRunSummary);
}

export function cloneCompanionSessions(sessions: readonly CompanionSession[]): CompanionSession[] {
  return sessions.map(cloneCompanionSession);
}

export function createCompanionSessionSummary(
  session: CompanionSession,
  latestMergeRun: CompanionMergeRun | CompanionMergeRunSummary | null = null,
): CompanionSessionSummary {
  return {
    id: session.id,
    groupId: session.groupId,
    taskTitle: session.taskTitle,
    status: session.status,
    repoRoot: session.repoRoot,
    focusPath: session.focusPath,
    targetBranch: session.targetBranch,
    baseSnapshotRef: session.baseSnapshotRef,
    baseSnapshotCommit: session.baseSnapshotCommit,
    selectedPaths: [...session.selectedPaths],
    changedFiles: session.changedFiles.map((file) => ({ ...file })),
    siblingWarnings: session.siblingWarnings.map((warning) => ({
      ...warning,
      paths: [...warning.paths],
    })),
    allowedAdditionalDirectories: [...(session.allowedAdditionalDirectories ?? [])],
    runState: session.runState,
    threadId: session.threadId,
    provider: session.provider,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    approvalMode: session.approvalMode,
    codexSandboxMode: session.codexSandboxMode,
    character: session.character,
    characterRoleMarkdown: session.characterRoleMarkdown,
    characterIconPath: session.characterIconPath,
    characterThemeColors: { ...session.characterThemeColors },
    updatedAt: session.updatedAt,
    latestMergeRun: latestMergeRun
      ? "diffSnapshot" in latestMergeRun
        ? companionMergeRunToSummary(latestMergeRun)
        : cloneCompanionMergeRunSummary(latestMergeRun)
      : null,
  };
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
    allowedAdditionalDirectories: [...(summary.allowedAdditionalDirectories ?? [])],
    latestMergeRun: summary.latestMergeRun ? cloneCompanionMergeRunSummary(summary.latestMergeRun) : null,
    characterThemeColors: { ...summary.characterThemeColors },
  };
}

export function cloneCompanionSessionSummaries(
  summaries: readonly CompanionSessionSummary[],
): CompanionSessionSummary[] {
  return summaries.map(cloneCompanionSessionSummary);
}
