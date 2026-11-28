import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildHomeSettingsProjection } from "../../src/settings/settings-projection.js";

/** 設定画面の表示可否と、データベース初期化対象の表示状態を、それぞれの入力から導出する。 */
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
  /** モデル一覧が読み込み中で画面全体が未準備でも、選択済みの初期化項目に対応するラベルと操作可否を返す。 */
  it("loading と reset target 派生状態を返す", () => {
    const projection = buildHomeSettingsProjection({
      settingsDraftLoaded: true,
      modelCatalogLoadSettled: false,
      resetDatabaseTargets: ["sessions"],
      resettingDatabase: false,
    });

    assert.equal(projection.settingsWindowReady, false);
    assert.equal(projection.selectedResetTargetsDescription, "Sessions");
    assert.equal(projection.canResetDatabase, true);
    assert.deepEqual(
      projection.resetTargetItems.find((item) => item.target === "sessions"),
      {
        target: "sessions",
        checked: true,
        disabled: false,
      },
    );
  });

  /** モデル一覧の取得が終了していても、設定の下書きをまだ読み込んでいなければ画面を準備済みにしない。 */
  it("settings draft が hydrate されるまでは ready にしない", () => {
    const projection = buildHomeSettingsProjection({
      settingsDraftLoaded: false,
      modelCatalogLoadSettled: true,
      resetDatabaseTargets: ["appSettings"],
      resettingDatabase: false,
    });

    assert.equal(projection.settingsWindowReady, false);
  });

  /** 設定の下書きが揃っていれば、モデル一覧取得の成功ではなく完了を条件にし、失敗後も設定画面を表示できる。 */
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
