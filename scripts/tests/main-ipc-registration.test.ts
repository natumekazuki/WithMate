import assert from "node:assert/strict";
import test from "node:test";

import type { IpcMain } from "electron";

import {
  registerMainIpcHandlers,
} from "../../src-electron/main-ipc-registration.js";
import {
  WITHMATE_CANCEL_AUXILIARY_SESSION_RUN_CHANNEL,
  WITHMATE_CANCEL_SESSION_EXECUTION_CHANNEL,
  WITHMATE_CLOSE_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_CREATE_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_CREATE_CHARACTER_CHANNEL,
  WITHMATE_CREATE_MATE_CHANNEL,
  WITHMATE_CREATE_COMPANION_SESSION_CHANNEL,
  WITHMATE_CREATE_SESSION_CHANNEL,
  WITHMATE_ENQUEUE_SESSION_TURN_CHANNEL,
  WITHMATE_CREATE_PROMPT_TEMPLATE_CHANNEL,
  WITHMATE_DELETE_SESSION_CHANNEL,
  WITHMATE_DELETE_PROMPT_TEMPLATE_CHANNEL,
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
  WITHMATE_LIST_OPEN_ACTIVE_AUXILIARY_SESSION_SUMMARIES_CHANNEL,
  WITHMATE_LIST_SESSION_SUMMARIES_CHANNEL,
  WITHMATE_LIST_SESSION_TURN_EXECUTIONS_CHANNEL,
  WITHMATE_LIST_PROMPT_TEMPLATES_CHANNEL,
  WITHMATE_LIST_SESSION_FILE_ROOTS_CHANNEL,
  WITHMATE_LIST_SESSION_DIRECTORY_CHANNEL,
  WITHMATE_INSPECT_SESSION_FILE_CHANNEL,
  WITHMATE_READ_SESSION_FILE_CHUNK_CHANNEL,
  WITHMATE_OPEN_SESSION_FILE_CHANNEL,
  WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL,
  WITHMATE_GET_SESSION_FILE_PREVIEW_WINDOW_PAYLOAD_CHANNEL,
  WITHMATE_COPY_SESSION_FILE_PREVIEW_IMAGE_CHANNEL,
  WITHMATE_SHOW_SESSION_FILE_PREVIEW_IMAGE_CONTEXT_MENU_CHANNEL,
  WITHMATE_SHOW_MARKDOWN_LINK_CONTEXT_MENU_CHANNEL,
  WITHMATE_LIST_FILE_ROOT_CHANGES_CHANNEL,
  WITHMATE_GET_FILE_ROOT_DIFF_CHANNEL,
  WITHMATE_OPEN_CHARACTER_EDITOR_WINDOW_CHANNEL,
  WITHMATE_OPEN_SESSION_CHANNEL,
  WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL,
  WITHMATE_PICK_IMAGE_FILE_CHANNEL,
  WITHMATE_VALIDATE_SESSION_WORKSPACE_CHANNEL,
  WITHMATE_VALIDATE_WORKSPACE_DIRECTORY_CHANNEL,
  WITHMATE_RESET_APP_DATABASE_CHANNEL,
  WITHMATE_REGISTER_CODEX_SESSION_MCP_CHANNEL,
  WITHMATE_RESOLVE_LAUNCH_CHARACTER_CHANNEL,
  WITHMATE_RUN_AUXILIARY_SESSION_TURN_CHANNEL,
  WITHMATE_PREVIEW_COMPANION_COMPOSER_INPUT_CHANNEL,
  WITHMATE_RUN_COMPANION_SESSION_TURN_CHANNEL,
  WITHMATE_RUN_SESSION_TURN_CHANNEL,
  WITHMATE_UPDATE_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_UPDATE_CHAT_LAYOUT_PREFERENCE_CHANNEL,
  WITHMATE_UPDATE_PROMPT_TEMPLATE_CHANNEL,
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
    isFilePreviewWindow: () => false,
    getFilePreviewWindowResource: () => null,
    isFilePreviewTokenWindow: () => false,
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

function createSessionRequest(workspace: Record<string, unknown>) {
  return {
    rootSessionRole: "overall-coordinator",
    taskTitle: "Task",
    characterId: "character-1",
    character: "Character",
    characterIconPath: "",
    characterThemeColors: { main: "#111111", sub: "#222222" },
    workspace,
  };
}

test("registerMainIpcHandlers は保持する public IPC だけを登録する", () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const { deps } = createDeps();

  registerMainIpcHandlers(ipcMain, deps);

  assert.ok(handlers.has(WITHMATE_OPEN_SESSION_CHANNEL));
  assert.ok(handlers.has(WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL));
  assert.ok(handlers.has(WITHMATE_OPEN_CHARACTER_EDITOR_WINDOW_CHANNEL));
  assert.ok(handlers.has(WITHMATE_VALIDATE_WORKSPACE_DIRECTORY_CHANNEL));
  assert.ok(handlers.has(WITHMATE_LIST_SESSION_SUMMARIES_CHANNEL));
  assert.ok(handlers.has(WITHMATE_COPY_SESSION_FILE_PREVIEW_IMAGE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_SHOW_SESSION_FILE_PREVIEW_IMAGE_CONTEXT_MENU_CHANNEL));
  assert.ok(handlers.has(WITHMATE_SHOW_MARKDOWN_LINK_CONTEXT_MENU_CHANNEL));
  assert.ok(handlers.has(WITHMATE_LIST_FILE_ROOT_CHANGES_CHANNEL));
  assert.ok(handlers.has(WITHMATE_GET_FILE_ROOT_DIFF_CHANNEL));
  assert.ok(handlers.has(WITHMATE_GET_APP_SETTINGS_CHANNEL));
  assert.ok(handlers.has(WITHMATE_LIST_PROMPT_TEMPLATES_CHANNEL));
  assert.ok(handlers.has(WITHMATE_CREATE_PROMPT_TEMPLATE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_UPDATE_PROMPT_TEMPLATE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_DELETE_PROMPT_TEMPLATE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_UPDATE_CHAT_LAYOUT_PREFERENCE_CHANNEL));
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
  assert.equal(handlers.has("withmate:set-default-character"), false);
  assert.ok(handlers.has(WITHMATE_RESOLVE_LAUNCH_CHARACTER_CHANNEL));
  assert.ok(handlers.has(WITHMATE_CREATE_SESSION_CHANNEL));
  assert.ok(handlers.has(WITHMATE_DELETE_SESSION_CHANNEL));
  assert.ok(handlers.has(WITHMATE_DELETE_SESSIONS_LAST_ACTIVE_BEFORE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_RUN_SESSION_TURN_CHANNEL));
  assert.ok(handlers.has(WITHMATE_ENQUEUE_SESSION_TURN_CHANNEL));
  assert.ok(handlers.has(WITHMATE_LIST_SESSION_TURN_EXECUTIONS_CHANNEL));
  assert.ok(handlers.has(WITHMATE_CANCEL_SESSION_EXECUTION_CHANNEL));

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

test("workspace validation IPC は Home window だけから validation service を呼べる", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const homeWindow = createWindowStub("http://localhost:5173/");
  const otherWindow = createWindowStub("http://localhost:5173/?mode=settings");
  let eventWindow = homeWindow;
  const validatedPaths: unknown[] = [];
  const { deps } = createDeps({
    resolveEventWindow: () => eventWindow,
    resolveHomeWindow: () => homeWindow,
    validateWorkspaceDirectory: async (targetPath: unknown) => {
      validatedPaths.push(targetPath);
      return { valid: true };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  const handler = handlers.get(WITHMATE_VALIDATE_WORKSPACE_DIRECTORY_CHANNEL);

  assert.deepEqual(await handler?.({}, "C:\\workspace"), { valid: true });
  eventWindow = otherWindow;
  await assert.rejects(
    () => handler?.({}, "C:\\private") as Promise<unknown>,
    /only available from the Home window/,
  );
  assert.deepEqual(validatedPaths, ["C:\\workspace"]);
});

test("Session workspace validation IPC は対象 Session window の保存済み path だけを検証する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const sessionWindow = createWindowStub("http://localhost:5173/?mode=session&sessionId=session-1");
  const otherWindow = createWindowStub("http://localhost:5173/?mode=session&sessionId=session-2");
  let eventWindow = sessionWindow;
  const resolvedSessionIds: string[] = [];
  const validatedPaths: unknown[] = [];
  const { deps } = createDeps({
    resolveEventWindow: () => eventWindow,
    resolveSessionWindow: (sessionId: string) => sessionId === "session-1" ? sessionWindow : otherWindow,
    getSession: async (sessionId: string) => {
      resolvedSessionIds.push(sessionId);
      return sessionId === "session-1" ? { workspacePath: "C:\\session-workspace" } : null;
    },
    validateWorkspaceDirectory: async (targetPath: unknown) => {
      validatedPaths.push(targetPath);
      return { valid: true };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  const handler = handlers.get(WITHMATE_VALIDATE_SESSION_WORKSPACE_CHANNEL);

  assert.deepEqual(await handler?.({}, "session-1"), { valid: true });
  assert.deepEqual(resolvedSessionIds, ["session-1"]);
  assert.deepEqual(validatedPaths, ["C:\\session-workspace"]);

  eventWindow = otherWindow;
  await assert.rejects(
    () => handler?.({}, "session-1") as Promise<unknown>,
    /only available from the target Session window/,
  );
  assert.deepEqual(resolvedSessionIds, ["session-1"]);
  assert.deepEqual(validatedPaths, ["C:\\session-workspace"]);
});

test("GUI queue IPC は対象 Session window だけにenqueue/list/cancelを許可する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const sessionWindow = createWindowStub("http://localhost:5173/?mode=session&sessionId=session-1");
  const otherWindow = createWindowStub("http://localhost:5173/?mode=session&sessionId=session-2");
  let eventWindow = sessionWindow;
  const calls: unknown[] = [];
  const { deps } = createDeps({
    resolveEventWindow: () => eventWindow,
    resolveSessionWindow: (sessionId: string) => sessionId === "session-1" ? sessionWindow : otherWindow,
    enqueueSessionTurn: async (sessionId: string, request: unknown) => {
      calls.push(["enqueue", sessionId, request]);
      return { ok: true, execution: null };
    },
    listSessionTurnExecutions: (sessionId: string) => {
      calls.push(["list", sessionId]);
      return [];
    },
    cancelSessionExecution: async (sessionId: string, request: unknown) => {
      calls.push(["cancel", sessionId, request]);
      return { ok: true };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);

  const enqueueRequest = { userMessage: "next", clientRequestId: "request-1" };
  const cancelRequest = { executionId: "execution-1", clientRequestId: "cancel-1" };
  assert.deepEqual(
    await handlers.get(WITHMATE_ENQUEUE_SESSION_TURN_CHANNEL)?.({}, "session-1", enqueueRequest),
    { ok: true, execution: null },
  );
  assert.deepEqual(await handlers.get(WITHMATE_LIST_SESSION_TURN_EXECUTIONS_CHANNEL)?.({}, "session-1"), []);
  assert.deepEqual(
    await handlers.get(WITHMATE_CANCEL_SESSION_EXECUTION_CHANNEL)?.({}, "session-1", cancelRequest),
    { ok: true },
  );
  assert.deepEqual(calls, [
    ["enqueue", "session-1", enqueueRequest],
    ["list", "session-1"],
    ["cancel", "session-1", cancelRequest],
  ]);

  eventWindow = otherWindow;
  await assert.rejects(
    () => handlers.get(WITHMATE_ENQUEUE_SESSION_TURN_CHANNEL)?.({}, "session-1", enqueueRequest) as Promise<unknown>,
    /only available from the target Session window/,
  );
  assert.deepEqual(calls, [
    ["enqueue", "session-1", enqueueRequest],
    ["list", "session-1"],
    ["cancel", "session-1", cancelRequest],
  ]);
});

test("Session作成はworkspaceを検証し、退役済みCompanion作成はside effect前に拒否する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const homeWindow = createWindowStub("http://localhost:5173/");
  const otherWindow = createWindowStub("http://localhost:5173/?mode=settings");
  let eventWindow = homeWindow;
  const validatedPaths: unknown[] = [];
  const created: string[] = [];
  const { deps } = createDeps({
    resolveEventWindow: () => eventWindow,
    resolveHomeWindow: () => homeWindow,
    validateWorkspaceDirectory: async (targetPath: unknown) => {
      validatedPaths.push(targetPath);
      return targetPath === "C:\\valid" ? { valid: true } : { valid: false, reason: "missing" };
    },
    createSession: async () => {
      created.push("session");
      return {};
    },
    createCompanionSession: async () => {
      created.push("companion");
      return {};
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  const createSession = handlers.get(WITHMATE_CREATE_SESSION_CHANNEL);
  const createCompanion = handlers.get(WITHMATE_CREATE_COMPANION_SESSION_CHANNEL);
  const validSession = createSessionRequest({
    kind: "directory",
    label: "valid",
    path: "C:\\valid",
    branch: "main",
  });

  await createSession?.({}, validSession);
  await assert.rejects(
    () => createCompanion?.({}, { workspacePath: "C:\\valid" }) as Promise<unknown>,
    /Companion Mode is retired/,
  );
  assert.deepEqual(created, ["session"]);

  await assert.rejects(
    () => createSession?.({}, createSessionRequest({
      kind: "directory",
      label: "missing",
      path: "C:\\missing",
      branch: "",
    })) as Promise<unknown>,
    /Path not found\./,
  );
  await assert.rejects(
    () => createCompanion?.({}, { workspacePath: "C:\\missing" }) as Promise<unknown>,
    /Companion Mode is retired/,
  );
  assert.deepEqual(created, ["session"]);

  eventWindow = otherWindow;
  await assert.rejects(
    () => createSession?.({}, validSession) as Promise<unknown>,
    /only available from the Home window/,
  );
  await assert.rejects(
    () => createCompanion?.({}, { workspacePath: "C:\\valid" }) as Promise<unknown>,
    /only available from the Home window/,
  );
  assert.deepEqual(validatedPaths, ["C:\\valid", "C:\\missing"]);
  assert.deepEqual(created, ["session"]);
});

test("退役済みCompanionのpreviewとprovider turnはdepsへ到達しない", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const { deps, calls } = createDeps({
    previewCompanionComposerInput: async () => {
      calls.push("previewCompanionComposerInput");
      return {};
    },
    runCompanionSessionTurn: async () => {
      calls.push("runCompanionSessionTurn");
      return {};
    },
  });
  registerMainIpcHandlers(ipcMain, deps);

  await assert.rejects(
    () => handlers.get(WITHMATE_PREVIEW_COMPANION_COMPOSER_INPUT_CHANNEL)?.({}, "companion-1", "hello") as Promise<unknown>,
    /Companion provider execution is retired/,
  );
  await assert.rejects(
    () => handlers.get(WITHMATE_RUN_COMPANION_SESSION_TURN_CHANNEL)?.({}, "companion-1", { userMessage: "hello" }) as Promise<unknown>,
    /Companion provider execution is retired/,
  );
  assert.equal(calls.includes("previewCompanionComposerInput"), false);
  assert.equal(calls.includes("runCompanionSessionTurn"), false);
});

test("SessionFolder 作成 IPC は filesystem validation を行わず Home から作成できる", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const homeWindow = createWindowStub("http://localhost:5173/");
  let validationCount = 0;
  let creationCount = 0;
  const { deps } = createDeps({
    resolveEventWindow: () => homeWindow,
    resolveHomeWindow: () => homeWindow,
    validateWorkspaceDirectory: async () => {
      validationCount += 1;
      return { valid: true };
    },
    createSession: async () => {
      creationCount += 1;
      return {};
    },
  });
  registerMainIpcHandlers(ipcMain, deps);

  await handlers.get(WITHMATE_CREATE_SESSION_CHANNEL)?.(
    {},
    createSessionRequest({ kind: "session-folder" }),
  );

  assert.equal(validationCount, 0);
  assert.equal(creationCount, 1);
});

test("prompt template IPC は CRUD payload を専用 dependency へ渡す", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const received: unknown[] = [];
  const templates = [{ id: "template-1", name: "Review", prompt: "review it" }];
  const { deps } = createDeps({
    listPromptTemplates: () => templates,
    createPromptTemplate: (input: unknown) => {
      received.push({ kind: "create", input });
      return templates;
    },
    updatePromptTemplate: (input: unknown) => {
      received.push({ kind: "update", input });
      return templates;
    },
    deletePromptTemplate: (id: string) => {
      received.push({ kind: "delete", id });
      return [];
    },
  });
  registerMainIpcHandlers(ipcMain, deps);

  assert.deepEqual(await handlers.get(WITHMATE_LIST_PROMPT_TEMPLATES_CHANNEL)?.({}), templates);
  assert.deepEqual(
    await handlers.get(WITHMATE_CREATE_PROMPT_TEMPLATE_CHANNEL)?.({}, { name: "Review", prompt: "review it" }),
    templates,
  );
  assert.deepEqual(
    await handlers.get(WITHMATE_UPDATE_PROMPT_TEMPLATE_CHANNEL)?.({}, { id: "template-1", name: "Review", prompt: "review it" }),
    templates,
  );
  assert.deepEqual(await handlers.get(WITHMATE_DELETE_PROMPT_TEMPLATE_CHANNEL)?.({}, "template-1"), []);
  assert.deepEqual(received, [
    { kind: "create", input: { name: "Review", prompt: "review it" } },
    { kind: "update", input: { id: "template-1", name: "Review", prompt: "review it" } },
    { kind: "delete", id: "template-1" },
  ]);
});

test("pick-image-file IPC は Character icon purpose を伝播し、不正な purpose を拒否する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const calls: Array<{ initialPath: string | null; purpose: string }> = [];
  const { deps } = createDeps({
    pickImageFile: async (_targetWindow: unknown, initialPath: string | null, purpose: string) => {
      calls.push({ initialPath, purpose });
      return "C:/icons/a.png";
    },
  });

  registerMainIpcHandlers(ipcMain, deps);
  const handler = handlers.get(WITHMATE_PICK_IMAGE_FILE_CHANNEL);
  assert.ok(handler);

  assert.equal(
    await handler({}, "C:/icons/current.webp", "character-icon"),
    "C:/icons/a.png",
  );
  assert.deepEqual(calls, [{
    initialPath: "C:/icons/current.webp",
    purpose: "character-icon",
  }]);
  assert.equal(await handler({}, null), "C:/icons/a.png");
  assert.deepEqual(calls[1], {
    initialPath: null,
    purpose: "general",
  });
  await assert.rejects(
    async () => handler({}, null, "unsupported-purpose"),
    /画像選択の用途が不正です/,
  );
});

test("chat layout preference IPC は単一 target の列挙値だけを専用更新処理へ渡す", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const updates: unknown[] = [];
  const { deps } = createDeps({
    updateChatLayoutPreference: (update: unknown) => {
      updates.push(update);
      return { chatLayoutPreference: update };
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  assert.deepEqual(
    await handlers.get(WITHMATE_UPDATE_CHAT_LAYOUT_PREFERENCE_CHANNEL)?.({}, {
      target: "sidePane",
      value: "files",
    }),
    { chatLayoutPreference: { target: "sidePane", value: "files" } },
  );
  assert.deepEqual(
    await handlers.get(WITHMATE_UPDATE_CHAT_LAYOUT_PREFERENCE_CHANNEL)?.({}, {
      target: "header",
      value: "visible",
    }),
    { chatLayoutPreference: { target: "header", value: "visible" } },
  );
  assert.deepEqual(
    await handlers.get(WITHMATE_UPDATE_CHAT_LAYOUT_PREFERENCE_CHANNEL)?.({}, {
      target: "actionDock",
      value: "expanded",
    }),
    { chatLayoutPreference: { target: "actionDock", value: "expanded" } },
  );
  assert.deepEqual(
    await handlers.get(WITHMATE_UPDATE_CHAT_LAYOUT_PREFERENCE_CHANNEL)?.({}, {
      target: "priority",
      value: "dock-first",
    }),
    { chatLayoutPreference: { target: "priority", value: "dock-first" } },
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_UPDATE_CHAT_LAYOUT_PREFERENCE_CHANNEL)?.({}, {
        target: "header",
        value: "shown",
      }) as Promise<unknown>,
    /更新内容が不正/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_UPDATE_CHAT_LAYOUT_PREFERENCE_CHANNEL)?.({}, {
        target: "priority",
        value: "left-first",
      }) as Promise<unknown>,
    /更新内容が不正/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_UPDATE_CHAT_LAYOUT_PREFERENCE_CHANNEL)?.({}, {
        target: "actionDock",
        value: "expanded",
        sidePane: "context",
      }) as Promise<unknown>,
    /更新内容が不正/,
  );
  assert.deepEqual(updates, [
    { target: "sidePane", value: "files" },
    { target: "header", value: "visible" },
    { target: "actionDock", value: "expanded" },
    { target: "priority", value: "dock-first" },
  ]);
});

test("File Explorer IPC は owning Session window からだけ利用でき、Auxiliary ID を parent へ解決する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const ownerWindow = createWindowStub("file:///session.html?sessionId=session-1");
  const otherWindow = createWindowStub("file:///home.html");
  const previewWindow = createWindowStub("file:///file-preview.html?token=preview-1");
  const currentPreviewResource = {
    sessionId: "aux-1",
    absolutePath: "C:/outside/current.md",
  };
  let currentWindow = ownerWindow;
  const directoryRequests: unknown[] = [];
  const inspectRequests: unknown[] = [];
  const readRequests: unknown[] = [];
  const openRequests: unknown[] = [];
  const changesRequests: unknown[] = [];
  const diffRequests: unknown[] = [];
  const previewNavigationRequests: unknown[] = [];
  const { deps } = createDeps({
    resolveEventWindow: () => currentWindow,
    resolveSessionWindow: (sessionId: string) => sessionId === "session-1" ? ownerWindow : null,
    getSessionFileExplorerOwnerSessionId: async (sessionId: string) => sessionId === "aux-1" ? "session-1" : null,
    isFilePreviewWindow: (window: unknown, sessionId: string) => window === previewWindow && sessionId === "aux-1",
    getFilePreviewWindowResource: (window: unknown, sessionId: string) => (
      window === previewWindow && sessionId === "aux-1" ? currentPreviewResource : null
    ),
    isFilePreviewTokenWindow: (window: unknown, token: string) => window === previewWindow && token === "preview-1",
    openSessionFilePreviewWindow: async (request: unknown) => {
      previewNavigationRequests.push(request);
      return {
        status: "opened",
        targetType: "preview-window",
        disposition: "created",
        resource: { sessionId: "aux-1", rootId: "workspace", relativePath: "src/App.tsx" },
      };
    },
    getSessionFilePreviewWindowPayload: () => ({
      resource: currentPreviewResource,
      ownerSessionId: "session-1",
      windowTitle: "current.md",
    }),
    listSessionFileRoots: async () => [{ id: "workspace", kind: "workspace", label: "Workspace", displayPath: "C:/repo" }],
    listSessionDirectory: async (request: unknown) => {
      directoryRequests.push(request);
      return [];
    },
    inspectSessionFile: async (request: unknown) => {
      inspectRequests.push(request);
      return null;
    },
    readSessionFileChunk: async (request: unknown) => {
      readRequests.push(request);
      return null;
    },
    openSessionFile: async (request: unknown) => {
      openRequests.push(request);
      return { status: "opened", targetType: "local-path", target: "C:/repo/src/App.tsx" };
    },
    listFileRootChanges: async (request: unknown) => {
      changesRequests.push(request);
      return { status: "ok", entries: [] };
    },
    getFileRootDiff: async (request: unknown) => {
      diffRequests.push(request);
      return { status: "not-changed", message: "none" };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);

  assert.deepEqual(
    await handlers.get(WITHMATE_LIST_SESSION_FILE_ROOTS_CHANNEL)?.({}, "aux-1"),
    [{ id: "workspace", kind: "workspace", label: "Workspace", displayPath: "C:/repo" }],
  );
  const request = { sessionId: "aux-1", rootId: "workspace", relativePath: "src" };
  assert.deepEqual(await handlers.get(WITHMATE_LIST_SESSION_DIRECTORY_CHANNEL)?.({}, request), []);
  assert.deepEqual(directoryRequests, [request]);
  const openRequest = { sessionId: "aux-1", rootId: "workspace", relativePath: "src/App.tsx" };
  assert.deepEqual(await handlers.get(WITHMATE_OPEN_SESSION_FILE_CHANNEL)?.({}, openRequest), {
    status: "opened",
    targetType: "local-path",
    target: "C:/repo/src/App.tsx",
  });
  assert.deepEqual(openRequests, [openRequest]);
  const outsideResource = { sessionId: "aux-1", absolutePath: "C:/outside/current.md" };
  await assert.rejects(
    () => handlers.get(WITHMATE_INSPECT_SESSION_FILE_CHANNEL)?.({}, outsideResource) as Promise<unknown>,
    /current Preview resource/,
  );
  await assert.rejects(
    () => handlers.get(WITHMATE_READ_SESSION_FILE_CHUNK_CHANNEL)?.({}, {
      ...outsideResource,
      offset: 0,
      length: 1024,
    }) as Promise<unknown>,
    /current Preview resource/,
  );
  await assert.rejects(
    () => handlers.get(WITHMATE_OPEN_SESSION_FILE_CHANNEL)?.({}, outsideResource) as Promise<unknown>,
    /current Preview resource/,
  );
  await assert.rejects(
    () => handlers.get(WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL)?.({}, {
      kind: "resource",
      resource: outsideResource,
    }) as Promise<unknown>,
    /must be root-scoped/,
  );
  assert.deepEqual(inspectRequests, []);
  assert.deepEqual(readRequests, []);
  assert.deepEqual(openRequests, [openRequest]);
  const previewRequest = {
    kind: "resource",
    resource: openRequest,
    view: { kind: "diff", scope: "working-tree" },
  };
  assert.equal(
    (await handlers.get(WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL)?.({}, previewRequest) as { status: string }).status,
    "opened",
  );
  assert.deepEqual(previewNavigationRequests, [previewRequest]);
  await assert.rejects(
    () => handlers.get(WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL)?.({}, {
      ...previewRequest,
      view: { kind: "diff", scope: "invalid" },
    }) as Promise<unknown>,
    /view is invalid/,
  );
  const changesRequest = { sessionId: "aux-1", rootId: "workspace" };
  assert.deepEqual(await handlers.get(WITHMATE_LIST_FILE_ROOT_CHANGES_CHANNEL)?.({}, changesRequest), {
    status: "ok",
    entries: [],
  });
  assert.deepEqual(changesRequests, [changesRequest]);
  const diffRequest = {
    sessionId: "aux-1",
    rootId: "workspace",
    relativePath: "src/App.tsx",
    scope: "working-tree",
  };
  assert.deepEqual(await handlers.get(WITHMATE_GET_FILE_ROOT_DIFF_CHANNEL)?.({}, diffRequest), {
    status: "not-changed",
    message: "none",
  });
  assert.deepEqual(diffRequests, [diffRequest]);
  await assert.rejects(
    () => handlers.get(WITHMATE_LIST_FILE_ROOT_CHANGES_CHANNEL)?.({}, { sessionId: "aux-1", rootId: "" }) as Promise<unknown>,
    /File root changes request/,
  );
  assert.deepEqual(changesRequests, [changesRequest]);
  await assert.rejects(
    () => handlers.get(WITHMATE_GET_FILE_ROOT_DIFF_CHANNEL)?.({}, { ...diffRequest, scope: "unknown" }) as Promise<unknown>,
    /Git Diff request/,
  );
  assert.deepEqual(diffRequests, [diffRequest]);

  currentWindow = otherWindow;
  await assert.rejects(
    () => handlers.get(WITHMATE_LIST_SESSION_FILE_ROOTS_CHANNEL)?.({}, "aux-1") as Promise<unknown>,
    /owning Session window/,
  );
  await assert.rejects(
    () => handlers.get(WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL)?.({}, previewRequest) as Promise<unknown>,
    /owning Session window/,
  );
  await assert.rejects(
    () => handlers.get(WITHMATE_LIST_FILE_ROOT_CHANGES_CHANNEL)?.({}, changesRequest) as Promise<unknown>,
    /owning Session window/,
  );
  assert.deepEqual(changesRequests, [changesRequest]);
  await assert.rejects(
    () => handlers.get(WITHMATE_OPEN_SESSION_FILE_CHANNEL)?.({}, openRequest) as Promise<unknown>,
    /current Preview resource/,
  );
  currentWindow = previewWindow;
  assert.deepEqual(
    await handlers.get(WITHMATE_LIST_SESSION_FILE_ROOTS_CHANNEL)?.({}, "aux-1"),
    [{ id: "workspace", kind: "workspace", label: "Workspace", displayPath: "C:/repo" }],
  );
  await assert.rejects(
    () => handlers.get(WITHMATE_LIST_SESSION_DIRECTORY_CHANNEL)?.({}, request) as Promise<unknown>,
    /owning Session window/,
  );
  assert.deepEqual(directoryRequests, [request]);
  assert.deepEqual(
    await handlers.get(WITHMATE_GET_SESSION_FILE_PREVIEW_WINDOW_PAYLOAD_CHANNEL)?.({}, "preview-1"),
    {
      resource: currentPreviewResource,
      ownerSessionId: "session-1",
      windowTitle: "current.md",
    },
  );
  assert.equal(
    await handlers.get(WITHMATE_GET_SESSION_FILE_PREVIEW_WINDOW_PAYLOAD_CHANNEL)?.({}, "wrong-token"),
    null,
  );
  await assert.rejects(
    () => handlers.get(WITHMATE_LIST_FILE_ROOT_CHANGES_CHANNEL)?.({}, changesRequest) as Promise<unknown>,
    /current Preview resource/,
  );
  await assert.rejects(
    () => handlers.get(WITHMATE_GET_FILE_ROOT_DIFF_CHANNEL)?.({}, diffRequest) as Promise<unknown>,
    /current Preview resource/,
  );
  await assert.rejects(
    () => handlers.get(WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL)?.({}, previewRequest) as Promise<unknown>,
    /owning Session window/,
  );
  assert.equal(
    (await handlers.get(WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL)?.({}, {
      kind: "link",
      sessionId: "aux-1",
      target: "../outside.txt",
      baseResource: currentPreviewResource,
    }) as { status: string }).status,
    "opened",
  );
  await handlers.get(WITHMATE_INSPECT_SESSION_FILE_CHANNEL)?.({}, currentPreviewResource);
  assert.deepEqual(inspectRequests, [currentPreviewResource]);
  assert.deepEqual(
    await handlers.get(WITHMATE_OPEN_SESSION_FILE_CHANNEL)?.({}, currentPreviewResource),
    { status: "opened", targetType: "local-path", target: "C:/repo/src/App.tsx" },
  );
  await assert.rejects(
    () => handlers.get(WITHMATE_INSPECT_SESSION_FILE_CHANNEL)?.({}, {
      sessionId: "aux-1",
      absolutePath: "C:/outside/other.md",
    }) as Promise<unknown>,
    /current Preview resource/,
  );
  await assert.rejects(
    () => handlers.get(WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL)?.({}, {
      kind: "link",
      sessionId: "aux-1",
      target: "../outside.txt",
      baseResource: {
        sessionId: "aux-1",
        absolutePath: "C:/outside/other.md",
      },
    }) as Promise<unknown>,
    /current Preview resource as its base/,
  );
  await assert.rejects(
    () => handlers.get(WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL)?.({}, {
      kind: "link",
      sessionId: "aux-1",
      target: "../outside.txt",
      baseResource: {
        sessionId: "aux-1",
        absolutePath: "C:/outside/current.md",
        rootId: "workspace",
        relativePath: "current.md",
      },
    }) as Promise<unknown>,
    /File preview resource is invalid/,
  );
});

test("File Preview の Git IPC は current root file だけを投影する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const ownerWindow = createWindowStub("file:///session.html?sessionId=session-1");
  const previewWindow = createWindowStub("file:///file-preview.html?token=preview-1");
  const currentResource = {
    sessionId: "aux-1",
    rootId: "workspace",
    relativePath: "src/current.ts",
  };
  const diffRequests: unknown[] = [];
  const { deps } = createDeps({
    resolveEventWindow: () => previewWindow,
    resolveSessionWindow: (sessionId: string) => sessionId === "session-1" ? ownerWindow : null,
    getSessionFileExplorerOwnerSessionId: async (sessionId: string) => sessionId === "aux-1" ? "session-1" : null,
    getFilePreviewWindowResource: (window: unknown, sessionId: string) => (
      window === previewWindow && sessionId === "aux-1" ? currentResource : null
    ),
    listFileRootChanges: async () => ({
      status: "ok",
      entries: [
        { relativePath: "src/current.ts", previousRelativePath: null, kinds: { "working-tree": "modified" }, scopes: ["working-tree"] },
        { relativePath: "src/secret.ts", previousRelativePath: null, kinds: { "working-tree": "modified" }, scopes: ["working-tree"] },
      ],
    }),
    getFileRootDiff: async (request: unknown) => {
      diffRequests.push(request);
      return { status: "not-changed", message: "none" };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);

  assert.deepEqual(
    await handlers.get(WITHMATE_LIST_FILE_ROOT_CHANGES_CHANNEL)?.({}, {
      sessionId: "aux-1",
      rootId: "workspace",
    }),
    {
      status: "ok",
      entries: [{
        relativePath: "src/current.ts",
        previousRelativePath: null,
        kinds: { "working-tree": "modified" },
        scopes: ["working-tree"],
      }],
    },
  );
  const currentDiff = { ...currentResource, scope: "working-tree" };
  assert.deepEqual(
    await handlers.get(WITHMATE_GET_FILE_ROOT_DIFF_CHANNEL)?.({}, currentDiff),
    { status: "not-changed", message: "none" },
  );
  assert.deepEqual(diffRequests, [currentDiff]);
  await assert.rejects(
    () => handlers.get(WITHMATE_LIST_FILE_ROOT_CHANGES_CHANNEL)?.({}, {
      sessionId: "aux-1",
      rootId: "other-root",
    }) as Promise<unknown>,
    /current Preview resource/,
  );
  await assert.rejects(
    () => handlers.get(WITHMATE_GET_FILE_ROOT_DIFF_CHANNEL)?.({}, {
      ...currentDiff,
      relativePath: "src/secret.ts",
    }) as Promise<unknown>,
    /current Preview resource/,
  );
  assert.deepEqual(diffRequests, [currentDiff]);
});

test("画像copy IPCはowning Session windowと非負の整数座標だけを受け付ける", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const ownerWindow = createWindowStub("file:///session.html?sessionId=session-1");
  const otherWindow = createWindowStub("file:///home.html");
  let currentWindow = ownerWindow;
  const copyRequests: unknown[] = [];
  const menuRequests: unknown[] = [];
  const { deps } = createDeps({
    resolveEventWindow: () => currentWindow,
    resolveSessionWindow: (sessionId: string) => sessionId === "session-1" ? ownerWindow : null,
    getSessionFileExplorerOwnerSessionId: async (sessionId: string) => sessionId === "aux-1" ? "session-1" : null,
    copySessionFilePreviewImage: async (_event: unknown, request: unknown) => {
      copyRequests.push(request);
      return { status: "copied" };
    },
    showSessionFilePreviewImageContextMenu: async (_event: unknown, request: unknown) => {
      menuRequests.push(request);
      return { status: "dismissed" };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  const request = { sessionId: "aux-1", point: { x: 24, y: 48 } };

  assert.deepEqual(
    await handlers.get(WITHMATE_COPY_SESSION_FILE_PREVIEW_IMAGE_CHANNEL)?.({}, request),
    { status: "copied" },
  );
  assert.deepEqual(
    await handlers.get(WITHMATE_SHOW_SESSION_FILE_PREVIEW_IMAGE_CONTEXT_MENU_CHANNEL)?.({}, request),
    { status: "dismissed" },
  );
  assert.deepEqual(copyRequests, [request]);
  assert.deepEqual(menuRequests, [request]);

  for (const invalidRequest of [
    null,
    { sessionId: "aux-1", point: { x: -1, y: 2 } },
    { sessionId: "aux-1", point: { x: 1.5, y: 2 } },
    { sessionId: "aux-1", point: { x: 1, y: Number.NaN } },
  ]) {
    await assert.rejects(
      () => handlers.get(WITHMATE_COPY_SESSION_FILE_PREVIEW_IMAGE_CHANNEL)?.({}, invalidRequest) as Promise<unknown>,
      /Image copy request is invalid/,
    );
  }
  assert.deepEqual(copyRequests, [request]);

  currentWindow = otherWindow;
  await assert.rejects(
    () => handlers.get(WITHMATE_COPY_SESSION_FILE_PREVIEW_IMAGE_CHANNEL)?.({}, request) as Promise<unknown>,
    /owning Session window/,
  );
});

test("Markdown link context menu IPCはtarget文字列と非負の整数座標を変換せず渡す", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const sourceWindow = createWindowStub("file:///session.html?sessionId=session-1");
  let currentWindow: ReturnType<typeof createWindowStub> | null = sourceWindow;
  const requests: unknown[] = [];
  const { deps } = createDeps({
    resolveEventWindow: () => currentWindow,
    showMarkdownLinkContextMenu: async (_event: unknown, request: unknown) => {
      requests.push(request);
      return { status: "copied" };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  const request = {
    target: "file:///C:/tmp/candidate-source%20final.json",
    point: { x: 24, y: 48 },
  };

  assert.deepEqual(
    await handlers.get(WITHMATE_SHOW_MARKDOWN_LINK_CONTEXT_MENU_CHANNEL)?.({}, request),
    { status: "copied" },
  );
  assert.deepEqual(requests, [request]);

  for (const invalidRequest of [
    null,
    { target: "", point: { x: 1, y: 2 } },
    { target: "docs/review-brief.md", point: { x: -1, y: 2 } },
    { target: "docs/review-brief.md", point: { x: 1.5, y: 2 } },
  ]) {
    await assert.rejects(
      () => handlers.get(WITHMATE_SHOW_MARKDOWN_LINK_CONTEXT_MENU_CHANNEL)?.({}, invalidRequest) as Promise<unknown>,
      /Markdown link context menu request is invalid/,
    );
  }
  assert.deepEqual(requests, [request]);

  currentWindow = null;
  await assert.rejects(
    () => handlers.get(WITHMATE_SHOW_MARKDOWN_LINK_CONTEXT_MENU_CHANNEL)?.({}, request) as Promise<unknown>,
    /only available from a WithMate window/,
  );
  assert.deepEqual(requests, [request]);
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

test("run-session-turn IPC拒否ログは本文を含めずclient request IDを相関情報として渡す", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const errors: Array<{ channel: string; clientRequestId?: string }> = [];
  const { deps } = createDeps({
    runSessionTurn: async () => {
      throw new Error("このセッションはまだ実行中だよ。");
    },
    logIpcError: (input: { channel: string; clientRequestId?: string }) => {
      errors.push(input);
    },
  });
  registerMainIpcHandlers(ipcMain, deps);

  await assert.rejects(
    () => handlers.get(WITHMATE_RUN_SESSION_TURN_CHANNEL)?.({}, "session-1", {
      userMessage: "ログへ出してはいけない本文",
      clientRequestId: "7c26d875-9117-4ad5-97b5-e9af775b94bc",
    }) as Promise<unknown>,
    /まだ実行中/,
  );

  assert.deepEqual(errors.map(({ channel, clientRequestId }) => ({ channel, clientRequestId })), [{
    channel: WITHMATE_RUN_SESSION_TURN_CHANNEL,
    clientRequestId: "7c26d875-9117-4ad5-97b5-e9af775b94bc",
  }]);
  assert.doesNotMatch(JSON.stringify(errors), /ログへ出してはいけない本文/);

  await assert.rejects(
    () => handlers.get(WITHMATE_RUN_SESSION_TURN_CHANNEL)?.({}, "session-1", {
      userMessage: "please use secretprompt",
      clientRequestId: "secretprompt",
      submitSource: "secretprompt",
    }) as Promise<unknown>,
    /まだ実行中/,
  );
  assert.equal(errors.at(-1)?.clientRequestId, undefined);
  assert.doesNotMatch(JSON.stringify(errors.at(-1)), /secretprompt/);
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

test("Codex Session MCP registration IPC は Settings window からだけ呼び出せる", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const settingsWindow = createWindowStub("http://localhost:5173/?mode=settings");
  const homeWindow = createWindowStub("http://localhost:5173/");
  let eventWindow = settingsWindow;
  const { deps, calls } = createDeps({
    resolveEventWindow: () => eventWindow,
    isSettingsWindow: (window: unknown) => window === settingsWindow,
    registerCodexSessionMcp: async () => {
      calls.push("register");
      return { codexMcp: { status: "installed" } } as never;
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  assert.deepEqual(await handlers.get(WITHMATE_REGISTER_CODEX_SESSION_MCP_CHANNEL)?.({}), {
    codexMcp: { status: "installed" },
  });
  eventWindow = homeWindow;
  await assert.rejects(
    () => handlers.get(WITHMATE_REGISTER_CODEX_SESSION_MCP_CHANNEL)?.({}) as Promise<unknown>,
    /Settings IPC is only available/,
  );
  assert.deepEqual(calls, ["register", `log:${WITHMATE_REGISTER_CODEX_SESSION_MCP_CHANNEL}`]);
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

test("Auxiliary mutationはowner windowへ限定し、Companion Reviewからの新規runを拒否する", async () => {
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
    runtimeSelection: "latest-session",
  });
  await handlers.get(WITHMATE_UPDATE_AUXILIARY_SESSION_CHANNEL)?.({}, auxiliarySession);
  await handlers.get(WITHMATE_CLOSE_AUXILIARY_SESSION_CHANNEL)?.({}, "aux-1");
  await handlers.get(WITHMATE_RUN_AUXILIARY_SESSION_TURN_CHANNEL)?.({}, "aux-1", { userMessage: "hello" });
  eventWindow = companionReviewWindow;
  await assert.rejects(
    () => handlers.get(WITHMATE_RUN_AUXILIARY_SESSION_TURN_CHANNEL)?.({}, "aux-1", { userMessage: "hello" }) as Promise<unknown>,
    /Companion provider execution is retired/,
  );
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
    "log:withmate:run-auxiliary-session-turn",
    "getAuxiliarySession:aux-1",
    "cancelAuxiliarySessionRun",
  ]);
});

test("Auxiliary create IPC は送信元 window と runtime selection mode を結び付ける", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const sessionWindow = createWindowStub("http://localhost:5173/?mode=agent&sessionId=session-1");
  const companionReviewWindow = createWindowStub("http://localhost:5173/?mode=companion&sessionId=session-1");
  const auxiliarySession = createAuxiliarySessionStub();
  let eventWindow: unknown = sessionWindow;
  const forwardedInputs: unknown[] = [];
  const { deps } = createDeps({
    resolveEventWindow: () => eventWindow,
    resolveSessionWindow: (sessionId: string) => sessionId === "session-1" ? sessionWindow : null,
    resolveCompanionReviewWindow: (sessionId: string) =>
      sessionId === "session-1" ? companionReviewWindow : null,
    createAuxiliarySession: async (input: unknown) => {
      forwardedInputs.push(input);
      return auxiliarySession;
    },
  });

  registerMainIpcHandlers(ipcMain, deps);
  const createHandler = handlers.get(WITHMATE_CREATE_AUXILIARY_SESSION_CHANNEL);

  await assert.rejects(
    () => createHandler?.({}, {
      parentSessionId: "session-1",
      provider: "codex",
      runtimeSelection: "explicit",
      approvalMode: "never",
      codexSandboxMode: "danger-full-access",
    }) as Promise<unknown>,
    /requires latest-session runtime selection/,
  );
  await assert.rejects(
    () => createHandler?.({}, {
      parentSessionId: "session-1",
      provider: "codex",
      runtimeSelection: "latest-session",
      approvalMode: undefined,
    }) as Promise<unknown>,
    /cannot specify runtime options directly/,
  );
  await createHandler?.({}, {
    parentSessionId: "session-1",
    provider: "codex",
    runtimeSelection: "latest-session",
  });

  eventWindow = companionReviewWindow;
  await assert.rejects(
    () => createHandler?.({}, {
      parentSessionId: "session-1",
      provider: "codex",
      runtimeSelection: "latest-session",
    }) as Promise<unknown>,
    /Companion provider execution is retired/,
  );
  await assert.rejects(
    () => createHandler?.({}, {
      parentSessionId: "session-1",
      provider: "codex",
      runtimeSelection: "explicit",
      approvalMode: "never",
      codexSandboxMode: "danger-full-access",
    }) as Promise<unknown>,
    /Companion provider execution is retired/,
  );

  assert.deepEqual(forwardedInputs, [
    {
      parentSessionId: "session-1",
      provider: "codex",
      runtimeSelection: "latest-session",
    },
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

test("Home 用 Auxiliary summary IPC は main が確定した open parent scope の active summary だけを返す", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const {
    messages: _messages,
    composerDraft: _composerDraft,
    ...summary
  } = createAuxiliarySessionStub();
  const calls: string[] = [];
  const { deps } = createDeps({
    listOpenActiveAuxiliarySessionSummaries: async () => {
      calls.push("listOpenActiveAuxiliarySessionSummaries");
      return [summary];
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  assert.deepEqual(
    await handlers.get(WITHMATE_LIST_OPEN_ACTIVE_AUXILIARY_SESSION_SUMMARIES_CHANNEL)?.({}),
    [summary],
  );
  assert.deepEqual(calls, ["listOpenActiveAuxiliarySessionSummaries"]);
  assert.equal("messages" in summary, false);
  assert.equal("composerDraft" in summary, false);
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
