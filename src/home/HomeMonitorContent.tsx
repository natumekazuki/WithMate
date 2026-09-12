import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

import type {
  SessionMonitorContextMenuPoint,
  SessionMonitorEntryKind,
} from "../withmate-window-types.js";
import type { HomeMonitorEntry } from "./home-session-projection.js";
import { CharacterAvatar } from "../ui-utils.js";

export type HomeMonitorContentProps = {
  runningEntries: HomeMonitorEntry[];
  nonRunningEntries: HomeMonitorEntry[];
  feedback?: string;
  onOpenSession: (sessionId: string) => void;
  onOpenCompanionReview: (sessionId: string) => void;
  onShowContextMenu: (
    kind: SessionMonitorEntryKind,
    sessionId: string,
    point: SessionMonitorContextMenuPoint,
  ) => void;
};

export function HomeMonitorContent({
  runningEntries,
  nonRunningEntries,
  feedback = "",
  onOpenSession,
  onOpenCompanionReview,
  onShowContextMenu,
}: HomeMonitorContentProps) {
  const companionGroupMarkerClassName = (groupId: string): string => {
    let hash = 0;
    for (let index = 0; index < groupId.length; index += 1) {
      hash = (hash * 31 + groupId.charCodeAt(index)) >>> 0;
    }
    return `companion-group-${hash % 6}`;
  };

  const showEntryContextMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    entry: HomeMonitorEntry,
  ) => {
    event.preventDefault();
    if (entry.kind === "companion" && !entry.isWindowOpen) {
      return;
    }
    onShowContextMenu(entry.kind, entry.session.id, {
      x: Math.max(0, Math.round(event.clientX)),
      y: Math.max(0, Math.round(event.clientY)),
    });
  };

  const showEntryContextMenuFromKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    entry: HomeMonitorEntry,
  ) => {
    if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) {
      return;
    }
    event.preventDefault();
    if (entry.kind === "companion" && !entry.isWindowOpen) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    onShowContextMenu(entry.kind, entry.session.id, {
      x: Math.max(0, Math.round(rect.left)),
      y: Math.max(0, Math.round(rect.bottom)),
    });
  };

  const renderMonitorEntries = (entries: HomeMonitorEntry[]) => {
    return entries.map((entry) => {
      if (entry.kind === "companion") {
        const { session } = entry;
        const groupClassName = companionGroupMarkerClassName(session.groupId);
        const modeLabel = entry.activeAuxiliarySession ? "Auxiliary" : "Companion";
        const modeClassName = entry.activeAuxiliarySession ? "auxiliary" : "companion";
        return (
          <button
            key={`companion-${session.id}`}
            className={`home-monitor-row companion ${groupClassName}`}
            type="button"
            onClick={() => onOpenCompanionReview(session.id)}
            onContextMenu={(event) => showEntryContextMenu(event, entry)}
            onKeyDown={(event) => showEntryContextMenuFromKeyboard(event, entry)}
            aria-haspopup={entry.isWindowOpen ? "menu" : undefined}
          >
            <CharacterAvatar
              character={{ name: session.character, iconPath: session.characterIconPath }}
              size="tiny"
              className="home-monitor-avatar"
            />
            <div className="home-monitor-row-copy">
              <strong>{session.taskTitle}</strong>
              <span>{entry.groupLabel}</span>
            </div>
            <div className="home-monitor-row-badges">
              <span className={`session-mode-badge ${modeClassName}`}>{modeLabel}</span>
              <span className={`session-status home-monitor-status ${entry.state.kind}`.trim()}>{entry.state.label}</span>
              <span className={`home-monitor-group-chip ${groupClassName}`} aria-label="同じ Companion group の目印" />
            </div>
          </button>
        );
      }

      const { session } = entry;
      const modeLabel = entry.activeAuxiliarySession ? "Auxiliary" : "Agent";
      const modeClassName = entry.activeAuxiliarySession ? "auxiliary" : "agent";
      return (
        <button
          key={`agent-${session.id}`}
          className="home-monitor-row"
          type="button"
          onClick={() => onOpenSession(session.id)}
          onContextMenu={(event) => showEntryContextMenu(event, entry)}
          onKeyDown={(event) => showEntryContextMenuFromKeyboard(event, entry)}
          aria-haspopup="menu"
        >
          <CharacterAvatar
            character={{ name: session.character, iconPath: session.characterIconPath }}
            size="tiny"
            className="home-monitor-avatar"
          />
          <div className="home-monitor-row-copy">
            <strong>{session.taskTitle}</strong>
            <span>{session.workspaceLabel || session.workspacePath || "workspace 未設定"}</span>
          </div>
          <div className="home-monitor-row-badges">
            <span className={`session-mode-badge ${modeClassName}`}>{modeLabel}</span>
            <span className={`session-status home-monitor-status ${entry.state.kind}`.trim()}>{entry.state.label}</span>
          </div>
        </button>
      );
    });
  };

  return (
    <div className="home-monitor-body">
      {feedback ? (
        <p className="settings-feedback" role="status" aria-live="polite">
          {feedback}
        </p>
      ) : null}
      <section className="home-monitor-section" aria-labelledby="home-monitor-running">
        <div className="home-monitor-section-head">
          <h3 id="home-monitor-running">実行中</h3>
          <span className="home-monitor-count">{runningEntries.length}</span>
        </div>
        <div className="home-monitor-list">
          {runningEntries.length > 0 ? (
            renderMonitorEntries(runningEntries)
          ) : null}
        </div>
      </section>

      <section className="home-monitor-section" aria-labelledby="home-monitor-inactive">
        <div className="home-monitor-section-head">
          <h3 id="home-monitor-inactive">停止・完了</h3>
          <span className="home-monitor-count">{nonRunningEntries.length}</span>
        </div>
        <div className="home-monitor-list">
          {nonRunningEntries.length > 0 ? (
            renderMonitorEntries(nonRunningEntries)
          ) : null}
        </div>
      </section>
    </div>
  );
}
