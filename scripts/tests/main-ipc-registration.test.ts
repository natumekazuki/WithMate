import assert from "node:assert/strict";
import test from "node:test";

import type { IpcMain } from "electron";

import {
  registerMainIpcHandlers,
} from "../../src-electron/main-ipc-registration.js";
import {
  WITHMATE_CANCEL_AUXILIARY_SESSION_RUN_CHANNEL,
  WITHMATE_CLOSE_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_CREATE_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_CREATE_CHARACTER_CHANNEL,
  WITHMATE_CREATE_MATE_CHANNEL,
  WITHMATE_CREATE_SESSION_CHANNEL,
  WITHMATE_DELETE_SESSION_CHANNEL,
  WITHMATE_DELETE_SESSIONS_LAST_ACTIVE_BEFORE_CHANNEL,
  WITHMATE_GET_ACTIVE_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_GET_CHARACTER_CHANNEL,
  WITHMATE_GET_APP_SETTINGS_CHANNEL,
  WITHMATE_GET_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_GET_MEMORY_V6_DIAGNOSTICS_CHANNEL,
  WITHMATE_INSTALL_MEMORY_V6_CLI_SHIM_CHANNEL,
  WITHMATE_GET_MEMORY_V6_FILE_USAGE_CHANNEL,
  WITHMATE_EXPORT_MEMORY_V6_ENTRY_FILES_CHANNEL,
  WITHMATE_RUN_MEMORY_V6_PROTECTED_OBJECT_GC_CHANNEL,
  WITHMATE_SEARCH_MEMORY_V6_ENTRIES_CHANNEL,
  WITHMATE_GET_MEMORY_V6_ENTRY_CHANNEL,
  WITHMATE_FORGET_MEMORY_V6_ENTRY_CHANNEL,
  WITHMATE_GET_MATE_STATE_CHANNEL,
  WITHMATE_LIST_CHARACTERS_CHANNEL,
  WITHMATE_LIST_AUXILIARY_SESSIONS_CHANNEL,
  WITHMATE_LIST_SESSION_SUMMARIES_CHANNEL,
  WITHMATE_OPEN_CHARACTER_EDITOR_WINDOW_CHANNEL,
  WITHMATE_OPEN_SESSION_CHANNEL,
  WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL,
  WITHMATE_RESET_APP_DATABASE_CHANNEL,
  WITHMATE_RESOLVE_LAUNCH_CHARACTER_CHANNEL,
  WITHMATE_RUN_AUXILIARY_SESSION_TURN_CHANNEL,
  WITHMATE_RUN_SESSION_TURN_CHANNEL,
  WITHMATE_SET_DEFAULT_CHARACTER_CHANNEL,
  WITHMATE_UPDATE_AUXILIARY_SESSION_CHANNEL,
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

function createAuxiliarySessionStub(overrides: Record<string, unknown> = {}) {
  return {
    id: "aux-1",
    parentSessionId: "session-1",
    status: "active",
    runState: "idle",
    title: "Auxiliary",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5",
    reasoningEffort: "medium",
    approvalMode: "never",
    codexSandboxMode: "workspace-write",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "thread-1",
    composerDraft: "",
    messages: [],
    displayAfterMessageIndex: null,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    closedAt: "",
    ...overrides,
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
  assert.ok(handlers.has(WITHMATE_GET_MEMORY_V6_FILE_USAGE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_EXPORT_MEMORY_V6_ENTRY_FILES_CHANNEL));
  assert.ok(handlers.has(WITHMATE_RUN_MEMORY_V6_PROTECTED_OBJECT_GC_CHANNEL));
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
  assert.ok(handlers.has(WITHMATE_DELETE_SESSION_CHANNEL));
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
    getMemoryV6FileUsage: async () => ({ usedBytes: 0 }) as never,
    exportMemoryV6EntryFiles: async (entryId: string) => ({ entryId, exportedCount: 1 }) as never,
    runMemoryV6ProtectedObjectGc: async (request: { dryRun: boolean }) => ({ dryRun: request.dryRun }) as never,
    searchMemoryV6Entries: async () => ({ items: [] }),
    getMemoryV6Entry: async () => null,
    forgetMemoryV6Entry: async () => ({ entryId: "mem-1", status: "not_found", reason: "user_request" }),
  });

  registerMainIpcHandlers(ipcMain, deps);

  assert.deepEqual(await handlers.get(WITHMATE_GET_MEMORY_V6_FILE_USAGE_CHANNEL)?.({}), { usedBytes: 0 });
  assert.deepEqual(await handlers.get(WITHMATE_EXPORT_MEMORY_V6_ENTRY_FILES_CHANNEL)?.({}, "mem-1"), {
    entryId: "mem-1",
    exportedCount: 1,
  });
  assert.deepEqual(await handlers.get(WITHMATE_RUN_MEMORY_V6_PROTECTED_OBJECT_GC_CHANNEL)?.({}, { dryRun: true }), {
    dryRun: true,
  });
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

test("Memory V6 Review protected object IPC は通常 window からの呼び出しを拒否する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const homeWindow = createWindowStub("http://localhost:5173/");
  const { deps, calls } = createDeps({
    resolveEventWindow: () => homeWindow,
    isMemoryV6ReviewWindow: () => false,
    getMemoryV6FileUsage: async () => {
      calls.push("usage");
      return {};
    },
    exportMemoryV6EntryFiles: async () => {
      calls.push("export");
      return null;
    },
    runMemoryV6ProtectedObjectGc: async () => {
      calls.push("gc");
      return {};
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  await assert.rejects(
    () => handlers.get(WITHMATE_GET_MEMORY_V6_FILE_USAGE_CHANNEL)?.({}) as Promise<unknown>,
    /Memory V6 Review IPC is only available/,
  );
  await assert.rejects(
    () => handlers.get(WITHMATE_EXPORT_MEMORY_V6_ENTRY_FILES_CHANNEL)?.({}, "mem-1") as Promise<unknown>,
    /Memory V6 Review IPC is only available/,
  );
  await assert.rejects(
    () => handlers.get(WITHMATE_RUN_MEMORY_V6_PROTECTED_OBJECT_GC_CHANNEL)?.({}, { dryRun: true }) as Promise<unknown>,
    /Memory V6 Review IPC is only available/,
  );
  assert.equal(calls.includes("usage"), false);
  assert.equal(calls.includes("export"), false);
  assert.equal(calls.includes("gc"), false);
});

test("Storage Maintenance の bulk session delete IPC は Settings window からだけ呼び出せる", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const settingsWindow = createWindowStub("http://localhost:5173/?mode=settings");
  const { deps, calls } = createDeps({
    resolveEventWindow: () => settingsWindow,
    isSettingsWindow: (window: unknown) => window === settingsWindow,
    deleteSessionsLastActiveBefore: async () => {
      calls.push("deleteSessionsLastActiveBefore");
      return { deletedSessionIds: ["session-1"], skippedRunningSessionIds: [] };
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  assert.deepEqual(
    await handlers.get(WITHMATE_DELETE_SESSIONS_LAST_ACTIVE_BEFORE_CHANNEL)?.(
      {},
      { cutoffDate: "2026-07-01" },
    ),
    { deletedSessionIds: ["session-1"], skippedRunningSessionIds: [] },
  );
  assert.deepEqual(calls, ["deleteSessionsLastActiveBefore"]);
});

test("single session delete IPC は Home / Settings / 対象 Session window から呼び出せる", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const homeWindow = createWindowStub("http://localhost:5173/");
  const settingsWindow = createWindowStub("http://localhost:5173/?mode=settings");
  const sessionWindow = createWindowStub("http://localhost:5173/?mode=agent&sessionId=session-1");
  let eventWindow: unknown = homeWindow;
  const { deps, calls } = createDeps({
    resolveEventWindow: () => eventWindow,
    resolveHomeWindow: () => homeWindow,
    resolveSessionWindow: (sessionId: string) => sessionId === "session-1" ? sessionWindow : null,
    isSettingsWindow: (window: unknown) => window === settingsWindow,
    deleteSession: async (sessionId: string) => {
      calls.push(`deleteSession:${sessionId}`);
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  await handlers.get(WITHMATE_DELETE_SESSION_CHANNEL)?.({}, "session-1");
  eventWindow = settingsWindow;
  await handlers.get(WITHMATE_DELETE_SESSION_CHANNEL)?.({}, "session-1");
  eventWindow = sessionWindow;
  await handlers.get(WITHMATE_DELETE_SESSION_CHANNEL)?.({}, "session-1");

  assert.deepEqual(calls, [
    "deleteSession:session-1",
    "deleteSession:session-1",
    "deleteSession:session-1",
  ]);
});

test("single session delete IPC は許可されていない window からの呼び出しを拒否する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const otherWindow = createWindowStub("http://localhost:5173/?mode=memory-review");
  const homeWindow = createWindowStub("http://localhost:5173/");
  const sessionWindow = createWindowStub("http://localhost:5173/?mode=agent&sessionId=session-1");
  const { deps, calls } = createDeps({
    resolveEventWindow: () => otherWindow,
    resolveHomeWindow: () => homeWindow,
    resolveSessionWindow: (sessionId: string) => sessionId === "session-1" ? sessionWindow : null,
    isSettingsWindow: () => false,
    deleteSession: async (sessionId: string) => {
      calls.push(`deleteSession:${sessionId}`);
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  await assert.rejects(
    () => handlers.get(WITHMATE_DELETE_SESSION_CHANNEL)?.({}, "session-1") as Promise<unknown>,
    /Session delete IPC is only available/,
  );
  assert.equal(calls.includes("deleteSession:session-1"), false);
});

test("Storage Maintenance の bulk session delete IPC は Settings window 以外からの呼び出しを拒否する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const homeWindow = createWindowStub("http://localhost:5173/");
  const { deps, calls } = createDeps({
    resolveEventWindow: () => homeWindow,
    isSettingsWindow: () => false,
    deleteSessionsLastActiveBefore: async () => {
      calls.push("deleteSessionsLastActiveBefore");
      return { deletedSessionIds: ["session-1"], skippedRunningSessionIds: [] };
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  await assert.rejects(
    () => handlers.get(WITHMATE_DELETE_SESSIONS_LAST_ACTIVE_BEFORE_CHANNEL)?.(
      {},
      { cutoffDate: "2026-07-01" },
    ) as Promise<unknown>,
    /Settings IPC is only available/,
  );
  assert.equal(calls.includes("deleteSessionsLastActiveBefore"), false);
});

test("DB reset IPC は Settings window からだけ呼び出せる", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const settingsWindow = createWindowStub("http://localhost:5173/?mode=settings");
  const { deps, calls } = createDeps({
    resolveEventWindow: () => settingsWindow,
    isSettingsWindow: (window: unknown) => window === settingsWindow,
    resetAppDatabase: async () => {
      calls.push("resetAppDatabase");
      return { ok: true };
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  assert.deepEqual(
    await handlers.get(WITHMATE_RESET_APP_DATABASE_CHANNEL)?.(
      {},
      { targets: ["sessions"] },
    ),
    { ok: true },
  );
  assert.deepEqual(calls, ["resetAppDatabase"]);
});

test("DB reset IPC は Settings window 以外からの呼び出しを拒否する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const homeWindow = createWindowStub("http://localhost:5173/");
  const { deps, calls } = createDeps({
    resolveEventWindow: () => homeWindow,
    isSettingsWindow: () => false,
    resetAppDatabase: async () => {
      calls.push("resetAppDatabase");
      return { ok: true };
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  await assert.rejects(
    () => handlers.get(WITHMATE_RESET_APP_DATABASE_CHANNEL)?.(
      {},
      { targets: ["sessions"] },
    ) as Promise<unknown>,
    /Settings IPC is only available/,
  );
  assert.equal(calls.includes("resetAppDatabase"), false);
});

test("Auxiliary mutation/run IPC は対象 Session / Companion Review window から呼び出せる", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const sessionWindow = createWindowStub("http://localhost:5173/?mode=agent&sessionId=session-1");
  const companionReviewWindow = createWindowStub("http://localhost:5173/?mode=companion&sessionId=session-1");
  const auxiliarySession = createAuxiliarySessionStub();
  let eventWindow: unknown = sessionWindow;
  const { deps, calls } = createDeps({
    resolveEventWindow: () => eventWindow,
    resolveSessionWindow: (sessionId: string) => sessionId === "session-1" ? sessionWindow : null,
    resolveCompanionReviewWindow: (sessionId: string) =>
      sessionId === "session-1" ? companionReviewWindow : null,
    getAuxiliarySession: async (auxiliarySessionId: string) => {
      calls.push(`getAuxiliarySession:${auxiliarySessionId}`);
      return auxiliarySession;
    },
    createAuxiliarySession: async () => {
      calls.push("createAuxiliarySession");
      return auxiliarySession;
    },
    updateAuxiliarySession: async () => {
      calls.push("updateAuxiliarySession");
      return auxiliarySession;
    },
    closeAuxiliarySession: async () => {
      calls.push("closeAuxiliarySession");
      return { ...auxiliarySession, status: "closed" };
    },
    runAuxiliarySessionTurn: async () => {
      calls.push("runAuxiliarySessionTurn");
      return { ...auxiliarySession, runState: "running" };
    },
    cancelAuxiliarySessionRun: async () => {
      calls.push("cancelAuxiliarySessionRun");
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  await handlers.get(WITHMATE_CREATE_AUXILIARY_SESSION_CHANNEL)?.({}, {
    parentSessionId: "session-1",
    provider: "codex",
  });
  await handlers.get(WITHMATE_UPDATE_AUXILIARY_SESSION_CHANNEL)?.({}, auxiliarySession);
  await handlers.get(WITHMATE_CLOSE_AUXILIARY_SESSION_CHANNEL)?.({}, "aux-1");
  eventWindow = companionReviewWindow;
  await handlers.get(WITHMATE_RUN_AUXILIARY_SESSION_TURN_CHANNEL)?.({}, "aux-1", { userMessage: "hello" });
  await handlers.get(WITHMATE_CANCEL_AUXILIARY_SESSION_RUN_CHANNEL)?.({}, "aux-1");

  assert.deepEqual(calls, [
    "createAuxiliarySession",
    "getAuxiliarySession:aux-1",
    "updateAuxiliarySession",
    "getAuxiliarySession:aux-1",
    "closeAuxiliarySession",
    "getAuxiliarySession:aux-1",
    "runAuxiliarySessionTurn",
    "getAuxiliarySession:aux-1",
    "cancelAuxiliarySessionRun",
  ]);
});

test("Auxiliary full read IPC は対象 Session / Companion Review window から呼び出せる", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const sessionWindow = createWindowStub("http://localhost:5173/?mode=agent&sessionId=session-1");
  const companionReviewWindow = createWindowStub("http://localhost:5173/?mode=companion&sessionId=session-1");
  const auxiliarySession = createAuxiliarySessionStub();
  let eventWindow: unknown = sessionWindow;
  const { deps, calls } = createDeps({
    resolveEventWindow: () => eventWindow,
    resolveSessionWindow: (sessionId: string) => sessionId === "session-1" ? sessionWindow : null,
    resolveCompanionReviewWindow: (sessionId: string) =>
      sessionId === "session-1" ? companionReviewWindow : null,
    getActiveAuxiliarySession: async (parentSessionId: string) => {
      calls.push(`getActiveAuxiliarySession:${parentSessionId}`);
      return auxiliarySession;
    },
    getAuxiliarySession: async (auxiliarySessionId: string) => {
      calls.push(`getAuxiliarySession:${auxiliarySessionId}`);
      return auxiliarySession;
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  assert.equal(await handlers.get(WITHMATE_GET_ACTIVE_AUXILIARY_SESSION_CHANNEL)?.({}, "session-1"), auxiliarySession);
  eventWindow = companionReviewWindow;
  assert.equal(await handlers.get(WITHMATE_GET_AUXILIARY_SESSION_CHANNEL)?.({}, "aux-1"), auxiliarySession);

  assert.deepEqual(calls, [
    "getActiveAuxiliarySession:session-1",
    "getAuxiliarySession:aux-1",
  ]);
});

test("Auxiliary mutation/run IPC は対象外 window から deps mutation/run に到達しない", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const sessionWindow = createWindowStub("http://localhost:5173/?mode=agent&sessionId=session-1");
  const companionReviewWindow = createWindowStub("http://localhost:5173/?mode=companion&sessionId=session-1");
  const auxiliarySession = createAuxiliarySessionStub();
  let eventWindow: unknown = createWindowStub("http://localhost:5173/");
  const mutationCalls: string[] = [];
  const { deps } = createDeps({
    resolveEventWindow: () => eventWindow,
    resolveSessionWindow: (sessionId: string) => sessionId === "session-1" ? sessionWindow : null,
    resolveCompanionReviewWindow: (sessionId: string) =>
      sessionId === "session-1" ? companionReviewWindow : null,
    getAuxiliarySession: async () => auxiliarySession,
    createAuxiliarySession: async () => {
      mutationCalls.push("createAuxiliarySession");
      return auxiliarySession;
    },
    updateAuxiliarySession: async () => {
      mutationCalls.push("updateAuxiliarySession");
      return auxiliarySession;
    },
    closeAuxiliarySession: async () => {
      mutationCalls.push("closeAuxiliarySession");
      return auxiliarySession;
    },
    runAuxiliarySessionTurn: async () => {
      mutationCalls.push("runAuxiliarySessionTurn");
      return auxiliarySession;
    },
    cancelAuxiliarySessionRun: async () => {
      mutationCalls.push("cancelAuxiliarySessionRun");
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  const unauthorizedWindows = [
    createWindowStub("http://localhost:5173/"),
    createWindowStub("http://localhost:5173/?mode=settings"),
    createWindowStub("http://localhost:5173/?mode=diff&token=diff-1"),
    createWindowStub("http://localhost:5173/?mode=monitor"),
  ];

  for (const window of unauthorizedWindows) {
    eventWindow = window;
    await assert.rejects(
      () => handlers.get(WITHMATE_CREATE_AUXILIARY_SESSION_CHANNEL)?.({}, {
        parentSessionId: "session-1",
        provider: "codex",
      }) as Promise<unknown>,
      /Auxiliary session IPC is only available/,
    );
    await assert.rejects(
      () => handlers.get(WITHMATE_UPDATE_AUXILIARY_SESSION_CHANNEL)?.({}, auxiliarySession) as Promise<unknown>,
      /Auxiliary session IPC is only available/,
    );
    await assert.rejects(
      () => handlers.get(WITHMATE_CLOSE_AUXILIARY_SESSION_CHANNEL)?.({}, "aux-1") as Promise<unknown>,
      /Auxiliary session IPC is only available/,
    );
    await assert.rejects(
      () => handlers.get(WITHMATE_RUN_AUXILIARY_SESSION_TURN_CHANNEL)?.(
        {},
        "aux-1",
        { userMessage: "hello" },
      ) as Promise<unknown>,
      /Auxiliary session IPC is only available/,
    );
    await assert.rejects(
      () => handlers.get(WITHMATE_CANCEL_AUXILIARY_SESSION_RUN_CHANNEL)?.({}, "aux-1") as Promise<unknown>,
      /Auxiliary session IPC is only available/,
    );
  }

  assert.deepEqual(mutationCalls, []);
});

test("Auxiliary full read IPC は対象外 window から full read を返さず、summary list は許可する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const homeWindow = createWindowStub("http://localhost:5173/");
  const sessionWindow = createWindowStub("http://localhost:5173/?mode=agent&sessionId=session-1");
  const companionReviewWindow = createWindowStub("http://localhost:5173/?mode=companion&sessionId=session-1");
  const auxiliarySession = createAuxiliarySessionStub();
  const fullReadCalls: string[] = [];
  const { deps } = createDeps({
    resolveEventWindow: () => homeWindow,
    resolveSessionWindow: (sessionId: string) => sessionId === "session-1" ? sessionWindow : null,
    resolveCompanionReviewWindow: (sessionId: string) =>
      sessionId === "session-1" ? companionReviewWindow : null,
    listAuxiliarySessions: async () => [createAuxiliarySessionStub({ messages: undefined, composerDraft: undefined })],
    getActiveAuxiliarySession: async () => {
      fullReadCalls.push("getActiveAuxiliarySession");
      return auxiliarySession;
    },
    getAuxiliarySession: async () => auxiliarySession,
  });

  registerMainIpcHandlers(ipcMain, deps);

  assert.equal(
    (await handlers.get(WITHMATE_LIST_AUXILIARY_SESSIONS_CHANNEL)?.({}, "session-1") as unknown[]).length,
    1,
  );
  await assert.rejects(
    () => handlers.get(WITHMATE_GET_ACTIVE_AUXILIARY_SESSION_CHANNEL)?.({}, "session-1") as Promise<unknown>,
    /Auxiliary session IPC is only available/,
  );
  await assert.rejects(
    () => handlers.get(WITHMATE_GET_AUXILIARY_SESSION_CHANNEL)?.({}, "aux-1") as Promise<unknown>,
    /Auxiliary session IPC is only available/,
  );
  assert.deepEqual(fullReadCalls, []);
});

test("Auxiliary update IPC は payload parent と既存 parent の不一致を拒否する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const sessionWindow = createWindowStub("http://localhost:5173/?mode=agent&sessionId=session-1");
  const auxiliarySession = createAuxiliarySessionStub();
  const { deps, calls } = createDeps({
    resolveEventWindow: () => sessionWindow,
    resolveSessionWindow: (sessionId: string) => sessionId === "session-1" ? sessionWindow : null,
    resolveCompanionReviewWindow: () => null,
    getAuxiliarySession: async () => auxiliarySession,
    updateAuxiliarySession: async () => {
      calls.push("updateAuxiliarySession");
      return auxiliarySession;
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  await assert.rejects(
    () => handlers.get(WITHMATE_UPDATE_AUXILIARY_SESSION_CHANNEL)?.(
      {},
      createAuxiliarySessionStub({ parentSessionId: "session-2" }),
    ) as Promise<unknown>,
    /Auxiliary Session parent mismatch/,
  );
  assert.equal(calls.includes("updateAuxiliarySession"), false);
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
