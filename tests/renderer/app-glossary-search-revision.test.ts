import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useSessionGlossary, type SessionGlossarySelection } from "../../src/glossary/use-session-glossary.js";
import { SessionGlossaryPane } from "../../src/glossary/SessionGlossaryPane.js";
import type { SessionGlossaryProjection } from "../../src-shared/glossary/glossary-contract.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

type GlossaryApi = Pick<WithMateWindowApi, "getSessionGlossaryProjection" | "searchSessionGlossary" | "subscribeSessionGlossary">;

function projection(revision: string): SessionGlossaryProjection {
  return {
    sessionId: "session-1",
    scopeRevision: "scope-1",
    sequence: Number(revision),
    checkout: { repositoryName: "Repository", branch: "main", pathLabel: "workspace" },
    state: {
      status: "valid",
      relativePath: ".withmate/glossary.yaml",
      revision,
      entries: [{ term: "Old", aliases: [], definition: "Old definition" }],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

function setup(api: GlossaryApi) {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://withmate.test" });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  let current: ReturnType<typeof useSessionGlossary> | null = null;
  let selection: SessionGlossarySelection = {
    id: "session-1",
    revision: "session-revision-1",
    workspaceLabel: "workspace",
    branch: "main",
  };
  function Probe() {
    current = useSessionGlossary({ api, selectedSession: selection, onActivatePane: () => undefined });
    return React.createElement(SessionGlossaryPane, current.paneProps);
  }
  const root: Root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
  return {
    document: dom.window.document,
    get current() { return current as ReturnType<typeof useSessionGlossary>; },
    async render(sessionId?: string) {
      if (sessionId) selection = { ...selection, id: sessionId };
      await act(async () => { root.render(React.createElement(Probe)); });
    },
    async unmount() { await act(async () => { root.unmount(); }); Object.assign(globalThis, { window: previousWindow, document: previousDocument }); dom.window.close(); },
  };
}

// @test-value v2
// kind = "contract"
// claim = "Glossary検索はquery変更時に前queryの結果を公開せず、旧revisionの遅延responseを破棄して新revisionのresponseだけを公開viewへ反映する"
// oracle = { type = "contract", ref = "SessionGlossaryProjection.state.revision and searchSessionGlossary result revision" }
// fault = "別queryの検索結果を表示する、旧responseを新revisionへ混入させる、または新responseを公開しない"
// observable = "useSessionGlossary view.searchEntries, view.searchLoading, view.searchTotal"
// observation_boundary = "component-behavior"
// scope = "session-glossary-search-revision"
// lifecycle = "permanent"
// distinction = "source文字列ではなく、projection購読と遅延検索responseを通した公開viewのstale guardを検証する"
// @end-test-value
test("Glossary検索は別queryの結果と旧revisionの遅延応答を混ぜない", async () => {
  let notify!: (next: SessionGlossaryProjection) => void;
  const initial = deferred<SessionGlossaryProjection>();
  const oldSearch = deferred<Awaited<ReturnType<GlossaryApi["searchSessionGlossary"]>>>();
  const staleSearch = deferred<Awaited<ReturnType<GlossaryApi["searchSessionGlossary"]>>>();
  const newSearch = deferred<Awaited<ReturnType<GlossaryApi["searchSessionGlossary"]>>>();
  let searchCount = 0;
  const api: GlossaryApi = {
    getSessionGlossaryProjection: async () => initial.promise,
    subscribeSessionGlossary: (listener) => { notify = listener; return () => undefined; },
    searchSessionGlossary: async (_sessionId, request) => {
      searchCount += 1;
      if (request.query === "old") return oldSearch.promise;
      return searchCount === 2 ? staleSearch.promise : newSearch.promise;
    },
  };
  const view = setup(api);
  try {
    await view.render();
    await act(async () => { initial.resolve(projection("1")); await initial.promise; });
    assert.equal(view.current.view.searchTotal, 0);
    await act(async () => { view.current.actions.onSearchQueryChange("old"); });
    await act(async () => {
      oldSearch.resolve({ ok: true, revision: "1", entries: [{ term: "Old", aliases: [], definition: "old" }], total: 1, offset: 0, pageSize: 100 });
      await oldSearch.promise;
    });
    assert.deepEqual(view.current.view.searchEntries.map((entry) => entry.term), ["Old"]);

    await act(async () => { view.current.actions.onSearchQueryChange("term"); });
    await act(async () => { notify(projection("2")); });
    assert.deepEqual(view.current.view.searchEntries, []);
    assert.equal(view.current.view.searchLoading, true);

    await act(async () => {
      staleSearch.resolve({ ok: true, revision: "1", entries: [{ term: "Stale", aliases: [], definition: "stale" }], total: 1, offset: 0, pageSize: 100 });
      await staleSearch.promise;
    });
    assert.deepEqual(view.current.view.searchEntries, []);

    await act(async () => {
      newSearch.resolve({ ok: true, revision: "2", entries: [{ term: "New", aliases: [], definition: "new" }], total: 1, offset: 0, pageSize: 100 });
      await newSearch.promise;
    });
    assert.deepEqual(view.current.view.searchEntries, [{ term: "New", aliases: [], definition: "new" }]);
    assert.equal(view.current.view.searchTotal, 1);
  } finally {
    await view.unmount();
  }
});

// @test-value v2
// kind = "contract"
// claim = "内容不変通知はmatcherとactivation identityを維持し、revision変更・invalid化・scope/Session切替は現在値で再投影とactivationを判定する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md#repository-glossary-annotation" }
// fault = "sequenceや表示通知でmatcherを再compileする、または旧scopeのcallbackで現在の用語を開く"
// observable = "hookのmatcher/callback identity、range definitionと選択用語"
// observation_boundary = "component-behavior"
// scope = "session glossary content ownership and stale activation"
// lifecycle = "permanent"
// distinction = "検索revision testとは異なる、会話注釈用の公開matcherとactivationを購読通知とSession切替から検証する"
// @end-test-value
test("注釈matcherは内容とownerへ結び付きactivationは現在のscopeを確認する", async () => {
  let notify!: (next: SessionGlossaryProjection) => void;
  const api: GlossaryApi = {
    getSessionGlossaryProjection: async (sessionId) => ({ ...projection("1"), sessionId }),
    subscribeSessionGlossary: (listener) => { notify = listener; return () => undefined; },
    searchSessionGlossary: async () => ({ ok: true, revision: "1", entries: [], total: 0, offset: 0, pageSize: 100 }),
  };
  const view = setup(api);
  try {
    await view.render();
    const first = view.current.annotationMatcher!;
    const activate = view.current.actions.onActivateGlossaryEntry;
    await act(async () => {
      notify({ ...projection("1"), sequence: 2, checkout: { repositoryName: "Renamed", branch: "feature", pathLabel: "label" } });
    });
    assert.equal(view.current.annotationMatcher, first);
    assert.equal(view.current.actions.onActivateGlossaryEntry, activate);
    const changed = projection("1");
    changed.sequence = 3;
    changed.state = { status: "valid", relativePath: ".withmate/glossary.yaml", revision: "new", entries: [{ term: "New", aliases: ["Old"], definition: "new definition" }] };
    await act(async () => notify(changed));
    assert.notEqual(view.current.annotationMatcher, first);
    assert.equal(view.current.annotationMatcher!.matchText("Old", view.current.annotationMatcher!.createMessageBudget())[0]?.definition, "new definition");
    await act(async () => activate("Old"));
    assert.equal(view.current.view.selectedTerm, null);
    await act(async () => activate("New"));
    assert.equal(view.current.view.selectedTerm, "New");
    await act(async () => notify({ ...changed, sequence: 4, state: { status: "missing", relativePath: ".withmate/glossary.yaml", revision: null } }));
    assert.equal(view.current.annotationMatcher, undefined);
    await act(async () => view.current.actions.onBackToList());
    await act(async () => activate("New"));
    assert.equal(view.current.view.selectedTerm, null);
    await act(async () => notify({ ...changed, sequence: 5, scopeRevision: "other-scope" }));
    await act(async () => activate("New"));
    assert.equal(view.current.view.selectedTerm, null);
    await act(async () => view.current.actions.onActivateGlossaryEntry("New"));
    assert.equal(view.current.view.selectedTerm, "New");
    const oldScopeActivate = view.current.actions.onActivateGlossaryEntry;
    await view.render("session-2");
    await act(async () => oldScopeActivate("Old"));
    assert.equal(view.current.view.selectedTerm, null);
  } finally {
    await view.unmount();
  }
});

// @test-value v2
// kind = "contract"
// claim = "初回取得失敗は必要時に理由を開閉でき、同じ会話でRetryでき、処理中は二重取得を防いで成功後に一覧へ復帰する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "失敗を待機か0件へ隠す、Retryで会話選び直しを要求する、または二重取得する"
// observable = "詳細buttonのaria-controls/expandedと理由のhidden、Retryのaccessible name/disabled/aria-busy、取得session IDと回数、成功後の用語行"
// observation_boundary = "component-behavior"
// scope = "Glossary初回取得からRetry成功までのhookと実pane"
// lifecycle = "permanent"
// distinction = "型検査やstatic markupでは取得の順序と同一tickの重複操作を検出できない。制御promiseのみで検証する"
// @end-test-value
test("Glossary初回取得は同じ会話で理由を保持して一度だけRetryする", async () => {
  const requests: { id: string; pending: ReturnType<typeof deferred<SessionGlossaryProjection>> }[] = [];
  const view = setup({
    getSessionGlossaryProjection: (id) => {
      const pending = deferred<SessionGlossaryProjection>();
      requests.push({ id, pending });
      return pending.promise;
    },
    subscribeSessionGlossary: () => () => undefined,
    searchSessionGlossary: async () => { throw new Error("Unexpected search"); },
  });
  try {
    await view.render();
    await act(async () => requests[0]!.pending.reject(new Error("Projection offline")));
    assert.equal(view.document.querySelector('[role="alert"]')!.textContent, "Glossary Load Failed");
    const details = view.document.querySelector<HTMLButtonElement>('button[aria-label="Glossary Load Failed: Details"]')!;
    const detail = view.document.getElementById(details.getAttribute("aria-controls")!)!;
    assert.equal(detail.hidden, true);
    assert.equal(details.getAttribute("aria-expanded"), "false");
    await act(async () => details.click());
    assert.equal(details.getAttribute("aria-expanded"), "true");
    assert.equal(detail.hidden, false);
    assert.equal(detail.textContent, "Projection offline");
    await act(async () => details.click());
    assert.equal(detail.hidden, true);
    const retry = view.document.querySelector<HTMLButtonElement>('button[aria-label="Retry"]')!;
    await act(async () => {
      retry.click();
      assert.equal(requests.length, 2);
      view.current.actions.onRetryProjection();
    });
    assert.deepEqual(requests.map((request) => request.id), ["session-1", "session-1"]);
    assert.equal(retry.disabled, true);
    assert.equal(retry.getAttribute("aria-busy"), "true");
    assert.equal(retry.getAttribute("aria-label"), "Retry");
    assert.equal(detail.textContent, "Projection offline");
    await act(async () => requests[1]!.pending.resolve(projection("1")));
    assert.equal(view.current.view.projectionError, "");
    assert.equal(view.current.view.projectionLoading, false);
    assert.equal(view.document.querySelector(".glossary-entry-term")?.textContent, "Old");
  } finally { await view.unmount(); }
});

// @test-value v2
// kind = "contract"
// claim = "subscriptionで取得した一覧・選択本文・注釈は遅い初回getの失敗でも保持し、会話切替後の旧get成功を採用しない"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "遅い初回失敗がprojectionを置換して閲覧中の本文を消す、または旧会話の応答を新会話へ適用する"
// observable = "選択本文、一覧、annotation matcher、取得失敗の有無と切替先projection"
// observation_boundary = "component-behavior"
// scope = "subscription/get競合と会話owner切替"
// lifecycle = "permanent"
// impact = "取得済みの用語を参照しながら作業する利用者の閲覧を中断する"
// distinction = "既存matcher testや型では非同期get失敗との競合を通らない。遅延promiseで待ち時間なく検証する"
// @end-test-value
test("Glossaryは通知済み内容を旧get失敗から保護し旧ownerの成功を破棄する", async () => {
  let notify!: (next: SessionGlossaryProjection) => void;
  const requests: ReturnType<typeof deferred<SessionGlossaryProjection>>[] = [];
  const view = setup({
    getSessionGlossaryProjection: () => { const request = deferred<SessionGlossaryProjection>(); requests.push(request); return request.promise; },
    subscribeSessionGlossary: (listener) => { notify = listener; return () => undefined; },
    searchSessionGlossary: async () => { throw new Error("Unexpected search"); },
  });
  try {
    await view.render();
    await act(async () => notify(projection("2")));
    await act(async () => view.current.actions.onSelectTerm("Old"));
    const matcher = view.current.annotationMatcher;
    await act(async () => requests[0]!.reject(new Error("Late failure")));
    assert.equal(view.current.view.projection?.sequence, 2);
    assert.equal(view.current.view.projectionError, "");
    assert.equal(view.document.querySelector(".glossary-entry-definition")?.textContent, "Old definition");
    assert.equal(view.current.annotationMatcher, matcher);
    await act(async () => view.current.actions.onBackToList());
    assert.equal(view.document.querySelector(".glossary-entry-term")?.textContent, "Old");
    await act(async () => view.current.actions.onRetryProjection());
    await view.render("session-2");
    await act(async () => requests[2]!.resolve({ ...projection("1"), sessionId: "session-2" }));
    await act(async () => requests[1]!.resolve(projection("99")));
    assert.equal(view.current.view.projection?.sessionId, "session-2");
    assert.equal(view.current.view.projection?.sequence, 1);
  } finally { await view.unmount(); }
});

type SearchResult = Awaited<ReturnType<GlossaryApi["searchSessionGlossary"]>>;
function searchResult(revision: string, terms: string[], total = terms.length): SearchResult {
  return { ok: true, revision, entries: terms.map((term) => ({ term, aliases: [], definition: `${term} definition` })), total, offset: 0, pageSize: 100 };
}

// @test-value v2
// kind = "contract"
// claim = "同じowner/queryの再検索は取得済み結果を保持し、失敗後も同queryでRetryして成功0件へ遷移する。query/checkout変更の旧応答は採用しない"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "再検索で取得済み内容を消す、Retryを重複実行する、成功0件で旧結果を残す、または別query/scopeの結果を混ぜる"
// observable = "検索API引数・回数、公開結果、保持中の表示とstale通知、error・busyと正常0件"
// observation_boundary = "component-behavior"
// scope = "projection revision更新、検索失敗・Retry・query/checkout切替"
// lifecycle = "permanent"
// impact = "一時的な検索障害で参照内容を失う、または別checkoutの用語を現在の検索結果と誤認する"
// distinction = "既存revision testは別queryの遅延結果だけを扱う。同queryの再取得保持とscope境界は型/static checkで代替できず制御promiseで検証する"
// @end-test-value
test("Glossaryは同queryの再取得失敗中も結果を保持しRetryとowner境界を守る", async () => {
  let notify!: (next: SessionGlossaryProjection) => void;
  const requests: { query: string; pending: ReturnType<typeof deferred<SearchResult>> }[] = [];
  const view = setup({
    getSessionGlossaryProjection: async () => projection("1"),
    subscribeSessionGlossary: (listener) => { notify = listener; return () => undefined; },
    searchSessionGlossary: (_id, { query }) => {
      const pending = deferred<SearchResult>(); requests.push({ query, pending }); return pending.promise;
    },
  });
  try {
    await view.render();
    await act(async () => view.current.actions.onSearchQueryChange("Old"));
    await act(async () => requests[0]!.pending.resolve(searchResult("1", ["Old"])));
    await act(async () => notify(projection("2")));
    assert.equal(view.current.view.searchLoading, true);
    assert.deepEqual(view.current.view.searchEntries.map((entry) => entry.term), ["Old"]);
    assert.match(view.document.querySelector('[role="status"]')!.textContent!, /previous search results/);
    await act(async () => requests[1]!.pending.resolve({ ok: false, code: "GLOSSARY_TARGET_INVALID", message: "Search offline", effect: "none", retryable: true }));
    assert.equal(view.current.view.searchError, "Search offline");
    assert.equal(view.document.querySelector(".glossary-entry-term")?.textContent, "Old");
    await act(async () => { view.current.actions.onRetrySearch(); view.current.actions.onRetrySearch(); });
    assert.equal(requests.length, 3);
    assert.equal(requests[2]!.query, "Old");
    assert.equal(view.current.view.searchLoading, true);
    assert.equal(view.document.querySelector<HTMLButtonElement>('.glossary-error-actions button[aria-label="Retry"]')!.disabled, true);
    await act(async () => requests[2]!.pending.resolve(searchResult("2", [])));
    assert.deepEqual(view.current.view.searchEntries, []);
    assert.equal(view.current.view.searchTotal, 0);
    assert.equal(view.current.view.searchError, "");
    assert.equal(view.current.view.searchStale, false);

    await act(async () => view.current.actions.onSearchQueryChange("First"));
    await act(async () => view.current.actions.onSearchQueryChange("Second"));
    await act(async () => requests[3]!.pending.resolve(searchResult("2", ["First"])));
    assert.deepEqual(view.current.view.searchEntries, []);
    await act(async () => requests[4]!.pending.resolve(searchResult("2", ["Second"])));
    await act(async () => notify(projection("3")));
    await act(async () => notify({ ...projection("3"), scopeRevision: "other-checkout", sequence: 4 }));
    assert.deepEqual(view.current.view.searchEntries, []);
    await act(async () => requests[5]!.pending.resolve(searchResult("3", ["Wrong checkout"])));
    assert.deepEqual(view.current.view.searchEntries, []);
    assert.equal(view.current.view.searchLoading, true);
    await act(async () => requests[6]!.pending.reject(new Error("Other checkout offline")));
    assert.deepEqual(view.current.view.searchEntries, []);
    assert.equal(view.current.view.searchError, "Other checkout offline");
  } finally { await view.unmount(); }
});

// @test-value v2
// kind = "contract"
// claim = "追加検索の失敗は既存結果を保持し同じoffsetでRetryする。owner切替後の旧追加検索応答を採用せず、破棄後の操作は追加要求を送らない"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "追加取得失敗で既存結果を消す、同一offsetを重複取得する、旧応答を新ownerへ適用する、または破棄後も検索要求を送る"
// observable = "検索offsetと回数、保持結果とerror、切替先の結果、unmount後の操作で検索要求数が不変"
// observation_boundary = "component-behavior"
// scope = "Glossary追加検索とRetryのlifecycle"
// lifecycle = "permanent"
// distinction = "初回検索とは異なる追加取得経路の取消とoffset継続を制御promiseで確認し、実時間待機や外部I/Oを要しない"
// @end-test-value
test("Glossary追加検索はoffsetを保持してRetryし旧owner応答を破棄する", async () => {
  const requests: { offset: number; pending: ReturnType<typeof deferred<SearchResult>> }[] = [];
  const view = setup({
    getSessionGlossaryProjection: async (sessionId) => ({ ...projection("1"), sessionId }),
    subscribeSessionGlossary: () => () => undefined,
    searchSessionGlossary: (_id, { offset = 0 }) => {
      const pending = deferred<SearchResult>(); requests.push({ offset, pending }); return pending.promise;
    },
  });
  let unmounted = false;
  try {
    await view.render();
    await act(async () => view.current.actions.onSearchQueryChange("Old"));
    await act(async () => requests[0]!.pending.resolve(searchResult("1", ["Old"], 3)));
    await act(async () => { view.current.actions.onLoadMoreSearchResults(); view.current.actions.onLoadMoreSearchResults(); });
    assert.equal(requests.length, 2);
    await act(async () => requests[1]!.pending.reject(new Error("Page offline")));
    assert.deepEqual(view.current.view.searchEntries.map((entry) => entry.term), ["Old"]);
    assert.equal(view.current.view.searchError, "Page offline");
    await act(async () => view.current.actions.onRetrySearch());
    assert.equal(requests[2]!.offset, 1);
    await act(async () => requests[2]!.pending.resolve(searchResult("1", ["More"], 3)));
    assert.deepEqual(view.current.view.searchEntries.map((entry) => entry.term), ["Old", "More"]);
    await act(async () => view.current.actions.onLoadMoreSearchResults());
    await view.render("session-2");
    await act(async () => requests[3]!.pending.resolve(searchResult("1", ["Wrong owner"], 3)));
    assert.deepEqual(view.current.view.searchEntries, []);
    assert.equal(view.current.view.searchError, "");
    await act(async () => view.current.actions.onSearchQueryChange("New"));
    await act(async () => requests[4]!.pending.resolve(searchResult("1", ["New"], 2)));
    const actions = view.current.actions;
    await view.unmount(); unmounted = true;
    await act(async () => { actions.onRetrySearch(); actions.onLoadMoreSearchResults(); });
    assert.equal(requests.length, 5);
  } finally { if (!unmounted) await view.unmount(); }
});
