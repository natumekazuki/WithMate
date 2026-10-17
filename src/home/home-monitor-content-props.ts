import type { ReactNode } from "react";
import type { HomeMonitorContentProps } from "./HomeMonitorContent.js";
import type { HomeMonitorAuxiliaryDataState, HomeMonitorEntry } from "./home-session-projection.js";
import type {
  SessionMonitorContextMenuPoint,
  SessionMonitorEntryKind,
} from "../../src-shared/window/withmate-window-types.js";

export type HomeMonitorContentInput = {
  approvalEntries: HomeMonitorEntry[];
  providerQuota?: ReactNode;
  runningEntries: HomeMonitorEntry[];
  nonRunningEntries: HomeMonitorEntry[];
  auxiliaryDataState: HomeMonitorAuxiliaryDataState;
  sessionWindowsDataState?: "loading" | "loaded" | "error";
  runningEmptyMessage?: string;
  nonRunningEmptyMessage?: string;
  feedback?: string;
  onRetry?: () => void;
  onOpenSession: (sessionId: string, auxiliarySessionId?: string) => void;
  onShowContextMenu: (
    kind: SessionMonitorEntryKind,
    sessionId: string,
    point: SessionMonitorContextMenuPoint,
  ) => void;
};

export function buildHomeMonitorContentProps({
  approvalEntries,
  providerQuota,
  runningEntries,
  nonRunningEntries,
  auxiliaryDataState,
  sessionWindowsDataState,
  runningEmptyMessage,
  nonRunningEmptyMessage,
  feedback,
  onRetry,
  onOpenSession,
  onShowContextMenu,
}: HomeMonitorContentInput): HomeMonitorContentProps {
  return {
    approvalEntries,
    providerQuota,
    runningEntries,
    nonRunningEntries,
    auxiliaryDataState,
    sessionWindowsDataState,
    runningEmptyMessage,
    nonRunningEmptyMessage,
    feedback,
    onRetry,
    onOpenSession,
    onShowContextMenu,
  };
}
