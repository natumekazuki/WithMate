import type { ReactNode } from "react";

import {
  HomeMonitorContent,
  type HomeMonitorContentProps,
} from "./HomeMonitorContent.js";
import {
  HomeMateSetupPanel,
  type HomeMateSetupPanelProps,
} from "../mate/MateSetupPanel.js";
import {
  HomeSettingsContent,
  type HomeSettingsContentProps,
} from "../settings/SettingsContent.js";

/** 設定、Mate セットアップ、独立 Monitor の本体に渡す機能別の引数。 */
type HomeWindowContentSlotsInput = {
  settingsContent: HomeSettingsContentProps;
  mateSetupContent: HomeMateSetupPanelProps;
  monitorContent: HomeMonitorContentProps;
};

/** ウィンドウの振り分け先へ渡す、機能ごとの組立て済みコンテンツ。 */
type HomeWindowContentSlots = {
  settingsContent: ReactNode;
  mateSetupContent: ReactNode;
  monitorContent: ReactNode;
};

/** 各コンテンツを共通の機能コンポーネントから作り、どのウィンドウを表示するかの判断は行わない。 */
export function buildHomeWindowContentSlots({
  settingsContent,
  mateSetupContent,
  monitorContent,
}: HomeWindowContentSlotsInput): HomeWindowContentSlots {
  return {
    settingsContent: <HomeSettingsContent {...settingsContent} />,
    mateSetupContent: <HomeMateSetupPanel {...mateSetupContent} />,
    monitorContent: <HomeMonitorContent {...monitorContent} />,
  };
}
