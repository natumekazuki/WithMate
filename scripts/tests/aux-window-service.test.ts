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
  FILE_PREVIEW_WINDOW_DEFAULT_BOUNDS,
} from "../../src-electron/window-defaults.js";

function createWindowStub() {
  let destroyed = false;
  let minimized = false;
  let focusCount = 0;
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
      focus: () => {
        focusCount += 1;
      },
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
    getFocusCount() {
      return focusCount;
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
    async loadFilePreviewEntry() {},
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
    async loadFilePreviewEntry() {},
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

test("AuxWindowService は同じ file preview resource を再利用し close 後は作り直す", async () => {
  const stubs: ReturnType<typeof createWindowStub>[] = [];
  const createdOptions: Array<Record<string, unknown>> = [];
  const previewLoads: string[] = [];
  let tokenSequence = 0;
  const service = new AuxWindowService({
    createWindow(options) {
      createdOptions.push(options);
      const stub = createWindowStub();
      stubs.push(stub);
      return stub.window;
    },
    async loadHomeEntry() {},
    async loadDiffEntry() {},
    async loadFilePreviewEntry(_window, token) {
      previewLoads.push(token);
    },
    async loadChatEntry() {},
    async loadCompanionMergeReviewEntry() {},
    async loadCharacterEditorEntry() {},
    onCompanionReviewWindowsChanged() {},
    generateDiffToken() {
      tokenSequence += 1;
      return `preview-${tokenSequence}`;
    },
  });
  const payload = {
    resource: { sessionId: "session-1", rootId: "workspace", relativePath: "src/file.ts" },
    ownerSessionId: "session-1",
    windowTitle: "src/file.ts",
  };

  const first = await service.openFilePreviewWindow(payload);
  const reused = await service.openFilePreviewWindow(payload);

  assert.equal(first.disposition, "created");
  assert.equal(reused.disposition, "focused");
  assert.equal(first.window, reused.window);
  assert.equal(stubs.length, 1);
  assert.equal(stubs[0]?.getFocusCount(), 1);
  assert.deepEqual(service.getFilePreviewPayload("preview-1"), {
    ...payload,
    windowTitle: "file.ts",
  });
  assert.equal(service.isFilePreviewWindow(first.window, "session-1"), true);
  assert.deepEqual(service.getFilePreviewWindowResource(first.window, "session-1"), payload.resource);
  assert.equal(service.isFilePreviewTokenWindow(first.window, "preview-1"), true);

  const otherPayload = {
    resource: { sessionId: "session-1", rootId: "workspace", relativePath: "src/other.ts" },
    ownerSessionId: "session-1",
    windowTitle: "src/other.ts",
  };
  const other = await service.openFilePreviewWindow(otherPayload);
  assert.equal(other.disposition, "created");
  assert.notEqual(other.window, first.window);

  first.window.close();
  assert.equal(service.getFilePreviewPayload("preview-1"), null);
  const reopened = await service.openFilePreviewWindow(payload);
  assert.equal(reopened.disposition, "created");
  assert.notEqual(reopened.window, first.window);
  assert.deepEqual(previewLoads, ["preview-1", "preview-2", "preview-3"]);
  assert.deepEqual(createdOptions, [
    { ...FILE_PREVIEW_WINDOW_DEFAULT_BOUNDS, title: "file.ts" },
    { ...FILE_PREVIEW_WINDOW_DEFAULT_BOUNDS, title: "other.ts" },
    { ...FILE_PREVIEW_WINDOW_DEFAULT_BOUNDS, title: "file.ts" },
  ]);
  service.closeFilePreviewWindowsForSession("session-1");
  assert.equal(reopened.window.isDestroyed(), true);
  assert.equal(other.window.isDestroyed(), true);
  assert.equal(service.getFilePreviewPayload("preview-3"), null);
});

test("AuxWindowService は file preview entry load 失敗時に registry と window を残さない", async () => {
  const stubs: ReturnType<typeof createWindowStub>[] = [];
  const createdOptions: Array<Record<string, unknown>> = [];
  let loadShouldFail = true;
  const service = new AuxWindowService({
    createWindow(options) {
      createdOptions.push(options);
      const stub = createWindowStub();
      stubs.push(stub);
      return stub.window;
    },
    async loadHomeEntry() {},
    async loadDiffEntry() {},
    async loadFilePreviewEntry() {
      if (loadShouldFail) {
        throw new Error("entry load failed");
      }
    },
    async loadChatEntry() {},
    async loadCompanionMergeReviewEntry() {},
    async loadCharacterEditorEntry() {},
    onCompanionReviewWindowsChanged() {},
    generateDiffToken() {
      return `preview-${stubs.length}`;
    },
  });
  const payload = {
    resource: { sessionId: "session-1", rootId: "workspace", relativePath: "src/file.ts" },
    ownerSessionId: "session-1",
    windowTitle: "",
  };

  await assert.rejects(() => service.openFilePreviewWindow(payload), /entry load failed/);
  assert.equal(stubs[0]?.window.isDestroyed(), true);
  assert.equal(service.getFilePreviewPayload("preview-1"), null);

  loadShouldFail = false;
  const reopened = await service.openFilePreviewWindow(payload);
  assert.equal(reopened.disposition, "created");
  assert.equal(stubs.length, 2);
  assert.deepEqual(createdOptions, [
    { ...FILE_PREVIEW_WINDOW_DEFAULT_BOUNDS, title: "File Preview" },
    { ...FILE_PREVIEW_WINDOW_DEFAULT_BOUNDS, title: "File Preview" },
  ]);
  assert.equal(service.getFilePreviewPayload("preview-1")?.windowTitle, "File Preview");
});

test("AuxWindowService は absolute file preview を path 単位で再利用し close 後に破棄する", async () => {
  const stubs: ReturnType<typeof createWindowStub>[] = [];
  const createdOptions: Array<Record<string, unknown>> = [];
  let tokenSequence = 0;
  const service = new AuxWindowService({
    createWindow(options) {
      createdOptions.push(options);
      const stub = createWindowStub();
      stubs.push(stub);
      return stub.window;
    },
    async loadHomeEntry() {},
    async loadDiffEntry() {},
    async loadFilePreviewEntry() {},
    async loadChatEntry() {},
    async loadCompanionMergeReviewEntry() {},
    async loadCharacterEditorEntry() {},
    onCompanionReviewWindowsChanged() {},
    generateDiffToken() {
      tokenSequence += 1;
      return `absolute-preview-${tokenSequence}`;
    },
  });
  const payload = {
    resource: { sessionId: "session-1", absolutePath: "C:\\outside\\notes.md" },
    ownerSessionId: "session-1",
    windowTitle: "C:\\Users\\private\\notes.md",
  };

  const first = await service.openFilePreviewWindow(payload);
  const reused = await service.openFilePreviewWindow(payload);
  assert.equal(first.disposition, "created");
  assert.equal(reused.disposition, "focused");
  assert.equal(stubs.length, 1);
  first.window.close();
  assert.equal(service.getFilePreviewPayload("absolute-preview-1"), null);

  const reopened = await service.openFilePreviewWindow(payload);
  assert.equal(reopened.disposition, "created");
  assert.equal(stubs.length, 2);
  assert.deepEqual(createdOptions, [
    { ...FILE_PREVIEW_WINDOW_DEFAULT_BOUNDS, title: "notes.md" },
    { ...FILE_PREVIEW_WINDOW_DEFAULT_BOUNDS, title: "notes.md" },
  ]);
  assert.equal(service.getFilePreviewPayload("absolute-preview-2")?.windowTitle, "notes.md");
});

test("AuxWindowService は大小文字だけが異なる absolute path を別 Preview として扱う", async () => {
  const stubs: ReturnType<typeof createWindowStub>[] = [];
  let tokenSequence = 0;
  const service = new AuxWindowService({
    createWindow() {
      const stub = createWindowStub();
      stubs.push(stub);
      return stub.window;
    },
    async loadHomeEntry() {},
    async loadDiffEntry() {},
    async loadFilePreviewEntry() {},
    async loadChatEntry() {},
    async loadCompanionMergeReviewEntry() {},
    async loadCharacterEditorEntry() {},
    onCompanionReviewWindowsChanged() {},
    generateDiffToken() {
      tokenSequence += 1;
      return `case-preview-${tokenSequence}`;
    },
  });

  const upper = await service.openFilePreviewWindow({
    resource: { sessionId: "session-1", absolutePath: "C:\\case-sensitive\\Report.md" },
    ownerSessionId: "session-1",
    windowTitle: "Report.md",
  });
  const lower = await service.openFilePreviewWindow({
    resource: { sessionId: "session-1", absolutePath: "C:\\case-sensitive\\report.md" },
    ownerSessionId: "session-1",
    windowTitle: "report.md",
  });

  assert.equal(upper.disposition, "created");
  assert.equal(lower.disposition, "created");
  assert.notEqual(upper.window, lower.window);
  assert.equal(stubs.length, 2);
});

test("AuxWindowService は literal backslash を含む canonical path を separator path と区別する", async () => {
  const stubs: ReturnType<typeof createWindowStub>[] = [];
  let tokenSequence = 0;
  const service = new AuxWindowService({
    createWindow() {
      const stub = createWindowStub();
      stubs.push(stub);
      return stub.window;
    },
    async loadHomeEntry() {},
    async loadDiffEntry() {},
    async loadFilePreviewEntry() {},
    async loadChatEntry() {},
    async loadCompanionMergeReviewEntry() {},
    async loadCharacterEditorEntry() {},
    onCompanionReviewWindowsChanged() {},
    generateDiffToken() {
      tokenSequence += 1;
      return `separator-preview-${tokenSequence}`;
    },
  });

  const literalBackslash = await service.openFilePreviewWindow({
    resource: { sessionId: "session-1", absolutePath: "/tmp/a\\b" },
    ownerSessionId: "session-1",
    windowTitle: "a\\b",
  });
  const separatorPath = await service.openFilePreviewWindow({
    resource: { sessionId: "session-1", absolutePath: "/tmp/a/b" },
    ownerSessionId: "session-1",
    windowTitle: "b",
  });

  assert.equal(literalBackslash.disposition, "created");
  assert.equal(separatorPath.disposition, "created");
  assert.notEqual(literalBackslash.window, separatorPath.window);
  assert.equal(stubs.length, 2);
});

test("AuxWindowService は entry load 中に閉じた Session を opened 扱いにしない", async () => {
  const stubs: ReturnType<typeof createWindowStub>[] = [];
  let finishLoad: (() => void) | null = null;
  const load = new Promise<void>((resolve) => {
    finishLoad = resolve;
  });
  const service = new AuxWindowService({
    createWindow() {
      const stub = createWindowStub();
      stubs.push(stub);
      return stub.window;
    },
    async loadHomeEntry() {},
    async loadDiffEntry() {},
    async loadFilePreviewEntry() {
      await load;
    },
    async loadChatEntry() {},
    async loadCompanionMergeReviewEntry() {},
    async loadCharacterEditorEntry() {},
    onCompanionReviewWindowsChanged() {},
    generateDiffToken() {
      return "delayed-preview";
    },
  });
  const opening = service.openFilePreviewWindow({
    resource: { sessionId: "session-1", absolutePath: "C:\\outside\\notes.md" },
    ownerSessionId: "session-1",
    windowTitle: "notes.md",
  });

  service.closeFilePreviewWindowsForSession("session-1");
  finishLoad?.();

  await assert.rejects(opening, /Session is no longer active/);
  assert.equal(stubs[0]?.window.isDestroyed(), true);
  assert.equal(service.getFilePreviewPayload("delayed-preview"), null);
});

test("AuxWindowService は共有 entry load 中に閉じた Session を reused 扱いにしない", async () => {
  const stubs: ReturnType<typeof createWindowStub>[] = [];
  let finishLoad: (() => void) | null = null;
  const load = new Promise<void>((resolve) => {
    finishLoad = resolve;
  });
  const service = new AuxWindowService({
    createWindow() {
      const stub = createWindowStub();
      stubs.push(stub);
      return stub.window;
    },
    async loadHomeEntry() {},
    async loadDiffEntry() {},
    async loadFilePreviewEntry() {
      await load;
    },
    async loadChatEntry() {},
    async loadCompanionMergeReviewEntry() {},
    async loadCharacterEditorEntry() {},
    onCompanionReviewWindowsChanged() {},
    generateDiffToken() {
      return "shared-delayed-preview";
    },
  });
  const payload = {
    resource: { sessionId: "session-1", absolutePath: "C:\\outside\\notes.md" },
    ownerSessionId: "session-1",
    windowTitle: "notes.md",
  };
  const firstOpening = service.openFilePreviewWindow(payload);
  const reusedOpening = service.openFilePreviewWindow(payload);

  service.closeFilePreviewWindowsForSession("session-1");
  finishLoad?.();

  await assert.rejects(firstOpening, /Session is no longer active/);
  await assert.rejects(reusedOpening, /Session is no longer active/);
  assert.equal(stubs[0]?.window.isDestroyed(), true);
  assert.equal(service.getFilePreviewPayload("shared-delayed-preview"), null);
});

test("AuxWindowService は close 済み Session の遅延 file preview admission を拒否する", async () => {
  const stubs: Array<ReturnType<typeof createWindowStub>> = [];
  const service = new AuxWindowService({
    createWindow() {
      const stub = createWindowStub();
      stubs.push(stub);
      return stub.window;
    },
    loadHomeEntry: async () => {},
    loadDiffEntry: async () => {},
    loadFilePreviewEntry: async () => {},
    loadChatEntry: async () => {},
    loadCompanionMergeReviewEntry: async () => {},
    loadCharacterEditorEntry: async () => {},
    generateDiffToken: () => "preview-1",
    onCompanionReviewWindowsChanged: () => {},
  });
  const payload = {
    resource: { sessionId: "aux-1", rootId: "workspace", relativePath: "src/file.ts" },
    ownerSessionId: "session-1",
    windowTitle: "file.ts",
  };

  service.closeFilePreviewWindowsForSession("aux-1");

  await assert.rejects(
    () => service.openFilePreviewWindow(payload),
    /Session is no longer active/,
  );
  assert.equal(stubs.length, 0);
  assert.equal(service.getFilePreviewPayload("preview-1"), null);
});

test("AuxWindowService は reset 時に Memory Review window を close する", async () => {
  const service = new AuxWindowService({
    createWindow() {
      const stub = createWindowStub();
      return stub.window;
    },
    async loadHomeEntry() {},
    async loadDiffEntry() {},
    async loadFilePreviewEntry() {},
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
    async loadFilePreviewEntry() {},
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
    async loadFilePreviewEntry() {},
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
