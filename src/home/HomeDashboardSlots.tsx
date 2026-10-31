import type { ReactNode } from "react";

import { HomeLaunchDialog, type HomeLaunchDialogProps } from "./HomeLaunchDialog.js";
import { HomeRecentSessionsPanel, type HomeRecentSessionsPanelProps } from "./HomeRecentSessionsPanel.js";
import { HomeRightPane, type HomeRightPaneProps } from "./HomeRightPane.js";
import { HomeHeader, type HomeHeaderProps } from "./HomeHeader.js";

type HomeDashboardSlotsInput = {
  recentSessionsPanel: HomeRecentSessionsPanelProps;
  rightPane: HomeRightPaneProps & HomeHeaderProps;
  launchDialog: HomeLaunchDialogProps;
};

type HomeDashboardSlots = {
  header: ReactNode;
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
    header: <HomeHeader {...rightPane} />,
    recentSessionsPanel: <HomeRecentSessionsPanel {...recentSessionsPanel} />,
    rightPane: <HomeRightPane {...rightPane} />,
    launchDialog: <HomeLaunchDialog {...launchDialog} />,
  };
}
