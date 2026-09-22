import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_DRAFT_FLUSH_TIMEOUT_MS,
  DEFAULT_QUIT_DRAFT_FLUSH_TIMEOUT_MS,
  DraftFlushCoordinator,
} from "../../src-electron/platform/draft-flush-coordinator.js";
import { DEFAULT_PROVIDER_CANCEL_GRACE_MS } from "../../src-electron/session/session-run-timeouts.js";

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
