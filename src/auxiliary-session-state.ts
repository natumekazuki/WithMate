import type { ApprovalMode } from "./approval-mode.js";
import {
  addAllowedAdditionalDirectory,
  removeAllowedAdditionalDirectory,
} from "./additional-directory-state.js";
import { normalizeCodexSandboxMode, type CodexSandboxMode } from "./codex-sandbox-mode.js";
import {
  resolveModelChangeSelection,
  resolveModelSelection,
  type ModelCatalogProvider,
  type ModelReasoningEffort,
} from "./model-catalog.js";
import { normalizeMessage, type Message } from "./session-state.js";

export type AuxiliarySessionStatus = "active" | "closed";

export type CreateAuxiliarySessionInput = {
  parentSessionId: string;
  provider: string;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  customAgentName?: string;
};

export type AuxiliarySession = {
  id: string;
  parentSessionId: string;
  status: AuxiliarySessionStatus;
  runState: "idle" | "running" | "error";
  title: string;
  provider: string;
  catalogRevision: number;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  approvalMode: ApprovalMode;
  codexSandboxMode: CodexSandboxMode;
  customAgentName: string;
  allowedAdditionalDirectories: string[];
  threadId: string;
  composerDraft: string;
  messages: Message[];
  displayAfterMessageIndex: number | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string;
};

export type AuxiliarySessionSummary = Omit<AuxiliarySession, "messages" | "composerDraft">;

export function applyAuxiliarySessionPatch(
  session: AuxiliarySession,
  patch: Partial<Omit<AuxiliarySession, "id" | "parentSessionId" | "createdAt" | "updatedAt">>,
  updatedAt: string,
): AuxiliarySession {
  return {
    ...session,
    ...patch,
    updatedAt,
  };
}

export function applyAuxiliarySessionRuntimeOptionsPatch(
  session: AuxiliarySession,
  patch: Partial<Pick<AuxiliarySession, "approvalMode" | "codexSandboxMode">>,
  updatedAt: string,
): AuxiliarySession {
  return applyAuxiliarySessionPatch(session, patch, updatedAt);
}

export function applyAuxiliarySessionModelSelectionPatch(
  session: AuxiliarySession,
  patch: Pick<AuxiliarySession, "catalogRevision" | "model" | "reasoningEffort">,
  updatedAt: string,
): AuxiliarySession {
  return applyAuxiliarySessionPatch(session, patch, updatedAt);
}

export function applyAuxiliarySessionModelChange(
  session: AuxiliarySession,
  providerCatalog: ModelCatalogProvider,
  model: string,
  catalogRevision: number,
  updatedAt: string,
): AuxiliarySession {
  const selection = resolveModelChangeSelection(providerCatalog, model, session.reasoningEffort);
  return applyAuxiliarySessionModelSelectionPatch(
    session,
    {
      catalogRevision,
      model: selection.resolvedModel,
      reasoningEffort: selection.resolvedReasoningEffort,
    },
    updatedAt,
  );
}

export function applyAuxiliarySessionReasoningEffortChange(
  session: AuxiliarySession,
  providerCatalog: ModelCatalogProvider,
  reasoningEffort: ModelReasoningEffort,
  catalogRevision: number,
  updatedAt: string,
): AuxiliarySession {
  const selection = resolveModelSelection(providerCatalog, session.model, reasoningEffort);
  return applyAuxiliarySessionModelSelectionPatch(
    session,
    {
      catalogRevision,
      model: selection.resolvedModel,
      reasoningEffort: selection.resolvedReasoningEffort,
    },
    updatedAt,
  );
}

export function addAuxiliarySessionAdditionalDirectory(
  session: AuxiliarySession,
  directoryPath: string,
  updatedAt: string,
): AuxiliarySession {
  return applyAuxiliarySessionPatch(
    session,
    { allowedAdditionalDirectories: addAllowedAdditionalDirectory(session.allowedAdditionalDirectories, directoryPath) },
    updatedAt,
  );
}

export function removeAuxiliarySessionAdditionalDirectory(
  session: AuxiliarySession,
  directoryPath: string,
  updatedAt: string,
): AuxiliarySession {
  return applyAuxiliarySessionPatch(
    session,
    { allowedAdditionalDirectories: removeAllowedAdditionalDirectory(session.allowedAdditionalDirectories, directoryPath) },
    updatedAt,
  );
}

export function applyAuxiliarySessionComposerDraftPatch(
  session: AuxiliarySession,
  composerDraft: string,
  updatedAt: string,
): AuxiliarySession {
  return applyAuxiliarySessionPatch(session, { composerDraft }, updatedAt);
}

export function applyAuxiliarySessionCustomAgentPatch(
  session: AuxiliarySession,
  customAgentName: string,
  updatedAt: string,
): AuxiliarySession {
  return applyAuxiliarySessionPatch(session, { customAgentName }, updatedAt);
}

export function buildAuxiliaryDraftSaveRequest(input: {
  currentSession: AuxiliarySession | null;
  targetSessionId: string;
  draft: string;
  updatedAt: string;
}): AuxiliarySession | null {
  if (
    !input.currentSession
    || input.currentSession.id !== input.targetSessionId
    || input.currentSession.composerDraft !== input.draft
  ) {
    return null;
  }

  return applyAuxiliarySessionComposerDraftPatch(input.currentSession, input.draft, input.updatedAt);
}

export type AuxiliarySessionSendTargetResolution = {
  blockedReason: "session-changed" | "running" | null;
  session: AuxiliarySession | null;
};

export type AuxiliarySessionSendPreflightResult = {
  blockedReason: "empty-message" | "running" | "composer-blocked" | null;
  blockedMessage: string;
  userMessage: string;
};

export function resolveAuxiliarySessionSendPreflight(input: {
  activeSession: AuxiliarySession;
  composerBlockedReason?: string | null;
  messageText: string;
}): AuxiliarySessionSendPreflightResult {
  const userMessage = input.messageText.trim();
  if (!userMessage) {
    return {
      blockedReason: "empty-message",
      blockedMessage: "送信するメッセージが空だよ。",
      userMessage,
    };
  }
  if (input.activeSession.runState === "running") {
    return {
      blockedReason: "running",
      blockedMessage: "Auxiliary Session はまだ実行中だよ。",
      userMessage,
    };
  }
  if (input.composerBlockedReason) {
    return {
      blockedReason: "composer-blocked",
      blockedMessage: input.composerBlockedReason,
      userMessage,
    };
  }

  return {
    blockedReason: null,
    blockedMessage: "",
    userMessage,
  };
}

export function resolveAuxiliarySessionSendTarget(input: {
  activeSession: AuxiliarySession;
  currentSession: AuxiliarySession | null;
}): AuxiliarySessionSendTargetResolution {
  const currentSession = input.currentSession ?? input.activeSession;
  if (currentSession.id !== input.activeSession.id) {
    return {
      blockedReason: "session-changed",
      session: null,
    };
  }
  if (currentSession.runState === "running") {
    return {
      blockedReason: "running",
      session: null,
    };
  }

  return {
    blockedReason: null,
    session: currentSession,
  };
}

export function resolveEditableActiveAuxiliarySession(input: {
  activeSession: AuxiliarySession;
  currentSession: AuxiliarySession | null;
}): AuxiliarySession | null {
  const currentSession = input.currentSession ?? input.activeSession;
  if (currentSession.id !== input.activeSession.id || currentSession.runState === "running") {
    return null;
  }

  return currentSession;
}

export function buildEditableActiveAuxiliarySessionPatch(input: {
  activeSession: AuxiliarySession;
  currentSession: AuxiliarySession | null;
  recipe: (current: AuxiliarySession) => AuxiliarySession;
}): AuxiliarySession | null {
  const currentSession = resolveEditableActiveAuxiliarySession({
    activeSession: input.activeSession,
    currentSession: input.currentSession,
  });
  if (!currentSession) {
    return null;
  }

  return input.recipe(currentSession);
}

export function resolveActiveAuxiliarySessionRefreshResult(input: {
  currentSession: AuxiliarySession | null;
  savedSession: AuxiliarySession | null;
  sessionId: string;
}): AuxiliarySession | null {
  if (input.currentSession?.id !== input.sessionId) {
    return input.currentSession;
  }

  if (
    input.currentSession.runState === "running"
    && input.savedSession
    && input.savedSession.runState !== "running"
    && (
      input.savedSession.messages.length < input.currentSession.messages.length
      || input.savedSession.updatedAt < input.currentSession.updatedAt
    )
  ) {
    return input.currentSession;
  }

  if (
    !input.savedSession
    || input.savedSession.runState !== "running"
    || input.currentSession.runState !== "running"
  ) {
    return input.savedSession;
  }

  return input.currentSession;
}

export function resolveAuxiliarySessionDisplayAfterMessageIndex(input: {
  auxiliaryMessageCount: number;
  currentDisplayAfterMessageIndex: number | null;
  parentMessageCount: number | null;
}): number | null {
  return input.auxiliaryMessageCount === 0 && input.parentMessageCount !== null
    ? input.parentMessageCount - 1
    : input.currentDisplayAfterMessageIndex;
}

export function resolveClosedAuxiliarySessionIds(summaries: AuxiliarySessionSummary[]): string[] {
  return summaries
    .filter((summary) => summary.status === "closed")
    .reverse()
    .map((summary) => summary.id);
}

export function resolveClosedAuxiliarySessionsLoadResult(
  sessions: Array<AuxiliarySession | null>,
): AuxiliarySession[] {
  return sessions.filter((session): session is AuxiliarySession => session !== null);
}

export function resolveClosedAuxiliarySessionsAfterReturn(
  currentSessions: AuxiliarySession[],
  closedSession: AuxiliarySession,
): AuxiliarySession[] {
  return [
    ...currentSessions.filter((session) => session.id !== closedSession.id),
    closedSession,
  ];
}

export async function loadClosedAuxiliarySessionDetails(input: {
  parentSessionId: string;
  listAuxiliarySessions: (parentSessionId: string) => Promise<AuxiliarySessionSummary[]>;
  getAuxiliarySession: (sessionId: string) => Promise<AuxiliarySession | null>;
}): Promise<AuxiliarySession[]> {
  const summaries = await input.listAuxiliarySessions(input.parentSessionId);
  const closedSessionIds = resolveClosedAuxiliarySessionIds(summaries);
  const sessions = await Promise.all(
    closedSessionIds.map((sessionId) => input.getAuxiliarySession(sessionId)),
  );
  return resolveClosedAuxiliarySessionsLoadResult(sessions);
}

export function buildRunningAuxiliarySessionTurn(input: {
  session: AuxiliarySession;
  userMessage: string;
  displayAfterMessageIndex: number | null;
  updatedAt: string;
}): AuxiliarySession {
  return {
    ...input.session,
    runState: "running",
    composerDraft: "",
    updatedAt: input.updatedAt,
    messages: [...input.session.messages, { role: "user", text: input.userMessage }],
    displayAfterMessageIndex: input.displayAfterMessageIndex,
  };
}

export function buildAuxiliarySessionRunningTransition(input: {
  session: AuxiliarySession;
  userMessage: string;
  parentMessageCount: number | null;
  updatedAt: string;
}): {
  anchorUpdateSession: AuxiliarySession | null;
  runningSession: AuxiliarySession;
} {
  const displayAfterMessageIndex = resolveAuxiliarySessionDisplayAfterMessageIndex({
    auxiliaryMessageCount: input.session.messages.length,
    currentDisplayAfterMessageIndex: input.session.displayAfterMessageIndex,
    parentMessageCount: input.parentMessageCount,
  });

  return {
    anchorUpdateSession: displayAfterMessageIndex !== input.session.displayAfterMessageIndex
      ? { ...input.session, displayAfterMessageIndex }
      : null,
    runningSession: buildRunningAuxiliarySessionTurn({
      session: input.session,
      userMessage: input.userMessage,
      displayAfterMessageIndex,
      updatedAt: input.updatedAt,
    }),
  };
}

export function normalizeAuxiliarySession(value: unknown): AuxiliarySession | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<AuxiliarySession>;
  if (typeof candidate.id !== "string" || !candidate.id.trim()) {
    return null;
  }
  if (typeof candidate.parentSessionId !== "string" || !candidate.parentSessionId.trim()) {
    return null;
  }

  return {
    id: candidate.id.trim(),
    parentSessionId: candidate.parentSessionId.trim(),
    status: candidate.status === "closed" ? "closed" : "active",
    runState:
      candidate.runState === "running" || candidate.runState === "error"
        ? candidate.runState
        : "idle",
    title: typeof candidate.title === "string" ? candidate.title : "",
    provider: typeof candidate.provider === "string" ? candidate.provider : "codex",
    catalogRevision: typeof candidate.catalogRevision === "number" ? candidate.catalogRevision : 1,
    model: typeof candidate.model === "string" ? candidate.model : "",
    reasoningEffort:
      candidate.reasoningEffort === "minimal" ||
      candidate.reasoningEffort === "low" ||
      candidate.reasoningEffort === "medium" ||
      candidate.reasoningEffort === "high" ||
      candidate.reasoningEffort === "xhigh"
        ? candidate.reasoningEffort
        : "medium",
    approvalMode:
      candidate.approvalMode === "never" ||
      candidate.approvalMode === "on-request" ||
      candidate.approvalMode === "on-failure"
      || candidate.approvalMode === "untrusted"
        ? candidate.approvalMode
        : "untrusted",
    codexSandboxMode: normalizeCodexSandboxMode(candidate.codexSandboxMode),
    customAgentName: typeof candidate.customAgentName === "string" ? candidate.customAgentName : "",
    allowedAdditionalDirectories: Array.isArray(candidate.allowedAdditionalDirectories)
      ? candidate.allowedAdditionalDirectories.filter((entry): entry is string => typeof entry === "string")
      : [],
    threadId: typeof candidate.threadId === "string" ? candidate.threadId : "",
    composerDraft: typeof candidate.composerDraft === "string" ? candidate.composerDraft : "",
    messages: Array.isArray(candidate.messages)
      ? candidate.messages
          .map((message) => normalizeMessage(message))
          .filter((message): message is Message => message !== null)
      : [],
    displayAfterMessageIndex:
      typeof candidate.displayAfterMessageIndex === "number" && Number.isInteger(candidate.displayAfterMessageIndex)
        ? candidate.displayAfterMessageIndex
        : null,
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : "",
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : "",
    closedAt: typeof candidate.closedAt === "string" ? candidate.closedAt : "",
  };
}

export function projectAuxiliarySessionSummary(session: AuxiliarySession): AuxiliarySessionSummary {
  const { messages: _messages, composerDraft: _composerDraft, ...summary } = session;
  return summary;
}
