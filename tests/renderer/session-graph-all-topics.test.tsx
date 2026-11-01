import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { SessionGraphRecord, SessionGraphRelation } from "../../src-shared/session-graph/session-graph-contract.js";
import type { SessionGraphTopicOverview } from "../../src-shared/session-graph/session-graph-ui-read-contract.js";
import type { SessionGraphViewState } from "../../src-shared/session-graph/session-graph-window-contract.js";
import { SessionGraphPreview, type SessionGraphPreviewMemory } from "../../src/session-graph/SessionGraphPreview.js";

const updatedAt = "2026-10-20T00:00:00Z";
const identity = { sessionId: "main", sessionTitle: "Main", role: "main" as const };
function record(id: string, topicId = "a", kind: SessionGraphRecord["kind"] = "activity"): SessionGraphRecord {
  return { id, topicId, kind, title: `Record ${id}`, detail: `Body ${id}`, scope: "Graph Test", references: [],
    actor: { sessionId: "main" }, origin: { type: "agent" }, actorSnapshot: identity, recordedBy: identity,
    ...(kind === "issue" ? { resolution: "open" as const } : {}), createdAt: updatedAt, updatedAt };
}
function topic(id: string, records: SessionGraphRecord[]): SessionGraphTopicOverview {
  const items = records.filter((item) => item.topicId === id);
  const group = () => ({ count: 0, states: {}, records: [] });
  return { id, title: `Topic ${id}`, createdAt: updatedAt, updatedAt, recordCount: items.length, latestRecordUpdatedAt: items.length ? updatedAt : undefined,
    recency: items.length ? { oldestUpdatedAt: updatedAt, newestUpdatedAt: updatedAt } : {},
    requirements: group(), constraints: group(), decisions: group(), activities: group(), observations: group(), issues: group(), actors: [] };
}
function fixture(records: SessionGraphRecord[], ids = ["a", "b", "empty"], relations: SessionGraphRelation[] = []) {
  const topics = ids.map((id) => topic(id, records));
  const calls: Array<{ operation: string; request: Record<string, unknown> }> = [];
  let revision = 1;
  let failRecent = false;
  let notify = (_id: string) => {};
  const api = {
    readSessionGraph: (async (_id: string, operation: string, request: Record<string, unknown>) => {
      calls.push({ operation, request });
      if (request.expectedRevision !== undefined && request.expectedRevision !== revision || operation === "recent" && failRecent) return { status: "conflict", revision };
      const offset = Number(request.offset ?? 0), limit = Number(request.limit ?? 40);
      if (operation === "overview" || operation === "list_topics") return { status: "ok", revision, items: topics.slice(offset, offset + limit), total: topics.length,
        offset, hasMore: offset + limit < topics.length, incomplete: false, topicRelations: [], recency: {} };
      const source = operation === "get" ? records.filter((item) => (request.ids as string[]).includes(item.id))
        : operation === "get_topic_view" ? records.filter((item) => item.topicId === request.topicId) : records;
      const items = source.slice(offset, offset + limit), visible = new Set(items.map((item) => item.id));
      const edges = relations.filter((edge) => visible.has(edge.fromId) || visible.has(edge.toId));
      return { status: "ok", revision, items, total: source.length, offset, hasMore: offset + items.length < source.length,
        incomplete: false, relations: edges, externalEndpoints: records.filter((item) => !visible.has(item.id)), relationsTruncated: false,
        relationOffset: 0, relationsHasMore: false, recency: { oldestUpdatedAt: updatedAt, newestUpdatedAt: updatedAt } };
    }) as WithMateWindowApi["readSessionGraph"],
    subscribeSessionGraph: (listener: (id: string) => void) => { notify = listener; return () => {}; },
  };
  return { api, calls, topics, update(fail = false) { revision += 1; failRecent = fail; notify("main"); } };
}
async function withDom(run: (doc: Document, root: Root) => Promise<void>, width = 1440) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) { this.callback([{ target, contentRect: { ...target.getBoundingClientRect(), width: target.clientWidth, height: target.clientHeight } }] as ResizeObserverEntry[], this as unknown as ResizeObserver); }
      disconnect() {}
      unobserve() {}
    },
  };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const prototype = dom.window.HTMLElement.prototype;
  Object.defineProperties(prototype, { clientWidth: { configurable: true, get: () => width }, clientHeight: { configurable: true, get: () => 700 } });
  prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 120, bottom: 26, width: 120, height: 26, toJSON: () => ({}) });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try { await run(dom.window.document, root); }
  finally { await act(async () => root.unmount()); dom.window.close(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } }
}
async function click(element: Element | undefined | null) { assert.ok(element); await act(async () => (element as HTMLElement).click()); }
const node = (doc: Document, id: string) => [...doc.querySelectorAll(".session-graph-node")].find((item) => item.querySelector(".session-graph-node-title")?.textContent === `Record ${id}`);

// @test-value v2
// kind = "contract"
// claim = "All Topicsは空Topicを含む所属のまとまりと実record間の有向関係を図示し、record選択後も全体範囲を保つ"
// oracle = { type = "contract", ref = "docs/design/session-graph.md: 閲覧UI" }
// fault = "Topicをリンクのみにする、Topic間の保存済み関係を落とす、またはrecord選択でTopic単独へ切り替える"
// observable = "Topic帯の名称、record nodeの種類・状態、関係labelと矢印marker、選択後の公開topicIdと本文"
// observation_boundary = "component-behavior"
// scope = "SessionGraphPreviewのAll Topics描画とrecord詳細"
// lifecycle = "permanent"
// impact = "要求・作業・未解決のつながりを全体の図から辿れなくなる"
// distinction = "Storageとlayout単体testは全体表示の実record描画と選択経路を検証できない"
// @end-test-value
test("all topics draws record relationships and opens one record without leaving the graph", async () => {
  await withDom(async (doc, root) => {
    const f = fixture([record("work"), record("old", "b", "issue")], undefined, [{ id: "dependency", fromId: "work", toId: "old", kind: "depends_on", label: "Needs Investigation" }]);
    let state: SessionGraphViewState | undefined;
    await act(async () => root.render(<SessionGraphPreview api={f.api} sessionId="main" onOpenPath={() => {}} onStateChange={(value) => { state = value; }} />));
    assert.deepEqual([...doc.querySelectorAll(".session-graph-topic-heading button")].map((item) => item.textContent), ["Topic a", "Topic b", "Topic empty"]);
    assert.match(doc.querySelector(".session-graph-topic-empty")!.textContent!, /No Records/);
    assert.match(node(doc, "old")!.textContent!, /Issue · Unresolved/);
    assert.equal(doc.querySelector("[data-relation-id='dependency']")?.textContent, "Needs Investigation");
    assert.equal(doc.querySelector("[data-relation-id='dependency']")?.getAttribute("title"), "Depends On: Record work → Record old");
    assert.equal(doc.querySelectorAll(".session-graph-edges path[marker-end]").length, 1);
    await click(node(doc, "old"));
    assert.equal(state?.topicId, null);
    assert.equal(state?.selectedId, "old");
    assert.match(doc.querySelector("aside")!.textContent!, /Body old/);
    assert.equal(doc.querySelectorAll(".session-graph-topic-band").length, 3);
    assert.ok(node(doc, "work")!.classList.contains("is-connected"));
  });
});

// @test-value v2
// kind = "contract"
// claim = "All Topicsは全Topic pageとrecord追加pageをrevision付きで辿り、古い未解決と未取得Topicへの到達を保つ"
// oracle = { type = "contract", ref = "docs/design/session-graph.md: 閲覧UI" }
// fault = "先頭pageを全体と誤認し、末尾の空Topicまたは代表外の古い未解決recordへ到達できない"
// observable = "Topic option総数、Topic/record pageのoffsetとexpectedRevision、追加後の未解決nodeと本文"
// observation_boundary = "component-behavior"
// scope = "All Topicsのoverview/recent page統合"
// lifecycle = "permanent"
// impact = "全体の図から古い残件を見落とす"
// distinction = "公開MCPやStorageのpage testではrendererの取得範囲統合を保証できない"
// @end-test-value
test("all topics reaches every topic and older records through revision-bound pages", async () => {
  await withDom(async (doc, root) => {
    const records = [...Array.from({ length: 40 }, (_, i) => record(String(i))), record("old", "b", "issue")];
    const f = fixture(records, ["a", "b", ...Array.from({ length: 199 }, (_, i) => `empty${i}`)]);
    await act(async () => root.render(<SessionGraphPreview api={f.api} sessionId="main" onOpenPath={() => {}} />));
    assert.equal(doc.querySelectorAll("select option").length, 202);
    assert.deepEqual(f.calls[1], { operation: "overview", request: { limit: 200, offset: 200, expectedRevision: 1 } });
    assert.match(doc.querySelector(".session-graph-record-status")!.textContent!, /40 \/ 41 Records Loaded/);
    assert.match([...doc.querySelectorAll(".session-graph-topic-band")].find((item) => item.getAttribute("aria-label") === "Topic b")!.textContent!, /Records Not Loaded/);
    await click(doc.querySelector(".session-graph-load-more"));
    assert.ok(node(doc, "old"));
    assert.ok(f.calls.some((call) => call.operation === "recent" && call.request.offset === 40 && call.request.expectedRevision === 1));
    await click(node(doc, "old"));
    assert.match(doc.querySelector("aside")!.textContent!, /Body old/);
  });
});

// @test-value v2
// kind = "contract"
// claim = "Topic単独表示との往復とGraph再mountで全体の選択record・倍率・位置を復元し、別Windowにも初期値を渡す"
// oracle = { type = "contract", ref = "docs/design/session-graph.md: 閲覧UI" }
// fault = "Topicへのfocusや再mountで全体の閲覧位置または選択を失う"
// observable = "復帰後の公開state、倍率、scroll、record座標、選択本文、別Windowへ渡すoverview state"
// observation_boundary = "component-behavior"
// scope = "SessionGraphPreviewの全体/Topic状態とmemory"
// lifecycle = "permanent"
// impact = "詳細な話題を見た後に全体の文脈へ戻れない"
// distinction = "TopicView単体のnavigation testではwrapperによる両範囲の状態保持を検証できない"
// @end-test-value
test("all topics restores its selection zoom and position after topic focus and remount", async () => {
  await withDom(async (doc, root) => {
    const f = fixture(Array.from({ length: 24 }, (_, i) => record(String(i))));
    let state: SessionGraphViewState | undefined, memory: SessionGraphPreviewMemory | undefined;
    let windowState: SessionGraphViewState | undefined;
    const render = (key: string, initialState?: SessionGraphViewState, initialMemory?: SessionGraphPreviewMemory) => <SessionGraphPreview key={key} api={f.api} sessionId="main" onOpenPath={() => {}} initialState={initialState} initialMemory={initialMemory} onOpenWindow={(value) => { windowState = value; }} onStateChange={(value) => { state = value; }} onMemoryChange={(value) => { memory = value; }} />;
    await act(async () => root.render(render("first")));
    await click(doc.querySelector("[aria-label='Zoom In']"));
    await click(node(doc, "2"));
    const viewport = doc.querySelector<HTMLElement>(".session-graph-viewport")!;
    await act(async () => { viewport.scrollLeft = 40; viewport.scrollTop = 120; viewport.dispatchEvent(new doc.defaultView!.Event("scroll")); });
    const positions = [...doc.querySelectorAll<HTMLElement>(".session-graph-node")].map((item) => [item.style.left, item.style.top]);
    await click(doc.querySelector("[aria-label='Focus Topic: Topic a']"));
    assert.equal(state?.topicId, "a");
    await act(async () => node(doc, "2")!.dispatchEvent(new doc.defaultView!.MouseEvent("click", { ctrlKey: true, bubbles: true })));
    assert.equal(windowState?.topicId, "a"); assert.equal(windowState?.selectedId, "2");
    assert.deepEqual(windowState?.overview, { selectedId: "2", zoom: 1.1, scrollLeft: 40, scrollTop: 120 });
    await click(doc.querySelector("[aria-label='All Topics']"));
    const assertRestored = () => {
      assert.equal(state?.topicId, null); assert.equal(state?.selectedId, "2"); assert.equal(state?.zoom, 1.1);
      assert.equal(doc.querySelector<HTMLElement>(".session-graph-viewport")!.scrollTop, 120);
      assert.equal(doc.querySelector<HTMLElement>(".session-graph-viewport")!.scrollLeft, 40);
      assert.match(doc.querySelector("aside")!.textContent!, /Body 2/);
      assert.deepEqual([...doc.querySelectorAll<HTMLElement>(".session-graph-node")].map((item) => [item.style.left, item.style.top]), positions);
    };
    assertRestored();
    const savedState = state, savedMemory = memory;
    await act(async () => root.render(null));
    await act(async () => root.render(render("reopened", savedState, savedMemory)));
    assertRestored();
  });
});

// @test-value v2
// kind = "contract"
// claim = "All Topicsのlive更新が競合しても取得済図と選択を保持し、成功後も順序と倍率を維持する"
// oracle = { type = "contract", ref = "docs/design/session-graph.md: 同一revisionの読取統合" }
// fault = "更新競合を正常emptyで置き換えるか、新しさ順の更新だけでnode順や選択を変える"
// observable = "競合後のalert・node・本文と成功後のnode順・公開選択・倍率"
// observation_boundary = "component-behavior"
// scope = "All Topicsのlive refreshと失敗保持"
// lifecycle = "permanent"
// impact = "更新中に読んでいた内容を失い、欠落を正常な全体図と誤認する"
// distinction = "graph-read-state単体ではmetadata取得とrecord取得の間のrenderer競合を検証できない"
// @end-test-value
test("all topics retains its graph on conflicting refresh and its order on successful updates", async () => {
  await withDom(async (doc, root) => {
    const records = [record("work"), record("issue", "b", "issue")], f = fixture(records);
    let state: SessionGraphViewState | undefined;
    await act(async () => root.render(<SessionGraphPreview api={f.api} sessionId="main" onOpenPath={() => {}} onStateChange={(value) => { state = value; }} />));
    await click(node(doc, "work")); await click(doc.querySelector("[aria-label='Zoom In']"));
    await act(async () => f.update(true));
    assert.match(doc.querySelector("[role='alert']")!.textContent!, /graph changed/);
    assert.ok(node(doc, "work")); assert.equal(state?.selectedId, "work");
    assert.match(doc.querySelector("aside")!.textContent!, /Body work/);
    records.reverse();
    await act(async () => f.update());
    assert.deepEqual([...doc.querySelectorAll(".session-graph-node-title")].map((item) => item.textContent), ["Record work", "Record issue"]);
    assert.equal(state?.zoom, 1.1); assert.equal(state?.selectedId, "work");
  });
});

// @test-value v2
// kind = "contract"
// claim = "狭幅のAll Topicsではrecord本文へfocusを移し、Escapeで閉じると選択元nodeへ戻す"
// oracle = { type = "contract", ref = "docs/design/session-graph.md: 閲覧UI" }
// fault = "詳細表示後も背面にfocusを残すか、閉じた後に選択元を見失う"
// observable = "詳細見出しと閉じた後のactiveElement、nodeのaria-pressed"
// observation_boundary = "component-behavior"
// scope = "All Topicsのrecord詳細focus lifecycle"
// lifecycle = "permanent"
// impact = "keyboard利用者が詳細本文の閲覧と図への復帰を行えない"
// distinction = "DOM静的描画やTopic単独のtestでは全体表示の選択保持とfocus復帰を同時に検証できない"
// @end-test-value
test("all topics focuses record details and restores the node on Escape", async () => {
  await withDom(async (doc, root) => {
    const f = fixture([record("work")]);
    await act(async () => root.render(<SessionGraphPreview api={f.api} sessionId="main" onOpenPath={() => {}} />));
    const source = node(doc, "work")!;
    await click(source);
    assert.equal(doc.activeElement, doc.querySelector("aside h2"));
    assert.ok(doc.querySelector(".session-graph-column")?.hasAttribute("inert"));
    await act(async () => doc.querySelector("aside")!.dispatchEvent(new doc.defaultView!.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(doc.activeElement, source); assert.equal(source.getAttribute("aria-pressed"), "false");
  }, 600);
});
