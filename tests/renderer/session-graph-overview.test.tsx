import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { SessionGraphOverviewResult, SessionGraphTopicOverview } from "../../src-shared/session-graph/session-graph-ui-read-contract.js";
import { SessionGraphOverview, type SessionGraphOverviewState } from "../../src/session-graph/SessionGraphOverview.js";
import { SessionGraphPreview, type SessionGraphPreviewMemory } from "../../src/session-graph/SessionGraphPreview.js";
import type { SessionGraphViewState } from "../../src-shared/session-graph/session-graph-window-contract.js";
import type { SessionGraphRecord } from "../../src-shared/session-graph/session-graph-contract.js";

function topic(id: string): SessionGraphTopicOverview {
  const empty = () => ({ count: 0, states: {}, records: [] });
  return { id, title: `Topic ${id}`, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", recordCount: 0, recency: {}, requirements: empty(), constraints: empty(), decisions: empty(), activities: empty(), observations: empty(), issues: empty(), actors: [] };
}
async function withDom(run: (doc: Document, root: ReturnType<typeof createRoot>) => Promise<void>) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost" });
  const descriptors = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperties(globalThis, { window: { configurable: true, value: dom.window }, document: { configurable: true, value: dom.window.document }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true } });
  Object.defineProperties(dom.window.HTMLElement.prototype, { clientWidth: { configurable: true, get: () => 1024 }, clientHeight: { configurable: true, get: () => 600 } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try { await run(dom.window.document, root); }
  finally { await act(async () => root.unmount()); dom.window.close(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } }
}
const click = async (element: Element | null | undefined) => { assert.ok(element); await act(async () => (element as HTMLElement).click()); };

// @test-value v2
// kind = "contract"
// claim = "Overviewは全Topic pageを同一revisionで取得し、空Topicと古い未解決を含めて詳細へ到達できる"
// oracle = { type = "contract", ref = "docs/design/session-graph.md: 閲覧UI; issue #901" }
// fault = "先頭Topic pageや代表recordだけを全体として扱い、末尾の空Topicまたは古い未解決への導線を失う"
// observable = "Topic option件数、未解決record button、追加record取得revision、onOpenTopicのTopic/record ID"
// observation_boundary = "component-behavior"
// scope = "SessionGraphOverviewのoverview/topic_records読取とrecord遷移"
// lifecycle = "permanent"
// impact = "古い残件と空Topicを含む全体の現在地への到達を保護する"
// distinction = "Storage集約testや型検査ではrendererのpage統合と遷移を確認できない"
// @end-test-value
test("overview reaches all topic pages and records beyond category representatives", async () => {
  await withDom(async (doc, root) => {
    const topics = Array.from({ length: 201 }, (_, index) => topic(String(index)));
    const old = { id: "old", topicId: "0", kind: "issue" as const, title: "Old Unresolved Work", resolution: "open" as const, updatedAt: "2026-01-01T00:00:00Z" };
    topics[0].recordCount = 2; topics[0].issues = { count: 2, states: { "resolution:open": 2 }, records: [old] };
    const calls: Array<{ operation: string; request: Record<string, unknown> }> = [];
    const opened: string[][] = [];
    const api = { readSessionGraph: (async (_id: string, operation: string, request: Record<string, unknown>) => {
      calls.push({ operation, request }); const offset = Number(request.offset ?? 0);
      if (operation === "overview") return { status: "ok", revision: 3, items: topics.slice(offset, offset + 200), total: 201, offset, hasMore: offset === 0, incomplete: true, topicRelations: [], recency: {} };
      return { status: "ok", revision: 3, items: [old, { ...old, id: "another", title: "Another Unresolved Record" }], total: 2, offset: 0, hasMore: false, incomplete: false };
    }) as WithMateWindowApi["readSessionGraph"], subscribeSessionGraph: () => () => {} };
    await act(async () => root.render(<SessionGraphOverview api={api} sessionId="main" onOpenTopic={(topicId, recordId) => opened.push([topicId, recordId ?? ""])} />));
    assert.equal(doc.querySelectorAll("select option").length, 202);
    assert.deepEqual(calls[1], { operation: "overview", request: { limit: 200, offset: 200, expectedRevision: 3 } });
    await click(doc.querySelector(".topic-overview-card"));
    assert.match(doc.querySelector("aside")!.textContent!, /Old Unresolved Work/);
    await click([...doc.querySelectorAll("aside button")].find((item) => item.textContent === "Load More Records"));
    await click([...doc.querySelectorAll("aside button")].find((item) => item.textContent === "Another Unresolved Record"));
    assert.deepEqual(opened, [["0", "another"]]);
    assert.equal(calls.at(-1)?.request.expectedRevision, 3);
  });
});

// @test-value v2
// kind = "contract"
// claim = "Overviewのlive更新は選択・倍率・順序を保ち、Topic接続は方向を保持した元record双方へ辿れる"
// oracle = { type = "contract", ref = "docs/design/session-graph.md: 閲覧UI; issue #901" }
// fault = "新しさ更新でTopic配置順や選択を変えるか、集約線から一方のendpointへ移動できない"
// observable = "更新後のcard順、state.zoom/selectedTopicId、relation endpoint buttonからのonOpenTopic引数"
// observation_boundary = "component-behavior"
// scope = "SessionGraphOverview live readとTopic間relation詳細"
// lifecycle = "permanent"
// impact = "閲覧中の文脈と実際のrecord間関係の意味を保護する"
// distinction = "layout単体やStorage relation testではUI選択状態と詳細遷移を検証できない"
// @end-test-value
test("overview preserves navigation on updates and opens both directed relation endpoints", async () => {
  await withDom(async (doc, root) => {
    let revision = 1; let notify = (_id: string) => {}; let state: SessionGraphOverviewState | undefined;
    const opened: string[][] = [];
    const edge = { fromTopicId: "a", toTopicId: "b", kind: "depends_on" as const, count: 1 };
    const api = { readSessionGraph: (async (_id: string, operation: string) => {
      if (operation === "overview") return { status: "ok", revision, items: revision === 1 ? [topic("a"), topic("b")] : [topic("b"), topic("a")], total: 2, offset: 0, hasMore: false, incomplete: false, topicRelations: [edge], recency: {} } satisfies SessionGraphOverviewResult;
      return { status: "ok", revision, items: [{ id: "rel", fromId: "from", toId: "to", kind: "depends_on" }], total: 1, offset: 0, hasMore: false, incomplete: false, endpoints: [{ id: "from", topicId: "a", title: "Dependent Work", kind: "activity" }, { id: "to", topicId: "b", title: "Required Decision", kind: "decision" }] };
    }) as WithMateWindowApi["readSessionGraph"], subscribeSessionGraph: (callback: (id: string) => void) => { notify = callback; return () => {}; } };
    await act(async () => root.render(<SessionGraphOverview api={api} sessionId="main" onStateChange={(value) => { state = value; }} onOpenTopic={(topicId, recordId) => opened.push([topicId, recordId ?? ""])} />));
    await click(doc.querySelector(".topic-overview-card")); await click(doc.querySelector("button[aria-label='Zoom In']"));
    revision = 2; await act(async () => notify("main"));
    assert.equal(state?.selectedTopicId, "a"); assert.equal(state?.zoom, 1.1);
    assert.deepEqual([...doc.querySelectorAll(".topic-overview-card strong")].map((item) => item.textContent), ["Topic a", "Topic b"]);
    await click(doc.querySelector(".topic-overview-relation"));
    assert.match(doc.querySelector("aside")!.textContent!, /Specific Records/);
    await click([...doc.querySelectorAll("aside button")].find((item) => item.textContent === "Dependent Work"));
    await click([...doc.querySelectorAll("aside button")].find((item) => item.textContent === "Required Decision"));
    assert.deepEqual(opened, [["a", "from"], ["b", "to"]]);
  });
});

// @test-value v2
// kind = "contract"
// claim = "実寸とscroll上限のあるwrapper往復・再mountは計測後のOverview配置・選択・倍率・scrollを保持する"
// oracle = { type = "contract", ref = "docs/design/session-graph.md: 閲覧UI; issue #901" }
// fault = "未計測layoutでcached配置を上書きするか、暫定sceneでscrollをclampして復元済みとして保存する"
// observable = "record詳細本文、往復・再mount後のcard座標、Topic選択・zoom出力・上限付きviewport scroll、公開state"
// observation_boundary = "component-behavior"
// scope = "SessionGraphPreviewからOverview/TopicViewへの遷移とstate/memory再利用"
// lifecycle = "permanent"
// impact = "Graphの詳細閲覧や中央表示の開閉で利用者の閲覧位置を失わせない"
// distinction = "Overview単体testではwrapperによるstate/memory伝播とTopicViewとの切替を確認できない"
// @end-test-value
test("preview restores overview navigation across record detail and remount", async () => {
  await withDom(async (doc, root) => {
    const scrolls = new WeakMap<HTMLElement, { left: number; top: number }>();
    const prototype = doc.defaultView!.HTMLElement.prototype;
    Object.defineProperties(prototype, {
      clientWidth: { configurable: true, get(this: HTMLElement) { return this.classList.contains("session-graph-viewport") ? 600 : 1440; } },
      clientHeight: { configurable: true, get(this: HTMLElement) { return this.classList.contains("session-graph-viewport") ? 200 : 1000; } },
      scrollLeft: { configurable: true, get(this: HTMLElement) { return scrolls.get(this)?.left ?? 0; }, set(this: HTMLElement, value: number) { const current = scrolls.get(this) ?? { left: 0, top: 0 }; const width = parseFloat(this.querySelector<HTMLElement>(".session-graph-space")?.style.width ?? "0"); current.left = Math.max(0, Math.min(value, Math.max(0, width - this.clientWidth))); scrolls.set(this, current); } },
      scrollTop: { configurable: true, get(this: HTMLElement) { return scrolls.get(this)?.top ?? 0; }, set(this: HTMLElement, value: number) { const current = scrolls.get(this) ?? { left: 0, top: 0 }; const height = parseFloat(this.querySelector<HTMLElement>(".session-graph-space")?.style.height ?? "0"); current.top = Math.max(0, Math.min(value, Math.max(0, height - this.clientHeight))); scrolls.set(this, current); } },
    });
    prototype.getBoundingClientRect = function () { return { x: 0, y: 0, left: 0, top: 0, right: 180, bottom: 26, width: 180, height: 26, toJSON: () => ({}) }; };
    const updatedAt = "2026-01-01T00:00:00Z";
    const identity = { sessionId: "main", sessionTitle: "Main", role: "main" as const };
    const record: SessionGraphRecord = { id: "requirement", topicId: "a", kind: "requirement", title: "Required Outcome", detail: "Requirement Detail Body", scope: "Overview Navigation", references: [], actor: { sessionId: "main" }, origin: { type: "user" }, actorSnapshot: identity, recordedBy: identity, createdAt: updatedAt, updatedAt };
    const first = topic("a"); first.recordCount = 1; first.latestRecordUpdatedAt = updatedAt;
    first.requirements = { count: 1, states: {}, records: [record] };
    const recency = { oldestUpdatedAt: updatedAt, newestUpdatedAt: updatedAt };
    let state: SessionGraphViewState | undefined;
    let memory: SessionGraphPreviewMemory | undefined;
    const api = { readSessionGraph: (async (_id: string, operation: string) => {
      if (operation === "overview") return { status: "ok", revision: 1, items: [first, ...Array.from({ length: 11 }, (_, index) => topic(String(index)))], total: 12, offset: 0, hasMore: false, incomplete: false, recency, topicRelations: [{ fromTopicId: "a", toTopicId: "0", kind: "depends_on", count: 1 }] };
      if (operation === "list_topics") return { status: "ok", revision: 1, items: [first, topic("b")], total: 2, offset: 0, hasMore: false, incomplete: false };
      return { status: "ok", revision: 1, items: [record], total: 1, offset: 0, hasMore: false, incomplete: false, recency, relations: [], externalEndpoints: [], relationsTruncated: false, relationOffset: 0, relationsHasMore: false };
    }) as WithMateWindowApi["readSessionGraph"], subscribeSessionGraph: () => () => {} };
    const render = (key: string, initialState?: SessionGraphViewState, initialMemory?: SessionGraphPreviewMemory) => <SessionGraphPreview key={key} api={api} sessionId="main" onOpenPath={() => {}} initialState={initialState} initialMemory={initialMemory} onStateChange={(value) => { state = value; }} onMemoryChange={(value) => { memory = value; }} />;
    await act(async () => root.render(render("initial")));
    await click(doc.querySelector(".topic-overview-card"));
    await click(doc.querySelector("button[aria-label='Zoom In']"));
    const viewport = doc.querySelector<HTMLDivElement>("[aria-label='Topic Graph Canvas']")!;
    await act(async () => { viewport.scrollLeft = 91; viewport.scrollTop = 137; viewport.dispatchEvent(new doc.defaultView!.Event("scroll", { bubbles: true })); });
    assert.deepEqual(state?.overview, { selectedTopicId: "a", zoom: 1.1, scrollLeft: 91, scrollTop: 137 });
    const cardPositions = () => [...doc.querySelectorAll<HTMLElement>(".topic-overview-card")].map((card) => [card.style.left, card.style.top]);
    const positions = cardPositions();
    await click([...doc.querySelectorAll("aside button")].find((item) => item.textContent === "Required Outcome"));
    assert.match(doc.querySelector(".session-graph-details")?.textContent ?? "", /Requirement Detail Body/);
    assert.equal(state?.topicId, "a"); assert.equal(state?.selectedId, "requirement");
    await click(doc.querySelector("button[aria-label='All Topics']"));
    const assertOverview = () => {
      assert.equal(doc.querySelector<HTMLSelectElement>("select[aria-label='Select Topic']")?.value, "a");
      assert.equal(doc.querySelector(".topic-overview-footer output")?.textContent, "110%");
      const restored = doc.querySelector<HTMLDivElement>("[aria-label='Topic Graph Canvas']")!;
      assert.equal(restored.scrollLeft, 91); assert.equal(restored.scrollTop, 137);
      assert.deepEqual(state?.overview, { selectedTopicId: "a", zoom: 1.1, scrollLeft: 91, scrollTop: 137 });
      assert.deepEqual(cardPositions(), positions);
    };
    assertOverview();
    const savedState = state; const savedMemory = memory;
    assert.ok(savedState); assert.ok(savedMemory?.overview);
    await act(async () => root.render(null));
    await act(async () => root.render(render("reopened", savedState, savedMemory)));
    assertOverview();
  });
});

// @test-value v2
// kind = "contract"
// claim = "revision変更後の関係取得失敗では旧endpoint/labelを操作できず、record追加pageも新revisionの代表へ切り替わる"
// oracle = { type = "contract", ref = "docs/design/session-graph.md: 同一revisionの読取統合" }
// fault = "古いrelationPageまたはrecord pageを新overviewへ混在表示する"
// observable = "関係失敗時の未確認表示と旧button/label不在、再試行後の新endpoint、record更新後の追加page内容"
// observation_boundary = "component-behavior"
// scope = "SessionGraphOverview relationとcategory pageのrevision境界"
// lifecycle = "permanent"
// impact = "解除・移動済み関係を現行接続として辿る誤操作を防ぐ"
// distinction = "storageのrevision検査ではrendererが保持済みpageを描画する欠陥を検出できない"
// @end-test-value
test("overview quarantines old relation and record pages after revision changes", async () => {
  await withDom(async (doc, root) => {
    let revision = 1; let failRelations = false; let notify = (_id: string) => {};
    const first = topic("a");
    const summary = { id: "representative", topicId: "a", kind: "issue" as const, title: "Current Issue", updatedAt: "2026-01-01T00:00:00Z" };
    first.issues = { count: 2, states: {}, records: [summary] };
    const api = { readSessionGraph: (async (_id: string, operation: string) => {
      if (operation === "overview") return { status: "ok", revision, items: [first, topic("b")], total: 2, offset: 0, hasMore: false, incomplete: false, recency: {}, topicRelations: [{ fromTopicId: "a", toTopicId: "b", kind: "supports", count: 1 }] };
      if (operation === "topic_records") return { status: "ok", revision, items: [summary, { ...summary, id: "extra", title: "Old Extra Record" }], total: 2, offset: 0, hasMore: false, incomplete: false };
      if (failRelations) throw new Error("Relation Read Failed");
      return { status: "ok", revision, items: [{ id: "rel", fromId: "from", toId: "to", kind: "supports", label: revision === 1 ? "Old Relation Label" : "New Relation Label" }], total: 1, offset: 0, hasMore: false, incomplete: false, endpoints: [{ id: "from", topicId: "a", title: revision === 1 ? "Old Endpoint" : "New Endpoint", kind: "activity" }, { id: "to", topicId: "b", title: "Target", kind: "decision" }] };
    }) as WithMateWindowApi["readSessionGraph"], subscribeSessionGraph: (callback: (id: string) => void) => { notify = callback; return () => {}; } };
    await act(async () => root.render(<SessionGraphOverview api={api} sessionId="main" onOpenTopic={() => {}} />));
    await click(doc.querySelector(".topic-overview-relation"));
    assert.match(doc.querySelector("aside")!.textContent!, /Old Endpoint/);
    revision = 2; failRelations = true; await act(async () => notify("main"));
    assert.match(doc.querySelector("aside")!.textContent!, /Record Relations Are Unconfirmed/);
    assert.doesNotMatch(doc.querySelector("aside")!.textContent!, /Old Endpoint|Old Relation Label/);
    failRelations = false;
    await click([...doc.querySelectorAll("aside button")].find((button) => button.textContent === "Load More Relations"));
    assert.match(doc.querySelector("aside")!.textContent!, /New Endpoint/);
    await click(doc.querySelector("button[aria-label='Close Topic Summary']"));
    await click(doc.querySelector(".topic-overview-card"));
    await click([...doc.querySelectorAll("aside button")].find((button) => button.textContent === "Load More Records"));
    assert.match(doc.querySelector("aside")!.textContent!, /Old Extra Record/);
    revision = 3; await act(async () => notify("main"));
    assert.match(doc.querySelector("aside")!.textContent!, /Current Issue/);
    assert.doesNotMatch(doc.querySelector("aside")!.textContent!, /Old Extra Record/);
  });
});

// @test-value v2
// kind = "contract"
// claim = "狭幅でTopic/relation/selectから開いた詳細へfocusを移し、dismissで操作元へ戻し、live更新ではfocusを奪わない"
// oracle = { type = "contract", ref = "docs/design/session-graph.md: 狭幅詳細とkeyboard操作; docs/design/ui-design-guidelines.md: 操作とアクセシビリティ" }
// fault = "focusをinert canvasへ残すか、dismissで別controlへ戻すか、更新ごとに見出しへ戻す"
// observable = "各操作直後・更新後・Escape後のdocument.activeElementとcanvasのinert属性"
// observation_boundary = "component-behavior"
// scope = "600px幅SessionGraphOverviewの詳細focus lifecycle"
// lifecycle = "permanent"
// impact = "狭幅keyboard利用で操作不能な背面へfocusが残ることを防ぐ"
// distinction = "型検査や静的ARIA検査では操作元に依存するfocus移動を検証できない"
// @end-test-value
test("narrow overview moves detail focus and restores each actual trigger", async () => {
  await withDom(async (doc, root) => {
    Object.defineProperties(doc.defaultView!.HTMLElement.prototype, { clientWidth: { configurable: true, get: () => 600 }, clientHeight: { configurable: true, get: () => 400 } });
    let revision = 1; let notify = (_id: string) => {};
    const api = { readSessionGraph: (async (_id: string, operation: string) => operation === "overview" ? { status: "ok", revision, items: [topic("a"), topic("b")], total: 2, offset: 0, hasMore: false, incomplete: false, recency: {}, topicRelations: [{ fromTopicId: "a", toTopicId: "b", kind: "related", count: 1 }] } : { status: "ok", revision, items: [], total: 0, offset: 0, hasMore: false, incomplete: false, endpoints: [] }) as WithMateWindowApi["readSessionGraph"], subscribeSessionGraph: (callback: (id: string) => void) => { notify = callback; return () => {}; } };
    await act(async () => root.render(<SessionGraphOverview api={api} sessionId="main" onOpenTopic={() => {}} />));
    const escape = async () => { await act(async () => doc.querySelector("aside")!.dispatchEvent(new doc.defaultView!.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); };
    const card = doc.querySelector<HTMLButtonElement>(".topic-overview-card")!;
    card.focus(); await click(card);
    assert.equal(doc.activeElement, doc.querySelector("aside h2"));
    assert.equal(doc.querySelector(".session-graph-column")?.hasAttribute("inert"), true);
    const close = doc.querySelector<HTMLButtonElement>("button[aria-label='Close Topic Summary']")!;
    close.focus(); revision = 2; await act(async () => notify("main"));
    assert.equal(doc.activeElement, close);
    await escape(); assert.equal(doc.activeElement, card);
    const relation = doc.querySelector<HTMLButtonElement>(".topic-overview-relation")!;
    relation.focus(); await click(relation);
    assert.equal(doc.activeElement, doc.querySelector("aside h2"));
    await escape(); assert.equal(doc.activeElement, relation);
    const select = doc.querySelector<HTMLSelectElement>("select[aria-label='Select Topic']")!;
    select.focus(); await act(async () => { select.value = "b"; select.dispatchEvent(new doc.defaultView!.Event("change", { bubbles: true })); });
    assert.equal(doc.activeElement, doc.querySelector("aside h2"));
    await escape(); assert.equal(doc.activeElement, select);
    card.focus(); await click(card);
    await click(doc.querySelector(".topic-overview-related"));
    assert.equal(doc.activeElement, doc.querySelector("aside h2"));
    await escape();
    assert.equal(doc.activeElement, doc.querySelector(".topic-overview-related"));
    await escape(); assert.equal(doc.activeElement, card);
  });
});
