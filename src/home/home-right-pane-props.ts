import type { ReactNode } from "react";

import type { HomeRightPaneProps } from "./HomeRightPane.js";
import type { HomeMonitorEntry } from "./home-session-projection.js";
import type { MateProfile } from "../mate/mate-state.js";

type HomeRightPaneHandlers = {
  onChangeRightPaneView: (view: HomeRightPaneProps["rightPaneView"]) => void;
  onOpenSessionMonitorWindow: () => void;
  onOpenSettingsWindow: () => void;
  onOpenMateProfile: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenCompanionReview: (sessionId: string) => void;
};

export type HomeRightPanePropsInput = {
  rightPaneView: HomeRightPaneProps["rightPaneView"];
  runningMonitorEntries: HomeMonitorEntry[];
  nonRunningMonitorEntries: HomeMonitorEntry[];
  monitorWindowIcon: ReactNode;
  mateProfile: MateProfile | null;
  handlers: HomeRightPaneHandlers;
  canUsePrimaryFeatures?: boolean;
};

export function buildHomeRightPaneProps({
  rightPaneView,
  runningMonitorEntries,
  nonRunningMonitorEntries,
  monitorWindowIcon,
  mateProfile,
  handlers,
  canUsePrimaryFeatures,
}: HomeRightPanePropsInput): HomeRightPaneProps {
  return {
    rightPaneView,
    runningMonitorEntries,
    nonRunningMonitorEntries,
    monitorWindowIcon,
    mateProfile,
    onChangeRightPaneView: handlers.onChangeRightPaneView,
    onOpenSessionMonitorWindow: handlers.onOpenSessionMonitorWindow,
    onOpenSettingsWindow: handlers.onOpenSettingsWindow,
    onOpenMateProfile: handlers.onOpenMateProfile,
    onOpenSession: handlers.onOpenSession,
    onOpenCompanionReview: handlers.onOpenCompanionReview,
    canUsePrimaryFeatures,
  };
}
