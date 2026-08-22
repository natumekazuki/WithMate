import { createHash } from "node:crypto";

import {
  SESSION_SUMMARY_PAGE_SCOPES,
  type SessionSummaryInvalidation,
  type SessionSummaryPageRequest,
  type SessionSummaryPageScope,
} from "../src/session-state.js";

export const SESSION_SUMMARY_PAGE_DEFAULT_LIMIT = 50;
export const SESSION_SUMMARY_PAGE_MAX_LIMIT = 50;
export const SESSION_SUMMARY_OPEN_ID_MAX = 100;
export const SESSION_SUMMARY_QUERY_MAX_LENGTH = 120;
export const SESSION_SUMMARY_RAW_QUERY_MAX_LENGTH = 512;
export const SESSION_SUMMARY_CURSOR_MAX_LENGTH = 512;
export const SESSION_SUMMARY_INVALIDATION_ID_MAX = 256;
export const SESSION_SUMMARY_ID_MAX_LENGTH = 256;

const SESSION_SUMMARY_CURSOR_VERSION = 1;

type SessionSummaryCursorPayload = {
  v: number;
  scope: Exclude<SessionSummaryPageScope, "open">;
  last_active_at: string;
  id: string;
  query_fingerprint: string;
};

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function queryFingerprint(normalizedQuery: string): string {
  return createHash("sha256").update(normalizedQuery, "utf8").digest("hex").slice(0, 32);
}

function normalizeCursor(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError("Session summary cursor が不正です。");
  }
  if (value.length > SESSION_SUMMARY_CURSOR_MAX_LENGTH) {
    throw new RangeError("Session summary cursor が長すぎます。");
  }
  return value;
}

export function normalizeSessionSummarySearchText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new TypeError("Session summary search query が不正です。");
  }
  if (value.length > SESSION_SUMMARY_RAW_QUERY_MAX_LENGTH) {
    throw new RangeError("Session summary search query が長すぎます。");
  }

  const normalized = value.trim().toLocaleLowerCase();
  if (normalized.length > SESSION_SUMMARY_QUERY_MAX_LENGTH) {
    throw new RangeError("Session summary search query は120文字以内で指定してね。");
  }
  return normalized;
}

function parseLimit(value: unknown, scope: SessionSummaryPageScope): number {
  const defaultLimit = scope === "open" ? SESSION_SUMMARY_OPEN_ID_MAX : SESSION_SUMMARY_PAGE_DEFAULT_LIMIT;
  if (value === undefined || value === null) {
    return defaultLimit;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new RangeError("Session summary page limit が不正です。");
  }
  const maxLimit = scope === "open" ? SESSION_SUMMARY_OPEN_ID_MAX : SESSION_SUMMARY_PAGE_MAX_LIMIT;
  if (value > maxLimit) {
    throw new RangeError(`Session summary page limit は${maxLimit}件以内で指定してね。`);
  }
  return value;
}

function parseSessionIds(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError("open Session ID list が不正です。");
  }
  if (value.length > SESSION_SUMMARY_OPEN_ID_MAX) {
    throw new RangeError("open Session ID は100件ずつ取得してね。");
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const valueItem of value) {
    if (typeof valueItem !== "string") {
      throw new TypeError("open Session ID が不正です。");
    }
    const id = valueItem.trim();
    if (!id || id.length > SESSION_SUMMARY_ID_MAX_LENGTH) {
      throw new RangeError("open Session ID が不正です。");
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export type ParsedSessionSummaryPageRequest = {
  scope: SessionSummaryPageScope;
  cursor: string | null;
  limit: number;
  searchText: string;
  sessionIds?: string[];
};

export function parseSessionSummaryPageRequest(value: unknown): ParsedSessionSummaryPageRequest {
  if (value !== undefined && value !== null && !isRecord(value)) {
    throw new TypeError("Session summary page request が不正です。");
  }
  const candidate = isRecord(value) ? value : {};
  const scope = candidate.scope === undefined
    ? "recent"
    : SESSION_SUMMARY_PAGE_SCOPES.includes(candidate.scope as SessionSummaryPageScope)
    ? candidate.scope as SessionSummaryPageScope
    : null;
  if (!scope) {
    throw new TypeError("Session summary page scope が不正です。");
  }

  const cursor = normalizeCursor(candidate.cursor);
  const searchText = normalizeSessionSummarySearchText(candidate.searchText);
  const limit = parseLimit(candidate.limit, scope);
  const sessionIds = parseSessionIds(candidate.sessionIds);

  if (scope === "open") {
    if (cursor) {
      throw new TypeError("open Session query は cursor を受け付けません。");
    }
    if (searchText) {
      throw new TypeError("open Session query は検索条件を受け付けません。");
    }
    if (sessionIds.length > 0 && limit < sessionIds.length) {
      throw new RangeError("open Session query のlimitは指定したID数以上にしてね。");
    }
  } else if (sessionIds.length > 0) {
    throw new TypeError("recent / pinned query に open Session ID は指定できません。");
  }

  return {
    scope,
    cursor,
    limit,
    searchText,
    sessionIds: scope === "open" ? sessionIds : undefined,
  };
}

export function encodeSessionSummaryCursor(
  scope: Exclude<SessionSummaryPageScope, "open">,
  lastActiveAt: string,
  id: string,
  normalizedQuery: string,
): string {
  const payload: SessionSummaryCursorPayload = {
    v: SESSION_SUMMARY_CURSOR_VERSION,
    scope,
    last_active_at: lastActiveAt,
    id,
    query_fingerprint: queryFingerprint(normalizedQuery),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  if (encoded.length > SESSION_SUMMARY_CURSOR_MAX_LENGTH) {
    throw new RangeError("Session summary cursor を上限内に encode できません。");
  }
  return encoded;
}

export function decodeSessionSummaryCursor(
  cursor: string | null,
  scope: Exclude<SessionSummaryPageScope, "open">,
  normalizedQuery: string,
): { lastActiveAt: string; id: string } | null {
  if (!cursor) {
    return null;
  }
  if (cursor.length > SESSION_SUMMARY_CURSOR_MAX_LENGTH) {
    throw new RangeError("Session summary cursor が長すぎます。");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("Session summary cursor を decode できません。");
  }

  if (!isRecord(payload)
    || payload.v !== SESSION_SUMMARY_CURSOR_VERSION
    || payload.scope !== scope
    || typeof payload.last_active_at !== "string"
    || !payload.last_active_at
    || typeof payload.id !== "string"
    || !payload.id
    || payload.id.length > SESSION_SUMMARY_ID_MAX_LENGTH
    || typeof payload.query_fingerprint !== "string"
    || payload.query_fingerprint !== queryFingerprint(normalizedQuery)) {
    throw new TypeError("Session summary cursor は現在の query と一致しません。");
  }

  const canonical = encodeSessionSummaryCursor(scope, payload.last_active_at, payload.id, normalizedQuery);
  if (canonical !== cursor) {
    throw new TypeError("Session summary cursor の形式が不正です。");
  }

  return { lastActiveAt: payload.last_active_at, id: payload.id };
}

export function buildSessionSummarySearchClause(alias: string, normalizedQuery: string): {
  sql: string;
  params: string[];
} {
  return buildSessionSummarySearchClauseForColumns(alias, normalizedQuery, {
    title: `${alias}.title`,
    workspacePath: `${alias}.workspace_path`,
    workspaceLabel: `CASE WHEN json_valid(${alias}.runtime_policy_json) THEN json_extract(${alias}.runtime_policy_json, '$.workspaceLabel') ELSE '' END`,
    sessionKind: `${alias}.session_kind`,
  });
}

export function buildSessionSummarySearchClauseForColumns(
  alias: string,
  normalizedQuery: string,
  columns: {
    title: string;
    workspacePath: string;
    workspaceLabel: string;
    sessionKind: string;
  },
): {
  sql: string;
  params: string[];
} {
  if (!normalizedQuery) {
    return { sql: "", params: [] };
  }

  const escaped = normalizedQuery.replace(/[\\%_]/g, (character) => `\\${character}`);
  const pattern = `%${escaped}%`;
  return {
    sql: `(
      LOWER(COALESCE(${columns.title}, '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(${columns.workspacePath}, '')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(${columns.workspaceLabel}, '')) LIKE ? ESCAPE '\\'
      OR LOWER(CASE
        WHEN ${columns.sessionKind} = 'character-authoring'
        THEN 'character character authoring authoring agent'
        ELSE 'agent ' || COALESCE(${columns.sessionKind}, '')
      END) LIKE ? ESCAPE '\\'
    )`,
    params: [pattern, pattern, pattern, pattern],
  };
}

export function buildSessionSummaryKeysetClause(
  alias: string,
  cursor: { lastActiveAt: string; id: string } | null,
): { sql: string; params: string[] } {
  if (!cursor) {
    return { sql: "", params: [] };
  }
  return {
    sql: `(
      ${alias}.last_active_at < ?
      OR (${alias}.last_active_at = ? AND ${alias}.id < ?)
    )`,
    params: [cursor.lastActiveAt, cursor.lastActiveAt, cursor.id],
  };
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
