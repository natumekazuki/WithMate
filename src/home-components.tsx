import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type {
  AppSettings,
  CharacterReflectionProviderSettings,
  MemoryExtractionProviderSettings,
  SessionSummary,
} from "./app-state.js";
import type { MateEmbeddingSettings } from "./mate-embedding-settings.js";
import type { CompanionSessionSummary } from "./companion-state.js";
import {
  DEFAULT_MATE_GROWTH_APPLY_INTERVAL_MINUTES,
  type MateGrowthCandidateMode,
  type MateGrowthSettings,
} from "./mate-state.js";
import type {
  MemoryManagementDomain,
  MemoryManagementDomainPageInfo,
  MemoryManagementSnapshot,
} from "./memory-management-state.js";
import {
  buildFilteredMemoryManagementSnapshot,
  DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS,
  type CharacterMemoryCategoryFilter,
  type MemoryManagementDomainFilter,
  type MemoryManagementSort,
  type MemoryManagementViewFilters,
  type ProjectMemoryCategoryFilter,
  type SessionMemoryStatusFilter,
} from "./memory-management-view.js";
import type { HomeProviderSettingRow } from "./home-settings-view-model.js";
import type { LaunchWorkspace } from "./home-launch-projection.js";
import { getHomeCompanionSessionState, type HomeMonitorEntry, type HomeSessionState } from "./home-session-projection.js";
import {
  SETTINGS_SKILL_ROOT_LABEL,
  SETTINGS_SKILL_ROOT_PLACEHOLDER,
  SETTINGS_PROVIDER_INSTRUCTION_WRITE_MODE_LABEL,
  SETTINGS_PROVIDER_INSTRUCTION_FAIL_POLICY_LABEL,
  SETTINGS_PROVIDER_INSTRUCTION_ROOT_DIRECTORY_LABEL,
  SETTINGS_PROVIDER_INSTRUCTION_ROOT_DIRECTORY_PLACEHOLDER,
  SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_LABEL,
  SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_PLACEHOLDER,
  SETTINGS_PROVIDER_INSTRUCTION_SECTION_LABEL,
  SETTINGS_CHARACTER_REFLECTION_CHAR_DELTA_LABEL,
  SETTINGS_CHARACTER_REFLECTION_COOLDOWN_LABEL,
  SETTINGS_CHARACTER_REFLECTION_MESSAGE_DELTA_LABEL,
  SETTINGS_CHARACTER_REFLECTION_MODEL_LABEL,
  SETTINGS_CHARACTER_REFLECTION_REASONING_LABEL,
  SETTINGS_CHARACTER_REFLECTION_TIMEOUT_LABEL,
  SETTINGS_ACTION_DOCK_AUTO_CLOSE_LABEL,
  SETTINGS_MEMORY_GENERATION_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_MODEL_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_REASONING_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_TIMEOUT_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_TRIGGER_INTERVAL_LABEL,
  SETTINGS_MEMORY_EXTRACTION_MODEL_LABEL,
  SETTINGS_MEMORY_EXTRACTION_REASONING_LABEL,
  SETTINGS_MEMORY_EXTRACTION_TIMEOUT_LABEL,
  SETTINGS_MEMORY_EXTRACTION_THRESHOLD_LABEL,
  SETTINGS_MATE_EMBEDDING_CACHE_STATE_LABEL,
  SETTINGS_MATE_EMBEDDING_DIMENSION_LABEL,
  SETTINGS_MATE_EMBEDDING_DOWNLOAD_LABEL,
  SETTINGS_MATE_EMBEDDING_LABEL,
  SETTINGS_MATE_EMBEDDING_MODEL_LABEL,
  SETTINGS_MATE_GROWTH_APPLY_INTERVAL_MINUTES_LABEL,
  SETTINGS_MATE_GROWTH_AUTO_APPLY_ENABLED_LABEL,
  SETTINGS_MATE_GROWTH_ENABLED_LABEL,
  SETTINGS_MATE_GROWTH_EVERY_TURN_LABEL,
  SETTINGS_MATE_GROWTH_MANUAL_LABEL,
  SETTINGS_MATE_GROWTH_MEMORY_CANDIDATE_MODE_LABEL,
  SETTINGS_MATE_GROWTH_SETTINGS_LABEL,
  SETTINGS_MATE_GROWTH_THRESHOLD_LABEL,
  SETTINGS_MATE_GROWTH_HELP,
  SETTINGS_MATE_GROWTH_LABEL,
  SETTINGS_MATE_RESET_HELP,
  SETTINGS_MATE_RESET_LABEL,
  SETTINGS_DIAGNOSTICS_LABEL,
  SETTINGS_OPEN_LOG_FOLDER_LABEL,
  SETTINGS_OPEN_CRASH_DUMP_FOLDER_LABEL,
} from "./settings-ui.js";
import { focusRovingItemByKey, useDialogA11y } from "./a11y.js";
import { buildCardThemeStyle, CharacterAvatar } from "./ui-utils.js";
import { formatTimestampLabel } from "./time-state.js";
import type { MateProfile } from "./mate-state.js";

export type HomeSettingsContentProps = {
  settingsDraft: AppSettings;
  providerSettingRows: HomeProviderSettingRow[];
  modelCatalogRevisionLabel: string;
  settingsDirty: boolean;
  settingsFeedback: string;
  memoryManagementSnapshot: MemoryManagementSnapshot | null;
  memoryManagementPages: {
    session: MemoryManagementDomainPageInfo;
    project: MemoryManagementDomainPageInfo;
    character: MemoryManagementDomainPageInfo;
    mate_profile: MemoryManagementDomainPageInfo;
  };
  memoryManagementLoading: boolean;
  memoryManagementBusyTarget: string | null;
  memoryManagementFeedback: string;
  mateGrowthSettings: MateGrowthSettings | null;
  mateGrowthFeedback: string;
  mateGrowthBusy: boolean;
  mateEmbeddingSettings: MateEmbeddingSettings | null;
  mateEmbeddingFeedback: string;
  mateEmbeddingBusy: boolean;
  memoryManagementOnly?: boolean;
  onChangeSystemPromptPrefix: (value: string) => void;
  onChangeMemoryGenerationEnabled: (enabled: boolean) => void;
  onChangeMateMemoryGenerationPriorityProvider: (providerId: string) => void;
  onChangeMateMemoryGenerationPriorityModel: (providerId: string, model: string) => void;
  onChangeMateMemoryGenerationPriorityReasoningEffort: (
    reasoningEffort: AppSettings["mateMemoryGenerationSettings"]["priorityList"][number]["reasoningEffort"],
  ) => void;
  onChangeMateMemoryGenerationPriorityTimeoutSeconds: (value: string) => void;
  onChangeMateMemoryGenerationTriggerIntervalMinutes: (value: string) => void;
  onChangeAutoCollapseActionDockOnSend: (enabled: boolean) => void;
  onChangeProviderEnabled: (providerId: string, enabled: boolean) => void;
  onChangeProviderInstructionEnabled: (providerId: string, enabled: boolean) => void;
  onChangeProviderInstructionWriteMode: (providerId: string, value: string) => void;
  onChangeProviderInstructionFailPolicy: (providerId: string, value: string) => void;
  onChangeProviderInstructionRootDirectory: (providerId: string, rootDirectory: string) => void;
  onChangeProviderInstructionInstructionRelativePath: (providerId: string, instructionRelativePath: string) => void;
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
  onChangeMemoryManagementViewFilters: (filters: MemoryManagementViewFilters) => void;
  onLoadMoreMemoryManagement: (domain: MemoryManagementDomain) => void;
  onDeleteSessionMemory: (sessionId: string) => void;
  onDeleteProjectMemoryEntry: (entryId: string) => void;
  onDeleteCharacterMemoryEntry: (entryId: string) => void;
  onDeleteMateProfileItem: (itemId: string) => void;
  onStartMateEmbeddingDownload: () => void;
  onApplyPendingGrowth?: () => void;
  applyPendingGrowthBusy?: boolean;
  canApplyPendingGrowth?: boolean;
  onUpdateMateGrowthSettings: (input: {
    enabled?: boolean;
    autoApplyEnabled?: boolean;
    memoryCandidateMode?: MateGrowthCandidateMode;
    applyIntervalMinutes?: number;
  }) => void;
  onResetMate?: () => void;
  mateResetBusy?: boolean;
  canResetMate?: boolean;
  onSaveSettings: () => void;
};

const PROVIDER_INSTRUCTION_SYNC_STATE_LABEL: Record<HomeProviderSettingRow["instructionTarget"]["lastSyncState"], string> = {
  never: "未実行",
  stale: "更新あり",
  redaction_required: "要再編集",
  synced: "同期済み",
  skipped: "スキップ",
  failed: "失敗",
};

const MAX_PROVIDER_INSTRUCTION_ERROR_PREVIEW_LENGTH = 96;

const normalizeProviderInstructionErrorPreview = (errorPreview: string): string => {
  const trimmed = errorPreview.trim();
  if (trimmed.length <= MAX_PROVIDER_INSTRUCTION_ERROR_PREVIEW_LENGTH) {
    return trimmed;
  }

  return `${trimmed.slice(0, MAX_PROVIDER_INSTRUCTION_ERROR_PREVIEW_LENGTH - 3)}...`;
};

export function HomeSettingsContent({
  settingsDraft,
  providerSettingRows,
  modelCatalogRevisionLabel,
  settingsDirty,
  settingsFeedback,
  memoryManagementSnapshot,
  memoryManagementPages,
  memoryManagementLoading,
  memoryManagementBusyTarget,
  memoryManagementFeedback,
  mateGrowthSettings,
  mateGrowthFeedback,
  mateGrowthBusy = false,
  mateEmbeddingSettings,
  mateEmbeddingFeedback,
  mateEmbeddingBusy,
  memoryManagementOnly = false,
  onChangeSystemPromptPrefix,
  onChangeMemoryGenerationEnabled,
  onChangeMateMemoryGenerationPriorityProvider,
  onChangeMateMemoryGenerationPriorityModel,
  onChangeMateMemoryGenerationPriorityReasoningEffort,
  onChangeMateMemoryGenerationPriorityTimeoutSeconds,
  onChangeMateMemoryGenerationTriggerIntervalMinutes,
  onChangeAutoCollapseActionDockOnSend,
  onChangeProviderEnabled,
  onChangeProviderInstructionEnabled,
  onChangeProviderInstructionWriteMode,
  onChangeProviderInstructionFailPolicy,
  onChangeProviderInstructionRootDirectory,
  onChangeProviderInstructionInstructionRelativePath,
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
  onChangeMemoryManagementViewFilters,
  onLoadMoreMemoryManagement,
  onDeleteSessionMemory,
  onDeleteProjectMemoryEntry,
  onDeleteCharacterMemoryEntry,
  onDeleteMateProfileItem,
  onStartMateEmbeddingDownload,
  onApplyPendingGrowth,
  applyPendingGrowthBusy = false,
  canApplyPendingGrowth = false,
  onUpdateMateGrowthSettings,
  onResetMate,
  mateResetBusy = false,
  canResetMate = false,
  onSaveSettings,
}: HomeSettingsContentProps) {
  if (memoryManagementOnly) {
    return (
      <div className="settings-panel settings-panel-memory-only">
        <div className="settings-panel-memory-scroll">
          <SettingsMemoryManagementSection
            snapshot={memoryManagementSnapshot}
            pages={memoryManagementPages}
            loading={memoryManagementLoading}
            busyTarget={memoryManagementBusyTarget}
            feedback={memoryManagementFeedback}
            onReload={onReloadMemoryManagement}
            onChangeViewFilters={onChangeMemoryManagementViewFilters}
            onLoadMore={onLoadMoreMemoryManagement}
            onDeleteSessionMemory={onDeleteSessionMemory}
            onDeleteProjectMemoryEntry={onDeleteProjectMemoryEntry}
            onDeleteCharacterMemoryEntry={onDeleteCharacterMemoryEntry}
            onDeleteMateProfileItem={onDeleteMateProfileItem}
            standalone
          />
        </div>
      </div>
    );
  }
  const mateMemoryGenerationPriority = settingsDraft.mateMemoryGenerationSettings.priorityList[0] ?? null;
  const mateMemoryGenerationProvider = providerSettingRows.find(
    ({ provider }) => provider.id === (mateMemoryGenerationPriority?.provider ?? ""),
  ) ?? providerSettingRows[0] ?? null;
  const mateMemoryGenerationModel = mateMemoryGenerationProvider
    ? mateMemoryGenerationProvider.provider.models.find((model) => model.id === mateMemoryGenerationPriority?.model) ??
      mateMemoryGenerationProvider.provider.models.find((model) => model.id === mateMemoryGenerationProvider.provider.defaultModelId) ??
      null
    : null;
  const mateMemoryGenerationReasoningEfforts = mateMemoryGenerationModel?.reasoningEfforts ??
    [mateMemoryGenerationProvider?.provider.defaultReasoningEffort].filter((reasoningEffort) => typeof reasoningEffort === "string");
  const mateMemoryGenerationProviderId = mateMemoryGenerationProvider?.provider.id ?? "";
  const mateMemoryGenerationModelId = mateMemoryGenerationModel?.id ??
    mateMemoryGenerationPriority?.model ??
    mateMemoryGenerationProvider?.provider.defaultModelId ??
    "";
  const mateMemoryGenerationReasoningEffort =
    mateMemoryGenerationPriority?.reasoningEffort ??
    mateMemoryGenerationModel?.reasoningEfforts[0] ??
    "high";
  const isMateGrowthUnavailable = mateGrowthBusy || mateGrowthSettings === null;
  const isMateGrowthFeatureDisabled = mateGrowthSettings?.enabled === false;
  const isMateGrowthControlDisabled = isMateGrowthUnavailable || isMateGrowthFeatureDisabled;

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
                  <strong>{SETTINGS_PROVIDER_INSTRUCTION_SECTION_LABEL}</strong>
                  <div className="settings-provider-list">
                    {providerSettingRows.map(({ provider, instructionTarget }) => (
                      <section key={`provider-instruction-${provider.id}`} className="settings-provider-card">
                        <label className="settings-provider-toggle-row">
                          <span className="settings-provider-name">{provider.label}</span>
                          <input
                            type="checkbox"
                            checked={instructionTarget.enabled}
                            onChange={(event) => onChangeProviderInstructionEnabled(provider.id, event.target.checked)}
                          />
                        </label>
                        <label className="settings-provider-input">
                          <span>{SETTINGS_PROVIDER_INSTRUCTION_WRITE_MODE_LABEL}</span>
                          <select
                            value={instructionTarget.writeMode}
                            onChange={(event) =>
                              onChangeProviderInstructionWriteMode(provider.id, event.target.value)}
                          >
                            <option value="managed_block">managed_block</option>
                            <option value="managed_file">managed_file</option>
                          </select>
                        </label>
                        <label className="settings-provider-input">
                          <span>{SETTINGS_PROVIDER_INSTRUCTION_FAIL_POLICY_LABEL}</span>
                          <select
                            value={instructionTarget.failPolicy}
                            onChange={(event) =>
                              onChangeProviderInstructionFailPolicy(provider.id, event.target.value)}
                          >
                            <option value="warn_continue">warn_continue</option>
                            <option value="block_session">block_session</option>
                          </select>
                        </label>
                        <label className="settings-provider-input">
                          <span>{SETTINGS_PROVIDER_INSTRUCTION_ROOT_DIRECTORY_LABEL}</span>
                          <input
                            type="text"
                            value={instructionTarget.rootDirectory}
                            onChange={(event) =>
                              onChangeProviderInstructionRootDirectory(provider.id, event.target.value)}
                            placeholder={SETTINGS_PROVIDER_INSTRUCTION_ROOT_DIRECTORY_PLACEHOLDER}
                            autoComplete="off"
                            spellCheck={false}
                          />
                        </label>
                        <label className="settings-provider-input">
                          <span>{SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_LABEL}</span>
                          <input
                            type="text"
                            value={instructionTarget.instructionRelativePath}
                            onChange={(event) =>
                              onChangeProviderInstructionInstructionRelativePath(provider.id, event.target.value)}
                            placeholder={SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_PLACEHOLDER}
                            autoComplete="off"
                            spellCheck={false}
                          />
                        </label>
                        <dl className="settings-memory-meta">
                          <div>
                            <dt>同期状態</dt>
                            <dd>{PROVIDER_INSTRUCTION_SYNC_STATE_LABEL[instructionTarget.lastSyncState]}</dd>
                          </div>
                          {instructionTarget.lastSyncedAt ? (
                            <div>
                              <dt>最終同期</dt>
                              <dd>{formatTimestampLabel(instructionTarget.lastSyncedAt)}</dd>
                            </div>
                          ) : null}
                        </dl>
                        {instructionTarget.requiresRestart ? <p className="settings-feedback settings-memory-feedback">再起動が必要</p> : null}
                        {instructionTarget.lastErrorPreview.trim() ? (
                          <div className="settings-memory-block">
                            <span>エラープレビュー</span>
                            <p>{normalizeProviderInstructionErrorPreview(instructionTarget.lastErrorPreview)}</p>
                          </div>
                        ) : null}
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

            </>
          ) : null}

          <SettingsMateEmbeddingSection
            settings={mateEmbeddingSettings}
            feedback={mateEmbeddingFeedback}
            busy={mateEmbeddingBusy}
            onDownload={onStartMateEmbeddingDownload}
          />

          <section className="settings-section-card">
            <div className="settings-field">
              <strong>{SETTINGS_MATE_MEMORY_GENERATION_LABEL}</strong>
              <div className="settings-provider-list">
                <section className="settings-provider-card">
                  <label className="settings-provider-input">
                    <span>Priority 1</span>
                    <select
                      value={mateMemoryGenerationProviderId}
                      onChange={(event) => onChangeMateMemoryGenerationPriorityProvider(event.target.value)}
                    >
                      {providerSettingRows.map(({ provider }) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="settings-provider-input">
                    <span>{SETTINGS_MATE_MEMORY_GENERATION_MODEL_LABEL}</span>
                    <select
                      value={mateMemoryGenerationModelId}
                      onChange={(event) =>
                        onChangeMateMemoryGenerationPriorityModel(mateMemoryGenerationProviderId, event.target.value)}
                    >
                      {mateMemoryGenerationProvider?.provider.models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="settings-provider-input">
                    <span>{SETTINGS_MATE_MEMORY_GENERATION_REASONING_LABEL}</span>
                    <select
                      value={mateMemoryGenerationReasoningEffort}
                      onChange={(event) =>
                        onChangeMateMemoryGenerationPriorityReasoningEffort(
                          event.target.value as AppSettings["mateMemoryGenerationSettings"]["priorityList"][number]["reasoningEffort"],
                        )}
                    >
                      {mateMemoryGenerationReasoningEfforts.map((reasoningEffort) => (
                        <option key={reasoningEffort} value={reasoningEffort}>
                          {reasoningEffort}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="settings-provider-input">
                    <span>{SETTINGS_MATE_MEMORY_GENERATION_TIMEOUT_LABEL}</span>
                    <input
                      type="number"
                      min={1}
                      value={mateMemoryGenerationPriority?.timeoutSeconds ?? 30}
                      onChange={(event) => onChangeMateMemoryGenerationPriorityTimeoutSeconds(event.target.value)}
                    />
                  </label>
                  <label className="settings-provider-input">
                    <span>{SETTINGS_MATE_MEMORY_GENERATION_TRIGGER_INTERVAL_LABEL}</span>
                    <input
                      type="number"
                      min={1}
                      value={settingsDraft.mateMemoryGenerationSettings.triggerIntervalMinutes}
                      onChange={(event) => onChangeMateMemoryGenerationTriggerIntervalMinutes(event.target.value)}
                    />
                  </label>
                </section>
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

          {onApplyPendingGrowth ? (
            <section className="settings-section-card">
              <div className="settings-field">
                <strong>{SETTINGS_MATE_GROWTH_LABEL}</strong>
                <p className="settings-help">{SETTINGS_MATE_GROWTH_HELP}</p>
                <div className="settings-actions">
                  <button
                    className="launch-toggle"
                    type="button"
                    onClick={onApplyPendingGrowth}
                    disabled={isMateGrowthControlDisabled || applyPendingGrowthBusy || !canApplyPendingGrowth}
                  >
                    {applyPendingGrowthBusy ? "適用中..." : SETTINGS_MATE_GROWTH_LABEL}
                  </button>
                </div>
              </div>
            </section>
          ) : null}

          <section className="settings-section-card">
            <div className="settings-field">
              <strong>{SETTINGS_MATE_GROWTH_SETTINGS_LABEL}</strong>
              <label className="settings-provider-toggle-row settings-section-toggle">
                <span>{SETTINGS_MATE_GROWTH_ENABLED_LABEL}</span>
                <input
                  id="mate-growth-enabled"
                  type="checkbox"
                  checked={mateGrowthSettings?.enabled ?? false}
                  disabled={isMateGrowthUnavailable}
                  onChange={(event) => onUpdateMateGrowthSettings({
                    enabled: event.target.checked,
                  })}
                />
              </label>
              <label className="settings-provider-toggle-row settings-section-toggle">
                <span>{SETTINGS_MATE_GROWTH_AUTO_APPLY_ENABLED_LABEL}</span>
                <input
                  id="mate-growth-auto-apply-enabled"
                  type="checkbox"
                  checked={mateGrowthSettings?.autoApplyEnabled ?? false}
                  disabled={isMateGrowthControlDisabled}
                  onChange={(event) => onUpdateMateGrowthSettings({
                    autoApplyEnabled: event.target.checked,
                  })}
                />
              </label>
              <label className="settings-provider-input">
                <span>{SETTINGS_MATE_GROWTH_MEMORY_CANDIDATE_MODE_LABEL}</span>
                <select
                  id="mate-growth-memory-candidate-mode"
                  value={mateGrowthSettings?.memoryCandidateMode ?? "every_turn"}
                  disabled={isMateGrowthControlDisabled}
                  onChange={(event) => onUpdateMateGrowthSettings({
                    memoryCandidateMode: event.target.value as "every_turn" | "threshold" | "manual",
                  })}
                >
                  <option value="every_turn">{SETTINGS_MATE_GROWTH_EVERY_TURN_LABEL}</option>
                  <option value="threshold">{SETTINGS_MATE_GROWTH_THRESHOLD_LABEL}</option>
                  <option value="manual">{SETTINGS_MATE_GROWTH_MANUAL_LABEL}</option>
                </select>
              </label>
              <label className="settings-provider-input">
                <span>{SETTINGS_MATE_GROWTH_APPLY_INTERVAL_MINUTES_LABEL}</span>
                <input
                  id="mate-growth-apply-interval-minutes"
                  type="number"
                  min={1}
                  value={mateGrowthSettings?.applyIntervalMinutes ?? DEFAULT_MATE_GROWTH_APPLY_INTERVAL_MINUTES}
                  disabled={isMateGrowthControlDisabled}
                  onChange={(event) => {
                    if (event.target.value.trim() === "") {
                      return;
                    }
                    const nextApplyIntervalMinutes = Number(event.target.value);
                    if (Number.isNaN(nextApplyIntervalMinutes)) {
                      return;
                    }
                    onUpdateMateGrowthSettings({ applyIntervalMinutes: nextApplyIntervalMinutes });
                  }}
                />
              </label>
              {mateGrowthFeedback ? <p className="settings-feedback">{mateGrowthFeedback}</p> : null}
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

type SettingsMateEmbeddingSectionProps = {
  settings: MateEmbeddingSettings | null;
  feedback: string;
  busy: boolean;
  onDownload: () => void;
};

const MATE_EMBEDDING_CACHE_STATE_LABELS: Record<MateEmbeddingSettings["cacheState"], string> = {
  missing: "未取得",
  downloading: "取得中",
  ready: "準備済み",
  failed: "失敗",
  stale: "更新あり",
};

const MATE_EMBEDDING_LAST_STATUS_LABELS: Record<MateEmbeddingSettings["lastStatus"], string> = {
  unknown: "不明",
  available: "利用可",
  unavailable: "利用不可",
  failed: "失敗",
};

const formatCacheSizeLabel = (cacheSizeBytes: number): string => {
  if (!Number.isFinite(cacheSizeBytes) || cacheSizeBytes < 0) {
    return "-";
  }
  if (cacheSizeBytes < 1024) {
    return `${cacheSizeBytes} B`;
  }
  if (cacheSizeBytes < 1024 ** 2) {
    return `${(cacheSizeBytes / 1024).toFixed(1)} KB`;
  }
  if (cacheSizeBytes < 1024 ** 3) {
    return `${(cacheSizeBytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(cacheSizeBytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
};

function SettingsMateEmbeddingSection({
  settings,
  feedback,
  busy,
  onDownload,
}: SettingsMateEmbeddingSectionProps) {
  const disabled = !settings || busy || settings.cacheState === "downloading";
  return (
    <section className="settings-section-card">
      <div className="settings-field">
        <strong>{SETTINGS_MATE_EMBEDDING_LABEL}</strong>
        {settings ? (
          <>
            <dl className="settings-memory-meta">
              <div>
                <dt>{SETTINGS_MATE_EMBEDDING_MODEL_LABEL}</dt>
                <dd>{settings.sourceModelId}</dd>
              </div>
              <div>
                <dt>{SETTINGS_MATE_EMBEDDING_DIMENSION_LABEL}</dt>
                <dd>{settings.dimension}</dd>
              </div>
              <div>
                <dt>キャッシュサイズ</dt>
                <dd>{formatCacheSizeLabel(settings.cacheSizeBytes)}</dd>
              </div>
              <div>
                <dt>{SETTINGS_MATE_EMBEDDING_CACHE_STATE_LABEL}</dt>
                <dd>{MATE_EMBEDDING_CACHE_STATE_LABELS[settings.cacheState]}</dd>
              </div>
              <div>
                <dt>最終更新</dt>
                <dd>{settings.cacheUpdatedAt ? formatTimestampLabel(settings.cacheUpdatedAt) : "-"}</dd>
              </div>
              <div>
                <dt>最終確認</dt>
                <dd>{settings.lastVerifiedAt ? formatTimestampLabel(settings.lastVerifiedAt) : "-"}</dd>
              </div>
              <div>
                <dt>最終ステータス</dt>
                <dd>{MATE_EMBEDDING_LAST_STATUS_LABELS[settings.lastStatus]}</dd>
              </div>
            </dl>
            {settings.lastErrorPreview ? (
              <p className="settings-feedback settings-memory-feedback">{settings.lastErrorPreview}</p>
            ) : null}
          </>
        ) : (
          <p className="settings-help">Mate 作成後に使えるよ。</p>
        )}
        {feedback ? <p className="settings-feedback settings-memory-feedback">{feedback}</p> : null}
        <div className="settings-actions">
          <button className="launch-toggle" type="button" onClick={onDownload} disabled={disabled}>
            {busy ? "Downloading..." : SETTINGS_MATE_EMBEDDING_DOWNLOAD_LABEL}
          </button>
        </div>
      </div>
    </section>
  );
}

type SettingsMemoryManagementSectionProps = {
  snapshot: MemoryManagementSnapshot | null;
  pages: {
    session: MemoryManagementDomainPageInfo;
    project: MemoryManagementDomainPageInfo;
    character: MemoryManagementDomainPageInfo;
    mate_profile: MemoryManagementDomainPageInfo;
  };
  loading: boolean;
  busyTarget: string | null;
  feedback: string;
  standalone?: boolean;
  onReload: () => void;
  onChangeViewFilters: (filters: MemoryManagementViewFilters) => void;
  onLoadMore: (domain: MemoryManagementDomain) => void;
  onDeleteSessionMemory: (sessionId: string) => void;
  onDeleteProjectMemoryEntry: (entryId: string) => void;
  onDeleteCharacterMemoryEntry: (entryId: string) => void;
  onDeleteMateProfileItem: (itemId: string) => void;
};

const MEMORY_DOMAIN_OPTIONS: Array<{ value: MemoryManagementDomainFilter; label: string }> = [
  { value: "all", label: "All Domains" },
  { value: "session", label: "Session" },
  { value: "project", label: "Project" },
  { value: "character", label: "Character" },
  { value: "mate_profile", label: "Mate Profile" },
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
  pages,
  loading,
  busyTarget,
  feedback,
  standalone = false,
  onReload,
  onChangeViewFilters,
  onLoadMore,
  onDeleteSessionMemory,
  onDeleteProjectMemoryEntry,
  onDeleteCharacterMemoryEntry,
  onDeleteMateProfileItem,
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
  const activeFilters = useMemo<MemoryManagementViewFilters>(
    () => ({
      searchText,
      domain,
      sort,
      sessionStatus,
      projectCategory,
      characterCategory,
    }),
    [characterCategory, domain, projectCategory, searchText, sessionStatus, sort],
  );

  useEffect(() => {
    onChangeViewFilters(activeFilters);
  }, [activeFilters, onChangeViewFilters]);

  const filteredSnapshot = useMemo(
    () =>
      buildFilteredMemoryManagementSnapshot(snapshot, activeFilters),
    [activeFilters, snapshot],
  );
  const sessionCount = filteredSnapshot?.sessionMemories.length ?? 0;
  const projectEntryCount = filteredSnapshot?.projectMemories.reduce((count, group) => count + group.entries.length, 0) ?? 0;
  const characterEntryCount =
    filteredSnapshot?.characterMemories.reduce((count, group) => count + group.entries.length, 0) ?? 0;
  const mateProfileItemCount = filteredSnapshot?.mateProfileItems?.length ?? 0;
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
  const showMateProfileDomain = domain === "all" || domain === "mate_profile";

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
            {`Session ${sessionCount} / Project ${projectEntryCount} / Character ${characterEntryCount} / Mate Profile ${mateProfileItemCount}`}
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
                disabled={domain === "project" || domain === "character" || domain === "mate_profile"}
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
                disabled={domain === "session" || domain === "character" || domain === "mate_profile"}
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
                disabled={domain === "session" || domain === "project" || domain === "mate_profile"}
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
            {pages.session.hasMore ? (
              <button
                className="launch-toggle compact"
                type="button"
                disabled={loading}
                onClick={() => onLoadMore("session")}
              >
                {loading ? "追加読み込み中..." : `Load More (${pages.session.total - (pages.session.nextCursor ?? pages.session.total)} left)`}
              </button>
            ) : null}
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
            {pages.project.hasMore ? (
              <button
                className="launch-toggle compact"
                type="button"
                disabled={loading}
                onClick={() => onLoadMore("project")}
              >
                {loading ? "追加読み込み中..." : `Load More (${pages.project.total - (pages.project.nextCursor ?? pages.project.total)} left)`}
              </button>
            ) : null}
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
            {pages.character.hasMore ? (
              <button
                className="launch-toggle compact"
                type="button"
                disabled={loading}
                onClick={() => onLoadMore("character")}
              >
                {loading ? "追加読み込み中..." : `Load More (${pages.character.total - (pages.character.nextCursor ?? pages.character.total)} left)`}
              </button>
            ) : null}
            </section>
          ) : null}

          {showMateProfileDomain ? (
            <section className="settings-memory-domain">
            <div className="settings-memory-domain-head">
              <h3>Mate Profile</h3>
              <span>{mateProfileItemCount}</span>
            </div>
            {filteredSnapshot && (filteredSnapshot.mateProfileItems?.length ?? 0) > 0 ? (
              <div className="settings-memory-card-list">
                {(filteredSnapshot.mateProfileItems ?? []).map((item) => {
                  const targetKey = `mate_profile:${item.id}`;
                  const deleting = busyTarget === targetKey;
                  return (
                    <article key={item.id} className="settings-memory-card compact">
                      <div className="settings-memory-card-head">
                        <div className="settings-memory-card-copy">
                          <strong>{item.renderedText || item.claimValue || item.claimKey}</strong>
                          <span>{`${item.sectionKey} / ${item.category}`}</span>
                        </div>
                        <button
                          className="danger-button"
                          type="button"
                          disabled={loading || deleting}
                          onClick={() => onDeleteMateProfileItem(item.id)}
                        >
                          {deleting ? "忘却中..." : "Forget"}
                        </button>
                      </div>
                      <dl className="settings-memory-meta">
                        <div>
                          <dt>Claim</dt>
                          <dd>{item.claimKey}</dd>
                        </div>
                        <div>
                          <dt>状態</dt>
                          <dd>{`${item.state} / confidence ${item.confidence.toFixed(2)}`}</dd>
                        </div>
                        <div>
                          <dt>updatedAt</dt>
                          <dd>{item.updatedAt}</dd>
                        </div>
                      </dl>
                      <p className="settings-memory-detail">{item.claimValue || item.normalizedClaim || "value なし"}</p>
                      <SettingsMemoryTagLine label="Tags" items={item.tags} />
                    </article>
                  );
                })}
              </div>
            ) : (
              <article className="empty-list-card compact">
                <p>{loading ? "Mate Profile を読み込み中..." : "一致する Mate Profile はないよ。"}</p>
              </article>
            )}
            {pages.mate_profile.hasMore ? (
              <button
                className="launch-toggle compact"
                type="button"
                disabled={loading}
                onClick={() => onLoadMore("mate_profile")}
              >
                {loading ? "追加読み込み中..." : `Load More (${pages.mate_profile.total - (pages.mate_profile.nextCursor ?? pages.mate_profile.total)} left)`}
              </button>
            ) : null}
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
  mode: "session" | "companion";
  title: string;
  workspace: LaunchWorkspace | null;
  launchWorkspacePathLabel: string;
  enabledLaunchProviders: Array<{ id: string; label: string }>;
  selectedLaunchProviderId: string | null;
  canStartSession: boolean;
  launchFeedback: string;
  launchStarting: boolean;
  onClose: () => void;
  onSelectMode: (mode: "session" | "companion") => void;
  onChangeTitle: (value: string) => void;
  onBrowseWorkspace: () => void;
  onSelectProvider: (providerId: string) => void;
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
  canStartSession,
  launchFeedback,
  launchStarting,
  onClose,
  onSelectMode,
  onChangeTitle,
  onBrowseWorkspace,
  onSelectProvider,
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
        </div>

        <div className="launch-dialog-foot minimal">
          {launchFeedback ? <p className="launch-feedback">{launchFeedback}</p> : null}
          <button
            className="start-session-button"
            type="button"
            aria-disabled={!canStartSession || launchStarting}
            disabled={!canStartSession || launchStarting}
            onClick={() => onStartSession(mode)}
          >
            {launchStarting ? "Starting..." : mode === "companion" ? "Start Companion" : "Start New Session"}
          </button>
        </div>
      </section>
    </div>
  );
}

export type HomeRecentSessionsPanelProps = {
  filteredSessionEntries: Array<{ session: SessionSummary; state: HomeSessionState }>;
  companionSessions: CompanionSessionSummary[];
  normalizedSessionSearch: string;
  searchText: string;
  searchIcon: ReactNode;
  onChangeSearchText: (value: string) => void;
  onOpenLaunchDialog: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenCompanionReview: (sessionId: string) => void;
  canUsePrimaryFeatures?: boolean;
};

export type HomeMateSetupPanelProps = {
  displayName: string;
  creating: boolean;
  feedback: string;
  mateDisplayName: string | null;
  onChangeDisplayName: (value: string) => void;
  onSubmit: () => void;
  onOpenSettings: () => void;
};

export type HomeMateTalkPanelProps = {
  mateName: string;
  messages: Array<{ id: string; role: "user" | "mate"; text: string }>;
  input: string;
  onChangeInput: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  sending?: boolean;
  feedback: string;
};

export function HomeMateSetupPanel({
  displayName,
  creating,
  feedback,
  mateDisplayName,
  onChangeDisplayName,
  onSubmit,
  onOpenSettings,
}: HomeMateSetupPanelProps) {
  return (
    <section className="home-mate-setup-panel">
      <h2 className="home-mate-setup-head">Mate 作成</h2>
      <p className="home-mate-setup-description">
        Home を使う前に Mate を 1 つ作成してね。設定は利用できるよ。
      </p>
      <form
        className="home-mate-setup-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label className="settings-field" htmlFor="mate-display-name">
          <span>表示名</span>
          <input
            id="mate-display-name"
            type="text"
            value={displayName}
            onChange={(event) => onChangeDisplayName(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="あなたの Mate"
            disabled={creating}
          />
        </label>
        {mateDisplayName ? <p className="home-mate-current-name">現在の Mate: {mateDisplayName}</p> : null}
        {feedback ? <p className="settings-feedback home-mate-feedback">{feedback}</p> : null}
        <div className="home-mate-setup-actions">
          <button className="start-session-button" type="submit" disabled={creating}>
            {creating ? "作成中..." : "Mate を作成"}
          </button>
          <button className="launch-toggle" type="button" onClick={onOpenSettings}>
            設定
          </button>
        </div>
      </form>
    </section>
  );
}

export function HomeMateTalkPanel({
  mateName,
  messages,
  input,
  onChangeInput,
  onSubmit,
  onClose,
  sending = false,
  feedback,
}: HomeMateTalkPanelProps) {
  const isSubmitDisabled = sending || input.trim() === "";

  return (
    <section className="home-mate-talk-panel">
      <h2 className="home-mate-talk-head">メイトーク</h2>
      <p className="home-mate-talk-description">{mateName} と話す</p>

      <section className="home-mate-talk-messages" aria-label="メイトーク会話履歴">
        {messages.length > 0 ? (
          messages.map((message) => (
            <article
              key={message.id}
              className={`home-mate-talk-message ${message.role === "user" ? "home-mate-talk-message-user" : "home-mate-talk-message-mate"}`}
            >
              <p>
                <strong>{message.role === "user" ? "あなた" : mateName}:</strong>
                {` ${message.text}`}
              </p>
            </article>
          ))
        ) : (
          <p className="home-mate-talk-empty">まだ会話は開始してないよ。まずは入力してね。</p>
        )}
      </section>

      {feedback ? <p className="settings-feedback home-mate-feedback">{feedback}</p> : null}

      <form
        className="home-mate-talk-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label className="settings-field home-mate-talk-input-field" htmlFor="home-mate-talk-input">
          <span>入力</span>
          <textarea
            id="home-mate-talk-input"
            value={input}
            onChange={(event) => onChangeInput(event.target.value)}
            rows={4}
            disabled={sending}
            autoComplete="off"
            spellCheck={false}
            placeholder="今日はどうする？"
          />
        </label>
        <div className="launch-dialog-foot settings-dialog-foot">
          <button className="launch-toggle" type="button" onClick={onClose}>
            ホームに戻る
          </button>
          <button className="start-session-button" type="submit" disabled={isSubmitDisabled}>
            {sending ? "送信中..." : "送信"}
          </button>
        </div>
      </form>
    </section>
  );
}

export function HomeRecentSessionsPanel({
  filteredSessionEntries,
  companionSessions,
  normalizedSessionSearch,
  searchText,
  searchIcon,
  onChangeSearchText,
  onOpenLaunchDialog,
  onOpenSession,
  onOpenCompanionReview,
  canUsePrimaryFeatures = true,
}: HomeRecentSessionsPanelProps) {
  const openLaunchDialog = () => {
    if (!canUsePrimaryFeatures) {
      return;
    }
    onOpenLaunchDialog();
  };
  const openSession = (sessionId: string) => {
    if (!canUsePrimaryFeatures) {
      return;
    }
    onOpenSession(sessionId);
  };
  const openCompanionReview = (sessionId: string) => {
    if (!canUsePrimaryFeatures) {
      return;
    }
    onOpenCompanionReview(sessionId);
  };
  const visibleCompanionSessions = companionSessions.filter((session) => {
    if (!normalizedSessionSearch) {
      return true;
    }
    const haystack = [
      session.taskTitle,
      session.character,
      session.repoRoot,
      session.focusPath,
      session.targetBranch,
      session.status,
    ].join(" ").toLowerCase();
    return haystack.includes(normalizedSessionSearch);
  });
  const visibleSessionEntries = [
    ...filteredSessionEntries.map((entry) => ({
      kind: "agent" as const,
      updatedAt: entry.session.updatedAt,
      entry,
    })),
    ...visibleCompanionSessions.map((session) => ({
      kind: "companion" as const,
      updatedAt: session.updatedAt,
      session,
    })),
  ].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt);
    const rightTime = Date.parse(right.updatedAt);
    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  });
  const hasVisibleEntries = visibleSessionEntries.length > 0;

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
        <button
          className="start-session-button"
          type="button"
          onClick={openLaunchDialog}
          aria-disabled={!canUsePrimaryFeatures}
          disabled={!canUsePrimaryFeatures}
        >
          New Session
        </button>
      </div>

      <div className="session-card-list home-session-card-list">
        {visibleSessionEntries.map((item) => {
          if (item.kind === "companion") {
            const { session } = item;
            const companionState = getHomeCompanionSessionState(session);
            return (
              <button
                key={`companion-${session.id}`}
                className="session-card home-session-card"
                type="button"
                style={buildCardThemeStyle(session.characterThemeColors)}
                onClick={() => openCompanionReview(session.id)}
                aria-disabled={!canUsePrimaryFeatures}
                disabled={!canUsePrimaryFeatures}
              >
                <CharacterAvatar character={{ name: session.character, iconPath: session.characterIconPath }} size="small" className="session-card-avatar" />
                <div className="session-card-copy">
                  <div className="session-card-topline home-session-card-topline">
                    <strong>{session.taskTitle}</strong>
                    <div className="home-session-card-badges">
                      <span className="session-mode-badge companion">Companion</span>
                      <span className={`session-status home-session-status ${companionState.kind}`.trim()}>{companionState.label}</span>
                    </div>
                  </div>
                  <div className="session-card-subline home-session-card-meta">
                    <span>{`Workspace : ${session.focusPath || session.repoRoot}`}</span>
                    <span>{`updatedAt: ${session.updatedAt}`}</span>
                  </div>
                </div>
              </button>
            );
          }

          const { session, state } = item.entry;
          return (
            <button
              key={`agent-${session.id}`}
              className="session-card home-session-card"
              type="button"
              style={buildCardThemeStyle(session.characterThemeColors)}
              onClick={() => openSession(session.id)}
              aria-disabled={!canUsePrimaryFeatures}
              disabled={!canUsePrimaryFeatures}
            >
              <CharacterAvatar character={{ name: session.character, iconPath: session.characterIconPath }} size="small" className="session-card-avatar" />
              <div className="session-card-copy">
                <div className="session-card-topline home-session-card-topline">
                  <strong>{session.taskTitle}</strong>
                  <div className="home-session-card-badges">
                    <span className="session-mode-badge agent">Agent</span>
                    <span className={`session-status home-session-status ${state.kind}`.trim()}>{state.label}</span>
                  </div>
                </div>
                <div className="session-card-subline home-session-card-meta">
                  <span>{`Workspace : ${session.workspacePath || session.workspaceLabel}`}</span>
                  <span>{`updatedAt: ${session.updatedAt}`}</span>
                </div>
                {session.taskSummary.trim() ? <p className="session-card-summary home-session-card-summary">{session.taskSummary}</p> : null}
              </div>
            </button>
          );
        })}
        {!hasVisibleEntries ? (
          normalizedSessionSearch ? (
            <article className="empty-list-card">
              <p>一致するセッションはないよ。</p>
            </article>
          ) : (
            <article className="empty-list-card">
              <p>まだセッションはないよ。</p>
              <button
                className="start-session-button"
                type="button"
                onClick={openLaunchDialog}
                aria-disabled={!canUsePrimaryFeatures}
                disabled={!canUsePrimaryFeatures}
              >
                New Session
              </button>
            </article>
          )
        ) : null}
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
  onOpenCompanionReview: (sessionId: string) => void;
};

export function HomeMonitorContent({
  runningEntries,
  nonRunningEntries,
  runningEmptyMessage,
  completedEmptyMessage,
  onOpenSession,
  onOpenCompanionReview,
}: HomeMonitorContentProps) {
  const companionGroupMarkerClassName = (groupId: string): string => {
    let hash = 0;
    for (let index = 0; index < groupId.length; index += 1) {
      hash = (hash * 31 + groupId.charCodeAt(index)) >>> 0;
    }
    return `companion-group-${hash % 6}`;
  };

  const renderMonitorEntries = (entries: HomeMonitorEntry[]) => {
    return entries.map((entry) => {
      if (entry.kind === "companion") {
        const { session, state } = entry;
        const groupClassName = companionGroupMarkerClassName(session.groupId);
        return (
          <button
            key={`companion-${session.id}`}
            className={`home-monitor-row companion ${groupClassName}`}
            type="button"
            onClick={() => onOpenCompanionReview(session.id)}
          >
            <CharacterAvatar character={{ name: session.character, iconPath: session.characterIconPath }} size="tiny" />
            <div className="home-monitor-row-copy">
              <strong>{session.taskTitle}</strong>
              <span>{session.character}</span>
            </div>
            <div className="home-monitor-row-badges">
              <span className="session-mode-badge companion">Companion</span>
              <span className={`home-monitor-group-chip ${groupClassName}`} aria-label="同じ Companion group の目印" />
              <span className={`session-status home-monitor-status ${state.kind}`.trim()}>{state.label}</span>
            </div>
          </button>
        );
      }

      const { session, state } = entry;
      return (
        <button
          key={`agent-${session.id}`}
          className="home-monitor-row"
          type="button"
          onClick={() => onOpenSession(session.id)}
        >
          <CharacterAvatar character={{ name: session.character, iconPath: session.characterIconPath }} size="tiny" />
          <div className="home-monitor-row-copy">
            <strong>{session.taskTitle}</strong>
            <span>{session.workspaceLabel || session.workspacePath || "workspace 未設定"}</span>
          </div>
          <div className="home-monitor-row-badges">
            <span className="session-mode-badge agent">Agent</span>
            <span className={`session-status home-monitor-status ${state.kind}`.trim()}>{state.label}</span>
          </div>
        </button>
      );
    });
  };

  return (
    <div className="home-monitor-body">
      <section className="home-monitor-section" aria-labelledby="home-monitor-running">
        <div className="home-monitor-section-head">
          <h3 id="home-monitor-running">実行中</h3>
          <span className="home-monitor-count">{runningEntries.length}</span>
        </div>
        <div className="home-monitor-list">
          {runningEntries.length > 0 ? (
            renderMonitorEntries(runningEntries)
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
            renderMonitorEntries(nonRunningEntries)
          ) : (
            <p className="home-monitor-empty">{completedEmptyMessage}</p>
          )}
        </div>
      </section>
    </div>
  );
}

export type HomeRightPaneProps = {
  rightPaneView: "monitor" | "mate";
  runningMonitorEntries: HomeMonitorEntry[];
  nonRunningMonitorEntries: HomeMonitorEntry[];
  monitorRunningEmptyMessage: string;
  monitorCompletedEmptyMessage: string;
  monitorWindowIcon: ReactNode;
  mateProfile: MateProfile | null;
  onChangeRightPaneView: (view: "monitor" | "mate") => void;
  onOpenSessionMonitorWindow: () => void;
  onOpenMemoryManagementWindow: () => void;
  onOpenSettingsWindow: () => void;
  onOpenMateTalk: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenCompanionReview: (sessionId: string) => void;
  canUsePrimaryFeatures?: boolean;
};

export function HomeRightPane({
  rightPaneView,
  runningMonitorEntries,
  nonRunningMonitorEntries,
  monitorRunningEmptyMessage,
  monitorCompletedEmptyMessage,
  monitorWindowIcon,
  mateProfile,
  onChangeRightPaneView,
  onOpenSessionMonitorWindow,
  onOpenMemoryManagementWindow,
  onOpenSettingsWindow,
  onOpenMateTalk,
  onOpenSession,
  onOpenCompanionReview,
  canUsePrimaryFeatures = true,
}: HomeRightPaneProps) {
  const mateDisplayName = mateProfile?.displayName ?? "Your Mate";
  const mateDescription = mateProfile?.description?.trim() ?? "";
  const mateThemeStyle = buildCardThemeStyle({
    main: mateProfile?.themeMain ?? "#3e4b65",
    sub: mateProfile?.themeSub ?? "#7b8fb0",
  });
  const openSessionMonitorWindow = () => {
    if (!canUsePrimaryFeatures) {
      return;
    }
    onOpenSessionMonitorWindow();
  };
  const openMemoryManagementWindow = () => {
    if (!canUsePrimaryFeatures) {
      return;
    }
    onOpenMemoryManagementWindow();
  };
  const openMateTalk = () => {
    if (!canUsePrimaryFeatures) {
      return;
    }
    onOpenMateTalk();
  };
  const openSession = (sessionId: string) => {
    if (!canUsePrimaryFeatures) {
      return;
    }
    onOpenSession(sessionId);
  };
  const openCompanionReview = (sessionId: string) => {
    if (!canUsePrimaryFeatures) {
      return;
    }
    onOpenCompanionReview(sessionId);
  };

  return (
    <section className="panel home-right-pane rise-3">
      <div className="home-settings-rail">
        <div className="home-settings-actions">
          <button
            className="launch-toggle home-monitor-window-button"
            type="button"
            aria-label="Session Monitor Window を開く"
            title="Session Monitor Window"
            onClick={openSessionMonitorWindow}
            aria-disabled={!canUsePrimaryFeatures}
            disabled={!canUsePrimaryFeatures}
          >
            {monitorWindowIcon}
          </button>
          <button
            className="launch-toggle home-settings-button"
            type="button"
            onClick={openMemoryManagementWindow}
            aria-disabled={!canUsePrimaryFeatures}
            disabled={!canUsePrimaryFeatures}
          >
            Memory
          </button>
          <button className="launch-toggle home-settings-button" type="button" onClick={onOpenSettingsWindow}>
            Settings
          </button>
          <button
            className="launch-toggle home-settings-button"
            type="button"
            onClick={openMateTalk}
            aria-disabled={!canUsePrimaryFeatures}
            disabled={!canUsePrimaryFeatures}
          >
            メイトーク
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
            className={`home-pane-toggle-button ${rightPaneView === "mate" ? "active" : ""}`.trim()}
            type="button"
            role="tab"
            aria-selected={rightPaneView === "mate"}
            onClick={() => onChangeRightPaneView("mate")}
          >
            Your Mate
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
            onOpenSession={openSession}
            onOpenCompanionReview={openCompanionReview}
          />
        </section>
      ) : (
        <section className="home-monitor-panel" role="tabpanel" aria-label="Your Mate" style={mateThemeStyle}>
          <div className="home-monitor-section">
            <div className="home-monitor-section-head">
              <h3>Your Mate</h3>
              <span>{mateDisplayName}</span>
            </div>
            <div className="home-monitor-section">
              <CharacterAvatar
                character={{ name: mateDisplayName, iconPath: mateProfile?.avatarFilePath ?? "" }}
                size="large"
              />
              {mateDescription ? (
                <p>{mateDescription}</p>
              ) : (
                <p>Mate の説明は未設定だよ。</p>
              )}
            </div>
          </div>
        </section>
      )}
    </section>
  );
}
