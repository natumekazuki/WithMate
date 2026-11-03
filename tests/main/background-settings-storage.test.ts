import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { AppSettingsStorage } from "../../src-electron/app/app-settings-storage.js";
import { createDefaultAppSettings, normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { resolveBackgroundInstructionText } from "../../src-shared/settings/background-settings.js";

// @test-value v2
// kind = "contract"
// claim = "背景用途の選択・空本文・頻度はSQLite再open後も保持され、未設定本文だけpresetを使う"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md#current-scope" }
// fault = "新設定を保存しないか、明示した空本文をpresetへ置換する"
// observable = "getSettingsの再読込値と本文resolverの返却値"
// observation_boundary = "public-boundary"
// scope = "background-settings-persistence"
// lifecycle = "permanent"
// distinction = "型検査はJSON保存漏れや空本文の意味喪失を検出しない"
// @end-test-value
it("背景設定を保存して再読込し未設定と空本文を区別する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "background-settings-"));
  const dbPath = path.join(directory, "settings.db");
  let storage = new AppSettingsStorage(dbPath);
  try {
    const initial = storage.getSettings();
    assert.deepEqual(initial.backgroundExecutionSettings, { "character-memory": {}, "target-memory": {}, affect: {} });
    assert.deepEqual(initial.memoryRecordingFrequencies, { "character-memory": { turnCount: 5, idleMinutes: 5 }, "target-memory": { turnCount: 5, idleMinutes: 5 } });
    const next = {
      ...initial,
      backgroundExecutionSettings: {
        ...initial.backgroundExecutionSettings,
        "character-memory": { selection: { providerId: "claude", modelId: "real-model-id" }, instructionText: "" },
        affect: { instructionText: "Appraise this event." },
      },
      memoryRecordingFrequencies: { ...initial.memoryRecordingFrequencies, "target-memory": { turnCount: 8, idleMinutes: 2.5 } },
    };
    storage.updateSettings(next);
    storage.close();
    storage = new AppSettingsStorage(dbPath);
    const loaded = storage.getSettings();
    assert.deepEqual(loaded.backgroundExecutionSettings, next.backgroundExecutionSettings);
    assert.deepEqual(loaded.memoryRecordingFrequencies, next.memoryRecordingFrequencies);
    assert.equal(resolveBackgroundInstructionText(loaded.backgroundExecutionSettings["character-memory"], "preset"), "");
    assert.equal(resolveBackgroundInstructionText(loaded.backgroundExecutionSettings["target-memory"], "preset"), "preset");
    assert.deepEqual(loaded.codingProviderSettings, initial.codingProviderSettings);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "背景設定の明示不正値は保存と読込で拒否され、欠落値だけ既定化する"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md#current-scope" }
// fault = "空選択や不正頻度を既定値に救済して保存または読込に成功する"
// observable = "normalizeAppSettingsとstorage保存/読込のthrow、および不正保存後の保持値"
// observation_boundary = "public-boundary"
// scope = "background-settings-validation"
// lifecycle = "permanent"
// distinction = "unknown JSON入力とSQLite破損値は型検査で検証できない"
// @end-test-value
it("背景設定の不正値を保存と読込で拒否する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "background-settings-invalid-"));
  const dbPath = path.join(directory, "settings.db");
  const storage = new AppSettingsStorage(dbPath);
  try {
    const initial = storage.getSettings();
    for (const value of [null, { "character-memory": { selection: { providerId: "claude", modelId: "" } } }, { affect: { instructionText: null } }]) {
      assert.throws(() => normalizeAppSettings({ backgroundExecutionSettings: value }));
    }
    for (const frequency of [{ turnCount: 0, idleMinutes: 5 }, { turnCount: 1.5, idleMinutes: 5 }, { turnCount: 5, idleMinutes: 0 }, { turnCount: 5, idleMinutes: Number.NaN }]) {
      assert.throws(() => storage.updateSettings({ ...initial, memoryRecordingFrequencies: { ...initial.memoryRecordingFrequencies, "character-memory": frequency } }));
      assert.deepEqual(storage.getSettings(), initial);
    }
    assert.deepEqual(normalizeAppSettings({}).backgroundExecutionSettings, createDefaultAppSettings().backgroundExecutionSettings);
    const db = new DatabaseSync(dbPath);
    try {
      const insert = db.prepare("INSERT OR REPLACE INTO app_settings(setting_key,setting_value,updated_at) VALUES (?, ?, ?)");
      for (const value of ["not-json", "null", JSON.stringify({ "target-memory": { turnCount: -1, idleMinutes: 5 } })]) {
        insert.run("memory_recording_frequencies_json", value, new Date().toISOString());
        assert.throws(() => storage.getSettings());
      }
    } finally { db.close(); }
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
