import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { ConcurrentChatSplitter } from "../chat/chat-window.js";

type HomeDashboardScreenProps = {
  homePageClassName: string;
  header: ReactNode;
  rightPaneLabel: "Monitor" | "Characters";
  recentSessionsPanel: ReactNode;
  rightPane: ReactNode;
  launchDialog: ReactNode;
};

export function HomeDashboardScreen({
  homePageClassName,
  header,
  rightPaneLabel,
  recentSessionsPanel,
  rightPane,
  launchDialog,
}: HomeDashboardScreenProps) {
  const [monitorWidthRatio, setMonitorWidthRatio] = useState(0.5);
  const layoutRef = useRef<HTMLElement>(null);
  const sessionsId = useId();
  const monitorId = useId();

  useLayoutEffect(() => {
    const layout = layoutRef.current;
    const view = layout?.ownerDocument.defaultView;
    if (!layout || !view) return;
    const update = () => {
      const splitter = layout.querySelector<HTMLElement>(".concurrent-chat-splitter");
      const width = layout.getBoundingClientRect().width - (splitter?.getBoundingClientRect().width ?? 0);
      const minimum = (selector: string) => {
        const pane = layout.querySelector<HTMLElement>(selector);
        return pane ? Number.parseFloat(view.getComputedStyle(pane).getPropertyValue("--session-region-min-width")) || 0 : 0;
      };
      const minRatio = minimum(".home-monitor-pane") / width;
      const maxRatio = 1 - minimum(".home-sessions-pane") / width;
      if (width <= 0 || minRatio > maxRatio) return;
      setMonitorWidthRatio((ratio) => ratio <= 0 || ratio >= 1 ? ratio : Math.max(minRatio, Math.min(maxRatio, ratio)));
    };
    update();
    const observer = view.ResizeObserver ? new view.ResizeObserver(update) : null;
    observer?.observe(layout);
    return () => observer?.disconnect();
  }, [monitorWidthRatio]);

  return (
    <div className={`${homePageClassName} home-page-dashboard`}>
      {header}
      <main
        ref={layoutRef}
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
          auxiliaryPane={{ selector: ".home-monitor-pane", id: monitorId, label: rightPaneLabel }}
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
