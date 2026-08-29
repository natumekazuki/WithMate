import type { Message } from "../src/session-state.js";

export type SessionRunningTurnStartInput = {
  sessionId: string;
  expectedMessageCount: number;
  userMessage: Message;
  updatedAt: string;
};
