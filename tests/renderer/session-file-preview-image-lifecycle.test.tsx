import { readStylesheet } from "../support/read-stylesheet.js";
import { installIntersectionObserver } from "../support/intersection-observer.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  SessionDiffPreview,
  SessionFilePreview,
} from "../../src/file-explorer/SessionFilePreview.js";
import { areSessionFileResourcesEqual } from "../../src-shared/file-explorer/file-explorer-contract.js";
import type {
  SessionFileDescriptor,
  SessionFileGitCommitResourceRequest,
  SessionFileRootResourceRequest,
  SessionFileResourceRequest,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import { STRUCTURED_TEXT_PREVIEW_MAX_BYTES } from "../../src/file-explorer/structured-text-preview.js";
import type {
  HtmlPreviewMountRequest,
  WithMateHtmlPreviewApi,
} from "../../src-shared/window/html-preview.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** プレビューコンポーネントがテストから差し替えられる API の契約。 */
type PreviewApi = NonNullable<
  React.ComponentProps<typeof SessionFilePreview>["api"]
>;

const DEFAULT_IMAGE_COPY_API: Pick<
  PreviewApi,
  | "isSessionFileObjectCopyAvailable"
  | "copySessionFileObject"
  | "copySessionFilePreviewImage"
  | "showSessionFilePreviewImageContextMenu"
  | "openSessionFilePreviewWindow"
  | "inspectSessionImage"
  | "readSessionImageChunk"
> = {
  /** 既定の画像 API は共通 PNG フィクスチャのメタデータを返す。 */
  async inspectSessionImage() {
    return IMAGE_DESCRIPTOR;
  },
  /** 要求範囲の画像バイトと次の開始位置を返し、末尾に達したかを通知する。 */
  async readSessionImageChunk(request) {
    const chunk = IMAGE_BYTES.slice(
      request.offset,
      request.offset + request.length,
    );
    return {
      data: copyArrayBuffer(chunk),
      offset: request.offset,
      nextOffset: request.offset + chunk.byteLength,
      totalBytes: IMAGE_BYTES.byteLength,
      done: request.offset + chunk.byteLength >= IMAGE_BYTES.byteLength,
      revision: request.expectedRevision,
    };
  },
  /** 既定ではファイル自体のコピー操作を表示させない。 */
  isSessionFileObjectCopyAvailable() {
    return false;
  },
  /** ファイル自体のコピー成功を固定の通知文とともに返す。 */
  async copySessionFileObject() {
    return { status: "copied", message: "File copied." };
  },
  /** 画像のコピー成功を返し、実際のクリップボード操作は行わない。 */
  async copySessionFilePreviewImage() {
    return { status: "copied" };
  },
  /** 既定の画像メニューは選択せず閉じた扱いにする。 */
  async showSessionFilePreviewImageContextMenu() {
    return { status: "dismissed" };
  },
  /** OS を起動せず、別窓プレビューが開いた扱いの結果を返す。 */
  async openSessionFilePreviewWindow() {
    return {
      status: "opened",
      targetType: "preview-window",
      disposition: "created",
      resource: MARKDOWN_REQUEST,
    };
  },
};

const MARKDOWN_REQUEST: SessionFileRootResourceRequest = {
  sessionId: "session-1",
  rootId: "workspace",
  relativePath: "docs/readme.md",
};
const MARKDOWN_BYTES = new TextEncoder().encode("![sample](./image.png)");
const IMAGE_BYTES = Uint8Array.of(137, 80, 78, 71);

/** ルート相対パスとワークスペース内絶対パスをフィクスチャ照合用の表記に揃える。 */
function resourcePath(
  resource: { relativePath: string } | { absolutePath: string },
): string {
  return "relativePath" in resource
    ? resource.relativePath
    : resource.absolutePath
        .replaceAll("\\", "/")
        .replace(/^C:\/workspace\//, "");
}

const MARKDOWN_DESCRIPTOR: SessionFileDescriptor = {
  ...MARKDOWN_REQUEST,
  absoluteFilePath: "C:\\workspace\\docs\\readme.md",
  name: "readme.md",
  kind: "markdown",
  byteLength: MARKDOWN_BYTES.byteLength,
  modifiedAt: "2026-08-02T00:00:00.000Z",
  mimeType: "text/markdown",
  suggestedEncoding: "utf-8",
  revision: "markdown-r1",
};
const IMAGE_DESCRIPTOR: SessionFileDescriptor = {
  sessionId: "session-1",
  rootId: "workspace",
  relativePath: "docs/image.png",
  absoluteFilePath: "C:\\workspace\\docs\\image.png",
  name: "image.png",
  kind: "image",
  byteLength: IMAGE_BYTES.byteLength,
  modifiedAt: "2026-08-02T00:00:00.000Z",
  mimeType: "image/png",
  suggestedEncoding: "utf-8",
  revision: "image-r1",
};

/** 描画に必要な DOM グローバルを差し替え、テスト後に元へ戻す関数を返す。 */
function installDomGlobals(dom: JSDOM): () => void {
  const intersection = installIntersectionObserver();
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousMutationObserver = globalThis.MutationObserver;
  const previousNode = globalThis.Node;

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
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: dom.window.requestAnimationFrame.bind(dom.window),
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: dom.window.HTMLElement,
  });
  Object.defineProperty(globalThis, "MutationObserver", {
    configurable: true,
    value: dom.window.MutationObserver,
  });
  Object.defineProperty(globalThis, "Node", {
    configurable: true,
    value: dom.window.Node,
  });

  return () => {
    intersection.restore();
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
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: previousRequestAnimationFrame,
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      value: previousCancelAnimationFrame,
    });
    Object.defineProperty(globalThis, "HTMLElement", {
      configurable: true,
      value: previousHTMLElement,
    });
    Object.defineProperty(globalThis, "MutationObserver", {
      configurable: true,
      value: previousMutationObserver,
    });
    Object.defineProperty(globalThis, "Node", {
      configurable: true,
      value: previousNode,
    });
  };
}

/** 指定した位置と寸法からプレビューのレイアウト計算に渡す矩形を作る。 */
function createRect(input: {
  left: number;
  top: number;
  width: number;
  height: number;
}): DOMRect {
  return {
    ...input,
    right: input.left + input.width,
    bottom: input.top + input.height,
    x: input.left,
    y: input.top,
    /** 矩形の JSON 化はテスト対象外なので空のオブジェクトを返す。 */
    toJSON: () => ({}),
  } as DOMRect;
}

/** レイアウト計算をしない JSDOM に固定寸法を与え、差し替え前の定義を復元可能にする。 */
function installElementSize(dom: JSDOM): () => void {
  const prototype = dom.window.HTMLElement.prototype;
  const previousOffsetWidth = Object.getOwnPropertyDescriptor(
    prototype,
    "offsetWidth",
  );
  const previousOffsetHeight = Object.getOwnPropertyDescriptor(
    prototype,
    "offsetHeight",
  );
  const previousClientWidth = Object.getOwnPropertyDescriptor(
    prototype,
    "clientWidth",
  );
  const previousClientHeight = Object.getOwnPropertyDescriptor(
    prototype,
    "clientHeight",
  );
  Object.defineProperty(prototype, "offsetWidth", {
    configurable: true,
    /** 要素の外寸幅を固定する。 */
    get: () => 800,
  });
  Object.defineProperty(prototype, "offsetHeight", {
    configurable: true,
    /** 要素の外寸高を固定する。 */
    get: () => 600,
  });
  Object.defineProperty(prototype, "clientWidth", {
    configurable: true,
    /** 表示領域の幅を固定して仮想行の寸法計算に使わせる。 */
    get: () => 800,
  });
  Object.defineProperty(prototype, "clientHeight", {
    configurable: true,
    /** 表示領域の高さを固定し、仮想化が参照できるようにする。 */
    get: () => 600,
  });
  return () => {
    if (previousClientWidth)
      Object.defineProperty(prototype, "clientWidth", previousClientWidth);
    else Reflect.deleteProperty(prototype, "clientWidth");
    if (previousClientHeight)
      Object.defineProperty(prototype, "clientHeight", previousClientHeight);
    else Reflect.deleteProperty(prototype, "clientHeight");
    if (previousOffsetWidth) {
      Object.defineProperty(prototype, "offsetWidth", previousOffsetWidth);
    } else {
      Reflect.deleteProperty(prototype, "offsetWidth");
    }
    if (previousOffsetHeight) {
      Object.defineProperty(prototype, "offsetHeight", previousOffsetHeight);
    } else {
      Reflect.deleteProperty(prototype, "offsetHeight");
    }
  };
}

/** 元のビューとは独立した、正確に同じ長さのバッファを応答用に作る。 */
function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** テスト側で完了・失敗の順序を制御できる保留中の処理を作る。 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

/** Markdown と参照先画像を提供し、画像検査の回数と完了順をテスト側から制御できるようにする。 */
function createPreviewApi(
  inspectImage: (callCount: number) => Promise<SessionFileDescriptor>,
): { api: PreviewApi; getImageInspectCount: () => number } {
  let imageInspectCount = 0;
  const api: PreviewApi = {
    ...DEFAULT_IMAGE_COPY_API,
    /** 同じ Markdown を基準に相対画像を解決する要求だけを受け付け、その検査回数を記録する。 */
    async inspectSessionImage(request) {
      assert.deepEqual(request, {
        sessionId: MARKDOWN_REQUEST.sessionId,
        baseResource: {
          sessionId: MARKDOWN_REQUEST.sessionId,
          absolutePath: MARKDOWN_DESCRIPTOR.absoluteFilePath,
        },
        target: "./image.png",
      });
      imageInspectCount += 1;
      return inspectImage(imageInspectCount);
    },
    /** Markdown 本体は固定値を返し、それ以外は画像検査として回数を数える。 */
    async inspectSessionFile(request) {
      if (resourcePath(request) === MARKDOWN_REQUEST.relativePath) {
        return MARKDOWN_DESCRIPTOR;
      }
      imageInspectCount += 1;
      return inspectImage(imageInspectCount);
    },
    /** 対象に対応するバイト列を範囲で読み、要求のリビジョンを応答に引き継ぐ。 */
    async readSessionFileChunk(request) {
      const source =
        resourcePath(request) === MARKDOWN_REQUEST.relativePath
          ? MARKDOWN_BYTES
          : IMAGE_BYTES;
      const chunk = source.slice(
        request.offset,
        request.offset + request.length,
      );
      const nextOffset = request.offset + chunk.byteLength;
      return {
        data: copyArrayBuffer(chunk),
        offset: request.offset,
        nextOffset,
        totalBytes: source.byteLength,
        done: nextOffset >= source.byteLength,
        revision: request.expectedRevision,
      };
    },
    /** 実ファイルを開かず、正規化した対象パスを成功結果で返す。 */
    async openSessionFile(request) {
      return {
        status: "opened",
        targetType: "local-path",
        target: resourcePath(request),
      };
    },
    /** 引数のパスをローカルで開いたものとして返す。 */
    async openPath(target) {
      return { status: "opened", targetType: "local-path", target };
    },
  };
  return {
    api,
    /** 本体の検査とは別に記録した画像検査の累計を返す。 */
    getImageInspectCount: () => imageInspectCount,
  };
}

/** 渡されたテキストとリビジョンだけで完結するファイル読み込み API を用意する。 */
function createTextPreviewApi(
  request: SessionFileResourceRequest,
  name: string,
  raw: string,
  revision: string,
): PreviewApi {
  const bytes = new TextEncoder().encode(raw);
  return {
    ...DEFAULT_IMAGE_COPY_API,
    /** 入力テキストの長さと表示名を持つ UTF-8 のファイル情報を返す。 */
    async inspectSessionFile() {
      return {
        ...request,
        absoluteFilePath:
          "absolutePath" in request
            ? request.absolutePath
            : `C:/workspace/${request.relativePath}`,
        name,
        kind: "text",
        byteLength: bytes.byteLength,
        modifiedAt: "2026-08-09T00:00:00.000Z",
        mimeType: "text/plain",
        suggestedEncoding: "utf-8",
        revision,
      };
    },
    /** 指定範囲の UTF-8 バイトと終端情報を、要求されたリビジョン付きで返す。 */
    async readSessionFileChunk(chunkRequest) {
      const chunk = bytes.slice(
        chunkRequest.offset,
        chunkRequest.offset + chunkRequest.length,
      );
      return {
        data: copyArrayBuffer(chunk),
        offset: chunkRequest.offset,
        nextOffset: chunkRequest.offset + chunk.byteLength,
        totalBytes: bytes.byteLength,
        done: chunkRequest.offset + chunk.byteLength >= bytes.byteLength,
        revision: chunkRequest.expectedRevision,
      };
    },
    /** フィクスチャのファイルを開けた扱いにし、OS へは接続しない。 */
    async openSessionFile() {
      return {
        status: "opened",
        targetType: "local-path",
        target: resourcePath(request),
      };
    },
    /** 渡されたリンク先をローカルパスの成功結果にする。 */
    async openPath(target) {
      return { status: "opened", targetType: "local-path", target };
    },
  };
}

/** React の更新を進めながら条件を待ち、期限まで成立しなければテストを失敗させる。 */
async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  assert.fail("Timed out waiting for preview state.");
}

/** エンコーディング欄の値を変更し、バブリングするイベントで実際の切替処理を起動する。 */
async function changeEncoding(
  container: HTMLElement,
  dom: JSDOM,
  value: string,
): Promise<void> {
  const select = container.querySelector<HTMLSelectElement>(
    "select[aria-label='Text encoding']",
  );
  assert.ok(select);
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}

/** API と対象を指定してプレビューをマウントし、呼び出し元が破棄するルートを返す。 */
async function renderPreview(
  api: PreviewApi,
  container: HTMLElement,
  request: SessionFileResourceRequest = MARKDOWN_REQUEST,
  extraProps: Partial<React.ComponentProps<typeof SessionFilePreview>> = {},
): Promise<Root> {
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(SessionFilePreview, {
        api,
        request,
        /** 個別テストが指定しない限りテキストのコピーを外部に送らない。 */
        onCopyText() {},
        /** 個別テストが指定しない限りテキストの引用を外部に送らない。 */
        onQuoteText() {},
        ...extraProps,
      }),
    );
  });
  return root;
}

// @test-value v2
// kind = "contract"
// claim = "通常とGit履歴のMarkdown previewは許可された外部・絶対local画像の本文とlightboxから元resourceのcontextでcopy menuを開く"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md: Image Handling" }
// fault = "Git履歴でlink操作の抑止と共に画像menuを止める、画像のbaseからcommit識別を落とす、または表示blobを元pathとして渡す"
// observable = "本文・lightboxのmouse/keyboard eventのdefaultPreventedとnative menu APIのrequest"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreviewから共有Markdown画像copyへのconsumer接続"
// lifecycle = "permanent"
// impact = "履歴内で表示を認められた画像からもbitmapと元pathをcopyできる"
// distinction = "MarkdownImage単体testではconsumerが画像contextを欠落させる不具合を検出できず、通常とcommitの実previewを同じ入力で比較する"
// @end-test-value
/** 通常ファイルと Git 履歴で、本文・拡大表示から開く画像メニューに同じ元リソースの文脈が渡ることを確かめる。履歴の識別子や元の画像 URL を失う退行を検出する。 */
test("通常とGit履歴のMarkdown画像は本文とlightboxのcopy menuへcontextを渡す", async () => {
  for (const isCommit of [false, true]) {
    for (const source of [
      "data:image/png;base64,iVBORw0KGgo=",
      "/outside/image.png",
    ]) {
      const dom = new JSDOM('<!doctype html><div id="root"></div>', {
        pretendToBeVisual: true,
      });
      const restoreGlobals = installDomGlobals(dom);
      const request = isCommit
        ? {
            ...MARKDOWN_REQUEST,
            resourceKind: "git-commit-file" as const,
            repositoryId: "git:aaaaaaaaaaaaaaaaaaaaaaaa",
            commitId: "a".repeat(40),
          }
        : MARKDOWN_REQUEST;
      const menuRequests: Parameters<
        PreviewApi["showSessionFilePreviewImageContextMenu"]
      >[0][] = [];
      const baseApi = createTextPreviewApi(
        request,
        "readme.md",
        `![sample](${source})`,
        "markdown-r1",
      );
      const api: PreviewApi = {
        ...baseApi,
        /** 通常・履歴のどちらのフィクスチャも Markdown として描画させる。 */
        async inspectSessionFile(input) {
          return {
            ...(await baseApi.inspectSessionFile(input)),
            kind: "markdown",
          };
        },
        /** ネイティブメニューに届いた元リソースの文脈を記録し、メニュー自体は表示しない。 */
        async showSessionFilePreviewImageContextMenu(input) {
          menuRequests.push(input);
          return { status: "dismissed" };
        },
      };
      Object.defineProperty(dom.window, "withmate", {
        configurable: true,
        value: api,
      });
      const container = dom.window.document.getElementById("root")!;
      let root: Root | null = null;
      try {
        root = await renderPreview(api, container, request);
        await waitFor(() => container.querySelector(".message-image") !== null);
        const image =
          container.querySelector<HTMLImageElement>(".message-image")!;
        const trigger = image.closest("button")!;
        image.getBoundingClientRect = trigger.getBoundingClientRect = () =>
          createRect({ left: 10, top: 20, width: 120, height: 80 });
        await act(async () =>
          image.dispatchEvent(new dom.window.Event("load")),
        );
        const mouse = new dom.window.MouseEvent("contextmenu", {
          clientX: 40,
          clientY: 50,
          bubbles: true,
          cancelable: true,
        });
        await act(async () => image.dispatchEvent(mouse));
        const keyboard = new dom.window.KeyboardEvent("keydown", {
          key: "F10",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        });
        await act(async () => trigger.dispatchEvent(keyboard));
        await act(async () => trigger.click());
        const dialog =
          dom.window.document.querySelector<HTMLElement>('[role="dialog"]')!;
        const largeImage = dialog.querySelector("img")!;
        largeImage.getBoundingClientRect = () =>
          createRect({ left: 30, top: 40, width: 200, height: 100 });
        dialog.querySelector<HTMLElement>(
          ".image-viewport",
        )!.getBoundingClientRect = largeImage.getBoundingClientRect;
        const largeMouse = new dom.window.MouseEvent("contextmenu", {
          clientX: 80,
          clientY: 90,
          bubbles: true,
          cancelable: true,
        });
        await act(async () => largeImage.dispatchEvent(largeMouse));
        const largeKeyboard = new dom.window.KeyboardEvent("keydown", {
          key: "ContextMenu",
          bubbles: true,
          cancelable: true,
        });
        await act(async () => dialog.dispatchEvent(largeKeyboard));
        assert.deepEqual(
          [mouse, keyboard, largeMouse, largeKeyboard].map(
            (event) => event.defaultPrevented,
          ),
          [true, true, true, true],
        );
        assert.deepEqual(
          menuRequests,
          [
            { x: 40, y: 50 },
            { x: 70, y: 60 },
            { x: 80, y: 90 },
            { x: 130, y: 90 },
          ].map((point) => ({
            sessionId: "session-1",
            point,
            ...(source.startsWith("/")
              ? {
                  image: {
                    target: source,
                    baseResource: isCommit
                      ? request
                      : {
                          sessionId: "session-1",
                          absolutePath: "C:/workspace/docs/readme.md",
                        },
                  },
                }
              : {}),
          })),
        );
      } finally {
        if (root) await act(async () => root!.unmount());
        restoreGlobals();
        dom.window.close();
      }
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "file previewはheaderと本文の間の専用領域にroot・absolute・commit resourceの絶対パスをread-onlyで表示し、対象切替に追従する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 中央 file preview" }
// fault = "表示pathを相対pathへ置換する、操作群と同じ領域へ戻す、編集可能にする、または別resourceへ旧pathを表示する"
// observable = "Absolute file path欄のvalue・readOnly・全選択範囲、header/専用領域/本文のDOM順とcommit表示"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview absolute file path region"
// lifecycle = "permanent"
// impact = "利用者がプレビュー対象の実際の所在を取り違えず確認・copyできる"
// distinction = "同じAPIでrequestだけを切り替え、Main側path解決と型検査だけでは検出できない専用領域への投影と対象切替を確認する"
// @end-test-value
/** ルート相対・絶対・履歴ファイルを切り替え、専用欄の順序、読み取り専用の絶対パスと選択範囲が現在の対象に一致することを確かめる。 */
test("file preview は専用領域で絶対パスをread-only表示し対象切替へ追従する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  try {
    assert.ok(container);
    root = createRoot(container);
    const cases = [
      {
        request: MARKDOWN_REQUEST,
        absoluteFilePath: "C:\\workspace\\日本語 folder\\docs\\readme.md",
      },
      {
        request: { sessionId: "session-1", absolutePath: "/outside/notes.md" },
        absoluteFilePath: "/outside/notes.md",
      },
      {
        request: {
          resourceKind: "git-commit-file" as const,
          sessionId: "session-1",
          rootId: "workspace",
          repositoryId: "git:repo",
          commitId: "a".repeat(40),
          relativePath: "docs/readme.md",
        },
        absoluteFilePath: "C:\\workspace\\docs\\readme.md",
      },
    ];
    const api: PreviewApi = {
      ...createPreviewApi(async () => IMAGE_DESCRIPTOR).api,
      /** 要求と一致するフィクスチャだけから表示用の絶対パスを返す。 */
      async inspectSessionFile(request) {
        const selected = cases.find((item) =>
          areSessionFileResourcesEqual(item.request, request),
        );
        assert.ok(selected);
        return {
          ...request,
          absoluteFilePath: selected.absoluteFilePath,
          name: "readme.md",
          kind: "binary",
          byteLength: 4,
          modifiedAt: MARKDOWN_DESCRIPTOR.modifiedAt,
          mimeType: "application/octet-stream",
          suggestedEncoding: "utf-8",
          revision: "path-r1",
        };
      },
    };
    for (const { request, absoluteFilePath } of cases) {
      await act(async () => {
        root?.render(
          React.createElement(SessionFilePreview, {
            api,
            request,
            /** パス欄の観測では本文のコピー結果を扱わない。 */
            onCopyText() {},
          }),
        );
      });
      await waitFor(
        () =>
          container.querySelector<HTMLTextAreaElement>(
            "textarea[aria-label='Absolute file path']",
          )?.value === absoluteFilePath,
      );
      const input: HTMLTextAreaElement | null =
        container.querySelector<HTMLTextAreaElement>(
          "textarea[aria-label='Absolute file path']",
        );
      assert.ok(input);
      assert.equal(input.readOnly, true);
      input.select();
      assert.equal(input.selectionStart, 0);
      assert.equal(input.selectionEnd, absoluteFilePath.length);
      const pathRegion: HTMLElement | null = input.parentElement;
      assert.equal(
        pathRegion?.previousElementSibling,
        container.querySelector("header"),
      );
      assert.equal(
        pathRegion?.nextElementSibling,
        container.querySelector(".session-file-preview-metadata"),
      );
      if ("resourceKind" in request) {
        assert.match(
          container.querySelector(".session-file-preview-title")?.textContent ??
            "",
          /Commit aaaaaaa/,
        );
      }
    }
  } finally {
    await act(async () => root?.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "画像IPC待機中にReloadとencodingを変えてもhost全体で4並列を守り、旧処理完了後は最新世代の全画像だけを表示する"
// oracle = { type = "contract", ref = "docs/adr/026-shared-image-resource-loading.md" }
// fault = "resolver世代ごとに実行枠を増やす、古い待機画像を開始する、または新しい画像の読込が停止する"
// observable = "inspect/chunkの保留件数と最大同時数、API呼出し数、生成blob数、画像DOM"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview image loader lifecycle across reload and encoding"
// lifecycle = "permanent"
// impact = "遅い画像読込中の再操作でfilesystem負荷が増え続けることとstale画像混入を防ぐ"
// distinction = "loaderやqueue単体testで観測できない実previewの世代変更を通し、inspectとchunkの各待機点を制御する"
// @end-test-value
/** 画像検査とチャンク読み込みをそれぞれ保留し、再読み込み・エンコーディング変更でも同時実行が四件を超えず、最新の画像だけが表示されることを確かめる。 */
test("Markdown画像の4並列はReloadとencoding変更をまたいで維持される", async () => {
  for (const pendingStage of ["inspect", "chunk"] as const) {
    const dom = new JSDOM('<!doctype html><div id="root"></div>', {
      pretendToBeVisual: true,
      url: "http://localhost/",
    });
    const restoreGlobals = installDomGlobals(dom);
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const bytes = new TextEncoder().encode(
      Array.from(
        { length: 6 },
        (_, i) => `![image-${i}](./image-${i}.png)`,
      ).join("\n"),
    );
    const gates: ReturnType<typeof deferred<void>>[] = [];
    let holding = true;
    let active = 0;
    let maximumActive = 0;
    let inspections = 0;
    let reads = 0;
    let blobs = 0;
    /** 解放されるまで IPC が実行中とみなし、同時実行数の最大値を記録する。 */
    const hold = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (holding) {
          const gate = deferred<void>();
          gates.push(gate);
          await gate.promise;
        }
      } finally {
        active -= 1;
      }
    };
    URL.createObjectURL = () => `blob:current-${++blobs}`;
    URL.revokeObjectURL = () => {};
    const api: PreviewApi = {
      ...createPreviewApi(async () => IMAGE_DESCRIPTOR).api,
      /** 複数の画像参照を含む Markdown 本体のバイト長を公開する。 */
      async inspectSessionFile() {
        return { ...MARKDOWN_DESCRIPTOR, byteLength: bytes.byteLength };
      },
      /** 画像が保留されている間も Markdown 本体の読み込みは即座に完了させる。 */
      async readSessionFileChunk(request) {
        return {
          data: copyArrayBuffer(bytes),
          offset: 0,
          nextOffset: bytes.byteLength,
          totalBytes: bytes.byteLength,
          done: true,
          revision: request.expectedRevision,
        };
      },
      /** 検査段階のケースだけ、画像メタデータの応答を待機させる。 */
      async inspectSessionImage() {
        inspections += 1;
        if (pendingStage === "inspect") await hold();
        return IMAGE_DESCRIPTOR;
      },
      /** チャンク段階のケースだけ、画像バイトの応答を待機させる。 */
      async readSessionImageChunk(request) {
        reads += 1;
        if (pendingStage === "chunk") await hold();
        return DEFAULT_IMAGE_COPY_API.readSessionImageChunk(request);
      },
    };
    let root: Root | null = null;
    try {
      const container = dom.window.document.getElementById("root");
      assert.ok(container);
      root = await renderPreview(api, container);
      await waitFor(() => gates.length === 4);
      for (let i = 0; i < 2; i += 1) {
        const reload: HTMLButtonElement | undefined = Array.from(
          container.querySelectorAll("button"),
        ).find((button) => button.textContent === "Reload");
        assert.ok(reload);
        await act(async () => reload.click());
        await waitFor(
          () => container.querySelectorAll(".message-image-shell").length === 6,
        );
        assert.equal(active, 4);
        assert.equal(inspections, 4);
      }
      await changeEncoding(container, dom, "utf-8");
      await waitFor(
        () => container.querySelectorAll(".message-image-shell").length === 6,
      );
      assert.equal(active, 4);
      assert.equal(inspections, 4);
      assert.equal(reads, pendingStage === "chunk" ? 4 : 0);
      await act(async () => {
        holding = false;
        for (const gate of gates) gate.resolve();
      });
      await waitFor(
        () => container.querySelectorAll("img.message-image").length === 6,
      );
      assert.equal(maximumActive, 4);
      assert.equal(active, 0);
      assert.equal(inspections, 10);
      assert.equal(reads, pendingStage === "chunk" ? 10 : 6);
      assert.equal(blobs, 6);
      assert.deepEqual(
        Array.from(container.querySelectorAll("img.message-image"), (image) =>
          image.getAttribute("alt"),
        ),
        Array.from({ length: 6 }, (_, i) => `image-${i}`),
      );
    } finally {
      if (root) await act(async () => root?.unmount());
      holding = false;
      for (const gate of gates) gate.resolve();
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      restoreGlobals();
      dom.window.close();
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = ".mmdのFile PreviewはMermaid表示経路を既定で選び、Sourceへ切り替えると元のテキストを読める"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#中央-file-preview" }
// fault = ".mmdを通常テキストとしてだけ表示する、またはSource切替で元の記述を失う"
// observable = "Mermaid preview container、display mode、Sourceの本文"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.mermaid"
// lifecycle = "permanent"
// impact = "ファイルプレビューから図を確認できない、または失敗時に記述を調べられない"
// distinction = "Mermaid code blockのtestでは独立した.mmdファイルのpreview経路と切替を確認できない"
// @end-test-value
/** 拡張子が .mmd のファイルでは Mermaid 表示が最初に選ばれ、Source へ切り替えても元の図の記述を読めることを確かめる。 */
test("MMD File Preview はMermaid表示経路とSourceを切り替える", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const restoreElementSize = installElementSize(dom);
  const request: SessionFileRootResourceRequest = {
    sessionId: "session-1",
    rootId: "workspace",
    relativePath: "docs/diagram.mmd",
  };
  const source = "flowchart TD\n  A --> B";
  const api = createTextPreviewApi(
    request,
    "diagram.mmd",
    source,
    "mermaid-r1",
  );
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container, request);
    await waitFor(
      () =>
        container.querySelector(".session-file-mermaid .message-mermaid") !==
        null,
    );
    const displayMode = container.querySelector<HTMLElement>(
      "[aria-label='Mermaid display mode']",
    );
    assert.ok(displayMode);
    assert.ok(
      displayMode.querySelector(".is-active")?.textContent === "Preview",
    );

    const sourceButton = Array.from(
      displayMode.querySelectorAll("button"),
    ).find((button) => button.textContent === "Source");
    assert.ok(sourceButton);
    await act(async () => sourceButton.click());
    await waitFor(
      () => container.querySelector(".session-file-text-line code") !== null,
    );
    assert.equal(container.querySelector(".session-file-mermaid"), null);
    assert.match(
      container.querySelector(".session-file-text-scroll")?.textContent ?? "",
      /flowchart TD[\s\S]*A --> B/,
    );
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreElementSize();
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "HTMLとHTMのFile PreviewはPreviewを既定とし、同内容のReloadでも隔離viewを再生成し、Findで原文Sourceへ切り替えてPreviewへ戻れる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 中央 file previewのHTML" }
// fault = "HTMLを通常textへ流す、Reload後も以前のJS実行状態を保持する、Findで隔離viewのDOMを検索しようとする、またはSource原文を変える"
// observable = "HTML display mode、mount/disposeのIDとHTMLとresource出自、Sourceのcode本文、Find barとSource内一致件数"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreviewのHTML resourceからPreview/Sourceと検索への接続"
// lifecycle = "permanent"
// impact = "HTML成果物を表示できない、または表示失敗時に原文を調べて引用できない"
// distinction = "隔離preview単体testではfile拡張子判定と既存Source・Find consumer接続を確認できない"
// @end-test-value
/** HTML と HTM の再読み込みで隔離ビューが作り直され、検索時は原文表示に切り替わり、元のプレビューモードにも戻れることを確かめる。 */
test("HTML File PreviewはReloadでviewを再生成し原文SourceとFindを保持する", async () => {
  for (const name of ["page.html", "page.HTM"]) {
    const dom = new JSDOM('<!doctype html><div id="root"></div>', {
      pretendToBeVisual: true,
      url: "http://localhost/",
    });
    const restoreGlobals = installDomGlobals(dom);
    const restoreElementSize = installElementSize(dom);
    const previousComputedStyle = Object.getOwnPropertyDescriptor(
      globalThis,
      "getComputedStyle",
    );
    Object.defineProperty(globalThis, "getComputedStyle", {
      configurable: true,
      value: dom.window.getComputedStyle.bind(dom.window),
    });
    Object.defineProperties(dom.window.HTMLElement.prototype, {
      attachEvent: {
        /** JSDOM にない旧形式のイベント登録を標準の DOM リスナーへ接続する。 */
        value(this: HTMLElement, name: string, listener: EventListener) {
          this.addEventListener(name.replace(/^on/, ""), listener);
        },
      },
      detachEvent: {
        /** 旧形式で登録されたリスナーを標準の DOM 操作で解除する。 */
        value(this: HTMLElement, name: string, listener: EventListener) {
          this.removeEventListener(name.replace(/^on/, ""), listener);
        },
      },
    });
    const request: SessionFileRootResourceRequest = {
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: `docs/${name}`,
    };
    const source =
      "<!doctype html><style>h1 {color: red}</style><h1>Original &amp; Text</h1>";
    const api = createTextPreviewApi(request, name, source, "html-r1");
    const mounts: HtmlPreviewMountRequest[] = [];
    const disposed: string[] = [];
    const htmlApi: WithMateHtmlPreviewApi = {
      /** 隔離ビューの生成要求を保存し、要求 ID ごとに別の URL とパーティションを返す。 */
      async mountHtmlPreview(input) {
        mounts.push(input);
        return {
          url: `withmate-html-preview://${input.id}/`,
          partition: input.id,
        };
      },
      /** 再読み込み時にどの隔離ビューが破棄されたかを記録する。 */
      async disposeHtmlPreview(id) {
        disposed.push(id);
      },
      /** このテストでは隔離ビューからの問い合わせに応答しない。 */
      async respondHtmlPreview() {},
      /** 隔離ビューのイベント配信は模擬せず、空の解除処理だけを返す。 */
      subscribeHtmlPreviewEvents() {
        return () => {};
      },
    };
    Object.defineProperty(dom.window, "withmate", {
      configurable: true,
      value: htmlApi,
    });
    const container = dom.window.document.getElementById("root");
    let root: Root | null = null;
    try {
      assert.ok(container);
      root = await renderPreview(api, container, request);
      await waitFor(
        () => container.querySelector(".session-file-html") !== null,
      );
      const mode = container.querySelector("[aria-label='HTML display mode']");
      assert.equal(mode?.querySelector(".is-active")?.textContent, "Preview");
      assert.equal(mounts.length, 1);
      assert.deepEqual(mounts[0].source, {
        kind: "resource",
        resource: {
          sessionId: "session-1",
          absolutePath: `C:/workspace/docs/${name}`,
        },
      });
      const reload = Array.from(container.querySelectorAll("button")).find(
        (item) => item.textContent === "Reload",
      );
      assert.ok(reload);
      await act(async () => reload.click());
      assert.equal(mounts.length, 2);
      assert.notEqual(mounts[0].id, mounts[1].id);
      assert.deepEqual(
        mounts.map((mount) => mount.html),
        [source, source],
      );
      assert.deepEqual(disposed, [mounts[0].id]);
      const find = Array.from(container.querySelectorAll("button")).find(
        (item) => item.textContent === "Find",
      );
      assert.ok(find);
      await act(async () => find.click());
      await waitFor(
        () => container.querySelector(".session-file-text-line code") !== null,
      );
      assert.equal(mode?.querySelector(".is-active")?.textContent, "Source");
      assert.equal(
        container.querySelector(".session-file-text-line code")?.textContent,
        source,
      );
      const input = container.querySelector<HTMLInputElement>(
        "input[aria-label='Find in current content']",
      );
      assert.ok(input);
      const setValue = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )?.set;
      assert.ok(setValue);
      await act(async () => {
        setValue.call(input, "&amp;");
        const event = new dom.window.Event("propertychange", { bubbles: true });
        Object.defineProperty(event, "propertyName", { value: "value" });
        input.dispatchEvent(event);
      });
      assert.equal(
        container.querySelector(".session-content-find-count")?.textContent,
        "1/1",
      );
      const preview = Array.from(mode?.querySelectorAll("button") ?? []).find(
        (item) => item.textContent === "Preview",
      );
      assert.ok(preview);
      await act(async () => preview.click());
      assert.ok(container.querySelector(".session-file-html"));
      assert.equal(
        container.querySelector("input[aria-label='Find in current content']"),
        null,
      );
    } finally {
      if (root) await act(async () => root?.unmount());
      restoreElementSize();
      restoreGlobals();
      if (previousComputedStyle)
        Object.defineProperty(
          globalThis,
          "getComputedStyle",
          previousComputedStyle,
        );
      else Reflect.deleteProperty(globalThis, "getComputedStyle");
      dom.window.close();
    }
  }
});

// @test-value v2
// kind = "regression"
// claim = "rich previewの検索は最初のqueryと同件数のquery変更でも一致箇所へscrollする"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/763 完了条件: 拡大後も既存の検索を阻害しない" }
// fault = "一致件数やcurrent indexが変わらないquery更新でscroll処理を省略し、画面外の一致箇所を表示できない"
// observable = "検索UIの1/1表示とscrollIntoViewへ渡された一致段落"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreviewのrich text検索queryから一致箇所へのnavigation"
// lifecycle = "permanent"
// distinction = "検索modelのunit testと異なりquery state更新からDOM navigationまでを確認し、実際の座標・描画はbrowser確認へ分離する"
// @end-test-value
/** 検索結果の件数が同じでも検索語が変われば対象段落へ移動することを、初回検索と続く検索のスクロール先で確かめる。 */
test("rich preview検索は最初のqueryと同件数のquery変更でも一致箇所へ移動する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    /** 検索入力のフォーカス処理が要求する旧形式のリスナー登録を代替する。 */
    value(this: HTMLElement, name: string, listener: EventListener) {
      this.addEventListener(name.replace(/^on/, ""), listener);
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    /** フォーカス処理が解除する旧形式のリスナーを標準 API で取り除く。 */
    value(this: HTMLElement, name: string, listener: EventListener) {
      this.removeEventListener(name.replace(/^on/, ""), listener);
    },
  });
  const restoreGlobals = installDomGlobals(dom);
  const api = createTextPreviewApi(
    MARKDOWN_REQUEST,
    "readme.md",
    "Alpha\n\nBeta",
    "find-r1",
  );
  const inspect = api.inspectSessionFile;
  api.inspectSessionFile = async (request) => ({
    ...(await inspect(request)),
    kind: "markdown",
  });
  const scrolled: string[] = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function () {
    scrolled.push(this.textContent ?? "");
  };
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  try {
    assert.ok(container);
    root = await renderPreview(api, container);
    await waitFor(
      () => container.querySelector(".session-file-markdown p") !== null,
    );
    const find = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent === "Find",
    );
    assert.ok(find);
    await act(async () => find.click());
    const input = container.querySelector<HTMLInputElement>(
      "input[aria-label='Find in current content']",
    );
    assert.ok(input);
    const setValue = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setValue);
    for (const query of ["Beta", "Alpha"]) {
      scrolled.length = 0;
      await act(async () => {
        setValue.call(input, query);
        const event = new dom.window.Event("propertychange", { bubbles: true });
        Object.defineProperty(event, "propertyName", { value: "value" });
        input.dispatchEvent(event);
      });
      assert.equal(
        container.querySelector(".session-content-find-count")?.textContent,
        "1/1",
      );
      assert.equal(scrolled.at(-1), query);
    }
  } finally {
    if (root) await act(async () => root?.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "File Previewはheaderを維持し、通常ファイルのinspectとcontent読込の両段階を可視説明なしのindicatorと対象付きbusyで示す"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込空失敗" }
// fault = "読込中にheaderを消し、通常の読込量を本文として出し、または状態の対象名やaria-busyを欠落させる"
// observable = "previewのaria-busy・title、本文のstatus名・aria-busy・共通spinner・textContent、取得後の本文"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.loading"
// lifecycle = "permanent"
// distinction = "jsdom上の利用者向けDOM/ARIA projectionを直接確認する"
// @end-test-value
/** ファイル情報の取得と本文の読み込みを別々に保留し、見出しを残したまま本文だけが対象名付きの待機表示から内容へ切り替わることを確かめる。 */
test("File Preview はheaderを維持し本文だけをinspectionとcontent読込の状態表示へ切り替える", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const restoreElementSize = installElementSize(dom);
  const request: SessionFileResourceRequest = {
    sessionId: "session-1",
    rootId: "workspace",
    relativePath: "notes.txt",
  };
  const bytes = new TextEncoder().encode("loaded preview");
  const descriptor: SessionFileDescriptor = {
    ...request,
    absoluteFilePath: "C:\\workspace\\notes.txt",
    name: "notes.txt",
    kind: "text",
    byteLength: bytes.byteLength,
    modifiedAt: "2026-08-16T00:00:00.000Z",
    mimeType: "text/plain",
    suggestedEncoding: "utf-8",
    revision: "notes-r1",
  };
  const inspectGate = deferred<SessionFileDescriptor>();
  const readGate = deferred<void>();
  const api: PreviewApi = {
    ...DEFAULT_IMAGE_COPY_API,
    /** ファイル情報の応答を、最初の待機状態を観測するまで保留する。 */
    async inspectSessionFile() {
      return inspectGate.promise;
    },
    /** 二段目の待機表示を観測するまで本文バイトを返さない。 */
    async readSessionFileChunk(chunkRequest) {
      await readGate.promise;
      return {
        data: copyArrayBuffer(bytes),
        offset: chunkRequest.offset,
        nextOffset: bytes.byteLength,
        totalBytes: bytes.byteLength,
        done: true,
        revision: chunkRequest.expectedRevision,
      };
    },
    /** フィクスチャを OS で開かず、通常の成功結果を返す。 */
    async openSessionFile() {
      return {
        status: "opened",
        targetType: "local-path",
        target: resourcePath(request),
      };
    },
    /** 引数のパスを開けたものとして返す。 */
    async openPath(target) {
      return { status: "opened", targetType: "local-path", target };
    },
  };
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container, request);
    const preview = container.querySelector<HTMLElement>(
      "[aria-label='File preview']",
    );
    assert.ok(preview);
    assert.equal(preview.getAttribute("aria-busy"), "true");
    assert.equal(
      preview.querySelector(".session-file-preview-title strong")?.textContent,
      "notes.txt",
    );
    assert.equal(
      preview.querySelector("[role='status']")?.getAttribute("aria-label"),
      "Inspecting file",
    );
    assert.ok(
      preview.querySelector(".loading-indicator-spinner[aria-hidden='true']"),
    );

    await act(async () => inspectGate.resolve(descriptor));
    await waitFor(
      () =>
        preview.querySelector(
          "[role='status'][aria-label='Loading file content']",
        ) !== null,
    );
    const status = preview.querySelector(
      "[role='status'][aria-label='Loading file content']",
    );
    assert.ok(status);
    assert.equal(preview.getAttribute("aria-busy"), "true");
    assert.ok(preview.querySelector(".session-file-preview-header"));
    assert.equal(
      preview.querySelector(".session-file-preview-title strong")?.textContent,
      "notes.txt",
    );
    assert.equal(status.getAttribute("aria-busy"), "true");
    assert.ok(
      status.querySelector(".loading-indicator-spinner[aria-hidden='true']"),
    );
    assert.equal(
      preview.querySelector(".session-file-preview-loading")?.textContent,
      "",
    );

    await act(async () => readGate.resolve());
    await waitFor(
      () => preview.querySelector(".session-file-text-scroll") !== null,
    );
    assert.equal(preview.getAttribute("aria-busy"), null);
    assert.equal(preview.querySelector("[role='status']"), null);
    assert.match(preview.textContent ?? "", /loaded preview/);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreElementSize();
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "File Previewのtoolbar actionは一つの実行中operationを保持し、完了まで他の対象操作を開始させない"
// oracle = { type = "contract", ref = "src/file-explorer/SessionFilePreview.tsx" }
// fault = "Open中にRevealや別のtoolbar actionが開始され、busy表示が後発operationの完了で先に解除される"
// observable = "Open中のbutton disabled、busy aria、Reveal API呼出し数、完了後の再操作可否"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.toolbar-action-busy"
// lifecycle = "permanent"
// impact = "同じpreview resourceへ重複したopen操作を送らず、利用者へ実行中の対象を継続して示す"
// distinction = "同一DOM上でOpen保留中のRevealを試行し、request開始抑止とbusy解除境界を確認する"
// @end-test-value
/** Open が完了するまで Reveal を押しても API が呼ばれず、操作中の表示と無効状態が先に解除されないことを確かめる。 */
test("File Previewのtoolbar actionは実行中operationを直列化する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const openResult =
    deferred<Awaited<ReturnType<PreviewApi["openSessionFile"]>>>();
  const revealResult =
    deferred<Awaited<ReturnType<PreviewApi["openSessionFile"]>>>();
  let revealCalls = 0;
  const api: PreviewApi = {
    ...createTextPreviewApi(
      MARKDOWN_REQUEST,
      "readme.md",
      "preview content",
      "preview-r1",
    ),
    /** Open と Reveal の応答を別々に保留し、抑止されるべき Reveal が届いた回数を記録する。 */
    async openSessionFile(openRequest) {
      if (openRequest.reveal) {
        revealCalls += 1;
        return revealResult.promise;
      }
      return openResult.promise;
    },
  };
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container, MARKDOWN_REQUEST);
    await waitFor(() =>
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).some(
        (button) => button.textContent === "Open",
      ),
    );
    const preview = container.querySelector<HTMLElement>(
      "[aria-label='File preview']",
    );
    const openButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Open");
    const revealButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Show In Explorer");
    assert.ok(preview);
    assert.ok(openButton);
    assert.ok(revealButton);

    await act(async () => openButton.click());
    assert.ok(openButton.querySelector(".button-content-spinner"));
    assert.equal(
      openButton.querySelector(".visually-hidden")?.textContent,
      "Opening file",
    );
    assert.equal(openButton.disabled, true);
    assert.equal(revealButton.disabled, true);
    assert.equal(preview.getAttribute("aria-busy"), "true");

    await act(async () => revealButton.click());
    assert.equal(revealCalls, 0);

    await act(async () => {
      openResult.resolve({
        status: "opened",
        targetType: "local-path",
        target: MARKDOWN_REQUEST.relativePath,
      });
      await openResult.promise;
    });
    await waitFor(() => openButton.textContent === "Open");
    assert.equal(revealButton.disabled, false);
    assert.equal(preview.getAttribute("aria-busy"), null);

    await act(async () => revealButton.click());
    assert.equal(revealCalls, 1);
    assert.ok(revealButton.querySelector(".button-content-spinner"));
    assert.equal(
      revealButton.querySelector(".visually-hidden")?.textContent,
      "Showing file in Explorer",
    );
    await act(async () => {
      revealResult.resolve({
        status: "revealed",
        targetType: "local-path",
        target: MARKDOWN_REQUEST.relativePath,
        message: "",
      });
      await revealResult.promise;
    });
    await waitFor(() => revealButton.textContent === "Show In Explorer");
    assert.equal(preview.getAttribute("aria-busy"), null);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "File Previewのcopy availability APIが有効な場合だけCopy Fileを表示し、結果を操作群と分離した共通通知overlayへ表示する"
// oracle = { type = "contract", ref = "docs/features/windows-file-object-copy.md: 操作できる場所 / Copy結果の通知; docs/design/desktop-ui.md: Copy File / Copy Image結果通知" }
// fault = "Copy Fileを利用可能時に表示しない、利用不可時に表示する、effect-unknownをsuccess toneまたはstatusとして表示する、copiedをerror toneまたはalertとして表示する、または操作群を構成する要素として表示する"
// observable = "Copy Fileの表示可否、copied/effect-unknownのmessage、success/error class、role、aria-live、header notification layer包含関係、操作群からの分離、下部feedbackの不在"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview Copy File availability API and feedback"
// lifecycle = "permanent"
// impact = "利用者が操作直後にファイルコピー結果を確認でき、成功を失敗と誤認しない"
// distinction = "copy serviceのstatus返却ではなく、File Previewの利用者向け配置・視認性・ARIA表示を直接検証する"
// @end-test-value
/** 利用可否で Copy File の表示を切り替え、成功と結果不明を異なる通知として操作群の外に表示することを確かめる。 */
test("File Preview はcopy availability APIが有効な場合だけCopy Fileを表示しCopy Imageと別contractで結果を表示する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const restoreElementSize = installElementSize(dom);
  const copyRequests: SessionFileResourceRequest[] = [];
  const harness = createPreviewApi(async () => IMAGE_DESCRIPTOR);
  let copyResult: "effect-unknown" | "copied" = "effect-unknown";
  const api: PreviewApi = {
    ...harness.api,
    /** ファイル自体をコピーできる環境として操作を表示させる。 */
    isSessionFileObjectCopyAvailable() {
      return true;
    },
    /** コピー対象を保存し、テストが選んだ成功または結果不明の応答を返す。 */
    async copySessionFileObject(request) {
      copyRequests.push(request.resource);
      return copyResult === "copied"
        ? { status: "copied", message: "File copied." }
        : { status: "effect-unknown", message: "File copy status is unknown." };
    },
  };
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container, IMAGE_DESCRIPTOR);
    await waitFor(() =>
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent === "Copy Image",
      ),
    );
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    );
    assert.ok(buttons.some((button) => button.textContent === "Copy Image"));
    const copyFile = buttons.find(
      (button) => button.textContent === "Copy File",
    );
    assert.ok(copyFile);
    await act(async () => {
      copyFile.click();
      await Promise.resolve();
    });
    assert.deepEqual(copyRequests, [
      {
        sessionId: "session-1",
        absolutePath: IMAGE_DESCRIPTOR.absoluteFilePath,
      },
    ]);
    const copyFeedback = container.querySelector<HTMLElement>(
      ".session-file-preview-copy-feedback",
    );
    assert.equal(copyFeedback?.textContent, "File copy status is unknown.");
    assert.ok(copyFeedback?.classList.contains("error"));
    assert.equal(copyFeedback?.getAttribute("role"), "alert");
    assert.equal(copyFeedback?.getAttribute("aria-live"), "assertive");
    assert.equal(
      copyFeedback?.closest(".session-file-preview-header") !== null,
      true,
    );
    assert.equal(
      copyFeedback?.closest(".session-file-preview-notification-layer") !==
        null,
      true,
    );
    assert.equal(copyFeedback?.closest(".session-file-preview-actions"), null);
    assert.equal(
      container.querySelector(".session-file-preview-feedback"),
      null,
    );

    copyResult = "copied";
    await act(async () => {
      copyFile.click();
      await Promise.resolve();
    });
    const successFeedback = container.querySelector<HTMLElement>(
      ".session-file-preview-copy-feedback",
    );
    assert.equal(successFeedback?.textContent, "File copied.");
    assert.ok(successFeedback?.classList.contains("success"));
    assert.equal(successFeedback?.getAttribute("role"), "status");
    assert.equal(successFeedback?.getAttribute("aria-live"), "polite");
    assert.equal(
      successFeedback?.closest(".session-file-preview-header") !== null,
      true,
    );
    assert.equal(
      successFeedback?.closest(".session-file-preview-notification-layer") !==
        null,
      true,
    );
    assert.equal(
      successFeedback?.closest(".session-file-preview-actions"),
      null,
    );
    assert.equal(
      container.querySelector(".session-file-preview-feedback"),
      null,
    );

    const unavailableApi: PreviewApi = {
      ...api,
      /** ファイル自体のコピー非対応を再現し、ボタンが残らないか検査する。 */
      isSessionFileObjectCopyAvailable() {
        return false;
      },
    };
    await act(async () => {
      root?.render(
        React.createElement(SessionFilePreview, {
          api: unavailableApi,
          request: IMAGE_DESCRIPTOR,
          /** ファイルコピー可否の検査ではテキストコピーの処理を実行しない。 */
          onCopyText() {},
          /** ファイルコピー可否の検査には引用操作を含めない。 */
          onQuoteText() {},
        }),
      );
    });
    assert.equal(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent === "Copy File",
      ),
      false,
    );
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreElementSize();
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Markdownのroot外local file linkはcurrent resourceを基準にdetached preview navigationへ渡される"
// oracle = { type = "contract", ref = "src/file-explorer/SessionFilePreview.tsx" }
// fault = "Markdown local linkがopenPathへ誤送信される、base resourceを失う、またはnavigation requestのtargetを誤る"
// observable = "preview navigation requestのkind、sessionId、target、baseResource"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.markdown-local-link"
// lifecycle = "permanent"
// impact = "root外Markdown linkを現在のfile contextから安全にpreview navigationへ接続する"
// distinction = "表示されたanchorの実clickからIPC navigation payloadを直接確認する"
// @end-test-value
/** ルート外にある Markdown のローカルリンクが、閲覧中のファイルを基準に別窓プレビューへ送られ、一般のパス起動へ流れないことを確かめる。 */
test("Markdown preview の local file link は current resource を基準に detached Preview navigation へ戻す", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const request: SessionFileResourceRequest = {
    sessionId: "session-1",
    absolutePath: "C:\\outside\\current.md",
  };
  const bytes = new TextEncoder().encode("[next](./next.md)");
  const navigationRequests: unknown[] = [];
  const descriptor: SessionFileDescriptor = {
    ...request,
    absoluteFilePath: "C:\\outside\\current.md",
    name: "current.md",
    kind: "markdown",
    byteLength: bytes.byteLength,
    modifiedAt: "2026-08-10T00:00:00.000Z",
    mimeType: "text/markdown",
    suggestedEncoding: "utf-8",
    revision: "outside-r1",
  };
  const api: PreviewApi = {
    ...DEFAULT_IMAGE_COPY_API,
    /** ワークスペース外の Markdown を絶対パスで検査した結果を返す。 */
    async inspectSessionFile() {
      return descriptor;
    },
    /** Markdown 本体の指定範囲を返してリンクを描画できるようにする。 */
    async readSessionFileChunk(chunkRequest) {
      const chunk = bytes.slice(
        chunkRequest.offset,
        chunkRequest.offset + chunkRequest.length,
      );
      return {
        data: copyArrayBuffer(chunk),
        offset: chunkRequest.offset,
        nextOffset: chunkRequest.offset + chunk.byteLength,
        totalBytes: bytes.byteLength,
        done: true,
        revision: chunkRequest.expectedRevision,
      };
    },
    /** 通常のファイル起動 API には閲覧中の絶対パスで成功を返す。 */
    async openSessionFile() {
      return {
        status: "opened",
        targetType: "local-path",
        target: request.absolutePath,
      };
    },
    /** ローカルリンクが誤って一般のパス起動に送られた時点でテストを失敗させる。 */
    async openPath(target) {
      assert.fail(`Markdown local file link must not use openPath: ${target}`);
    },
    /** 別窓に渡す遷移要求の基準リソースとリンク先を観測できるように保存する。 */
    async openSessionFilePreviewWindow(navigationRequest) {
      navigationRequests.push(navigationRequest);
      return {
        status: "opened",
        targetType: "preview-window",
        disposition: "created",
        resource: {
          sessionId: "session-1",
          absolutePath: "C:\\outside\\next.md",
        },
      };
    },
  };
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  try {
    assert.ok(container);
    root = await renderPreview(api, container, request);
    await waitFor(
      () => container.querySelector<HTMLAnchorElement>("a") !== null,
    );
    await act(async () =>
      container.querySelector<HTMLAnchorElement>("a")?.click(),
    );
    assert.deepEqual(navigationRequests, [
      {
        kind: "link",
        sessionId: "session-1",
        target: "./next.md",
        baseResource: request,
      },
    ]);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "commit-scoped file previewは通常previewを再利用し、working tree専用操作を表示しない"
// oracle = { type = "contract", ref = "src/file-explorer/SessionFilePreview.tsx" }
// fault = "commit resourceにOpen、Show in Explorer、Copy fileなどのworking tree操作を表示する、またはcommit内容をpreviewしない"
// observable = "commit title、本文、Open/Show in Explorer/Copy file buttonの表示有無、Reload表示"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.git-commit-resource"
// lifecycle = "permanent"
// impact = "commit snapshotをread-only resourceとして扱い、local working tree操作との混同を防ぐ"
// distinction = "commit resourceの実render DOMで操作群と本文を確認する"
// @end-test-value
/** コミットのタイトルと本文を通常プレビューで読めても、作業ツリー専用の Open・Reveal・Copy File が表示されないことを確かめる。 */
test("commit file preview は通常previewを再利用しworking tree操作を表示しない", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const restoreElementSize = installElementSize(dom);
  const request: SessionFileGitCommitResourceRequest = {
    resourceKind: "git-commit-file",
    sessionId: "session-1",
    rootId: "workspace",
    repositoryId: "git:aaaaaaaaaaaaaaaaaaaaaaaa",
    commitId: "a".repeat(40),
    relativePath: "src/current.ts",
  };
  const api: PreviewApi = {
    ...createTextPreviewApi(
      request,
      "current.ts",
      "const version = 'commit';\n",
      "b".repeat(40),
    ),
    /** コピー可能な環境を指定し、ボタンが消える理由を履歴リソースの制約に絞る。 */
    isSessionFileObjectCopyAvailable() {
      return true;
    },
  };
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  try {
    assert.ok(container);
    root = await renderPreview(api, container, request);
    await waitFor(
      () =>
        container.textContent?.includes("const version = 'commit';") === true,
    );
    assert.match(
      container.querySelector(".session-file-preview-title")?.textContent ?? "",
      /current\.tsCommit aaaaaaa/,
    );
    const labels = Array.from(container.querySelectorAll("button")).map(
      (button) => button.textContent,
    );
    assert.equal(labels.includes("Open"), false);
    assert.equal(labels.includes("Show In Explorer"), false);
    assert.equal(labels.includes("Copy File"), false);
    assert.equal(labels.includes("Reload"), true);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreElementSize();
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "binary commit file previewのmetadataにもworking tree専用操作を表示しない"
// oracle = { type = "contract", ref = "src/file-explorer/SessionFilePreview.tsx" }
// fault = "commit snapshotへOpen、Show in Explorer、Copy fileを表示し、通常file操作と誤認させる"
// observable = "binary metadata、commit title、Open/Show in Explorer/Copy file buttonの表示有無"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.git-commit-binary-resource"
// lifecycle = "permanent"
// impact = "binary commit snapshotをread-onlyとして表示し、working tree操作を誤って実行させない"
// distinction = "binary metadata previewの実DOMから操作群の非表示を確認する"
// @end-test-value
/** 履歴上のバイナリはメタデータだけを表示し、本文を読まず作業ツリー専用操作も提示しないことを確かめる。 */
test("binary commit file preview はmetadata内にもworking tree操作を表示しない", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const request: SessionFileGitCommitResourceRequest = {
    resourceKind: "git-commit-file",
    sessionId: "session-1",
    rootId: "workspace",
    repositoryId: "git:aaaaaaaaaaaaaaaaaaaaaaaa",
    commitId: "a".repeat(40),
    relativePath: "assets/archive.bin",
  };
  const descriptor: SessionFileDescriptor = {
    ...request,
    absoluteFilePath: "C:\\workspace\\assets\\archive.bin",
    name: "archive.bin",
    kind: "binary",
    byteLength: 4,
    modifiedAt: "2026-08-28T00:00:00.000Z",
    mimeType: "application/octet-stream",
    suggestedEncoding: "utf-8",
    revision: "b".repeat(40),
  };
  const api: PreviewApi = {
    ...DEFAULT_IMAGE_COPY_API,
    /** 履歴のファイルがバイナリであることをファイル情報から伝える。 */
    async inspectSessionFile() {
      return descriptor;
    },
    /** メタデータ表示だけで済むはずの場面で本文を読んだら失敗させる。 */
    async readSessionFileChunk() {
      assert.fail("Binary metadata preview must not read file contents.");
    },
    /** 履歴ファイルの操作が作業ツリー向けの Open へ到達したら失敗させる。 */
    async openSessionFile() {
      assert.fail("Commit resources must not invoke working tree open.");
    },
    /** 一般のローカルパス起動を実行せず成功結果だけを返す。 */
    async openPath(target) {
      return { status: "opened", targetType: "local-path", target };
    },
    /** ファイル自体をコピーできる環境でも履歴では操作を出さないことを切り分ける。 */
    isSessionFileObjectCopyAvailable() {
      return true;
    },
  };
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  try {
    assert.ok(container);
    root = await renderPreview(api, container, request);
    await waitFor(
      () => container.querySelector(".session-file-preview-metadata") !== null,
    );
    assert.equal(
      container.querySelector(".session-file-preview-title strong")
        ?.textContent,
      "archive.bin",
    );
    assert.match(
      container.querySelector(".session-file-preview-title")?.textContent ?? "",
      /Commit aaaaaaa/,
    );
    const labels = Array.from(container.querySelectorAll("button")).map(
      (button) => button.textContent,
    );
    assert.equal(labels.includes("Open"), false);
    assert.equal(labels.includes("Open In Default App"), false);
    assert.equal(labels.includes("Show In Explorer"), false);
    assert.equal(labels.includes("Copy File"), false);
    assert.equal(labels.includes("Reload"), true);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

/** 本文の選択から Copy と Quote が現れ、引用へ空白と改行を含む選択文字列が渡ることを確かめる。 */
test("Text preview の選択範囲は Copy と Quote の共通 action を表示する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const restoreElementSize = installElementSize(dom);
  const request: SessionFileResourceRequest = {
    sessionId: "session-1",
    rootId: "workspace",
    relativePath: "notes.txt",
  };
  const quotedTexts: string[] = [];
  const api = createTextPreviewApi(
    request,
    "notes.txt",
    "selected preview text",
    "text-r1",
  );
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container, request, {
      /** 引用操作が渡した文字列を、空白を変えずに記録する。 */
      onQuoteText: (text) => quotedTexts.push(text),
    });
    await waitFor(
      () => container.querySelector(".session-file-text-line code") !== null,
    );

    const surface = container.querySelector<HTMLElement>(
      ".session-file-text-scroll",
    );
    const selectedNode = container.querySelector(
      ".session-file-text-line code",
    )?.firstChild;
    assert.ok(surface);
    assert.ok(selectedNode);
    Object.defineProperty(surface, "getBoundingClientRect", {
      configurable: true,
      /** 本文のスクロール領域を固定し、選択ツールバーの座標計算を安定させる。 */
      value: () => createRect({ left: 0, top: 0, width: 500, height: 500 }),
    });
    const anchorRect = createRect({
      left: 100,
      top: 100,
      width: 80,
      height: 20,
    });
    const selection = {
      isCollapsed: false,
      rangeCount: 1,
      /** 選択範囲の共通祖先を本文に置き、ツールバーの配置に使う矩形を返す。 */
      getRangeAt() {
        return {
          commonAncestorContainer: selectedNode,
          /** 選択範囲全体の境界を一つの矩形として返す。 */
          getBoundingClientRect: () => anchorRect,
          /** 一行分の選択矩形を返す。 */
          getClientRects: () => [anchorRect],
        };
      },
      /** 引用時に保持すべき先頭空白と改行を含む選択本文を返す。 */
      toString: () => "  selected preview text\n",
    } as unknown as Selection;
    Object.defineProperty(dom.window, "getSelection", {
      configurable: true,
      /** JSDOM からテスト用の本文選択が取得されるようにする。 */
      value: () => selection,
    });

    await act(async () => {
      dom.window.document.dispatchEvent(
        new dom.window.Event("selectionchange"),
      );
    });
    const toolbar = container.querySelector(".message-response-actions");
    assert.ok(toolbar);
    const buttons = Array.from(
      toolbar.querySelectorAll<HTMLButtonElement>("button"),
    );
    assert.deepEqual(
      buttons.map((button) => button.textContent),
      ["Copy", "Quote"],
    );

    await act(async () => buttons[1]?.click());
    assert.deepEqual(quotedTexts, ["  selected preview text\n"]);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreElementSize();
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Text previewのCtrl+Aは仮想化された全文を選択対象にし、Copy/Quoteの操作対象をその範囲へ限定する"
// oracle = { type = "contract", ref = "src/file-explorer/SessionFilePreview.tsx" }
// fault = "全行をDOMへ展開する、selectionを未仮想化内容へ広げる、またはCopy/Quote対象を失う"
// observable = "Ctrl+AのdefaultPrevented、activeElement、rendered line count"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.text-selection"
// lifecycle = "permanent"
// distinction = "仮想化surfaceのキーボード操作とDOM量を実描画で確認する"
// @end-test-value
/** 仮想化で DOM にない行も含め、Ctrl+A 後のコピーと引用がプレビュー全文だけを対象とすることを確かめる。 */
test("Text preview の Ctrl+A は仮想化された全文だけを Copy と Quote の対象にする", async () => {
  const dom = new JSDOM(
    '<!doctype html><p>outside preview</p><div id="root"></div>',
    {
      pretendToBeVisual: true,
      url: "http://localhost/",
    },
  );
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    /** React がフォーカス時に使う旧イベント登録を標準の DOM リスナーに変換する。 */
    value(this: HTMLElement, name: string, listener: EventListener) {
      this.addEventListener(name.replace(/^on/, ""), listener);
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    /** React がフォーカス解除時に使う旧イベント解除を標準の DOM 操作に変換する。 */
    value(this: HTMLElement, name: string, listener: EventListener) {
      this.removeEventListener(name.replace(/^on/, ""), listener);
    },
  });
  const restoreGlobals = installDomGlobals(dom);
  const restoreElementSize = installElementSize(dom);
  const rangePrototype = dom.window.Range.prototype;
  const previousGetBoundingClientRect = rangePrototype.getBoundingClientRect;
  const previousGetClientRects = rangePrototype.getClientRects;
  const selectionRect = createRect({
    left: 40,
    top: 40,
    width: 400,
    height: 300,
  });
  rangePrototype.getBoundingClientRect = () => selectionRect;
  Object.defineProperty(rangePrototype, "getClientRects", {
    configurable: true,
    /** 仮想選択のツールバーを配置できる矩形を Range に与える。 */
    value: () => [selectionRect],
  });
  const request: SessionFileResourceRequest = {
    sessionId: "session-1",
    rootId: "workspace",
    relativePath: "many-lines.txt",
  };
  const text = Array.from(
    { length: 200 },
    (_, index) => `line ${index + 1}`,
  ).join("\n");
  const quotedTexts: string[] = [];
  const api = createTextPreviewApi(request, "many-lines.txt", text, "text-r1");
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container, request, {
      /** 引用された文字列を記録し、仮想化で未描画の行を含む原文と比較できるようにする。 */
      onQuoteText: (value) => quotedTexts.push(value),
    });
    await waitFor(
      () => container.querySelector(".session-file-text-line code") !== null,
    );

    const surface = container.querySelector<HTMLElement>(
      ".session-file-text-scroll",
    );
    assert.ok(surface);
    Object.defineProperty(surface, "getBoundingClientRect", {
      configurable: true,
      /** 仮想選択操作を検査するためにスクロール領域の境界を固定する。 */
      value: () => selectionRect,
    });
    const previewHeaderButton = container.querySelector<HTMLButtonElement>(
      ".session-file-preview-header button",
    );
    assert.ok(previewHeaderButton);
    previewHeaderButton.focus();
    const selectAllEvent = new dom.window.KeyboardEvent("keydown", {
      key: "a",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      previewHeaderButton.dispatchEvent(selectAllEvent);
    });
    assert.equal(selectAllEvent.defaultPrevented, true);
    assert.equal(dom.window.document.activeElement, surface);
    assert.ok(
      container.querySelectorAll(".session-file-text-line").length < 200,
    );

    let copiedText = "";
    const copyEvent = new dom.window.Event("copy", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(copyEvent, "clipboardData", {
      value: {
        /** コピー操作がプレーンテキストとして書き込んだ値を取り出す。 */
        setData(type: string, value: string) {
          assert.equal(type, "text/plain");
          copiedText = value;
        },
      },
    });
    await act(async () => {
      surface.dispatchEvent(copyEvent);
    });
    assert.equal(copyEvent.defaultPrevented, true);
    assert.equal(copiedText, text);
    assert.doesNotMatch(copiedText, /outside preview/);

    const quoteButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        ".message-response-actions button",
      ),
    ).find((button) => button.textContent === "Quote");
    assert.ok(quoteButton);
    await act(async () => quoteButton.click());
    assert.deepEqual(quotedTexts, [text]);

    const findButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Find");
    assert.ok(findButton);
    await act(async () => findButton.click());
    const findInput = container.querySelector<HTMLInputElement>(
      "input[aria-label='Find in current content']",
    );
    assert.ok(findInput);
    const inputSelectAllEvent = new dom.window.KeyboardEvent("keydown", {
      key: "a",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      findInput.dispatchEvent(inputSelectAllEvent);
    });
    assert.equal(inputSelectAllEvent.defaultPrevented, false);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    if (previousGetBoundingClientRect) {
      rangePrototype.getBoundingClientRect = previousGetBoundingClientRect;
    } else {
      Reflect.deleteProperty(rangePrototype, "getBoundingClientRect");
    }
    if (previousGetClientRects) {
      Object.defineProperty(rangePrototype, "getClientRects", {
        configurable: true,
        value: previousGetClientRects,
      });
    } else {
      Reflect.deleteProperty(rangePrototype, "getClientRects");
    }
    restoreElementSize();
    restoreGlobals();
    dom.window.close();
  }
});

/** JSDOM のイベントに座標・ボタン・修飾キーを付け、指定要素へポインター操作として配送する。 */
function dispatchPointerEvent(
  dom: JSDOM,
  target: Element,
  type: string,
  input: {
    pointerId: number;
    button?: number;
    ctrlKey?: boolean;
    clientX?: number;
    clientY?: number;
  },
): void {
  const event = new dom.window.MouseEvent(type, {
    bubbles: true,
    button: input.button ?? 0,
    ctrlKey: input.ctrlKey ?? false,
    clientX: input.clientX ?? 0,
    clientY: input.clientY ?? 0,
  });
  Object.defineProperty(event, "pointerId", { value: input.pointerId });
  target.dispatchEvent(event);
}

// @test-value v2
// kind = "contract"
// claim = "Mermaid単体とMarkdown内の図でzoomしても検索中の一致位置を保持し、本文変更では検索を再構築する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: File Previewの検索と図の拡縮" }
// fault = "倍率表示だけのmutationで先頭一致へ戻る、または本文更新も除外して一致を見失う"
// observable = "検索countとscrollIntoViewの対象文字列"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreviewとMermaidViewportのzoom・rendered検索の連携"
// lifecycle = "permanent"
// impact = "検索で見つけたノードを拡大して読む際に別ノードへ移動してしまう"
// distinction = "単独の倍率testとquery変更testでは検出できない実component間のMutationObserver連携を確認する"
// @end-test-value
/** 単体 Mermaid と Markdown 内の図のどちらも、拡縮では検索位置を保持し、本文が更新されれば一致位置を再計算することを確かめる。 */
test("rich previewは図の拡縮で検索位置を保持し本文更新には追従する", async () => {
  const mermaid = (await import("mermaid")).default;
  const originalRender = mermaid.render;
  mermaid.render = async () => ({
    svg: '<svg viewBox="0 0 2000 1000"><text>Node first</text><text>Node second</text></svg>',
    diagramType: "flowchart-v2",
  });
  const originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    observe /** 寸法が固定なので監視登録ではリサイズ通知を生成しない。 */() {}
    unobserve /** 個別要素の監視解除を受け付けるが、購読は保持しない。 */() {}
    disconnect /** テスト用の監視には破棄すべき購読がない。 */() {}
  };
  try {
    for (const kind of ["mermaid", "markdown"] as const) {
      const dom = new JSDOM('<!doctype html><div id="root"></div>', {
        pretendToBeVisual: true,
        url: "http://localhost/",
      });
      const restoreGlobals = installDomGlobals(dom);
      Object.defineProperties(dom.window.HTMLElement.prototype, {
        clientWidth: {
          configurable: true,
          /** 図の表示領域を固定幅にする。 */
          get: () => 800,
        },
        clientHeight: {
          configurable: true,
          /** 図の表示領域を固定高にする。 */
          get: () => 400,
        },
        attachEvent: {
          configurable: true,
          /** 検索欄の旧形式リスナー登録を標準 DOM API につなぐ。 */
          value(this: HTMLElement, name: string, listener: EventListener) {
            this.addEventListener(name.replace(/^on/, ""), listener);
          },
        },
        detachEvent: {
          configurable: true,
          /** 検索欄の旧形式リスナーを標準 DOM API で取り除く。 */
          value(this: HTMLElement, name: string, listener: EventListener) {
            this.removeEventListener(name.replace(/^on/, ""), listener);
          },
        },
      });
      Object.defineProperty(dom.window.SVGElement.prototype, "viewBox", {
        /** 表示領域より大きい図の固有寸法を与え、拡縮の前提を作る。 */
        get: () => ({ baseVal: { width: 2000, height: 1000 } }),
      });
      const scrolled: string[] = [];
      dom.window.SVGElement.prototype.scrollIntoView = function () {
        scrolled.push(this.textContent ?? "");
      };
      const request = {
        ...MARKDOWN_REQUEST,
        relativePath: kind === "mermaid" ? "diagram.mmd" : "diagram.md",
      };
      const source =
        kind === "mermaid"
          ? "flowchart TD\nA --> B"
          : "```mermaid\nflowchart TD\nA --> B\n```";
      const api = createTextPreviewApi(
        request,
        request.relativePath,
        source,
        "diagram-r1",
      );
      const inspect = api.inspectSessionFile;
      api.inspectSessionFile = async (resource) => ({
        ...(await inspect(resource)),
        kind: kind === "markdown" ? "markdown" : "text",
      });
      const container = dom.window.document.getElementById("root")!;
      let root: Root | null = null;
      try {
        root = await renderPreview(api, container, request);
        await waitFor(
          () => container.querySelector(".message-mermaid-canvas svg") !== null,
        );
        await act(async () =>
          Array.from(container.querySelectorAll("button"))
            .find((item) => item.textContent === "Find")!
            .click(),
        );
        const input = container.querySelector<HTMLInputElement>(
          "input[aria-label='Find in current content']",
        )!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(
            dom.window.HTMLInputElement.prototype,
            "value",
          )!.set!.call(input, "Node");
          const event = new dom.window.Event("propertychange", {
            bubbles: true,
          });
          Object.defineProperty(event, "propertyName", { value: "value" });
          input.dispatchEvent(event);
        });
        await act(async () =>
          container
            .querySelector<HTMLButtonElement>(
              'button[aria-label="Next match"]',
            )!
            .click(),
        );
        assert.equal(
          container.querySelector(".session-content-find-count")?.textContent,
          "2/2",
        );
        assert.equal(scrolled.at(-1), "Node second");
        scrolled.length = 0;
        for (const label of [
          "Zoom diagram in",
          "Zoom diagram out",
          "Reset diagram zoom to 100%",
          "Fit diagram to preview",
        ]) {
          await act(async () =>
            container
              .querySelector<HTMLButtonElement>(
                `button[aria-label="${label}"]`,
              )!
              .click(),
          );
          assert.equal(
            container.querySelector(".session-content-find-count")?.textContent,
            "2/2",
          );
        }
        assert.ok(scrolled.every((text) => text === "Node second"));
        await act(async () => {
          container.querySelectorAll("svg text")[1].textContent =
            "Different label";
        });
        assert.equal(
          container.querySelector(".session-content-find-count")?.textContent,
          "1/1",
        );
        assert.equal(scrolled.at(-1), "Node first");
      } finally {
        if (root) await act(async () => root?.unmount());
        restoreGlobals();
        dom.window.close();
      }
    }
  } finally {
    mermaid.render = originalRender;
    if (originalResizeObserver)
      globalThis.ResizeObserver = originalResizeObserver;
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
});

// @test-value v2
// kind = "contract"
// claim = ".mmdとMarkdown内Mermaidのlinkはcurrent resourceをbaseとして送信し、失敗後も図と操作を保持して再試行できる"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/768 受入条件: 相対基準・安全な経路・失敗通知と操作継続" }
// fault = ".mmdへcallbackを注入しない、Markdown contextを失う、baseResourceを誤る、または失敗で図を置換する"
// observable = "openSessionFilePreviewWindowのrequest、role=alertのfeedback、図DOM、成功後のerror解消"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreviewからMermaidDiagramとMermaidViewportを経由するrenderer navigation境界"
// lifecycle = "permanent"
// impact = "図内の相対linkが別directoryで解決されたり、失敗後に閲覧と再試行ができなくなる"
// distinction = "SVG生成とMain応答だけをmockし、単体viewport testでは欠落するfile context注入とfailure feedbackの接続を確認する。実機の遷移と認可確認は代替しない"
// @end-test-value
/** 単体図と Markdown 内の図で、リンクに現在のリソースが渡り、起動失敗を表示しても図から再試行できることを確かめる。 */
test("Mermaidのfile linkはpreview contextと失敗時の図を保持する", async () => {
  const mermaid = (await import("mermaid")).default;
  const originalRender = mermaid.render;
  mermaid.render = async () => ({
    svg: '<svg viewBox="0 0 200 100"><a xlink:href="../next%20file.md#L10"><text>Next file</text></a></svg>',
    diagramType: "flowchart-v2",
  });
  const originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    observe /** 固定寸法の図では監視を開始しても通知を生成しない。 */() {}
    unobserve /** 通知を生成しないため要素ごとの監視解除は空処理とする。 */() {}
    disconnect /** 図の破棄時に監視停止を受け付けるが、購読は保持しない。 */() {}
  };
  try {
    for (const extension of ["mmd", "md"]) {
      for (const outsideRoot of [false, true]) {
        const dom = new JSDOM('<!doctype html><div id="root"></div>', {
          pretendToBeVisual: true,
          url: "http://localhost/",
        });
        const restoreGlobals = installDomGlobals(dom);
        Object.defineProperty(dom.window.SVGElement.prototype, "viewBox", {
          /** 単一のリンクを含む図に固定の viewBox 寸法を与える。 */
          get: () => ({ baseVal: { width: 200, height: 100 } }),
        });
        const request: SessionFileResourceRequest = outsideRoot
          ? {
              sessionId: "session-1",
              absolutePath: `C:/outside/docs/diagram.${extension}`,
            }
          : { ...MARKDOWN_REQUEST, relativePath: `docs/diagram.${extension}` };
        const source =
          extension === "mmd"
            ? "flowchart TD\nA[Next file]"
            : "```mermaid\nflowchart TD\nA[Next file]\n```";
        const api = createTextPreviewApi(
          request,
          `diagram.${extension}`,
          source,
          "links-r1",
        );
        const inspect = api.inspectSessionFile;
        api.inspectSessionFile = async (resource) => ({
          ...(await inspect(resource)),
          kind: extension === "md" ? "markdown" : "text",
        });
        const navigationRequests: unknown[] = [];
        let failure: "missing" | "denied" | "rejected" | null = "missing";
        api.openPath = async () => {
          assert.fail("File preview links must retain their base resource.");
        };
        api.openSessionFilePreviewWindow = async (navigationRequest) => {
          navigationRequests.push(navigationRequest);
          if (failure === "rejected")
            throw new Error("The link could not be opened.");
          if (failure)
            return {
              status: failure === "missing" ? "not-found" : "failed",
              targetType: "local-path",
              target: "../next%20file.md#L10",
              message:
                failure === "missing"
                  ? "The local path was not found."
                  : "The preview resource is not authorized.",
            };
          return {
            status: "opened",
            targetType: "preview-window",
            disposition: "created",
            resource: request,
          };
        };
        const container = dom.window.document.getElementById("root")!;
        let root: Root | null = null;
        try {
          root = await renderPreview(api, container, request);
          await waitFor(
            () => container.querySelector(".message-mermaid-canvas a") !== null,
          );
          const diagram = container.querySelector(
            ".message-mermaid-canvas svg",
          );
          for (const outcome of [
            "missing",
            "denied",
            "rejected",
            null,
          ] as const) {
            failure = outcome;
            const event = new dom.window.MouseEvent("click", {
              bubbles: true,
              cancelable: true,
            });
            await act(async () =>
              container
                .querySelector(".message-mermaid-canvas a text")!
                .dispatchEvent(event),
            );
            assert.equal(event.defaultPrevented, true);
            assert.deepEqual(navigationRequests.at(-1), {
              kind: "link",
              sessionId: request.sessionId,
              target: "../next%20file.md#L10",
              baseResource: outsideRoot
                ? request
                : {
                    sessionId: "session-1",
                    absolutePath: `C:/workspace/docs/diagram.${extension}`,
                  },
            });
            assert.equal(
              container.querySelector(".message-mermaid-canvas svg"),
              diagram,
            );
            const feedback = container.querySelector(
              ".session-file-preview-feedback[role=alert]",
            );
            if (outcome === null) assert.equal(feedback, null);
            else
              assert.match(
                feedback?.textContent ?? "",
                outcome === "missing"
                  ? /not found/
                  : outcome === "denied"
                    ? /not authorized/
                    : /could not be opened/,
              );
          }
          assert.equal(navigationRequests.length, 4);
        } finally {
          if (root) await act(async () => root?.unmount());
          restoreGlobals();
          dom.window.close();
        }
      }
    }
  } finally {
    mermaid.render = originalRender;
    if (originalResizeObserver)
      globalThis.ResizeObserver = originalResizeObserver;
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
});

// @test-value v2
// kind = "invariant"
// claim = "encoding切替で表示済みlocal画像を新しいpreview世代へ読み直し旧blobを解放する"
// oracle = { type = "contract", ref = "src/file-explorer/SessionFilePreview.tsx" }
// fault = "encoding切替でresolverを再実行しない、または旧blob resourceを保持する"
// observable = "画像inspect回数、切替後img src、旧URLのrevoke呼出し"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview encoding image lifecycle"
// lifecycle = "permanent"
// distinction = "読込中の取消testとは異なり既に表示したresourceの置換と解放を確認する"
// @end-test-value
/** 表示済みのローカル画像はエンコーディング変更後に改めて検査され、表示 URL が更新されて古い URL が解放されることを確かめる。 */
test("encoding 切替は表示済みの同一 local image を現行 generation へ再登録する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const revoked: string[] = [];
  let objectUrlSequence = 0;
  URL.createObjectURL = () => `blob:preview-${++objectUrlSequence}`;
  URL.revokeObjectURL = (value) => revoked.push(value);
  const { api, getImageInspectCount } = createPreviewApi(
    async () => IMAGE_DESCRIPTOR,
  );
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container);
    await waitFor(
      () =>
        container
          .querySelector("img")
          ?.getAttribute("src")
          ?.startsWith("blob:preview-") ?? false,
    );
    const firstSource = container.querySelector("img")?.getAttribute("src");
    const baselineInspectCount = getImageInspectCount();
    assert.ok(firstSource);

    await changeEncoding(container, dom, "shift_jis");
    await waitFor(() => getImageInspectCount() >= baselineInspectCount + 1);
    await waitFor(() => {
      const nextSource = container.querySelector("img")?.getAttribute("src");
      return Boolean(nextSource && nextSource !== firstSource);
    });

    assert.ok(revoked.includes(firstSource));
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "SessionFilePreviewのReload操作はMarkdown画像resolverを現行generationへ再登録し、旧blob URLを解放する"
// oracle = { type = "contract", ref = "Issue #714: 明示Reload後は現行resourceを再解決し古いresourceを表示しない" }
// fault = "Reload後に同じMarkdown画像のresolverが再実行されない、旧画像が残る、または旧blob URLが解放されない"
// observable = "Reload button、画像resolverのinspect回数、画像srcの変化、URL.revokeObjectURL呼出し"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreviewのMarkdown画像Reload lifecycle"
// lifecycle = "permanent"
// impact = "明示的な再読込で更新されたローカル画像を表示し、前世代の画像resourceを保持しない"
// distinction = "encoding変更によるgeneration再登録とは別に、利用者が実際のReload操作を行った経路を観測する"
// @end-test-value
/** 同じパスの画像が更新されたとき、Reload 後に検査と表示 URL が更新され、旧 URL が解放されることを確かめる。 */
test("Markdown File Preview のReloadは同一画像を現行generationへ再登録する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const revoked: string[] = [];
  const createdBlobs: Blob[] = [];
  let objectUrlSequence = 0;
  URL.createObjectURL = (value) => {
    if (value instanceof Blob) {
      createdBlobs.push(value);
    }
    return `blob:reload-preview-${++objectUrlSequence}`;
  };
  URL.revokeObjectURL = (value) => revoked.push(value);
  const changedImageBytes = Uint8Array.of(137, 80, 78, 71, 1);
  const changedImageDescriptor: SessionFileDescriptor = {
    ...IMAGE_DESCRIPTOR,
    byteLength: changedImageBytes.byteLength,
    modifiedAt: "2026-08-02T00:01:00.000Z",
    revision: "image-r2",
  };
  const imageReadRevisions: string[] = [];
  const harness = createPreviewApi(async (callCount) =>
    callCount === 1 ? IMAGE_DESCRIPTOR : changedImageDescriptor,
  );
  const api: PreviewApi = {
    ...harness.api,
    /** 要求のリビジョンで更新前後の画像バイトを選び、再読み込みで新しい内容が使われるか検査できるようにする。 */
    async readSessionImageChunk(request) {
      const source =
        request.expectedRevision === changedImageDescriptor.revision
          ? changedImageBytes
          : IMAGE_BYTES;
      imageReadRevisions.push(request.expectedRevision ?? "");
      const chunk = source.slice(
        request.offset,
        request.offset + request.length,
      );
      const nextOffset = request.offset + chunk.byteLength;
      return {
        data: copyArrayBuffer(chunk),
        offset: request.offset,
        nextOffset,
        totalBytes: source.byteLength,
        done: nextOffset >= source.byteLength,
        revision: request.expectedRevision,
      };
    },
  };
  const { getImageInspectCount } = harness;
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container);
    await waitFor(
      () =>
        container
          .querySelector("img")
          ?.getAttribute("src")
          ?.startsWith("blob:reload-preview-") ?? false,
    );
    const firstSource = container.querySelector("img")?.getAttribute("src");
    const baselineInspectCount = getImageInspectCount();
    const reload = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Reload");
    assert.ok(firstSource);
    assert.ok(reload);

    await act(async () => reload.click());
    await waitFor(() => getImageInspectCount() >= baselineInspectCount + 1);
    await waitFor(() => {
      const nextSource = container.querySelector("img")?.getAttribute("src");
      return Boolean(nextSource && nextSource !== firstSource);
    });

    const nextSource = container.querySelector("img")?.getAttribute("src");
    assert.ok(revoked.includes(firstSource));
    assert.ok(nextSource);
    assert.notEqual(nextSource, firstSource);
    assert.ok(!revoked.includes(nextSource));
    assert.deepEqual(imageReadRevisions, [
      IMAGE_DESCRIPTOR.revision,
      changedImageDescriptor.revision,
    ]);
    assert.equal(createdBlobs.length, 2);
    assert.deepEqual(
      Array.from(new Uint8Array(await createdBlobs[0].arrayBuffer())),
      Array.from(IMAGE_BYTES),
    );
    assert.deepEqual(
      Array.from(new Uint8Array(await createdBlobs[1].arrayBuffer())),
      Array.from(changedImageBytes),
    );
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "File PreviewのReload busyはready本文を一時表示していても実際のinspectとcontent読込完了まで保持される"
// oracle = { type = "contract", ref = "src/file-explorer/SessionFilePreview.tsx" }
// fault = "Reload直後の旧ready stateまたはinspect完了だけでbusyを解除し、content読込完了前にspinnerまたはaria-busyを失う"
// observable = "inspectとchunk readの各待機中のReloading label・spinner・button disabled・aria-busy、最終read完了後の解除"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.reload-busy"
// lifecycle = "permanent"
// impact = "再読込中の対象を継続して示し、古い本文への操作と重複requestを防ぐ"
// distinction = "二回目inspectとその後のchunk readを別々に保留して各境界のbusyを観測する。型・API単体testではrendererの早期解除を検出できない"
// @end-test-value
/** 再読み込みのファイル検査と本文取得を順に保留し、本文の応答が完了するまでボタンとプレビューの操作中状態が解除されないことを確かめる。 */
test("File PreviewのReload busyはrequest完了まで保持される", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  let objectUrlSequence = 0;
  URL.createObjectURL = () => `blob:reload-busy-${++objectUrlSequence}`;
  URL.revokeObjectURL = () => undefined;
  const secondInspect = deferred<SessionFileDescriptor>();
  const harness = createPreviewApi(async (callCount) =>
    callCount === 1 ? IMAGE_DESCRIPTOR : secondInspect.promise,
  );
  const secondReadStarted = deferred<void>();
  const secondRead = deferred<void>();
  const readChunk = harness.api.readSessionFileChunk;
  harness.api.readSessionFileChunk = async (request) => {
    if (request.expectedRevision === "image-r2") {
      secondReadStarted.resolve();
      await secondRead.promise;
    }
    return readChunk(request);
  };
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(harness.api, container, IMAGE_DESCRIPTOR);
    await waitFor(
      () =>
        container.querySelector<HTMLImageElement>(".session-file-image") !==
        null,
    );
    const preview = container.querySelector<HTMLElement>(
      "[aria-label='File preview']",
    );
    const reload = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Reload");
    assert.ok(preview);
    assert.ok(reload);

    await act(async () => reload.click());
    await waitFor(
      () => reload.querySelector(".button-content-spinner") !== null,
    );
    assert.equal(
      reload.querySelector(".visually-hidden")?.textContent,
      "Reloading",
    );
    assert.equal(reload.disabled, true);
    assert.equal(reload.getAttribute("aria-busy"), "true");
    assert.equal(preview.getAttribute("aria-busy"), "true");

    await act(async () => {
      secondInspect.resolve({
        ...IMAGE_DESCRIPTOR,
        revision: "image-r2",
      });
      await secondReadStarted.promise;
    });
    assert.ok(
      reload.querySelector(".button-content-spinner"),
      "content読込の待機中もReloadのspinnerを保持する",
    );
    assert.equal(
      reload.querySelector(".visually-hidden")?.textContent,
      "Reloading",
    );
    assert.equal(reload.disabled, true);
    assert.equal(reload.getAttribute("aria-busy"), "true");
    assert.equal(preview.getAttribute("aria-busy"), "true");
    await act(async () => secondRead.resolve());
    await waitFor(() => reload.textContent === "Reload");
    assert.equal(reload.disabled, false);
    assert.equal(reload.getAttribute("aria-busy"), null);
    assert.equal(reload.querySelector(".button-content-spinner"), null);
    assert.equal(preview.getAttribute("aria-busy"), null);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "encoding切替中でも同一local imageを現行generationへ再登録し表示を継続する"
// oracle = { type = "contract", ref = "src/file-explorer/SessionFilePreview.tsx" }
// fault = "旧generationの画像を表示し続ける、または切替中画像の再登録を落とす"
// observable = "previewのimg srcがblob URLへ切り替わることと現行generationの登録callback"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.local-image-generation"
// lifecycle = "permanent"
// distinction = "非同期encoding切替中のresource lifecycleをDOMとcallbackで確認する"
// @end-test-value
/** 画像検査の完了前にエンコーディングを変えても、新しい世代で同じ画像を登録し直して表示できることを確かめる。 */
test("encoding 切替は実行中の同一 local image も現行 generation へ再登録する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const createdSources: string[] = [];
  const revokedSources: string[] = [];
  let objectUrlSequence = 0;
  URL.createObjectURL = () => {
    const source = `blob:encoding-preview-${++objectUrlSequence}`;
    createdSources.push(source);
    return source;
  };
  URL.revokeObjectURL = (source) => revokedSources.push(source);
  const firstInspectResolver: {
    resolve: ((descriptor: SessionFileDescriptor) => void) | null;
  } = { resolve: null };
  const firstInspect = new Promise<SessionFileDescriptor>((resolve) => {
    firstInspectResolver.resolve = resolve;
  });
  const { api, getImageInspectCount } = createPreviewApi(async (callCount) =>
    callCount === 1 ? firstInspect : IMAGE_DESCRIPTOR,
  );
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container);
    await waitFor(() => getImageInspectCount() === 1);

    await changeEncoding(container, dom, "shift_jis");
    await waitFor(() => getImageInspectCount() === 2);
    await waitFor(
      () =>
        container.querySelector("img")?.getAttribute("src") ===
        createdSources[0],
    );
    const currentSource = container.querySelector("img")?.getAttribute("src");
    assert.equal(currentSource, "blob:encoding-preview-1");

    firstInspectResolver.resolve?.({
      ...IMAGE_DESCRIPTOR,
      revision: "stale-image-r0",
    });
    await act(async () => {
      await Promise.resolve();
    });
    assert.equal(
      container.querySelector("img")?.getAttribute("src"),
      currentSource,
    );
    assert.deepEqual(createdSources, [currentSource]);
    assert.deepEqual(revokedSources, []);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "security"
// claim = "inspection prefix後にbinaryと判明したMarkdownはrich rendererへ渡さず利用不可表示にする"
// oracle = { type = "contract", ref = "src/file-explorer/SessionFilePreview.tsx" }
// fault = "binary contentをMarkdownとしてrenderし、誤った本文やunsafe previewを表示する"
// observable = "Markdown rendererの不在とbinary unavailable message"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.binary-detection"
// lifecycle = "permanent"
// impact = "binary fileの誤解釈とpreview経路への不適切な入力を防ぐ"
// distinction = "inspection後のrender選択と利用者向け表示を実DOMで確認する"
// @end-test-value
/** 検査済みの先頭部分の後でバイナリが見つかった場合、Markdown のリッチ表示を出さず、利用不可と表示することを確かめる。 */
test("inspection prefix より後ろで binary と判明した Markdown は rich renderer へ渡さない", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const bytes = new Uint8Array(8193).fill(0x61);
  bytes[8192] = 0;
  const descriptor: SessionFileDescriptor = {
    ...MARKDOWN_DESCRIPTOR,
    byteLength: bytes.byteLength,
    revision: "binary-markdown-r1",
  };
  const api: PreviewApi = {
    ...DEFAULT_IMAGE_COPY_API,
    /** 内容にバイナリを含むフィクスチャを、検査結果では Markdown として返す。 */
    async inspectSessionFile() {
      return descriptor;
    },
    /** 後続チャンクにあるバイナリも含め、指定範囲と進捗を返す。 */
    async readSessionFileChunk(request) {
      const chunk = bytes.slice(
        request.offset,
        request.offset + request.length,
      );
      const nextOffset = request.offset + chunk.byteLength;
      return {
        data: copyArrayBuffer(chunk),
        offset: request.offset,
        nextOffset,
        totalBytes: bytes.byteLength,
        done: nextOffset >= bytes.byteLength,
        revision: request.expectedRevision,
      };
    },
    /** ファイル起動では元リソースから導いたパスで成功を返す。 */
    async openSessionFile(request) {
      return {
        status: "opened",
        targetType: "local-path",
        target: resourcePath(request),
      };
    },
    /** パスを実際に開くことなく成功結果の対象に含める。 */
    async openPath(target) {
      return { status: "opened", targetType: "local-path", target };
    },
  };
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container);
    await waitFor(
      () => container.querySelector(".session-file-preview-metadata") !== null,
    );
    assert.equal(container.querySelector(".session-file-markdown"), null);
    assert.match(
      container.textContent ?? "",
      /Preview is not available for this binary file/,
    );
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

/** JSON の整形表示と Raw を切り替え、Raw では整形前の原文が変化しないことを確かめる。 */
test("JSON preview は Formatted と原文を保持した Raw を切り替える", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const restoreElementSize = installElementSize(dom);
  const request: SessionFileResourceRequest = {
    sessionId: "session-1",
    rootId: "workspace",
    relativePath: "config/settings.json",
  };
  const raw = '{"markup":"<img src=x onerror=alert(1)>","enabled":true}';
  const api = createTextPreviewApi(request, "settings.json", raw, "json-r1");
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container, request);
    await waitFor(() => {
      const formatted = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent === "Formatted");
      return formatted?.disabled === false;
    });
    const formattedButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Formatted");
    const rawButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Raw");
    assert.ok(formattedButton?.classList.contains("is-active"));
    assert.ok(rawButton);
    assert.equal(container.querySelector("img[src='x']"), null);
    assert.match(container.textContent ?? "", /<img src=x onerror=alert\(1\)>/);

    await act(async () => rawButton.click());
    await waitFor(() => rawButton.classList.contains("is-active"));
    const displayedLines = Array.from(
      container.querySelectorAll(".session-file-text-line code"),
    ).map((element) => element.textContent ?? "");
    assert.deepEqual(displayedLines, [raw]);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    restoreElementSize();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "不正YAMLはRawを維持して短い失敗説明を表示し、整形診断の複数行原文を非modal詳細入口から提供する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "Rawを失う、診断を1行へ切り詰める、詳細入口とpopoverの関連を失う、またはtoggle通知後も開閉状態を誤って公開する"
// observable = "Raw本文とFormatted disabled、短い説明、popover原文とrole、詳細buttonのtarget/aria-expanded/操作名"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview structured text formatting failure"
// lifecycle = "permanent"
// impact = "診断で本文を圧迫せず、支援技術の利用者も必要時に失敗原因へ到達できる"
// distinction = "既存Raw切替testや型検査で保証しない診断原文と詳細入口のDOM接続を検証する。native dismissal・位置・実keyboardはbrowser確認で扱う"
// @end-test-value
/** YAML の構文エラーで Raw に戻り、原文と複数行の診断詳細を失わず詳細入口の開閉状態を公開することを確かめる。 */
test("不正な YAML preview は parse error を示して Raw へ fallback する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const restoreElementSize = installElementSize(dom);
  const request: SessionFileResourceRequest = {
    sessionId: "session-1",
    rootId: "workspace",
    relativePath: "config/settings.yaml",
  };
  const raw = "root: [";
  const api = createTextPreviewApi(request, "settings.yaml", raw, "yaml-r1");
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container, request);
    await waitFor(
      () =>
        container.textContent?.includes("Formatted preview is unavailable") ??
        false,
    );
    const formattedButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Formatted");
    const rawButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Raw");
    assert.equal(formattedButton?.disabled, true);
    assert.ok(rawButton?.classList.contains("is-active"));
    assert.deepEqual(
      [...container.querySelectorAll(".session-file-text-line code")].map(
        (line) => line.textContent,
      ),
      [raw],
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Show Formatting Error Details']",
    );
    assert.ok(trigger);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
    const details = dom.window.document.getElementById(
      trigger.getAttribute("popovertarget")!,
    );
    assert.ok(details);
    assert.equal(details.getAttribute("popover"), "auto");
    assert.equal(details.getAttribute("role"), "dialog");
    assert.equal(trigger.getAttribute("aria-controls"), details.id);
    assert.equal(
      container.querySelector(".session-file-preview-feedback")
        ?.firstElementChild?.textContent,
      "Formatted preview is unavailable. Showing raw content.",
    );
    const diagnostic =
      details.querySelector(".session-file-format-error-message")
        ?.textContent ?? "";
    assert.match(diagnostic, /\n/);
    assert.match(diagnostic, /root: \[/);
    for (const newState of ["open", "closed"]) {
      await act(async () => {
        details.dispatchEvent(
          Object.assign(new dom.window.Event("toggle"), { newState }),
        );
      });
      assert.equal(
        trigger.getAttribute("aria-expanded"),
        String(newState === "open"),
      );
      assert.equal(
        trigger.getAttribute("aria-label"),
        `${newState === "open" ? "Hide" : "Show"} Formatting Error Details`,
      );
    }
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    restoreElementSize();
    dom.window.close();
  }
});

/** 構造化テキストの上限を超える JSON は整形せず、Raw 表示で扱うことを確かめる。 */
test("上限を超える JSON preview はformatせず既存Raw表示へ戻す", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const request: SessionFileResourceRequest = {
    sessionId: "session-1",
    rootId: "workspace",
    relativePath: "large.json",
  };
  const raw = `{"value":"${"a".repeat(STRUCTURED_TEXT_PREVIEW_MAX_BYTES)}"}`;
  const api = createTextPreviewApi(request, "large.json", raw, "large-json-r1");
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container, request);
    await waitFor(
      () =>
        container.textContent?.includes("Formatted preview is skipped") ??
        false,
    );
    assert.equal(
      container.querySelector("[aria-label='Structured text display mode']"),
      null,
    );
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "寸法情報のあるSVGも初回画像表示ではFit modeを選択する"
// oracle = { type = "contract", ref = "src/file-explorer/SessionFilePreview.tsx" }
// fault = "SVGだけ初回Fitを適用せず、画像がviewport外へはみ出す"
// observable = "image elementのis-fit classと初回表示状態"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.image-fit"
// lifecycle = "permanent"
// distinction = "SVG metadataを含む実previewの初期表示classを確認する"
// @end-test-value
/** SVG に固有寸法があっても、初回表示では原寸ではなく Fit が選ばれることを画像の状態で確かめる。 */
test("寸法情報のあるSVGも初回はFitで表示する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:dimensionless-svg";
  URL.revokeObjectURL = () => undefined;
  const request: SessionFileResourceRequest = {
    sessionId: "session-1",
    rootId: "workspace",
    relativePath: "assets/icon.svg",
  };
  const bytes = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><path d="M0 0"/></svg>',
  );
  const descriptor: SessionFileDescriptor = {
    ...request,
    absoluteFilePath: "C:\\workspace\\assets\\icon.svg",
    name: "icon.svg",
    kind: "svg",
    byteLength: bytes.byteLength,
    modifiedAt: "2026-08-02T00:00:00.000Z",
    mimeType: "image/svg+xml",
    suggestedEncoding: "utf-8",
    revision: "svg-r1",
  };
  const api: PreviewApi = {
    ...DEFAULT_IMAGE_COPY_API,
    /** 寸法を持つ SVG を読み込むため、種類とバイト長を返す。 */
    async inspectSessionFile() {
      return descriptor;
    },
    /** SVG の本文を一回で返し、取得済みとして表示に進ませる。 */
    async readSessionFileChunk(chunkRequest) {
      return {
        data: copyArrayBuffer(bytes),
        offset: chunkRequest.offset,
        nextOffset: bytes.byteLength,
        totalBytes: bytes.byteLength,
        done: true,
        revision: chunkRequest.expectedRevision,
      };
    },
    /** SVG のファイル起動を実行せず、要求の対象で成功を返す。 */
    async openSessionFile(openRequest) {
      return {
        status: "opened",
        targetType: "local-path",
        target: resourcePath(openRequest),
      };
    },
    /** 一般パスの起動も実行せず、対象を結果に反映する。 */
    async openPath(target) {
      return { status: "opened", targetType: "local-path", target };
    },
  };
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container, request);
    await waitFor(
      () => container.querySelector(".session-file-image.is-fit") !== null,
    );
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "画像previewはCtrl＋左dragのときだけscroll移動し、終了後は停止する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 共通previewのCtrl＋左drag移動" }
// fault = "Ctrlなしの左dragを移動として奪う、Ctrl＋左dragで移動しない、または終了後も移動する"
// observable = "scrollLeft／scrollTop、pointer capture、移動中class"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreviewの画像から共通pan hookへの接続"
// lifecycle = "permanent"
// distinction = "Mermaid側testでは検出できない画像consumerの接続とnative image drag無効化を確認する"
// @end-test-value
/** 拡大画像は Ctrl を押しながら左ドラッグした間だけスクロールし、終了後のポインター移動では位置が変わらないことを確かめる。 */
test("拡大画像をCtrl＋左ドラッグするとスクロール位置を移動し、終了後は停止する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:pannable-image";
  URL.revokeObjectURL = () => undefined;
  const { api } = createPreviewApi(async () => IMAGE_DESCRIPTOR);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container, IMAGE_DESCRIPTOR);
    await waitFor(
      () => container.querySelector(".session-file-image-scroll") !== null,
    );
    const scrollSurface = container.querySelector<HTMLDivElement>(
      ".session-file-image-scroll",
    );
    const image = container.querySelector<HTMLImageElement>(
      ".session-file-image",
    );
    assert.ok(scrollSurface);
    assert.ok(image);
    assert.equal(image.draggable, false);

    Object.defineProperties(scrollSurface, {
      clientWidth: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 300 },
      scrollWidth: { configurable: true, value: 800 },
      scrollHeight: { configurable: true, value: 600 },
    });
    let capturedPointerId: number | null = null;
    scrollSurface.setPointerCapture = (pointerId) => {
      capturedPointerId = pointerId;
    };
    scrollSurface.hasPointerCapture = (pointerId) =>
      capturedPointerId === pointerId;
    scrollSurface.releasePointerCapture = (pointerId) => {
      if (capturedPointerId === pointerId) {
        capturedPointerId = null;
      }
    };
    scrollSurface.scrollLeft = 120;
    scrollSurface.scrollTop = 90;

    await act(async () => {
      dispatchPointerEvent(dom, scrollSurface, "pointerdown", {
        pointerId: 7,
        clientX: 200,
        clientY: 160,
      });
      dispatchPointerEvent(dom, scrollSurface, "pointermove", {
        pointerId: 7,
        clientX: 150,
        clientY: 120,
      });
    });
    assert.deepEqual(
      [scrollSurface.scrollLeft, scrollSurface.scrollTop, capturedPointerId],
      [120, 90, null],
    );

    await act(async () => {
      dispatchPointerEvent(dom, scrollSurface, "pointerdown", {
        pointerId: 7,
        ctrlKey: true,
        clientX: 200,
        clientY: 160,
      });
      dispatchPointerEvent(dom, scrollSurface, "pointermove", {
        pointerId: 7,
        clientX: 150,
        clientY: 120,
      });
    });

    assert.equal(scrollSurface.scrollLeft, 170);
    assert.equal(scrollSurface.scrollTop, 130);
    assert.equal(capturedPointerId, 7);
    assert.ok(scrollSurface.classList.contains("is-panning"));

    await act(async () => {
      dispatchPointerEvent(dom, scrollSurface, "pointerup", { pointerId: 7 });
      dispatchPointerEvent(dom, scrollSurface, "pointermove", {
        pointerId: 7,
        clientX: 100,
        clientY: 80,
      });
    });

    assert.equal(scrollSurface.scrollLeft, 170);
    assert.equal(scrollSurface.scrollTop, 130);
    assert.equal(capturedPointerId, null);
    assert.ok(!scrollSurface.classList.contains("is-panning"));
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "単体画像previewのCopy Image操作（buttonと右クリック）の成功結果は操作群と分離した共通通知overlayでsuccess toneとstatus roleを持って表示される"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Copy File / Copy Image結果通知" }
// fault = "Copy Image操作の成功結果がsuccess tone・status role・polite announcementを持たない、下部のerror表示になる、または操作群を構成する要素として表示される"
// observable = "Copy Image結果のmessage、success class、status role、aria-live、header notification layer包含関係、操作群からの分離、下部feedbackの不在"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview Copy Image feedback"
// lifecycle = "permanent"
// impact = "画像コピー直後の成功結果を操作位置の近くで確認できる"
// distinction = "画像座標をcopy境界へ渡す既存検証に加え、rendererの結果通知DOM配置とARIA契約を直接検証する"
// @end-test-value
/** 画像のボタンと右クリックが現在の表示座標をコピー API へ渡し、成功を操作群外の通知に出すことを確かめる。 */
test("単体画像previewはbuttonと右クリックから現在の画像座標をcopy境界へ渡す", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:copy-image";
  URL.revokeObjectURL = () => undefined;
  const baseApi = createPreviewApi(async () => IMAGE_DESCRIPTOR).api;
  const copyRequests: unknown[] = [];
  const contextMenuRequests: unknown[] = [];
  const api: PreviewApi = {
    ...baseApi,
    /** ボタン経由の画像コピー要求を記録し、成功通知を発生させる。 */
    async copySessionFilePreviewImage(request) {
      copyRequests.push(request);
      return { status: "copied" };
    },
    /** 右クリック経由の画像コピー要求を記録し、メニュー選択によるコピー成功を再現する。 */
    async showSessionFilePreviewImageContextMenu(request) {
      contextMenuRequests.push(request);
      return { status: "copied" };
    },
  };
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container, {
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: "docs/image.png",
    });
    await waitFor(
      () =>
        container.querySelector<HTMLImageElement>(".session-file-image") !==
        null,
    );
    const image = container.querySelector<HTMLImageElement>(
      ".session-file-image",
    );
    const scrollport = container.querySelector<HTMLDivElement>(
      ".session-file-image-scroll",
    );
    assert.ok(image);
    assert.ok(scrollport);
    image.getBoundingClientRect = () => ({
      x: 20,
      y: 30,
      left: 20,
      top: 30,
      right: 220,
      bottom: 230,
      width: 200,
      height: 200,
      /** 画像の矩形は座標比較にだけ使い、JSON 化しない。 */
      toJSON() {},
    });
    scrollport.getBoundingClientRect = () => ({
      x: 40,
      y: 50,
      left: 40,
      top: 50,
      right: 100,
      bottom: 110,
      width: 60,
      height: 60,
      /** スクロール領域の矩形も座標計算用なので JSON 化しない。 */
      toJSON() {},
    });
    const copyButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Copy Image");
    assert.ok(copyButton);

    await act(async () => copyButton.click());
    await waitFor(() => copyRequests.length === 1);
    assert.deepEqual(copyRequests, [
      {
        sessionId: "session-1",
        point: { x: 70, y: 80 },
      },
    ]);
    const imageCopyFeedback = container.querySelector<HTMLElement>(
      ".session-file-preview-copy-feedback",
    );
    assert.equal(imageCopyFeedback?.textContent, "Image copied.");
    assert.ok(imageCopyFeedback?.classList.contains("success"));
    assert.equal(imageCopyFeedback?.getAttribute("role"), "status");
    assert.equal(imageCopyFeedback?.getAttribute("aria-live"), "polite");
    assert.equal(
      imageCopyFeedback?.closest(".session-file-preview-header") !== null,
      true,
    );
    assert.equal(
      imageCopyFeedback?.closest(".session-file-preview-notification-layer") !==
        null,
      true,
    );
    assert.equal(
      imageCopyFeedback?.closest(".session-file-preview-actions"),
      null,
    );
    assert.equal(
      container.querySelector(".session-file-preview-feedback"),
      null,
    );

    const contextMenuRequest: SessionFileResourceRequest = {
      ...IMAGE_DESCRIPTOR,
      relativePath: "docs/context-menu.png",
    };
    await act(async () => {
      root?.render(
        React.createElement(SessionFilePreview, {
          api,
          request: contextMenuRequest,
          /** 右クリックの検査ではテキストコピーを実行しない。 */
          onCopyText() {},
          /** 右クリックの検査では引用を実行しない。 */
          onQuoteText() {},
        }),
      );
    });
    await waitFor(
      () =>
        container.querySelector<HTMLImageElement>(".session-file-image") !==
        null,
    );
    await waitFor(
      () =>
        container.querySelector(".session-file-preview-copy-feedback") === null,
    );
    const contextMenuImage = container.querySelector<HTMLImageElement>(
      ".session-file-image",
    );
    assert.ok(contextMenuImage);
    const contextMenuEvent = new dom.window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 44,
      clientY: 55,
    });
    await act(async () => contextMenuImage.dispatchEvent(contextMenuEvent));
    await waitFor(() => contextMenuRequests.length === 1);
    assert.equal(contextMenuEvent.defaultPrevented, true);
    assert.deepEqual(contextMenuRequests, [
      {
        sessionId: "session-1",
        point: { x: 44, y: 55 },
      },
    ]);
    await waitFor(
      () =>
        container.querySelector<HTMLElement>(
          ".session-file-preview-copy-feedback",
        )?.textContent === "Image copied.",
    );
    const contextMenuFeedback = container.querySelector<HTMLElement>(
      ".session-file-preview-copy-feedback",
    );
    assert.equal(contextMenuFeedback?.textContent, "Image copied.");
    assert.ok(contextMenuFeedback?.classList.contains("success"));
    assert.equal(contextMenuFeedback?.getAttribute("role"), "status");
    assert.equal(contextMenuFeedback?.getAttribute("aria-live"), "polite");
    assert.equal(
      contextMenuFeedback?.closest(".session-file-preview-header") !== null,
      true,
    );
    assert.equal(
      contextMenuFeedback?.closest(
        ".session-file-preview-notification-layer",
      ) !== null,
      true,
    );
    assert.equal(
      contextMenuFeedback?.closest(".session-file-preview-actions"),
      null,
    );
    assert.equal(
      container.querySelector(".session-file-preview-feedback"),
      null,
    );
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "regression"
// claim = "現行のcopy通知CSSは別窓のtheme tokenを参照し、success/error別の背景・borderとheader基準の操作群外overlayを宣言する"
// oracle = { type = "characterization", ref = "src/file-explorer/files.css: file-preview-window-page; src/chat/session-shell.css: app-notification / session-file-preview-notification-layer" }
// fault = "別窓の通知用theme tokenやtone別の色参照（未定義のdanger tokenのfallbackを含む）が欠ける、overlayが通常flowへ戻る、header直下・右寄せのanchorや前面配置を失う、またはpointer操作を遮る"
// observable = "file-preview-window-page、app-notificationのsuccess/error、session-file-preview-headerとsession-file-preview-notification-layerの各CSS declaration"
// observation_boundary = "declaration"
// scope = "File Preview detached notification stylesheet"
// lifecycle = "characterization"
// review_when = "通知のtheme token接続またはoverlayの配置方式を変更するとき"
// impact = "通知の配色接続や操作群外配置を失うCSS欠落を検出する。色・余白の具体値や実描画でのcontrast・座標は保証しない"
// distinction = "Desktop UIのCopy結果表示・tone・ARIA・親境界は既存component testが検証する。本testはその表示を支える現行CSS宣言だけを補完する"
// @end-test-value
/** 別窓のコピー通知がテーマ色を使い、ヘッダー右側の操作群外に置かれてポインター操作を妨げないことを CSS の宣言で確かめる。 */
test("別窓File Previewのcopy通知CSSはtheme接続と操作群外overlayを定義する", async () => {
  const styles = await readStylesheet();
  const pageRule =
    styles.match(/\.file-preview-window-page\s*{(?<body>[^}]*)}/)?.groups
      ?.body ?? "";
  const notificationRule =
    styles.match(/\.app-notification\s*{(?<body>[^}]*)}/)?.groups?.body ?? "";
  const successRule =
    styles.match(/\.app-notification\.success\s*{(?<body>[^}]*)}/)?.groups
      ?.body ?? "";
  const errorRule =
    styles.match(/\.app-notification\.error\s*{(?<body>[^}]*)}/)?.groups
      ?.body ?? "";
  const headerRule =
    styles.match(/\.session-file-preview-header\s*{(?<body>[^}]*)}/)?.groups
      ?.body ?? "";
  const layerRule =
    styles.match(/\.session-file-preview-notification-layer\s*{(?<body>[^}]*)}/)
      ?.groups?.body ?? "";

  for (const token of ["surface-strong", "line", "ink", "teal", "teal-soft"]) {
    assert.match(pageRule, new RegExp(`--${token}:\\s*[^;\\s][^;]*;`));
  }
  assert.match(notificationRule, /border:\s*[^;]+\s+solid\s+var\(--line\);/);
  assert.match(notificationRule, /background:\s*var\(--surface-strong\);/);
  assert.match(notificationRule, /color:\s*var\(--ink\);/);
  assert.match(successRule, /border-color:\s*var\(--teal\);/);
  assert.match(successRule, /background:\s*[^;]*var\(--teal-soft\)[^;]*;/);
  assert.match(errorRule, /border-color:\s*var\(--danger,\s*[^;)\s][^;]*\);/);
  assert.match(
    errorRule,
    /background:\s*[^;]*var\(--danger,\s*[^;)\s][^;]*\)[^;]*;/,
  );
  assert.match(headerRule, /position:\s*relative;/);
  assert.match(layerRule, /position:\s*absolute;/);
  assert.match(layerRule, /top:\s*(?:100%|calc\(100%\s*\+\s*[^;]+\));/);
  assert.match(layerRule, /right:\s*(?!auto\b)[^;\s][^;]*;/);
  assert.match(layerRule, /z-index:\s*[1-9]\d*;/);
  assert.match(layerRule, /pointer-events:\s*none;/);
});

/** 初回の Fit が実寸から計算した倍率を表示し、Zoom In がその倍率を起点とすることを確かめる。 */
test("画像previewは初回Fitの実効倍率を表示しZoom Inの基準にする", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:fit-image";
  URL.revokeObjectURL = () => undefined;
  const { api } = createPreviewApi(async () => IMAGE_DESCRIPTOR);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container, IMAGE_DESCRIPTOR);
    await waitFor(
      () =>
        container.querySelector<HTMLImageElement>(".session-file-image") !==
        null,
    );
    const viewport = container.querySelector<HTMLElement>(
      ".session-file-image-scroll",
    );
    const image = container.querySelector<HTMLImageElement>(
      ".session-file-image",
    );
    assert.ok(viewport);
    assert.ok(image);
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 450 },
    });
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 1600 },
      naturalHeight: { configurable: true, value: 900 },
    });
    await act(async () => {
      image.dispatchEvent(new dom.window.Event("load"));
    });
    assert.ok(container.querySelector(".session-file-image.is-fit"));
    assert.ok(
      container.querySelector(
        "button[aria-label='Fit image to preview'].is-active",
      ),
    );
    assert.equal(
      container.querySelector<HTMLButtonElement>(
        "button[aria-label='Reset image zoom to 100%']",
      )?.textContent,
      "50%",
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("button[aria-label='Zoom image in']")
        ?.click();
    });
    assert.equal(
      container.querySelector<HTMLButtonElement>(
        "button[aria-label='Reset image zoom to 100%']",
      )?.textContent,
      "60%",
    );
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "file切替後に旧fileのOpen結果を新previewへ表示しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/777#issuecomment-5971260656" }
// fault = "旧fileのOpen完了が新fileのpreviewへfeedbackを表示する"
// observable = "Open APIのrequest、切替後のpreview titleとOpen failure textの不在"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.async-generation"
// lifecycle = "permanent"
// impact = "別fileの操作失敗を現在fileの失敗と誤認させない"
// distinction = "実DOMからOpenを開始して旧promiseを切替後に完了し、型検査では検出できない応答順の混入を確認する"
// @end-test-value
/** Open の応答を保留して対象を切り替え、旧対象の失敗通知が新しいプレビューに出ないことを確かめる。 */
test("file切替後に完了したOpenの結果を新しいpreviewへ表示しない", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const firstRequest: SessionFileResourceRequest = {
    sessionId: "session-1",
    rootId: "workspace",
    relativePath: "first.txt",
  };
  const secondRequest: SessionFileResourceRequest = {
    ...firstRequest,
    relativePath: "second.txt",
  };
  const bytes = new TextEncoder().encode("content");
  const openResult =
    deferred<Awaited<ReturnType<PreviewApi["openSessionFile"]>>>();
  const openRequests: SessionFileResourceRequest[] = [];
  const api: PreviewApi = {
    ...DEFAULT_IMAGE_COPY_API,
    /** 要求ごとに異なる対象のメタデータを返し、切り替えをタイトルから観測できるようにする。 */
    async inspectSessionFile(inspectRequest) {
      return {
        ...inspectRequest,
        absoluteFilePath: `C:/workspace/${resourcePath(inspectRequest)}`,
        name: resourcePath(inspectRequest),
        kind: "text",
        byteLength: bytes.byteLength,
        modifiedAt: "2026-08-02T00:00:00.000Z",
        mimeType: "text/plain",
        suggestedEncoding: "utf-8",
        revision: `${resourcePath(inspectRequest)}-r1`,
      };
    },
    /** どちらの対象でも本文は固定値で返し、Open の応答順だけを変えられるようにする。 */
    async readSessionFileChunk(chunkRequest) {
      return {
        data: copyArrayBuffer(bytes),
        offset: chunkRequest.offset,
        nextOffset: bytes.byteLength,
        totalBytes: bytes.byteLength,
        done: true,
        revision: chunkRequest.expectedRevision,
      };
    },
    /** Open の対象を記録し、応答をテスト側から解決できるようにする。 */
    openSessionFile(request) {
      openRequests.push(request);
      return openResult.promise;
    },
    /** 渡されたパスの起動成功を模擬する。 */
    async openPath(target) {
      return { status: "opened", targetType: "local-path", target };
    },
  };
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  /** 同じ React ルートを使い、対象だけを変更して旧操作の扱いを観測する。 */
  const render = async (request: SessionFileResourceRequest) => {
    await act(async () => {
      root?.render(
        React.createElement(SessionFilePreview, {
          api,
          request,
          /** 対象切り替えの検査ではテキストコピーを実行しない。 */
          onCopyText() {},
          /** Open の完了順に関係のない引用処理は登録だけ行う。 */
          onQuoteText() {},
        }),
      );
    });
  };

  try {
    assert.ok(container);
    root = await renderPreview(api, container, firstRequest);
    await waitFor(() =>
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent === "Open",
      ),
    );
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    );
    const openButton = buttons.find((button) => button.textContent === "Open");
    assert.ok(openButton);
    await act(async () => {
      openButton.click();
    });
    assert.deepEqual(openRequests, [
      { sessionId: "session-1", absolutePath: "C:/workspace/first.txt" },
    ]);

    await render(secondRequest);
    await waitFor(() => container.textContent?.includes("second.txt") ?? false);
    await act(async () => {
      openResult.resolve({
        status: "failed",
        targetType: "local-path",
        target: "first.txt",
        message: "first open failed",
      });
      await openResult.promise;
    });

    assert.equal(
      container.querySelector(".session-file-preview-title strong")
        ?.textContent,
      "second.txt",
    );
    assert.doesNotMatch(container.textContent ?? "", /first open failed/);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "file切替後の旧Open Diff完了は現在fileの本文とfeedbackへ混入せず、現在のDiff操作中状態を解除しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/777#issuecomment-5971260656" }
// fault = "旧Diffのmessageが新previewへ表示される、または旧Diffの完了で新Diffのbusyが解除される"
// observable = "各fileに紐づくonOpenDiffのscopeと呼出し数、titleと本文、feedback、aria-busyとbutton disabled"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.open-diff-generation"
// lifecycle = "permanent"
// impact = "別fileの失敗表示と、Diff処理中の再操作を防ぐ"
// distinction = "Openと独立してDiffを開始し、新旧で異なる本文と制御した完了順を使う。型検査や通常のtoolbar testでは応答順の混入を検出できない"
// @end-test-value
/** 古い Open Diff が後で完了しても、新しい対象の本文・通知・実行中の Diff 操作が変わらないことを確かめる。 */
test("file切替後に完了したOpen Diffは新しいpreviewと実行中操作を変更しない", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const restoreElementSize = installElementSize(dom);
  const firstRequest: SessionFileResourceRequest = {
    sessionId: "session-1",
    rootId: "workspace",
    relativePath: "first.txt",
  };
  const secondRequest: SessionFileResourceRequest = {
    ...firstRequest,
    relativePath: "second.txt",
  };
  const firstApi = createTextPreviewApi(
    firstRequest,
    "first.txt",
    "first file content",
    "first-r1",
  );
  const secondApi = createTextPreviewApi(
    secondRequest,
    "second.txt",
    "second file content",
    "second-r1",
  );
  const firstDiff = deferred<string | null>();
  const secondDiff = deferred<string | null>();
  const diffCalls: { request: SessionFileResourceRequest; scope: string }[] =
    [];
  const api: PreviewApi = {
    ...firstApi,
    /** リクエストのファイルに合わせて、切り替えの前後で異なるファイル情報を返す。 */
    inspectSessionFile(request) {
      return resourcePath(request) === "first.txt"
        ? firstApi.inspectSessionFile(request)
        : secondApi.inspectSessionFile(request);
    },
    /** リクエストのファイルに合わせて、前後で判別できる本文を返す。 */
    readSessionFileChunk(request) {
      return resourcePath(request) === "first.txt"
        ? firstApi.readSessionFileChunk(request)
        : secondApi.readSessionFileChunk(request);
    },
  };
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  /** 同じルートで対象と Diff の保留応答を組み替え、二つの操作を別々に完了できるようにする。 */
  const render = async (
    request: SessionFileResourceRequest,
    result: typeof firstDiff,
  ) => {
    await act(async () => {
      root?.render(
        React.createElement(SessionFilePreview, {
          api,
          request,
          /** 差分起動の競合を検査する間はテキストコピーを行わない。 */
          onCopyText() {},
          /** 差分起動の競合を検査する間は引用を行わない。 */
          onQuoteText() {},
          diffScopes: ["working-tree"],
          /** 対象と差分の範囲を記録し、その対象用の応答を保留する。 */
          onOpenDiff(scope) {
            diffCalls.push({ request, scope });
            return result.promise;
          },
        }),
      );
    });
  };

  try {
    assert.ok(container);
    root = createRoot(container);
    await render(firstRequest, firstDiff);
    await waitFor(
      () => container.textContent?.includes("first file content") === true,
    );
    const firstButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Open Diff");
    assert.ok(firstButton);
    await act(async () => firstButton.click());
    assert.deepEqual(diffCalls, [
      { request: firstRequest, scope: "working-tree" },
    ]);

    await render(secondRequest, secondDiff);
    await waitFor(
      () => container.textContent?.includes("second file content") === true,
    );
    const preview = container.querySelector<HTMLElement>(
      "[aria-label='File preview']",
    );
    const secondButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Open Diff");
    assert.ok(preview);
    assert.ok(secondButton);
    assert.equal(secondButton.disabled, false);
    await act(async () => secondButton.click());
    assert.deepEqual(diffCalls, [
      { request: firstRequest, scope: "working-tree" },
      { request: secondRequest, scope: "working-tree" },
    ]);
    assert.equal(preview.getAttribute("aria-busy"), "true");
    assert.equal(secondButton.disabled, true);

    await act(async () => {
      firstDiff.resolve("first diff failed");
      await firstDiff.promise;
    });
    assert.equal(
      preview.querySelector(".session-file-preview-title strong")?.textContent,
      "second.txt",
    );
    assert.match(preview.textContent ?? "", /second file content/);
    assert.doesNotMatch(
      preview.textContent ?? "",
      /first file content|first diff failed/,
    );
    assert.equal(preview.getAttribute("aria-busy"), "true");
    assert.equal(secondButton.disabled, true);
    await act(async () => secondButton.click());
    assert.equal(diffCalls.length, 2);

    await act(async () => {
      secondDiff.resolve("second diff failed");
      await secondDiff.promise;
    });
    assert.match(preview.textContent ?? "", /second diff failed/);
    assert.doesNotMatch(preview.textContent ?? "", /first diff failed/);
    assert.equal(preview.getAttribute("aria-busy"), null);
    assert.equal(secondButton.disabled, false);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreElementSize();
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "操作feedbackと後着したGit Diff利用不可理由を同時に表示し、後続operationで前者だけを更新する"
// oracle = { type = "contract", ref = "src/file-explorer/SessionFilePreview.tsx" }
// fault = "後着のgit diff reasonが操作feedbackを消す、または同じerror表示へ混ぜる"
// observable = "Open failure textとGit Diff unsupported textの同時表示"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.feedback"
// lifecycle = "permanent"
// distinction = "独立したasync feedback laneの同時表示を実DOMで確認する"
// @end-test-value
/** Open の失敗通知と後から届く Git Diff の利用不可理由が共存し、次の Open が前者だけを更新することを確かめる。 */
test("操作feedbackと後着するGit Diff利用不可理由を両方表示する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const baseApi = createPreviewApi(async () => IMAGE_DESCRIPTOR).api;
  let openCount = 0;
  const api: PreviewApi = {
    ...DEFAULT_IMAGE_COPY_API,
    ...baseApi,
    /** Open の試行回数を含む失敗を返して、通知の更新を判別できるようにする。 */
    async openSessionFile() {
      openCount += 1;
      return {
        status: "failed",
        targetType: "local-path",
        target: "docs/image.png",
        message: `Open failed ${openCount}`,
      };
    },
  };
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  /** プレビューの対象を維持し、Git Diff の利用不可理由だけを差し替える。 */
  const render = async (diffAvailabilityMessage: string) => {
    await act(async () => {
      root?.render(
        React.createElement(SessionFilePreview, {
          api,
          request: MARKDOWN_REQUEST,
          /** Open の失敗通知の検査ではテキストコピーを実行しない。 */
          onCopyText() {},
          /** Git Diff の利用不可理由の検査では引用を実行しない。 */
          onQuoteText() {},
          diffAvailabilityMessage,
        }),
      );
    });
  };

  try {
    assert.ok(container);
    root = await renderPreview(api, container);
    await waitFor(() =>
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent === "Open",
      ),
    );
    /** 再描画後の DOM から現在の Open ボタンを取得する。 */
    const open = () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent === "Open",
      );

    await act(async () => {
      open()?.click();
    });
    await waitFor(
      () => container.textContent?.includes("Open failed 1") ?? false,
    );

    await render(
      "Git clean/process filters are not supported for Workspace changes.",
    );
    assert.match(container.textContent ?? "", /Open failed 1/);
    assert.match(
      container.textContent ?? "",
      /Git clean\/process filters are not supported/,
    );

    await act(async () => {
      open()?.click();
    });
    await waitFor(
      () => container.textContent?.includes("Open failed 2") ?? false,
    );
    assert.match(
      container.textContent ?? "",
      /Git clean\/process filters are not supported/,
    );
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Git Diff世代切替後の古いReload完了は現在世代のfeedbackを消さない"
// oracle = { type = "contract", ref = "src/file-explorer/SessionFilePreview.tsx" }
// fault = "旧世代promiseが新世代のerror feedbackを消す、または誤って再表示する"
// observable = "second reload failureの表示と旧reload完了後の表示状態"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.git-diff-generation"
// lifecycle = "permanent"
// distinction = "世代を跨ぐ非同期完了順とfeedback projectionを直接確認する"
// @end-test-value
/** 新しい Git Diff の再読み込みが失敗した後に旧世代の応答を完了させても、現在の失敗通知が消えないことを確かめる。 */
test("Git Diff世代切替後に古いReloadが完了しても現在のfeedbackを消さない", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const firstReload = deferred<string | null>();
  const secondReload = deferred<string | null>();
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  /** 差分の世代と再読み込み応答を切り替え、旧処理と現行処理を区別する。 */
  const render = async (
    title: string,
    previewRevision: number,
    onReload: () => Promise<string | null>,
  ) => {
    await act(async () => {
      root?.render(
        React.createElement(SessionDiffPreview, {
          title,
          previewRevision,
          patch: "@@ -1 +1 @@\n-old\n+new\n",
          /** Git Diff の世代競合はテキストコピーを使わず観測する。 */
          onCopyText() {},
          /** Git Diff の世代競合は引用を使わず観測する。 */
          onQuoteText() {},
          onReload,
        }),
      );
    });
  };

  try {
    assert.ok(container);
    root = createRoot(container);
    await render("same.txt · Working Tree", 1, () => firstReload.promise);
    const firstButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Reload");
    assert.ok(firstButton);
    await act(async () => firstButton.click());

    await render("same.txt · Working Tree", 2, () => secondReload.promise);
    const secondButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Reload");
    assert.ok(secondButton);
    await act(async () => secondButton.click());
    await act(async () => {
      secondReload.resolve("second reload failed");
      await secondReload.promise;
    });
    await waitFor(() =>
      /second reload failed/.test(container.textContent ?? ""),
    );
    assert.match(container.textContent ?? "", /second reload failed/);

    await act(async () => {
      firstReload.resolve(null);
      await firstReload.promise;
    });
    assert.match(container.textContent ?? "", /second reload failed/);

    await render("same.txt · Working Tree", 3, async () => null);
    await waitFor(
      () => !/second reload failed/.test(container.textContent ?? ""),
    );
    assert.doesNotMatch(container.textContent ?? "", /second reload failed/);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Git Diffは新しい対象の初回取得だけ本文spinnerを表示し、既存patchのReload中は本文を維持しつつbusyを示す"
// oracle = { type = "contract", ref = "src/file-explorer/SessionFilePreview.tsx" }
// fault = "対象切替後の初回取得で本文を残す、Reload中に既存patchを消す、またはreloadPendingのbusyを示さない"
// observable = "初回loading共通spinner、title、patch本文の有無、reload button disabled、aria-busy"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.git-diff-loading-reload"
// lifecycle = "permanent"
// impact = "新しいdiff取得の待機と既存patchの再読込を区別し、操作対象のbusy状態を伝える"
// distinction = "loading=trueとpatch保持/reloadPending=trueの2描画をDOMで比較する"
// @end-test-value
/** 新しい差分の取得中は本文を待機表示に置き換え、取得済み差分の再読み込み中は本文を保持して操作中と示すことを確かめる。 */
test("Git Diffは新しい対象の初回取得だけ本文spinnerへ切り替えReload中は既存本文を維持する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const restoreElementSize = installElementSize(dom);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        React.createElement(SessionDiffPreview, {
          title: "next.txt · Working Tree",
          previewRevision: 1,
          patch: "",
          loading: true,
          reloadPending: true,
          /** 初回取得中の表示ではテキストコピーを観測しない。 */
          onCopyText() {},
          /** 再読み込みの結果は返さず、待機状態は渡したプロパティで与える。 */
          async onReload() {
            return null;
          },
        }),
      );
    });
    const preview = container.querySelector<HTMLElement>(
      "[aria-label='Git diff preview']",
    );
    assert.ok(preview);
    assert.equal(preview.getAttribute("aria-busy"), "true");
    assert.equal(
      preview.querySelector(".session-file-preview-title strong")?.textContent,
      "next.txt · Working Tree",
    );
    assert.ok(preview.querySelector(".loading-indicator-spinner"));
    assert.equal(preview.querySelector(".session-live-diff-split"), null);
    const initialReload = [
      ...preview.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Reload");
    assert.equal(initialReload?.disabled, true);

    await act(async () => {
      root?.render(
        React.createElement(SessionDiffPreview, {
          title: "next.txt · Working Tree",
          previewRevision: 1,
          patch: "@@ -1 +1 @@\n-old\n+new\n",
          reloadPending: true,
          /** 既存本文の保持を確認する間はテキストコピーを行わない。 */
          onCopyText() {},
          /** 再読み込み処理自体は起動せず、取得済み本文と保留状態をプロパティで再現する。 */
          async onReload() {
            return null;
          },
        }),
      );
    });
    assert.equal(preview.getAttribute("aria-busy"), "true");
    assert.equal(preview.querySelector(".loading-indicator"), null);
    assert.ok(preview.querySelector(".session-live-diff-split"));
    const pendingReload = [
      ...preview.querySelectorAll<HTMLButtonElement>("button"),
    ].find(
      (button) => button.querySelector(".button-content-spinner") !== null,
    );
    assert.equal(pendingReload?.disabled, true);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreElementSize();
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Git Diff reloadで一致件数が減ってもfind current indexを有効範囲へclampし、navigationと対象行表示を更新する"
// oracle = { type = "contract", ref = "src/file-explorer/SessionFilePreview.tsx" }
// fault = "削減後の存在しないmatch indexを表示し、find navigationが範囲外になる"
// observable = "find count表示、Previous/Next操作、current markと対象行の更新"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.git-diff-find"
// lifecycle = "permanent"
// distinction = "reload後のfind projectionをinput/button操作とDOM表示で確認する"
// @end-test-value
/** Git Diff の再読み込みで一致件数が減ったとき、検索位置が残った一致へ収まり、移動操作と強調表示が一致することを確かめる。 */
test("Git Diff検索はReloadで一致件数が減っても現在位置を有効範囲へ収める", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreElementSize = installElementSize(dom);
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    /** 検索欄の旧形式のフォーカス処理で使うイベント登録を標準 API に変換する。 */
    value(this: HTMLElement, name: string, listener: EventListener) {
      this.addEventListener(name.replace(/^on/, ""), listener);
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    /** 検索欄から解除される旧形式のリスナーを標準 API で取り除く。 */
    value(this: HTMLElement, name: string, listener: EventListener) {
      this.removeEventListener(name.replace(/^on/, ""), listener);
    },
  });
  const restoreGlobals = installDomGlobals(dom);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  /** 同じ画面に差分本文と世代番号を渡し直し、検索継続中の再読み込みを再現する。 */
  const render = async (patch: string, previewRevision: number) => {
    await act(async () => {
      root?.render(
        React.createElement(SessionDiffPreview, {
          title: "same.txt · Working Tree",
          previewRevision,
          patch,
          /** 検索の現在位置の検査では本文をテキストコピーしない。 */
          onCopyText() {},
          /** 検索の現在位置の検査では本文を引用しない。 */
          onQuoteText() {},
        }),
      );
    });
  };

  try {
    assert.ok(container);
    root = createRoot(container);
    await render("needle\nsecond needle\n", 1);
    const findButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Find");
    assert.ok(findButton);
    await act(async () => findButton.click());
    const input = container.querySelector<HTMLInputElement>(
      "input[aria-label='Find in current content']",
    );
    assert.ok(input);
    const setInputValue = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setInputValue);
    await act(async () => {
      setInputValue.call(input, "needle");
      const propertyChange = new dom.window.Event("propertychange", {
        bubbles: true,
      });
      Object.defineProperty(propertyChange, "propertyName", { value: "value" });
      input.dispatchEvent(propertyChange);
    });
    const nextButton = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Next match']",
    );
    assert.ok(nextButton);
    await act(async () => nextButton.click());
    assert.equal(
      container.querySelector(".session-content-find-count")?.textContent,
      "2/2",
    );
    assert.equal(
      Array.from(container.querySelectorAll("mark.is-current")).some((mark) =>
        mark.closest("code")?.textContent?.includes("second needle"),
      ),
      true,
    );

    const previousButton = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Previous match']",
    );
    assert.ok(previousButton);
    await act(async () => previousButton.click());
    assert.equal(
      container.querySelector(".session-content-find-count")?.textContent,
      "1/2",
    );
    assert.equal(
      Array.from(container.querySelectorAll("mark.is-current")).some(
        (mark) => mark.closest("code")?.textContent === "needle",
      ),
      true,
    );

    await render("needle\n", 2);
    assert.equal(
      container.querySelector(".session-content-find-count")?.textContent,
      "1/1",
    );
    const clampedPreviousButton = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Previous match']",
    );
    const clampedNextButton = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Next match']",
    );
    assert.equal(clampedPreviousButton?.disabled, false);
    assert.equal(clampedNextButton?.disabled, false);
    assert.equal(
      Array.from(container.querySelectorAll("mark.is-current")).some(
        (mark) => mark.closest("code")?.textContent === "needle",
      ),
      true,
    );
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreElementSize();
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "文書と構造化テキストの表示モードは現在の選択だけをpressedで公開し、切替後も視覚的選択・原文表示・focusと一致する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#操作とアクセシビリティ" }
// fault = "pressed属性が欠落する、複数または古いモードをpressedにする、または無効なFormattedを選択状態として公開する"
// observable = "Markdown/Mermaid/HTML/JSON/不正YAMLのgroup内buttonのaria-pressed、active class、disabled、focusとRaw/Source本文"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview display mode accessibility"
// lifecycle = "permanent"
// impact = "支援技術の利用者が現在の本文表現と切替結果を識別できる"
// distinction = "既存の本文切替testや型検査では保証しない、各consumerの動的な選択状態公開を少数fixtureで検証する"
// @end-test-value
/** 各形式の表示モードで選択状態と押下状態、本文、フォーカスが整合し、不正 YAML は選択できない整形モードではなく Raw を示すことを確かめる。 */
test("File Previewの選択モードをpressedで公開し切替・focus・利用不可状態と一致させる", async () => {
  for (const fixture of [
    {
      name: "notes.md",
      source: "# Notes",
      group: "Markdown display mode",
      first: "Preview",
      second: "Source",
    },
    {
      name: "diagram.mmd",
      source: "flowchart TD\n  A --> B",
      group: "Mermaid display mode",
      first: "Preview",
      second: "Source",
    },
    {
      name: "page.html",
      source: "<h1>Notes</h1>",
      group: "HTML display mode",
      first: "Preview",
      second: "Source",
    },
    {
      name: "settings.json",
      source: '{"enabled":true}',
      group: "Structured text display mode",
      first: "Formatted",
      second: "Raw",
    },
    {
      name: "invalid.yaml",
      source: "items: [",
      group: "Structured text display mode",
      first: "Formatted",
      second: "Raw",
      invalid: true,
    },
  ]) {
    const dom = new JSDOM('<!doctype html><div id="root"></div>', {
      pretendToBeVisual: true,
      url: "http://localhost/",
    });
    const restoreGlobals = installDomGlobals(dom);
    const restoreElementSize = installElementSize(dom);
    const request: SessionFileRootResourceRequest = {
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: fixture.name,
    };
    const api = createTextPreviewApi(
      request,
      fixture.name,
      fixture.source,
      "mode-r1",
    );
    if (fixture.name.endsWith(".md")) {
      const inspect = api.inspectSessionFile;
      api.inspectSessionFile = async (resource) => ({
        ...(await inspect(resource)),
        kind: "markdown",
      });
    }
    const container = dom.window.document.getElementById("root")!;
    let root: Root | null = null;
    try {
      root = await renderPreview(api, container, request);
      await waitFor(
        () =>
          container.querySelector(`[aria-label='${fixture.group}']`) !== null,
      );
      const group = container.querySelector(`[aria-label='${fixture.group}']`)!;
      const buttons = [...group.querySelectorAll<HTMLButtonElement>("button")];
      assert.equal(buttons.length, 2);
      const first = buttons.find(
        (button) => button.textContent === fixture.first,
      )!;
      const second = buttons.find(
        (button) => button.textContent === fixture.second,
      )!;
      /** 現在のボタンだけが支援技術向けにも視覚上も選択状態になることを比較する。 */
      const assertSelection = (selected: HTMLButtonElement) => {
        for (const button of buttons) {
          assert.equal(
            button.getAttribute("aria-pressed"),
            String(button === selected),
            fixture.name,
          );
          assert.equal(
            button.classList.contains("is-active"),
            button === selected,
            fixture.name,
          );
        }
      };
      if (fixture.invalid) {
        await waitFor(
          () =>
            container.textContent?.includes(
              "Formatted preview is unavailable",
            ) ?? false,
        );
        assert.equal(first.disabled, true);
        assertSelection(second);
      } else {
        await waitFor(() => !first.disabled);
        assertSelection(first);
        second.focus();
        await act(async () => second.click());
        assertSelection(second);
        assert.equal(dom.window.document.activeElement, second);
      }
      await waitFor(
        () => container.querySelector(".session-file-text-line code") !== null,
      );
      assert.deepEqual(
        [...container.querySelectorAll(".session-file-text-line code")].map(
          (line) => line.textContent,
        ),
        fixture.source.split("\n"),
      );
      if (!fixture.invalid) {
        first.focus();
        await act(async () => first.click());
        assertSelection(first);
        assert.equal(dom.window.document.activeElement, first);
      }
    } finally {
      if (root) await act(async () => root?.unmount());
      restoreElementSize();
      restoreGlobals();
      dom.window.close();
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "Git DiffはSplitを既定表示し、Inline切替でdiff surface・視覚的選択・pressed stateを一致させる"
// oracle = { type = "contract", ref = "src/file-explorer/SessionFilePreview.tsx" }
// fault = "既定modeがInline、切替後に両方のsurfaceを表示する、pressed stateが欠落または本文とずれる、またはOpen Preview callbackを失う"
// observable = "Split/Inline surfaceの存在、active buttonとaria-pressed、Open Preview callback count"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.git-diff-mode"
// lifecycle = "permanent"
// distinction = "mode切替と外部preview操作をDOM eventから確認する"
// @end-test-value
/** Git Diff は既定で Split を描画し、Inline 切替で本文と選択状態が揃って変わること、および Open Preview が呼ばれることを確かめる。 */
test("Git DiffはSplitを既定表示にしてInlineへ切り替えられる", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  let previewOpenCount = 0;

  try {
    assert.ok(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        React.createElement(SessionDiffPreview, {
          title: "same.txt · Working Tree",
          previewRevision: 1,
          patch: "@@ -1 +1 @@\n-old\n+new\n",
          /** 差分モードと別窓起動の検査ではテキストコピーを実行しない。 */
          onCopyText() {},
          /** 差分モードと別窓起動の検査では引用を実行しない。 */
          onQuoteText() {},
          /** 別窓は実際に開かず、Open Preview の呼び出しだけを数える。 */
          async onOpenPreview() {
            previewOpenCount += 1;
            return null;
          },
        }),
      );
    });

    assert.ok(container.querySelector(".session-live-diff-split"));
    assert.equal(container.querySelector(".session-file-text-scroll"), null);
    assert.equal(
      container.querySelector("button.is-active")?.textContent,
      "Split",
    );
    const displayMode = container.querySelector(
      "[aria-label='Git diff display mode']",
    )!;
    assert.deepEqual(
      [...displayMode.querySelectorAll("button")].map((button) =>
        button.getAttribute("aria-pressed"),
      ),
      ["true", "false"],
    );

    const openPreviewButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Open Preview");
    assert.ok(openPreviewButton);
    await act(async () => {
      openPreviewButton.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
    });
    assert.equal(previewOpenCount, 1);

    const inlineButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Inline");
    assert.ok(inlineButton);
    await act(async () => inlineButton.click());

    assert.equal(container.querySelector(".session-live-diff-split"), null);
    assert.ok(container.querySelector(".session-file-text-scroll"));
    assert.equal(
      container.querySelector("button.is-active")?.textContent,
      "Inline",
    );
    assert.deepEqual(
      [...displayMode.querySelectorAll("button")].map((button) =>
        button.getAttribute("aria-pressed"),
      ),
      ["false", "true"],
    );
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});
