import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useAuxiliaryWorkspace, type AuxiliaryWorkspaceApi, type AuxiliaryWorkspace } from "../../src/chat/use-auxiliary-workspace.js";
import type { AuxiliarySession } from "../../src/auxiliary-session-state.js";

function session(id: string, createdAt: string, overrides: Partial<AuxiliarySession> = {}): AuxiliarySession {
  return {
    id,
    parentSessionId: "parent-1",
    status: "active",
    runState: "idle",
    title: id,
    provider: "codex",
    catalogRevision: 1,
    model: "model",
    reasoningEffort: "medium",
    approvalMode: "never",
    codexSandboxMode: "workspace-write",
    codexSpeed: "balanced",
    codexReviewer: "none",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: id,
    composerDraft: "",
    messages: [{ role: "assistant", text: `${id} response` }],
    displayAfterMessageIndex: null,
    createdAt,
    updatedAt: createdAt,
    closedAt: "",
    ...overrides,
  };
}

function setup(api: AuxiliaryWorkspaceApi, parentSessionId: string | null = "parent-1") {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://withmate.test" });
  const previousWindow = globalThis.window;
  Object.assign(globalThis, { window: dom.window, IS_REACT_ACT_ENVIRONMENT: true });
  let current: AuxiliaryWorkspace | null = null;
  function Probe(props: { parentSessionId: string | null }) {
    current = useAuxiliaryWorkspace({ parentSessionId: props.parentSessionId, api });
    return null;
  }
  const root: Root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
  return {
    get current() { return current as AuxiliaryWorkspace; },
    async render(nextParentSessionId = parentSessionId) {
      await act(async () => { root.render(React.createElement(Probe, { parentSessionId: nextParentSessionId })); });
    },
    async unmount() { await act(async () => { root.unmount(); }); Object.assign(globalThis, { window: previousWindow }); },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

// @test-value v2
// kind = "invariant"
// claim = "会話切替の逆順詳細取得は最新選択の詳細だけを表示する"
// oracle = { type = "contract", ref = "issue-710-selection-load-generation" }
// fault = "遅れて到着した旧会話の詳細を現在選択中の会話として表示する"
// observable = "hookのselectedSessionとselectedId"
// observation_boundary = "component-behavior"
// scope = "auxiliary-workspace-selection"
// lifecycle = "permanent"
// @end-test-value
test("逆順detail loadは現在選択のIDを巻き戻さない", async () => {
  const a = session("a", "2026-01-01");
  const b = session("b", "2026-01-02");
  const c = session("c", "2026-01-03");
  const loadA = deferred<AuxiliarySession | null>();
  const loadB = deferred<AuxiliarySession | null>();
  const loadC = deferred<AuxiliarySession | null>();
  const started: string[] = [];
  const api: AuxiliaryWorkspaceApi = {
    listAuxiliarySessions: async () => [a, b, c],
    getAuxiliarySession: (id) => {
      started.push(id);
      return id === "a" ? loadA.promise : id === "b" ? loadB.promise : loadC.promise;
    },
  };
  const view = setup(api);
  await view.render();
  await act(async () => { view.current.selectSession("a"); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { view.current.selectSession("b"); });
  await act(async () => { view.current.selectSession("c"); });
  assert.deepEqual(started, ["a", "b", "c"]);
  await act(async () => { loadC.resolve(c); await loadC.promise; });
  await act(async () => { loadB.resolve(b); await loadB.promise; });
  await act(async () => { loadA.resolve(a); await loadA.promise; });
  assert.equal(view.current.selectedId, "c");
  assert.equal(view.current.selectedSession?.id, "c");
  await view.unmount();
});

// @test-value v2
// kind = "invariant"
// claim = "親workspaceの切替後に旧parentのlive terminal結果を新parentへ適用しない"
// oracle = { type = "contract", ref = "issue-710-parent-workspace-generation" }
// fault = "null parentから再接続した後、旧parentの遅延terminalやerrorが新parentの状態を汚染する"
// observable = "hookのsummariesとerror"
// observation_boundary = "component-behavior"
// scope = "auxiliary-workspace-parent-generation"
// lifecycle = "permanent"
// @end-test-value
test("parent切替後は旧parentの遅延terminalを捨てる", async () => {
  const a = session("a", "2026-01-01", { parentSessionId: "parent-1" });
  const b = session("b", "2026-01-02", { parentSessionId: "parent-2" });
  const delayedOldTerminal = deferred<AuxiliarySession | null>();
  const listeners = new Set<(id: string, state: null) => void>();
  const subscribedListeners: Array<(id: string, state: null) => void> = [];
  const api: AuxiliaryWorkspaceApi = {
    listAuxiliarySessions: async (parentId) => parentId === "parent-1" ? [a] : parentId === "parent-2" ? [b] : [],
    getAuxiliarySession: async (id) => id === "a" ? delayedOldTerminal.promise : b,
    subscribeLiveSessionRun: (listener) => {
      const callback = listener as (id: string, state: null) => void;
      subscribedListeners.push(callback);
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
  const view = setup(api, null);
  await view.render();
  assert.deepEqual(view.current.summaries, []);
  await view.render("parent-1");
  await act(async () => { view.current.selectSession("a"); });
  assert.deepEqual(view.current.summaries.map((summary) => summary.id), ["a"]);
  await view.render("parent-2");
  assert.deepEqual(view.current.summaries.map((summary) => summary.id), ["b"]);
  await act(async () => {
    const parentOneListener = subscribedListeners.at(-2);
    assert.ok(parentOneListener);
    parentOneListener("a", null);
    delayedOldTerminal.resolve(null);
    await delayedOldTerminal.promise;
  });
  assert.deepEqual(view.current.summaries.map((summary) => summary.id), ["b"]);
  assert.equal(view.current.error, null);
  assert.equal([...listeners].includes(subscribedListeners.at(-2)!), false);
  await view.unmount();
});

// @test-value v2
// kind = "invariant"
// claim = "追加後に到着した古い一覧応答は新しい会話を消さない"
// oracle = { type = "contract", ref = "issue-710-summary-generation" }
// fault = "古いlist応答でaddSession後の一覧を巻き戻す"
// observable = "hookのsummariesとselectedId"
// observation_boundary = "component-behavior"
// scope = "auxiliary-workspace-summary"
// lifecycle = "permanent"
// @end-test-value
test("stale summary responseはaddSessionを巻き戻さない", async () => {
  const list = deferred<ReturnType<AuxiliaryWorkspaceApi["listAuxiliarySessions"]> extends Promise<infer T> ? T : never>();
  const api: AuxiliaryWorkspaceApi = {
    listAuxiliarySessions: () => list.promise,
    getAuxiliarySession: async () => null,
  };
  const view = setup(api);
  await view.render();
  const added = session("added", "2026-01-01");
  await act(async () => { view.current.addSession(added); });
  await act(async () => { list.resolve([]); await list.promise; });
  assert.deepEqual(view.current.summaries.map((item) => item.id), ["added"]);
  assert.equal(view.current.selectedId, "added");
  await view.unmount();
});

// @test-value v2
// kind = "invariant"
// claim = "Main対象への切替と折りたたみはAuxiliary選択と保存済み幅を保持する"
// oracle = { type = "contract", ref = "issue-710-collapse-restore" }
// fault = "Mainへ戻す操作で選択IDまたは再展開可能な状態を失う"
// observable = "hookのtarget、isExpanded、selectedId、widthRatio"
// observation_boundary = "component-behavior"
// scope = "auxiliary-workspace-layout"
// lifecycle = "permanent"
// @end-test-value
test("Main targetとcollapseは選択・幅を保ったまま再展開できる", async () => {
  const a = session("a", "2026-01-01");
  const api: AuxiliaryWorkspaceApi = {
    listAuxiliarySessions: async () => [a],
    getAuxiliarySession: async () => a,
  };
  const view = setup(api);
  await view.render();
  await act(async () => { view.current.selectSession("a"); view.current.setWidthRatio(0.65); view.current.setTarget("auxiliary"); });
  await act(async () => { view.current.setTarget("main"); view.current.collapse(); });
  assert.equal(view.current.selectedId, "a");
  assert.equal(view.current.target, "main");
  assert.equal(view.current.isExpanded, false);
  await act(async () => { view.current.setTarget("auxiliary"); });
  assert.equal(view.current.isExpanded, true);
  assert.equal(view.current.widthRatio, 0.65);
  await view.unmount();
});

// @test-value v2
// kind = "invariant"
// claim = "非表示会話のsaveとterminal更新は会話IDを保ったままsummaryとbindingへ反映される"
// oracle = { type = "contract", ref = "issue-710-hidden-session-terminal" }
// fault = "非表示化した会話のdraftまたはterminal応答を捨て、別会話のrevisionを進める"
// observable = "binding.sessionRef、summary.preview、binding.mutationRevision"
// observation_boundary = "component-behavior"
// scope = "auxiliary-workspace-hidden-run"
// lifecycle = "permanent"
// @end-test-value
test("hidden sessionのsaveとterminalでdraft・previewを維持する", async () => {
  const a = session("a", "2026-01-01");
  const b = session("b", "2026-01-02");
  let terminal: ((id: string, state: null) => void) | null = null;
  let latest = a;
  const api: AuxiliaryWorkspaceApi = {
    listAuxiliarySessions: async () => [a, b],
    getAuxiliarySession: async (id) => id === "a" ? latest : b,
    subscribeLiveSessionRun: (listener) => { terminal = listener as (id: string, state: null) => void; return () => {}; },
  };
  const view = setup(api);
  await view.render();
  await act(async () => { view.current.addSession(a); view.current.addSession(b); });
  await act(async () => { view.current.selectSession("a"); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const binding = view.current.getBinding("a");
  const bindingB = view.current.getBinding("b");
  const revision = binding.mutationRevision.current;
  bindingB.mutationRevision.current += 1;
  await act(async () => { view.current.setTarget("main"); binding.setSession((current) => current ? { ...current, composerDraft: "hidden draft" } : current); });
  latest = { ...a, composerDraft: "hidden draft", preview: "terminal answer", messages: [...a.messages, { role: "assistant", text: "terminal answer" }] };
  assert.ok(terminal);
  await act(async () => { terminal?.("a", null); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(binding.sessionRef.current?.composerDraft, "hidden draft");
  assert.equal(binding.mutationRevision.current, revision);
  assert.equal(bindingB.mutationRevision.current, 1);
  assert.equal(view.current.summaries[0]?.preview, "terminal answer");
  await view.unmount();
});

// @test-value v2
// kind = "invariant"
// claim = "非表示の複数会話は同時terminalでも互いのdetail更新を失わない"
// oracle = { type = "contract", ref = "issue-710-independent-terminal-runs" }
// fault = "一方の会話のterminal取得が他方の会話の更新を共有revisionで破棄する"
// observable = "各summary.previewとbinding.sessionRef"
// observation_boundary = "component-behavior"
// scope = "auxiliary-workspace-concurrent-terminal"
// lifecycle = "permanent"
// @end-test-value
test("hidden A/Bの同時terminalは会話ごとに独立して反映される", async () => {
  const a = session("a", "2026-01-01");
  const b = session("b", "2026-01-02");
  const latest = new Map([["a", a], ["b", b]]);
  const listeners = new Set<(id: string, state: null) => void>();
  const api: AuxiliaryWorkspaceApi = {
    listAuxiliarySessions: async () => [...latest.values()],
    getAuxiliarySession: async (id) => latest.get(id) ?? null,
    subscribeLiveSessionRun: (listener) => {
      const callback = listener as (id: string, state: null) => void;
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
  const view = setup(api);
  await view.render();
  await act(async () => { view.current.addSession(a); view.current.addSession(b); });
  await act(async () => { view.current.selectSession("a"); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { view.current.selectSession("b"); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const bindingA = view.current.getBinding("a");
  const bindingB = view.current.getBinding("b");
  latest.set("a", { ...a, preview: "A terminal", messages: [...a.messages, { role: "assistant", text: "A terminal" }] });
  latest.set("b", { ...b, preview: "B terminal", messages: [...b.messages, { role: "assistant", text: "B terminal" }] });
  assert.ok(listeners.size > 0);
  await act(async () => {
    for (const listener of listeners) {
      listener("a", null);
      listener("b", null);
    }
    await Promise.resolve();
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(view.current.summaries.find((summary) => summary.id === "a")?.preview, "A terminal");
  assert.equal(view.current.summaries.find((summary) => summary.id === "b")?.preview, "B terminal");
  assert.equal(bindingA.sessionRef.current?.id, "a");
  assert.equal(bindingB.sessionRef.current?.id, "b");
  await view.unmount();
});
