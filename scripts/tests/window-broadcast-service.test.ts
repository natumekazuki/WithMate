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

  service.broadcastSessionSummaries([]);
  service.broadcastSessionInvalidation(["session-1"]);
  service.broadcastOpenSessionWindowIds(["session-1"]);

  assert.deepEqual(home.sent.map((entry) => entry.channel), [
    "withmate:sessions-changed",
    "withmate:open-session-windows-changed",
  ]);
  assert.deepEqual(session.sent.map((entry) => entry.channel), [
    "withmate:sessions-invalidated",
    "withmate:open-session-windows-changed",
  ]);
  assert.equal(closed.sent.length, 0);
});
