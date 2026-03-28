import assert from "node:assert/strict";
import test from "node:test";

import { createWithMateWindowApi } from "../../src-electron/preload-api.js";

type Listener = (...args: unknown[]) => void;

function createIpcRendererStub() {
  const listeners = new Map<string, Listener>();

  return {
    listeners,
    ipcRenderer: {
      invoke(channel: string, ...args: unknown[]) {
        return Promise.resolve({ channel, args });
      },
      on(channel: string, listener: Listener) {
        listeners.set(channel, listener);
      },
      removeListener(channel: string) {
        listeners.delete(channel);
      },
    },
  };
}

test("createWithMateWindowApi は invoke 系 API を domain ごとに束ねる", async () => {
  const { ipcRenderer } = createIpcRendererStub();
  const api = createWithMateWindowApi(ipcRenderer as never);

  assert.deepEqual(await api.openSession("session-1"), {
    channel: "withmate:open-session",
    args: ["session-1"],
  });
  assert.deepEqual(await api.resetAppDatabase({ targets: ["appSettings"] }), {
    channel: "withmate:reset-app-database",
    args: [{ targets: ["appSettings"] }],
  });
  assert.deepEqual(await api.getSessionBackgroundActivity("session-1", "memoryGeneration"), {
    channel: "withmate:get-session-background-activity",
    args: ["session-1", "memoryGeneration"],
  });
});

test("createWithMateWindowApi は subscribe 系 API で payload を unwrap する", async () => {
  const { ipcRenderer, listeners } = createIpcRendererStub();
  const api = createWithMateWindowApi(ipcRenderer as never);
  const received: unknown[] = [];

  const dispose = api.subscribeLiveSessionRun((sessionId, state) => {
    received.push({ sessionId, state });
  });

  listeners.get("withmate:live-session-run")?.({}, { sessionId: "session-1", state: { phase: "running" } });
  dispose();

  assert.deepEqual(received, [{ sessionId: "session-1", state: { phase: "running" } }]);
  assert.equal(listeners.has("withmate:live-session-run"), false);
});
