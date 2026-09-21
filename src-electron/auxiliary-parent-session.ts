import type { Session } from "../src-shared/session/session-state.js";

type Awaitable<T> = T | Promise<T>;

export async function resolveAuxiliaryParentSession(input: {
  parentSessionId: string;
  getStoredSession: (sessionId: string) => Awaitable<Session | null>;
  getCachedSession: (sessionId: string) => Session | null;
}): Promise<Session | null> {
  const storedSession = await input.getStoredSession(input.parentSessionId);
  if (storedSession) {
    return storedSession;
  }

  const cachedSession = input.getCachedSession(input.parentSessionId);
  if (cachedSession) {
    return cachedSession;
  }

  return null;
}
