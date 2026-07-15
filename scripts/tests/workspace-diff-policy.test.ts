import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDisabledWorkspaceSnapshotCapture,
  WORKSPACE_DIFF_CAPTURE_ENABLED,
} from "../../src-electron/workspace-diff-policy.js";

describe("workspace diff policy", () => {
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
