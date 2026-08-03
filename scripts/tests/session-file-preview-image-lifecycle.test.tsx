import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { SessionDiffPreview, SessionFilePreview } from "../../src/file-explorer/SessionFilePreview.js";
import type {
  SessionFileDescriptor,
  SessionFileResourceRequest,
} from "../../src/file-explorer/file-explorer-contract.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PreviewApi = NonNullable<React.ComponentProps<typeof SessionFilePreview>["api"]>;

const DEFAULT_IMAGE_COPY_API: Pick<
  PreviewApi,
  "copySessionFilePreviewImage" | "showSessionFilePreviewImageContextMenu"
> = {
  async copySessionFilePreviewImage() {
    return { status: "copied" };
  },
  async showSessionFilePreviewImageContextMenu() {
    return { status: "dismissed" };
  },
};

const MARKDOWN_REQUEST: SessionFileResourceRequest = {
  sessionId: "session-1",
  rootId: "workspace",
  relativePath: "docs/readme.md",
};
const MARKDOWN_BYTES = new TextEncoder().encode("![sample](./image.png)");
const IMAGE_BYTES = Uint8Array.of(137, 80, 78, 71);

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
      if (request.relativePath === MARKDOWN_REQUEST.relativePath) {
        return MARKDOWN_DESCRIPTOR;
      }
      imageInspectCount += 1;
      return inspectImage(imageInspectCount);
    },
    async readSessionFileChunk(request) {
      const source = request.relativePath === MARKDOWN_REQUEST.relativePath
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
      return { status: "opened", targetType: "local-path", target: request.relativePath };
    },
    async openPath(target) {
      return { status: "opened", targetType: "local-path", target };
    },
  };
  return { api, getImageInspectCount: () => imageInspectCount };
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
      onClose() {},
      onCopyText() {},
      ...extraProps,
    }));
  });
  return root;
}

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

test("encoding 切替は実行中の同一 local image も現行 generation へ再登録する", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  let resolveFirstInspect: ((descriptor: SessionFileDescriptor) => void) | null = null;
  const firstInspect = new Promise<SessionFileDescriptor>((resolve) => {
    resolveFirstInspect = resolve;
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
    resolveFirstInspect?.(IMAGE_DESCRIPTOR);
    await waitFor(() => container.querySelector("img")?.getAttribute("src")?.startsWith("blob:") ?? false);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

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
      return { status: "opened", targetType: "local-path", target: request.relativePath };
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

test("寸法情報のないSVGは初回だけFitで表示する", async () => {
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
  const bytes = new TextEncoder().encode("<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0 0\"/></svg>");
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
      return { status: "opened", targetType: "local-path", target: openRequest.relativePath };
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
    assert.match(container.textContent ?? "", /Image copied\./);

    const contextMenuEvent = new dom.window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 44,
      clientY: 55,
    });
    await act(async () => image.dispatchEvent(contextMenuEvent));
    await waitFor(() => contextMenuRequests.length === 1);
    assert.equal(contextMenuEvent.defaultPrevented, true);
    assert.deepEqual(contextMenuRequests, [{
      sessionId: "session-1",
      point: { x: 44, y: 55 },
    }]);
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

test("Fitは実効倍率を表示しZoom Inの基準にする", async () => {
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
      container.querySelector<HTMLButtonElement>("button[aria-label='Fit image to preview']")?.click();
    });
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
        name: inspectRequest.relativePath,
        kind: "text",
        byteLength: bytes.byteLength,
        modifiedAt: "2026-08-02T00:00:00.000Z",
        mimeType: "text/plain",
        suggestedEncoding: "utf-8",
        revision: `${inspectRequest.relativePath}-r1`,
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
        onClose() {},
        onCopyText() {},
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
      openResult.resolve({ status: "failed", message: "first open failed" });
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
      return { status: "failed", message: `Open failed ${openCount}` };
    },
  };
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  const render = async (diffAvailabilityMessage: string) => {
    await act(async () => {
      root?.render(React.createElement(SessionFilePreview, {
        api,
        request: MARKDOWN_REQUEST,
        onClose() {},
        onCopyText() {},
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
        onClose() {},
        onCopyText() {},
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

test("Git Diff検索はReloadで一致件数が減っても現在位置を有効範囲へ収める", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  const render = async (patch: string, previewRevision: number) => {
    await act(async () => {
      root?.render(React.createElement(SessionDiffPreview, {
        title: "same.txt · Working Tree",
        previewRevision,
        patch,
        onClose() {},
        onCopyText() {},
      }));
    });
  };

  try {
    assert.ok(container);
    root = createRoot(container);
    await render("needle needle\n", 1);
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

    await render("needle\n", 2);
    assert.equal(container.querySelector(".session-content-find-count")?.textContent, "1/1");
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});
