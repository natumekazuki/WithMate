import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { DEFAULT_CHARACTER_THEME_COLORS } from "../../src/character-state.js";
import DiffApp from "../../src/DiffApp.js";
import FilePreviewApp from "../../src/FilePreviewApp.js";
import {
  buildFileRootDiffPreviewWindowRequest,
  FILE_PREVIEW_WINDOW_TITLE_FALLBACK,
  resolveSessionFilePreviewWindowTitle,
  type SessionFileDescriptor,
} from "../../src/file-explorer/file-explorer-contract.js";
import type { WithMateWindowApi } from "../../src/withmate-window-api.js";

test("resolveSessionFilePreviewWindowTitle は basename だけを返し不正な名前を fallback する", () => {
  assert.equal(resolveSessionFilePreviewWindowTitle("C:\\Users\\private\\notes.md"), "notes.md");
  assert.equal(resolveSessionFilePreviewWindowTitle("/home/private/notes.md"), "notes.md");
  assert.equal(resolveSessionFilePreviewWindowTitle(""), FILE_PREVIEW_WINDOW_TITLE_FALLBACK);
  assert.equal(resolveSessionFilePreviewWindowTitle(".."), FILE_PREVIEW_WINDOW_TITLE_FALLBACK);
  assert.equal(resolveSessionFilePreviewWindowTitle("unsafe\nname.md"), FILE_PREVIEW_WINDOW_TITLE_FALLBACK);
});

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
    assert.equal(dom.window.document.querySelector(".back-navigation-button"), null);
    assert.equal(
      [...dom.window.document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Close"),
      false,
    );
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
    assert.equal(loadingPreview.querySelector("[role='status']")?.textContent, "Loading Git diff");
    assert.ok(loadingPreview.querySelector(".session-file-preview-spinner[aria-hidden='true']"));
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

test("DiffApp は独立 Window に app 内 Close を表示しない", async () => {
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
    assert.equal(
      [...dom.window.document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Close"),
      false,
    );
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
