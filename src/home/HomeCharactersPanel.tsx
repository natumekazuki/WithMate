import { useState } from "react";

import type { CharacterCatalogEntry } from "../character/character-catalog.js";
import { buildCardThemeStyle, CharacterAvatar } from "../ui-utils.js";
import { renderHomeSearchIcon } from "./home-icons.js";

export type HomeCharactersPanelProps = {
  characters: readonly CharacterCatalogEntry[];
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
  feedback = "",
  onCreateCharacter,
  onEditCharacter,
}: HomeCharactersPanelProps) {
  const [searchText, setSearchText] = useState("");
  const visibleCharacters = filterCharactersByName(characters, searchText);

  return (
    <div className="home-monitor-body">
      <section className="home-monitor-section">
        <div className="home-monitor-section-head">
          <div className="home-character-toolbar">
            <label className="toolbar-search-field" aria-label="Characterを名前で検索">
              <span className="toolbar-search-icon" aria-hidden="true">
                {renderHomeSearchIcon()}
              </span>
              <input
                className="toolbar-search-input"
                type="search"
                aria-label="Characterを名前で検索"
                placeholder="名前で検索"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
              />
            </label>
            <button className="launch-toggle compact" type="button" onClick={onCreateCharacter}>
              Create
            </button>
          </div>
        </div>
        {feedback ? <p className="settings-feedback">{feedback}</p> : null}
        {characters.length === 0 ? (
          <div className="home-monitor-empty">
            <p>Character はまだありません。</p>
            <button className="launch-toggle" type="button" onClick={onCreateCharacter}>
              Create Character
            </button>
          </div>
        ) : visibleCharacters.length === 0 ? (
          <div className="home-monitor-empty">
            <p>名前に一致するCharacterはありません。</p>
          </div>
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
                    {character.isDefault ? <span className="settings-character-badge">Default</span> : null}
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
