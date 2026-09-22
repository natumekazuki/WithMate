import { useState } from "react";

import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
import { buildCardThemeStyle, CharacterAvatar } from "../ui/ui-utils.js";
import { renderHomePlusIcon, renderHomeSearchIcon } from "./home-icons.js";
import type { HomeCharacterLoadStatus } from "./home-launch-state.js";

export type HomeCharactersPanelProps = {
  characters: readonly CharacterCatalogEntry[];
  characterLoadStatus?: HomeCharacterLoadStatus;
  feedback?: string;
  onCreateCharacter: () => void;
  onEditCharacter: (characterId: string) => void;
};

export function filterCharactersByName(
  characters: readonly CharacterCatalogEntry[],
  searchText: string,
): readonly CharacterCatalogEntry[] {
  const normalizedSearchText = searchText.trim().toLocaleLowerCase();
  return normalizedSearchText
    ? characters.filter((character) => character.name.toLocaleLowerCase().includes(normalizedSearchText))
    : characters;
}

export function HomeCharactersPanel({
  characters,
  characterLoadStatus = "loaded",
  feedback = "",
  onCreateCharacter,
  onEditCharacter,
}: HomeCharactersPanelProps) {
  const [searchText, setSearchText] = useState("");
  const visibleCharacters = filterCharactersByName(characters, searchText);

  return (
    <div className="home-monitor-body" aria-busy={characterLoadStatus === "loading"}>
      <section className="home-monitor-section">
        <div className="home-monitor-section-head">
          <div className="home-character-toolbar">
            <label className="toolbar-search-field" aria-label="Search characters by name">
              <span className="toolbar-search-icon" aria-hidden="true">
                {renderHomeSearchIcon()}
              </span>
              <input
                className="toolbar-search-input"
                type="search"
                aria-label="Search characters by name"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
              />
            </label>
            <button
              className="launch-toggle compact home-create-button"
              type="button"
              aria-label="Create character"
              title="Create character"
              onClick={onCreateCharacter}
            >
              <span className="home-create-icon">{renderHomePlusIcon()}</span>
              <span className="sr-only">CreateCharacter</span>
            </button>
          </div>
        </div>
        {feedback ? <p className="settings-feedback" role="status" aria-live="polite">{feedback}</p> : null}
        {characterLoadStatus === "loading" ? (
          <div className="home-session-list-load-status home-monitor-empty" role="status" aria-live="polite">
            <span className="home-session-list-load-spinner" aria-hidden="true" />
            <span className="sr-only">Loading characters…</span>
          </div>
        ) : characterLoadStatus === "error" ? (
          feedback ? null : (
            <p className="home-monitor-empty" role="status" aria-live="polite">Could not load characters.</p>
          )
        ) : characters.length === 0 ? (
          null
        ) : visibleCharacters.length === 0 ? (
          null
        ) : (
          <div className="home-character-list">
            {visibleCharacters.map((character) => (
              <button
                key={character.id}
                className="home-character-card"
                type="button"
                style={buildCardThemeStyle({ main: character.theme.main, sub: character.theme.sub })}
                onClick={() => onEditCharacter(character.id)}
              >
                <CharacterAvatar character={{ name: character.name, iconPath: character.iconFilePath }} size="medium" />
                <span className="home-character-card-copy">
                  <span className="home-character-card-title">
                    {character.name}
                  </span>
                  <span>{character.description || character.id}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
