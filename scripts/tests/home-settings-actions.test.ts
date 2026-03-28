import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDefaultAppSettings } from "../../src/app-state.js";
import {
  exportHomeModelCatalog,
  importHomeModelCatalog,
  resetHomeDatabase,
  saveHomeSettings,
  type HomeSettingsApi,
} from "../../src/home-settings-actions.js";

function createApi(overrides?: Partial<HomeSettingsApi>): HomeSettingsApi {
  return {
    importModelCatalogFile: async () => null,
    exportModelCatalogFile: async () => null,
    updateAppSettings: async (settings) => settings,
    resetAppDatabase: async () => ({
      resetTargets: ["sessions", "auditLogs"],
      sessions: [],
      appSettings: createDefaultAppSettings(),
      modelCatalog: { revision: 1, providers: [] },
    }),
    ...overrides,
  };
}

describe("home-settings-actions", () => {
  it("import/export の feedback を返す", async () => {
    const api = createApi({
      importModelCatalogFile: async () => ({ revision: 3, providers: [] }),
      exportModelCatalogFile: async () => "tmp/catalog.json",
    });

    assert.equal(await importHomeModelCatalog(api), "model catalog revision 3 を読み込んだよ。");
    assert.equal(await exportHomeModelCatalog(api), "model catalog を保存したよ: tmp/catalog.json");
  });

  it("save は nextSettings と feedback を返す", async () => {
    const settings = createDefaultAppSettings();
    settings.systemPromptPrefix = "prefix";

    const result = await saveHomeSettings(createApi(), settings);

    assert.equal(result.nextSettings.systemPromptPrefix, "prefix");
    assert.equal(result.feedback, "設定を保存したよ。");
  });

  it("reset は confirm と result を扱う", async () => {
    const api = createApi();
    const result = await resetHomeDatabase({
      api,
      resetTargets: ["sessions"],
      confirm: () => true,
    });

    assert.equal(result.kind, "success");
    if (result.kind === "success") {
      assert.equal(result.feedback, "sessions / audit logs を初期状態へ戻したよ。characters は保持したよ。");
      assert.deepEqual(result.result.resetTargets, ["sessions", "auditLogs"]);
    }
  });

  it("reset target が空なら noop、confirm false なら canceled を返す", async () => {
    const api = createApi();

    const noopResult = await resetHomeDatabase({
      api,
      resetTargets: [],
      confirm: () => true,
    });
    assert.deepEqual(noopResult, {
      kind: "noop",
      feedback: "初期化対象を 1 つ以上選んでね。",
    });

    const canceledResult = await resetHomeDatabase({
      api,
      resetTargets: ["sessions"],
      confirm: () => false,
    });
    assert.deepEqual(canceledResult, {
      kind: "canceled",
    });
  });
});
