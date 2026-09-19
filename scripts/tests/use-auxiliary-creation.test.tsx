import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { AuxiliaryCreationRequest, AuxiliarySession } from "../../src/auxiliary-session-state.js";
import { useAuxiliaryCreation } from "../../src/chat/use-auxiliary-creation.js";
import { AuxiliaryLaunchProviderDialog } from "../../src/chat/AuxiliaryLaunchProviderDialog.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const context = { generationId: "generation-1", parentIncarnationId: "parent-incarnation" };
const request: AuxiliaryCreationRequest = { parentSessionId: "parent-1", clientRequestId: "request-1", creationContext: context };
const savedFor = (candidate: AuxiliaryCreationRequest) => ({ id: "aux-1", ...candidate }) as AuxiliarySession;
type Api = NonNullable<Parameters<typeof useAuxiliaryCreation>[0]["api"]>;

async function mount(t: TestContext, api: Api) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/" });
  const properties = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = Object.keys(properties).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(properties)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = createRoot(dom.window.document.getElementById("root")!);
  let state!: ReturnType<typeof useAuxiliaryCreation>;
  const applied: AuxiliarySession[] = [];
  function Harness({ parent }: { parent: string | null }) {
    state = useAuxiliaryCreation({ parentSessionId: parent, api, onCommitted: (session) => applied.push(session), onFeedback: () => undefined });
    return <AuxiliaryLaunchProviderDialog open providers={[{ id: "codex", label: "Codex" }]}
      selectedProviderId="codex" feedback="" starting={state.starting} creationInFlight={state.inFlight}
      onClose={() => undefined} onSelectProvider={() => undefined} onStart={() => { void state.start("codex"); }} />;
  }
  const render = async (parent: string | null) => { await act(async () => root.render(<Harness parent={parent} />)); };
  t.after(async () => {
    await act(async () => root.unmount());
    t.mock.timers.reset();
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { render, get state() { return state; }, applied, storage: dom.window.localStorage,
    get startButton() { return dom.window.document.querySelector<HTMLButtonElement>(".start-session-button")!; },
    poll: async () => { await act(async () => { t.mock.timers.tick(500); }); } };
}

function apiWith(overrides: Partial<Api> = {}): Api {
  return {
    getAuxiliaryCreationContext: async () => context,
    createAuxiliarySession: async (input) => savedFor(input as AuxiliaryCreationRequest),
    getAuxiliaryCreation: async () => ({ status: "preparing" }),
    cancelAuxiliaryCreation: async () => ({ status: "cancelled" }),
    getAuxiliarySession: async () => savedFor(request),
    ...overrides,
  };
}

// @test-value v2
// kind = "regression"
// claim = "親切替後のcontextまたはcreate応答は新しい親の要求・表示を上書きしない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#ui-flow" }
// fault = "旧contextから作成を発行するか、旧create応答で別親のUIへSessionを追加する"
// observable = "実React hookのcreate呼出し、starting/status、適用Session一覧"
// observation_boundary = "component-behavior"
// scope = "auxiliary-creation-renderer-lifecycle"
// lifecycle = "permanent"
// impact = "別Sessionへの誤表示と処理中表示の上書きを防ぐ"
// distinction = "request比較だけの単体testと異なりrender/effectと非同期応答の順序を制御する"
// @end-test-value
test("Auxiliary creation rejects old parent responses across context and create waits", async (t) => {
  const pendingContext = deferred<typeof context>();
  const pendingCreate = deferred<AuxiliarySession>();
  const creates: string[] = [];
  const fixture = await mount(t, apiWith({
    getAuxiliaryCreationContext: (parent) => parent === "parent-1" ? pendingContext.promise : Promise.resolve(context),
    createAuxiliarySession: (input) => { creates.push(input.parentSessionId); return pendingCreate.promise; },
  }));
  await fixture.render("parent-1");
  let first!: Promise<void>;
  await act(async () => { first = fixture.state.start("codex"); });
  await fixture.render("parent-2");
  await act(async () => { pendingContext.resolve(context); await first; });
  assert.deepEqual(creates, []);
  let second!: Promise<void>;
  await act(async () => { second = fixture.state.start("codex"); });
  assert.deepEqual(creates, ["parent-2"]);
  const oldRequest = JSON.parse(fixture.storage.getItem("withmate:auxiliary-creation:parent-2")!) as AuxiliaryCreationRequest;
  await fixture.render("parent-3");
  await act(async () => { pendingCreate.resolve(savedFor(oldRequest)); await second; });
  assert.deepEqual(fixture.applied, []);
  assert.equal(fixture.state.starting, false);
  assert.equal(fixture.state.status, null);
});

// @test-value v2
// kind = "contract"
// claim = "再表示したunknown要求は同じIDで照会し、詳細適用まで開始を無効にして一度だけ回復しpollを止める"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#ui-flow" }
// fault = "status更新effect cleanupが回復結果を捨てるか、確定後も定期照会でSessionを再適用する"
// observable = "照会ID列、create呼出し数、実dialogの開始button.disabled、適用Session数、localStorageのhint、確定後query数"
// observation_boundary = "component-behavior"
// scope = "auxiliary-creation-renderer-recovery"
// lifecycle = "permanent"
// impact = "応答を失った作成結果を二重作成せず回復し、利用者の現在画面を繰り返し変更しない"
// distinction = "実hookのeffectと仮想timerを通し、DB応答待ちの再描画とpoll終了を観測する"
// @end-test-value
test("Auxiliary reopen recovers unknown commit once and stops polling", async (t) => {
  const pendingSession = deferred<AuxiliarySession>();
  const queries: string[] = [];
  let creates = 0;
  const fixture = await mount(t, apiWith({
    createAuxiliarySession: async () => { creates += 1; return savedFor(request); },
    getAuxiliaryCreation: async (candidate) => {
      queries.push(candidate.clientRequestId);
      return queries.length === 1 ? { status: "unknown" } : { status: "committed", auxiliarySessionId: "aux-1" };
    },
    getAuxiliarySession: () => pendingSession.promise,
  }));
  fixture.storage.setItem("withmate:auxiliary-creation:parent-1", JSON.stringify(request));
  await fixture.render("parent-1");
  await fixture.poll();
  assert.equal(fixture.state.status, "unknown");
  await act(async () => { await fixture.state.start("codex"); });
  assert.equal(creates, 0);
  await fixture.poll();
  assert.equal(fixture.state.status, "committed");
  assert.equal(fixture.state.starting, false);
  assert.equal(fixture.startButton.disabled, true);
  await act(async () => { fixture.startButton.click(); });
  assert.equal(creates, 0);
  assert.deepEqual(fixture.applied, []);
  await act(async () => { pendingSession.resolve(savedFor(request)); });
  assert.deepEqual(fixture.applied, [savedFor(request)]);
  assert.equal(fixture.storage.getItem("withmate:auxiliary-creation:parent-1"), null);
  assert.equal(fixture.startButton.disabled, false);
  await fixture.poll();
  assert.deepEqual(queries, [request.clientRequestId, request.clientRequestId]);
  assert.equal(fixture.applied.length, 1);
});

// @test-value v2
// kind = "contract"
// claim = "cancelがcommitに負けた場合は作成結果を一度だけ適用し、遅いcreate失敗でunknownへ戻さない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence" }
// fault = "取消意図がcommit済み結果を隠す、または古いcreate finally/catchが確定後の状態を破壊する"
// observable = "cancel APIの要求、hook status、適用Session数と確定後poll停止"
// observation_boundary = "component-behavior"
// scope = "auxiliary-creation-renderer-cancel"
// lifecycle = "permanent"
// impact = "作成済みAuxiliaryを取消済み・失敗と誤表示して再送することを防ぐ"
// distinction = "backend cancel応答とcreate promiseの先後を実React hook経由で検証する"
// @end-test-value
test("Auxiliary commit wins over cancel and late create failure", async (t) => {
  const pendingCreate = deferred<AuxiliarySession>();
  let submitted!: AuxiliaryCreationRequest;
  const cancels: string[] = [];
  const fixture = await mount(t, apiWith({
    createAuxiliarySession: (input) => { submitted = input as AuxiliaryCreationRequest; return pendingCreate.promise; },
    cancelAuxiliaryCreation: async (candidate) => { cancels.push(candidate.clientRequestId); return { status: "committed", auxiliarySessionId: "aux-1" }; },
    getAuxiliarySession: async () => savedFor(submitted),
  }));
  await fixture.render("parent-1");
  let pending!: Promise<void>;
  await act(async () => { pending = fixture.state.start("codex"); });
  await act(async () => { await fixture.state.cancel(); });
  assert.deepEqual(cancels, [submitted.clientRequestId]);
  assert.equal(fixture.state.status, "committed");
  assert.equal(fixture.applied.length, 1);
  await act(async () => { pendingCreate.reject(new Error("lost response")); await pending; });
  await fixture.poll();
  assert.equal(fixture.state.status, "committed");
  assert.equal(fixture.state.starting, false);
  assert.equal(fixture.state.cancelling, false);
  assert.equal(fixture.applied.length, 1);
});
