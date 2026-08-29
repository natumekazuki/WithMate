import assert from "node:assert/strict";
import test from "node:test";

import { WindowBroadcastService } from "../../src-electron/window-broadcast-service.js";

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

test("WindowBroadcastService は用途別 window に event を振り分ける", () => {
  const home = createWindow(false);
  const session = createWindow(false);
  const closed = createWindow(true);
  const service = new WindowBroadcastService({
    getAllWindows: () => [home.window, session.window, closed.window],
    getHomeWindows: () => [home.window, closed.window],
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
  const session = createWindow(false);
  const closedHome = createWindow(true);
  const service = new WindowBroadcastService({
    getAllWindows: () => [home.window, session.window, closedHome.window],
    getHomeWindows: () => [home.window, closedHome.window],
    getSessionWindows: () => [session.window],
  });

  service.broadcastSessionWindowRestoreSet(["session-1", "session-2"]);

  assert.deepEqual(home.sent, [{
    channel: "withmate:session-window-restore-set-changed",
    payload: ["session-1", "session-2"],
  }]);
  assert.equal(session.sent.length, 0);
  assert.equal(closedHome.sent.length, 0);
});

test("WindowBroadcastService は open Session ID の上限超過を all にする", () => {
  const home = createWindow(false);
  const service = new WindowBroadcastService({
    getAllWindows: () => [home.window],
    getHomeWindows: () => [home.window],
    getSessionWindows: () => [],
  });

  service.broadcastOpenSessionWindowIds(Array.from({ length: 101 }, (_, index) => `session-${index}`));

  assert.deepEqual(home.sent[0]?.payload, { scope: "all" });
});
