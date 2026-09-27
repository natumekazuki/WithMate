import type { Message } from "./session-state.js";

type OptimisticRunningSessionBase = {
  messages: Message[];
  runState: string;
  updatedAt: string;
};

export function createOptimisticRunningSessionState<TSession extends OptimisticRunningSessionBase>(
  session: TSession,
  userMessage: string,
  updatedAt: string,
  options: { status?: string } = {},
): TSession {
  return {
    ...session,
    ...(options.status !== undefined ? { status: options.status } : {}),
    updatedAt,
    runState: "running",
    messages: [...session.messages, { role: "user", text: userMessage }],
  } as TSession;
}
