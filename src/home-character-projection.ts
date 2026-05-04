import type { CharacterProfile } from "./app-state.js";

export type HomeCharacterProjection = {
  filteredCharacters: CharacterProfile[];
  emptyState: "no-match" | "empty" | null;
};

export function filterCharacters(
  characters: readonly CharacterProfile[],
  searchText: string,
): CharacterProfile[] {
  const normalizedSearch = searchText.trim().toLocaleLowerCase();
  if (!normalizedSearch) {
    return [...characters];
  }

  return characters.filter((character) => {
    const haystacks = [character.name, character.description].map((value) => value.toLocaleLowerCase());
    return haystacks.some((value) => value.includes(normalizedSearch));
  });
}

export function buildHomeCharacterProjection(
  characters: readonly CharacterProfile[],
  searchText: string,
): HomeCharacterProjection {
  const normalizedSearch = searchText.trim();
  const filteredCharacters = filterCharacters(characters, searchText);

  if (filteredCharacters.length > 0) {
    return {
      filteredCharacters,
      emptyState: null,
    };
  }

  return {
    filteredCharacters,
    emptyState: characters.length > 0 && normalizedSearch ? "no-match" : "empty",
  };
}
