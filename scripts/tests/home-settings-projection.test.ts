import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildHomeSettingsProjection } from "../../src/home-settings-projection.js";

describe("home-settings-projection", () => {
  it("loading と reset target 派生状態を返す", () => {
    const projection = buildHomeSettingsProjection({
      settingsDraftLoaded: true,
      modelCatalogLoaded: false,
      memoryManagementLoaded: true,
      resetDatabaseTargets: ["sessions"],
      resettingDatabase: false,
    });

    assert.equal(projection.settingsWindowReady, false);
    assert.equal(projection.selectedResetTargetsDescription, "sessions / audit logs");
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
      modelCatalogLoaded: true,
      memoryManagementLoaded: true,
      resetDatabaseTargets: ["appSettings"],
      resettingDatabase: false,
    });

    assert.equal(projection.settingsWindowReady, false);
  });
});
