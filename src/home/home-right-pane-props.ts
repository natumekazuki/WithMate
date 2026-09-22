import type { ReactNode } from "react";

import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
import type { HomeRightPaneProps } from "./HomeRightPane.js";
import type { HomeMonitorAuxiliaryDataState, HomeMonitorEntry } from "./home-session-projection.js";
import type {
  SessionMonitorContextMenuPoint,
  SessionMonitorEntryKind,
} from "../../src-shared/window/withmate-window-types.js";

type HomeRightPaneHandlers = {
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

export type HomeRightPanePropsInput = {
  rightPaneView: HomeRightPaneProps["rightPaneView"];
  runningMonitorEntries: HomeMonitorEntry[];
  nonRunningMonitorEntries: HomeMonitorEntry[];
  auxiliaryDataState: HomeMonitorAuxiliaryDataState;
  sessionMonitorFeedback?: string;
  monitorWindowIcon: ReactNode;
  characterEntries: CharacterCatalogEntry[];
  characterListFeedback?: string;
  handlers: HomeRightPaneHandlers;
  canUsePrimaryFeatures?: boolean;
  sessionWindowRestoreIds?: readonly string[];
  sessionWindowRestorePending?: boolean;
  sessionWindowRestoreFeedback?: string;
};

export function buildHomeRightPaneProps({
  rightPaneView,
  runningMonitorEntries,
  nonRunningMonitorEntries,
  auxiliaryDataState,
  sessionMonitorFeedback,
  monitorWindowIcon,
  characterEntries,
  characterListFeedback,
  handlers,
  canUsePrimaryFeatures,
  sessionWindowRestoreIds,
  sessionWindowRestorePending,
  sessionWindowRestoreFeedback,
}: HomeRightPanePropsInput): HomeRightPaneProps {
  return {
    rightPaneView,
    runningMonitorEntries,
    nonRunningMonitorEntries,
    auxiliaryDataState,
    sessionMonitorFeedback,
    monitorWindowIcon,
    characterEntries,
    characterListFeedback,
    onChangeRightPaneView: handlers.onChangeRightPaneView,
    onOpenSessionMonitorWindow: handlers.onOpenSessionMonitorWindow,
    onOpenSettingsWindow: handlers.onOpenSettingsWindow,
    onRestoreSessionWindows: handlers.onRestoreSessionWindows,
    onCreateCharacter: handlers.onCreateCharacter,
    onEditCharacter: handlers.onEditCharacter,
    onOpenSession: handlers.onOpenSession,
    onShowSessionMonitorContextMenu: handlers.onShowSessionMonitorContextMenu,
    canUsePrimaryFeatures,
    sessionWindowRestoreIds,
    sessionWindowRestorePending,
    sessionWindowRestoreFeedback,
  };
}
