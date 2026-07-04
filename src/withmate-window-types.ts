import type { AppSettings } from "./provider-settings-state.js";
import type { ModelCatalogSnapshot } from "./model-catalog.js";
import type { Session } from "./session-state.js";

export type SavePastedSessionFileRequest = {
  sessionId: string;
  fileName: string;
  data: ArrayBuffer;
};

export type OpenPathOptions = {
  baseDirectory?: string | null;
};

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
