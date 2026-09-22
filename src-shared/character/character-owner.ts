export const UNKNOWN_CHARACTER_OWNER_ID = "withmate:unresolved-character-owner";

export function normalizeCharacterOwnerId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

export function requireCharacterOwnerId(value: unknown): string {
  const normalized = normalizeCharacterOwnerId(value);
  if (!normalized || normalized === UNKNOWN_CHARACTER_OWNER_ID) {
    throw new Error("characterId は空にできないよ。");
  }
  return normalized;
}

export function isUnknownCharacterOwnerId(value: unknown): boolean {
  return normalizeCharacterOwnerId(value) === UNKNOWN_CHARACTER_OWNER_ID;
}

export function recoverStoredCharacterOwnerId(value: unknown): string {
  return normalizeCharacterOwnerId(value) ?? UNKNOWN_CHARACTER_OWNER_ID;
}
