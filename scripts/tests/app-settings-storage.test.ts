import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import { AppSettingsStorage } from "../../src-electron/app-settings-storage.js";

describe("AppSettingsStorage", () => {
  it("coding provider settings を canonical key で保存して再読込できる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-app-settings-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const storage = new AppSettingsStorage(dbPath);
      const updated = storage.updateSettings({
        systemPromptPrefix: "prefix",
        memoryGenerationEnabled: false,
        autoCollapseActionDockOnSend: false,
        codingProviderSettings: {
          codex: {
            enabled: false,
            apiKey: "codex-key",
            skillRootPath: "C:/skills/codex",
          },
          copilot: {
            enabled: true,
            apiKey: "copilot-key",
            skillRootPath: "C:/skills/copilot",
          },
        },
        memoryExtractionProviderSettings: {
          codex: {
            model: "gpt-5.4-mini",
            reasoningEffort: "medium",
            outputTokensThreshold: 240,
            timeoutSeconds: 240,
          },
          copilot: {
            model: "gpt-5",
            reasoningEffort: "low",
            outputTokensThreshold: 180,
            timeoutSeconds: 360,
          },
        },
        characterReflectionProviderSettings: {
          codex: {
            model: "gpt-5.4-mini",
            reasoningEffort: "medium",
            timeoutSeconds: 210,
          },
          copilot: {
            model: "gpt-5",
            reasoningEffort: "low",
            timeoutSeconds: 420,
          },
        },
        mateMemoryGenerationSettings: {
          priorityList: [
            {
              provider: "copilot",
              model: "gpt-5.4",
              reasoningEffort: "high",
              timeoutSeconds: 300,
            },
            {
              provider: "codex",
              model: "gpt-5.4-mini",
              reasoningEffort: "medium",
              timeoutSeconds: 180,
            },
          ],
          triggerIntervalMinutes: 90,
        },
      });
      storage.close();

      const reopened = new AppSettingsStorage(dbPath);
      const loaded = reopened.getSettings();
      reopened.close();

      assert.deepEqual(loaded, updated);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("resetSettings で app settings を canonical default へ戻し、再読込後も維持される", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-app-settings-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const storage = new AppSettingsStorage(dbPath);
      storage.updateSettings({
        systemPromptPrefix: "custom-prefix",
        memoryGenerationEnabled: false,
        autoCollapseActionDockOnSend: false,
        codingProviderSettings: {
          codex: {
            enabled: false,
            apiKey: "custom-key",
            skillRootPath: "C:/skills/codex",
          },
          copilot: {
            enabled: true,
            apiKey: "copilot-key",
            skillRootPath: "C:/skills/copilot",
          },
        },
        memoryExtractionProviderSettings: {
          codex: {
            model: "gpt-5.4-mini",
            reasoningEffort: "medium",
            outputTokensThreshold: 240,
            timeoutSeconds: 240,
          },
          copilot: {
            model: "gpt-5",
            reasoningEffort: "low",
            outputTokensThreshold: 180,
            timeoutSeconds: 360,
          },
        },
        characterReflectionProviderSettings: {
          codex: {
            model: "gpt-5.4-mini",
            reasoningEffort: "medium",
            timeoutSeconds: 210,
          },
          copilot: {
            model: "gpt-5",
            reasoningEffort: "low",
            timeoutSeconds: 420,
          },
        },
        mateMemoryGenerationSettings: {
          priorityList: [
            {
              provider: "copilot",
              model: "gpt-5.4",
              reasoningEffort: "high",
              timeoutSeconds: 300,
            },
          ],
          triggerIntervalMinutes: 90,
        },
      });

      const reset = storage.resetSettings();
      storage.close();

      const reopened = new AppSettingsStorage(dbPath);
      const loaded = reopened.getSettings();
      reopened.close();

      assert.deepEqual(reset, createDefaultAppSettings());
      assert.deepEqual(loaded, createDefaultAppSettings());
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
