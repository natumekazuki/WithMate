import type { ReactNode } from "react";

import type { SessionSummariesLoadStatus } from "../chat/runtime/session-summary-subscription.js";
import type { HomeRecentSessionsPanelProps } from "./HomeRecentSessionsPanel.js";
import type { HomeSessionState } from "./home-session-projection.js";
import type { HomeSessionSummary } from "../../src-shared/session/session-state.js";

/** 一覧項目を開く操作と、同じ項目のピンを変更する操作。 */
type HomeRecentSessionsPanelHandlers = {
  onOpenSession: (sessionId: string) => void;
  onSetSessionPinned: (sessionId: string, isPinned: boolean) => void;
};

/** 絞り込み済みの要約と操作、ページの状態、一覧に表示する起動結果。 */
export type HomeRecentSessionsPanelPropsInput = {
  filteredSessionEntries: Array<{
    session: HomeSessionSummary;
    state: HomeSessionState;
  }>;
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

/** Home で決めた一覧と操作をパネルの表示引数にまとめ、ページの取得や絞り込みは行わない。 */
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
