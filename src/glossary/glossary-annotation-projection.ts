import {
  normalizeGlossaryLookup,
  type GlossaryEntry,
} from "../glossary-contract.js";

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
};

type NormalizedTextProjection = {
  value: string;
  originalStarts: number[];
  originalEnds: number[];
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

function createGraphemeSegments(value: string): Array<{ segment: string; index: number }> {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(value), ({ segment, index }) => ({ segment, index }));
  }

  const segments: Array<{ segment: string; index: number }> = [];
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
      segments.push({ segment: current, index: currentIndex });
      current = codePoint;
      currentIndex = index;
    }
    index += codePoint.length;
  }
  if (current) {
    segments.push({ segment: current, index: currentIndex });
  }
  return segments;
}

function normalizeTextWithOffsets(value: string): NormalizedTextProjection {
  let normalized = "";
  const originalStarts: number[] = [];
  const originalEnds: number[] = [];

  for (const { segment, index } of createGraphemeSegments(value)) {
    const normalizedSegment = segment.normalize("NFKC").toLowerCase();
    const originalEnd = index + segment.length;
    for (const character of normalizedSegment) {
      if (/^\s$/u.test(character)) {
        if (normalized.endsWith(" ")) {
          originalEnds[originalEnds.length - 1] = originalEnd;
          continue;
        }
        normalized += " ";
        originalStarts.push(index);
        originalEnds.push(originalEnd);
        continue;
      }
      normalized += character;
      for (let unit = 0; unit < character.length; unit += 1) {
        originalStarts.push(index);
        originalEnds.push(originalEnd);
      }
    }
  }

  let start = 0;
  let end = normalized.length;
  while (start < end && normalized[start] === " ") start += 1;
  while (end > start && normalized[end - 1] === " ") end -= 1;
  return {
    value: normalized.slice(start, end),
    originalStarts: originalStarts.slice(start, end),
    originalEnds: originalEnds.slice(start, end),
  };
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
  return (start === 0 || starts[start] !== starts[start - 1])
    && (end === projection.value.length || starts[end] !== starts[end - 1]);
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

  const matchText = (text: string, budget: GlossaryAnnotationBudget): GlossaryAnnotationRange[] => {
    if (candidates === null || budget.limitReached || !text) return [];
    if (text.length > budget.remainingCodeUnits) {
      budget.limitReached = true;
      return [];
    }
    budget.remainingCodeUnits -= text.length;

    const projection = normalizeTextWithOffsets(text);
    if (projection.value.length > budget.remainingNormalizedCodeUnits) {
      budget.limitReached = true;
      return [];
    }
    budget.remainingNormalizedCodeUnits -= projection.value.length;
    const urlRanges = collectUrlRanges(text);
    const matches: GlossaryAnnotationRange[] = [];
    let previousOriginalEnd = 0;
    for (let normalizedIndex = 0; normalizedIndex < projection.value.length;) {
      const bucket = candidatesByFirstUnit.get(projection.value[normalizedIndex]) ?? [];
      let accepted: GlossaryAnnotationCandidate | null = null;
      for (const candidate of bucket) {
        budget.remainingComparisons -= 1;
        if (budget.remainingComparisons < 0) {
          budget.limitReached = true;
          return matches;
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
      const originalStart = projection.originalStarts[normalizedIndex];
      const originalEnd = projection.originalEnds[normalizedEnd - 1];
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
        return matches;
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
    return matches;
  };

  return {
    revision,
    disabledByLimit: candidates === null,
    createMessageBudget,
    matchText,
  };
}
