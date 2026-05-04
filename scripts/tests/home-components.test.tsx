import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { HomeLaunchDialog, HomeRightPane, HomeSettingsContent } from "../../src/home-components.js";
import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import { buildHomeProviderSettingRows } from "../../src/home-settings-view-model.js";
import {
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

  const renderSettings = () => renderToStaticMarkup(
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
      onStartMateEmbeddingDownload={noOp}
      onSaveSettings={noOp}
    />
  );

  it("Mate Memory Generation のセクションが表示される", () => {
    const html = renderSettings();

    assert.ok(html.includes(`<strong>${SETTINGS_MATE_MEMORY_GENERATION_LABEL}</strong>`));
    assert.ok(html.includes("<span>Priority 1</span>"));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_MEMORY_GENERATION_MODEL_LABEL}</span>`));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_MEMORY_GENERATION_REASONING_LABEL}</span>`));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_MEMORY_GENERATION_TIMEOUT_LABEL}</span>`));
    assert.ok(html.includes(`<span>${SETTINGS_MATE_MEMORY_GENERATION_TRIGGER_INTERVAL_LABEL}</span>`));
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
  }) => renderToStaticMarkup(
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
});
