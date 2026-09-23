import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CHARACTER_THEME_COLORS } from "../../src-shared/character/character-state.js";
import type { DiffPreviewPayload } from "../../src-shared/session/session-state.js";
import { AuxWindowService } from "../../src-electron/auxiliary/aux-window-service.js";
import {
  CHARACTER_EDITOR_WINDOW_DEFAULT_BOUNDS,
  DIFF_WINDOW_DEFAULT_BOUNDS,
  FILE_PREVIEW_WINDOW_DEFAULT_BOUNDS,
} from "../../src-electron/windows/window-defaults.js";

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

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は singleton window を再利用する"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "singleton各windowの再利用・分類判定・close後のregistry解除を誤る"
// observable = "home/settings/memory-reviewのwindow identity、load mode列、生成数、close後の判定"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
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
    async loadCharacterEditorEntry() {},
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

// @test-value v2
// kind = "contract"
// claim = "起動状態を表示したWindowはentryを読み直さずHomeとして引き継がれる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window-startup" }
// fault = "Homeへの切替で別Windowを生成するか、表示中のentryを読み直して画面をちらつかせる"
// observable = "Window identity、Home registry、entry load回数、close後のregistry解除"
// observation_boundary = "public-boundary"
// scope = "AuxWindowService startup-to-Home handoff"
// lifecycle = "permanent"
// impact = "起動とHomeが二重表示されるか、切替時に描画が途切れる"
// distinction = "buildや単独renderer testではWindow identityとentry再loadの有無を確認できない"
// @end-test-value
test("AuxWindowService は起動WindowをHomeとして引き継ぐ", async () => {
  const startupWindow = createWindowStub();
  const modes: string[] = [];
  let createdWindows = 0;
  const service = new AuxWindowService({
    createWindow() {
      createdWindows += 1;
      return startupWindow.window;
    },
    async loadHomeEntry(window, mode) {
      assert.equal(window, startupWindow.window);
      modes.push(mode);
    },
    async loadDiffEntry() {},
    async loadFilePreviewEntry() {},
    async loadChatEntry() {},
    async loadCharacterEditorEntry() {},
    generateDiffToken() {
      return "diff-token";
    },
  });

  const homeWindow = await service.adoptHomeWindow(startupWindow.window);
  assert.equal(homeWindow, startupWindow.window);
  assert.equal(service.getHomeWindow(), startupWindow.window);
  assert.equal(await service.openHomeWindow(), startupWindow.window);
  assert.equal(createdWindows, 0);
  assert.deepEqual(modes, []);

  startupWindow.window.close();
  assert.equal(service.getHomeWindow(), null);
});

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は diff preview を保持し reset 時に close する"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "diff previewをregistryへ保存しないか、reset後もpreviewを残す"
// observable = "diff load token、preview取得結果、reset後のWindow destroyedとregistryのnull"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
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
    async loadCharacterEditorEntry() {},
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
  assert.equal(diffStub.window.isDestroyed(), true);
  assert.equal(service.getDiffPreview("diff-token"), null);
});

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は同じ file preview resource を再利用し close 後は作り直す"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "同一resourceを別windowとして重複生成するか、close後にregistry・payloadを残す"
// observable = "created/focused disposition、window identity、navigation payload、preview payload、生成数"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
test("AuxWindowService は同じ file preview resource を再利用し close 後は作り直す", async () => {
  const stubs: ReturnType<typeof createWindowStub>[] = [];
  const createdOptions: Array<Record<string, unknown>> = [];
  const previewLoads: string[] = [];
  const navigations: unknown[] = [];
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
    navigateFilePreviewWindow(_window, nextPayload) {
      navigations.push(nextPayload);
    },
    async loadChatEntry() {},
    async loadCharacterEditorEntry() {},
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
  const reused = await service.openFilePreviewWindow({
    ...payload,
    view: { kind: "diff", scope: "working-tree" },
  });

  assert.equal(first.disposition, "created");
  assert.equal(reused.disposition, "focused");
  assert.equal(first.window, reused.window);
  assert.equal(stubs.length, 1);
  assert.equal(stubs[0]?.getFocusCount(), 1);
  assert.deepEqual(service.getFilePreviewPayload("preview-1"), {
    ...payload,
    windowTitle: "file.ts",
    view: { kind: "diff", scope: "working-tree" },
  });
  assert.deepEqual(navigations, [{
    ...payload,
    windowTitle: "file.ts",
    view: { kind: "diff", scope: "working-tree" },
  }]);
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

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は file preview entry load 失敗時に registry と window を残さない"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "entry load失敗後に破棄済みwindowまたはpreview registryを残し、再試行を妨げる"
// observable = "reject error、destroyed state、preview payload null、再open disposition"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
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
    async loadCharacterEditorEntry() {},
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

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は commit file preview を root・repository・commit・path 単位で再利用する"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "repository・commit・pathの識別を混同し、異なるcommitを既存previewへ再利用する"
// observable = "root・repository・commit・pathの各識別子差分に対するcreated/focused disposition、window identity、stub生成数"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
test("AuxWindowService は commit file preview を repository・commit・path 単位で再利用する", async () => {
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
    async loadCharacterEditorEntry() {},
    generateDiffToken() {
      tokenSequence += 1;
      return `commit-preview-${tokenSequence}`;
    },
  });
  const resource = {
    resourceKind: "git-commit-file" as const,
    sessionId: "session-1",
    rootId: "workspace",
    repositoryId: "git:aaaaaaaaaaaaaaaaaaaaaaaa",
    commitId: "a".repeat(40),
    relativePath: "src/file.ts",
  };
  const first = await service.openFilePreviewWindow({
    resource,
    ownerSessionId: "session-1",
    windowTitle: "src/file.ts",
  });
  const reused = await service.openFilePreviewWindow({
    resource: { ...resource },
    ownerSessionId: "session-1",
    windowTitle: "src/file.ts",
  });
  const otherCommit = await service.openFilePreviewWindow({
    resource: { ...resource, commitId: "b".repeat(40) },
    ownerSessionId: "session-1",
    windowTitle: "src/file.ts",
  });
  const otherRoot = await service.openFilePreviewWindow({
    resource: { ...resource, rootId: "workspace-2" },
    ownerSessionId: "session-1",
    windowTitle: "src/file.ts",
  });
  const otherRepository = await service.openFilePreviewWindow({
    resource: { ...resource, repositoryId: "git:bbbbbbbbbbbbbbbbbbbbbbbb" },
    ownerSessionId: "session-1",
    windowTitle: "src/file.ts",
  });
  const otherPath = await service.openFilePreviewWindow({
    resource: { ...resource, relativePath: "src/other.ts" },
    ownerSessionId: "session-1",
    windowTitle: "src/other.ts",
  });

  assert.equal(first.disposition, "created");
  assert.equal(reused.disposition, "focused");
  assert.equal(reused.window, first.window);
  assert.equal(otherCommit.disposition, "created");
  assert.notEqual(otherCommit.window, first.window);
  assert.equal(otherRoot.disposition, "created");
  assert.equal(otherRepository.disposition, "created");
  assert.equal(otherPath.disposition, "created");
  assert.equal(stubs.length, 5);
});

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は absolute file preview を path 単位で再利用し close 後に破棄する"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "同一absolute pathを再利用せず、close後のpayloadを残す"
// observable = "created/focused disposition、window生成数、destroy後payload null、window title"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
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
    async loadCharacterEditorEntry() {},
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

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は大小文字だけが異なる absolute path を別 Preview として扱う"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "pathの大文字小文字を正規化しすぎて異なるPreviewを同一windowへ束ねる"
// observable = "各openのcreated disposition、window identity、stub生成数"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
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
    async loadCharacterEditorEntry() {},
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

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は literal backslash を含む canonical path を separator path と区別する"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "literal backslashとseparatorを同一pathとして扱いPreviewを誤って共有する"
// observable = "各openのcreated disposition、window identity、stub生成数"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
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
    async loadCharacterEditorEntry() {},
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

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は entry load 中に閉じた Session を opened 扱いにしない"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "entry load中のSession close後もopen処理を成功扱いし、window・payloadを残す"
// observable = "reject error、destroyed state、preview payload null"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
test("AuxWindowService は entry load 中に閉じた Session を opened 扱いにしない", async () => {
  const stubs: ReturnType<typeof createWindowStub>[] = [];
  const loadControl = { resolve: undefined as (() => void) | undefined };
  const load = new Promise<void>((resolve) => {
    loadControl.resolve = resolve;
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
    async loadCharacterEditorEntry() {},
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
  loadControl.resolve?.();

  await assert.rejects(opening, /Session is no longer active/);
  assert.equal(stubs[0]?.window.isDestroyed(), true);
  assert.equal(service.getFilePreviewPayload("delayed-preview"), null);
});

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は共有 entry load 中に閉じた Session を reused 扱いにしない"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "共有load中のSession close後に再利用処理を成功扱いし、registryを残す"
// observable = "両openのreject error、destroyed state、preview payload null"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
test("AuxWindowService は共有 entry load 中に閉じた Session を reused 扱いにしない", async () => {
  const stubs: ReturnType<typeof createWindowStub>[] = [];
  const loadControl = { resolve: undefined as (() => void) | undefined };
  const load = new Promise<void>((resolve) => {
    loadControl.resolve = resolve;
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
    async loadCharacterEditorEntry() {},
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
  loadControl.resolve?.();

  await assert.rejects(firstOpening, /Session is no longer active/);
  await assert.rejects(reusedOpening, /Session is no longer active/);
  assert.equal(stubs[0]?.window.isDestroyed(), true);
  assert.equal(service.getFilePreviewPayload("shared-delayed-preview"), null);
});

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は close 済み Session の遅延 file preview admission を拒否する"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "close済みSessionのpreview admissionを受け入れwindowやpayloadを作成する"
// observable = "reject error、stub生成数、preview payload null"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
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
    loadCharacterEditorEntry: async () => {},
    generateDiffToken: () => "preview-1",
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

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は reset 時に Memory Review window を close する"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "reset後もMemory Review windowをregistryに残しclose判定を誤る"
// observable = "destroyed state、Memory Review判定、home window一覧"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
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
    async loadCharacterEditorEntry() {},
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

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は Character Editor window を create/edit key ごとに再利用し、役割に合うtitleを付ける"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "create keyとedit keyのwindowを混同するか、同一keyを再利用しない"
// observable = "window identity、characterId load列、created optionsのtitle"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
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
    async loadCharacterEditorEntry(_window, characterId) {
      characterEditorLoads.push(characterId);
    },
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
      title: "New Character",
    },
    {
      ...CHARACTER_EDITOR_WINDOW_DEFAULT_BOUNDS,
      title: "Character Editor",
    },
  ]);
});
