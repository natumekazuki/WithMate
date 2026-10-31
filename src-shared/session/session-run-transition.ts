import type { Message } from "./session-state.js";
import { CONVERSATION_PAGE_SIZE } from "./conversation-page.js";

type OptimisticRunningSessionBase = {
  messages: Message[];
  messageCount?: number;
  runState: string;
  updatedAt: string;
};

export function createOptimisticRunningSessionState<TSession extends OptimisticRunningSessionBase>(
  session: TSession,
  userMessage: string,
  updatedAt: string,
  options: { status?: string } = {},
): TSession {
  const isConversationView = session.messageCount !== undefined;
  const messages: Message[] = [...session.messages, {
    role: "user",
    text: userMessage,
    ...(isConversationView ? { historyIndex: session.messageCount } : {}),
  }];
  return {
    ...session,
    ...(options.status !== undefined ? { status: options.status } : {}),
    updatedAt,
    runState: "running",
    ...(isConversationView ? { messageCount: session.messageCount! + 1 } : {}),
    messages: isConversationView ? messages.slice(-CONVERSATION_PAGE_SIZE) : messages,
  } as TSession;
}
