import assert from "node:assert/strict";
import test from "node:test";

import {
  clampFindMatchIndex,
  findTextMatches,
} from "../../src-shared/text/find-text-matches.js";

/** 小文字・大文字が混在する三つの一致が、原文順の開始・終了位置として返ることを確認する。 */
test("findTextMatches は同じ文字列内の全一致を順番とsource offset付きで返す", () => {
  assert.deepEqual(findTextMatches("alpha alpha ALPHA", "alpha"), [
    { startOffset: 0, endOffset: 5 },
    { startOffset: 6, endOffset: 11 },
    { startOffset: 12, endOffset: 17 },
  ]);
});

/** 小文字化で文字数が増える文字の後ろを検索しても、一致の位置が小文字化した文字列ではなく原文を指すことを確認する。 */
test("findTextMatches は lowercase で長さが変わる文字の後もsource offsetを維持する", () => {
  assert.deepEqual(findTextMatches("İX", "x"), [
    { startOffset: 1, endOffset: 2 },
  ]);
});

/** 負の選択位置と、一致数が減って範囲外になった位置を補正する。一致がなくなったときは 0 に戻す。 */
test("clampFindMatchIndex は一致件数が減った後も現在位置を有効範囲へ収める", () => {
  assert.equal(clampFindMatchIndex(3, 2), 1);
  assert.equal(clampFindMatchIndex(-1, 2), 0);
  assert.equal(clampFindMatchIndex(2, 0), 0);
});
