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
  settingsWindowReady: boolean;
  settingsContent: ReactNode;
  isMateStateLoading: boolean;
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
  settingsWindowReady,
  settingsContent,
  isMateStateLoading,
  mateProfileEditorOpen,
  mateSetupContent,
  isMonitorWindowMode,
  monitorContent,
  recentSessionsPanel,
  rightPane,
  launchDialog,
}: HomeAppRouterProps) {
  if (!desktopRuntime) {
    return <HomeStatusScreen homePageClassName={homePageClassName} message="Home は Electron から起動してね。" />;
  }

  if (isSettingsWindowMode) {
    return (
      <SettingsWindowScreen
        homePageClassName={homePageClassName}
        ready={settingsWindowReady}
        content={settingsContent}
      />
    );
  }

  if (isMemoryReviewWindowMode) {
    return <MemoryV6ReviewScreen homePageClassName={homePageClassName} getApi={getMemoryReviewApi} />;
  }

  if (isMateStateLoading) {
    return <HomeStatusScreen homePageClassName={homePageClassName} message="Mate 状態を読み込んでるよ..." />;
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
