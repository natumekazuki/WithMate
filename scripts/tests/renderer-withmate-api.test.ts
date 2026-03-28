import assert from "node:assert/strict";
import test from "node:test";

import { getWithMateApi, isDesktopRuntime } from "../../src/renderer-withmate-api.js";

test("renderer-withmate-api は window.withmate が無い時に null と false を返す", () => {
  const previousWindow = globalThis.window;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: undefined,
  });

  assert.equal(getWithMateApi(), null);
  assert.equal(isDesktopRuntime(), false);

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: previousWindow,
  });
});

test("renderer-withmate-api は window.withmate をそのまま返す", () => {
  const previousWindow = globalThis.window;
  const api = { listSessions() {} };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { withmate: api },
  });

  assert.equal(getWithMateApi(), api);
  assert.equal(isDesktopRuntime(), true);

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: previousWindow,
  });
});
