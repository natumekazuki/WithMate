import assert from "node:assert/strict";
import test from "node:test";
import type { SessionGraphRelation } from "../../src-shared/session-graph/session-graph-contract.js";
import { layoutSessionGraph, type SessionGraphLayout } from "../../src/session-graph/graph-layout.js";

type Rect = { x: number; y: number; width: number; height: number };
function intersects(a: Rect, b: Rect) {
  if (!a.width || !a.height || !b.width || !b.height) return false;
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
function segmentIntersects(from: { x: number; y: number }, to: { x: number; y: number }, rect: Rect) {
  if (!rect.width || !rect.height) return false;
  let lower = 0;
  let upper = 1;
  for (const axis of ["x", "y"] as const) {
    const extent = axis === "x" ? rect.width : rect.height;
    const delta = to[axis] - from[axis];
    const min = rect[axis] + 1e-6;
    const max = rect[axis] + extent - 1e-6;
    if (Math.abs(delta) < 1e-6) {
      if (from[axis] <= min || from[axis] >= max) return false;
    } else {
      const crossing = [(min - from[axis]) / delta, (max - from[axis]) / delta].sort((a, b) => a - b);
      lower = Math.max(lower, crossing[0]);
      upper = Math.min(upper, crossing[1]);
    }
  }
  return lower < upper;
}
function assertGeometry(layout: SessionGraphLayout) {
  const nodes = [...layout.positions.values()].map((point) => ({ ...point, width: 240, height: 112 }));
  const labels = [...layout.edgeRoutes.values()].map((route) => ({
    x: route.labelX - route.labelWidth / 2, y: route.labelY - route.labelHeight / 2,
    width: route.labelWidth, height: route.labelHeight,
  }));
  const rectangles = [...nodes, ...labels];
  for (let index = 0; index < rectangles.length; index += 1) {
    const rect = rectangles[index];
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= layout.width && rect.y + rect.height <= layout.height);
    for (const other of rectangles.slice(index + 1)) assert.equal(intersects(rect, other), false, JSON.stringify({ rect, other }));
  }
  for (const route of layout.edgeRoutes.values()) {
    for (const points of route.segments) for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1];
      const to = points[index];
      assert.ok(to.x >= 0 && to.y >= 0 && to.x <= layout.width && to.y <= layout.height);
      for (const rect of rectangles) assert.equal(segmentIntersects(from, to, rect), false, JSON.stringify({ from, to, rect }));
    }
  }
}
function relation(id: string, fromId: string, toId: string): SessionGraphRelation {
  return { id, fromId, toId, kind: "supports" };
}

// @test-value v2
// kind = "contract"
// claim = "障害物のない隣接cardを直線で結び、実寸labelは中央へ置き、単純groupへ上方迂回用の余白を残さない"
// oracle = { type = "contract", ref = "docs/design/session-graph.md: 閲覧UI / 直線優先" }
// fault = "短labelの横隣接関係を上へ大回りさせるか、直線のために長labelをcardへ重ねる"
// observable = "横隣接2cardの経路の共線性、labelの中央と実寸、groupの必要高さ、全描画線分と矩形の非交差"
// observation_boundary = "consumer"
// scope = "短labelと長labelの単純2node group。実描画の自然さの評価は別"
// lifecycle = "permanent"
// distinction = "幾何非交差だけでは不要な迂回と上方余白を検出できない。少数座標の確認で直線優先を保持する"
// @end-test-value
test("unobstructed adjacent cards use a compact straight connection", () => {
  for (const size of [{ width: 50, height: 26 }, { width: 280, height: 200 }]) {
    const layout = layoutSessionGraph([{ id: "a" }, { id: "b" }], [relation("edge", "a", "b")], 960, 600, new Map([["edge", size]]));
    const route = layout.edgeRoutes.get("edge")!;
    const from = layout.positions.get("a")!;
    const to = layout.positions.get("b")!;
    assert.equal(from.y, to.y);
    assert.equal(route.labelX, (from.x + 240 + to.x) / 2);
    assert.equal(route.labelY, from.y + 56);
    assert.equal(route.segments.length, 2);
    for (const segment of route.segments) {
      assert.equal(segment.length, 2);
      for (const point of segment) assert.equal(point.y, from.y + 56);
    }
    assert.equal(layout.components[0].height, Math.max(112, size.height));
    assertGeometry(layout);
  }
});

// @test-value v2
// kind = "contract"
// claim = "空いている斜め接続は直線で結び、途中cardがある接続だけ必要な迂回を行う"
// oracle = { type = "contract", ref = "docs/design/session-graph.md: 閲覧UI / 直線優先" }
// fault = "斜め経路を常に直角迂回するか、直線優先を理由に中間cardを横切る"
// observable = "斜め経路の全点とcard中心間の共線性・非ゼロ傾き、中間cardを持つ経路の折れ点、全線分とcard/labelの非交差"
// observation_boundary = "consumer"
// scope = "4node分岐合流の斜め接続と3node同一行の障害物迂回"
// lifecycle = "permanent"
// distinction = "横隣接の直線testは斜め経路と障害物判定を通らない。小規模形状で採用方針の両側を確認する"
// @end-test-value
test("diagonal clear connections stay straight while obstructed connections detour", () => {
  const records = Array.from({ length: 4 }, (_, index) => ({ id: String(index) }));
  const edges = [relation("a", "0", "1"), relation("b", "0", "2"), relation("c", "1", "3"), relation("d", "2", "3"), relation("diagonal", "0", "3")];
  const layout = layoutSessionGraph(records, edges, 800, 600, new Map(edges.map((edge) => [edge.id, { width: 30, height: 26 }])));
  const diagonal = layout.edgeRoutes.get("diagonal")!;
  const from = layout.positions.get("0")!;
  const to = layout.positions.get("3")!;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  assert.equal(diagonal.segments.length, 2);
  for (const segment of diagonal.segments) {
    assert.equal(segment.length, 2);
    assert.notEqual(segment[0].x, segment[1].x);
    assert.notEqual(segment[0].y, segment[1].y);
    for (const point of segment) {
      const distance = Math.abs((point.x - from.x - 120) * dy - (point.y - from.y - 56) * dx) / Math.hypot(dx, dy);
      assert.ok(distance < 1e-6, "all route points must stay on the line between card centers");
    }
  }
  assertGeometry(layout);
  const obstructedEdges = [relation("a", "0", "1"), relation("b", "1", "2"), relation("blocked", "0", "2")];
  const obstructed = layoutSessionGraph(records.slice(0, 3), obstructedEdges, 1280, 600,
    new Map(obstructedEdges.map((edge) => [edge.id, { width: 30, height: 26 }])));
  assert.ok(obstructed.edgeRoutes.get("blocked")!.segments.some((segment) => segment.length > 2));
  assertGeometry(obstructed);
});

// @test-value v2
// kind = "contract"
// claim = "実測した短長ラベルと並行・自己・分岐合流・上方迂回辺をnodeや隣接labelへ重ねずcanvas内へ置く"
// oracle = { type = "contract", ref = "docs/design/session-graph.md: 閲覧UI / #891" }
// fault = "固定文字高さでlabelを切るかlabel同士やcardに重ねるか辺を文字やcardへ通す"
// observable = "実測矩形入力に対するlabel寸法、全矩形の交差、全path線分と矩形の交差、canvas境界"
// observation_boundary = "consumer"
// scope = "Session Graphの寸法入力から配置・経路出力まで。DOM実測と可読性の実描画確認は別"
// lifecycle = "permanent"
// distinction = "型検査とnodeのみの配置testはlabel矩形・経路の衝突を検出しない。小規模な幾何演算で表示内容の到達性を守る"
// @end-test-value
test("measured labels and complex routes have separate readable space", () => {
  const records = Array.from({ length: 8 }, (_, index) => ({ id: String(index) }));
  const edges = [relation("short", "0", "1"), relation("parallel", "0", "1"),
    relation("self", "0", "0"), relation("branch", "0", "2"), relation("join", "1", "3"),
    relation("join2", "2", "3"), relation("long-route", "3", "7"), relation("return", "7", "0"),
    relation("middle", "3", "4"), relation("middle2", "4", "5"), relation("middle3", "5", "6")];
  const sizes = new Map(edges.map((edge, index) => [edge.id, { width: index === 0 ? 50 : 280, height: index === 0 ? 26 : 44 + index * 18 }]));
  for (const width of [360, 960, 1500]) {
    const layout = layoutSessionGraph(records, edges, width, 600, sizes);
    assert.equal(layout.positions.size, records.length);
    assert.equal(layout.edgeRoutes.size, edges.length);
    for (const edge of edges) {
      assert.equal(layout.edgeRoutes.get(edge.id)!.labelWidth, sizes.get(edge.id)!.width);
      assert.equal(layout.edgeRoutes.get(edge.id)!.labelHeight, sizes.get(edge.id)!.height);
    }
    assert.notDeepEqual(layout.edgeRoutes.get("short")!.segments, layout.edgeRoutes.get("parallel")!.segments);
    assertGeometry(layout);
  }
});

// @test-value v2
// kind = "contract"
// claim = "独立groupと孤立nodeを縦横へ配置し、幅内候補があるgroupを横にはみ出さずgroupを分断しない"
// oracle = { type = "contract", ref = "docs/design/session-graph.md: 閲覧UI / #892" }
// fault = "孤立nodeや小groupを縦一列にするか、下側の空間を使わず幅外へ送るかgroup矩形を交差させる"
// observable = "横長と縦長viewportでのnode列と行、1280pxでの横境界、1440px幅800-900px高での複数行、component非交差、全IDの保持"
// observation_boundary = "consumer"
// scope = "Session Graphの孤立5件と独立小groupの2D packing"
// lifecycle = "permanent"
// distinction = "単一接続groupのtestでは独立groupのpackingや縦横比への応答を確認できない"
// @end-test-value
test("independent groups use both axes without splitting connected groups", () => {
  const isolated = Array.from({ length: 5 }, (_, index) => ({ id: `isolated-${index}` }));
  const wide = layoutSessionGraph(isolated, [], 960, 600);
  const tall = layoutSessionGraph(isolated, [], 500, 1000);
  assert.ok(new Set([...wide.positions.values()].map((point) => point.x)).size > 1);
  assert.ok(new Set([...wide.positions.values()].map((point) => point.y)).size > 1);
  assert.ok(wide.width > tall.width && wide.height < tall.height);
  const central = layoutSessionGraph(isolated, [], 1280, 548);
  assert.ok(central.width <= 1280);
  assert.ok(new Set([...central.positions.values()].map((point) => point.y)).size > 1);
  for (const point of central.positions.values()) assert.ok(point.x + 240 <= 1280);
  const beforeAdd = layoutSessionGraph(isolated.slice(0, 4), [], 1280, 548);
  const afterAdd = layoutSessionGraph(isolated, [], 1280, 548, new Map(), beforeAdd);
  assert.ok(afterAdd.width <= 1280);
  assert.ok(new Set([...afterAdd.positions.values()].map((point) => point.y)).size > 1);
  for (const record of isolated.slice(0, 4)) assert.deepEqual(afterAdd.positions.get(record.id), beforeAdd.positions.get(record.id));
  assertGeometry(central);
  assertGeometry(afterAdd);
  for (const height of [800, 829, 900]) {
    const roomy = layoutSessionGraph(isolated, [], 1440, height);
    assert.ok(roomy.width <= 1440);
    assert.ok(new Set([...roomy.positions.values()].map((point) => point.x)).size > 1);
    assert.ok(new Set([...roomy.positions.values()].map((point) => point.y)).size > 1);
    assertGeometry(roomy);
  }
  const records = [...isolated, ...Array.from({ length: 6 }, (_, index) => ({ id: String(index) }))];
  const edges = [relation("a", "0", "1"), relation("b", "2", "3"), relation("c", "4", "5")];
  const groups = layoutSessionGraph(records, edges, 1500, 800, new Map(edges.map((edge) => [edge.id, { width: 70, height: 26 }])));
  assert.equal(groups.positions.size, records.length);
  for (const edge of edges) assert.ok(groups.components.some((component) => component.ids.includes(edge.fromId) && component.ids.includes(edge.toId)));
  for (let index = 0; index < groups.components.length; index += 1) {
    for (const other of groups.components.slice(index + 1)) assert.equal(intersects(groups.components[index], other), false);
  }
  assertGeometry(groups);
});

// @test-value v2
// kind = "contract"
// claim = "同一viewportのlive更新で並び順や独立node追加が既存座標を不用意に変えず、接続node追加でも既存列を保つ"
// oracle = { type = "contract", ref = "docs/design/session-graph.md: 閲覧UI / #892" }
// fault = "更新時刻順への変更や孤立node追加のたびに全componentを並べ直す"
// observable = "更新前後の既存node座標、接続追加後の列と既存ID座標、全矩形の非交差"
// observation_boundary = "consumer"
// scope = "同じoverview/viewportでpreviousLayoutを渡したlive更新。幅変更や詳細開閉の入力制御は別"
// lifecycle = "permanent"
// distinction = "静的配置testでは閲覧位置の継続を判定できない。小規模な座標比較でlive閲覧の安定性を守る"
// @end-test-value
test("live additions and reordered reads preserve established positions", () => {
  const records = Array.from({ length: 5 }, (_, index) => ({ id: String(index) }));
  const first = layoutSessionGraph(records, [], 960, 600);
  const next = layoutSessionGraph([{ id: "added" }, ...[...records].reverse()], [], 960, 600, new Map(), first);
  for (const record of records) assert.deepEqual(next.positions.get(record.id), first.positions.get(record.id));
  assertGeometry(next);
  const edges = [relation("a", "0", "1")];
  const connected = layoutSessionGraph(records.slice(0, 2), edges, 960, 600);
  const extended = layoutSessionGraph(records.slice(0, 3), [...edges, relation("b", "1", "2")], 960, 600, new Map(), connected);
  for (const record of records.slice(0, 2)) assert.deepEqual(extended.positions.get(record.id), connected.positions.get(record.id));
  assertGeometry(extended);
  const membership = new Map(records.slice(0, 3).map((record) => [record.id, "topic"]));
  const band = layoutSessionGraph(records.slice(0, 3), [], 1440, 800, new Map(), undefined, membership);
  const linked = layoutSessionGraph(records.slice(0, 3), [relation("new", "0", "2")], 1440, 800, new Map(), band, membership);
  const translation = linked.positions.get("0")!.x - band.positions.get("0")!.x;
  // A new detour can translate the band, but must not reorder its records.
  for (const record of records.slice(0, 3)) assert.equal(linked.positions.get(record.id)!.x - band.positions.get(record.id)!.x, translation);
  assertGeometry(linked);
});

// @test-value v2
// kind = "contract"
// claim = "All Topicsの所属帯がrecordの左右・下に16px以上の余白を取り、Topicを跨ぐ保存済み関係の経路とlabelをcard・見出しに重ねない"
// oracle = { type = "contract", ref = "docs/design/session-graph.md: 閲覧UI" }
// fault = "異なるTopicのrecordを同じ帯へ混ぜるか、枠とcardを接触させるか、帯見出しの予約領域へ関係線・label・cardを配置する"
// observable = "所属帯とrecordの余白、帯のcanvas内包含、見出し矩形と関係経路の非交差、実寸labelの非交差"
// observation_boundary = "consumer"
// scope = "Topic所属付きlayoutの広幅・狭幅・単一行・折返し・長label・Topic間edge・展開縮小混在"
// lifecycle = "permanent"
// impact = "Topicの所属と関係を誤読するか、見出し・関係labelが読めなくなるか、枠と選択表示が重なる"
// distinction = "既存の非group layout testはTopic見出しの領域と所属の包含を扱わない"
// @end-test-value
test("topic bands contain their records and reserve readable headings around cross-topic edges", () => {
  const records = Array.from({ length: 7 }, (_, i) => ({ id: String(i) }));
  const membership = new Map(records.map((item, i) => [item.id, i < 3 ? "a" : i < 6 ? "b" : "empty"]));
  const edges = [relation("inside", "0", "1"), relation("cross", "1", "3"), relation("return", "5", "2")];
  const sizes = new Map(edges.map((edge) => [edge.id, { width: edge.id === "cross" ? 280 : 90, height: edge.id === "cross" ? 80 : 26 }]));
  for (const width of [600, 1440]) {
    const layout = layoutSessionGraph(records, edges, width, 800, sizes, undefined, membership);
    assertGeometry(layout);
    assert.deepEqual(layout.topicGroups?.map((group) => group.topicId), ["a", "b", "empty"]);
    for (const group of layout.topicGroups!) {
      assert.ok(group.x >= 0 && group.y >= 0 && group.x + group.width <= layout.width && group.y + group.height <= layout.height);
      const heading = { ...group, height: 56 };
      for (const item of records) {
        const position = layout.positions.get(item.id)!;
        const node = { ...position, width: 240, height: 112 };
        if (membership.get(item.id) === group.topicId) {
          assert.ok(node.x >= group.x + 16 && node.x + node.width + 16 <= group.x + group.width);
          assert.ok(node.y >= group.y + 68 && node.y + node.height + 16 <= group.y + group.height);
        } else assert.equal(intersects(node, group), false);
        assert.equal(intersects(node, heading), false);
      }
      for (const route of layout.edgeRoutes.values()) {
        assert.equal(intersects(heading, { x: route.labelX - route.labelWidth / 2, y: route.labelY - route.labelHeight / 2, width: route.labelWidth, height: route.labelHeight }), false);
        for (const points of route.segments) for (let i = 1; i < points.length; i += 1) assert.equal(segmentIntersects(points[i - 1], points[i], heading), false, JSON.stringify({ heading, from: points[i - 1], to: points[i] }));
      }
    }
  }
  for (const width of [600, 1440]) {
    const single = layoutSessionGraph(records.slice(0, 3), [], width, 800, new Map(), undefined, membership);
    const group = single.topicGroups![0];
    for (const point of single.positions.values()) {
      assert.ok(point.x >= group.x + 16 && point.x + 240 + 16 <= group.x + group.width);
      assert.ok(point.y >= group.y + 68 && point.y + 112 + 16 <= group.y + group.height);
    }
    assert.ok(group.x >= 0 && group.x + group.width <= single.width && group.y + group.height <= single.height);
    assertGeometry(single);
  }
  const mixedNodes = [...records.slice(0, 3), { id: "topic:b" }, { id: "topic:c" }];
  const mixedMembership = new Map(mixedNodes.map((item) => [item.id, item.id.startsWith("topic:") ? item.id.slice(6) : "a"]));
  const mixed = layoutSessionGraph(mixedNodes, [relation("mixed", "0", "topic:b")], 1440, 800, new Map([["mixed", { width: 90, height: 26 }]]), undefined, mixedMembership, new Set(["a"]));
  assert.deepEqual(mixed.topicGroups?.map((group) => group.topicId), ["a"]);
  const band = mixed.topicGroups![0];
  for (const item of records.slice(0, 3)) {
    const point = mixed.positions.get(item.id)!;
    assert.ok(point.x >= band.x + 16 && point.x + 240 + 16 <= band.x + band.width);
    assert.ok(point.y + 112 + 16 <= band.y + band.height);
  }
  assert.equal(mixed.positions.get("topic:b")!.y, mixed.positions.get("topic:c")!.y);
  assert.ok(mixed.positions.get("topic:b")!.y >= mixed.topicGroups![0].y + mixed.topicGroups![0].height);
  assertGeometry(mixed);
});
