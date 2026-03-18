import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createDefaultAppSettings, normalizeAppSettings, type AppSettings } from "../src/app-state.js";

const DEFAULT_APP_SETTINGS: AppSettings = createDefaultAppSettings();
const SYSTEM_PROMPT_PREFIX_KEY = "system_prompt_prefix";
const CODING_PROVIDER_SETTINGS_KEY = "coding_provider_settings_json";

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
      .run(CODING_PROVIDER_SETTINGS_KEY, JSON.stringify(DEFAULT_APP_SETTINGS.codingProviderSettings), updatedAt);
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
        .run(CODING_PROVIDER_SETTINGS_KEY, JSON.stringify(normalized.codingProviderSettings), updatedAt);
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
