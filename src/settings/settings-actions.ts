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

/** 設定の永続化と、確認後のデータベース初期化・古い Session の削除に使う API。 */
export type HomeSettingsApi = {
  updateAppSettings: (settings: AppSettings) => Promise<AppSettings>;
  resetAppDatabase: (
    request: ResetAppDatabaseRequest,
  ) => Promise<ResetAppDatabaseResult>;
  deleteSessionsLastActiveBefore: (
    request: DeleteSessionsLastActiveBeforeRequest,
  ) => Promise<DeleteSessionsResult>;
};

/** 入力を保存し、画面が採用すべき値として API が返した設定を通知文と一緒に返す。 */
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

/** リセット対象なし、確認での取消、リセット実行成功を区別する結果。 */
export type ResetHomeDatabaseActionResult =
  | { kind: "noop"; feedback: string }
  | { kind: "canceled" }
  | { kind: "success"; result: ResetAppDatabaseResult; feedback: string };

/** 対象を正規化し、空でなく確認が取れた場合だけリセット API を呼び出す。 */
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

  const confirmed = confirm(
    buildResetDatabaseConfirmMessage(normalizedTargets),
  );
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

/** 削除日の未入力、確認での取消、削除 API の成功を区別する結果。 */
export type DeleteOldSessionsActionResult =
  | { kind: "noop"; feedback: string }
  | { kind: "canceled" }
  | { kind: "success"; result: DeleteSessionsResult; feedback: string };

/** 前後の空白を除いた削除日を確認し、承認された場合にだけ古い Session の削除を依頼する。 */
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

  const confirmed = confirm(
    buildDeleteOldSessionsConfirmMessage(normalizedCutoffDate),
  );
  if (!confirmed) {
    return { kind: "canceled" };
  }

  const result = await api.deleteSessionsLastActiveBefore({
    cutoffDate: normalizedCutoffDate,
  });
  return {
    kind: "success",
    result,
    feedback: buildDeleteOldSessionsSuccessMessage(result),
  };
}
