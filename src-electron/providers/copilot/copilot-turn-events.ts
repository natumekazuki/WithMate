import type { SessionEvent } from "@github/copilot-sdk";

type CopilotAssistantEvent =
  | Extract<SessionEvent, { type: "assistant.message_delta" }>
  | Extract<SessionEvent, { type: "assistant.message" }>;

function appendUniqueMessage(messages: string[], nextMessage: string): string[] {
  const normalized = nextMessage.trim();
  if (!normalized) {
    return messages;
  }

  if (messages[messages.length - 1] === normalized) {
    return messages;
  }

  return [...messages, normalized];
}

function buildAssistantResponse(messages: string[], draft: string): {
  assistantText: string;
  lastNonEmptyAssistantMessageText: string;
} {
  const parts = [...messages];
  const normalizedDraft = draft.trim();
  if (normalizedDraft) {
    parts.push(normalizedDraft);
  }

  return {
    assistantText: parts.join("\n\n"),
    lastNonEmptyAssistantMessageText: parts.at(-1) ?? "",
  };
}

export function applyCopilotAssistantEvent(
  messages: string[],
  draft: string,
  event: CopilotAssistantEvent,
): {
  messages: string[];
  draft: string;
  assistantText: string;
  lastNonEmptyAssistantMessageText: string;
} {
  if (event.agentId || event.data.parentToolCallId) {
    return {
      messages,
      draft,
      ...buildAssistantResponse(messages, draft),
    };
  }

  if (event.type === "assistant.message_delta") {
    const nextDraft = draft + event.data.deltaContent;
    return {
      messages,
      draft: nextDraft,
      ...buildAssistantResponse(messages, nextDraft),
    };
  }

  const content = event.data.content.trim();
  if (!content) {
    return {
      messages,
      draft: "",
      ...buildAssistantResponse(messages, ""),
    };
  }

  const draftTrimmed = draft.trim();
  const finalizedMessages = draftTrimmed && draftTrimmed === content
    ? appendUniqueMessage(messages, draftTrimmed)
    : appendUniqueMessage(messages, content);

  return {
    messages: finalizedMessages,
    draft: "",
    ...buildAssistantResponse(finalizedMessages, ""),
  };
}
