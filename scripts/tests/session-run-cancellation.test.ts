import assert from "node:assert/strict";
import { test } from "node:test";

import { cancelSessionRun } from "../../src-electron/session-run-cancellation.js";

test("CANCEL-OWNER-08: GUI cancelもactive external executionの取消印を共通ownerで記録する", () => {
  const events: string[] = [];

  cancelSessionRun({
    getActiveExecutionId: () => "execution-1",
    markExecutionCanceled: (executionId) => events.push(`mark:${executionId}`),
    cancelRuntimeRun: (sessionId) => events.push(`cancel:${sessionId}`),
  }, "session-1");

  assert.deepEqual(events, ["mark:execution-1", "cancel:session-1"]);
});

test("CANCEL-OWNER-08: execution指定cancelは別executionのprovider runへ到達しない", () => {
  const events: string[] = [];

  assert.throws(() => cancelSessionRun({
    getActiveExecutionId: () => "execution-2",
    markExecutionCanceled: (executionId) => events.push(`mark:${executionId}`),
    cancelRuntimeRun: (sessionId) => events.push(`cancel:${sessionId}`),
  }, "session-1", "execution-1"));

  assert.deepEqual(events, []);
});
