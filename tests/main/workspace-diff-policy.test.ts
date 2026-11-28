import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDisabledWorkspaceSnapshotCapture,
  WORKSPACE_DIFF_CAPTURE_ENABLED,
} from "../../src-electron/files/workspace-diff-policy.js";

/** Workspace 差分取得を無効にしている間の戻り値を確認する。 */
describe("workspace diff policy", () => {
  /** 差分取得が停止中はファイルを収集したり上限に達したりしたと報告せず、空のスナップショットとゼロの統計を返す。 */
  it("workspace snapshot capture を一時的に無効化する", () => {
    assert.equal(WORKSPACE_DIFF_CAPTURE_ENABLED, false);

    const result = createDisabledWorkspaceSnapshotCapture();

    assert.equal(result.snapshot.size, 0);
    assert.deepEqual(result.stats, {
      capturedFiles: 0,
      capturedBytes: 0,
      skippedBinaryOrOversizeFiles: 0,
      skippedByLimitFiles: 0,
      hitFileCountLimit: false,
      hitTotalBytesLimit: false,
    });
  });
});
