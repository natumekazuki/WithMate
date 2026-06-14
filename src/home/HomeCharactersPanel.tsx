import type { CharacterCatalogEntry } from "../character/character-catalog.js";
import { buildCardThemeStyle, CharacterAvatar } from "../ui-utils.js";

export type HomeCharactersPanelProps = {
  characters: readonly CharacterCatalogEntry[];
  onCreateCharacter: () => void;
  onEditCharacter: (characterId: string) => void;
};

export function HomeCharactersPanel({
  characters,
  onCreateCharacter,
  onEditCharacter,
}: HomeCharactersPanelProps) {
  return (
    <div className="home-monitor-content">
      <section className="home-monitor-section">
        <div className="home-monitor-section-head">
          <h3>Characters</h3>
          <button className="launch-toggle compact" type="button" onClick={onCreateCharacter}>
            Create
          </button>
        </div>
        {characters.length === 0 ? (
          <div className="home-monitor-empty">
            <p>Character はまだありません。</p>
            <button className="launch-toggle" type="button" onClick={onCreateCharacter}>
              Create Character
            </button>
          </div>
        ) : (
          <div className="home-character-list">
            {characters.map((character) => (
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
                  <span className="home-character-card-updated">updated {character.updatedAt || "-"}</span>
                </span>
                <span className="launch-toggle compact home-character-card-edit">Edit</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
