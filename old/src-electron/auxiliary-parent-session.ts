import type { CompanionSession } from "../src/companion-state.js";
import type { Session } from "../src/session-state.js";

type Awaitable<T> = T | Promise<T>;

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
    characterRuntimeSnapshot: session.characterRuntimeSnapshot,
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

export async function resolveAuxiliaryParentSession(input: {
  parentSessionId: string;
  getStoredSession: (sessionId: string) => Awaitable<Session | null>;
  getCachedSession: (sessionId: string) => Session | null;
  getCompanionSession: (sessionId: string) => Awaitable<CompanionSession | null>;
}): Promise<Session | null> {
  const storedSession = await input.getStoredSession(input.parentSessionId);
  if (storedSession) {
    return storedSession;
  }

  const cachedSession = input.getCachedSession(input.parentSessionId);
  if (cachedSession) {
    return cachedSession;
  }

  const companionSession = await input.getCompanionSession(input.parentSessionId);
  return companionSession ? companionSessionToAuxiliaryParentSession(companionSession) : null;
}
