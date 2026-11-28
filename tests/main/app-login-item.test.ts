import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLaunchAtLoginSetting,
  resolveAppUserModelId,
  shouldLaunchInBackground,
  WITHMATE_BACKGROUND_LAUNCH_ARG,
  WITHMATE_APP_USER_MODEL_ID,
} from "../../src-electron/app/app-login-item.js";

/** 起動引数にバックグラウンド指定を加えたときだけ、通常起動と区別されることを確認する。 */
test("shouldLaunchInBackground は background launch arg を検出する", () => {
  assert.equal(shouldLaunchInBackground(["withmate"]), false);
  assert.equal(
    shouldLaunchInBackground(["withmate", WITHMATE_BACKGROUND_LAUNCH_ARG]),
    true,
  );
});

/** 配布版には固定の製品 ID、開発版には実行ファイルのパスが使われることを確認する。 */
test("resolveAppUserModelId は packaged app だけに製品 ID を割り当てる", () => {
  assert.equal(
    resolveAppUserModelId({
      isPackaged: true,
      execPath: "C:\\Program Files\\WithMate\\WithMate.exe",
    }),
    WITHMATE_APP_USER_MODEL_ID,
  );
  assert.equal(
    resolveAppUserModelId({
      isPackaged: false,
      execPath: "C:\\workspace\\node_modules\\electron\\dist\\electron.exe",
    }),
    "C:\\workspace\\node_modules\\electron\\dist\\electron.exe",
  );
});

/** 配布版のログイン時起動を有効にすると、バックグラウンド指定付きの登録が一度だけ行われることを確認する。 */
test("applyLaunchAtLoginSetting は有効時に background arg を登録する", () => {
  const calls: unknown[] = [];

  applyLaunchAtLoginSetting(
    {
      /** OS に登録される起動設定を実際には適用せず記録する。 */
      setLoginItemSettings(settings) {
        calls.push(settings);
      },
    },
    true,
    true,
  );

  assert.deepEqual(calls, [
    {
      openAtLogin: true,
      args: [WITHMATE_BACKGROUND_LAUNCH_ARG],
    },
  ]);
});

/** ログイン時起動を無効にすると、OS への解除要求にバックグラウンド引数が残らないことを確認する。 */
test("applyLaunchAtLoginSetting は無効時に login item を解除する", () => {
  const calls: unknown[] = [];

  applyLaunchAtLoginSetting(
    {
      /** OS へ渡される解除要求の設定値を記録する。 */
      setLoginItemSettings(settings) {
        calls.push(settings);
      },
    },
    false,
    true,
  );

  assert.deepEqual(calls, [
    {
      openAtLogin: false,
      args: [],
    },
  ]);
});

/** 開発版では有効化・無効化いずれの操作でも OS のログイン項目を変更しない。 */
test("applyLaunchAtLoginSetting は unpackaged app から OS の login item を変更しない", () => {
  const calls: unknown[] = [];
  const app = {
    /** 開発版から誤って設定の書き込みが行われた場合に検出する。 */
    setLoginItemSettings(settings: unknown) {
      calls.push(settings);
    },
  };

  applyLaunchAtLoginSetting(app, true, false);
  applyLaunchAtLoginSetting(app, false, false);

  assert.deepEqual(calls, []);
});
