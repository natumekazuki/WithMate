import { readStylesheet } from "../support/read-stylesheet.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { SessionDiffPreview, SessionFilePreview } from "../../src/file-explorer/SessionFilePreview.js";
import type {
  SessionFileDescriptor,
  SessionFileGitCommitResourceRequest,
  SessionFileRootResourceRequest,
  SessionFileResourceRequest,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import { STRUCTURED_TEXT_PREVIEW_MAX_BYTES } from "../../src/file-explorer/structured-text-preview.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PreviewApi = NonNullable<React.ComponentProps<typeof SessionFilePreview>["api"]>;

const DEFAULT_IMAGE_COPY_API: Pick<
  PreviewApi,
  | "isSessionFileObjectCopyAvailable"
  | "copySessionFileObject"
  | "copySessionFilePreviewImage"
  | "showSessionFilePreviewImageContextMenu"
  | "openSessionFilePreviewWindow"
> = {
  isSessionFileObjectCopyAvailable() {
    return false;
  },
  async copySessionFileObject() {
    return { status: "copied", message: "File copied." };
  },
  async copySessionFilePreviewImage() {
    return { status: "copied" };
  },
  async showSessionFilePreviewImageContextMenu() {
    return { status: "dismissed" };
  },
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

function resourcePath(resource: { relativePath: string } | { absolutePath: string }): string {
  return "relativePath" in resource ? resource.relativePath : resource.absolutePath;
}

const MARKDOWN_DESCRIPTOR: SessionFileDescriptor = {
  ...MARKDOWN_REQUEST,
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
  name: "image.png",
  kind: "image",
  byteLength: IMAGE_BYTES.byteLength,
  modifiedAt: "2026-08-02T00:00:00.000Z",
  mimeType: "image/png",
  suggestedEncoding: "utf-8",
  revision: "image-r1",
};

function installDomGlobals(dom: JSDOM): () => void {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousMutationObserver = globalThis.MutationObserver;
  const previousNode = globalThis.Node;

  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: dom.window.requestAnimationFrame.bind(dom.window),
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "MutationObserver", {
    configurable: true,
    value: dom.window.MutationObserver,
  });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });

  return () => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: previousRequestAnimationFrame });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: previousCancelAnimationFrame });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "MutationObserver", {
      configurable: true,
      value: previousMutationObserver,
    });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
  };
}

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
    toJSON: () => ({}),
  } as DOMRect;
}

function installElementSize(dom: JSDOM): () => void {
  const prototype = dom.window.HTMLElement.prototype;
  const previousOffsetWidth = Object.getOwnPropertyDescriptor(prototype, "offsetWidth");
  const previousOffsetHeight = Object.getOwnPropertyDescriptor(prototype, "offsetHeight");
  Object.defineProperty(prototype, "offsetWidth", { configurable: true, get: () => 800 });
  Object.defineProperty(prototype, "offsetHeight", { configurable: true, get: () => 600 });
  return () => {
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

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

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

function createPreviewApi(
  inspectImage: (callCount: number) => Promise<SessionFileDescriptor>,
): { api: PreviewApi; getImageInspectCount: () => number } {
  let imageInspectCount = 0;
  const api: PreviewApi = {
    ...DEFAULT_IMAGE_COPY_API,
    async listSessionFileRoots() {
      return [{
        id: "workspace",
        kind: "workspace",
        label: "Workspace",
        displayPath: "C:\\workspace",
      }];
    },
    async inspectSessionFile(request) {
      if (resourcePath(request) === MARKDOWN_REQUEST.relativePath) {
        return MARKDOWN_DESCRIPTOR;
      }
      imageInspectCount += 1;
      return inspectImage(imageInspectCount);
    },
    async readSessionFileChunk(request) {
      const source = resourcePath(request) === MARKDOWN_REQUEST.relativePath
        ? MARKDOWN_BYTES
        : IMAGE_BYTES;
      const chunk = source.slice(request.offset, request.offset + request.length);
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
    async openSessionFile(request) {
      return { status: "opened", targetType: "local-path", target: resourcePath(request) };
    },
    async openPath(target) {
      return { status: "opened", targetType: "local-path", target };
    },
  };
  return { api, getImageInspectCount: () => imageInspectCount };
}

function createTextPreviewApi(
  request: SessionFileResourceRequest,
  name: string,
  raw: string,
  revision: string,
): PreviewApi {
  const bytes = new TextEncoder().encode(raw);
  return {
    ...DEFAULT_IMAGE_COPY_API,
    async listSessionFileRoots() {
      return [{ id: "workspace", kind: "workspace", label: "Workspace", displayPath: "C:\\workspace" }];
    },
    async inspectSessionFile() {
      return {
        ...request,
        name,
        kind: "text",
        byteLength: bytes.byteLength,
        modifiedAt: "2026-08-09T00:00:00.000Z",
        mimeType: "text/plain",
        suggestedEncoding: "utf-8",
        revision,
      };
    },
    async readSessionFileChunk(chunkRequest) {
      const chunk = bytes.slice(chunkRequest.offset, chunkRequest.offset + chunkRequest.length);
      return {
        data: copyArrayBuffer(chunk),
        offset: chunkRequest.offset,
        nextOffset: chunkRequest.offset + chunk.byteLength,
        totalBytes: bytes.byteLength,
        done: chunkRequest.offset + chunk.byteLength >= bytes.byteLength,
        revision: chunkRequest.expectedRevision,
      };
    },
    async openSessionFile() {
      return { status: "opened", targetType: "local-path", target: resourcePath(request) };
    },
    async openPath(target) {
      return { status: "opened", targetType: "local-path", target };
    },
  };
}

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

async function changeEncoding(container: HTMLElement, dom: JSDOM, value: string): Promise<void> {
  const select = container.querySelector<HTMLSelectElement>("select[aria-label='Text encoding']");
  assert.ok(select);
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}

async function renderPreview(
  api: PreviewApi,
  container: HTMLElement,
  request: SessionFileResourceRequest = MARKDOWN_REQUEST,
  extraProps: Partial<React.ComponentProps<typeof SessionFilePreview>> = {},
): Promise<Root> {
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(SessionFilePreview, {
      api,
      request,
      onCopyText() {},
      onQuoteText() {},
      ...extraProps,
    }));
  });
  return root;
}

// @test-value v2
// kind = "contract"
// claim = "File Previewはheaderを維持したままinspection/content読込中のbusy状態とprogressを本文へ表示する"
// oracle = { type = "contract", ref = "src/file-explorer/SessionFilePreview.tsx" }
// fault = "loading中にheaderを消す、aria-busy/statusを欠落させる、またはprogress上限を誤る"
// observable = "previewのaria-busy、title、status text、spinner、progress max"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.loading"
// lifecycle = "permanent"
// distinction = "jsdom上の利用者向けDOM/ARIA projectionを直接確認する"
// @end-test-value
test("File Preview はheaderを維持し本文だけをinspectionとcontent読込の状態表示へ切り替える", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
    async listSessionFileRoots() {
      return [{ id: "workspace", kind: "workspace", label: "Workspace", displayPath: "C:\\workspace" }];
    },
    async inspectSessionFile() {
      return inspectGate.promise;
    },
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
    async openSessionFile() {
      return { status: "opened", targetType: "local-path", target: resourcePath(request) };
    },
    async openPath(target) {
      return { status: "opened", targetType: "local-path", target };
    },
  };
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container, request);
    const preview = container.querySelector<HTMLElement>("[aria-label='File preview']");
    assert.ok(preview);
    assert.equal(preview.getAttribute("aria-busy"), "true");
    assert.equal(preview.querySelector(".session-file-preview-title strong")?.textContent, "notes.txt");
    assert.equal(preview.querySelector("[role='status']")?.getAttribute("aria-label"), "Inspecting file");
    assert.ok(preview.querySelector(".session-file-preview-spinner[aria-hidden='true']"));

    await act(async () => inspectGate.resolve(descriptor));
    await waitFor(() => preview.querySelector("progress") !== null);
    const progress = preview.querySelector<HTMLProgressElement>("progress");
    assert.ok(progress);
    assert.equal(preview.getAttribute("aria-busy"), "true");
    assert.ok(preview.querySelector(".session-file-preview-header"));
    assert.equal(preview.querySelector(".session-file-preview-title strong")?.textContent, "notes.txt");
    assert.equal(progress.max, bytes.byteLength);
    assert.equal(progress.value, 0);
    assert.equal(preview.querySelector("[role='status']")?.getAttribute("aria-label"), "Loading file content");

    await act(async () => readGate.resolve());
    await waitFor(() => preview.querySelector(".session-file-text-scroll") !== null);
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
test("File Previewのtoolbar actionは実行中operationを直列化する", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const openResult = deferred<Awaited<ReturnType<PreviewApi["openSessionFile"]>>>();
  const revealResult = deferred<Awaited<ReturnType<PreviewApi["openSessionFile"]>>>();
  let revealCalls = 0;
  const api: PreviewApi = {
    ...createTextPreviewApi(MARKDOWN_REQUEST, "readme.md", "preview content", "preview-r1"),
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
    await waitFor(() => Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .some((button) => button.textContent === "Open"));
    const preview = container.querySelector<HTMLElement>("[aria-label='File preview']");
    const openButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Open");
    const revealButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Show In Explorer");
    assert.ok(preview);
    assert.ok(openButton);
    assert.ok(revealButton);

    await act(async () => openButton.click());
    assert.ok(openButton.querySelector(".session-file-preview-action-spinner"));
    assert.equal(openButton.querySelector(".visually-hidden")?.textContent, "Opening file");
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
    assert.ok(revealButton.querySelector(".session-file-preview-action-spinner"));
    assert.equal(revealButton.querySelector(".visually-hidden")?.textContent, "Showing file in Explorer");
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
// oracle = { type = "contract", ref = "docs/manual-test-checklist.md: MT-023D8A" }
// fault = "Copy Fileを利用可能時に表示しない、利用不可時に表示する、effect-unknownをsuccess toneまたはstatusとして表示する、copiedをerror toneまたはalertとして表示する、または操作群を構成する要素として表示する"
// observable = "Copy Fileの表示可否、copied/effect-unknownのmessage、success/error class、role、aria-live、header notification layer包含関係、操作群からの分離、下部feedbackの不在"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview Copy File availability API and feedback"
// lifecycle = "permanent"
// impact = "利用者が操作直後にファイルコピー結果を確認でき、成功を失敗と誤認しない"
// distinction = "copy serviceのstatus返却ではなく、File Previewの利用者向け配置・視認性・ARIA表示を直接検証する"
// @end-test-value
test("File Preview はcopy availability APIが有効な場合だけCopy Fileを表示しCopy Imageと別contractで結果を表示する", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
    isSessionFileObjectCopyAvailable() {
      return true;
    },
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
    await waitFor(() => Array.from(container.querySelectorAll("button"))
      .some((button) => button.textContent === "Copy Image"));
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    assert.ok(buttons.some((button) => button.textContent === "Copy Image"));
    const copyFile = buttons.find((button) => button.textContent === "Copy File");
    assert.ok(copyFile);
    await act(async () => {
      copyFile.click();
      await Promise.resolve();
    });
    assert.deepEqual(copyRequests, [IMAGE_DESCRIPTOR]);
    const copyFeedback = container.querySelector<HTMLElement>(".session-file-preview-copy-feedback");
    assert.equal(copyFeedback?.textContent, "File copy status is unknown.");
    assert.ok(copyFeedback?.classList.contains("error"));
    assert.equal(copyFeedback?.getAttribute("role"), "alert");
    assert.equal(copyFeedback?.getAttribute("aria-live"), "assertive");
    assert.equal(copyFeedback?.closest(".session-file-preview-header") !== null, true);
    assert.equal(copyFeedback?.closest(".session-file-preview-notification-layer") !== null, true);
    assert.equal(copyFeedback?.closest(".session-file-preview-actions"), null);
    assert.equal(container.querySelector(".session-file-preview-feedback"), null);

    copyResult = "copied";
    await act(async () => {
      copyFile.click();
      await Promise.resolve();
    });
    const successFeedback = container.querySelector<HTMLElement>(".session-file-preview-copy-feedback");
    assert.equal(successFeedback?.textContent, "File copied.");
    assert.ok(successFeedback?.classList.contains("success"));
    assert.equal(successFeedback?.getAttribute("role"), "status");
    assert.equal(successFeedback?.getAttribute("aria-live"), "polite");
    assert.equal(successFeedback?.closest(".session-file-preview-header") !== null, true);
    assert.equal(successFeedback?.closest(".session-file-preview-notification-layer") !== null, true);
    assert.equal(successFeedback?.closest(".session-file-preview-actions"), null);
    assert.equal(container.querySelector(".session-file-preview-feedback"), null);

    const unavailableApi: PreviewApi = {
      ...api,
      isSessionFileObjectCopyAvailable() {
        return false;
      },
    };
    await act(async () => {
      root?.render(React.createElement(SessionFilePreview, {
        api: unavailableApi,
        request: IMAGE_DESCRIPTOR,
        onCopyText() {},
        onQuoteText() {},
      }));
    });
    assert.equal(Array.from(container.querySelectorAll("button"))
      .some((button) => button.textContent === "Copy File"), false);
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
// fault = "Markdown local linkがopenPathへ誤送信される、base resourceを失う、またはdetached preview resourceを誤る"
// observable = "preview navigation requestのkind、target、baseResource、detached resource"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.markdown-local-link"
// lifecycle = "permanent"
// impact = "root外Markdown linkを現在のfile contextから安全にpreview navigationへ接続する"
// distinction = "表示されたanchorの実clickからIPC navigation payloadを直接確認する"
// @end-test-value
test("Markdown preview の local file link は current resource を基準に detached Preview navigation へ戻す", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
    async listSessionFileRoots() {
      return [];
    },
    async inspectSessionFile() {
      return descriptor;
    },
    async readSessionFileChunk(chunkRequest) {
      const chunk = bytes.slice(chunkRequest.offset, chunkRequest.offset + chunkRequest.length);
      return {
        data: copyArrayBuffer(chunk),
        offset: chunkRequest.offset,
        nextOffset: chunkRequest.offset + chunk.byteLength,
        totalBytes: bytes.byteLength,
        done: true,
        revision: chunkRequest.expectedRevision,
      };
    },
    async openSessionFile() {
      return { status: "opened", targetType: "local-path", target: request.absolutePath };
    },
    async openPath(target) {
      assert.fail(`Markdown local file link must not use openPath: ${target}`);
    },
    async openSessionFilePreviewWindow(navigationRequest) {
      navigationRequests.push(navigationRequest);
      return {
        status: "opened",
        targetType: "preview-window",
        disposition: "created",
        resource: { sessionId: "session-1", absolutePath: "C:\\outside\\next.md" },
      };
    },
  };
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  try {
    assert.ok(container);
    root = await renderPreview(api, container, request);
    await waitFor(() => container.querySelector<HTMLAnchorElement>("a") !== null);
    await act(async () => container.querySelector<HTMLAnchorElement>("a")?.click());
    assert.deepEqual(navigationRequests, [{
      kind: "link",
      sessionId: "session-1",
      target: "./next.md",
      baseResource: request,
    }]);
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
test("commit file preview は通常previewを再利用しworking tree操作を表示しない", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
    ...createTextPreviewApi(request, "current.ts", "const version = 'commit';\n", "b".repeat(40)),
    isSessionFileObjectCopyAvailable() {
      return true;
    },
  };
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  try {
    assert.ok(container);
    root = await renderPreview(api, container, request);
    await waitFor(() => container.textContent?.includes("const version = 'commit';") === true);
    assert.match(container.querySelector(".session-file-preview-title")?.textContent ?? "", /current\.tsCommit aaaaaaa/);
    const labels = Array.from(container.querySelectorAll("button")).map((button) => button.textContent);
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
test("binary commit file preview はmetadata内にもworking tree操作を表示しない", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
    async listSessionFileRoots() {
      return [];
    },
    async inspectSessionFile() {
      return descriptor;
    },
    async readSessionFileChunk() {
      assert.fail("Binary metadata preview must not read file contents.");
    },
    async openSessionFile() {
      assert.fail("Commit resources must not invoke working tree open.");
    },
    async openPath(target) {
      return { status: "opened", targetType: "local-path", target };
    },
    isSessionFileObjectCopyAvailable() {
      return true;
    },
  };
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  try {
    assert.ok(container);
    root = await renderPreview(api, container, request);
    await waitFor(() => container.querySelector(".session-file-preview-metadata") !== null);
    const labels = Array.from(container.querySelectorAll("button")).map((button) => button.textContent);
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

test("Text preview の選択範囲は Copy と Quote の共通 action を表示する", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
  const api = createTextPreviewApi(request, "notes.txt", "selected preview text", "text-r1");
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container, request, {
      onQuoteText: (text) => quotedTexts.push(text),
    });
    await waitFor(() => container.querySelector(".session-file-text-line code") !== null);

    const surface = container.querySelector<HTMLElement>(".session-file-text-scroll");
    const selectedNode = container.querySelector(".session-file-text-line code")?.firstChild;
    assert.ok(surface);
    assert.ok(selectedNode);
    Object.defineProperty(surface, "getBoundingClientRect", {
      configurable: true,
      value: () => createRect({ left: 0, top: 0, width: 500, height: 500 }),
    });
    const anchorRect = createRect({ left: 100, top: 100, width: 80, height: 20 });
    const selection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt() {
        return {
          commonAncestorContainer: selectedNode,
          getBoundingClientRect: () => anchorRect,
          getClientRects: () => [anchorRect],
        };
      },
      toString: () => "  selected preview text\n",
    } as unknown as Selection;
    Object.defineProperty(dom.window, "getSelection", {
      configurable: true,
      value: () => selection,
    });

    await act(async () => {
      dom.window.document.dispatchEvent(new dom.window.Event("selectionchange"));
    });
    const toolbar = container.querySelector(".message-response-actions");
    assert.ok(toolbar);
    const buttons = Array.from(toolbar.querySelectorAll<HTMLButtonElement>("button"));
    assert.deepEqual(buttons.map((button) => button.textContent), ["Copy", "Quote"]);

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
test("Text preview の Ctrl+A は仮想化された全文だけを Copy と Quote の対象にする", async () => {
  const dom = new JSDOM("<!doctype html><p>outside preview</p><div id=\"root\"></div>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    value(this: HTMLElement, name: string, listener: EventListener) {
      this.addEventListener(name.replace(/^on/, ""), listener);
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    value(this: HTMLElement, name: string, listener: EventListener) {
      this.removeEventListener(name.replace(/^on/, ""), listener);
    },
  });
  const restoreGlobals = installDomGlobals(dom);
  const restoreElementSize = installElementSize(dom);
  const rangePrototype = dom.window.Range.prototype;
  const previousGetBoundingClientRect = rangePrototype.getBoundingClientRect;
  const previousGetClientRects = rangePrototype.getClientRects;
  const selectionRect = createRect({ left: 40, top: 40, width: 400, height: 300 });
  rangePrototype.getBoundingClientRect = () => selectionRect;
  Object.defineProperty(rangePrototype, "getClientRects", {
    configurable: true,
    value: () => [selectionRect],
  });
  const request: SessionFileResourceRequest = {
    sessionId: "session-1",
    rootId: "workspace",
    relativePath: "many-lines.txt",
  };
  const text = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n");
  const quotedTexts: string[] = [];
  const api = createTextPreviewApi(request, "many-lines.txt", text, "text-r1");
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container, request, {
      onQuoteText: (value) => quotedTexts.push(value),
    });
    await waitFor(() => container.querySelector(".session-file-text-line code") !== null);

    const surface = container.querySelector<HTMLElement>(".session-file-text-scroll");
    assert.ok(surface);
    Object.defineProperty(surface, "getBoundingClientRect", {
      configurable: true,
      value: () => selectionRect,
    });
    const previewHeaderButton = container.querySelector<HTMLButtonElement>(".session-file-preview-header button");
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
    assert.ok(container.querySelectorAll(".session-file-text-line").length < 200);

    let copiedText = "";
    const copyEvent = new dom.window.Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copyEvent, "clipboardData", {
      value: {
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

    const quoteButton = Array.from(container.querySelectorAll<HTMLButtonElement>(".message-response-actions button"))
      .find((button) => button.textContent === "Quote");
    assert.ok(quoteButton);
    await act(async () => quoteButton.click());
    assert.deepEqual(quotedTexts, [text]);

    const findButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Find");
    assert.ok(findButton);
    await act(async () => findButton.click());
    const findInput = container.querySelector<HTMLInputElement>("input[aria-label='Find in current content']");
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

function dispatchPointerEvent(
  dom: JSDOM,
  target: Element,
  type: string,
  input: { pointerId: number; button?: number; clientX?: number; clientY?: number },
): void {
  const event = new dom.window.MouseEvent(type, {
    bubbles: true,
    button: input.button ?? 0,
    clientX: input.clientX ?? 0,
    clientY: input.clientY ?? 0,
  });
  Object.defineProperty(event, "pointerId", { value: input.pointerId });
  target.dispatchEvent(event);
}

test("encoding 切替は表示済みの同一 local image を現行 generation へ再登録する", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
  const { api, getImageInspectCount } = createPreviewApi(async () => IMAGE_DESCRIPTOR);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container);
    await waitFor(() => container.querySelector("img")?.getAttribute("src")?.startsWith("blob:preview-") ?? false);
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
test("Markdown File Preview のReloadは同一画像を現行generationへ再登録する", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
  const harness = createPreviewApi(async (callCount) => (
    callCount === 1 ? IMAGE_DESCRIPTOR : changedImageDescriptor
  ));
  const api: PreviewApi = {
    ...harness.api,
    async readSessionFileChunk(request) {
      const source = resourcePath(request) === MARKDOWN_REQUEST.relativePath
        ? MARKDOWN_BYTES
        : request.expectedRevision === changedImageDescriptor.revision
          ? changedImageBytes
          : IMAGE_BYTES;
      if (resourcePath(request) === IMAGE_DESCRIPTOR.relativePath) {
        imageReadRevisions.push(request.expectedRevision ?? "");
      }
      const chunk = source.slice(request.offset, request.offset + request.length);
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
    await waitFor(() => container.querySelector("img")?.getAttribute("src")?.startsWith("blob:reload-preview-") ?? false);
    const firstSource = container.querySelector("img")?.getAttribute("src");
    const baselineInspectCount = getImageInspectCount();
    const reload = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Reload");
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
    assert.deepEqual(imageReadRevisions, [IMAGE_DESCRIPTOR.revision, changedImageDescriptor.revision]);
    assert.equal(createdBlobs.length, 2);
    assert.deepEqual(Array.from(new Uint8Array(await createdBlobs[0].arrayBuffer())), Array.from(IMAGE_BYTES));
    assert.deepEqual(Array.from(new Uint8Array(await createdBlobs[1].arrayBuffer())), Array.from(changedImageBytes));
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
// fault = "Reload直後の旧ready stateを見てbusyを解除し、request完了前に再操作可能またはaria-busy解除になる"
// observable = "Reloading label、reload button disabled、preview aria-busy、inspect gate解放後の解除"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.reload-busy"
// lifecycle = "permanent"
// impact = "再読込中の対象を継続して示し、古い本文への操作と重複requestを防ぐ"
// distinction = "ready本文を保持したまま二回目inspectを保留し、完了前後のDOM busy projectionを分けて確認する"
// @end-test-value
test("File PreviewのReload busyはrequest完了まで保持される", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
  const harness = createPreviewApi(async (callCount) => (
    callCount === 1 ? IMAGE_DESCRIPTOR : secondInspect.promise
  ));
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(harness.api, container, IMAGE_DESCRIPTOR);
    await waitFor(() => container.querySelector<HTMLImageElement>(".session-file-image") !== null);
    const preview = container.querySelector<HTMLElement>("[aria-label='File preview']");
    const reload = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Reload");
    assert.ok(preview);
    assert.ok(reload);

    await act(async () => reload.click());
    await waitFor(() => reload.querySelector(".session-file-preview-action-spinner") !== null);
    assert.equal(reload.querySelector(".visually-hidden")?.textContent, "Reloading");
    assert.equal(reload.disabled, true);
    assert.equal(preview.getAttribute("aria-busy"), "true");

    await act(async () => {
      secondInspect.resolve({
        ...IMAGE_DESCRIPTOR,
        revision: "image-r2",
      });
      await secondInspect.promise;
    });
    await waitFor(() => reload.textContent === "Reload");
    assert.equal(reload.disabled, false);
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
test("encoding 切替は実行中の同一 local image も現行 generation へ再登録する", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
  const firstInspectResolver: { resolve: ((descriptor: SessionFileDescriptor) => void) | null } = { resolve: null };
  const firstInspect = new Promise<SessionFileDescriptor>((resolve) => {
    firstInspectResolver.resolve = resolve;
  });
  const { api, getImageInspectCount } = createPreviewApi(async (callCount) => (
    callCount === 1 ? firstInspect : IMAGE_DESCRIPTOR
  ));
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container);
    await waitFor(() => getImageInspectCount() === 1);

    await changeEncoding(container, dom, "shift_jis");
    await waitFor(() => getImageInspectCount() === 2);
    await waitFor(() => container.querySelector("img")?.getAttribute("src") === createdSources[0]);
    const currentSource = container.querySelector("img")?.getAttribute("src");
    assert.equal(currentSource, "blob:encoding-preview-1");

    firstInspectResolver.resolve?.({ ...IMAGE_DESCRIPTOR, revision: "stale-image-r0" });
    await act(async () => {
      await Promise.resolve();
    });
    assert.equal(container.querySelector("img")?.getAttribute("src"), currentSource);
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
test("inspection prefix より後ろで binary と判明した Markdown は rich renderer へ渡さない", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
    async listSessionFileRoots() {
      return [{ id: "workspace", kind: "workspace", label: "Workspace", displayPath: "C:\\workspace" }];
    },
    async inspectSessionFile() {
      return descriptor;
    },
    async readSessionFileChunk(request) {
      const chunk = bytes.slice(request.offset, request.offset + request.length);
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
    async openSessionFile(request) {
      return { status: "opened", targetType: "local-path", target: resourcePath(request) };
    },
    async openPath(target) {
      return { status: "opened", targetType: "local-path", target };
    },
  };
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container);
    await waitFor(() => container.querySelector(".session-file-preview-metadata") !== null);
    assert.equal(container.querySelector(".session-file-markdown"), null);
    assert.match(container.textContent ?? "", /Preview is not available for this binary file/);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

test("JSON preview は Formatted と原文を保持した Raw を切り替える", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
  const raw = "{\"markup\":\"<img src=x onerror=alert(1)>\",\"enabled\":true}";
  const api = createTextPreviewApi(request, "settings.json", raw, "json-r1");
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container, request);
    await waitFor(() => {
      const formatted = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent === "Formatted");
      return formatted?.disabled === false;
    });
    const formattedButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Formatted");
    const rawButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Raw");
    assert.ok(formattedButton?.classList.contains("is-active"));
    assert.ok(rawButton);
    assert.equal(container.querySelector("img[src='x']"), null);
    assert.match(container.textContent ?? "", /<img src=x onerror=alert\(1\)>/);

    await act(async () => rawButton.click());
    await waitFor(() => rawButton.classList.contains("is-active"));
    const displayedLines = Array.from(container.querySelectorAll(".session-file-text-line code"))
      .map((element) => element.textContent ?? "");
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

test("不正な YAML preview は parse error を示して Raw へ fallback する", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
    await waitFor(() => container.textContent?.includes("Formatted preview is unavailable") ?? false);
    const formattedButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Formatted");
    const rawButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Raw");
    assert.equal(formattedButton?.disabled, true);
    assert.ok(rawButton?.classList.contains("is-active"));
    assert.match(container.textContent ?? "", /root: \[/);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    restoreElementSize();
    dom.window.close();
  }
});

test("上限を超える JSON preview はformatせず既存Raw表示へ戻す", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
    await waitFor(() => container.textContent?.includes("Formatted preview is skipped") ?? false);
    assert.equal(container.querySelector("[aria-label='Structured text display mode']"), null);
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
test("寸法情報のあるSVGも初回はFitで表示する", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
    "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"320\" height=\"180\"><path d=\"M0 0\"/></svg>",
  );
  const descriptor: SessionFileDescriptor = {
    ...request,
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
    async listSessionFileRoots() {
      return [{ id: "workspace", kind: "workspace", label: "Workspace", displayPath: "C:\\workspace" }];
    },
    async inspectSessionFile() {
      return descriptor;
    },
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
    async openSessionFile(openRequest) {
      return { status: "opened", targetType: "local-path", target: resourcePath(openRequest) };
    },
    async openPath(target) {
      return { status: "opened", targetType: "local-path", target };
    },
  };
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = await renderPreview(api, container, request);
    await waitFor(() => container.querySelector(".session-file-image.is-fit") !== null);
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

test("拡大画像を主ポインターでドラッグするとスクロール位置を移動し、終了後は停止する", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
    await waitFor(() => container.querySelector(".session-file-image-scroll") !== null);
    const scrollSurface = container.querySelector<HTMLDivElement>(".session-file-image-scroll");
    const image = container.querySelector<HTMLImageElement>(".session-file-image");
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
    scrollSurface.hasPointerCapture = (pointerId) => capturedPointerId === pointerId;
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
// oracle = { type = "contract", ref = "docs/manual-test-checklist.md: MT-023D8" }
// fault = "Copy Image操作の成功結果がsuccess tone・status role・polite announcementを持たない、下部のerror表示になる、または操作群を構成する要素として表示される"
// observable = "Copy Image結果のmessage、success class、status role、aria-live、header notification layer包含関係、操作群からの分離、下部feedbackの不在"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview Copy Image feedback"
// lifecycle = "permanent"
// impact = "画像コピー直後の成功結果を操作位置の近くで確認できる"
// distinction = "画像座標をcopy境界へ渡す既存検証に加え、rendererの結果通知DOM配置とARIA契約を直接検証する"
// @end-test-value
test("単体画像previewはbuttonと右クリックから現在の画像座標をcopy境界へ渡す", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
    async copySessionFilePreviewImage(request) {
      copyRequests.push(request);
      return { status: "copied" };
    },
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
    await waitFor(() => container.querySelector<HTMLImageElement>(".session-file-image") !== null);
    const image = container.querySelector<HTMLImageElement>(".session-file-image");
    const scrollport = container.querySelector<HTMLDivElement>(".session-file-image-scroll");
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
      toJSON() {},
    });
    const copyButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Copy Image");
    assert.ok(copyButton);

    await act(async () => copyButton.click());
    await waitFor(() => copyRequests.length === 1);
    assert.deepEqual(copyRequests, [{
      sessionId: "session-1",
      point: { x: 70, y: 80 },
    }]);
    const imageCopyFeedback = container.querySelector<HTMLElement>(".session-file-preview-copy-feedback");
    assert.equal(imageCopyFeedback?.textContent, "Image copied.");
    assert.ok(imageCopyFeedback?.classList.contains("success"));
    assert.equal(imageCopyFeedback?.getAttribute("role"), "status");
    assert.equal(imageCopyFeedback?.getAttribute("aria-live"), "polite");
    assert.equal(imageCopyFeedback?.closest(".session-file-preview-header") !== null, true);
    assert.equal(imageCopyFeedback?.closest(".session-file-preview-notification-layer") !== null, true);
    assert.equal(imageCopyFeedback?.closest(".session-file-preview-actions"), null);
    assert.equal(container.querySelector(".session-file-preview-feedback"), null);

    const contextMenuRequest: SessionFileResourceRequest = {
      ...IMAGE_DESCRIPTOR,
      relativePath: "docs/context-menu.png",
    };
    await act(async () => {
      root?.render(React.createElement(SessionFilePreview, {
        api,
        request: contextMenuRequest,
        onCopyText() {},
        onQuoteText() {},
      }));
    });
    await waitFor(() => container.querySelector<HTMLImageElement>(".session-file-image") !== null);
    await waitFor(() => container.querySelector(".session-file-preview-copy-feedback") === null);
    const contextMenuImage = container.querySelector<HTMLImageElement>(".session-file-image");
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
    assert.deepEqual(contextMenuRequests, [{
      sessionId: "session-1",
      point: { x: 44, y: 55 },
    }]);
    await waitFor(() => container.querySelector<HTMLElement>(".session-file-preview-copy-feedback")?.textContent === "Image copied.");
    const contextMenuFeedback = container.querySelector<HTMLElement>(".session-file-preview-copy-feedback");
    assert.equal(contextMenuFeedback?.textContent, "Image copied.");
    assert.ok(contextMenuFeedback?.classList.contains("success"));
    assert.equal(contextMenuFeedback?.getAttribute("role"), "status");
    assert.equal(contextMenuFeedback?.getAttribute("aria-live"), "polite");
    assert.equal(contextMenuFeedback?.closest(".session-file-preview-header") !== null, true);
    assert.equal(contextMenuFeedback?.closest(".session-file-preview-notification-layer") !== null, true);
    assert.equal(contextMenuFeedback?.closest(".session-file-preview-actions"), null);
    assert.equal(container.querySelector(".session-file-preview-feedback"), null);
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
// claim = "別窓File Previewのcopy通知に必要な暗色theme token、success/errorの文字・背景・border、headerを基準にした操作群外overlayのCSS宣言が定義されている"
// oracle = { type = "contract", ref = "docs/manual-test-checklist.md: MT-023D8" }
// fault = "別窓copy通知の暗色theme token、success/errorの背景またはborder、headerのrelative基準、または操作群外absolute overlayに必要なCSS宣言が欠けている"
// observable = "file-preview-window-page、app-notificationのsuccess/error、session-file-preview-headerとsession-file-preview-notification-layerの各CSS declaration"
// observation_boundary = "declaration"
// scope = "File Preview detached notification stylesheet"
// lifecycle = "permanent"
// impact = "別窓のcopy通知表示に必要なCSS契約を維持し、実画面で確認すべき視認性とlayout条件を明確にする"
// distinction = "JSDOMでは算出できない宣言の存在を確認し、DOMの通知内容・ARIA・親境界の検証と分担する"
// @end-test-value
test("別窓File Previewのcopy通知CSSは暗色themeと操作群外overlayを定義する", async () => {
  const styles = await readStylesheet();
  const pageRule = styles.match(/\.file-preview-window-page\s*{(?<body>[^}]*)}/)?.groups?.body ?? "";
  const notificationRule = styles.match(/\.app-notification\s*{(?<body>[^}]*)}/)?.groups?.body ?? "";
  const successRule = styles.match(/\.app-notification\.success\s*{(?<body>[^}]*)}/)?.groups?.body ?? "";
  const errorRule = styles.match(/\.app-notification\.error\s*{(?<body>[^}]*)}/)?.groups?.body ?? "";
  const headerRule = styles.match(/\.session-file-preview-header\s*{(?<body>[^}]*)}/)?.groups?.body ?? "";
  const layerRule = styles.match(/\.session-file-preview-notification-layer\s*{(?<body>[^}]*)}/)?.groups?.body ?? "";

  assert.match(pageRule, /--surface-strong:\s*rgba\(28,\s*33,\s*43,\s*0\.98\);/);
  assert.match(pageRule, /--line:\s*rgba\(203,\s*213,\s*225,\s*0\.12\);/);
  assert.match(pageRule, /--ink:\s*#e5edf8;/);
  assert.match(pageRule, /--teal:\s*#6fb8c7;/);
  assert.match(pageRule, /--teal-soft:\s*rgba\(111,\s*184,\s*199,\s*0\.14\);/);
  assert.match(notificationRule, /border:\s*1px solid var\(--line\);/);
  assert.match(notificationRule, /background:\s*var\(--surface-strong\);/);
  assert.match(notificationRule, /color:\s*var\(--ink\);/);
  assert.match(successRule, /border-color:\s*var\(--teal\);/);
  assert.match(successRule, /background:\s*color-mix\(in srgb,\s*var\(--teal-soft\)\s*72%,\s*var\(--surface-strong\)\);/);
  assert.match(errorRule, /border-color:\s*var\(--danger,\s*#fca5a5\);/);
  assert.match(errorRule, /background:\s*color-mix\(in srgb,\s*var\(--danger,\s*#fca5a5\)\s*14%,\s*var\(--surface-strong\)\);/);
  assert.match(headerRule, /position:\s*relative;/);
  assert.match(layerRule, /position:\s*absolute;/);
  assert.match(layerRule, /top:\s*calc\(100%\s*\+\s*8px\);/);
  assert.match(layerRule, /right:\s*10px;/);
  assert.match(layerRule, /z-index:\s*2;/);
  assert.match(layerRule, /pointer-events:\s*none;/);
});

test("画像previewは初回Fitの実効倍率を表示しZoom Inの基準にする", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
    await waitFor(() => container.querySelector<HTMLImageElement>(".session-file-image") !== null);
    const viewport = container.querySelector<HTMLElement>(".session-file-image-scroll");
    const image = container.querySelector<HTMLImageElement>(".session-file-image");
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
    assert.ok(container.querySelector("button[aria-label='Fit image to preview'].is-active"));
    assert.equal(
      container.querySelector<HTMLButtonElement>("button[aria-label='Reset image zoom to 100%']")?.textContent,
      "50%",
    );

    await act(async () => {
      container.querySelector<HTMLButtonElement>("button[aria-label='Zoom image in']")?.click();
    });
    assert.equal(
      container.querySelector<HTMLButtonElement>("button[aria-label='Reset image zoom to 100%']")?.textContent,
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
// claim = "file切替後に旧fileの完了したOpen/Open Diff結果を新previewへ表示しない"
// oracle = { type = "contract", ref = "src/file-explorer/SessionFilePreview.tsx" }
// fault = "stale async resultが新fileのpreviewへ混入する"
// observable = "切替後のpreview DOMとopen/open-diff feedback"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.async-generation"
// lifecycle = "permanent"
// distinction = "旧promiseの完了順を制御し、generation guardの利用者向け結果を確認する"
// @end-test-value
test("file切替後に完了したOpenとOpen Diffの結果を新しいpreviewへ表示しない", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const firstRequest: SessionFileResourceRequest = {
    sessionId: "session-1",
    rootId: "workspace",
    relativePath: "first.txt",
  };
  const secondRequest: SessionFileResourceRequest = { ...firstRequest, relativePath: "second.txt" };
  const bytes = new TextEncoder().encode("content");
  const openResult = deferred<Awaited<ReturnType<PreviewApi["openSessionFile"]>>>();
  const diffResult = deferred<string | null>();
  const api: PreviewApi = {
    ...DEFAULT_IMAGE_COPY_API,
    async listSessionFileRoots() {
      return [{ id: "workspace", kind: "workspace", label: "Workspace", displayPath: "C:\\workspace" }];
    },
    async inspectSessionFile(inspectRequest) {
      return {
        ...inspectRequest,
        name: resourcePath(inspectRequest),
        kind: "text",
        byteLength: bytes.byteLength,
        modifiedAt: "2026-08-02T00:00:00.000Z",
        mimeType: "text/plain",
        suggestedEncoding: "utf-8",
        revision: `${resourcePath(inspectRequest)}-r1`,
      };
    },
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
    openSessionFile() {
      return openResult.promise;
    },
    async openPath(target) {
      return { status: "opened", targetType: "local-path", target };
    },
  };
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  const render = async (request: SessionFileResourceRequest) => {
    await act(async () => {
      root?.render(React.createElement(SessionFilePreview, {
        api,
        request,
        onCopyText() {},
        onQuoteText() {},
        diffScopes: ["working-tree"],
        onOpenDiff: () => diffResult.promise,
      }));
    });
  };

  try {
    assert.ok(container);
    root = await renderPreview(api, container, firstRequest, {
      diffScopes: ["working-tree"],
      onOpenDiff: () => diffResult.promise,
    });
    await waitFor(() => Array.from(container.querySelectorAll("button"))
      .some((button) => button.textContent === "Open Diff"));
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    const openButton = buttons.find((button) => button.textContent === "Open");
    const diffButton = buttons.find((button) => button.textContent === "Open Diff");
    assert.ok(openButton);
    assert.ok(diffButton);
    await act(async () => {
      openButton.click();
      diffButton.click();
    });

    await render(secondRequest);
    await waitFor(() => container.textContent?.includes("second.txt") ?? false);
    await act(async () => {
      openResult.resolve({
        status: "failed",
        targetType: "local-path",
        target: "docs/image.png",
        message: "first open failed",
      });
      diffResult.resolve("first diff failed");
      await Promise.all([openResult.promise, diffResult.promise]);
    });

    assert.doesNotMatch(container.textContent ?? "", /first open failed|first diff failed/);
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
// claim = "操作feedbackと後着したGit Diff利用不可理由を同時に表示し、後続operationで前者だけを更新する"
// oracle = { type = "contract", ref = "src/file-explorer/SessionFilePreview.tsx" }
// fault = "後着のgit diff reasonが操作feedbackを消す、または同じerror表示へ混ぜる"
// observable = "Open failure textとGit Diff unsupported textの同時表示"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.feedback"
// lifecycle = "permanent"
// distinction = "独立したasync feedback laneの同時表示を実DOMで確認する"
// @end-test-value
test("操作feedbackと後着するGit Diff利用不可理由を両方表示する", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const baseApi = createPreviewApi(async () => IMAGE_DESCRIPTOR).api;
  let openCount = 0;
  const api: PreviewApi = {
    ...DEFAULT_IMAGE_COPY_API,
    ...baseApi,
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
  const render = async (diffAvailabilityMessage: string) => {
    await act(async () => {
      root?.render(React.createElement(SessionFilePreview, {
        api,
        request: MARKDOWN_REQUEST,
        onCopyText() {},
        onQuoteText() {},
        diffAvailabilityMessage,
      }));
    });
  };

  try {
    assert.ok(container);
    root = await renderPreview(api, container);
    await waitFor(() => Array.from(container.querySelectorAll("button"))
      .some((button) => button.textContent === "Open"));
    const open = () => Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Open");

    await act(async () => {
      open()?.click();
    });
    await waitFor(() => container.textContent?.includes("Open failed 1") ?? false);

    await render("Git clean/process filters are not supported for Workspace changes.");
    assert.match(container.textContent ?? "", /Open failed 1/);
    assert.match(container.textContent ?? "", /Git clean\/process filters are not supported/);

    await act(async () => {
      open()?.click();
    });
    await waitFor(() => container.textContent?.includes("Open failed 2") ?? false);
    assert.match(container.textContent ?? "", /Git clean\/process filters are not supported/);
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
test("Git Diff世代切替後に古いReloadが完了しても現在のfeedbackを消さない", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const firstReload = deferred<string | null>();
  const secondReload = deferred<string | null>();
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  const render = async (title: string, previewRevision: number, onReload: () => Promise<string | null>) => {
    await act(async () => {
      root?.render(React.createElement(SessionDiffPreview, {
        title,
        previewRevision,
        patch: "@@ -1 +1 @@\n-old\n+new\n",
        onCopyText() {},
        onQuoteText() {},
        onReload,
      }));
    });
  };

  try {
    assert.ok(container);
    root = createRoot(container);
    await render("same.txt · Working Tree", 1, () => firstReload.promise);
    const firstButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Reload");
    assert.ok(firstButton);
    await act(async () => firstButton.click());

    await render("same.txt · Working Tree", 2, () => secondReload.promise);
    const secondButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Reload");
    assert.ok(secondButton);
    await act(async () => secondButton.click());
    await act(async () => {
      secondReload.resolve("second reload failed");
      await secondReload.promise;
    });
    await waitFor(() => /second reload failed/.test(container.textContent ?? ""));
    assert.match(container.textContent ?? "", /second reload failed/);

    await act(async () => {
      firstReload.resolve(null);
      await firstReload.promise;
    });
    assert.match(container.textContent ?? "", /second reload failed/);

    await render("same.txt · Working Tree", 3, async () => null);
    await waitFor(() => !/second reload failed/.test(container.textContent ?? ""));
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
// observable = "初回loading spinner、title、patch本文の有無、reload button disabled、aria-busy"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.git-diff-loading-reload"
// lifecycle = "permanent"
// impact = "新しいdiff取得の待機と既存patchの再読込を区別し、操作対象のbusy状態を伝える"
// distinction = "loading=trueとpatch保持/reloadPending=trueの2描画をDOMで比較する"
// @end-test-value
test("Git Diffは新しい対象の初回取得だけ本文spinnerへ切り替えReload中は既存本文を維持する", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
      root?.render(React.createElement(SessionDiffPreview, {
        title: "next.txt · Working Tree",
        previewRevision: 1,
        patch: "",
        loading: true,
        reloadPending: true,
        onCopyText() {},
        async onReload() {
          return null;
        },
      }));
    });
    const preview = container.querySelector<HTMLElement>("[aria-label='Git diff preview']");
    assert.ok(preview);
    assert.equal(preview.getAttribute("aria-busy"), "true");
    assert.equal(preview.querySelector(".session-file-preview-title strong")?.textContent, "next.txt · Working Tree");
    assert.ok(preview.querySelector(".session-file-preview-spinner"));
    assert.equal(preview.querySelector(".session-live-diff-split"), null);
    const initialReload = [...preview.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Reload");
    assert.equal(initialReload?.disabled, true);

    await act(async () => {
      root?.render(React.createElement(SessionDiffPreview, {
        title: "next.txt · Working Tree",
        previewRevision: 1,
        patch: "@@ -1 +1 @@\n-old\n+new\n",
        reloadPending: true,
        onCopyText() {},
        async onReload() {
          return null;
        },
      }));
    });
    assert.equal(preview.getAttribute("aria-busy"), "true");
    assert.equal(preview.querySelector(".session-file-preview-spinner"), null);
    assert.ok(preview.querySelector(".session-live-diff-split"));
    const pendingReload = [...preview.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.querySelector(".session-file-preview-action-spinner") !== null);
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
test("Git Diff検索はReloadで一致件数が減っても現在位置を有効範囲へ収める", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreElementSize = installElementSize(dom);
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    value(this: HTMLElement, name: string, listener: EventListener) {
      this.addEventListener(name.replace(/^on/, ""), listener);
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    value(this: HTMLElement, name: string, listener: EventListener) {
      this.removeEventListener(name.replace(/^on/, ""), listener);
    },
  });
  const restoreGlobals = installDomGlobals(dom);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  const render = async (patch: string, previewRevision: number) => {
    await act(async () => {
      root?.render(React.createElement(SessionDiffPreview, {
        title: "same.txt · Working Tree",
        previewRevision,
        patch,
        onCopyText() {},
        onQuoteText() {},
      }));
    });
  };

  try {
    assert.ok(container);
    root = createRoot(container);
    await render("needle\nsecond needle\n", 1);
    const findButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Find");
    assert.ok(findButton);
    await act(async () => findButton.click());
    const input = container.querySelector<HTMLInputElement>("input[aria-label='Find in current content']");
    assert.ok(input);
    const setInputValue = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setInputValue);
    await act(async () => {
      setInputValue.call(input, "needle");
      const propertyChange = new dom.window.Event("propertychange", { bubbles: true });
      Object.defineProperty(propertyChange, "propertyName", { value: "value" });
      input.dispatchEvent(propertyChange);
    });
    const nextButton = container.querySelector<HTMLButtonElement>("button[aria-label='Next match']");
    assert.ok(nextButton);
    await act(async () => nextButton.click());
    assert.equal(container.querySelector(".session-content-find-count")?.textContent, "2/2");
    assert.equal(Array.from(container.querySelectorAll("mark.is-current"))
      .some((mark) => mark.closest("code")?.textContent?.includes("second needle")), true);

    const previousButton = container.querySelector<HTMLButtonElement>("button[aria-label='Previous match']");
    assert.ok(previousButton);
    await act(async () => previousButton.click());
    assert.equal(container.querySelector(".session-content-find-count")?.textContent, "1/2");
    assert.equal(Array.from(container.querySelectorAll("mark.is-current"))
      .some((mark) => mark.closest("code")?.textContent === "needle"), true);

    await render("needle\n", 2);
    assert.equal(container.querySelector(".session-content-find-count")?.textContent, "1/1");
    const clampedPreviousButton = container.querySelector<HTMLButtonElement>("button[aria-label='Previous match']");
    const clampedNextButton = container.querySelector<HTMLButtonElement>("button[aria-label='Next match']");
    assert.equal(clampedPreviousButton?.disabled, false);
    assert.equal(clampedNextButton?.disabled, false);
    assert.equal(Array.from(container.querySelectorAll("mark.is-current"))
      .some((mark) => mark.closest("code")?.textContent === "needle"), true);
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
// claim = "Git DiffはSplitを既定表示し、Inline切替でdiff surfaceとactive controlを更新する"
// oracle = { type = "contract", ref = "src/file-explorer/SessionFilePreview.tsx" }
// fault = "既定modeがInline、切替後に両方のsurfaceを表示する、またはOpen Preview callbackを失う"
// observable = "Split/Inline surfaceの存在、active button、Open Preview callback count"
// observation_boundary = "component-behavior"
// scope = "SessionFilePreview.git-diff-mode"
// lifecycle = "permanent"
// distinction = "mode切替と外部preview操作をDOM eventから確認する"
// @end-test-value
test("Git DiffはSplitを既定表示にしてInlineへ切り替えられる", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
      root?.render(React.createElement(SessionDiffPreview, {
        title: "same.txt · Working Tree",
        previewRevision: 1,
        patch: "@@ -1 +1 @@\n-old\n+new\n",
        onCopyText() {},
        onQuoteText() {},
        async onOpenPreview() {
          previewOpenCount += 1;
          return null;
        },
      }));
    });

    assert.ok(container.querySelector(".session-live-diff-split"));
    assert.equal(container.querySelector(".session-file-text-scroll"), null);
    assert.equal(container.querySelector("button.is-active")?.textContent, "Split");

    const openPreviewButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Open Preview");
    assert.ok(openPreviewButton);
    await act(async () => {
      openPreviewButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.equal(previewOpenCount, 1);

    const inlineButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Inline");
    assert.ok(inlineButton);
    await act(async () => inlineButton.click());

    assert.equal(container.querySelector(".session-live-diff-split"), null);
    assert.ok(container.querySelector(".session-file-text-scroll"));
    assert.equal(container.querySelector("button.is-active")?.textContent, "Inline");
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});
