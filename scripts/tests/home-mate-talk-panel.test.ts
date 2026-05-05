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
}) {
  return renderToStaticMarkup(
    React.createElement(HomeMateTalkPanel, {
      mateName: "ユニバーサル",
      messages: options?.messages ?? [],
      input: options?.input ?? "",
      feedback: options?.feedback ?? "",
      sending: options?.sending,
      onChangeInput() {},
      onSubmit() {},
      onClose() {},
    }),
  );
}

test("HomeMateTalkPanel は未送信時の通常状態をレンダリングする", () => {
  const html = renderPanel({ input: "おはよう" });

  assert.match(html, /<h2 class="home-mate-talk-head">メイトーク<\/h2>/);
  assert.match(html, /<p class="home-mate-talk-empty">まだ会話は開始してないよ。まずは入力してね。<\/p>/);
  assert.match(html, /<button class="start-session-button" type="submit">送信<\/button>/);
  assert.doesNotMatch(html, /<button class="start-session-button"[^>]*disabled="[^"]*"/);
  assert.doesNotMatch(html, /<textarea[^>]*id="home-mate-talk-input"[^>]*disabled="disabled"/);
  assert.doesNotMatch(html, /<button class="start-session-button"[^>]*disabled="disabled">送信中\.\.\.<\/button>/);
});

test("HomeMateTalkPanel は空白入力で送信を抑制する", () => {
  const html = renderPanel({ input: "   ", feedback: "入力してから送信してね。" });

  assert.match(html, /<p class="settings-feedback home-mate-feedback">入力してから送信してね。<\/p>/);
  assert.match(html, /<button class="start-session-button"[^>]*type="submit"[^>]*disabled=""/);
});

test("HomeMateTalkPanel は sending 中に送信ボタン文言と disabled を反映する", () => {
  const html = renderPanel({ sending: true, input: "おはよう" });

  assert.match(html, /<h2 class="home-mate-talk-head">メイトーク<\/h2>/);
  assert.match(html, /<p class="home-mate-talk-empty">まだ会話は開始してないよ。まずは入力してね。<\/p>/);
  assert.match(html, /<button class="start-session-button"[^>]*type="submit"[^>]*disabled="">送信中\.\.\.<\/button>/);
  assert.match(html, /<textarea[^>]*id="home-mate-talk-input"[^>]*disabled=""/);
});
