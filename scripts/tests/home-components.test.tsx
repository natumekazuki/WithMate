import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  HomeLaunchDialog,
  HomeRecentSessionsPanel,
  HomeRightPane,
  HomeSettingsContent,
} from "../../src/home-components.js";
import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import { buildHomeProviderSettingRows } from "../../src/home-settings-view-model.js";
import type { MateEmbeddingSettings } from "../../src/mate-embedding-settings.js";
import { formatTimestampLabel } from "../../src/time-state.js";
import {
  SETTINGS_MATE_EMBEDDING_LABEL,
  SETTINGS_MATE_RESET_HELP,
  SETTINGS_MATE_RESET_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_TRIGGER_INTERVAL_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_MODEL_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_REASONING_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_TIMEOUT_LABEL,
  SETTINGS_PROVIDER_INSTRUCTION_SECTION_LABEL,
  SETTINGS_PROVIDER_INSTRUCTION_ROOT_DIRECTORY_LABEL,
  SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_LABEL,
} from "../../src/settings-ui.js";

describe("HomeSettingsContent", () => {
  const modelCatalog: ModelCatalogSnapshot = {
    revision: 1,
    providers: [
      {
        id: "codex",
        label: "Codex",
        defaultModelId: "gpt-5.4",
        defaultReasoningEffort: "high",
        models: [
          { id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["medium", "high"] },
          { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", reasoningEfforts: ["low", "medium"] },
        ],
      },
    ],
  };

  const settingsDraft = createDefaultAppSettings();
  const providerSettingRows = buildHomeProviderSettingRows(modelCatalog, settingsDraft);
  const noOp = (..._args: unknown[]) => undefined;

  const renderSettings = (params?: {
    canResetMate?: boolean;
    mateResetBusy?: boolean;
  }) => renderToStaticMarkup(
    <HomeSettingsContent
      settingsDraft={settingsDraft}
      providerSettingRows={providerSettingRows}
      modelCatalogRevisionLabel={String(modelCatalog.revision)}
      settingsDirty={false}
      settingsFeedback=""
      memoryManagementSnapshot={null}
      memoryManagementPages={{
        session: { nextCursor: null, hasMore: false, total: 0 },
        project: { nextCursor: null, hasMore: false, total: 0 },
        character: { nextCursor: null, hasMore: false, total: 0 },
        mate_profile: { nextCursor: null, hasMore: false, total: 0 },
      }}
      memoryManagementLoading={false}
      memoryManagementBusyTarget={null}
      memoryManagementFeedback=""
      mateEmbeddingSettings={null}
      mateEmbeddingFeedback=""
      mateEmbeddingBusy={false}
      onChangeSystemPromptPrefix={noOp}
      onChangeMemoryGenerationEnabled={noOp}
      onChangeMateMemoryGenerationPriorityProvider={noOp}
      onChangeMateMemoryGenerationPriorityModel={noOp}
      onChangeMateMemoryGenerationPriorityReasoningEffort={noOp}
      onChangeMateMemoryGenerationPriorityTimeoutSeconds={noOp}
      onChangeMateMemoryGenerationTriggerIntervalMinutes={noOp}
      onChangeAutoCollapseActionDockOnSend={noOp}
      onChangeProviderEnabled={noOp}
      onChangeProviderInstructionEnabled={noOp}
      onChangeProviderInstructionWriteMode={noOp}
      onChangeProviderInstructionFailPolicy={noOp}
      onChangeProviderInstructionRootDirectory={noOp}
      onChangeProviderInstructionInstructionRelativePath={noOp}
      onChangeProviderSkillRootPath={noOp}
      onBrowseProviderSkillRootPath={noOp}
      onChangeMemoryExtractionModel={noOp}
      onChangeMemoryExtractionReasoningEffort={noOp}
      onChangeMemoryExtractionThreshold={noOp}
      onChangeMemoryExtractionTimeoutSeconds={noOp}
      onChangeCharacterReflectionModel={noOp}
      onChangeCharacterReflectionReasoningEffort={noOp}
      onChangeCharacterReflectionTimeoutSeconds={noOp}
      onChangeCharacterReflectionCooldownSeconds={noOp}
      onChangeCharacterReflectionCharDeltaThreshold={noOp}
      onChangeCharacterReflectionMessageDeltaThreshold={noOp}
      onImportModelCatalog={noOp}
      onExportModelCatalog={noOp}
      onOpenAppLogFolder={noOp}
      onOpenCrashDumpFolder={noOp}
      onReloadMemoryManagement={noOp}
      onChangeMemoryManagementViewFilters={noOp}
      onLoadMoreMemoryManagement={noOp}
      onDeleteSessionMemory={noOp}
      onDeleteProjectMemoryEntry={noOp}
      onDeleteCharacterMemoryEntry={noOp}
      onDeleteMateProfileItem={noOp}
      onStartMateEmbeddingDownload={noOp}
      onResetMate={noOp}
      canResetMate={params?.canResetMate ?? false}
      mateResetBusy={params?.mateResetBusy ?? false}
      onSaveSettings={noOp}
    />
  );

  const extractResetButton = (html: string) => {
    const resetLabelIndex = html.indexOf(`<strong>${SETTINGS_MATE_RESET_LABEL}</strong>`);
    const resetButtonIndex = html.indexOf('<button class="launch-toggle danger-button"', resetLabelIndex);
    const resetButtonEndIndex = html.indexOf("</button>", resetButtonIndex);
    assert.ok(resetLabelIndex >= 0 && resetButtonIndex >= 0 && resetButtonEndIndex >= 0);
    return html.slice(resetButtonIndex, resetButtonEndIndex + 9);
  };

  it("Mate Memory Generation のセクションが表示される", () => {
    const html = renderSettings();

    assert.ok(html.includes(`<strong>${SETTINGS_MATE_MEMORY_GENERATION_LABEL}</strong>`));
    assert.ok(html.includes("<span>Priority 1</span>"));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_MEMORY_GENERATION_MODEL_LABEL}</span>`));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_MEMORY_GENERATION_REASONING_LABEL}</span>`));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_MEMORY_GENERATION_TIMEOUT_LABEL}</span>`));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_MEMORY_GENERATION_TRIGGER_INTERVAL_LABEL}</span>`));
  });

  it("Mate Reset のラベルとヘルプが表示される", () => {
    const html = renderSettings();
    assert.ok(html.includes(`<strong>${SETTINGS_MATE_RESET_LABEL}</strong>`));
    assert.ok(html.includes(`<p class="settings-help">${SETTINGS_MATE_RESET_HELP}</p>`));
  });

  it("canResetMate=false のときリセットボタンは無効化される", () => {
    const html = renderSettings({ canResetMate: false });
    const buttonHtml = extractResetButton(html);
    assert.ok(buttonHtml.includes('disabled=""'));
    assert.ok(buttonHtml.includes(SETTINGS_MATE_RESET_LABEL));
  });

  it("canResetMate=true のときリセットボタンは有効", () => {
    const html = renderSettings({ canResetMate: true });
    const buttonHtml = extractResetButton(html);
    assert.ok(!buttonHtml.includes('disabled=""'));
  });

  it("mateResetBusy=true のときリセットボタンは無効化され「リセット中...」が表示される", () => {
    const html = renderSettings({ canResetMate: true, mateResetBusy: true });
    const buttonHtml = extractResetButton(html);
    assert.ok(buttonHtml.includes('disabled=""'));
    assert.ok(buttonHtml.includes("リセット中..."));
  });

  it("Mate Embedding のキャッシュ状態が拡張表示される", () => {
    const mateEmbeddingSettings: MateEmbeddingSettings = {
      mateId: "current",
      enabled: true,
      backendType: "local_transformers_js",
      modelId: "text-embedding-3-large",
      sourceModelId: "text-embedding-3-small",
      dimension: 1536,
      cachePolicy: "download_once_local_cache",
      cacheState: "ready",
      cacheDirPath: "hidden-cache-path-marker",
      cacheManifestSha256: "manifest-sha",
      modelRevision: "model-revision",
      cacheSizeBytes: 1536,
      cacheUpdatedAt: "2026-05-01T09:30:00.000Z",
      lastVerifiedAt: null,
      lastStatus: "available",
      lastErrorPreview: "",
      createdAt: "2026-05-01T09:00:00.000Z",
      updatedAt: "2026-05-01T09:00:00.000Z",
    };

    const html = renderToStaticMarkup(
      <HomeSettingsContent
        settingsDraft={settingsDraft}
        providerSettingRows={providerSettingRows}
        modelCatalogRevisionLabel={String(modelCatalog.revision)}
        settingsDirty={false}
        settingsFeedback=""
        memoryManagementSnapshot={null}
        memoryManagementPages={{
          session: { nextCursor: null, hasMore: false, total: 0 },
          project: { nextCursor: null, hasMore: false, total: 0 },
          character: { nextCursor: null, hasMore: false, total: 0 },
          mate_profile: { nextCursor: null, hasMore: false, total: 0 },
        }}
        memoryManagementLoading={false}
        memoryManagementBusyTarget={null}
        memoryManagementFeedback=""
        mateEmbeddingSettings={mateEmbeddingSettings}
        mateEmbeddingFeedback=""
        mateEmbeddingBusy={false}
        onChangeSystemPromptPrefix={noOp}
        onChangeMemoryGenerationEnabled={noOp}
        onChangeMateMemoryGenerationPriorityProvider={noOp}
        onChangeMateMemoryGenerationPriorityModel={noOp}
        onChangeMateMemoryGenerationPriorityReasoningEffort={noOp}
        onChangeMateMemoryGenerationPriorityTimeoutSeconds={noOp}
        onChangeMateMemoryGenerationTriggerIntervalMinutes={noOp}
        onChangeAutoCollapseActionDockOnSend={noOp}
        onChangeProviderEnabled={noOp}
        onChangeProviderInstructionEnabled={noOp}
        onChangeProviderInstructionWriteMode={noOp}
        onChangeProviderInstructionFailPolicy={noOp}
        onChangeProviderInstructionRootDirectory={noOp}
        onChangeProviderInstructionInstructionRelativePath={noOp}
        onChangeProviderSkillRootPath={noOp}
        onBrowseProviderSkillRootPath={noOp}
        onChangeMemoryExtractionModel={noOp}
        onChangeMemoryExtractionReasoningEffort={noOp}
        onChangeMemoryExtractionThreshold={noOp}
        onChangeMemoryExtractionTimeoutSeconds={noOp}
        onChangeCharacterReflectionModel={noOp}
        onChangeCharacterReflectionReasoningEffort={noOp}
        onChangeCharacterReflectionTimeoutSeconds={noOp}
        onChangeCharacterReflectionCooldownSeconds={noOp}
        onChangeCharacterReflectionCharDeltaThreshold={noOp}
        onChangeCharacterReflectionMessageDeltaThreshold={noOp}
        onImportModelCatalog={noOp}
        onExportModelCatalog={noOp}
        onOpenAppLogFolder={noOp}
        onOpenCrashDumpFolder={noOp}
        onReloadMemoryManagement={noOp}
        onChangeMemoryManagementViewFilters={noOp}
        onLoadMoreMemoryManagement={noOp}
        onDeleteSessionMemory={noOp}
        onDeleteProjectMemoryEntry={noOp}
        onDeleteCharacterMemoryEntry={noOp}
        onDeleteMateProfileItem={noOp}
        onStartMateEmbeddingDownload={noOp}
        onSaveSettings={noOp}
      />,
    );

    assert.ok(html.includes(`<strong>${SETTINGS_MATE_EMBEDDING_LABEL}</strong>`));
    assert.ok(html.includes("キャッシュサイズ"));
    assert.ok(html.includes("<dd>1.5 KB</dd>"));
    assert.ok(html.includes("<dt>最終更新</dt>"));
    assert.ok(html.includes(`<dd>${formatTimestampLabel(mateEmbeddingSettings.cacheUpdatedAt)}</dd>`));
    assert.ok(html.includes("<dt>最終確認</dt>"));
    assert.ok(html.includes("<dd>-</dd>"));
    assert.ok(html.includes("<dt>最終ステータス</dt>"));
    assert.ok(html.includes("<dd>利用可</dd>"));
    assert.ok(!html.includes("hidden-cache-path-marker"));
  });

  it("Provider Instruction Sync に rootDirectory / instructionRelativePath の入力が表示される", () => {
    const customRows = buildHomeProviderSettingRows(modelCatalog, settingsDraft, [
      {
        providerId: "codex",
        targetId: "main",
        enabled: true,
        rootDirectory: "/repo-root",
        instructionRelativePath: "docs/instructions.md",
        writeMode: "managed_block",
        projectionScope: "mate_only",
        failPolicy: "warn_continue",
        requiresRestart: false,
        lastSyncState: "never",
        lastSyncRunId: null,
        lastSyncedRevisionId: null,
        lastErrorPreview: "",
        lastSyncedAt: null,
      },
    ]);

    const html = renderToStaticMarkup(
      <HomeSettingsContent
        settingsDraft={settingsDraft}
        providerSettingRows={customRows}
        modelCatalogRevisionLabel={String(modelCatalog.revision)}
        settingsDirty={false}
        settingsFeedback=""
        memoryManagementSnapshot={null}
        memoryManagementPages={{
          session: { nextCursor: null, hasMore: false, total: 0 },
          project: { nextCursor: null, hasMore: false, total: 0 },
          character: { nextCursor: null, hasMore: false, total: 0 },
          mate_profile: { nextCursor: null, hasMore: false, total: 0 },
        }}
        memoryManagementLoading={false}
        memoryManagementBusyTarget={null}
        memoryManagementFeedback=""
        mateEmbeddingSettings={null}
        mateEmbeddingFeedback=""
        mateEmbeddingBusy={false}
        onChangeSystemPromptPrefix={noOp}
        onChangeMemoryGenerationEnabled={noOp}
        onChangeMateMemoryGenerationPriorityProvider={noOp}
        onChangeMateMemoryGenerationPriorityModel={noOp}
        onChangeMateMemoryGenerationPriorityReasoningEffort={noOp}
        onChangeMateMemoryGenerationPriorityTimeoutSeconds={noOp}
        onChangeMateMemoryGenerationTriggerIntervalMinutes={noOp}
        onChangeAutoCollapseActionDockOnSend={noOp}
        onChangeProviderEnabled={noOp}
        onChangeProviderInstructionEnabled={noOp}
        onChangeProviderInstructionWriteMode={noOp}
        onChangeProviderInstructionFailPolicy={noOp}
        onChangeProviderInstructionRootDirectory={noOp}
        onChangeProviderInstructionInstructionRelativePath={noOp}
        onChangeProviderSkillRootPath={noOp}
        onBrowseProviderSkillRootPath={noOp}
        onChangeMemoryExtractionModel={noOp}
        onChangeMemoryExtractionReasoningEffort={noOp}
        onChangeMemoryExtractionThreshold={noOp}
        onChangeMemoryExtractionTimeoutSeconds={noOp}
        onChangeCharacterReflectionModel={noOp}
        onChangeCharacterReflectionReasoningEffort={noOp}
        onChangeCharacterReflectionTimeoutSeconds={noOp}
        onChangeCharacterReflectionCooldownSeconds={noOp}
        onChangeCharacterReflectionCharDeltaThreshold={noOp}
        onChangeCharacterReflectionMessageDeltaThreshold={noOp}
        onImportModelCatalog={noOp}
        onExportModelCatalog={noOp}
        onOpenAppLogFolder={noOp}
        onOpenCrashDumpFolder={noOp}
        onReloadMemoryManagement={noOp}
        onChangeMemoryManagementViewFilters={noOp}
        onLoadMoreMemoryManagement={noOp}
        onDeleteSessionMemory={noOp}
        onDeleteProjectMemoryEntry={noOp}
        onDeleteCharacterMemoryEntry={noOp}
        onDeleteMateProfileItem={noOp}
        onStartMateEmbeddingDownload={noOp}
        onSaveSettings={noOp}
      />,
    );

    assert.ok(html.includes(`<strong>${SETTINGS_PROVIDER_INSTRUCTION_SECTION_LABEL}</strong>`));
    assert.ok(html.includes(`<span>${SETTINGS_PROVIDER_INSTRUCTION_ROOT_DIRECTORY_LABEL}</span>`));
    assert.ok(html.includes(`<span>${SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_LABEL}</span>`));
    assert.ok(html.includes(`value=\"/repo-root\"`));
    assert.ok(html.includes("value=\"docs/instructions.md\""));
  });

  it("Provider Instruction Sync の同期状態 / 再起動 / エラープレビューが表示される", () => {
    const syncedAt = "2026-05-06T10:00:00.000Z";
    const customRows = buildHomeProviderSettingRows(modelCatalog, settingsDraft, [
      {
        providerId: "codex",
        targetId: "main",
        enabled: true,
        rootDirectory: "/repo-root",
        instructionRelativePath: "docs/instructions.md",
        writeMode: "managed_block",
        projectionScope: "mate_only",
        failPolicy: "warn_continue",
        requiresRestart: true,
        lastSyncState: "failed",
        lastSyncRunId: null,
        lastSyncedRevisionId: null,
        lastErrorPreview: "permission denied: EACCES (13): Permission denied",
        lastSyncedAt: syncedAt,
      },
    ]);

    const html = renderToStaticMarkup(
      <HomeSettingsContent
        settingsDraft={settingsDraft}
        providerSettingRows={customRows}
        modelCatalogRevisionLabel={String(modelCatalog.revision)}
        settingsDirty={false}
        settingsFeedback=""
        memoryManagementSnapshot={null}
        memoryManagementPages={{
          session: { nextCursor: null, hasMore: false, total: 0 },
          project: { nextCursor: null, hasMore: false, total: 0 },
          character: { nextCursor: null, hasMore: false, total: 0 },
          mate_profile: { nextCursor: null, hasMore: false, total: 0 },
        }}
        memoryManagementLoading={false}
        memoryManagementBusyTarget={null}
        memoryManagementFeedback=""
        mateEmbeddingSettings={null}
        mateEmbeddingFeedback=""
        mateEmbeddingBusy={false}
        onChangeSystemPromptPrefix={noOp}
        onChangeMemoryGenerationEnabled={noOp}
        onChangeMateMemoryGenerationPriorityProvider={noOp}
        onChangeMateMemoryGenerationPriorityModel={noOp}
        onChangeMateMemoryGenerationPriorityReasoningEffort={noOp}
        onChangeMateMemoryGenerationPriorityTimeoutSeconds={noOp}
        onChangeMateMemoryGenerationTriggerIntervalMinutes={noOp}
        onChangeAutoCollapseActionDockOnSend={noOp}
        onChangeProviderEnabled={noOp}
        onChangeProviderInstructionEnabled={noOp}
        onChangeProviderInstructionWriteMode={noOp}
        onChangeProviderInstructionFailPolicy={noOp}
        onChangeProviderInstructionRootDirectory={noOp}
        onChangeProviderInstructionInstructionRelativePath={noOp}
        onChangeProviderSkillRootPath={noOp}
        onBrowseProviderSkillRootPath={noOp}
        onChangeMemoryExtractionModel={noOp}
        onChangeMemoryExtractionReasoningEffort={noOp}
        onChangeMemoryExtractionThreshold={noOp}
        onChangeMemoryExtractionTimeoutSeconds={noOp}
        onChangeCharacterReflectionModel={noOp}
        onChangeCharacterReflectionReasoningEffort={noOp}
        onChangeCharacterReflectionTimeoutSeconds={noOp}
        onChangeCharacterReflectionCooldownSeconds={noOp}
        onChangeCharacterReflectionCharDeltaThreshold={noOp}
        onChangeCharacterReflectionMessageDeltaThreshold={noOp}
        onImportModelCatalog={noOp}
        onExportModelCatalog={noOp}
        onOpenAppLogFolder={noOp}
        onOpenCrashDumpFolder={noOp}
        onReloadMemoryManagement={noOp}
        onChangeMemoryManagementViewFilters={noOp}
        onLoadMoreMemoryManagement={noOp}
        onDeleteSessionMemory={noOp}
        onDeleteProjectMemoryEntry={noOp}
        onDeleteCharacterMemoryEntry={noOp}
        onDeleteMateProfileItem={noOp}
        onStartMateEmbeddingDownload={noOp}
        onSaveSettings={noOp}
      />,
    );

    assert.ok(html.includes("<dt>同期状態</dt>"));
    assert.ok(html.includes("<dd>失敗</dd>"));
    assert.ok(html.includes("<dt>最終同期</dt>"));
    assert.ok(html.includes(`<dd>${formatTimestampLabel(syncedAt)}</dd>`));
    assert.ok(html.includes("<p class=\"settings-feedback settings-memory-feedback\">再起動が必要</p>"));
    assert.ok(html.includes("<span>エラープレビュー</span>"));
    assert.ok(html.includes("permission denied: EACCES (13): Permission denied"));
  });
});

describe("HomeLaunchDialog", () => {
  const noOp = (..._args: unknown[]) => undefined;

  it("セッション起動ダイアログにキャラ選択 UI が含まれない", () => {
    const html = renderToStaticMarkup(
      <HomeLaunchDialog
        open={true}
        mode="session"
        title="demo"
        workspace={null}
        launchWorkspacePathLabel="workspace"
        enabledLaunchProviders={[{ id: "codex", label: "Codex" }]}
        selectedLaunchProviderId="codex"
        canStartSession={true}
        launchFeedback=""
        launchStarting={false}
        onClose={noOp}
        onSelectMode={noOp}
        onChangeTitle={noOp}
        onBrowseWorkspace={noOp}
        onSelectProvider={noOp}
        onStartSession={noOp}
      />,
    );

    assert.ok(!html.includes("launch-search-row"));
    assert.ok(!html.includes("キャラクターを選ぶ"));
    assert.ok(!html.includes("キャラを選んでね"));
    assert.ok(!html.includes("Add Character"));
  });
});

describe("HomeRecentSessionsPanel", () => {
  const noOp = (..._args: unknown[]) => undefined;

  const renderHomeRecentSessions = (canUsePrimaryFeatures = true) => renderToStaticMarkup(
    <HomeRecentSessionsPanel
      filteredSessionEntries={[]}
      companionSessions={[]}
      normalizedSessionSearch=""
      searchText=""
      searchIcon={<span />}
      onChangeSearchText={noOp}
      onOpenLaunchDialog={noOp}
      onOpenSession={noOp}
      onOpenCompanionReview={noOp}
      canUsePrimaryFeatures={canUsePrimaryFeatures}
    />,
  );

  it("canUsePrimaryFeatures false の時は New Session が無効化される", () => {
    const html = renderHomeRecentSessions(false);
    const disabledButtons = html.match(/<button class="start-session-button"[^>]*disabled=""/g);
    assert.ok(disabledButtons && disabledButtons.length >= 2);
  });
});

describe("HomeRightPane", () => {
  const noOp = (..._args: unknown[]) => undefined;

  const renderHomeRightPane = (rightPaneView: "monitor" | "mate", mateProfile: null | {
    id: string;
    state: "draft" | "active" | "deleted";
    displayName: string;
    description: string;
    themeMain: string;
    themeSub: string;
    avatarFilePath: string;
    avatarSha256: string;
    avatarByteSize: number;
    activeRevisionId: string | null;
    profileGeneration: number;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
    sections: {
      sectionKey: "core" | "bond" | "work_style" | "notes";
      filePath: string;
      sha256: string;
      byteSize: number;
      updatedByRevisionId: string;
    }[];
    },
    canUsePrimaryFeatures = true,
  ) => renderToStaticMarkup(
    <HomeRightPane
      rightPaneView={rightPaneView}
      runningMonitorEntries={[]}
      nonRunningMonitorEntries={[]}
      monitorRunningEmptyMessage="running"
      monitorCompletedEmptyMessage="completed"
      mateProfile={mateProfile}
      monitorWindowIcon={<span>Monitor</span>}
      onChangeRightPaneView={noOp}
      onOpenSessionMonitorWindow={noOp}
      onOpenMemoryManagementWindow={noOp}
      onOpenSettingsWindow={noOp}
      onOpenMateTalk={noOp}
      onOpenSession={noOp}
      onOpenCompanionReview={noOp}
      canUsePrimaryFeatures={canUsePrimaryFeatures}
    />,
  );

  it("Your Mate タブは Characters / Add Character を含まない", () => {
    const html = renderHomeRightPane("mate", {
      id: "mate-1",
      state: "active",
      displayName: "Your Mate",
      description: "説明文",
      themeMain: "#3b82f6",
      themeSub: "#1d4ed8",
      avatarFilePath: "",
      avatarSha256: "",
      avatarByteSize: 0,
      activeRevisionId: null,
      profileGeneration: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      sections: [],
    });

    assert.ok(html.includes("Your Mate"));
    assert.ok(html.includes("説明文"));
    assert.ok(!html.includes("Characters"));
    assert.ok(!html.includes("Add Character"));
    assert.ok(html.includes("メイトーク"));
  });

  it("mateProfile が null でも fallback で Mate 表示できる", () => {
    const html = renderHomeRightPane("mate", null);
    assert.ok(html.includes("Your Mate"));
    assert.ok(html.includes("Mate の説明は未設定だよ。"));
  });

  it("canUsePrimaryFeatures false の時は主要アクションを無効化する", () => {
    const html = renderHomeRightPane("monitor", null, false);
    assert.match(html, /<button class="launch-toggle home-monitor-window-button"[^>]*disabled=""/);
    assert.match(html, /<button class="launch-toggle home-settings-button"[^>]*aria-disabled="true"[^>]*disabled=""/);
  });
});
