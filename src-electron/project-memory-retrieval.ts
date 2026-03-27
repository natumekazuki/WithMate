import type { ProjectMemoryEntry, SessionMemory } from "../src/app-state.js";

type RetrievedProjectMemory = {
  entry: ProjectMemoryEntry;
  score: number;
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

function collectQueryFeatures(text: string): string[] {
  const features = new Set<string>();
  for (const token of tokenizeWords(text)) {
    features.add(token);
  }
  for (const token of tokenizeNgrams(text)) {
    features.add(token);
  }

  return [...features];
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

function scoreMatches(haystack: string, queryFeatures: string[], weight: number): number {
  let score = 0;
  for (const feature of queryFeatures) {
    if (!feature || !haystack.includes(feature)) {
      continue;
    }

    score += weight;
  }

  return score;
}

function scoreEntryPart(
  entry: ProjectMemoryEntry,
  queryText: string,
  queryFeatures: string[],
  weights: { title: number; keywords: number; detail: number; fullTextBonus: number; fullDetailBonus: number },
): number {
  const normalizedQuery = normalizeText(queryText);
  const titleHaystack = normalizeText(entry.title);
  const detailHaystack = normalizeText(entry.detail);
  const keywordsHaystack = normalizeText(entry.keywords.join(" "));

  let score = 0;
  score += scoreMatches(titleHaystack, queryFeatures, weights.title);
  score += scoreMatches(keywordsHaystack, queryFeatures, weights.keywords);
  score += scoreMatches(detailHaystack, queryFeatures, weights.detail);

  if (normalizedQuery && titleHaystack.includes(normalizedQuery)) {
    score += weights.fullTextBonus;
  }

  if (normalizedQuery && detailHaystack.includes(normalizedQuery)) {
    score += weights.fullDetailBonus;
  }

  return score;
}

function scoreEntry(
  entry: ProjectMemoryEntry,
  userMessage: string,
  userFeatures: string[],
  sessionContextText: string,
  sessionFeatures: string[],
): number {
  const userScore = scoreEntryPart(entry, userMessage, userFeatures, {
    title: 6,
    keywords: 5,
    detail: 2,
    fullTextBonus: 20,
    fullDetailBonus: 8,
  });
  if (userScore <= 0) {
    return 0;
  }

  const sessionScore = sessionFeatures.length > 0
    ? scoreEntryPart(entry, sessionContextText, sessionFeatures, {
      title: 2,
      keywords: 1,
      detail: 1,
      fullTextBonus: 4,
      fullDetailBonus: 2,
    })
    : 0;

  return CATEGORY_WEIGHTS[entry.category] + userScore + sessionScore;
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
  const ranked: RetrievedProjectMemory[] = [];

  for (const entry of entries) {
    const score = scoreEntry(entry, userText, userFeatures, sessionContextText, sessionFeatures);
    if (score <= 0) {
      continue;
    }

    ranked.push({ entry, score });
  }

  ranked.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    return right.entry.updatedAt.localeCompare(left.entry.updatedAt);
  });

  return ranked.slice(0, maxEntries).map((item) => item.entry);
}
