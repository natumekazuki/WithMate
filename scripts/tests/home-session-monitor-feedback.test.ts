import assert from "node:assert/strict";
import test from "node:test";

import type { SessionMonitorContextMenuResult } from "../../src/withmate-window-types.js";
import { runSessionMonitorContextMenu } from "../../src/home/home-session-monitor-feedback.js";

// @test-value v2
// kind = "contract"
// claim = "Session Monitor context menuのAPI resultをfeedback setterへ渡し、failedだけmessageを表示し、closed/copied/dismissedは空にする"
// oracle = { type = "contract", ref = "Home Session Monitor context menu feedback" }
// fault = "HomeAppのcontext menu API resultがstate setterへ届かずfailed messageが消える、または成功・取消が失敗表示として残る"
// observable = "context menu API resultごとのfeedback setter呼出し履歴"
// observation_boundary = "implementation"
// scope = "runSessionMonitorContextMenu API-to-feedback boundary"
// lifecycle = "permanent"
// impact = "HomeAppがnative context menuの失敗をMonitor UIへ返す"
// distinction = "native menu serviceの失敗発生やMonitor contentのDOM描画ではなく、API resultからHomeApp state setterまでのdeliveryを検証する"
// @end-test-value
test("Session Monitor context menu API resultをfeedback setterへ届ける", async () => {
  const request = { kind: "companion" as const, sessionId: "companion-1", point: { x: 24, y: 48 } };
  const cases: Array<{ result: SessionMonitorContextMenuResult; expectedFeedback: string }> = [
    { result: { status: "closed" }, expectedFeedback: "" },
    { result: { status: "copied" }, expectedFeedback: "" },
    { result: { status: "dismissed" }, expectedFeedback: "" },
    {
      result: { status: "failed", message: "Session IDをコピーできませんでした。" },
      expectedFeedback: "Session IDをコピーできませんでした。",
    },
  ];

  for (const { result, expectedFeedback } of cases) {
    const feedbackUpdates: string[] = [];
    runSessionMonitorContextMenu(
      { showSessionMonitorContextMenu: async () => result },
      request,
      (feedback) => feedbackUpdates.push(feedback),
    );
    await Promise.resolve();
    assert.deepEqual(feedbackUpdates, ["", expectedFeedback]);
  }
});
