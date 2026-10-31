import type { SessionSummaryInvalidation } from "./session-state.js";

const SESSION_SUMMARY_INVALIDATION_ID_MAX = 256;
const SESSION_SUMMARY_ID_MAX_LENGTH = 256;

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeSessionSummaryInvalidation(value: unknown): SessionSummaryInvalidation | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.scope === "all") {
    return { scope: "all" };
  }
  if (value.scope !== "ids" || !Array.isArray(value.sessionIds) || value.sessionIds.length < 1) {
    return null;
  }
  if (value.sessionIds.length > SESSION_SUMMARY_INVALIDATION_ID_MAX) {
    return { scope: "all" };
  }

  const sessionIds: string[] = [];
  const seen = new Set<string>();
  for (const valueItem of value.sessionIds) {
    if (typeof valueItem !== "string") {
      return { scope: "all" };
    }
    const id = valueItem.trim();
    if (!id || id.length > SESSION_SUMMARY_ID_MAX_LENGTH) {
      return { scope: "all" };
    }
    if (!seen.has(id)) {
      seen.add(id);
      sessionIds.push(id);
    }
  }
  return sessionIds.length > 0 ? { scope: "ids", sessionIds } : null;
}
