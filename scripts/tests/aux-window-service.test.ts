import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CHARACTER_THEME_COLORS } from "../../src/character-state.js";
import type { DiffPreviewPayload } from "../../src/session-state.js";
import { AuxWindowService } from "../../src-electron/aux-window-service.js";
import {
  CHARACTER_EDITOR_WINDOW_DEFAULT_BOUNDS,
  COMPANION_CHAT_WINDOW_DEFAULT_BOUNDS,
  COMPANION_REVIEW_WINDOW_DEFAULT_BOUNDS,
  DIFF_WINDOW_DEFAULT_BOUNDS,
} from "../../src-electron/window-defaults.js";

function createWindowStub() {
  let destroyed = false;
  let minimized = false;
  const events = new Map<string, Array<() => void>>();
  return {
    window: {
      async loadURL() {},
      async loadFile() {},
      isDestroyed: () => destroyed,
      isMinimized: () => minimized,
      restore: () => {
        minimized = false;
      },
      focus: () => {},
      show: () => {},
      close: () => {
        destroyed = true;
        for (const listener of events.get("closed") ?? []) {
          listener();
        }
      },
      setAlwaysOnTop: () => {},
      once: (event: "ready-to-show", listener: () => void) => {
        const listeners = events.get(event) ?? [];
        listeners.push(listener);
        events.set(event, listeners);
      },
      on: (event: "closed", listener: () => void) => {
        const listeners = events.get(event) ?? [];
        listeners.push(listener);
        events.set(event, listeners);
      },
    },
    setMinimized(value: boolean) {
      minimized = value;
    },
  };
}

function createDiffPreview(): DiffPreviewPayload {
  return {
    file: {
      kind: "edit",
      path: "src/file.ts",
      summary: "diff",
      diffRows: [
        { kind: "delete", leftNumber: 1, leftText: "old" },
        { kind: "add", rightNumber: 1, rightText: "new" },
      ],
    },
    title: "diff",
    themeColors: DEFAULT_CHARACTER_THEME_COLORS,
  };
}

test("AuxWindowService は singleton window を再利用する", async () => {
  const created: unknown[] = [];
  const homeLoads: string[] = [];
  const service = new AuxWindowService({
    createWindow() {
      const stub = createWindowStub();
      created.push(stub.window);
      return stub.window;
    },
    async loadHomeEntry(_window, mode) {
      homeLoads.push(mode);
    },
    async loadDiffEntry() {},
    async loadChatEntry() {},
    async loadCompanionMergeReviewEntry() {},
    async loadCharacterEditorEntry() {},
    onCompanionReviewWindowsChanged() {},
    generateDiffToken() {
      return "diff-token";
    },
  });

  const first = await service.openHomeWindow();
  const second = await service.openHomeWindow();
  const settings = await service.openSettingsWindow();
  const memoryReview = await service.openMemoryV6ReviewWindow();

  assert.equal(first, second);
  assert.notEqual(first, settings);
  assert.notEqual(settings, memoryReview);
  assert.equal(service.isSettingsWindow(settings), true);
  assert.equal(service.isSettingsWindow(memoryReview), false);
  assert.equal(service.isMemoryV6ReviewWindow(memoryReview), true);
  assert.equal(service.isMemoryV6ReviewWindow(settings), false);
  assert.deepEqual(homeLoads, ["home", "settings", "memory-review"]);
  assert.equal(created.length, 3);
  memoryReview.close();
  assert.equal(service.isMemoryV6ReviewWindow(memoryReview), false);
  settings.close();
  assert.equal(service.isSettingsWindow(settings), false);
});

test("AuxWindowService は diff preview を保持し reset 時に close する", async () => {
  const diffLoads: string[] = [];
  const diffStub = createWindowStub();
  const createdOptions: Array<Record<string, unknown>> = [];
  const service = new AuxWindowService({
    createWindow(options) {
      createdOptions.push(options);
      return diffStub.window;
    },
    async loadHomeEntry() {},
    async loadDiffEntry(_window, token) {
      diffLoads.push(token);
    },
    async loadChatEntry() {},
    async loadCompanionMergeReviewEntry() {},
    async loadCharacterEditorEntry() {},
    onCompanionReviewWindowsChanged() {},
    generateDiffToken() {
      return "diff-token";
    },
  });

  await service.openDiffWindow(createDiffPreview());
  assert.ok(service.getDiffPreview("diff-token"));
  assert.deepEqual(diffLoads, ["diff-token"]);
  assert.deepEqual(createdOptions, [
    {
      ...DIFF_WINDOW_DEFAULT_BOUNDS,
      title: "Diff - src/file.ts",
    },
  ]);

  service.closeResetTargetWindows();
  assert.equal(service.getDiffPreview("diff-token"), null);
});

test("AuxWindowService は reset 時に Memory Review window を close する", async () => {
  const service = new AuxWindowService({
    createWindow() {
      const stub = createWindowStub();
      return stub.window;
    },
    async loadHomeEntry() {},
    async loadDiffEntry() {},
    async loadChatEntry() {},
    async loadCompanionMergeReviewEntry() {},
    async loadCharacterEditorEntry() {},
    onCompanionReviewWindowsChanged() {},
    generateDiffToken() {
      return "diff-token";
    },
  });

  const memoryReview = await service.openMemoryV6ReviewWindow();
  assert.equal(service.isMemoryV6ReviewWindow(memoryReview), true);

  service.closeResetTargetWindows();

  assert.equal(memoryReview.isDestroyed(), true);
  assert.equal(service.isMemoryV6ReviewWindow(memoryReview), false);
  assert.deepEqual(service.listHomeWindows(), []);
});

test("AuxWindowService は companion chat と merge の entry を分けて開く", async () => {
  const chatLoads: unknown[] = [];
  const companionMergeLoads: string[] = [];
  let companionReviewWindowChangeCount = 0;
  const createdOptions: Array<Record<string, unknown>> = [];
  const service = new AuxWindowService({
    createWindow(options) {
      const stub = createWindowStub();
      createdOptions.push(options);
      return stub.window;
    },
    async loadHomeEntry() {},
    async loadDiffEntry() {},
    async loadChatEntry(_window, mode) {
      chatLoads.push(mode);
    },
    async loadCompanionMergeReviewEntry(_window, sessionId) {
      companionMergeLoads.push(sessionId);
    },
    async loadCharacterEditorEntry() {},
    onCompanionReviewWindowsChanged() {
      companionReviewWindowChangeCount += 1;
    },
    generateDiffToken() {
      return "diff-token";
    },
  });

  const chat = await service.openCompanionReviewWindow("companion-1");
  const chatReopened = await service.openCompanionReviewWindow("companion-1");
  const merge = await service.openCompanionMergeWindow("companion-1");
  const mergeReopened = await service.openCompanionMergeWindow("companion-1");

  assert.equal(chat, chatReopened);
  assert.equal(merge, mergeReopened);
  assert.notEqual(chat, merge);
  assert.deepEqual(service.listOpenCompanionReviewWindowIds(), ["companion-1"]);
  assert.equal(companionReviewWindowChangeCount, 1);
  assert.deepEqual(chatLoads, [{ kind: "companion", sessionId: "companion-1" }]);
  assert.deepEqual(companionMergeLoads, ["companion-1"]);
  assert.deepEqual(createdOptions, [
    {
      ...COMPANION_CHAT_WINDOW_DEFAULT_BOUNDS,
      title: "Companion - companion-1",
    },
    {
      ...COMPANION_REVIEW_WINDOW_DEFAULT_BOUNDS,
      title: "Companion Merge - companion-1",
    },
  ]);
});

test("AuxWindowService は Character Editor window を create/edit key ごとに再利用する", async () => {
  const characterEditorLoads: Array<string | null | undefined> = [];
  const createdOptions: Array<Record<string, unknown>> = [];
  const service = new AuxWindowService({
    createWindow(options) {
      const stub = createWindowStub();
      createdOptions.push(options);
      return stub.window;
    },
    async loadHomeEntry() {},
    async loadDiffEntry() {},
    async loadChatEntry() {},
    async loadCompanionMergeReviewEntry() {},
    async loadCharacterEditorEntry(_window, characterId) {
      characterEditorLoads.push(characterId);
    },
    onCompanionReviewWindowsChanged() {},
    generateDiffToken() {
      return "diff-token";
    },
  });

  const createWindow = await service.openCharacterEditorWindow();
  const createWindowReopened = await service.openCharacterEditorWindow(null);
  const editWindow = await service.openCharacterEditorWindow("char-1");
  const editWindowReopened = await service.openCharacterEditorWindow("char-1");

  assert.equal(createWindow, createWindowReopened);
  assert.equal(editWindow, editWindowReopened);
  assert.notEqual(createWindow, editWindow);
  assert.deepEqual(characterEditorLoads, [null, "char-1"]);
  assert.deepEqual(createdOptions, [
    {
      ...CHARACTER_EDITOR_WINDOW_DEFAULT_BOUNDS,
      title: "WithMate New Character",
    },
    {
      ...CHARACTER_EDITOR_WINDOW_DEFAULT_BOUNDS,
      title: "WithMate Character Editor",
    },
  ]);
});
