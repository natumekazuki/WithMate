import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatWindowStatusScreen, ChatWorkbenchSplitter } from "../../src/chat/chat-window.js";

test("ChatWindowStatusScreen は Session 共通 shell で状態表示をレンダリングする", () => {
  const html = renderToStaticMarkup(React.createElement(ChatWindowStatusScreen, { message: "準備しています。" }));

  assert.match(html, /<main class="page-shell session-page">/);
  assert.match(html, /<section class="session-work-surface chat-panel" aria-live="polite">/);
  assert.match(html, /<p class="session-message-empty">準備しています。<\/p>/);
  assert.doesNotMatch(html, /session-plain/);
});

test("ChatWorkbenchSplitter は resize handler がない場合に静的 splitter をレンダリングする", () => {
  const html = renderToStaticMarkup(React.createElement(ChatWorkbenchSplitter));

  assert.equal(html, '<div class="session-workbench-splitter" aria-hidden="true"></div>');
});

test("ChatWorkbenchSplitter は resize handler がある場合に操作可能 splitter をレンダリングする", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatWorkbenchSplitter, {
      isActive: true,
      onPointerDown() {},
    }),
  );

  assert.match(html, /<button class="session-workbench-splitter is-active" type="button"/);
  assert.match(html, /aria-label="会話と command pane の幅を調整"/);
  assert.match(html, /title="左右の幅をドラッグで調整"/);
});
