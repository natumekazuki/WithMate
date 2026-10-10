import assert from "node:assert/strict";
import test from "node:test";

import { AuxiliaryLiveRunParents } from "../../src-electron/auxiliary/auxiliary-live-run-parents.js";
import { SessionObservabilityService } from "../../src-electron/session/session-observability-service.js";
import { WindowBroadcastService } from "../../src-electron/windows/window-broadcast-service.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";

function auxiliary(id: string, parentSessionId = "parent-a", status: AuxiliarySession["status"] = "active") {
  return { id, parentSessionId, status };
}

function live(sessionId: string, overrides: Partial<LiveSessionRunState> = {}): LiveSessionRunState {
  return {
    sessionId, threadId: "thread", runState: "running", assistantText: "body",
    steps: [], backgroundTasks: [], usage: null, errorMessage: "",
    approvalRequest: null, elicitationRequest: null, ...overrides,
  };
}

function fixture() {
  let owner: object | null = {};
  const admission = new Set<string>();
  const inFlight = new Set<string>();
  const sent: Array<{ windowId: string; channel: string; payload: unknown }> = [];
  const windows = new Map(["home", "monitor", "parent-a", "parent-b", "unrelated"].map((windowId) => [windowId, {
    isDestroyed: () => false,
    webContents: { send: (channel: string, payload: unknown) => { sent.push({ windowId, channel, payload }); } },
  }]));
  const getWindow = (id: string) => windows.get(id)!;
  const broadcaster = new WindowBroadcastService({
    getAllWindows: () => [...windows.values()],
    getHomeWindows: () => [getWindow("home")],
    getPrimaryHomeWindow: () => getWindow("home"),
    getSessionWindows: () => [getWindow("parent-a"), getWindow("parent-b"), getWindow("unrelated")],
    getLiveSessionRunStatusWindows: () => [getWindow("home"), getWindow("monitor")],
    getLiveSessionRunWindow: (id) => {
      const parent = parents.get(id);
      return parent ? windows.get(parent) ?? null : null;
    },
  });
  const parents = new AuxiliaryLiveRunParents({
    getStorageOwner: () => owner,
    isRunPending: (id) => admission.has(id) || inFlight.has(id),
    hasLiveSessionRun: (id) => Boolean(observability.getLiveSessionRun(id)),
    broadcastLiveSessionRun: (id, state) => broadcaster.broadcastLiveSessionRun(id, state),
  });
  const createObservability = () => {
    const capturedOwner = owner;
    return new SessionObservabilityService({
      onProviderQuotaTelemetryChanged: () => {},
      onSessionContextTelemetryChanged: () => {},
      onSessionBackgroundActivityChanged: () => {},
      onLiveSessionRunChanged: (id, state) => parents.publish(id, state, capturedOwner),
    });
  };
  let observability = createObservability();
  return {
    admission, inFlight, parents, sent,
    get owner() { return owner!; },
    get observability() { return observability; },
    replaceOwner: () => {
      observability.dispose();
      parents.clear();
      admission.clear();
      inFlight.clear();
      owner = {};
      observability = createObservability();
    },
    details: () => sent.filter((entry) => entry.channel === "withmate:live-session-run"),
  };
}

// @test-value v2
// kind = "contract"
// claim = "Auxiliaryの取消終了待ちとretained liveを親Windowへ配送し、最後のnullを届けてから親関連を解除する"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#live-run-delivery" }
// fault = "run呼出し収束で親関連を失う、保持live中に解除する、または終端nullの前に解除する"
// observable = "親Windowが実WindowBroadcastServiceから受け取る詳細payload列、Home/Monitorのstatus列、残存親関連数"
// observation_boundary = "public-boundary"
// scope = "auxiliary-live-owner-retention-and-terminal-routing"
// lifecycle = "permanent"
// impact = "取消終了待ちや保持liveとその解除が表示へ届かず、Windowに古い状態が残る"
// distinction = "既存routing単独testに対し実observability更新と親関連lifecycleを結合し、Promise収束後の宛先継続を確認する"
// @end-test-value
test("取消graceと保持liveの配送後に終端nullで親関連を解除する", () => {
  const f = fixture();
  const id = "aux-cancel";
  f.admission.add(id);
  f.inFlight.add(id);
  f.parents.remember(auxiliary(id), f.owner);
  const running = live(id);
  f.observability.setLiveSessionRun(id, running);
  const requested = live(id, { cancellationState: "requested" });
  f.observability.setLiveSessionRun(id, requested);
  f.admission.delete(id);
  f.parents.releaseIfUnused(id, f.owner);
  const terminating = live(id, { runState: "idle", cancellationState: "terminating" });
  f.observability.setLiveSessionRun(id, terminating);
  assert.equal(f.parents.get(id), "parent-a");
  // A null while real termination is still pending must not drop its route.
  f.observability.setLiveSessionRun(id, null);
  assert.equal(f.parents.get(id), "parent-a");
  const retained = live(id, { runState: "idle", reasoningText: "retained reasoning" });
  f.inFlight.delete(id);
  f.observability.setLiveSessionRun(id, retained);
  f.parents.releaseIfUnused(id, f.owner);
  assert.equal(f.parents.get(id), "parent-a");
  const background = live(id, { runState: "idle", backgroundTasks: [
    { id: "task", kind: "agent", title: "background", status: "running", updatedAt: "2026-10-10T00:00:00.000Z" },
  ] });
  f.observability.setLiveSessionRun(id, background);
  assert.equal(f.parents.size, 1);
  f.observability.setLiveSessionRun(id, null);
  assert.equal(f.parents.size, 0);
  assert.deepEqual(f.details(), [running, requested, terminating, null, retained, background, null].map((state) => ({
    windowId: "parent-a", channel: "withmate:live-session-run", payload: { sessionId: id, state },
  })));
  for (const windowId of ["home", "monitor"]) {
    assert.deepEqual(f.sent.filter((entry) => entry.windowId === windowId).map((entry) => entry.payload), [
      { sessionId: id, status: { runState: "running", cancellationState: undefined } },
      { sessionId: id, status: { runState: "running", cancellationState: "requested" } },
      { sessionId: id, status: { runState: "idle", cancellationState: "terminating" } },
      { sessionId: id, status: null },
      { sessionId: id, status: { runState: "idle", cancellationState: undefined } },
      { sessionId: id, status: { runState: "idle", cancellationState: undefined } },
      { sessionId: id, status: null },
    ]);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "完了または受付失敗したAuxiliaryの親関連は蓄積せず、遅い会話読込みでも再登録されない"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#live-run-delivery" }
// fault = "admission終了時の不要entryを残すか、実行していない会話読込みで親関連を復活させる"
// observable = "反復完了後の親関連数と、各親Windowの終端null payload"
// observation_boundary = "public-boundary"
// scope = "auxiliary-live-owner-completion-release"
// lifecycle = "permanent"
// impact = "完了会話数に比例してvolatile配送metadataが増加する"
// distinction = "取消・保持liveの継続とは別にadmissionが終端nullより遅く解除される通常完了と受付失敗を小さい反復fixtureで確認する"
// @end-test-value
test("完了と受付失敗を繰り返しても不要な親関連を残さない", () => {
  const f = fixture();
  for (let i = 0; i < 40; i += 1) {
    const row = auxiliary(`aux-${i}`, i % 2 === 0 ? "parent-a" : "parent-b");
    f.admission.add(row.id);
    f.parents.remember(row, f.owner);
    f.observability.setLiveSessionRun(row.id, live(row.id));
    f.observability.setLiveSessionRun(row.id, null);
    assert.equal(f.parents.size, 1);
    f.admission.delete(row.id);
    f.parents.releaseIfUnused(row.id, f.owner);
    f.parents.remember(row, f.owner);
    assert.equal(f.parents.size, 0);
    const rejected = auxiliary(`rejected-${i}`);
    f.admission.add(rejected.id);
    f.parents.remember(rejected, f.owner);
    f.admission.delete(rejected.id);
    f.parents.releaseIfUnused(rejected.id, f.owner);
    assert.equal(f.parents.size, 0);
  }
  assert.deepEqual(f.details().filter((entry) => (entry.payload as { state: unknown }).state === null),
    Array.from({ length: 40 }, (_, i) => ({
      windowId: i % 2 === 0 ? "parent-a" : "parent-b", channel: "withmate:live-session-run",
      payload: { sessionId: `aux-${i}`, state: null },
    })));
});

// @test-value v2
// kind = "contract"
// claim = "closeまたは削除で保持liveの親関連を解除し、closed会話や遅いactive読込みを再登録しない"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#live-run-delivery" }
// fault = "close/削除後の保持liveを根拠に親関連を復活させ、不要entryまたは詳細宛先を残す"
// observable = "親関連数とclose/削除後にWindowBroadcastServiceが送る詳細通知数"
// observation_boundary = "public-boundary"
// scope = "auxiliary-live-owner-close-delete-release"
// lifecycle = "permanent"
// impact = "破棄済み会話のrouting metadataが残り、遅い状態が旧親Windowに配信される"
// distinction = "通常完了では解除できない保持liveありの明示teardownと同generationの遅い読込みを確認する"
// @end-test-value
test("保持live付き会話のcloseと削除で親関連を解除する", () => {
  const f = fixture();
  for (let i = 0; i < 40; i += 1) {
    const row = auxiliary(`closed-or-deleted-${i}`);
    f.admission.add(row.id);
    f.parents.remember(row, f.owner);
    f.observability.setLiveSessionRun(row.id, live(row.id, { runState: "idle", reasoningText: "retained" }));
    f.admission.delete(row.id);
    f.parents.releaseIfUnused(row.id, f.owner);
    assert.equal(f.parents.size, 1);
    f.parents.delete(row.id, f.owner);
    f.parents.remember(auxiliary(row.id, row.parentSessionId, "closed"), f.owner);
    f.parents.remember(row, f.owner);
    assert.equal(f.parents.size, 0);
    const detailsBefore = f.details().length;
    f.observability.setLiveSessionRun(row.id, null);
    assert.equal(f.details().length, detailsBefore);
  }
  // Closed rows must also be rejected even if a new admission has been reserved.
  f.admission.add("closed");
  f.parents.remember(auxiliary("closed", "parent-a", "closed"), f.owner);
  assert.equal(f.parents.size, 0);
});

// @test-value v2
// kind = "contract"
// claim = "旧storage ownerの遅い登録・通知・解除は同じAuxiliary IDを持つ新ownerの配送に影響しない"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#live-run-delivery" }
// fault = "旧ownerのparentで新entryを上書きする、旧通知を新Windowへ送る、または旧finallyで新entryを解除する"
// observable = "owner交換後の親Window/Home/Monitor受信列と新ownerの親関連"
// observation_boundary = "public-boundary"
// scope = "auxiliary-live-owner-generation-isolation"
// lifecycle = "permanent"
// risk_tags = ["privacy"]
// impact = "旧会話の本文が新しいstorage ownerのWindowへ誤配送される"
// distinction = "owner lookup失敗testではなく同一会話IDの再利用中に遅い旧observability callbackと解除を実配送へ通す"
// @end-test-value
test("旧generationの処理は新ownerの親関連と配送先を変更しない", () => {
  const f = fixture();
  const id = "same-aux-id";
  const oldOwner = f.owner;
  const oldObservability = f.observability;
  f.admission.add(id);
  f.parents.remember(auxiliary(id), oldOwner);
  f.replaceOwner();
  assert.equal(f.parents.size, 0);
  f.admission.add(id);
  f.parents.remember(auxiliary(id, "parent-b"), f.owner);
  const current = live(id, { assistantText: "new owner's body" });
  f.observability.setLiveSessionRun(id, current);
  const sentBefore = [...f.sent];
  f.parents.remember(auxiliary(id, "parent-a"), oldOwner);
  oldObservability.setLiveSessionRun(id, live(id, { assistantText: "old owner's body" }));
  oldObservability.setLiveSessionRun(id, null);
  f.parents.delete(id, oldOwner);
  f.parents.releaseIfUnused(id, oldOwner);
  assert.deepEqual(f.sent, sentBefore);
  assert.equal(f.parents.get(id), "parent-b");
  f.admission.delete(id);
  f.parents.releaseIfUnused(id, f.owner);
  assert.equal(f.parents.size, 1);
  f.observability.setLiveSessionRun(id, null);
  assert.equal(f.parents.size, 0);
  assert.deepEqual(f.details(), [current, null].map((state) => ({
    windowId: "parent-b", channel: "withmate:live-session-run", payload: { sessionId: id, state },
  })));
});
