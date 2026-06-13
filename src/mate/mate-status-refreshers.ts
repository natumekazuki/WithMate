import type { WithMateWindowApi } from "../withmate-window-api.js";
import { loadMateStatusSnapshot } from "./mate-status-load-operation.js";
import type { MateProfile, MateStorageState } from "./mate-state.js";

type MateStatusRefreshersContext = {
  setMateState: (state: MateStorageState) => void;
  setMateProfile: (profile: MateProfile | null) => void;
  setMateDisplayName: (displayName: string) => void;
  setMateAvatarUpdating: (updating: boolean) => void;
};

export type MateStatusRefreshers = {
  refreshMateStatus: (
    api: WithMateWindowApi,
    options?: { isActive?: () => boolean },
  ) => Promise<MateStorageState>;
};

export function buildMateStatusRefreshers({
  setMateState,
  setMateProfile,
  setMateDisplayName,
  setMateAvatarUpdating,
}: MateStatusRefreshersContext): MateStatusRefreshers {
  const refreshMateStatus: MateStatusRefreshers["refreshMateStatus"] = async (api, options) => {
    const isActive = options?.isActive ?? (() => true);
    const result = await loadMateStatusSnapshot({ api, isActive });
    if (result.status === "stale" || !isActive()) {
      return result.mateState;
    }

    if (result.mateState === "not_created") {
      setMateState("not_created");
      setMateProfile(null);
      setMateDisplayName("");
      setMateAvatarUpdating(false);
      return result.mateState;
    }

    setMateState(result.mateState);
    setMateProfile(result.mateProfile);
    setMateDisplayName(result.mateProfile?.displayName ?? "");
    return result.mateState;
  };

  return {
    refreshMateStatus,
  };
}
