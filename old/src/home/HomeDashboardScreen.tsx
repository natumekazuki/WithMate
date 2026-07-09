import type { ReactNode } from "react";

type HomeDashboardScreenProps = {
  homePageClassName: string;
  recentSessionsPanel: ReactNode;
  rightPane: ReactNode;
  launchDialog: ReactNode;
};

export function HomeDashboardScreen({
  homePageClassName,
  recentSessionsPanel,
  rightPane,
  launchDialog,
}: HomeDashboardScreenProps) {
  return (
    <div className={homePageClassName}>
      <main className="home-layout rise-2">
        {recentSessionsPanel}
        {rightPane}
      </main>

      {launchDialog}
    </div>
  );
}
