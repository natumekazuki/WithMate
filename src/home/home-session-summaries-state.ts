import type { HomeSessionSummary, SessionCharacterUsage } from "../../src-shared/session/session-state.js";
import type { SessionSummariesLoadStatus } from "../chat/runtime/session-summary-subscription.js";
import {
  buildHomeSessionSummaryEntries,
  type HomeLoadedSessionSummaryPage,
  type HomeSessionSummaryPageCollection,
} from "./home-session-summary-query.js";

export type HomeSessionSummariesState = {
  recentStatus: SessionSummariesLoadStatus;
  pinnedStatus: SessionSummariesLoadStatus;
  recentError: string;
  pinnedError: string;
  recentPageError: string;
  pinnedPageError: string;
  summaries: HomeSessionSummary[];
  recentPages: HomeLoadedSessionSummaryPage[];
  recentCursor: string | null;
  hasMoreRecent: boolean;
  pinnedPages: HomeLoadedSessionSummaryPage[];
  pinnedCursor: string | null;
  hasMorePinned: boolean;
  loadingRecentPage: boolean;
  loadingPinnedPage: boolean;
  openSummaries: HomeSessionSummary[];
  openStatus: SessionSummariesLoadStatus;
  openError: string;
  characterUsageStatus: SessionSummariesLoadStatus;
  characterUsage: SessionCharacterUsage[];
};

export function createEmptyHomeSessionSummariesState(): HomeSessionSummariesState {
  return {
    recentStatus: "loading",
    pinnedStatus: "loading",
    recentError: "",
    pinnedError: "",
    recentPageError: "",
    pinnedPageError: "",
    summaries: [],
    recentPages: [],
    recentCursor: null,
    hasMoreRecent: false,
    pinnedPages: [],
    pinnedCursor: null,
    hasMorePinned: false,
    loadingRecentPage: false,
    loadingPinnedPage: false,
    openSummaries: [],
    openStatus: "loading",
    openError: "",
    characterUsageStatus: "loading",
    characterUsage: [],
  };
}

export function applyHomeSessionSummaryPages(
  current: HomeSessionSummariesState,
  pages: HomeSessionSummaryPageCollection,
): HomeSessionSummariesState {
  const recentPage = pages.recent.at(-1)?.page;
  const pinnedPage = pages.pinned.at(-1)?.page;
  return {
    ...current,
    summaries: buildHomeSessionSummaryEntries(pages),
    recentPages: pages.recent,
    recentCursor: recentPage?.nextCursor ?? null,
    hasMoreRecent: recentPage?.hasMore ?? false,
    pinnedPages: pages.pinned,
    pinnedCursor: pinnedPage?.nextCursor ?? null,
    hasMorePinned: pinnedPage?.hasMore ?? false,
    openSummaries: pages.open,
  };
}
