import type { WithMateWindowApi } from "../withmate-window-api.js";
import type { MateGrowthEventListItem } from "./mate-growth-events-state.js";
import { loadMateStatusSnapshot } from "./mate-status-load-operation.js";
import type { MateGrowthSettings, MateProfile, MateStorageState } from "./mate-state.js";

type MateStatusRefreshersContext = {
  setMateState: (state: MateStorageState) => void;
  setMateProfile: (profile: MateProfile | null) => void;
  setMateDisplayName: (displayName: string) => void;
  setMateEmbeddingSettings: (settings: Awaited<ReturnType<WithMateWindowApi["getMateEmbeddingSettings"]>>) => void;
  setMateEmbeddingFeedback: (message: string) => void;
  setMateEmbeddingBusy: (busy: boolean) => void;
  setMateGrowthSettings: (settings: MateGrowthSettings | null) => void;
  setMateGrowthFeedback: (message: string) => void;
  setMateGrowthBusy: (busy: boolean) => void;
  setMateGrowthEvents: (events: MateGrowthEventListItem[]) => void;
  setMateGrowthEventsFeedback: (message: string) => void;
  setMateGrowthEventsLoading: (loading: boolean) => void;
  setMateGrowthEventBusyTarget: (target: string | null) => void;
  setCorrectingMateGrowthEventId: (eventId: string | null) => void;
  setCorrectingMateGrowthEventStatement: (statement: string) => void;
  setMateAvatarUpdating: (updating: boolean) => void;
  stopMateEmbeddingSettingsPolling: () => void;
};

export type MateStatusRefreshers = {
  refreshMateStatus: (
    api: WithMateWindowApi,
    options?: { isActive?: () => boolean },
  ) => Promise<MateStorageState>;
  refreshMateGrowthEvents: (
    api: WithMateWindowApi,
    options?: { isActive?: () => boolean; silent?: boolean },
  ) => Promise<void>;
};

export function buildMateStatusRefreshers({
  setMateState,
  setMateProfile,
  setMateDisplayName,
  setMateEmbeddingSettings,
  setMateEmbeddingFeedback,
  setMateEmbeddingBusy,
  setMateGrowthSettings,
  setMateGrowthFeedback,
  setMateGrowthBusy,
  setMateGrowthEvents,
  setMateGrowthEventsFeedback,
  setMateGrowthEventsLoading,
  setMateGrowthEventBusyTarget,
  setCorrectingMateGrowthEventId,
  setCorrectingMateGrowthEventStatement,
  setMateAvatarUpdating,
  stopMateEmbeddingSettingsPolling,
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
      setMateEmbeddingSettings(null);
      setMateEmbeddingFeedback("");
      setMateEmbeddingBusy(false);
      setMateGrowthSettings(null);
      setMateGrowthFeedback("");
      setMateGrowthBusy(false);
      setMateGrowthEvents([]);
      setMateGrowthEventsFeedback("");
      setMateGrowthEventsLoading(false);
      setMateGrowthEventBusyTarget(null);
      setCorrectingMateGrowthEventId(null);
      setCorrectingMateGrowthEventStatement("");
      setMateAvatarUpdating(false);
      stopMateEmbeddingSettingsPolling();
      return result.mateState;
    }

    setMateState(result.mateState);
    setMateProfile(result.mateProfile);
    setMateDisplayName(result.mateProfile?.displayName ?? "");
    return result.mateState;
  };

  const refreshMateGrowthEvents: MateStatusRefreshers["refreshMateGrowthEvents"] = async (api, options) => {
    const isActive = options?.isActive ?? (() => true);
    if (!options?.silent) {
      setMateGrowthEventsLoading(true);
      setMateGrowthEventsFeedback("");
    }

    try {
      const result = await api.listMateGrowthEvents({ limit: 20 });
      if (!isActive()) {
        return;
      }
      setMateGrowthEvents(result.events);
      if (!options?.silent) {
        setMateGrowthEventsFeedback("Growth Event を更新したよ。");
      }
    } catch (error) {
      if (!isActive()) {
        return;
      }
      setMateGrowthEventsFeedback(error instanceof Error ? error.message : "Growth Event の取得に失敗したよ。");
    } finally {
      if (isActive()) {
        setMateGrowthEventsLoading(false);
      }
    }
  };

  return {
    refreshMateStatus,
    refreshMateGrowthEvents,
  };
}
