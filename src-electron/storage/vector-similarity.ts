export type Vector = readonly number[] | Float32Array;

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

  return dotProduct / (Math.sqrt(leftNormSquared) * Math.sqrt(rightNormSquared));
}

export function rankByCosineSimilarity<T>(
  queryVector: Vector,
  candidates: readonly T[],
  getVector: (item: T) => Vector,
  options: { minScore?: number; limit?: number } = {},
): Array<{ item: T; score: number }> {
  if (
    options.limit !== undefined
    && (!Number.isInteger(options.limit) || options.limit < 1)
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
  const filtered = minScore === undefined
    ? scoredCandidates
    : scoredCandidates.filter((candidate) => candidate.score >= minScore);

  const ranked = filtered.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.index - right.index;
  });

  const result = ranked.map((candidate) => ({ item: candidate.item, score: candidate.score }));

  if (options.limit === undefined) {
    return result;
  }

  return result.slice(0, options.limit);
}
