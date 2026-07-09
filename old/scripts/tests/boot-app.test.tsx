import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import BootApp from "../../src/BootApp.js";

test("BootApp は Home と同じ page shell と panel で起動ステータスをレンダリングする", () => {
  const html = renderToStaticMarkup(React.createElement(BootApp));

  assert.match(html, /<div class="page-shell home-page boot-page">/);
  assert.match(html, /<main class="home-layout home-layout-minimal boot-page-shell">/);
  assert.match(html, /<section class="panel boot-status-panel rise-1" aria-live="polite">/);
  assert.match(html, /<p class="kicker">WithMate<\/p>/);
  assert.match(html, /<ol class="boot-stage-list" aria-label="起動処理の進捗">/);
  assert.doesNotMatch(html, /boot-brand-mark/);
});
