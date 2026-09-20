import type { HomeMonitorContentProps } from "./HomeMonitorContent.js";
import type { HomeMonitorAuxiliaryDataState, HomeMonitorEntry } from "./home-session-projection.js";
import type {
  SessionMonitorContextMenuPoint,
  SessionMonitorEntryKind,
} from "../withmate-window-types.js";

export type HomeMonitorContentInput = {
  runningEntries: HomeMonitorEntry[];
  nonRunningEntries: HomeMonitorEntry[];
  auxiliaryDataState: HomeMonitorAuxiliaryDataState;
  feedback?: string;
  onOpenSession: (sessionId: string, auxiliarySessionId?: string) => void;
  onShowContextMenu: (
    kind: SessionMonitorEntryKind,
    sessionId: string,
    point: SessionMonitorContextMenuPoint,
  ) => void;
};

export function buildHomeMonitorContentProps({
  runningEntries,
  nonRunningEntries,
  auxiliaryDataState,
  feedback,
  onOpenSession,
  onShowContextMenu,
}: HomeMonitorContentInput): HomeMonitorContentProps {
  return {
    runningEntries,
    nonRunningEntries,
    auxiliaryDataState,
    feedback,
    onOpenSession,
    onShowContextMenu,
  };
}
