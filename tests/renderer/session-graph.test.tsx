import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import type { SessionGraphRecord } from "../../src-shared/session-graph/session-graph-contract.js";
import { layoutSessionGraph } from "../../src/session-graph/graph-layout.js";
import { projectSessionGraph } from "../../src/session-graph/graph-overview.js";
import type { SessionGraphRelation } from "../../src-shared/session-graph/session-graph-contract.js";
import { sessionGraphStatuses } from "../../src/session-graph/SessionGraphPreview.js";
import { SessionGraphPreview, type SessionGraphPreviewMemory } from "../../src/session-graph/SessionGraphPreview.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { SessionGraphViewState } from "../../src-shared/session-graph/session-graph-window-contract.js";
import { MessageRichText } from "../../src/ui/markdown/MessageRichText.js";
import { PreviewWheelZoomStepContext } from "../../src/settings/preview-zoom-settings-context.js";

function record(id: string): SessionGraphRecord {
  return {
    id,
    topicId: "topic",
    title: id,
    kind: "decision",
    detail: "",
    scope: "",
    references: [],
    actor: { label: "User" },
    recordedBy: { sessionId: "main", sessionTitle: "Main", role: "main" },
    createdAt: "2026-10-24T00:00:00Z",
    updatedAt: "2026-10-24T00:00:00Z",
  };
}

// @test-value v2
// kind = "invariant"
// claim = "任意の循環・分離した記録も有限の重ならない可読位置へ配置される"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "循環で配置が停止するか分離記録を落とすかノードを同じ位置へ置く"
// observable = "全入力記録の位置、有限なcanvas寸法、ノード矩形の交差"
// observation_boundary = "consumer"
// scope = "session-graph-layout"
// lifecycle = "permanent"
// @end-test-value
test("graph layout retains cyclic and disconnected records at readable nonoverlapping positions", () => {
  const records = [
    record("alpha"),
    record("beta"),
    record("gamma"),
    record("isolated"),
  ];
  const layout = layoutSessionGraph(records, [
    { id: "ab", fromId: "alpha", toId: "beta", kind: "supports" },
    { id: "bc", fromId: "beta", toId: "gamma", kind: "depends_on" },
    { id: "ca", fromId: "gamma", toId: "alpha", kind: "related" },
    { id: "outside", fromId: "isolated", toId: "external", kind: "related" },
  ], 640);
  assert.equal(layout.positions.size, records.length);
  assert.ok(Number.isFinite(layout.width) && Number.isFinite(layout.height));
  const positions = [...layout.positions.values()];
  for (let index = 0; index < positions.length; index += 1) {
    const point = positions[index];
    assert.ok(
      point.x >= 0 &&
        point.y >= 0 &&
        point.x + 240 <= layout.width &&
        point.y + 112 <= layout.height,
    );
    for (const other of positions.slice(index + 1))
      assert.ok(
        Math.abs(point.x - other.x) >= 240 ||
        Math.abs(point.y - other.y) >= 112,
      );
  }
});

// @test-value v2
// kind = "contract"
// claim = "接続形状によらず図の幅を使って可読cardを複数列へ詰め、重ならずに表示する"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "連鎖を一列に固定して表示外の領域を増やすか、幅を超えたcardや重なりを作る"
// observable = "異なる表示幅での全記録の矩形、連鎖と並列群の列数とcanvas高さ"
// observation_boundary = "consumer"
// scope = "session-graph-responsive-layout"
// lifecycle = "permanent"
// distinction = "型検査や循環保持testは表示幅に応じた配置を判定しない。少数の座標入力で可読寸法と横scrollの主経路化を継続確認する"
// @end-test-value
test("graph layout packs chains and parallel records into the available width", () => {
  const records = Array.from({ length: 12 }, (_, index) => record(`node-${index}`));
  const chain = layoutSessionGraph(records, records.slice(1).map((item, index) => ({
    id: `chain-${index}`, fromId: records[index].id, toId: item.id, kind: "depends_on",
  })), 960);
  const chainPoints = [...chain.positions.values()];
  assert.equal(new Set(chainPoints.map((point) => point.x)).size, 3);
  assert.ok(chain.width <= 960);
  assert.ok(chain.height <= 4 * 176);

  const branches = records.slice(1).map((item) => ({
    id: `branch-${item.id}`, fromId: records[0].id, toId: item.id, kind: "supports" as const,
  }));
  const narrow = layoutSessionGraph(records, branches, 640);
  const wide = layoutSessionGraph(records, branches, 960);
  for (const [width, layout] of [[640, narrow], [960, wide]] as const) {
    assert.equal(layout.positions.size, records.length);
    assert.ok(layout.width <= width);
    const points = [...layout.positions.values()];
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      assert.ok(point.x >= 0 && point.x + 240 <= width && point.y + 112 <= layout.height);
      for (const other of points.slice(index + 1))
        assert.ok(Math.abs(point.x - other.x) >= 240 || Math.abs(point.y - other.y) >= 112);
    }
  }
  assert.equal(new Set([...narrow.positions.values()].map((point) => point.x)).size, 2);
  assert.equal(new Set([...wide.positions.values()].map((point) => point.x)).size, 3);
  assert.ok(wide.height < narrow.height);
});

function chainRecords(count: number) {
  const records = Array.from({ length: count }, (_, index) => record(`node-${index}`));
  const relations: SessionGraphRelation[] = records.slice(1).map((item, index) => ({
    id: `edge-${index}`, fromId: records[index].id, toId: item.id, kind: "depends_on",
  }));
  return { records, relations };
}

// @test-value v2
// kind = "contract"
// claim = "長い同種の経路を件数付きで俯瞰し、段階展開しても全recordへ有限回で到達でき、集約を直接edgeと混同しない"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "集約でrecordを落とすか重複させる、展開しても同じ大きさのgroupが残る、集約経路を直接relationへ書き換える"
// observable = "投影nodeのrecord集合、group件数、展開後の大きさ、group境界edgeの向きと区別"
// observation_boundary = "consumer"
// scope = "session-graph-overview-reachability"
// lifecycle = "permanent"
// @end-test-value
test("graph overview groups long paths and expands every record without inventing direct edges", () => {
  const { records, relations } = chainRecords(55);
  const overview = projectSessionGraph(records, relations, 9);
  assert.deepEqual(overview.nodes.map((node) => node.records.length), [1, 53, 1]);
  assert.deepEqual(overview.nodes.flatMap((node) => node.records.map((item) => item.id)).sort(), records.map((item) => item.id).sort());
  assert.deepEqual(overview.edges.map((edge) => [edge.id, edge.fromId, edge.toId, edge.kind, edge.grouped]), [
    ["edge-0", overview.nodes[0].id, overview.nodes[1].id, "depends_on", true],
    ["edge-53", overview.nodes[1].id, overview.nodes[2].id, "depends_on", true],
  ]);
  const reached = new Set<string>();
  const visit = (ids: string[] | null, depth: number) => {
    assert.ok(depth < 10, "expansion must make progress");
    const view = projectSessionGraph(records, relations, 9, ids);
    assert.ok(view.nodes.length <= 9);
    const expected = new Set(ids ?? records.map((item) => item.id));
    const covered = view.nodes.flatMap((node) => node.records.map((item) => item.id)).filter((id) => expected.has(id));
    assert.deepEqual(covered.sort(), [...expected].sort());
    for (const node of view.nodes) {
      if (node.records.length === 1) reached.add(node.records[0].id);
      else {
        if (ids) assert.ok(node.records.length < ids.length);
        visit(node.records.map((item) => item.id), depth + 1);
      }
    }
  };
  visit(null, 0);
  assert.deepEqual([...reached].sort(), records.map((item) => item.id).sort());
});

// @test-value v2
// kind = "invariant"
// claim = "俯瞰の集約は分岐・合流・関係の種類やlabelや向きの変更・循環・未取得端点を隠さない"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "次数だけで集約し意味の境界や不完全な接続を一本道に見せる"
// observable = "境界recordの個別node、循環の全recordとedge、集約内外のrecord被覆"
// observation_boundary = "consumer"
// scope = "session-graph-overview-boundaries"
// lifecycle = "permanent"
// @end-test-value
test("graph overview retains semantic boundaries, branches, cycles and unloaded endpoints", () => {
  const { records, relations } = chainRecords(24);
  records.push(record("branch"));
  relations[5].kind = "supports";
  relations[9].label = "Condition";
  [relations[13].fromId, relations[13].toId] = [relations[13].toId, relations[13].fromId];
  relations.push({ id: "branch", fromId: "node-17", toId: "branch", kind: "depends_on" });
  relations.push({ id: "unloaded", fromId: "node-21", toId: "outside", kind: "depends_on" });
  const overview = projectSessionGraph(records, relations, 3);
  const singles = new Set(overview.nodes.filter((node) => node.records.length === 1).map((node) => node.records[0].id));
  for (const id of [0, 5, 6, 9, 10, 13, 14, 17, 21, 23]) assert.ok(singles.has(`node-${id}`), `boundary ${id}`);
  assert.ok(singles.has("branch"));
  assert.deepEqual(overview.nodes.flatMap((node) => node.records.map((item) => item.id)).sort(), records.map((item) => item.id).sort());
  const cycle = chainRecords(8);
  cycle.relations.push({ id: "cycle", fromId: "node-7", toId: "node-0", kind: "depends_on" });
  for (const extra of [[], [{ id: "self", fromId: "node-0", toId: "node-0", kind: "related" as const }]]) {
    const view = projectSessionGraph(cycle.records, [...cycle.relations, ...extra], 3);
    assert.equal(view.nodes.length, 8);
    assert.ok(view.nodes.every((node) => node.records.length === 1));
    assert.equal(view.edges.length, 8 + extra.length);
  }
});

// @test-value v2
// kind = "contract"
// claim = "区間展開からrecord詳細へ辿れ、再表示・跨話題往復・戻る操作で追加取得した区間を保持し、label主体の名前を常時読める"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "group操作が全経路を無条件展開するか、詳細dismiss・再表示・跨話題往復で区間や追加pageが失われるか、Userがtooltip内だけになる"
// observable = "展開後のgroupとrecord、詳細本文と可視label、再表示・跨話題往復後のnode集合、戻り先groupのfocus、部分取得中の集約可否"
// observation_boundary = "component-behavior"
// scope = "session-graph-overview-navigation"
// lifecycle = "permanent"
// @end-test-value
test("graph preview retains expanded ranges and displays label actors beside a person icon", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost" });
  const descriptors = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window }, document: { configurable: true, value: dom.window.document },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const { records, relations } = chainRecords(55);
  const other = { ...record("other-record"), topicId: "other", title: "Other Topic Record" };
  relations.push({ id: "cross-topic", fromId: records[0].id, toId: other.id, kind: "related" });
  let memory: SessionGraphPreviewMemory | null = null;
  let state = { topicId: "topic", selectedId: null, zoom: 1, scrollLeft: 0, scrollTop: 0 } as SessionGraphViewState;
  let truncated = false;
  const api = {
    readSessionGraph: (async (_id: string, operation: string, request: { ids?: string[]; topicId?: string; offset?: number; limit?: number }) => {
      if (operation === "list_topics") return { status: "ok", revision: 1, items: [{ id: "topic", title: "Topic" }, { id: "other", title: "Other" }], total: 2, offset: 0, hasMore: false, incomplete: false };
      const source = request.topicId === "other" ? [other] : records;
      const offset = request.offset ?? 0;
      const items = operation === "get" ? [...records, other].filter((record) => request.ids?.includes(record.id)) : source.slice(offset, offset + (request.limit ?? 40));
      const total = operation === "get" ? items.length : source.length;
      const hasMore = offset + items.length < total;
      const edges = truncated ? [...relations, ...Array.from({ length: 400 - relations.length }, (_, index) => ({ id: `external-${index}`, fromId: "outside", toId: "unloaded", kind: "related" }))] : relations;
      return { status: "ok", revision: 1, items, total, offset, hasMore, incomplete: truncated || hasMore || offset > 0, relations: edges, externalEndpoints: [other, records[0]] };
    }) as WithMateWindowApi["readSessionGraph"],
    subscribeSessionGraph: () => () => {},
  };
  const render = (key: string) => root.render(<SessionGraphPreview key={key} api={api} sessionId="main" onOpenPath={() => {}}
    initialState={state} initialMemory={memory} onStateChange={(next) => { state = next; }} onMemoryChange={(next) => { memory = next; }} />);
  const click = async (selector: string) => {
    const target = dom.window.document.querySelector(selector);
    assert.ok(target, selector);
    await act(async () => { target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  };
  const labels = () => [...dom.window.document.querySelectorAll(".session-graph-node")].map((node) => node.textContent);
  try {
    await act(async () => render("initial"));
    await click(".session-graph-partial button");
    assert.equal(dom.window.document.querySelectorAll(".session-graph-node").length, 3);
    await click(".session-graph-group");
    assert.ok(dom.window.document.querySelector("[aria-label='Back To Overview']"));
    const expanded = labels();
    assert.ok(dom.window.document.querySelector(".session-graph-group"), "a long range remains progressively expandable");
    assert.ok(expanded.length < records.length, "opening a group must not render the whole long path");
    await act(async () => render("reopen"));
    assert.deepEqual(labels(), expanded);
    await click(".session-graph-node:not(.session-graph-group)");
    const crossTopicLink = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-graph-related button")].find((button) => button.textContent?.includes(other.title));
    assert.ok(crossTopicLink);
    await act(async () => crossTopicLink.click());
    assert.equal(dom.window.document.querySelector(".session-graph-details h2")?.textContent, other.title);
    await click(".session-graph-back-link");
    await click("[aria-label='Close Record Details']");
    assert.deepEqual(labels(), expanded, "cross-topic return keeps the loaded pages in the expanded range");
    let steps = 0;
    while (dom.window.document.querySelector(".session-graph-group")) {
      assert.ok(steps++ < 10);
      await click(".session-graph-group");
    }
    const leaf = labels();
    await click(".session-graph-node");
    const actor = dom.window.document.querySelector(".session-graph-details .session-graph-identity.is-label")!;
    assert.equal(actor.querySelector(".session-graph-actor-name")?.textContent, "User");
    assert.ok(actor.querySelector("svg[aria-hidden='true']"));
    assert.equal(actor.getAttribute("aria-label"), "User");
    await click("[aria-label='Close Record Details']");
    assert.deepEqual(labels(), leaf);
    assert.ok(dom.window.document.activeElement?.classList.contains("session-graph-node"));
    while (dom.window.document.querySelector("[aria-label='Back To Previous Range']")) await click("[aria-label='Back To Previous Range']");
    assert.deepEqual(labels(), expanded);
    await click("[aria-label='Back To Overview']");
    assert.equal(dom.window.document.querySelectorAll(".session-graph-node").length, 3);
    assert.ok(dom.window.document.activeElement?.classList.contains("session-graph-group"));
    truncated = true;
    memory = null;
    await act(async () => render("truncated"));
    await click(".session-graph-partial button");
    assert.equal(dom.window.document.querySelectorAll(".session-graph-node").length, 55);
    assert.match(dom.window.document.querySelector(".session-graph-partial")?.textContent ?? "", /Partial Graph/);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "採用・作業・確認・論点・有効性は別の状態として保持される"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "置換済みの採用判断や完了作業に併存する失敗と未解決を単一状態へ潰す"
// observable = "詳細とノードに渡す状態label集合"
// observation_boundary = "consumer"
// scope = "session-graph-status"
// lifecycle = "permanent"
// @end-test-value
test("status presentation keeps acceptance and supersession as well as completion and unresolved results", () => {
  assert.deepEqual(
    sessionGraphStatuses({
      ...record("decision"),
      adoption: "accepted",
      validity: "superseded",
    }),
    ["accepted", "superseded"],
  );
  assert.deepEqual(
    sessionGraphStatuses({
      ...record("activity"),
      progress: "completed",
      result: "failed",
      resolution: "open",
    }),
    ["completed", "failed", "unresolved"],
  );
  assert.deepEqual(
    sessionGraphStatuses({ ...record("observation"), result: "not_run" }),
    ["not_run"],
  );
});

// @test-value v2
// kind = "invariant"
// claim = "Graph本文の画像とMermaidは自動取得せずテキストとして表示し、明示リンクは安全なrendererへ残る"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "Graph本文のMarkdown画像やMermaid画像の埋込が閲覧時に外部またはlocal資源を自動取得する"
// observable = "HTMLの画像埋込とMermaid surfaceの不在、画像代替文字、code本文、明示リンク"
// observation_boundary = "component-behavior"
// scope = "graph-markdown-media-policy"
// lifecycle = "permanent"
// impact = "信頼しない記録本文の閲覧だけで追跡URLやlocal画像が取得される"
// distinction = "型やschemaは有効な画像Markdownを許すため、rendererの自動取得境界はbuildでは検出できない。小さいSSR testで継続検査する"
// @end-test-value
test("graph detail markdown represents embedded media as text while keeping deliberate links", () => {
  const html = renderToStaticMarkup(
    <MessageRichText
      embeddedMedia="text"
      text={
        '![Private Image](https://example.invalid/private.png)\n\n```mermaid\nflowchart TD\nA@{ img: "https://example.invalid/track.png" }\n```\n\n[Open Evidence](https://example.invalid/evidence)'
      }
    />,
  );
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelector("img"), null);
  assert.equal(document.querySelector(".mermaid-viewport"), null);
  assert.match(document.body.textContent ?? "", /\[Image: Private Image\]/);
  assert.match(
    document.querySelector("pre")?.textContent ?? "",
    /https:\/\/example.invalid\/track.png/,
  );
  assert.equal(
    document.querySelector("a")?.getAttribute("href"),
    "https://example.invalid/evidence",
  );
});

// @test-value v2
// kind = "contract"
// claim = "Graphは設定刻みのCtrl＋wheelとCtrl＋左dragで対象だけを操作し、通知・再表示・関連往復で選択と位置を保ち、別窓操作は元ビューを変えない"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "Ctrl＋wheelが全体zoomへ伝播するか設定刻みを無視し、通常dragでも移動するかpan後に選択・別窓を誤発火し、通知や関連往復で元状態やfalse値を失う"
// observable = "wheelのcancelと伝播、倍率、pointer操作後のscrollと選択、自由項目、参照open引数、復帰・再表示の位置と追加取得範囲、別窓state、詳細開閉のfocus"
// observation_boundary = "component-behavior"
// scope = "session-graph-preview-navigation"
// lifecycle = "permanent"
// @end-test-value
test("graph preview preserves selection on notifications and navigates cross-topic references", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", {
    url: "http://localhost",
  });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  const previousAct = Object.getOwnPropertyDescriptor(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  let notify: (id: string) => void = () => {};
  let revision = 1;
  const opened: string[] = [];
  const windows: SessionGraphViewState[] = [];
  let latestState: SessionGraphViewState | null = null;
  let latestMemory: SessionGraphPreviewMemory | null = null;
  const relation = {
    id: "cross",
    fromId: "alpha",
    toId: "cross-topic",
    kind: "supports" as const,
    label: "Evidence",
  };
  const alpha = () => ({
    ...record("alpha"),
    title: "Shared Decision",
    detail: `Decision At Revision ${revision}`,
    adoption: "accepted" as const,
    fields: {
      zero: 0,
      disabled: false,
      nothing: null,
      empty: "",
      structure: { count: 3 },
    },
    references: [
      {
        role: "evidence" as const,
        label: "Open Evidence",
        href: "evidence.md",
      },
    ],
  });
  const other = {
    ...record("cross-topic"),
    topicId: "other",
    title: "Other Topic Observation",
    detail: "Cross Topic Detail",
  };
  const api: Pick<
    WithMateWindowApi,
    "readSessionGraph" | "subscribeSessionGraph"
  > = {
    readSessionGraph: (async (
      _sessionId: string,
      operation: string,
      request: { ids?: string[]; topicId?: string; offset?: number },
    ) => {
      if (operation === "list_topics")
        return {
          status: "ok",
          revision,
          items: [
            { id: "topic", title: "Decisions" },
            { id: "other", title: "Evidence" },
          ],
          total: 2,
          offset: 0,
          hasMore: false,
          incomplete: false,
        };
      const selected =
        operation === "get"
          ? request.ids?.[0]
          : request.topicId === "other"
            ? "cross-topic"
            : "alpha";
      return {
        status: "ok",
        revision,
        items: [selected === "cross-topic" ? other : operation === "get_topic_view" && request.offset ? record("second-page") : alpha()],
        total: operation === "get_topic_view" && selected === "alpha" ? 2 : 1,
        offset: 0,
        hasMore: operation === "get_topic_view" && selected === "alpha" && !request.offset,
        incomplete: false,
        relations: [relation],
        externalEndpoints: [other],
      };
    }) as WithMateWindowApi["readSessionGraph"],
    subscribeSessionGraph: (listener) => {
      notify = listener;
      return () => {
        notify = () => {};
      };
    },
  };
  const click = async (element: Element | null) => {
    assert.ok(element);
    await act(async () => {
      element.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
  };
  try {
    await act(async () => {
      root.render(
        <PreviewWheelZoomStepContext.Provider value={7}><SessionGraphPreview
          api={api}
          sessionId="main"
          onClose={() => {}}
          onOpenPath={(target) => opened.push(target)}
          onOpenWindow={(state) => windows.push(state)}
          onStateChange={(state) => { latestState = state; }}
          onMemoryChange={(memory) => { latestMemory = memory; }}
        /></PreviewWheelZoomStepContext.Provider>,
      );
    });
    assert.equal(dom.window.document.activeElement?.getAttribute("aria-label"), "Graph Topic");
    await click([...dom.window.document.querySelectorAll("button")].find((button) => button.textContent === "Load More") ?? null);
    assert.equal(dom.window.document.querySelectorAll(".session-graph-node").length, 2);
    const viewport = dom.window.document.querySelector<HTMLDivElement>(".session-graph-viewport")!;
    let parentWheels = 0;
    dom.window.document.getElementById("root")!.addEventListener("wheel", () => parentWheels++);
    const wheel = async (deltaY: number, ctrlKey: boolean) => {
      const event = new dom.window.WheelEvent("wheel", { deltaY, ctrlKey, bubbles: true, cancelable: true });
      await act(async () => { viewport.dispatchEvent(event); });
      return event;
    };
    assert.equal((await wheel(-100, true)).defaultPrevented, true);
    assert.match(dom.window.document.querySelector(".session-graph-navigation")!.textContent!, /107%/);
    assert.equal(parentWheels, 0);
    await wheel(100, true);
    assert.match(dom.window.document.querySelector(".session-graph-navigation")!.textContent!, /100%/);
    assert.equal((await wheel(100, false)).defaultPrevented, false);
    assert.equal(parentWheels, 1);
    Object.defineProperties(viewport, { scrollWidth: { value: 1200 }, scrollHeight: { value: 900 }, clientWidth: { value: 400 }, clientHeight: { value: 300 } });
    let captured: number | null = null;
    viewport.setPointerCapture = (id) => { captured = id; };
    viewport.hasPointerCapture = (id) => captured === id;
    viewport.releasePointerCapture = () => { captured = null; };
    viewport.scrollLeft = 80;
    viewport.scrollTop = 120;
    const pointer = async (target: Element, type: string, x: number, y: number, ctrlKey: boolean) => {
      const event = new dom.window.MouseEvent(type, { button: 0, ctrlKey, clientX: x, clientY: y, bubbles: true, cancelable: true });
      Object.defineProperty(event, "pointerId", { value: 7 });
      await act(async () => { target.dispatchEvent(event); });
      return event;
    };
    assert.equal((await pointer(viewport, "pointerdown", 200, 180, false)).defaultPrevented, false);
    await pointer(viewport, "pointermove", 150, 130, false);
    assert.deepEqual([viewport.scrollLeft, viewport.scrollTop], [80, 120]);
    const firstNode = dom.window.document.querySelector(".session-graph-node")!;
    assert.equal((await pointer(firstNode, "pointerdown", 200, 180, true)).defaultPrevented, true);
    await pointer(viewport, "pointermove", 150, 130, true);
    assert.deepEqual([viewport.scrollLeft, viewport.scrollTop], [130, 170]);
    await pointer(viewport, "pointerup", 150, 130, true);
    await pointer(viewport, "pointermove", 100, 80, true);
    assert.deepEqual([viewport.scrollLeft, viewport.scrollTop], [130, 170]);
    await act(async () => { firstNode.dispatchEvent(new dom.window.MouseEvent("click", { ctrlKey: true, detail: 1, bubbles: true, cancelable: true })); });
    assert.equal(windows.length, 0);
    assert.equal(dom.window.document.querySelector(".session-graph-details"), null);
    await click(dom.window.document.querySelector(".session-graph-node"));
    const details = dom.window.document.querySelector<HTMLElement>(
      ".session-graph-details",
    )!;
    assert.equal(dom.window.document.activeElement, details.querySelector("h2"));
    assert.match(details.textContent ?? "", /Decision At Revision 1/);
    assert.deepEqual(
      Array.from(
        details.querySelectorAll(".session-graph-fields pre"),
        (element) => element.textContent,
      ),
      ["0", "false", "null", '""', '{\n  "count": 3\n}'],
    );
    details.scrollTop = 77;
    revision = 2;
    await act(async () => {
      notify("main");
    });
    assert.equal(
      dom.window.document.querySelector(".session-graph-details"),
      details,
    );
    assert.equal(details.scrollTop, 77);
    assert.match(details.textContent ?? "", /Decision At Revision 2/);
    await click(details.querySelector(".session-graph-references button"));
    assert.deepEqual(opened, ["evidence.md"]);
    await click(dom.window.document.querySelector("button[aria-label='Zoom In']"));
    const canvas = dom.window.document.querySelector<HTMLElement>(".session-graph-viewport")!;
    canvas.scrollLeft = 43;
    canvas.scrollTop = 91;
    const loadedState = latestState!;
    const loadedMemory = latestMemory!;
    await act(async () => {
      details.querySelector(".session-graph-related button")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
    });
    assert.equal(windows[0].selectedId, "cross-topic");
    assert.equal(windows[0].zoom, 1.1);
    assert.match(details.textContent ?? "", /Decision At Revision 2/);
    await act(async () => {
      details.querySelector(".session-graph-related button")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
    });
    await click(dom.window.document.querySelector(".session-graph-record-menu > button"));
    assert.equal(windows[1].selectedId, "cross-topic");
    await click(details.querySelector(".session-graph-related button"));
    assert.equal(
      dom.window.document.querySelector<HTMLSelectElement>(
        "select[aria-label='Graph Topic']",
      )?.value,
      "other",
    );
    assert.match(
      dom.window.document.querySelector(".session-graph-details")
        ?.textContent ?? "",
      /Cross Topic Detail/,
    );
    assert.match(dom.window.document.querySelector(".session-graph-back-link")?.textContent ?? "", /Back To Shared Decision/);
    const relatedState = latestState!;
    const relatedMemory = latestMemory!;
    await click(dom.window.document.querySelector(".session-graph-back-link"));
    assert.equal(dom.window.document.querySelector<HTMLSelectElement>("select[aria-label='Graph Topic']")?.value, "topic");
    assert.match(details.textContent ?? "", /Decision At Revision 2/);
    assert.equal(canvas.scrollLeft, 43);
    assert.equal(canvas.scrollTop, 91);
    assert.equal(dom.window.document.querySelector(".session-graph-navigation")?.textContent?.includes("110%"), true);
    const savedState = latestState!;
    const savedMemory = latestMemory!;
    await act(async () => {
      details.querySelector("h2")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(dom.window.document.activeElement, dom.window.document.querySelector(".session-graph-node"));
    await act(async () => {
      root.render(<SessionGraphPreview key="reopened" api={api} sessionId="main" initialState={savedState} initialMemory={savedMemory} onClose={() => {}} onOpenPath={() => {}} />);
    });
    assert.match(dom.window.document.querySelector(".session-graph-details")?.textContent ?? "", /Decision At Revision 2/);
    const restoredCanvas = dom.window.document.querySelector<HTMLElement>(".session-graph-viewport")!;
    assert.equal(restoredCanvas.scrollLeft, 43);
    assert.equal(restoredCanvas.scrollTop, 91);
    assert.equal(dom.window.document.querySelector(".session-graph-navigation")?.textContent?.includes("110%"), true);
    await act(async () => {
      root.render(<SessionGraphPreview key="reopened-related" api={api} sessionId="main" initialState={relatedState} initialMemory={relatedMemory} onClose={() => {}} onOpenPath={() => {}} />);
    });
    await click(dom.window.document.querySelector(".session-graph-back-link"));
    assert.match(dom.window.document.querySelector(".session-graph-details")?.textContent ?? "", /Decision At Revision 2/);
    await act(async () => {
      root.render(<SessionGraphPreview key="reopened-pages" api={api} sessionId="main" initialState={loadedState} initialMemory={loadedMemory} onClose={() => {}} onOpenPath={() => {}} />);
    });
    await click(dom.window.document.querySelector("button[aria-label='Close Record Details']"));
    assert.equal(dom.window.document.querySelectorAll(".session-graph-node").length, 2);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of [
      ["window", previousWindow],
      ["document", previousDocument],
      ["IS_REACT_ACT_ENVIRONMENT", previousAct],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
