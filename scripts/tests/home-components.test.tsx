import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { HomeSettingsContent } from "../../src/home-components.js";
import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import { buildHomeProviderSettingRows } from "../../src/home-settings-view-model.js";
import {
  SETTINGS_MATE_MEMORY_GENERATION_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_TRIGGER_INTERVAL_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_MODEL_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_REASONING_LABEL,
  SETTINGS_MATE_MEMORY_GENERATION_TIMEOUT_LABEL,
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
});
