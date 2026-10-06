import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useSessionGlossary, type SessionGlossarySelection } from "../../src/glossary/use-session-glossary.js";
import type { SessionGlossaryProjection } from "../../src-shared/glossary/glossary-contract.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

type GlossaryApi = Pick<WithMateWindowApi, "getSessionGlossaryProjection" | "searchSessionGlossary" | "subscribeSessionGlossary">;

function projection(revision: string): SessionGlossaryProjection {
  return {
    sessionId: "session-1",
    scopeRevision: revision,
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
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function setup(api: GlossaryApi) {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://withmate.test" });
  const previousWindow = globalThis.window;
  Object.assign(globalThis, { window: dom.window, IS_REACT_ACT_ENVIRONMENT: true });
  let current: ReturnType<typeof useSessionGlossary> | null = null;
  let selection: SessionGlossarySelection = {
    id: "session-1",
    revision: "session-revision-1",
    workspaceLabel: "workspace",
    branch: "main",
  };
  function Probe() {
    current = useSessionGlossary({ api, selectedSession: selection, onActivatePane: () => undefined });
    return null;
  }
  const root: Root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
  return {
    get current() { return current as ReturnType<typeof useSessionGlossary>; },
    async render(sessionId?: string) {
      if (sessionId) selection = { ...selection, id: sessionId };
      await act(async () => { root.render(React.createElement(Probe)); });
    },
    async unmount() { await act(async () => { root.unmount(); }); Object.assign(globalThis, { window: previousWindow }); },
  };
}

// @test-value v2
// kind = "contract"
// claim = "Glossary検索はprojectionのrevision更新時に旧結果を消去し、旧revisionの遅延responseを破棄して新revisionのresponseだけを公開viewへ反映する"
// oracle = { type = "contract", ref = "SessionGlossaryProjection.state.revision and searchSessionGlossary result revision" }
// fault = "revision更新中に旧検索結果を表示し続ける、旧responseを新revisionへ混入させる、または新responseを公開しない"
// observable = "useSessionGlossary view.searchEntries, view.searchLoading, view.searchTotal"
// observation_boundary = "component-behavior"
// scope = "session-glossary-search-revision"
// lifecycle = "permanent"
// distinction = "source文字列ではなく、projection購読と遅延検索responseを通した公開viewのstale guardを検証する"
// @end-test-value
test("Glossary検索は新しいrevisionのresponseを待つ間に旧結果を表示しない", async () => {
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
