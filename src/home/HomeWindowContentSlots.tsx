import type { ReactNode } from "react";

import { HomeMonitorContent, type HomeMonitorContentProps } from "./HomeMonitorContent.js";
import { HomeMateSetupPanel, type HomeMateSetupPanelProps } from "../mate/MateSetupPanel.js";
import { HomeSettingsContent, type HomeSettingsContentProps } from "../settings/SettingsContent.js";

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
    memoryManagementContent: <HomeSettingsContent {...memoryManagementContent} />,
    mateSetupContent: <HomeMateSetupPanel {...mateSetupContent} />,
    monitorContent: <HomeMonitorContent {...monitorContent} />,
  };
}
