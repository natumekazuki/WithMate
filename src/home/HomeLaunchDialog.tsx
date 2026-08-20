import { useRef } from "react";

import { focusRovingItemByKey, useDialogA11y } from "../a11y.js";
import { LaunchDialogFooter, LaunchDialogShell } from "../launch/launch-dialog-shell.js";
import { ProviderLaunchField } from "../launch/provider-launch-picker.js";
import { buildCharacterThemeStyle } from "../theme-utils.js";
import { CharacterAvatar } from "../ui-utils.js";
import type { CharacterCatalogEntry } from "../character/character-catalog.js";
import { DEFAULT_CHARACTER_THEME_COLORS } from "../character-state.js";
import type { HomeLaunchWorkspaceValidationState } from "./home-launch-state.js";
import type { HomeLaunchSessionPurpose } from "./home-launch-state.js";

export type HomeLaunchDialogProps = {
  open: boolean;
  title: string;
  sessionPurpose: HomeLaunchSessionPurpose;
  sessionFolderSelected: boolean;
  launchWorkspacePathLabel: string;
  workspacePathInput: string;
  workspaceValidation: HomeLaunchWorkspaceValidationState;
  workspaceValidationMessage: string;
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
  onSelectSessionPurpose: (purpose: HomeLaunchSessionPurpose) => void;
  onChangeWorkspacePath: (value: string) => void;
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
  sessionPurpose,
  sessionFolderSelected,
  launchWorkspacePathLabel,
  workspacePathInput,
  workspaceValidation,
  workspaceValidationMessage,
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
  onSelectSessionPurpose,
  onChangeWorkspacePath,
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

  const workspaceValidationActive = workspaceValidation === "debouncing" || workspaceValidation === "pending";

  return (
    <LaunchDialogShell
      onClose={onClose}
      dialogRef={dialogRef}
      onKeyDown={handleDialogKeyDown}
      ariaLabel="New Session"
      showDismissControl={false}
      dialogClassName="home-launch-dialog"
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
            Session Title
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
        <div className="launch-field">
          <div className="launch-field-heading">
            <label className="launch-field-label" htmlFor="launch-workspace-path">
              Workspace
            </label>
            <span
              id="launch-workspace-path-error"
              className="launch-field-error"
              role="status"
              aria-live="polite"
              aria-atomic="true"
              title={workspaceValidationMessage || undefined}
            >
              {workspaceValidationMessage}
            </span>
          </div>
          <div className="launch-field-input-shell workspace-validation-input" aria-busy={workspaceValidationActive}>
            <input
              id="launch-workspace-path"
              className="launch-field-input"
              type="text"
              value={workspacePathInput}
              placeholder="C:\\path\\to\\workspace"
              aria-invalid={workspaceValidation === "invalid"}
              aria-describedby={workspaceValidationMessage ? "launch-workspace-path-error" : undefined}
              onChange={(event) => onChangeWorkspacePath(event.target.value)}
            />
            {workspaceValidationActive ? (
              <span className="workspace-validation-spinner" aria-hidden="true" />
            ) : null}
          </div>
          {workspaceValidationActive ? (
            <span className="visually-hidden" role="status" aria-live="polite">
              Validating workspace path
            </span>
          ) : null}
        </div>
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
        {sessionFolderSelected ? (
          <p className="launch-path selected">{launchWorkspacePathLabel}</p>
        ) : null}
      </section>

      <section className="launch-section minimal">
        <fieldset className="launch-purpose-field">
          <legend className="launch-field-label">Purpose</legend>
          <div
            className="choice-list launch-choice-list"
            role="radiogroup"
            aria-label="Purpose"
            onKeyDown={(event) => {
              focusRovingItemByKey(event, { orientation: "horizontal", activateOnFocus: true });
            }}
          >
            <button
              className={`choice-chip${sessionPurpose === "standalone" ? " active" : ""}`}
              type="button"
              role="radio"
              aria-checked={sessionPurpose === "standalone"}
              tabIndex={sessionPurpose === "standalone" ? 0 : -1}
              onClick={() => onSelectSessionPurpose("standalone")}
            >
              standalone
            </button>
            <button
              className={`choice-chip${sessionPurpose === "overall-coordinator" ? " active" : ""}`}
              type="button"
              role="radio"
              aria-checked={sessionPurpose === "overall-coordinator"}
              tabIndex={sessionPurpose === "overall-coordinator" ? 0 : -1}
              onClick={() => onSelectSessionPurpose("overall-coordinator")}
            >
              overall-coordinator
            </button>
          </div>
        </fieldset>
      </section>

      <ProviderLaunchField
        fieldId="launch-provider-picker"
        providers={enabledLaunchProviders}
        selectedProviderId={selectedLaunchProviderId}
        onSelectProvider={onSelectProvider}
      />

      <section className="launch-section minimal home-launch-character-section">
        <div className="launch-field">
          <span className="launch-field-label">Character</span>
          {!charactersLoaded ? (
            <div className="launch-character-neutral">
              <span className="character-avatar tiny" aria-hidden="true">W</span>
              <div className="launch-character-copy">
                <strong>Loading</strong>
                <span>Loading Characters...</span>
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
                  <strong>Random</strong>
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
