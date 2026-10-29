import type { SessionGraphRelation } from "../../src-shared/session-graph/session-graph-contract.js";

type Point = { x: number; y: number };
export type SessionGraphLabelSize = { width: number; height: number };
type Rect = Point & SessionGraphLabelSize;
export type SessionGraphEdgeRoute = {
  segments: Point[][];
  labelX: number;
  labelY: number;
  labelWidth: number;
  labelHeight: number;
};
type Component = Rect & {
  ids: string[];
  columns: number;
  columnStep: number;
  rowHeights: number[];
  nodeOffsets: number[];
};
export type SessionGraphLayout = {
  positions: Map<string, Point>;
  edgeRoutes: Map<string, SessionGraphEdgeRoute>;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  components: Component[];
};
const CARD_WIDTH = 240;
const CARD_HEIGHT = 112;
const COLUMN_STEP = 320;
const ROW_STEP = 176;
const PADDING = 24;
const GAP = 12;

export function sessionGraphCapacity(width: number, height: number) {
  return Math.max(3, Math.max(1, Math.floor(width / COLUMN_STEP)) * Math.max(1, Math.floor(height / ROW_STEP)));
}

function overlaps(a: Rect, b: Rect, gap = 0) {
  if (!a.width || !a.height || !b.width || !b.height) return false;
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}

export function sessionGraphRoutePath(points: Point[]) {
  return points.map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`).join(" ");
}

function edgeRoute(segments: Point[][], label: Rect): SessionGraphEdgeRoute {
  return {
    segments,
    labelX: label.x + label.width / 2,
    labelY: label.y + label.height / 2,
    labelWidth: label.width,
    labelHeight: label.height,
  };
}

function segmentHitsRect(from: Point, to: Point, rect: Rect) {
  if (!rect.width || !rect.height) return false;
  let first = 0;
  let last = 1;
  for (const [start, delta, low, high] of [
    [from.x, to.x - from.x, rect.x + 0.000001, rect.x + rect.width - 0.000001],
    [from.y, to.y - from.y, rect.y + 0.000001, rect.y + rect.height - 0.000001],
  ]) {
    if (Math.abs(delta) < 0.000001) {
      if (start <= low || start >= high) return false;
    } else {
      const a = (low - start) / delta;
      const b = (high - start) / delta;
      first = Math.max(first, Math.min(a, b));
      last = Math.min(last, Math.max(a, b));
      if (first >= last) return false;
    }
  }
  return first < last;
}

function routeHitsRect(route: SessionGraphEdgeRoute, rect: Rect) {
  return route.segments.some((points) => points.slice(1).some((point, index) => segmentHitsRect(points[index], point, rect)));
}

function labelRect(route: SessionGraphEdgeRoute): Rect {
  return { x: route.labelX - route.labelWidth / 2, y: route.labelY - route.labelHeight / 2,
    width: route.labelWidth, height: route.labelHeight };
}

function straightRoute(from: Point, to: Point, size: SessionGraphLabelSize) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const clip = Math.min(CARD_WIDTH / 2 / Math.abs(dx), CARD_HEIGHT / 2 / Math.abs(dy));
  const center = { x: (from.x + to.x + CARD_WIDTH) / 2, y: (from.y + to.y + CARD_HEIGHT) / 2 };
  const start = { x: from.x + CARD_WIDTH / 2 + dx * clip, y: from.y + CARD_HEIGHT / 2 + dy * clip };
  const end = { x: to.x + CARD_WIDTH / 2 - dx * clip, y: to.y + CARD_HEIGHT / 2 - dy * clip };
  const label = { x: center.x - size.width / 2, y: center.y - size.height / 2, ...size };
  if (!size.width || !size.height) return edgeRoute([[start, end]], label);
  const gap = Math.min((size.width / 2 + 6) / Math.abs(dx), (size.height / 2 + 6) / Math.abs(dy));
  return edgeRoute([[start, { x: center.x - dx * gap, y: center.y - dy * gap }],
    [{ x: center.x + dx * gap, y: center.y + dy * gap }, end]], label);
}

// Vertical corridor segments can pass other rows' label bands. Detour around
// their measured rectangles, rather than drawing through readable text.
function avoidLabels(points: Point[], labels: Rect[]) {
  const result = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (start.x === end.x && start.y !== end.y) {
      const direction = Math.sign(end.y - start.y);
      const obstacles = labels.filter((label) => label.width > 0 && label.height > 0 &&
        start.x > label.x - 4 && start.x < label.x + label.width + 4 &&
        Math.min(start.y, end.y) < label.y + label.height + 4 &&
        Math.max(start.y, end.y) > label.y - 4,
      ).sort((a, b) => direction * (a.y - b.y));
      for (const label of obstacles) {
        const before = direction > 0 ? label.y - 6 : label.y + label.height + 6;
        const after = direction > 0 ? label.y + label.height + 6 : label.y - 6;
        const side = Math.abs(start.x - label.x) < Math.abs(start.x - label.x - label.width)
          ? label.x - 8 : label.x + label.width + 8;
        result.push({ x: start.x, y: before }, { x: side, y: before },
          { x: side, y: after }, { x: start.x, y: after });
      }
    }
    result.push(end);
  }
  return result;
}

// Undirected breadth-first order expresses proximity only. Arrows and labels,
// not grid axes, carry relation direction and meaning.
export function layoutSessionGraph(
  records: { id: string }[],
  relations: SessionGraphRelation[],
  availableWidth: number,
  availableHeight = 600,
  labelSizes: ReadonlyMap<string, SessionGraphLabelSize> = new Map(),
  previousLayout?: SessionGraphLayout,
): SessionGraphLayout {
  const previous = previousLayout?.viewportWidth === availableWidth &&
    previousLayout.viewportHeight === availableHeight ? previousLayout : undefined;
  const neighbors = new Map(records.map((record) => [record.id, new Set<string>()]));
  const edges = relations.filter((edge) => neighbors.has(edge.fromId) && neighbors.has(edge.toId));
  for (const edge of edges) {
    neighbors.get(edge.fromId)!.add(edge.toId);
    neighbors.get(edge.toId)!.add(edge.fromId);
  }
  const order = [...neighbors.keys()].sort((a, b) => {
    const left = previous?.positions.get(a);
    const right = previous?.positions.get(b);
    return left && right ? left.y - right.y || left.x - right.x : left ? -1 : right ? 1 : 0;
  });
  const remaining = new Set(order);
  const groups: string[][] = [];
  for (const first of order) {
    if (!remaining.delete(first)) continue;
    const ids = [first];
    for (let index = 0; index < ids.length; index += 1) {
      for (const neighbor of neighbors.get(ids[index])!) {
        if (remaining.delete(neighbor)) ids.push(neighbor);
      }
    }
    // Changes to update ordering alone must not reshuffle existing nodes.
    if (previous) ids.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    groups.push(ids);
  }
  const positions = new Map<string, Point>();
  const edgeRoutes = new Map<string, SessionGraphEdgeRoute>();
  const components: Component[] = [];

  for (const ids of groups) {
    const idSet = new Set(ids);
    const componentEdges = edges.filter((edge) => idSet.has(edge.fromId)).sort((a, b) => a.id.localeCompare(b.id));
    const old = previous?.components.find((component) => component.ids.some((id) => idSet.has(id)));
    const direct = new Set(componentEdges.filter((edge) => edge.fromId !== edge.toId &&
      componentEdges.filter((other) => (other.fromId === edge.fromId && other.toId === edge.toId) ||
        (other.fromId === edge.toId && other.toId === edge.fromId)).length === 1).map((edge) => edge.id));
    const directWidth = Math.max(0, ...componentEdges.filter((edge) => direct.has(edge.id)).map((edge) => labelSizes.get(edge.id)?.width ?? 0));
    const maxOut = Math.max(0, ...ids.map((id) => componentEdges.filter((edge) => edge.fromId === id).length));
    const maxIn = Math.max(0, ...ids.map((id) => componentEdges.filter((edge) => edge.toId === id).length));
    const columnStep = Math.max(COLUMN_STEP, CARD_WIDTH + directWidth + GAP * 2,
      CARD_WIDTH + 24 + (maxOut + maxIn) * 4, old?.columnStep ?? 0);
    const columns = Math.min(ids.length, old?.columns ?? Math.max(1,
      Math.floor((Math.max(COLUMN_STEP, availableWidth) - PADDING * 2 + columnStep - CARD_WIDTH) / columnStep)));
    const rows = Math.ceil(ids.length / columns);
    const slots = new Map(ids.map((id, index) => [id, { row: Math.floor(index / columns), column: index % columns }]));
    // Removing a blocked straight candidate adds only that edge to the detour
    // lanes. Each retry removes at least one candidate and therefore terminates.
    let localPositions = new Map<string, Point>();
    let localRoutes = new Map<string, SessionGraphEdgeRoute>();
    let rowHeights: number[] = [];
    let nodeOffsets: number[] = [];
    let minX = 0;
    let maxX = 0;
    while (true) {
      const detours = componentEdges.filter((edge) => !direct.has(edge.id));
      const outgoing = new Map(ids.map((id) => [id, detours.filter((edge) => edge.fromId === id)]));
      const incoming = new Map(ids.map((id) => [id, detours.filter((edge) => edge.toId === id)]));
      const maxIn = Math.max(0, ...[...incoming.values()].map((items) => items.length));
      type RoutedEdge = { edge: SessionGraphRelation; row: number; lane: number; label: Rect; sourceX: number; targetX: number };
      const routed: RoutedEdge[] = [];
      const lanes: Array<Array<{ height: number; intervals: Array<[number, number]> }>> = Array.from({ length: rows }, () => []);
      minX = detours.length ? -32 - Math.max(0, maxIn - 1) * 4 : 0;
      maxX = (columns - 1) * columnStep + CARD_WIDTH;
      for (const edge of detours) {
        const source = slots.get(edge.fromId)!;
        const target = slots.get(edge.toId)!;
        const sourceX = source.column * columnStep + CARD_WIDTH + 12 + outgoing.get(edge.fromId)!.indexOf(edge) * 4;
        const targetX = target.column * columnStep - 12 - incoming.get(edge.toId)!.indexOf(edge) * 4;
        const size = labelSizes.get(edge.id) ?? { width: 0, height: 0 };
        const labelX = (sourceX + targetX) / 2 - size.width / 2;
        const left = Math.min(sourceX, targetX, labelX) - GAP;
        const right = Math.max(sourceX, targetX, labelX + size.width) + GAP;
        const row = Math.min(source.row, target.row);
        let lane = lanes[row].findIndex((candidate) => candidate.intervals.every(([a, b]) => right < a || left > b));
        if (lane < 0) {
          lane = lanes[row].length;
          lanes[row].push({ height: 0, intervals: [] });
        }
        lanes[row][lane].height = Math.max(lanes[row][lane].height, size.height ? size.height + 28 : 20);
        lanes[row][lane].intervals.push([left, right]);
        routed.push({ edge, row, lane, label: { x: labelX, y: 0, ...size }, sourceX, targetX });
        minX = Math.min(minX, left - 8);
        maxX = Math.max(maxX, right + 8);
      }
      const rowGaps = Array.from({ length: rows }, () => 48);
      const nodeBands = Array.from({ length: rows }, () => CARD_HEIGHT);
      for (const edge of componentEdges.filter((edge) => direct.has(edge.id))) {
        const source = slots.get(edge.fromId)!;
        const target = slots.get(edge.toId)!;
        const height = labelSizes.get(edge.id)?.height ?? 0;
        if (source.row === target.row) nodeBands[source.row] = Math.max(nodeBands[source.row], height);
        else for (let row = Math.min(source.row, target.row); row < Math.max(source.row, target.row); row += 1) {
          rowGaps[row] = Math.max(rowGaps[row], height + GAP * 2);
        }
      }
      nodeOffsets = lanes.map((items, index) => Math.max(
        (items.length ? GAP + items.reduce((sum, lane) => sum + lane.height, 0) : 0) + (nodeBands[index] - CARD_HEIGHT) / 2,
        old?.nodeOffsets[index] ?? 0));
      rowHeights = nodeOffsets.map((offset, index) => Math.max(
        offset + CARD_HEIGHT + (nodeBands[index] - CARD_HEIGHT) / 2 + (index < rows - 1 ? rowGaps[index] : 0),
        old?.rowHeights[index] ?? 0));
      const rowTops = rowHeights.map((_, index) => rowHeights.slice(0, index).reduce((sum, height) => sum + height, 0));
      const nodeYs = nodeOffsets.map((offset, index) => rowTops[index] + offset);
      localPositions = new Map(ids.map((id) => {
        const slot = slots.get(id)!;
        return [id, { x: slot.column * columnStep - minX, y: nodeYs[slot.row] }];
      }));
      for (const route of routed) {
        const bandTop = rowTops[route.row];
        route.label.x -= minX;
        route.label.y = bandTop + lanes[route.row].slice(0, route.lane).reduce((sum, lane) => sum + lane.height, 0) + 12;
      }
      const labels = routed.map((route) => route.label);
      localRoutes = new Map<string, SessionGraphEdgeRoute>();
      for (const route of routed) {
        const from = localPositions.get(route.edge.fromId)!;
        const to = localPositions.get(route.edge.toId)!;
        const out = outgoing.get(route.edge.fromId)!;
        const ins = incoming.get(route.edge.toId)!;
        const startY = from.y + 20 + (CARD_HEIGHT - 40) * (out.indexOf(route.edge) + 1) / (out.length + 1);
        const endY = to.y + 20 + (CARD_HEIGHT - 40) * (ins.indexOf(route.edge) + 1) / (ins.length + 1);
        const laneY = route.label.y + route.label.height + 8;
        const sourceX = route.sourceX - minX;
        const targetX = route.targetX - minX;
        const points = [
          { x: from.x + CARD_WIDTH, y: startY }, { x: sourceX, y: startY },
          { x: sourceX, y: laneY }, { x: targetX, y: laneY },
          { x: targetX, y: endY }, { x: to.x, y: endY },
        ];
        localRoutes.set(route.edge.id, edgeRoute([avoidLabels(points, labels)], route.label));
      }
      const nodeRects = [...localPositions.values()].map((point) => ({ ...point, width: CARD_WIDTH, height: CARD_HEIGHT }));
      const accepted: SessionGraphEdgeRoute[] = [];
      let blocked = false;
      for (const edge of componentEdges.filter((edge) => direct.has(edge.id))) {
        const route = straightRoute(localPositions.get(edge.fromId)!, localPositions.get(edge.toId)!, labelSizes.get(edge.id) ?? { width: 0, height: 0 });
        const rect = labelRect(route);
        if (nodeRects.some((node) => overlaps(rect, node) || routeHitsRect(route, node)) ||
            labels.some((label) => overlaps(rect, label, GAP) || routeHitsRect(route, label)) ||
            [...localRoutes.values()].some((other) => routeHitsRect(other, rect)) ||
            accepted.some((other) => overlaps(rect, labelRect(other), GAP) || routeHitsRect(route, labelRect(other)) || routeHitsRect(other, rect))) {
          direct.delete(edge.id);
          blocked = true;
        } else {
          accepted.push(route);
          localRoutes.set(edge.id, route);
        }
      }
      if (blocked) continue;
      break;
    }
    const labelBounds = [...localRoutes.values()].filter((route) => route.labelWidth && route.labelHeight).map(labelRect);
    const contentLeft = Math.min(0, ...labelBounds.map((rect) => rect.x - GAP));
    const contentRight = Math.max(maxX - minX, ...labelBounds.map((rect) => rect.x + rect.width + GAP));
    const component: Component = { ids, columns, columnStep, rowHeights, nodeOffsets,
      x: PADDING, y: PADDING, width: contentRight - contentLeft, height: rowHeights.reduce((sum, height) => sum + height, 0) };
    // Pack whole connected components into two dimensions. Existing origins are
    // preferred on live updates; only actual collisions require displacement.
    const candidates = [{ x: old?.x ?? PADDING, y: old?.y ?? PADDING }, { x: PADDING, y: PADDING },
      ...components.flatMap((other) => [
        { x: other.x + other.width + PADDING, y: other.y },
        { x: other.x, y: other.y + other.height + PADDING },
        { x: PADDING, y: other.y + other.height + PADDING },
      ])];
    const collisionFree = candidates.filter((point) => !components.some((other) => overlaps({ ...component, ...point }, other, PADDING)));
    const withinWidth = collisionFree.filter((point) => point.x + component.width + PADDING <= availableWidth);
    // A narrow component must not cause horizontal overflow while there is
    // usable room below. Oversized connected groups still keep their full size.
    const valid = withinWidth.length ? withinWidth : collisionFree;
    const preferred = old && valid.find((point) => point.x === old.x && point.y === old.y);
    const score = (point: Point) => {
      const width = Math.max(point.x + component.width, ...components.map((other) => other.x + other.width));
      const height = Math.max(point.y + component.height, ...components.map((other) => other.y + other.height));
      return {
        occupancy: Math.max(width / Math.max(COLUMN_STEP, availableWidth), height / Math.max(ROW_STEP, availableHeight)),
        area: width * height,
      };
    };
    Object.assign(component, preferred ?? valid.sort((a, b) => {
      const left = score(a);
      const right = score(b);
      return left.occupancy - right.occupancy || left.area - right.area || a.y - b.y || a.x - b.x;
    })[0]);
    components.push(component);
    for (const [id, point] of localPositions) positions.set(id, { x: point.x + component.x - contentLeft, y: point.y + component.y });
    for (const [id, route] of localRoutes) {
      edgeRoutes.set(id, edgeRoute(route.segments.map((points) => points.map((point) => ({ x: point.x + component.x - contentLeft, y: point.y + component.y }))), {
        x: route.labelX - route.labelWidth / 2 + component.x - contentLeft,
        y: route.labelY - route.labelHeight / 2 + component.y,
        width: route.labelWidth, height: route.labelHeight,
      }));
    }
  }
  return { positions, edgeRoutes, components, viewportWidth: availableWidth, viewportHeight: availableHeight,
    width: Math.max(COLUMN_STEP, ...components.map((component) => component.x + component.width + PADDING)),
    height: Math.max(ROW_STEP, ...components.map((component) => component.y + component.height + PADDING)),
  };
}
