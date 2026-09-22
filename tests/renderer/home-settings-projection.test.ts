import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildHomeSettingsProjection } from "../../src/settings/settings-projection.js";

describe("home-settings-projection", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "Settings projectionはloading中のwindow ready、選択reset targets、disabled target、reset可否を一貫して派生する"
  // oracle = { type = "contract", ref = "src/settings/settings-projection.ts: buildHomeSettingsProjection" }
  // fault = "loading中にSettings windowをready扱いするか、選択対象のlabelとdisabled stateを誤って表示する"
  // observable = "settingsWindowReady、selectedResetTargetsDescription、canResetDatabase、resetTargetItems"
  // observation_boundary = "public-boundary"
  // scope = "home-settings-projection reset state"
  // lifecycle = "permanent"
  // @end-test-value
  it("loading と reset target 派生状態を返す", () => {
    const projection = buildHomeSettingsProjection({
      settingsDraftLoaded: true,
      modelCatalogLoadSettled: false,
      resetDatabaseTargets: ["sessions"],
      resettingDatabase: false,
    });

    assert.equal(projection.settingsWindowReady, false);
    assert.equal(projection.selectedResetTargetsDescription, "Sessions / Audit logs");
    assert.equal(projection.canResetDatabase, true);
    assert.deepEqual(projection.resetTargetItems.find((item) => item.target === "auditLogs"), {
      target: "auditLogs",
      checked: false,
      disabled: true,
    });
  });

  it("settings draft が hydrate されるまでは ready にしない", () => {
    const projection = buildHomeSettingsProjection({
      settingsDraftLoaded: false,
      modelCatalogLoadSettled: true,
      resetDatabaseTargets: ["appSettings"],
      resettingDatabase: false,
    });

    assert.equal(projection.settingsWindowReady, false);
  });

  it("model catalog load が失敗して settled した後は SettingsContent を描画できる", () => {
    const projection = buildHomeSettingsProjection({
      settingsDraftLoaded: true,
      modelCatalogLoadSettled: true,
      resetDatabaseTargets: ["appSettings"],
      resettingDatabase: false,
    });

    assert.equal(projection.settingsWindowReady, true);
  });
});
