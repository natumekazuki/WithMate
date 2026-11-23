import { useRef, type ReactNode } from "react";

import { ButtonContent } from "../ui/button-content.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { LoadError } from "../ui/load-error.js";
import { renderHomePlusIcon, renderHomeSearchIcon } from "./home-icons.js";

export const homeRightPaneLabels = { monitor: "Monitor", crew: "Crew", characters: "Characters", previews: "Previews" } as const;
export type HomeRightPaneView = keyof typeof homeRightPaneLabels;
const homeRightPaneViews = Object.keys(homeRightPaneLabels) as HomeRightPaneView[];

export type HomeHeaderProps = {
  searchInputText: string;
  onChangeSearchText: (value: string) => void;
  onSearchCompositionStart?: () => void;
  onSearchCompositionEnd?: (value: string) => void;
  onOpenLaunchDialog: () => void;
  canCreateSession: boolean;
  rightPaneView: HomeRightPaneView;
  onChangeRightPaneView: (view: HomeRightPaneView) => void;
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
  searchInputText,
  onChangeSearchText,
  onSearchCompositionStart,
  onSearchCompositionEnd,
  onOpenLaunchDialog,
  canCreateSession,
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
  const searchInputRef = useRef<HTMLInputElement>(null);
  return (
    <header className="home-settings-rail">
      <div className="home-header-search">
        <div className="toolbar-search-field home-header-search-field">
          <span className="toolbar-search-icon" aria-hidden="true">{renderHomeSearchIcon()}</span>
          <input
            ref={searchInputRef}
            className="toolbar-search-input"
            type="search"
            aria-label="Search Sessions And Characters"
            value={searchInputText}
            onChange={(event) => onChangeSearchText(event.target.value)}
            onCompositionStart={onSearchCompositionStart}
            onCompositionEnd={(event) => onSearchCompositionEnd?.(event.currentTarget.value)}
          />
          {searchInputText ? (
            <button
              className="home-search-clear"
              type="button"
              aria-label="Clear Search"
              title="Clear Search"
              onClick={() => {
                onChangeSearchText("");
                searchInputRef.current?.focus();
              }}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                <path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          ) : null}
        </div>
        <button
          className="start-session-button"
          type="button"
          onClick={onOpenLaunchDialog}
          disabled={!canCreateSession}
          aria-label="New session"
          title="New Session"
        >
          <span className="home-create-icon">{renderHomePlusIcon()}</span>
        </button>
      </div>
      <div className="home-pane-toggle" role="tablist" aria-label="Home right pane">
        {homeRightPaneViews.map((view, index) => (
          <button
            key={view}
            className={`home-pane-toggle-button${rightPaneView === view ? " active" : ""}`}
            type="button"
            role="tab"
            aria-controls={rightPaneView === view ? `home-panel-${view}` : undefined}
            aria-selected={rightPaneView === view}
            tabIndex={rightPaneView === view ? 0 : -1}
            onClick={() => onChangeRightPaneView(view)}
            onKeyDown={(event) => {
              const count = homeRightPaneViews.length;
              const next = event.key === "ArrowLeft" ? (index - 1 + count) % count
                : event.key === "ArrowRight" ? (index + 1) % count
                : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : null;
              if (next === null) return;
              event.preventDefault();
              onChangeRightPaneView(homeRightPaneViews[next]!);
              event.currentTarget.parentElement?.querySelectorAll("button")[next]?.focus();
            }}
          >
            {homeRightPaneLabels[view]}
          </button>
        ))}
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
