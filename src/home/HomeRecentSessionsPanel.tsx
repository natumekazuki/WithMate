import { useEffect, useRef, type ReactNode } from "react";

import { isReadOnlySession } from "../../src-shared/session/session-state.js";
import type { HomeSessionSummary } from "../../src-shared/session/session-state.js";
import type { SessionSummariesLoadStatus } from "../chat/runtime/session-summary-subscription.js";
import type { HomeSessionState } from "./home-session-projection.js";
import { buildCardThemeStyle, CharacterAvatar } from "../ui/ui-utils.js";

export type HomeRecentSessionsPanelProps = {
  filteredSessionEntries: Array<{ session: HomeSessionSummary; state: HomeSessionState }>;
  normalizedSessionSearch: string;
  searchText: string;
  searchIcon: ReactNode;
  onChangeSearchText: (value: string) => void;
  onOpenLaunchDialog: () => void;
  onOpenSession: (sessionId: string) => void;
  onSetSessionPinned: (sessionId: string, isPinned: boolean) => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  pendingSessionPinIds?: readonly string[];
  canUsePrimaryFeatures?: boolean;
  sessionSummaryLoadStatus?: SessionSummariesLoadStatus;
};

const HOME_SESSION_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatHomeSessionUpdatedAt(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return value;
  }
  return HOME_SESSION_DATE_FORMATTER.format(timestamp);
}

function PinIcon({ active, pending }: { active: boolean; pending: boolean }) {
  if (pending) {
    return <span className="home-session-pin-icon pending" aria-hidden="true" />;
  }

  return (
    <svg
      className={`home-session-pin-icon${active ? " active" : ""}`}
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="m7.2 2.8 5.7 5.7 1.3-.3 1.2 1.2-3.6 1.9-1.9 3.6-1.2-1.2.3-1.3-5.7-5.7 1.3-1.3 1.3.3 1.3-1.3Zm-2.9 9.9 2.9 2.9-2.5 1.6-2-2 1.6-2.5Z"
        fill={active ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function getAgentSessionModeBadge(session: HomeSessionSummary): { className: string; label: string } {
  if (session.sessionKind === "character-authoring") {
    return {
      className: "session-mode-badge character",
      label: "Character",
    };
  }

  return {
    className: "session-mode-badge agent",
    label: "Agent",
  };
}

export function HomeRecentSessionsPanel({
  filteredSessionEntries,
  normalizedSessionSearch,
  searchText,
  searchIcon,
  onChangeSearchText,
  onOpenLaunchDialog,
  onOpenSession,
  onSetSessionPinned,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  pendingSessionPinIds = [],
  canUsePrimaryFeatures = true,
  sessionSummaryLoadStatus = "loaded",
}: HomeRecentSessionsPanelProps) {
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    const scrollRoot = sentinel?.parentElement;
    if (!sentinel || !scrollRoot || !hasMore || !onLoadMore || typeof IntersectionObserver === "undefined") {
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onLoadMore();
      }
    }, {
      root: scrollRoot,
      rootMargin: "0px 0px 96px",
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, onLoadMore]);

  const openLaunchDialog = () => {
    if (!canUsePrimaryFeatures) {
      return;
    }
    onOpenLaunchDialog();
  };
  const openSession = (sessionId: string) => {
    if (!canUsePrimaryFeatures) {
      return;
    }
    onOpenSession(sessionId);
  };
  const visibleSessionEntries = filteredSessionEntries.map((entry) => ({
      kind: "agent" as const,
      updatedAt: entry.session.updatedAt,
      isPinned: entry.session.isPinned,
      entry,
    })).sort((left, right) => {
    if (left.isPinned !== right.isPinned) {
      return left.isPinned ? -1 : 1;
    }
    const leftTime = Date.parse(left.updatedAt);
    const rightTime = Date.parse(right.updatedAt);
    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  });
  const hasVisibleEntries = visibleSessionEntries.length > 0;
  const emptyMessage = sessionSummaryLoadStatus === "loading"
    ? "Loading sessions…"
    : sessionSummaryLoadStatus === "error"
      ? "Could not load sessions."
      : normalizedSessionSearch
        ? "No matching sessions."
        : "No sessions yet.";

  return (
    <section className="panel session-list-panel home-session-list-panel rise-3">
      <div className="toolbar-search-row">
        <label className="toolbar-search-field" aria-label="Search sessions">
          <span className="toolbar-search-icon" aria-hidden="true">
            {searchIcon}
          </span>
          <input
            className="toolbar-search-input"
            type="text"
            aria-label="Search sessions"
            value={searchText}
            onChange={(event) => onChangeSearchText(event.target.value)}
          />
        </label>
        <button
          className="start-session-button"
          type="button"
          onClick={openLaunchDialog}
          aria-disabled={!canUsePrimaryFeatures}
          disabled={!canUsePrimaryFeatures}
        >
          New session
        </button>
      </div>

      <div
        className="session-card-list home-session-card-list"
        aria-busy={sessionSummaryLoadStatus === "loading" || loadingMore}
      >
        {visibleSessionEntries.map((item) => {
          const { session, state } = item.entry;
          const isReadOnly = isReadOnlySession(session);
          const modeBadge = getAgentSessionModeBadge(session);
          const isPinPending = pendingSessionPinIds.includes(session.id);
          return (
            <div
              key={`agent-${session.id}`}
              className={`session-card home-session-card is-pinnable${session.isPinned ? " is-pinned" : ""}`}
              style={buildCardThemeStyle(session.characterThemeColors)}
            >
              <button
                className="home-session-card-open"
                type="button"
                onClick={() => openSession(session.id)}
                aria-disabled={!canUsePrimaryFeatures}
                disabled={!canUsePrimaryFeatures}
              >
                <CharacterAvatar
                  character={{ name: session.character, iconPath: session.characterIconPath }}
                  size="tiny"
                  className="home-session-card-avatar"
                />
                <div className="session-card-copy">
                  <strong>{session.taskTitle}</strong>
                  <div className="session-card-subline home-session-card-meta">
                    <span>{`Workspace: ${session.workspacePath || session.workspaceLabel}`}</span>
                    <span>{`Updated ${formatHomeSessionUpdatedAt(session.updatedAt)}`}</span>
                  </div>
                </div>
              </button>
              <div className="home-session-card-actions">
                <div className="home-session-card-badges">
                  <span className={modeBadge.className}>{modeBadge.label}</span>
                  {isReadOnly ? <span className="session-status home-session-status neutral">Read-only</span> : null}
                  <span className={`session-status home-session-status ${state.kind}`.trim()}>{state.label}</span>
                </div>
                <button
                  className={`home-session-pin-button${session.isPinned ? " is-active" : ""}${isPinPending ? " is-pending" : ""}`}
                  type="button"
                  aria-pressed={session.isPinned}
                  aria-label={isPinPending
                    ? `Updating pin for ${session.taskTitle}`
                    : `${session.isPinned ? "Unpin" : "Pin"} ${session.taskTitle}`}
                  title={isPinPending
                    ? `Updating pin for ${session.taskTitle}`
                    : `${session.isPinned ? "Unpin" : "Pin"} ${session.taskTitle}`}
                  aria-busy={isPinPending}
                  disabled={!canUsePrimaryFeatures || isPinPending}
                  onClick={() => onSetSessionPinned(session.id, !session.isPinned)}
                >
                  <PinIcon active={session.isPinned} pending={isPinPending} />
                </button>
              </div>
            </div>
          );
        })}
        {!hasVisibleEntries ? (
          <p className="home-session-list-empty" role={sessionSummaryLoadStatus === "loading" ? "status" : undefined}>
            {emptyMessage}
          </p>
        ) : null}
        {hasMore ? <div ref={loadMoreSentinelRef} className="home-session-list-load-sentinel" aria-hidden="true" /> : null}
        {loadingMore ? (
          <div className="home-session-list-load-status" role="status" aria-live="polite">
            <span className="home-session-list-load-spinner" aria-hidden="true" />
            <span className="sr-only">Loading more sessions…</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
