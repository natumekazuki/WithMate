import type { ReactNode } from "react";

import type { HomeRecentSessionsPanelProps } from "./HomeRecentSessionsPanel.js";
import type { HomeSessionState } from "./home-session-projection.js";
import type { SessionSummary } from "../app-state.js";
import type { CompanionSessionSummary } from "../companion-state.js";

type HomeRecentSessionsPanelHandlers = {
  onChangeSearchText: (value: string) => void;
  onOpenLaunchDialog: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenCompanionReview: (sessionId: string) => void;
};

export type HomeRecentSessionsPanelPropsInput = {
  filteredSessionEntries: Array<{ session: SessionSummary; state: HomeSessionState }>;
  companionSessions: CompanionSessionSummary[];
  normalizedSessionSearch: string;
  searchText: string;
  searchIcon: ReactNode;
  handlers: HomeRecentSessionsPanelHandlers;
  canUsePrimaryFeatures?: boolean;
};

export function buildHomeRecentSessionsPanelProps({
  filteredSessionEntries,
  companionSessions,
  normalizedSessionSearch,
  searchText,
  searchIcon,
  handlers,
  canUsePrimaryFeatures,
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
    onOpenCompanionReview: handlers.onOpenCompanionReview,
    canUsePrimaryFeatures,
  };
}
