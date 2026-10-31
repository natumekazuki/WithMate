import assert from "node:assert/strict";
import { it } from "node:test";
import { ProviderProgressDelivery, ProviderProgressMap } from "../../src-electron/providers/provider-progress.js";
import { createProviderAgentRuntimeBindingRedactor } from "../../src-electron/providers/provider-agent-runtime-binding.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";

const noChanges = { steps: { upserts: [], removes: [] }, backgroundTasks: { upserts: [], removes: [] } };
const state: LiveSessionRunState = {
  sessionId: "session", threadId: "thread", assistantText: "text", steps: [], backgroundTasks: [], usage: null,
  errorMessage: "", approvalRequest: null, elicitationRequest: null,
};

// @test-value v2
// kind = "security"
// claim = "変更stepだけの配送は全snapshotを作らずredactor交換時には残存stepのsecret集合を再処理する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Codex projection owner" }
// fault = "secret集合が変わっても旧sanitized cacheを返し追加secretを漏らす"
// observable = "変更配送のsnapshotとupserts、redactor交換後のsnapshot文字列"
// observation_boundary = "component-behavior"
// scope = "ProviderProgressMap sanitized projection cache"
// lifecycle = "permanent"
// risk_tags = ["privacy"]
// impact = "bindingやcredentialの追加・交換後に旧projectionから秘密を露出させない"
// distinction = "単発redactor testは同じmapに残ったstepのcache無効化を通らない"
// @end-test-value
it("変更配送とsecret集合変更の再projectionを分離する", () => {
  const steps = new ProviderProgressMap<{ id: string; text: string }>();
  steps.set("one", { id: "one", text: "old-secret new-secret" });
  const first = createProviderAgentRuntimeBindingRedactor(null, ["old-secret"]);
  const patch = steps.takeProgress(first, false);
  assert.deepEqual(patch.snapshot, []);
  assert.equal(patch.changes.upserts.length, 1);
  assert.equal(steps.takeProgress(first, false).changes.upserts.length, 0);
  const second = createProviderAgentRuntimeBindingRedactor(null, ["old-secret", "new-secret"]);
  const rebuilt = steps.takeProgress(second);
  assert.equal(rebuilt.changes.upserts.length, 1);
  assert.ok(!JSON.stringify(rebuilt.snapshot).includes("secret"));
});

// @test-value v2
// kind = "contract"
// claim = "集中するprogressを件数だけで拒否せず全callbackの実完了を返す"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#streaming-policy" }
// fault = "未完了callback件数を理由に必要な更新を拒否するかhandlerより先に完了する"
// observable = "callback実行件数、gate前後の完了件数とfailure通知"
// observation_boundary = "component-behavior"
// scope = "ProviderProgressDelivery burst completion"
// lifecycle = "permanent"
// impact = "SDKの正常burstで進捗を失いturnが中断することを防ぐ"
// distinction = "単一callbackと型検査では未完了burstと実完了の対応を観測できない;通信なしの小さい固定burstで確認する"
// @end-test-value
it("event-emitter burstは全callbackの実完了を返す", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const failures: unknown[] = [];
  const delivery = new ProviderProgressDelivery(() => { calls += 1; return gate; }, (error) => failures.push(error));
  let completed = 0;
  const admitted = Array.from({ length: 100 }, () => delivery.deliver(state, noChanges).then(() => { completed++; }));
  for (const operation of admitted) void operation.catch(() => undefined);
  try {
    await Promise.resolve();
    assert.equal(calls, 100);
    assert.equal(completed, 0);
    assert.equal(failures.length, 0);
  } finally { release(); }
  await Promise.all(admitted);
  await delivery.deliver(state, noChanges);
  assert.equal(calls, 101);
  assert.equal(completed, 100);
});

// @test-value v2
// kind = "contract"
// claim = "大きいprogressもhandlerへ全量配送し、同期throwと非同期rejectは元の失敗として通知する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#streaming-policy" }
// fault = "payload量だけでhandler前に拒否するか、handlerの失敗を握りつぶす"
// observable = "consumerが受け取るdetail、deliverのreject、failure通知"
// observation_boundary = "component-behavior"
// scope = "ProviderProgressDelivery payload and handler failure"
// lifecycle = "permanent"
// impact = "必要なツール結果を欠落させず保存などの実失敗を成功にしない"
// distinction = "小さいburstでは大きいdetailと同期/非同期handler失敗を検査できない;固定文字列と直接注入で確認する"
// @end-test-value
it("大きいprogressを配送しhandlerの実失敗を通知する", async () => {
  const detail = "x".repeat(4 * 1024 * 1024);
  let received: string | undefined;
  const failures: unknown[] = [];
  const delivery = new ProviderProgressDelivery((_state, changes) => { received = changes.steps.upserts[0].details; }, (error) => failures.push(error));
  await delivery.deliver(state, {
    ...noChanges,
    steps: { upserts: [{ id: "giant", type: "command", summary: "command", status: "in_progress", details: detail }], removes: [] },
  });
  assert.equal(received, detail);
  assert.equal(failures.length, 0);
  for (const synchronous of [false, true]) {
    const error = new Error("handler failed");
    const failing = new ProviderProgressDelivery(() => { if (synchronous) throw error; return Promise.reject(error); }, failure => failures.push(failure));
    await assert.rejects(failing.deliver(state, noChanges), failure => failure === error);
    assert.equal(failures.at(-1), error);
  }
});
