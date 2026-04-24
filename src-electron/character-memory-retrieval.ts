import type { Session } from "../src/app-state.js";
import type { CharacterMemoryEntry } from "../src/memory-state.js";
import { computeMemoryTimeDecayScore } from "./memory-time-decay.js";

type RetrievedCharacterMemory = {
  entry: CharacterMemoryEntry;
  score: number;
  coverage: number;
  fingerprint: string;
  primaryMatchCount: number;
  detailMatchCount: number;
  userCoverage: number;
};

type QueryFeature = {
  value: string;
  kind: "word" | "ngram";
};

type IndexedCharacterMemoryEntry = {
  entry: CharacterMemoryEntry;
  titleHaystack: string;
  detailHaystack: string;
  keywordsHaystack: string;
  fingerprint: string;
  featureKeys: Set<string>;
};

type CharacterMemoryEntryIndexData = Omit<IndexedCharacterMemoryEntry, "entry">;

const CATEGORY_WEIGHTS: Record<CharacterMemoryEntry["category"], number> = {
  relationship: 6,
  preference: 5,
  boundary: 4,
  shared_moment: 4,
  tone: 3,
};

const MAX_ENTRY_INDEX_CACHE_SIZE = 2_000;
const entryIndexCache = new Map<string, CharacterMemoryEntryIndexData>();

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
        if (!isLowSignalJapaneseToken(token)) {
          result.add(token);
        }
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

function buildReflectionQueryText(session: Session): string {
  return session.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-8)
    .map((message) => message.text.trim())
    .filter((text) => text.length > 0)
    .join("\n");
}

function buildReflectionUserQueryText(session: Session): string {
  return session.messages
    .filter((message) => message.role === "user")
    .slice(-6)
    .map((message) => message.text.trim())
    .filter((text) => text.length > 0)
    .join("\n");
}

function scoreMatches(haystack: string, queryFeatures: QueryFeature[], weight: number): { score: number; matchedFeatureKeys: Set<string> } {
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
  indexed: IndexedCharacterMemoryEntry,
  queryText: string,
  queryFeatures: QueryFeature[],
): {
  score: number;
  matchedFeatureKeys: Set<string>;
  titleMatchCount: number;
  keywordsMatchCount: number;
  detailMatchCount: number;
} {
  const normalizedQuery = normalizeText(queryText);

  const titleMatches = scoreMatches(indexed.titleHaystack, queryFeatures, 6);
  const keywordsMatches = scoreMatches(indexed.keywordsHaystack, queryFeatures, 5);
  const detailMatches = scoreMatches(indexed.detailHaystack, queryFeatures, 2);
  const matchedFeatureKeys = new Set<string>([
    ...titleMatches.matchedFeatureKeys,
    ...keywordsMatches.matchedFeatureKeys,
    ...detailMatches.matchedFeatureKeys,
  ]);

  let score = titleMatches.score + keywordsMatches.score + detailMatches.score;
  if (normalizedQuery && indexed.titleHaystack.includes(normalizedQuery)) {
    score += 14;
  }
  if (normalizedQuery && indexed.detailHaystack.includes(normalizedQuery)) {
    score += 6;
  }

  return {
    score,
    matchedFeatureKeys,
    titleMatchCount: titleMatches.matchedFeatureKeys.size,
    keywordsMatchCount: keywordsMatches.matchedFeatureKeys.size,
    detailMatchCount: detailMatches.matchedFeatureKeys.size,
  };
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

function computeMinimumScore(queryFeatures: QueryFeature[]): number {
  const wordCount = queryFeatures.filter((feature) => feature.kind === "word").length;
  const ngramCount = queryFeatures.filter((feature) => feature.kind === "ngram").length;
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

function computeMinimumCoverage(queryFeatures: QueryFeature[]): number {
  const wordCount = queryFeatures.filter((feature) => feature.kind === "word").length;
  return wordCount >= 2 ? 2 : 1;
}

function buildEntryFingerprint(entry: CharacterMemoryEntry): string {
  const normalizedTitle = normalizeText(entry.title).replace(/\s+/g, " ").trim();
  const normalizedDetail = normalizeText(entry.detail).replace(/\s+/g, " ").trim();
  return `${entry.category}\u001f${normalizedTitle}\u001f${normalizedDetail}`;
}

function collectEntryFeatureKeys(entry: CharacterMemoryEntry): Set<string> {
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

function buildEntryIndexCacheKey(entry: CharacterMemoryEntry): string {
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

function getEntryIndexData(entry: CharacterMemoryEntry): CharacterMemoryEntryIndexData {
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

function buildIndexedEntries(entries: CharacterMemoryEntry[]): IndexedCharacterMemoryEntry[] {
  return entries.map((entry) => ({
    entry,
    ...getEntryIndexData(entry),
  }));
}

function buildInvertedIndex(indexedEntries: IndexedCharacterMemoryEntry[]): Map<string, IndexedCharacterMemoryEntry[]> {
  const invertedIndex = new Map<string, IndexedCharacterMemoryEntry[]>();
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
  indexedEntries: IndexedCharacterMemoryEntry[],
  invertedIndex: Map<string, IndexedCharacterMemoryEntry[]>,
  queryFeatures: QueryFeature[],
): IndexedCharacterMemoryEntry[] {
  if (queryFeatures.length === 0 || indexedEntries.length === 0) {
    return [];
  }

  const candidates = new Map<string, IndexedCharacterMemoryEntry>();
  for (const feature of queryFeatures) {
    for (const indexed of invertedIndex.get(toFeatureKey(feature)) ?? []) {
      candidates.set(indexed.entry.id, indexed);
    }
  }

  return [...candidates.values()];
}

function dedupeRankedEntries(ranked: RetrievedCharacterMemory[]): RetrievedCharacterMemory[] {
  const seen = new Set<string>();
  const result: RetrievedCharacterMemory[] = [];
  for (const item of ranked) {
    if (seen.has(item.fingerprint)) {
      continue;
    }

    seen.add(item.fingerprint);
    result.push(item);
  }

  return result;
}

function scoreEntry(
  indexed: IndexedCharacterMemoryEntry,
  queryText: string,
  queryFeatures: QueryFeature[],
  userQueryText: string,
  userQueryFeatures: QueryFeature[],
  nowMs: number,
): RetrievedCharacterMemory | null {
  const part = scoreEntryPart(indexed, queryText, queryFeatures);
  if (part.score <= 0) {
    return null;
  }

  const primaryMatchCount = part.titleMatchCount + part.keywordsMatchCount;
  if (primaryMatchCount <= 0 && part.detailMatchCount < 2) {
    return null;
  }

  const userPart = scoreEntryPart(indexed, userQueryText, userQueryFeatures);
  const userCoverage = userPart.matchedFeatureKeys.size;
  if (userQueryFeatures.length > 0 && userCoverage <= 0) {
    return null;
  }

  const coverage = computeCoverageBonus(part.matchedFeatureKeys);
  const score =
    CATEGORY_WEIGHTS[indexed.entry.category]
    + part.score
    + coverage.bonus
    + computeMemoryTimeDecayScore(indexed.entry.lastUsedAt, indexed.entry.updatedAt, nowMs);
  return {
    entry: indexed.entry,
    score,
    coverage: coverage.coverage,
    fingerprint: indexed.fingerprint,
    primaryMatchCount,
    detailMatchCount: part.detailMatchCount,
    userCoverage,
  };
}

function rankRecentEntries(entries: CharacterMemoryEntry[]): CharacterMemoryEntry[] {
  return [...entries]
    .sort((left, right) => {
      const leftScore = Date.parse(left.lastUsedAt ?? left.updatedAt);
      const rightScore = Date.parse(right.lastUsedAt ?? right.updatedAt);
      return rightScore - leftScore;
    });
}

export function retrieveCharacterMemoryEntries(
  entries: CharacterMemoryEntry[],
  session: Session,
  maxEntries = 6,
): CharacterMemoryEntry[] {
  if (entries.length === 0) {
    return [];
  }

  const queryText = buildReflectionQueryText(session);
  const queryFeatures = collectQueryFeatures(queryText);
  const userQueryText = buildReflectionUserQueryText(session);
  const userQueryFeatures = collectQueryFeatures(userQueryText);
  const minimumScore = computeMinimumScore(queryFeatures);
  const minimumCoverage = computeMinimumCoverage(queryFeatures);
  const nowMs = Date.now();
  const ranked: RetrievedCharacterMemory[] = [];
  const indexedEntries = buildIndexedEntries(entries);
  const invertedIndex = buildInvertedIndex(indexedEntries);
  const candidates = selectCandidateEntries(indexedEntries, invertedIndex, queryFeatures);

  for (const indexed of candidates) {
    const scored = scoreEntry(indexed, queryText, queryFeatures, userQueryText, userQueryFeatures, nowMs);
    if (!scored || scored.score < minimumScore || scored.coverage < minimumCoverage) {
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
    if (right.primaryMatchCount !== left.primaryMatchCount) {
      return right.primaryMatchCount - left.primaryMatchCount;
    }
    if (right.coverage !== left.coverage) {
      return right.coverage - left.coverage;
    }

    return right.entry.updatedAt.localeCompare(left.entry.updatedAt);
  });

  const resolved = dedupeRankedEntries(ranked).slice(0, maxEntries).map((item) => item.entry);
  if (resolved.length > 0) {
    return resolved;
  }

  return dedupeRankedEntries(
    rankRecentEntries(entries).map((entry) => ({
      entry,
      score: 0,
      coverage: 0,
      fingerprint: buildEntryFingerprint(entry),
      primaryMatchCount: 0,
      detailMatchCount: 0,
      userCoverage: 0,
    })),
  ).slice(0, Math.min(maxEntries, 4)).map((item) => item.entry);
}
