import type { ReactNode } from "react";

import type { CharacterCatalogEntry } from "../character/character-catalog.js";
import type { HomeMonitorEntry } from "./home-session-projection.js";
import { HomeCharactersPanel } from "./HomeCharactersPanel.js";
import { HomeMonitorContent } from "./HomeMonitorContent.js";
import { ScheduleWorkspace } from "../session-schedule-workspace.js";
import type { ScheduleSummaryProjection } from "../session-schedule-ui-projection.js";

export type HomeRightPaneProps = {
  rightPaneView: "monitor" | "characters" | "schedules";
  schedules?: readonly ScheduleSummaryProjection[];
  scheduleLoadState?: "loading" | "loaded" | "error";
  runningMonitorEntries: HomeMonitorEntry[];
  nonRunningMonitorEntries: HomeMonitorEntry[];
  monitorWindowIcon: ReactNode;
  characterEntries: CharacterCatalogEntry[];
  characterListFeedback?: string;
  onChangeRightPaneView: (view: "monitor" | "characters" | "schedules") => void;
  onOpenSessionMonitorWindow: () => void;
  onOpenCoordinationWindow: () => void;
  onOpenSettingsWindow: () => void;
  onRestoreSessionWindows: () => void;
  onCreateCharacter: () => void;
  onEditCharacter: (characterId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onOpenCompanionReview: (sessionId: string) => void;
  canUsePrimaryFeatures?: boolean;
  sessionWindowRestoreIds?: readonly string[];
  sessionWindowRestorePending?: boolean;
  sessionWindowRestoreFeedback?: string;
};

export function HomeRightPane({
  rightPaneView,
  schedules = [],
  scheduleLoadState = "loaded",
  runningMonitorEntries,
  nonRunningMonitorEntries,
  monitorWindowIcon,
  characterEntries,
  characterListFeedback = "",
  onChangeRightPaneView,
  onOpenSessionMonitorWindow,
  onOpenCoordinationWindow,
  onOpenSettingsWindow,
  onRestoreSessionWindows,
  onCreateCharacter,
  onEditCharacter,
  onOpenSession,
  onOpenCompanionReview,
  canUsePrimaryFeatures = true,
  sessionWindowRestoreIds = [],
  sessionWindowRestorePending = false,
  sessionWindowRestoreFeedback = "",
}: HomeRightPaneProps) {
  const openSessionMonitorWindow = () => {
    if (!canUsePrimaryFeatures) {
      return;
    }
    onOpenSessionMonitorWindow();
  };
  const openSession = (sessionId: string) => {
    if (!canUsePrimaryFeatures) {
      return;
    }
    onOpenSession(sessionId);
  };
  const openCompanionReview = (sessionId: string) => {
    if (!canUsePrimaryFeatures) {
      return;
    }
    onOpenCompanionReview(sessionId);
  };

  return (
    <section className="panel home-right-pane rise-3">
      <div className="home-settings-rail">
        <div className="home-settings-actions">
          <button
            className="restore-session-windows-button"
            type="button"
            onClick={onRestoreSessionWindows}
            disabled={
              !canUsePrimaryFeatures
              || sessionWindowRestorePending
              || sessionWindowRestoreIds.length === 0
            }
            aria-busy={sessionWindowRestorePending}
          >
            {sessionWindowRestorePending ? (
              <span className="restore-session-windows-spinner" aria-hidden="true" />
            ) : null}
            <span>Restore Sessions</span>
          </button>
          <button
            className="launch-toggle home-monitor-window-button"
            type="button"
            aria-label="Session Monitor Window を開く"
            title="Session Monitor Window"
            onClick={openSessionMonitorWindow}
            aria-disabled={!canUsePrimaryFeatures}
            disabled={!canUsePrimaryFeatures}
          >
            {monitorWindowIcon}
          </button>
          <button className="launch-toggle" type="button" onClick={onOpenCoordinationWindow} disabled={!canUsePrimaryFeatures}>
            Coordination
          </button>
          <button className="launch-toggle home-settings-button" type="button" onClick={onOpenSettingsWindow}>
            Settings
          </button>
        </div>
        {sessionWindowRestoreFeedback ? (
          <p className="session-window-restore-feedback" role="status" aria-live="polite">
            {sessionWindowRestoreFeedback}
          </p>
        ) : null}
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
            className={`home-pane-toggle-button ${rightPaneView === "schedules" ? "active" : ""}`.trim()}
            type="button"
            role="tab"
            aria-selected={rightPaneView === "schedules"}
            onClick={() => onChangeRightPaneView("schedules")}
          >
            Schedules
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
        </div>
      </div>

      {rightPaneView === "monitor" ? (
        <section className="home-monitor-panel" role="tabpanel" aria-label="Session Monitor">
          <HomeMonitorContent
            runningEntries={runningMonitorEntries}
            nonRunningEntries={nonRunningMonitorEntries}
            onOpenSession={openSession}
            onOpenCompanionReview={openCompanionReview}
          />
        </section>
      ) : rightPaneView === "characters" ? (
        <section className="home-monitor-panel" role="tabpanel" aria-label="Characters">
          <HomeCharactersPanel
            characters={characterEntries}
            feedback={characterListFeedback}
            onCreateCharacter={onCreateCharacter}
            onEditCharacter={onEditCharacter}
          />
        </section>
      ) : (
        <section className="home-monitor-panel" role="tabpanel" aria-label="Schedules">
          <ScheduleWorkspace mode="list" isHome loadState={scheduleLoadState} schedules={schedules} onBack={() => onChangeRightPaneView("monitor")} onOpenSession={openSession} />
        </section>
      )}
    </section>
  );
}
