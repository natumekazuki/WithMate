import { describeResetDatabaseTargets } from "./settings-ui.js";
import {
  ALL_RESET_APP_DATABASE_TARGETS,
  type ResetAppDatabaseTarget,
} from "../withmate-window-types.js";

export type HomeSettingsResetTargetItem = {
  target: ResetAppDatabaseTarget;
  checked: boolean;
  disabled: boolean;
};

export type HomeSettingsProjection = {
  settingsWindowReady: boolean;
  selectedResetTargetsDescription: string;
  resetTargetItems: HomeSettingsResetTargetItem[];
  canResetDatabase: boolean;
};

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
    disabled: resettingDatabase || (target === "auditLogs" && resetDatabaseTargets.includes("sessions")),
  }));

  return {
    settingsWindowReady: settingsDraftLoaded && modelCatalogLoadSettled,
    selectedResetTargetsDescription: describeResetDatabaseTargets(resetDatabaseTargets),
    resetTargetItems,
    canResetDatabase: !resettingDatabase && resetDatabaseTargets.length > 0,
  };
}
