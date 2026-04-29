import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { calculateVirtualListWindow, quantizeVirtualListScrollTop } from "../../src/virtual-list.js";

describe("calculateVirtualListWindow", () => {
  it("空配列では空 window を返す", () => {
    assert.deepEqual(calculateVirtualListWindow({
      itemCount: 0,
      scrollTop: 100,
      viewportHeight: 400,
      estimatedItemHeight: 100,
      overscan: 2,
    }), {
      startIndex: 0,
      endIndex: 0,
      paddingTop: 0,
      paddingBottom: 0,
      totalHeight: 0,
      visibleCount: 0,
    });
  });

  it("scrollTop と overscan から表示範囲と spacer 高さを計算する", () => {
    assert.deepEqual(calculateVirtualListWindow({
      itemCount: 100,
      scrollTop: 450,
      viewportHeight: 300,
      estimatedItemHeight: 100,
      overscan: 2,
    }), {
      startIndex: 2,
      endIndex: 10,
      paddingTop: 200,
      paddingBottom: 9000,
      totalHeight: 10000,
      visibleCount: 8,
    });
  });

  it("末尾付近でも範囲が itemCount を超えない", () => {
    assert.deepEqual(calculateVirtualListWindow({
      itemCount: 10,
      scrollTop: 900,
      viewportHeight: 400,
      estimatedItemHeight: 100,
      overscan: 3,
    }), {
      startIndex: 6,
      endIndex: 10,
      paddingTop: 600,
      paddingBottom: 0,
      totalHeight: 1000,
      visibleCount: 4,
    });
  });

  it("overscan なしでも端数 scroll で部分表示される次 item を含める", () => {
    assert.deepEqual(calculateVirtualListWindow({
      itemCount: 3,
      scrollTop: 99,
      viewportHeight: 100,
      estimatedItemHeight: 100,
      overscan: 0,
    }), {
      startIndex: 0,
      endIndex: 2,
      paddingTop: 0,
      paddingBottom: 100,
      totalHeight: 300,
      visibleCount: 2,
    });
  });

  it("scrollTop が範囲外でも最後の item を含む window に寄せる", () => {
    assert.deepEqual(calculateVirtualListWindow({
      itemCount: 3,
      scrollTop: 10000,
      viewportHeight: 100,
      estimatedItemHeight: 100,
      overscan: 0,
    }), {
      startIndex: 2,
      endIndex: 3,
      paddingTop: 200,
      paddingBottom: 0,
      totalHeight: 300,
      visibleCount: 1,
    });
  });
});

describe("quantizeVirtualListScrollTop", () => {
  it("同じ推定行内の scrollTop を同じ anchor に丸める", () => {
    assert.equal(quantizeVirtualListScrollTop(0, 100), 0);
    assert.equal(quantizeVirtualListScrollTop(99, 100), 0);
    assert.equal(quantizeVirtualListScrollTop(100, 100), 100);
    assert.equal(quantizeVirtualListScrollTop(199, 100), 100);
  });

  it("負数と不正な推定高を安全な値に寄せる", () => {
    assert.equal(quantizeVirtualListScrollTop(-20, 100), 0);
    assert.equal(quantizeVirtualListScrollTop(12, 0), 12);
  });
});
