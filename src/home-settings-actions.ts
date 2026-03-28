import type { AppSettings } from "./app-state.js";
import type { ModelCatalogSnapshot } from "./model-catalog.js";
import {
  buildResetDatabaseConfirmMessage,
  buildResetDatabaseSuccessMessage,
} from "./settings-ui.js";
import {
  normalizeResetAppDatabaseTargets,
  type ResetAppDatabaseResult,
  type ResetAppDatabaseTarget,
} from "./withmate-window-types.js";
import type { WithMateWindowApi } from "./withmate-window-api.js";

export type HomeSettingsApi = Pick<
  WithMateWindowApi,
  "importModelCatalogFile" | "exportModelCatalogFile" | "updateAppSettings" | "resetAppDatabase"
>;

export async function importHomeModelCatalog(api: HomeSettingsApi): Promise<string> {
  const snapshot = await api.importModelCatalogFile();
  return snapshot ? `model catalog revision ${snapshot.revision} を読み込んだよ。` : "読み込みをキャンセルしたよ。";
}

export async function exportHomeModelCatalog(api: HomeSettingsApi): Promise<string> {
  const savedPath = await api.exportModelCatalogFile();
  return savedPath ? `model catalog を保存したよ: ${savedPath}` : "保存をキャンセルしたよ。";
}

export async function saveHomeSettings(
  api: HomeSettingsApi,
  settings: AppSettings,
): Promise<{ nextSettings: AppSettings; feedback: string }> {
  const nextSettings = await api.updateAppSettings(settings);
  return {
    nextSettings,
    feedback: "設定を保存したよ。",
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
      feedback: "初期化対象を 1 つ以上選んでね。",
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
