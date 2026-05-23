import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  type AppSettings,
  type MemoryExtractionProviderSettings,
} from "../app-state.js";
import { MICROCOPY_SLOTS, type MicrocopySlot } from "../microcopy-state.js";
import type { MateEmbeddingSettings } from "../mate/mate-embedding-settings.js";
import {
  DEFAULT_MATE_GROWTH_APPLY_INTERVAL_MINUTES,
  type MateGrowthModelPreference,
  type MateGrowthSettings,
  type UpdateMateGrowthSettingsInput,
} from "../mate/mate-state.js";
import type { MateGrowthEventListItem } from "../mate/mate-growth-events-state.js";
import type {
  MemoryManagementDomain,
  MemoryManagementDomainPageInfo,
  MemoryManagementSnapshot,
} from "../memory/memory-management-state.js";
import {
  buildFilteredMemoryManagementSnapshot,
  DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS,
  type MemoryManagementDomainFilter,
  type MemoryManagementSort,
  type MemoryManagementViewFilters,
  type ProjectMemoryCategoryFilter,
  type SessionMemoryStatusFilter,
} from "../memory/memory-management-view.js";
import type { HomeProviderSettingRow } from "./settings-view-model.js";
import {
  SETTINGS_PROVIDER_INSTRUCTION_WRITE_MODE_LABEL,
  SETTINGS_PROVIDER_INSTRUCTION_FAIL_POLICY_LABEL,
  SETTINGS_PROVIDER_INSTRUCTION_ROOT_DIRECTORY_LABEL,
  SETTINGS_PROVIDER_INSTRUCTION_ROOT_DIRECTORY_PLACEHOLDER,
  SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_LABEL,
  SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_PLACEHOLDER,
  SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_LABEL,
  SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_PLACEHOLDER,
  SETTINGS_PROVIDER_INSTRUCTION_SECTION_LABEL,
  SETTINGS_PROVIDER_INSTRUCTION_FAIL_POLICY_HELP,
  SETTINGS_PROVIDER_INSTRUCTION_HELP_SUMMARY,
  SETTINGS_PROVIDER_INSTRUCTION_MANAGED_BLOCK_HELP,
  SETTINGS_PROVIDER_INSTRUCTION_MANAGED_FILE_HELP,
  SETTINGS_PROVIDER_INSTRUCTION_PATH_HELP,
  SETTINGS_ACTION_DOCK_AUTO_CLOSE_LABEL,
  SETTINGS_MEMORY_GENERATION_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_MODEL_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_PRIORITY_ADD_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_PRIORITY_REMOVE_LABEL,
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
  SETTINGS_MATE_GROWTH_MEMORY_CANDIDATE_MODE_LABEL,
  SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_DEPTH_LABEL,
  SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_ENABLED_LABEL,
  SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_MODEL_LABEL,
  SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_PROVIDER_LABEL,
  SETTINGS_MATE_GROWTH_MODEL_PREFERENCES_LABEL,
  SETTINGS_MATE_GROWTH_SETTINGS_LABEL,
  SETTINGS_MATE_GROWTH_HELP,
  SETTINGS_MATE_GROWTH_LABEL,
  SETTINGS_MATE_RESET_HELP,
  SETTINGS_MATE_RESET_LABEL,
  SETTINGS_DIAGNOSTICS_LABEL,
  SETTINGS_OPEN_LOG_FOLDER_LABEL,
  SETTINGS_OPEN_CRASH_DUMP_FOLDER_LABEL,
} from "./settings-ui.js";
import { formatTimestampLabel } from "../time-state.js";

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
    mate_profile: MemoryManagementDomainPageInfo;
  };
  memoryManagementLoading: boolean;
  memoryManagementBusyTarget: string | null;
  memoryManagementFeedback: string;
  mateGrowthSettings: MateGrowthSettings | null;
  mateGrowthFeedback: string;
  mateGrowthBusy: boolean;
  mateGrowthEvents: MateGrowthEventListItem[];
  mateGrowthEventsLoading: boolean;
  mateGrowthEventsFeedback: string;
  mateGrowthEventBusyTarget: string | null;
  mateEmbeddingSettings: MateEmbeddingSettings | null;
  mateEmbeddingFeedback: string;
  mateEmbeddingBusy: boolean;
  memoryManagementOnly?: boolean;
  onChangeMemoryGenerationEnabled: (enabled: boolean) => void;
  onChangeMateMemoryGenerationPriorityProvider: (index: number, providerId: string) => void;
  onChangeMateMemoryGenerationPriorityModel: (index: number, providerId: string, model: string) => void;
  onChangeMateMemoryGenerationPriorityReasoningEffort: (
    index: number,
    reasoningEffort: AppSettings["mateMemoryGenerationSettings"]["priorityList"][number]["reasoningEffort"],
  ) => void;
  onChangeMateMemoryGenerationPriorityTimeoutSeconds: (index: number, value: string) => void;
  onAddMateMemoryGenerationPriority: () => void;
  onRemoveMateMemoryGenerationPriority: (index: number) => void;
  onChangeMateMemoryGenerationTriggerIntervalMinutes: (value: string) => void;
  onChangeAutoCollapseActionDockOnSend: (enabled: boolean) => void;
  onChangeUserMicrocopySlot: (slot: MicrocopySlot, value: string) => void;
  onChangeProviderEnabled: (providerId: string, enabled: boolean) => void;
  onChangeProviderInstructionEnabled: (providerId: string, enabled: boolean) => void;
  onChangeProviderInstructionWriteMode: (providerId: string, value: string) => void;
  onChangeProviderInstructionFailPolicy: (providerId: string, value: string) => void;
  onChangeProviderInstructionInstructionRelativePath: (providerId: string, instructionRelativePath: string) => void;
  onBrowseProviderInstructionInstructionRelativePath: (providerId: string) => void;
  onChangeProviderSkillRootPath: (providerId: string, skillRootPath: string) => void;
  onBrowseProviderSkillRootPath: (providerId: string) => void;
  onChangeProviderSkillRelativePath: (providerId: string, skillRelativePath: string) => void;
  onBrowseProviderSkillRelativePath: (providerId: string) => void;
  onChangeMemoryExtractionModel: (providerId: string, model: string) => void;
  onChangeMemoryExtractionReasoningEffort: (
    providerId: string,
    reasoningEffort: MemoryExtractionProviderSettings["reasoningEffort"],
  ) => void;
  onChangeMemoryExtractionThreshold: (providerId: string, value: string) => void;
  onChangeMemoryExtractionTimeoutSeconds: (providerId: string, value: string) => void;
  onImportModelCatalog: () => void;
  onExportModelCatalog: () => void;
  onOpenAppLogFolder: () => void;
  onOpenCrashDumpFolder: () => void;
  onReloadMemoryManagement: () => void;
  onChangeMemoryManagementViewFilters: (filters: MemoryManagementViewFilters) => void;
  onLoadMoreMemoryManagement: (domain: MemoryManagementDomain) => void;
  onDeleteSessionMemory: (sessionId: string) => void;
  onDeleteProjectMemoryEntry: (entryId: string) => void;
  onDeleteMateProfileItem: (itemId: string) => void;
  onStartMateEmbeddingDownload: () => void;
  onApplyPendingGrowth?: () => void;
  applyPendingGrowthBusy?: boolean;
  canApplyPendingGrowth?: boolean;
  onReloadMateGrowthEvents?: () => void;
  correctingMateGrowthEventId?: string | null;
  correctingMateGrowthEventStatement?: string;
  onBeginCorrectMateGrowthEvent?: (eventId: string, statement: string) => void;
  onChangeCorrectMateGrowthEventStatement?: (statement: string) => void;
  onCancelCorrectMateGrowthEvent?: () => void;
  onCorrectMateGrowthEvent?: (eventId: string, statement: string) => void;
  onDisableMateGrowthEvent?: (eventId: string) => void;
  onForgetMateGrowthEvent?: (eventId: string) => void;
  onUpdateMateGrowthSettings: (input: UpdateMateGrowthSettingsInput) => void;
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
const GROWTH_EVENT_STATE_LABEL: Record<MateGrowthEventListItem["state"], string> = {
  candidate: "候補",
  applied: "適用済み",
  corrected: "修正済み",
  superseded: "置換済み",
  disabled: "無効",
  forgotten: "忘却済み",
  failed: "失敗",
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

const normalizeProviderInstructionErrorPreview = (errorPreview: string): string => {
  const trimmed = errorPreview.trim();
  if (trimmed.length <= MAX_PROVIDER_INSTRUCTION_ERROR_PREVIEW_LENGTH) {
    return trimmed;
  }

  return `${trimmed.slice(0, MAX_PROVIDER_INSTRUCTION_ERROR_PREVIEW_LENGTH - 3)}...`;
};

const formatMateGrowthEventMeta = (event: MateGrowthEventListItem): string =>
  [
    GROWTH_EVENT_STATE_LABEL[event.state],
    event.kind,
    event.targetSection,
    `${event.confidence}%`,
    formatTimestampLabel(event.updatedAt),
  ].join(" / ");

function SettingsInlineHelp({
  summary,
  children,
}: {
  summary: string;
  children: ReactNode;
}) {
  return (
    <details className="settings-inline-help settings-field-help-icon">
      <summary aria-label={summary}>?</summary>
      <div>{children}</div>
    </details>
  );
}

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
  mateGrowthEvents,
  mateGrowthEventsLoading,
  mateGrowthEventsFeedback,
  mateGrowthEventBusyTarget,
  mateEmbeddingSettings,
  mateEmbeddingFeedback,
  mateEmbeddingBusy,
  memoryManagementOnly = false,
  onChangeMemoryGenerationEnabled,
  onChangeMateMemoryGenerationPriorityProvider,
  onChangeMateMemoryGenerationPriorityModel,
  onChangeMateMemoryGenerationPriorityReasoningEffort,
  onChangeMateMemoryGenerationPriorityTimeoutSeconds,
  onAddMateMemoryGenerationPriority,
  onRemoveMateMemoryGenerationPriority,
  onChangeMateMemoryGenerationTriggerIntervalMinutes,
  onChangeAutoCollapseActionDockOnSend,
  onChangeUserMicrocopySlot,
  onChangeProviderEnabled,
  onChangeProviderInstructionEnabled,
  onChangeProviderInstructionWriteMode,
  onChangeProviderInstructionFailPolicy,
  onChangeProviderInstructionInstructionRelativePath,
  onBrowseProviderInstructionInstructionRelativePath,
  onChangeProviderSkillRootPath,
  onBrowseProviderSkillRootPath,
  onChangeProviderSkillRelativePath,
  onBrowseProviderSkillRelativePath,
  onChangeMemoryExtractionModel,
  onChangeMemoryExtractionReasoningEffort,
  onChangeMemoryExtractionThreshold,
  onChangeMemoryExtractionTimeoutSeconds,
  onImportModelCatalog,
  onExportModelCatalog,
  onOpenAppLogFolder,
  onOpenCrashDumpFolder,
  onReloadMemoryManagement,
  onChangeMemoryManagementViewFilters,
  onLoadMoreMemoryManagement,
  onDeleteSessionMemory,
  onDeleteProjectMemoryEntry,
  onDeleteMateProfileItem,
  onStartMateEmbeddingDownload,
  onApplyPendingGrowth,
  applyPendingGrowthBusy = false,
  canApplyPendingGrowth = false,
  onReloadMateGrowthEvents,
  correctingMateGrowthEventId = null,
  correctingMateGrowthEventStatement = "",
  onBeginCorrectMateGrowthEvent,
  onChangeCorrectMateGrowthEventStatement,
  onCancelCorrectMateGrowthEvent,
  onCorrectMateGrowthEvent,
  onDisableMateGrowthEvent,
  onForgetMateGrowthEvent,
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
            onDeleteMateProfileItem={onDeleteMateProfileItem}
            standalone
          />
        </div>
      </div>
    );
  }
  const mateMemoryGenerationPriorities = settingsDraft.mateMemoryGenerationSettings.priorityList.length > 0
    ? settingsDraft.mateMemoryGenerationSettings.priorityList
    : [];
  const resolveMateMemoryGenerationProvider = (
    priority: AppSettings["mateMemoryGenerationSettings"]["priorityList"][number],
  ) => providerSettingRows.find(({ provider }) => provider.id === priority.provider) ?? providerSettingRows[0] ?? null;
  const resolveMateMemoryGenerationModel = (
    providerRow: HomeProviderSettingRow | null,
    priority: AppSettings["mateMemoryGenerationSettings"]["priorityList"][number],
  ) => providerRow
    ? providerRow.provider.models.find((model) => model.id === priority.model) ??
      providerRow.provider.models.find((model) => model.id === providerRow.provider.defaultModelId) ??
      null
    : null;
  const isMateGrowthUnavailable = mateGrowthBusy || mateGrowthSettings === null;
  const isMateGrowthFeatureDisabled = mateGrowthSettings?.enabled === false;
  const isMateGrowthControlDisabled = isMateGrowthUnavailable || isMateGrowthFeatureDisabled;
  const mateGrowthMemoryCandidateMode = mateGrowthSettings?.memoryCandidateMode ?? "every_turn";
  const mateGrowthVisibleMemoryCandidateMode =
    mateGrowthMemoryCandidateMode === "every_turn" ? "every_turn" : "unsupported";
  const mateGrowthModelPreferences = mateGrowthSettings?.modelPreferences ?? [];
  const defaultMateGrowthProviderRow = providerSettingRows[0] ?? null;
  const defaultMateGrowthProvider = defaultMateGrowthProviderRow?.provider;
  const createDefaultMateGrowthModelPreference = (): MateGrowthModelPreference => ({
    purpose: "memory_candidate",
    priority: 1,
    provider: defaultMateGrowthProvider?.id ?? "codex",
    model: defaultMateGrowthProvider?.defaultModelId ?? "gpt-5.4",
    depth: defaultMateGrowthProvider?.defaultReasoningEffort ?? "low",
    enabled: true,
  });
  const mateGrowthMemoryCandidatePreference =
    mateGrowthModelPreferences.find((preference) => preference.purpose === "memory_candidate") ??
    createDefaultMateGrowthModelPreference();
  const mateGrowthProviderRow =
    providerSettingRows.find(({ provider }) => provider.id === mateGrowthMemoryCandidatePreference.provider) ??
    defaultMateGrowthProviderRow;
  const mateGrowthProvider = mateGrowthProviderRow?.provider ?? null;
  const mateGrowthModel =
    mateGrowthProvider?.models.find((model) => model.id === mateGrowthMemoryCandidatePreference.model) ??
    mateGrowthProvider?.models.find((model) => model.id === mateGrowthProvider.defaultModelId) ??
    mateGrowthProvider?.models[0] ??
    null;
  const mateGrowthDepthOptions = mateGrowthModel?.reasoningEfforts ??
    (mateGrowthProvider ? [mateGrowthProvider.defaultReasoningEffort] : [mateGrowthMemoryCandidatePreference.depth]);
  const mateGrowthDepth = mateGrowthDepthOptions.includes(mateGrowthMemoryCandidatePreference.depth as never)
    ? mateGrowthMemoryCandidatePreference.depth
    : mateGrowthDepthOptions[0] ?? mateGrowthMemoryCandidatePreference.depth;
  const mateGrowthNormalizedMemoryCandidatePreference: MateGrowthModelPreference = {
    ...mateGrowthMemoryCandidatePreference,
    purpose: "memory_candidate",
    priority: 1,
    provider: mateGrowthProvider?.id ?? mateGrowthMemoryCandidatePreference.provider,
    model: mateGrowthModel?.id ?? mateGrowthMemoryCandidatePreference.model,
    depth: mateGrowthDepth,
  };
  const updateMateGrowthMemoryCandidatePreference = (patch: Partial<MateGrowthModelPreference>) => {
    onUpdateMateGrowthSettings({
      modelPreferences: [{
        ...mateGrowthNormalizedMemoryCandidatePreference,
        ...patch,
        purpose: "memory_candidate",
        priority: 1,
      }],
    });
  };
  const updateMateGrowthProvider = (providerId: string) => {
    const nextProviderRow =
      providerSettingRows.find(({ provider }) => provider.id === providerId) ??
      defaultMateGrowthProviderRow;
    const nextProvider = nextProviderRow?.provider ?? mateGrowthProvider;
    const nextModel =
      nextProvider?.models.find((model) => model.id === nextProvider.defaultModelId) ??
      nextProvider?.models[0] ??
      mateGrowthModel;
    const nextDepth = nextModel?.reasoningEfforts.includes(nextProvider?.defaultReasoningEffort as never)
      ? nextProvider?.defaultReasoningEffort
      : nextModel?.reasoningEfforts[0];

    updateMateGrowthMemoryCandidatePreference({
      provider: nextProvider?.id ?? providerId,
      model: nextModel?.id ?? mateGrowthNormalizedMemoryCandidatePreference.model,
      depth: nextDepth ?? mateGrowthNormalizedMemoryCandidatePreference.depth,
    });
  };
  const updateMateGrowthModel = (modelId: string) => {
    const nextModel = mateGrowthProvider?.models.find((model) => model.id === modelId) ?? mateGrowthModel;
    const nextDepth = nextModel?.reasoningEfforts.includes(mateGrowthDepth as never)
      ? mateGrowthDepth
      : nextModel?.reasoningEfforts[0];

    updateMateGrowthMemoryCandidatePreference({
      model: nextModel?.id ?? modelId,
      depth: nextDepth ?? mateGrowthDepth,
    });
  };

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

              <section className="settings-section-card">
                <div className="settings-field">
                  <strong>{SETTINGS_PROVIDER_INSTRUCTION_SECTION_LABEL}</strong>
                  <details className="settings-inline-help">
                    <summary aria-label={SETTINGS_PROVIDER_INSTRUCTION_HELP_SUMMARY}>?</summary>
                    <div>
                      <p>{SETTINGS_PROVIDER_INSTRUCTION_MANAGED_BLOCK_HELP}</p>
                      <p>{SETTINGS_PROVIDER_INSTRUCTION_MANAGED_FILE_HELP}</p>
                      <p>{SETTINGS_PROVIDER_INSTRUCTION_PATH_HELP}</p>
                      <p>{SETTINGS_PROVIDER_INSTRUCTION_FAIL_POLICY_HELP}</p>
                    </div>
                  </details>
                  <div className="settings-provider-list">
                    {providerSettingRows.map(({ provider, settings, instructionTarget }) => (
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
                          <span className="settings-field-label-with-help">
                            <span>{SETTINGS_PROVIDER_INSTRUCTION_ROOT_DIRECTORY_LABEL}</span>
                            <SettingsInlineHelp summary={`${SETTINGS_PROVIDER_INSTRUCTION_ROOT_DIRECTORY_LABEL} のヘルプ`}>
                              <p>Root Directory は Skill と Instruction Relative Path の共通基準になる。</p>
                              <p>{SETTINGS_PROVIDER_INSTRUCTION_PATH_HELP}</p>
                            </SettingsInlineHelp>
                          </span>
                          <div className="settings-inline-input-row">
                            <input
                              type="text"
                              value={settings.skillRootPath}
                              onChange={(event) => onChangeProviderSkillRootPath(provider.id, event.target.value)}
                              placeholder={SETTINGS_PROVIDER_INSTRUCTION_ROOT_DIRECTORY_PLACEHOLDER}
                              autoComplete="off"
                              spellCheck={false}
                            />
                            <button
                              className="launch-toggle"
                              type="button"
                              onClick={() => onBrowseProviderSkillRootPath(provider.id)}
                            >
                              選択
                            </button>
                          </div>
                        </label>
                        <label className="settings-provider-input">
                          <span className="settings-field-label-with-help">
                            <span>{SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_LABEL}</span>
                            <SettingsInlineHelp summary={`${SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_LABEL} のヘルプ`}>
                              <p>Skills folder を Root Directory 配下の相対パスで指定する。</p>
                              <p>{SETTINGS_PROVIDER_INSTRUCTION_PATH_HELP}</p>
                            </SettingsInlineHelp>
                          </span>
                          <div className="settings-inline-input-row">
                            <input
                              type="text"
                              value={settings.skillRelativePath ?? ""}
                              onChange={(event) => onChangeProviderSkillRelativePath(provider.id, event.target.value)}
                              placeholder={SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_PLACEHOLDER}
                              autoComplete="off"
                              spellCheck={false}
                            />
                            <button
                              className="launch-toggle"
                              type="button"
                              onClick={() => onBrowseProviderSkillRelativePath(provider.id)}
                            >
                              選択
                            </button>
                          </div>
                        </label>
                        <label className="settings-provider-input">
                          <span className="settings-field-label-with-help">
                            <span>{SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_LABEL}</span>
                            <SettingsInlineHelp summary={`${SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_LABEL} のヘルプ`}>
                              <p>{SETTINGS_PROVIDER_INSTRUCTION_PATH_HELP}</p>
                            </SettingsInlineHelp>
                          </span>
                          <div className="settings-inline-input-row">
                            <input
                              type="text"
                              value={instructionTarget.instructionRelativePath}
                              onChange={(event) =>
                                onChangeProviderInstructionInstructionRelativePath(provider.id, event.target.value)}
                              placeholder={SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_PLACEHOLDER}
                              autoComplete="off"
                              spellCheck={false}
                            />
                            <button
                              className="launch-toggle"
                              type="button"
                              onClick={() => onBrowseProviderInstructionInstructionRelativePath(provider.id)}
                            >
                              選択
                            </button>
                          </div>
                        </label>
                        <label className="settings-provider-input">
                          <span className="settings-field-label-with-help">
                            <span>{SETTINGS_PROVIDER_INSTRUCTION_WRITE_MODE_LABEL}</span>
                            <SettingsInlineHelp summary={`${SETTINGS_PROVIDER_INSTRUCTION_WRITE_MODE_LABEL} のヘルプ`}>
                              <p>{SETTINGS_PROVIDER_INSTRUCTION_MANAGED_BLOCK_HELP}</p>
                              <p>{SETTINGS_PROVIDER_INSTRUCTION_MANAGED_FILE_HELP}</p>
                            </SettingsInlineHelp>
                          </span>
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
                          <span className="settings-field-label-with-help">
                            <span>{SETTINGS_PROVIDER_INSTRUCTION_FAIL_POLICY_LABEL}</span>
                            <SettingsInlineHelp summary={`${SETTINGS_PROVIDER_INSTRUCTION_FAIL_POLICY_LABEL} のヘルプ`}>
                              <p>{SETTINGS_PROVIDER_INSTRUCTION_FAIL_POLICY_HELP}</p>
                            </SettingsInlineHelp>
                          </span>
                          <select
                            value={instructionTarget.failPolicy}
                            onChange={(event) =>
                              onChangeProviderInstructionFailPolicy(provider.id, event.target.value)}
                          >
                            <option value="warn_continue">warn_continue</option>
                            <option value="block_session">block_session</option>
                          </select>
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
              <label className="settings-provider-input">
                <span>{SETTINGS_MATE_MEMORY_GENERATION_TRIGGER_INTERVAL_LABEL}</span>
                <input
                  type="number"
                  min={1}
                  value={settingsDraft.mateMemoryGenerationSettings.triggerIntervalMinutes}
                  onChange={(event) => onChangeMateMemoryGenerationTriggerIntervalMinutes(event.target.value)}
                />
              </label>
              <div className="settings-provider-list">
                {mateMemoryGenerationPriorities.map((priority, index) => {
                  const providerRow = resolveMateMemoryGenerationProvider(priority);
                  const model = resolveMateMemoryGenerationModel(providerRow, priority);
                  const providerId = providerRow?.provider.id ?? priority.provider;
                  const modelId = model?.id ?? priority.model ?? providerRow?.provider.defaultModelId ?? "";
                  const reasoningEfforts = model?.reasoningEfforts ??
                    [providerRow?.provider.defaultReasoningEffort].filter((reasoningEffort) => typeof reasoningEffort === "string");
                  const reasoningEffort = priority.reasoningEffort ?? model?.reasoningEfforts[0] ?? "high";
                  return (
                    <section key={`${providerId}-${index}`} className="settings-provider-card">
                      <div className="settings-provider-toggle-row">
                        <span className="settings-provider-name">Priority {index + 1}</span>
                        <button
                          className="launch-toggle"
                          type="button"
                          onClick={() => onRemoveMateMemoryGenerationPriority(index)}
                          disabled={mateMemoryGenerationPriorities.length <= 1}
                        >
                          {SETTINGS_MATE_MEMORY_GENERATION_PRIORITY_REMOVE_LABEL}
                        </button>
                      </div>
                      <label className="settings-provider-input">
                        <span>Provider</span>
                        <select
                          value={providerId}
                          onChange={(event) => onChangeMateMemoryGenerationPriorityProvider(index, event.target.value)}
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
                          value={modelId}
                          onChange={(event) =>
                            onChangeMateMemoryGenerationPriorityModel(index, providerId, event.target.value)}
                        >
                          {providerRow?.provider.models.map((providerModel) => (
                            <option key={providerModel.id} value={providerModel.id}>
                              {providerModel.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="settings-provider-input">
                        <span>{SETTINGS_MATE_MEMORY_GENERATION_REASONING_LABEL}</span>
                        <select
                          value={reasoningEffort}
                          onChange={(event) =>
                            onChangeMateMemoryGenerationPriorityReasoningEffort(
                              index,
                              event.target.value as AppSettings["mateMemoryGenerationSettings"]["priorityList"][number]["reasoningEffort"],
                            )}
                        >
                          {reasoningEfforts.map((nextReasoningEffort) => (
                            <option key={nextReasoningEffort} value={nextReasoningEffort}>
                              {nextReasoningEffort}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="settings-provider-input">
                        <span>{SETTINGS_MATE_MEMORY_GENERATION_TIMEOUT_LABEL}</span>
                        <input
                          type="number"
                          min={1}
                          value={priority.timeoutSeconds ?? 30}
                          onChange={(event) =>
                            onChangeMateMemoryGenerationPriorityTimeoutSeconds(index, event.target.value)}
                        />
                      </label>
                    </section>
                  );
                })}
              </div>
              <div className="settings-actions">
                <button id="mate-memory-generation-priority-add" className="launch-toggle" type="button" onClick={onAddMateMemoryGenerationPriority}>
                  {SETTINGS_MATE_MEMORY_GENERATION_PRIORITY_ADD_LABEL}
                </button>
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
              <strong>最近の Growth Event</strong>
              <div className="settings-actions">
                <button
                  className="launch-toggle"
                  type="button"
                  onClick={() => onReloadMateGrowthEvents?.()}
                  disabled={!onReloadMateGrowthEvents || mateGrowthEventsLoading || mateGrowthSettings === null}
                >
                  {mateGrowthEventsLoading ? "更新中..." : "再読み込み"}
                </button>
              </div>
              {mateGrowthEvents.length > 0 ? (
                <div className="settings-memory-card-list">
                  {mateGrowthEvents.map((event) => (
                    <article key={event.id} className="settings-memory-card settings-growth-event-card compact">
                      <div className="settings-memory-card-head settings-growth-event-head">
                        <div className="settings-memory-card-copy">
                          <strong>{event.statement}</strong>
                          <span>{formatMateGrowthEventMeta(event)}</span>
                        </div>
                      </div>
                      <div className="settings-memory-actions settings-growth-event-actions">
                        <button
                          className="launch-toggle"
                          type="button"
                          onClick={() => onBeginCorrectMateGrowthEvent?.(event.id, event.statement)}
                          disabled={
                            !onBeginCorrectMateGrowthEvent ||
                            !onCorrectMateGrowthEvent ||
                            mateGrowthEventBusyTarget !== null ||
                            applyPendingGrowthBusy ||
                            event.state !== "candidate"
                          }
                        >
                          修正
                        </button>
                        <button
                          className="danger-button"
                          type="button"
                          onClick={() => onDisableMateGrowthEvent?.(event.id)}
                          disabled={
                            !onDisableMateGrowthEvent ||
                            mateGrowthEventBusyTarget !== null ||
                            event.state !== "candidate"
                          }
                        >
                          {mateGrowthEventBusyTarget === event.id ? "処理中..." : "無効化"}
                        </button>
                        <button
                          className="danger-button"
                          type="button"
                          onClick={() => onForgetMateGrowthEvent?.(event.id)}
                          disabled={
                            !onForgetMateGrowthEvent ||
                            mateGrowthEventBusyTarget !== null ||
                            event.state !== "candidate"
                          }
                        >
                          {mateGrowthEventBusyTarget === event.id ? "処理中..." : "忘れる"}
                        </button>
                      </div>
                      {correctingMateGrowthEventId === event.id ? (
                        <div className="settings-field compact">
                          <label>
                            <span>修正後の内容</span>
                            <textarea
                              value={correctingMateGrowthEventStatement}
                              rows={3}
                              disabled={mateGrowthEventBusyTarget !== null}
                              onChange={(changeEvent) =>
                                onChangeCorrectMateGrowthEventStatement?.(changeEvent.target.value)}
                            />
                          </label>
                          <div className="settings-actions">
                            <button
                              className="launch-toggle"
                              type="button"
                              onClick={() => {
                                const nextStatement = correctingMateGrowthEventStatement.trim();
                                if (nextStatement.length === 0) {
                                  return;
                                }
                                onCorrectMateGrowthEvent?.(event.id, nextStatement);
                              }}
                              disabled={
                                !onCorrectMateGrowthEvent ||
                                mateGrowthEventBusyTarget !== null ||
                                applyPendingGrowthBusy ||
                                event.state !== "candidate" ||
                                correctingMateGrowthEventStatement.trim().length === 0
                              }
                            >
                              保存
                            </button>
                            <button
                              className="launch-toggle"
                              type="button"
                              onClick={() => onCancelCorrectMateGrowthEvent?.()}
                              disabled={mateGrowthEventBusyTarget !== null}
                            >
                              キャンセル
                            </button>
                          </div>
                        </div>
                      ) : null}
                      {event.rationalePreview ? <p className="settings-help">{event.rationalePreview}</p> : null}
                    </article>
                  ))}
                </div>
              ) : (
                <p className="settings-help">
                  {mateGrowthEventsLoading ? "Growth Event を読み込み中..." : "表示できる Growth Event はまだないよ。"}
                </p>
              )}
              {mateGrowthEventsFeedback ? <p className="settings-feedback">{mateGrowthEventsFeedback}</p> : null}
            </div>
          </section>

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
                  value={mateGrowthVisibleMemoryCandidateMode}
                  disabled={isMateGrowthControlDisabled}
                  onChange={(event) => onUpdateMateGrowthSettings({
                    memoryCandidateMode: event.target.value as "every_turn",
                  })}
                >
                  <option value="every_turn">{SETTINGS_MATE_GROWTH_EVERY_TURN_LABEL}</option>
                  {mateGrowthVisibleMemoryCandidateMode === "unsupported" ? (
                    <option value="unsupported" disabled>
                      {mateGrowthMemoryCandidateMode}
                    </option>
                  ) : null}
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
              <div className="settings-field">
                <strong>{SETTINGS_MATE_GROWTH_MODEL_PREFERENCES_LABEL}</strong>
                <div className="settings-provider-list">
                  <section className="settings-provider-card">
                    <div className="settings-provider-card-head">
                      <span className="settings-provider-name">memory_candidate</span>
                    </div>
                      <label className="settings-provider-input">
                        <span>{SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_PROVIDER_LABEL}</span>
                        <select
                          id="mate-growth-model-preference-provider"
                          value={mateGrowthNormalizedMemoryCandidatePreference.provider}
                          disabled={isMateGrowthControlDisabled}
                          onChange={(event) => updateMateGrowthProvider(event.target.value)}
                        >
                          {providerSettingRows.length > 0 ? providerSettingRows.map(({ provider }) => (
                            <option key={provider.id} value={provider.id}>
                              {provider.label}
                            </option>
                          )) : (
                            <option value={mateGrowthNormalizedMemoryCandidatePreference.provider}>
                              {mateGrowthNormalizedMemoryCandidatePreference.provider}
                            </option>
                          )}
                        </select>
                      </label>
                      <label className="settings-provider-input">
                        <span>{SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_MODEL_LABEL}</span>
                        <select
                          id="mate-growth-model-preference-model"
                          value={mateGrowthNormalizedMemoryCandidatePreference.model}
                          disabled={isMateGrowthControlDisabled}
                          onChange={(event) => updateMateGrowthModel(event.target.value)}
                        >
                          {mateGrowthProvider?.models.length ? mateGrowthProvider.models.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.label}
                            </option>
                          )) : (
                            <option value={mateGrowthNormalizedMemoryCandidatePreference.model}>
                              {mateGrowthNormalizedMemoryCandidatePreference.model}
                            </option>
                          )}
                        </select>
                      </label>
                      <label className="settings-provider-input">
                        <span>{SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_DEPTH_LABEL}</span>
                        <select
                          id="mate-growth-model-preference-depth"
                          value={mateGrowthNormalizedMemoryCandidatePreference.depth}
                          disabled={isMateGrowthControlDisabled}
                          onChange={(event) =>
                            updateMateGrowthMemoryCandidatePreference({
                              depth: event.target.value,
                            })}
                        >
                          {mateGrowthDepthOptions.map((depth) => (
                            <option key={depth} value={depth}>
                              {depth}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="settings-provider-toggle-row settings-section-toggle">
                        <span>{SETTINGS_MATE_GROWTH_MODEL_PREFERENCE_ENABLED_LABEL}</span>
                        <input
                          id="mate-growth-model-preference-enabled"
                          type="checkbox"
                          checked={mateGrowthNormalizedMemoryCandidatePreference.enabled}
                          disabled={isMateGrowthControlDisabled}
                          onChange={(event) =>
                            updateMateGrowthMemoryCandidatePreference({
                              enabled: event.target.checked,
                            })}
                        />
                      </label>
                  </section>
                </div>
              </div>
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
  onDeleteMateProfileItem: (itemId: string) => void;
};

const MEMORY_DOMAIN_OPTIONS: Array<{ value: MemoryManagementDomainFilter; label: string }> = [
  { value: "all", label: "All Domains" },
  { value: "session", label: "Session" },
  { value: "project", label: "Project" },
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

function areMemoryManagementFiltersEqual(
  left: MemoryManagementViewFilters,
  right: MemoryManagementViewFilters,
): boolean {
  return (
    left.searchText === right.searchText &&
    left.domain === right.domain &&
    left.sort === right.sort &&
    left.sessionStatus === right.sessionStatus &&
    left.projectCategory === right.projectCategory
  );
}

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
  onDeleteMateProfileItem,
}: SettingsMemoryManagementSectionProps) {
  const [searchText, setSearchText] = useState(DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.searchText);
  const [domain, setDomain] = useState<MemoryManagementDomainFilter>(DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.domain);
  const [sort, setSort] = useState<MemoryManagementSort>(DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.sort);
  const [sessionStatus, setSessionStatus] = useState<SessionMemoryStatusFilter>(DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.sessionStatus);
  const [projectCategory, setProjectCategory] = useState<ProjectMemoryCategoryFilter>(
    DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.projectCategory,
  );
  const activeFilters = useMemo<MemoryManagementViewFilters>(
    () => ({
      searchText,
      domain,
      sort,
      sessionStatus,
      projectCategory,
    }),
    [domain, projectCategory, searchText, sessionStatus, sort],
  );
  const lastNotifiedFiltersRef = useRef<MemoryManagementViewFilters>(activeFilters);

  useEffect(() => {
    if (areMemoryManagementFiltersEqual(lastNotifiedFiltersRef.current, activeFilters)) {
      return;
    }
    lastNotifiedFiltersRef.current = activeFilters;
    onChangeViewFilters(activeFilters);
  }, [activeFilters, onChangeViewFilters]);

  const filteredSnapshot = useMemo(
    () =>
      buildFilteredMemoryManagementSnapshot(snapshot, activeFilters),
    [activeFilters, snapshot],
  );
  const sessionCount = filteredSnapshot?.sessionMemories.length ?? 0;
  const projectEntryCount = filteredSnapshot?.projectMemories.reduce((count, group) => count + group.entries.length, 0) ?? 0;
  const mateProfileItemCount = filteredSnapshot?.mateProfileItems?.length ?? 0;
  const hasActiveFilters =
    searchText.trim().length > 0 ||
    domain !== DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.domain ||
    sort !== DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.sort ||
    sessionStatus !== DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.sessionStatus ||
    projectCategory !== DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.projectCategory;
  const showSessionDomain = domain === "all" || domain === "session";
  const showProjectDomain = domain === "all" || domain === "project";
  const showMateProfileDomain = domain === "all" || domain === "mate_profile";

  const clearFilters = () => {
    setSearchText(DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.searchText);
    setDomain(DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.domain);
    setSort(DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.sort);
    setSessionStatus(DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.sessionStatus);
    setProjectCategory(DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS.projectCategory);
  };

  return (
    <section className="settings-section-card">
      <div className="settings-field">
        <strong>Memory 管理</strong>
        <div className="settings-actions settings-memory-actions">
          <span className="settings-memory-summary">
            {`Session ${sessionCount} / Project ${projectEntryCount} / Mate Profile ${mateProfileItemCount}`}
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
                disabled={domain === "project" || domain === "mate_profile"}
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
                disabled={domain === "session" || domain === "mate_profile"}
                onChange={(event) => setProjectCategory(event.target.value as ProjectMemoryCategoryFilter)}
              >
                {PROJECT_CATEGORY_OPTIONS.map((option) => (
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
