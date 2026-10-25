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
} from "../../src-shared/memory/memory-review-state.js";
import { MEMORY_V6_SCHEMA_VERSION, type MemoryV6ReviewSearchRequest } from "../../src-shared/memory/memory-contract.js";
import type { MemoryFileUsageResponse } from "../../src-shared/memory/memory-response-contract.js";

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
    createdAt: "2026-06-27T00:00:00.000Z",
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// @test-value v2
// kind = "contract"
// claim = "usageの先行失敗は検索とdetail成功で消えず、usage Retryはusageだけを再取得し、再取得失敗でも取得済み容量を保持する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "検索/detail成功がusage errorを消す、Retryが別APIを呼ぶ、またはusage再取得で容量を消す"
// observable = "失敗理由とRetry button、usage容量、API呼出回数"
// observation_boundary = "component-behavior"
// scope = "memory-review-usage-request-isolation"
// lifecycle = "permanent"
// impact = "取得状況の誤認と回復不能を防ぎ、表示済み容量の参照を維持する"
// distinction = "型検査やservice testでは検出できない非同期応答順と画面操作の組合せを確認する"
// @end-test-value
test("MemoryV6ReviewScreen はusage失敗を独立して保持し対象だけRetryする", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://withmate.local/" });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });
  const rootElement = dom.window.document.getElementById("root")!;
  let root: Root | null = null;
  const search = deferred<MemoryV6ReviewSearchResult>();
  const usages = [deferred<MemoryFileUsageResponse>(), deferred<MemoryFileUsageResponse>(), deferred<MemoryFileUsageResponse>()];
  const calls = { search: 0, usage: 0, detail: 0 };
  const api: MemoryV6ReviewApi = {
    searchMemoryV6Entries() { calls.search += 1; return search.promise; },
    getMemoryV6FileUsage() { return usages[calls.usage++]!.promise; },
    async getMemoryV6Entry() { calls.detail += 1; return createDetail("entry-a", "Entry A"); },
    async exportMemoryV6EntryFiles() { return null; },
    async runMemoryV6ProtectedObjectGc() { throw new Error("unused"); },
    async forgetMemoryV6Entry(entryId) { return { entryId, status: "forgotten", reason: "user_request" }; },
  };
  const click = async (selector: string) => {
    const button = rootElement.querySelector<HTMLButtonElement>(selector);
    assert.ok(button);
    await act(async () => { button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  };
  try {
    await act(async () => { root = createRoot(rootElement); root.render(<MemoryV6ReviewScreen homePageClassName="home-page" getApi={() => api} />); });
    await act(async () => { usages[0]!.reject(new Error("Usage unavailable")); });
    assert.match(rootElement.textContent ?? "", /Usage unavailable/);
    await act(async () => { search.resolve({ items: [createHit("entry-a", "Entry A")] }); });
    await click("button.memory-review-item");
    assert.match(rootElement.textContent ?? "", /Entry A body/);
    assert.match(rootElement.textContent ?? "", /Usage unavailable/);
    await click('button[aria-label="Retry Memory file usage"]');
    assert.deepEqual(calls, { search: 1, usage: 2, detail: 1 });
    await act(async () => { usages[1]!.resolve(createUsage()); });
    assert.doesNotMatch(rootElement.textContent ?? "", /Usage unavailable/);
    assert.match(rootElement.querySelector('[aria-label="Memory file usage"]')?.textContent ?? "", /1\.5 KB/);
    await click('button[aria-label="Refresh Memory review"]');
    assert.match(rootElement.querySelector('[aria-label="Memory file usage"]')?.textContent ?? "", /1\.5 KB/);
    await act(async () => { usages[2]!.reject(new Error("Usage refresh failed")); });
    assert.match(rootElement.textContent ?? "", /Usage refresh failed/);
    assert.match(rootElement.querySelector('[aria-label="Memory file usage"]')?.textContent ?? "", /1\.5 KB/);
    assert.match(rootElement.textContent ?? "", /Entry A body/);
  } finally {
    await act(async () => { root?.unmount(); });
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "検索の先行失敗はusage成功で消えず、検索とdetailのRetryは対象APIだけを呼び、同一IDのdetailを再取得中と失敗後にも保持する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "usage成功が検索errorを消す、Retryが別APIを呼ぶ、または同一IDの再取得が表示済み本文を消す"
// observable = "検索/detail失敗理由、Retry button、本文、API呼出回数とentry ID"
// observation_boundary = "component-behavior"
// scope = "memory-review-search-detail-request-isolation"
// lifecycle = "permanent"
// impact = "失敗領域を回復可能に保ち、再取得失敗で閲覧中の本文を失わない"
// distinction = "既存detail切替安全testとは異なり、同一IDの継続表示と独立Retryを非同期応答で確認する"
// @end-test-value
test("MemoryV6ReviewScreen は検索と同一entryの失敗を対象別にRetryする", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://withmate.local/" });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });
  const rootElement = dom.window.document.getElementById("root")!;
  let root: Root | null = null;
  const search = deferred<MemoryV6ReviewSearchResult>();
  const usage = deferred<MemoryFileUsageResponse>();
  const detailRefresh = deferred<MemoryV6ReviewEntryDetail>();
  const calls = { search: 0, usage: 0, detail: [] as string[] };
  const api: MemoryV6ReviewApi = {
    searchMemoryV6Entries() { calls.search += 1; return calls.search === 1 ? search.promise : Promise.resolve({ items: [createHit("entry-a", "Entry A")] }); },
    getMemoryV6FileUsage() { calls.usage += 1; return usage.promise; },
    getMemoryV6Entry(entryId) {
      calls.detail.push(entryId);
      return calls.detail.length === 2 ? detailRefresh.promise : Promise.resolve(createDetail(entryId, "Entry A"));
    },
    async exportMemoryV6EntryFiles() { return null; },
    async runMemoryV6ProtectedObjectGc() { throw new Error("unused"); },
    async forgetMemoryV6Entry(entryId) { return { entryId, status: "forgotten", reason: "user_request" }; },
  };
  const click = async (selector: string) => {
    const button = rootElement.querySelector<HTMLButtonElement>(selector);
    assert.ok(button);
    await act(async () => { button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  };
  try {
    await act(async () => { root = createRoot(rootElement); root.render(<MemoryV6ReviewScreen homePageClassName="home-page" getApi={() => api} />); });
    await act(async () => { search.reject(new Error("Search unavailable")); });
    await act(async () => { usage.resolve(createUsage()); });
    assert.match(rootElement.textContent ?? "", /Search unavailable/);
    await click('button[aria-label="Retry Memory search"]');
    assert.deepEqual(calls, { search: 2, usage: 1, detail: [] });
    assert.doesNotMatch(rootElement.textContent ?? "", /Search unavailable/);
    await click("button.memory-review-item");
    assert.match(rootElement.textContent ?? "", /Entry A body/);
    await click("button.memory-review-item");
    assert.ok(rootElement.querySelector('[role="status"][aria-label="Loading Memory entry"]'));
    assert.match(rootElement.textContent ?? "", /Entry A body/);
    await act(async () => { detailRefresh.reject(new Error("Detail refresh failed")); });
    assert.match(rootElement.textContent ?? "", /Detail refresh failed/);
    assert.match(rootElement.textContent ?? "", /Entry A body/);
    await click('button[aria-label="Retry Memory entry"]');
    assert.deepEqual(calls, { search: 2, usage: 1, detail: ["entry-a", "entry-a", "entry-a"] });
    assert.doesNotMatch(rootElement.textContent ?? "", /Detail refresh failed/);
    assert.match(rootElement.textContent ?? "", /Entry A body/);
  } finally {
    await act(async () => { root?.unmount(); });
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "次pageの検索失敗でも既存一覧を保持し、検索Retryは失敗したcursorで次pageだけをappendする"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "append失敗で一覧を消す、Retryがfirst pageへ戻る、またはusage/detailを再取得する"
// observable = "pending/失敗/Retry後の一覧title、検索cursor、usage/detail呼出回数"
// observation_boundary = "component-behavior"
// scope = "memory-review-pagination-retry"
// lifecycle = "permanent"
// impact = "閲覧済み一覧を維持したまま失敗した次pageへ到達できる"
// distinction = "既存pagination成功testでは検出できない失敗requestのcursor再利用と回復操作を確認する"
// @end-test-value
test("MemoryV6ReviewScreen は失敗したappend cursorをRetryで再利用する", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://withmate.local/" });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });
  const rootElement = dom.window.document.getElementById("root")!;
  let root: Root | null = null;
  const append = deferred<MemoryV6ReviewSearchResult>();
  const retry = deferred<MemoryV6ReviewSearchResult>();
  const requests: MemoryV6ReviewSearchRequest[] = [];
  let usageCalls = 0;
  let detailCalls = 0;
  const api: MemoryV6ReviewApi = {
    searchMemoryV6Entries(request) {
      requests.push(request);
      if (requests.length === 1) return Promise.resolve({ items: [createHit("entry-a", "Entry A")], nextCursor: "cursor-a" });
      return requests.length === 2 ? append.promise : retry.promise;
    },
    async getMemoryV6FileUsage() { usageCalls += 1; return createUsage(); },
    async getMemoryV6Entry() { detailCalls += 1; return null; },
    async exportMemoryV6EntryFiles() { return null; },
    async runMemoryV6ProtectedObjectGc() { throw new Error("unused"); },
    async forgetMemoryV6Entry(entryId) { return { entryId, status: "forgotten", reason: "user_request" }; },
  };
  const click = async (selector: string) => {
    const button = rootElement.querySelector<HTMLButtonElement>(selector);
    assert.ok(button);
    await act(async () => { button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  };
  try {
    await act(async () => { root = createRoot(rootElement); root.render(<MemoryV6ReviewScreen homePageClassName="home-page" getApi={() => api} />); });
    await click("button.memory-review-load-more");
    assert.match(rootElement.querySelector('[aria-label="Memory entries"]')?.textContent ?? "", /Entry A/);
    await act(async () => { append.reject(new Error("Next page failed")); });
    assert.match(rootElement.textContent ?? "", /Next page failed/);
    assert.match(rootElement.querySelector('[aria-label="Memory entries"]')?.textContent ?? "", /Entry A/);
    await click('button[aria-label="Retry Memory search"]');
    assert.deepEqual(requests.map((request) => request.cursor), [undefined, "cursor-a", "cursor-a"]);
    assert.equal(usageCalls, 1);
    assert.equal(detailCalls, 0);
    assert.match(rootElement.querySelector('[aria-label="Memory entries"]')?.textContent ?? "", /Entry A/);
    await act(async () => { retry.resolve({ items: [createHit("entry-b", "Entry B")] }); });
    assert.match(rootElement.querySelector('[aria-label="Memory entries"]')?.textContent ?? "", /Entry A/);
    assert.match(rootElement.querySelector('[aria-label="Memory entries"]')?.textContent ?? "", /Entry B/);
    assert.doesNotMatch(rootElement.textContent ?? "", /Next page failed/);
  } finally {
    await act(async () => { root?.unmount(); });
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Memory ReviewのLoad MoreはnextCursorを使って次pageを既存項目へappendする"
// oracle = { type = "contract", ref = "src/memory-v6/MemoryV6ReviewScreen.tsx: runSearch pagination" }
// fault = "Load Moreがcursorを送らない、既存項目を置き換える、または次pageを表示しない"
// observable = "search requestのcursorとrender後のentry title一覧"
// observation_boundary = "component-behavior"
// scope = "memory-v6-review-pagination-append"
// lifecycle = "permanent"
// @end-test-value
test("MemoryV6ReviewScreen は nextCursor がある場合に LoadMore で次 page を append する", async () => {
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

    const loadMoreButton = rootElement.querySelector<HTMLButtonElement>("button.memory-review-load-more");
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
      Array.from(rootElement.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Load More"),
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

// @test-value v2
// kind = "invariant"
// claim = "Memory Reviewの新しいfilter検索は先行paginationのbusy stateを解除し、新first pageのLoad Moreを通常状態で表示する"
// oracle = { type = "contract", ref = "src/memory-v6/MemoryV6ReviewScreen.tsx: runSearch pagination supersession" }
// fault = "query変更後も古いpagination busyを残し、次の検索結果をLoading moreとして操作不能にする"
// observable = "query変更後のLoad More label、busy stateと検索requestのcursor"
// observation_boundary = "component-behavior"
// scope = "memory-v6-review-pagination-supersession"
// lifecycle = "permanent"
// @end-test-value
test("MemoryV6ReviewScreen はfilter変更時に古いpagination busyを解除する", async () => {
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
  let resolveAppend: ((result: MemoryV6ReviewSearchResult) => void) | undefined;
  const requests: MemoryV6ReviewSearchRequest[] = [];

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
      if (request.cursor === "cursor-1") {
        return new Promise<MemoryV6ReviewSearchResult>((resolve) => {
          resolveAppend = resolve;
        });
      }
      if (request.kinds?.[0] === "decision") {
        return { items: [createHit("entry-new", "New search result")], nextCursor: "cursor-new" };
      }
      return { items: [createHit("entry-first", "First search result")], nextCursor: "cursor-1" };
    },
    async getMemoryV6Entry() {
      return null;
    },
    async forgetMemoryV6Entry() {
      return { entryId: "entry-first", status: "forgotten", reason: "user_request" };
    },
  };

  try {
    await act(async () => {
      root = createRoot(rootElement);
      root.render(<MemoryV6ReviewScreen homePageClassName="home-page" getApi={() => api} />);
    });
    await flushEffects();

    const loadMoreButton = rootElement.querySelector<HTMLButtonElement>("button.memory-review-load-more");
    assert.ok(loadMoreButton);
    await act(async () => {
      loadMoreButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(requests.at(-1)?.cursor, "cursor-1");
    assert.equal(rootElement.querySelector<HTMLButtonElement>("button.memory-review-load-more")?.getAttribute("aria-busy"), "true");
    assert.ok(rootElement.querySelector("button.memory-review-load-more .button-content-spinner[aria-hidden='true']"));

    const kindSelect = rootElement.querySelector<HTMLSelectElement>("select");
    assert.ok(kindSelect);
    await act(async () => {
      kindSelect.value = "decision";
      kindSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await flushEffects();

    assert.deepEqual(requests.at(-1)?.kinds, ["decision"]);
    assert.equal(rootElement.querySelector<HTMLButtonElement>("button.memory-review-load-more")?.textContent?.trim(), "Load More");
    assert.equal(rootElement.querySelector<HTMLButtonElement>("button.memory-review-load-more")?.getAttribute("aria-busy"), null);

    resolveAppend?.({ items: [createHit("entry-old-page", "Old page")] });
    await flushEffects();
  } finally {
    await act(async () => {
      root?.unmount();
    });
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Memory Reviewのentry detailはprotected fileのdisplay name、role、media kind、容量、summaryを表示する"
// oracle = { type = "contract", ref = "docs/design/v6-memory-protected-objects.md#ui-policy" }
// fault = "protected fileの表示情報を欠落させ、entryの添付内容を判断できなくする"
// observable = "detailのtextContentに含まれるdisplay name、role、media kind、容量、summary"
// observation_boundary = "component-behavior"
// scope = "memory-v6-review-file-summary"
// lifecycle = "permanent"
// distinction = "Main review service testは内部field除去を担い、このtestはsanitized summaryの利用者向け表示を確認する"
// @end-test-value
test("MemoryV6ReviewScreen はentry detailのprotected file summaryを表示する", async () => {
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
    assert.match(text, /Protected Files/);
    assert.match(text, /dialog\.png/);
    assert.match(text, /evidence \/ image \/ 1\.5 KB/);
    assert.match(text, /エラー状態を確認できるスクリーンショット。/);
  } finally {
    await act(async () => {
      root?.unmount();
    });
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Memory Reviewのfile usageとlargest entry候補は表示され、候補clickは対応するentry detailを開く"
// oracle = { type = "contract", ref = "src/memory-v6/MemoryV6ReviewScreen.tsx: fileUsage and selectEntry" }
// fault = "usage summaryまたはlargest entry候補が欠落する、または候補clickが別entryを選択する"
// observable = "usageのtextContent、largest entry title、getMemoryV6Entryへ渡したentry ID"
// observation_boundary = "component-behavior"
// scope = "memory-v6-review-file-usage"
// lifecycle = "permanent"
// @end-test-value
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
    assert.match(text, /Pending Delete/);
    assert.match(text, /Largest Entries/);
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

// @test-value v2
// kind = "contract"
// claim = "Memory ReviewのExport Files操作は選択中entry IDをexport APIへ渡し、export件数をfeedbackに表示する"
// oracle = { type = "contract", ref = "docs/design/v6-memory-protected-objects.md#cli-policy" }
// fault = "export対象のentry IDを取り違える、export操作が実行されない、または返却された件数を表示しない"
// observable = "export APIへ渡したentry IDとfeedbackのexport件数"
// observation_boundary = "component-behavior"
// scope = "memory-v6-review-file-export"
// lifecycle = "permanent"
// distinction = "Main review service testがoutput pathとobject metadataのresponse除去を担い、このtestはsanitized export結果の表示と操作対象を確認する"
// @end-test-value
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

    const exportButton = rootElement.querySelector<HTMLButtonElement>('button[aria-label="Export Memory files"]');
    assert.ok(exportButton);

    await act(async () => {
      exportButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    assert.deepEqual(exportedEntryIds, ["entry-export"]);
    const text = rootElement.textContent ?? "";
    assert.match(text, /1 files exported\./);
  } finally {
    await act(async () => {
      root?.unmount();
    });
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
  }
});

// @test-value v2
// kind = "security"
// claim = "Memory Reviewでdetail選択を切り替える間は旧detailとforget/export操作を消し、遅延または失敗した新entryを旧対象として操作できない"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md#current-scope" }
// fault = "selectedEntryIdだけを先に更新して旧detailを表示し、旧本文に対する操作を新entry IDへ送る"
// observable = "切替中のLoading表示、旧本文とForget/Export buttonの不在、失敗feedback、forget/export API call数"
// observation_boundary = "component-behavior"
// scope = "memory-v6-review-detail-selection-safety"
// lifecycle = "permanent"
// @end-test-value
test("MemoryV6ReviewScreen は遅延または失敗したdetail選択で旧entryを操作対象にしない", async () => {
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
  let rejectB: ((error: Error) => void) | undefined;
  const forgetRequests: string[] = [];
  const exportRequests: string[] = [];
  const detailA = createDetail("entry-a", "Entry A", {
    files: [{
      role: "artifact",
      mediaKind: "text",
      contentType: "text/plain",
      displayName: "entry-a.txt",
      summary: "Entry A file",
      originalBytes: 12,
    }],
  });

  const api: MemoryV6ReviewApi = {
    async getMemoryV6FileUsage() {
      return createUsage();
    },
    async exportMemoryV6EntryFiles(entryId) {
      exportRequests.push(entryId);
      return null;
    },
    async runMemoryV6ProtectedObjectGc() {
      throw new Error("unused");
    },
    async searchMemoryV6Entries() {
      return { items: [createHit("entry-a", "Entry A"), createHit("entry-b", "Entry B")] };
    },
    async getMemoryV6Entry(entryId) {
      if (entryId === "entry-a") {
        return detailA;
      }
      return new Promise<MemoryV6ReviewEntryDetail>((_resolve, reject) => {
        rejectB = reject;
      });
    },
    async forgetMemoryV6Entry(entryId) {
      forgetRequests.push(entryId);
      return { entryId, status: "forgotten", reason: "user_request" };
    },
  };

  try {
    await act(async () => {
      root = createRoot(rootElement);
      root.render(<MemoryV6ReviewScreen homePageClassName="home-page" getApi={() => api} />);
    });
    await flushEffects();

    const entryAButton = Array.from(rootElement.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Entry A")
    );
    const entryBButton = Array.from(rootElement.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Entry B")
    );
    assert.ok(entryAButton);
    assert.ok(entryBButton);

    await act(async () => {
      entryAButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();
    assert.match(rootElement.textContent ?? "", /Entry A body/);
    assert.ok(rootElement.querySelector('button[aria-label="Export Memory files"]'));

    await act(async () => {
      entryBButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    let text = rootElement.textContent ?? "";
    assert.doesNotMatch(text, /Entry A body/);
    assert.ok(rootElement.querySelector('[role="status"][aria-label="Loading Memory entry"]'));
    assert.equal(Array.from(rootElement.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Forget Entry"), false);
    assert.equal(rootElement.querySelector('button[aria-label="Export Memory files"]'), null);

    rejectB?.(new Error("Entry B failed"));
    await flushEffects();
    text = rootElement.textContent ?? "";
    assert.match(text, /Entry B failed/);
    assert.doesNotMatch(text, /Entry A body/);
    assert.equal(Array.from(rootElement.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Forget Entry"), false);
    assert.equal(rootElement.querySelector('button[aria-label="Export Memory files"]'), null);
    assert.deepEqual(forgetRequests, []);
    assert.deepEqual(exportRequests, []);
  } finally {
    await act(async () => {
      root?.unmount();
    });
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
  }
});

// @test-value v2
// kind = "security"
// claim = "Memory ReviewのGC Dry Run操作はdryRun要求を送り、pending・orphan・missing activeの件数をvisible reportで示す"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md" }
// fault = "GC Dry RunからdryRun=falseを要求するか、操作の対象件数とmissing状態を隠す"
// observable = "GC requestのdryRun、visible report labels/counts"
// observation_boundary = "component-behavior"
// scope = "memory-v6-review-protected-object-gc"
// lifecycle = "permanent"
// distinction = "Main review service testが実削除の不在を担い、このtestはdry-run選択とsummary report表示を確認する"
// @end-test-value
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
      button.textContent?.trim() === "GC Dry Run"
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
    assert.match(text, /Pending 2 \/ deleted 0 \/ missing 1 \/ failed 0/);
    assert.match(text, /Orphan 1 \/ deleted 0 \/ failed 0/);
    assert.match(text, /Missing active 1/);
  } finally {
    await act(async () => {
      root?.unmount();
    });
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
  }
});
