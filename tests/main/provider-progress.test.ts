import assert from "node:assert/strict";
import { it } from "node:test";
import { ProviderProgressDelivery } from "../../src-electron/providers/provider-progress.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";

const noChanges = { steps: { upserts: [], removes: [] }, backgroundTasks: { upserts: [], removes: [] } };
const state: LiveSessionRunState = {
  sessionId: "session", threadId: "thread", assistantText: "text", steps: [], backgroundTasks: [], usage: null,
  errorMessage: "", approvalRequest: null, elicitationRequest: null,
};

// @test-value v2
// kind = "contract"
// claim = "event-emitter progressは64件まで受付し、超過を明示失敗にしてdrain後に容量を解放する"
// oracle = { type = "contract", ref = "docs/design/audit-log.md" }
// fault = "未完了callbackを64件超えて受け付けるか、完了後も容量を返却しない"
// observable = "callback実行件数、超過のrejectとfailure通知、drain後の次callback"
// observation_boundary = "component-behavior"
// scope = "ProviderProgressDelivery capacity accounting"
// lifecycle = "permanent"
// impact = "SDKが同期burstを送った際の無制限保持と誤った過負荷判定を防ぐ"
// distinction = "adapter cleanup testは上限到達時の停止を確認するが容量解放の会計までは確認しない"
// @end-test-value
it("event-emitter callback容量は有界でdrain後に解放される", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const failures: unknown[] = [];
  const delivery = new ProviderProgressDelivery(() => { calls += 1; return gate; }, (error) => failures.push(error));
  const admitted = Array.from({ length: 64 }, () => delivery.deliver(state, noChanges));
  try {
    await assert.rejects(delivery.deliver(state, noChanges), /capacity exceeded/);
    assert.equal(calls, 64);
    assert.equal(failures.length, 1);
  } finally { release(); }
  await Promise.all(admitted);
  await delivery.deliver(state, noChanges);
  assert.equal(calls, 65);
});

// @test-value v2
// kind = "contract"
// claim = "単一progress payloadも8 MiBの保守的proxy上限を超えればcallbackを開始せず明示拒否する"
// oracle = { type = "contract", ref = "docs/design/audit-log.md" }
// fault = "件数だけを制限して巨大な単一payloadを受け付ける"
// observable = "巨大payloadのreject、failure通知、consumer callback未開始"
// observation_boundary = "component-behavior"
// scope = "ProviderProgressDelivery payload capacity"
// lifecycle = "permanent"
// impact = "operation detailが一度に増えた際にも未完了callback保持を有限にする"
// distinction = "64件の小さいpayloadや型検査では単一巨大payloadの容量検査を代替できない"
// @end-test-value
it("単一巨大progressもcallback開始前に拒否する", async () => {
  let calls = 0;
  const failures: unknown[] = [];
  const delivery = new ProviderProgressDelivery(() => { calls += 1; }, (error) => failures.push(error));
  await assert.rejects(delivery.deliver(state, {
    ...noChanges,
    steps: { upserts: [{ id: "giant", type: "command", summary: "command", status: "in_progress", details: "x".repeat(4 * 1024 * 1024) }], removes: [] },
  }), /capacity exceeded/);
  assert.equal(calls, 0);
  assert.equal(failures.length, 1);
});
