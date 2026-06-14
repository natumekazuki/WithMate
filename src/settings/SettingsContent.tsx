import type { CSSProperties } from "react";

import type { AppSettings } from "../app-state.js";
import type { CharacterCatalogEntry } from "../character/character-catalog.js";
import { MICROCOPY_SLOTS, type MicrocopySlot } from "../microcopy-state.js";
import {
  createNewCharacterEditorDraft,
  type SettingsCharacterEditorDraft,
} from "./settings-character-editor-state.js";
import type { HomeProviderSettingRow } from "./settings-view-model.js";
import {
  SETTINGS_ACTION_DOCK_AUTO_CLOSE_LABEL,
  SETTINGS_MATE_RESET_HELP,
  SETTINGS_MATE_RESET_LABEL,
  SETTINGS_DIAGNOSTICS_LABEL,
  SETTINGS_OPEN_LOG_FOLDER_LABEL,
  SETTINGS_OPEN_CRASH_DUMP_FOLDER_LABEL,
} from "./settings-ui.js";

export type HomeSettingsContentProps = {
  settingsDraft: AppSettings;
  providerSettingRows: HomeProviderSettingRow[];
  characterEntries?: CharacterCatalogEntry[];
  selectedCharacterId?: string | null;
  characterDraft?: SettingsCharacterEditorDraft;
  characterEditorDirty?: boolean;
  characterEditorBusy?: boolean;
  characterEditorFeedback?: string;
  modelCatalogRevisionLabel: string;
  settingsDirty: boolean;
  settingsFeedback: string;
  onChangeAutoCollapseActionDockOnSend: (enabled: boolean) => void;
  onChangeUserMicrocopySlot: (slot: MicrocopySlot, value: string) => void;
  onChangeProviderEnabled: (providerId: string, enabled: boolean) => void;
  onSelectCharacter?: (characterId: string) => void;
  onNewCharacter?: () => void;
  onChangeCharacterDraft?: (patch: Partial<SettingsCharacterEditorDraft>) => void;
  onImportCharacterDefinitionFile?: (file: File) => void;
  onPickCharacterIcon?: () => void;
  onSaveCharacter?: () => void;
  onCancelCharacterEdit?: () => void;
  onSetDefaultCharacter?: () => void;
  onArchiveCharacter?: () => void;
  onImportModelCatalog: () => void;
  onExportModelCatalog: () => void;
  onOpenAppLogFolder: () => void;
  onOpenCrashDumpFolder: () => void;
  onResetMate?: () => void;
  mateResetBusy?: boolean;
  canResetMate?: boolean;
  onSaveSettings: () => void;
};

const MICROCOPY_SLOT_LABEL: Record<MicrocopySlot, string> = {
  "chat.pending.response_waiting": "Chat / 応答待機",
  "dock.status.approval": "ActionDock / 承認待機",
  "dock.status.working": "ActionDock / 処理中",
  "dock.status.responding": "ActionDock / 応答生成中",
  "dock.status.preparing": "ActionDock / 応答準備中",
  "retry.interrupted.title": "Retry / 中断",
  "retry.failed.title": "Retry / 失敗",
  "retry.canceled.title": "Retry / キャンセル",
  "empty.latest_command.waiting": "Empty / command 待機",
  "empty.latest_command": "Empty / command なし",
  "empty.changed_files": "Empty / 変更なし",
  "empty.context": "Empty / context なし",
};

const microcopyTextareaValue = (value: AppSettings["userMicrocopyCatalog"][MicrocopySlot]): string => {
  if (typeof value === "string") {
    return value;
  }

  return (value ?? []).join("\n");
};

const CHARACTER_DEFINITION_IMPORT_INPUT_ID = "settings-character-definition-import";

export function HomeSettingsContent({
  settingsDraft,
  providerSettingRows,
  characterEntries = [],
  selectedCharacterId = null,
  characterDraft = createNewCharacterEditorDraft(),
  characterEditorDirty = false,
  characterEditorBusy = false,
  characterEditorFeedback = "",
  modelCatalogRevisionLabel,
  settingsDirty,
  settingsFeedback,
  onChangeAutoCollapseActionDockOnSend,
  onChangeUserMicrocopySlot,
  onChangeProviderEnabled,
  onSelectCharacter = () => undefined,
  onNewCharacter = () => undefined,
  onChangeCharacterDraft = () => undefined,
  onImportCharacterDefinitionFile = () => undefined,
  onPickCharacterIcon = () => undefined,
  onSaveCharacter = () => undefined,
  onCancelCharacterEdit = () => undefined,
  onSetDefaultCharacter = () => undefined,
  onArchiveCharacter = () => undefined,
  onImportModelCatalog,
  onExportModelCatalog,
  onOpenAppLogFolder,
  onOpenCrashDumpFolder,
  onResetMate,
  mateResetBusy = false,
  canResetMate = false,
  onSaveSettings,
}: HomeSettingsContentProps) {
  const selectedCharacter = characterEntries.find((entry) => entry.id === selectedCharacterId) ?? null;

  return (
    <>
      <div className="settings-panel settings-panel-window">
        <div className="settings-panel-window-scroll">
          <section className="settings-section">
          <section className="settings-section-card">
            <div className="settings-field">
              <strong>Session Window</strong>
              <label className="settings-provider-toggle-row settings-section-toggle">
                <span className="settings-provider-name">{SETTINGS_ACTION_DOCK_AUTO_CLOSE_LABEL}</span>
                <input
                  type="checkbox"
                  checked={settingsDraft.autoCollapseActionDockOnSend}
                  onChange={(event) => onChangeAutoCollapseActionDockOnSend(event.target.checked)}
                />
              </label>
            </div>
          </section>

          <section className="settings-section-card">
            <div className="settings-field">
              <strong>Default Microcopy</strong>
              <p className="settings-note">1 行を 1 候補として保存する。空の slot は system default に戻る。</p>
              <div className="settings-provider-list">
                {MICROCOPY_SLOTS.map((slot) => (
                  <label key={slot} className="settings-provider-input">
                    <span>{MICROCOPY_SLOT_LABEL[slot]}</span>
                    <textarea
                      className="settings-microcopy-textarea"
                      value={microcopyTextareaValue(settingsDraft.userMicrocopyCatalog[slot])}
                      onChange={(event) => onChangeUserMicrocopySlot(slot, event.target.value)}
                      rows={3}
                      spellCheck={false}
                    />
                  </label>
                ))}
              </div>
            </div>
          </section>

          {providerSettingRows.length > 0 ? (
            <>
              <section className="settings-section-card">
                <div className="settings-field">
                  <strong>Coding Agent Providers</strong>
                  <div className="settings-provider-list">
                    {providerSettingRows.map(({ provider, settings }) => (
                      <section key={provider.id} className="settings-provider-card settings-provider-toggle-card">
                        <label className="settings-provider-toggle-row">
                          <span className="settings-provider-name">{provider.label}</span>
                          <input
                            type="checkbox"
                            checked={settings.enabled}
                            onChange={(event) => onChangeProviderEnabled(provider.id, event.target.checked)}
                          />
                        </label>
                      </section>
                    ))}
                  </div>
                </div>
              </section>
            </>
          ) : null}

          <section className="settings-section-card settings-character-section">
            <div className="settings-field">
              <div className="settings-section-head-row">
                <strong>Characters</strong>
                <button className="launch-toggle compact" type="button" onClick={onNewCharacter}>
                  New
                </button>
              </div>
              <div className="settings-character-editor">
                <div className="settings-character-list" aria-label="Characters">
                  {characterEntries.length === 0 ? (
                    <p className="settings-note">登録済み Character はまだないよ。</p>
                  ) : characterEntries.map((character) => (
                    <button
                      key={character.id}
                      className={`settings-character-row${character.id === selectedCharacterId ? " selected" : ""}`}
                      type="button"
                      onClick={() => onSelectCharacter(character.id)}
                    >
                      <span
                        className="settings-character-swatch"
                        style={{ "--settings-character-swatch": character.theme.main } as CSSProperties}
                        aria-hidden="true"
                      />
                      <span className="settings-character-row-copy">
                        <span className="settings-character-row-name">
                          {character.name}
                          {character.isDefault ? <span className="settings-character-badge">Default</span> : null}
                        </span>
                        <span>{character.description || character.id}</span>
                      </span>
                    </button>
                  ))}
                </div>

                <div className="settings-character-form">
                  <div className="settings-character-form-grid">
                    <label className="settings-provider-input">
                      <span>Name</span>
                      <input
                        type="text"
                        value={characterDraft.name}
                        onChange={(event) => onChangeCharacterDraft({ name: event.target.value })}
                      />
                    </label>
                    <label className="settings-provider-input">
                      <span>Description</span>
                      <input
                        type="text"
                        value={characterDraft.description}
                        onChange={(event) => onChangeCharacterDraft({ description: event.target.value })}
                      />
                    </label>
                    <label className="settings-provider-input">
                      <span>Icon</span>
                      <div className="settings-inline-input-row">
                        <input
                          type="text"
                          value={characterDraft.iconFilePath}
                          onChange={(event) => onChangeCharacterDraft({ iconFilePath: event.target.value })}
                        />
                        <button className="launch-toggle compact" type="button" onClick={onPickCharacterIcon}>
                          Browse
                        </button>
                      </div>
                    </label>
                    <div className="settings-character-theme-fields">
                      <label className="settings-provider-input">
                        <span>Main</span>
                        <input
                          type="color"
                          value={characterDraft.theme.main}
                          onChange={(event) => onChangeCharacterDraft({
                            theme: { ...characterDraft.theme, main: event.target.value },
                          })}
                        />
                      </label>
                      <label className="settings-provider-input">
                        <span>Sub</span>
                        <input
                          type="color"
                          value={characterDraft.theme.sub}
                          onChange={(event) => onChangeCharacterDraft({
                            theme: { ...characterDraft.theme, sub: event.target.value },
                          })}
                        />
                      </label>
                    </div>
                  </div>

                  <label className="settings-provider-input">
                    <span>character.md</span>
                    <textarea
                      className="settings-character-markdown-textarea"
                      value={characterDraft.definitionMarkdown}
                      onChange={(event) => onChangeCharacterDraft({ definitionMarkdown: event.target.value })}
                      rows={14}
                      spellCheck={false}
                    />
                  </label>
                  <label className="settings-provider-input">
                    <span>character-notes.md</span>
                    <textarea
                      className="settings-character-notes-textarea"
                      value={characterDraft.notesMarkdown}
                      onChange={(event) => onChangeCharacterDraft({ notesMarkdown: event.target.value })}
                      rows={5}
                      spellCheck={false}
                    />
                  </label>
                  <input
                    id={CHARACTER_DEFINITION_IMPORT_INPUT_ID}
                    type="file"
                    accept=".md,text/markdown,text/plain"
                    className="settings-character-import-input"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) {
                        onImportCharacterDefinitionFile(file);
                      }
                      event.currentTarget.value = "";
                    }}
                  />
                  <div className="settings-actions settings-character-actions">
                    <button
                      className="launch-toggle"
                      type="button"
                      onClick={() => {
                        if (typeof document === "undefined") {
                          return;
                        }
                        document.getElementById(CHARACTER_DEFINITION_IMPORT_INPUT_ID)?.click();
                      }}
                      disabled={characterEditorBusy}
                    >
                      Import / Replace
                    </button>
                    <button
                      className="launch-toggle"
                      type="button"
                      onClick={onSetDefaultCharacter}
                      disabled={characterEditorBusy || characterDraft.mode !== "edit" || selectedCharacter?.isDefault}
                    >
                      Set Default
                    </button>
                    <button
                      className="launch-toggle danger-button"
                      type="button"
                      onClick={onArchiveCharacter}
                      disabled={characterEditorBusy || characterDraft.mode !== "edit"}
                    >
                      Archive
                    </button>
                    <button
                      className="launch-toggle"
                      type="button"
                      onClick={onCancelCharacterEdit}
                      disabled={characterEditorBusy || !characterEditorDirty}
                    >
                      Cancel
                    </button>
                    <button
                      className="launch-toggle start-session-button"
                      type="button"
                      onClick={onSaveCharacter}
                      disabled={characterEditorBusy || !characterEditorDirty}
                    >
                      Save Character
                    </button>
                  </div>
                  {characterEditorFeedback ? (
                    <p className="settings-feedback">{characterEditorFeedback}</p>
                  ) : null}
                </div>
              </div>
            </div>
          </section>

          <section className="settings-section-card">
            <div className="settings-field">
              <strong>{SETTINGS_DIAGNOSTICS_LABEL}</strong>
              <div className="settings-actions">
                <button className="launch-toggle" type="button" onClick={onOpenAppLogFolder}>
                  {SETTINGS_OPEN_LOG_FOLDER_LABEL}
                </button>
                <button className="launch-toggle" type="button" onClick={onOpenCrashDumpFolder}>
                  {SETTINGS_OPEN_CRASH_DUMP_FOLDER_LABEL}
                </button>
              </div>
            </div>
          </section>

          <section className="settings-section-card danger-zone">
            <div className="settings-field">
              <strong>{SETTINGS_MATE_RESET_LABEL}</strong>
              <p className="settings-help">{SETTINGS_MATE_RESET_HELP}</p>
              <div className="settings-actions">
                <button
                  className="launch-toggle danger-button"
                  type="button"
                  onClick={() => onResetMate?.()}
                  disabled={!canResetMate || mateResetBusy}
                >
                  {mateResetBusy ? "リセット中..." : SETTINGS_MATE_RESET_LABEL}
                </button>
              </div>
            </div>
          </section>

          <section className="settings-section-card">
            <div className="settings-field">
              <strong>Model Catalog</strong>
              <p className="settings-help">active revision: {modelCatalogRevisionLabel}</p>
              <div className="settings-actions">
                <button className="launch-toggle" type="button" onClick={onImportModelCatalog}>
                  Import Models
                </button>
                <button className="launch-toggle" type="button" onClick={onExportModelCatalog}>
                  Export Models
                </button>
              </div>
            </div>
          </section>

          </section>
        </div>
      </div>
      <div className="launch-dialog-foot settings-dialog-foot">
        {settingsFeedback ? <p className="settings-feedback settings-feedback-inline">{settingsFeedback}</p> : <span aria-hidden="true" />}
        <button className="launch-toggle" type="button" onClick={onSaveSettings} disabled={!settingsDirty}>
          Save Settings
        </button>
      </div>
    </>
  );
}
