import assert from "node:assert/strict";
import test from "node:test";

import { clampFindMatchIndex, findTextMatches } from "../../src/find-text-matches.js";

test("findTextMatches は同じ文字列内の全一致を順番とsource offset付きで返す", () => {
  assert.deepEqual(findTextMatches("alpha alpha ALPHA", "alpha"), [
    { startOffset: 0, endOffset: 5 },
    { startOffset: 6, endOffset: 11 },
    { startOffset: 12, endOffset: 17 },
  ]);
});

test("findTextMatches は lowercase で長さが変わる文字の後もsource offsetを維持する", () => {
  assert.deepEqual(findTextMatches("İX", "x"), [{ startOffset: 1, endOffset: 2 }]);
});

test("clampFindMatchIndex は一致件数が減った後も現在位置を有効範囲へ収める", () => {
  assert.equal(clampFindMatchIndex(3, 2), 1);
  assert.equal(clampFindMatchIndex(-1, 2), 0);
  assert.equal(clampFindMatchIndex(2, 0), 0);
});
