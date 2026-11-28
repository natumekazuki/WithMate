import type { Message } from "./session-state.js";
import { CONVERSATION_PAGE_SIZE } from "./conversation-page.js";

/** 送信直後の暫定表示に必要な履歴・実行状態と、ページ式の表示なら総件数。 */
type OptimisticRunningSessionBase = {
  messages: Message[];
  messageCount?: number;
  runState: string;
  updatedAt: string;
};

/** 送った本文と実行中表示を暫定反映し、ページ式なら総件数と末尾ページを更新する。 */
export function createOptimisticRunningSessionState<
  TSession extends OptimisticRunningSessionBase,
>(
  session: TSession,
  userMessage: string,
  updatedAt: string,
  options: { status?: string } = {},
): TSession {
  const isConversationView = session.messageCount !== undefined;
  const messages: Message[] = [
    ...session.messages,
    {
      role: "user",
      text: userMessage,
      ...(isConversationView ? { historyIndex: session.messageCount } : {}),
    },
  ];
  return {
    ...session,
    ...(options.status !== undefined ? { status: options.status } : {}),
    updatedAt,
    runState: "running",
    ...(isConversationView ? { messageCount: session.messageCount! + 1 } : {}),
    messages: isConversationView
      ? messages.slice(-CONVERSATION_PAGE_SIZE)
      : messages,
  } as TSession;
}
