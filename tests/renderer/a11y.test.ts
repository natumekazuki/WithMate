import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getNextRovingIndex } from "../../src/ui/a11y.js";

/** 項目の向きに応じたロービングフォーカスの移動量と、端の回り込みを確認する。 */
describe("a11y roving index", () => {
  /** 横向きでは左右で項目を移動し、縦方向のキーは処理しない。 */
  it("horizontal は左右キーだけを受け付ける", () => {
    assert.equal(getNextRovingIndex(0, 3, "ArrowRight", "horizontal"), 1);
    assert.equal(getNextRovingIndex(0, 3, "ArrowLeft", "horizontal"), 2);
    assert.equal(getNextRovingIndex(0, 3, "ArrowDown", "horizontal"), null);
  });

  /** 縦向きでは上下で項目を移動し、横方向のキーは処理しない。 */
  it("vertical は上下キーだけを受け付ける", () => {
    assert.equal(getNextRovingIndex(1, 3, "ArrowDown", "vertical"), 2);
    assert.equal(getNextRovingIndex(1, 3, "ArrowUp", "vertical"), 0);
    assert.equal(getNextRovingIndex(1, 3, "ArrowRight", "vertical"), null);
  });

  /** 両端で左右の移動が反対端へ回り込み、Home と End は先頭と末尾に直接移る。 */
  it("Home / End と wrap-around を処理する", () => {
    assert.equal(getNextRovingIndex(2, 3, "ArrowRight", "horizontal"), 0);
    assert.equal(getNextRovingIndex(0, 3, "ArrowLeft", "horizontal"), 2);
    assert.equal(getNextRovingIndex(1, 3, "Home", "both"), 0);
    assert.equal(getNextRovingIndex(1, 3, "End", "both"), 2);
  });
});
