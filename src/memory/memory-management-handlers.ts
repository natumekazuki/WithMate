import type { HomeSettingsContentBaseProps } from "../settings/home-settings-content-props.js";
import type { MemoryManagementPageState } from "./memory-management-page-state.js";
import type { MemoryManagementViewFilters } from "./memory-management-view.js";
import {
  handleChangeMemoryManagementViewFilters as handleChangeMemoryManagementViewFiltersAction,
  handleDeleteCharacterMemoryEntry as handleDeleteCharacterMemoryEntryAction,
  handleDeleteMateProfileItem as handleDeleteMateProfileItemAction,
  handleDeleteProjectMemoryEntry as handleDeleteProjectMemoryEntryAction,
  handleDeleteSessionMemory as handleDeleteSessionMemoryAction,
  handleLoadMoreMemoryManagement as handleLoadMoreMemoryManagementAction,
  handleReloadMemoryManagement as handleReloadMemoryManagementAction,
  type HomeMemoryManagementApi,
  type SetMemoryManagementPages,
  type SetMemoryManagementSnapshot,
} from "./memory-management-actions.js";

type MemoryManagementHandlersContext = {
  getApi: () => HomeMemoryManagementApi | null;
  usesMemoryManagementWindow: boolean;
  memoryManagementFilters: MemoryManagementViewFilters;
  memoryManagementPages: MemoryManagementPageState;
  beginMemoryManagementRequest: () => number;
  isLatestMemoryManagementRequest: (requestId: number) => boolean;
  setMemoryManagementLoaded: (loaded: boolean) => void;
  setMemoryManagementFilters: (filters: MemoryManagementViewFilters) => void;
  setMemoryManagementSnapshot: SetMemoryManagementSnapshot;
  setMemoryManagementPages: SetMemoryManagementPages;
  setMemoryManagementFeedback: (feedback: string) => void;
  setMemoryManagementBusyTarget: (busyTarget: string | null) => void;
};

export type MemoryManagementHandlers = Pick<
  HomeSettingsContentBaseProps,
  | "onReloadMemoryManagement"
  | "onChangeMemoryManagementViewFilters"
  | "onLoadMoreMemoryManagement"
  | "onDeleteSessionMemory"
  | "onDeleteProjectMemoryEntry"
  | "onDeleteCharacterMemoryEntry"
  | "onDeleteMateProfileItem"
>;

export function buildMemoryManagementHandlers({
  getApi,
  usesMemoryManagementWindow,
  memoryManagementFilters,
  memoryManagementPages,
  beginMemoryManagementRequest,
  isLatestMemoryManagementRequest,
  setMemoryManagementLoaded,
  setMemoryManagementFilters,
  setMemoryManagementSnapshot,
  setMemoryManagementPages,
  setMemoryManagementFeedback,
  setMemoryManagementBusyTarget,
}: MemoryManagementHandlersContext): MemoryManagementHandlers {
  const buildContext = () => ({
    api: getApi(),
    usesMemoryManagementWindow,
    memoryManagementFilters,
    memoryManagementPages,
    beginMemoryManagementRequest,
    isLatestMemoryManagementRequest,
    setMemoryManagementLoaded,
    setMemoryManagementSnapshot,
    setMemoryManagementPages,
    setMemoryManagementFeedback,
    setMemoryManagementBusyTarget,
  });

  return {
    onReloadMemoryManagement: () => {
      void handleReloadMemoryManagementAction({
        ...buildContext(),
      });
    },
    onLoadMoreMemoryManagement: (domain) => {
      void handleLoadMoreMemoryManagementAction({
        ...buildContext(),
        domain,
      });
    },
    onChangeMemoryManagementViewFilters: (filters) => {
      void handleChangeMemoryManagementViewFiltersAction({
        ...buildContext(),
        setMemoryManagementFilters,
        filters,
      });
    },
    onDeleteSessionMemory: (sessionId) => {
      void handleDeleteSessionMemoryAction({
        ...buildContext(),
        sessionId,
      });
    },
    onDeleteProjectMemoryEntry: (entryId) => {
      void handleDeleteProjectMemoryEntryAction({
        ...buildContext(),
        entryId,
      });
    },
    onDeleteCharacterMemoryEntry: (entryId) => {
      void handleDeleteCharacterMemoryEntryAction({
        ...buildContext(),
        entryId,
      });
    },
    onDeleteMateProfileItem: (itemId) => {
      void handleDeleteMateProfileItemAction({
        ...buildContext(),
        itemId,
      });
    },
  };
}
