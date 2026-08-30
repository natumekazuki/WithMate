export const SESSION_WINDOW_RESTORE_SET_MAX = 100;

export type SessionWindowRestoreFailureReason = "missing" | "unreadable" | "open-failed";

export type SessionWindowRestoreFailure = {
  sessionId: string;
  reason: SessionWindowRestoreFailureReason;
};

export type SessionWindowRestoreResult = {
  requestedSessionIds: string[];
  openedSessionIds: string[];
  failures: SessionWindowRestoreFailure[];
};

export function normalizeSessionWindowRestoreIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const sessionIds: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      return null;
    }
    const sessionId = entry.trim();
    if (!sessionId || seen.has(sessionId)) {
      continue;
    }
    seen.add(sessionId);
    sessionIds.push(sessionId);
    if (sessionIds.length === SESSION_WINDOW_RESTORE_SET_MAX) {
      break;
    }
  }
  return sessionIds;
}

export function normalizeSessionWindowRestoreResult(value: unknown): SessionWindowRestoreResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as {
    requestedSessionIds?: unknown;
    openedSessionIds?: unknown;
    failures?: unknown;
  };
  const requestedSessionIds = normalizeSessionWindowRestoreIds(candidate.requestedSessionIds);
  const openedSessionIds = normalizeSessionWindowRestoreIds(candidate.openedSessionIds);
  if (!requestedSessionIds || !openedSessionIds || !Array.isArray(candidate.failures)) {
    return null;
  }
  const requestedSet = new Set(requestedSessionIds);
  if (openedSessionIds.some((sessionId) => !requestedSet.has(sessionId))) {
    return null;
  }
  const failures: SessionWindowRestoreFailure[] = [];
  const failedIds = new Set<string>();
  for (const entry of candidate.failures) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const failure = entry as { sessionId?: unknown; reason?: unknown };
    const sessionId = typeof failure.sessionId === "string" ? failure.sessionId.trim() : "";
    if (
      !sessionId
      || !requestedSet.has(sessionId)
      || failedIds.has(sessionId)
      || (
        failure.reason !== "missing"
        && failure.reason !== "unreadable"
        && failure.reason !== "open-failed"
      )
    ) {
      return null;
    }
    failedIds.add(sessionId);
    failures.push({ sessionId, reason: failure.reason });
  }
  if (openedSessionIds.some((sessionId) => failedIds.has(sessionId))) {
    return null;
  }
  const classifiedIds = new Set([...openedSessionIds, ...failedIds]);
  if (
    classifiedIds.size !== requestedSessionIds.length
    || requestedSessionIds.some((sessionId) => !classifiedIds.has(sessionId))
  ) {
    return null;
  }
  return { requestedSessionIds, openedSessionIds, failures };
}
