import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AppSettings } from "../src/app-state.js";

const DEFAULT_APP_SETTINGS: AppSettings = {
  systemPromptPrefix: "",
};

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
    this.db
      .prepare(`
        INSERT INTO app_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO NOTHING
      `)
      .run("system_prompt_prefix", DEFAULT_APP_SETTINGS.systemPromptPrefix, new Date().toISOString());
  }

  getSettings(): AppSettings {
    const rows = this.db
      .prepare(`
        SELECT setting_key, setting_value
        FROM app_settings
      `)
      .all() as AppSettingRow[];

    const settings = { ...DEFAULT_APP_SETTINGS };
    for (const row of rows) {
      if (row.setting_key === "system_prompt_prefix") {
        settings.systemPromptPrefix = row.setting_value;
      }
    }

    return settings;
  }

  updateSettings(nextSettings: AppSettings): AppSettings {
    const normalized: AppSettings = {
      systemPromptPrefix: nextSettings.systemPromptPrefix ?? "",
    };
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
        .run("system_prompt_prefix", normalized.systemPromptPrefix, updatedAt);
      this.db.exec("COMMIT");
      return normalized;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
