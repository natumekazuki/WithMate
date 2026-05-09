import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { HomeMateTalkPanel } from "../../src/home-components.js";

function renderPanel(options?: {
  sending?: boolean;
  input?: string;
  messages?: Array<{ id: string; role: "user" | "mate"; text: string }>;
  feedback?: string;
  isHeaderExpanded?: boolean;
}) {
  return renderToStaticMarkup(
    React.createElement(HomeMateTalkPanel, {
      mateName: "ユニバーサル",
      messages: options?.messages ?? [],
      input: options?.input ?? "",
      feedback: options?.feedback ?? "",
      sending: options?.sending,
      isHeaderExpanded: options?.isHeaderExpanded ?? true,
      modelOptions: [{ value: "gpt-test", label: "GPT Test" }],
      selectedModel: "gpt-test",
      selectedModelFallbackLabel: "GPT Test",
      reasoningOptions: [{ value: "low", label: "low" }, { value: "medium", label: "medium" }],
      selectedReasoningEffort: "low",
      onChangeInput() {},
      onChangeModel() {},
      onChangeReasoningEffort() {},
      onSubmit() {},
      onClose() {},
      onToggleHeaderExpanded() {},
    }),
  );
}

test("HomeMateTalkPanel は Session 共通レイアウトで通常状態をレンダリングする", () => {
  const html = renderPanel({ input: "おはよう" });

  assert.match(html, /<div class="page-shell session-page home-mate-talk-panel"/);
  assert.match(html, /data-session-mode="mate-talk"/);
  assert.match(html, /<div class="session-main-grid">/);
  assert.match(html, /<div class="session-action-dock">/);
  assert.match(html, /<aside class="session-context-pane session-context-pane-header-expanded"/);
  assert.match(html, /<header class="session-window-bar session-top-bar rise-1">/);
  assert.match(html, /<span class="session-window-title session-title-accent">メイトーク<\/span>/);
  assert.match(html, /<button class="drawer-toggle compact secondary" type="button">ホーム<\/button>/);
  assert.doesNotMatch(html, /まだ会話は開始してないよ。まずは入力してね。/);
  assert.doesNotMatch(html, /メイトーク中に使う補助情報はここに表示されます。/);
  assert.doesNotMatch(html, /session-plain/);
  assert.match(html, /<div class="composer-box">/);
  assert.match(html, /<textarea[^>]*placeholder="今日はどうする？"/);
  assert.match(html, /<button class="session-send-button" type="button" title="メッセージを送信">Send<\/button>/);
  assert.match(html, /<span>Model<\/span>/);
  assert.match(html, /<span>Depth<\/span>/);
  assert.doesNotMatch(html, />File<\/button>/);
  assert.doesNotMatch(html, />Folder<\/button>/);
  assert.doesNotMatch(html, />Image<\/button>/);
  assert.doesNotMatch(html, />Agent<\/button>/);
  assert.doesNotMatch(html, />Skills<\/button>/);
  assert.doesNotMatch(html, />Add Directory<\/button>/);
  assert.doesNotMatch(html, />Approval<\/span>/);
  assert.doesNotMatch(html, />Sandbox<\/span>/);
  assert.doesNotMatch(html, /<button class="session-send-button"[^>]*disabled=""/);
});

test("HomeMateTalkPanel は空白入力で送信を抑制する", () => {
  const html = renderPanel({ input: "   ", feedback: "入力してから送信してね。" });

  assert.match(html, /<div id="composer-sendability-feedback" class="composer-sendability-feedback helper"><p>入力してから送信してね。<\/p><\/div>/);
  assert.match(html, /<button class="session-send-button" type="button" disabled="">Send<\/button>/);
});

test("HomeMateTalkPanel は sending 中に共通の pending 表示と disabled を反映する", () => {
  const html = renderPanel({ sending: true, input: "おはよう" });

  assert.match(html, /<span class="session-window-title session-title-accent">メイトーク<\/span>/);
  assert.doesNotMatch(html, /まだ会話は開始してないよ。まずは入力してね。/);
  assert.match(html, /<article class="message-row assistant pending-row">/);
  assert.match(html, /ユニバーサル が返信を準備中/);
  assert.match(html, /<button class="session-send-button" type="button" disabled="">Send<\/button>/);
  assert.match(html, /<textarea[^>]*disabled=""/);
});

test("HomeMateTalkPanel は Session と同じヘッダー格納ハンドルを使う", () => {
  const html = renderPanel({ input: "おはよう", isHeaderExpanded: false });

  assert.match(html, /session-page-header-collapsed/);
  assert.doesNotMatch(html, /<header class="session-window-bar session-top-bar rise-1">/);
  assert.match(html, /<button class="session-header-handle" type="button"><span class="session-window-title session-title-accent">メイトーク<\/span><\/button>/);
});

test("HomeMateTalkPanel は user/mate メッセージを共通 message row でレンダリングする", () => {
  const html = renderPanel({
    messages: [
      { id: "m1", role: "user", text: "おはよう" },
      { id: "m2", role: "mate", text: "やあ、元気？" },
    ],
    input: "test",
  });

  assert.match(html, /<article class="message-row user">/);
  assert.match(html, /<article class="message-row assistant">/);
  assert.match(html, /<p class="message-paragraph">おはよう<\/p>/);
  assert.match(html, /class="character-avatar small message-avatar"/);
  assert.match(html, /<p class="message-paragraph">やあ、元気？<\/p>/);
  assert.doesNotMatch(html, /session-plain-message-speaker/);
});

test("HomeMateTalkPanel は feedback を共通 composer feedback で表示する", () => {
  const html = renderPanel({ feedback: "返信を待っています", input: "test" });

  assert.match(html, /<div id="composer-sendability-feedback" class="composer-sendability-feedback helper"><p>返信を待っています<\/p><\/div>/);
});

test("HomeMateTalkPanel は送信中に共通メッセージリストへ pending row を追加する", () => {
  const html = renderPanel({
    sending: true,
    input: "おはよう",
    messages: [{ id: "m1", role: "user", text: "最初のメッセージ" }],
  });

  assert.match(html, /<div class="session-message-list">/);
  assert.match(html, /<p class="message-paragraph">最初のメッセージ<\/p>/);
  assert.match(html, /<article class="message-row assistant pending-row">/);
});
