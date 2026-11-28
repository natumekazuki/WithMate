import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  calculateVirtualListWindow,
  quantizeVirtualListScrollTop,
} from "../../src/ui/virtual-list.js";

/** 仮想リストの表示区間と前後スペーサーが、画面と項目数の境界でどう決まるかを検証する。 */
describe("calculateVirtualListWindow", () => {
  /** スクロール位置を指定しても、項目がなければ表示件数と高さはすべてゼロになることを確認する。 */
  it("空配列では空 window を返す", () => {
    assert.deepEqual(
      calculateVirtualListWindow({
        itemCount: 0,
        scrollTop: 100,
        viewportHeight: 400,
        estimatedItemHeight: 100,
        overscan: 2,
      }),
      {
        startIndex: 0,
        endIndex: 0,
        paddingTop: 0,
        paddingBottom: 0,
        totalHeight: 0,
        visibleCount: 0,
      },
    );
  });

  /** 行の途中にある画面を前後の余裕行で広げ、未描画部分の高さをスペーサーへ割り当てることを確認する。 */
  it("scrollTop と overscan から表示範囲と spacer 高さを計算する", () => {
    assert.deepEqual(
      calculateVirtualListWindow({
        itemCount: 100,
        scrollTop: 450,
        viewportHeight: 300,
        estimatedItemHeight: 100,
        overscan: 2,
      }),
      {
        startIndex: 2,
        endIndex: 10,
        paddingTop: 200,
        paddingBottom: 9000,
        totalHeight: 10000,
        visibleCount: 8,
      },
    );
  });

  /** 末尾近くで余裕行を求めても存在しない行を描画せず、下側のスペーサーはゼロになることを確認する。 */
  it("末尾付近でも範囲が itemCount を超えない", () => {
    assert.deepEqual(
      calculateVirtualListWindow({
        itemCount: 10,
        scrollTop: 900,
        viewportHeight: 400,
        estimatedItemHeight: 100,
        overscan: 3,
      }),
      {
        startIndex: 6,
        endIndex: 10,
        paddingTop: 600,
        paddingBottom: 0,
        totalHeight: 1000,
        visibleCount: 4,
      },
    );
  });

  /** 余裕行がなくても画面に一部だけ入った次の行を描画範囲に含めることを確認する。 */
  it("overscan なしでも端数 scroll で部分表示される次 item を含める", () => {
    assert.deepEqual(
      calculateVirtualListWindow({
        itemCount: 3,
        scrollTop: 99,
        viewportHeight: 100,
        estimatedItemHeight: 100,
        overscan: 0,
      }),
      {
        startIndex: 0,
        endIndex: 2,
        paddingTop: 0,
        paddingBottom: 100,
        totalHeight: 300,
        visibleCount: 2,
      },
    );
  });

  /** 末尾を大幅に超えた位置から計算しても空の範囲を返さず、最後の一行を表示することを確認する。 */
  it("scrollTop が範囲外でも最後の item を含む window に寄せる", () => {
    assert.deepEqual(
      calculateVirtualListWindow({
        itemCount: 3,
        scrollTop: 10000,
        viewportHeight: 100,
        estimatedItemHeight: 100,
        overscan: 0,
      }),
      {
        startIndex: 2,
        endIndex: 3,
        paddingTop: 200,
        paddingBottom: 0,
        totalHeight: 300,
        visibleCount: 1,
      },
    );
  });
});

/** スクロール位置を推定行の先頭へ丸めるときの境界と不正値を検証する。 */
describe("quantizeVirtualListScrollTop", () => {
  /** ピクセル単位では位置が異なっても、同じ推定行の中なら描画基準は切り替わらないことを確認する。 */
  it("同じ推定行内の scrollTop を同じ anchor に丸める", () => {
    assert.equal(quantizeVirtualListScrollTop(0, 100), 0);
    assert.equal(quantizeVirtualListScrollTop(99, 100), 0);
    assert.equal(quantizeVirtualListScrollTop(100, 100), 100);
    assert.equal(quantizeVirtualListScrollTop(199, 100), 100);
  });

  /** 負の位置は先頭へ補正し、推定高がゼロなら行への丸めを行わず元の位置を返すことを確認する。 */
  it("負数と不正な推定高を安全な値に寄せる", () => {
    assert.equal(quantizeVirtualListScrollTop(-20, 100), 0);
    assert.equal(quantizeVirtualListScrollTop(12, 0), 12);
  });
});
