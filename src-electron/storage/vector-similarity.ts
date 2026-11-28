/** 類似度計算に渡せる数値列。通常の配列と単精度浮動小数点配列を受け付ける。 */
export type Vector = readonly number[] | Float32Array;

/** 空の数値列や非有限の要素を拒否し、例外に対象の名前を含める。 */
function validateVector(vector: Vector, name: string): void {
  if (vector.length === 0) {
    throw new Error(`${name} が空です`);
  }

  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index];
    if (!Number.isFinite(value)) {
      throw new Error(`${name} に非有限値があります`);
    }
  }
}

/** 等しい次元の空でない有限ベクトルのコサイン類似度を求める。一方でもノルムがゼロなら 0 を返す。 */
export function computeCosineSimilarity(left: Vector, right: Vector): number {
  if (left.length !== right.length) {
    throw new Error("ベクトルの長さが一致しません");
  }

  validateVector(left, "left ベクトル");
  validateVector(right, "right ベクトル");

  let dotProduct = 0;
  let leftNormSquared = 0;
  let rightNormSquared = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    dotProduct += leftValue * rightValue;
    leftNormSquared += leftValue * leftValue;
    rightNormSquared += rightValue * rightValue;
  }

  if (leftNormSquared === 0 || rightNormSquared === 0) {
    return 0;
  }

  return (
    dotProduct / (Math.sqrt(leftNormSquared) * Math.sqrt(rightNormSquared))
  );
}

/** 候補を類似度の降順に並べ、同点は入力順を保つ。指定された下限以上の候補から件数上限まで返す。 */
export function rankByCosineSimilarity<T>(
  queryVector: Vector,
  candidates: readonly T[],
  getVector: (item: T) => Vector,
  options: { minScore?: number; limit?: number } = {},
): Array<{ item: T; score: number }> {
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) || options.limit < 1)
  ) {
    throw new Error("limit は正の整数である必要があります");
  }
  if (options.minScore !== undefined && !Number.isFinite(options.minScore)) {
    throw new Error("minScore は有限数である必要があります");
  }

  const scoredCandidates = candidates.map((item, index) => {
    const vector = getVector(item);
    const score = computeCosineSimilarity(queryVector, vector);

    return { item, score, index };
  });

  const minScore = options.minScore;
  const filtered =
    minScore === undefined
      ? scoredCandidates
      : scoredCandidates.filter((candidate) => candidate.score >= minScore);

  const ranked = filtered.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.index - right.index;
  });

  const result = ranked.map((candidate) => ({
    item: candidate.item,
    score: candidate.score,
  }));

  if (options.limit === undefined) {
    return result;
  }

  return result.slice(0, options.limit);
}
