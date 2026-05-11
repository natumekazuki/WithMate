import type { ReactNode } from "react";

import {
  HomeMateSetupPanel,
  type HomeMateSetupPanelProps,
  HomeMonitorContent,
  type HomeMonitorContentProps,
  HomeSettingsContent,
  type HomeSettingsContentProps,
} from "../home-components.js";

type HomeWindowContentSlotsInput = {
  settingsContent: HomeSettingsContentProps;
  memoryManagementContent: HomeSettingsContentProps;
  mateSetupContent: HomeMateSetupPanelProps;
  monitorContent: HomeMonitorContentProps;
};

type HomeWindowContentSlots = {
  settingsContent: ReactNode;
  memoryManagementContent: ReactNode;
  mateSetupContent: ReactNode;
  monitorContent: ReactNode;
};

export function buildHomeWindowContentSlots({
  settingsContent,
  memoryManagementContent,
  mateSetupContent,
  monitorContent,
}: HomeWindowContentSlotsInput): HomeWindowContentSlots {
  return {
    settingsContent: <HomeSettingsContent {...settingsContent} />,
    memoryManagementContent: <HomeSettingsContent {...memoryManagementContent} memoryManagementOnly />,
    mateSetupContent: <HomeMateSetupPanel {...mateSetupContent} />,
    monitorContent: <HomeMonitorContent {...monitorContent} />,
  };
}
