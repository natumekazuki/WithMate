import type { ReactNode } from "react";

import type { CharacterCatalogEntry } from "../character/character-catalog.js";
import type { HomeRightPaneProps } from "./HomeRightPane.js";
import type { HomeMonitorEntry } from "./home-session-projection.js";

type HomeRightPaneHandlers = {
  onChangeRightPaneView: (view: HomeRightPaneProps["rightPaneView"]) => void;
  onOpenSessionMonitorWindow: () => void;
  onOpenSettingsWindow: () => void;
  onRestoreSessionWindows: () => void;
  onCreateCharacter: () => void;
  onEditCharacter: (characterId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onOpenCompanionReview: (sessionId: string) => void;
};

export type HomeRightPanePropsInput = {
  rightPaneView: HomeRightPaneProps["rightPaneView"];
  runningMonitorEntries: HomeMonitorEntry[];
  nonRunningMonitorEntries: HomeMonitorEntry[];
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
    onOpenCompanionReview: handlers.onOpenCompanionReview,
    canUsePrimaryFeatures,
    sessionWindowRestoreIds,
    sessionWindowRestorePending,
    sessionWindowRestoreFeedback,
  };
}
