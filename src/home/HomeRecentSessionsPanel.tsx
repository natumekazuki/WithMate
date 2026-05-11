import type { ReactNode } from "react";

import type { SessionSummary } from "../app-state.js";
import type { CompanionSessionSummary } from "../companion-state.js";
import { getHomeCompanionSessionState, type HomeSessionState } from "./home-session-projection.js";
import { buildCardThemeStyle, CharacterAvatar } from "../ui-utils.js";

export type HomeRecentSessionsPanelProps = {
  filteredSessionEntries: Array<{ session: SessionSummary; state: HomeSessionState }>;
  companionSessions: CompanionSessionSummary[];
  normalizedSessionSearch: string;
  searchText: string;
  searchIcon: ReactNode;
  onChangeSearchText: (value: string) => void;
  onOpenLaunchDialog: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenCompanionReview: (sessionId: string) => void;
  canUsePrimaryFeatures?: boolean;
};

export function HomeRecentSessionsPanel({
  filteredSessionEntries,
  companionSessions,
  normalizedSessionSearch,
  searchText,
  searchIcon,
  onChangeSearchText,
  onOpenLaunchDialog,
  onOpenSession,
  onOpenCompanionReview,
  canUsePrimaryFeatures = true,
}: HomeRecentSessionsPanelProps) {
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
  const openCompanionReview = (sessionId: string) => {
    if (!canUsePrimaryFeatures) {
      return;
    }
    onOpenCompanionReview(sessionId);
  };
  const visibleCompanionSessions = companionSessions.filter((session) => {
    if (!normalizedSessionSearch) {
      return true;
    }
    const haystack = [
      session.taskTitle,
      session.character,
      session.repoRoot,
      session.focusPath,
      session.targetBranch,
      session.status,
    ].join(" ").toLowerCase();
    return haystack.includes(normalizedSessionSearch);
  });
  const visibleSessionEntries = [
    ...filteredSessionEntries.map((entry) => ({
      kind: "agent" as const,
      updatedAt: entry.session.updatedAt,
      entry,
    })),
    ...visibleCompanionSessions.map((session) => ({
      kind: "companion" as const,
      updatedAt: session.updatedAt,
      session,
    })),
  ].sort((left, right) => {
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
          if (item.kind === "companion") {
            const { session } = item;
            const companionState = getHomeCompanionSessionState(session);
            return (
              <button
                key={`companion-${session.id}`}
                className="session-card home-session-card"
                type="button"
                style={buildCardThemeStyle(session.characterThemeColors)}
                onClick={() => openCompanionReview(session.id)}
                aria-disabled={!canUsePrimaryFeatures}
                disabled={!canUsePrimaryFeatures}
              >
                <CharacterAvatar character={{ name: session.character, iconPath: session.characterIconPath }} size="small" className="session-card-avatar" />
                <div className="session-card-copy">
                  <div className="session-card-topline home-session-card-topline">
                    <strong>{session.taskTitle}</strong>
                    <div className="home-session-card-badges">
                      <span className="session-mode-badge companion">Companion</span>
                      <span className={`session-status home-session-status ${companionState.kind}`.trim()}>{companionState.label}</span>
                    </div>
                  </div>
                  <div className="session-card-subline home-session-card-meta">
                    <span>{`Workspace : ${session.focusPath || session.repoRoot}`}</span>
                    <span>{`updatedAt: ${session.updatedAt}`}</span>
                  </div>
                </div>
              </button>
            );
          }

          const { session, state } = item.entry;
          return (
            <button
              key={`agent-${session.id}`}
              className="session-card home-session-card"
              type="button"
              style={buildCardThemeStyle(session.characterThemeColors)}
              onClick={() => openSession(session.id)}
              aria-disabled={!canUsePrimaryFeatures}
              disabled={!canUsePrimaryFeatures}
            >
              <CharacterAvatar character={{ name: session.character, iconPath: session.characterIconPath }} size="small" className="session-card-avatar" />
              <div className="session-card-copy">
                <div className="session-card-topline home-session-card-topline">
                  <strong>{session.taskTitle}</strong>
                  <div className="home-session-card-badges">
                    <span className="session-mode-badge agent">Agent</span>
                    <span className={`session-status home-session-status ${state.kind}`.trim()}>{state.label}</span>
                  </div>
                </div>
                <div className="session-card-subline home-session-card-meta">
                  <span>{`Workspace : ${session.workspacePath || session.workspaceLabel}`}</span>
                  <span>{`updatedAt: ${session.updatedAt}`}</span>
                </div>
                {session.taskSummary.trim() ? <p className="session-card-summary home-session-card-summary">{session.taskSummary}</p> : null}
              </div>
            </button>
          );
        })}
        {!hasVisibleEntries ? (
          normalizedSessionSearch ? (
            <article className="empty-list-card">
              <p>一致するセッションはないよ。</p>
            </article>
          ) : (
            <article className="empty-list-card">
              <p>まだセッションはないよ。</p>
              <button
                className="start-session-button"
                type="button"
                onClick={openLaunchDialog}
                aria-disabled={!canUsePrimaryFeatures}
                disabled={!canUsePrimaryFeatures}
              >
                New Session
              </button>
            </article>
          )
        ) : null}
      </div>
    </section>
  );
}
