import type { CharacterCatalogEntry } from "./character-catalog.js";

export type CharacterUsageSessionSource = {
  characterId: string;
  sessionKind: string;
};

export function selectWeightedRandomLaunchCharacterId(
  entries: readonly CharacterCatalogEntry[],
  sessionsByLastActiveDesc: readonly CharacterUsageSessionSource[],
  openSessionCharacterIds: readonly string[] = [],
  random: () => number = Math.random,
): string {
  const activeEntries = entries.filter((entry) => entry.state === "active");
  if (activeEntries.length === 0) {
    return "";
  }

  const openSessionCharacterIdSet = new Set(openSessionCharacterIds);
  const unusedEntries = activeEntries.filter((entry) => !openSessionCharacterIdSet.has(entry.id));
  const eligibleEntries = unusedEntries.length > 0 ? unusedEntries : activeEntries;
  const eligibleCharacterIds = new Set(eligibleEntries.map((entry) => entry.id));
  const recencyRanks = new Map<string, number>();
  for (const session of sessionsByLastActiveDesc) {
    if (
      session.sessionKind !== "default" ||
      !eligibleCharacterIds.has(session.characterId) ||
      recencyRanks.has(session.characterId)
    ) {
      continue;
    }
    recencyRanks.set(session.characterId, recencyRanks.size);
  }

  const weightedEntries = eligibleEntries.map((entry) => ({
    entry,
    weight: (recencyRanks.get(entry.id) ?? recencyRanks.size) + 1,
  }));
  const totalWeight = weightedEntries.reduce((total, candidate) => total + candidate.weight, 0);
  const randomValue = random();
  const normalizedRandomValue = Number.isFinite(randomValue)
    ? Math.min(Math.max(randomValue, 0), 1 - Number.EPSILON)
    : 0;
  let remainingWeight = normalizedRandomValue * totalWeight;

  for (const candidate of weightedEntries) {
    remainingWeight -= candidate.weight;
    if (remainingWeight < 0) {
      return candidate.entry.id;
    }
  }

  return weightedEntries.at(-1)?.entry.id ?? "";
}
