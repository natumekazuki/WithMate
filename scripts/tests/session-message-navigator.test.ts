import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import {
  SessionContextPane,
  type SessionContextPaneProps,
} from "../../src/session-components.js";
import { buildContextPaneProjection } from "../../src/session-ui-projection.js";
import type { CharacterProfile } from "../../src/app-state.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createCharacterProfile(): CharacterProfile {
  return {
    id: "char-1",
    name: "Test Character",
    iconPath: "/icons/test-character.svg",
    description: "for message navigator test",
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

test("Messages navigator はaccessible nameを持つnative rowを上下キーとEnterで操作する", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", { pretendToBeVisual: true });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousDOMRect = globalThis.DOMRect;
  const previousEvent = globalThis.Event;
  const previousMouseEvent = globalThis.MouseEvent;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "DOMRect", { configurable: true, value: dom.window.DOMRect });
  Object.defineProperty(globalThis, "Event", { configurable: true, value: dom.window.Event });
  Object.defineProperty(globalThis, "MouseEvent", { configurable: true, value: dom.window.MouseEvent });

  const rootElement = dom.window.document.getElementById("root");
  assert.ok(rootElement);
  const root = createRoot(rootElement);
  const jumpedKeys: string[] = [];
  const props: SessionContextPaneProps = {
    activeContextPaneTab: "messages",
    availableContextPaneTabs: ["latest-command", "messages"],
    contextPaneProjection: buildContextPaneProjection({
      activeContextPaneTab: "messages",
      latestCommandView: null,
      backgroundTasks: [],
    }),
    latestCommandView: null,
    runningDetailsEntries: [],
    liveRunReasoningText: "",
    backgroundTasks: [],
    companionGroupMonitorEntries: [],
    selectedSessionLiveRunErrorMessage: "",
    isSelectedSessionRunning: false,
    isCopilotSession: false,
    selectedCopilotRemainingPercentLabel: "",
    selectedCopilotRemainingRequestsLabel: "",
    selectedCopilotQuotaResetLabel: "",
    selectedSessionContextTelemetry: null,
    selectedSessionContextTelemetryProjection: {
      summaryLabel: "",
      currentTokensLabel: "",
      tokenLimitLabel: "",
      messagesLengthLabel: "",
      systemTokensLabel: "",
      conversationTokensLabel: "",
    },
    contextEmptyText: "",
    messageNavigatorCharacter: createCharacterProfile(),
    messageNavigatorEntries: [
      {
        key: "first",
        sourceKind: "session",
        role: "assistant",
        preview: "assistant first",
        accent: false,
        isCollapsed: true,
      },
      {
        key: "second",
        sourceKind: "session",
        role: "user",
        preview: "user second",
        accent: false,
        isCollapsed: false,
      },
    ],
    onCycleContextPaneTab() {},
    onJumpToMessage: (key) => jumpedKeys.push(key),
    onOpenCompanionReview() {},
  };

  try {
    await act(async () => {
      root.render(React.createElement(SessionContextPane, props));
    });
    const rows = Array.from(rootElement.querySelectorAll<HTMLButtonElement>(".messages-navigator-row"));
    assert.equal(rows.length, 2);
    assert.match(rows[0]?.getAttribute("aria-label") ?? "", /Test Character/);
    assert.match(rows[1]?.getAttribute("aria-label") ?? "", /あなたのメッセージ/);
    assert.match(rows[0]?.getAttribute("aria-label") ?? "", /assistant first/);
    assert.equal(rows[0]?.getAttribute("aria-expanded"), null);
    rows[0]?.focus();
    await act(async () => {
      rows[0]?.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(dom.window.document.activeElement, rows[1]);
    await act(async () => {
      rows[1]?.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.deepEqual(jumpedKeys, ["second"]);
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.window.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "DOMRect", { configurable: true, value: previousDOMRect });
    Object.defineProperty(globalThis, "Event", { configurable: true, value: previousEvent });
    Object.defineProperty(globalThis, "MouseEvent", { configurable: true, value: previousMouseEvent });
  }
});
