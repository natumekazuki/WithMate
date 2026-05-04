import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { HomeMateTalkPanel } from "../../src/home-components.js";

function renderPanel(options?: { sending?: boolean; messages?: Array<{ id: string; role: "user" | "mate"; text: string }> }) {
  return renderToStaticMarkup(
    React.createElement(HomeMateTalkPanel, {
      mateName: "ユニバーサル",
      messages: options?.messages ?? [],
      input: "",
      sending: options?.sending,
      onChangeInput() {},
      onSubmit() {},
      onClose() {},
    }),
  );
}

test("HomeMateTalkPanel は未送信時の通常状態をレンダリングする", () => {
  const html = renderPanel({});

  assert.match(html, /<h2 class="home-mate-talk-head">メイトーク<\/h2>/);
  assert.match(html, /<p class="home-mate-talk-empty">まだ会話は開始してないよ。まずは入力してね。<\/p>/);
  assert.match(html, /<button class="start-session-button" type="submit">送信<\/button>/);
  assert.doesNotMatch(html, /<textarea[^>]*id="home-mate-talk-input"[^>]*disabled="disabled"/);
  assert.doesNotMatch(html, /<button class="start-session-button"[^>]*disabled="disabled">送信中\.\.\.<\/button>/);
});

test("HomeMateTalkPanel は sending 中に送信ボタン文言と disabled を反映する", () => {
  const html = renderPanel({ sending: true });

  assert.match(html, /<h2 class="home-mate-talk-head">メイトーク<\/h2>/);
  assert.match(html, /<p class="home-mate-talk-empty">まだ会話は開始してないよ。まずは入力してね。<\/p>/);
  assert.match(html, /<button class="start-session-button"[^>]*type="submit"[^>]*disabled="">送信中\.\.\.<\/button>/);
  assert.match(html, /<textarea[^>]*id="home-mate-talk-input"[^>]*disabled=""/);
});
