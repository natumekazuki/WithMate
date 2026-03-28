import { createEmptyCharacterUpdateMemoryExtract, type CharacterUpdateMemoryExtract } from "../src/character-update-state.js";
import type { CharacterMemoryCategory, CharacterMemoryEntry } from "../src/memory-state.js";

const CATEGORY_ORDER: CharacterMemoryCategory[] = [
  "relationship",
  "preference",
  "tone",
  "boundary",
  "shared_moment",
];

const CATEGORY_LABELS: Record<CharacterMemoryCategory, string> = {
  relationship: "Relationship",
  preference: "Preference",
  tone: "Tone",
  boundary: "Boundary",
  shared_moment: "Shared Moment",
};

const CATEGORY_QUOTAS: Record<CharacterMemoryCategory, number> = {
  relationship: 4,
  preference: 3,
  tone: 2,
  boundary: 2,
  shared_moment: 3,
};

function scoreTimestamp(entry: CharacterMemoryEntry): number {
  return Date.parse(entry.lastUsedAt ?? entry.updatedAt);
}

function sortEntries(entries: CharacterMemoryEntry[]): CharacterMemoryEntry[] {
  return [...entries].sort((left, right) => scoreTimestamp(right) - scoreTimestamp(left));
}

function renderEntry(entry: CharacterMemoryEntry): string {
  const base = `- ${entry.title}: ${entry.detail}`;
  if (entry.evidence.length === 0) {
    return base;
  }

  return `${base}\n  - evidence: ${entry.evidence.join(" / ")}`;
}

export function buildCharacterUpdateMemoryExtract(
  characterId: string,
  entries: CharacterMemoryEntry[],
): CharacterUpdateMemoryExtract {
  if (entries.length === 0) {
    return createEmptyCharacterUpdateMemoryExtract(characterId);
  }

  const grouped = new Map<CharacterMemoryCategory, CharacterMemoryEntry[]>();
  for (const category of CATEGORY_ORDER) {
    grouped.set(category, []);
  }

  for (const entry of sortEntries(entries)) {
    const bucket = grouped.get(entry.category);
    if (!bucket) {
      continue;
    }
    if (bucket.length >= CATEGORY_QUOTAS[entry.category]) {
      continue;
    }
    bucket.push(entry);
  }

  const sections = CATEGORY_ORDER
    .map((category) => {
      const categoryEntries = grouped.get(category) ?? [];
      if (categoryEntries.length === 0) {
        return "";
      }

      return [`## ${CATEGORY_LABELS[category]}`, ...categoryEntries.map(renderEntry)].join("\n");
    })
    .filter((section) => section.length > 0);

  return {
    characterId,
    generatedAt: new Date().toISOString(),
    entryCount: [...grouped.values()].reduce((sum, bucket) => sum + bucket.length, 0),
    text: sections.join("\n\n"),
  };
}
