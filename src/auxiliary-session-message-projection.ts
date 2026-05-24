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

export function buildMessageListProjection(
  sessionMessages: Message[],
  auxiliarySessions: AuxiliarySession[],
  sessionId = "session",
): MessageListProjection {
  const messages: Message[] = [];
  const sources: MessageListSource[] = [];
  const keys: string[] = [];
  const groups: Array<MessageListGroup | null> = [];
  const auxiliaryBuckets = new Map<number, AuxiliarySession[]>();
  const fallbackAuxiliarySessions: AuxiliarySession[] = [];

  const addSessionMessage = (message: Message, messageIndex: number) => {
    messages.push(message);
    sources.push({ kind: "session", messageIndex });
    keys.push(`session-${sessionId}-${messageIndex}`);
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
      keys.push(`auxiliary-${auxiliarySession.id}-${messageIndex}`);
      groups.push(group);
    });
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

  return { messages, sources, keys, groups };
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
