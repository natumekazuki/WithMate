import assert from "node:assert/strict";
import test from "node:test";

import { openMateTalkWindow } from "../../src/home/home-launch-commands.js";

test("openMateTalkWindow は withmate API の openMateTalkWindow を呼ぶ", async () => {
  const previousWindow = globalThis.window;
  let called = false;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      withmate: {
        openMateTalkWindow: async () => {
          called = true;
        },
      },
    },
  });

  try {
    await openMateTalkWindow();
    assert.equal(called, true);
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
  }
});
