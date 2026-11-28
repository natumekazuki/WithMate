import type { ReactNode } from "react";

import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
import type { HomeRightPaneProps } from "./HomeRightPane.js";
import type { HomeHeaderProps } from "./HomeHeader.js";
import type {
  HomeMonitorAuxiliaryDataState,
  HomeMonitorEntry,
} from "./home-session-projection.js";
import type { HomeCharacterLoadStatus } from "./home-launch-state.js";
import type {
  SessionMonitorContextMenuPoint,
  SessionMonitorEntryKind,
} from "../../src-shared/window/withmate-window-types.js";

/** Home のヘッダーと右ペインから実行する検索・ウィンドウ・Session・Character の操作。 */
type HomeRightPaneHandlers = {
  onChangeSearchText: (value: string) => void;
  onSearchCompositionStart?: () => void;
  onSearchCompositionEnd?: (value: string) => void;
  onOpenLaunchDialog: () => void;
  onChangeRightPaneView: (view: HomeRightPaneProps["rightPaneView"]) => void;
  onOpenSessionMonitorWindow: () => void;
  onOpenSettingsWindow: () => void;
  onRestoreSessionWindows: () => void;
  onCreateCharacter: () => void;
  onEditCharacter: (characterId: string) => void;
  onOpenSession: (sessionId: string, auxiliarySessionId?: string) => void;
  onShowSessionMonitorContextMenu: (
    kind: SessionMonitorEntryKind,
    sessionId: string,
    point: SessionMonitorContextMenuPoint,
  ) => void;
};

/** ヘッダーと右ペインの共通接続に必要な、入力中と確定の検索値、一覧状態、および操作。 */
export type HomeRightPanePropsInput = {
  searchText: string;
  searchInputText: string;
  canCreateSession: boolean;
  providerQuota?: ReactNode;
  rightPaneView: HomeRightPaneProps["rightPaneView"];
  approvalMonitorEntries: HomeMonitorEntry[];
  runningMonitorEntries: HomeMonitorEntry[];
  nonRunningMonitorEntries: HomeMonitorEntry[];
  auxiliaryDataState: HomeMonitorAuxiliaryDataState;
  auxiliaryRefreshing?: boolean;
  sessionWindowsDataState?: "loading" | "loaded" | "error";
  monitorRunningEmptyMessage?: string;
  monitorNonRunningEmptyMessage?: string;
  sessionMonitorFeedback?: string;
  onRetrySessionSummaries?: () => void;
  monitorWindowIcon: ReactNode;
  characterEntries: CharacterCatalogEntry[];
  characterLoadStatus?: HomeCharacterLoadStatus;
  characterListFeedback?: string;
  onRetryCharacters?: () => void;
  handlers: HomeRightPaneHandlers;
  sessionWindowRestoreIds?: readonly string[];
  sessionWindowRestorePending?: boolean;
  sessionWindowRestoreFeedback?: string;
  mateLoadStatus?: HomeHeaderProps["mateLoadStatus"];
  mateLoadError?: string;
  onRetryMateStatus?: () => void;
};

/** Home の所有状態と操作を、ヘッダーと右ペインが受け取る表示用の引数へまとめる。 */
export function buildHomeRightPaneProps({
  searchText,
  searchInputText,
  canCreateSession,
  providerQuota,
  rightPaneView,
  approvalMonitorEntries,
  runningMonitorEntries,
  nonRunningMonitorEntries,
  auxiliaryDataState,
  auxiliaryRefreshing,
  sessionWindowsDataState,
  monitorRunningEmptyMessage,
  monitorNonRunningEmptyMessage,
  sessionMonitorFeedback,
  onRetrySessionSummaries,
  monitorWindowIcon,
  characterEntries,
  characterLoadStatus,
  characterListFeedback,
  onRetryCharacters,
  handlers,
  sessionWindowRestoreIds,
  sessionWindowRestorePending,
  sessionWindowRestoreFeedback,
  mateLoadStatus,
  mateLoadError,
  onRetryMateStatus,
}: HomeRightPanePropsInput): HomeRightPaneProps & HomeHeaderProps {
  return {
    searchText,
    searchInputText,
    canCreateSession,
    onChangeSearchText: handlers.onChangeSearchText,
    onSearchCompositionStart: handlers.onSearchCompositionStart,
    onSearchCompositionEnd: handlers.onSearchCompositionEnd,
    onOpenLaunchDialog: handlers.onOpenLaunchDialog,
    providerQuota,
    rightPaneView,
    approvalMonitorEntries,
    runningMonitorEntries,
    nonRunningMonitorEntries,
    auxiliaryDataState,
    auxiliaryRefreshing,
    sessionWindowsDataState,
    monitorRunningEmptyMessage,
    monitorNonRunningEmptyMessage,
    sessionMonitorFeedback,
    onRetrySessionSummaries,
    monitorWindowIcon,
    characterEntries,
    characterLoadStatus,
    characterListFeedback,
    onRetryCharacters,
    onChangeRightPaneView: handlers.onChangeRightPaneView,
    onOpenSessionMonitorWindow: handlers.onOpenSessionMonitorWindow,
    onOpenSettingsWindow: handlers.onOpenSettingsWindow,
    onRestoreSessionWindows: handlers.onRestoreSessionWindows,
    onCreateCharacter: handlers.onCreateCharacter,
    onEditCharacter: handlers.onEditCharacter,
    onOpenSession: handlers.onOpenSession,
    onShowSessionMonitorContextMenu: handlers.onShowSessionMonitorContextMenu,
    sessionWindowRestoreIds,
    sessionWindowRestorePending,
    sessionWindowRestoreFeedback,
    mateLoadStatus,
    mateLoadError,
    onRetryMateStatus,
  };
}
