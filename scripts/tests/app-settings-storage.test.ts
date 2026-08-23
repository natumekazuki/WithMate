import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  MEMORY_FILE_QUOTA_DEFAULT_BYTES,
  createDefaultAppSettings,
} from "../../src/provider-settings-state.js";
import { AppSettingsStorage } from "../../src-electron/app-settings-storage.js";

describe("AppSettingsStorage", () => {
  it("保存済みの旧 path error 既定値を読み込み時に現在の既定値へ移行する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-app-settings-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const initialStorage = new AppSettingsStorage(dbPath);
      initialStorage.close();

      const legacyDatabase = new DatabaseSync(dbPath);
      const legacyCatalog = createDefaultAppSettings().userMicrocopyCatalog;
      legacyCatalog["composer.error.path_not_found"] = ["指定したパスが見つかりません: {path}"];
      legacyDatabase
        .prepare("UPDATE app_settings SET setting_value = ? WHERE setting_key = ?")
        .run(JSON.stringify(legacyCatalog), "user_microcopy_catalog");
      legacyDatabase.close();

      const migratedStorage = new AppSettingsStorage(dbPath);
      assert.deepEqual(
        migratedStorage.getSettings().userMicrocopyCatalog["composer.error.path_not_found"],
        ["Path not found: {path}"],
      );
      migratedStorage.close();
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("legacy right pane visibility を canonical side pane へ一度だけ移行する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-app-settings-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const initialStorage = new AppSettingsStorage(dbPath);
      initialStorage.close();

      const legacyDatabase = new DatabaseSync(dbPath);
      legacyDatabase.prepare("DELETE FROM app_settings WHERE setting_key = ?").run("session_side_pane");
      legacyDatabase
        .prepare(`
          INSERT INTO app_settings (setting_key, setting_value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value
        `)
        .run("session_right_pane_visible", "true", new Date().toISOString());
      legacyDatabase.close();

      const migratedStorage = new AppSettingsStorage(dbPath);
      assert.equal(migratedStorage.getSettings().chatLayoutPreference.sidePane, "context");
      migratedStorage.updateChatLayoutPreference({ target: "sidePane", value: "files" });
      migratedStorage.close();

      const staleLegacyDatabase = new DatabaseSync(dbPath);
      staleLegacyDatabase
        .prepare("UPDATE app_settings SET setting_value = ? WHERE setting_key = ?")
        .run("false", "session_right_pane_visible");
      staleLegacyDatabase.close();

      const reopenedStorage = new AppSettingsStorage(dbPath);
      assert.equal(reopenedStorage.getSettings().chatLayoutPreference.sidePane, "files");
      reopenedStorage.close();
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("Session turn notification setting の欠損値と不正値は既定の有効へ戻す", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-app-settings-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const storage = new AppSettingsStorage(dbPath);
      storage.close();

      const invalidDatabase = new DatabaseSync(dbPath);
      invalidDatabase
        .prepare(`
          UPDATE app_settings
          SET setting_value = ?
          WHERE setting_key = ?
        `)
        .run("invalid", "session_turn_notification_enabled");
      invalidDatabase.close();

      const invalidValueStorage = new AppSettingsStorage(dbPath);
      assert.equal(invalidValueStorage.getSettings().sessionTurnNotificationEnabled, true);
      invalidValueStorage.close();

      const missingDatabase = new DatabaseSync(dbPath);
      missingDatabase
        .prepare("DELETE FROM app_settings WHERE setting_key = ?")
        .run("session_turn_notification_enabled");
      missingDatabase.close();

      const missingValueStorage = new AppSettingsStorage(dbPath);
      assert.equal(missingValueStorage.getSettings().sessionTurnNotificationEnabled, true);
      missingValueStorage.close();
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("Session turn notification response preview setting の欠損値と不正値は既定の無効へ戻す", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-app-settings-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const storage = new AppSettingsStorage(dbPath);
      storage.close();

      const invalidDatabase = new DatabaseSync(dbPath);
      invalidDatabase
        .prepare(`
          UPDATE app_settings
          SET setting_value = ?
          WHERE setting_key = ?
        `)
        .run("invalid", "session_turn_notification_response_preview_enabled");
      invalidDatabase.close();

      const invalidValueStorage = new AppSettingsStorage(dbPath);
      assert.equal(invalidValueStorage.getSettings().sessionTurnNotificationResponsePreviewEnabled, false);
      invalidValueStorage.close();

      const missingDatabase = new DatabaseSync(dbPath);
      missingDatabase
        .prepare("DELETE FROM app_settings WHERE setting_key = ?")
        .run("session_turn_notification_response_preview_enabled");
      missingDatabase.close();

      const missingValueStorage = new AppSettingsStorage(dbPath);
      assert.equal(missingValueStorage.getSettings().sessionTurnNotificationResponsePreviewEnabled, false);
      missingValueStorage.close();
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("send scroll setting の欠損値と不正値は既定の有効へ戻す", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-app-settings-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const storage = new AppSettingsStorage(dbPath);
      storage.close();

      const invalidDatabase = new DatabaseSync(dbPath);
      invalidDatabase
        .prepare("UPDATE app_settings SET setting_value = ? WHERE setting_key = ?")
        .run("invalid", "scroll_to_latest_on_send");
      invalidDatabase.close();

      const invalidValueStorage = new AppSettingsStorage(dbPath);
      assert.equal(invalidValueStorage.getSettings().scrollToLatestOnSend, true);
      invalidValueStorage.close();

      const missingDatabase = new DatabaseSync(dbPath);
      missingDatabase
        .prepare("DELETE FROM app_settings WHERE setting_key = ?")
        .run("scroll_to_latest_on_send");
      missingDatabase.close();

      const missingValueStorage = new AppSettingsStorage(dbPath);
      assert.equal(missingValueStorage.getSettings().scrollToLatestOnSend, true);
      missingValueStorage.close();
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("coding provider settings を canonical key で保存して再読込できる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-app-settings-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const storage = new AppSettingsStorage(dbPath);
      storage.updateChatLayoutPreference({ target: "sidePane", value: "context" });
      const updated = storage.updateSettings({
        ...createDefaultAppSettings(),
        memoryGenerationEnabled: false,
        launchAtLoginEnabled: true,
        sessionTurnNotificationEnabled: false,
        sessionTurnNotificationResponsePreviewEnabled: true,
        autoCollapseActionDockOnSend: false,
        scrollToLatestOnSend: false,
        chatLayoutPreference: {
          header: "visible",
          actionDock: "expanded",
          sidePane: "context",
          priority: "dock-first",
        },
        keyboardShortcuts: {
          overrides: {
            "session.message.toggle-collapse": {
              windows: { key: "x", ctrlKey: true, shiftKey: true },
            },
          },
        },
        memoryFileQuotaBytes: 2 * MEMORY_FILE_QUOTA_DEFAULT_BYTES,
        userMicrocopyCatalog: {
          ...createDefaultAppSettings().userMicrocopyCatalog,
          "chat.pending.response_waiting": ["応答待機中", "出力待機中"],
        },
        codingProviderSettings: {
          codex: {
            enabled: false,
            apiKey: "codex-key",
            skillRootPath: "C:/skills/codex",
            skillRelativePath: ".codex/skills",
            instructionRelativePath: "AGENTS.md",
          },
          copilot: {
            enabled: true,
            apiKey: "copilot-key",
            skillRootPath: "C:/skills/copilot",
            skillRelativePath: "skills",
            instructionRelativePath: "copilot-instructions.md",
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

  it("keyboard shortcutの無効なplatform overrideだけを除外して有効値を再loadできる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-app-settings-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const storage = new AppSettingsStorage(dbPath);
      storage.close();

      const persistedDatabase = new DatabaseSync(dbPath);
      persistedDatabase
        .prepare("UPDATE app_settings SET setting_value = ? WHERE setting_key = ?")
        .run(JSON.stringify({
          overrides: {
            "session.message.toggle-collapse": {
              windows: { key: "x" },
              linux: { key: "x", altKey: true, shiftKey: true },
              macos: { key: "x", metaKey: true, shiftKey: true },
            },
            "session.composer.submit": {
              windows: { key: "Enter", altKey: true },
              linux: { key: "Enter", ctrlKey: true, altKey: true },
              macos: { key: "Enter", altKey: true },
            },
            "session.message.find": {
              windows: { key: "g", ctrlKey: true },
            },
            "unknown.command": {
              windows: { key: "x", ctrlKey: true, shiftKey: true },
            },
          },
        }), "keyboard_shortcuts_json");
      persistedDatabase.close();

      const reopened = new AppSettingsStorage(dbPath);
      const loaded = reopened.getSettings();
      reopened.close();

      assert.deepEqual(loaded.keyboardShortcuts.overrides, {
        "session.message.toggle-collapse": {
          linux: { key: "x", altKey: true, shiftKey: true },
          macos: { key: "x", metaKey: true, shiftKey: true },
        },
        "session.composer.submit": {
          windows: { key: "Enter", altKey: true },
          macos: { key: "Enter", altKey: true },
        },
      });
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("chat layout の対象1項目だけを更新し、他の app settings と再読込結果を維持する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-app-settings-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const storage = new AppSettingsStorage(dbPath);
      assert.deepEqual(storage.getSettings().chatLayoutPreference, {
        header: "hidden",
        actionDock: "compact",
        sidePane: "none",
        priority: "side-pane-first",
      });

      storage.updateSettings({
        ...createDefaultAppSettings(),
        memoryGenerationEnabled: false,
      });
      storage.updateChatLayoutPreference({ target: "header", value: "visible" });
      storage.updateChatLayoutPreference({ target: "actionDock", value: "expanded" });
      storage.updateChatLayoutPreference({ target: "sidePane", value: "files" });
      const updated = storage.updateChatLayoutPreference({ target: "priority", value: "dock-first" });
      storage.close();

      const reopened = new AppSettingsStorage(dbPath);
      const loaded = reopened.getSettings();
      reopened.close();

      assert.deepEqual(updated.chatLayoutPreference, {
        header: "visible",
        actionDock: "expanded",
        sidePane: "files",
        priority: "dock-first",
      });
      assert.equal(updated.memoryGenerationEnabled, false);
      assert.deepEqual(loaded.chatLayoutPreference, updated.chatLayoutPreference);
      assert.equal(loaded.memoryGenerationEnabled, false);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("chat layout 専用更新は指定された storage key だけを UPSERT する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-app-settings-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    const storage = new AppSettingsStorage(dbPath);
    const directDatabase = new DatabaseSync(dbPath);

    try {
      directDatabase
        .prepare("UPDATE app_settings SET setting_value = ? WHERE setting_key = ?")
        .run("sentinel-action-dock", "session_action_dock_presentation");
      directDatabase
        .prepare("UPDATE app_settings SET setting_value = ? WHERE setting_key = ?")
        .run("sentinel-side-pane", "session_side_pane");
      directDatabase
        .prepare("UPDATE app_settings SET setting_value = ? WHERE setting_key = ?")
        .run("sentinel-priority", "session_layout_priority");

      const updated = storage.updateChatLayoutPreference({ target: "header", value: "visible" });
      const rows = directDatabase
        .prepare(`
          SELECT setting_key, setting_value
          FROM app_settings
          WHERE setting_key IN (?, ?, ?, ?)
          ORDER BY setting_key
        `)
        .all(
          "session_header_visibility",
          "session_action_dock_presentation",
          "session_side_pane",
          "session_layout_priority",
        ) as Array<{
          setting_key: string;
          setting_value: string;
        }>;

      assert.deepEqual(rows.map((row) => ({ ...row })), [
        { setting_key: "session_action_dock_presentation", setting_value: "sentinel-action-dock" },
        { setting_key: "session_header_visibility", setting_value: "visible" },
        { setting_key: "session_layout_priority", setting_value: "sentinel-priority" },
        { setting_key: "session_side_pane", setting_value: "sentinel-side-pane" },
      ]);
      assert.deepEqual(updated.chatLayoutPreference, {
        header: "visible",
        actionDock: "compact",
        sidePane: "none",
        priority: "side-pane-first",
      });
    } finally {
      directDatabase.close();
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("通常の settings 更新は先に保存された chat layout を stale snapshot で巻き戻さない", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-app-settings-"));
    const dbPath = path.join(tempDirectory, "withmate.db");

    try {
      const storage = new AppSettingsStorage(dbPath);
      const staleSettings = storage.getSettings();

      storage.updateChatLayoutPreference({ target: "header", value: "visible" });
      storage.updateChatLayoutPreference({ target: "actionDock", value: "expanded" });
      storage.updateChatLayoutPreference({ target: "sidePane", value: "context" });
      storage.updateChatLayoutPreference({ target: "priority", value: "dock-first" });
      const updated = storage.updateSettings({
        ...staleSettings,
        launchAtLoginEnabled: true,
      });
      storage.close();

      const reopened = new AppSettingsStorage(dbPath);
      const loaded = reopened.getSettings();
      reopened.close();

      assert.equal(updated.launchAtLoginEnabled, true);
      assert.deepEqual(updated.chatLayoutPreference, {
        header: "visible",
        actionDock: "expanded",
        sidePane: "context",
        priority: "dock-first",
      });
      assert.deepEqual(loaded.chatLayoutPreference, updated.chatLayoutPreference);
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
        ...createDefaultAppSettings(),
        memoryGenerationEnabled: false,
        launchAtLoginEnabled: true,
        sessionTurnNotificationEnabled: false,
        sessionTurnNotificationResponsePreviewEnabled: true,
        autoCollapseActionDockOnSend: false,
        chatLayoutPreference: {
          header: "visible",
          actionDock: "expanded",
          sidePane: "context",
        },
        userMicrocopyCatalog: {
          ...createDefaultAppSettings().userMicrocopyCatalog,
          "dock.status.preparing": ["準備中"],
        },
        codingProviderSettings: {
          codex: {
            enabled: false,
            apiKey: "custom-key",
            skillRootPath: "C:/skills/codex",
            skillRelativePath: ".codex/skills",
            instructionRelativePath: "AGENTS.md",
          },
          copilot: {
            enabled: true,
            apiKey: "copilot-key",
            skillRootPath: "C:/skills/copilot",
            skillRelativePath: "skills",
            instructionRelativePath: "copilot-instructions.md",
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
      storage.updateChatLayoutPreference({ target: "sidePane", value: "files" });
      storage.updateChatLayoutPreference({ target: "priority", value: "dock-first" });

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
