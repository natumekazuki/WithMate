import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getNextRovingIndex } from "../../src/a11y.js";

describe("a11y roving index", () => {
  it("horizontal は左右キーだけを受け付ける", () => {
    assert.equal(getNextRovingIndex(0, 3, "ArrowRight", "horizontal"), 1);
    assert.equal(getNextRovingIndex(0, 3, "ArrowLeft", "horizontal"), 2);
    assert.equal(getNextRovingIndex(0, 3, "ArrowDown", "horizontal"), null);
  });

  it("vertical は上下キーだけを受け付ける", () => {
    assert.equal(getNextRovingIndex(1, 3, "ArrowDown", "vertical"), 2);
    assert.equal(getNextRovingIndex(1, 3, "ArrowUp", "vertical"), 0);
    assert.equal(getNextRovingIndex(1, 3, "ArrowRight", "vertical"), null);
  });

  it("Home / End と wrap-around を処理する", () => {
    assert.equal(getNextRovingIndex(2, 3, "ArrowRight", "horizontal"), 0);
    assert.equal(getNextRovingIndex(0, 3, "ArrowLeft", "horizontal"), 2);
    assert.equal(getNextRovingIndex(1, 3, "Home", "both"), 0);
    assert.equal(getNextRovingIndex(1, 3, "End", "both"), 2);
  });
});
