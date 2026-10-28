import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MEMORY_FILE_QUOTA_MAX_BYTES,
  MEMORY_FILE_QUOTA_MIN_BYTES,
  createDefaultAppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import {
  buildPersistedAppSettingsFromRows,
  buildHomeProviderSettingRows,
  buildNormalizedMemoryExtractionProviderSettings,
  getMemoryFileQuotaMegabytes,
  getMemoryFileQuotaMegabytesInputBounds,
} from "../../src/settings/settings-view-model.js";

function createSnapshot(): ModelCatalogSnapshot {
  return {
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
}

describe("home-settings-view-model", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "provider設定表示はSDK候補にない保存modelとDepthを保持する"
  // oracle = { type = "contract", ref = "Issue #879 discovered models and preserved execution selections" }
  // fault = "保存modelをcatalog既定値へ置換する"
  // observable = "provider rowのmodelとDepth"
  // observation_boundary = "public-boundary"
  // scope = "settings-saved-model-projection"
  // lifecycle = "permanent"
  // @end-test-value
  it("provider row はcatalog未収録の保存選択を保持する", () => {
    const settings = createDefaultAppSettings();
    settings.memoryExtractionProviderSettings.codex = {
      model: "missing-model",
      reasoningEffort: "high",
      outputTokensThreshold: 222,
      timeoutSeconds: 240,
    };

    const rows = buildHomeProviderSettingRows(createSnapshot(), settings);

    assert.equal(rows[0]?.resolvedMemoryExtractionModel, "missing-model");
    assert.equal(rows[0]?.resolvedMemoryExtractionReasoningEffort, "high");
    assert.equal(rows[0]?.memoryExtractionSettings.timeoutSeconds, 240);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "未選択のmemory設定はSDK候補の既定モデルを創作せず保存する"
  // oracle = { type = "contract", ref = "Issue #879 discovered models and preserved execution selections" }
  // fault = "未選択modelやDepthをSDK候補から自動補完する"
  // observable = "memory設定modelとDepth"
  // observation_boundary = "public-boundary"
  // scope = "settings-unselected-model"
  // lifecycle = "permanent"
  // @end-test-value
  it("保存settingsはproviderごとの値を保持する", () => {
    const rows = buildHomeProviderSettingRows(createSnapshot(), createDefaultAppSettings());

    assert.deepEqual(buildNormalizedMemoryExtractionProviderSettings(rows), {
      codex: {
        model: "",
        reasoningEffort: "",
        outputTokensThreshold: 300000,
        timeoutSeconds: 180,
      },
    });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "App設定保存は候補外memory modelと独立した設定値を保持する"
  // oracle = { type = "contract", ref = "Issue #879 discovered models and preserved execution selections" }
  // fault = "設定保存時に候補外modelを消すか無関係な設定を上書きする"
  // observable = "保存用App設定のmodelとtoggle値"
  // observation_boundary = "public-boundary"
  // scope = "settings-persisted-model"
  // lifecycle = "permanent"
  // @end-test-value
  it("persisted settings はcatalog未収録の選択を保持する", () => {
    const draft = createDefaultAppSettings();
    draft.autoCollapseActionDockOnSend = false;
    draft.scrollToLatestOnSend = false;
    draft.memoryExtractionProviderSettings.codex = {
      model: "missing-model",
      reasoningEffort: "high",
      outputTokensThreshold: 333,
      timeoutSeconds: 240,
    };

    const rows = buildHomeProviderSettingRows(createSnapshot(), draft);
    const persisted = buildPersistedAppSettingsFromRows(draft, rows);

    assert.equal(persisted.autoCollapseActionDockOnSend, false);
    assert.equal(persisted.scrollToLatestOnSend, false);
    assert.deepEqual(persisted.memoryExtractionProviderSettings.codex, {
      model: "missing-model",
      reasoningEffort: "high",
      outputTokensThreshold: 333,
      timeoutSeconds: 240,
    });
  });

  it("memory file quota は Settings 表示用に MB と入力範囲へ変換する", () => {
    const settings = createDefaultAppSettings();
    settings.memoryFileQuotaBytes = 2 * 1024 * 1024 * 1024;

    assert.equal(getMemoryFileQuotaMegabytes(settings), 2048);
    assert.deepEqual(getMemoryFileQuotaMegabytesInputBounds(), {
      min: MEMORY_FILE_QUOTA_MIN_BYTES / 1024 / 1024,
      max: MEMORY_FILE_QUOTA_MAX_BYTES / 1024 / 1024,
    });
  });
});
