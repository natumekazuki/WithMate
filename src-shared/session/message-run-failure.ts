import type { Message } from "./session-state.js";

/** Separate a stored application notice only when the terminal turn identifies this response. */
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
