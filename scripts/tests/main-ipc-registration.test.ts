import assert from "node:assert/strict";
import test from "node:test";

import type { IpcMain } from "electron";

import {
  registerMainIpcHandlers,
} from "../../src-electron/main-ipc-registration.js";
import {
  WITHMATE_CREATE_CHARACTER_CHANNEL,
  WITHMATE_CREATE_MATE_CHANNEL,
  WITHMATE_CREATE_SESSION_CHANNEL,
  WITHMATE_GET_CHARACTER_CHANNEL,
  WITHMATE_GET_APP_SETTINGS_CHANNEL,
  WITHMATE_GET_MEMORY_V6_DIAGNOSTICS_CHANNEL,
  WITHMATE_GET_MATE_STATE_CHANNEL,
  WITHMATE_LIST_CHARACTERS_CHANNEL,
  WITHMATE_LIST_SESSION_SUMMARIES_CHANNEL,
  WITHMATE_OPEN_CHARACTER_EDITOR_WINDOW_CHANNEL,
  WITHMATE_OPEN_SESSION_CHANNEL,
  WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL,
  WITHMATE_RESOLVE_LAUNCH_CHARACTER_CHANNEL,
  WITHMATE_RUN_SESSION_TURN_CHANNEL,
  WITHMATE_SET_DEFAULT_CHARACTER_CHANNEL,
} from "../../src/withmate-ipc-channels.js";

type Handler = (...args: unknown[]) => unknown;

function createIpcMainStub() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle(channel: string, handler: Handler) {
      handlers.set(channel, handler);
    },
    on() {},
  };

  return { ipcMain: ipcMain as unknown as IpcMain, handlers };
}

function createDeps(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const deps = new Proxy({
    resolveEventWindow: () => null,
    resolveHomeWindow: () => null,
    getMateState: async () => "active",
    logIpcError: (input: { channel: string }) => calls.push(`log:${input.channel}`),
    ...overrides,
  }, {
    get(target, prop: string) {
      if (prop in target) {
        return target[prop as keyof typeof target];
      }
      return async (...args: unknown[]) => {
        calls.push(`${prop}:${args.join(",")}`);
        return null;
      };
    },
  });

  return { deps: deps as never, calls };
}

test("registerMainIpcHandlers は保持する public IPC だけを登録する", () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const { deps } = createDeps();

  registerMainIpcHandlers(ipcMain, deps);

  assert.ok(handlers.has(WITHMATE_OPEN_SESSION_CHANNEL));
  assert.ok(handlers.has(WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL));
  assert.ok(handlers.has(WITHMATE_OPEN_CHARACTER_EDITOR_WINDOW_CHANNEL));
  assert.ok(handlers.has(WITHMATE_LIST_SESSION_SUMMARIES_CHANNEL));
  assert.ok(handlers.has(WITHMATE_GET_APP_SETTINGS_CHANNEL));
  assert.ok(handlers.has(WITHMATE_GET_MEMORY_V6_DIAGNOSTICS_CHANNEL));
  assert.ok(handlers.has(WITHMATE_GET_MATE_STATE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_CREATE_MATE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_LIST_CHARACTERS_CHANNEL));
  assert.ok(handlers.has(WITHMATE_GET_CHARACTER_CHANNEL));
  assert.ok(handlers.has(WITHMATE_CREATE_CHARACTER_CHANNEL));
  assert.ok(handlers.has(WITHMATE_SET_DEFAULT_CHARACTER_CHANNEL));
  assert.ok(handlers.has(WITHMATE_RESOLVE_LAUNCH_CHARACTER_CHANNEL));
  assert.ok(handlers.has(WITHMATE_CREATE_SESSION_CHANNEL));
  assert.ok(handlers.has(WITHMATE_RUN_SESSION_TURN_CHANNEL));

  const removedChannels = [
    "withmate:open-memory-management-window",
    "withmate:open-mate-talk-window",
    "withmate:get-memory-management-snapshot",
    "withmate:get-memory-management-page",
    "withmate:get-mate-growth-settings",
    "withmate:update-mate-growth-settings",
    "withmate:get-mate-embedding-settings",
    "withmate:list-provider-instruction-targets",
    "withmate:upsert-provider-instruction-target",
    "withmate:apply-mate-growth",
    "withmate:list-mate-growth-events",
    "withmate:correct-mate-growth-event",
    "withmate:disable-mate-growth-event",
    "withmate:forget-mate-growth-event",
    "withmate:start-mate-embedding-download",
    "withmate:delete-session-memory",
    "withmate:delete-project-memory-entry",
    "withmate:forget-mate-profile-item",
    "withmate:run-mate-talk-turn",
  ];

  for (const channel of removedChannels) {
    assert.equal(handlers.has(channel), false, `${channel} should not be registered`);
  }
});

test("registerMainIpcHandlers は Mate 未作成時でも session runtime IPC を block しない", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const { deps, calls } = createDeps({
    getMateState: async () => "not_created",
  });

  registerMainIpcHandlers(ipcMain, deps);

  await handlers.get(WITHMATE_RUN_SESSION_TURN_CHANNEL)?.({}, "session-1", { userMessage: "hello" });

  assert.deepEqual(calls, ["runSessionTurn:session-1,[object Object]"]);
});
