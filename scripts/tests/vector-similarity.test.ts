import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeCosineSimilarity, rankByCosineSimilarity } from "../../src-electron/vector-similarity.js";

describe("computeCosineSimilarity", () => {
  it("identical near 1", () => {
    const score = computeCosineSimilarity([1, 2, 3], [1, 2, 3]);
    assert.ok(Math.abs(score - 1) < 1e-12);
  });

  it("orthogonal near 0", () => {
    const score = computeCosineSimilarity([1, 0, 0], [0, 1, 0]);
    assert.ok(Math.abs(score - 0) < 1e-12);
  });

  it("Float32Array にも対応する", () => {
    const score = computeCosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0]));
    assert.ok(Math.abs(score - 1) < 1e-12);
  });

  it("opposite near -1", () => {
    const score = computeCosineSimilarity([1, 0, 0], [-1, 0, 0]);
    assert.ok(Math.abs(score + 1) < 1e-12);
  });

  it("zero vector は 0 を返す", () => {
    assert.equal(computeCosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
    assert.equal(computeCosineSimilarity([1, 2, 3], [0, 0, 0]), 0);
  });

  it("非有限値を reject する", () => {
    assert.throws(() => computeCosineSimilarity([1, Number.NaN, 2], [1, 2, 3]), /非有限値/);
    assert.throws(() => computeCosineSimilarity([1, 2, 3], [1, Number.NEGATIVE_INFINITY, 3]), /非有限値/);
  });

  it("長さ不一致を reject する", () => {
    assert.throws(() => computeCosineSimilarity([1, 2], [1, 2, 3]), /長さ/);
  });

  it("空配列を reject する", () => {
    assert.throws(() => computeCosineSimilarity([], []), /空です/);
    assert.throws(() => computeCosineSimilarity([1], []), /長さ/);
  });
});

describe("rankByCosineSimilarity", () => {
  it("降順で並ぶ。同点は元順を維持する", () => {
    const candidates = [
      { id: "first", vector: new Float32Array([1, 0]) },
      { id: "second", vector: [0.6, 0.8] as const },
      { id: "third", vector: [1, 0] as const },
      { id: "fourth", vector: [0, 1] as const },
      { id: "fifth", vector: [-1, 0] as const },
    ];

    const ranked = rankByCosineSimilarity([1, 0], candidates, (item) => item.vector);

    assert.deepEqual(ranked.map((entry) => entry.item.id), ["first", "third", "second", "fourth", "fifth"]);
    assert.deepEqual(ranked.map((entry) => entry.score), [1, 1, 0.6, 0, -1]);
  });

  it("minScore と limit が効く", () => {
    const candidates = [
      { id: "first", vector: [1, 0] as const },
      { id: "second", vector: [0.6, 0.8] as const },
      { id: "third", vector: [0, 1] as const },
      { id: "fourth", vector: [-1, 0] as const },
    ];

    const rankedWithMinScore = rankByCosineSimilarity([1, 0], candidates, (item) => item.vector, {
      minScore: 0.1,
    });
    assert.deepEqual(rankedWithMinScore.map((entry) => entry.item.id), ["first", "second"]);

    const rankedWithLimit = rankByCosineSimilarity([1, 0], candidates, (item) => item.vector, { limit: 2 });
    assert.deepEqual(rankedWithLimit.map((entry) => entry.item.id), ["first", "second"]);
  });

  it("limit の不正値で throw する", () => {
    assert.throws(() => rankByCosineSimilarity([1, 0], [{ vector: [1, 0] }], (item) => item.vector, { limit: 0 }), /limit/);
    assert.throws(() => rankByCosineSimilarity([1, 0], [{ vector: [1, 0] }], (item) => item.vector, { limit: 1.5 }), /limit/);
    assert.throws(() => rankByCosineSimilarity([1, 0], [{ vector: [1, 0] }], (item) => item.vector, { limit: -1 }), /limit/);
  });

  it("minScore の不正値で throw する", () => {
    assert.throws(() => {
      rankByCosineSimilarity([1, 0], [{ vector: [1, 0] }], (item) => item.vector, {
        minScore: Number.NaN,
      });
    }, /minScore/);
  });

  it("入力の candidates を mutate しない", () => {
    const candidates = [
      { id: "first", vector: [1, 0] as const },
      { id: "second", vector: [0, 1] as const },
    ];
    const copy = structuredClone(candidates);

    rankByCosineSimilarity([1, 0], candidates, (item) => item.vector);

    assert.deepEqual(candidates, copy);
  });

  it("非有限値/長さ不一致/空配列を reject する", () => {
    assert.throws(() => {
      rankByCosineSimilarity([1, 0], [{ vector: [1, Number.NaN] }], (item) => item.vector);
    }, /非有限値/);

    assert.throws(() => {
      rankByCosineSimilarity([1, 0], [{ vector: [1] }], (item) => item.vector);
    }, /長さ/);

    assert.throws(() => {
      rankByCosineSimilarity([1, 0], [{ vector: [] }], (item) => item.vector);
    }, /長さ/);
  });
});
