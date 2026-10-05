import assert from "node:assert/strict";
import test from "node:test";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import { subscribeSessionLiveEvents, subscribeSessionLiveSelection, subscribeSessionRunControls, updateSessionLiveState, type SessionLiveIngressApi } from "../../src/chat/runtime/session-window-live-ingress.js";

function fixture() {
  let listener: Parameters<SessionLiveIngressApi["subscribeLiveSessionRun"]>[0] = () => {};
  const gets: Array<{ id: string; resolve: (state: LiveSessionRunState | null) => void }> = [];
  let subscriptions = 0;
  let disposals = 0;
  const api: SessionLiveIngressApi = {
    subscribeLiveSessionRun: (next) => { listener = next; ++subscriptions; return () => { ++disposals; }; },
    getLiveSessionRun: (id) => new Promise((resolve) => { gets.push({ id, resolve }); }),
  };
  return { api, gets, emit: (id: string, state: LiveSessionRunState | null) => listener(id, state),
    get subscriptions() { return subscriptions; }, get disposals() { return disposals; } };
}
const live = (sessionId: string, assistantText = "body"): LiveSessionRunState => ({
  sessionId, threadId: "thread", runState: "running", assistantText, steps: [], backgroundTasks: [],
  usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null,
});
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

// @test-value v2
// kind = "contract"
// claim = "同じWindowの複数live consumerは1本の公開API callbackとownerごと1回の初回取得を共有し、各会話に同じ最新snapshotを配送する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: メッセージの投影とWindow内live受信" }
// fault = "consumer追加でfull payloadの境界コピーが増える、初回IPCを重複する、または別ownerの本文を混入する"
// observable = "公開APIの登録・解除回数、get対象ID列、consumerへ届いたsnapshot参照とowner"
// observation_boundary = "public-boundary"
// scope = "SessionWindow live ingress sharing"
// lifecycle = "permanent"
// impact = "長い応答のconsumer数比例コピーと会話取り違えを防ぐ"
// distinction = "型検査や個別Column testでは複数consumer間の公開API呼出数を保証できない。少数のdeferredで計測し壁時計閾値を使わない"
// @end-test-value
test("Window liveはcallbackとinitial getを共有しownerを分離する", async () => {
  const f = fixture();
  const main: Array<LiveSessionRunState | null> = [];
  const audit: Array<LiveSessionRunState | null> = [];
  const auxiliary: Array<LiveSessionRunState | null> = [];
  const dispose = [
    subscribeSessionLiveEvents(f.api, () => {}),
    subscribeSessionLiveSelection({ api: f.api, sessionId: "main", select: (state) => state, onChange: (state) => main.push(state) }),
    subscribeSessionLiveSelection({ api: f.api, sessionId: "main", select: (state) => state, onChange: (state) => audit.push(state) }),
    subscribeSessionLiveSelection({ api: f.api, sessionId: "aux", select: (state) => state, onChange: (state) => auxiliary.push(state) }),
  ];
  assert.equal(f.subscriptions, 1);
  assert.deepEqual(f.gets.map((get) => get.id), ["main", "aux"]);
  const latest = live("main");
  f.emit("main", latest);
  f.gets[0]!.resolve(live("main", "stale"));
  f.gets[1]!.resolve(live("aux", "aux body"));
  await flush();
  assert.strictEqual(main.at(-1), latest);
  assert.strictEqual(audit.at(-1), latest);
  assert.equal(auxiliary.at(-1)?.assistantText, "aux body");
  dispose.forEach((release) => release());
  assert.equal(f.disposals, 1);
});

// @test-value v2
// kind = "contract"
// claim = "controlsは本文deltaで更新せず取消を最新に保ち、最後の表示consumerを閉じた後の再openはdetailを再取得する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: メッセージの投影とWindow内live受信; docs/design/desktop-ui.md: Mainの取消受付後" }
// fault = "controlsがfull本文を保持またはtokenごと更新する、取消を見失う、再openで古いdetailを表示する"
// observable = "controlsの通知列、再open時のget回数と取得した本文、action updaterの本文・steps・background保持内容"
// observation_boundary = "consumer"
// scope = "SessionWindow controls and detail lifetime"
// lifecycle = "permanent"
// impact = "非表示時の保持負荷と取消中の誤送信を防ぎ、最新の応答を再表示する"
// distinction = "型検査では通知の省略や保持寿命を確認できない。snapshotの取得・取消・再openを1つの短い操作列で検証する"
// @end-test-value
test("controlsは本文とdetail寿命から独立して取消解除を受け取る", async () => {
  const f = fixture();
  const controls: Array<Parameters<Parameters<typeof subscribeSessionRunControls>[0]["onChange"]>[0]> = [];
  const closeControls = subscribeSessionRunControls({ api: f.api, sessionId: "main", onChange: (value) => controls.push(value) });
  const closeDisplay = subscribeSessionLiveSelection({ api: f.api, sessionId: "main", select: (state) => state, onChange: () => {} });
  const withDetail = {
    ...live("main"),
    steps: [{ id: "step", type: "command_execution", summary: "command", details: "large operation detail", status: "in_progress" }],
    backgroundTasks: [{ id: "background", kind: "shell" as const, status: "running" as const, title: "shell", details: "large background detail", updatedAt: "now" }],
  };
  f.gets[0]!.resolve(withDetail);
  await flush();
  const count = controls.length;
  for (let i = 0; i < 100; ++i) f.emit("main", {
    ...withDetail, assistantText: `body ${i}`,
  });
  assert.equal(controls.length, count);
  const closeOtherControls = subscribeSessionRunControls({ api: f.api, sessionId: "main", onChange: (value) => assert.equal(value.hasAssistantText, true) });
  closeOtherControls();
  closeDisplay();
  updateSessionLiveState(f.api, "main", (current) => {
    assert.equal(current.state?.assistantText, "");
    assert.deepEqual(current.state?.steps, []);
    assert.deepEqual(current.state?.backgroundTasks, []);
    return current;
  });
  f.emit("main", { ...live("main"), cancellationState: "terminating" });
  assert.equal(controls.at(-1)?.cancellationState, "terminating");
  const reopened: Array<LiveSessionRunState | null> = [];
  const closeReopen = subscribeSessionLiveSelection({ api: f.api, sessionId: "main", select: (state) => state, onChange: (state) => reopened.push(state) });
  assert.equal(f.gets.length, 2);
  f.gets[1]!.resolve({ ...live("main", "latest detail"), cancellationState: "terminating" });
  await flush();
  assert.equal(reopened.at(-1)?.assistantText, "latest detail");
  closeReopen();
  const closeTerminalReopen = subscribeSessionLiveSelection({ api: f.api, sessionId: "main", select: (state) => state, onChange: (state) => reopened.push(state) });
  assert.equal(f.gets.length, 3);
  f.emit("main", null);
  f.gets[2]!.resolve({ ...live("main", "obsolete"), cancellationState: "terminating" });
  await flush();
  assert.equal(controls.at(-1)?.hasLiveRun, false);
  assert.equal(reopened.at(-1), null);
  closeTerminalReopen();
  closeControls();
});

// @test-value v2
// kind = "invariant"
// claim = "無購読ownerの遅い取得は同じIDを再openした新しいownerへ適用しない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: メッセージの投影とWindow内live受信" }
// fault = "解放済みownerの初回結果が新しい表示を上書きする"
// observable = "再open consumerの本文と初回get回数"
// observation_boundary = "consumer"
// scope = "SessionWindow owner lifetime race"
// lifecycle = "permanent"
// impact = "Auxiliaryの反復切替で古い会話や取消状態が復活することを防ぐ"
// distinction = "既存の単一購読race testと異なり同じ公開API・同じIDのowner破棄と再作成を検証する。短いdeferredで維持できる"
// @end-test-value
test("解放したownerのgetは再openしたownerを巻き戻さない", async () => {
  const f = fixture();
  const close = subscribeSessionLiveSelection({ api: f.api, sessionId: "aux", select: (state) => state, onChange: () => {} });
  close();
  const values: Array<LiveSessionRunState | null> = [];
  const closeNew = subscribeSessionLiveSelection({ api: f.api, sessionId: "aux", select: (state) => state, onChange: (state) => values.push(state) });
  assert.equal(f.gets.length, 2);
  f.gets[1]!.resolve(live("aux", "new"));
  await flush();
  f.gets[0]!.resolve(live("aux", "old"));
  await flush();
  assert.equal(values.at(-1)?.assistantText, "new");
  closeNew();
});
