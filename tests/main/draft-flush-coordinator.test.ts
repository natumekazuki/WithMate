import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_DRAFT_FLUSH_TIMEOUT_MS,
  DEFAULT_QUIT_DRAFT_FLUSH_TIMEOUT_MS,
  DraftFlushCoordinator,
  type DraftFlushResult,
} from "../../src-electron/platform/draft-flush-coordinator.js";
import { DEFAULT_PROVIDER_CANCEL_GRACE_MS } from "../../src-electron/session/session-run-timeouts.js";

// @test-value v2
// kind = "invariant"
// claim = "draft flushは成功ACKだけをtrueで確定し、負ACK・timeout・送信例外・Window消滅・Renderer死亡は各分類のfalseとして一度だけ通知する"
// oracle = { type = "contract", ref = "src-electron/platform/draft-flush-coordinator.ts#DraftFlushOutcome" }
// fault = "未保存終了をtrueにする、失敗分類を失う、または遅延ACKで完了通知を二重発行する"
// observable = "request結果、settled通知のreason/outcome/elapsedMs、遅延ACK受理"
// observation_boundary = "public-boundary"
// scope = "draft-flush-result-classification"
// lifecycle = "permanent"
// impact = "未保存入力を保存済みと誤認し、Renderer障害を区別できない"
// distinction = "sender整合とtimeout期限の既存testでは扱わない終了経路全体の保存成否分類を検証する"
// @end-test-value
test("DraftFlushCoordinatorは保存成否と終了理由を一度だけ分類する", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (const outcome of ["saved", "rejected", "timeout", "send-failed", "window-closed", "renderer-gone"] as const) {
    const settled: DraftFlushResult[] = [];
    let requestId = "";
    const window = {};
    const coordinator = new DraftFlushCoordinator((_, request) => {
      requestId = request.requestId;
      if (outcome === "send-failed") throw new Error("send failed");
    }, 100, (result) => { settled.push(result); });
    const result = coordinator.request(window, "session", "sender", "close");
    if (outcome === "timeout") t.mock.timers.tick(100);
    else if (outcome === "window-closed" || outcome === "renderer-gone") coordinator.forgetWindow(window, outcome);
    else if (outcome !== "send-failed") coordinator.acknowledge(requestId, "sender", outcome === "saved");
    assert.equal(await result, outcome === "saved");
    assert.deepEqual(settled, [{ reason: "close", outcome, elapsedMs: outcome === "timeout" ? 100 : 0 }]);
    assert.equal(coordinator.acknowledge(requestId, "sender", true), false);
    assert.equal(settled.length, 1);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "flush要求はclose目的を送出し、ackは同じrenderer senderの対応requestだけを成功として確定する"
// oracle = { type = "contract", ref = "src-electron/draft-flush-coordinator.ts#acknowledge" }
// fault = "別rendererまたは存在しないrequestのackで終了処理を成功扱いする"
// observable = "送出requestのreason、acknowledgeの戻り値とrequest Promiseの結果"
// observation_boundary = "public-boundary"
// scope = "draft-flush-transport"
// lifecycle = "permanent"
// @end-test-value
test("DraftFlushCoordinatorはsender不一致のackを無視する", async () => {
  let request: { requestId: string } | undefined;
  const coordinator = new DraftFlushCoordinator((_, payload) => { request = payload; }, 100);
  const result = coordinator.request({}, "session", "sender-a", "close");
  assert.equal((request as { reason?: string } | undefined)?.reason, "close");
  assert.equal(coordinator.acknowledge("unknown", "sender-a", true), false);
  assert.equal(coordinator.acknowledge(request!.requestId, "sender-b", true), false);
  assert.equal(coordinator.acknowledge(request!.requestId, "sender-a", true), true);
  assert.equal(await result, true);
});

// @test-value v2
// kind = "invariant"
// claim = "quitのflushはcancel猶予後の保存時間を確保し、closeもquitも応答欠落は有限時間で失敗する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence" }
// fault = "cancel猶予の満了時点でquitを中止するか、応答欠落で終了処理が永遠にpendingする"
// observable = "close期限後のquit未完了、猶予後のACK成功、各timeout後のrequest Promiseのfalse"
// observation_boundary = "public-boundary"
// scope = "draft-flush-transport"
// lifecycle = "permanent"
// @end-test-value
test("DraftFlushCoordinatorはquitのcancel猶予を確保しack欠落をfalseで終端する", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requestId = "";
  const coordinator = new DraftFlushCoordinator((_, payload) => { requestId = payload.requestId; });
  const close = coordinator.request({}, "session", "sender", "close");
  let quitSettled = false;
  const quit = coordinator.request({}, "session", "sender", "quit").then((result) => {
    quitSettled = true;
    return result;
  });
  t.mock.timers.tick(DEFAULT_DRAFT_FLUSH_TIMEOUT_MS);
  assert.equal(await close, false);
  assert.equal(quitSettled, false);
  assert.ok(DEFAULT_QUIT_DRAFT_FLUSH_TIMEOUT_MS > DEFAULT_PROVIDER_CANCEL_GRACE_MS);
  assert.equal(coordinator.acknowledge(requestId, "sender", true), true);
  assert.equal(await quit, true);

  const unacknowledgedQuit = coordinator.request({}, "session", "sender", "quit");
  t.mock.timers.tick(DEFAULT_QUIT_DRAFT_FLUSH_TIMEOUT_MS);
  assert.equal(await unacknowledgedQuit, false);
});
