import { useId, useState, type ReactNode } from "react";

import { ConcurrentChatSplitter } from "../chat/chat-window.js";

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
  const [monitorWidthRatio, setMonitorWidthRatio] = useState(0.5);
  const sessionsId = useId();
  const monitorId = useId();

  return (
    <div className={homePageClassName}>
      <main
        className="home-layout home-dashboard-layout rise-2"
        style={{ gridTemplateColumns: `minmax(0, ${1 - monitorWidthRatio}fr) var(--session-dock-splitter-size) minmax(0, ${monitorWidthRatio}fr)` }}
      >
        <div
          id={sessionsId}
          className={`home-dashboard-pane home-sessions-pane${monitorWidthRatio >= 1 ? " is-collapsed" : ""}`}
          inert={monitorWidthRatio >= 1}
          aria-hidden={monitorWidthRatio >= 1}
        >
          {recentSessionsPanel}
        </div>
        <ConcurrentChatSplitter
          widthRatio={monitorWidthRatio}
          onWidthRatioChange={setMonitorWidthRatio}
          mainPane={{ selector: ".home-sessions-pane", id: sessionsId, label: "Sessions" }}
          auxiliaryPane={{ selector: ".home-monitor-pane", id: monitorId, label: "Monitor" }}
        />
        <div
          id={monitorId}
          className={`home-dashboard-pane home-monitor-pane${monitorWidthRatio <= 0 ? " is-collapsed" : ""}`}
          inert={monitorWidthRatio <= 0}
          aria-hidden={monitorWidthRatio <= 0}
        >
          {rightPane}
        </div>
      </main>

      {launchDialog}
    </div>
  );
}
