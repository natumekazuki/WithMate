import assert from "node:assert/strict";
import test from "node:test";

import { WindowBroadcastService } from "../../src-electron/windows/window-broadcast-service.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";

function createWindow(destroyed = false) {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    window: {
      isDestroyed: () => destroyed,
      webContents: {
        send: (channel: string, payload: unknown) => {
          sent.push({ channel, payload });
        },
      },
    },
    sent,
  };
}

// @test-value v2
// kind = "invariant"
// claim = "到達不能Rendererをskipし、軽量通知の送信例外と診断例外を隔離して他Windowとownerへlive通知を配信する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#decision" }
// fault = "到達不能Rendererへ送信するか、一つの送信失敗がMainのpublicationをthrowで中断する"
// observable = "live run通知の配信payload、到達不能Windowの送信数、送信失敗通知数、publicationの例外"
// observation_boundary = "public-boundary"
// scope = "window-broadcast-renderer-failure-isolation"
// lifecycle = "permanent"
// impact = "表示障害が他Windowの状態更新とMain所有のprovider進行を妨げる"
// distinction = "用途別routing testと型検査では観測できない実send例外の伝播を三つの小さいWindowで検証する"
// @end-test-value
test("WindowBroadcastServiceはRenderer送信失敗を隔離して他Windowへ配信する", () => {
  const unreachable = createWindow();
  const broken = createWindow();
  const healthy = createWindow();
  let failures = 0;
  broken.window.webContents.send = () => { throw new TypeError("Object has been destroyed"); };
  const service = new WindowBroadcastService({
    getAllWindows: () => [unreachable.window, broken.window, healthy.window],
    getHomeWindows: () => [],
    getPrimaryHomeWindow: () => null,
    getSessionWindows: () => [],
    getLiveSessionRunStatusWindows: () => [unreachable.window, broken.window, healthy.window],
    getLiveSessionRunWindow: () => healthy.window,
    canSendToWindow: (window) => window !== unreachable.window,
    onSendFailed: () => { failures += 1; throw new Error("diagnostics failed"); },
  });
  assert.doesNotThrow(() => service.broadcastLiveSessionRun("session-1", null));
  assert.equal(unreachable.sent.length, 0);
  assert.equal(failures, 1);
  assert.deepEqual(healthy.sent, [
    { channel: "withmate:live-session-run-status", payload: { sessionId: "session-1", status: null } },
    { channel: "withmate:live-session-run", payload: { sessionId: "session-1", state: null } },
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "用途別配送を維持し、turn更新は生存windowへ、queue変更は生存Session windowだけへ対象Session IDを渡す"
// oracle = { type = "contract", ref = "src-shared/ipc/withmate-ipc-channels.ts notification contracts" }
// fault = "必要なWindowへ通知しない、destroyed Windowへ配信する、またはturn/queue通知へ本文や履歴詳細を混入する"
// observable = "home/session/closed Windowのchannelとpayload"
// observation_boundary = "public-boundary"
// scope = "window broadcast routing"
// lifecycle = "permanent"
// @end-test-value
test("WindowBroadcastService は用途別 window に event を振り分ける", () => {
  const home = createWindow(false);
  const session = createWindow(false);
  const closed = createWindow(true);
  const service = new WindowBroadcastService({
    getAllWindows: () => [home.window, session.window, closed.window],
    getHomeWindows: () => [home.window, closed.window],
    getPrimaryHomeWindow: () => home.window,
    getSessionWindows: () => [session.window, closed.window],
    getLiveSessionRunStatusWindows: () => [home.window],
    getLiveSessionRunWindow: () => session.window,
  });

  service.broadcastSessionInvalidation({ scope: "ids", sessionIds: ["session-1"] });
  service.broadcastOpenSessionWindowIds(["session-1"]);
  service.broadcastPromptTemplates([]);
  service.broadcastSessionTurnUpdated("session-1");
  service.broadcastSessionTurnQueueChanged("session-1");

  assert.deepEqual(home.sent.map((entry) => entry.channel), [
    "withmate:sessions-invalidated",
    "withmate:open-session-windows-changed",
    "withmate:prompt-templates-changed",
    "withmate:session-turn-updated",
  ]);
  assert.deepEqual(session.sent.map((entry) => entry.channel), [
    "withmate:sessions-invalidated",
    "withmate:open-session-windows-changed",
    "withmate:prompt-templates-changed",
    "withmate:session-turn-updated",
    "withmate:session-turn-queue-changed",
  ]);
  assert.equal(closed.sent.length, 0);
  assert.deepEqual(home.sent[1]?.payload, { scope: "ids", sessionIds: ["session-1"] });
  assert.equal(home.sent[3]?.payload, "session-1");
  assert.equal(session.sent[3]?.payload, "session-1");
  assert.equal(session.sent[4]?.payload, "session-1");
});

// @test-value v2
// kind = "security"
// claim = "Aux queue変更は親owner Windowだけへ実Aux target IDを配信する"
// oracle = { type = "contract", ref = "src-electron/windows/window-broadcast-service.ts broadcastSessionTurnQueueChanged" }
// fault = "queue変更を全Session Windowへ公開するかpayloadを親IDへ置換する"
// observable = "owner/nonowner Windowの送信eventとpayload"
// observation_boundary = "public-boundary"
// scope = "Auxiliary queue owner notification routing"
// lifecycle = "permanent"
// impact = "別会話WindowへAux target識別子が漏れるかAux queue一覧が更新されない"
// distinction = "IPC認可testはMainからRendererへのevent配送先を検証しない"
// risk_tags = ["privacy"]
// @end-test-value
test("Aux queue変更は親WindowだけへAux IDで配信する", () => {
  const owner = createWindow();
  const other = createWindow();
  const service = new WindowBroadcastService({
    getAllWindows: () => [owner.window, other.window],
    getHomeWindows: () => [], getPrimaryHomeWindow: () => null,
    getSessionWindows: () => [owner.window, other.window],
    getLiveSessionRunStatusWindows: () => [],
    getLiveSessionRunWindow: (id) => id === "parent-1" ? owner.window : other.window,
  });
  service.broadcastSessionTurnQueueChanged("aux-1", "parent-1");
  assert.deepEqual(owner.sent, [{ channel: "withmate:session-turn-queue-changed", payload: "aux-1" }]);
  assert.deepEqual(other.sent, []);
});

// @test-value v2
// kind = "contract"
// claim = "Window復元集合はprimary Homeだけへ配信する"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#sessionwindowbridge" }
// fault = "復元集合をSettingsやSessionにも送信する"
// observable = "各Windowの受信payloadと送信件数"
// observation_boundary = "public-boundary"
// scope = "window-restore-set-routing"
// lifecycle = "permanent"
// @end-test-value
test("WindowBroadcastService は Session Window復元集合をHomeだけへ通知する", () => {
  const home = createWindow(false);
  const settings = createWindow(false);
  const session = createWindow(false);
  const closedPrimaryHome = createWindow(true);
  const service = new WindowBroadcastService({
    getAllWindows: () => [home.window, settings.window, session.window, closedPrimaryHome.window],
    getHomeWindows: () => [home.window, settings.window],
    getPrimaryHomeWindow: () => home.window,
    getSessionWindows: () => [session.window],
    getLiveSessionRunStatusWindows: () => [home.window],
    getLiveSessionRunWindow: () => session.window,
  });

  service.broadcastSessionWindowRestoreSet(["session-1", "session-2"]);

  assert.deepEqual(home.sent, [{
    channel: "withmate:session-window-restore-set-changed",
    payload: ["session-1", "session-2"],
  }]);
  assert.equal(settings.sent.length, 0);
  assert.equal(session.sent.length, 0);
  assert.equal(closedPrimaryHome.sent.length, 0);
});

// @test-value v2
// kind = "contract"
// claim = "primary Homeがない時は他の管理Windowへ復元集合を流さない"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#sessionwindowbridge" }
// fault = "primary不在時にSettingsを代替宛先にする"
// observable = "Settingsの受信件数"
// observation_boundary = "public-boundary"
// scope = "window-restore-set-without-home"
// lifecycle = "permanent"
// @end-test-value
test("WindowBroadcastService はprimary Home不在時に復元集合を通知しない", () => {
  const settings = createWindow(false);
  const service = new WindowBroadcastService({
    getAllWindows: () => [settings.window],
    getHomeWindows: () => [settings.window],
    getPrimaryHomeWindow: () => null,
    getSessionWindows: () => [],
    getLiveSessionRunStatusWindows: () => [],
    getLiveSessionRunWindow: () => null,
  });

  service.broadcastSessionWindowRestoreSet(["session-1"]);

  assert.equal(settings.sent.length, 0);
});

// @test-value v2
// kind = "contract"
// claim = "open Session ID通知は上限超過時にall無効化へ縮退する"
// oracle = { type = "contract", ref = "src-shared/window/withmate-window-types.ts#OPEN_SESSION_WINDOW_IDS_BROADCAST_MAX" }
// fault = "上限を超えるID列をeventへ保持する"
// observable = "Homeが受信したscope"
// observation_boundary = "public-boundary"
// scope = "window-open-id-broadcast-bound"
// lifecycle = "permanent"
// @end-test-value
test("WindowBroadcastService は open Session ID の上限超過を all にする", () => {
  const home = createWindow(false);
  const service = new WindowBroadcastService({
    getAllWindows: () => [home.window],
    getHomeWindows: () => [home.window],
    getPrimaryHomeWindow: () => home.window,
    getSessionWindows: () => [],
    getLiveSessionRunStatusWindows: () => [home.window],
    getLiveSessionRunWindow: () => null,
  });

  service.broadcastOpenSessionWindowIds(Array.from({ length: 101 }, (_, index) => `session-${index}`));

  assert.deepEqual(home.sent[0]?.payload, { scope: "all" });
});

function createLiveState(): LiveSessionRunState {
  return {
    sessionId: "aux-1", threadId: "thread-1", runState: "running", turnId: "turn-1",
    cancellationState: "terminating", assistantText: "large assistant body".repeat(10000),
    reasoningText: "large reasoning".repeat(10000),
    steps: [{ id: "step-1", type: "command", summary: "operation", status: "in_progress", details: "large operation".repeat(10000) }],
    backgroundTasks: [], usage: null, errorMessage: "",
    approvalRequest: null, elicitationRequest: null,
  };
}

// @test-value v2
// kind = "contract"
// claim = "live詳細はMainが解決したowner Windowだけへ元sessionIdで届き、HomeとMonitorには本文サイズと独立した状態だけが届く"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#live-run-delivery" }
// fault = "全Windowへ詳細を送るか、Auxiliary IDを親IDへ書き換えるか、軽量通知に本文やoperationを含める"
// observable = "各Windowの受信channel・payloadと軽量payloadの直列化サイズ"
// observation_boundary = "public-boundary"
// scope = "live-run-owner-and-status-delivery"
// lifecycle = "permanent"
// impact = "無関係Windowへの会話詳細転送と本文増加に比例する複数WindowのIPC負荷を防ぐ"
// distinction = "型はruntime objectの余剰fieldと実配送先を制約しないため、小さいWindow stubで現行の公開配送境界を継続確認する"
// @end-test-value
test("live配信はowner詳細とHome／Monitorの固定サイズstatusに分離する", () => {
  const home = createWindow();
  const monitor = createWindow();
  const owner = createWindow();
  const unrelated = createWindow();
  const settings = createWindow();
  const memoryReview = createWindow();
  const state = createLiveState();
  const service = new WindowBroadcastService({
    getAllWindows: () => [home.window, monitor.window, owner.window, unrelated.window, settings.window, memoryReview.window],
    getHomeWindows: () => [home.window, monitor.window, settings.window, memoryReview.window],
    getPrimaryHomeWindow: () => home.window,
    getSessionWindows: () => [owner.window, unrelated.window],
    getLiveSessionRunStatusWindows: () => [home.window, monitor.window],
    getLiveSessionRunWindow: (id) => id === "aux-1" || id === "main-1" ? owner.window : null,
  });
  service.broadcastLiveSessionRun("aux-1", state);
  assert.deepEqual(owner.sent, [{ channel: "withmate:live-session-run", payload: { sessionId: "aux-1", state } }]);
  const expectedStatus = { channel: "withmate:live-session-run-status", payload: { sessionId: "aux-1", status: { runState: "running", cancellationState: "terminating" } } };
  assert.deepEqual(home.sent, [expectedStatus]);
  assert.deepEqual(monitor.sent, [expectedStatus]);
  assert.equal(unrelated.sent.length + settings.sent.length + memoryReview.sent.length, 0);
  const size = JSON.stringify(home.sent[0]).length;
  service.broadcastLiveSessionRun("aux-1", { ...state, assistantText: "", reasoningText: "", steps: [] });
  assert.equal(JSON.stringify(home.sent[1]).length, size);
  service.broadcastLiveSessionRun("main-1", { ...state, sessionId: "main-1" });
  assert.equal((owner.sent[2]?.payload as { sessionId: string }).sessionId, "main-1");
});

// @test-value v2
// kind = "contract"
// claim = "非表示ownerと再open後の新ownerへ終端nullを配信し、owner不明・lookup例外でも他Sessionへ詳細を代替配信しない"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#live-run-delivery" }
// fault = "visibilityでowner通知を落とすか、古いWindowへnullを送るか、lookup失敗を全Window配信で救済する"
// observable = "旧／新ownerと無関係Sessionの受信payload、lookup例外時のpublication結果とHome status"
// observation_boundary = "public-boundary"
// scope = "live-run-owner-lifecycle"
// lifecycle = "permanent"
// impact = "再open後の取消待ち解除と宛先限定を維持し、無関係会話への詳細漏出を防ぐ"
// distinction = "Window生存とowner解決はruntime依存のため、型検査ではnull配送やlookup障害を検出できない。追加基盤なしの短いfixtureで確認する"
// @end-test-value
test("live配送は再openとowner lookup失敗でも宛先境界を維持する", () => {
  const home = createWindow();
  const unrelated = createWindow();
  const first = createWindow();
  const reopened = createWindow();
  let target: typeof first.window | null = first.window;
  let lookupFailed = false;
  const service = new WindowBroadcastService({
    getAllWindows: () => [home.window, unrelated.window, first.window, reopened.window],
    getHomeWindows: () => [home.window], getPrimaryHomeWindow: () => home.window,
    getSessionWindows: () => [unrelated.window, first.window, reopened.window],
    getLiveSessionRunStatusWindows: () => [home.window],
    getLiveSessionRunWindow: () => { if (lookupFailed) throw new Error("owner unavailable"); return target; },
  });
  // No visibility API: a live registered owner receives state even when hidden.
  service.broadcastLiveSessionRun("aux-1", createLiveState());
  target = reopened.window;
  first.window.isDestroyed = () => true;
  service.broadcastLiveSessionRun("aux-1", null);
  assert.equal(first.sent.length, 1);
  assert.deepEqual(reopened.sent, [{ channel: "withmate:live-session-run", payload: { sessionId: "aux-1", state: null } }]);
  target = null;
  service.broadcastLiveSessionRun("aux-1", createLiveState());
  lookupFailed = true;
  assert.doesNotThrow(() => service.broadcastLiveSessionRun("aux-1", null));
  assert.equal(unrelated.sent.length, 0);
  assert.equal(reopened.sent.length, 1);
  assert.deepEqual(home.sent.at(-1), { channel: "withmate:live-session-run-status", payload: { sessionId: "aux-1", status: null } });
});
