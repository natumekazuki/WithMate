/** 一致をDOM Rangeに戻すための始点と終点。終点は一致範囲に含まない。 */
export type RenderedTextMatch = {
  startNode: Text;
  startOffset: number;
  endNode: Text;
  endOffset: number;
};

/** 小文字化でUTF-16長が変わった文字について、正規化前後の範囲を保持する。 */
type ExpandedOffset = {
  normalizedStart: number;
  normalizedEnd: number;
  sourceStart: number;
  sourceEnd: number;
};

/** 一つのテキストノードの索引範囲と、長さが変わった文字の補正情報。 */
type TextRun = {
  node: Text;
  normalizedStart: number;
  normalizedEnd: number;
  expandedOffsets: ExpandedOffset[];
};

/** 検索用の連結テキストと、DOM順に並べたノードへの逆引き情報。 */
export type RenderedTextSearchIndex = {
  normalizedText: string;
  runs: TextRun[];
};

/** DOM範囲を作る前の一致始点一覧と、正規化後の検索語の長さ。 */
export type RenderedTextMatchOffsets = {
  offsets: Uint32Array;
  normalizedQueryLength: number;
};

/** ノードを検索対象の連結テキストに含めるかを決める。 */
export type RenderedTextNodeFilter = (node: Text) => boolean;

/** 全一致の強調表示に使うDOM範囲数の上限。現在の一致は別に扱う。 */
export const MAX_RENDERED_TEXT_HIGHLIGHT_RANGES = 5_000;

const FIND_MATCH_HIGHLIGHT_NAME = "withmate-find-match";
const FIND_CURRENT_HIGHLIGHT_NAME = "withmate-find-current";

/** 文書のCSS Highlight一覧を操作するために使うインターフェース。 */
type HighlightRegistry = {
  /** 同名の強調表示を登録または置換する。 */
  set(name: string, highlight: unknown): void;
  /** 指定名の登録を削除し、登録が存在したかを返す。 */
  delete(name: string): boolean;
};

/** ブラウザーのHighlightに一致範囲を蓄積するためのインターフェース。 */
type HighlightCollection = {
  /** DOM範囲を加え、追加先のコレクションを返す。 */
  add(range: Range): HighlightCollection;
};

/** CSS Custom Highlight APIを提供しない実行環境も扱えるウィンドウ型。 */
type HighlightWindow = Window &
  typeof globalThis & {
    CSS?: { highlights?: HighlightRegistry };
    Highlight?: new () => HighlightCollection;
  };

/** 索引と検索語に同じロケール依存の小文字化を適用する。 */
function normalizeSearchText(value: string): string {
  return value.toLocaleLowerCase();
}

/** 対象ノードをDOM順で区切りなしに連結し、ノードをまたぐ検索と元の境界への逆変換を可能にする。 */
export function createRenderedTextSearchIndex(
  container: HTMLElement,
  includeTextNode: RenderedTextNodeFilter = () => true,
): RenderedTextSearchIndex {
  const normalizedParts: string[] = [];
  const runs: TextRun[] = [];
  let normalizedStart = 0;
  const showText =
    container.ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = container.ownerDocument.createTreeWalker(container, showText);
  let current = walker.nextNode();
  while (current) {
    const node = current as Text;
    const text = node.textContent ?? "";
    if (text && includeTextNode(node)) {
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

/** 正規化後の位置を含むノード区間を二分探索し、範囲外ならnullを返す。 */
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

/** 正規化後のUTF-16単位を元ノードの境界に戻す。長さが変わった文字は始点・終点に応じて文字全体を含める。 */
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
    accumulatedDelta +=
      expanded.normalizedEnd -
      expanded.normalizedStart -
      (expanded.sourceEnd - expanded.sourceStart);
  }
  const sourceOffset = normalizedOffset - accumulatedDelta;
  return boundary === "start" ? sourceOffset : sourceOffset + 1;
}

/** 前後の空白を除いた検索語で、重なりのない一致の始点を出現順に返す。空の検索語は一致なしとする。 */
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

/** 指定順位の一致を元のDOM範囲へ戻す。存在しない順位や対応するノード区間がない場合はnullを返す。 */
export function resolveRenderedTextMatch(
  index: RenderedTextSearchIndex,
  matches: RenderedTextMatchOffsets,
  matchIndex: number,
): RenderedTextMatch | null {
  const normalizedOffset = matches.offsets[matchIndex];
  if (normalizedOffset === undefined || matches.normalizedQueryLength === 0) {
    return null;
  }
  const normalizedEndOffset =
    normalizedOffset + matches.normalizedQueryLength - 1;
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

/** 先頭から上限件数までの一致をDOM範囲へ戻し、解決できなかったものは除く。 */
export function resolveRenderedTextMatches(
  index: RenderedTextSearchIndex,
  matches: RenderedTextMatchOffsets,
  limit = MAX_RENDERED_TEXT_HIGHLIGHT_RANGES,
): RenderedTextMatch[] {
  const resolvedMatches: RenderedTextMatch[] = [];
  const matchLimit = Math.min(matches.offsets.length, Math.max(0, limit));
  for (let matchIndex = 0; matchIndex < matchLimit; matchIndex += 1) {
    const match = resolveRenderedTextMatch(index, matches, matchIndex);
    if (match) {
      resolvedMatches.push(match);
    }
  }
  return resolvedMatches;
}

/** 既に追加した件数を差し引いた残りの枠に、今回の一致を出現順で追記する。 */
export function appendRenderedTextMatches(
  target: RenderedTextMatch[],
  index: RenderedTextSearchIndex,
  matches: RenderedTextMatchOffsets,
  limit = MAX_RENDERED_TEXT_HIGHLIGHT_RANGES,
): void {
  const remaining = Math.max(0, limit - target.length);
  if (remaining === 0) {
    return;
  }
  const resolved = resolveRenderedTextMatches(index, matches, remaining);
  for (const match of resolved) {
    target.push(match);
  }
}

/** 接続中の一致を可視範囲へ移す。スクロール要素が指定された場合は、取得できた一致矩形をその要素内で扱う。 */
export function scrollRenderedTextMatchIntoView(
  match: RenderedTextMatch | null,
  scrollContainer?: HTMLElement,
): void {
  if (!match || !match.startNode.isConnected || !match.endNode.isConnected) {
    return;
  }
  if (scrollContainer) {
    const range = createRange(match.startNode.ownerDocument, match);
    if (range && typeof range.getClientRects === "function") {
      const rect = Array.from(range.getClientRects()).find(
        (rect) => rect.width > 0 && rect.height > 0,
      );
      if (!rect) return;
      const containerRect = scrollContainer.getBoundingClientRect();
      const top = containerRect.top + scrollContainer.clientTop;
      const bottom = top + scrollContainer.clientHeight;
      if (rect.top < top || rect.bottom > bottom) {
        scrollContainer.scrollTop +=
          rect.top + rect.height / 2 - (top + scrollContainer.clientHeight / 2);
      }
      return;
    }
  }
  const target = match.startNode.parentElement;
  if (typeof target?.scrollIntoView === "function") {
    target.scrollIntoView({ block: "center", inline: "nearest" });
  }
}

/** DOMに接続された端点から範囲を作る。描画の更新で外れた端点を含む一致は使わない。 */
function createRange(
  document: Document,
  match: RenderedTextMatch,
): Range | null {
  if (!match.startNode.isConnected || !match.endNode.isConnected) {
    return null;
  }
  const range = document.createRange();
  range.setStart(match.startNode, match.startOffset);
  range.setEnd(match.endNode, match.endOffset);
  return range;
}

/** 文書から全件用と現在位置用の検索ハイライトだけを取り除く。 */
export function clearRenderedTextHighlights(document: Document): void {
  const highlightWindow = document.defaultView as HighlightWindow | null;
  highlightWindow?.CSS?.highlights?.delete(FIND_MATCH_HIGHLIGHT_NAME);
  highlightWindow?.CSS?.highlights?.delete(FIND_CURRENT_HIGHLIGHT_NAME);
}

/** 件数制限付きの全一致と現在位置を別名で登録する。CSS Highlight APIがなければfalseを返す。 */
export function applyRenderedTextHighlights(
  document: Document,
  matches: RenderedTextMatch[],
  currentMatch: RenderedTextMatch | null,
): boolean {
  const highlightWindow = document.defaultView as HighlightWindow | null;
  const registry = highlightWindow?.CSS?.highlights;
  const HighlightConstructor = highlightWindow?.Highlight;
  if (!registry || !HighlightConstructor) {
    return false;
  }
  const ranges = matches
    .slice(0, MAX_RENDERED_TEXT_HIGHLIGHT_RANGES)
    .map((match) => createRange(document, match))
    .filter((range): range is Range => range !== null);
  const currentRange = currentMatch
    ? createRange(document, currentMatch)
    : null;
  const matchHighlight = new HighlightConstructor();
  for (const range of ranges) {
    matchHighlight.add(range);
  }
  registry.set(FIND_MATCH_HIGHLIGHT_NAME, matchHighlight);
  if (currentRange) {
    const currentHighlight = new HighlightConstructor();
    currentHighlight.add(currentRange);
    registry.set(FIND_CURRENT_HIGHLIGHT_NAME, currentHighlight);
  } else {
    registry.delete(FIND_CURRENT_HIGHLIGHT_NAME);
  }
  return true;
}

/** 索引が持つノード区間数と、文字長の補正に必要な例外の件数を返す。 */
export function getRenderedTextSearchIndexStats(
  index: RenderedTextSearchIndex,
): {
  runCount: number;
  expandedOffsetCount: number;
} {
  return {
    runCount: index.runs.length,
    expandedOffsetCount: index.runs.reduce(
      (count, run) => count + run.expandedOffsets.length,
      0,
    ),
  };
}
