import type { ReactNode } from "react";

import type { HomeRecentSessionsPanelProps } from "./HomeRecentSessionsPanel.js";
import type { HomeSessionState } from "./home-session-projection.js";
import type { HomeSessionSummary } from "../app-state.js";
import type { CompanionSessionSummary } from "../companion-state.js";

type HomeRecentSessionsPanelHandlers = {
  onChangeSearchText: (value: string) => void;
  onOpenLaunchDialog: () => void;
  onOpenSession: (sessionId: string) => void;
  onSetSessionPinned: (sessionId: string, isPinned: boolean) => void;
  onOpenCompanionReview: (sessionId: string) => void;
  onRestoreSessionWindows: () => void;
};

export type HomeRecentSessionsPanelPropsInput = {
  filteredSessionEntries: Array<{ session: HomeSessionSummary; state: HomeSessionState }>;
  companionSessions: CompanionSessionSummary[];
  normalizedSessionSearch: string;
  searchText: string;
  searchIcon: ReactNode;
  handlers: HomeRecentSessionsPanelHandlers;
  canUsePrimaryFeatures?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  pendingSessionPinIds?: readonly string[];
  sessionWindowRestoreIds?: readonly string[];
  sessionWindowRestorePending?: boolean;
  sessionWindowRestoreFeedback?: string;
};

export function buildHomeRecentSessionsPanelProps({
  filteredSessionEntries,
  companionSessions,
  normalizedSessionSearch,
  searchText,
  searchIcon,
  handlers,
  canUsePrimaryFeatures,
  hasMore,
  loadingMore,
  onLoadMore,
  pendingSessionPinIds,
  sessionWindowRestoreIds,
  sessionWindowRestorePending,
  sessionWindowRestoreFeedback,
}: HomeRecentSessionsPanelPropsInput): HomeRecentSessionsPanelProps {
  return {
    filteredSessionEntries,
    companionSessions,
    normalizedSessionSearch,
    searchText,
    searchIcon,
    onChangeSearchText: handlers.onChangeSearchText,
    onOpenLaunchDialog: handlers.onOpenLaunchDialog,
    onOpenSession: handlers.onOpenSession,
    onSetSessionPinned: handlers.onSetSessionPinned,
    onOpenCompanionReview: handlers.onOpenCompanionReview,
    onRestoreSessionWindows: handlers.onRestoreSessionWindows,
    canUsePrimaryFeatures,
    hasMore,
    loadingMore,
    onLoadMore,
    pendingSessionPinIds,
    sessionWindowRestoreIds,
    sessionWindowRestorePending,
    sessionWindowRestoreFeedback,
  };
}
