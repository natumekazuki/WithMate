import { useEffect, useRef, type ReactNode } from "react";

import { isReadOnlySession } from "../../src-shared/session/session-state.js";
import type { HomeSessionSummary } from "../../src-shared/session/session-state.js";
import type { HomeSessionState } from "./home-session-projection.js";
import { buildCardThemeStyle, CharacterAvatar } from "../ui-utils.js";

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
};

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

  return (
    <section className="panel session-list-panel home-session-list-panel rise-3">
      <div className="toolbar-search-row">
        <label className="toolbar-search-field" aria-label="セッション検索">
          <span className="toolbar-search-icon" aria-hidden="true">
            {searchIcon}
          </span>
          <input
            className="toolbar-search-input"
            type="text"
            aria-label="セッション検索"
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
          New Session
        </button>
      </div>

      <div className="session-card-list home-session-card-list">
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
                    <span>{`Workspace : ${session.workspacePath || session.workspaceLabel}`}</span>
                    <span>{`updatedAt: ${session.updatedAt}`}</span>
                  </div>
                </div>
              </button>
              <div className="home-session-card-actions">
                <div className="home-session-card-badges">
                  <span className={modeBadge.className}>{modeBadge.label}</span>
                  {isReadOnly ? <span className="session-status home-session-status neutral">閲覧専用</span> : null}
                  <span className={`session-status home-session-status ${state.kind}`.trim()}>{state.label}</span>
                </div>
                <button
                  className={`home-session-pin-button${session.isPinned ? " is-active" : ""}${isPinPending ? " is-pending" : ""}`}
                  type="button"
                  aria-pressed={session.isPinned}
                  aria-label={`${session.taskTitle}を${session.isPinned ? "ピン解除" : "ピン止め"}`}
                  disabled={!canUsePrimaryFeatures || isPinPending}
                  onClick={() => onSetSessionPinned(session.id, !session.isPinned)}
                >
                  {isPinPending ? "変更中..." : session.isPinned ? "ピン解除" : "ピン止め"}
                </button>
              </div>
            </div>
          );
        })}
        {hasMore ? <div ref={loadMoreSentinelRef} className="home-session-list-load-sentinel" aria-hidden="true" /> : null}
        {loadingMore ? (
          <div className="home-session-list-load-status" role="status" aria-live="polite">
            <span className="home-session-list-load-spinner" aria-hidden="true" />
            <span className="sr-only">Sessionを読み込み中...</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
