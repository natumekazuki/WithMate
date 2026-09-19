import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useAuxiliaryWorkspace, type AuxiliaryWorkspaceApi as WorkspaceApi, type AuxiliaryWorkspace } from "../../src/chat/use-auxiliary-workspace.js";
import type { AuxiliarySession } from "../../src/auxiliary-session-state.js";

type AuxiliaryWorkspaceApi = Omit<WorkspaceApi, "getAuxiliarySessionStatus"> & Partial<Pick<WorkspaceApi, "getAuxiliarySessionStatus">>;

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

function setup(
  api: AuxiliaryWorkspaceApi,
  parentSessionId: string | null = "parent-1",
  initialSelectedId: string | null = null,
) {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://withmate.test" });
  const previousWindow = globalThis.window;
  Object.assign(globalThis, { window: dom.window, IS_REACT_ACT_ENVIRONMENT: true });
  let current: AuxiliaryWorkspace | null = null;
  const workspaceApi: WorkspaceApi = {
    ...api,
    getAuxiliarySessionStatus: api.getAuxiliarySessionStatus ?? (async (id) => {
      const detail = await api.getAuxiliarySession(id);
      return detail ? { id: detail.id, parentSessionId: detail.parentSessionId, createdAt: detail.createdAt, runState: detail.runState } : null;
    }),
  };
  function Probe(props: { parentSessionId: string | null }) {
    current = useAuxiliaryWorkspace({
      parentSessionId: props.parentSessionId,
      api: workspaceApi,
      initialSelectedId,
    });
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

// @test-value v2
// kind = "contract"
// claim = "Auxiliary workspaceへ指定された初期IDは一覧取得後の初期選択へ反映され、Auxiliary選択はMain/Auxiliaryの送信対象を変更しない"
// oracle = { type = "adr", ref = "docs/adr/006-windows-session-turn-notifications.md" }
// fault = "一覧取得後の初期選択IDを無視する、または対象会話の選択時に送信対象までAuxiliaryへ切り替える"
// observable = "hookのselectedId、selectedSession、target"
// observation_boundary = "component-behavior"
// scope = "auxiliary-workspace-notification-navigation"
// lifecycle = "permanent"
// distinction = "通常の一覧選択testでは検証できない初期選択と送信対象の独立性をhookのcomponent behaviorとして検証する"
// @end-test-value
test("通知由来のAuxiliary選択は送信対象を変更しない", async () => {
  const a = session("a", "2026-01-01");
  const b = session("b", "2026-01-02");
  const view = setup({
    listAuxiliarySessions: async () => [a, b],
    getAuxiliarySession: async (id) => id === a.id ? a : id === b.id ? b : null,
  }, "parent-1", b.id);

  await view.render();
  assert.equal(view.current.selectedId, b.id);
  assert.equal(view.current.selectedSession?.id, b.id);
  assert.equal(view.current.target, "main");

  await act(async () => { view.current.selectSession(a.id); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(view.current.selectedId, a.id);
  assert.equal(view.current.selectedSession?.id, a.id);
  assert.equal(view.current.target, "main");

  await act(async () => { view.current.setTarget("auxiliary"); });
  await act(async () => { view.current.selectSession(b.id); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(view.current.selectedId, b.id);
  assert.equal(view.current.selectedSession?.id, b.id);
  assert.equal(view.current.target, "auxiliary");
  await view.unmount();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

// @test-value v2
// kind = "contract"
// claim = "Auxiliary一覧は最終使用時刻の降順で表示し、同時刻ではIDの降順で安定する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md:75" }
// fault = "作成時刻の順序を表示し続けるか、同時刻の会話順が不定になり、最近使ったAuxiliaryへすぐ切り替えられない"
// observable = "hookが公開するsummariesのID順"
// observation_boundary = "component-behavior"
// scope = "auxiliary-workspace-summary-order"
// lifecycle = "permanent"
// @end-test-value
test("Auxiliary一覧は最終使用順で並び、同時刻ではIDで安定する", async () => {
  const createdLater = session("created-later", "2026-01-03", { updatedAt: "2026-01-01" });
  const lastUsed = session("last-used", "2026-01-01", { updatedAt: "2026-01-03" });
  const sameTimeA = session("same-time-a", "2026-01-04", { updatedAt: "2026-01-02" });
  const sameTimeB = session("same-time-b", "2026-01-02", { updatedAt: "2026-01-02" });
  const api: AuxiliaryWorkspaceApi = {
    listAuxiliarySessions: async () => [createdLater, lastUsed, sameTimeA, sameTimeB],
    getAuxiliarySession: async () => null,
  };
  const view = setup(api);
  await view.render();
  assert.deepEqual(view.current.summaries.map((summary) => summary.id), [
    "last-used",
    "same-time-b",
    "same-time-a",
    "created-later",
  ]);
  await view.unmount();
});

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
  const a = session("a", "2026-01-01", { updatedAt: "2026-01-03" });
  const b = session("b", "2026-01-02", { updatedAt: "2026-01-02" });
  const c = session("c", "2026-01-03", { updatedAt: "2026-01-01" });
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
// claim = "Main/Auxiliary対象の切替とAuxiliary追加は選択中の幅を変更せず、幅0は同一親の再マウントでも復元する"
// oracle = { type = "contract", ref = "issue-710-auxiliary-width-target-separation" }
// fault = "対象切替や新規追加で幅が暗黙に変わる、幅0から対象切替だけで再展開する、または親セッション再マウントで幅0を失う"
// observable = "hookのtarget、selectedId、widthRatioと親セッション切替後のwidthRatio"
// observation_boundary = "component-behavior"
// scope = "auxiliary-workspace-layout"
// lifecycle = "permanent"
// @end-test-value
test("対象切替は選択・幅を変更せず、Auxiliaryの幅0を保持する", async () => {
  const a = session("a", "2026-01-01");
  const b = session("b", "2026-01-02");
  const api: AuxiliaryWorkspaceApi = {
    listAuxiliarySessions: async (parentSessionId) => parentSessionId === "parent-1" ? [a] : [],
    getAuxiliarySession: async () => a,
  };
  const view = setup(api);
  await view.render();
  await act(async () => { view.current.selectSession("a"); view.current.setWidthRatio(0.65); view.current.setTarget("auxiliary"); });
  await act(async () => { view.current.setTarget("main"); });
  assert.equal(view.current.selectedId, "a");
  assert.equal(view.current.target, "main");
  assert.equal(view.current.widthRatio, 0.65);
  await act(async () => { view.current.setWidthRatio(0); view.current.setTarget("auxiliary"); });
  assert.equal(view.current.target, "auxiliary");
  assert.equal(view.current.widthRatio, 0);
  await act(async () => { view.current.setTarget("main"); });
  assert.equal(view.current.widthRatio, 0);
  await act(async () => { view.current.addSession(b); });
  assert.equal(view.current.selectedId, "b");
  assert.equal(view.current.target, "main");
  assert.equal(view.current.widthRatio, 0);
  await view.render("parent-2");
  await view.render("parent-1");
  assert.equal(view.current.widthRatio, 0);
  await view.unmount();
});

// @test-value v2
// kind = "invariant"
// claim = "非表示会話のterminal詳細は保存済draftと確定応答を対象会話へ反映し、選択中の別会話を上書きしない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: Goal / Context boundary / Preview contract" }
// fault = "非表示化した会話のterminal応答を捨てる、または取得したdraftと応答を別会話へ適用する"
// observable = "対象と選択中会話のbinding.sessionRef、summary.preview"
// observation_boundary = "component-behavior"
// scope = "auxiliary-workspace-hidden-run"
// lifecycle = "permanent"
// @end-test-value
test("hidden sessionのterminal詳細を保存済draftとともに正しい会話へ反映する", async () => {
  const a = session("a", "2026-01-01", { composerDraft: "hidden draft" });
  const b = session("b", "2026-01-02", { composerDraft: "selected draft" });
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
  await act(async () => { view.current.selectSession("b"); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => {
    view.current.setTarget("main");
  });
  assert.equal(binding.sessionRef.current?.id, a.id);
  assert.equal(binding.sessionRef.current?.composerDraft, "hidden draft");
  latest = { ...latest, preview: "terminal answer", messages: [...latest.messages, { role: "assistant", text: "terminal answer" }] };
  assert.ok(terminal);
  await act(async () => { terminal?.("a", null); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(binding.sessionRef.current?.id, a.id);
  assert.equal(binding.sessionRef.current?.composerDraft, "hidden draft");
  assert.equal(binding.sessionRef.current?.preview, "terminal answer");
  assert.equal(binding.sessionRef.current?.messages.at(-1)?.text, "terminal answer");
  assert.equal(bindingB.sessionRef.current?.id, b.id);
  assert.equal(bindingB.sessionRef.current?.composerDraft, "selected draft");
  assert.deepEqual(bindingB.sessionRef.current?.messages, b.messages);
  assert.equal(view.current.summaries.find((summary) => summary.id === "a")?.preview, "terminal answer");
  await view.unmount();
});

// @test-value v2
// kind = "invariant"
// claim = "詳細取得前に完了したAuxiliaryもterminal確定Sessionをdetailへ反映し、遅い初期取得で巻き戻さない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: UI flow" }
// fault = "詳細未取得時のterminal通知を一覧更新だけで終え、確定したassistant messageを表示せず、遅い初期取得で古いSessionへ戻す"
// observable = "hookのselectedSession、detailLoading、detailError"
// observation_boundary = "component-behavior"
// scope = "auxiliary-workspace-terminal-detail-refresh"
// lifecycle = "permanent"
// distinction = "通常の詳細取得済みterminal testでは検出できない、初期detail loadとterminal refreshの競合を検証する"
// @end-test-value
test("詳細取得前のterminalは確定Sessionを反映し、遅い初期detailで巻き戻さない", async () => {
  const initial = session("a", "2026-01-01");
  const terminalSession = {
    ...initial,
    preview: "terminal answer",
    updatedAt: "2026-01-03",
    messages: [...initial.messages, { role: "assistant" as const, text: "terminal answer" }],
  };
  const initialDetail = deferred<AuxiliarySession | null>();
  let initialDetailPending = true;
  let terminal: ((id: string, state: null) => void) | null = null;
  const api: AuxiliaryWorkspaceApi = {
    listAuxiliarySessions: async () => [initial],
    getAuxiliarySession: async () => {
      if (initialDetailPending) {
        initialDetailPending = false;
        return initialDetail.promise;
      }
      return terminalSession;
    },
    subscribeLiveSessionRun: (listener) => {
      terminal = listener as (id: string, state: null) => void;
      return () => {};
    },
  };
  const view = setup(api, "parent-1", initial.id);

  await view.render();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.ok(terminal);

  await act(async () => {
    terminal?.(initial.id, null);
    await Promise.resolve();
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(view.current.selectedSession?.messages.at(-1)?.text, "terminal answer");
  assert.equal(view.current.detailLoading, false);
  assert.equal(view.current.detailError, null);

  await act(async () => {
    initialDetail.resolve(initial);
    await initialDetail.promise;
  });
  assert.equal(view.current.selectedSession?.messages.at(-1)?.text, "terminal answer");
  await view.unmount();
});

// @test-value v2
// kind = "invariant"
// claim = "terminal確定Sessionを表示中に遅い初期detailのrejectが到着してもdetailErrorを設定せずMessagesを隠さない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: UI flow" }
// fault = "terminal確定Sessionを表示した後、先行していた初期detailのrejectがdetailErrorを上書きし、Messagesを共通エラー状態にする"
// observable = "hookのselectedSession、selectedSession.messages、detailLoading、detailError"
// observation_boundary = "component-behavior"
// scope = "auxiliary-workspace-terminal-detail-rejection-epoch"
// lifecycle = "permanent"
// distinction = "初期detailの遅いresolve競合では検出できない、terminal確定後に到着する初期detailのreject経路を検証する"
// @end-test-value
test("terminal確定後の遅い初期detailエラーはMessagesを隠さない", async () => {
  const initial = session("a", "2026-01-01");
  const terminalSession = {
    ...initial,
    preview: "terminal answer",
    updatedAt: "2026-01-03",
    messages: [...initial.messages, { role: "assistant" as const, text: "terminal answer" }],
  };
  let rejectInitialDetail!: (cause: Error) => void;
  const initialDetail = new Promise<AuxiliarySession | null>((_resolve, reject) => { rejectInitialDetail = reject; });
  let initialDetailPending = true;
  let terminal: ((id: string, state: null) => void) | null = null;
  const api: AuxiliaryWorkspaceApi = {
    listAuxiliarySessions: async () => [initial],
    getAuxiliarySession: async () => {
      if (initialDetailPending) {
        initialDetailPending = false;
        return initialDetail;
      }
      return terminalSession;
    },
    subscribeLiveSessionRun: (listener) => {
      terminal = listener as (id: string, state: null) => void;
      return () => {};
    },
  };
  const view = setup(api, "parent-1", initial.id);

  await view.render();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.ok(terminal);

  await act(async () => {
    terminal?.(initial.id, null);
    await Promise.resolve();
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(view.current.selectedSession?.messages.at(-1)?.text, "terminal answer");
  assert.equal(view.current.detailLoading, false);
  assert.equal(view.current.detailError, null);

  rejectInitialDetail(new Error("initial detail read failed"));
  await act(async () => { await initialDetail.catch(() => undefined); });
  assert.equal(view.current.selectedSession?.messages.at(-1)?.text, "terminal answer");
  assert.equal(view.current.detailLoading, false);
  assert.equal(view.current.detailError, null);
  await view.unmount();
});

// @test-value v2
// kind = "invariant"
// claim = "terminal詳細取得が失敗しても初期detail解決後に選択中のSessionを空のままにしない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: UI flow" }
// fault = "terminal再取得のreject後に初期detailの解決を反映せず、完了Sessionを表示できないまま選択中のdetailErrorだけを残す"
// observable = "hookのselectedSession、detailLoading、detailError"
// observation_boundary = "component-behavior"
// scope = "auxiliary-workspace-terminal-detail-fallback"
// lifecycle = "permanent"
// distinction = "terminal再取得成功だけを確認するtestでは検出できない、terminal失敗と初期detail解決の競合を検証する"
// @end-test-value
test("terminal詳細取得失敗時は初期detailへフォールバックする", async () => {
  const initial = session("a", "2026-01-01");
  const initialDetail = deferred<AuxiliarySession | null>();
  let initialDetailPending = true;
  let terminal: ((id: string, state: null) => void) | null = null;
  const api: AuxiliaryWorkspaceApi = {
    listAuxiliarySessions: async () => [initial],
    getAuxiliarySession: async () => {
      if (initialDetailPending) {
        initialDetailPending = false;
        return initialDetail.promise;
      }
      throw new Error("terminal read failed");
    },
    subscribeLiveSessionRun: (listener) => {
      terminal = listener as (id: string, state: null) => void;
      return () => {};
    },
  };
  const view = setup(api, "parent-1", initial.id);

  await view.render();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.ok(terminal);

  await act(async () => {
    terminal?.(initial.id, null);
    await Promise.resolve();
  });
  assert.equal(view.current.selectedSession, null);
  assert.equal(view.current.detailLoading, false);
  assert.equal(view.current.detailError?.message, "terminal read failed");

  await act(async () => {
    initialDetail.resolve(initial);
    await initialDetail.promise;
  });
  assert.equal(view.current.selectedSession?.id, initial.id);
  assert.equal(view.current.detailLoading, false);
  assert.equal(view.current.detailError, null);
  await view.unmount();
});

// @test-value v2
// kind = "invariant"
// claim = "非選択Auxiliaryの遅延terminal詳細取得失敗は選択中Auxiliaryの共通エラーへ波及しない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: UI flow" }
// fault = "AからBへ切り替えた後にAの遅延terminal取得失敗をB選択中の共通errorへ設定し、選択中Sessionの表示を共通エラー状態にする"
// observable = "hookのselectedId、selectedSession、detailError、error"
// observation_boundary = "component-behavior"
// scope = "auxiliary-workspace-session-scoped-error"
// lifecycle = "permanent"
// distinction = "選択中Auxiliary自身の詳細失敗ではなく、選択切替後に到着する非選択Auxiliaryのterminal失敗が共通errorへ流入しないことを検証する"
// @end-test-value
test("非選択Auxiliaryの遅延terminalエラーは選択中Auxiliaryへ波及しない", async () => {
  const a = session("a", "2026-01-01");
  const b = session("b", "2026-01-02");
  let rejectTerminal!: (cause: Error) => void;
  const terminalFailure = new Promise<AuxiliarySession | null>((_resolve, reject) => { rejectTerminal = reject; });
  const aDetails = [Promise.resolve<AuxiliarySession | null>(a), terminalFailure];
  let terminal: ((id: string, state: null) => void) | null = null;
  const api: AuxiliaryWorkspaceApi = {
    listAuxiliarySessions: async () => [a, b],
    getAuxiliarySession: (id) => id === a.id ? (aDetails.shift() ?? Promise.resolve(a)) : Promise.resolve(b),
    subscribeLiveSessionRun: (listener) => {
      terminal = listener as (id: string, state: null) => void;
      return () => {};
    },
  };
  const view = setup(api, "parent-1", a.id);

  await view.render();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(view.current.selectedId, a.id);
  assert.ok(terminal);

  await act(async () => {
    terminal?.(a.id, null);
    view.current.selectSession(b.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(view.current.selectedId, b.id);
  assert.equal(view.current.selectedSession?.id, b.id);

  await act(async () => {
    rejectTerminal(new Error("A terminal read failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(view.current.selectedId, b.id);
  assert.equal(view.current.selectedSession?.id, b.id);
  assert.equal(view.current.detailError, null);
  assert.equal(view.current.error, null);
  await view.unmount();
});

// @test-value v2
// kind = "invariant"
// claim = "削除済みAuxiliaryのterminal詳細がnullなら一覧と選択状態を再同期し、古いdetailを表示し続けない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: UI flow" }
// fault = "terminal再取得のnullを無視して一覧の古いsummaryと選択中のSessionを残す"
// observable = "hookのsummaries、selectedId、selectedSession、detailError"
// observation_boundary = "component-behavior"
// scope = "auxiliary-workspace-terminal-detail-missing"
// lifecycle = "permanent"
// distinction = "terminal詳細がnullかつ一覧からも削除された会話について、一覧・選択状態の再同期を検証する"
// @end-test-value
test("terminal詳細がnullなら一覧と選択状態を再同期する", async () => {
  const initial = session("a", "2026-01-01");
  let listed = [initial];
  let initialDetailPending = true;
  let terminal: ((id: string, state: null) => void) | null = null;
  const api: AuxiliaryWorkspaceApi = {
    listAuxiliarySessions: async () => listed,
    getAuxiliarySession: async () => {
      if (initialDetailPending) {
        initialDetailPending = false;
        return initial;
      }
      return null;
    },
    subscribeLiveSessionRun: (listener) => {
      terminal = listener as (id: string, state: null) => void;
      return () => {};
    },
  };
  const view = setup(api, "parent-1", initial.id);

  await view.render();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(view.current.selectedSession?.id, initial.id);
  assert.ok(terminal);

  listed = [];
  await act(async () => {
    terminal?.(initial.id, null);
    await Promise.resolve();
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.deepEqual(view.current.summaries, []);
  assert.equal(view.current.selectedId, null);
  assert.equal(view.current.selectedSession, null);
  assert.equal(view.current.detailError, null);
  await view.unmount();
});

// @test-value v2
// kind = "invariant"
// claim = "terminal完了反映後に到着した古い一覧応答は完了済みsummaryを巻き戻さない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: Persistence" }
// fault = "terminal完了反映と一覧refreshが競合したとき古いsummaryが完了済みpreviewを上書きする"
// observable = "hookのsummaries.previewとsummaries.updatedAt"
// observation_boundary = "component-behavior"
// scope = "auxiliary-workspace-terminal-summary-generation"
// lifecycle = "permanent"
// distinction = "addSession後の一覧競合ではなく、terminal確定Sessionのsummary反映後に古い一覧応答が到着する競合を検証する"
// @end-test-value
test("terminal完了後の古い一覧応答はsummaryを巻き戻さない", async () => {
  const initial = session("a", "2026-01-01", { preview: "old answer" });
  const terminalSession = {
    ...initial,
    preview: "terminal answer",
    updatedAt: "2026-01-03",
    messages: [...initial.messages, { role: "assistant" as const, text: "terminal answer" }],
  };
  const staleList = deferred<ReturnType<AuxiliaryWorkspaceApi["listAuxiliarySessions"]> extends Promise<infer T> ? T : never>();
  const listStarted = deferred<void>();
  let listCall = 0;
  let detailCall = 0;
  let terminal: ((id: string, state: null) => void) | null = null;
  const api: AuxiliaryWorkspaceApi = {
    listAuxiliarySessions: async () => {
      listCall += 1;
      if (listCall === 1) return [initial];
      listStarted.resolve();
      return staleList.promise;
    },
    getAuxiliarySession: async () => {
      detailCall += 1;
      return detailCall === 1 ? initial : terminalSession;
    },
    subscribeLiveSessionRun: (listener) => {
      terminal = listener as (id: string, state: null) => void;
      return () => {};
    },
  };
  const view = setup(api, "parent-1", initial.id);

  await view.render();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(view.current.summaries.find((summary) => summary.id === initial.id)?.preview, "old answer");
  assert.ok(terminal);

  let refreshPromise: Promise<void> | null = null;
  await act(async () => {
    refreshPromise = view.current.refreshSummaries();
    await listStarted.promise;
  });
  assert.ok(refreshPromise);

  await act(async () => {
    terminal?.(initial.id, null);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(view.current.summaries.find((summary) => summary.id === initial.id)?.preview, "terminal answer");
  assert.equal(view.current.loading, false);

  await act(async () => {
    staleList.resolve([initial]);
    await refreshPromise;
  });
  assert.equal(view.current.summaries.find((summary) => summary.id === initial.id)?.preview, "terminal answer");
  assert.equal(view.current.summaries.find((summary) => summary.id === initial.id)?.updatedAt, "2026-01-03");
  assert.equal(view.current.loading, false);
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

// @test-value v2
// kind = "invariant"
// claim = "完了後も保持されるlive stateは永続化runStateをrunningへ誤変換しない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: Composer の更新・保存境界" }
// fault = "background taskまたはreasoning保持用のlive stateだけでsummaryをrunningにし続けるか、status反映でbindingの未保存draftを上書きする"
// observable = "hookのsummaries.runStateとbinding.sessionRef.composerDraft"
// observation_boundary = "component-behavior"
// scope = "auxiliary-workspace-run-state"
// lifecycle = "permanent"
// @end-test-value
test("保持されたlive stateは永続化runStateを正本として扱う", async () => {
  const idle = session("idle", "2026-01-01");
  const running = session("running", "2026-01-02", { runState: "running" });
  const latest = new Map([[idle.id, idle], [running.id, running]]);
  let listener: ((id: string, state: object | null) => void) | null = null;
  const api: AuxiliaryWorkspaceApi = {
    listAuxiliarySessions: async () => [idle, running],
    getAuxiliarySession: async (id) => latest.get(id) ?? null,
    getAuxiliarySessionStatus: async (id) => {
      const current = latest.get(id);
      return current ? { id: current.id, parentSessionId: current.parentSessionId, createdAt: current.createdAt, runState: current.runState } : null;
    },
    subscribeLiveSessionRun: (nextListener) => {
      listener = nextListener as (id: string, state: object | null) => void;
      return () => { listener = null; };
    },
  };
  const view = setup(api);
  await view.render();
  assert.ok(listener);
  const retainedLiveState = { errorMessage: "", backgroundTasks: [{ id: "task-1" }] };
  await act(async () => {
    listener?.(idle.id, retainedLiveState);
    await Promise.resolve();
  });
  assert.equal(view.current.summaries.find((summary) => summary.id === idle.id)?.runState, "idle");
  await act(async () => {
    listener?.(running.id, retainedLiveState);
    await Promise.resolve();
  });
  assert.equal(view.current.summaries.find((summary) => summary.id === running.id)?.runState, "running");
  await act(async () => { view.current.selectSession(running.id); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const runningBinding = view.current.getBinding(running.id);
  await act(async () => {
    runningBinding.setSession((current) => current ? { ...current, composerDraft: "未保存draft" } : current);
  });
  latest.set(running.id, { ...running, runState: "idle" });
  await act(async () => {
    listener?.(running.id, retainedLiveState);
    await Promise.resolve();
  });
  assert.equal(view.current.summaries.find((summary) => summary.id === running.id)?.runState, "idle");
  assert.equal(runningBinding.sessionRef.current?.composerDraft, "未保存draft");
  await view.unmount();
});

// @test-value v2
// kind = "contract"
// claim = "非選択Auxiliaryの連続live通知は有限に集約した軽量statusだけで反映し、terminalでは本文を取得して再選択時に表示する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: Composer の更新・保存境界" }
// fault = "live通知ごとに履歴を取得するか、status集約によってterminalの最新本文も取得しなくなる"
// observable = "APIの詳細取得回数・status取得回数、summaries参照とrunState、selectedId、再選択したselectedSession.messages"
// observation_boundary = "component-behavior"
// scope = "auxiliary-workspace-live-boundary"
// lifecycle = "permanent"
// impact = "多数会話の非表示実行が入力を重くすることと、完了した応答を閲覧できなくなることを防ぐ"
// distinction = "型検査やcontroller単体では観測できない実hookの購読・取得・表示の接続を少数のdeferred操作で検証する"
// @end-test-value
test("非選択live statusは有限に集約し、terminal本文は再選択時に表示する", async () => {
  const sessions = Array.from({ length: 100 }, (_, index) => session(`aux-${index}`, "2026-01-01"));
  const hidden = sessions[0];
  const running = { id: hidden.id, parentSessionId: hidden.parentSessionId, createdAt: hidden.createdAt, runState: "running" as const };
  const firstStatus = deferred<typeof running>();
  let statusReads = 0;
  let detailReads = 0;
  let latest = hidden;
  let listener: ((id: string, state: object | null) => void) | undefined;
  const view = setup({
    listAuxiliarySessions: async () => sessions,
    getAuxiliarySession: async (id) => { detailReads += 1; return id === hidden.id ? latest : sessions.find((item) => item.id === id) ?? null; },
    getAuxiliarySessionStatus: async () => { statusReads += 1; return statusReads === 1 ? firstStatus.promise : running; },
    subscribeLiveSessionRun: (next) => { listener = next as typeof listener; return () => { listener = undefined; }; },
  });
  try {
    await view.render();
    assert.notEqual(view.current.selectedId, hidden.id);
    const loadedDetails = detailReads;
    await act(async () => {
      for (let index = 0; index < 100; index += 1) listener?.(hidden.id, { assistantText: `chunk ${index}` });
    });
    assert.equal(statusReads, 1);
    assert.equal(detailReads, loadedDetails);
    await act(async () => { firstStatus.resolve(running); });
    assert.equal(statusReads, 2);
    assert.equal(view.current.summaries.find((item) => item.id === hidden.id)?.runState, "running");
    const summaries = view.current.summaries;
    await act(async () => { listener?.(hidden.id, { assistantText: "same run" }); });
    assert.strictEqual(view.current.summaries, summaries);
    assert.equal(detailReads, loadedDetails);

    latest = { ...hidden, preview: "completed response", messages: [{ role: "assistant", text: "completed response" }] };
    await act(async () => { listener?.(hidden.id, null); });
    assert.equal(detailReads, loadedDetails + 1);
    assert.equal(view.current.summaries.find((item) => item.id === hidden.id)?.runState, "idle");
    assert.equal(view.current.summaries.find((item) => item.id === hidden.id)?.preview, "completed response");
    await act(async () => { view.current.selectSession(hidden.id); });
    assert.equal(detailReads, loadedDetails + 1);
    assert.equal(view.current.selectedSession?.messages[0]?.text, "completed response");
  } finally {
    await view.unmount();
  }
});

// @test-value v2
// kind = "contract"
// claim = "workspace hookに渡された使用時刻は実際の順位変更だけを一覧へ通知し、同順位の更新・no-opは参照を保ち、本文preview変更は反映する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: Composer の更新・保存境界" }
// fault = "同順位の入力や省略保存で一覧を作り直す、または必要な順位・preview更新まで止める"
// observable = "hookのsummaries参照、ID順、previewとselectedSession.messages"
// observation_boundary = "component-behavior"
// scope = "auxiliary-workspace-recency-boundary"
// lifecycle = "permanent"
// impact = "最終使用順の継続利用と入力時の一覧負荷分離を同時に保つ"
// distinction = "既存の初期並び順テストでは確認できない入力recencyの通知省略と真の本文更新を一つのhook操作で検証する"
// @end-test-value
test("同順位のrecencyとno-opは一覧を通知せず、本当の順位とpreview更新は反映する", async () => {
  const a = session("a", "2026-01-01", { preview: "A" });
  const b = session("b", "2026-01-02", { preview: "B" });
  const view = setup({ listAuxiliarySessions: async () => [a, b], getAuxiliarySession: async (id) => id === a.id ? a : b });
  try {
    await view.render();
    await act(async () => { view.current.touchRecency(a.id, "2026-01-03"); });
    assert.deepEqual(view.current.summaries.map((item) => item.id), [a.id, b.id]);
    const summaries = view.current.summaries;
    await act(async () => {
      for (let index = 0; index < 100; index += 1) view.current.touchRecency(a.id, `2026-01-04T00:00:${String(index).padStart(3, "0")}`);
      view.current.getBinding(b.id).setSession((current) => current);
    });
    assert.strictEqual(view.current.summaries, summaries);
    await act(async () => {
      view.current.getBinding(b.id).setSession((current) => current ? { ...current, preview: "new B", messages: [{ role: "assistant", text: "new B" }] } : current);
    });
    assert.equal(view.current.summaries.find((item) => item.id === b.id)?.preview, "new B");
    assert.equal(view.current.selectedSession?.messages[0]?.text, "new B");
  } finally {
    await view.unmount();
  }
});

// @test-value v2
// kind = "contract"
// claim = "terminal詳細取得中の保持live通知は最終本文を捨てず、新しい実行が確認された場合だけ古いterminalを適用しない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: Composer の更新・保存境界" }
// fault = "非null liveだけでterminal読取りを無効化し最終応答を失う、または新runを古いterminalでidleへ戻す"
// observable = "実hookのselectedSession.messagesとrunState、詳細API呼出数"
// observation_boundary = "component-behavior"
// scope = "auxiliary-terminal-retained-live-race"
// lifecycle = "permanent"
// impact = "background taskを保持する会話の完了本文と、再実行中の送信制限を保つ"
// distinction = "同期したterminal/statusテストでは生じない応答順逆転をdeferredで検証する"
// @end-test-value
test("terminal取得中の保持liveは本文を保持し、新runだけ古いterminalを無効化する", async () => {
  const initial = session("a", "2026-01-01", { runState: "running" });
  let status: "running" | "idle" = "idle";
  let terminal = deferred<AuxiliarySession>();
  let reads = 0;
  let listener: ((id: string, state: object | null) => void) | undefined;
  const view = setup({
    listAuxiliarySessions: async () => [initial],
    getAuxiliarySession: async () => { reads += 1; return reads === 1 ? initial : terminal.promise; },
    getAuxiliarySessionStatus: async () => ({ id: initial.id, parentSessionId: initial.parentSessionId, createdAt: initial.createdAt, runState: status }),
    subscribeLiveSessionRun: (next) => { listener = next as typeof listener; return () => { listener = undefined; }; },
  });
  try {
    await view.render();
    await act(async () => { listener?.(initial.id, null); });
    await act(async () => { listener?.(initial.id, { backgroundTasks: [{ id: "retained" }] }); });
    const completed = { ...initial, runState: "idle" as const, messages: [{ role: "assistant" as const, text: "final response" }] };
    await act(async () => { terminal.resolve(completed); });
    assert.equal(view.current.selectedSession?.messages.at(-1)?.text, "final response");
    assert.equal(view.current.selectedSession?.runState, "idle");
    assert.equal(reads, 2);

    terminal = deferred<AuxiliarySession>();
    await act(async () => { listener?.(initial.id, null); });
    status = "running";
    await act(async () => { listener?.(initial.id, { assistantText: "new run" }); });
    await act(async () => { terminal.resolve({ ...completed, messages: [{ role: "assistant", text: "obsolete terminal response" }] }); });
    assert.equal(view.current.selectedSession?.runState, "running");
    assert.equal(view.current.selectedSession?.messages.at(-1)?.text, "final response");
    assert.equal(reads, 3);
  } finally {
    await view.unmount();
  }
});
