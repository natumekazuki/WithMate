import type {
  SessionGraphRecord,
  SessionGraphRelation,
} from "../../src-shared/session-graph/session-graph-contract.js";

type Point = { x: number; y: number };

export function sessionGraphEdgePath(from: Point, to: Point, self: boolean) {
  if (self) {
    return {
      path: `M${from.x + 80},${from.y} C${from.x + 40},${from.y - 32} ${from.x + 200},${from.y - 32} ${from.x + 160},${from.y}`,
      labelX: from.x + 120,
      labelY: from.y - 10,
    };
  }
  if (from.x !== to.x) {
    const direction = to.x > from.x ? 1 : -1;
    const x1 = from.x + (direction > 0 ? 240 : 0);
    const y1 = from.y + 75;
    const x2 = to.x + (direction > 0 ? 0 : 240);
    const y2 = to.y + 75;
    return {
      path: `M${x1},${y1} C${x1 + direction * 40},${y1} ${x2 - direction * 40},${y2} ${x2},${y2}`,
      labelX: (x1 + x2) / 2,
      labelY: (y1 + y2) / 2 - 8,
    };
  }
  const direction = to.y > from.y ? 1 : -1;
  const x1 = from.x + 120;
  const y1 = from.y + (direction > 0 ? 150 : 0);
  const x2 = to.x + 120;
  const y2 = to.y + (direction > 0 ? 0 : 150);
  const bend = Math.min(40, Math.abs(y2 - y1) / 2);
  return {
    path: `M${x1},${y1} C${x1},${y1 + direction * bend} ${x2},${y2 - direction * bend} ${x2},${y2}`,
    labelX: (x1 + x2) / 2,
    labelY: (y1 + y2) / 2 - 8,
  };
}

// Breadth-first layers remain finite for cycles and disconnected components.
// Native scrolling preserves readable node sizes instead of fitting every record.
export function layoutSessionGraph(
  records: SessionGraphRecord[],
  relations: SessionGraphRelation[],
) {
  const remaining = new Set(records.map((record) => record.id));
  const neighbors = new Map(
    records.map((record) => [record.id, new Set<string>()]),
  );
  for (const edge of relations) {
    if (!neighbors.has(edge.fromId) || !neighbors.has(edge.toId)) continue;
    neighbors.get(edge.fromId)!.add(edge.toId);
    neighbors.get(edge.toId)!.add(edge.fromId);
  }
  const positions = new Map<string, { x: number; y: number }>();
  let rowOffset = 0;
  while (remaining.size) {
    let layer = [remaining.values().next().value!];
    remaining.delete(layer[0]);
    let column = 0;
    let componentRows = 1;
    while (layer.length) {
      const next: string[] = [];
      componentRows = Math.max(componentRows, layer.length);
      layer.forEach((id, row) => {
        positions.set(id, {
          x: 32 + column * 320,
          y: 40 + (rowOffset + row) * 180,
        });
        for (const neighbor of neighbors.get(id)!) {
          if (remaining.delete(neighbor)) next.push(neighbor);
        }
      });
      layer = next;
      column += 1;
    }
    rowOffset += componentRows + 1;
  }
  return {
    positions,
    width: Math.max(
      400,
      ...Array.from(positions.values(), (point) => point.x + 280),
    ),
    height: Math.max(
      240,
      ...Array.from(positions.values(), (point) => point.y + 160),
    ),
  };
}
