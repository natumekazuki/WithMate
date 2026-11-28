import type { Session } from "../../src-shared/session/session-state.js";

/** 親の読み取りを直接行う保存先と、非同期の保存先の両方を受け付ける結果。 */
type Awaitable<T> = T | Promise<T>;

/** 保存済みの親を先に探す。保存先に結果がなければ、現在キャッシュしている親を探す。 */
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
