import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";

import App from "../../src/app/SessionWindowApp.js";

// @test-value v2
// kind = "contract"
// claim = "Session AppはsessionIdが指定されたdesktop runtimeの初回renderで例外を出さず、共通shellと読込中のaccessible statusを描画する"
// oracle = { type = "contract", ref = "src/app/SessionWindowApp.tsx: status screen" }
// fault = "初回renderがTDZで落ちるか、未取得sessionを未選択扱いにし、読込中のstatusまたはchat work surfaceを失う"
// observable = "renderToStringの非throw結果、Loading sessionのstatusとbusy属性、session shell class"
// observation_boundary = "component-behavior"
// scope = "session-app-initial-render"
// lifecycle = "permanent"
// impact = "desktop起動直後に画面が落ちるか、指定したsessionを読込中であることが利用者へ伝わらない"
// distinction = "Electron window stub下の初回renderを使い、browser runtimeでの遷移後renderとは分離する"
// @end-test-value
test("App は desktop runtime の初回 render で TDZ 例外を出さない", () => {
  const previousWindow = globalThis.window;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        search: "?sessionId=session-1",
      },
      withmate: {},
    },
  });

  try {
    let output = "";
    assert.doesNotThrow(() => {
      output = renderToString(React.createElement(App));
    });
    assert.match(output, /role="status"/);
    assert.match(output, /aria-label="Loading session"/);
    assert.match(output, /aria-busy="true"/);
    assert.match(output, /session-work-surface chat-panel/);
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
  }
});
