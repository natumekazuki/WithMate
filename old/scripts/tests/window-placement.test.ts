import assert from "node:assert/strict";
import test from "node:test";

import { resolveCursorAnchoredPosition } from "../../src-electron/window-placement.js";

test("resolveCursorAnchoredPosition はカーソル位置を起点に少しずらして開く", () => {
  const position = resolveCursorAnchoredPosition({
    cursor: { x: 320, y: 180 },
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    width: 900,
    height: 700,
  });

  assert.deepEqual(position, { x: 344, y: 204 });
});

test("resolveCursorAnchoredPosition は右下端ではみ出しを clamp する", () => {
  const position = resolveCursorAnchoredPosition({
    cursor: { x: 1860, y: 1040 },
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    width: 900,
    height: 700,
  });

  assert.deepEqual(position, { x: 1020, y: 380 });
});

test("resolveCursorAnchoredPosition は display workArea より大きい window でも原点へ寄せる", () => {
  const position = resolveCursorAnchoredPosition({
    cursor: { x: 120, y: 60 },
    workArea: { x: 200, y: 100, width: 800, height: 600 },
    width: 1200,
    height: 900,
  });

  assert.deepEqual(position, { x: 200, y: 100 });
});
