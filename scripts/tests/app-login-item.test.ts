import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLaunchAtLoginSetting,
  resolveAppUserModelId,
  shouldLaunchInBackground,
  WITHMATE_BACKGROUND_LAUNCH_ARG,
  WITHMATE_APP_USER_MODEL_ID,
} from "../../src-electron/app-login-item.js";

test("shouldLaunchInBackground は background launch arg を検出する", () => {
  assert.equal(shouldLaunchInBackground(["withmate"]), false);
  assert.equal(shouldLaunchInBackground(["withmate", WITHMATE_BACKGROUND_LAUNCH_ARG]), true);
});

test("resolveAppUserModelId は packaged app だけに製品 ID を割り当てる", () => {
  assert.equal(resolveAppUserModelId({
    isPackaged: true,
    execPath: "C:\\Program Files\\WithMate\\WithMate.exe",
  }), WITHMATE_APP_USER_MODEL_ID);
  assert.equal(resolveAppUserModelId({
    isPackaged: false,
    execPath: "C:\\workspace\\node_modules\\electron\\dist\\electron.exe",
  }), "C:\\workspace\\node_modules\\electron\\dist\\electron.exe");
});

test("applyLaunchAtLoginSetting は有効時に background arg を登録する", () => {
  const calls: unknown[] = [];

  applyLaunchAtLoginSetting({
    setLoginItemSettings(settings) {
      calls.push(settings);
    },
  }, true, true);

  assert.deepEqual(calls, [{
    openAtLogin: true,
    args: [WITHMATE_BACKGROUND_LAUNCH_ARG],
  }]);
});

test("applyLaunchAtLoginSetting は無効時に login item を解除する", () => {
  const calls: unknown[] = [];

  applyLaunchAtLoginSetting({
    setLoginItemSettings(settings) {
      calls.push(settings);
    },
  }, false, true);

  assert.deepEqual(calls, [{
    openAtLogin: false,
    args: [],
  }]);
});

test("applyLaunchAtLoginSetting は unpackaged app から OS の login item を変更しない", () => {
  const calls: unknown[] = [];
  const app = {
    setLoginItemSettings(settings: unknown) {
      calls.push(settings);
    },
  };

  applyLaunchAtLoginSetting(app, true, false);
  applyLaunchAtLoginSetting(app, false, false);

  assert.deepEqual(calls, []);
});
