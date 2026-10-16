import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";

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
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { LoadError } from "../ui/load-error.js";
import { getHomeAuxiliarySessionState } from "./home-session-projection.js";
import { ChatDockSplitter } from "../chat/chat-window.js";

export type HomeMonitorContentProps = {
  approvalEntries: HomeMonitorEntry[];
  runningEntries: HomeMonitorEntry[];
  nonRunningEntries: HomeMonitorEntry[];
  auxiliaryDataState?: HomeMonitorAuxiliaryDataState;
  sessionWindowsDataState?: "loading" | "loaded" | "error";
  runningEmptyMessage?: string;
  nonRunningEmptyMessage?: string;
  feedback?: string;
  onRetry?: () => void;
  onOpenSession: (sessionId: string, auxiliarySessionId?: string) => void;
  onShowContextMenu: (
    kind: SessionMonitorEntryKind,
    sessionId: string,
    point: SessionMonitorContextMenuPoint,
  ) => void;
};

type HomeMonitorStatusKind = HomeSessionState["kind"] | "loading" | "closed";

type SectionBoundaries = [number, number];

function clampSectionBoundaries(boundaries: SectionBoundaries, height: number): SectionBoundaries {
  if (height <= 0) return boundaries;
  const minimum = Math.min(1 / 3, 48 / height);
  const first = Math.max(minimum, Math.min(1 - minimum * 2, boundaries[0]));
  return [first, Math.max(first + minimum, Math.min(1 - minimum, boundaries[1]))];
}

function getEntryKey(entry: HomeMonitorEntry): string {
  return `${entry.kind}:${entry.session.id}`;
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
      title={count === undefined ? label : `${label}: ${count}`}
    >
      <span className="home-monitor-status-icon-mark" aria-hidden="true" />
      {count === undefined ? null : <span className="home-monitor-status-icon-count">: {count}</span>}
    </span>
  );
}

function renderAuxiliaryStatusIcons(entry: HomeMonitorEntry) {
  const summaries = entry.auxiliarySessions;
  const groups = [
    { kind: "approval" as const, label: "Approval Required" },
    { kind: "running" as const, label: "Running" },
    { kind: "running" as const, label: "Canceling" },
    { kind: "running" as const, label: "Waiting For Stop" },
    { kind: "error" as const, label: "Error" },
    { kind: "neutral" as const, label: "Idle" },
    { kind: "closed" as const, label: "Closed" },
  ].map((group) => ({
    ...group,
    count: summaries.filter((summary) => getHomeAuxiliarySessionState(summary).label === group.label).length,
  })).filter((group) => group.count > 0);

  return (
    <span className="home-monitor-status-cluster home-monitor-auxiliary-status" aria-label="Auxiliary status">
      <span className="home-monitor-status-label">Aux</span>
      {groups.map((group) => (
        <MonitorStatusIcon
          key={group.label}
          kind={group.kind}
          label={`Auxiliary ${group.label}`}
          count={group.count}
        />
      ))}
    </span>
  );
}

export function HomeMonitorContent({
  approvalEntries,
  runningEntries,
  nonRunningEntries,
  auxiliaryDataState = "ready",
  sessionWindowsDataState = "loaded",
  runningEmptyMessage = "",
  nonRunningEmptyMessage = "",
  feedback = "",
  onRetry,
  onOpenSession,
  onShowContextMenu,
}: HomeMonitorContentProps) {
  const [expandedEntryKeys, setExpandedEntryKeys] = useState<Set<string>>(() => new Set());
  const [sectionBoundaries, setSectionBoundaries] = useState<SectionBoundaries>([1 / 3, 2 / 3]);
  const resizeStartRef = useRef<{ ratio: number; height: number } | null>(null);
  const sectionsId = useId();
  const sectionsRef = useRef<HTMLDivElement>(null);
  const [collapsedLists, setCollapsedLists] = useState<boolean[]>([false, false, false]);

  const getSectionsHeight = (container: HTMLElement) => container.getBoundingClientRect().height
    - [...container.querySelectorAll<HTMLElement>(".home-monitor-splitter")]
      .reduce((sum, splitter) => sum + splitter.getBoundingClientRect().height, 0);

  useLayoutEffect(() => {
    const container = sectionsRef.current;
    if (!container) return;
    const sections = [...container.querySelectorAll<HTMLElement>(":scope > section")];
    const updateLayout = () => {
      const height = getSectionsHeight(container);
      setSectionBoundaries((current) => {
        const next = clampSectionBoundaries(current, height);
        return next.every((value, index) => value === current[index]) ? current : next;
      });
      const next = sections.map((section, index) => {
        const list = section.querySelector<HTMLElement>(".home-monitor-list");
        const card = list?.querySelector<HTMLElement>(".home-monitor-card");
        if (!list || !card) return false;
        const auxiliaryList = card.querySelector<HTMLElement>(".home-monitor-auxiliary-list");
        const minimumHeight = card.getBoundingClientRect().height - (auxiliaryList?.getBoundingClientRect().height ?? 0);
        const collapsed = list.getBoundingClientRect().height < minimumHeight;
        if (collapsed && list.contains(container.ownerDocument.activeElement)) {
          container.querySelectorAll<HTMLButtonElement>(".home-monitor-splitter")[Math.min(index, 1)]?.focus({ preventScroll: true });
        }
        return collapsed;
      });
      setCollapsedLists((current) => current.every((value, index) => value === next[index]) ? current : next);
    };
    updateLayout();
    const Observer = container.ownerDocument.defaultView?.ResizeObserver;
    if (!Observer) return;
    const observer = new Observer(updateLayout);
    observer.observe(container);
    for (const section of sections) {
      observer.observe(section);
      const head = section.querySelector(".home-monitor-section-head");
      const card = section.querySelector(".home-monitor-card");
      if (head) observer.observe(head);
      if (card) observer.observe(card);
    }
    return () => observer.disconnect();
  }, [approvalEntries, runningEntries, nonRunningEntries]);

  const resizeSections = (index: 0 | 1, ratio: number, height: number) => {
    if (height <= 0) return;
    const minimum = Math.min(1 / 3, 48 / height);
    setSectionBoundaries((current) => {
      const next = clampSectionBoundaries(current, height);
      const lower = index === 0 ? minimum : next[0] + minimum;
      const upper = index === 0 ? next[1] - minimum : 1 - minimum;
      next[index] = Math.max(lower, Math.min(upper, ratio));
      return next;
    });
  };

  const renderSplitter = (index: 0 | 1, label: string) => (
    <ChatDockSplitter
      edge="bottom"
      className="home-monitor-splitter"
      canCollapse={false}
      ariaLabel={`Resize ${label}`}
      ariaControls={sectionsId}
      ariaOrientation="horizontal"
      ariaValueNow={Math.round(sectionBoundaries[index] * 100)}
      title={`Drag or use Up/Down arrows to resize ${label}`}
      onPointerDown={(event) => {
        event.preventDefault();
        const container = event.currentTarget.parentElement;
        if (!container) return;
        const height = getSectionsHeight(container);
        const ratio = clampSectionBoundaries(sectionBoundaries, height)[index];
        resizeSections(index, ratio, height);
        resizeStartRef.current = { ratio, height };
      }}
      onDrag={(_event, delta) => {
        const start = resizeStartRef.current;
        if (start) resizeSections(index, start.ratio + delta.y / start.height, start.height);
      }}
      onPointerEnd={() => { resizeStartRef.current = null; }}
      onKeyDown={(event) => {
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const container = event.currentTarget.parentElement;
        if (!container) return;
        const height = getSectionsHeight(container);
        const ratio = clampSectionBoundaries(sectionBoundaries, height)[index];
        resizeSections(index, event.key === "Home" ? 0 : event.key === "End" ? 1
          : ratio + (event.key === "ArrowDown" ? 24 : -24) / height, height);
      }}
    />
  );

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
              const status = getHomeAuxiliarySessionState(summary);
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
  const hasReadError = sessionWindowsDataState === "error" || auxiliaryDataState === "error";
  const showEmptyState = sessionWindowsDataState !== "loading" && sessionWindowsDataState !== "error";

  return (
    <div
      className="home-monitor-body"
      aria-busy={isLoading}
    >
      {statusFeedback ? hasReadError ? (
        <LoadError message={statusFeedback} onRetry={onRetry} retryDisabled={isLoading} className="home-session-list-feedback" />
      ) : (
        <div className="home-session-list-feedback">
          <p className="settings-feedback" role="status" aria-live="polite">{statusFeedback}</p>
          {onRetry ? (
            <button className="launch-toggle home-session-retry-button" type="button" disabled={isLoading} onClick={onRetry}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      {!feedback && isLoading && (auxiliaryDataState === "loading" || (approvalEntries.length === 0 && runningEntries.length === 0 && nonRunningEntries.length === 0)) ? (
        <LoadingIndicator label={loadingMessage.replace(/…$/, "")} className="home-session-list-load-status" />
      ) : null}
      <div
        ref={sectionsRef}
        id={sectionsId}
        className="home-monitor-sections"
        style={{ gridTemplateRows: `minmax(48px, ${sectionBoundaries[0]}fr) var(--session-dock-splitter-size) minmax(48px, ${sectionBoundaries[1] - sectionBoundaries[0]}fr) var(--session-dock-splitter-size) minmax(48px, ${1 - sectionBoundaries[1]}fr)` }}
      >
        <section className="home-monitor-section" aria-labelledby="home-monitor-approval">
          <div className="home-monitor-section-head">
            <h3 id="home-monitor-approval">Approval</h3>
            <span className="home-monitor-count">{approvalEntries.length}</span>
          </div>
          <div className={`home-monitor-list${collapsedLists[0] ? " is-collapsed" : ""}`} inert={collapsedLists[0]}>
            {renderMonitorEntries(approvalEntries)}
          </div>
        </section>

        {renderSplitter(0, "Approval and Running")}

        <section className="home-monitor-section" aria-labelledby="home-monitor-running">
          <div className="home-monitor-section-head">
            <h3 id="home-monitor-running">Running</h3>
            <span className="home-monitor-count">{runningEntries.length}</span>
          </div>
          <div className={`home-monitor-list${collapsedLists[1] ? " is-collapsed" : ""}`} inert={collapsedLists[1]}>
            {runningEntries.length > 0
              ? renderMonitorEntries(runningEntries)
              : showEmptyState && runningEmptyMessage
                ? <p className="home-monitor-empty">{runningEmptyMessage}</p>
                : null}
          </div>
        </section>

        {renderSplitter(1, "Running and Stopped")}

        <section className="home-monitor-section" aria-labelledby="home-monitor-inactive">
          <div className="home-monitor-section-head">
            <h3 id="home-monitor-inactive">Stopped</h3>
            <span className="home-monitor-count">{nonRunningEntries.length}</span>
          </div>
          <div className={`home-monitor-list${collapsedLists[2] ? " is-collapsed" : ""}`} inert={collapsedLists[2]}>
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
