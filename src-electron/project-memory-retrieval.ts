import type { ProjectMemoryEntry, SessionMemory } from "../src/memory-state.js";
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

type IndexedProjectMemoryEntry = {
  entry: ProjectMemoryEntry;
  titleHaystack: string;
  detailHaystack: string;
  keywordsHaystack: string;
  fingerprint: string;
  featureKeys: Set<string>;
};

type ProjectMemoryEntryIndexData = Omit<IndexedProjectMemoryEntry, "entry">;

const CATEGORY_WEIGHTS: Record<ProjectMemoryEntry["category"], number> = {
  decision: 5,
  constraint: 4,
  convention: 3,
  context: 2,
  deferred: 1,
};

const MAX_ENTRY_INDEX_CACHE_SIZE = 2_000;
const entryIndexCache = new Map<string, ProjectMemoryEntryIndexData>();

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

function toFeatureKey(feature: QueryFeature): string {
  return `${feature.kind}:${feature.value}`;
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
    matchedFeatureKeys.add(toFeatureKey(feature));
  }

  return { score, matchedFeatureKeys };
}

function scoreEntryPart(
  indexed: IndexedProjectMemoryEntry,
  queryText: string,
  queryFeatures: QueryFeature[],
  weights: { title: number; keywords: number; detail: number; fullTextBonus: number; fullDetailBonus: number },
): { score: number; matchedFeatureKeys: Set<string> } {
  const normalizedQuery = normalizeText(queryText);

  const titleMatches = scoreMatches(indexed.titleHaystack, queryFeatures, weights.title);
  const keywordsMatches = scoreMatches(indexed.keywordsHaystack, queryFeatures, weights.keywords);
  const detailMatches = scoreMatches(indexed.detailHaystack, queryFeatures, weights.detail);
  const matchedFeatureKeys = new Set<string>([
    ...titleMatches.matchedFeatureKeys,
    ...keywordsMatches.matchedFeatureKeys,
    ...detailMatches.matchedFeatureKeys,
  ]);
  let score = 0;
  score += titleMatches.score;
  score += keywordsMatches.score;
  score += detailMatches.score;

  if (normalizedQuery && indexed.titleHaystack.includes(normalizedQuery)) {
    score += weights.fullTextBonus;
  }

  if (normalizedQuery && indexed.detailHaystack.includes(normalizedQuery)) {
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

function collectEntryFeatureKeys(entry: ProjectMemoryEntry): Set<string> {
  const keys = new Set<string>();
  const searchText = `${entry.title}\n${entry.keywords.join(" ")}\n${entry.detail}`;
  for (const token of tokenizeWords(searchText)) {
    keys.add(`word:${token}`);
  }
  for (const token of tokenizeNgrams(searchText)) {
    keys.add(`ngram:${token}`);
  }

  return keys;
}

function buildEntryIndexCacheKey(entry: ProjectMemoryEntry): string {
  return [
    entry.id,
    entry.category,
    entry.updatedAt,
    entry.title,
    entry.detail,
    entry.keywords.join("\u001e"),
  ].join("\u001f");
}

function pruneEntryIndexCache(): void {
  if (entryIndexCache.size <= MAX_ENTRY_INDEX_CACHE_SIZE) {
    return;
  }

  const overflow = entryIndexCache.size - MAX_ENTRY_INDEX_CACHE_SIZE;
  for (const key of [...entryIndexCache.keys()].slice(0, overflow)) {
    entryIndexCache.delete(key);
  }
}

function getEntryIndexData(entry: ProjectMemoryEntry): ProjectMemoryEntryIndexData {
  const cacheKey = buildEntryIndexCacheKey(entry);
  const cached = entryIndexCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const data = {
    titleHaystack: normalizeText(entry.title),
    detailHaystack: normalizeText(entry.detail),
    keywordsHaystack: normalizeText(entry.keywords.join(" ")),
    fingerprint: buildEntryFingerprint(entry),
    featureKeys: collectEntryFeatureKeys(entry),
  };
  entryIndexCache.set(cacheKey, data);
  pruneEntryIndexCache();
  return data;
}

function buildIndexedEntries(entries: ProjectMemoryEntry[]): IndexedProjectMemoryEntry[] {
  return entries.map((entry) => ({
    entry,
    ...getEntryIndexData(entry),
  }));
}

function buildInvertedIndex(indexedEntries: IndexedProjectMemoryEntry[]): Map<string, IndexedProjectMemoryEntry[]> {
  const invertedIndex = new Map<string, IndexedProjectMemoryEntry[]>();
  for (const indexed of indexedEntries) {
    for (const key of indexed.featureKeys) {
      const entries = invertedIndex.get(key);
      if (entries) {
        entries.push(indexed);
      } else {
        invertedIndex.set(key, [indexed]);
      }
    }
  }

  return invertedIndex;
}

function selectCandidateEntries(
  indexedEntries: IndexedProjectMemoryEntry[],
  invertedIndex: Map<string, IndexedProjectMemoryEntry[]>,
  queryFeatures: QueryFeature[],
): IndexedProjectMemoryEntry[] {
  if (queryFeatures.length === 0 || indexedEntries.length === 0) {
    return [];
  }

  const candidates = new Map<string, IndexedProjectMemoryEntry>();
  for (const feature of queryFeatures) {
    for (const indexed of invertedIndex.get(toFeatureKey(feature)) ?? []) {
      candidates.set(indexed.entry.id, indexed);
    }
  }

  return [...candidates.values()];
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
  indexed: IndexedProjectMemoryEntry,
  userMessage: string,
  userFeatures: QueryFeature[],
  sessionContextText: string,
  sessionFeatures: QueryFeature[],
  nowMs: number,
): RetrievedProjectMemory | null {
  const userPart = scoreEntryPart(indexed, userMessage, userFeatures, {
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
    ? scoreEntryPart(indexed, sessionContextText, sessionFeatures, {
      title: 2,
      keywords: 1,
      detail: 1,
      fullTextBonus: 4,
      fullDetailBonus: 2,
    })
    : { score: 0, matchedFeatureKeys: new Set<string>() };
  const sessionCoverage = computeCoverageBonus(sessionPart.matchedFeatureKeys);

  const score =
    CATEGORY_WEIGHTS[indexed.entry.category]
    + userPart.score
    + userCoverage.bonus
    + sessionPart.score
    + sessionCoverage.bonus
    + computeMemoryTimeDecayScore(indexed.entry.lastUsedAt, indexed.entry.updatedAt, nowMs);

  return {
    entry: indexed.entry,
    score,
    userCoverage: userCoverage.coverage,
    sessionCoverage: sessionCoverage.coverage,
    fingerprint: indexed.fingerprint,
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
  const indexedEntries = buildIndexedEntries(entries);
  const invertedIndex = buildInvertedIndex(indexedEntries);
  const candidates = selectCandidateEntries(indexedEntries, invertedIndex, userFeatures);

  for (const indexed of candidates) {
    const scored = scoreEntry(indexed, userText, userFeatures, sessionContextText, sessionFeatures, nowMs);
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
