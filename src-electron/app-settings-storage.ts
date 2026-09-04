import type { DatabaseSync } from "node:sqlite";

import {
  isChatActionDockMode,
  isChatHeaderVisibility,
  isChatLayoutPriority,
  type ChatLayoutPreferenceUpdate,
} from "../src/chat/chat-layout-preference.js";
import { createDefaultAppSettings, normalizeAppSettings, type AppSettings } from "../src/provider-settings-state.js";
import { isSessionSidePane, type SessionSidePane } from "../src/session-side-pane.js";
import { CREATE_APP_SETTINGS_TABLE_SQL } from "./database-schema-v1.js";
import { openAppDatabase } from "./sqlite-connection.js";

const DEFAULT_APP_SETTINGS: AppSettings = createDefaultAppSettings();
const MEMORY_GENERATION_ENABLED_KEY = "memory_generation_enabled";
const LAUNCH_AT_LOGIN_ENABLED_KEY = "launch_at_login_enabled";
const SESSION_TURN_NOTIFICATION_ENABLED_KEY = "session_turn_notification_enabled";
const SESSION_TURN_NOTIFICATION_RESPONSE_PREVIEW_ENABLED_KEY =
  "session_turn_notification_response_preview_enabled";
const AUTO_COLLAPSE_ACTION_DOCK_ON_SEND_KEY = "auto_collapse_action_dock_on_send";
const SCROLL_TO_LATEST_ON_SEND_KEY = "scroll_to_latest_on_send";
const SESSION_HEADER_VISIBILITY_KEY = "session_header_visibility";
const SESSION_ACTION_DOCK_PRESENTATION_KEY = "session_action_dock_presentation";
const SESSION_SIDE_PANE_KEY = "session_side_pane";
const SESSION_LAYOUT_PRIORITY_KEY = "session_layout_priority";
const LEGACY_SESSION_RIGHT_PANE_VISIBLE_KEY = "session_right_pane_visible";
const KEYBOARD_SHORTCUTS_KEY = "keyboard_shortcuts_json";
const MEMORY_FILE_QUOTA_BYTES_KEY = "memory_file_quota_bytes";
const GLOSSARY_PROACTIVE_CREATE_LIMIT_KEY = "glossary_proactive_create_limit";
const GLOSSARY_PROACTIVE_CREATE_LIMIT_INITIALIZED_KEY = "glossary_proactive_create_limit_initialized";
const CODING_PROVIDER_SETTINGS_KEY = "coding_provider_settings_json";
const MEMORY_EXTRACTION_PROVIDER_SETTINGS_KEY = "memory_extraction_provider_settings_json";
const MATE_MEMORY_GENERATION_SETTINGS_KEY = "mate_memory_generation_settings_json";
const USER_MICROCOPY_CATALOG_KEY = "user_microcopy_catalog_json";

type AppSettingRow = {
  setting_key: string;
  setting_value: string;
};

export class AppSettingsStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    this.db.exec(CREATE_APP_SETTINGS_TABLE_SQL);
    this.ensureSessionSidePaneDefault();
    this.ensureDefaults();
  }

  private ensureSessionSidePaneDefault(): void {
    const canonicalRow = this.db
      .prepare("SELECT setting_value FROM app_settings WHERE setting_key = ?")
      .get(SESSION_SIDE_PANE_KEY) as { setting_value: string } | undefined;
    if (canonicalRow) {
      return;
    }

    const legacyRow = this.db
      .prepare("SELECT setting_value FROM app_settings WHERE setting_key = ?")
      .get(LEGACY_SESSION_RIGHT_PANE_VISIBLE_KEY) as { setting_value: string } | undefined;
    const initialSidePane: SessionSidePane = legacyRow?.setting_value === "true" ? "context" : "none";
    this.db
      .prepare(`
        INSERT INTO app_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
      `)
      .run(SESSION_SIDE_PANE_KEY, initialSidePane, new Date().toISOString());
  }

  private ensureDefaults(): void {
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO app_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO NOTHING
      `)
      .run(MEMORY_GENERATION_ENABLED_KEY, String(DEFAULT_APP_SETTINGS.memoryGenerationEnabled), updatedAt);
    this.db
      .prepare(`
        INSERT INTO app_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO NOTHING
      `)
      .run(LAUNCH_AT_LOGIN_ENABLED_KEY, String(DEFAULT_APP_SETTINGS.launchAtLoginEnabled), updatedAt);
    this.db
      .prepare(`
        INSERT INTO app_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO NOTHING
      `)
      .run(
        SESSION_TURN_NOTIFICATION_ENABLED_KEY,
        String(DEFAULT_APP_SETTINGS.sessionTurnNotificationEnabled),
        updatedAt,
      );
    this.db
      .prepare(`
        INSERT INTO app_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO NOTHING
      `)
      .run(
        SESSION_TURN_NOTIFICATION_RESPONSE_PREVIEW_ENABLED_KEY,
        String(DEFAULT_APP_SETTINGS.sessionTurnNotificationResponsePreviewEnabled),
        updatedAt,
      );
    this.db
      .prepare(`
        INSERT INTO app_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO NOTHING
      `)
      .run(
        AUTO_COLLAPSE_ACTION_DOCK_ON_SEND_KEY,
        String(DEFAULT_APP_SETTINGS.autoCollapseActionDockOnSend),
        updatedAt,
      );
    this.db
      .prepare(`
        INSERT INTO app_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO NOTHING
      `)
      .run(SCROLL_TO_LATEST_ON_SEND_KEY, String(DEFAULT_APP_SETTINGS.scrollToLatestOnSend), updatedAt);
    this.db
      .prepare(`
        INSERT INTO app_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO NOTHING
      `)
      .run(SESSION_HEADER_VISIBILITY_KEY, DEFAULT_APP_SETTINGS.chatLayoutPreference.header, updatedAt);
    this.db
      .prepare(`
        INSERT INTO app_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO NOTHING
      `)
      .run(
        SESSION_ACTION_DOCK_PRESENTATION_KEY,
        DEFAULT_APP_SETTINGS.chatLayoutPreference.actionDock,
        updatedAt,
      );
    this.db
      .prepare(`
        INSERT INTO app_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO NOTHING
      `)
      .run(SESSION_LAYOUT_PRIORITY_KEY, DEFAULT_APP_SETTINGS.chatLayoutPreference.priority, updatedAt);
    this.db
      .prepare(`
        INSERT INTO app_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO NOTHING
      `)
      .run(KEYBOARD_SHORTCUTS_KEY, JSON.stringify(DEFAULT_APP_SETTINGS.keyboardShortcuts), updatedAt);
    this.db
      .prepare(`
        INSERT INTO app_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO NOTHING
      `)
      .run(MEMORY_FILE_QUOTA_BYTES_KEY, String(DEFAULT_APP_SETTINGS.memoryFileQuotaBytes), updatedAt);
    const glossaryLimitInitialized = this.db
      .prepare("SELECT 1 FROM app_settings WHERE setting_key = ?")
      .get(GLOSSARY_PROACTIVE_CREATE_LIMIT_INITIALIZED_KEY);
    if (!glossaryLimitInitialized) {
      this.db
        .prepare(`
          INSERT INTO app_settings (setting_key, setting_value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(setting_key) DO NOTHING
        `)
        .run(
          GLOSSARY_PROACTIVE_CREATE_LIMIT_KEY,
          String(DEFAULT_APP_SETTINGS.glossaryProactiveCreateLimit),
          updatedAt,
        );
      this.db
        .prepare(`
          INSERT INTO app_settings (setting_key, setting_value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(setting_key) DO NOTHING
        `)
        .run(GLOSSARY_PROACTIVE_CREATE_LIMIT_INITIALIZED_KEY, "true", updatedAt);
    }
    this.db
      .prepare(`
        INSERT INTO app_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO NOTHING
      `)
      .run(CODING_PROVIDER_SETTINGS_KEY, JSON.stringify(DEFAULT_APP_SETTINGS.codingProviderSettings), updatedAt);
    this.db
      .prepare(`
        INSERT INTO app_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO NOTHING
      `)
      .run(
        MEMORY_EXTRACTION_PROVIDER_SETTINGS_KEY,
        JSON.stringify(DEFAULT_APP_SETTINGS.memoryExtractionProviderSettings),
        updatedAt,
      );
    this.db
      .prepare(`
        INSERT INTO app_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO NOTHING
      `)
      .run(
        MATE_MEMORY_GENERATION_SETTINGS_KEY,
        JSON.stringify(DEFAULT_APP_SETTINGS.mateMemoryGenerationSettings),
        updatedAt,
      );
    this.db
      .prepare(`
        INSERT INTO app_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO NOTHING
      `)
      .run(
        USER_MICROCOPY_CATALOG_KEY,
        JSON.stringify(DEFAULT_APP_SETTINGS.userMicrocopyCatalog),
        updatedAt,
      );
  }

  getSettings(): AppSettings {
    const rows = this.db
      .prepare(`
        SELECT setting_key, setting_value
        FROM app_settings
      `)
      .all() as AppSettingRow[];

    const settings = createDefaultAppSettings();
    let glossaryProactiveCreateLimitFound = false;
    for (const row of rows) {
      if (row.setting_key === MEMORY_GENERATION_ENABLED_KEY) {
        settings.memoryGenerationEnabled = row.setting_value === "true";
        continue;
      }
      if (row.setting_key === LAUNCH_AT_LOGIN_ENABLED_KEY) {
        settings.launchAtLoginEnabled = row.setting_value === "true";
        continue;
      }
      if (row.setting_key === SESSION_TURN_NOTIFICATION_ENABLED_KEY) {
        if (row.setting_value === "true" || row.setting_value === "false") {
          settings.sessionTurnNotificationEnabled = row.setting_value === "true";
        }
        continue;
      }
      if (row.setting_key === SESSION_TURN_NOTIFICATION_RESPONSE_PREVIEW_ENABLED_KEY) {
        if (row.setting_value === "true" || row.setting_value === "false") {
          settings.sessionTurnNotificationResponsePreviewEnabled = row.setting_value === "true";
        }
        continue;
      }
      if (row.setting_key === AUTO_COLLAPSE_ACTION_DOCK_ON_SEND_KEY) {
        settings.autoCollapseActionDockOnSend = row.setting_value === "true";
        continue;
      }
      if (row.setting_key === SCROLL_TO_LATEST_ON_SEND_KEY) {
        if (row.setting_value === "true" || row.setting_value === "false") {
          settings.scrollToLatestOnSend = row.setting_value === "true";
        }
        continue;
      }
      if (row.setting_key === SESSION_HEADER_VISIBILITY_KEY) {
        settings.chatLayoutPreference.header = isChatHeaderVisibility(row.setting_value)
          ? row.setting_value
          : "hidden";
        continue;
      }
      if (row.setting_key === SESSION_ACTION_DOCK_PRESENTATION_KEY) {
        settings.chatLayoutPreference.actionDock = isChatActionDockMode(row.setting_value)
          ? row.setting_value
          : "compact";
        continue;
      }
      if (row.setting_key === SESSION_SIDE_PANE_KEY) {
        settings.chatLayoutPreference.sidePane = isSessionSidePane(row.setting_value) ? row.setting_value : "none";
        continue;
      }
      if (row.setting_key === SESSION_LAYOUT_PRIORITY_KEY) {
        settings.chatLayoutPreference.priority = isChatLayoutPriority(row.setting_value)
          ? row.setting_value
          : "side-pane-first";
        continue;
      }
      if (row.setting_key === MEMORY_FILE_QUOTA_BYTES_KEY) {
        settings.memoryFileQuotaBytes = Number(row.setting_value);
        continue;
      }
      if (row.setting_key === GLOSSARY_PROACTIVE_CREATE_LIMIT_KEY) {
        glossaryProactiveCreateLimitFound = true;
        settings.glossaryProactiveCreateLimit = /^\d+$/.test(row.setting_value)
          ? Number(row.setting_value)
          : null;
        continue;
      }
    }
    if (!glossaryProactiveCreateLimitFound) {
      settings.glossaryProactiveCreateLimit = null;
    }

    const providerSettingsJson = rows.find((row) => row.setting_key === CODING_PROVIDER_SETTINGS_KEY)?.setting_value;
    if (providerSettingsJson) {
      try {
        settings.codingProviderSettings = normalizeAppSettings({
          ...settings,
          codingProviderSettings: JSON.parse(providerSettingsJson),
        }).codingProviderSettings;
      } catch {
        settings.codingProviderSettings = createDefaultAppSettings().codingProviderSettings;
      }
    }

    const memoryExtractionProviderSettingsJson = rows.find(
      (row) => row.setting_key === MEMORY_EXTRACTION_PROVIDER_SETTINGS_KEY,
    )?.setting_value;
    if (memoryExtractionProviderSettingsJson) {
      try {
        settings.memoryExtractionProviderSettings = normalizeAppSettings({
          ...settings,
          memoryExtractionProviderSettings: JSON.parse(memoryExtractionProviderSettingsJson),
        }).memoryExtractionProviderSettings;
      } catch {
        settings.memoryExtractionProviderSettings = createDefaultAppSettings().memoryExtractionProviderSettings;
      }
    }

    const mateMemoryGenerationSettingsJson = rows.find(
      (row) => row.setting_key === MATE_MEMORY_GENERATION_SETTINGS_KEY,
    )?.setting_value;
    if (mateMemoryGenerationSettingsJson) {
      try {
        settings.mateMemoryGenerationSettings = normalizeAppSettings({
          ...settings,
          mateMemoryGenerationSettings: JSON.parse(mateMemoryGenerationSettingsJson),
        }).mateMemoryGenerationSettings;
      } catch {
        settings.mateMemoryGenerationSettings = createDefaultAppSettings().mateMemoryGenerationSettings;
      }
    }

    const keyboardShortcutsJson = rows.find((row) => row.setting_key === KEYBOARD_SHORTCUTS_KEY)?.setting_value;
    if (keyboardShortcutsJson) {
      try {
        settings.keyboardShortcuts = normalizeAppSettings({
          ...settings,
          keyboardShortcuts: JSON.parse(keyboardShortcutsJson),
        }).keyboardShortcuts;
      } catch {
        settings.keyboardShortcuts = createDefaultAppSettings().keyboardShortcuts;
      }
    }

    const userMicrocopyCatalogJson = rows.find((row) => row.setting_key === USER_MICROCOPY_CATALOG_KEY)?.setting_value;
    if (userMicrocopyCatalogJson) {
      try {
        settings.userMicrocopyCatalog = normalizeAppSettings({
          ...settings,
          userMicrocopyCatalog: JSON.parse(userMicrocopyCatalogJson),
        }).userMicrocopyCatalog;
      } catch {
        settings.userMicrocopyCatalog = createDefaultAppSettings().userMicrocopyCatalog;
      }
    }

    return normalizeAppSettings(settings);
  }

  updateSettings(nextSettings: AppSettings): AppSettings {
    const normalized = normalizeAppSettings(nextSettings);
    const updatedAt = new Date().toISOString();

    // Chat layout preferences have their own write path so stale full-settings snapshots cannot overwrite them.
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db
        .prepare(`
          INSERT INTO app_settings (setting_key, setting_value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = excluded.updated_at
        `)
        .run(MEMORY_GENERATION_ENABLED_KEY, String(normalized.memoryGenerationEnabled), updatedAt);
      this.db
        .prepare(`
          INSERT INTO app_settings (setting_key, setting_value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = excluded.updated_at
        `)
        .run(LAUNCH_AT_LOGIN_ENABLED_KEY, String(normalized.launchAtLoginEnabled), updatedAt);
      this.db
        .prepare(`
          INSERT INTO app_settings (setting_key, setting_value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = excluded.updated_at
        `)
        .run(
          SESSION_TURN_NOTIFICATION_ENABLED_KEY,
          String(normalized.sessionTurnNotificationEnabled),
          updatedAt,
        );
      this.db
        .prepare(`
          INSERT INTO app_settings (setting_key, setting_value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = excluded.updated_at
        `)
        .run(
          SESSION_TURN_NOTIFICATION_RESPONSE_PREVIEW_ENABLED_KEY,
          String(normalized.sessionTurnNotificationResponsePreviewEnabled),
          updatedAt,
        );
      this.db
        .prepare(`
          INSERT INTO app_settings (setting_key, setting_value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = excluded.updated_at
        `)
        .run(
          AUTO_COLLAPSE_ACTION_DOCK_ON_SEND_KEY,
          String(normalized.autoCollapseActionDockOnSend),
          updatedAt,
        );
      this.db
        .prepare(`
          INSERT INTO app_settings (setting_key, setting_value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = excluded.updated_at
        `)
        .run(SCROLL_TO_LATEST_ON_SEND_KEY, String(normalized.scrollToLatestOnSend), updatedAt);
      this.db
        .prepare(`
          INSERT INTO app_settings (setting_key, setting_value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = excluded.updated_at
        `)
        .run(KEYBOARD_SHORTCUTS_KEY, JSON.stringify(normalized.keyboardShortcuts), updatedAt);
      this.db
        .prepare(`
          INSERT INTO app_settings (setting_key, setting_value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = excluded.updated_at
        `)
        .run(MEMORY_FILE_QUOTA_BYTES_KEY, String(normalized.memoryFileQuotaBytes), updatedAt);
      this.db
        .prepare(`
          INSERT INTO app_settings (setting_key, setting_value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = excluded.updated_at
        `)
        .run(
          GLOSSARY_PROACTIVE_CREATE_LIMIT_KEY,
          normalized.glossaryProactiveCreateLimit === null
            ? ""
            : String(normalized.glossaryProactiveCreateLimit),
          updatedAt,
        );
      this.db
        .prepare(`
          INSERT INTO app_settings (setting_key, setting_value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = excluded.updated_at
        `)
        .run(CODING_PROVIDER_SETTINGS_KEY, JSON.stringify(normalized.codingProviderSettings), updatedAt);
      this.db
        .prepare(`
          INSERT INTO app_settings (setting_key, setting_value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = excluded.updated_at
        `)
        .run(
          MEMORY_EXTRACTION_PROVIDER_SETTINGS_KEY,
          JSON.stringify(normalized.memoryExtractionProviderSettings),
          updatedAt,
        );
      this.db
        .prepare(`
          INSERT INTO app_settings (setting_key, setting_value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = excluded.updated_at
        `)
        .run(
          MATE_MEMORY_GENERATION_SETTINGS_KEY,
          JSON.stringify(normalized.mateMemoryGenerationSettings),
          updatedAt,
        );
      this.db
        .prepare(`
          INSERT INTO app_settings (setting_key, setting_value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = excluded.updated_at
        `)
        .run(
          USER_MICROCOPY_CATALOG_KEY,
          JSON.stringify(normalized.userMicrocopyCatalog),
          updatedAt,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return this.getSettings();
  }

  updateChatLayoutPreference(update: ChatLayoutPreferenceUpdate): AppSettings {
    const [settingKey, settingValue] = (() => {
      if (update.target === "header") {
        return [SESSION_HEADER_VISIBILITY_KEY, update.value] as const;
      }
      if (update.target === "actionDock") {
        return [SESSION_ACTION_DOCK_PRESENTATION_KEY, update.value] as const;
      }
      if (update.target === "sidePane") {
        return [SESSION_SIDE_PANE_KEY, update.value] as const;
      }
      return [SESSION_LAYOUT_PRIORITY_KEY, update.value] as const;
    })();
    this.db
      .prepare(`
        INSERT INTO app_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO UPDATE SET
          setting_value = excluded.setting_value,
          updated_at = excluded.updated_at
      `)
      .run(settingKey, settingValue, new Date().toISOString());
    return this.getSettings();
  }

  resetSettings(): AppSettings {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db.exec("DELETE FROM app_settings;");
      this.ensureSessionSidePaneDefault();
      this.ensureDefaults();
      this.db.exec("COMMIT");
      return this.getSettings();
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
