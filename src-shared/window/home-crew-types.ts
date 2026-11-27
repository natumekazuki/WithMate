import type { AuxiliarySessionSummary } from "../auxiliary/auxiliary-session-state.js";
import type { HomeSessionSummary } from "../session/session-state.js";
import type { SessionMonitorContextMenuPoint } from "./withmate-window-types.js";

export type HomeCrewMember = HomeSessionSummary & {
  incarnationId: string;
  rootSessionId: string;
  parentSessionId: string | null;
  createdAt: string;
  isWindowOpen: boolean;
};

export type HomeCrewPageResult = {
  entries: HomeCrewMember[];
  auxiliarySessions: AuxiliarySessionSummary[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type HomeCrewContextMenuRequest = {
  sessionId: string;
  incarnationId: string;
  point: SessionMonitorContextMenuPoint;
};
