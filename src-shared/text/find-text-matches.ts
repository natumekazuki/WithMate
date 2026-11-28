/** 原文上の一致範囲。開始位置は含み、終了位置は含まない。 */
export type TextSearchMatch = {
  startOffset: number;
  endOffset: number;
};

/** 小文字化した本文と、長さが変わったときに使う原文上の開始・終了位置対応表。 */
type NormalizedSearchText = {
  text: string;
  sourceStarts: Uint32Array | null;
  sourceEnds: Uint32Array | null;
};

/** 本文を検索用に小文字化し、UTF-16長が変わる場合だけ対応表を作る。 */
function normalizeSearchText(value: string): NormalizedSearchText {
  const text = value.toLocaleLowerCase();
  if (text.length === value.length) {
    return { text, sourceStarts: null, sourceEnds: null };
  }

  const sourceStarts = new Uint32Array(text.length);
  const sourceEnds = new Uint32Array(text.length);
  let sourceOffset = 0;
  let normalizedOffset = 0;
  for (const character of value) {
    const sourceEnd = sourceOffset + character.length;
    const normalizedCharacter = character.toLocaleLowerCase();
    for (let index = 0; index < normalizedCharacter.length; index += 1) {
      sourceStarts[normalizedOffset + index] = sourceOffset;
      sourceEnds[normalizedOffset + index] = sourceEnd;
    }
    sourceOffset = sourceEnd;
    normalizedOffset += normalizedCharacter.length;
  }
  return { text, sourceStarts, sourceEnds };
}

/** 空白だけの検索を除外し、大文字小文字を区別しない非重複の一致を原文位置順に返す。 */
export function* iterateTextMatches(
  value: string,
  query: string,
): Generator<TextSearchMatch> {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return;
  }
  const normalizedValue = normalizeSearchText(value);
  let normalizedOffset = normalizedValue.text.indexOf(normalizedQuery);
  while (normalizedOffset >= 0) {
    const normalizedEndOffset = normalizedOffset + normalizedQuery.length - 1;
    yield {
      startOffset:
        normalizedValue.sourceStarts?.[normalizedOffset] ?? normalizedOffset,
      endOffset:
        normalizedValue.sourceEnds?.[normalizedEndOffset] ??
        normalizedEndOffset + 1,
    };
    normalizedOffset = normalizedValue.text.indexOf(
      normalizedQuery,
      normalizedOffset + normalizedQuery.length,
    );
  }
}

/** 本文の非重複の一致範囲をすべて配列に集める。 */
export function findTextMatches(
  value: string,
  query: string,
): TextSearchMatch[] {
  return Array.from(iterateTextMatches(value, query));
}

/** 選択位置を0から最終一致までに収め、一致がなければ0を返す。 */
export function clampFindMatchIndex(
  currentIndex: number,
  matchCount: number,
): number {
  if (matchCount <= 0) {
    return 0;
  }
  return Math.min(Math.max(0, currentIndex), matchCount - 1);
}
