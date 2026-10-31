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
import { HomePreviewsPanel } from "./HomePreviewsPanel.js";

export type HomeRightPaneProps = {
  searchText: string;
  providerQuota?: ReactNode;
  rightPaneView: "monitor" | "characters" | "previews";
  approvalMonitorEntries: HomeMonitorEntry[];
  runningMonitorEntries: HomeMonitorEntry[];
  nonRunningMonitorEntries: HomeMonitorEntry[];
  auxiliaryDataState: HomeMonitorAuxiliaryDataState;
  auxiliaryRefreshing?: boolean;
  sessionWindowsDataState?: "loading" | "loaded" | "error";
  monitorRunningEmptyMessage?: string;
  monitorNonRunningEmptyMessage?: string;
  sessionMonitorFeedback?: string;
  onRetrySessionSummaries?: () => void;
  characterEntries: CharacterCatalogEntry[];
  characterLoadStatus?: HomeCharacterLoadStatus;
  characterListFeedback?: string;
  onRetryCharacters?: () => void;
  onCreateCharacter: () => void;
  onEditCharacter: (characterId: string) => void;
  onOpenSession: (sessionId: string, auxiliarySessionId?: string) => void;
  onShowSessionMonitorContextMenu: (
    kind: SessionMonitorEntryKind,
    sessionId: string,
    point: SessionMonitorContextMenuPoint,
  ) => void;
};

export function HomeRightPane({
  searchText,
  providerQuota,
  rightPaneView,
  approvalMonitorEntries,
  runningMonitorEntries,
  nonRunningMonitorEntries,
  auxiliaryDataState,
  auxiliaryRefreshing,
  sessionWindowsDataState = "loaded",
  monitorRunningEmptyMessage = "",
  monitorNonRunningEmptyMessage = "",
  sessionMonitorFeedback = "",
  onRetrySessionSummaries,
  characterEntries,
  characterLoadStatus = "loaded",
  characterListFeedback = "",
  onRetryCharacters,
  onCreateCharacter,
  onEditCharacter,
  onOpenSession,
  onShowSessionMonitorContextMenu,
}: HomeRightPaneProps) {
  return (
    <section className="panel home-right-pane rise-3">
      {rightPaneView === "monitor" ? (
        <section className="home-monitor-panel" role="tabpanel" aria-label="Session monitor">
          <HomeMonitorContent
            approvalEntries={approvalMonitorEntries}
            providerQuota={providerQuota}
            runningEntries={runningMonitorEntries}
            nonRunningEntries={nonRunningMonitorEntries}
            auxiliaryDataState={auxiliaryDataState}
            auxiliaryRefreshing={auxiliaryRefreshing}
            sessionWindowsDataState={sessionWindowsDataState}
            runningEmptyMessage={monitorRunningEmptyMessage}
            nonRunningEmptyMessage={monitorNonRunningEmptyMessage}
            feedback={sessionMonitorFeedback}
            onRetry={onRetrySessionSummaries}
            onOpenSession={onOpenSession}
            onShowContextMenu={onShowSessionMonitorContextMenu}
          />
        </section>
      ) : rightPaneView === "previews" ? (
        <section className="home-monitor-panel" role="tabpanel" aria-label="Previews">
          <HomePreviewsPanel />
        </section>
      ) : (
        <section className="home-monitor-panel home-characters-panel" role="tabpanel" aria-label="Characters">
          <HomeCharactersPanel
            characters={characterEntries}
            searchText={searchText}
            characterLoadStatus={characterLoadStatus}
            feedback={characterListFeedback}
            onRetry={onRetryCharacters}
            onCreateCharacter={onCreateCharacter}
            onEditCharacter={onEditCharacter}
          />
        </section>
      )}
    </section>
  );
}
