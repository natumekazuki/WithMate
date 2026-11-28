import {
  normalizeGlossaryLookup,
  type GlossaryEntry,
} from "../../src-shared/glossary/glossary-contract.js";

/** 注釈のために扱う候補・本文・正規化・照合回数・一致数の上限。本文の通常表示は制限しない。 */
export const GLOSSARY_ANNOTATION_LIMITS = {
  maxLookupValues: 10_000,
  maxMessageCodeUnits: 100_000,
  maxNormalizedMessageCodeUnits: 300_000,
  maxCandidateComparisonsPerMessage: 250_000,
  maxAnnotationsPerMessage: 200,
} as const;

/** 元のテキストノード内の UTF-16 範囲と、表示文字列に対応する正規用語および定義。 */
export type GlossaryAnnotationRange = {
  start: number;
  end: number;
  matchedText: string;
  canonicalTerm: string;
  definition: string;
};

/** 正規化した用語または別名と、同じ長さの候補の優先順を含む照合項目。 */
type GlossaryAnnotationCandidate = {
  normalized: string;
  canonicalTerm: string;
  definition: string;
  order: number;
};

/** メッセージ一件の全テキストノードで共有する残りの処理量と、上限に達したかどうか。 */
export type GlossaryAnnotationBudget = {
  remainingCodeUnits: number;
  remainingNormalizedCodeUnits: number;
  remainingComparisons: number;
  remainingAnnotations: number;
  limitReached: boolean;
};

/** 一つの用語集の版に紐付く照合器。候補上限で無効になった場合も用語集の版は保持する。 */
export type GlossaryAnnotationMatcher = {
  revision: string;
  disabledByLimit: boolean;
  createMessageBudget: () => GlossaryAnnotationBudget;
  matchText: (
    text: string,
    budget: GlossaryAnnotationBudget,
  ) => GlossaryAnnotationRange[];
  createMessageProjection: () => GlossaryMessageProjection;
};

/** 同一メッセージの繰り返し描画でノードごとの照合を再利用する、一巡単位の操作。 */
export type GlossaryMessageProjection = {
  begin: () => GlossaryAnnotationBudget;
  matchText: GlossaryAnnotationMatcher["matchText"];
  finish: () => void;
};

/** 照合用の正規化本文と元の文字範囲への対応、および後続の追記で再利用できる境界。 */
type NormalizedTextProjection = {
  text: string;
  value: string;
  untrimmedValue: string;
  trimStart: number;
  originalStarts: number[];
  originalEnds: number[];
  resumeOriginalIndex: number;
  resumeNormalizedIndex: number;
};

const URL_PATTERN =
  /(?:\b[a-z][a-z0-9+.-]+:|\bwww\.|\/\/)[^\s<]+|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu;

/** 用語の前後が識別子の一部かを判断するための、文字種と文字体系の分類。 */
type IdentifierClass =
  | "connector"
  | "number"
  | "mark"
  | "latin"
  | "greek"
  | "cyrillic"
  | "han"
  | "hiragana"
  | "katakana"
  | "hangul"
  | "other-letter";

let graphemeSegmenter: Intl.Segmenter | undefined;

/** 書記素と元の位置を順に返す。ASCII は直接処理し、分割器がなければ結合マークを直前の文字にまとめる。 */
function* createGraphemeSegments(
  value: string,
): Iterable<{ segment: string; index: number }> {
  // ASCII の書記素は CRLF を除き一単位。ノードや接尾部がすべて ASCII なら、
  // 結合マーク、Prepend、ハングル、絵文字に関わる文脈は現れない。
  if (/^[\x00-\x7F]*$/u.test(value)) {
    for (let index = 0; index < value.length;) {
      const length = value[index] === "\r" && value[index + 1] === "\n" ? 2 : 1;
      yield { segment: value.slice(index, index + length), index };
      index += length;
    }
    return;
  }
  if (typeof Intl.Segmenter === "function") {
    graphemeSegmenter ??= new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    });
    yield* graphemeSegmenter.segment(value);
    return;
  }

  let current = "";
  let currentIndex = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = String.fromCodePoint(value.codePointAt(index) ?? 0);
    const isMark = /^\p{M}$/u.test(codePoint);
    if (!current || isMark) {
      if (!current) {
        currentIndex = index;
      }
      current += codePoint;
    } else {
      yield { segment: current, index: currentIndex };
      current = codePoint;
      currentIndex = index;
    }
    index += codePoint.length;
  }
  if (current) {
    yield { segment: current, index: currentIndex };
  }
}

/** 照合用に正規化しつつ各コード単位の元範囲を保持し、処理範囲の一括正規化と整合しない対応は破棄する。 */
function normalizeTextWithOffsets(
  value: string,
  previous?: NormalizedTextProjection,
): NormalizedTextProjection {
  // 追記のみの場合に、観測済みで ASCII 空白から始まる書記素の直前までの接頭部だけを再利用する。
  // 残した空白が NFKC 正規化と大文字・小文字変換の文脈を分断する。
  // 最後の書記素全体と、大文字・小文字変換の影響を受ける末尾は再構築する。
  const resume =
    previous &&
    typeof Intl.Segmenter === "function" &&
    value.startsWith(previous.text)
      ? previous.resumeOriginalIndex
      : 0;
  const normalizedPrefixLength = resume ? previous!.resumeNormalizedIndex : 0;
  const suffix = value.slice(resume);
  let compatibilityNormalized = "";
  const compatibilityStarts: number[] = [];
  const compatibilityEnds: number[] = [];

  for (const { segment, index } of createGraphemeSegments(suffix)) {
    const normalizedSegment = segment.normalize("NFKC");
    const originalStart = resume + index;
    const originalEnd = originalStart + segment.length;
    for (const character of normalizedSegment) {
      compatibilityNormalized += character;
      for (let unit = 0; unit < character.length; unit += 1) {
        compatibilityStarts.push(originalStart);
        compatibilityEnds.push(originalEnd);
      }
    }
  }

  const lowered = compatibilityNormalized.toLowerCase();
  let normalized = resume
    ? previous!.untrimmedValue.slice(0, normalizedPrefixLength)
    : "";
  const originalStarts = resume ? previous!.originalStarts : [];
  const originalEnds = resume ? previous!.originalEnds : [];
  originalStarts.length = normalizedPrefixLength;
  originalEnds.length = normalizedPrefixLength;
  let resumeOriginalIndex = resume;
  let resumeNormalizedIndex = normalizedPrefixLength;
  let loweredIndex = 0;
  for (let index = 0; index < compatibilityNormalized.length;) {
    const character = String.fromCodePoint(
      compatibilityNormalized.codePointAt(index) ?? 0,
    );
    const loweredLength = character.toLowerCase().length;
    const originalStart = compatibilityStarts[index];
    const originalEnd = compatibilityEnds[index + character.length - 1];
    const loweredCharacter = lowered.slice(
      loweredIndex,
      loweredIndex + loweredLength,
    );
    if (
      (index === 0 ||
        compatibilityStarts[index] !== compatibilityStarts[index - 1]) &&
      /^[ \t\r\n]/u.test(value[originalStart]) &&
      !normalized.endsWith(" ")
    ) {
      resumeOriginalIndex = originalStart;
      resumeNormalizedIndex = normalized.length;
    }
    for (const unitCharacter of loweredCharacter) {
      if (/^\s$/u.test(unitCharacter)) {
        if (normalized.endsWith(" ")) {
          originalEnds[originalEnds.length - 1] = originalEnd;
        } else {
          normalized += " ";
          originalStarts.push(originalStart);
          originalEnds.push(originalEnd);
        }
        continue;
      }
      normalized += unitCharacter;
      for (let unit = 0; unit < unitCharacter.length; unit += 1) {
        originalStarts.push(originalStart);
        originalEnds.push(originalEnd);
      }
    }
    loweredIndex += loweredLength;
    index += character.length;
  }

  let start = 0;
  let end = normalized.length;
  while (start < end && normalized[start] === " ") start += 1;
  while (end > start && normalized[end - 1] === " ") end -= 1;
  const projection = {
    text: value,
    value: normalized.slice(start, end),
    untrimmedValue: normalized,
    trimStart: start,
    originalStarts,
    originalEnds,
    resumeOriginalIndex,
    resumeNormalizedIndex,
  };
  if (
    compatibilityNormalized !== suffix.normalize("NFKC") ||
    loweredIndex !== lowered.length
  ) {
    projection.value = "";
    projection.untrimmedValue = "";
    projection.originalStarts.length = 0;
    projection.originalEnds.length = 0;
    projection.resumeOriginalIndex = 0;
    projection.resumeNormalizedIndex = 0;
  }
  return projection;
}

/** 指定の UTF-16 位置の直前の文字をサロゲートを考慮して取得し、先頭では空を返す。 */
function codePointBefore(value: string, index: number): string {
  if (index <= 0) return "";
  const trailing = value.charCodeAt(index - 1);
  const start =
    trailing >= 0xdc00 && trailing <= 0xdfff && index >= 2
      ? index - 2
      : index - 1;
  return String.fromCodePoint(value.codePointAt(start) ?? 0);
}

/** 指定位置から始まるコードポイントを文字列で返し、末尾以降は空にする。 */
function codePointAt(value: string, index: number): string {
  return index >= value.length
    ? ""
    : String.fromCodePoint(value.codePointAt(index) ?? 0);
}

/** 境界の判定対象になる文字を分類し、空白・区切りなど対象外の文字は null とする。 */
function identifierClass(value: string): IdentifierClass | null {
  if (!value) return null;
  if (/^[\p{Pc}\u200C\u200D]$/u.test(value)) return "connector";
  if (/^\p{N}$/u.test(value)) return "number";
  if (/^\p{M}$/u.test(value)) return "mark";
  if (/^\p{Script=Latin}$/u.test(value)) return "latin";
  if (/^\p{Script=Greek}$/u.test(value)) return "greek";
  if (/^\p{Script=Cyrillic}$/u.test(value)) return "cyrillic";
  if (/^\p{Script=Han}$/u.test(value)) return "han";
  if (/^\p{Script=Hiragana}$/u.test(value)) return "hiragana";
  if (/^\p{Script=Katakana}$/u.test(value)) return "katakana";
  if (/^\p{Script=Hangul}$/u.test(value)) return "hangul";
  return /^\p{L}$/u.test(value) ? "other-letter" : null;
}

/** 同種の文字や数字・結合マーク・連結文字を挟む並びを、連続した識別子として扱う。 */
function identifiersJoin(left: string, right: string): boolean {
  const leftClass = identifierClass(left);
  const rightClass = identifierClass(right);
  if (!leftClass || !rightClass) return false;
  return (
    leftClass === rightClass ||
    leftClass === "connector" ||
    rightClass === "connector" ||
    leftClass === "number" ||
    rightClass === "number" ||
    leftClass === "mark" ||
    rightClass === "mark"
  );
}

/** 用語が周囲の識別子の一部になっていないことを、開始と終了の両端で確かめる。 */
function hasIdentifierBoundary(
  value: string,
  start: number,
  candidate: string,
): boolean {
  const first = codePointAt(candidate, 0);
  const last = codePointBefore(candidate, candidate.length);
  return (
    !identifiersJoin(codePointBefore(value, start), first) &&
    !identifiersJoin(last, codePointAt(value, start + candidate.length))
  );
}

/** 本文内の URL・メールアドレスらしい範囲を、注釈から除外するために記録する。 */
function collectUrlRanges(
  value: string,
): Array<{ start: number; end: number }> {
  return Array.from(value.matchAll(URL_PATTERN), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/** 候補の半開区間が除外範囲と少しでも重なるかを調べる。端に接するだけなら重ならない。 */
function overlapsRange(
  start: number,
  end: number,
  ranges: readonly { start: number; end: number }[],
): boolean {
  return ranges.some((range) => start < range.end && end > range.start);
}

/** 正規化で複数文字へ展開した一つの書記素を、途中だけ注釈しないよう両端を検査する。 */
function alignsWithOriginalBoundaries(
  projection: NormalizedTextProjection,
  start: number,
  end: number,
): boolean {
  const starts = projection.originalStarts;
  const offset = projection.trimStart;
  return (
    (start === 0 || starts[start + offset] !== starts[start + offset - 1]) &&
    (end === projection.value.length ||
      starts[end + offset] !== starts[end + offset - 1])
  );
}

/** 正規用語と別名を入力順に照合候補へ変換し、上限まで登録した後に残りがあれば照合を無効にする。 */
function buildCandidates(
  entries: readonly GlossaryEntry[],
): GlossaryAnnotationCandidate[] | null {
  const candidates: GlossaryAnnotationCandidate[] = [];
  let order = 0;
  for (const entry of entries) {
    for (const displayValue of [entry.term, ...entry.aliases]) {
      if (candidates.length >= GLOSSARY_ANNOTATION_LIMITS.maxLookupValues) {
        return null;
      }
      const normalized = normalizeGlossaryLookup(displayValue);
      if (normalized) {
        candidates.push({
          normalized,
          canonicalTerm: entry.term,
          definition: entry.definition,
          order,
        });
        order += 1;
      }
    }
  }
  return candidates;
}

/** 先頭単位で候補を絞り、最長一致を優先する照合器を、一つの用語集の版について作る。 */
export function createGlossaryAnnotationMatcher(
  entries: readonly GlossaryEntry[],
  revision: string,
): GlossaryAnnotationMatcher {
  const candidates = buildCandidates(entries);
  const candidatesByFirstUnit = new Map<
    string,
    GlossaryAnnotationCandidate[]
  >();
  for (const candidate of candidates ?? []) {
    const firstUnit = candidate.normalized[0];
    if (!firstUnit) continue;
    const bucket = candidatesByFirstUnit.get(firstUnit) ?? [];
    bucket.push(candidate);
    candidatesByFirstUnit.set(firstUnit, bucket);
  }
  for (const bucket of candidatesByFirstUnit.values()) {
    bucket.sort(
      (left, right) =>
        right.normalized.length - left.normalized.length ||
        left.order - right.order,
    );
  }

  /** ノード間で消費する各上限を、メッセージを照合するたびに初期化する。 */
  const createMessageBudget = (): GlossaryAnnotationBudget => ({
    remainingCodeUnits: GLOSSARY_ANNOTATION_LIMITS.maxMessageCodeUnits,
    remainingNormalizedCodeUnits:
      GLOSSARY_ANNOTATION_LIMITS.maxNormalizedMessageCodeUnits,
    remainingComparisons:
      GLOSSARY_ANNOTATION_LIMITS.maxCandidateComparisonsPerMessage,
    remainingAnnotations: GLOSSARY_ANNOTATION_LIMITS.maxAnnotationsPerMessage,
    limitReached: candidates === null,
  });

  /** ノードの正規化と一致を再利用するため、処理前後の予算も原文と一緒に保持する。 */
  type CachedText = {
    text: string;
    projection: NormalizedTextProjection;
    before: GlossaryAnnotationBudget;
    after: GlossaryAnnotationBudget;
    matches: GlossaryAnnotationRange[];
  };
  /** キャッシュ済みの一致数と停止位置を再利用できるよう、消費前の予算全体を比較する。 */
  const sameBudget = (
    left: GlossaryAnnotationBudget,
    right: GlossaryAnnotationBudget,
  ) =>
    left.remainingCodeUnits === right.remainingCodeUnits &&
    left.remainingNormalizedCodeUnits === right.remainingNormalizedCodeUnits &&
    left.remainingComparisons === right.remainingComparisons &&
    left.remainingAnnotations === right.remainingAnnotations &&
    left.limitReached === right.limitReached;

  /** 識別子・書記素の境界と除外範囲を守って照合し、元の本文上の重ならない一致を予算内で返す。 */
  const matchProjectedText = (
    text: string,
    budget: GlossaryAnnotationBudget,
    previous?: CachedText,
    remember?: (cached: CachedText) => void,
  ): GlossaryAnnotationRange[] => {
    if (!candidates?.length || budget.limitReached || !text) return [];
    if (previous?.text === text && sameBudget(budget, previous.before)) {
      Object.assign(budget, previous.after);
      remember?.(previous);
      return previous.matches;
    }
    if (text.length > budget.remainingCodeUnits) {
      budget.limitReached = true;
      return [];
    }
    const before = { ...budget };
    budget.remainingCodeUnits -= text.length;

    const projection =
      previous?.text === text
        ? previous.projection
        : normalizeTextWithOffsets(text, previous?.projection);
    const matches: GlossaryAnnotationRange[] = [];
    /** 照合を終えた時点の予算と一致範囲を、このノードを再利用するために記録する。 */
    const complete = () => {
      remember?.({ text, projection, before, after: { ...budget }, matches });
      return matches;
    };
    if (projection.value.length > budget.remainingNormalizedCodeUnits) {
      budget.limitReached = true;
      return matches;
    }
    budget.remainingNormalizedCodeUnits -= projection.value.length;
    const urlRanges = collectUrlRanges(text);
    let previousOriginalEnd = 0;
    for (let normalizedIndex = 0; normalizedIndex < projection.value.length;) {
      const bucket =
        candidatesByFirstUnit.get(projection.value[normalizedIndex]) ?? [];
      let accepted: GlossaryAnnotationCandidate | null = null;
      for (const candidate of bucket) {
        budget.remainingComparisons -= 1;
        if (budget.remainingComparisons < 0) {
          budget.limitReached = true;
          return complete();
        }
        if (
          projection.value.startsWith(candidate.normalized, normalizedIndex) &&
          hasIdentifierBoundary(
            projection.value,
            normalizedIndex,
            candidate.normalized,
          )
        ) {
          accepted = candidate;
          break;
        }
      }

      if (!accepted) {
        normalizedIndex += 1;
        continue;
      }

      const normalizedEnd = normalizedIndex + accepted.normalized.length;
      const originalStart =
        projection.originalStarts[normalizedIndex + projection.trimStart];
      const originalEnd =
        projection.originalEnds[normalizedEnd + projection.trimStart - 1];
      if (
        originalStart === undefined ||
        originalEnd === undefined ||
        !alignsWithOriginalBoundaries(
          projection,
          normalizedIndex,
          normalizedEnd,
        ) ||
        originalStart < previousOriginalEnd ||
        originalEnd <= originalStart ||
        overlapsRange(originalStart, originalEnd, urlRanges)
      ) {
        normalizedIndex += 1;
        continue;
      }
      if (budget.remainingAnnotations <= 0) {
        budget.limitReached = true;
        return complete();
      }

      matches.push({
        start: originalStart,
        end: originalEnd,
        matchedText: text.slice(originalStart, originalEnd),
        canonicalTerm: accepted.canonicalTerm,
        definition: accepted.definition,
      });
      previousOriginalEnd = originalEnd;
      budget.remainingAnnotations -= 1;
      normalizedIndex = normalizedEnd;
    }
    return complete();
  };

  return {
    revision,
    disabledByLimit: candidates === null,
    createMessageBudget,
    /** ノードに対して、以前の描画結果を使わず指定の共有予算で照合する。 */
    matchText: (text, budget) => matchProjectedText(text, budget),
    /** 現在のメッセージに属するノードに限って、繰り返しの照合結果を保持する。 */
    createMessageProjection: () => {
      // 処理を一巡した後に残すのは、現在のメッセージで対象となるテキストノードだけ。
      // 照合器や対象範囲が変わればこの所有単位を置き換え、アンマウント時に解放する。
      const nodes: Array<CachedText | undefined> = [];
      let cursor = 0;
      return {
        /** ノードの処理順を先頭へ戻し、この描画用の予算を開始する。 */
        begin: () => {
          cursor = 0;
          return createMessageBudget();
        },
        /** 現在の順番にあった以前のノードを照合へ渡し、再利用できる新しい状態を保存する。 */
        matchText: (text, budget) => {
          if (!candidates?.length || budget.limitReached || !text) return [];
          const index = cursor++;
          const previous = nodes[index];
          nodes[index] = undefined;
          return matchProjectedText(text, budget, previous, (cached) => {
            nodes[index] = cached;
          });
        },
        /** 現在の描画で参照しなかった末尾ノードのキャッシュを捨てる。 */
        finish: () => {
          nodes.length = cursor;
        },
      };
    },
  };
}
