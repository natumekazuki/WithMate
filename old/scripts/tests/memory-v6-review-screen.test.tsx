import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MemoryV6ReviewScreen } from "../../src/memory-v6/MemoryV6ReviewScreen.js";
import type {
  MemoryV6ReviewApi,
  MemoryV6ReviewEntryDetail,
  MemoryV6ReviewSearchHit,
  MemoryV6ReviewSearchResult,
} from "../../src/memory-v6/memory-review-state.js";
import { MEMORY_V6_SCHEMA_VERSION, type MemoryV6ReviewSearchRequest } from "../../src/memory-v6/memory-contract.js";
import type { MemoryFileUsageResponse } from "../../src/memory-v6/memory-response-contract.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createHit(id: string, title: string): MemoryV6ReviewSearchHit {
  return {
    id,
    kind: "note",
    title,
    preview: `${title} preview`,
    owner: { type: "project", id: "WithMate" },
    scope: { type: "project", id: "WithMate" },
    tags: [],
    sourceSessionId: null,
    sourceProviderId: "codex",
    updatedAt: "2026-06-27T00:00:00.000Z",
  };
}

function createDetail(id: string, title: string, overrides: Partial<MemoryV6ReviewEntryDetail> = {}): MemoryV6ReviewEntryDetail {
  return {
    ...createHit(id, title),
    state: "active",
    body: `${title} body`,
    source: { type: "agent", sessionId: null, messageId: "message-a", providerId: "codex" },
    supersedes: [],
    supersededBy: null,
    forgottenAt: null,
    createdAt: "2026-06-27T00:00:00.000Z",
    ...overrides,
  };
}

function createUsage(overrides: Partial<MemoryFileUsageResponse> = {}): MemoryFileUsageResponse {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    quotaBytes: 4096,
    usedBytes: 1536,
    physicalBytes: 1600,
    pendingDeleteBytes: 256,
    availableBytes: 2560,
    objectCount: 2,
    pendingDeleteCount: 1,
    quotaExceeded: false,
    ...overrides,
  };
}

async function flushEffects() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

test("MemoryV6ReviewScreen は nextCursor がある場合に Load more で次 page を append する", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "https://withmate.local/?mode=memory-review",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;

  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });

  const rootElement = dom.window.document.getElementById("root");
  assert.ok(rootElement);
  let root: Root | null = null;
  const requests: MemoryV6ReviewSearchRequest[] = [];
  const pages: MemoryV6ReviewSearchResult[] = [
    { items: [createHit("entry-1", "First entry")], nextCursor: "cursor-1" },
    { items: [createHit("entry-2", "Second entry")] },
  ];

  const api: MemoryV6ReviewApi = {
    async getMemoryV6FileUsage() {
      return createUsage();
    },
    async exportMemoryV6EntryFiles() {
      return null;
    },
    async runMemoryV6ProtectedObjectGc() {
      throw new Error("unused");
    },
    async searchMemoryV6Entries(request) {
      requests.push(request);
      return pages.shift() ?? { items: [] };
    },
    async getMemoryV6Entry() {
      return null;
    },
    async forgetMemoryV6Entry() {
      return { entryId: "entry-1", status: "forgotten", reason: "user_request" };
    },
  };

  try {
    await act(async () => {
      root = createRoot(rootElement);
      root.render(<MemoryV6ReviewScreen homePageClassName="home-page" getApi={() => api} />);
    });
    await flushEffects();

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.cursor, undefined);
    assert.match(rootElement.textContent ?? "", /First entry/);
    assert.doesNotMatch(rootElement.textContent ?? "", /Second entry/);

    const loadMoreButton = Array.from(rootElement.querySelectorAll("button")).find((button) =>
      button.textContent?.trim() === "Load more"
    );
    assert.ok(loadMoreButton);

    await act(async () => {
      loadMoreButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.cursor, "cursor-1");
    assert.match(rootElement.textContent ?? "", /First entry/);
    assert.match(rootElement.textContent ?? "", /Second entry/);
    assert.equal(
      Array.from(rootElement.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Load more"),
      false,
    );
  } finally {
    await act(async () => {
      root?.unmount();
    });
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
  }
});

test("MemoryV6ReviewScreen はentry detailのfile summaryを表示し、内部IDやpathは表示しない", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "https://withmate.local/?mode=memory-review",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;

  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });

  const rootElement = dom.window.document.getElementById("root");
  assert.ok(rootElement);
  let root: Root | null = null;
  const detail = createDetail("entry-with-file", "Entry with file", {
    files: [{
      role: "evidence",
      mediaKind: "image",
      contentType: "image/png",
      displayName: "dialog.png",
      summary: "エラー状態を確認できるスクリーンショット。",
      originalBytes: 1536,
    }],
  });

  const api: MemoryV6ReviewApi = {
    async getMemoryV6FileUsage() {
      return createUsage();
    },
    async exportMemoryV6EntryFiles() {
      return null;
    },
    async runMemoryV6ProtectedObjectGc() {
      throw new Error("unused");
    },
    async searchMemoryV6Entries() {
      return { items: [createHit("entry-with-file", "Entry with file")] };
    },
    async getMemoryV6Entry() {
      return detail;
    },
    async forgetMemoryV6Entry() {
      return { entryId: "entry-with-file", status: "forgotten", reason: "user_request" };
    },
  };

  try {
    await act(async () => {
      root = createRoot(rootElement);
      root.render(<MemoryV6ReviewScreen homePageClassName="home-page" getApi={() => api} />);
    });
    await flushEffects();

    const entryButton = Array.from(rootElement.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Entry with file")
    );
    assert.ok(entryButton);

    await act(async () => {
      entryButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    const text = rootElement.textContent ?? "";
    assert.match(text, /Protected files/);
    assert.match(text, /dialog\.png/);
    assert.match(text, /evidence \/ image \/ 1\.5 KB/);
    assert.match(text, /エラー状態を確認できるスクリーンショット。/);
    assert.doesNotMatch(text, /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
    assert.doesNotMatch(text, /C:\\/);
    assert.doesNotMatch(text, /memory-objects/);
  } finally {
    await act(async () => {
      root?.unmount();
    });
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
  }
});

test("MemoryV6ReviewScreen はfile usageとlargest entriesを表示し、候補clickでdetailを開く", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "https://withmate.local/?mode=memory-review",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;

  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });

  const rootElement = dom.window.document.getElementById("root");
  assert.ok(rootElement);
  let root: Root | null = null;
  const selectedEntryIds: string[] = [];

  const api: MemoryV6ReviewApi = {
    async getMemoryV6FileUsage() {
      return createUsage({
        largestEntries: [{
          entryId: "entry-large",
          title: "Large memory",
          preview: "Large preview",
          totalFileBytes: 1536,
          fileCount: 2,
          updatedAt: "2026-06-27T00:00:00.000Z",
        }],
      });
    },
    async exportMemoryV6EntryFiles() {
      return null;
    },
    async runMemoryV6ProtectedObjectGc() {
      throw new Error("unused");
    },
    async searchMemoryV6Entries() {
      return { items: [] };
    },
    async getMemoryV6Entry(entryId) {
      selectedEntryIds.push(entryId);
      return createDetail(entryId, "Large memory");
    },
    async forgetMemoryV6Entry() {
      return { entryId: "entry-large", status: "forgotten", reason: "user_request" };
    },
  };

  try {
    await act(async () => {
      root = createRoot(rootElement);
      root.render(<MemoryV6ReviewScreen homePageClassName="home-page" getApi={() => api} />);
    });
    await flushEffects();

    let text = rootElement.textContent ?? "";
    assert.match(text, /Used/);
    assert.match(text, /1\.5 KB/);
    assert.match(text, /38% of 4\.0 KB/);
    assert.match(text, /Pending delete/);
    assert.match(text, /Largest entries/);
    assert.match(text, /Large memory/);

    const largestButton = Array.from(rootElement.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Large memory")
    );
    assert.ok(largestButton);

    await act(async () => {
      largestButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    assert.deepEqual(selectedEntryIds, ["entry-large"]);
    text = rootElement.textContent ?? "";
    assert.match(text, /Large memory body/);
  } finally {
    await act(async () => {
      root?.unmount();
    });
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
  }
});

test("MemoryV6ReviewScreen はentry detailからprotected filesをexportできる", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "https://withmate.local/?mode=memory-review",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;

  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });

  const rootElement = dom.window.document.getElementById("root");
  assert.ok(rootElement);
  let root: Root | null = null;
  const exportedEntryIds: string[] = [];
  const detail = createDetail("entry-export", "Entry export", {
    files: [{
      role: "artifact",
      mediaKind: "text",
      contentType: "text/plain",
      displayName: "note.txt",
      summary: "exportable text file",
      originalBytes: 512,
    }],
  });

  const api: MemoryV6ReviewApi = {
    async getMemoryV6FileUsage() {
      return createUsage();
    },
    async exportMemoryV6EntryFiles(entryId) {
      exportedEntryIds.push(entryId);
      return {
        entryId,
        exportedCount: 1,
      };
    },
    async runMemoryV6ProtectedObjectGc() {
      throw new Error("unused");
    },
    async searchMemoryV6Entries() {
      return { items: [createHit("entry-export", "Entry export")] };
    },
    async getMemoryV6Entry() {
      return detail;
    },
    async forgetMemoryV6Entry() {
      return { entryId: "entry-export", status: "forgotten", reason: "user_request" };
    },
  };

  try {
    await act(async () => {
      root = createRoot(rootElement);
      root.render(<MemoryV6ReviewScreen homePageClassName="home-page" getApi={() => api} />);
    });
    await flushEffects();

    const entryButton = Array.from(rootElement.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Entry export")
    );
    assert.ok(entryButton);

    await act(async () => {
      entryButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    const exportButton = Array.from(rootElement.querySelectorAll("button")).find((button) =>
      button.textContent?.trim() === "Export files"
    );
    assert.ok(exportButton);

    await act(async () => {
      exportButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    assert.deepEqual(exportedEntryIds, ["entry-export"]);
    const text = rootElement.textContent ?? "";
    assert.match(text, /1 files exported\./);
    assert.doesNotMatch(text, /bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/);
    assert.doesNotMatch(text, /C:\/export/);
    assert.doesNotMatch(text, /key/);
    assert.doesNotMatch(text, /sha256/);
  } finally {
    await act(async () => {
      root?.unmount();
    });
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
  }
});

test("MemoryV6ReviewScreen はprotected object GC dry-run reportを表示する", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "https://withmate.local/?mode=memory-review",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;

  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });

  const rootElement = dom.window.document.getElementById("root");
  assert.ok(rootElement);
  let root: Root | null = null;
  const gcRequests: Array<{ dryRun: boolean }> = [];

  const api: MemoryV6ReviewApi = {
    async getMemoryV6FileUsage() {
      return createUsage();
    },
    async exportMemoryV6EntryFiles() {
      return null;
    },
    async runMemoryV6ProtectedObjectGc(request) {
      gcRequests.push(request);
      return {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        dryRun: request.dryRun,
        deletePending: { candidates: 2, bytes: 640, deleted: 0, missing: 1, failed: 0 },
        orphanFiles: { candidates: 1, bytes: 128, deleted: 0, failed: 0 },
        stagingFiles: { candidates: 1, deleted: 0, failed: 0 },
        missingActiveObjects: 1,
        fileUsage: createUsage(),
        warnings: [],
      };
    },
    async searchMemoryV6Entries() {
      return { items: [] };
    },
    async getMemoryV6Entry() {
      return null;
    },
    async forgetMemoryV6Entry() {
      return { entryId: "entry-gc", status: "forgotten", reason: "user_request" };
    },
  };

  try {
    await act(async () => {
      root = createRoot(rootElement);
      root.render(<MemoryV6ReviewScreen homePageClassName="home-page" getApi={() => api} />);
    });
    await flushEffects();

    const dryRunButton = Array.from(rootElement.querySelectorAll("button")).find((button) =>
      button.textContent?.trim() === "GC dry-run"
    );
    assert.ok(dryRunButton);

    await act(async () => {
      dryRunButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    assert.equal(gcRequests.length, 1);
    assert.equal(gcRequests[0]?.dryRun, true);
    const text = rootElement.textContent ?? "";
    assert.match(text, /Memory file GC dry-run completed\./);
    assert.match(text, /pending 2 \/ deleted 0 \/ missing 1 \/ failed 0/);
    assert.match(text, /orphan 1 \/ deleted 0 \/ failed 0/);
    assert.match(text, /missing active 1/);
    assert.doesNotMatch(text, /11111111111111111111111111111111/);
    assert.doesNotMatch(text, /memory-objects/);
    assert.doesNotMatch(text, /key/);
    assert.doesNotMatch(text, /sha256/);
  } finally {
    await act(async () => {
      root?.unmount();
    });
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
  }
});
