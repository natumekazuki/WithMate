import type { CharacterProfile } from "./app-state.js";
import { filterCharacters } from "./home-launch-projection.js";

export type HomeCharacterProjection = {
  filteredCharacters: CharacterProfile[];
  emptyState: "no-match" | "empty" | null;
};

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
