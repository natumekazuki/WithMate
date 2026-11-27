import type { ReactNode } from "react";

import { MateProfileScreen } from "../mate/MateProfileScreen.js";
import { SettingsWindowScreen } from "../settings/SettingsWindowScreen.js";
import { HomeDashboardScreen } from "./HomeDashboardScreen.js";
import { HomeMonitorWindowScreen } from "./HomeMonitorWindowScreen.js";
import { HomeStatusScreen } from "./HomeStatusScreen.js";
import type { HomeDashboardScreenProps } from "./HomeDashboardScreen.js";

type HomeAppRouterProps = {
  desktopRuntime: boolean;
  homePageClassName: string;
  isSettingsWindowMode: boolean;
  settingsContent: ReactNode;
  mateProfileEditorOpen: boolean;
  mateSetupContent: ReactNode;
  isMonitorWindowMode: boolean;
  monitorContent: ReactNode;
  header: ReactNode;
  rightPaneLabel: HomeDashboardScreenProps["rightPaneLabel"];
  recentSessionsPanel: ReactNode;
  rightPane: ReactNode;
  launchDialog: ReactNode;
};

export function HomeAppRouter({
  desktopRuntime,
  homePageClassName,
  isSettingsWindowMode,
  settingsContent,
  mateProfileEditorOpen,
  mateSetupContent,
  isMonitorWindowMode,
  monitorContent,
  header,
  rightPaneLabel,
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

  if (mateProfileEditorOpen) {
    return <MateProfileScreen homePageClassName={homePageClassName} content={mateSetupContent} />;
  }

  if (isMonitorWindowMode) {
    return <HomeMonitorWindowScreen homePageClassName={homePageClassName} content={monitorContent} />;
  }

  return (
    <HomeDashboardScreen
      homePageClassName={homePageClassName}
      header={header}
      rightPaneLabel={rightPaneLabel}
      recentSessionsPanel={recentSessionsPanel}
      rightPane={rightPane}
      launchDialog={launchDialog}
    />
  );
}
