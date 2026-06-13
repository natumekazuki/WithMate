import type { AppSettings } from "../app-state.js";
import { getProviderAppSettings } from "../provider-settings-state.js";
import {
  buildResetDatabaseConfirmMessage,
  buildResetDatabaseSuccessMessage,
} from "./settings-ui.js";
import type { HomeProviderInstructionTargetDraft } from "./provider-instruction-target-draft.js";
import { buildHomeProviderInstructionTargetUpsertInput } from "./settings-view-model.js";
import {
  normalizeResetAppDatabaseTargets,
  type ResetAppDatabaseResult,
  type ResetAppDatabaseRequest,
  type ResetAppDatabaseTarget,
} from "../withmate-window-types.js";

export type HomeSettingsApi = {
  importModelCatalogFile: () => Promise<{ revision: number } | null>;
  exportModelCatalogFile: () => Promise<string | null>;
  updateAppSettings: (settings: AppSettings) => Promise<AppSettings>;
  resetAppDatabase: (request: ResetAppDatabaseRequest) => Promise<ResetAppDatabaseResult>;
};

type ProviderInstructionTargetSyncApi = {
  upsertProviderInstructionTarget: (
    input: ReturnType<typeof buildHomeProviderInstructionTargetUpsertInput>,
  ) => Promise<HomeProviderInstructionTargetDraft> | HomeProviderInstructionTargetDraft;
};

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

export async function syncProviderInstructionTargetRoots({
  api,
  nextSettings,
  providerInstructionTargets,
}: {
  api: ProviderInstructionTargetSyncApi;
  nextSettings: AppSettings;
  providerInstructionTargets: readonly HomeProviderInstructionTargetDraft[];
}): Promise<HomeProviderInstructionTargetDraft[]> {
  const nextTargets = providerInstructionTargets.map((target) => {
    const rootDirectory = getProviderAppSettings(nextSettings, target.providerId).skillRootPath.trim();
    if (rootDirectory === target.rootDirectory) {
      return target;
    }

    return {
      ...target,
      rootDirectory,
    };
  });

  const changedTargets = nextTargets.filter((target, index) =>
    target.rootDirectory !== providerInstructionTargets[index]?.rootDirectory);
  await Promise.all(
    changedTargets.map((target) =>
      api.upsertProviderInstructionTarget(buildHomeProviderInstructionTargetUpsertInput(target))),
  );

  return nextTargets;
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
