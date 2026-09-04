import assert from "node:assert/strict";
import test from "node:test";

import { WindowBroadcastService } from "../../src-electron/window-broadcast-service.js";

function createWindow(destroyed = false) {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    window: { isDestroyed: () => destroyed, webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } },
    sent,
  };
}

// @test-value v1
// kind = "contract"
// claim = "WindowBroadcastService は用途別 window に event を振り分けるが検証対象の公開契約を成立させる"
// oracle = { type = "contract", ref = "scripts/tests/window-broadcast-service.test.ts:14 public contract" }
// failure_mode = "WindowBroadcastService は用途別 window に event を振り分けるの条件で、consumerから観測できる公開結果が欠落・誤配信・不正許可になる"
// scope = "window-broadcast-service"
// lifecycle = "permanent"
// distinction = "対象テスト「WindowBroadcastService は用途別 window に event を振り分ける」固有の入力、境界、またはwindow scopeを確認する"
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
    getSessionWindow: () => session.window,
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
    "withmate:sessions-invalidated", "withmate:open-session-windows-changed", "withmate:prompt-templates-changed",
  ]);
  assert.equal(closed.sent.length, 0);
  assert.deepEqual(home.sent[1]?.payload, { scope: "ids", sessionIds: ["session-1"] });
});

// @test-value v1
// kind = "contract"
// claim = "WindowBroadcastService は Session Window復元集合をHomeだけへ通知するが検証対象の公開契約を成立させる"
// oracle = { type = "contract", ref = "scripts/tests/window-broadcast-service.test.ts:40 public contract" }
// failure_mode = "WindowBroadcastService は Session Window復元集合をHomeだけへ通知するの条件で、consumerから観測できる公開結果が欠落・誤配信・不正許可になる"
// scope = "window-broadcast-service"
// lifecycle = "permanent"
// distinction = "対象テスト「WindowBroadcastService は Session Window復元集合をHomeだけへ通知する」固有の入力、境界、またはwindow scopeを確認する"
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
    getSessionWindow: () => session.window,
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

// @test-value v1
// kind = "contract"
// claim = "WindowBroadcastService はprimary Home不在時に復元集合を通知しないが検証対象の公開契約を成立させる"
// oracle = { type = "contract", ref = "scripts/tests/window-broadcast-service.test.ts:64 public contract" }
// failure_mode = "WindowBroadcastService はprimary Home不在時に復元集合を通知しないの条件で、consumerから観測できる公開結果が欠落・誤配信・不正許可になる"
// scope = "window-broadcast-service"
// lifecycle = "permanent"
// distinction = "対象テスト「WindowBroadcastService はprimary Home不在時に復元集合を通知しない」固有の入力、境界、またはwindow scopeを確認する"
// @end-test-value
test("WindowBroadcastService はprimary Home不在時に復元集合を通知しない", () => {
  const settings = createWindow(false);
  const service = new WindowBroadcastService({
    getAllWindows: () => [settings.window],
    getHomeWindows: () => [settings.window],
    getPrimaryHomeWindow: () => null,
    getSessionWindows: () => [],
    getSessionWindow: () => null,
  });

  service.broadcastSessionWindowRestoreSet(["session-1"]);

  assert.equal(settings.sent.length, 0);
});

// @test-value v1
// kind = "regression"
// claim = "WindowBroadcastService は open Session ID の上限超過を all にするが検証対象の公開契約を成立させる"
// oracle = { type = "contract", ref = "scripts/tests/window-broadcast-service.test.ts:79 public contract" }
// failure_mode = "WindowBroadcastService は open Session ID の上限超過を all にするの条件で、consumerから観測できる公開結果が欠落・誤配信・不正許可になる"
// scope = "window-broadcast-service"
// lifecycle = "permanent"
// distinction = "対象テスト「WindowBroadcastService は open Session ID の上限超過を all にする」固有の入力、境界、またはwindow scopeを確認する"
// @end-test-value
test("WindowBroadcastService は open Session ID の上限超過を all にする", () => {
  const home = createWindow(false);
  const service = new WindowBroadcastService({
    getAllWindows: () => [home.window],
    getHomeWindows: () => [home.window],
    getPrimaryHomeWindow: () => home.window,
    getSessionWindows: () => [],
    getSessionWindow: () => null,
  });

  service.broadcastOpenSessionWindowIds(Array.from({ length: 101 }, (_, index) => `session-${index}`));

  assert.deepEqual(home.sent[0]?.payload, { scope: "all" });
});

// @test-value v1
// kind = "regression"
// claim = "WindowBroadcastService は一つのWindow送信失敗を他Windowへ波及させないが検証対象の公開契約を成立させる"
// oracle = { type = "contract", ref = "scripts/tests/window-broadcast-service.test.ts:94 public contract" }
// failure_mode = "WindowBroadcastService は一つのWindow送信失敗を他Windowへ波及させないの条件で、consumerから観測できる公開結果が欠落・誤配信・不正許可になる"
// scope = "window-broadcast-service"
// lifecycle = "permanent"
// distinction = "対象テスト「WindowBroadcastService は一つのWindow送信失敗を他Windowへ波及させない」固有の入力、境界、またはwindow scopeを確認する"
// @end-test-value
test("WindowBroadcastService は一つのWindow送信失敗を他Windowへ波及させない", () => {
  const failed = createWindow(false);
  failed.window.webContents.send = () => { throw new Error("renderer disposed"); };
  const available = createWindow(false);
  const service = new WindowBroadcastService({
    getAllWindows: () => [failed.window, available.window],
    getHomeWindows: () => [failed.window, available.window],
    getPrimaryHomeWindow: () => failed.window,
    getSessionWindows: () => [],
    getSessionWindow: () => null,
  });

  service.broadcastPromptTemplates([]);

  assert.deepEqual(available.sent.map((entry) => entry.channel), ["withmate:prompt-templates-changed"]);
});
