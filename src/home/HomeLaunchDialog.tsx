import { useRef } from "react";

import { focusRovingItemByKey, useDialogA11y } from "../a11y.js";
import { LaunchDialogFooter, LaunchDialogShell } from "../launch/launch-dialog-shell.js";
import { ProviderLaunchField } from "../launch/provider-launch-picker.js";
import { buildCharacterThemeStyle } from "../theme-utils.js";
import { CharacterAvatar } from "../ui-utils.js";
import type { LaunchWorkspace } from "./home-launch-projection.js";
import type { CharacterCatalogEntry } from "../character/character-catalog.js";
import { DEFAULT_CHARACTER_THEME_COLORS } from "../character-state.js";

export type HomeLaunchDialogProps = {
  open: boolean;
  mode: "session" | "companion";
  title: string;
  workspace: LaunchWorkspace | null;
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
  onSelectMode: (mode: "session" | "companion") => void;
  onChangeTitle: (value: string) => void;
  onBrowseWorkspace: () => void;
  onSelectProvider: (providerId: string) => void;
  onSelectCharacter: (characterId: string) => void;
  onSelectRandomCharacter: () => void;
  onStartSession: (mode: "session" | "companion") => void;
};

export function HomeLaunchDialog({
  open,
  mode,
  title,
  workspace,
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
  onSelectMode,
  onChangeTitle,
  onBrowseWorkspace,
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
          startButtonLabel={
            launchStarting
              ? "Starting..."
              : mode === "companion"
                  ? "Start Companion"
                  : "Start New Session"
          }
          startButtonDisabled={!canStartSession || launchStarting}
          startButtonAriaDisabled={!canStartSession || launchStarting}
          onStart={() => onStartSession(mode)}
        />
      }
    >
      <section className="launch-section minimal">
        <div
          className="choice-list launch-provider-list"
          role="tablist"
          aria-label="Session mode"
          onKeyDown={(event) => {
            focusRovingItemByKey(event, { orientation: "horizontal", activateOnFocus: true });
          }}
        >
          {[
            { value: "session" as const, label: "Agent Mode" },
            { value: "companion" as const, label: "Companion Mode" },
          ].map((option) => (
            <button
              key={option.value}
              className={`choice-chip${mode === option.value ? " active" : ""}`}
              type="button"
              role="tab"
              aria-selected={mode === option.value}
              tabIndex={mode === option.value ? 0 : -1}
              onClick={() => onSelectMode(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>

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
        <div className="section-head compact-actions">
          <button className="browse-button" type="button" onClick={onBrowseWorkspace}>
            Browse
          </button>
        </div>
        <p className={`launch-path${workspace ? " selected" : ""}`}>{launchWorkspacePathLabel}</p>
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
                  {character.isDefault ? <span className="launch-character-badge">Default</span> : null}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
    </LaunchDialogShell>
  );
}
