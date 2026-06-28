import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLaunchAtLoginSetting,
  shouldLaunchInBackground,
  WITHMATE_BACKGROUND_LAUNCH_ARG,
} from "../../src-electron/app-login-item.js";

test("shouldLaunchInBackground は background launch arg を検出する", () => {
  assert.equal(shouldLaunchInBackground(["withmate"]), false);
  assert.equal(shouldLaunchInBackground(["withmate", WITHMATE_BACKGROUND_LAUNCH_ARG]), true);
});

test("applyLaunchAtLoginSetting は有効時に background arg を登録する", () => {
  const calls: unknown[] = [];

  applyLaunchAtLoginSetting({
    setLoginItemSettings(settings) {
      calls.push(settings);
    },
  }, true);

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
  }, false);

  assert.deepEqual(calls, [{
    openAtLogin: false,
    args: [],
  }]);
});
