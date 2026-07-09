import assert from "node:assert/strict";
import test from "node:test";

import { getWithMateApi, isDesktopRuntime, withWithMateApi } from "../../src/renderer-withmate-api.js";

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
  assert.equal(withWithMateApi((currentApi) => currentApi), api);

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: previousWindow,
  });
});

test("renderer-withmate-api は API が無い時に callback を呼ばず null を返す", () => {
  const previousWindow = globalThis.window;
  let called = false;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: undefined,
  });

  const result = withWithMateApi(() => {
    called = true;
    return "unexpected";
  });

  assert.equal(result, null);
  assert.equal(called, false);

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: previousWindow,
  });
});
