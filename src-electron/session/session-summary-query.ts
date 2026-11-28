import { createHash } from "node:crypto";

import {
  SESSION_SUMMARY_PAGE_SCOPES,
  type SessionSummaryPageRequest,
  type SessionSummaryPageScope,
} from "../../src-shared/session/session-state.js";

/** 最近・ピン留め一覧で件数が省略されたときに返す既定件数。 */
export const SESSION_SUMMARY_PAGE_DEFAULT_LIMIT = 50;
/** 最近・ピン留め一覧の一ページで取得できる最大件数。 */
export const SESSION_SUMMARY_PAGE_MAX_LIMIT = 50;
/** 開いている Session を ID でまとめて取得する際の上限件数。 */
export const SESSION_SUMMARY_OPEN_ID_MAX = 100;
/** 空白除去と小文字化の後で許可する、検索語の最大長。 */
export const SESSION_SUMMARY_QUERY_MAX_LENGTH = 120;
/** 検索語を正規化する前に受け付ける入力の最大長。 */
export const SESSION_SUMMARY_RAW_QUERY_MAX_LENGTH = 512;
/** 送受信する要約カーソルの符号化後の最大長。 */
export const SESSION_SUMMARY_CURSOR_MAX_LENGTH = 512;
/** 一覧の無効化通知に含められる Session ID の最大件数。 */
export const SESSION_SUMMARY_INVALIDATION_ID_MAX = 256;
/** 指定 ID とカーソル内の Session ID の最大長。 */
export const SESSION_SUMMARY_ID_MAX_LENGTH = 256;

const SESSION_SUMMARY_CURSOR_VERSION = 1;

/** 最近・ピン留めの範囲、最後の項目の並び順、検索条件をバージョン付きで持つカーソルの内容。 */
type SessionSummaryCursorPayload = {
  v: number;
  scope: Exclude<SessionSummaryPageScope, "open">;
  last_active_at: string;
  id: string;
  query_fingerprint: string;
};

/** 外部入力から名前付きの条件を読み取るオブジェクト。各値はこの段階では未検証。 */
type RecordLike = Record<string, unknown>;

/** 検索要求やカーソルを配列と区別し、名前付きのフィールドを読める形か確かめる。 */
function isRecord(value: unknown): value is RecordLike {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 正規化済みの検索語を、カーソルが同じ条件で作られたか照合する値に変換する。 */
function queryFingerprint(normalizedQuery: string): string {
  return createHash("sha256")
    .update(normalizedQuery, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/** 未指定または空文字列をカーソルなしとし、不正な型や長さを拒否する。 */
function normalizeCursor(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError("Session summary cursor is invalid.");
  }
  if (value.length > SESSION_SUMMARY_CURSOR_MAX_LENGTH) {
    throw new RangeError("Session summary cursor is too long.");
  }
  return value;
}

/** 検索語の入力長を先に検査してから空白を除き小文字化し、正規化後の上限も適用する。 */
export function normalizeSessionSummarySearchText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new TypeError("Session summary search query is invalid.");
  }
  if (value.length > SESSION_SUMMARY_RAW_QUERY_MAX_LENGTH) {
    throw new RangeError("Session summary search query is too long.");
  }

  const normalized = value.trim().toLocaleLowerCase();
  if (normalized.length > SESSION_SUMMARY_QUERY_MAX_LENGTH) {
    throw new RangeError(
      "Session summary search query must be 120 characters or fewer.",
    );
  }
  return normalized;
}

/** 開いている Session の ID 照会と、最近・ピン留めのページに別々の既定値と上限を適用する。 */
function parseLimit(value: unknown, scope: SessionSummaryPageScope): number {
  const defaultLimit =
    scope === "open"
      ? SESSION_SUMMARY_OPEN_ID_MAX
      : SESSION_SUMMARY_PAGE_DEFAULT_LIMIT;
  if (value === undefined || value === null) {
    return defaultLimit;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new RangeError("Session summary page limit is invalid.");
  }
  const maxLimit =
    scope === "open"
      ? SESSION_SUMMARY_OPEN_ID_MAX
      : SESSION_SUMMARY_PAGE_MAX_LIMIT;
  if (value > maxLimit) {
    throw new RangeError(
      `Session summary page limit must be at most ${maxLimit}.`,
    );
  }
  return value;
}

/** 開いている Window の ID を検証し、前後空白を除いて初出順のまま重複を取り除く。 */
function parseSessionIds(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError("Open Session ID list is invalid.");
  }
  if (value.length > SESSION_SUMMARY_OPEN_ID_MAX) {
    throw new RangeError("Open Session IDs must be fetched in batches of 100.");
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const valueItem of value) {
    if (typeof valueItem !== "string") {
      throw new TypeError("Open Session ID is invalid.");
    }
    const id = valueItem.trim();
    if (!id || id.length > SESSION_SUMMARY_ID_MAX_LENGTH) {
      throw new RangeError("Open Session ID is invalid.");
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/** 範囲と件数を確定し、その範囲で使えるカーソル・検索語・ID だけを持つ内部要求。 */
export type ParsedSessionSummaryPageRequest = {
  scope: SessionSummaryPageScope;
  cursor: string | null;
  limit: number;
  searchText: string;
  sessionIds?: string[];
};

/** 要約の照会条件を検証し、ID で開いている Session を読む経路と検索・ページ送りの条件を混在させない。 */
export function parseSessionSummaryPageRequest(
  value: unknown,
): ParsedSessionSummaryPageRequest {
  if (value !== undefined && value !== null && !isRecord(value)) {
    throw new TypeError("Session summary page request is invalid.");
  }
  const candidate = isRecord(value) ? value : {};
  const scope =
    candidate.scope === undefined
      ? "recent"
      : SESSION_SUMMARY_PAGE_SCOPES.includes(
            candidate.scope as SessionSummaryPageScope,
          )
        ? (candidate.scope as SessionSummaryPageScope)
        : null;
  if (!scope) {
    throw new TypeError("Session summary page scope is invalid.");
  }

  const cursor = normalizeCursor(candidate.cursor);
  const searchText = normalizeSessionSummarySearchText(candidate.searchText);
  const limit = parseLimit(candidate.limit, scope);
  const sessionIds = parseSessionIds(candidate.sessionIds);

  if (scope === "open") {
    if (cursor) {
      throw new TypeError("Open Session queries do not accept a cursor.");
    }
    if (searchText) {
      throw new TypeError(
        "Open Session queries do not accept search conditions.",
      );
    }
    if (sessionIds.length > 0 && limit < sessionIds.length) {
      throw new RangeError(
        "The Open Session query limit must be at least the number of requested IDs.",
      );
    }
  } else if (sessionIds.length > 0) {
    throw new TypeError(
      "Recent and pinned queries cannot specify Open Session IDs.",
    );
  }

  return {
    scope,
    cursor,
    limit,
    searchText,
    sessionIds: scope === "open" ? sessionIds : undefined,
  };
}

/** 最後の項目の日時と ID、検索条件の照合値を Base64URL で保持し、長さ上限を超えれば拒否する。 */
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
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  if (encoded.length > SESSION_SUMMARY_CURSOR_MAX_LENGTH) {
    throw new RangeError(
      "Session summary cursor cannot be encoded within the length limit.",
    );
  }
  return encoded;
}

/** 現在の範囲と検索条件に合う正規形式のカーソルだけから、ページ再開位置を取り出す。 */
export function decodeSessionSummaryCursor(
  cursor: string | null,
  scope: Exclude<SessionSummaryPageScope, "open">,
  normalizedQuery: string,
): { lastActiveAt: string; id: string } | null {
  if (!cursor) {
    return null;
  }
  if (cursor.length > SESSION_SUMMARY_CURSOR_MAX_LENGTH) {
    throw new RangeError("Session summary cursor is too long.");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("Session summary cursor cannot be decoded.");
  }

  if (
    !isRecord(payload) ||
    payload.v !== SESSION_SUMMARY_CURSOR_VERSION ||
    payload.scope !== scope ||
    typeof payload.last_active_at !== "string" ||
    !payload.last_active_at ||
    typeof payload.id !== "string" ||
    !payload.id ||
    payload.id.length > SESSION_SUMMARY_ID_MAX_LENGTH ||
    typeof payload.query_fingerprint !== "string" ||
    payload.query_fingerprint !== queryFingerprint(normalizedQuery)
  ) {
    throw new TypeError(
      "Session summary cursor does not match the current query.",
    );
  }

  const canonical = encodeSessionSummaryCursor(
    scope,
    payload.last_active_at,
    payload.id,
    normalizedQuery,
  );
  if (canonical !== cursor) {
    throw new TypeError("Session summary cursor format is invalid.");
  }

  return { lastActiveAt: payload.last_active_at, id: payload.id };
}

/** 既存の Session 要約の列・JSON 項目を指定して、共通の部分一致検索へ渡す。 */
export function buildSessionSummarySearchClause(
  alias: string,
  normalizedQuery: string,
  characterName: string,
): {
  sql: string;
  params: string[];
} {
  return buildSessionSummarySearchClauseForColumns(alias, normalizedQuery, {
    title: `${alias}.title`,
    workspacePath: `${alias}.workspace_path`,
    workspaceLabel: `CASE WHEN json_valid(${alias}.runtime_policy_json) THEN json_extract(${alias}.runtime_policy_json, '$.workspaceLabel') ELSE '' END`,
    sessionKind: `${alias}.session_kind`,
    characterName,
  });
}

/** 検索対象列ごとの部分一致条件を作る。検索語のワイルドカードを文字として扱い、語は SQL パラメーターで渡す。 */
export function buildSessionSummarySearchClauseForColumns(
  alias: string,
  normalizedQuery: string,
  columns: {
    title: string;
    workspacePath: string;
    workspaceLabel: string;
    sessionKind: string;
    characterName?: string;
  },
): {
  sql: string;
  params: string[];
} {
  if (!normalizedQuery) {
    return { sql: "", params: [] };
  }

  const escaped = normalizedQuery.replace(
    /[\\%_]/g,
    (character) => `\\${character}`,
  );
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
      ${columns.characterName ? `OR LOWER(COALESCE(${columns.characterName}, '')) LIKE ? ESCAPE '\\'` : ""}
    )`,
    params: [
      pattern,
      pattern,
      pattern,
      pattern,
      ...(columns.characterName ? [pattern] : []),
    ],
  };
}

/** 前ページ末尾より古い日時、または同じ日時でより小さい ID に絞り、降順のページを続ける。 */
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
