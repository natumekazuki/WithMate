export type RenderedTextMatch = {
  startNode: Text;
  startOffset: number;
  endNode: Text;
  endOffset: number;
};

type ExpandedOffset = {
  normalizedStart: number;
  normalizedEnd: number;
  sourceStart: number;
  sourceEnd: number;
};

type TextRun = {
  node: Text;
  normalizedStart: number;
  normalizedEnd: number;
  expandedOffsets: ExpandedOffset[];
};

export type RenderedTextSearchIndex = {
  normalizedText: string;
  runs: TextRun[];
};

export type RenderedTextMatchOffsets = {
  offsets: Uint32Array;
  normalizedQueryLength: number;
};

function normalizeSearchText(value: string): string {
  return value.toLocaleLowerCase();
}

export function createRenderedTextSearchIndex(container: HTMLElement): RenderedTextSearchIndex {
  const normalizedParts: string[] = [];
  const runs: TextRun[] = [];
  let normalizedStart = 0;
  const showText = container.ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = container.ownerDocument.createTreeWalker(container, showText);
  let current = walker.nextNode();
  while (current) {
    const node = current as Text;
    const text = node.textContent ?? "";
    if (text) {
      const normalizedText = normalizeSearchText(text);
      const expandedOffsets: ExpandedOffset[] = [];
      let sourceOffset = 0;
      let normalizedOffset = 0;
      for (const character of text) {
        const sourceEnd = sourceOffset + character.length;
        const normalizedCharacterLength = normalizeSearchText(character).length;
        const normalizedEnd = normalizedOffset + normalizedCharacterLength;
        if (normalizedCharacterLength !== character.length) {
          expandedOffsets.push({
            normalizedStart: normalizedOffset,
            normalizedEnd,
            sourceStart: sourceOffset,
            sourceEnd,
          });
        }
        sourceOffset = sourceEnd;
        normalizedOffset = normalizedEnd;
      }
      normalizedParts.push(normalizedText);
      runs.push({
        node,
        normalizedStart,
        normalizedEnd: normalizedStart + normalizedText.length,
        expandedOffsets,
      });
      normalizedStart += normalizedText.length;
    }
    current = walker.nextNode();
  }
  return { normalizedText: normalizedParts.join(""), runs };
}

function findRun(runs: TextRun[], normalizedOffset: number): TextRun | null {
  let low = 0;
  let high = runs.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const run = runs[middle];
    if (normalizedOffset < run.normalizedStart) {
      high = middle - 1;
    } else if (normalizedOffset >= run.normalizedEnd) {
      low = middle + 1;
    } else {
      return run;
    }
  }
  return null;
}

function mapNormalizedUnitOffset(
  run: TextRun,
  globalNormalizedOffset: number,
  boundary: "start" | "end",
): number {
  const normalizedOffset = globalNormalizedOffset - run.normalizedStart;
  let accumulatedDelta = 0;
  for (const expanded of run.expandedOffsets) {
    if (normalizedOffset < expanded.normalizedStart) {
      break;
    }
    if (normalizedOffset < expanded.normalizedEnd) {
      return boundary === "start" ? expanded.sourceStart : expanded.sourceEnd;
    }
    accumulatedDelta += (expanded.normalizedEnd - expanded.normalizedStart)
      - (expanded.sourceEnd - expanded.sourceStart);
  }
  const sourceOffset = normalizedOffset - accumulatedDelta;
  return boundary === "start" ? sourceOffset : sourceOffset + 1;
}

export function findRenderedTextMatchOffsets(
  index: RenderedTextSearchIndex,
  query: string,
): RenderedTextMatchOffsets {
  const normalizedQuery = normalizeSearchText(query.trim());
  if (!normalizedQuery) {
    return { offsets: new Uint32Array(0), normalizedQueryLength: 0 };
  }

  let matchCount = 0;
  let normalizedOffset = index.normalizedText.indexOf(normalizedQuery);
  while (normalizedOffset >= 0) {
    matchCount += 1;
    normalizedOffset = index.normalizedText.indexOf(
      normalizedQuery,
      normalizedOffset + normalizedQuery.length,
    );
  }

  const offsets = new Uint32Array(matchCount);
  let matchIndex = 0;
  normalizedOffset = index.normalizedText.indexOf(normalizedQuery);
  while (normalizedOffset >= 0) {
    offsets[matchIndex] = normalizedOffset;
    matchIndex += 1;
    normalizedOffset = index.normalizedText.indexOf(
      normalizedQuery,
      normalizedOffset + normalizedQuery.length,
    );
  }
  return { offsets, normalizedQueryLength: normalizedQuery.length };
}

export function resolveRenderedTextMatch(
  index: RenderedTextSearchIndex,
  matches: RenderedTextMatchOffsets,
  matchIndex: number,
): RenderedTextMatch | null {
  const normalizedOffset = matches.offsets[matchIndex];
  if (normalizedOffset === undefined || matches.normalizedQueryLength === 0) {
    return null;
  }
  const normalizedEndOffset = normalizedOffset + matches.normalizedQueryLength - 1;
  const startRun = findRun(index.runs, normalizedOffset);
  const endRun = findRun(index.runs, normalizedEndOffset);
  if (!startRun || !endRun) {
    return null;
  }
  return {
    startNode: startRun.node,
    startOffset: mapNormalizedUnitOffset(startRun, normalizedOffset, "start"),
    endNode: endRun.node,
    endOffset: mapNormalizedUnitOffset(endRun, normalizedEndOffset, "end"),
  };
}

export function getRenderedTextSearchIndexStats(index: RenderedTextSearchIndex): {
  runCount: number;
  expandedOffsetCount: number;
} {
  return {
    runCount: index.runs.length,
    expandedOffsetCount: index.runs.reduce((count, run) => count + run.expandedOffsets.length, 0),
  };
}
