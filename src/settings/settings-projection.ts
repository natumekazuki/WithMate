import { describeResetDatabaseTargets } from "./settings-ui.js";
import {
  ALL_RESET_APP_DATABASE_TARGETS,
  type ResetAppDatabaseTarget,
} from "../../src-shared/window/withmate-window-types.js";

/** リセット対象ごとの識別子と、チェックおよび操作無効の表示状態。 */
export type HomeSettingsResetTargetItem = {
  target: ResetAppDatabaseTarget;
  checked: boolean;
  disabled: boolean;
};

/** 設定の表示準備と、リセット対象の一覧・要約・実行可否をまとめた表示用データ。 */
export type HomeSettingsProjection = {
  settingsWindowReady: boolean;
  selectedResetTargetsDescription: string;
  resetTargetItems: HomeSettingsResetTargetItem[];
  canResetDatabase: boolean;
};

/** 設定とカタログの読み込み状態から表示可否を決め、リセット中は次のリセットを許可しない。 */
export function buildHomeSettingsProjection({
  settingsDraftLoaded,
  modelCatalogLoadSettled,
  resetDatabaseTargets,
  resettingDatabase,
}: {
  settingsDraftLoaded: boolean;
  modelCatalogLoadSettled: boolean;
  resetDatabaseTargets: readonly ResetAppDatabaseTarget[];
  resettingDatabase: boolean;
}): HomeSettingsProjection {
  const resetTargetItems = ALL_RESET_APP_DATABASE_TARGETS.map((target) => ({
    target,
    checked: resetDatabaseTargets.includes(target),
    disabled: resettingDatabase,
  }));

  return {
    settingsWindowReady: settingsDraftLoaded && modelCatalogLoadSettled,
    selectedResetTargetsDescription:
      describeResetDatabaseTargets(resetDatabaseTargets),
    resetTargetItems,
    canResetDatabase: !resettingDatabase && resetDatabaseTargets.length > 0,
  };
}
