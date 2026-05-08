import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";

import App from "../../src/App.js";

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
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
  }
});
