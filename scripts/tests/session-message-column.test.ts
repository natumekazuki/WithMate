import assert from "node:assert/strict";
import test from "node:test";
import React, { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SessionMessageColumn } from "../../src/session-components.js";
import type { CharacterProfile, LiveApprovalRequest, LiveElicitationRequest, Message } from "../../src/app-state.js";

function createCharacterProfile(): CharacterProfile {
  return {
    id: "char-1",
    name: "Test Character",
    iconPath: "/icons/test-character.svg",
    description: "for virtualized list red test",
    roleMarkdown: "テストキャラクター",
    notesMarkdown: "",
    updatedAt: "2026-04-29T00:00:00.000Z",
    themeColors: {
      main: "#6f8cff",
      sub: "#6fb8c7",
    },
    sessionCopy: {
      pendingApproval: ["承認を待機中"],
      pendingWorking: ["処理を実行中"],
      pendingResponding: ["応答を生成中"],
      pendingPreparing: ["応答を準備中"],
      retryInterruptedTitle: ["前回の依頼は中断されたままです"],
      retryFailedTitle: ["前回の依頼は完了できませんでした"],
      retryCanceledTitle: ["この依頼は途中で停止しました"],
      latestCommandWaiting: ["最初の command を待機中"],
      latestCommandEmpty: ["直近 run の command 記録はありません"],
      changedFilesEmpty: ["ファイル変更はありません"],
      contextEmpty: ["context usage はまだありません"],
    },
  };
}

function createMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "assistant" : "user",
    text: `message ${index + 1}`,
  }));
}

function createArtifactMessage(): Message {
  return {
    role: "assistant",
    text: "artifact message",
    artifact: {
      title: "artifact result",
      activitySummary: ["updated app"],
      operationTimeline: [
        {
          type: "file_write",
          summary: "updated file",
          details: "details for operation",
        },
      ],
      changedFiles: [
        {
          kind: "edit",
          path: "src/App.tsx",
          summary: "updated app component",
          diffRows: [{ kind: "add", rightNumber: 1, rightText: "new line" }],
        },
      ],
      runChecks: [{ label: "snapshot files", value: "ok" }],
    },
  };
}

function createLiveApprovalRequest(): LiveApprovalRequest {
  return {
    requestId: "approval-1",
    provider: "codex",
    kind: "command",
    title: "コマンド実行の承認",
    summary: "npm test を実行します",
    details: "approval details",
    warning: "確認してね",
    decisionMode: "direct-decision",
  };
}

function createLiveElicitationRequest(): LiveElicitationRequest {
  return {
    requestId: "elicitation-1",
    provider: "codex",
    mode: "form",
    message: "対象ブランチを選んでね。",
    fields: [
      {
        type: "text",
        name: "branch",
        title: "Branch",
        required: true,
        defaultValue: "main",
      },
    ],
  };
}

function renderSessionMessageColumn(options: {
  messages: Message[];
  expandedArtifacts?: Record<string, boolean>;
  isRunning?: boolean;
  isMessageListFollowing?: boolean;
  hasMessageListUnread?: boolean;
  liveApprovalRequest?: LiveApprovalRequest | null;
  liveElicitationRequest?: LiveElicitationRequest | null;
  liveRunAssistantText?: string;
}): string {
  return renderToStaticMarkup(
    React.createElement(SessionMessageColumn, {
      sessionId: "session-1",
      character: createCharacterProfile(),
      messages: options.messages,
      expandedArtifacts: options.expandedArtifacts ?? {},
      messageListRef: createRef<HTMLDivElement>(),
      isRunning: options.isRunning ?? false,
      pendingRunIndicatorAnnouncement: "",
      pendingRunIndicatorText: "処理を実行中",
      liveApprovalRequest: options.liveApprovalRequest ?? null,
      approvalActionRequestId: null,
      liveElicitationRequest: options.liveElicitationRequest ?? null,
      elicitationActionRequestId: null,
      liveRunAssistantText: options.liveRunAssistantText ?? "",
      hasLiveRunAssistantText: !!options.liveRunAssistantText,
      liveRunErrorMessage: "",
      isMessageListFollowing: options.isMessageListFollowing ?? false,
      hasMessageListUnread: options.hasMessageListUnread ?? false,
      onMessageListScroll() {},
      onToggleArtifact() {},
      onOpenDiff() {},
      onResolveLiveApproval() {},
      onResolveLiveElicitation() {},
      onJumpToBottom() {},
      onOpenPath: undefined,
      getChangedFilesEmptyText() {
        return "変更ファイルはありません";
      },
    }),
  );
}

test("SessionMessageColumn は大量メッセージを最新 chunk に絞って描画する", () => {
  const html = renderSessionMessageColumn({
    messages: createMessages(100),
    isMessageListFollowing: false,
    hasMessageListUnread: true,
  });

  const messageRowCount = (html.match(/message-row/g) ?? []).length;
  assert.ok(messageRowCount > 0, "message-row が1件も描画されていない");
  assert.ok(messageRowCount < 100, "100件全て message-row が描画されている");
  assert.doesNotMatch(html, /message 1<\/p>/);
  assert.match(html, /message 100<\/p>/);
  assert.match(html, /以前のメッセージを読み込む/);
});

test("SessionMessageColumn は未追従時に message-follow-banner を維持する", () => {
  const html = renderSessionMessageColumn({
    messages: createMessages(2),
    isMessageListFollowing: false,
    hasMessageListUnread: false,
  });

  assert.match(html, /message-follow-banner/);
  assert.match(html, /読み返し中/);
});

test("SessionMessageColumn は artifact 展開と diff 起動に必要な表示断片を維持する", () => {
  const html = renderSessionMessageColumn({
    messages: [createArtifactMessage()],
    expandedArtifacts: { "session-1-0": true },
  });

  assert.match(html, /artifact-panel-session-1-0/);
  assert.match(html, /src\/App\.tsx/);
  assert.match(html, /Open Diff/);
  assert.match(html, /snapshot files/);
});

test("SessionMessageColumn は pending と live approval\/elicitation を window の外側で維持する", () => {
  const html = renderSessionMessageColumn({
    messages: createMessages(100),
    isRunning: true,
    liveApprovalRequest: createLiveApprovalRequest(),
    liveElicitationRequest: createLiveElicitationRequest(),
  });

  assert.match(html, /pending-row/);
  assert.match(html, /承認待ち/);
  assert.match(html, /コマンド実行の承認/);
  assert.match(html, /対象ブランチを選んでね。/);
  assert.match(html, /Branch/);
  assert.ok(
    html.indexOf("pending-row") < html.indexOf("message-list-bottom-anchor"),
    "pending row は bottom anchor より前に描画する",
  );
});

test("SessionMessageColumn は実行中の assistant text を pending bubble に表示する", () => {
  const html = renderSessionMessageColumn({
    messages: createMessages(100),
    isRunning: true,
    liveRunAssistantText: "ストリーミング中の返答",
  });

  assert.match(html, /pending-row/);
  assert.match(html, /ストリーミング中の返答/);
});
