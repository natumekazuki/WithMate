import assert from "node:assert/strict";
import test from "node:test";
import React, { isValidElement, type ReactElement, type ReactNode } from "react";
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

function renderPanelElement(options?: {
  sending?: boolean;
  input?: string;
  onClose?: () => void;
  onSubmit?: () => void;
  onChangeInput?: (value: string) => void;
}) {
  return HomeMateTalkPanel({
    mateName: "ユニバーサル",
    messages: [],
    input: options?.input ?? "",
    feedback: "",
    sending: options?.sending,
    onChangeInput: options?.onChangeInput ?? (() => {}),
    onSubmit: options?.onSubmit ?? (() => {}),
    onClose: options?.onClose ?? (() => {}),
  }) as ReactElement;
}

function findElementByType(root: ReactNode, type: string): ReactElement | null {
  if (!isValidElement(root)) {
    return null;
  }

  if (root.type === type) {
    return root;
  }

  const children = (root.props as { children?: ReactNode }).children;
  const childList = React.Children.toArray(children);

  for (const child of childList) {
    const found = findElementByType(child, type);
    if (found) {
      return found;
    }
  }

  return null;
}

function findButtonByText(root: ReactNode, text: string): ReactElement | null {
  if (!isValidElement(root)) {
    return null;
  }

  if (root.type === "button" && (root.props as { children?: ReactNode }).children === text) {
    return root;
  }

  const children = (root.props as { children?: ReactNode }).children;
  const childList = React.Children.toArray(children);

  for (const child of childList) {
    const found = findButtonByText(child, text);
    if (found) {
      return found;
    }
  }

  return null;
}

test("HomeMateTalkPanel は未送信時の通常状態をレンダリングする", () => {
  const html = renderPanel({ input: "おはよう" });

  assert.match(html, /<section class="home-mate-talk-panel session-page">/);
  assert.match(html, /<h2 class="home-mate-talk-head">メイトーク<\/h2>/);
  assert.match(html, /<button class="drawer-toggle compact secondary" type="button">ホーム<\/button>/);
  assert.match(html, /<p class="home-mate-talk-empty">まだ会話は開始してないよ。まずは入力してね。<\/p>/);
  assert.match(html, /<div class="composer-box home-mate-talk-composer-box">/);
  assert.match(html, /<button class="session-send-button" type="submit">送信<\/button>/);
  assert.doesNotMatch(html, /<button class="session-send-button"[^>]*disabled="[^"]*"/);
  assert.doesNotMatch(html, /<textarea[^>]*id="home-mate-talk-input"[^>]*disabled="disabled"/);
  assert.doesNotMatch(html, /<button class="session-send-button"[^>]*disabled="disabled">送信中\.\.\.<\/button>/);
});

test("HomeMateTalkPanel は空白入力で送信を抑制する", () => {
  const html = renderPanel({ input: "   ", feedback: "入力してから送信してね。" });

  assert.match(html, /<p[^>]*class="settings-feedback home-mate-feedback"[^>]*>入力してから送信してね。<\/p>/);
  assert.match(html, /<button class="session-send-button"[^>]*type="submit"[^>]*disabled=""/);
});

test("HomeMateTalkPanel は sending 中に送信ボタン文言と disabled を反映する", () => {
  const html = renderPanel({ sending: true, input: "おはよう" });

  assert.match(html, /<h2 class="home-mate-talk-head">メイトーク<\/h2>/);
  assert.match(html, /<p class="home-mate-talk-empty">まだ会話は開始してないよ。まずは入力してね。<\/p>/);
  assert.match(html, /<button class="session-send-button"[^>]*type="submit"[^>]*disabled="">送信中\.\.\.<\/button>/);
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

  assert.match(html, /<article class="message-row user home-mate-talk-row">/);
  assert.match(html, /<article class="message-row assistant home-mate-talk-row">/);
  assert.match(html, /<p class="home-mate-talk-speaker">あなた<\/p><p class="home-mate-talk-text">おはよう<\/p>/);
  assert.match(html, /<div class="home-mate-talk-avatar" aria-hidden="true">ユ<\/div>/);
  assert.match(html, /<p class="home-mate-talk-speaker">ユニバーサル<\/p><p class="home-mate-talk-text">やあ、元気？<\/p>/);
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

  assert.match(html, /<section[^>]*class="session-message-list home-mate-talk-messages"[^>]*aria-live="polite"[^>]*aria-busy="true"/);
});

test("HomeMateTalkPanel はホームボタンで onClose を呼ぶ", () => {
  let closeCount = 0;
  const element = renderPanelElement({ onClose: () => { closeCount += 1; } });
  const homeButton = findButtonByText(element, "ホーム");

  assert.ok(homeButton);
  (homeButton.props as { onClick: () => void }).onClick();
  assert.equal(closeCount, 1);
});

test("HomeMateTalkPanel は form submit で onSubmit を呼ぶ", () => {
  let submitCount = 0;
  let prevented = false;
  const element = renderPanelElement({ input: "おはよう", onSubmit: () => { submitCount += 1; } });
  const form = findElementByType(element, "form");

  assert.ok(form);
  (form.props as { onSubmit: (event: { preventDefault: () => void }) => void }).onSubmit({
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(submitCount, 1);
});

test("HomeMateTalkPanel は Ctrl+Enter で onSubmit を呼び preventDefault する", () => {
  let submitCount = 0;
  let prevented = false;
  const element = renderPanelElement({ input: "おはよう", onSubmit: () => { submitCount += 1; } });
  const textarea = findElementByType(element, "textarea");

  assert.ok(textarea);
  (textarea.props as { onKeyDown: (event: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; nativeEvent: { isComposing: boolean }; preventDefault: () => void }) => void }).onKeyDown({
    key: "Enter",
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    nativeEvent: { isComposing: false },
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(submitCount, 1);
});
