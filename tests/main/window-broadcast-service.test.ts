import assert from "node:assert/strict";
import test from "node:test";

import { WindowBroadcastService } from "../../src-electron/windows/window-broadcast-service.js";

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
// claim = "到達不能Rendererをskipし、送信例外と診断例外を隔離して他Windowへ同じlive run通知を配信する"
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
    canSendToWindow: (window) => window !== unreachable.window,
    onSendFailed: () => { failures += 1; throw new Error("diagnostics failed"); },
  });
  assert.doesNotThrow(() => service.broadcastLiveSessionRun("session-1", null));
  assert.equal(unreachable.sent.length, 0);
  assert.equal(failures, 1);
  assert.deepEqual(healthy.sent, [{ channel: "withmate:live-session-run", payload: { sessionId: "session-1", state: null } }]);
});

test("WindowBroadcastService は用途別 window に event を振り分ける", () => {
  const home = createWindow(false);
  const session = createWindow(false);
  const closed = createWindow(true);
  const service = new WindowBroadcastService({
    getAllWindows: () => [home.window, session.window, closed.window],
    getHomeWindows: () => [home.window, closed.window],
    getPrimaryHomeWindow: () => home.window,
    getSessionWindows: () => [session.window, closed.window],
  });

  service.broadcastSessionInvalidation({ scope: "ids", sessionIds: ["session-1"] });
  service.broadcastOpenSessionWindowIds(["session-1"]);
  service.broadcastPromptTemplates([]);

  assert.deepEqual(home.sent.map((entry) => entry.channel), [
    "withmate:sessions-invalidated",
    "withmate:open-session-windows-changed",
    "withmate:prompt-templates-changed",
  ]);
  assert.deepEqual(session.sent.map((entry) => entry.channel), [
    "withmate:sessions-invalidated",
    "withmate:open-session-windows-changed",
    "withmate:prompt-templates-changed",
  ]);
  assert.equal(closed.sent.length, 0);
  assert.deepEqual(home.sent[1]?.payload, { scope: "ids", sessionIds: ["session-1"] });
});

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

test("WindowBroadcastService はprimary Home不在時に復元集合を通知しない", () => {
  const settings = createWindow(false);
  const service = new WindowBroadcastService({
    getAllWindows: () => [settings.window],
    getHomeWindows: () => [settings.window],
    getPrimaryHomeWindow: () => null,
    getSessionWindows: () => [],
  });

  service.broadcastSessionWindowRestoreSet(["session-1"]);

  assert.equal(settings.sent.length, 0);
});

test("WindowBroadcastService は open Session ID の上限超過を all にする", () => {
  const home = createWindow(false);
  const service = new WindowBroadcastService({
    getAllWindows: () => [home.window],
    getHomeWindows: () => [home.window],
    getPrimaryHomeWindow: () => home.window,
    getSessionWindows: () => [],
  });

  service.broadcastOpenSessionWindowIds(Array.from({ length: 101 }, (_, index) => `session-${index}`));

  assert.deepEqual(home.sent[0]?.payload, { scope: "all" });
});
