import type { ReactNode } from "react";

import type {
  AppSettings,
  CharacterReflectionProviderSettings,
  CharacterProfile,
  MemoryExtractionProviderSettings,
  Session,
} from "./app-state.js";
import type { HomeProviderSettingRow } from "./home-settings-view-model.js";
import type { LaunchWorkspace } from "./home-launch-projection.js";
import type { HomeMonitorEntry, HomeSessionState } from "./home-session-projection.js";
import {
  SETTINGS_API_KEY_LABEL,
  SETTINGS_API_KEY_PLACEHOLDER,
  SETTINGS_CODING_CREDENTIALS_FUTURE_NOTE,
  SETTINGS_CODING_CREDENTIALS_HELP,
  SETTINGS_RESET_DATABASE_HELP,
  SETTINGS_RESET_DATABASE_LABEL,
  SETTINGS_RESET_DATABASE_TARGET_LABELS,
  SETTINGS_RELEASE_COMPATIBILITY_NOTE,
  SETTINGS_SKILL_ROOT_HELP,
  SETTINGS_SKILL_ROOT_LABEL,
  SETTINGS_SKILL_ROOT_PLACEHOLDER,
  SETTINGS_CHARACTER_REFLECTION_HELP,
  SETTINGS_CHARACTER_REFLECTION_MODEL_LABEL,
  SETTINGS_CHARACTER_REFLECTION_REASONING_LABEL,
  SETTINGS_MEMORY_EXTRACTION_HELP,
  SETTINGS_MEMORY_GENERATION_HELP,
  SETTINGS_MEMORY_GENERATION_LABEL,
  SETTINGS_MEMORY_EXTRACTION_MODEL_LABEL,
  SETTINGS_MEMORY_EXTRACTION_REASONING_LABEL,
  SETTINGS_MEMORY_EXTRACTION_THRESHOLD_LABEL,
} from "./settings-ui.js";
import { buildCardThemeStyle, CharacterAvatar, modelOptionLabel, reasoningDepthLabel } from "./ui-utils.js";
import type { ResetAppDatabaseTarget } from "./withmate-window-types.js";

export type HomeSettingsContentProps = {
  settingsDraft: AppSettings;
  providerSettingRows: HomeProviderSettingRow[];
  modelCatalogRevisionLabel: string;
  selectedResetTargetsDescription: string;
  resetTargetItems: Array<{
    target: ResetAppDatabaseTarget;
    checked: boolean;
    disabled: boolean;
  }>;
  resettingDatabase: boolean;
  canResetDatabase: boolean;
  settingsDirty: boolean;
  settingsFeedback: string;
  onOpenHome: () => void;
  onCloseWindow: () => void;
  onChangeSystemPromptPrefix: (value: string) => void;
  onChangeMemoryGenerationEnabled: (enabled: boolean) => void;
  onChangeProviderEnabled: (providerId: string, enabled: boolean) => void;
  onChangeProviderApiKey: (providerId: string, apiKey: string) => void;
  onChangeProviderSkillRootPath: (providerId: string, skillRootPath: string) => void;
  onBrowseProviderSkillRootPath: (providerId: string) => void;
  onChangeMemoryExtractionModel: (providerId: string, model: string) => void;
  onChangeMemoryExtractionReasoningEffort: (
    providerId: string,
    reasoningEffort: MemoryExtractionProviderSettings["reasoningEffort"],
  ) => void;
  onChangeMemoryExtractionThreshold: (providerId: string, value: string) => void;
  onChangeCharacterReflectionModel: (providerId: string, model: string) => void;
  onChangeCharacterReflectionReasoningEffort: (
    providerId: string,
    reasoningEffort: CharacterReflectionProviderSettings["reasoningEffort"],
  ) => void;
  onImportModelCatalog: () => void;
  onExportModelCatalog: () => void;
  onToggleResetDatabaseTarget: (target: ResetAppDatabaseTarget) => void;
  onResetAppDatabase: () => void;
  onSaveSettings: () => void;
};

export function HomeSettingsContent({
  settingsDraft,
  providerSettingRows,
  modelCatalogRevisionLabel,
  selectedResetTargetsDescription,
  resetTargetItems,
  resettingDatabase,
  canResetDatabase,
  settingsDirty,
  settingsFeedback,
  onOpenHome,
  onCloseWindow,
  onChangeSystemPromptPrefix,
  onChangeMemoryGenerationEnabled,
  onChangeProviderEnabled,
  onChangeProviderApiKey,
  onChangeProviderSkillRootPath,
  onBrowseProviderSkillRootPath,
  onChangeMemoryExtractionModel,
  onChangeMemoryExtractionReasoningEffort,
  onChangeMemoryExtractionThreshold,
  onChangeCharacterReflectionModel,
  onChangeCharacterReflectionReasoningEffort,
  onImportModelCatalog,
  onExportModelCatalog,
  onToggleResetDatabaseTarget,
  onResetAppDatabase,
  onSaveSettings,
}: HomeSettingsContentProps) {
  return (
    <>
      <div className="launch-dialog-head minimal settings-window-head">
        <button className="launch-toggle compact" type="button" onClick={onOpenHome}>
          Home
        </button>
        <button className="diff-close" type="button" onClick={onCloseWindow}>
          Close
        </button>
      </div>

      <div className="settings-panel">
        <section className="settings-section">
          <p className="settings-note">{SETTINGS_RELEASE_COMPATIBILITY_NOTE}</p>

          <section className="settings-section-card">
            <div className="settings-field">
              <strong>System Prompt Prefix</strong>
              <p className="settings-help">保存時に先頭へ <code># System Prompt</code> が自動で付く。</p>
              <textarea
                value={settingsDraft.systemPromptPrefix}
                onChange={(event) => onChangeSystemPromptPrefix(event.target.value)}
                rows={8}
              />
            </div>
          </section>

          {providerSettingRows.length > 0 ? (
            <>
              <section className="settings-section-card">
                <div className="settings-field">
                  <strong>Coding Agent Providers</strong>
                  <p className="settings-help">有効な coding provider は使える前提で扱う。失敗時は実行時エラーとして返る。</p>
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

              <section className="settings-section-card">
                <div className="settings-field">
                  <strong>Coding Agent Credentials</strong>
                  <p className="settings-help">{SETTINGS_CODING_CREDENTIALS_HELP}</p>
                  <div className="settings-provider-list">
                    {providerSettingRows.map(({ provider, settings }) => (
                      <section key={provider.id} className="settings-provider-card">
                        <p className="settings-provider-name">{provider.label}</p>
                        <label className="settings-provider-input">
                          <span>{SETTINGS_API_KEY_LABEL}</span>
                          <input
                            type="password"
                            value={settings.apiKey}
                            onChange={(event) => onChangeProviderApiKey(provider.id, event.target.value)}
                            placeholder={SETTINGS_API_KEY_PLACEHOLDER}
                            autoComplete="off"
                            spellCheck={false}
                          />
                        </label>
                      </section>
                    ))}
                  </div>
                  <p className="settings-note">{SETTINGS_CODING_CREDENTIALS_FUTURE_NOTE}</p>
                </div>
              </section>

              <section className="settings-section-card">
                <div className="settings-field">
                  <strong>Skill Roots</strong>
                  <p className="settings-help">{SETTINGS_SKILL_ROOT_HELP}</p>
                  <div className="settings-provider-list">
                    {providerSettingRows.map(({ provider, settings }) => (
                      <section key={provider.id} className="settings-provider-card">
                        <p className="settings-provider-name">{provider.label}</p>
                        <label className="settings-provider-input">
                          <span>{SETTINGS_SKILL_ROOT_LABEL}</span>
                          <div className="settings-inline-input-row">
                            <input
                              type="text"
                              value={settings.skillRootPath}
                              onChange={(event) => onChangeProviderSkillRootPath(provider.id, event.target.value)}
                              placeholder={SETTINGS_SKILL_ROOT_PLACEHOLDER}
                              autoComplete="off"
                              spellCheck={false}
                            />
                            <button
                              className="launch-toggle"
                              type="button"
                              onClick={() => onBrowseProviderSkillRootPath(provider.id)}
                            >
                              Browse
                            </button>
                          </div>
                        </label>
                      </section>
                    ))}
                  </div>
                </div>
              </section>

              <section className="settings-section-card">
              <div className="settings-field">
                <strong>Memory Extraction</strong>
                <p className="settings-help">{SETTINGS_MEMORY_EXTRACTION_HELP}</p>
                <label className="settings-provider-toggle-row settings-section-toggle">
                  <span className="settings-provider-name">{SETTINGS_MEMORY_GENERATION_LABEL}</span>
                  <input
                    type="checkbox"
                    checked={settingsDraft.memoryGenerationEnabled}
                    onChange={(event) => onChangeMemoryGenerationEnabled(event.target.checked)}
                  />
                </label>
                <p className="settings-help">{SETTINGS_MEMORY_GENERATION_HELP}</p>
                <div className="settings-provider-list">
                    {providerSettingRows.map((row) => (
                      <section key={row.provider.id} className="settings-provider-card">
                        <p className="settings-provider-name">{row.provider.label}</p>
                        <label className="settings-provider-input composer-setting-field">
                          <span>{SETTINGS_MEMORY_EXTRACTION_MODEL_LABEL}</span>
                          <select
                            value={row.resolvedMemoryExtractionModel}
                            onChange={(event) => onChangeMemoryExtractionModel(row.provider.id, event.target.value)}
                            aria-label={`${row.provider.label} model`}
                          >
                            {row.provider.models.map((model) => (
                              <option key={model.id} value={model.id}>
                                {modelOptionLabel(model)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="settings-provider-input composer-setting-field">
                          <span>{SETTINGS_MEMORY_EXTRACTION_REASONING_LABEL}</span>
                          <select
                            value={row.resolvedMemoryExtractionReasoningEffort}
                            onChange={(event) =>
                              onChangeMemoryExtractionReasoningEffort(
                                row.provider.id,
                                event.target.value as MemoryExtractionProviderSettings["reasoningEffort"],
                              )
                            }
                            aria-label={`${row.provider.label} reasoning depth`}
                          >
                            {row.availableMemoryExtractionReasoningEfforts.map((reasoningEffort) => (
                              <option key={reasoningEffort} value={reasoningEffort}>
                                {reasoningDepthLabel(reasoningEffort)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="settings-provider-input">
                          <span>{SETTINGS_MEMORY_EXTRACTION_THRESHOLD_LABEL}</span>
                          <input
                            type="number"
                            min={1}
                            step={1}
                            value={row.memoryExtractionSettings.outputTokensThreshold}
                            onChange={(event) => onChangeMemoryExtractionThreshold(row.provider.id, event.target.value)}
                          />
                        </label>
                      </section>
                    ))}
                  </div>
                </div>
              </section>

              <section className="settings-section-card">
                <div className="settings-field">
                  <strong>Character Reflection</strong>
                  <p className="settings-help">{SETTINGS_CHARACTER_REFLECTION_HELP}</p>
                  <div className="settings-provider-list">
                    {providerSettingRows.map((row) => (
                      <section key={row.provider.id} className="settings-provider-card">
                        <p className="settings-provider-name">{row.provider.label}</p>
                        <label className="settings-provider-input composer-setting-field">
                          <span>{SETTINGS_CHARACTER_REFLECTION_MODEL_LABEL}</span>
                          <select
                            value={row.resolvedCharacterReflectionModel}
                            onChange={(event) => onChangeCharacterReflectionModel(row.provider.id, event.target.value)}
                            aria-label={`${row.provider.label} character reflection model`}
                          >
                            {row.provider.models.map((model) => (
                              <option key={model.id} value={model.id}>
                                {modelOptionLabel(model)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="settings-provider-input composer-setting-field">
                          <span>{SETTINGS_CHARACTER_REFLECTION_REASONING_LABEL}</span>
                          <select
                            value={row.resolvedCharacterReflectionReasoningEffort}
                            onChange={(event) =>
                              onChangeCharacterReflectionReasoningEffort(
                                row.provider.id,
                                event.target.value as CharacterReflectionProviderSettings["reasoningEffort"],
                              )
                            }
                            aria-label={`${row.provider.label} character reflection reasoning depth`}
                          >
                            {row.availableCharacterReflectionReasoningEfforts.map((reasoningEffort) => (
                              <option key={reasoningEffort} value={reasoningEffort}>
                                {reasoningDepthLabel(reasoningEffort)}
                              </option>
                            ))}
                          </select>
                        </label>
                      </section>
                    ))}
                  </div>
                </div>
              </section>
            </>
          ) : null}

          <section className="settings-section-card">
            <div className="settings-field">
              <strong>Model Catalog</strong>
              <p className="settings-help">active revision: {modelCatalogRevisionLabel}。DB 初期化を行うと bundled catalog の初期状態へ戻る。</p>
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

          <section className="settings-section-card danger-zone">
            <div className="settings-field">
              <strong>Danger Zone</strong>
              <p className="settings-help">{SETTINGS_RESET_DATABASE_HELP}</p>
              <ul className="settings-danger-list">
                <li>選択中の reset 対象: {selectedResetTargetsDescription}</li>
                <li>reset 非対象: characters（DB 外ファイルなので保持）</li>
              </ul>
              <div className="settings-reset-targets" role="group" aria-label="reset targets">
                {resetTargetItems.map(({ target, checked, disabled }) => (
                  <label key={target} className="settings-reset-target">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => onToggleResetDatabaseTarget(target)}
                    />
                    <span>{SETTINGS_RESET_DATABASE_TARGET_LABELS[target]}</span>
                  </label>
                ))}
              </div>
              <div className="settings-actions">
                <button
                  className="drawer-toggle danger"
                  type="button"
                  onClick={onResetAppDatabase}
                  disabled={!canResetDatabase}
                >
                  {resettingDatabase ? "DB 初期化中..." : SETTINGS_RESET_DATABASE_LABEL}
                </button>
              </div>
            </div>
          </section>
        </section>
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

export type HomeLaunchDialogProps = {
  open: boolean;
  title: string;
  workspace: LaunchWorkspace | null;
  launchWorkspacePathLabel: string;
  enabledLaunchProviders: Array<{ id: string; label: string }>;
  selectedLaunchProviderId: string | null;
  characters: CharacterProfile[];
  filteredLaunchCharacters: CharacterProfile[];
  selectedCharacterId: string | null;
  launchCharacterSearchText: string;
  canStartSession: boolean;
  searchIcon: ReactNode;
  onClose: () => void;
  onChangeTitle: (value: string) => void;
  onBrowseWorkspace: () => void;
  onSelectProvider: (providerId: string) => void;
  onChangeCharacterSearch: (value: string) => void;
  onSelectCharacter: (characterId: string) => void;
  onOpenCharacterEditor: () => void;
  onStartSession: () => void;
};

export function HomeLaunchDialog({
  open,
  title,
  workspace,
  launchWorkspacePathLabel,
  enabledLaunchProviders,
  selectedLaunchProviderId,
  characters,
  filteredLaunchCharacters,
  selectedCharacterId,
  launchCharacterSearchText,
  canStartSession,
  searchIcon,
  onClose,
  onChangeTitle,
  onBrowseWorkspace,
  onSelectProvider,
  onChangeCharacterSearch,
  onSelectCharacter,
  onOpenCharacterEditor,
  onStartSession,
}: HomeLaunchDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="launch-modal" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="launch-dialog panel" onClick={(event) => event.stopPropagation()}>
        <div className="launch-dialog-head minimal">
          <button className="diff-close" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="launch-panel minimal">
          <section className="launch-section minimal">
            <div className="launch-field">
              <label className="launch-field-label" htmlFor="launch-session-title">
                セッションタイトル
              </label>
              <input
                id="launch-session-title"
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

          <section className="launch-section minimal">
            <div className="launch-field">
              <label className="launch-field-label" htmlFor="launch-provider-picker">
                Coding Provider
              </label>
              {enabledLaunchProviders.length > 0 ? (
                <div id="launch-provider-picker" className="choice-list launch-provider-list" role="listbox" aria-label="Coding Provider">
                  {enabledLaunchProviders.map((provider) => (
                    <button
                      key={provider.id}
                      className={`choice-chip${provider.id === selectedLaunchProviderId ? " active" : ""}`}
                      type="button"
                      aria-selected={provider.id === selectedLaunchProviderId}
                      onClick={() => onSelectProvider(provider.id)}
                    >
                      {provider.label}
                    </button>
                  ))}
                </div>
              ) : (
                <article className="empty-list-card compact">
                  <p>有効な Coding Provider がないよ。</p>
                </article>
              )}
            </div>
          </section>

          <section className="launch-section profile-panel minimal">
            {characters.length > 0 ? (
              <>
                <div className="launch-search-row">
                  <label className="toolbar-search-field" aria-label="キャラ検索">
                    <span className="toolbar-search-icon">{searchIcon}</span>
                    <input
                      className="toolbar-search-input"
                      type="text"
                      value={launchCharacterSearchText}
                      onChange={(event) => onChangeCharacterSearch(event.target.value)}
                    />
                  </label>
                </div>

                {filteredLaunchCharacters.length > 0 ? (
                  <div className="choice-card-list">
                    {filteredLaunchCharacters.map((character) => (
                      <button
                        key={character.id}
                        className={`choice-card${character.id === selectedCharacterId ? " active" : ""}`}
                        style={buildCardThemeStyle(character.themeColors)}
                        type="button"
                        onClick={() => onSelectCharacter(character.id)}
                      >
                        <CharacterAvatar character={character} size="small" className="choice-avatar" />
                        <div className="choice-card-copy">
                          <strong>{character.name}</strong>
                          <span>{character.description || "キャラクターを選ぶ"}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <article className="empty-list-card compact">
                    <p>一致するキャラはないよ。</p>
                  </article>
                )}
              </>
            ) : (
              <article className="empty-list-card compact">
                <p>セッションを始める前にキャラを作ってね。</p>
                <button className="launch-toggle" type="button" onClick={onOpenCharacterEditor}>
                  Add Character
                </button>
              </article>
            )}
          </section>
        </div>

        <div className="launch-dialog-foot minimal">
          <button className="start-session-button" type="button" disabled={!canStartSession} onClick={onStartSession}>
            Start New Session
          </button>
        </div>
      </section>
    </div>
  );
}

export type HomeRecentSessionsPanelProps = {
  filteredSessionEntries: Array<{ session: Session; state: HomeSessionState }>;
  normalizedSessionSearch: string;
  searchText: string;
  searchIcon: ReactNode;
  onChangeSearchText: (value: string) => void;
  onOpenLaunchDialog: () => void;
  onOpenSession: (sessionId: string) => void;
};

export function HomeRecentSessionsPanel({
  filteredSessionEntries,
  normalizedSessionSearch,
  searchText,
  searchIcon,
  onChangeSearchText,
  onOpenLaunchDialog,
  onOpenSession,
}: HomeRecentSessionsPanelProps) {
  return (
    <section className="panel session-list-panel home-session-list-panel rise-3">
      <div className="home-panel-head">
        <div className="home-panel-copy">
          <h2>Recent Sessions</h2>
        </div>
      </div>

      <div className="toolbar-search-row">
        <label className="toolbar-search-field" aria-label="セッション検索">
          <span className="toolbar-search-icon" aria-hidden="true">
            {searchIcon}
          </span>
          <input
            className="toolbar-search-input"
            type="text"
            aria-label="セッション検索"
            value={searchText}
            onChange={(event) => onChangeSearchText(event.target.value)}
          />
        </label>
        <button className="start-session-button" type="button" onClick={onOpenLaunchDialog}>
          New Session
        </button>
      </div>

      <div className="session-card-list home-session-card-list">
        {filteredSessionEntries.length > 0 ? (
          filteredSessionEntries.map(({ session, state }) => (
            <button
              key={session.id}
              className="session-card home-session-card"
              type="button"
              style={buildCardThemeStyle(session.characterThemeColors)}
              onClick={() => onOpenSession(session.id)}
            >
              <CharacterAvatar character={{ name: session.character, iconPath: session.characterIconPath }} size="small" className="session-card-avatar" />
              <div className="session-card-copy">
                <div className="session-card-topline home-session-card-topline">
                  <strong>{session.taskTitle}</strong>
                  <span className={`session-status home-session-status ${state.kind}`.trim()}>{state.label}</span>
                </div>
                <div className="session-card-subline home-session-card-meta">
                  <span>{`Workspace : ${session.workspacePath || session.workspaceLabel}`}</span>
                  <span>{`updatedAt: ${session.updatedAt}`}</span>
                </div>
                {session.taskSummary.trim() ? <p className="session-card-summary home-session-card-summary">{session.taskSummary}</p> : null}
              </div>
            </button>
          ))
        ) : normalizedSessionSearch ? (
          <article className="empty-list-card">
            <p>一致するセッションはないよ。</p>
          </article>
        ) : (
          <article className="empty-list-card">
            <p>まだセッションはないよ。</p>
            <button className="start-session-button" type="button" onClick={onOpenLaunchDialog}>
              New Session
            </button>
          </article>
        )}
      </div>
    </section>
  );
}

export type HomeMonitorContentProps = {
  runningEntries: HomeMonitorEntry[];
  nonRunningEntries: HomeMonitorEntry[];
  runningEmptyMessage: string;
  completedEmptyMessage: string;
  onOpenSession: (sessionId: string) => void;
};

export function HomeMonitorContent({
  runningEntries,
  nonRunningEntries,
  runningEmptyMessage,
  completedEmptyMessage,
  onOpenSession,
}: HomeMonitorContentProps) {
  return (
    <div className="home-monitor-body">
      <section className="home-monitor-section" aria-labelledby="home-monitor-running">
        <div className="home-monitor-section-head">
          <h3 id="home-monitor-running">実行中</h3>
          <span className="home-monitor-count">{runningEntries.length}</span>
        </div>
        <div className="home-monitor-list">
          {runningEntries.length > 0 ? (
            runningEntries.map(({ session, state }) => (
              <button
                key={session.id}
                className="home-monitor-row"
                type="button"
                onClick={() => onOpenSession(session.id)}
              >
                <CharacterAvatar character={{ name: session.character, iconPath: session.characterIconPath }} size="tiny" />
                <div className="home-monitor-row-copy">
                  <strong>{session.taskTitle}</strong>
                  <span>{session.workspaceLabel || session.workspacePath || "workspace 未設定"}</span>
                </div>
                <span className={`session-status home-monitor-status ${state.kind}`.trim()}>{state.label}</span>
              </button>
            ))
          ) : (
            <p className="home-monitor-empty">{runningEmptyMessage}</p>
          )}
        </div>
      </section>

      <section className="home-monitor-section" aria-labelledby="home-monitor-inactive">
        <div className="home-monitor-section-head">
          <h3 id="home-monitor-inactive">停止・完了</h3>
          <span className="home-monitor-count">{nonRunningEntries.length}</span>
        </div>
        <div className="home-monitor-list">
          {nonRunningEntries.length > 0 ? (
            nonRunningEntries.map(({ session, state }) => (
              <button
                key={session.id}
                className="home-monitor-row"
                type="button"
                onClick={() => onOpenSession(session.id)}
              >
                <CharacterAvatar character={{ name: session.character, iconPath: session.characterIconPath }} size="tiny" />
                <div className="home-monitor-row-copy">
                  <strong>{session.taskTitle}</strong>
                  <span>{session.workspaceLabel || session.workspacePath || "workspace 未設定"}</span>
                </div>
                <span className={`session-status home-monitor-status ${state.kind}`.trim()}>{state.label}</span>
              </button>
            ))
          ) : (
            <p className="home-monitor-empty">{completedEmptyMessage}</p>
          )}
        </div>
      </section>
    </div>
  );
}

export type HomeRightPaneProps = {
  rightPaneView: "monitor" | "characters";
  runningMonitorEntries: HomeMonitorEntry[];
  nonRunningMonitorEntries: HomeMonitorEntry[];
  monitorRunningEmptyMessage: string;
  monitorCompletedEmptyMessage: string;
  filteredCharacters: CharacterProfile[];
  characterEmptyState: "no-match" | "empty" | null;
  characterSearchText: string;
  searchIcon: ReactNode;
  monitorWindowIcon: ReactNode;
  onChangeRightPaneView: (view: "monitor" | "characters") => void;
  onOpenSessionMonitorWindow: () => void;
  onOpenSettingsWindow: () => void;
  onChangeCharacterSearchText: (value: string) => void;
  onOpenCharacterEditor: (characterId?: string | null) => void;
  onOpenSession: (sessionId: string) => void;
};

export function HomeRightPane({
  rightPaneView,
  runningMonitorEntries,
  nonRunningMonitorEntries,
  monitorRunningEmptyMessage,
  monitorCompletedEmptyMessage,
  filteredCharacters,
  characterEmptyState,
  characterSearchText,
  searchIcon,
  monitorWindowIcon,
  onChangeRightPaneView,
  onOpenSessionMonitorWindow,
  onOpenSettingsWindow,
  onChangeCharacterSearchText,
  onOpenCharacterEditor,
  onOpenSession,
}: HomeRightPaneProps) {
  return (
    <section className="panel home-right-pane rise-3">
      <div className="home-settings-rail">
        <div className="home-pane-toggle" role="tablist" aria-label="Home right pane">
          <button
            className={`home-pane-toggle-button ${rightPaneView === "monitor" ? "active" : ""}`.trim()}
            type="button"
            role="tab"
            aria-selected={rightPaneView === "monitor"}
            onClick={() => onChangeRightPaneView("monitor")}
          >
            Monitor
          </button>
          <button
            className={`home-pane-toggle-button ${rightPaneView === "characters" ? "active" : ""}`.trim()}
            type="button"
            role="tab"
            aria-selected={rightPaneView === "characters"}
            onClick={() => onChangeRightPaneView("characters")}
          >
            Characters
          </button>
        </div>
        <div className="home-settings-actions">
          <button
            className="launch-toggle home-monitor-window-button"
            type="button"
            aria-label="Session Monitor Window を開く"
            title="Session Monitor Window"
            onClick={onOpenSessionMonitorWindow}
          >
            {monitorWindowIcon}
          </button>
          <button className="launch-toggle home-settings-button" type="button" onClick={onOpenSettingsWindow}>
            Settings
          </button>
        </div>
      </div>

      {rightPaneView === "monitor" ? (
        <section className="home-monitor-panel" role="tabpanel" aria-label="Session Monitor">
          <HomeMonitorContent
            runningEntries={runningMonitorEntries}
            nonRunningEntries={nonRunningMonitorEntries}
            runningEmptyMessage={monitorRunningEmptyMessage}
            completedEmptyMessage={monitorCompletedEmptyMessage}
            onOpenSession={onOpenSession}
          />
        </section>
      ) : (
        <section className="characters-panel home-characters-panel" role="tabpanel" aria-label="Characters">
          <div className="toolbar-search-row home-character-toolbar">
            <label className="toolbar-search-field" aria-label="キャラクター検索">
              <span className="toolbar-search-icon" aria-hidden="true">
                {searchIcon}
              </span>
              <input
                className="toolbar-search-input"
                type="text"
                aria-label="キャラクター検索"
                value={characterSearchText}
                onChange={(event) => onChangeCharacterSearchText(event.target.value)}
              />
            </label>
            <button className="launch-toggle" type="button" onClick={() => onOpenCharacterEditor()}>
              Add Character
            </button>
          </div>

          <div className="character-list">
            {filteredCharacters.length > 0 ? (
              filteredCharacters.map((character) => (
                <button
                  key={character.id}
                  className="character-card"
                  type="button"
                  style={buildCardThemeStyle(character.themeColors)}
                  onClick={() => onOpenCharacterEditor(character.id)}
                >
                  <CharacterAvatar character={character} size="small" className="character-card-avatar" />
                  <div className="character-card-copy">
                    <strong>{character.name}</strong>
                  </div>
                </button>
              ))
            ) : characterEmptyState === "no-match" ? (
              <article className="empty-list-card">
                <p>一致するキャラはないよ。</p>
              </article>
            ) : (
              <article className="empty-list-card">
                <p>まだキャラはないよ。</p>
                <button className="launch-toggle" type="button" onClick={() => onOpenCharacterEditor()}>
                  Add Character
                </button>
              </article>
            )}
          </div>
        </section>
      )}
    </section>
  );
}
