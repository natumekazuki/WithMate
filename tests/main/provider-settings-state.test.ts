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
} from "../../src-shared/settings/provider-settings-state.js";

describe("provider-settings-state", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "default AppSettings の chat layout は priority なしの canonical shape を持つ"
  // oracle = { type = "contract", ref = "Default app settings" }
  // fault = "削除済み priority が default settings に復活する"
  // observable = "createDefaultAppSettings().chatLayoutPreference"
  // observation_boundary = "public-boundary"
  // scope = "default-chat-layout-settings"
  // lifecycle = "permanent"
  // impact = "廃止設定が保存・IPC payload へ伝播する"
  // distinction = "default provider settings と chat layout shape を確認する"
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
    });
    assert.equal(settings.sessionTurnNotificationEnabled, true);
    assert.equal(settings.sessionTurnNotificationResponsePreviewEnabled, false);
    assert.equal(settings.memoryFileQuotaBytes, MEMORY_FILE_QUOTA_DEFAULT_BYTES);
    assert.equal(settings.glossaryProactiveCreateLimit, DEFAULT_GLOSSARY_PROACTIVE_CREATE_LIMIT);
  });

  it("glossary proactive create limitは0から100の整数だけを保持し、欠落・不正値をfallbackしない", () => {
    assert.equal(normalizeAppSettings({ glossaryProactiveCreateLimit: 0 }).glossaryProactiveCreateLimit, 0);
    assert.equal(normalizeAppSettings({ glossaryProactiveCreateLimit: 100 }).glossaryProactiveCreateLimit, 100);
    assert.equal(normalizeAppSettings({ glossaryProactiveCreateLimit: 5.5 }).glossaryProactiveCreateLimit, null);
    assert.equal(normalizeAppSettings({ glossaryProactiveCreateLimit: 101 }).glossaryProactiveCreateLimit, null);
    assert.equal(normalizeAppSettings({ glossaryProactiveCreateLimit: "5" }).glossaryProactiveCreateLimit, null);
    assert.equal(normalizeAppSettings({}).glossaryProactiveCreateLimit, null);
  });

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

  it("action dock auto close は normalize で boolean を保持し、未設定時は true に寄せる", () => {
    assert.equal(normalizeAppSettings({ autoCollapseActionDockOnSend: false }).autoCollapseActionDockOnSend, false);
    assert.equal(normalizeAppSettings({}).autoCollapseActionDockOnSend, true);
  });

  it("send scroll は normalize で boolean を保持し、未設定時は true に寄せる", () => {
    assert.equal(normalizeAppSettings({ scrollToLatestOnSend: false }).scrollToLatestOnSend, false);
    assert.equal(normalizeAppSettings({}).scrollToLatestOnSend, true);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "chat layout preference normalize は priority なしの canonical shape を返す"
  // oracle = { type = "contract", ref = "AppSettings normalization" }
  // fault = "入力の廃止済み priority が normalized settings に残る"
  // observable = "normalizeAppSettings の chatLayoutPreference"
  // observation_boundary = "public-boundary"
  // scope = "normalized-chat-layout-settings"
  // lifecycle = "permanent"
  // impact = "廃止設定が settings projection に混入する"
  // distinction = "valid/invalid side pane の normalize と field shape を確認する"
  // @end-test-value
  it("chat layout preference は項目ごとに canonical enum へ normalize する", () => {
    assert.deepEqual(normalizeAppSettings({
      chatLayoutPreference: {
        header: "visible",
        actionDock: "expanded",
        sidePane: "context",
      },
    }).chatLayoutPreference, {
      header: "visible",
      actionDock: "expanded",
      sidePane: "context",
    });
    assert.deepEqual(normalizeAppSettings({
      chatLayoutPreference: { header: "invalid", actionDock: false, sidePane: "left" },
    }).chatLayoutPreference, {
      header: "hidden",
      actionDock: "compact",
      sidePane: "none",
    });
  });

  it("launch at login は default false で boolean を保持する", () => {
    assert.equal(createDefaultAppSettings().launchAtLoginEnabled, false);
    assert.equal(normalizeAppSettings({ launchAtLoginEnabled: true }).launchAtLoginEnabled, true);
    assert.equal(normalizeAppSettings({ launchAtLoginEnabled: "true" }).launchAtLoginEnabled, false);
  });

  it("Session turn notification は default true で boolean を保持する", () => {
    assert.equal(createDefaultAppSettings().sessionTurnNotificationEnabled, true);
    assert.equal(normalizeAppSettings({ sessionTurnNotificationEnabled: false }).sessionTurnNotificationEnabled, false);
    assert.equal(normalizeAppSettings({ sessionTurnNotificationEnabled: "false" }).sessionTurnNotificationEnabled, true);
  });

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

  // @test-value v2
  // kind = "invariant"
  // claim = "foreground prompt context の個別設定は既定で有効になり、明示した boolean 値だけを保持する"
  // oracle = { type = "contract", ref = "Prompt context settings" }
  // fault = "既存利用者の prompt 注入が欠落するか、設定値の無効入力で意図しない注入状態になる"
  // observable = "createDefaultAppSettings と normalizeAppSettings の prompt context fields"
  // observation_boundary = "public-boundary"
  // scope = "prompt-context-settings-normalization"
  // lifecycle = "permanent"
  // impact = "設定保存・IPC・provider prompt 合成へ渡る toggle の既定状態が変わる"
  // distinction = "既存の boolean settings の normalize と異なる prompt context 4項目を一括で確認する"
  // @end-test-value
  it("foreground prompt context は既定有効で、false と無効値を正しく normalize する", () => {
    const defaults = createDefaultAppSettings();

    assert.equal(defaults.characterDefinitionEnabled, true);
    assert.equal(defaults.characterAffectContextEnabled, true);
    assert.equal(defaults.conversationTimingEnabled, true);
    assert.equal(defaults.toolCallPresenceEnabled, true);
    const normalizedOff = normalizeAppSettings({
      characterDefinitionEnabled: false,
      characterAffectContextEnabled: false,
      conversationTimingEnabled: false,
      toolCallPresenceEnabled: false,
    });
    assert.equal(normalizedOff.characterDefinitionEnabled, false);
    assert.equal(normalizedOff.characterAffectContextEnabled, false);
    assert.equal(normalizedOff.conversationTimingEnabled, false);
    assert.equal(normalizedOff.toolCallPresenceEnabled, false);
    const normalizedMixed = normalizeAppSettings({
      characterDefinitionEnabled: true,
      characterAffectContextEnabled: true,
      conversationTimingEnabled: false,
      toolCallPresenceEnabled: true,
    });

    assert.equal(normalizedMixed.characterDefinitionEnabled, true);
    assert.equal(normalizedMixed.characterAffectContextEnabled, true);
    assert.equal(normalizedMixed.conversationTimingEnabled, false);
    assert.equal(normalizedMixed.toolCallPresenceEnabled, true);
    const normalizedInvalid = normalizeAppSettings({
      characterDefinitionEnabled: "false",
      characterAffectContextEnabled: "false",
      conversationTimingEnabled: null,
      toolCallPresenceEnabled: 0,
    });

    assert.equal(normalizedInvalid.characterDefinitionEnabled, true);
    assert.equal(normalizedInvalid.characterAffectContextEnabled, true);
    assert.equal(normalizedInvalid.conversationTimingEnabled, true);
    assert.equal(normalizedInvalid.toolCallPresenceEnabled, true);

    const normalizedMissing = normalizeAppSettings({});
    assert.equal(normalizedMissing.characterDefinitionEnabled, true);
    assert.equal(normalizedMissing.characterAffectContextEnabled, true);
    assert.equal(normalizedMissing.conversationTimingEnabled, true);
    assert.equal(normalizedMissing.toolCallPresenceEnabled, true);
  });

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

});
