import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDefaultAppSettings,
  DEFAULT_BACKGROUND_TIMEOUT_SECONDS,
  DEFAULT_MATE_MEMORY_GENERATION_TRIGGER_INTERVAL_MINUTES,
  DEFAULT_MEMORY_EXTRACTION_OUTPUT_TOKENS_THRESHOLD,
  getMateMemoryGenerationSettings,
  normalizeAppSettings,
} from "../../src/provider-settings-state.js";

describe("provider-settings-state", () => {
  it("memory extraction threshold の default は 300000", () => {
    const settings = createDefaultAppSettings();

    assert.equal(DEFAULT_MEMORY_EXTRACTION_OUTPUT_TOKENS_THRESHOLD, 300000);
    assert.equal(settings.memoryExtractionProviderSettings.codex.outputTokensThreshold, 300000);
    assert.equal(DEFAULT_BACKGROUND_TIMEOUT_SECONDS, 180);
    assert.equal(settings.memoryExtractionProviderSettings.codex.timeoutSeconds, 180);
    assert.equal(settings.characterReflectionProviderSettings.codex.timeoutSeconds, 180);
    assert.equal(settings.autoCollapseActionDockOnSend, true);
    assert.deepEqual(settings.characterReflectionTriggerSettings, {
      cooldownSeconds: 120,
      charDeltaThreshold: 400,
      messageDeltaThreshold: 2,
    });
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

  it("character reflection trigger settings は normalize で clamp する", () => {
    const settings = normalizeAppSettings({
      characterReflectionTriggerSettings: {
        cooldownSeconds: 5,
        charDeltaThreshold: 0,
        messageDeltaThreshold: 999,
      },
    });

    assert.deepEqual(settings.characterReflectionTriggerSettings, {
      cooldownSeconds: 30,
      charDeltaThreshold: 1,
      messageDeltaThreshold: 100,
    });
  });

  it("character reflection provider timeout は normalize で clamp する", () => {
    const settings = normalizeAppSettings({
      characterReflectionProviderSettings: {
        codex: {
          model: "gpt-5.4-mini",
          reasoningEffort: "medium",
          timeoutSeconds: 5,
        },
      },
    });

    assert.equal(settings.characterReflectionProviderSettings.codex.timeoutSeconds, 30);
  });
});
