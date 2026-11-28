import type {
  SnapshotCaptureStats,
  WorkspaceSnapshot,
} from "../platform/snapshot-ignore.js";

/** 永続設定を増やさず、ファイル Diff 生成のための workspace 読み取りを一時停止する。 */
export const WORKSPACE_DIFF_CAPTURE_ENABLED = false;

/** キャプチャを省略したときに使う空のスナップショットと、すべて未計上の統計を返す。 */
export function createDisabledWorkspaceSnapshotCapture(): {
  snapshot: WorkspaceSnapshot;
  stats: SnapshotCaptureStats;
} {
  return {
    snapshot: new Map(),
    stats: {
      capturedFiles: 0,
      capturedBytes: 0,
      skippedBinaryOrOversizeFiles: 0,
      skippedByLimitFiles: 0,
      hitFileCountLimit: false,
      hitTotalBytesLimit: false,
    },
  };
}
