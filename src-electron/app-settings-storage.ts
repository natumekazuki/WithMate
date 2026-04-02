import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createDefaultAppSettings, normalizeAppSettings, type AppSettings } from "../src/provider-settings-state.js";

const DEFAULT_APP_SETTINGS: AppSettings = createDefaultAppSettings();
const SYSTEM_PROMPT_PREFIX_KEY = "system_prompt_prefix";
const MEMORY_GENERATION_ENABLED_KEY = "memory_generation_enabled";
const AUTO_COLLAPSE_ACTION_DOCK_ON_SEND_KEY = "auto_collapse_action_dock_on_send";
const CHARACTER_REFLECTION_TRIGGER_SETTINGS_KEY = "character_reflection_trigger_settings_json";
const CODING_PROVIDER_SETTINGS_KEY = "coding_provider_settings_json";
const MEMORY_EXTRACTION_PROVIDER_SETTINGS_KEY = "memory_extraction_provider_settings_json";
const CHARACTER_REFLECTION_PROVIDER_SETTINGS_KEY = "character_reflection_provider_settings_json";

type AppSettingRow = {
  setting_key: string;
  setting_value: string;
};

export class AppSettingsStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.ensureDefaults();
  }

  private ensureDefaults(): void {
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO app_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO NOTHING
      `)
      .run(SYSTEM_PROMPT_PREFIX_KEY, DEFAULT_APP_SETTINGS.systemPromptPrefix, updatedAt);
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
      .run(
        CHARACTER_REFLECTION_TRIGGER_SETTINGS_KEY,
        JSON.stringify(DEFAULT_APP_SETTINGS.characterReflectionTriggerSettings),
        updatedAt,
      );
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
        CHARACTER_REFLECTION_PROVIDER_SETTINGS_KEY,
        JSON.stringify(DEFAULT_APP_SETTINGS.characterReflectionProviderSettings),
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
    for (const row of rows) {
      if (row.setting_key === SYSTEM_PROMPT_PREFIX_KEY) {
        settings.systemPromptPrefix = row.setting_value;
        continue;
      }
      if (row.setting_key === MEMORY_GENERATION_ENABLED_KEY) {
        settings.memoryGenerationEnabled = row.setting_value === "true";
        continue;
      }
      if (row.setting_key === AUTO_COLLAPSE_ACTION_DOCK_ON_SEND_KEY) {
        settings.autoCollapseActionDockOnSend = row.setting_value === "true";
        continue;
      }
    }

    const characterReflectionTriggerSettingsJson = rows.find(
      (row) => row.setting_key === CHARACTER_REFLECTION_TRIGGER_SETTINGS_KEY,
    )?.setting_value;
    if (characterReflectionTriggerSettingsJson) {
      try {
        settings.characterReflectionTriggerSettings = normalizeAppSettings({
          ...settings,
          characterReflectionTriggerSettings: JSON.parse(characterReflectionTriggerSettingsJson),
        }).characterReflectionTriggerSettings;
      } catch {
        settings.characterReflectionTriggerSettings = createDefaultAppSettings().characterReflectionTriggerSettings;
      }
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

    const characterReflectionProviderSettingsJson = rows.find(
      (row) => row.setting_key === CHARACTER_REFLECTION_PROVIDER_SETTINGS_KEY,
    )?.setting_value;
    if (characterReflectionProviderSettingsJson) {
      try {
        settings.characterReflectionProviderSettings = normalizeAppSettings({
          ...settings,
          characterReflectionProviderSettings: JSON.parse(characterReflectionProviderSettingsJson),
        }).characterReflectionProviderSettings;
      } catch {
        settings.characterReflectionProviderSettings = createDefaultAppSettings().characterReflectionProviderSettings;
      }
    }

    return normalizeAppSettings(settings);
  }

  updateSettings(nextSettings: AppSettings): AppSettings {
    const normalized = normalizeAppSettings(nextSettings);
    const updatedAt = new Date().toISOString();

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
        .run(SYSTEM_PROMPT_PREFIX_KEY, normalized.systemPromptPrefix, updatedAt);
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
        .run(
          CHARACTER_REFLECTION_TRIGGER_SETTINGS_KEY,
          JSON.stringify(normalized.characterReflectionTriggerSettings),
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
          CHARACTER_REFLECTION_PROVIDER_SETTINGS_KEY,
          JSON.stringify(normalized.characterReflectionProviderSettings),
          updatedAt,
        );
      this.db.exec("COMMIT");
      return normalized;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  resetSettings(): AppSettings {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db.exec("DELETE FROM app_settings;");
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
