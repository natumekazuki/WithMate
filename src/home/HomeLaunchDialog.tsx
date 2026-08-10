import { useRef } from "react";

import { focusRovingItemByKey, useDialogA11y } from "../a11y.js";
import { LaunchDialogFooter, LaunchDialogShell } from "../launch/launch-dialog-shell.js";
import { ProviderLaunchField } from "../launch/provider-launch-picker.js";
import { buildCharacterThemeStyle } from "../theme-utils.js";
import { CharacterAvatar } from "../ui-utils.js";
import type { CharacterCatalogEntry } from "../character/character-catalog.js";
import { DEFAULT_CHARACTER_THEME_COLORS } from "../character-state.js";

export type HomeLaunchDialogProps = {
  open: boolean;
  title: string;
  workspaceSelected: boolean;
  sessionFolderSelected: boolean;
  launchWorkspacePathLabel: string;
  enabledLaunchProviders: Array<{ id: string; label: string }>;
  selectedLaunchProviderId: string | null;
  characterOptions: CharacterCatalogEntry[];
  selectedCharacterId: string | null;
  randomCharacterSelected: boolean;
  charactersLoaded: boolean;
  canStartSession: boolean;
  launchFeedback: string;
  launchStarting: boolean;
  onClose: () => void;
  onChangeTitle: (value: string) => void;
  onBrowseWorkspace: () => void;
  onSelectSessionFolder: () => void;
  onSelectProvider: (providerId: string) => void;
  onSelectCharacter: (characterId: string) => void;
  onSelectRandomCharacter: () => void;
  onStartSession: () => void;
};

export function HomeLaunchDialog({
  open,
  title,
  workspaceSelected,
  sessionFolderSelected,
  launchWorkspacePathLabel,
  enabledLaunchProviders,
  selectedLaunchProviderId,
  characterOptions,
  selectedCharacterId,
  randomCharacterSelected,
  charactersLoaded,
  canStartSession,
  launchFeedback,
  launchStarting,
  onClose,
  onChangeTitle,
  onBrowseWorkspace,
  onSelectSessionFolder,
  onSelectProvider,
  onSelectCharacter,
  onSelectRandomCharacter,
  onStartSession,
}: HomeLaunchDialogProps) {
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const { dialogRef, handleDialogKeyDown } = useDialogA11y<HTMLElement>({
    open,
    onClose,
    initialFocusRef: titleInputRef,
  });

  if (!open) {
    return null;
  }

  return (
    <LaunchDialogShell
      onClose={onClose}
      dialogRef={dialogRef}
      onKeyDown={handleDialogKeyDown}
      footer={
        <LaunchDialogFooter
          feedback={launchFeedback}
          startButtonLabel={launchStarting ? "Starting..." : "Start New Session"}
          startButtonDisabled={!canStartSession || launchStarting}
          startButtonAriaDisabled={!canStartSession || launchStarting}
          onStart={onStartSession}
        />
      }
    >
      <section className="launch-section minimal">
        <div className="launch-field">
          <label className="launch-field-label" htmlFor="launch-session-title">
            セッションタイトル
          </label>
          <input
            id="launch-session-title"
            ref={titleInputRef}
            className="launch-field-input"
            type="text"
            value={title}
            onChange={(event) => onChangeTitle(event.target.value)}
          />
        </div>
      </section>

      <section className="launch-section workspace-picker minimal">
        <div className="section-head compact-actions workspace-picker-actions">
          <button className="browse-button" type="button" onClick={onBrowseWorkspace}>
            Browse
          </button>
          <button
            className={`browse-button${sessionFolderSelected ? " active" : ""}`}
            type="button"
            aria-pressed={sessionFolderSelected}
            onClick={onSelectSessionFolder}
          >
            SessionFolder
          </button>
        </div>
        <p className={`launch-path${workspaceSelected ? " selected" : ""}`}>{launchWorkspacePathLabel}</p>
      </section>

      <ProviderLaunchField
        fieldId="launch-provider-picker"
        providers={enabledLaunchProviders}
        selectedProviderId={selectedLaunchProviderId}
        onSelectProvider={onSelectProvider}
      />

      <section className="launch-section minimal">
        <div className="launch-field">
          <span className="launch-field-label">Character</span>
          {!charactersLoaded ? (
            <div className="launch-character-neutral">
              <span className="character-avatar tiny" aria-hidden="true">W</span>
              <div className="launch-character-copy">
                <strong>読み込み中</strong>
                <span>Character を読み込んでるよ...</span>
              </div>
            </div>
          ) : characterOptions.length === 0 ? (
            <div className="launch-character-neutral">
              <span className="character-avatar tiny" aria-hidden="true">W</span>
              <div className="launch-character-copy">
                <strong>WithMate</strong>
                <span>Neutral</span>
              </div>
            </div>
          ) : (
            <div
              className="launch-character-list"
              role="radiogroup"
              aria-label="Character"
              onKeyDown={(event) => {
                focusRovingItemByKey(event, { orientation: "vertical", activateOnFocus: true });
              }}
            >
              <button
                className={`launch-character-option${randomCharacterSelected ? " selected" : ""}`}
                type="button"
                role="radio"
                aria-checked={randomCharacterSelected}
                tabIndex={randomCharacterSelected ? 0 : -1}
                style={buildCharacterThemeStyle(DEFAULT_CHARACTER_THEME_COLORS)}
                onClick={onSelectRandomCharacter}
              >
                <span className="character-avatar tiny" aria-hidden="true">R</span>
                <span className="launch-character-copy">
                  <strong>ランダム</strong>
                  <span>最近使っていないCharacterを優先</span>
                </span>
              </button>
              {characterOptions.map((character) => (
                <button
                  key={character.id}
                  className={`launch-character-option${character.id === selectedCharacterId ? " selected" : ""}`}
                  type="button"
                  role="radio"
                  aria-checked={character.id === selectedCharacterId}
                  tabIndex={character.id === selectedCharacterId ? 0 : -1}
                  style={buildCharacterThemeStyle(character.theme)}
                  onClick={() => onSelectCharacter(character.id)}
                >
                  <CharacterAvatar
                    character={{ name: character.name, iconPath: character.iconFilePath }}
                    size="tiny"
                  />
                  <span className="launch-character-copy">
                    <strong>{character.name}</strong>
                    <span>{character.description || character.id}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
    </LaunchDialogShell>
  );
}
