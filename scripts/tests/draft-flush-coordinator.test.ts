import assert from "node:assert/strict";
import { test } from "node:test";

import { DraftFlushCoordinator } from "../../src-electron/draft-flush-coordinator.js";

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
// claim = "flush応答がない場合は成功扱いせず有限時間で失敗する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence" }
// fault = "renderer死亡や応答欠落で終了処理が永遠にpendingする"
// observable = "timeout後のrequest Promiseの結果"
// observation_boundary = "public-boundary"
// scope = "draft-flush-transport"
// lifecycle = "permanent"
// @end-test-value
test("DraftFlushCoordinatorはack欠落をfalseで終端する", { timeout: 1000 }, async () => {
  const coordinator = new DraftFlushCoordinator(() => {}, 5);
  assert.equal(await coordinator.request({}, "session", "sender", "quit"), false);
});
