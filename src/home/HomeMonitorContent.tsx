import { useId, useLayoutEffect, useRef, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";

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
import { ComposerIcon } from "../chat/composer/composer-icon.js";

export type HomeMonitorContentProps = {
  approvalEntries: HomeMonitorEntry[];
  providerQuota?: ReactNode;
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

function fitSectionWeights(weights: number[], closed: boolean[], height: number): number[] {
  if (height <= 0) return weights;
  const active = weights.map((_, index) => index).filter((index) => !closed[index]);
  const minimum = Math.min(48, height / active.length);
  const next = [...weights];
  let remaining = height;
  let pending = active;
  while (pending.length) {
    const total = pending.reduce((sum, index) => sum + weights[index]!, 0);
    const small = pending.filter((index) => remaining * weights[index]! / total < minimum);
    if (!small.length) {
      for (const index of pending) next[index] = remaining * weights[index]! / total;
      break;
    }
    for (const index of small) { next[index] = minimum; remaining -= minimum; }
    pending = pending.filter((index) => !small.includes(index));
  }
  return next;
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
    { kind: "approval" as const, label: "Attention" },
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
  providerQuota,
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
  const [closedSections, setClosedSections] = useState([false, false, false]);
  const [smallSections, setSmallSections] = useState([false, false, false]);
  const [sectionWeights, setSectionWeights] = useState([1, 1, 1]);
  const [availableHeight, setAvailableHeight] = useState(0);
  const [isQuotaExpanded, setIsQuotaExpanded] = useState(true);
  const sectionsRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<number[] | null>(null);
  const id = useId();
  const sectionLabels = ["Attention", "Running", "Stopped"];
  const sectionCounts = [approvalEntries.length, runningEntries.length, nonRunningEntries.length];

  const getAvailableHeight = () => {
    const container = sectionsRef.current;
    if (!container) return 0;
    return container.getBoundingClientRect().height
      - [...container.querySelectorAll<HTMLElement>(":scope > .home-monitor-splitter")].reduce((sum, item) => sum + item.getBoundingClientRect().height, 0)
      - [...container.querySelectorAll<HTMLElement>(":scope > section")].reduce((sum, item, index) => sum + (closedSections[index] ? item.getBoundingClientRect().height : 0), 0);
  };

  useLayoutEffect(() => {
    const container = sectionsRef.current;
    if (!container) return;
    const sections = [...container.querySelectorAll<HTMLElement>(":scope > section")];
    const update = () => {
      setAvailableHeight(getAvailableHeight());
      const small = sections.map((section, index) => {
        if (closedSections[index]) return false;
        const content = section.querySelector<HTMLElement>(".home-monitor-section-content");
        const card = content?.querySelector<HTMLElement>(".home-monitor-parent-row");
        return Boolean(content && card && content.getBoundingClientRect().height < card.getBoundingClientRect().height);
      });
      sections.forEach((section, index) => {
        if ((closedSections[index] || small[index]) && section.querySelector(".home-monitor-section-content")?.contains(container.ownerDocument.activeElement)) {
          container.querySelectorAll<HTMLButtonElement>(":scope > .home-monitor-splitter")[Math.min(index, 1)]?.focus({ preventScroll: true });
        }
      });
      setSmallSections((current) => current.every((value, index) => value === small[index]) ? current : small);
    };
    update();
    const Observer = container.ownerDocument.defaultView?.ResizeObserver;
    if (!Observer) return;
    const observer = new Observer(update);
    observer.observe(container);
    for (const section of sections) {
      observer.observe(section);
      for (const item of section.querySelectorAll(".home-monitor-section-head, .home-monitor-parent-row")) observer.observe(item);
    }
    return () => observer.disconnect();
  }, [closedSections, approvalEntries, runningEntries, nonRunningEntries]);

  const resizePair = (index: number, start: number[], delta: number) => {
    if (closedSections[index] || closedSections[index + 1]) return;
    const total = start[index]! + start[index + 1]!;
    const minimum = Math.min(48, total / 2);
    const first = Math.max(minimum, Math.min(total - minimum, start[index]! + delta));
    setAvailableHeight(getAvailableHeight());
    setSectionWeights((weights) => {
      const activeWeight = weights.reduce((sum, value, i) => sum + (closedSections[i] ? 0 : value), 0);
      const activeHeight = start.reduce((sum, value, i) => sum + (closedSections[i] ? 0 : value), 0);
      if (activeHeight <= 0) return weights;
      const next = start.map((value, i) => closedSections[i] ? weights[i]! : value * activeWeight / activeHeight);
      next[index] = first * activeWeight / activeHeight;
      next[index + 1] = (total - first) * activeWeight / activeHeight;
      return next;
    });
  };

  const renderSplitter = (index: number) => {
    const nextIndex = index + 1;
    const restore = closedSections[index] || closedSections[nextIndex];
    const target = closedSections[index] ? index : closedSections[nextIndex] ? nextIndex
      : sectionCounts[index]! < sectionCounts[nextIndex]! ? index : nextIndex;
    const action = `${restore ? "Expand" : "Collapse"} ${sectionLabels[target]}`;
    const weights = fitSectionWeights(sectionWeights, closedSections, getAvailableHeight());
    const sectionElements = sectionsRef.current?.querySelectorAll<HTMLElement>(":scope > section");
    const heights = weights.map((value, i) => closedSections[i] ? sectionElements?.[i]?.getBoundingClientRect().height ?? 0 : value);
    const total = heights.reduce((sum, value) => sum + value, 0);
    return <ChatDockSplitter edge={target === index ? "top" : "bottom"} className="home-monitor-splitter"
      ariaLabel={`${action}; resize ${sectionLabels[index]} and ${sectionLabels[nextIndex]}`}
      ariaControls={`${id}-content-${target}`}
      ariaOrientation="horizontal" ariaValueNow={Math.round(heights.slice(0, nextIndex).reduce((sum, value) => sum + value, 0) / total * 100)}
      isPanelExpanded={!restore} title={`${action}; drag or use Up/Down arrows to resize`}
      onTogglePanel={() => setClosedSections((current) => current.map((value, i) => i === target ? !restore : value))}
      onPointerDown={(event) => {
        event.preventDefault();
        dragStartRef.current = fitSectionWeights(sectionWeights, closedSections, getAvailableHeight());
      }}
      onDrag={(_event, delta) => { if (dragStartRef.current) resizePair(index, dragStartRef.current, delta.y); }}
      onPointerEnd={() => { dragStartRef.current = null; }}
      onKeyDown={(event) => {
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const start = fitSectionWeights(sectionWeights, closedSections, getAvailableHeight());
        resizePair(index, start, event.key === "Home" ? -Infinity : event.key === "End" ? Infinity : event.key === "ArrowDown" ? 24 : -24);
      }}
    />;
  };

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
          <div className="home-monitor-parent-identity" role="group" aria-label={`Main session: ${title}`}>
            <span className="home-monitor-status-cluster" aria-label={`Main status: ${entry.mainState.label}`}>
              <MonitorStatusIcon kind={entry.mainState.kind} label={`Main ${entry.mainState.label}`} />
            </span>
            <button
              className="home-monitor-parent-button"
              type="button"
              onClick={openParent}
              onKeyDown={(event) => showEntryContextMenuFromKeyboard(event, entry)}
              aria-haspopup="menu"
              aria-label={`Open session: ${title}`}
              title={title}
            >
              <CharacterAvatar
                character={{ name: entry.session.character, iconPath: entry.session.characterIconPath }}
                size="tiny"
                className="home-monitor-avatar"
              />
              <strong className="home-monitor-parent-title">{title}</strong>
            </button>
          </div>
          {canExpand ? (
            <button
              className="home-monitor-disclosure"
              type="button"
              aria-label={`${isExpanded ? "Hide" : "Show"} Auxiliary sessions for ${title}`}
              title={`${isExpanded ? "Hide" : "Show"} Auxiliary sessions for ${title}`}
              aria-expanded={isExpanded}
              onClick={() => toggleEntry(entry)}
            >
              <ComposerIcon name="auxiliary" />
              {renderAuxiliaryStatusIcons(entry)}
              <span aria-hidden="true">{isExpanded ? "▾" : "▸"}</span>
            </button>
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
  const renderMonitorList = (entries: HomeMonitorEntry[], emptyMessage = "") => {
    const midpoint = Math.ceil(entries.length / 2);
    return <div className="home-monitor-list">
      {entries.length > 0 ? [entries.slice(0, midpoint), entries.slice(midpoint)].map((column, index) => (
        <div key={index} className="home-monitor-column">{renderMonitorEntries(column)}</div>
      )) : showEmptyState && emptyMessage ? <p className="home-monitor-empty">{emptyMessage}</p> : null}
    </div>;
  };
  const fittedWeights = fitSectionWeights(sectionWeights, closedSections, availableHeight);

  return (
    <div
      className="home-monitor-body"
      aria-busy={isLoading}
    >
      {providerQuota ? (
        <div className="home-monitor-quota">
          <div id={`${id}-quota`} hidden={!isQuotaExpanded}>{providerQuota}</div>
          <ChatDockSplitter edge="top" className="home-monitor-quota-splitter"
            isPanelExpanded={isQuotaExpanded} ariaControls={`${id}-quota`}
            ariaLabel={isQuotaExpanded ? "Collapse Provider Quotas" : "Expand Provider Quotas"}
            onTogglePanel={() => setIsQuotaExpanded((current) => !current)} />
        </div>
      ) : null}
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
        className="home-monitor-sections"
        style={{ gridTemplateRows: fittedWeights.map((weight, index) => closedSections[index] ? "max-content" : `minmax(48px, ${weight}fr)`).join(" var(--session-dock-splitter-size) ") }}
      >
        <section className={`home-monitor-section${closedSections[0] ? " is-closed" : ""}`} aria-labelledby="home-monitor-approval">
          <div className="home-monitor-section-head">
            <h3 id="home-monitor-approval">Attention</h3>
            <span className="home-monitor-count">{approvalEntries.length}</span>
          </div>
          <div id={`${id}-content-0`} className={`home-monitor-section-content${closedSections[0] || smallSections[0] ? " is-hidden" : ""}`} inert={closedSections[0] || smallSections[0]} aria-hidden={closedSections[0] || smallSections[0]}>
            {renderMonitorList(approvalEntries)}
          </div>
        </section>

        {renderSplitter(0)}

        <section className={`home-monitor-section${closedSections[1] ? " is-closed" : ""}`} aria-labelledby="home-monitor-running">
          <div className="home-monitor-section-head">
            <h3 id="home-monitor-running">Running</h3>
            <span className="home-monitor-count">{runningEntries.length}</span>
          </div>
          <div id={`${id}-content-1`} className={`home-monitor-section-content${closedSections[1] || smallSections[1] ? " is-hidden" : ""}`} inert={closedSections[1] || smallSections[1]} aria-hidden={closedSections[1] || smallSections[1]}>
            {renderMonitorList(runningEntries, runningEmptyMessage)}
          </div>
        </section>

        {renderSplitter(1)}

        <section className={`home-monitor-section${closedSections[2] ? " is-closed" : ""}`} aria-labelledby="home-monitor-inactive">
          <div className="home-monitor-section-head">
            <h3 id="home-monitor-inactive">Stopped</h3>
            <span className="home-monitor-count">{nonRunningEntries.length}</span>
          </div>
          <div id={`${id}-content-2`} className={`home-monitor-section-content${closedSections[2] || smallSections[2] ? " is-hidden" : ""}`} inert={closedSections[2] || smallSections[2]} aria-hidden={closedSections[2] || smallSections[2]}>
            {renderMonitorList(nonRunningEntries, nonRunningEmptyMessage)}
          </div>
        </section>
      </div>
    </div>
  );
}
