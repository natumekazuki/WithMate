import assert from "node:assert/strict";
import test from "node:test";
import type { SessionGraphRelation } from "../../src-shared/session-graph/session-graph-contract.js";
import { layoutSessionGraph, type SessionGraphLayout } from "../../src/session-graph/graph-layout.js";

type Rect = { x: number; y: number; width: number; height: number };
function intersects(a: Rect, b: Rect) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
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
    for (let index = 1; index < route.points.length; index += 1) {
      const from = route.points[index - 1];
      const to = route.points[index];
      assert.ok(from.x === to.x || from.y === to.y);
      assert.ok(to.x >= 0 && to.y >= 0 && to.x <= layout.width && to.y <= layout.height);
      const segment = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(from.x - to.x), height: Math.abs(from.y - to.y) };
      for (const rect of rectangles) assert.equal(intersects(segment, rect), false, JSON.stringify({ segment, rect }));
    }
  }
}
function relation(id: string, fromId: string, toId: string): SessionGraphRelation {
  return { id, fromId, toId, kind: "supports" };
}

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
    assert.notEqual(layout.edgeRoutes.get("short")!.path, layout.edgeRoutes.get("parallel")!.path);
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
});
