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
  boundaries: Array<MessageListBoundary | null>;
};

export type MessageListBoundary = {
  label: string;
  statusLabel: string;
};

export function buildMessageListProjection(
  sessionMessages: Message[],
  auxiliarySessions: AuxiliarySession[],
  sessionId = "session",
): MessageListProjection {
  const messages: Message[] = [];
  const sources: MessageListSource[] = [];
  const keys: string[] = [];
  const boundaries: Array<MessageListBoundary | null> = [];

  sessionMessages.forEach((message, messageIndex) => {
    messages.push(message);
    sources.push({ kind: "session", messageIndex });
    keys.push(`session-${sessionId}-${messageIndex}`);
    boundaries.push(null);
  });

  for (const auxiliarySession of auxiliarySessions) {
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
      boundaries.push(messageIndex === 0
        ? {
            label: "Auxiliary",
            statusLabel: auxiliarySession.status === "active" ? "Active" : "Closed",
          }
        : null);
    });
  }

  return { messages, sources, keys, boundaries };
}
