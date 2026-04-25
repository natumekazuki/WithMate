import { useMemo, useRef, useState, type ReactNode } from "react";

import type {
  AppSettings,
  CharacterReflectionProviderSettings,
  CharacterProfile,
  MemoryExtractionProviderSettings,
  SessionSummary,
} from "./app-state.js";
import type { MemoryManagementSnapshot } from "./memory-management-state.js";
import {
  buildFilteredMemoryManagementSnapshot,
  DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS,
  type CharacterMemoryCategoryFilter,
  type MemoryManagementDomainFilter,
  type MemoryManagementSort,
  type ProjectMemoryCategoryFilter,
  type SessionMemoryStatusFilter,
} from "./memory-management-view.js";
import type { HomeProviderSettingRow } from "./home-settings-view-model.js";
import type { LaunchWorkspace } from "./home-launch-projection.js";
import type { HomeMonitorEntry, HomeSessionState } from "./home-session-projection.js";
import {
  SETTINGS_SKILL_ROOT_LABEL,
  SETTINGS_SKILL_ROOT_PLACEHOLDER,
  SETTINGS_CHARACTER_REFLECTION_CHAR_DELTA_LABEL,
  SETTINGS_CHARACTER_REFLECTION_COOLDOWN_LABEL,
  SETTINGS_CHARACTER_REFLECTION_MESSAGE_DELTA_LABEL,
  SETTINGS_CHARACTER_REFLECTION_MODEL_LABEL,
  SETTINGS_CHARACTER_REFLECTION_REASONING_LABEL,
  SETTINGS_CHARACTER_REFLECTION_TIMEOUT_LABEL,
  SETTINGS_ACTION_DOCK_AUTO_CLOSE_LABEL,
  SETTINGS_MEMORY_GENERATION_LABEL,
  SETTINGS_MEMORY_EXTRACTION_MODEL_LABEL,
  SETTINGS_MEMORY_EXTRACTION_REASONING_LABEL,
  SETTINGS_MEMORY_EXTRACTION_TIMEOUT_LABEL,
  SETTINGS_MEMORY_EXTRACTION_THRESHOLD_LABEL,
  SETTINGS_DIAGNOSTICS_LABEL,
  SETTINGS_OPEN_LOG_FOLDER_LABEL,
  SETTINGS_OPEN_CRASH_DUMP_FOLDER_LABEL,
} from "./settings-ui.js";
import { focusRovingItemByKey, useDialogA11y } from "./a11y.js";
import { buildCardThemeStyle, CharacterAvatar, modelOptionLabel, reasoningDepthLabel } from "./ui-utils.js";

export type HomeSettingsContentProps = {
  settingsDraft: AppSettings;
  providerSettingRows: HomeProviderSettingRow[];
  modelCatalogRevisionLabel: string;
  settingsDirty: boolean;
  settingsFeedback: string;
  memoryManagementSnapshot: MemoryManagementSnapshot | null;
  memoryManagementLoading: boolean;
  memoryManagementBusyTarget: string | null;
  memoryManagementFeedback: string;
  memoryManagementOnly?: boolean;
  onChangeSystemPromptPrefix: (value: string) => void;
  onChangeMemoryGenerationEnabled: (enabled: boolean) => void;
  onChangeAutoCollapseActionDockOnSend: (enabled: boolean) => void;
  onChangeProviderEnabled: (providerId: string, enabled: boolean) => void;
  onChangeProviderSkillRootPath: (providerId: string, skillRootPath: string) => void;
  onBrowseProviderSkillRootPath: (providerId: string) => void;
  onChangeMemoryExtractionModel: (providerId: string, model: string) => void;
  onChangeMemoryExtractionReasoningEffort: (
    providerId: string,
    reasoningEffort: MemoryExtractionProviderSettings["reasoningEffort"],
  ) => void;
  onChangeMemoryExtractionThreshold: (providerId: string, value: string) => void;
  onChangeMemoryExtractionTimeoutSeconds: (providerId: string, value: string) => void;
  onChangeCharacterReflectionModel: (providerId: string, model: string) => void;
  onChangeCharacterReflectionReasoningEffort: (
    providerId: string,
    reasoningEffort: CharacterReflectionProviderSettings["reasoningEffort"],
  ) => void;
  onChangeCharacterReflectionTimeoutSeconds: (providerId: string, value: string) => void;
  onChangeCharacterReflectionCooldownSeconds: (value: string) => void;
  onChangeCharacterReflectionCharDeltaThreshold: (value: string) => void;
  onChangeCharacterReflectionMessageDeltaThreshold: (value: string) => void;
  onImportModelCatalog: () => void;
  onExportModelCatalog: () => void;
  onOpenAppLogFolder: () => void;
  onOpenCrashDumpFolder: () => void;
  onReloadMemoryManagement: () => void;
  onDeleteSessionMemory: (sessionId: string) => void;
  onDeleteProjectMemoryEntry: (entryId: string) => void;
  onDeleteCharacterMemoryEntry: (entryId: string) => void;
  onSaveSettings: () => void;
};

export function HomeSettingsContent({
  settingsDraft,
  providerSettingRows,
  modelCatalogRevisionLabel,
  settingsDirty,
  settingsFeedback,
  memoryManagementSnapshot,
  memoryManagementLoading,
  memoryManagementBusyTarget,
  memoryManagementFeedback,
  memoryManagementOnly = false,
  onChangeSystemPromptPrefix,
  onChangeMemoryGenerationEnabled,
  onChangeAutoCollapseActionDockOnSend,
  onChangeProviderEnabled,
  onChangeProviderSkillRootPath,
  onBrowseProviderSkillRootPath,
  onChangeMemoryExtractionModel,
  onChangeMemoryExtractionReasoningEffort,
  onChangeMemoryExtractionThreshold,
  onChangeMemoryExtractionTimeoutSeconds,
  onChangeCharacterReflectionModel,
  onChangeCharacterReflectionReasoningEffort,
  onChangeCharacterReflectionTimeoutSeconds,
  onChangeCharacterReflectionCooldownSeconds,
  onChangeCharacterReflectionCharDeltaThreshold,
  onChangeCharacterReflectionMessageDeltaThreshold,
  onImportModelCatalog,
  onExportModelCatalog,
  onOpenAppLogFolder,
  onOpenCrashDumpFolder,
  onReloadMemoryManagement,
  onDeleteSessionMemory,
  onDeleteProjectMemoryEntry,
  onDeleteCharacterMemoryEntry,
  onSaveSettings,
}: HomeSettingsContentProps) {
  if (memoryManagementOnly) {
    return (
      <div className="settings-panel settings-panel-memory-only">
        <div className="settings-panel-memory-scroll">
          <SettingsMemoryManagementSection
            snapshot={memoryManagementSnapshot}
            loading={memoryManagementLoading}
            busyTarget={memoryManagementBusyTarget}
            feedback={memoryManagementFeedback}
            onReload={onReloadMemoryManagement}
            onDeleteSessionMemory={onDeleteSessionMemory}
            onDeleteProjectMemoryEntry={onDeleteProjectMemoryEntry}
            onDeleteCharacterMemoryEntry={onDeleteCharacterMemoryEntry}
            standalone
          />
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="settings-panel settings-panel-window">
        <div className="settings-panel-window-scroll">
          <section className="settings-section">
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

              <section className="settings-section-card">
                <div className="settings-field">
                  <strong>Skill Roots</strong>
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
                <label className="settings-provider-toggle-row settings-section-toggle">
                  <span className="settings-provider-name">{SETTINGS_MEMORY_GENERATION_LABEL}</span>
                  <input
                    type="checkbox"
                    checked={settingsDraft.memoryGenerationEnabled}
                    onChange={(event) => onChangeMemoryGenerationEnabled(event.target.checked)}
                  />
                </label>
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
                        <label className="settings-provider-input">
                          <span>{SETTINGS_MEMORY_EXTRACTION_TIMEOUT_LABEL}</span>
                          <input
                            type="number"
                            min={30}
                            max={1800}
                            step={30}
                            value={row.memoryExtractionSettings.timeoutSeconds}
                            onChange={(event) => onChangeMemoryExtractionTimeoutSeconds(row.provider.id, event.target.value)}
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
                  <div className="settings-provider-list">
                    <section className="settings-provider-card">
                      <label className="settings-provider-input composer-setting-field">
                        <span>{SETTINGS_CHARACTER_REFLECTION_COOLDOWN_LABEL}</span>
                        <input
                          type="number"
                          min={30}
                          max={3600}
                          step={30}
                          value={settingsDraft.characterReflectionTriggerSettings.cooldownSeconds}
                          onChange={(event) => onChangeCharacterReflectionCooldownSeconds(event.target.value)}
                        />
                      </label>
                      <label className="settings-provider-input composer-setting-field">
                        <span>{SETTINGS_CHARACTER_REFLECTION_CHAR_DELTA_LABEL}</span>
                        <input
                          type="number"
                          min={1}
                          max={20000}
                          step={50}
                          value={settingsDraft.characterReflectionTriggerSettings.charDeltaThreshold}
                          onChange={(event) => onChangeCharacterReflectionCharDeltaThreshold(event.target.value)}
                        />
                      </label>
                      <label className="settings-provider-input composer-setting-field">
                        <span>{SETTINGS_CHARACTER_REFLECTION_MESSAGE_DELTA_LABEL}</span>
                        <input
                          type="number"
                          min={1}
                          max={100}
                          step={1}
                          value={settingsDraft.characterReflectionTriggerSettings.messageDeltaThreshold}
                          onChange={(event) => onChangeCharacterReflectionMessageDeltaThreshold(event.target.value)}
                        />
                      </label>
                    </section>
                  </div>
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
                        <label className="settings-provider-input">
                          <span>{SETTINGS_CHARACTER_REFLECTION_TIMEOUT_LABEL}</span>
                          <input
                            type="number"
                            min={30}
                            max={1800}
                            step={30}
                            value={row.characterReflectionSettings.timeoutSeconds}
                            onChange={(event) => onChangeCharacterReflectionTimeoutSeconds(row.provider.id, event.target.value)}
                          />
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

type SettingsMemoryManagementSectionProps = {
  snapshot: MemoryManagementSnapshot | null;
  loading: boolean;
  busyTarget: string | null;
  feedback: string;
  standalone?: boolean;
  onReload: () => void;
  onDeleteSessionMemory: (sessionId: string) => void;
  onDeleteProjectMemoryEntry: (entryId: string) => void;
  onDeleteCharacterMemoryEntry: (entryId: string) => void;
};

const MEMORY_DOMAIN_OPTIONS: Array<{ value: MemoryManagementDomainFilter; label: string }> = [
  { value: "all", label: "All Domains" },
  { value: "session", label: "Session" },
  { value: "project", label: "Project" },
  { value: "character", label: "Character" },
];

const MEMORY_SORT_OPTIONS: Array<{ value: MemoryManagementSort; label: string }> = [
  { value: "updated-desc", label: "更新が新しい順" },
  { value: "updated-asc", label: "更新が古い順" },
];

const SESSION_STATUS_OPTIONS: Array<{ value: SessionMemoryStatusFilter; label: string }> = [
  { value: "all", label: "すべての状態" },
  { value: "running", label: "Running" },
  { value: "idle", label: "Idle" },
  { value: "saved", label: "Saved" },
];

const PROJECT_CATEGORY_OPTIONS: Array<{ value: ProjectMemoryCategoryFilter; label: string }> = [
  { value: "all", label: "全カテゴリ" },
  { value: "decision", label: "decision" },
  { value: "constraint", label: "constraint" },
  { value: "convention", label: "convention" },
  { value: "context", label: "context" },
  { value: "deferred", label: "deferred" },
];

const CHARACTER_CATEGORY_OPTIONS: Array<{ value: CharacterMemoryCategoryFilter; label: string }> = [
  { value: "all", label: "全カテゴリ" },
  { value: "preference", label: "preference" },
  { value: "relationship", label: "relationship" },
  { value: "shared_moment", label: "shared_moment" },
  { value: "tone", label: "tone" },
  { value: "boundary", label: "boundary" },
];

function SettingsMemoryManagementSection({
  snapshot,
  loading,
  busyTarget,
  feedback,
  standalone = false,
  onReload,
  onDeleteSessionMemory,
  onDeleteProjectMemoryEntry,
  onDeleteCharacterMemoryEntry,
}: SettingsMemoryManagementSectionProps) {
  const [searchText, setSearchText] = useState(DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.searchText);
  const [domain, setDomain] = useState<MemoryManagementDomainFilter>(DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.domain);
  const [sort, setSort] = useState<MemoryManagementSort>(DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.sort);
  const [sessionStatus, setSessionStatus] = useState<SessionMemoryStatusFilter>(DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.sessionStatus);
  const [projectCategory, setProjectCategory] = useState<ProjectMemoryCategoryFilter>(
    DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.projectCategory,
  );
  const [characterCategory, setCharacterCategory] = useState<CharacterMemoryCategoryFilter>(
    DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.characterCategory,
  );

  const filteredSnapshot = useMemo(
    () =>
      buildFilteredMemoryManagementSnapshot(snapshot, {
        searchText,
        domain,
        sort,
        sessionStatus,
        projectCategory,
        characterCategory,
      }),
    [characterCategory, domain, projectCategory, searchText, sessionStatus, snapshot, sort],
  );
  const sessionCount = filteredSnapshot?.sessionMemories.length ?? 0;
  const projectEntryCount = filteredSnapshot?.projectMemories.reduce((count, group) => count + group.entries.length, 0) ?? 0;
  const characterEntryCount =
    filteredSnapshot?.characterMemories.reduce((count, group) => count + group.entries.length, 0) ?? 0;
  const hasActiveFilters =
    searchText.trim().length > 0 ||
    domain !== DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.domain ||
    sort !== DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.sort ||
    sessionStatus !== DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.sessionStatus ||
    projectCategory !== DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.projectCategory ||
    characterCategory !== DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.characterCategory;
  const showSessionDomain = domain === "all" || domain === "session";
  const showProjectDomain = domain === "all" || domain === "project";
  const showCharacterDomain = domain === "all" || domain === "character";

  const clearFilters = () => {
    setSearchText(DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.searchText);
    setDomain(DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.domain);
    setSort(DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.sort);
    setSessionStatus(DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.sessionStatus);
    setProjectCategory(DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.projectCategory);
    setCharacterCategory(DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.characterCategory);
  };

  return (
    <section className="settings-section-card">
      <div className="settings-field">
        <strong>Memory 管理</strong>
        <div className="settings-actions settings-memory-actions">
          <span className="settings-memory-summary">
            {`Session ${sessionCount} / Project ${projectEntryCount} / Character ${characterEntryCount}`}
          </span>
          <div className="settings-actions">
            {hasActiveFilters ? (
              <button className="launch-toggle compact" type="button" onClick={clearFilters} disabled={loading}>
                Clear Filters
              </button>
            ) : null}
            <button className="launch-toggle" type="button" onClick={onReload} disabled={loading}>
              {loading ? "Memory 読み込み中..." : "Reload Memory"}
            </button>
          </div>
        </div>
        {feedback ? <p className="settings-feedback settings-memory-feedback">{feedback}</p> : null}
        <div className="settings-memory-toolbar">
          <label className="settings-provider-input">
            <span>Search</span>
            <input
              type="text"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="title / detail / keyword / workspace"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="settings-provider-input">
            <span>Domain</span>
            <div className="settings-memory-domain-tabs" role="tablist" aria-label="memory domain">
              {MEMORY_DOMAIN_OPTIONS.map((option) => {
                const isActive = domain === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className={`settings-memory-domain-tab${isActive ? " active" : ""}`}
                    onClick={() => setDomain(option.value)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="settings-memory-filter-grid">
            <label className="settings-provider-input">
              <span>Sort</span>
              <select value={sort} onChange={(event) => setSort(event.target.value as MemoryManagementSort)}>
                {MEMORY_SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-provider-input">
              <span>Session Status</span>
              <select
                value={sessionStatus}
                disabled={domain === "project" || domain === "character"}
                onChange={(event) => setSessionStatus(event.target.value as SessionMemoryStatusFilter)}
              >
                {SESSION_STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-provider-input">
              <span>Project Category</span>
              <select
                value={projectCategory}
                disabled={domain === "session" || domain === "character"}
                onChange={(event) => setProjectCategory(event.target.value as ProjectMemoryCategoryFilter)}
              >
                {PROJECT_CATEGORY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-provider-input">
              <span>Character Category</span>
              <select
                value={characterCategory}
                disabled={domain === "session" || domain === "project"}
                onChange={(event) => setCharacterCategory(event.target.value as CharacterMemoryCategoryFilter)}
              >
                {CHARACTER_CATEGORY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="settings-memory-section-list">
          {showSessionDomain ? (
            <section className="settings-memory-domain">
            <div className="settings-memory-domain-head">
              <h3>Session Memory</h3>
              <span>{sessionCount}</span>
            </div>
            {filteredSnapshot && filteredSnapshot.sessionMemories.length > 0 ? (
              <div className="settings-memory-card-list">
                {filteredSnapshot.sessionMemories.map((item) => {
                  const targetKey = `session:${item.sessionId}`;
                  const deleting = busyTarget === targetKey;
                  return (
                    <article key={item.sessionId} className="settings-memory-card">
                      <div className="settings-memory-card-head">
                        <div className="settings-memory-card-copy">
                          <strong>{item.taskTitle}</strong>
                          <span>{`${item.character} / ${item.provider || "provider 未設定"}`}</span>
                        </div>
                        <button
                          className="danger-button"
                          type="button"
                          disabled={loading || deleting}
                          onClick={() => onDeleteSessionMemory(item.sessionId)}
                        >
                          {deleting ? "削除中..." : "Delete"}
                        </button>
                      </div>
                      <dl className="settings-memory-meta">
                        <div>
                          <dt>Workspace</dt>
                          <dd>{item.workspacePath || item.workspaceLabel || "-"}</dd>
                        </div>
                        <div>
                          <dt>状態</dt>
                          <dd>{`${item.status} / ${item.runState}`}</dd>
                        </div>
                        <div>
                          <dt>updatedAt</dt>
                          <dd>{item.updatedAt}</dd>
                        </div>
                      </dl>
                      <div className="settings-memory-block">
                        <span>Goal</span>
                        <p>{item.memory.goal || "未設定"}</p>
                      </div>
                      <SettingsMemoryListBlock title="Decisions" items={item.memory.decisions} />
                      <SettingsMemoryListBlock title="Open Questions" items={item.memory.openQuestions} />
                      <SettingsMemoryListBlock title="Next Actions" items={item.memory.nextActions} />
                      <SettingsMemoryListBlock title="Notes" items={item.memory.notes} />
                    </article>
                  );
                })}
              </div>
            ) : (
              <article className="empty-list-card compact">
                <p>{loading ? "Session Memory を読み込み中..." : "一致する Session Memory はないよ。"}</p>
              </article>
            )}
            </section>
          ) : null}

          {showProjectDomain ? (
            <section className="settings-memory-domain">
            <div className="settings-memory-domain-head">
              <h3>Project Memory</h3>
              <span>{projectEntryCount}</span>
            </div>
            {filteredSnapshot && filteredSnapshot.projectMemories.length > 0 ? (
              <div className="settings-memory-group-list">
                {filteredSnapshot.projectMemories.map((group) => (
                  <article key={group.scope.id} className="settings-memory-group-card">
                    <div className="settings-memory-card-copy">
                      <strong>{group.scope.displayName || group.scope.projectKey}</strong>
                      <span>{`${group.scope.projectType} / ${group.scope.workspacePath}`}</span>
                    </div>
                    <div className="settings-memory-card-list">
                      {group.entries.map((entry) => {
                        const targetKey = `project:${entry.id}`;
                        const deleting = busyTarget === targetKey;
                        return (
                          <article key={entry.id} className="settings-memory-card compact">
                            <div className="settings-memory-card-head">
                              <div className="settings-memory-card-copy">
                                <strong>{entry.title}</strong>
                                <span>{entry.category}</span>
                              </div>
                              <button
                                className="danger-button"
                                type="button"
                                disabled={loading || deleting}
                                onClick={() => onDeleteProjectMemoryEntry(entry.id)}
                              >
                                {deleting ? "削除中..." : "Delete"}
                              </button>
                            </div>
                            <p className="settings-memory-detail">{entry.detail || "detail なし"}</p>
                            <SettingsMemoryTagLine label="Keywords" items={entry.keywords} />
                            <SettingsMemoryTagLine label="Evidence" items={entry.evidence} />
                          </article>
                        );
                      })}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <article className="empty-list-card compact">
                <p>{loading ? "Project Memory を読み込み中..." : "一致する Project Memory はないよ。"}</p>
              </article>
            )}
            </section>
          ) : null}

          {showCharacterDomain ? (
            <section className="settings-memory-domain">
            <div className="settings-memory-domain-head">
              <h3>Character Memory</h3>
              <span>{characterEntryCount}</span>
            </div>
            {filteredSnapshot && filteredSnapshot.characterMemories.length > 0 ? (
              <div className="settings-memory-group-list">
                {filteredSnapshot.characterMemories.map((group) => (
                  <article key={group.scope.id} className="settings-memory-group-card">
                    <div className="settings-memory-card-copy">
                      <strong>{group.scope.displayName || group.scope.characterId}</strong>
                      <span>{group.scope.characterId}</span>
                    </div>
                    <div className="settings-memory-card-list">
                      {group.entries.map((entry) => {
                        const targetKey = `character:${entry.id}`;
                        const deleting = busyTarget === targetKey;
                        return (
                          <article key={entry.id} className="settings-memory-card compact">
                            <div className="settings-memory-card-head">
                              <div className="settings-memory-card-copy">
                                <strong>{entry.title}</strong>
                                <span>{entry.category}</span>
                              </div>
                              <button
                                className="danger-button"
                                type="button"
                                disabled={loading || deleting}
                                onClick={() => onDeleteCharacterMemoryEntry(entry.id)}
                              >
                                {deleting ? "削除中..." : "Delete"}
                              </button>
                            </div>
                            <p className="settings-memory-detail">{entry.detail || "detail なし"}</p>
                            <SettingsMemoryTagLine label="Keywords" items={entry.keywords} />
                            <SettingsMemoryTagLine label="Evidence" items={entry.evidence} />
                          </article>
                        );
                      })}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <article className="empty-list-card compact">
                <p>{loading ? "Character Memory を読み込み中..." : "一致する Character Memory はないよ。"}</p>
              </article>
            )}
            </section>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function SettingsMemoryListBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="settings-memory-block">
      <span>{title}</span>
      {items.length > 0 ? (
        <ul className="settings-memory-list">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p>なし</p>
      )}
    </div>
  );
}

function SettingsMemoryTagLine({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="settings-memory-tags">
      <span>{label}</span>
      <p>{items.length > 0 ? items.join(", ") : "-"}</p>
    </div>
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
    <div className="launch-modal" role="dialog" aria-modal="true" onClick={onClose}>
      <section
        ref={dialogRef}
        className="launch-dialog panel"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
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

          <section className="launch-section minimal">
            <div className="launch-field">
              <label className="launch-field-label" htmlFor="launch-provider-picker">
                Coding Provider
              </label>
              {enabledLaunchProviders.length > 0 ? (
                <div
                  id="launch-provider-picker"
                  className="choice-list launch-provider-list"
                  role="listbox"
                  aria-label="Coding Provider"
                  aria-orientation="horizontal"
                  onKeyDown={(event) => {
                    focusRovingItemByKey(event, { orientation: "horizontal", activateOnFocus: true });
                  }}
                >
                  {enabledLaunchProviders.map((provider) => (
                    <button
                      key={provider.id}
                      className={`choice-chip${provider.id === selectedLaunchProviderId ? " active" : ""}`}
                      type="button"
                      role="option"
                      aria-selected={provider.id === selectedLaunchProviderId}
                      tabIndex={provider.id === selectedLaunchProviderId ? 0 : -1}
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
  filteredSessionEntries: Array<{ session: SessionSummary; state: HomeSessionState }>;
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
  onOpenMemoryManagementWindow: () => void;
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
  onOpenMemoryManagementWindow,
  onOpenSettingsWindow,
  onChangeCharacterSearchText,
  onOpenCharacterEditor,
  onOpenSession,
}: HomeRightPaneProps) {
  return (
    <section className="panel home-right-pane rise-3">
      <div className="home-settings-rail">
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
          <button className="launch-toggle home-settings-button" type="button" onClick={onOpenMemoryManagementWindow}>
            Memory
          </button>
          <button className="launch-toggle home-settings-button" type="button" onClick={onOpenSettingsWindow}>
            Settings
          </button>
        </div>
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
