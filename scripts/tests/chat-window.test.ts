import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatWindowStatusScreen, ChatWorkbenchSplitter } from "../../src/chat/chat-window.js";
import { SessionChatScreen } from "../../src/session-components.js";

test("ChatWindowStatusScreen は Session 共通 shell で状態表示をレンダリングする", () => {
  const html = renderToStaticMarkup(React.createElement(ChatWindowStatusScreen, { message: "準備しています。" }));

  assert.match(html, /<main class="page-shell session-page">/);
  assert.match(html, /<section class="session-work-surface chat-panel" aria-live="polite">/);
  assert.match(html, /<p class="session-message-empty">準備しています。<\/p>/);
  assert.doesNotMatch(html, /session-plain/);
});

test("ChatWorkbenchSplitter は resize handler がない場合に静的 splitter をレンダリングする", () => {
  const html = renderToStaticMarkup(React.createElement(ChatWorkbenchSplitter));

  assert.equal(html, '<div class="session-workbench-splitter is-static" aria-hidden="true"></div>');
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

test("ChatWorkbenchSplitter は右ペインの表示状態を切り替える affordance を示す", () => {
  const expandedHtml = renderToStaticMarkup(
    React.createElement(ChatWorkbenchSplitter, {
      isRightPaneVisible: true,
      onPointerDown() {},
      onToggleRightPane() {},
    }),
  );
  const collapsedHtml = renderToStaticMarkup(
    React.createElement(ChatWorkbenchSplitter, {
      isRightPaneVisible: false,
      onToggleRightPane() {},
    }),
  );

  assert.match(expandedHtml, /aria-label="右ペインを非表示"/);
  assert.match(expandedHtml, /aria-controls="session-right-pane"/);
  assert.match(expandedHtml, /aria-expanded="true"/);
  assert.match(expandedHtml, /クリックで右ペインを非表示、広い画面ではドラッグで幅を調整/);
  assert.match(expandedHtml, />›<\/span>/);

  assert.match(collapsedHtml, /class="session-workbench-splitter is-collapsed"/);
  assert.match(collapsedHtml, /aria-label="右ペインを表示"/);
  assert.match(collapsedHtml, /aria-expanded="false"/);
  assert.match(collapsedHtml, />‹<\/span>/);
});

test("SessionChatScreen は右ペインを unmount せずにレイアウトから隠す", () => {
  const html = renderToStaticMarkup(
    React.createElement(SessionChatScreen, {
      mode: "agent",
      header: null,
      messageColumn: React.createElement("div", null, "Messages"),
      actionDock: React.createElement("div", null, "Composer"),
      splitter: React.createElement("button", { type: "button" }, "Toggle"),
      rightPane: React.createElement("aside", null, "Latest Command"),
      isRightPaneVisible: false,
    }),
  );

  assert.match(html, /session-main-grid session-main-grid-right-pane-hidden/);
  assert.match(html, /id="session-right-pane" class="session-right-pane-slot" hidden=""/);
  assert.match(html, /Latest Command/);
});
