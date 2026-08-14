import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { DEFAULT_CHARACTER_THEME_COLORS } from "../../src/character-state.js";
import DiffApp from "../../src/DiffApp.js";
import FilePreviewApp from "../../src/FilePreviewApp.js";
import {
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
