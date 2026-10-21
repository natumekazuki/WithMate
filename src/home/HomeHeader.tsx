import type { ReactNode } from "react";

import { ButtonContent } from "../ui/button-content.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { LoadError } from "../ui/load-error.js";

export type HomeHeaderProps = {
  rightPaneView: "monitor" | "characters" | "previews";
  onChangeRightPaneView: (view: "monitor" | "characters" | "previews") => void;
  monitorWindowIcon: ReactNode;
  onOpenSessionMonitorWindow: () => void;
  onOpenSettingsWindow: () => void;
  onRestoreSessionWindows: () => void;
  sessionWindowRestoreIds?: readonly string[];
  sessionWindowRestorePending?: boolean;
  sessionWindowRestoreFeedback?: string;
  mateLoadStatus?: "loading" | "loaded" | "error";
  mateLoadError?: string;
  onRetryMateStatus?: () => void;
};

export function HomeHeader({
  rightPaneView,
  onChangeRightPaneView,
  monitorWindowIcon,
  onOpenSessionMonitorWindow,
  onOpenSettingsWindow,
  onRestoreSessionWindows,
  sessionWindowRestoreIds = [],
  sessionWindowRestorePending = false,
  sessionWindowRestoreFeedback = "",
  mateLoadStatus = "loaded",
  mateLoadError = "",
  onRetryMateStatus,
}: HomeHeaderProps) {
  return (
    <header className="home-settings-rail">
      <div className="home-pane-toggle" role="tablist" aria-label="Home right pane">
        <button
          className={`home-pane-toggle-button ${rightPaneView === "monitor" ? "active" : ""}`.trim()}
          type="button"
          role="tab"
          aria-selected={rightPaneView === "monitor"}
          onClick={() => onChangeRightPaneView("monitor")}
        >
          Monitor
        </button>
        <button
          className={`home-pane-toggle-button ${rightPaneView === "characters" ? "active" : ""}`.trim()}
          type="button"
          role="tab"
          aria-selected={rightPaneView === "characters"}
          onClick={() => onChangeRightPaneView("characters")}
        >
          Characters
        </button>
        <button
          className={`home-pane-toggle-button ${rightPaneView === "previews" ? "active" : ""}`.trim()}
          type="button"
          role="tab"
          aria-selected={rightPaneView === "previews"}
          onClick={() => onChangeRightPaneView("previews")}
        >
          Previews
        </button>
      </div>
      <div className="home-settings-actions">
        <button
          className="restore-session-windows-button"
          type="button"
          onClick={onRestoreSessionWindows}
          disabled={sessionWindowRestorePending || sessionWindowRestoreIds.length === 0}
          aria-busy={sessionWindowRestorePending}
        >
          <ButtonContent busy={sessionWindowRestorePending}>Restore Sessions</ButtonContent>
        </button>
        <button
          className="launch-toggle home-monitor-window-button"
          type="button"
          aria-label="Open session monitor window"
          title="Open session monitor window"
          onClick={onOpenSessionMonitorWindow}
        >
          {monitorWindowIcon}
        </button>
        <button className="launch-toggle home-settings-button" type="button" onClick={onOpenSettingsWindow}>
          Settings
        </button>
      </div>
      {mateLoadStatus !== "loaded" ? (
        <div className="home-header-feedback">
          {mateLoadStatus === "loading" ? <LoadingIndicator label="Loading app state" inline /> : (
            <LoadError message={mateLoadError || "Could not load app state."} onRetry={onRetryMateStatus} />
          )}
        </div>
      ) : null}
      {sessionWindowRestoreFeedback ? (
        <p className="session-window-restore-feedback home-header-feedback" role="status" aria-live="polite">
          {sessionWindowRestoreFeedback}
        </p>
      ) : null}
    </header>
  );
}
