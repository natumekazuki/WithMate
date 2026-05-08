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

  assert.match(html, /<p[^>]*class="settings-feedback home-mate-feedback"[^>]*>入力してから送信してね。<\/p>/);
  assert.match(html, /<button class="start-session-button"[^>]*type="submit"[^>]*disabled=""/);
});

test("HomeMateTalkPanel は sending 中に送信ボタン文言と disabled を反映する", () => {
  const html = renderPanel({ sending: true, input: "おはよう" });

  assert.match(html, /<h2 class="home-mate-talk-head">メイトーク<\/h2>/);
  assert.match(html, /<p class="home-mate-talk-empty">まだ会話は開始してないよ。まずは入力してね。<\/p>/);
  assert.match(html, /<button class="start-session-button"[^>]*type="submit"[^>]*disabled="">送信中\.\.\.<\/button>/);
  assert.match(html, /<textarea[^>]*id="home-mate-talk-input"[^>]*disabled=""/);
});

test("HomeMateTalkPanel は user/mate メッセージに発話者ラベルを含めてレンダリングする", () => {
  const html = renderPanel({
    messages: [
      { id: "m1", role: "user", text: "おはよう" },
      { id: "m2", role: "mate", text: "やあ、元気？" },
    ],
    input: "test",
  });

  assert.match(html, /<strong>あなた:<\/strong>\s*おはよう/);
  assert.match(html, /<strong>ユニバーサル:<\/strong>\s*やあ、元気？/);
});

test("HomeMateTalkPanel は feedback を非破壊通知として status ロールで表示する", () => {
  const html = renderPanel({ feedback: "返信を待っています", input: "test" });

  assert.match(html, /<p role="status" class="settings-feedback home-mate-feedback">返信を待っています<\/p>/);
});

test("HomeMateTalkPanel は送信中に会話履歴 region を busy として示す", () => {
  const html = renderPanel({
    sending: true,
    input: "おはよう",
    messages: [{ id: "m1", role: "user", text: "最初のメッセージ" }],
  });

  assert.match(html, /<section[^>]*class="home-mate-talk-messages"[^>]*aria-live="polite"[^>]*aria-busy="true"/);
});
