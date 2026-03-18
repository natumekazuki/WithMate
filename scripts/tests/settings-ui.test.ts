import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SETTINGS_API_KEY_LABEL, SETTINGS_API_KEY_PLACEHOLDER } from "../../src/settings-ui.js";
import { HOME_WINDOW_DEFAULT_BOUNDS } from "../../src-electron/window-defaults.js";

describe("Settings UI constants", () => {
  it("provider card の API key 文言は OpenAI API Key を明示する", () => {
    assert.equal(SETTINGS_API_KEY_LABEL, "OpenAI API Key");
    assert.equal(SETTINGS_API_KEY_PLACEHOLDER, "OpenAI API Key を入力");
  });

  it("Home Window は Settings overlay の余裕を確保する既定サイズを使う", () => {
    assert.deepEqual(HOME_WINDOW_DEFAULT_BOUNDS, {
      width: 1440,
      height: 960,
      minWidth: 1040,
      minHeight: 760,
    });
  });
});
