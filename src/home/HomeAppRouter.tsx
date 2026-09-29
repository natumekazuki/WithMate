import type { ComponentProps, ReactNode } from "react";

import { MateProfileScreen } from "../mate/MateProfileScreen.js";
import { MemoryV6ReviewScreen } from "../memory-v6/MemoryV6ReviewScreen.js";
import { SettingsWindowScreen } from "../settings/SettingsWindowScreen.js";
import { HomeDashboardScreen } from "./HomeDashboardScreen.js";
import { HomeMonitorWindowScreen } from "./HomeMonitorWindowScreen.js";
import { HomeStatusScreen } from "./HomeStatusScreen.js";

type HomeAppRouterProps = {
  desktopRuntime: boolean;
  homePageClassName: string;
  isSettingsWindowMode: boolean;
  isMemoryReviewWindowMode: boolean;
  getMemoryReviewApi: ComponentProps<typeof MemoryV6ReviewScreen>["getApi"];
  settingsContent: ReactNode;
  mateProfileEditorOpen: boolean;
  mateSetupContent: ReactNode;
  isMonitorWindowMode: boolean;
  monitorContent: ReactNode;
  recentSessionsPanel: ReactNode;
  rightPane: ReactNode;
  launchDialog: ReactNode;
};

export function HomeAppRouter({
  desktopRuntime,
  homePageClassName,
  isSettingsWindowMode,
  isMemoryReviewWindowMode,
  getMemoryReviewApi,
  settingsContent,
  mateProfileEditorOpen,
  mateSetupContent,
  isMonitorWindowMode,
  monitorContent,
  recentSessionsPanel,
  rightPane,
  launchDialog,
}: HomeAppRouterProps) {
  if (!desktopRuntime) {
    return <HomeStatusScreen homePageClassName={homePageClassName} message="Home is available from the Electron desktop app." />;
  }

  if (isSettingsWindowMode) {
    return (
      <SettingsWindowScreen
        homePageClassName={homePageClassName}
        content={settingsContent}
      />
    );
  }

  if (isMemoryReviewWindowMode) {
    return <MemoryV6ReviewScreen homePageClassName={homePageClassName} getApi={getMemoryReviewApi} />;
  }

  if (mateProfileEditorOpen) {
    return <MateProfileScreen homePageClassName={homePageClassName} content={mateSetupContent} />;
  }

  if (isMonitorWindowMode) {
    return <HomeMonitorWindowScreen homePageClassName={homePageClassName} content={monitorContent} />;
  }

  return (
    <HomeDashboardScreen
      homePageClassName={homePageClassName}
      recentSessionsPanel={recentSessionsPanel}
      rightPane={rightPane}
      launchDialog={launchDialog}
    />
  );
}
