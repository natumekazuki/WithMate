import type { ReactNode } from "react";

import type { SessionSummariesLoadStatus } from "../chat/runtime/session-summary-subscription.js";
import type { HomeRecentSessionsPanelProps } from "./HomeRecentSessionsPanel.js";
import type { HomeSessionState } from "./home-session-projection.js";
import type { HomeSessionSummary } from "../../src-shared/session/session-state.js";

type HomeRecentSessionsPanelHandlers = {
  onChangeSearchText: (value: string) => void;
  onOpenLaunchDialog: () => void;
  onOpenSession: (sessionId: string) => void;
  onSetSessionPinned: (sessionId: string, isPinned: boolean) => void;
};

export type HomeRecentSessionsPanelPropsInput = {
  filteredSessionEntries: Array<{ session: HomeSessionSummary; state: HomeSessionState }>;
  normalizedSessionSearch: string;
  searchText: string;
  searchIcon: ReactNode;
  handlers: HomeRecentSessionsPanelHandlers;
  canCreateSession?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  pendingSessionPinIds?: readonly string[];
  sessionSummaryLoadStatus?: SessionSummariesLoadStatus;
  feedback?: string;
  onRetry?: () => void;
  launchResults?: ReactNode;
};

export function buildHomeRecentSessionsPanelProps({
  filteredSessionEntries,
  normalizedSessionSearch,
  searchText,
  searchIcon,
  handlers,
  canCreateSession,
  hasMore,
  loadingMore,
  onLoadMore,
  pendingSessionPinIds,
  sessionSummaryLoadStatus,
  feedback,
  onRetry,
  launchResults,
}: HomeRecentSessionsPanelPropsInput): HomeRecentSessionsPanelProps {
  return {
    filteredSessionEntries,
    normalizedSessionSearch,
    searchText,
    searchIcon,
    onChangeSearchText: handlers.onChangeSearchText,
    onOpenLaunchDialog: handlers.onOpenLaunchDialog,
    onOpenSession: handlers.onOpenSession,
    onSetSessionPinned: handlers.onSetSessionPinned,
    canCreateSession,
    hasMore,
    loadingMore,
    onLoadMore,
    pendingSessionPinIds,
    sessionSummaryLoadStatus,
    feedback,
    onRetry,
    launchResults,
  };
}
