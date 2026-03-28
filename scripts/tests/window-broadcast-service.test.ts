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

test("WindowBroadcastService は非破棄 window にだけ event を送る", () => {
  const active = createWindow(false);
  const closed = createWindow(true);
  const service = new WindowBroadcastService({
    getWindows: () => [active.window, closed.window],
  });

  service.broadcastSessions([]);
  service.broadcastOpenSessionWindowIds(["session-1"]);

  assert.equal(active.sent.length, 2);
  assert.equal(closed.sent.length, 0);
  assert.deepEqual(active.sent.map((entry) => entry.channel), [
    "withmate:sessions-changed",
    "withmate:open-session-windows-changed",
  ]);
});
