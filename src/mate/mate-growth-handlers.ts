import type { HomeSettingsContentProps } from "../settings/SettingsContent.js";
import type {
  MateGrowthSettings,
  MateStorageState,
  UpdateMateGrowthSettingsInput,
} from "./mate-state.js";
import type { MateGrowthEventListItem } from "./mate-growth-events-state.js";
import {
  handleApplyPendingGrowth as handleApplyPendingGrowthAction,
  handleBeginCorrectMateGrowthEvent as handleBeginCorrectMateGrowthEventAction,
  handleCancelCorrectMateGrowthEvent as handleCancelCorrectMateGrowthEventAction,
  handleCorrectMateGrowthEvent as handleCorrectMateGrowthEventAction,
  handleDisableMateGrowthEvent as handleDisableMateGrowthEventAction,
  handleForgetMateGrowthEvent as handleForgetMateGrowthEventAction,
  handleReloadMateGrowthEvents as handleReloadMateGrowthEventsAction,
  handleUpdateMateGrowthSettings as handleUpdateMateGrowthSettingsAction,
  type HomeMateGrowthApi,
  type HomeMateGrowthEventListRefresher,
  type HomeMateGrowthStatusRefresher,
} from "./mate-growth-actions.js";

type MateGrowthHandlersContext<TApi extends HomeMateGrowthApi> = {
  getApi: () => TApi | null;
  mateState: MateStorageState | null;
  mateGrowthApplying: boolean;
  mateGrowthBusy: boolean;
  mateGrowthEventBusyTarget: string | null;
  setMateGrowthApplying: (busy: boolean) => void;
  setMateGrowthBusy: (busy: boolean) => void;
  setSettingsFeedback: (message: string) => void;
  setMateGrowthFeedback: (message: string) => void;
  setMateGrowthSettings: (settings: MateGrowthSettings | null) => void;
  setMateGrowthEventsFeedback: (message: string) => void;
  setMateGrowthEventBusyTarget: (target: string | null) => void;
  setCorrectingMateGrowthEventId: (eventId: string | null) => void;
  setCorrectingMateGrowthEventStatement: (statement: string) => void;
  upsertMateGrowthEventListItem: (nextEvent: MateGrowthEventListItem | null) => void;
  refreshMateStatus: HomeMateGrowthStatusRefresher<TApi>;
  refreshMateGrowthEvents: HomeMateGrowthEventListRefresher<TApi>;
};

export type MateGrowthHandlers = Required<Pick<
  HomeSettingsContentProps,
  | "onApplyPendingGrowth"
  | "onReloadMateGrowthEvents"
  | "onBeginCorrectMateGrowthEvent"
  | "onChangeCorrectMateGrowthEventStatement"
  | "onCancelCorrectMateGrowthEvent"
  | "onCorrectMateGrowthEvent"
  | "onDisableMateGrowthEvent"
  | "onForgetMateGrowthEvent"
  | "onUpdateMateGrowthSettings"
>>;

export function buildMateGrowthHandlers<TApi extends HomeMateGrowthApi>({
  getApi,
  mateState,
  mateGrowthApplying,
  mateGrowthBusy,
  mateGrowthEventBusyTarget,
  setMateGrowthApplying,
  setMateGrowthBusy,
  setSettingsFeedback,
  setMateGrowthFeedback,
  setMateGrowthSettings,
  setMateGrowthEventsFeedback,
  setMateGrowthEventBusyTarget,
  setCorrectingMateGrowthEventId,
  setCorrectingMateGrowthEventStatement,
  upsertMateGrowthEventListItem,
  refreshMateStatus,
  refreshMateGrowthEvents,
}: MateGrowthHandlersContext<TApi>): MateGrowthHandlers {
  const cancelCorrectMateGrowthEvent = () => {
    handleCancelCorrectMateGrowthEventAction({
      setCorrectingMateGrowthEventId,
      setCorrectingMateGrowthEventStatement,
    });
  };

  const buildEventActionContext = () => ({
    api: getApi(),
    setMateGrowthEventsFeedback,
    upsertMateGrowthEventListItem,
    setMateGrowthEventBusyTarget,
    mateState,
    mateGrowthEventBusyTarget,
  });

  return {
    onApplyPendingGrowth: () => {
      void handleApplyPendingGrowthAction({
        api: getApi(),
        mateGrowthApplying,
        mateState,
        setMateGrowthApplying,
        setSettingsFeedback,
        refreshMateStatus,
        refreshMateGrowthEvents,
      });
    },
    onReloadMateGrowthEvents: () => {
      void handleReloadMateGrowthEventsAction({
        api: getApi(),
        mateState,
        setMateGrowthEventsFeedback,
        refreshMateGrowthEvents,
      });
    },
    onBeginCorrectMateGrowthEvent: (eventId, statement) => {
      handleBeginCorrectMateGrowthEventAction({
        eventId,
        statement,
        setCorrectingMateGrowthEventId,
        setCorrectingMateGrowthEventStatement,
      });
    },
    onChangeCorrectMateGrowthEventStatement: setCorrectingMateGrowthEventStatement,
    onCancelCorrectMateGrowthEvent: cancelCorrectMateGrowthEvent,
    onCorrectMateGrowthEvent: (eventId, statement) => {
      void handleCorrectMateGrowthEventAction({
        ...buildEventActionContext(),
        eventId,
        statement,
        runCorrectAction: (api: HomeMateGrowthApi) => api.correctMateGrowthEvent({ eventId, statement }),
        setCancelCorrectMateGrowthEvent: cancelCorrectMateGrowthEvent,
      });
    },
    onDisableMateGrowthEvent: (eventId) => {
      void handleDisableMateGrowthEventAction({
        ...buildEventActionContext(),
        eventId,
        runDisableAction: (api: HomeMateGrowthApi) => api.disableMateGrowthEvent({ eventId }),
      });
    },
    onForgetMateGrowthEvent: (eventId) => {
      void handleForgetMateGrowthEventAction({
        ...buildEventActionContext(),
        eventId,
        runForgetAction: (api: HomeMateGrowthApi) => api.forgetMateGrowthEvent({ eventId }),
      });
    },
    onUpdateMateGrowthSettings: (input: UpdateMateGrowthSettingsInput) => {
      void handleUpdateMateGrowthSettingsAction({
        api: getApi(),
        input,
        mateGrowthBusy,
        mateState,
        setMateGrowthBusy,
        setMateGrowthFeedback,
        setMateGrowthSettings,
      });
    },
  };
}
