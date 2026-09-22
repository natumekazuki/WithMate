import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";

import App from "../../src/app/SessionWindowApp.js";

// @test-value v2
// kind = "contract"
// claim = "Session Appはdesktop runtimeの初回renderで例外を出さず、session未選択の共通shellと英語statusを描画する"
// oracle = { type = "contract", ref = "src/app/SessionWindowApp.tsx: status screen" }
// fault = "初回renderがTDZで落ちるか、未選択screenのstatus copyまたはchat work surfaceを失う"
// observable = "renderToStringの非throw結果、No session is selected/Open a session copy、session shell class"
// observation_boundary = "component-behavior"
// scope = "session-app-initial-render"
// lifecycle = "permanent"
// impact = "desktop起動直後に会話画面を復旧できず、利用者へ次の操作を案内できない"
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
    assert.match(output, /No session is selected\./);
    assert.match(output, /Open a session from the Home Window\./);
    assert.match(output, /session-work-surface chat-panel/);
    assert.doesNotMatch(output, /empty-session-card/);
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
  }
});
