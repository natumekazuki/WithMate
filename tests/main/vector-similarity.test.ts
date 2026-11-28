import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeCosineSimilarity,
  rankByCosineSimilarity,
} from "../../src-electron/storage/vector-similarity.js";

/** コサイン類似度の代表値と、不正なベクトルの拒否条件を検査する。 */
describe("computeCosineSimilarity", () => {
  /** 同一の非ゼロベクトルでは丸め誤差の範囲で 1 に一致する。 */
  it("identical near 1", () => {
    const score = computeCosineSimilarity([1, 2, 3], [1, 2, 3]);
    assert.ok(Math.abs(score - 1) < 1e-12);
  });

  /** 互いに直交する方向のベクトルでは類似度が 0 になる。 */
  it("orthogonal near 0", () => {
    const score = computeCosineSimilarity([1, 0, 0], [0, 1, 0]);
    assert.ok(Math.abs(score - 0) < 1e-12);
  });

  /** 型付き配列でも同じ方向の類似度を計算できる。 */
  it("Float32Array にも対応する", () => {
    const score = computeCosineSimilarity(
      new Float32Array([1, 0]),
      new Float32Array([1, 0]),
    );
    assert.ok(Math.abs(score - 1) < 1e-12);
  });

  /** 逆方向の単位ベクトルでは類似度が -1 になる。 */
  it("opposite near -1", () => {
    const score = computeCosineSimilarity([1, 0, 0], [-1, 0, 0]);
    assert.ok(Math.abs(score + 1) < 1e-12);
  });

  /** 左右どちらのベクトルがゼロでも除算せず 0 を返す。 */
  it("zero vector は 0 を返す", () => {
    assert.equal(computeCosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
    assert.equal(computeCosineSimilarity([1, 2, 3], [0, 0, 0]), 0);
  });

  /** 左辺の NaN と右辺の無限大をどちらも不正な成分として拒否する。 */
  it("非有限値を reject する", () => {
    assert.throws(
      () => computeCosineSimilarity([1, Number.NaN, 2], [1, 2, 3]),
      /非有限値/,
    );
    assert.throws(
      () =>
        computeCosineSimilarity([1, 2, 3], [1, Number.NEGATIVE_INFINITY, 3]),
      /非有限値/,
    );
  });

  /** 次元の異なるベクトルは内積の計算に進まず拒否する。 */
  it("長さ不一致を reject する", () => {
    assert.throws(() => computeCosineSimilarity([1, 2], [1, 2, 3]), /長さ/);
  });

  /** 両方が空の場合と片方だけが空の場合で、それぞれ該当する入力エラーを返す。 */
  it("空配列を reject する", () => {
    assert.throws(() => computeCosineSimilarity([], []), /空です/);
    assert.throws(() => computeCosineSimilarity([1], []), /長さ/);
  });
});

/** 候補の順位付けと上限・しきい値の適用、入力検証を扱う。 */
describe("rankByCosineSimilarity", () => {
  /** スコア降順に並べ、型の異なる配列同士でも同点なら候補の入力順を保つ。 */
  it("降順で並ぶ。同点は元順を維持する", () => {
    const candidates = [
      { id: "first", vector: new Float32Array([1, 0]) },
      { id: "second", vector: [0.6, 0.8] as const },
      { id: "third", vector: [1, 0] as const },
      { id: "fourth", vector: [0, 1] as const },
      { id: "fifth", vector: [-1, 0] as const },
    ];

    const ranked = rankByCosineSimilarity(
      [1, 0],
      candidates,
      (item) => item.vector,
    );

    assert.deepEqual(
      ranked.map((entry) => entry.item.id),
      ["first", "third", "second", "fourth", "fifth"],
    );
    assert.deepEqual(
      ranked.map((entry) => entry.score),
      [1, 1, 0.6, 0, -1],
    );
  });

  /** スコア下限による除外と、上位件数による打ち切りを別々に確認する。 */
  it("minScore と limit が効く", () => {
    const candidates = [
      { id: "first", vector: [1, 0] as const },
      { id: "second", vector: [0.6, 0.8] as const },
      { id: "third", vector: [0, 1] as const },
      { id: "fourth", vector: [-1, 0] as const },
    ];

    const rankedWithMinScore = rankByCosineSimilarity(
      [1, 0],
      candidates,
      (item) => item.vector,
      {
        minScore: 0.1,
      },
    );
    assert.deepEqual(
      rankedWithMinScore.map((entry) => entry.item.id),
      ["first", "second"],
    );

    const rankedWithLimit = rankByCosineSimilarity(
      [1, 0],
      candidates,
      (item) => item.vector,
      { limit: 2 },
    );
    assert.deepEqual(
      rankedWithLimit.map((entry) => entry.item.id),
      ["first", "second"],
    );
  });

  /** 件数上限にゼロ、小数、負数を受け付けない。 */
  it("limit の不正値で throw する", () => {
    assert.throws(
      () =>
        rankByCosineSimilarity(
          [1, 0],
          [{ vector: [1, 0] }],
          (item) => item.vector,
          { limit: 0 },
        ),
      /limit/,
    );
    assert.throws(
      () =>
        rankByCosineSimilarity(
          [1, 0],
          [{ vector: [1, 0] }],
          (item) => item.vector,
          { limit: 1.5 },
        ),
      /limit/,
    );
    assert.throws(
      () =>
        rankByCosineSimilarity(
          [1, 0],
          [{ vector: [1, 0] }],
          (item) => item.vector,
          { limit: -1 },
        ),
      /limit/,
    );
  });

  /** NaN をスコア下限として黙って適用せず、入力エラーにする。 */
  it("minScore の不正値で throw する", () => {
    assert.throws(() => {
      rankByCosineSimilarity(
        [1, 0],
        [{ vector: [1, 0] }],
        (item) => item.vector,
        {
          minScore: Number.NaN,
        },
      );
    }, /minScore/);
  });

  /** 順位付け後も渡した候補配列とその内容を変えない。 */
  it("入力の candidates を mutate しない", () => {
    const candidates = [
      { id: "first", vector: [1, 0] as const },
      { id: "second", vector: [0, 1] as const },
    ];
    const copy = structuredClone(candidates);

    rankByCosineSimilarity([1, 0], candidates, (item) => item.vector);

    assert.deepEqual(candidates, copy);
  });

  /** 候補ベクトルの非有限値と、空を含む次元不一致を拒否する。 */
  it("非有限値/長さ不一致/空配列を reject する", () => {
    assert.throws(() => {
      rankByCosineSimilarity(
        [1, 0],
        [{ vector: [1, Number.NaN] }],
        (item) => item.vector,
      );
    }, /非有限値/);

    assert.throws(() => {
      rankByCosineSimilarity([1, 0], [{ vector: [1] }], (item) => item.vector);
    }, /長さ/);

    assert.throws(() => {
      rankByCosineSimilarity([1, 0], [{ vector: [] }], (item) => item.vector);
    }, /長さ/);
  });
});
