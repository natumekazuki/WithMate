import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatDockSplitter, ChatWindowStatusScreen } from "../../src/chat/chat-window.js";
import { SessionActionDockCompactRow, SessionChatScreen } from "../../src/session-components.js";

test("ChatWindowStatusScreen は Session 共通 shell で状態表示をレンダリングする", () => {
  const html = renderToStaticMarkup(React.createElement(ChatWindowStatusScreen, { message: "準備しています。" }));

  assert.match(html, /<main class="page-shell session-page">/);
  assert.match(html, /<section class="session-work-surface chat-panel" aria-live="polite">/);
  assert.match(html, /<p class="session-message-empty">準備しています。<\/p>/);
  assert.doesNotMatch(html, /session-plain/);
});

test("ChatDockSplitter は resize handler がない場合に静的 splitter をレンダリングする", () => {
  const html = renderToStaticMarkup(React.createElement(ChatDockSplitter, { edge: "right" }));

  assert.equal(html, '<div class="session-dock-splitter edge-right is-static" aria-hidden="true"></div>');
});

test("ChatDockSplitter は resize handler がある場合に操作可能 splitter をレンダリングする", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatDockSplitter, {
      edge: "right",
      isActive: true,
      onPointerDown() {},
    }),
  );

  assert.match(html, /<button class="session-dock-splitter edge-right is-active" type="button"/);
  assert.match(html, /aria-label="右ペインのサイズを調整"/);
  assert.match(html, /title="右ペインのサイズをドラッグで調整"/);
});

test("ChatDockSplitter は各辺の表示状態を切り替える affordance を示す", () => {
  const expandedHtml = renderToStaticMarkup(
    React.createElement(ChatDockSplitter, {
      edge: "right",
      isPanelExpanded: true,
      onPointerDown() {},
      onTogglePanel() {},
    }),
  );
  const collapsedHtml = renderToStaticMarkup(
    React.createElement(ChatDockSplitter, {
      edge: "bottom",
      isPanelExpanded: false,
      onTogglePanel() {},
    }),
  );
  const fixedHeaderHtml = renderToStaticMarkup(
    React.createElement(ChatDockSplitter, {
      edge: "top",
      isPanelExpanded: true,
      onTogglePanel() {},
    }),
  );

  assert.match(expandedHtml, /aria-label="右ペインを折りたたむ"/);
  assert.match(expandedHtml, /aria-controls="session-right-pane"/);
  assert.match(expandedHtml, /aria-expanded="true"/);
  assert.match(expandedHtml, /クリックで右ペインを折りたたみ、ドラッグでサイズを調整/);
  assert.match(expandedHtml, />›<\/span>/);

  assert.match(collapsedHtml, /class="session-dock-splitter edge-bottom is-toggle-only is-collapsed"/);
  assert.match(collapsedHtml, /aria-label="ActionDockを展開"/);
  assert.match(collapsedHtml, /aria-controls="session-action-dock"/);
  assert.match(collapsedHtml, /aria-expanded="false"/);
  assert.match(collapsedHtml, />⌃<\/span>/);

  assert.match(fixedHeaderHtml, /class="session-dock-splitter edge-top is-toggle-only"/);
  assert.match(fixedHeaderHtml, /title="クリックでヘッダーを折りたたみ"/);
  assert.doesNotMatch(fixedHeaderHtml, /ドラッグでサイズを調整/);
});

test("SessionChatScreen は左右ペインを mounted のまま非表示・操作不可にする", () => {
  const html = renderToStaticMarkup(
    React.createElement(SessionChatScreen, {
      mode: "agent",
      header: null,
      headerSplitter: React.createElement("button", { type: "button" }, "Header Toggle"),
      isHeaderVisible: false,
      messageColumn: React.createElement("div", null, "Messages"),
      mainContent: React.createElement("div", null, "File Preview"),
      actionDock: React.createElement("div", null, "Composer"),
      actionDockSplitter: React.createElement("button", { type: "button" }, "Dock Toggle"),
      isActionDockExpanded: false,
      splitter: React.createElement("button", { type: "button" }, "Toggle"),
      rightPane: React.createElement("aside", null, "Latest Command"),
      isRightPaneVisible: false,
    }),
  );

  assert.match(html, /class="session-main-grid"/);
  assert.match(html, /id="session-header-dock"[^>]*class="session-header-dock-slot is-hidden"[^>]*aria-hidden="true"/);
  assert.match(html, /id="session-action-dock"[^>]*class="session-action-dock-slot is-compact"/);
  assert.match(html, /id="session-left-pane" class="session-left-pane-slot is-hidden" aria-hidden="true" inert=""/);
  assert.match(html, /id="session-right-pane" class="session-right-pane-slot is-hidden" aria-hidden="true" inert=""/);
  assert.match(html, /class="session-central-surface" hidden=""><div>Messages<\/div><\/div>/);
  assert.match(html, /class="session-central-surface"><div>File Preview<\/div><\/div>/);
  assert.match(html, /<div>Composer<\/div>/);
  assert.match(html, /Latest Command/);
});

test("SessionActionDockCompactRow は preview 中の chat notice を表示する", () => {
  const html = renderToStaticMarkup(
    React.createElement(SessionActionDockCompactRow, {
      draft: "",
      actionDockCompactPreview: "下書きなし",
      attachmentCount: 0,
      isRunning: false,
      chatNotice: "New messages",
      isSendDisabled: true,
      showJumpToBottom: false,
      onExpand() {},
      onJumpToBottom() {},
      onSendOrCancel() {},
    }),
  );

  assert.match(html, /session-action-dock-compact-badge attention/);
  assert.match(html, />New messages<\/span>/);
  assert.match(html, /<button class="session-action-dock-compact-preview"[^>]*>/);
});
