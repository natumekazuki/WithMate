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

function tokenize(text: string): string[] {
  const tokens = text.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  const unique = new Set<string>();
  for (const token of tokens) {
    unique.add(token.trim().toLowerCase());
  }

  return [...unique];
}

function buildRetrievalQuery(userMessage: string, sessionMemory: SessionMemory): string {
  return [
    userMessage,
    sessionMemory.goal,
    ...sessionMemory.openQuestions.slice(0, 3),
  ]
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join("\n");
}

function scoreEntry(entry: ProjectMemoryEntry, queryTokens: string[]): number {
  if (queryTokens.length === 0) {
    return 0;
  }

  const haystack = `${entry.title}\n${entry.detail}\n${entry.keywords.join(" ")}`.toLowerCase();
  let matchedTokens = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      matchedTokens += 1;
    }
  }

  if (matchedTokens === 0) {
    return 0;
  }

  return matchedTokens * 10 + CATEGORY_WEIGHTS[entry.category];
}

export function retrieveProjectMemoryEntries(
  entries: ProjectMemoryEntry[],
  userMessage: string,
  sessionMemory: SessionMemory,
  maxEntries = 3,
): ProjectMemoryEntry[] {
  const queryTokens = tokenize(buildRetrievalQuery(userMessage, sessionMemory));
  const ranked: RetrievedProjectMemory[] = [];

  for (const entry of entries) {
    const score = scoreEntry(entry, queryTokens);
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
