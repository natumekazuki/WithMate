import assert from "node:assert/strict";
import test from "node:test";

import {
  getWithMateApi,
  isDesktopRuntime,
  withWithMateApi,
} from "../../src/app/renderer-withmate-api.js";

/** Window がない環境では WithMate API が取得できず、デスクトップ実行とは判定しない。 */
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

/** preload が公開した API オブジェクトを複製・代替せずに取得し、コールバックにも同じ参照を渡す。 */
test("renderer-withmate-api は window.withmate をそのまま返す", () => {
  const previousWindow = globalThis.window;
  const api = {
    /** API の存在と参照だけを検証するため、実一覧は読み込まない。 */
    listSessions() {},
  };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { withmate: api },
  });

  assert.equal(getWithMateApi(), api);
  assert.equal(isDesktopRuntime(), true);
  assert.equal(
    withWithMateApi((currentApi) => currentApi),
    api,
  );

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: previousWindow,
  });
});

/** API がない場合はコールバックを起動せず、処理できる API がなかったことを null で返す。 */
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
