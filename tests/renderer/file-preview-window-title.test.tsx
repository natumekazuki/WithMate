import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { DEFAULT_CHARACTER_THEME_COLORS } from "../../src-shared/character/character-state.js";
import DiffApp from "../../src/file-explorer/DiffApp.js";
import FilePreviewApp from "../../src/file-explorer/FilePreviewApp.js";
import {
  buildFileRootDiffPreviewWindowRequest,
  FILE_PREVIEW_WINDOW_TITLE_FALLBACK,
  resolveSessionFileGitCommitPreviewWindowTitle,
  resolveSessionFilePreviewWindowTitle,
  type SessionFileDescriptor,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { createDefaultAppSettings, type AppSettings } from "../../src-shared/settings/provider-settings-state.js";

test("resolveSessionFilePreviewWindowTitle は basename だけを返し不正な名前を fallback する", () => {
  assert.equal(resolveSessionFilePreviewWindowTitle("C:\\Users\\private\\notes.md"), "notes.md");
  assert.equal(resolveSessionFilePreviewWindowTitle("/home/private/notes.md"), "notes.md");
  assert.equal(resolveSessionFilePreviewWindowTitle(""), FILE_PREVIEW_WINDOW_TITLE_FALLBACK);
  assert.equal(resolveSessionFilePreviewWindowTitle(".."), FILE_PREVIEW_WINDOW_TITLE_FALLBACK);
  assert.equal(resolveSessionFilePreviewWindowTitle("unsafe\nname.md"), FILE_PREVIEW_WINDOW_TITLE_FALLBACK);
});

test("commit file previewのwindow titleは短縮commit hashを含む", () => {
  assert.equal(
    resolveSessionFileGitCommitPreviewWindowTitle("src/notes.md", "abcdef0123456789abcdef0123456789abcdef01"),
    "notes.md · abcdef0",
  );
});

// @test-value v2
// kind = "contract"
// claim = "独立file previewは設定を購読してpayloadをhydrateした後も対象ファイル名をdocument titleへ反映する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md" }
// fault = "設定購読追加によってpreviewのhydrateが失敗するか、window titleが対象ファイルへ同期されない"
// observable = "FilePreviewAppをmountして取得後のdocument.title"
// observation_boundary = "component-behavior"
// scope = "detached-file-preview-window-title"
// lifecycle = "permanent"
// distinction = "title解決関数の単体testでは検出できないWindow rootと非同期payload取得の接続を確認する"
// @end-test-value
test("FilePreviewApp は payload hydrate 後も document title を対象ファイル名に同期する", async () => {
  const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousNode = globalThis.Node;
  const dom = new JSDOM(
    "<!doctype html><html><head><title>File Preview</title></head><body><div id=\"root\"></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/file-preview.html?token=preview-1" },
  );
  const resource = { sessionId: "session-1", absolutePath: "C:\\outside\\notes.md" };
  const descriptor: SessionFileDescriptor = {
    ...resource,
    name: "notes.md",
    kind: "text",
    byteLength: 0,
    modifiedAt: "2026-08-14T00:00:00.000Z",
    mimeType: "text/plain",
    suggestedEncoding: "utf-8",
    revision: "empty-r1",
  };
  const api = {
    async getAppSettings() {
      return createDefaultAppSettings();
    },
    subscribeAppSettings() {
      return () => {};
    },
    async getSessionFilePreviewWindowPayload() {
      return { resource, ownerSessionId: "session-1", windowTitle: "notes.md" };
    },
    subscribeSessionFilePreviewNavigation() {
      return () => {};
    },
    async inspectSessionFile() {
      return descriptor;
    },
    async listSessionFileRoots() {
      return [];
    },
    async readSessionFileChunk() {
      throw new Error("Empty preview must not request a file chunk.");
    },
  } as unknown as WithMateWindowApi;

  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(dom.window, "withmate", { configurable: true, value: api });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });

  let root: Root | null = null;
  try {
    root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
    await act(async () => {
      root?.render(<FilePreviewApp />);
    });
    for (let index = 0; index < 20 && dom.window.document.title !== "notes.md"; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    assert.equal(dom.window.document.title, "notes.md");
  } finally {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      previousActEnvironment;
    dom.window.close();
  }
});

test("buildFileRootDiffPreviewWindowRequest は root resource と Git scope を detached view へ保持する", () => {
  assert.deepEqual(buildFileRootDiffPreviewWindowRequest({
    sessionId: "session-1",
    rootId: "additional:repo",
    relativePath: "src/notes.txt",
    scope: "staged",
  }), {
    kind: "resource",
    resource: {
      sessionId: "session-1",
      rootId: "additional:repo",
      relativePath: "src/notes.txt",
    },
    view: { kind: "diff", scope: "staged" },
  });
});

// @test-value v2
// kind = "contract"
// claim = "detached live Git DiffのOpen previewは同じresourceのfile previewへ戻り、初回diff取得中も回復導線を保持する"
// oracle = { type = "contract", ref = "src/file-explorer/FilePreviewApp.tsx" }
// fault = "diff取得中にOpen previewを利用できない、別resourceへ遷移する、またはdiff requestのresource identityを失う"
// observable = "loading中のOpen preview disabled状態、diff request payload、遷移後のfile preview表示"
// observation_boundary = "component-behavior"
// scope = "FilePreviewApp.detached-live-diff-navigation"
// lifecycle = "permanent"
// impact = "取得中のlive diffから同じfile previewへ復帰でき、detached windowのresource identityを保つ"
// distinction = "detached payloadのloadingと解放後のDOMを順に確認し、button contractとnavigation requestを分けて観測する"
// @end-test-value
test("FilePreviewApp の live Git Diff は Open Preview で同じ detached Window の file preview へ戻る", async () => {
  const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousElement = globalThis.Element;
  const previousNode = globalThis.Node;
  const dom = new JSDOM(
    "<!doctype html><html><head><title>File Preview</title></head><body><div id=\"root\"></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/file-preview.html?token=preview-1" },
  );
  const resource = {
    sessionId: "session-1",
    rootId: "additional:repo",
    relativePath: "src/notes.txt",
  };
  const descriptor: SessionFileDescriptor = {
    ...resource,
    name: "notes.txt",
    kind: "text",
    byteLength: 0,
    modifiedAt: "2026-08-16T00:00:00.000Z",
    mimeType: "text/plain",
    suggestedEncoding: "utf-8",
    revision: "empty-r1",
  };
  const diffRequests: unknown[] = [];
  let releaseDiff: (() => void) | undefined;
  const diffGate = new Promise<void>((resolve) => {
    releaseDiff = resolve;
  });
  const api = {
    async getAppSettings() {
      return createDefaultAppSettings();
    },
    subscribeAppSettings() {
      return () => {};
    },
    async getSessionFilePreviewWindowPayload() {
      return {
        resource,
        ownerSessionId: "session-1",
        windowTitle: "notes.txt",
        view: { kind: "diff" as const, scope: "working-tree" as const },
      };
    },
    subscribeSessionFilePreviewNavigation() {
      return () => {};
    },
    async inspectSessionFile() {
      return descriptor;
    },
    async listSessionFileRoots() {
      return [{ id: "additional:repo", kind: "additional" as const, label: "repo", displayPath: "C:/repo" }];
    },
    async listFileRootChanges() {
      return {
        status: "ok" as const,
        entries: [{
          relativePath: resource.relativePath,
          previousRelativePath: null,
          scopes: ["working-tree" as const],
          kinds: { "working-tree": "modified" as const },
        }],
      };
    },
    async getFileRootDiff(request: unknown) {
      diffRequests.push(request);
      await diffGate;
      return {
        status: "ok" as const,
        relativePath: resource.relativePath,
        scope: "working-tree" as const,
        patch: "@@ -1 +1 @@\n-old\n+new\n",
      };
    },
    async readSessionFileChunk() {
      throw new Error("Empty preview must not request a file chunk.");
    },
  } as unknown as WithMateWindowApi;

  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(dom.window, "withmate", { configurable: true, value: api });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Element", { configurable: true, value: dom.window.Element });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });

  let root: Root | null = null;
  try {
    root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
    await act(async () => {
      root?.render(<FilePreviewApp />);
    });
    let loadingPreview: HTMLElement | null = null;
    for (let index = 0; index < 20 && !loadingPreview; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      loadingPreview = dom.window.document.querySelector<HTMLElement>(
        "[aria-label='Git diff preview'][aria-busy='true']",
      );
    }
    assert.ok(loadingPreview);
    assert.equal(loadingPreview.querySelector(".session-file-preview-title strong")?.textContent, "src/notes.txt");
    assert.equal(loadingPreview.querySelector("[role='status']")?.getAttribute("aria-label"), "Loading Git diff");
    assert.ok(loadingPreview.querySelector(".loading-indicator-spinner[aria-hidden='true']"));
    assert.equal(loadingPreview.querySelector(".file-preview-loading-content"), null);
    const loadingButtons = [...loadingPreview.querySelectorAll<HTMLButtonElement>("button")];
    assert.equal(loadingButtons.find((button) => button.textContent === "Find")?.disabled, true);
    assert.equal(loadingButtons.find((button) => button.textContent === "Open Preview")?.disabled, false);
    await act(async () => releaseDiff?.());
    let openPreviewButton: HTMLButtonElement | undefined;
    for (let index = 0; index < 20 && !openPreviewButton; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      openPreviewButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Open Preview");
    }
    assert.ok(openPreviewButton);
    assert.deepEqual(diffRequests, [{ ...resource, scope: "working-tree" }]);
    await act(async () => openPreviewButton.click());
    assert.ok(dom.window.document.querySelector("[aria-label='File preview']"));
    assert.equal(dom.window.document.querySelector("[aria-label='Git diff preview']"), null);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Element", { configurable: true, value: previousElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      previousActEnvironment;
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "独立画像previewは設定未取得と失敗中も画像と倍率を保ち、Retry後の刻み20と保存通知の刻み1を次のCtrl＋wheelへ適用する"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md" }
// fault = "設定失敗を既定値で成功扱いする、再試行できない、通知が画像倍率をリセットする、またはwheelが固定刻みを使う"
// observable = "FilePreviewAppの画像DOM、alertとRetry、倍率buttonの表示、画像style.zoom、wheel.defaultPrevented"
// observation_boundary = "component-behavior"
// scope = "detached-image-preview-settings-load-retry-and-live-step"
// lifecycle = "permanent"
// impact = "独立Windowが設定を無視するか、設定取得失敗で閲覧中の画像を失う"
// distinction = "subscription単体では確認できないWindow rootからproduction画像previewとnative wheelまでの接続を小さな画像fixtureで検証する"
// @end-test-value
test("FilePreviewAppの画像は設定Retryと通知で次のwheel刻みだけを更新する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/file-preview.html?token=preview-1",
  });
  const previousGlobals = Object.getOwnPropertyDescriptors(globalThis);
  const globalNames = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "IS_REACT_ACT_ENVIRONMENT"];
  for (const name of globalNames) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === "IS_REACT_ACT_ENVIRONMENT" ? true
        : name === "window" ? dom.window
          : (dom.window as unknown as Record<string, unknown>)[name],
    });
  }
  const resource = { sessionId: "session-1", absolutePath: "C:/outside/image.png" };
  const descriptor: SessionFileDescriptor = {
    ...resource,
    name: "image.png",
    kind: "image",
    byteLength: 1,
    modifiedAt: "2026-10-03T00:00:00.000Z",
    mimeType: "image/png",
    suggestedEncoding: "utf-8",
    revision: "image-r1",
  };
  let rejectInitial: ((error: Error) => void) | undefined;
  const initialSettings = new Promise<AppSettings>((_resolve, reject) => { rejectInitial = reject; });
  let settingsRequests = 0;
  let settingsListener: ((settings: AppSettings) => void) | undefined;
  const api = {
    getAppSettings() {
      settingsRequests += 1;
      return settingsRequests === 1 ? initialSettings
        : Promise.resolve({ ...createDefaultAppSettings(), previewWheelZoomStep: 20 });
    },
    subscribeAppSettings(listener: (settings: AppSettings) => void) {
      settingsListener = listener;
      return () => { settingsListener = undefined; };
    },
    async getSessionFilePreviewWindowPayload() {
      return { resource, ownerSessionId: "session-1", windowTitle: "image.png" };
    },
    subscribeSessionFilePreviewNavigation() { return () => {}; },
    async inspectSessionFile() { return descriptor; },
    async listSessionFileRoots() { return []; },
    async readSessionFileChunk() {
      return { offset: 0, totalBytes: 1, data: [0], nextOffset: 1, done: true };
    },
  } as unknown as WithMateWindowApi;
  Object.defineProperty(dom.window, "withmate", { configurable: true, value: api });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await act(async () => root.render(<FilePreviewApp />));
    const image = container.querySelector<HTMLImageElement>(".session-file-image");
    assert.ok(image);
    const viewport = container.querySelector<HTMLElement>(".session-file-image-scroll");
    assert.ok(viewport);
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 450 },
    });
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 800 },
      naturalHeight: { configurable: true, value: 450 },
    });
    await act(async () => image.dispatchEvent(new dom.window.Event("load")));
    const reset = container.querySelector<HTMLButtonElement>('button[aria-label="Reset image zoom to 100%"]');
    assert.ok(reset);
    const wheel = () => {
      const event = new dom.window.WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
      image.dispatchEvent(event);
      return event;
    };
    assert.ok(container.querySelector('[role="status"][aria-label="Loading preview settings"]'));
    await act(async () => { assert.equal(wheel().defaultPrevented, true); });
    assert.equal(reset.textContent, "100%");

    await act(async () => rejectInitial?.(new Error("Settings unavailable")));
    const alert = container.querySelector('[role="alert"]');
    assert.ok(alert);
    assert.match(alert.textContent ?? "", /Settings unavailable/);
    assert.equal(container.querySelector(".session-file-image"), image);
    await act(async () => { wheel(); });
    assert.equal(reset.textContent, "100%");
    const retry = alert.querySelector<HTMLButtonElement>("button");
    assert.ok(retry);
    assert.equal(retry.textContent, "Retry");
    await act(async () => retry.click());
    assert.equal(container.querySelector('[role="alert"]'), null);
    assert.equal(container.querySelector(".session-file-image"), image);
    assert.equal(reset.textContent, "100%");
    await act(async () => { wheel(); });
    assert.equal(reset.textContent, "120%");
    assert.equal(image.style.zoom, "1.2");
    assert.ok(settingsListener);
    await act(async () => settingsListener?.({ ...createDefaultAppSettings(), previewWheelZoomStep: 1 }));
    assert.equal(reset.textContent, "120%");
    assert.equal(image.style.zoom, "1.2");
    await act(async () => { wheel(); });
    assert.equal(reset.textContent, "121%");
    assert.equal(image.style.zoom, "1.21");
  } finally {
    await act(async () => root.unmount());
    for (const name of globalNames) {
      const previous = previousGlobals[name];
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
});

test("DiffApp は独立 Window の内容を描画する", async () => {
  const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousNode = globalThis.Node;
  const dom = new JSDOM(
    "<!doctype html><html><head><title>Diff</title></head><body><div id=\"root\"></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/diff.html?token=diff-1" },
  );
  const api = {
    async getDiffPreview() {
      return {
        title: "notes.md",
        file: {
          kind: "edit",
          path: "notes.md",
          summary: "1 line changed",
          diffRows: [{ kind: "add", rightNumber: 1, rightText: "updated" }],
        },
        themeColors: DEFAULT_CHARACTER_THEME_COLORS,
      };
    },
  } as unknown as WithMateWindowApi;

  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(dom.window, "withmate", { configurable: true, value: api });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });

  let root: Root | null = null;
  try {
    root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
    await act(async () => {
      root?.render(<DiffApp />);
    });
    for (let index = 0; index < 20 && !dom.window.document.querySelector(".diff-window-shell"); index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    assert.ok(dom.window.document.querySelector(".diff-window-shell"));
  } finally {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      previousActEnvironment;
    dom.window.close();
  }
});
