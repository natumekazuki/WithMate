import {
  normalizeGlossaryLookup,
  type GlossaryEntry,
} from "../../src-shared/glossary/glossary-contract.js";

export const GLOSSARY_ANNOTATION_LIMITS = {
  maxLookupValues: 10_000,
  maxMessageCodeUnits: 100_000,
  maxNormalizedMessageCodeUnits: 300_000,
  maxCandidateComparisonsPerMessage: 250_000,
  maxAnnotationsPerMessage: 200,
} as const;

export type GlossaryAnnotationRange = {
  start: number;
  end: number;
  matchedText: string;
  canonicalTerm: string;
  definition: string;
};

type GlossaryAnnotationCandidate = {
  normalized: string;
  canonicalTerm: string;
  definition: string;
  order: number;
};

export type GlossaryAnnotationBudget = {
  remainingCodeUnits: number;
  remainingNormalizedCodeUnits: number;
  remainingComparisons: number;
  remainingAnnotations: number;
  limitReached: boolean;
};

export type GlossaryAnnotationMatcher = {
  revision: string;
  disabledByLimit: boolean;
  createMessageBudget: () => GlossaryAnnotationBudget;
  matchText: (text: string, budget: GlossaryAnnotationBudget) => GlossaryAnnotationRange[];
  createMessageProjection: () => GlossaryMessageProjection;
};

export type GlossaryMessageProjection = {
  begin: () => GlossaryAnnotationBudget;
  matchText: GlossaryAnnotationMatcher["matchText"];
  finish: () => void;
};

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

const URL_PATTERN = /(?:\b[a-z][a-z0-9+.-]+:|\bwww\.|\/\/)[^\s<]+|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu;

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

function* createGraphemeSegments(value: string): Iterable<{ segment: string; index: number }> {
  // ASCII graphemes are single units except CRLF. No marks, Prepend, Hangul
  // or emoji context can occur in an entirely ASCII node/suffix.
  if (/^[\x00-\x7F]*$/u.test(value)) {
    for (let index = 0; index < value.length;) {
      const length = value[index] === "\r" && value[index + 1] === "\n" ? 2 : 1;
      yield { segment: value.slice(index, index + length), index };
      index += length;
    }
    return;
  }
  if (typeof Intl.Segmenter === "function") {
    graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
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

function normalizeTextWithOffsets(value: string, previous?: NormalizedTextProjection): NormalizedTextProjection {
  // Reuse only append-only prefixes ending before an observed grapheme that
  // starts with ASCII whitespace. The retained whitespace blocks NFKC/casing
  // context; the entire last grapheme and casing-sensitive tail are rebuilt.
  const resume = previous && typeof Intl.Segmenter === "function" && value.startsWith(previous.text)
    ? previous.resumeOriginalIndex : 0;
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
  let normalized = resume ? previous!.untrimmedValue.slice(0, normalizedPrefixLength) : "";
  const originalStarts = resume ? previous!.originalStarts : [];
  const originalEnds = resume ? previous!.originalEnds : [];
  originalStarts.length = normalizedPrefixLength;
  originalEnds.length = normalizedPrefixLength;
  let resumeOriginalIndex = resume;
  let resumeNormalizedIndex = normalizedPrefixLength;
  let loweredIndex = 0;
  for (let index = 0; index < compatibilityNormalized.length;) {
    const character = String.fromCodePoint(compatibilityNormalized.codePointAt(index) ?? 0);
    const loweredLength = character.toLowerCase().length;
    const originalStart = compatibilityStarts[index];
    const originalEnd = compatibilityEnds[index + character.length - 1];
    const loweredCharacter = lowered.slice(loweredIndex, loweredIndex + loweredLength);
    if (
      (index === 0 || compatibilityStarts[index] !== compatibilityStarts[index - 1])
      && /^[ \t\r\n]/u.test(value[originalStart])
      && !normalized.endsWith(" ")
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
  if (compatibilityNormalized !== suffix.normalize("NFKC") || loweredIndex !== lowered.length) {
    projection.value = "";
    projection.untrimmedValue = "";
    projection.originalStarts.length = 0;
    projection.originalEnds.length = 0;
    projection.resumeOriginalIndex = 0;
    projection.resumeNormalizedIndex = 0;
  }
  return projection;
}

function codePointBefore(value: string, index: number): string {
  if (index <= 0) return "";
  const trailing = value.charCodeAt(index - 1);
  const start = trailing >= 0xDC00 && trailing <= 0xDFFF && index >= 2 ? index - 2 : index - 1;
  return String.fromCodePoint(value.codePointAt(start) ?? 0);
}

function codePointAt(value: string, index: number): string {
  return index >= value.length ? "" : String.fromCodePoint(value.codePointAt(index) ?? 0);
}

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

function identifiersJoin(left: string, right: string): boolean {
  const leftClass = identifierClass(left);
  const rightClass = identifierClass(right);
  if (!leftClass || !rightClass) return false;
  return leftClass === rightClass
    || leftClass === "connector"
    || rightClass === "connector"
    || leftClass === "number"
    || rightClass === "number"
    || leftClass === "mark"
    || rightClass === "mark";
}

function hasIdentifierBoundary(value: string, start: number, candidate: string): boolean {
  const first = codePointAt(candidate, 0);
  const last = codePointBefore(candidate, candidate.length);
  return !identifiersJoin(codePointBefore(value, start), first)
    && !identifiersJoin(last, codePointAt(value, start + candidate.length));
}

function collectUrlRanges(value: string): Array<{ start: number; end: number }> {
  return Array.from(value.matchAll(URL_PATTERN), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function overlapsRange(start: number, end: number, ranges: readonly { start: number; end: number }[]): boolean {
  return ranges.some((range) => start < range.end && end > range.start);
}

function alignsWithOriginalBoundaries(
  projection: NormalizedTextProjection,
  start: number,
  end: number,
): boolean {
  const starts = projection.originalStarts;
  const offset = projection.trimStart;
  return (start === 0 || starts[start + offset] !== starts[start + offset - 1])
    && (end === projection.value.length || starts[end + offset] !== starts[end + offset - 1]);
}

function buildCandidates(entries: readonly GlossaryEntry[]): GlossaryAnnotationCandidate[] | null {
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

export function createGlossaryAnnotationMatcher(
  entries: readonly GlossaryEntry[],
  revision: string,
): GlossaryAnnotationMatcher {
  const candidates = buildCandidates(entries);
  const candidatesByFirstUnit = new Map<string, GlossaryAnnotationCandidate[]>();
  for (const candidate of candidates ?? []) {
    const firstUnit = candidate.normalized[0];
    if (!firstUnit) continue;
    const bucket = candidatesByFirstUnit.get(firstUnit) ?? [];
    bucket.push(candidate);
    candidatesByFirstUnit.set(firstUnit, bucket);
  }
  for (const bucket of candidatesByFirstUnit.values()) {
    bucket.sort((left, right) => right.normalized.length - left.normalized.length || left.order - right.order);
  }

  const createMessageBudget = (): GlossaryAnnotationBudget => ({
    remainingCodeUnits: GLOSSARY_ANNOTATION_LIMITS.maxMessageCodeUnits,
    remainingNormalizedCodeUnits: GLOSSARY_ANNOTATION_LIMITS.maxNormalizedMessageCodeUnits,
    remainingComparisons: GLOSSARY_ANNOTATION_LIMITS.maxCandidateComparisonsPerMessage,
    remainingAnnotations: GLOSSARY_ANNOTATION_LIMITS.maxAnnotationsPerMessage,
    limitReached: candidates === null,
  });

  type CachedText = {
    text: string;
    projection: NormalizedTextProjection;
    before: GlossaryAnnotationBudget;
    after: GlossaryAnnotationBudget;
    matches: GlossaryAnnotationRange[];
  };
  const sameBudget = (left: GlossaryAnnotationBudget, right: GlossaryAnnotationBudget) =>
    left.remainingCodeUnits === right.remainingCodeUnits
    && left.remainingNormalizedCodeUnits === right.remainingNormalizedCodeUnits
    && left.remainingComparisons === right.remainingComparisons
    && left.remainingAnnotations === right.remainingAnnotations
    && left.limitReached === right.limitReached;

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

    const projection = previous?.text === text ? previous.projection : normalizeTextWithOffsets(text, previous?.projection);
    const matches: GlossaryAnnotationRange[] = [];
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
      const bucket = candidatesByFirstUnit.get(projection.value[normalizedIndex]) ?? [];
      let accepted: GlossaryAnnotationCandidate | null = null;
      for (const candidate of bucket) {
        budget.remainingComparisons -= 1;
        if (budget.remainingComparisons < 0) {
          budget.limitReached = true;
          return complete();
        }
        if (
          projection.value.startsWith(candidate.normalized, normalizedIndex)
          && hasIdentifierBoundary(projection.value, normalizedIndex, candidate.normalized)
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
      const originalStart = projection.originalStarts[normalizedIndex + projection.trimStart];
      const originalEnd = projection.originalEnds[normalizedEnd + projection.trimStart - 1];
      if (
        originalStart === undefined
        || originalEnd === undefined
        || !alignsWithOriginalBoundaries(projection, normalizedIndex, normalizedEnd)
        || originalStart < previousOriginalEnd
        || originalEnd <= originalStart
        || overlapsRange(originalStart, originalEnd, urlRanges)
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
    matchText: (text, budget) => matchProjectedText(text, budget),
    createMessageProjection: () => {
      // Only the current message's eligible text nodes survive a pass. This
      // owner is replaced on matcher/scope change and released on unmount.
      const nodes: Array<CachedText | undefined> = [];
      let cursor = 0;
      return {
        begin: () => {
          cursor = 0;
          return createMessageBudget();
        },
        matchText: (text, budget) => {
          if (!candidates?.length || budget.limitReached || !text) return [];
          const index = cursor++;
          const previous = nodes[index];
          nodes[index] = undefined;
          return matchProjectedText(text, budget, previous, (cached) => { nodes[index] = cached; });
        },
        finish: () => { nodes.length = cursor; },
      };
    },
  };
}
