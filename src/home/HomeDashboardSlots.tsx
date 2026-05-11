import type { ReactNode } from "react";

import { HomeLaunchDialog, type HomeLaunchDialogProps } from "./HomeLaunchDialog.js";
import { HomeRecentSessionsPanel, type HomeRecentSessionsPanelProps } from "./HomeRecentSessionsPanel.js";
import { HomeRightPane, type HomeRightPaneProps } from "./HomeRightPane.js";

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
