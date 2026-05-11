import type { ReactNode } from "react";

import {
  HomeLaunchDialog,
  type HomeLaunchDialogProps,
  HomeRecentSessionsPanel,
  type HomeRecentSessionsPanelProps,
  HomeRightPane,
  type HomeRightPaneProps,
} from "../home-components.js";

type HomeDashboardSlotsInput = {
  recentSessionsPanel: HomeRecentSessionsPanelProps;
  rightPane: HomeRightPaneProps;
  launchDialog: HomeLaunchDialogProps;
};

type HomeDashboardSlots = {
  recentSessionsPanel: ReactNode;
  rightPane: ReactNode;
  launchDialog: ReactNode;
};

export function buildHomeDashboardSlots({
  recentSessionsPanel,
  rightPane,
  launchDialog,
}: HomeDashboardSlotsInput): HomeDashboardSlots {
  return {
    recentSessionsPanel: <HomeRecentSessionsPanel {...recentSessionsPanel} />,
    rightPane: <HomeRightPane {...rightPane} />,
    launchDialog: <HomeLaunchDialog {...launchDialog} />,
  };
}
