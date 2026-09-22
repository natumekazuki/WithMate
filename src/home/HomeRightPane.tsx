import type { ReactNode } from "react";

import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
import type {
  SessionMonitorContextMenuPoint,
  SessionMonitorEntryKind,
} from "../../src-shared/window/withmate-window-types.js";
import type { HomeMonitorAuxiliaryDataState, HomeMonitorEntry } from "./home-session-projection.js";
import type { HomeCharacterLoadStatus } from "./home-launch-state.js";
import { HomeCharactersPanel } from "./HomeCharactersPanel.js";
import { HomeMonitorContent } from "./HomeMonitorContent.js";

export type HomeRightPaneProps = {
  rightPaneView: "monitor" | "characters";
  runningMonitorEntries: HomeMonitorEntry[];
  nonRunningMonitorEntries: HomeMonitorEntry[];
  auxiliaryDataState: HomeMonitorAuxiliaryDataState;
  sessionWindowsDataState?: "loading" | "loaded" | "error";
  monitorRunningEmptyMessage?: string;
  monitorNonRunningEmptyMessage?: string;
  sessionMonitorFeedback?: string;
  monitorWindowIcon: ReactNode;
  characterEntries: CharacterCatalogEntry[];
  characterLoadStatus?: HomeCharacterLoadStatus;
  characterListFeedback?: string;
  onChangeRightPaneView: (view: "monitor" | "characters") => void;
  onOpenSessionMonitorWindow: () => void;
  onOpenSettingsWindow: () => void;
  onRestoreSessionWindows: () => void;
  onCreateCharacter: () => void;
  onEditCharacter: (characterId: string) => void;
  onOpenSession: (sessionId: string, auxiliarySessionId?: string) => void;
  onShowSessionMonitorContextMenu: (
    kind: SessionMonitorEntryKind,
    sessionId: string,
    point: SessionMonitorContextMenuPoint,
  ) => void;
  canUsePrimaryFeatures?: boolean;
  sessionWindowRestoreIds?: readonly string[];
  sessionWindowRestorePending?: boolean;
  sessionWindowRestoreFeedback?: string;
};

export function HomeRightPane({
  rightPaneView,
  runningMonitorEntries,
  nonRunningMonitorEntries,
  auxiliaryDataState,
  sessionWindowsDataState = "loaded",
  monitorRunningEmptyMessage = "",
  monitorNonRunningEmptyMessage = "",
  sessionMonitorFeedback = "",
  monitorWindowIcon,
  characterEntries,
  characterLoadStatus = "loaded",
  characterListFeedback = "",
  onChangeRightPaneView,
  onOpenSessionMonitorWindow,
  onOpenSettingsWindow,
  onRestoreSessionWindows,
  onCreateCharacter,
  onEditCharacter,
  onOpenSession,
  onShowSessionMonitorContextMenu,
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
  const openSession = (sessionId: string, auxiliarySessionId?: string) => {
    if (!canUsePrimaryFeatures) {
      return;
    }
    onOpenSession(sessionId, auxiliarySessionId);
  };
  const showSessionMonitorContextMenu = (
    kind: SessionMonitorEntryKind,
    sessionId: string,
    point: SessionMonitorContextMenuPoint,
  ) => {
    if (!canUsePrimaryFeatures) {
      return;
    }
    onShowSessionMonitorContextMenu(kind, sessionId, point);
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
            <span>RestoreSessions</span>
          </button>
          <button
            className="launch-toggle home-monitor-window-button"
            type="button"
            aria-label="Open session monitor window"
            title="Open session monitor window"
            onClick={openSessionMonitorWindow}
            aria-disabled={!canUsePrimaryFeatures}
            disabled={!canUsePrimaryFeatures}
          >
            {monitorWindowIcon}
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
        <section className="home-monitor-panel" role="tabpanel" aria-label="Session monitor">
          <HomeMonitorContent
            runningEntries={runningMonitorEntries}
            nonRunningEntries={nonRunningMonitorEntries}
            auxiliaryDataState={auxiliaryDataState}
            sessionWindowsDataState={sessionWindowsDataState}
            runningEmptyMessage={monitorRunningEmptyMessage}
            nonRunningEmptyMessage={monitorNonRunningEmptyMessage}
            feedback={sessionMonitorFeedback}
            onOpenSession={openSession}
            onShowContextMenu={showSessionMonitorContextMenu}
          />
        </section>
      ) : (
        <section className="home-monitor-panel" role="tabpanel" aria-label="Characters">
          <HomeCharactersPanel
            characters={characterEntries}
            characterLoadStatus={characterLoadStatus}
            feedback={characterListFeedback}
            onCreateCharacter={onCreateCharacter}
            onEditCharacter={onEditCharacter}
          />
        </section>
      )}
    </section>
  );
}
