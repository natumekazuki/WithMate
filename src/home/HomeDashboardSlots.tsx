import type { ReactNode } from "react";

import {
  HomeLaunchDialog,
  type HomeLaunchDialogProps,
} from "./HomeLaunchDialog.js";
import {
  HomeRecentSessionsPanel,
  type HomeRecentSessionsPanelProps,
} from "./HomeRecentSessionsPanel.js";
import { HomeRightPane, type HomeRightPaneProps } from "./HomeRightPane.js";
import { HomeHeader, type HomeHeaderProps } from "./HomeHeader.js";

/** 通常の Home を構成する各機能へ渡す表示引数。ヘッダーと右ペインは同じ接続を共有する。 */
type HomeDashboardSlotsInput = {
  recentSessionsPanel: HomeRecentSessionsPanelProps;
  rightPane: HomeRightPaneProps & HomeHeaderProps;
  launchDialog: HomeLaunchDialogProps;
};

/** 通常の Home のレイアウトに据える、組立て済みの領域と起動欄。 */
type HomeDashboardSlots = {
  header: ReactNode;
  recentSessionsPanel: ReactNode;
  rightPane: ReactNode;
  launchDialog: ReactNode;
};

/** 各機能の表示引数をそれぞれのコンポーネントへ渡し、画面構成用の領域を返す。 */
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
