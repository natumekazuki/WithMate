import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";

import App from "../../src/App.js";
import { CompanionChatModeApp } from "../../src/CompanionReviewApp.js";

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
    assert.match(output, /Session が選択されていません/);
    assert.match(output, /Home Window から session を開いてね/);
    assert.match(output, /session-work-surface chat-panel/);
    assert.doesNotMatch(output, /empty-session-card/);
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
  }
});

test("CompanionChatModeApp は chat mode の初回 render で共通 status shell を使う", () => {
  const previousWindow = globalThis.window;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        search: "?companionSessionId=companion-1&mode=companion",
      },
      withmate: {},
    },
  });

  try {
    let output = "";
    assert.doesNotThrow(() => {
      output = renderToString(React.createElement(CompanionChatModeApp));
    });
    assert.match(output, /Companion を読み込み中/);
    assert.match(output, /session-work-surface chat-panel/);
    assert.doesNotMatch(output, /companion-review-page/);
    assert.doesNotMatch(output, /empty-session-card/);
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
  }
});
