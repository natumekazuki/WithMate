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
  WITHMATE_DELETE_SESSIONS_LAST_ACTIVE_BEFORE_CHANNEL,
  WITHMATE_GET_CHARACTER_CHANNEL,
  WITHMATE_GET_APP_SETTINGS_CHANNEL,
  WITHMATE_GET_MEMORY_V6_DIAGNOSTICS_CHANNEL,
  WITHMATE_INSTALL_MEMORY_V6_CLI_SHIM_CHANNEL,
  WITHMATE_SEARCH_MEMORY_V6_ENTRIES_CHANNEL,
  WITHMATE_GET_MEMORY_V6_ENTRY_CHANNEL,
  WITHMATE_FORGET_MEMORY_V6_ENTRY_CHANNEL,
  WITHMATE_GET_MATE_STATE_CHANNEL,
  WITHMATE_LIST_CHARACTERS_CHANNEL,
  WITHMATE_LIST_SESSION_SUMMARIES_CHANNEL,
  WITHMATE_OPEN_CHARACTER_EDITOR_WINDOW_CHANNEL,
  WITHMATE_OPEN_SESSION_CHANNEL,
  WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL,
  WITHMATE_RESOLVE_LAUNCH_CHARACTER_CHANNEL,
  WITHMATE_RUN_SESSION_TURN_CHANNEL,
  WITHMATE_SET_DEFAULT_CHARACTER_CHANNEL,
  WITHMATE_UNINSTALL_MEMORY_V6_CLI_SHIM_CHANNEL,
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
    isSettingsWindow: () => false,
    isMemoryV6ReviewWindow: () => false,
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

function createWindowStub(url: string) {
  return {
    webContents: {
      isDestroyed: () => false,
      getURL: () => url,
    },
  };
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
  assert.ok(handlers.has(WITHMATE_INSTALL_MEMORY_V6_CLI_SHIM_CHANNEL));
  assert.ok(handlers.has(WITHMATE_UNINSTALL_MEMORY_V6_CLI_SHIM_CHANNEL));
  assert.ok(handlers.has(WITHMATE_SEARCH_MEMORY_V6_ENTRIES_CHANNEL));
  assert.ok(handlers.has(WITHMATE_GET_MEMORY_V6_ENTRY_CHANNEL));
  assert.ok(handlers.has(WITHMATE_FORGET_MEMORY_V6_ENTRY_CHANNEL));
  assert.ok(handlers.has(WITHMATE_GET_MATE_STATE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_CREATE_MATE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_LIST_CHARACTERS_CHANNEL));
  assert.ok(handlers.has(WITHMATE_GET_CHARACTER_CHANNEL));
  assert.ok(handlers.has(WITHMATE_CREATE_CHARACTER_CHANNEL));
  assert.ok(handlers.has(WITHMATE_SET_DEFAULT_CHARACTER_CHANNEL));
  assert.ok(handlers.has(WITHMATE_RESOLVE_LAUNCH_CHARACTER_CHANNEL));
  assert.ok(handlers.has(WITHMATE_CREATE_SESSION_CHANNEL));
  assert.ok(handlers.has(WITHMATE_DELETE_SESSIONS_LAST_ACTIVE_BEFORE_CHANNEL));
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

test("Memory V6 Review IPC は memory-review window からだけ呼び出せる", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const reviewWindow = createWindowStub("http://localhost:5173/?mode=memory-review");
  const { deps, calls } = createDeps({
    resolveEventWindow: () => reviewWindow,
    isMemoryV6ReviewWindow: (window: unknown) => window === reviewWindow,
    searchMemoryV6Entries: async () => ({ items: [] }),
    getMemoryV6Entry: async () => null,
    forgetMemoryV6Entry: async () => ({ entryId: "mem-1", status: "not_found", reason: "user_request" }),
  });

  registerMainIpcHandlers(ipcMain, deps);

  assert.deepEqual(await handlers.get(WITHMATE_SEARCH_MEMORY_V6_ENTRIES_CHANNEL)?.({}, { query: "x" }), { items: [] });
  assert.equal(await handlers.get(WITHMATE_GET_MEMORY_V6_ENTRY_CHANNEL)?.({}, "mem-1"), null);
  assert.deepEqual(await handlers.get(WITHMATE_FORGET_MEMORY_V6_ENTRY_CHANNEL)?.({}, "mem-1", "user_request"), {
    entryId: "mem-1",
    status: "not_found",
    reason: "user_request",
  });
  assert.deepEqual(calls, []);
});

test("Memory V6 CLI shim IPC は Settings window からだけ呼び出せる", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const settingsWindow = createWindowStub("http://localhost:5173/?mode=settings");
  const { deps, calls } = createDeps({
    resolveEventWindow: () => settingsWindow,
    isSettingsWindow: (window: unknown) => window === settingsWindow,
    installMemoryV6CliShim: async () => {
      calls.push("install");
      return { cliShim: { status: "installed" } };
    },
    uninstallMemoryV6CliShim: async () => {
      calls.push("uninstall");
      return { cliShim: { status: "not-installed" } };
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  assert.deepEqual(await handlers.get(WITHMATE_INSTALL_MEMORY_V6_CLI_SHIM_CHANNEL)?.({}), {
    cliShim: { status: "installed" },
  });
  assert.deepEqual(await handlers.get(WITHMATE_UNINSTALL_MEMORY_V6_CLI_SHIM_CHANNEL)?.({}), {
    cliShim: { status: "not-installed" },
  });
  assert.deepEqual(calls, ["install", "uninstall"]);
});

test("Memory V6 CLI shim IPC は Settings window 以外からの呼び出しを拒否する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const homeWindow = createWindowStub("http://localhost:5173/");
  const { deps, calls } = createDeps({
    resolveEventWindow: () => homeWindow,
    isSettingsWindow: () => false,
    installMemoryV6CliShim: async () => {
      calls.push("install");
      return null;
    },
    uninstallMemoryV6CliShim: async () => {
      calls.push("uninstall");
      return null;
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  await assert.rejects(
    () => handlers.get(WITHMATE_INSTALL_MEMORY_V6_CLI_SHIM_CHANNEL)?.({}) as Promise<unknown>,
    /Settings IPC is only available/,
  );
  await assert.rejects(
    () => handlers.get(WITHMATE_UNINSTALL_MEMORY_V6_CLI_SHIM_CHANNEL)?.({}) as Promise<unknown>,
    /Settings IPC is only available/,
  );
  assert.equal(calls.includes("install"), false);
  assert.equal(calls.includes("uninstall"), false);
});

test("Memory V6 Review IPC は通常 window からの呼び出しを拒否する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const homeWindow = createWindowStub("http://localhost:5173/?mode=settings");
  const { deps, calls } = createDeps({
    resolveEventWindow: () => homeWindow,
    isMemoryV6ReviewWindow: () => false,
    searchMemoryV6Entries: async () => {
      calls.push("search");
      return { items: [] };
    },
    getMemoryV6Entry: async () => {
      calls.push("get");
      return null;
    },
    forgetMemoryV6Entry: async () => {
      calls.push("forget");
      return { entryId: "mem-1", status: "not_found", reason: "user_request" };
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  await assert.rejects(
    () => handlers.get(WITHMATE_SEARCH_MEMORY_V6_ENTRIES_CHANNEL)?.({}, { query: "x" }) as Promise<unknown>,
    /Memory V6 Review IPC is only available/,
  );
  await assert.rejects(
    () => handlers.get(WITHMATE_GET_MEMORY_V6_ENTRY_CHANNEL)?.({}, "mem-1") as Promise<unknown>,
    /Memory V6 Review IPC is only available/,
  );
  await assert.rejects(
    () => handlers.get(WITHMATE_FORGET_MEMORY_V6_ENTRY_CHANNEL)?.({}, "mem-1", "privacy") as Promise<unknown>,
    /Memory V6 Review IPC is only available/,
  );
  assert.equal(calls.includes("search"), false);
  assert.equal(calls.includes("get"), false);
  assert.equal(calls.includes("forget"), false);
});

test("Memory V6 Review IPC は通常 window のURLがmemory-reviewでも拒否する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const spoofedHomeWindow = createWindowStub("http://localhost:5173/?mode=memory-review");
  const { deps, calls } = createDeps({
    resolveEventWindow: () => spoofedHomeWindow,
    isMemoryV6ReviewWindow: () => false,
    searchMemoryV6Entries: async () => {
      calls.push("search");
      return { items: [] };
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  await assert.rejects(
    () => handlers.get(WITHMATE_SEARCH_MEMORY_V6_ENTRIES_CHANNEL)?.({}, { query: "x" }) as Promise<unknown>,
    /Memory V6 Review IPC is only available/,
  );
  assert.equal(calls.includes("search"), false);
});
