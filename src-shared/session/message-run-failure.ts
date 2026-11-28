import type { Message } from "./session-state.js";

/** 終了した Turn がこの応答を指す場合に限り、保存済みのアプリケーション通知を分離する。 */
export function withMessageRunFailure(message: Message, reason: string | null | undefined): Message {
  if (message.role !== "assistant" || message.runFailure !== undefined || reason == null) return message;
  const notices = [`The run failed.\n${reason}`, reason];
  for (const notice of notices) {
    if (!notice) continue;
    if (message.text === notice) return { ...message, text: "", runFailure: reason };
    if (message.text.endsWith(`\n\n${notice}`)) {
      return { ...message, text: message.text.slice(0, -(notice.length + 2)), runFailure: reason };
    }
  }
  return { ...message, runFailure: reason };
}
