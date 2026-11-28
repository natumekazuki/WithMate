import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  buildSessionFileExplorerRootsRevision,
  type SessionDirectoryEntry,
  type SessionFileRoot,
  type SessionFilePin,
} from "../../src-shared/file-explorer/file-explorer-contract.js";

const emptyPinsApi = {
  /** ピンの操作を行わないケースでは、既存ピンがない状態から始める。 */
  async listSessionFilePins(): Promise<SessionFilePin[]> {
    return [];
  },
  /** ピン追加を伴わない画面操作で更新 API を誤って呼んだ場合に失敗させる。 */
  async pinSessionFile(): Promise<SessionFilePin> {
    throw new Error("Unexpected pin mutation.");
  },
  /** ピン解除を伴わない画面操作で更新 API を誤って呼んだ場合に失敗させる。 */
  async unpinSessionFile(): Promise<void> {
    throw new Error("Unexpected pin mutation.");
  },
};

/** 非同期の一覧取得やメニュー応答を、テストから決めた時点で完了できるようにする型。 */
type Deferred<T> = {
  promise: Promise<T>;
  /** 非同期操作を指定した値で完了する。 */
  resolve(value: T): void;
};

/** 取得やメニューが待機している状態を作るため、応答の解決を呼び出し側へ委ねる。 */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

/** React の非同期更新を進めながら DOM 条件を待ち、期限内に成立しなければ失敗させる。 */
async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  assert.fail("Timed out waiting for file explorer state.");
}

/** 指定名を相対パスにも使う一覧用のファイル項目を返す。 */
function fileEntry(name: string): SessionDirectoryEntry {
  return {
    name,
    relativePath: name,
    kind: "file",
    byteLength: 1,
    modifiedAt: "2026-08-02T00:00:00.000Z",
  };
}

/** 展開操作を受け付けるディレクトリ項目を、指定名で作る。 */
function directoryEntry(name: string): SessionDirectoryEntry {
  return {
    name,
    relativePath: name,
    kind: "directory",
    byteLength: 0,
    modifiedAt: "2026-08-02T00:00:00.000Z",
  };
}

// @test-value v2
// kind = "invariant"
// claim = "File Explorer root revisionはactive Session、workspace path、Additional Directory集合の組を一意に表す"
// oracle = { type = "contract", ref = "accepted behavior invariant 2: root change invalidates pending insertion" }
// fault = "同じSession IDのworkspace pathだけが変わったときに旧rootのmenu結果を新rootへ挿入する"
// observable = "session ID、workspace path、Additional Directory変更ごとのroot revision値"
// observation_boundary = "public-boundary"
// scope = "buildSessionFileExplorerRootsRevision"
// lifecycle = "permanent"
// distinction = "Additional Directory変更だけでなくMain rootの対応先であるworkspace path変更もrevisionへ反映する"
// @end-test-value
/** Session ID、作業場所、追加ディレクトリをそれぞれ変更し、旧ルートの操作を識別できる別のリビジョンになることを検査する。 */
test("File Explorer root revisionはworkspace path変更を検出する", () => {
  const initial = buildSessionFileExplorerRootsRevision({
    sessionId: "session-1",
    workspacePath: "C:\\workspace-a",
    additionalDirectories: ["C:\\additional"],
  });
  const workspaceChanged = buildSessionFileExplorerRootsRevision({
    sessionId: "session-1",
    workspacePath: "C:\\workspace-b",
    additionalDirectories: ["C:\\additional"],
  });
  const sessionChanged = buildSessionFileExplorerRootsRevision({
    sessionId: "session-2",
    workspacePath: "C:\\workspace-a",
    additionalDirectories: ["C:\\additional"],
  });
  const additionalDirectoryChanged = buildSessionFileExplorerRootsRevision({
    sessionId: "session-1",
    workspacePath: "C:\\workspace-a",
    additionalDirectories: ["C:\\additional-b"],
  });
  assert.notEqual(initial, workspaceChanged);
  assert.notEqual(initial, sessionChanged);
  assert.notEqual(initial, additionalDirectoryChanged);
  assert.equal(
    new Set([
      initial,
      workspaceChanged,
      sessionChanged,
      additionalDirectoryChanged,
    ]).size,
    4,
  );
});

// @test-value v2
// kind = "invariant"
// claim = "Files treeはpath操作と展開状態を伝え、更新中は既存treeとbusyを保ち、Files/Pin失敗では診断詳細の開閉・focus回復とRetryを提供する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md AgentのFile Explorer; docs/design/ui-design-guidelines.md 操作とアクセシビリティ・ボタン・読込・空・失敗" }
// fault = "path操作・展開状態が壊れる、更新中のtreeが消える、busyが誤る、失敗の診断原文に到達できない、詳細を閉じてfocusが失われる、またはRetryで回復できない"
// observable = "path menu/open callback、aria-expanded、tree identity、Refreshのdisabled/aria-busy/spinner、loading/alert、詳細dialogの原文・focus・開閉状態とRetry後の表示"
// observation_boundary = "component-behavior"
// scope = "SessionFileExplorerPane Files tree interaction and roots state"
// lifecycle = "permanent"
// impact = "展開階層と取得待ちを伝え、重複実行を防ぎ、失敗後も診断と回復操作へkeyboardで到達できる"
// distinction = "型検査では検出できない遅延取得・詳細開閉・focus・再試行のDOM状態を既存のcomponent testで観測する。位置とclipは実描画で確認する"
// @end-test-value
/** Files のパスメニューと展開状態を検査し、再取得中も既存ツリーと待機表示を保つ。Files と Pins の失敗は詳細のフォーカスと再試行で回復できる。 */
test("SessionFileExplorerPane は path menu対象と既存tree操作をowner単位に保つ", async () => {
  const previousActEnvironment = (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousElement = globalThis.Element;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      pretendToBeVisual: true,
    },
  );
  Object.defineProperty(dom.window, "ResizeObserver", {
    value: class {
      /** レイアウトを固定した環境では、要素の再計測を自動で行わない。 */
      observe() {}
      /** 実際の監視対象を登録しないため、解除は何もしない。 */
      unobserve() {}
      /** サイズ監視を開始していないため、切断時に解放する対象はない。 */
      disconnect() {}
    },
  });
  const previousGetBoundingClientRect =
    dom.window.HTMLElement.prototype.getBoundingClientRect;
  const previousClientHeight = Object.getOwnPropertyDescriptor(
    dom.window.HTMLElement.prototype,
    "clientHeight",
  );
  const previousClientWidth = Object.getOwnPropertyDescriptor(
    dom.window.HTMLElement.prototype,
    "clientWidth",
  );
  const previousOffsetHeight = Object.getOwnPropertyDescriptor(
    dom.window.HTMLElement.prototype,
    "offsetHeight",
  );
  const previousOffsetWidth = Object.getOwnPropertyDescriptor(
    dom.window.HTMLElement.prototype,
    "offsetWidth",
  );
  dom.window.HTMLElement.prototype.getBoundingClientRect =
    function getBoundingClientRect() {
      const height = this.classList.contains("session-file-explorer-body")
        ? 480
        : 31;
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 320,
        bottom: height,
        width: 320,
        height,
        /** レイアウト矩形の JSON 表現はこの検証では使わない。 */
        toJSON: () => ({}),
      };
    };
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", {
    configurable: true,
    /** ファイル一覧の表示領域と個別行の高さを分け、仮想表示の計算を進める。 */
    get() {
      return this.classList.contains("session-file-explorer-body") ? 480 : 31;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", {
    configurable: true,
    /** ビューポートと行で共通のクライアント幅を返す。 */
    get() {
      return 320;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    /** 実レイアウトがない環境に、スクロール領域と個々の行の高さを供給する。 */
    get() {
      return this.classList.contains("session-file-explorer-body") ? 480 : 31;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    /** 仮想一覧の横サイズをクライアント幅と同じ値に固定する。 */
    get() {
      return 320;
    },
  });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
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
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  const { SessionFileExplorerPane } =
    await import("../../src/file-explorer/SessionFileExplorerPane.js");

  const directoryRequests: Array<Deferred<SessionDirectoryEntry[]>> = [];
  const pathMenuRequests: unknown[] = [];
  let listedRoots: SessionFileRoot[] = [
    {
      id: "workspace",
      kind: "workspace",
      label: "Workspace",
      displayPath: "C:\\workspace",
    },
  ];
  let rejectRoots = false;
  let rejectPins = false;
  let directoryCalls = 0;
  let pinListCalls = 0;
  const pinRefresh = deferred<SessionFilePin[]>();
  const api = {
    ...emptyPinsApi,
    /** ピン取得の失敗を切り替え、二回目の応答だけ保留して全取得の完了まで待機が続くか観測する。 */
    async listSessionFilePins() {
      pinListCalls += 1;
      if (rejectPins) throw new Error("Pins failed.");
      return pinListCalls === 2 ? pinRefresh.promise : [];
    },
    /** メニューの対象と座標を記録し、ファイルの場合だけ操作失敗を返す。 */
    async showSessionFileTreeContextMenu(request: unknown) {
      pathMenuRequests.push(request);
      return (request as { nodeKind?: string }).nodeKind === "file"
        ? { status: "failed" as const, message: "Path action failed." }
        : { status: "dismissed" as const };
    },
    /** 指定したルート一覧または診断対象のエラーを返し、Retry 前後を切り替えられるようにする。 */
    async listSessionFileRoots() {
      if (rejectRoots) {
        throw new Error("File roots failed.");
      }
      return listedRoots;
    },
    /** ディレクトリの取得回数を記録し、展開と再取得の応答をそれぞれ保留する。 */
    listSessionDirectory() {
      directoryCalls += 1;
      const request = deferred<SessionDirectoryEntry[]>();
      directoryRequests.push(request);
      return request.promise;
    },
  };
  let changesRefreshCalls = 0;
  const openedFiles: Array<{ relativePath: string; openInWindow: boolean }> =
    [];
  let root: Root | null = null;
  try {
    await act(async () => {
      root = createRoot(
        dom.window.document.getElementById("root") as HTMLElement,
      );
      root.render(
        React.createElement(SessionFileExplorerPane, {
          api,
          sessionId: "session-1",
          enabled: true,
          rootsRevision: "roots-1",
          selectedFile: null,
          activeTab: "files",
          /** Files タブを固定し、他タブへの切替をこの段階の検証に入れない。 */
          onActiveTabChange() {},
          /** Files の操作が Changes の再取得を誤って呼んだ場合を検出できるようにする。 */
          onRefreshChanges() {
            changesRefreshCalls += 1;
          },
          /** ファイルを開く相対パスと別ウィンドウ指定を記録し、通常クリックと修飾キー操作を区別する。 */
          onOpenFile(request, openInWindow) {
            openedFiles.push({
              relativePath: request.relativePath,
              openInWindow,
            });
          },
          canInsertPathReference: true,
          /** メニュー要求と失敗表示だけを検査し、Composer への挿入は行わない。 */
          onInsertPathReference() {},
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      dom.window.dispatchEvent(new dom.window.Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(
      () =>
        dom.window.document.querySelector(".session-file-root-row") !== null,
    );
    assert.equal(directoryCalls, 0);

    const initialRoot = dom.window.document.querySelector<HTMLButtonElement>(
      ".session-file-root-row",
    );
    assert.ok(initialRoot);
    assert.equal(initialRoot.getAttribute("aria-expanded"), "false");
    initialRoot.dispatchEvent(
      new dom.window.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 6,
        clientY: 9,
      }),
    );
    await act(async () => {
      initialRoot.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    assert.equal(initialRoot.getAttribute("aria-expanded"), "true");
    await act(async () => {
      initialRoot.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    assert.equal(initialRoot.getAttribute("aria-expanded"), "false");
    await act(async () => {
      initialRoot.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
    });
    assert.equal(directoryCalls, 1);

    await act(async () => {
      directoryRequests[0]?.resolve([fileEntry("old.txt")]);
      await directoryRequests[0]?.promise;
    });
    await waitFor(
      () => dom.window.document.body.textContent?.includes("old.txt") ?? false,
    );

    const refresh = dom.window.document.querySelector<HTMLButtonElement>(
      ".session-file-explorer-refresh",
    );
    assert.ok(refresh);
    assert.equal(initialRoot.getAttribute("aria-expanded"), "true");
    assert.equal(refresh.getAttribute("aria-busy"), "false");
    assert.equal(refresh.querySelector(".button-content-spinner"), null);
    await act(async () => {
      refresh.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
    });
    await waitFor(
      () =>
        dom.window.document.querySelector(".session-file-root-row") !== null,
    );
    assert.equal(
      dom.window.document.querySelector(".session-file-root-row"),
      initialRoot,
    );
    assert.match(dom.window.document.body.textContent ?? "", /old\.txt/);
    assert.equal(directoryCalls, 2);
    assert.equal(initialRoot.getAttribute("aria-expanded"), "true");
    assert.equal(refresh.disabled, true);
    assert.equal(refresh.getAttribute("aria-busy"), "true");
    assert.ok(
      refresh.querySelector(
        ".button-content[data-busy='true'] > .button-content-spinner",
      ),
    );

    await act(async () => {
      directoryRequests[1]?.resolve([
        fileEntry("new.txt"),
        directoryEntry("folder"),
        { ...fileEntry("linked.txt"), kind: "symbolic-link" },
      ]);
      await directoryRequests[1]?.promise;
    });
    await waitFor(
      () => dom.window.document.body.textContent?.includes("new.txt") ?? false,
    );
    const rows = Array.from(
      dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-file-tree-row",
      ),
    );
    const fileRow = rows.find((row) => row.textContent?.includes("new.txt"));
    const directoryRow = rows.find((row) =>
      row.textContent?.includes("folder"),
    );
    const symbolicLinkRow = rows.find((row) =>
      row.textContent?.includes("linked.txt"),
    );
    assert.ok(fileRow);
    assert.ok(directoryRow);
    assert.ok(symbolicLinkRow);
    assert.equal(directoryRow.getAttribute("aria-expanded"), "false");
    assert.equal(fileRow.hasAttribute("aria-expanded"), false);
    assert.equal(symbolicLinkRow.hasAttribute("aria-expanded"), false);
    assert.equal(refresh.disabled, true);
    assert.equal(refresh.getAttribute("aria-busy"), "true");
    assert.ok(refresh.querySelector(".button-content-spinner"));
    await act(async () => {
      pinRefresh.resolve([]);
      await pinRefresh.promise;
    });
    assert.equal(refresh.disabled, false);
    assert.equal(refresh.getAttribute("aria-busy"), "false");
    assert.equal(refresh.querySelector(".button-content-spinner"), null);
    await act(async () => {
      fileRow.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
      fileRow.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, ctrlKey: true }),
      );
      directoryRow.dispatchEvent(
        new dom.window.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 12,
          clientY: 18,
        }),
      );
      fileRow.dispatchEvent(
        new dom.window.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 24,
          clientY: 48,
        }),
      );
      symbolicLinkRow.dispatchEvent(
        new dom.window.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 30,
          clientY: 60,
        }),
      );
      await Promise.resolve();
    });
    assert.deepEqual(openedFiles, [
      { relativePath: "new.txt", openInWindow: false },
      { relativePath: "new.txt", openInWindow: true },
    ]);
    assert.deepEqual(pathMenuRequests, [
      {
        sessionId: "session-1",
        rootId: "workspace",
        relativePath: "",
        nodeKind: "root",
        canInsert: true,
        point: { x: 6, y: 9 },
      },
      {
        sessionId: "session-1",
        rootId: "workspace",
        relativePath: "folder",
        nodeKind: "directory",
        canInsert: true,
        point: { x: 12, y: 18 },
      },
      {
        sessionId: "session-1",
        rootId: "workspace",
        relativePath: "new.txt",
        nodeKind: "file",
        canInsert: true,
        point: { x: 24, y: 48 },
      },
    ]);
    assert.equal(
      dom.window.document.querySelector(".session-file-tree-feedback")
        ?.textContent,
      "Path action failed.",
    );

    assert.match(dom.window.document.body.textContent ?? "", /new\.txt/);
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /old\.txt/);
    await act(async () => directoryRow.click());
    assert.equal(directoryRow.getAttribute("aria-expanded"), "true");
    await act(async () => {
      directoryRequests[2]?.resolve([]);
      await directoryRequests[2]?.promise;
      directoryRow.click();
    });
    assert.equal(directoryRow.getAttribute("aria-expanded"), "false");

    await act(async () => {
      root?.render(
        React.createElement(SessionFileExplorerPane, {
          api,
          sessionId: "session-1",
          enabled: true,
          rootsRevision: "roots-1",
          selectedFile: null,
          activeTab: "changes",
          /** Changes の更新ラベルを調べる間、タブの選択を固定する。 */
          onActiveTabChange() {},
          /** Changes の更新ボタンから、Files とは別の再取得が呼ばれたことを記録する。 */
          onRefreshChanges() {
            changesRefreshCalls += 1;
          },
          /** Changes 更新の検査ではファイルを開かない。 */
          onOpenFile() {},
          canInsertPathReference: false,
          /** Changes タブではパス挿入を無効にしておき、入力を変更しない。 */
          onInsertPathReference() {},
          /** 更新先のタブを判別できる固定の Changes 本文を表示する。 */
          renderChangesContent: () =>
            React.createElement("div", null, "Changes content"),
        }),
      );
    });
    const changesRefresh = dom.window.document.querySelector<HTMLButtonElement>(
      ".session-file-explorer-refresh",
    );
    assert.ok(changesRefresh);
    assert.equal(changesRefresh.ariaLabel, "Refresh changes");
    await act(async () => changesRefresh.click());
    assert.equal(changesRefreshCalls, 1);

    listedRoots = [];
    await act(async () => {
      root?.render(
        React.createElement(SessionFileExplorerPane, {
          api,
          sessionId: "session-1",
          enabled: true,
          rootsRevision: "roots-empty",
          selectedFile: null,
          activeTab: "files",
          /** ルートが空の検証中は Files から別タブへ移動しない。 */
          onActiveTabChange() {},
          /** 空の Files だけを表示するため、Changes の再取得は行わない。 */
          onRefreshChanges() {},
          /** ファイル行がない空状態では、別の表示を開かない。 */
          onOpenFile() {},
          canInsertPathReference: false,
          /** 空のルートには挿入先のパスがなく、Composer を変更しない。 */
          onInsertPathReference() {},
        }),
      );
    });
    const filesPanel = dom.window.document.querySelector<HTMLElement>(
      ".session-file-explorer-body",
    );
    await waitFor(() => filesPanel?.getAttribute("aria-busy") === "false");
    assert.equal(filesPanel?.querySelector(".session-file-tree-status"), null);

    rejectRoots = true;
    await act(async () => {
      root?.render(
        React.createElement(SessionFileExplorerPane, {
          api,
          sessionId: "session-1",
          enabled: true,
          rootsRevision: "roots-error",
          selectedFile: null,
          activeTab: "files",
          /** ルート取得失敗時はアクティブな Files タブを維持する。 */
          onActiveTabChange() {},
          /** Files エラーからの回復では Changes の更新を行わない。 */
          onRefreshChanges() {},
          /** 診断詳細と再試行の検証中はファイルを開かない。 */
          onOpenFile() {},
          canInsertPathReference: false,
          /** 取得失敗時にはパス挿入を行わず、エラーの表示だけを観測する。 */
          onInsertPathReference() {},
        }),
      );
      await Promise.resolve();
    });
    await waitFor(
      () => !!filesPanel?.querySelector('[aria-label="Files Error Details"]'),
    );
    assert.equal(
      filesPanel
        ?.querySelector(".session-file-tree-error")
        ?.getAttribute("role"),
      "alert",
    );
    assert.equal(refresh.disabled, false);
    assert.equal(refresh.getAttribute("aria-busy"), "false");
    assert.equal(refresh.querySelector(".button-content-spinner"), null);
    assert.ok(
      Array.from(filesPanel?.querySelectorAll("button") ?? []).some(
        (button) => button.textContent === "Retry Files",
      ),
    );

    const details = filesPanel!.querySelector<HTMLButtonElement>(
      '[aria-label="Files Error Details"]',
    )!;
    /** 開いた診断ダイアログの本文とフォーカスを調べるため、現在の要素を取り直す。 */
    const dialog = () =>
      dom.window.document.querySelector<HTMLElement>('[role="dialog"]');
    assert.equal(details.getAttribute("aria-expanded"), "false");
    await act(async () => details.click());
    assert.equal(details.getAttribute("aria-expanded"), "true");
    assert.equal(
      dialog()?.querySelector("p")?.textContent,
      "File roots failed.",
    );
    assert.equal(dom.window.document.activeElement, dialog());
    await act(async () =>
      dialog()?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      ),
    );
    assert.equal(dialog(), null);
    assert.equal(dom.window.document.activeElement, details);
    assert.equal(details.getAttribute("aria-expanded"), "false");
    await act(async () => details.click());
    await act(async () =>
      dialog()
        ?.querySelector<HTMLButtonElement>('[aria-label="Close Error Details"]')
        ?.click(),
    );
    assert.equal(dom.window.document.activeElement, details);
    assert.equal(dialog(), null);
    await act(async () => details.click());
    await act(async () => details.click());
    assert.equal(dialog(), null);
    await act(async () => details.click());
    await act(async () => {
      refresh.focus();
      refresh.dispatchEvent(
        new dom.window.Event("pointerdown", { bubbles: true }),
      );
    });
    assert.equal(dialog(), null);
    assert.equal(dom.window.document.activeElement, refresh);

    rejectRoots = false;
    await act(async () => {
      Array.from(filesPanel!.querySelectorAll("button"))
        .find((button) => button.textContent === "Retry Files")!
        .click();
    });
    await waitFor(() => !filesPanel?.querySelector(".session-file-tree-error"));
    assert.equal(filesPanel?.getAttribute("aria-busy"), "false");

    rejectPins = true;
    await act(async () => refresh.click());
    await waitFor(
      () => !!filesPanel?.querySelector('[aria-label="Pins Error Details"]'),
    );
    const pinsDetails = filesPanel!.querySelector<HTMLButtonElement>(
      '[aria-label="Pins Error Details"]',
    )!;
    await act(async () => pinsDetails.click());
    assert.equal(dialog()?.querySelector("p")?.textContent, "Pins failed.");
    rejectPins = false;
    await act(async () => {
      Array.from(filesPanel!.querySelectorAll("button"))
        .find((button) => button.textContent === "Retry Pins")!
        .click();
    });
    await waitFor(() => !filesPanel?.querySelector(".session-file-tree-error"));
    assert.equal(dialog(), null);
    assert.equal(filesPanel?.getAttribute("aria-busy"), "false");

    rejectRoots = true;
    await act(async () => refresh.click());
    await waitFor(
      () => !!filesPanel?.querySelector('[aria-label="Files Error Details"]'),
    );
    await act(async () =>
      filesPanel!
        .querySelector<HTMLButtonElement>('[aria-label="Files Error Details"]')!
        .click(),
    );
    assert.ok(dialog());

    await act(async () => {
      root?.render(
        React.createElement(SessionFileExplorerPane, {
          api,
          sessionId: "session-1",
          enabled: false,
          rootsRevision: "roots-unavailable",
          selectedFile: null,
          activeTab: "files",
          /** 無効化時の Files 表示を検査するため、タブ変更は反映しない。 */
          onActiveTabChange() {},
          /** ペイン無効化の確認では Changes を再取得しない。 */
          onRefreshChanges() {},
          /** 利用不可としているペインからファイルを開かない。 */
          onOpenFile() {},
          canInsertPathReference: false,
          /** 無効化時にはパス挿入先の入力を変更しない。 */
          onInsertPathReference() {},
        }),
      );
    });
    await waitFor(() => filesPanel?.getAttribute("aria-busy") === "false");
    assert.equal(filesPanel?.querySelector(".session-file-tree-status"), null);
    assert.equal(dialog(), null);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
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
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: previousNavigator,
    });
    dom.window.HTMLElement.prototype.getBoundingClientRect =
      previousGetBoundingClientRect;
    if (previousClientHeight) {
      Object.defineProperty(
        dom.window.HTMLElement.prototype,
        "clientHeight",
        previousClientHeight,
      );
    }
    if (previousClientWidth) {
      Object.defineProperty(
        dom.window.HTMLElement.prototype,
        "clientWidth",
        previousClientWidth,
      );
    }
    if (previousOffsetHeight) {
      Object.defineProperty(
        dom.window.HTMLElement.prototype,
        "offsetHeight",
        previousOffsetHeight,
      );
    }
    if (previousOffsetWidth) {
      Object.defineProperty(
        dom.window.HTMLElement.prototype,
        "offsetWidth",
        previousOffsetWidth,
      );
    }
    dom.window.close();
  }
});

// @test-value v1
// kind = "invariant"
// claim = "path insertion resultはaction確定時にも同じactive owner・root revisionかつ書き込み可能なcomposerだけへ渡る"
// oracle = { type = "contract", ref = "accepted behavior: File Explorer path insertion owner revalidation" }
// failure_mode = "menu表示後のowner・root切替またはcomposer無効化後にstale pathを別ownerや書き込み不可draftへ挿入する"
// scope = "SessionFileExplorerPane path insertion result boundary"
// lifecycle = "permanent"
// distinction = "menu request時の状態ではなくresult適用時の最新owner、root revision、capabilityを観測する"
// @end-test-value
/** メニュー結果を適用する時点で、Session・ルートの改訂・書込可否を再確認し、一致する場合だけパスを挿入する。 */
test("SessionFileExplorerPane は path insertion result適用時にowner・root・capabilityを再確認する", async () => {
  const { applySessionFileTreePathInsertionResult } =
    await import("../../src/file-explorer/SessionFileExplorerPane.js");
  const inserted: string[] = [];
  const result = {
    status: "insert-path",
    ownerSessionId: "session-1",
    absolutePath: "C:\\workspace\\docs\\report.md",
  };
  /** 挿入処理まで到達した絶対パスを集め、拒否ケースが混入しないか検査する。 */
  const insertPathReference = (_ownerSessionId: string, absolutePath: string) =>
    inserted.push(absolutePath);

  assert.equal(
    applySessionFileTreePathInsertionResult({
      result,
      currentOwnerSessionId: "session-2",
      requestedRootsRevision: "roots-1",
      currentRootsRevision: "roots-1",
      canInsert: true,
      insertPathReference,
    }),
    false,
  );
  assert.equal(
    applySessionFileTreePathInsertionResult({
      result,
      currentOwnerSessionId: "session-1",
      requestedRootsRevision: "roots-1",
      currentRootsRevision: "roots-1",
      canInsert: false,
      insertPathReference,
    }),
    false,
  );
  assert.equal(
    applySessionFileTreePathInsertionResult({
      result,
      currentOwnerSessionId: "session-1",
      requestedRootsRevision: "roots-1",
      currentRootsRevision: "roots-2",
      canInsert: true,
      insertPathReference,
    }),
    false,
  );
  assert.equal(
    applySessionFileTreePathInsertionResult({
      result,
      currentOwnerSessionId: "session-1",
      requestedRootsRevision: "roots-1",
      currentRootsRevision: "roots-1",
      canInsert: true,
      insertPathReference,
    }),
    true,
  );
  assert.deepEqual(inserted, ["C:\\workspace\\docs\\report.md"]);
});

// @test-value v2
// kind = "invariant"
// claim = "非同期menu結果はReactへcommit済みのowner snapshotだけを参照してpathを挿入する"
// oracle = { type = "contract", ref = "accepted behavior invariant 2: insertion targets the current active writable composer" }
// fault = "concurrent renderが中断されたとき、未commit renderのcallbackをcurrent ownerとしてpath挿入へ使う"
// observable = "確定renderと未確定renderそれぞれの挿入callbackに届いたpath集合"
// observation_boundary = "component-behavior"
// scope = "SessionFileExplorerPane committed insertion owner snapshot"
// lifecycle = "permanent"
// distinction = "通常のowner切替ではなく、同じowner identityの中断renderがrefだけを先行更新する競合を観測する"
// @end-test-value
/** 同じ所有者へ再描画を開始してもコミット前に中断した場合、旧メニュー結果を未確定のコールバックへ渡さない。 */
test("SessionFileExplorerPane は中断renderのowner callbackへpathを挿入しない", async () => {
  const previousActEnvironment = (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousElement = globalThis.Element;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      pretendToBeVisual: true,
    },
  );
  const previousGetBoundingClientRect =
    dom.window.HTMLElement.prototype.getBoundingClientRect;
  const previousClientHeight = Object.getOwnPropertyDescriptor(
    dom.window.HTMLElement.prototype,
    "clientHeight",
  );
  const previousClientWidth = Object.getOwnPropertyDescriptor(
    dom.window.HTMLElement.prototype,
    "clientWidth",
  );
  const previousOffsetHeight = Object.getOwnPropertyDescriptor(
    dom.window.HTMLElement.prototype,
    "offsetHeight",
  );
  const previousOffsetWidth = Object.getOwnPropertyDescriptor(
    dom.window.HTMLElement.prototype,
    "offsetWidth",
  );
  dom.window.HTMLElement.prototype.getBoundingClientRect =
    function getBoundingClientRect() {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 320,
        bottom: 480,
        width: 320,
        height: 480,
        /** 固定のレイアウト矩形は座標だけを使い、JSON には変換しない。 */
        toJSON: () => ({}),
      };
    };
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", {
    configurable: true,
    /** メニューを開ける仮想表示領域としてクライアント高さを固定する。 */
    get: () => 480,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", {
    configurable: true,
    /** JSDOM のクライアント幅に、テスト用の表示領域幅を設定する。 */
    get: () => 320,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    /** 要素の高さを取得する経路でも、同じ固定のレイアウト値を返す。 */
    get: () => 480,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    /** 要素の幅の測定もクライアント幅と同じ値にそろえる。 */
    get: () => 320,
  });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
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
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  const { SessionFileExplorerPane } =
    await import("../../src/file-explorer/SessionFileExplorerPane.js");
  const menuResult = deferred<{
    status: "insert-path";
    ownerSessionId: string;
    absolutePath: string;
  }>();
  const suspendedRender = deferred<void>();
  const committedInsertions: string[] = [];
  const uncommittedInsertions: string[] = [];
  const api = {
    ...emptyPinsApi,
    /** メニューを呼び出せる Workspace ルートを一つ表示する。 */
    async listSessionFileRoots() {
      return [
        {
          id: "workspace",
          kind: "workspace" as const,
          label: "Workspace",
          displayPath: "C:\\workspace",
        },
      ];
    },
    /** コンテキストメニューはルート行で開くため、配下の項目は用意しない。 */
    async listSessionDirectory() {
      return [];
    },
    /** 再描画が保留になるまで、開いたパスメニューの完了を遅らせる。 */
    showSessionFileTreeContextMenu() {
      return menuResult.promise;
    },
  };
  /** Suspense 境界の兄弟を待機させ、ペインに新しい props が渡ってもコミットできない状態を作る。 */
  function SuspendedSibling({ suspend }: { suspend: boolean }) {
    if (suspend) {
      throw suspendedRender.promise;
    }
    return null;
  }
  /** 表示済みと未確定の描画で、同じ所有者とルートに異なる挿入コールバックを渡す。 */
  const renderPane = (
    onInsertPathReference: (
      ownerSessionId: string,
      absolutePath: string,
    ) => void,
    suspend: boolean,
  ) =>
    React.createElement(
      React.Suspense,
      { fallback: null },
      React.createElement(SessionFileExplorerPane, {
        api,
        sessionId: "session-1",
        enabled: true,
        rootsRevision: "roots-1",
        selectedFile: null,
        activeTab: "files",
        /** メニューから操作する Files は、移行中もアクティブなままにする。 */
        onActiveTabChange() {},
        /** 遅延メニューだけを検査し、Changes の更新は行わない。 */
        onRefreshChanges() {},
        /** メニューを開くテストではファイル表示を起動しない。 */
        onOpenFile() {},
        canInsertPathReference: true,
        onInsertPathReference,
      }),
      React.createElement(SuspendedSibling, { suspend }),
    );

  let root: Root | null = null;
  try {
    await act(async () => {
      root = createRoot(
        dom.window.document.getElementById("root") as HTMLElement,
      );
      root.render(
        renderPane(
          (_ownerSessionId, absolutePath) =>
            committedInsertions.push(absolutePath),
          false,
        ),
      );
      await Promise.resolve();
    });
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(
      () =>
        dom.window.document.querySelector(".session-file-root-row") !== null,
    );
    dom.window.document
      .querySelector<HTMLButtonElement>(".session-file-root-row")
      ?.dispatchEvent(
        new dom.window.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
        }),
      );

    await act(async () => {
      React.startTransition(() => {
        root?.render(
          renderPane(
            (_ownerSessionId, absolutePath) =>
              uncommittedInsertions.push(absolutePath),
            true,
          ),
        );
      });
      await Promise.resolve();
    });
    await act(async () => {
      menuResult.resolve({
        status: "insert-path",
        ownerSessionId: "session-1",
        absolutePath: "C:\\workspace\\report.md",
      });
      await menuResult.promise;
    });
    assert.deepEqual(committedInsertions, ["C:\\workspace\\report.md"]);
    assert.deepEqual(uncommittedInsertions, []);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
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
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: previousNavigator,
    });
    dom.window.HTMLElement.prototype.getBoundingClientRect =
      previousGetBoundingClientRect;
    if (previousClientHeight) {
      Object.defineProperty(
        dom.window.HTMLElement.prototype,
        "clientHeight",
        previousClientHeight,
      );
    }
    if (previousClientWidth) {
      Object.defineProperty(
        dom.window.HTMLElement.prototype,
        "clientWidth",
        previousClientWidth,
      );
    }
    if (previousOffsetHeight) {
      Object.defineProperty(
        dom.window.HTMLElement.prototype,
        "offsetHeight",
        previousOffsetHeight,
      );
    }
    if (previousOffsetWidth) {
      Object.defineProperty(
        dom.window.HTMLElement.prototype,
        "offsetWidth",
        previousOffsetWidth,
      );
    }
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "SessionFileExplorerPaneはowner単位でtabをlazy mountし、tab切替では保持してowner変更時に破棄する"
// oracle = { type = "contract", ref = "accepted behavior: in-window File Explorer tab state retention" }
// fault = "tab切替で取得結果が失われるか、Sessionまたはroot集合の変更後も旧panel stateが残る"
// observable = "各tab panelのmount有無、buttonのlocal counter、Sessionとroot変更後のcounter初期化"
// observation_boundary = "component-behavior"
// scope = "SessionFileExplorerPane tab panel lifecycle"
// lifecycle = "permanent"
// distinction = "同一owner内のtab切替と、Session・root集合によるowner変更を一つのlifecycleとして扱う"
// @end-test-value
/** 未訪問のタブはマウントせず、訪問後は同じ所有者内で状態を保ち、ルートか Session の切替で初期化する。 */
test("SessionFileExplorerPane は訪問済みtab panelを保持する", async () => {
  const previousActEnvironment = (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousElement = globalThis.Element;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      pretendToBeVisual: true,
    },
  );
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
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
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  const { SessionFileExplorerPane } =
    await import("../../src/file-explorer/SessionFileExplorerPane.js");

  /** マウントし直されたか判定できるように、パネル名付きのローカルカウンターを表示する。 */
  function StatefulPanel({ name }: { name: string }) {
    const [count, setCount] = React.useState(0);
    return React.createElement(
      "button",
      {
        type: "button",
        "data-panel": name,
        /** クリック数を保持し、タブを戻したときの再マウントを検出できるようにする。 */
        onClick: () => setCount((current) => current + 1),
      },
      `${name}:${count}`,
    );
  }

  const api = {
    ...emptyPinsApi,
    /** パネルの維持だけを調べるため、ファイルルートを必要としない空の一覧を返す。 */
    async listSessionFileRoots() {
      return [];
    },
    /** ディレクトリの取得に依存せずタブを操作できるよう、空の配下を返す。 */
    async listSessionDirectory() {
      return [];
    },
    /** ファイルメニューの動作を扱わないケースでは、操作なしとして閉じる。 */
    async showSessionFileTreeContextMenu() {
      return { status: "dismissed" as const };
    },
  };
  /** タブ選択を制御し、ルート改訂や Session を替えても選択中パネルの状態の初期化を観測できるようにする。 */
  function Harness({
    sessionId,
    rootsRevision,
  }: {
    sessionId: string;
    rootsRevision: string;
  }) {
    const [activeTab, setActiveTab] = React.useState<
      "files" | "changes" | "history"
    >("files");
    return React.createElement(SessionFileExplorerPane, {
      api,
      sessionId,
      enabled: true,
      rootsRevision,
      selectedFile: null,
      activeTab,
      onActiveTabChange: setActiveTab,
      /** タブのマウント状態を調べる間は Changes の内容を再読込しない。 */
      onRefreshChanges() {},
      /** 各タブのカウンター検証ではファイルを開かない。 */
      onOpenFile() {},
      canInsertPathReference: false,
      /** ファイルのないタブ検証環境では、Composer に挿入しない。 */
      onInsertPathReference() {},
      /** Changes を初めて表示するときに、保持状態を検査するカウンターパネルを生成する。 */
      renderChangesContent: () =>
        React.createElement(StatefulPanel, { name: "changes" }),
      historyContent: React.createElement(StatefulPanel, { name: "history" }),
    });
  }

  let root: Root | null = null;
  try {
    await act(async () => {
      root = createRoot(
        dom.window.document.getElementById("root") as HTMLElement,
      );
      root.render(
        React.createElement(Harness, {
          sessionId: "session-1",
          rootsRevision: "roots-1",
        }),
      );
      await Promise.resolve();
    });
    assert.equal(
      dom.window.document.querySelector("[data-panel='changes']"),
      null,
    );
    assert.equal(
      dom.window.document.querySelector("[data-panel='history']"),
      null,
    );

    const tabs = Array.from(
      dom.window.document.querySelectorAll<HTMLButtonElement>("[role='tab']"),
    );
    const filesTab = tabs.find((tab) => tab.textContent === "Files");
    const changesTab = tabs.find((tab) => tab.textContent === "Changes");
    const historyTab = tabs.find((tab) => tab.textContent === "History");
    assert.ok(filesTab);
    assert.ok(changesTab);
    assert.ok(historyTab);

    await act(async () => changesTab.click());
    const changesPanel = dom.window.document.querySelector<HTMLButtonElement>(
      "[data-panel='changes']",
    );
    assert.ok(changesPanel);
    await act(async () => changesPanel.click());
    assert.equal(changesPanel.textContent, "changes:1");

    await act(async () => historyTab.click());
    assert.equal(
      changesPanel.closest("[role='tabpanel']")?.hasAttribute("hidden"),
      true,
    );
    const historyPanel = dom.window.document.querySelector<HTMLButtonElement>(
      "[data-panel='history']",
    );
    assert.ok(historyPanel);
    await act(async () => historyPanel.click());
    assert.equal(historyPanel.textContent, "history:1");

    await act(async () => filesTab.click());
    assert.equal(
      historyPanel.closest("[role='tabpanel']")?.hasAttribute("hidden"),
      true,
    );
    await act(async () => changesTab.click());
    assert.equal(changesPanel.textContent, "changes:1");
    await act(async () => historyTab.click());
    assert.equal(historyPanel.textContent, "history:1");
    await act(async () => {
      root?.render(
        React.createElement(Harness, {
          sessionId: "session-1",
          rootsRevision: "roots-2",
        }),
      );
      await Promise.resolve();
    });
    const nextHistoryPanel =
      dom.window.document.querySelector<HTMLButtonElement>(
        "[data-panel='history']",
      );
    assert.ok(nextHistoryPanel);
    assert.notEqual(nextHistoryPanel, historyPanel);
    assert.equal(nextHistoryPanel.textContent, "history:0");
    await act(async () => changesTab.click());
    const nextChangesPanel =
      dom.window.document.querySelector<HTMLButtonElement>(
        "[data-panel='changes']",
      );
    assert.ok(nextChangesPanel);
    assert.notEqual(nextChangesPanel, changesPanel);
    await act(async () => nextChangesPanel.click());
    assert.equal(nextChangesPanel.textContent, "changes:1");
    await act(async () => {
      root?.render(
        React.createElement(Harness, {
          sessionId: "session-2",
          rootsRevision: "roots-2",
        }),
      );
      await Promise.resolve();
    });
    const nextSessionChangesPanel =
      dom.window.document.querySelector<HTMLButtonElement>(
        "[data-panel='changes']",
      );
    assert.ok(nextSessionChangesPanel);
    assert.notEqual(nextSessionChangesPanel, nextChangesPanel);
    assert.equal(nextSessionChangesPanel.textContent, "changes:0");
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
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
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: previousNavigator,
    });
    dom.window.close();
  }
});
