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
  type SessionFilePreviewResourceRequest,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import {
  createDefaultAppSettings,
  type AppSettings,
} from "../../src-shared/settings/provider-settings-state.js";

/** WindowsとPOSIXのパスはbasenameだけにし、空や親参照や制御文字を含む名前は既定タイトルへ戻す。 */
test("resolveSessionFilePreviewWindowTitle は basename だけを返し不正な名前を fallback する", () => {
  assert.equal(
    resolveSessionFilePreviewWindowTitle("C:\\Users\\private\\notes.md"),
    "notes.md",
  );
  assert.equal(
    resolveSessionFilePreviewWindowTitle("/home/private/notes.md"),
    "notes.md",
  );
  assert.equal(
    resolveSessionFilePreviewWindowTitle(""),
    FILE_PREVIEW_WINDOW_TITLE_FALLBACK,
  );
  assert.equal(
    resolveSessionFilePreviewWindowTitle(".."),
    FILE_PREVIEW_WINDOW_TITLE_FALLBACK,
  );
  assert.equal(
    resolveSessionFilePreviewWindowTitle("unsafe\nname.md"),
    FILE_PREVIEW_WINDOW_TITLE_FALLBACK,
  );
});

/** コミット版プレビューのタイトルでは、basenameと7桁のハッシュで対象を識別できる。 */
test("commit file previewのwindow titleは短縮commit hashを含む", () => {
  assert.equal(
    resolveSessionFileGitCommitPreviewWindowTitle(
      "src/notes.md",
      "abcdef0123456789abcdef0123456789abcdef01",
    ),
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
/** 設定読込とpayload取得を含む初期化後、ウィンドウのdocument.titleが対象のファイル名に更新されることを確認する。 */
test("FilePreviewApp は payload hydrate 後も document title を対象ファイル名に同期する", async () => {
  const previousActEnvironment = (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousNode = globalThis.Node;
  const dom = new JSDOM(
    '<!doctype html><html><head><title>File Preview</title></head><body><div id="root"></div></body></html>',
    {
      pretendToBeVisual: true,
      url: "http://localhost/file-preview.html?token=preview-1",
    },
  );
  const resource = {
    sessionId: "session-1",
    absolutePath: "C:\\outside\\notes.md",
  };
  const descriptor: SessionFileDescriptor = {
    ...resource,
    absoluteFilePath: resource.absolutePath,
    name: "notes.md",
    kind: "text",
    byteLength: 0,
    modifiedAt: "2026-08-14T00:00:00.000Z",
    mimeType: "text/plain",
    suggestedEncoding: "utf-8",
    revision: "empty-r1",
  };
  const api = {
    /** 独立プレビューの初期化へ既定設定を返す。 */
    async getAppSettings() {
      return createDefaultAppSettings();
    },
    /** 初期化中に設定更新は配信せず、購読の解除だけを受け付ける。 */
    subscribeAppSettings() {
      return () => {};
    },
    /** 空のテキストファイルを開く独立ウィンドウのpayloadを返す。 */
    async getSessionFilePreviewWindowPayload() {
      return {
        resource,
        ownerSessionId: "session-1",
        windowTitle: "notes.md",
        displayPath: "C:/work/notes.md",
      };
    },
    /** 別ファイルへの移動通知は配信しない。 */
    subscribeSessionFilePreviewNavigation() {
      return () => {};
    },
    /** 対象に対応するファイル記述子を返す。 */
    async inspectSessionFile() {
      return descriptor;
    },
    /** 追加ルートなしで独立プレビューを描画する。 */
    async listSessionFileRoots() {
      return [];
    },
    /** 空ファイルに対する不要な本文読込があれば失敗させる。 */
    async readSessionFileChunk() {
      throw new Error("Empty preview must not request a file chunk.");
    },
  } as unknown as WithMateWindowApi;

  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(dom.window, "withmate", {
    configurable: true,
    value: api,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.defineProperty(globalThis, "Node", {
    configurable: true,
    value: dom.window.Node,
  });

  let root: Root | null = null;
  try {
    root = createRoot(
      dom.window.document.getElementById("root") as HTMLElement,
    );
    await act(async () => {
      root?.render(<FilePreviewApp />);
    });
    for (
      let index = 0;
      index < 20 && dom.window.document.title !== "notes.md";
      index += 1
    ) {
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
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: previousNavigator,
    });
    Object.defineProperty(globalThis, "Node", {
      configurable: true,
      value: previousNode,
    });
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
});

/** 独立Git diff要求にSession・追加ルート・相対パスとstagedのscopeが残ることを確認する。 */
test("buildFileRootDiffPreviewWindowRequest は root resource と Git scope を detached view へ保持する", () => {
  assert.deepEqual(
    buildFileRootDiffPreviewWindowRequest({
      sessionId: "session-1",
      rootId: "additional:repo",
      relativePath: "src/notes.txt",
      scope: "staged",
    }),
    {
      kind: "resource",
      resource: {
        sessionId: "session-1",
        rootId: "additional:repo",
        relativePath: "src/notes.txt",
      },
      view: { kind: "diff", scope: "staged" },
    },
  );
});

// @test-value v2
// kind = "contract"
// claim = "detached live Git DiffのOpen previewは同じresourceのfile previewへ戻り、初回diff取得中も回復導線を保持する"
// oracle = { type = "contract", ref = "src/file-explorer/FilePreviewApp.tsx" }
// fault = "diff取得中にOpen previewを利用できない、別resourceへ遷移する、またはdiff requestのresource identityを失う"
// observable = "diff request payload、loading中のOpen Preview click後のinspect requestとfile preview表示、diff完了後も維持されるpreview"
// observation_boundary = "component-behavior"
// scope = "FilePreviewApp.detached-live-diff-navigation"
// lifecycle = "permanent"
// impact = "取得中のlive diffから同じfile previewへ復帰でき、detached windowのresource identityを保つ"
// distinction = "detached payloadからproduction navigationを通し、未完了diffを残した操作と復帰resource identityをAPI requestとDOMで直接観測する"
// @end-test-value
/** Git diffの読込中もOpen Previewを使え、同じresourceのファイル表示へ切り替わった後は遅れて到着したdiffを表示し直さない。 */
test("FilePreviewApp の live Git Diff は Open Preview で同じ detached Window の file preview へ戻る", async () => {
  const previousActEnvironment = (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousElement = globalThis.Element;
  const previousNode = globalThis.Node;
  const dom = new JSDOM(
    '<!doctype html><html><head><title>File Preview</title></head><body><div id="root"></div></body></html>',
    {
      pretendToBeVisual: true,
      url: "http://localhost/file-preview.html?token=preview-1",
    },
  );
  const resource = {
    sessionId: "session-1",
    rootId: "additional:repo",
    relativePath: "src/notes.txt",
  };
  const descriptor: SessionFileDescriptor = {
    ...resource,
    absoluteFilePath: "C:/repo/src/notes.txt",
    name: "notes.txt",
    kind: "text",
    byteLength: 0,
    modifiedAt: "2026-08-16T00:00:00.000Z",
    mimeType: "text/plain",
    suggestedEncoding: "utf-8",
    revision: "empty-r1",
  };
  const diffRequests: unknown[] = [];
  const fileResource = {
    sessionId: resource.sessionId,
    absolutePath: descriptor.absoluteFilePath,
  };
  const inspectRequests: SessionFilePreviewResourceRequest[] = [];
  let releaseDiff: (() => void) | undefined;
  const diffGate = new Promise<void>((resolve) => {
    releaseDiff = resolve;
  });
  const api = {
    /** diffとファイル表示への初期化に既定設定を渡す。 */
    async getAppSettings() {
      return createDefaultAppSettings();
    },
    /** 表示切替中には設定の変更を発行しない。 */
    subscribeAppSettings() {
      return () => {};
    },
    /** 同じ追加ルートのworking-tree diffを最初に表示するpayloadを返す。 */
    async getSessionFilePreviewWindowPayload() {
      return {
        resource,
        ownerSessionId: "session-1",
        windowTitle: "notes.txt",
        displayPath: descriptor.absoluteFilePath,
        view: { kind: "diff" as const, scope: "working-tree" as const },
      };
    },
    /** 表示の切替はボタンから行い、外部のナビゲーション通知は発行しない。 */
    subscribeSessionFilePreviewNavigation() {
      return () => {};
    },
    /** ファイル表示へ戻るときのinspect要求を記録し、元と同じresourceを参照したか検査する。 */
    async inspectSessionFile(request: SessionFilePreviewResourceRequest) {
      inspectRequests.push(request);
      assert.deepEqual(request, fileResource);
      return descriptor;
    },
    /** 対象ファイルが属する追加リポジトリのルートを返す。 */
    async listSessionFileRoots() {
      return [
        {
          id: "additional:repo",
          kind: "additional" as const,
          label: "repo",
          displayPath: "C:/repo",
        },
      ];
    },
    /** 対象の相対パスにworking-treeの変更がある一覧を返す。 */
    async listFileRootChanges() {
      return {
        status: "ok" as const,
        entries: [
          {
            relativePath: resource.relativePath,
            previousRelativePath: null,
            scopes: ["working-tree" as const],
            kinds: { "working-tree": "modified" as const },
          },
        ],
      };
    },
    /** 元のscopeへのdiff要求を記録して保留し、プレビューへ戻ってから応答を解決できるようにする。 */
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
    /** 戻り先は空のテキストファイルなので、本文チャンク要求があれば失敗とする。 */
    async readSessionFileChunk() {
      throw new Error("Empty preview must not request a file chunk.");
    },
  } as unknown as WithMateWindowApi;

  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(dom.window, "withmate", {
    configurable: true,
    value: api,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: dom.window.HTMLElement,
  });
  Object.defineProperty(globalThis, "Element", {
    configurable: true,
    value: dom.window.Element,
  });
  Object.defineProperty(globalThis, "Node", {
    configurable: true,
    value: dom.window.Node,
  });

  let root: Root | null = null;
  try {
    root = createRoot(
      dom.window.document.getElementById("root") as HTMLElement,
    );
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
    assert.equal(
      loadingPreview.querySelector(".session-file-preview-title strong")
        ?.textContent,
      "src/notes.txt",
    );
    assert.equal(
      loadingPreview
        .querySelector("[role='status']")
        ?.getAttribute("aria-label"),
      "Loading Git diff",
    );
    assert.ok(
      loadingPreview.querySelector(
        ".loading-indicator-spinner[aria-hidden='true']",
      ),
    );
    assert.equal(
      loadingPreview.querySelector(".file-preview-loading-content"),
      null,
    );
    const loadingButtons = [
      ...loadingPreview.querySelectorAll<HTMLButtonElement>("button"),
    ];
    assert.equal(
      loadingButtons.find((button) => button.textContent === "Find")?.disabled,
      true,
    );
    const openPreviewButton = loadingButtons.find(
      (button) => button.textContent === "Open Preview",
    );
    assert.ok(openPreviewButton);
    assert.equal(openPreviewButton.disabled, false);
    assert.deepEqual(diffRequests, [{ ...resource, scope: "working-tree" }]);
    assert.deepEqual(inspectRequests, []);
    await act(async () => openPreviewButton.click());
    assert.deepEqual(inspectRequests, [fileResource]);
    const restoredPreview = dom.window.document.querySelector(
      "[aria-label='File preview']",
    );
    assert.ok(restoredPreview);
    assert.equal(
      restoredPreview.querySelector(".session-file-preview-title strong")
        ?.textContent,
      "notes.txt",
    );
    assert.equal(
      dom.window.document.querySelector("[aria-label='Git diff preview']"),
      null,
    );
    await act(async () => releaseDiff?.());
    assert.equal(
      dom.window.document.querySelector(
        "[aria-label='File preview'] .session-file-preview-title strong",
      )?.textContent,
      "notes.txt",
    );
    assert.deepEqual(inspectRequests, [fileResource]);
    assert.equal(
      dom.window.document.querySelector("[aria-label='Git diff preview']"),
      null,
    );
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: previousNavigator,
    });
    Object.defineProperty(globalThis, "HTMLElement", {
      configurable: true,
      value: previousHTMLElement,
    });
    Object.defineProperty(globalThis, "Element", {
      configurable: true,
      value: previousElement,
    });
    Object.defineProperty(globalThis, "Node", {
      configurable: true,
      value: previousNode,
    });
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
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
/** 設定の初回取得に失敗しても画像と倍率を保持する。再試行の20刻みと保存通知の1刻みは、現在の倍率を変えず次のホイール操作から使う。 */
test("FilePreviewAppの画像は設定Retryと通知で次のwheel刻みだけを更新する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/file-preview.html?token=preview-1",
  });
  const previousGlobals = Object.getOwnPropertyDescriptors(globalThis);
  const globalNames = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "IS_REACT_ACT_ENVIRONMENT",
  ];
  for (const name of globalNames) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value:
        name === "IS_REACT_ACT_ENVIRONMENT"
          ? true
          : name === "window"
            ? dom.window
            : (dom.window as unknown as Record<string, unknown>)[name],
    });
  }
  const resource = {
    sessionId: "session-1",
    absolutePath: "C:/outside/image.png",
  };
  const descriptor: SessionFileDescriptor = {
    ...resource,
    absoluteFilePath: resource.absolutePath,
    name: "image.png",
    kind: "image",
    byteLength: 1,
    modifiedAt: "2026-10-03T00:00:00.000Z",
    mimeType: "image/png",
    suggestedEncoding: "utf-8",
    revision: "image-r1",
  };
  let rejectInitial: ((error: Error) => void) | undefined;
  const initialSettings = new Promise<AppSettings>((_resolve, reject) => {
    rejectInitial = reject;
  });
  let settingsRequests = 0;
  let settingsListener: ((settings: AppSettings) => void) | undefined;
  const api = {
    /** 設定の初回取得だけを保留し、再試行にはホイールの刻み幅20を返す。 */
    getAppSettings() {
      settingsRequests += 1;
      return settingsRequests === 1
        ? initialSettings
        : Promise.resolve({
            ...createDefaultAppSettings(),
            previewWheelZoomStep: 20,
          });
    },
    /** 保存済み設定を通知するコールバックの登録と解除を保持する。 */
    subscribeAppSettings(listener: (settings: AppSettings) => void) {
      settingsListener = listener;
      return () => {
        settingsListener = undefined;
      };
    },
    /** 画像ファイルを対象とする独立プレビューのpayloadを返す。 */
    async getSessionFilePreviewWindowPayload() {
      return {
        resource,
        ownerSessionId: "session-1",
        windowTitle: "image.png",
        displayPath: "C:/work/image.png",
      };
    },
    /** このケースでは画像以外のファイルへ移動しない。 */
    subscribeSessionFilePreviewNavigation() {
      return () => {};
    },
    /** 表示対象の画像記述子を取得済みとして返す。 */
    async inspectSessionFile() {
      return descriptor;
    },
    /** 画像プレビューには追加ファイルルートを要求しない。 */
    async listSessionFileRoots() {
      return [];
    },
    /** 画像読込を完了させるため、1バイトで終端となるチャンクを返す。 */
    async readSessionFileChunk() {
      return { offset: 0, totalBytes: 1, data: [0], nextOffset: 1, done: true };
    },
  } as unknown as WithMateWindowApi;
  Object.defineProperty(dom.window, "withmate", {
    configurable: true,
    value: api,
  });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await act(async () => root.render(<FilePreviewApp />));
    const image = container.querySelector<HTMLImageElement>(
      ".session-file-image",
    );
    assert.ok(image);
    const viewport = container.querySelector<HTMLElement>(
      ".session-file-image-scroll",
    );
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
    const reset = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Reset image zoom to 100%"]',
    );
    assert.ok(reset);
    /** 画像へキャンセル可能なCtrl＋ホイールイベントを送り、ハンドラーの既定動作抑止も検査できるようにする。 */
    const wheel = () => {
      const event = new dom.window.WheelEvent("wheel", {
        deltaY: -100,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      image.dispatchEvent(event);
      return event;
    };
    assert.ok(
      container.querySelector(
        '[role="status"][aria-label="Loading preview settings"]',
      ),
    );
    await act(async () => {
      assert.equal(wheel().defaultPrevented, true);
    });
    assert.equal(reset.textContent, "100%");

    await act(async () => rejectInitial?.(new Error("Settings unavailable")));
    const alert = container.querySelector('[role="alert"]');
    assert.ok(alert);
    assert.match(alert.textContent ?? "", /Settings unavailable/);
    assert.equal(container.querySelector(".session-file-image"), image);
    await act(async () => {
      wheel();
    });
    assert.equal(reset.textContent, "100%");
    const retry = alert.querySelector<HTMLButtonElement>("button");
    assert.ok(retry);
    assert.equal(retry.textContent, "Retry");
    await act(async () => retry.click());
    assert.equal(container.querySelector('[role="alert"]'), null);
    assert.equal(container.querySelector(".session-file-image"), image);
    assert.equal(reset.textContent, "100%");
    await act(async () => {
      wheel();
    });
    assert.equal(reset.textContent, "120%");
    assert.equal(image.style.zoom, "1.2");
    assert.ok(settingsListener);
    await act(async () =>
      settingsListener?.({
        ...createDefaultAppSettings(),
        previewWheelZoomStep: 1,
      }),
    );
    assert.equal(reset.textContent, "120%");
    assert.equal(image.style.zoom, "1.2");
    await act(async () => {
      wheel();
    });
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

// @test-value v2
// kind = "contract"
// claim = "独立Diff Windowはpayload取得後にDiff画面のshellを描画する"
// oracle = { type = "contract", ref = "docs/design/window-architecture.md" }
// fault = "Window rootとpayload取得の接続が切れてDiff画面が表示されない"
// observable = "DiffAppをmountし非同期payload取得後のdiff-window-shell"
// observation_boundary = "component-behavior"
// scope = "detached-diff-window-render"
// lifecycle = "permanent"
// impact = "独立Windowで変更内容を確認できなくなる"
// distinction = "payload APIをstubにした実Window rootの初期表示で、型検査やDiff行変換testとは異なる接続を確認する。実layoutとresizeは対象外"
// @end-test-value
/** 独立Diffのエントリーが取得済みpayloadを使って画面のshellを描画することを確認する。 */
test("DiffApp は独立 Window の内容を描画する", async () => {
  const previousActEnvironment = (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousNode = globalThis.Node;
  const dom = new JSDOM(
    '<!doctype html><html><head><title>Diff</title></head><body><div id="root"></div></body></html>',
    { pretendToBeVisual: true, url: "http://localhost/diff.html?token=diff-1" },
  );
  const previousResizeObserver = Object.getOwnPropertyDescriptor(
    globalThis,
    "ResizeObserver",
  );
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      observe /** shellの表示確認では要素の寸法監視を開始しない。 */() {}
      disconnect /** 寸法監視に通知がないため、破棄時には何もしない。 */() {}
      unobserve /** 個別の要素についても解除すべき寸法監視はない。 */() {}
    },
  });
  const api = {
    /** 一行の追加とCharacter配色を含む独立Diffのpayloadを返す。 */
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

  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(dom.window, "withmate", {
    configurable: true,
    value: api,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollTo", {
    configurable: true,
    /** shellだけを検査するため、JSDOMでウィンドウ内のスクロールを実行しない。 */
    value: () => undefined,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    /** JSDOMには対象行を可視範囲へ移動させない。 */
    value: () => undefined,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.defineProperty(globalThis, "Node", {
    configurable: true,
    value: dom.window.Node,
  });

  let root: Root | null = null;
  try {
    root = createRoot(
      dom.window.document.getElementById("root") as HTMLElement,
    );
    await act(async () => {
      root?.render(<DiffApp />);
    });
    for (
      let index = 0;
      index < 20 && !dom.window.document.querySelector(".diff-window-shell");
      index += 1
    ) {
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
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: previousNavigator,
    });
    Object.defineProperty(globalThis, "Node", {
      configurable: true,
      value: previousNode,
    });
    if (previousResizeObserver)
      Object.defineProperty(
        globalThis,
        "ResizeObserver",
        previousResizeObserver,
      );
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
});
