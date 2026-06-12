import type { AuxiliarySession } from "./auxiliary-session-state.js";
import type { Message } from "./session-state.js";

export type MessageListSource =
  | {
      kind: "session";
      messageIndex: number;
    }
  | {
      kind: "auxiliary";
      sessionId: string;
      messageIndex: number;
      artifact: Message["artifact"];
    }
  | {
      kind: "live-assistant";
      sessionId: string;
      threadId: string | null;
    };

export type MessageListProjection = {
  messages: Message[];
  sources: MessageListSource[];
  keys: string[];
  groups: Array<MessageListGroup | null>;
};

export type MessageListGroup = {
  id: string;
  label: string;
};

type ProjectedMessageArtifact = NonNullable<Message["artifact"]>;

type PendingAuxiliaryMessageGroupSession = Pick<AuxiliarySession, "id" | "runState">;

export type LiveAssistantProjection = {
  sessionId: string;
  threadId: string | null;
  messageIndex: number;
  text: string;
};

export type MessageListProjectionOptions = {
  liveAssistant?: LiveAssistantProjection | null;
};

export type LiveAssistantBridgeProjectionInput = {
  bridge: LiveAssistantProjection | null | undefined;
  activeSessionId: string | null | undefined;
  hasLiveRun: boolean;
  hasPersistedAssistant: boolean;
};

export type LoadProjectedMessageArtifactOptions = {
  source: MessageListSource | undefined;
  loadSessionArtifact: (
    messageIndex: number,
  ) => ProjectedMessageArtifact | null | undefined | Promise<ProjectedMessageArtifact | null | undefined>;
};

export function loadProjectedMessageArtifact({
  source,
  loadSessionArtifact,
}: LoadProjectedMessageArtifactOptions): Promise<ProjectedMessageArtifact | null> {
  if (!source) {
    return Promise.resolve(null);
  }

  if (source.kind === "auxiliary") {
    return Promise.resolve(source.artifact ?? null);
  }

  if (source.kind === "live-assistant") {
    return Promise.resolve(null);
  }

  return Promise.resolve(loadSessionArtifact(source.messageIndex)).then((artifact) => artifact ?? null);
}

export function resolvePendingAuxiliaryMessageGroupId(
  auxiliarySession: PendingAuxiliaryMessageGroupSession | null | undefined,
): string | null {
  return auxiliarySession?.runState === "running" ? auxiliarySession.id : null;
}

export function buildMessageListProjection(
  sessionMessages: Message[],
  auxiliarySessions: AuxiliarySession[],
  sessionId = "session",
  options: MessageListProjectionOptions = {},
): MessageListProjection {
  const messages: Message[] = [];
  const sources: MessageListSource[] = [];
  const keys: string[] = [];
  const groups: Array<MessageListGroup | null> = [];
  const auxiliaryBuckets = new Map<number, AuxiliarySession[]>();
  const fallbackAuxiliarySessions: AuxiliarySession[] = [];
  const liveAssistant = normalizeLiveAssistantProjection(options.liveAssistant);
  const liveAssistantKey = liveAssistant
    ? buildLiveAssistantProjectionKey(liveAssistant.sessionId, liveAssistant.threadId, liveAssistant.messageIndex)
    : null;

  const addSessionMessage = (message: Message, messageIndex: number) => {
    messages.push(message);
    sources.push({ kind: "session", messageIndex });
    keys.push(isMatchingPersistedLiveAssistantMessage({
      message,
      messageIndex,
      messageCount: sessionMessages.length,
      targetSessionId: sessionId,
      liveAssistant,
    }) && liveAssistantKey
      ? liveAssistantKey
      : `session-${sessionId}-${messageIndex}`);
    groups.push(null);
  };

  const addAuxiliarySession = (auxiliarySession: AuxiliarySession) => {
    const group = {
      id: auxiliarySession.id,
      label: "Auxiliary",
    };
    auxiliarySession.messages.forEach((message, messageIndex) => {
      messages.push({
        ...message,
        accent: true,
      });
      sources.push({
        kind: "auxiliary",
        sessionId: auxiliarySession.id,
        messageIndex,
        artifact: message.artifact,
      });
      keys.push(isMatchingPersistedLiveAssistantMessage({
        message,
        messageIndex,
        messageCount: auxiliarySession.messages.length,
        targetSessionId: auxiliarySession.id,
        liveAssistant,
      }) && liveAssistantKey
        ? liveAssistantKey
        : `auxiliary-${auxiliarySession.id}-${messageIndex}`);
      groups.push(group);
    });

    if (
      liveAssistant &&
      liveAssistant.sessionId === auxiliarySession.id &&
      !hasPersistedLiveAssistantMessage(sessionMessages, [auxiliarySession], liveAssistant, sessionId)
    ) {
      addLiveAssistantMessage(group);
    }
  };

  const addLiveAssistantMessage = (group: MessageListGroup | null) => {
    if (!liveAssistant || !liveAssistantKey) {
      return;
    }

    messages.push({
      role: "assistant",
      text: liveAssistant.text,
      ...(group ? { accent: true } : {}),
    });
    sources.push({
      kind: "live-assistant",
      sessionId: liveAssistant.sessionId,
      threadId: liveAssistant.threadId,
    });
    keys.push(liveAssistantKey);
    groups.push(group);
  };

  const sortedAuxiliarySessions = [...auxiliarySessions].sort(compareAuxiliarySessions);
  for (const auxiliarySession of sortedAuxiliarySessions) {
    if (auxiliarySession.displayAfterMessageIndex === null) {
      fallbackAuxiliarySessions.push(auxiliarySession);
      continue;
    }

    const maxAnchor = sessionMessages.length - 1;
    const displayAfterMessageIndex = sessionMessages.length === 0
      ? -1
      : Math.min(Math.max(auxiliarySession.displayAfterMessageIndex, -1), maxAnchor);
    auxiliaryBuckets.set(displayAfterMessageIndex, [
      ...(auxiliaryBuckets.get(displayAfterMessageIndex) ?? []),
      auxiliarySession,
    ]);
  }

  for (let index = -1; index < sessionMessages.length; index += 1) {
    if (index >= 0) {
      addSessionMessage(sessionMessages[index], index);
    }

    for (const auxiliarySession of auxiliaryBuckets.get(index) ?? []) {
      addAuxiliarySession(auxiliarySession);
    }
  }

  for (const auxiliarySession of fallbackAuxiliarySessions) {
    addAuxiliarySession(auxiliarySession);
  }

  if (
    liveAssistant &&
    liveAssistantKey &&
    liveAssistant.sessionId === sessionId &&
    !hasPersistedLiveAssistantMessage(sessionMessages, auxiliarySessions, liveAssistant, sessionId)
  ) {
    addLiveAssistantMessage(null);
  }

  return { messages, sources, keys, groups };
}

export function buildLiveAssistantProjectionKey(
  sessionId: string,
  threadId: string | null,
  messageIndex: number,
): string {
  return `live-assistant-${sessionId}-${messageIndex}-${threadId || "pending"}`;
}

export function hasPersistedLiveAssistantMessage(
  sessionMessages: Message[],
  auxiliarySessions: AuxiliarySession[],
  liveAssistant: LiveAssistantProjection | null | undefined,
  sessionId = "session",
): boolean {
  const normalizedLiveAssistant = normalizeLiveAssistantProjection(liveAssistant);
  if (!normalizedLiveAssistant) {
    return false;
  }

  if (
    normalizedLiveAssistant.sessionId === sessionId &&
    hasAssistantMessageAtIndex(sessionMessages, normalizedLiveAssistant.messageIndex)
  ) {
    return true;
  }

  return auxiliarySessions.some((auxiliarySession) =>
    auxiliarySession.id === normalizedLiveAssistant.sessionId &&
    hasAssistantMessageAtIndex(auxiliarySession.messages, normalizedLiveAssistant.messageIndex)
  );
}

export function resolveLiveAssistantMessageIndex(
  sessionMessages: Message[],
  auxiliarySessions: AuxiliarySession[],
  targetSessionId: string,
  sessionId = "session",
): number {
  if (targetSessionId === sessionId) {
    return sessionMessages.length;
  }

  const targetAuxiliarySession = auxiliarySessions.find((auxiliarySession) => auxiliarySession.id === targetSessionId);
  return targetAuxiliarySession?.messages.length ?? 0;
}

export function shouldProjectLiveAssistantBridge({
  bridge,
  activeSessionId,
  hasLiveRun,
  hasPersistedAssistant,
}: LiveAssistantBridgeProjectionInput): boolean {
  return !!bridge && bridge.sessionId === activeSessionId && (hasLiveRun || hasPersistedAssistant);
}

function normalizeLiveAssistantProjection(
  liveAssistant: LiveAssistantProjection | null | undefined,
): LiveAssistantProjection | null {
  if (!liveAssistant || !liveAssistant.text || !Number.isInteger(liveAssistant.messageIndex)) {
    return null;
  }

  return {
    ...liveAssistant,
    messageIndex: Math.max(0, liveAssistant.messageIndex),
  };
}

function isMatchingPersistedLiveAssistantMessage({
  message,
  messageIndex,
  messageCount,
  targetSessionId,
  liveAssistant,
}: {
  message: Message;
  messageIndex: number;
  messageCount: number;
  targetSessionId: string;
  liveAssistant: LiveAssistantProjection | null;
}): boolean {
  return (
    liveAssistant?.sessionId === targetSessionId &&
    messageIndex === liveAssistant.messageIndex &&
    messageIndex < messageCount &&
    message.role === "assistant"
  );
}

function hasAssistantMessageAtIndex(messages: Message[], messageIndex: number): boolean {
  return messages[messageIndex]?.role === "assistant";
}

function compareAuxiliarySessions(left: AuxiliarySession, right: AuxiliarySession): number {
  const leftCreatedAt = Date.parse(left.createdAt);
  const rightCreatedAt = Date.parse(right.createdAt);
  const createdAtComparison = safeTimestamp(leftCreatedAt) - safeTimestamp(rightCreatedAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return left.id.localeCompare(right.id);
}

function safeTimestamp(value: number): number {
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}
