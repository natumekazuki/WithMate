import type { ApprovalMode } from "./approval-mode.js";
import type { CodexSandboxMode } from "./codex-sandbox-mode.js";
import type { ModelReasoningEffort } from "./model-catalog.js";

export type CompanionSessionStatus = "active" | "merged" | "discarded" | "recovery-required";

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
  provider: string;
  catalogRevision: number;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  customAgentName: string;
  approvalMode: ApprovalMode;
  codexSandboxMode: CodexSandboxMode;
  characterId: string;
  character: string;
  characterIconPath: string;
  characterThemeColors: {
    main: string;
    sub: string;
  };
  createdAt: string;
  updatedAt: string;
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
  | "provider"
  | "model"
  | "reasoningEffort"
  | "approvalMode"
  | "codexSandboxMode"
  | "character"
  | "characterIconPath"
  | "characterThemeColors"
  | "updatedAt"
>;

export function cloneCompanionSession(session: CompanionSession): CompanionSession {
  return {
    ...session,
    characterThemeColors: { ...session.characterThemeColors },
  };
}

export function cloneCompanionSessions(sessions: readonly CompanionSession[]): CompanionSession[] {
  return sessions.map(cloneCompanionSession);
}

export function cloneCompanionSessionSummary(summary: CompanionSessionSummary): CompanionSessionSummary {
  return {
    ...summary,
    characterThemeColors: { ...summary.characterThemeColors },
  };
}

export function cloneCompanionSessionSummaries(
  summaries: readonly CompanionSessionSummary[],
): CompanionSessionSummary[] {
  return summaries.map(cloneCompanionSessionSummary);
}
