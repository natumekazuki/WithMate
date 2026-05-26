import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatWindow } from "../../src/chat/chat-window.js";
import { buildMateTalkChatWindowProps } from "../../src/chat/mate-talk-chat-projection.js";

function renderPanel(options?: {
  sending?: boolean;
  input?: string;
  messages?: Array<{ id: string; role: "user" | "mate"; text: string }>;
  feedback?: string;
  isHeaderExpanded?: boolean;
  mateAvatarFilePath?: string;
  withResponseActions?: boolean;
}) {
  const messageListRef = React.createRef<HTMLDivElement>();
  const composerTextareaRef = React.createRef<HTMLTextAreaElement>();

  return renderToStaticMarkup(
    React.createElement(
      ChatWindow,
      buildMateTalkChatWindowProps({
        mateName: "ユニバーサル",
        mateAvatarFilePath: options?.mateAvatarFilePath,
        messages: options?.messages ?? [],
        input: options?.input ?? "",
        feedback: options?.feedback ?? "",
        sending: options?.sending ?? false,
        isHeaderExpanded: options?.isHeaderExpanded ?? false,
        isActionDockExpanded: true,
        modelOptions: [{ value: "gpt-test", label: "GPT Test" }],
        selectedModel: "gpt-test",
        selectedModelFallbackLabel: "GPT Test",
        reasoningOptions: [{ value: "low", label: "low" }, { value: "medium", label: "medium" }],
        selectedReasoningEffort: "low",
        messageListRef,
        composerTextareaRef,
        onChangeInput() {},
        onCopyMessageText: options?.withResponseActions ? () => {} : undefined,
        onQuoteMessageText: options?.withResponseActions ? () => {} : undefined,
        onChangeModel() {},
        onChangeReasoningEffort() {},
        onSubmit() {},
        onToggleHeaderExpanded() {},
        onCollapseActionDock() {},
        onExpandActionDock() {},
        composerCapabilityProps: {
          showAttachmentControls: true,
          showAdditionalDirectoryControls: true,
          showExecutionModeControls: true,
          showCustomAgentPicker: false,
          showSkillPicker: false,
          approvalOptions: [{ value: "untrusted", label: "untrusted" }],
          selectedApprovalMode: "untrusted",
          sandboxOptions: [{ value: "workspace-write", label: "workspace-write" }],
          selectedCodexSandboxMode: "workspace-write",
          onPickFile() {},
          onPickFolder() {},
          onPickImage() {},
          onAddAdditionalDirectory() {},
          onToggleAdditionalDirectoryList() {},
          onChangeApprovalMode() {},
          onChangeCodexSandboxMode() {},
        },
      }),
    ),
  );
}

test("MateTalk は ChatWindow で Session 共通レイアウトの通常状態をレンダリングする", () => {
  const html = renderPanel({ input: "おはよう", isHeaderExpanded: true });

  assert.match(html, /<div class="page-shell session-page"/);
  assert.match(html, /data-session-mode="mate-talk"/);
  assert.match(html, /<div class="session-main-grid">/);
  assert.match(html, /<div class="session-action-dock">/);
  assert.match(html, /<aside class="session-context-pane session-context-pane-header-expanded"/);
  assert.match(html, /<header class="session-window-bar session-top-bar rise-1">/);
  assert.match(html, /<span class="session-window-title session-title-accent">メイトーク<\/span>/);
  assert.doesNotMatch(html, />Home<\/button>/);
  assert.doesNotMatch(html, /まだ会話は開始してないよ。まずは入力してね。/);
  assert.doesNotMatch(html, /メイトーク中に使う補助情報はここに表示されます。/);
  assert.doesNotMatch(html, /session-plain/);
  assert.match(html, /<div class="composer-box">/);
  assert.match(html, /<textarea[^>]*placeholder="今日はどうする？"/);
  assert.match(html, /<button class="session-send-button" type="button" title="メッセージを送信">Send<\/button>/);
  assert.doesNotMatch(html, /<span>Provider<\/span>/);
  assert.match(html, /<span>Model<\/span>/);
  assert.match(html, /<span>Depth<\/span>/);
  assert.match(html, />File<\/button>/);
  assert.match(html, />Folder<\/button>/);
  assert.match(html, />Image<\/button>/);
  assert.match(html, />Hide<\/button>/);
  assert.doesNotMatch(html, />Agent<\/button>/);
  assert.doesNotMatch(html, />Skills<\/button>/);
  assert.match(html, />Add Directory<\/button>/);
  assert.match(html, />Approval<\/span>/);
  assert.match(html, />Sandbox<\/span>/);
  assert.doesNotMatch(html, /<button class="session-send-button"[^>]*disabled=""/);
});

test("MateTalk は ChatWindow の初期状態でヘッダーを格納する", () => {
  const html = renderPanel({ input: "おはよう" });

  assert.match(html, /session-page-header-collapsed/);
  assert.doesNotMatch(html, /<header class="session-window-bar session-top-bar rise-1">/);
  assert.match(html, /<button class="session-header-handle" type="button"><span class="session-window-title session-title-accent">メイトーク<\/span><\/button>/);
});

test("MateTalk は ChatWindow で action dock の格納と復帰を共通 props に接続する", () => {
  const messageListRef = React.createRef<HTMLDivElement>();
  const composerTextareaRef = React.createRef<HTMLTextAreaElement>();
  const onCollapseActionDock = () => {};
  const onExpandActionDock = () => {};

  const props = buildMateTalkChatWindowProps({
    mateName: "ユニバーサル",
    messages: [],
    input: "おはよう",
    feedback: "",
    sending: false,
    isHeaderExpanded: false,
    isActionDockExpanded: false,
    modelOptions: [{ value: "gpt-test", label: "GPT Test" }],
    selectedModel: "gpt-test",
    selectedModelFallbackLabel: "GPT Test",
    reasoningOptions: [{ value: "low", label: "low" }],
    selectedReasoningEffort: "low",
    messageListRef,
    composerTextareaRef,
    onChangeInput() {},
    onChangeModel() {},
    onChangeReasoningEffort() {},
    onSubmit() {},
    onToggleHeaderExpanded() {},
    onCollapseActionDock,
    onExpandActionDock,
    composerCapabilityProps: {
      showAttachmentControls: false,
      showAdditionalDirectoryControls: false,
      showExecutionModeControls: false,
      showCustomAgentPicker: true,
      showSkillPicker: true,
    },
  });

  assert.equal(props.isActionDockExpanded, false);
  assert.equal(props.composerProps.showAttachmentControls, true);
  assert.equal(props.composerProps.showAdditionalDirectoryControls, true);
  assert.equal(props.composerProps.showExecutionModeControls, true);
  assert.equal(props.composerProps.showCustomAgentPicker, false);
  assert.equal(props.composerProps.showSkillPicker, false);
  assert.equal(props.composerProps.canCollapseActionDock, true);
  assert.equal(props.composerProps.onCollapse, onCollapseActionDock);
  assert.equal(props.compactActionDockProps.onExpand, onExpandActionDock);
});

test("MateTalk は ChatWindow で空白入力の送信を抑制する", () => {
  const html = renderPanel({ input: "   ", feedback: "入力してから送信してね。" });

  assert.match(html, /<div id="composer-sendability-feedback" class="composer-sendability-feedback helper"><p>入力してから送信してね。<\/p><\/div>/);
  assert.match(html, /<button class="session-send-button" type="button" disabled="">Send<\/button>/);
});

test("MateTalk は ChatWindow で sending 中に共通の pending 表示と disabled を反映する", () => {
  const html = renderPanel({ sending: true, input: "おはよう" });

  assert.match(html, /<span class="session-window-title session-title-accent">メイトーク<\/span>/);
  assert.doesNotMatch(html, /まだ会話は開始してないよ。まずは入力してね。/);
  assert.doesNotMatch(html, /<article class="message-row assistant pending-row">/);
  assert.doesNotMatch(html, /ユニバーサル が返信を準備中/);
  assert.doesNotMatch(html, /composer-toolbar-progress/);
  assert.doesNotMatch(html, /composer-toolbar-cancel-button/);
  assert.match(html, /<button class="session-send-button" type="button" disabled="">Send<\/button>/);
  assert.match(html, /<textarea[^>]*disabled=""/);
});

test("MateTalk は ChatWindow で Session と同じヘッダー格納ハンドルを使う", () => {
  const html = renderPanel({ input: "おはよう", isHeaderExpanded: false });

  assert.match(html, /session-page-header-collapsed/);
  assert.doesNotMatch(html, /<header class="session-window-bar session-top-bar rise-1">/);
  assert.match(html, /<button class="session-header-handle" type="button"><span class="session-window-title session-title-accent">メイトーク<\/span><\/button>/);
});

test("MateTalk は ChatWindow で user/mate メッセージを共通 message row でレンダリングする", () => {
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

test("MateTalk は mate response に共通 Copy / Quote action を表示する", () => {
  const html = renderPanel({
    withResponseActions: true,
    messages: [
      { id: "m1", role: "user", text: "おはよう" },
      { id: "m2", role: "mate", text: "やあ、元気？" },
    ],
    input: "test",
  });

  assert.match(html, /<div class="message-response-actions" aria-label="Response actions">/);
  assert.match(html, />Copy<\/button>/);
  assert.match(html, />Quote<\/button>/);
});

test("MateTalk は Mate avatar path を返信メッセージの avatar に渡す", () => {
  const html = renderPanel({
    mateAvatarFilePath: "data:image/png;base64,AA==",
    messages: [
      { id: "m1", role: "user", text: "おはよう" },
      { id: "m2", role: "mate", text: "やあ、元気？" },
    ],
    input: "test",
  });

  assert.match(html, /<article class="message-row assistant">/);
  assert.match(html, /<img src="data:image\/png;base64,AA=="/);
});

test("MateTalk は ChatWindow で feedback を共通 composer feedback で表示する", () => {
  const html = renderPanel({ feedback: "返信を待っています", input: "test" });

  assert.match(html, /<div id="composer-sendability-feedback" class="composer-sendability-feedback helper"><p>返信を待っています<\/p><\/div>/);
});

test("MateTalk は ChatWindow で送信中でも空の pending row を追加しない", () => {
  const html = renderPanel({
    sending: true,
    input: "おはよう",
    messages: [{ id: "m1", role: "user", text: "最初のメッセージ" }],
  });

  assert.match(html, /<div class="session-message-list">/);
  assert.match(html, /<p class="message-paragraph">最初のメッセージ<\/p>/);
  assert.doesNotMatch(html, /<article class="message-row assistant pending-row">/);
});
