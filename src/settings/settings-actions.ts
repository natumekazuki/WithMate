import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import {
  buildDeleteOldSessionsConfirmMessage,
  buildDeleteOldSessionsSuccessMessage,
  buildResetDatabaseConfirmMessage,
  buildResetDatabaseSuccessMessage,
} from "./settings-ui.js";
import {
  type DeleteSessionsLastActiveBeforeRequest,
  type DeleteSessionsResult,
  normalizeResetAppDatabaseTargets,
  type ResetAppDatabaseResult,
  type ResetAppDatabaseRequest,
  type ResetAppDatabaseTarget,
} from "../../src-shared/window/withmate-window-types.js";

export type HomeSettingsApi = {
  updateAppSettings: (settings: AppSettings) => Promise<AppSettings>;
  resetAppDatabase: (request: ResetAppDatabaseRequest) => Promise<ResetAppDatabaseResult>;
  deleteSessionsLastActiveBefore: (request: DeleteSessionsLastActiveBeforeRequest) => Promise<DeleteSessionsResult>;
};

export async function saveHomeSettings(
  api: HomeSettingsApi,
  settings: AppSettings,
): Promise<{ nextSettings: AppSettings; feedback: string }> {
  const nextSettings = await api.updateAppSettings(settings);
  return {
    nextSettings,
    feedback: "Settings saved.",
  };
}

export type ResetHomeDatabaseActionResult =
  | { kind: "noop"; feedback: string }
  | { kind: "canceled" }
  | { kind: "success"; result: ResetAppDatabaseResult; feedback: string };

export async function resetHomeDatabase({
  api,
  resetTargets,
  confirm,
}: {
  api: HomeSettingsApi;
  resetTargets: readonly ResetAppDatabaseTarget[];
  confirm: (message: string) => boolean;
}): Promise<ResetHomeDatabaseActionResult> {
  const normalizedTargets = normalizeResetAppDatabaseTargets(resetTargets);
  if (normalizedTargets.length === 0) {
    return {
      kind: "noop",
      feedback: "Select at least one reset target.",
    };
  }

  const confirmed = confirm(buildResetDatabaseConfirmMessage(normalizedTargets));
  if (!confirmed) {
    return { kind: "canceled" };
  }

  const result = await api.resetAppDatabase({ targets: normalizedTargets });
  return {
    kind: "success",
    result,
    feedback: buildResetDatabaseSuccessMessage(result.resetTargets),
  };
}

export type DeleteOldSessionsActionResult =
  | { kind: "noop"; feedback: string }
  | { kind: "canceled" }
  | { kind: "success"; result: DeleteSessionsResult; feedback: string };

export async function deleteOldSessions({
  api,
  cutoffDate,
  confirm,
}: {
  api: HomeSettingsApi;
  cutoffDate: string;
  confirm: (message: string) => boolean;
}): Promise<DeleteOldSessionsActionResult> {
  const normalizedCutoffDate = cutoffDate.trim();
  if (!normalizedCutoffDate) {
    return {
      kind: "noop",
      feedback: "Select a cleanup date.",
    };
  }

  const confirmed = confirm(buildDeleteOldSessionsConfirmMessage(normalizedCutoffDate));
  if (!confirmed) {
    return { kind: "canceled" };
  }

  const result = await api.deleteSessionsLastActiveBefore({ cutoffDate: normalizedCutoffDate });
  return {
    kind: "success",
    result,
    feedback: buildDeleteOldSessionsSuccessMessage(result),
  };
}
