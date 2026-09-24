import { useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";

import type {
  SessionMonitorContextMenuPoint,
  SessionMonitorEntryKind,
} from "../../src-shared/window/withmate-window-types.js";
import type {
  HomeMonitorAuxiliaryDataState,
  HomeMonitorEntry,
  HomeSessionState,
} from "./home-session-projection.js";
import { CharacterAvatar } from "../ui/ui-utils.js";

export type HomeMonitorContentProps = {
  runningEntries: HomeMonitorEntry[];
  nonRunningEntries: HomeMonitorEntry[];
  auxiliaryDataState?: HomeMonitorAuxiliaryDataState;
  sessionWindowsDataState?: "loading" | "loaded" | "error";
  runningEmptyMessage?: string;
  nonRunningEmptyMessage?: string;
  feedback?: string;
  onOpenSession: (sessionId: string, auxiliarySessionId?: string) => void;
  onShowContextMenu: (
    kind: SessionMonitorEntryKind,
    sessionId: string,
    point: SessionMonitorContextMenuPoint,
  ) => void;
};

type HomeMonitorStatusKind = HomeSessionState["kind"] | "loading" | "closed";

function getEntryKey(entry: HomeMonitorEntry): string {
  return `${entry.kind}:${entry.session.id}`;
}
function getAuxiliaryStatus(summary: HomeMonitorEntry["auxiliarySessions"][number]): {
  kind: HomeMonitorStatusKind;
  label: string;
} {
  if (summary.runState === "running") {
    return { kind: "running", label: "Running" };
  }
  if (summary.runState === "error") {
    return { kind: "error", label: "Error" };
  }
  if (summary.status === "closed") {
    return { kind: "closed", label: "Closed" };
  }
  return { kind: "neutral", label: "Idle" };
}

function MonitorStatusIcon({
  kind,
  label,
  count,
}: {
  kind: HomeMonitorStatusKind;
  label: string;
  count?: number;
}) {
  return (
    <span
      className={`home-monitor-status-icon ${kind}`}
      role="img"
      aria-label={count === undefined ? label : `${label}: ${count}`}
    >
      <span className="home-monitor-status-icon-mark" aria-hidden="true" />
      {count === undefined ? null : <span className="home-monitor-status-icon-count">: {count}</span>}
    </span>
  );
}

function renderAuxiliaryStatusIcons(entry: HomeMonitorEntry) {
  const summaries = entry.auxiliarySessions;
  const groups = [
    { kind: "running" as const, label: "Running" },
    { kind: "error" as const, label: "Error" },
    { kind: "neutral" as const, label: "Idle" },
    { kind: "closed" as const, label: "Closed" },
  ].map((group) => ({
    ...group,
    count: summaries.filter((summary) => getAuxiliaryStatus(summary).kind === group.kind).length,
  })).filter((group) => group.count > 0);

  return (
    <span className="home-monitor-status-cluster home-monitor-auxiliary-status" aria-label="Auxiliary status">
      <span className="home-monitor-status-label">Aux</span>
      {groups.map((group) => (
        <MonitorStatusIcon
          key={group.kind}
          kind={group.kind}
          label={`Auxiliary ${group.label}`}
          count={group.count}
        />
      ))}
    </span>
  );
}

export function HomeMonitorContent({
  runningEntries,
  nonRunningEntries,
  auxiliaryDataState = "ready",
  sessionWindowsDataState = "loaded",
  runningEmptyMessage = "",
  nonRunningEmptyMessage = "",
  feedback = "",
  onOpenSession,
  onShowContextMenu,
}: HomeMonitorContentProps) {
  const [expandedEntryKeys, setExpandedEntryKeys] = useState<Set<string>>(() => new Set());

  const toggleEntry = (entry: HomeMonitorEntry) => {
    const key = getEntryKey(entry);
    setExpandedEntryKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const showEntryContextMenu = (
    event: ReactMouseEvent<HTMLDivElement>,
    entry: HomeMonitorEntry,
  ) => {
    event.preventDefault();
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
    const rect = event.currentTarget.getBoundingClientRect();
    onShowContextMenu(entry.kind, entry.session.id, {
      x: Math.max(0, Math.round(rect.left)),
      y: Math.max(0, Math.round(rect.bottom)),
    });
  };

  const renderMonitorEntries = (entries: HomeMonitorEntry[]) => entries.map((entry) => {
    const auxiliarySessions = entry.auxiliarySessions;
    const entryKey = getEntryKey(entry);
    const isExpanded = expandedEntryKeys.has(entryKey);
    const canExpand = auxiliarySessions.length > 0;
    const title = entry.session.taskTitle || entry.session.id;
    const openParent = () => {
      onOpenSession(entry.session.id);
    };

    return (
      <div
        key={entryKey}
        className="home-monitor-card"
        onContextMenu={(event) => showEntryContextMenu(event, entry)}
      >
        <div className="home-monitor-parent-row">
          {canExpand ? (
            <button
              className="home-monitor-disclosure"
              type="button"
              aria-label={`${isExpanded ? "Hide" : "Show"} Auxiliary sessions for ${title}`}
              aria-expanded={isExpanded}
              onClick={() => toggleEntry(entry)}
            >
              <span aria-hidden="true">{isExpanded ? "▾" : "▸"}</span>
            </button>
          ) : (
            <span className="home-monitor-disclosure-placeholder" aria-hidden="true" />
          )}
          <button
            className="home-monitor-parent-button"
            type="button"
            onClick={openParent}
            onKeyDown={(event) => showEntryContextMenuFromKeyboard(event, entry)}
            aria-haspopup="menu"
            aria-label={`Open session: ${title}`}
          >
            <CharacterAvatar
              character={{ name: entry.session.character, iconPath: entry.session.characterIconPath }}
              size="tiny"
              className="home-monitor-avatar"
            />
            <strong className="home-monitor-parent-title">{title}</strong>
          </button>
        </div>
        <div className="home-monitor-summary-row">
          <span className="home-monitor-status-cluster" aria-label={`Main status: ${entry.mainState.label}`}>
            <span className="home-monitor-status-label">Main</span>
            <MonitorStatusIcon kind={entry.mainState.kind} label={`Main ${entry.mainState.label}`} />
          </span>
          {auxiliarySessions.length > 0 ? (
            <>
              <span className="home-monitor-summary-separator" aria-hidden="true" />
              {renderAuxiliaryStatusIcons(entry)}
            </>
          ) : null}
        </div>
        {isExpanded ? (
          <div className="home-monitor-auxiliary-list" aria-label={`Auxiliary sessions for ${title}`}>
            {auxiliarySessions.map((summary, index) => {
              const status = getAuxiliaryStatus(summary);
              const preview = summary.preview?.trim() ?? "";
              const openAuxiliary = () => {
                onOpenSession(entry.session.id, summary.id);
              };
              return (
                <button
                  key={summary.id}
                  className="home-monitor-auxiliary-row"
                  type="button"
                  onClick={openAuxiliary}
                  aria-label={preview ? `Open Auxiliary: ${preview}` : `Open Auxiliary ${index + 1}`}
                >
                  <CharacterAvatar
                    character={{ name: "", iconPath: summary.characterIconPath ?? "" }}
                    size="tiny"
                    className="home-monitor-auxiliary-avatar"
                  />
                  <span className="home-monitor-auxiliary-preview">{preview}</span>
                  <MonitorStatusIcon kind={status.kind} label={`Auxiliary ${status.label}`} />
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  });

  const isLoading = sessionWindowsDataState === "loading" || auxiliaryDataState === "loading";
  const loadingMessage = sessionWindowsDataState === "loading"
    ? "Loading open sessions…"
    : "Loading Auxiliary sessions…";
  const statusFeedback = feedback || (
    sessionWindowsDataState === "error"
      ? "Could not load open sessions."
      : auxiliaryDataState === "error"
        ? "Could not load Auxiliary sessions."
        : ""
  );
  const showEmptyState = sessionWindowsDataState !== "loading" && sessionWindowsDataState !== "error";

  return (
    <div
      className="home-monitor-body"
      aria-busy={isLoading}
    >
      {statusFeedback ? (
        <p className="settings-feedback" role="status" aria-live="polite">
          {statusFeedback}
        </p>
      ) : null}
      {!feedback && isLoading ? (
        <div className="home-session-list-load-status" role="status" aria-live="polite">
          <span className="home-session-list-load-spinner" aria-hidden="true" />
          <span className="sr-only">{loadingMessage}</span>
        </div>
      ) : null}
      <div className="home-monitor-sections">
        <section className="home-monitor-section" aria-labelledby="home-monitor-running">
          <div className="home-monitor-section-head">
            <h3 id="home-monitor-running">Running</h3>
            <span className="home-monitor-count">{runningEntries.length}</span>
          </div>
          <div className="home-monitor-list">
            {runningEntries.length > 0
              ? renderMonitorEntries(runningEntries)
              : showEmptyState && runningEmptyMessage
                ? <p className="home-monitor-empty">{runningEmptyMessage}</p>
                : null}
          </div>
        </section>

        <section className="home-monitor-section" aria-labelledby="home-monitor-inactive">
          <div className="home-monitor-section-head">
            <h3 id="home-monitor-inactive">Stopped</h3>
            <span className="home-monitor-count">{nonRunningEntries.length}</span>
          </div>
          <div className="home-monitor-list">
            {nonRunningEntries.length > 0
              ? renderMonitorEntries(nonRunningEntries)
              : showEmptyState && nonRunningEmptyMessage
                ? <p className="home-monitor-empty">{nonRunningEmptyMessage}</p>
                : null}
          </div>
        </section>
      </div>
    </div>
  );
}
