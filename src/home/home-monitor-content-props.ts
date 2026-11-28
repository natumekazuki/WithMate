import type { ReactNode } from "react";
import type { HomeMonitorContentProps } from "./HomeMonitorContent.js";
import type {
  HomeMonitorAuxiliaryDataState,
  HomeMonitorEntry,
} from "./home-session-projection.js";
import type {
  SessionMonitorContextMenuPoint,
  SessionMonitorEntryKind,
} from "../../src-shared/window/withmate-window-types.js";

/** 承認待ち・実行中・その他の項目と、それぞれの取得状態や操作を Monitor へ渡す。 */
export type HomeMonitorContentInput = {
  approvalEntries: HomeMonitorEntry[];
  providerQuota?: ReactNode;
  runningEntries: HomeMonitorEntry[];
  nonRunningEntries: HomeMonitorEntry[];
  auxiliaryDataState: HomeMonitorAuxiliaryDataState;
  auxiliaryRefreshing?: boolean;
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

/** Home と独立 Monitor が同じ表示契約を使えるよう、投影と操作をコンテンツの引数にそろえる。 */
export function buildHomeMonitorContentProps({
  approvalEntries,
  providerQuota,
  runningEntries,
  nonRunningEntries,
  auxiliaryDataState,
  auxiliaryRefreshing,
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
    auxiliaryRefreshing,
    sessionWindowsDataState,
    runningEmptyMessage,
    nonRunningEmptyMessage,
    feedback,
    onRetry,
    onOpenSession,
    onShowContextMenu,
  };
}
