import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { AppSettingsStorage } from "../../src-electron/app-settings-storage.js";

describe("AppSettingsStorage", () => {
  it("provider settings を保存して再読込できる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-app-settings-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const storage = new AppSettingsStorage(dbPath);
      const updated = storage.updateSettings({
        systemPromptPrefix: "prefix",
        providerSettings: {
          codex: {
            enabled: false,
            apiKey: "codex-key",
          },
          copilot: {
            enabled: true,
            apiKey: "copilot-key",
          },
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
});
