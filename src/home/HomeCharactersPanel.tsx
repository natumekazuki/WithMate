import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
import { buildCardThemeStyle, CharacterAvatar } from "../ui/ui-utils.js";
import { renderHomePlusIcon } from "./home-icons.js";
import type { HomeCharacterLoadStatus } from "./home-launch-state.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { LoadError } from "../ui/load-error.js";

/** Character の候補と検索・取得状態、再試行、新規作成および編集の操作。 */
export type HomeCharactersPanelProps = {
  characters: readonly CharacterCatalogEntry[];
  searchText: string;
  characterLoadStatus?: HomeCharacterLoadStatus;
  feedback?: string;
  onRetry?: () => void;
  onCreateCharacter: () => void;
  onEditCharacter: (characterId: string) => void;
};

/** 前後の空白と大文字小文字を無視して名前を部分検索し、空の検索なら元の一覧を返す。 */
export function filterCharactersByName(
  characters: readonly CharacterCatalogEntry[],
  searchText: string,
): readonly CharacterCatalogEntry[] {
  const normalizedSearchText = searchText.trim().toLocaleLowerCase();
  return normalizedSearchText
    ? characters.filter((character) =>
        character.name.toLocaleLowerCase().includes(normalizedSearchText),
      )
    : characters;
}

/** 検索に一致する Character を編集できる一覧にし、取得中や再試行可能な失敗を通知する。 */
export function HomeCharactersPanel({
  characters,
  searchText,
  characterLoadStatus = "loaded",
  feedback = "",
  onRetry,
  onCreateCharacter,
  onEditCharacter,
}: HomeCharactersPanelProps) {
  const visibleCharacters = filterCharactersByName(characters, searchText);

  return (
    <div
      className="home-monitor-body"
      aria-busy={characterLoadStatus === "loading"}
    >
      <section className="home-monitor-section">
        <div className="home-monitor-section-head">
          <div className="home-character-toolbar">
            <span className="home-character-load-status">
              {characterLoadStatus === "loading" ? (
                <LoadingIndicator label="Loading characters" inline />
              ) : null}
            </span>
            <button
              className="launch-toggle compact home-create-button"
              type="button"
              aria-label="Create character"
              title="Create character"
              onClick={onCreateCharacter}
            >
              <span className="home-create-icon">{renderHomePlusIcon()}</span>
              <span className="sr-only">Create Character</span>
            </button>
          </div>
        </div>
        <div className="home-character-list">
          {visibleCharacters.map((character) => (
            <button
              key={character.id}
              className="home-character-card"
              type="button"
              style={buildCardThemeStyle({
                main: character.theme.main,
                sub: character.theme.sub,
              })}
              onClick={() => onEditCharacter(character.id)}
            >
              <CharacterAvatar
                character={{
                  name: character.name,
                  iconPath: character.iconFilePath,
                }}
                size="medium"
              />
              <span className="home-character-card-copy">
                <span className="home-character-card-title">
                  {character.name}
                </span>
                <span>{character.description || character.id}</span>
              </span>
            </button>
          ))}
        </div>
        {characterLoadStatus === "error" ? (
          <LoadError
            message={feedback || "Could not load characters."}
            onRetry={onRetry}
          />
        ) : feedback ? (
          <p className="settings-feedback" role="status" aria-live="polite">
            {feedback}
          </p>
        ) : null}
      </section>
    </div>
  );
}
