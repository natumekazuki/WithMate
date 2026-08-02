export type TextSearchMatch = {
  startOffset: number;
  endOffset: number;
};

type NormalizedSearchText = {
  text: string;
  sourceStarts: Uint32Array | null;
  sourceEnds: Uint32Array | null;
};

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

export function findTextMatches(value: string, query: string): TextSearchMatch[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return [];
  }
  const normalizedValue = normalizeSearchText(value);
  const matches: TextSearchMatch[] = [];
  let normalizedOffset = normalizedValue.text.indexOf(normalizedQuery);
  while (normalizedOffset >= 0) {
    const normalizedEndOffset = normalizedOffset + normalizedQuery.length - 1;
    matches.push({
      startOffset: normalizedValue.sourceStarts?.[normalizedOffset] ?? normalizedOffset,
      endOffset: normalizedValue.sourceEnds?.[normalizedEndOffset] ?? normalizedEndOffset + 1,
    });
    normalizedOffset = normalizedValue.text.indexOf(
      normalizedQuery,
      normalizedOffset + normalizedQuery.length,
    );
  }
  return matches;
}

export function clampFindMatchIndex(currentIndex: number, matchCount: number): number {
  if (matchCount <= 0) {
    return 0;
  }
  return Math.min(Math.max(0, currentIndex), matchCount - 1);
}
