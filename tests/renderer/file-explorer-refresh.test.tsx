import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { SessionLiveIngressApi } from "../../src/chat/runtime/session-window-live-ingress.js";
import { useFileExplorerRefresh } from "../../src/file-explorer/use-file-explorer-refresh.js";

async function mount(t: TestContext) {
  const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let listener: Parameters<SessionLiveIngressApi["subscribeLiveSessionRun"]>[0] = () => {};
  let snapshotReads = 0;
  const api: SessionLiveIngressApi = {
    getLiveSessionRun: async () => { ++snapshotReads; return null; },
    subscribeLiveSessionRun: (next) => { listener = next; return () => { listener = () => {}; }; },
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  let input: Parameters<typeof useFileExplorerRefresh>[0] = {
    api, ownerKey: "main-roots", relatedSessionIds: ["main", "aux"], enabled: true, visible: true, activeTab: "files",
  };
  let state!: ReturnType<typeof useFileExplorerRefresh>;
  function Harness() { state = useFileExplorerRefresh(input); return <output>{JSON.stringify(state.revisions)}</output>; }
  const render = async (patch: Partial<typeof input> = {}) => {
    input = { ...input, ...patch };
    await act(async () => root.render(<Harness />));
  };
  t.after(async () => {
    await act(async () => root.unmount());
    t.mock.timers.reset();
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await render();
  return {
    render,
    get state() { return state; },
    get snapshotReads() { return snapshotReads; },
    tick: async (ms = 150) => { await act(async () => t.mock.timers.tick(ms)); },
    focus: async () => { await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus"))); },
    documentVisible: async (visible: boolean) => {
      Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: visible ? "visible" : "hidden" });
      await act(async () => dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")));
    },
    emit: async (id: string, runState: string | null, turnId = "turn") => {
      const live: LiveSessionRunState | null = runState === null ? null : {
        sessionId: id, threadId: "thread", turnId, runState, assistantText: "body", steps: [], backgroundTasks: [],
        usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null,
      };
      await act(async () => listener(id, live));
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "Finderは関連Main/Auxiliaryの成功・失敗・取消終端とfocusを集約し、表示中tabだけを更新対象にする"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Agent の File Explorer 更新契機" }
// fault = "streamingや無関係なSessionで再取得する、失敗や取消終端を落とす、通知の連続で全tabを更新する"
// observable = "hook consumerのtab別revisionとlive snapshot APIの呼出数"
// observation_boundary = "component-behavior"
// scope = "Finderのlive eventとfocusの更新通知"
// lifecycle = "permanent"
// impact = "作業終了後も一覧が古いまま残るか、streaming中に不要なfilesystem/Git負荷が増える"
// distinction = "pane単体testでは扱わないWindow通知と更新対象tabの対応を仮想timerで検証する"
// @end-test-value
test("関連turn終端とfocusのburstを表示tabの一度の更新へ集約する", async (t) => {
  const explorer = await mount(t);
  await explorer.tick();
  for (let i = 0; i < 20; ++i) await explorer.emit("main", "running");
  await explorer.emit("unrelated", "idle");
  await explorer.tick();
  assert.deepEqual(explorer.state.revisions, { files: 0, changes: 0, history: 0 });
  await explorer.emit("main", "idle");
  await explorer.tick();
  assert.deepEqual(explorer.state.revisions, { files: 1, changes: 0, history: 0 });
  await explorer.emit("main", null);
  await explorer.focus();
  await explorer.focus();
  await explorer.tick();
  assert.deepEqual(explorer.state.revisions, { files: 2, changes: 0, history: 0 });
  await explorer.render({ activeTab: "changes" });
  await explorer.emit("aux", "running", "failed-turn");
  await explorer.emit("aux", "error", "failed-turn");
  await explorer.tick();
  assert.deepEqual(explorer.state.revisions, { files: 2, changes: 1, history: 0 });
  await explorer.emit("main", "running", "canceled-turn");
  await explorer.emit("main", null);
  await explorer.tick();
  assert.deepEqual(explorer.state.revisions, { files: 2, changes: 2, history: 0 });
  await explorer.emit("aux", "error", "failed-turn");
  await explorer.emit("main", null);
  await explorer.tick();
  assert.equal(explorer.state.revisions.changes, 2);
  await explorer.emit("main", "running", "next-turn");
  await explorer.emit("main", "idle", "next-turn");
  await explorer.emit("aux", "running", "next-aux-turn");
  await explorer.emit("aux", "error", "next-aux-turn");
  await explorer.focus();
  await explorer.tick();
  assert.equal(explorer.state.revisions.changes, 3);
  assert.equal(explorer.snapshotReads, 0);
});

// @test-value v2
// kind = "invariant"
// claim = "非表示・無効化中は通知を発行せず、復帰はvisibleとして伝え、旧owner/tabで待機中の更新は新しい対象へ適用しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Agent の File Explorer 非表示と遅延応答" }
// fault = "hidden中に更新するか、旧ownerのtimerが別root/tabを更新し、復帰直後のfocusがactivation取得を重複する"
// observable = "hook consumerのvisibleとtab別revision"
// observation_boundary = "component-behavior"
// scope = "Finderのpane/Window可視性と通知timerのlifetime"
// lifecycle = "permanent"
// impact = "閉じたpaneでもGit readを続ける負荷や、別会話のイベントによる不要な再取得が発生する"
// distinction = "型・build・pane単体では検出できないdocument visibilityとReact lifecycleの競合を仮想timerで再現する"
// @end-test-value
test("非表示とowner/tab変更で待機更新を止め、復帰をpaneへ伝える", async (t) => {
  const explorer = await mount(t);
  await explorer.tick();
  await explorer.focus();
  await explorer.render({ activeTab: "history" });
  await explorer.tick();
  await explorer.focus();
  await explorer.render({ ownerKey: "new-roots", relatedSessionIds: ["new"] });
  await explorer.tick();
  await explorer.documentVisible(false);
  await explorer.emit("new", "idle");
  await explorer.focus();
  await explorer.tick();
  assert.equal(explorer.state.visible, false);
  assert.deepEqual(explorer.state.revisions, { files: 0, changes: 0, history: 0 });
  await explorer.documentVisible(true);
  await explorer.focus();
  await explorer.tick();
  assert.equal(explorer.state.visible, true);
  assert.equal(explorer.state.revisions.history, 0);
  await explorer.focus();
  await explorer.tick();
  assert.equal(explorer.state.revisions.history, 1);
  await explorer.render({ visible: false });
  await explorer.emit("new", "error", "later-turn");
  await explorer.focus();
  await explorer.tick();
  assert.equal(explorer.state.revisions.history, 1);
  await explorer.render({ visible: true, enabled: false });
  await explorer.tick();
  await explorer.focus();
  await explorer.emit("new", null);
  await explorer.tick();
  assert.equal(explorer.state.revisions.history, 1);
});
