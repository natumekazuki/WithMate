import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";

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
import { ButtonContent } from "../ui/button-content.js";
import { getHomeAuxiliarySessionState } from "./home-session-projection.js";
import { ChatDockSplitter } from "../chat/chat-window.js";
import { ComposerIcon } from "../chat/composer/composer-icon.js";
import { useCoordinationMonitor } from "../coordination/use-coordination-monitor.js";

export type HomeMonitorContentProps = {
  approvalEntries: HomeMonitorEntry[];
  providerQuota?: ReactNode;
  runningEntries: HomeMonitorEntry[];
  nonRunningEntries: HomeMonitorEntry[];
  auxiliaryDataState?: HomeMonitorAuxiliaryDataState;
  auxiliaryRefreshing?: boolean;
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

type HomeMonitorStatusKind = HomeSessionState["kind"] | "loading";

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

function layoutMonitorCards(list: HTMLElement) {
  const cards = [...list.querySelectorAll<HTMLElement>(":scope > .home-monitor-card")];
  const styles = list.ownerDocument.defaultView!.getComputedStyle(list);
  const columns = Number(styles.getPropertyValue("--home-monitor-columns")) || 1;
  const gap = parseFloat(styles.rowGap) || 0;
  const midpoint = Math.ceil(cards.length / columns);
  const cardHeights = cards.map((card) => card.getBoundingClientRect().height);
  const heights = [0, 0];
  cards.forEach((card, index) => {
    const column = index < midpoint ? 0 : 1;
    const left = column === 0 ? "0px" : "calc((100% + var(--home-monitor-column-gap)) / 2)";
    const top = `${heights[column]}px`;
    if (card.style.left !== left) card.style.left = left;
    if (card.style.top !== top) card.style.top = top;
    heights[column]! += cardHeights[index]! + gap;
  });
  const height = `${Math.max(0, ...heights) - (cards.length ? gap : 0)}px`;
  if (list.style.height !== height) list.style.height = height;
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
  auxiliaryRefreshing = false,
  sessionWindowsDataState = "loaded",
  runningEmptyMessage = "",
  nonRunningEmptyMessage = "",
  feedback = "",
  onRetry,
  onOpenSession,
  onShowContextMenu,
}: HomeMonitorContentProps) {
  const [expandedEntryKeys, setExpandedEntryKeys] = useState<Set<string>>(() => new Set());
  const coordination = useCoordinationMonitor();
  const { entriesBySection, coordinationBySession } = useMemo(() => {
    const entries = new Map([...approvalEntries, ...runningEntries, ...nonRunningEntries].map(entry => [entry.session.id, entry]));
    const attentionIds = new Set(approvalEntries.map(entry => entry.session.id));
    const runningIds = new Set(runningEntries.map(entry => entry.session.id));
    const pending = new Map(coordination.groups.map(group => [group.mainSessionId, group]));
    const sections: HomeMonitorEntry[][] = [[], [], [], []];
    for (const entry of entries.values()) {
      const sessionId = entry.session.id;
      const section = attentionIds.has(sessionId) ? 0 : pending.has(sessionId) ? 1 : runningIds.has(sessionId) ? 2 : 3;
      sections[section]!.push(entry);
    }
    return { entriesBySection: sections, coordinationBySession: pending };
  }, [approvalEntries, runningEntries, nonRunningEntries, coordination.groups]);
  const [closedRows, setClosedRows] = useState([false, false, false]);
  const closedSections = [closedRows[0]!, closedRows[0]!, closedRows[1]!, closedRows[2]!];
  const [smallSections, setSmallSections] = useState([false, false, false, false]);
  const [sectionWeights, setSectionWeights] = useState([1, 1, 1]);
  const [availableHeight, setAvailableHeight] = useState(0);
  const [isQuotaExpanded, setIsQuotaExpanded] = useState(true);
  const sectionsRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<number[] | null>(null);
  const id = useId();
  const sectionCounts = entriesBySection.map(entries => entries.length);
  const rowLabels = ["Attention and Coordination", "Running", "Stopped"];
  const rowCounts = [sectionCounts[0]! + sectionCounts[1]!, sectionCounts[2]!, sectionCounts[3]!];
  const rowContentIds = [`${id}-content-0 ${id}-content-1`, `${id}-content-2`, `${id}-content-3`];

  const getAvailableHeight = () => {
    const container = sectionsRef.current;
    if (!container) return 0;
    return container.getBoundingClientRect().height
      - [...container.querySelectorAll<HTMLElement>(":scope > .home-monitor-splitter")].reduce((sum, item) => sum + item.getBoundingClientRect().height, 0)
      - [...container.querySelectorAll<HTMLElement>(":scope > .home-monitor-row")].reduce((sum, item, index) => sum + (closedRows[index] ? item.getBoundingClientRect().height : 0), 0);
  };

  useLayoutEffect(() => {
    const container = sectionsRef.current;
    if (!container) return;
    const sections = [...container.querySelectorAll<HTMLElement>(".home-monitor-section")];
    const update = () => {
      for (const list of container.querySelectorAll<HTMLElement>(".home-monitor-list-items")) layoutMonitorCards(list);
      setAvailableHeight(getAvailableHeight());
      const small = sections.map((section, index) => {
        if (closedSections[index]) return false;
        const content = section.querySelector<HTMLElement>(".home-monitor-section-content");
        const card = content?.querySelector<HTMLElement>(".home-monitor-parent-row");
        return Boolean(content && card && content.getBoundingClientRect().height < card.getBoundingClientRect().height);
      });
      sections.forEach((section, index) => {
        if ((closedSections[index] || small[index]) && section.querySelector(".home-monitor-section-content")?.contains(container.ownerDocument.activeElement)) {
          container.querySelectorAll<HTMLButtonElement>(":scope > .home-monitor-splitter")[index < 2 ? 0 : 1]?.focus({ preventScroll: true });
        }
      });
      setSmallSections((current) => current.every((value, index) => value === small[index]) ? current : small);
    };
    update();
    const Observer = container.ownerDocument.defaultView?.ResizeObserver;
    if (!Observer) return;
    const observer = new Observer(update);
    observer.observe(container);
    for (const row of container.querySelectorAll(":scope > .home-monitor-row")) observer.observe(row);
    for (const section of sections) {
      observer.observe(section);
      for (const item of section.querySelectorAll(".home-monitor-section-head, .home-monitor-parent-row, .home-monitor-card, .home-monitor-list-items")) observer.observe(item);
    }
    return () => observer.disconnect();
  }, [closedRows, approvalEntries, coordination.groups, runningEntries, nonRunningEntries, expandedEntryKeys]);

  const resizePair = (index: number, start: number[], delta: number) => {
    if (closedRows[index] || closedRows[index + 1]) return;
    const total = start[index]! + start[index + 1]!;
    const minimum = Math.min(48, total / 2);
    const first = Math.max(minimum, Math.min(total - minimum, start[index]! + delta));
    setAvailableHeight(getAvailableHeight());
    setSectionWeights((weights) => {
      const activeWeight = weights.reduce((sum, value, i) => sum + (closedRows[i] ? 0 : value), 0);
      const activeHeight = start.reduce((sum, value, i) => sum + (closedRows[i] ? 0 : value), 0);
      if (activeHeight <= 0) return weights;
      const next = start.map((value, i) => closedRows[i] ? weights[i]! : value * activeWeight / activeHeight);
      next[index] = first * activeWeight / activeHeight;
      next[index + 1] = (total - first) * activeWeight / activeHeight;
      return next;
    });
  };

  const renderSplitter = (index: number) => {
    const nextIndex = index + 1;
    const restore = closedRows[index] || closedRows[nextIndex];
    const target = closedRows[index] ? index : closedRows[nextIndex] ? nextIndex
      : rowCounts[index]! < rowCounts[nextIndex]! ? index : nextIndex;
    const action = `${restore ? "Expand" : "Collapse"} ${rowLabels[target]}`;
    const weights = fitSectionWeights(sectionWeights, closedRows, getAvailableHeight());
    const sectionElements = sectionsRef.current?.querySelectorAll<HTMLElement>(":scope > .home-monitor-row");
    const heights = weights.map((value, i) => closedRows[i] ? sectionElements?.[i]?.getBoundingClientRect().height ?? 0 : value);
    const total = heights.reduce((sum, value) => sum + value, 0);
    return <ChatDockSplitter edge={target === index ? "top" : "bottom"} className="home-monitor-splitter"
      ariaLabel={`${action}; resize ${rowLabels[index]} and ${rowLabels[nextIndex]}`}
      ariaControls={rowContentIds[target]}
      ariaOrientation="horizontal" ariaValueNow={Math.round(heights.slice(0, nextIndex).reduce((sum, value) => sum + value, 0) / total * 100)}
      isPanelExpanded={!restore} title={`${action}; drag or use Up/Down arrows to resize`}
      onTogglePanel={() => setClosedRows((current) => current.map((value, i) => i === target ? !restore : value))}
      onPointerDown={(event) => {
        event.preventDefault();
        dragStartRef.current = fitSectionWeights(sectionWeights, closedRows, getAvailableHeight());
      }}
      onDrag={(_event, delta) => { if (dragStartRef.current) resizePair(index, dragStartRef.current, delta.y); }}
      onPointerEnd={() => { dragStartRef.current = null; }}
      onKeyDown={(event) => {
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const start = fitSectionWeights(sectionWeights, closedRows, getAvailableHeight());
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
    const pending = coordinationBySession.get(entry.session.id);
    const coordinationPrimary = pending && !entriesBySection[0]!.some(candidate => candidate.session.id === entry.session.id);
    const auxiliarySessions = entry.auxiliarySessions;
    const entryKey = getEntryKey(entry);
    const isExpanded = expandedEntryKeys.has(entryKey);
    const canExpand = auxiliarySessions.length > 0;
    const title = entry.session.taskTitle || entry.session.id;
    const mainUnread = entry.session.hasUnreadResult === true;
    const auxiliaryUnread = auxiliarySessions.some((summary) => summary.hasUnreadResult);
    const openParent = () => {
      if (coordinationPrimary) void coordination.open(pending);
      else onOpenSession(entry.session.id);
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
              className={`home-monitor-parent-button${mainUnread ? " has-unread-result" : ""}`}
              type="button"
              onClick={openParent}
              onKeyDown={(event) => showEntryContextMenuFromKeyboard(event, entry)}
              aria-haspopup="menu"
              aria-label={coordinationPrimary ? `Open Coordination for ${title}` : `Open session: ${title}${mainUnread ? "; Unread Result" : ""}`}
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
              className={`home-monitor-disclosure${auxiliaryUnread ? " has-unread-result" : ""}`}
              type="button"
              aria-label={`${isExpanded ? "Hide" : "Show"} Auxiliary sessions for ${title}${auxiliaryUnread ? "; Unread Result" : ""}`}
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
                  className={`home-monitor-auxiliary-row${summary.hasUnreadResult ? " has-unread-result" : ""}`}
                  type="button"
                  onClick={openAuxiliary}
                  aria-label={`${preview ? `Open Auxiliary: ${preview}` : `Open Auxiliary ${index + 1}`}${summary.hasUnreadResult ? "; Unread Result" : ""}`}
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
  const isBusy = isLoading || auxiliaryRefreshing;
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
    return <div className="home-monitor-list">
      {entries.length > 0 ? (
        <div className="home-monitor-list-items">{renderMonitorEntries(entries)}</div>
      ) : showEmptyState && emptyMessage ? <p className="home-monitor-empty">{emptyMessage}</p> : null}
    </div>;
  };
  const fittedWeights = fitSectionWeights(sectionWeights, closedRows, availableHeight);

  return (
    <div
      className="home-monitor-body"
      aria-busy={isBusy || coordination.loading || coordination.refreshing}
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
        <LoadError message={statusFeedback} onRetry={onRetry} retryBusy={isBusy} className="home-session-list-feedback" />
      ) : (
        <div className="home-session-list-feedback">
          <p className="settings-feedback" role="status" aria-live="polite">{statusFeedback}</p>
          {onRetry ? (
            <button className="launch-toggle home-session-retry-button" type="button" disabled={isBusy} aria-busy={isBusy || undefined} onClick={onRetry}>
              <ButtonContent busy={isBusy} busyLabel="Retrying">Retry</ButtonContent>
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
        style={{ gridTemplateRows: fittedWeights.map((weight, index) => closedRows[index] ? "max-content" : `minmax(48px, ${weight}fr)`).join(" var(--session-dock-splitter-size) ") }}
      >
        <div className={`home-monitor-row home-monitor-top-row${closedRows[0] ? " is-closed" : ""}`}>
          <section className={`home-monitor-section${closedSections[0] ? " is-closed" : ""}`} aria-labelledby="home-monitor-approval">
            <div className="home-monitor-section-head">
              <h3 id="home-monitor-approval">Attention</h3>
              <span className="home-monitor-count">{sectionCounts[0]}</span>
            </div>
            <div id={`${id}-content-0`} className={`home-monitor-section-content${closedSections[0] || smallSections[0] ? " is-hidden" : ""}`} inert={closedSections[0] || smallSections[0]} aria-hidden={closedSections[0] || smallSections[0]}>
              {renderMonitorList(entriesBySection[0]!)}
            </div>
          </section>

          <ChatDockSplitter edge="left" className="home-monitor-top-divider" />

          <section className={`home-monitor-section${closedSections[1] ? " is-closed" : ""}`} aria-labelledby="home-monitor-coordination">
            <div className="home-monitor-section-head">
              <h3 id="home-monitor-coordination">Coordination</h3>
              <span className="home-monitor-count" aria-label={`${sectionCounts[1]} Main session groups`}>{sectionCounts[1]}</span>
            </div>
            <div id={`${id}-content-1`} className={`home-monitor-section-content${closedSections[1] || smallSections[1] ? " is-hidden" : ""}`} inert={closedSections[1] || smallSections[1]} aria-hidden={closedSections[1] || smallSections[1]}>
              {coordination.loading ? <LoadingIndicator label="Loading Coordination" /> : null}
              {coordination.error ? <LoadError message={coordination.error} onRetry={coordination.retry} /> : null}
              {renderMonitorList(entriesBySection[1]!)}
            </div>
          </section>
        </div>

        {renderSplitter(0)}

        <section className={`home-monitor-row home-monitor-section${closedSections[2] ? " is-closed" : ""}`} aria-labelledby="home-monitor-running">
          <div className="home-monitor-section-head">
            <h3 id="home-monitor-running">Running</h3>
            <span className="home-monitor-count">{sectionCounts[2]}</span>
          </div>
          <div id={`${id}-content-2`} className={`home-monitor-section-content${closedSections[2] || smallSections[2] ? " is-hidden" : ""}`} inert={closedSections[2] || smallSections[2]} aria-hidden={closedSections[2] || smallSections[2]}>
            {renderMonitorList(entriesBySection[2]!, runningEmptyMessage)}
          </div>
        </section>

        {renderSplitter(1)}

        <section className={`home-monitor-row home-monitor-section${closedSections[3] ? " is-closed" : ""}`} aria-labelledby="home-monitor-inactive">
          <div className="home-monitor-section-head">
            <h3 id="home-monitor-inactive">Stopped</h3>
            <span className="home-monitor-count">{sectionCounts[3]}</span>
          </div>
          <div id={`${id}-content-3`} className={`home-monitor-section-content${closedSections[3] || smallSections[3] ? " is-hidden" : ""}`} inert={closedSections[3] || smallSections[3]} aria-hidden={closedSections[3] || smallSections[3]}>
            {renderMonitorList(entriesBySection[3]!, nonRunningEmptyMessage)}
          </div>
        </section>
      </div>
    </div>
  );
}
