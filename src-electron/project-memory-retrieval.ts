import type { ProjectMemoryEntry, SessionMemory } from "../src/app-state.js";
import { computeMemoryTimeDecayScore } from "./memory-time-decay.js";

type RetrievedProjectMemory = {
  entry: ProjectMemoryEntry;
  score: number;
  userCoverage: number;
  sessionCoverage: number;
  fingerprint: string;
};

type QueryFeature = {
  value: string;
  kind: "word" | "ngram";
};

const CATEGORY_WEIGHTS: Record<ProjectMemoryEntry["category"], number> = {
  decision: 5,
  constraint: 4,
  convention: 3,
  context: 2,
  deferred: 1,
};

function normalizeText(text: string): string {
  return text.trim().toLowerCase();
}

function isLowSignalJapaneseToken(token: string): boolean {
  return /^[ぁ-ゖー]+$/u.test(token);
}

function tokenizeWords(text: string): string[] {
  const tokens = text.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  return tokens
    .map((token) => normalizeText(token))
    .filter((token) => token.length > 0 && !isLowSignalJapaneseToken(token));
}

function tokenizeNgrams(text: string): string[] {
  const result = new Set<string>();
  const segments = normalizeText(text).match(/[一-龯ぁ-ゖァ-ヴー]{2,}/gu) ?? [];
  for (const segment of segments) {
    const chars = [...segment];
    for (const size of [2, 3]) {
      if (chars.length < size) {
        continue;
      }

      for (let index = 0; index <= chars.length - size; index += 1) {
        const token = chars.slice(index, index + size).join("");
        if (isLowSignalJapaneseToken(token)) {
          continue;
        }

        result.add(token);
      }
    }
  }

  return [...result];
}

function collectQueryFeatures(text: string): QueryFeature[] {
  const features = new Map<string, QueryFeature>();
  for (const token of tokenizeWords(text)) {
    features.set(`word:${token}`, { value: token, kind: "word" });
  }
  for (const token of tokenizeNgrams(text)) {
    features.set(`ngram:${token}`, { value: token, kind: "ngram" });
  }

  return [...features.values()];
}

function buildSessionContextText(sessionMemory: SessionMemory): string {
  return [
    sessionMemory.goal,
    ...sessionMemory.openQuestions.slice(0, 3),
  ]
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join("\n");
}

function scoreMatches(
  haystack: string,
  queryFeatures: QueryFeature[],
  weight: number,
): { score: number; matchedFeatureKeys: Set<string> } {
  let score = 0;
  const matchedFeatureKeys = new Set<string>();
  for (const feature of queryFeatures) {
    if (!feature.value || !haystack.includes(feature.value)) {
      continue;
    }

    score += feature.kind === "word" ? weight : Math.max(1, weight - 2);
    matchedFeatureKeys.add(`${feature.kind}:${feature.value}`);
  }

  return { score, matchedFeatureKeys };
}

function scoreEntryPart(
  entry: ProjectMemoryEntry,
  queryText: string,
  queryFeatures: QueryFeature[],
  weights: { title: number; keywords: number; detail: number; fullTextBonus: number; fullDetailBonus: number },
): { score: number; matchedFeatureKeys: Set<string> } {
  const normalizedQuery = normalizeText(queryText);
  const titleHaystack = normalizeText(entry.title);
  const detailHaystack = normalizeText(entry.detail);
  const keywordsHaystack = normalizeText(entry.keywords.join(" "));

  let score = 0;
  const matchedFeatureKeys = new Set<string>();
  const titleMatches = scoreMatches(titleHaystack, queryFeatures, weights.title);
  const keywordsMatches = scoreMatches(keywordsHaystack, queryFeatures, weights.keywords);
  const detailMatches = scoreMatches(detailHaystack, queryFeatures, weights.detail);
  score += titleMatches.score;
  score += keywordsMatches.score;
  score += detailMatches.score;
  for (const key of titleMatches.matchedFeatureKeys) {
    matchedFeatureKeys.add(key);
  }
  for (const key of keywordsMatches.matchedFeatureKeys) {
    matchedFeatureKeys.add(key);
  }
  for (const key of detailMatches.matchedFeatureKeys) {
    matchedFeatureKeys.add(key);
  }

  if (normalizedQuery && titleHaystack.includes(normalizedQuery)) {
    score += weights.fullTextBonus;
  }

  if (normalizedQuery && detailHaystack.includes(normalizedQuery)) {
    score += weights.fullDetailBonus;
  }

  return { score, matchedFeatureKeys };
}

function computeCoverageBonus(matchedFeatureKeys: Set<string>): { bonus: number; coverage: number } {
  const coverage = matchedFeatureKeys.size;
  if (coverage <= 0) {
    return { bonus: 0, coverage: 0 };
  }

  return {
    bonus: Math.min(coverage, 4) * 2,
    coverage,
  };
}

function computeMinimumScore(userFeatures: QueryFeature[]): number {
  const wordCount = userFeatures.filter((feature) => feature.kind === "word").length;
  const ngramCount = userFeatures.filter((feature) => feature.kind === "ngram").length;
  if (wordCount >= 3) {
    return 12;
  }
  if (wordCount >= 1) {
    return 10;
  }
  if (ngramCount >= 4) {
    return 8;
  }

  return 6;
}

function computeMinimumCoverage(userFeatures: QueryFeature[]): number {
  const wordCount = userFeatures.filter((feature) => feature.kind === "word").length;
  return wordCount >= 2 ? 2 : 1;
}

function buildEntryFingerprint(entry: ProjectMemoryEntry): string {
  const normalizedTitle = normalizeText(entry.title).replace(/\s+/g, " ").trim();
  const normalizedDetail = normalizeText(entry.detail).replace(/\s+/g, " ").trim();
  return `${entry.category}\u001f${normalizedTitle}\u001f${normalizedDetail}`;
}

function dedupeRankedEntries(ranked: RetrievedProjectMemory[]): RetrievedProjectMemory[] {
  const selectedFingerprints = new Set<string>();
  const result: RetrievedProjectMemory[] = [];
  for (const item of ranked) {
    if (selectedFingerprints.has(item.fingerprint)) {
      continue;
    }

    selectedFingerprints.add(item.fingerprint);
    result.push(item);
  }

  return result;
}

function scoreEntry(
  entry: ProjectMemoryEntry,
  userMessage: string,
  userFeatures: QueryFeature[],
  sessionContextText: string,
  sessionFeatures: QueryFeature[],
  nowMs: number,
): RetrievedProjectMemory | null {
  const userPart = scoreEntryPart(entry, userMessage, userFeatures, {
    title: 6,
    keywords: 5,
    detail: 2,
    fullTextBonus: 20,
    fullDetailBonus: 8,
  });
  if (userPart.score <= 0) {
    return null;
  }
  const userCoverage = computeCoverageBonus(userPart.matchedFeatureKeys);

  const sessionPart = sessionFeatures.length > 0
    ? scoreEntryPart(entry, sessionContextText, sessionFeatures, {
      title: 2,
      keywords: 1,
      detail: 1,
      fullTextBonus: 4,
      fullDetailBonus: 2,
    })
    : { score: 0, matchedFeatureKeys: new Set<string>() };
  const sessionCoverage = computeCoverageBonus(sessionPart.matchedFeatureKeys);

  const score =
    CATEGORY_WEIGHTS[entry.category]
    + userPart.score
    + userCoverage.bonus
    + sessionPart.score
    + sessionCoverage.bonus
    + computeMemoryTimeDecayScore(entry.lastUsedAt, entry.updatedAt, nowMs);

  return {
    entry,
    score,
    userCoverage: userCoverage.coverage,
    sessionCoverage: sessionCoverage.coverage,
    fingerprint: buildEntryFingerprint(entry),
  };
}

export function retrieveProjectMemoryEntries(
  entries: ProjectMemoryEntry[],
  userMessage: string,
  sessionMemory: SessionMemory,
  maxEntries = 3,
): ProjectMemoryEntry[] {
  const userText = userMessage.trim();
  const userFeatures = collectQueryFeatures(userText);
  const sessionContextText = buildSessionContextText(sessionMemory);
  const sessionFeatures = collectQueryFeatures(sessionContextText);
  const minimumScore = computeMinimumScore(userFeatures);
  const minimumCoverage = computeMinimumCoverage(userFeatures);
  const nowMs = Date.now();
  const ranked: RetrievedProjectMemory[] = [];

  for (const entry of entries) {
    const scored = scoreEntry(entry, userText, userFeatures, sessionContextText, sessionFeatures, nowMs);
    if (!scored || scored.score < minimumScore || scored.userCoverage < minimumCoverage) {
      continue;
    }

    ranked.push(scored);
  }

  ranked.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (right.userCoverage !== left.userCoverage) {
      return right.userCoverage - left.userCoverage;
    }
    if (right.sessionCoverage !== left.sessionCoverage) {
      return right.sessionCoverage - left.sessionCoverage;
    }

    return right.entry.updatedAt.localeCompare(left.entry.updatedAt);
  });

  return dedupeRankedEntries(ranked).slice(0, maxEntries).map((item) => item.entry);
}
