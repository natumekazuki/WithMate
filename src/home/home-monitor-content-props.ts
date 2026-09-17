import type { HomeMonitorContentProps } from "./HomeMonitorContent.js";
import type { HomeMonitorEntry } from "./home-session-projection.js";
import type {
  SessionMonitorContextMenuPoint,
  SessionMonitorEntryKind,
} from "../withmate-window-types.js";

export type HomeMonitorContentInput = {
  runningEntries: HomeMonitorEntry[];
  nonRunningEntries: HomeMonitorEntry[];
  feedback?: string;
  onOpenSession: (sessionId: string) => void;
  onOpenCompanionReview: (sessionId: string) => void;
  onShowContextMenu: (
    kind: SessionMonitorEntryKind,
    sessionId: string,
    point: SessionMonitorContextMenuPoint,
  ) => void;
};

export function buildHomeMonitorContentProps({
  runningEntries,
  nonRunningEntries,
  feedback,
  onOpenSession,
  onOpenCompanionReview,
  onShowContextMenu,
}: HomeMonitorContentInput): HomeMonitorContentProps {
  return {
    runningEntries,
    nonRunningEntries,
    feedback,
    onOpenSession,
    onOpenCompanionReview,
    onShowContextMenu,
  };
}
