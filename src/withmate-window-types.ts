import type { AppSettings } from "./provider-settings-state.js";
import type { ModelCatalogSnapshot } from "./model-catalog.js";
import type { Session } from "./session-state.js";

export const OPEN_SESSION_WINDOW_IDS_BROADCAST_MAX = 100;
export const OPEN_SESSION_WINDOW_IDS_PAGE_MAX = 100;

export type OpenSessionWindowIdsPageRequest = {
  cursor?: string | null;
  limit?: number | null;
};

export type OpenSessionWindowIdsPageResult = {
  sessionIds: string[];
  nextCursor: string | null;
  hasMore: boolean;
};

export function parseOpenSessionWindowIdsPageRequest(value: unknown): { cursor: string | null; limit: number } {
  if (value !== undefined && value !== null && (typeof value !== "object" || Array.isArray(value))) {
    throw new TypeError("open Session Window ID page request が不正です。");
  }
  const candidate = value && typeof value === "object" && !Array.isArray(value)
    ? value as { cursor?: unknown; limit?: unknown }
    : {};
  const rawCursor = candidate.cursor === undefined || candidate.cursor === null || candidate.cursor === ""
    ? null
    : candidate.cursor;
  const cursor = typeof rawCursor === "string" ? rawCursor.trim() : rawCursor;
  const limit = candidate.limit === undefined || candidate.limit === null
    ? OPEN_SESSION_WINDOW_IDS_PAGE_MAX
    : candidate.limit;
  if (
    (cursor !== null && (typeof cursor !== "string" || !cursor || cursor.length > 256))
    || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1
    || limit > OPEN_SESSION_WINDOW_IDS_PAGE_MAX
  ) {
    throw new RangeError("open Session Window ID page request が不正です。");
  }
  return { cursor: typeof cursor === "string" ? cursor : null, limit };
}

export function buildOpenSessionWindowIdsPage(
  sessionIds: readonly string[],
  request?: OpenSessionWindowIdsPageRequest | null,
): OpenSessionWindowIdsPageResult {
  const { cursor, limit } = parseOpenSessionWindowIdsPageRequest(request);
  const uniqueSessionIds = Array.from(new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean))).sort();
  const candidates = cursor === null
    ? uniqueSessionIds
    : uniqueSessionIds.filter((sessionId) => sessionId > cursor);
  const entries = candidates.slice(0, limit);
  const hasMore = entries.length < candidates.length;
  return {
    sessionIds: entries,
    nextCursor: hasMore ? entries.at(-1) ?? null : null,
    hasMore,
  };
}

export function normalizeOpenSessionWindowIdsPageResult(value: unknown): OpenSessionWindowIdsPageResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as { sessionIds?: unknown; nextCursor?: unknown; hasMore?: unknown };
  if (!Array.isArray(candidate.sessionIds) || candidate.sessionIds.length > OPEN_SESSION_WINDOW_IDS_PAGE_MAX) {
    return null;
  }
  const sessionIds = candidate.sessionIds.filter((sessionId): sessionId is string => (
    typeof sessionId === "string" && sessionId.trim().length > 0
  ));
  if (sessionIds.length !== candidate.sessionIds.length || typeof candidate.hasMore !== "boolean") {
    return null;
  }
  if (candidate.nextCursor !== null && (
    typeof candidate.nextCursor !== "string" || !candidate.nextCursor || candidate.nextCursor.length > 256
  )) {
    return null;
  }
  return {
    sessionIds: Array.from(new Set(sessionIds.map((sessionId) => sessionId.trim()))),
    nextCursor: candidate.hasMore ? candidate.nextCursor as string | null : null,
    hasMore: candidate.hasMore,
  };
}

export type OpenSessionWindowIdsChangedPayload =
  | { scope: "ids"; sessionIds: string[] }
  | { scope: "all" };

export function normalizeOpenSessionWindowIdsChangedPayload(value: unknown): OpenSessionWindowIdsChangedPayload | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    if (value.length > OPEN_SESSION_WINDOW_IDS_BROADCAST_MAX) {
      return { scope: "all" };
    }
    const sessionIds = value.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
    return sessionIds.length === value.length
      ? { scope: "ids", sessionIds: Array.from(new Set(sessionIds.map((id) => id.trim()))) }
      : { scope: "all" };
  }
  if (typeof value !== "object") {
    return null;
  }
  const payload = value as { scope?: unknown; sessionIds?: unknown };
  if (payload.scope === "all") {
    return { scope: "all" };
  }
  if (payload.scope !== "ids" || !Array.isArray(payload.sessionIds)) {
    return null;
  }
  if (payload.sessionIds.length > OPEN_SESSION_WINDOW_IDS_BROADCAST_MAX) {
    return { scope: "all" };
  }
  const sessionIds = payload.sessionIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  return sessionIds.length === payload.sessionIds.length
    ? { scope: "ids", sessionIds: Array.from(new Set(sessionIds.map((id) => id.trim()))) }
    : { scope: "all" };
}

export type SavePastedSessionFileRequest = {
  sessionId: string;
  fileName: string;
  data: ArrayBuffer;
};

export type OpenPathOptions = {
  baseDirectory?: string | null;
  reveal?: boolean;
};

export type OpenPathResult =
  | { status: "opened"; targetType: "external-url" | "local-path"; target: string }
  | { status: "revealed"; targetType: "local-path"; target: string; message: string }
  | { status: "not-found" | "failed"; targetType: "external-url" | "local-path" | "unknown"; target: string; message: string };

export const IMAGE_FILE_PICKER_PURPOSES = ["general", "character-icon"] as const;

export type ImageFilePickerPurpose = (typeof IMAGE_FILE_PICKER_PURPOSES)[number];

export function parseImageFilePickerPurpose(value: unknown): ImageFilePickerPurpose {
  if (value === undefined || value === null) {
    return "general";
  }
  if (value === "general" || value === "character-icon") {
    return value;
  }
  throw new Error("画像選択の用途が不正です。");
}

export const ALL_RESET_APP_DATABASE_TARGETS = [
  "sessions",
  "auditLogs",
  "appSettings",
  "modelCatalog",
  "projectMemory",
] as const;

export type ResetAppDatabaseTarget = (typeof ALL_RESET_APP_DATABASE_TARGETS)[number];

export type ResetAppDatabaseRequest = {
  targets: ResetAppDatabaseTarget[];
};

export function normalizeResetAppDatabaseTargets(
  targets: readonly ResetAppDatabaseTarget[] | null | undefined,
): ResetAppDatabaseTarget[] {
  const selected = new Set<ResetAppDatabaseTarget>(targets ?? ALL_RESET_APP_DATABASE_TARGETS);
  if (selected.has("sessions")) {
    selected.add("auditLogs");
  }

  return ALL_RESET_APP_DATABASE_TARGETS.filter((target) => selected.has(target));
}

export function areAllResetAppDatabaseTargetsSelected(
  targets: readonly ResetAppDatabaseTarget[] | null | undefined,
): boolean {
  const normalized = normalizeResetAppDatabaseTargets(targets);
  return normalized.length === ALL_RESET_APP_DATABASE_TARGETS.length;
}

export type ResetAppDatabaseResult = {
  resetTargets: ResetAppDatabaseTarget[];
  sessions: Session[];
  appSettings: AppSettings;
  modelCatalog: ModelCatalogSnapshot;
};

export type DeleteSessionsLastActiveBeforeRequest = {
  cutoffDate: string;
};

export type DeleteSessionsLastActiveBeforeCutoff = {
  cutoffDate: string;
  cutoffTimestampMs: number;
  cutoffIso: string;
};

export type DeleteSessionsResult = {
  cutoffDate?: string;
  cutoffTimestampMs?: number;
  deletedSessionIds: string[];
  skippedRunningSessionIds: string[];
};

export function resolveDeleteSessionsLastActiveBeforeCutoff(
  request: DeleteSessionsLastActiveBeforeRequest | null | undefined,
): DeleteSessionsLastActiveBeforeCutoff {
  const cutoffDate = typeof request?.cutoffDate === "string" ? request.cutoffDate.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoffDate)) {
    throw new Error("削除基準日は YYYY-MM-DD 形式で指定してね。");
  }

  const [yearText, monthText, dayText] = cutoffDate.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const cutoff = new Date(year, month - 1, day);
  if (
    Number.isNaN(cutoff.getTime()) ||
    cutoff.getFullYear() !== year ||
    cutoff.getMonth() !== month - 1 ||
    cutoff.getDate() !== day
  ) {
    throw new Error("削除基準日を解釈できないよ。");
  }

  return {
    cutoffDate,
    cutoffTimestampMs: cutoff.getTime(),
    cutoffIso: cutoff.toISOString(),
  };
}
