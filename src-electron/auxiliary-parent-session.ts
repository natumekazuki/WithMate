import type { CompanionSession } from "../src/companion-state.js";
import type { Session } from "../src/session-state.js";

export function companionSessionToAuxiliaryParentSession(session: CompanionSession): Session | null {
  if (session.status !== "active" && session.status !== "recovery-required") {
    return null;
  }

  return {
    id: session.id,
    taskTitle: session.taskTitle,
    status: session.runState === "running" ? "running" : "idle",
    updatedAt: session.updatedAt,
    provider: session.provider,
    catalogRevision: session.catalogRevision,
    workspaceLabel: session.repoRoot || session.worktreePath,
    workspacePath: session.worktreePath,
    branch: session.companionBranch || session.targetBranch,
    sessionKind: "default",
    accessMode: "active",
    sourceSchemaVersion: 4,
    characterId: session.characterId,
    character: session.character,
    characterIconPath: session.characterIconPath,
    characterThemeColors: { ...session.characterThemeColors },
    runState: session.runState,
    approvalMode: session.approvalMode,
    codexSandboxMode: session.codexSandboxMode,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    customAgentName: session.customAgentName,
    allowedAdditionalDirectories: [...(session.allowedAdditionalDirectories ?? [])],
    threadId: session.threadId,
    messages: session.messages,
    stream: [],
  };
}
