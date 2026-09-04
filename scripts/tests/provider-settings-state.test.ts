import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDefaultAppSettings,
  DEFAULT_GLOSSARY_PROACTIVE_CREATE_LIMIT,
  DEFAULT_BACKGROUND_TIMEOUT_SECONDS,
  DEFAULT_MATE_MEMORY_GENERATION_TRIGGER_INTERVAL_MINUTES,
  DEFAULT_MEMORY_EXTRACTION_OUTPUT_TOKENS_THRESHOLD,
  MEMORY_FILE_QUOTA_DEFAULT_BYTES,
  MEMORY_FILE_QUOTA_MAX_BYTES,
  MEMORY_FILE_QUOTA_MIN_BYTES,
  getMateMemoryGenerationSettings,
  normalizeAppSettings,
} from "../../src/provider-settings-state.js";

describe("provider-settings-state", () => {
  // @test-value v1
  // kind = "regression"
  // claim = "test declaration at line 18 preserves its observable contract"
  // oracle = { type = "contract", ref = "-18" }
  // failure_mode = "line 18 violates its expected output or boundary behavior"
  // scope = "provider-settings-state.test"
  // lifecycle = "permanent"
  // @end-test-value
  it("memory extraction threshold の default は 300000", () => {
    const settings = createDefaultAppSettings();

    assert.equal(DEFAULT_MEMORY_EXTRACTION_OUTPUT_TOKENS_THRESHOLD, 300000);
    assert.equal(settings.memoryExtractionProviderSettings.codex.outputTokensThreshold, 300000);
    assert.equal(DEFAULT_BACKGROUND_TIMEOUT_SECONDS, 180);
    assert.equal(settings.memoryExtractionProviderSettings.codex.timeoutSeconds, 180);
    assert.equal(settings.autoCollapseActionDockOnSend, true);
    assert.equal(settings.scrollToLatestOnSend, true);
    assert.deepEqual(settings.chatLayoutPreference, {
      header: "hidden",
      actionDock: "compact",
      sidePane: "none",
      priority: "side-pane-first",
    });
    assert.equal(settings.sessionTurnNotificationEnabled, true);
    assert.equal(settings.sessionTurnNotificationResponsePreviewEnabled, false);
    assert.equal(settings.memoryFileQuotaBytes, MEMORY_FILE_QUOTA_DEFAULT_BYTES);
    assert.equal(settings.glossaryProactiveCreateLimit, DEFAULT_GLOSSARY_PROACTIVE_CREATE_LIMIT);
  });

  // @test-value v1
  // kind = "regression"
  // claim = "test declaration at line 39 preserves its observable contract"
  // oracle = { type = "contract", ref = "-39" }
  // failure_mode = "line 39 violates its expected output or boundary behavior"
  // scope = "provider-settings-state.test"
  // lifecycle = "permanent"
  // @end-test-value
  it("glossary proactive create limitは0から100の整数だけを保持し、欠落・不正値をfallbackしない", () => {
    assert.equal(normalizeAppSettings({ glossaryProactiveCreateLimit: 0 }).glossaryProactiveCreateLimit, 0);
    assert.equal(normalizeAppSettings({ glossaryProactiveCreateLimit: 100 }).glossaryProactiveCreateLimit, 100);
    assert.equal(normalizeAppSettings({ glossaryProactiveCreateLimit: 5.5 }).glossaryProactiveCreateLimit, null);
    assert.equal(normalizeAppSettings({ glossaryProactiveCreateLimit: 101 }).glossaryProactiveCreateLimit, null);
    assert.equal(normalizeAppSettings({ glossaryProactiveCreateLimit: "5" }).glossaryProactiveCreateLimit, null);
    assert.equal(normalizeAppSettings({}).glossaryProactiveCreateLimit, null);
  });

  // @test-value v1
  // kind = "regression"
  // claim = "test declaration at line 48 preserves its observable contract"
  // oracle = { type = "contract", ref = "-48" }
  // failure_mode = "line 48 violates its expected output or boundary behavior"
  // scope = "provider-settings-state.test"
  // lifecycle = "permanent"
  // @end-test-value
  it("memory extraction threshold は normalize で 1000000 に clamp する", () => {
    const settings = normalizeAppSettings({
      memoryExtractionProviderSettings: {
        codex: {
          model: "gpt-5.4-mini",
          reasoningEffort: "low",
          outputTokensThreshold: 9000000,
          timeoutSeconds: 5000,
        },
      },
    });

    assert.equal(settings.memoryExtractionProviderSettings.codex.outputTokensThreshold, 1000000);
    assert.equal(settings.memoryExtractionProviderSettings.codex.timeoutSeconds, 1800);
  });

  // @test-value v1
  // kind = "regression"
  // claim = "test declaration at line 64 preserves its observable contract"
  // oracle = { type = "contract", ref = "-64" }
  // failure_mode = "line 64 violates its expected output or boundary behavior"
  // scope = "provider-settings-state.test"
  // lifecycle = "permanent"
  // @end-test-value
  it("mate memory generation settings の default と trigger interval は 60 分", () => {
    const settings = createDefaultAppSettings();

    assert.deepEqual(settings.mateMemoryGenerationSettings, {
      priorityList: [
        {
          provider: "codex",
          model: "gpt-5.4",
          reasoningEffort: "high",
          timeoutSeconds: DEFAULT_BACKGROUND_TIMEOUT_SECONDS,
        },
      ],
      triggerIntervalMinutes: DEFAULT_MATE_MEMORY_GENERATION_TRIGGER_INTERVAL_MINUTES,
    });
  });

  // @test-value v1
  // kind = "regression"
  // claim = "test declaration at line 80 preserves its observable contract"
  // oracle = { type = "contract", ref = "-80" }
  // failure_mode = "line 80 violates its expected output or boundary behavior"
  // scope = "provider-settings-state.test"
  // lifecycle = "permanent"
  // @end-test-value
  it("mate memory generation settings は normalize で clamp される", () => {
    const settings = normalizeAppSettings({
      mateMemoryGenerationSettings: {
        priorityList: [
          {
            provider: "copilot",
            model: "",
            reasoningEffort: "invalid",
            timeoutSeconds: 5,
          },
        ],
        triggerIntervalMinutes: -10,
      },
    });

    assert.equal(settings.mateMemoryGenerationSettings.priorityList[0].provider, "copilot");
    assert.equal(settings.mateMemoryGenerationSettings.priorityList[0].model, "gpt-5.4");
    assert.equal(settings.mateMemoryGenerationSettings.priorityList[0].reasoningEffort, "high");
    assert.equal(settings.mateMemoryGenerationSettings.priorityList[0].timeoutSeconds, 30);
    assert.equal(settings.mateMemoryGenerationSettings.triggerIntervalMinutes, 1);
  });

  // @test-value v1
  // kind = "regression"
  // claim = "test declaration at line 102 preserves its observable contract"
  // oracle = { type = "contract", ref = "-102" }
  // failure_mode = "line 102 violates its expected output or boundary behavior"
  // scope = "provider-settings-state.test"
  // lifecycle = "permanent"
  // @end-test-value
  it("mate memory generation settings は getter でも normalize される", () => {
    const settings = getMateMemoryGenerationSettings(normalizeAppSettings({
      mateMemoryGenerationSettings: {
        priorityList: [],
        triggerIntervalMinutes: 120,
      },
    }));

    assert.equal(settings.priorityList.length, 1);
    assert.equal(settings.priorityList[0].provider, "codex");
    assert.equal(settings.triggerIntervalMinutes, 120);
  });

  // @test-value v1
  // kind = "regression"
  // claim = "test declaration at line 115 preserves its observable contract"
  // oracle = { type = "contract", ref = "-115" }
  // failure_mode = "line 115 violates its expected output or boundary behavior"
  // scope = "provider-settings-state.test"
  // lifecycle = "permanent"
  // @end-test-value
  it("action dock auto close は normalize で boolean を保持し、未設定時は true に寄せる", () => {
    assert.equal(normalizeAppSettings({ autoCollapseActionDockOnSend: false }).autoCollapseActionDockOnSend, false);
    assert.equal(normalizeAppSettings({}).autoCollapseActionDockOnSend, true);
  });

  // @test-value v1
  // kind = "regression"
  // claim = "test declaration at line 120 preserves its observable contract"
  // oracle = { type = "contract", ref = "-120" }
  // failure_mode = "line 120 violates its expected output or boundary behavior"
  // scope = "provider-settings-state.test"
  // lifecycle = "permanent"
  // @end-test-value
  it("send scroll は normalize で boolean を保持し、未設定時は true に寄せる", () => {
    assert.equal(normalizeAppSettings({ scrollToLatestOnSend: false }).scrollToLatestOnSend, false);
    assert.equal(normalizeAppSettings({}).scrollToLatestOnSend, true);
  });

  // @test-value v1
  // kind = "regression"
  // claim = "test declaration at line 125 preserves its observable contract"
  // oracle = { type = "contract", ref = "-125" }
  // failure_mode = "line 125 violates its expected output or boundary behavior"
  // scope = "provider-settings-state.test"
  // lifecycle = "permanent"
  // @end-test-value
  it("chat layout preference は項目ごとに canonical enum へ normalize する", () => {
    assert.deepEqual(normalizeAppSettings({
      chatLayoutPreference: {
        header: "visible",
        actionDock: "expanded",
        sidePane: "context",
        priority: "dock-first",
      },
    }).chatLayoutPreference, {
      header: "visible",
      actionDock: "expanded",
      sidePane: "context",
      priority: "dock-first",
    });
    assert.deepEqual(normalizeAppSettings({
      chatLayoutPreference: { header: "invalid", actionDock: false, sidePane: "left" },
    }).chatLayoutPreference, {
      header: "hidden",
      actionDock: "compact",
      sidePane: "none",
      priority: "side-pane-first",
    });
  });

  // @test-value v1
  // kind = "regression"
  // claim = "test declaration at line 149 preserves its observable contract"
  // oracle = { type = "contract", ref = "-149" }
  // failure_mode = "line 149 violates its expected output or boundary behavior"
  // scope = "provider-settings-state.test"
  // lifecycle = "permanent"
  // @end-test-value
  it("launch at login は default false で boolean を保持する", () => {
    assert.equal(createDefaultAppSettings().launchAtLoginEnabled, false);
    assert.equal(normalizeAppSettings({ launchAtLoginEnabled: true }).launchAtLoginEnabled, true);
    assert.equal(normalizeAppSettings({ launchAtLoginEnabled: "true" }).launchAtLoginEnabled, false);
  });

  // @test-value v1
  // kind = "regression"
  // claim = "test declaration at line 155 preserves its observable contract"
  // oracle = { type = "contract", ref = "-155" }
  // failure_mode = "line 155 violates its expected output or boundary behavior"
  // scope = "provider-settings-state.test"
  // lifecycle = "permanent"
  // @end-test-value
  it("Session turn notification は default true で boolean を保持する", () => {
    assert.equal(createDefaultAppSettings().sessionTurnNotificationEnabled, true);
    assert.equal(normalizeAppSettings({ sessionTurnNotificationEnabled: false }).sessionTurnNotificationEnabled, false);
    assert.equal(normalizeAppSettings({ sessionTurnNotificationEnabled: "false" }).sessionTurnNotificationEnabled, true);
  });

  // @test-value v1
  // kind = "regression"
  // claim = "test declaration at line 161 preserves its observable contract"
  // oracle = { type = "contract", ref = "-161" }
  // failure_mode = "line 161 violates its expected output or boundary behavior"
  // scope = "provider-settings-state.test"
  // lifecycle = "permanent"
  // @end-test-value
  it("Session turn notification response preview は default false で boolean を保持する", () => {
    assert.equal(createDefaultAppSettings().sessionTurnNotificationResponsePreviewEnabled, false);
    assert.equal(
      normalizeAppSettings({ sessionTurnNotificationResponsePreviewEnabled: true })
        .sessionTurnNotificationResponsePreviewEnabled,
      true,
    );
    assert.equal(
      normalizeAppSettings({ sessionTurnNotificationResponsePreviewEnabled: "true" })
        .sessionTurnNotificationResponsePreviewEnabled,
      false,
    );
  });

  // @test-value v1
  // kind = "regression"
  // claim = "test declaration at line 175 preserves its observable contract"
  // oracle = { type = "contract", ref = "-175" }
  // failure_mode = "line 175 violates its expected output or boundary behavior"
  // scope = "provider-settings-state.test"
  // lifecycle = "permanent"
  // @end-test-value
  it("memory file quota は normalize で min/max に clamp する", () => {
    assert.equal(normalizeAppSettings({ memoryFileQuotaBytes: 1 }).memoryFileQuotaBytes, MEMORY_FILE_QUOTA_MIN_BYTES);
    assert.equal(
      normalizeAppSettings({ memoryFileQuotaBytes: MEMORY_FILE_QUOTA_MAX_BYTES * 2 }).memoryFileQuotaBytes,
      MEMORY_FILE_QUOTA_MAX_BYTES,
    );
    assert.equal(
      normalizeAppSettings({ memoryFileQuotaBytes: "1024" }).memoryFileQuotaBytes,
      MEMORY_FILE_QUOTA_DEFAULT_BYTES,
    );
  });

  // @test-value v1
  // kind = "regression"
  // claim = "test declaration at line 187 preserves its observable contract"
  // oracle = { type = "contract", ref = "-187" }
  // failure_mode = "line 187 violates its expected output or boundary behavior"
  // scope = "provider-settings-state.test"
  // lifecycle = "permanent"
  // @end-test-value
  it("user microcopy catalog は複数 copy を保持し、空 slot は default に戻す", () => {
    const settings = normalizeAppSettings({
      userMicrocopyCatalog: {
        "chat.pending.response_waiting": ["応答待機中", "出力待機中"],
        "dock.status.preparing": [],
      },
    });

    assert.deepEqual(settings.userMicrocopyCatalog["chat.pending.response_waiting"], ["応答待機中", "出力待機中"]);
    assert.deepEqual(settings.userMicrocopyCatalog["dock.status.preparing"], ["応答を準備中"]);
  });
});
