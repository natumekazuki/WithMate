import { normalizeApprovalMode, type ApprovalMode } from "./approval-mode.js";
import {
  addAllowedAdditionalDirectory,
  removeAllowedAdditionalDirectory,
} from "./additional-directory-state.js";
import { normalizeCodexSandboxMode, type CodexSandboxMode } from "./codex-sandbox-mode.js";
import { normalizeCodexSpeed, type CodexSpeed } from "./codex-speed.js";
import { normalizeCodexReviewer, type CodexReviewer } from "./codex-reviewer.js";
import {
  isModelReasoningEffort,
  resolveModelChangeSelection,
  resolveModelSelection,
  type ModelCatalogProvider,
  type ModelReasoningEffort,
} from "./model-catalog.js";
import { normalizeMessage, type Message } from "./session-state.js";
import {
  normalizeCharacterRuntimeSnapshot,
} from "./character/character-runtime-snapshot.js";
import type { CharacterRuntimeSnapshot } from "./character/character-catalog.js";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export type AuxiliarySessionStatus = "active" | "closed";
export type AuxiliaryRuntimeSelectionMode = "explicit" | "latest-session";

export type CreateAuxiliarySessionInput = {
  parentSessionId: string;
  provider: string;
  runtimeSelection?: AuxiliaryRuntimeSelectionMode;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  approvalMode?: ApprovalMode;
  codexSandboxMode?: CodexSandboxMode;
  codexSpeed?: CodexSpeed;
  customAgentName?: string;
  /** Stable key used to make a retried create operation return the same row. */
  clientRequestId?: string;
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
  codexSpeed: CodexSpeed;
  codexReviewer: CodexReviewer;
  customAgentName: string;
  allowedAdditionalDirectories: string[];
  threadId: string;
  composerDraft: string;
  messages: Message[];
  displayAfterMessageIndex: number | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string;
  /** Character identity is fixed when the Auxiliary is created. Legacy rows omit it. */
  characterId?: string;
  characterRuntimeSnapshot?: CharacterRuntimeSnapshot | null;
  /** Internal migration marker: a present, malformed new snapshot must not fall back to parent identity. */
  characterRuntimeSnapshotInvalid?: boolean;
  characterIconPath?: string;
  /** Deterministic, non-AI projection used by the lightweight list. */
  preview?: string;
  clientRequestId?: string;
};

export type AuxiliarySessionSummary = Omit<
  AuxiliarySession,
  "messages" | "composerDraft" | "characterRuntimeSnapshot" | "characterRuntimeSnapshotInvalid"
>;

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
  patch: Partial<Pick<AuxiliarySession, "approvalMode" | "codexSandboxMode" | "codexSpeed" | "codexReviewer">>,
  updatedAt: string,
): AuxiliarySession {
  return applyAuxiliarySessionPatch(session, patch, updatedAt);
}

export function applyAuxiliarySessionApprovalModeChange(
  session: AuxiliarySession,
  approvalMode: ApprovalMode,
  updatedAt: string,
): AuxiliarySession {
  return applyAuxiliarySessionRuntimeOptionsPatch(session, { approvalMode }, updatedAt);
}

export function applyAuxiliarySessionCodexSandboxModeChange(
  session: AuxiliarySession,
  codexSandboxMode: CodexSandboxMode,
  updatedAt: string,
): AuxiliarySession {
  return applyAuxiliarySessionRuntimeOptionsPatch(session, { codexSandboxMode }, updatedAt);
}

export function applyAuxiliarySessionCodexSpeedChange(
  session: AuxiliarySession,
  codexSpeed: CodexSpeed,
  updatedAt: string,
): AuxiliarySession {
  return applyAuxiliarySessionRuntimeOptionsPatch(session, { codexSpeed }, updatedAt);
}

export function applyAuxiliarySessionCodexReviewerChange(
  session: AuxiliarySession,
  codexReviewer: CodexReviewer,
  updatedAt: string,
): AuxiliarySession {
  return applyAuxiliarySessionRuntimeOptionsPatch(session, { codexReviewer }, updatedAt);
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

  const hasStoredSnapshot = Object.prototype.hasOwnProperty.call(candidate, "characterRuntimeSnapshot");
  const normalizedCharacterRuntimeSnapshot = normalizeCharacterRuntimeSnapshot(candidate.characterRuntimeSnapshot);
  const normalizedCharacterId = typeof candidate.characterId === "string" ? candidate.characterId.trim() : undefined;
  const characterRuntimeSnapshotInvalid = candidate.characterRuntimeSnapshotInvalid === true
    || candidate.characterRuntimeSnapshot == null && Boolean(normalizedCharacterId)
    || hasStoredSnapshot && (
    (candidate.characterRuntimeSnapshot != null && (
      !normalizedCharacterRuntimeSnapshot
      || !normalizedCharacterId
      || normalizedCharacterId !== normalizedCharacterRuntimeSnapshot.characterId
    ))
  );
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
    reasoningEffort: isModelReasoningEffort(candidate.reasoningEffort)
      ? candidate.reasoningEffort
      : "medium",
    approvalMode: normalizeApprovalMode(candidate.approvalMode),
    codexSandboxMode: normalizeCodexSandboxMode(candidate.codexSandboxMode),
    codexSpeed: normalizeCodexSpeed(candidate.codexSpeed),
    codexReviewer: normalizeCodexReviewer(candidate.codexReviewer),
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
    characterId: normalizedCharacterId,
    characterRuntimeSnapshot: normalizedCharacterRuntimeSnapshot,
    characterRuntimeSnapshotInvalid,
    characterIconPath: typeof candidate.characterIconPath === "string" ? candidate.characterIconPath : undefined,
    preview: typeof candidate.preview === "string" ? candidate.preview : undefined,
    clientRequestId: typeof candidate.clientRequestId === "string"
      ? candidate.clientRequestId.trim()
      : typeof (candidate as { requestId?: unknown }).requestId === "string"
        ? (candidate as { requestId: string }).requestId.trim()
        : undefined,
  };
}

export function projectAuxiliarySessionSummary(session: AuxiliarySession): AuxiliarySessionSummary {
  const {
    messages: _messages,
    composerDraft: _composerDraft,
    characterRuntimeSnapshot: _characterRuntimeSnapshot,
    characterRuntimeSnapshotInvalid: _characterRuntimeSnapshotInvalid,
    ...summary
  } = session;
  return {
    ...summary,
    characterIconPath: session.characterIconPath ?? session.characterRuntimeSnapshot?.iconFilePath ?? "",
    preview: session.preview ?? buildAuxiliaryPreview(session.messages),
  };
}

export const AUXILIARY_PREVIEW_DEFAULT = "新しい会話";
export const AUXILIARY_PREVIEW_MAX_LENGTH = 240;

function flattenAuxiliaryPreviewMarkdown(value: string): string {
  const tree = fromMarkdown(value, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  type PreviewNode = { type: string; value?: string; alt?: string | null; children?: PreviewNode[] };
  const plainText = (node: PreviewNode): string => {
    if (node.type === "definition") return "";
    if (node.type === "break") return " ";
    if (node.type === "image") return node.alt ?? "";
    if (typeof node.value === "string") return node.value;
    const separator = ["root", "blockquote", "list", "listItem", "table", "tableRow"].includes(node.type) ? " " : "";
    return node.children?.map(plainText).join(separator) ?? "";
  };
  return plainText(tree).replace(/\s+/g, " ").trim();
}

function clipAuxiliaryPreview(value: string): string {
  const normalized = flattenAuxiliaryPreviewMarkdown(value);
  if (!normalized) {
    return "";
  }
  return Array.from(normalized).slice(0, AUXILIARY_PREVIEW_MAX_LENGTH).join("");
}

/**
 * Builds the list projection without invoking a provider. Accent assistant messages
 * are status/tool/error blocks in the current message contract and are excluded.
 */
export function buildAuxiliaryPreview(
  messages: readonly Message[],
  confirmedFinalAssistantText?: string | null,
): string {
  const confirmedPreview = confirmedFinalAssistantText == null
    ? ""
    : clipAuxiliaryPreview(confirmedFinalAssistantText);
  if (confirmedPreview) {
    return confirmedPreview;
  }
  const latestUser = [...messages]
    .reverse()
    .find((message) => message.role === "user" && clipAuxiliaryPreview(message.text));
  return latestUser ? clipAuxiliaryPreview(latestUser.text) || AUXILIARY_PREVIEW_DEFAULT : AUXILIARY_PREVIEW_DEFAULT;
}

/** Preserve the last confirmed projection while a new turn is streaming or fails. */
export function resolveAuxiliaryPreview(
  messages: readonly Message[],
  previousPreview?: string | null,
  confirmedFinalAssistantText?: string | null,
): string {
  if (confirmedFinalAssistantText?.trim()) {
    return buildAuxiliaryPreview(messages, confirmedFinalAssistantText);
  }
  if (previousPreview?.trim() && previousPreview !== AUXILIARY_PREVIEW_DEFAULT) {
    return previousPreview;
  }
  return buildAuxiliaryPreview(messages);
}
