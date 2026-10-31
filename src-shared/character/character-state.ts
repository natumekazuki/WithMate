export type CharacterVisual = {
  name: string;
  iconPath: string;
};

export type CharacterThemeColors = {
  main: string;
  sub: string;
};

export type CharacterCatalogItem = CharacterVisual & {
  id: string;
};

export type CharacterProfile = CharacterCatalogItem & {
  description: string;
  roleMarkdown: string;
  notesMarkdown: string;
  updatedAt: string;
  themeColors: CharacterThemeColors;
};

export type CreateCharacterInput = {
  name: string;
  iconPath: string;
  description: string;
  roleMarkdown: string;
  notesMarkdown: string;
  themeColors: CharacterThemeColors;
};

export const DEFAULT_CHARACTER_THEME_COLORS: CharacterThemeColors = {
  main: "#6f8cff",
  sub: "#6fb8c7",
};

function normalizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    return fallback;
  }

  return normalized.toLowerCase();
}

export function normalizeCharacterThemeColors(value: unknown): CharacterThemeColors {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_CHARACTER_THEME_COLORS };
  }

  const candidate = value as Partial<CharacterThemeColors>;
  return {
    main: normalizeHexColor(candidate.main, DEFAULT_CHARACTER_THEME_COLORS.main),
    sub: normalizeHexColor(candidate.sub, DEFAULT_CHARACTER_THEME_COLORS.sub),
  };
}

export function cloneCharacterProfiles(characters: CharacterProfile[]): CharacterProfile[] {
  return characters.map((character) => ({
    ...character,
    themeColors: { ...character.themeColors },
  }));
}

export function getCharacterById(characters: CharacterProfile[], characterId: string): CharacterProfile | null {
  return cloneCharacterProfiles(characters).find((character) => character.id === characterId) ?? null;
}
