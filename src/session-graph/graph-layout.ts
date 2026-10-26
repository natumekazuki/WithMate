import type { SessionGraphRelation } from "../../src-shared/session-graph/session-graph-contract.js";

type Point = { x: number; y: number };
const COLUMN_STEP = 320;
const ROW_STEP = 176;

export function sessionGraphCapacity(width: number, height: number) {
  return Math.max(3, Math.max(1, Math.floor(width / COLUMN_STEP)) * Math.max(1, Math.floor(height / ROW_STEP)));
}

export function sessionGraphEdgePath(from: Point, to: Point, self: boolean) {
  if (self) {
    return {
      path: `M${from.x + 80},${from.y} C${from.x + 40},${from.y - 32} ${from.x + 200},${from.y - 32} ${from.x + 160},${from.y}`,
      labelX: from.x + 120,
      labelY: from.y - 10,
    };
  }
  if (from.y === to.y) {
    const direction = to.x > from.x ? 1 : -1;
    const x1 = from.x + (direction > 0 ? 240 : 0);
    const y1 = from.y + 56;
    const x2 = to.x + (direction > 0 ? 0 : 240);
    const y2 = to.y + 56;
    if (Math.abs(to.x - from.x) > COLUMN_STEP) {
      const top = from.y - 24;
      return {
        path: `M${x1},${y1} H${x1 + direction * 24} V${top} H${x2 - direction * 24} V${y2} H${x2}`,
        labelX: (x1 + x2) / 2,
        labelY: top - 8,
      };
    }
    return {
      path: `M${x1},${y1} C${x1 + direction * 40},${y1} ${x2 - direction * 40},${y2} ${x2},${y2}`,
      labelX: (x1 + x2) / 2,
      labelY: (y1 + y2) / 2 - 8,
    };
  }
  const direction = to.y > from.y ? 1 : -1;
  const x1 = from.x + 120;
  const y1 = from.y + (direction > 0 ? 112 : 0);
  const x2 = to.x + 120;
  const y2 = to.y + (direction > 0 ? 0 : 112);
  const middleY = (y1 + y2) / 2;
  if (Math.abs(to.y - from.y) > ROW_STEP) {
    // Use a column gutter for edges spanning wrapped rows, not intervening cards.
    const gutter = from.x + 280;
    const startY = y1 + direction * 32;
    const endY = y2 - direction * 32;
    return {
      path: `M${x1},${y1} V${startY} H${gutter} V${endY} H${x2} V${y2}`,
      labelX: (x1 + gutter) / 2,
      labelY: startY - 8,
    };
  }
  return {
    path: `M${x1},${y1} C${x1},${middleY} ${x2},${middleY} ${x2},${y2}`,
    labelX: (x1 + x2) / 2,
    labelY: (y1 + y2) / 2 - 8,
  };
}

// Breadth-first traversal keeps connected nodes close. Packing is spatial only:
// relation arrows, not rows or columns, express direction and meaning.
export function layoutSessionGraph(
  records: { id: string }[],
  relations: SessionGraphRelation[],
  availableWidth: number,
) {
  const columns = Math.max(1, Math.floor(availableWidth / COLUMN_STEP));
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
    let index = 0;
    while (layer.length) {
      const next: string[] = [];
      layer.forEach((id) => {
        positions.set(id, {
          x: 32 + (index % columns) * COLUMN_STEP,
          y: 40 + (rowOffset + Math.floor(index / columns)) * ROW_STEP,
        });
        index += 1;
        for (const neighbor of neighbors.get(id)!) {
          if (remaining.delete(neighbor)) next.push(neighbor);
        }
      });
      layer = next;
    }
    rowOffset += Math.ceil(index / columns);
  }
  return {
    positions,
    width: Math.max(
      COLUMN_STEP,
      ...Array.from(positions.values(), (point) => point.x + 288),
    ),
    height: Math.max(
      ROW_STEP,
      ...Array.from(positions.values(), (point) => point.y + 136),
    ),
  };
}
