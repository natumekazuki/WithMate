import type { ReactNode } from "react";

import type { SessionSummariesLoadStatus } from "../chat/runtime/session-summary-subscription.js";
import type { HomeRecentSessionsPanelProps } from "./HomeRecentSessionsPanel.js";
import type { HomeSessionState } from "./home-session-projection.js";
import type { HomeSessionSummary } from "../../src-shared/session/session-state.js";

type HomeRecentSessionsPanelHandlers = {
  onOpenSession: (sessionId: string) => void;
  onSetSessionPinned: (sessionId: string, isPinned: boolean) => void;
};

export type HomeRecentSessionsPanelPropsInput = {
  filteredSessionEntries: Array<{ session: HomeSessionSummary; state: HomeSessionState }>;
  handlers: HomeRecentSessionsPanelHandlers;
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
  handlers,
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
    onOpenSession: handlers.onOpenSession,
    onSetSessionPinned: handlers.onSetSessionPinned,
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
