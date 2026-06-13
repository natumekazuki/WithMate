import type { MateStorageState } from "./mate-state.js";
import type { WithMateWindowApi } from "../withmate-window-api.js";
import { buildResetMateConfirmMessage } from "../settings/settings-ui.js";

type MateMaintenanceHandlersContext = {
  getApi: () => WithMateWindowApi | null;
  mateState: MateStorageState | null;
  mateResetting: boolean;
  setMateResetting: (resetting: boolean) => void;
  setSettingsFeedback: (message: string) => void;
  refreshMateStatus: (
    api: WithMateWindowApi,
    options?: { isActive?: () => boolean },
  ) => Promise<MateStorageState>;
  confirmResetMate?: (message: string) => boolean;
};

export type MateMaintenanceHandlers = {
  onResetMate: () => void;
};

export function buildMateMaintenanceHandlers({
  getApi,
  mateState,
  mateResetting,
  setMateResetting,
  setSettingsFeedback,
  refreshMateStatus,
  confirmResetMate = (message) => window.confirm(message),
}: MateMaintenanceHandlersContext): MateMaintenanceHandlers {
  const resetMate = async () => {
    if (mateResetting || mateState === "not_created") {
      return;
    }

    const api = getApi();
    if (!api) {
      setSettingsFeedback("Mate API が利用できないよ。");
      return;
    }

    if (!confirmResetMate(buildResetMateConfirmMessage())) {
      return;
    }

    setMateResetting(true);
    setSettingsFeedback("Mate を初期化中...");
    try {
      await api.resetMate();
      await refreshMateStatus(api);
      setSettingsFeedback("Mate を初期化したよ。");
    } catch (error) {
      setSettingsFeedback(error instanceof Error ? error.message : "Mate の初期化に失敗したよ。");
    } finally {
      setMateResetting(false);
    }
  };

  return {
    onResetMate: () => void resetMate(),
  };
}
