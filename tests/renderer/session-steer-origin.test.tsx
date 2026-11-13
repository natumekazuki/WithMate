import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { SessionMessageColumn, type SessionMessageColumnProps } from "../../src/chat/conversation/session-message-column.js";
import type { Message } from "../../src-shared/session/session-state.js";
import type { SessionSteerOrigin } from "../../src-shared/session/session-turn-queue.js";

// @test-value v2
// kind = "contract"
// claim = "直接Steerは保存された入力自身の親発言者・avatar・From導線を再表示後も保ち、開始Turnの別actorを通常ユーザーや旧入力へ帰属させない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/942; docs/design/desktop-ui.md#turn-input-details" }
// fault = "queueのないSteerをユーザー表示する、開始actorで置換する、または全追加入力を親発言へ変える"
// observable = "実SessionMessageColumnのrow種別・保存名・avatar・@宛先・FromのopenSession対象、reload相当のremount後の一致と配送状態"
// observation_boundary = "consumer"
// scope = "保存message→実chat column→turn-input readerとheader、IPC execution読取をfixture化"
// lifecycle = "permanent"
// impact = "利用者が親の追加指示を自分の発言と誤認し送信元へ辿れなくなる"
// distinction = "queue rowや保存testではqueueのない追加入力と開始Turnのorigin競合を検出できない。少数messageのDOMで継続確認する"
// @end-test-value
test("direct Steer attribution survives remount and stays separate from the Turn starter", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  Object.defineProperties(dom.window.HTMLElement.prototype, { clientHeight: { get: () => 720 }, clientWidth: { get: () => 960 }, offsetHeight: { get() { return this.classList.contains("session-message-list") ? 720 : 160; } }, offsetWidth: { get: () => 960 } });
  dom.window.HTMLElement.prototype.scrollTo = function (options) { if (typeof options === "object") this.scrollTop = options.top ?? 0; };
  dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  const keys = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? dom.window : (dom.window as any)[key] });
  const opened: string[][] = [];
  const origin: SessionSteerOrigin = { kind: "session", operation: "steer", actorKind: "main", actorSessionId: "parent", actorIncarnationId: "p-inc", actorTurnId: "7", targetSessionId: "child", targetIncarnationId: "c-inc",
    actorSnapshot: { sessionTitle: "Parent Work", character: { id: "parent-character", name: "Saved Parent", iconPath: "C:/fixture/parent.png" } },
    targetSnapshot: { sessionTitle: "Child Work", character: { id: "child-character", name: "Saved Child", iconPath: "" } } };
  const starter = { ...origin, operation: "send", actorSessionId: "starter", actorSnapshot: { sessionTitle: "Starter Work", character: { id: "starter-character", name: "Turn Starter", iconPath: "" } } };
  Object.defineProperty(dom.window, "withmate", { value: { openSession: async (...ids: string[]) => { opened.push(ids); }, readSessionExecution: async () => ({ ok: true, origin: starter, receiptId: null, turnId: "42", turnState: "running", userMessageSeq: 0, executionSettings: null }) } });
  const direct: Message = { role: "user", text: "Parent additional instruction", historyIndex: 4, turnInput: { turnId: "42", nativeTurnId: "native", state: "confirmed", attachments: [], origin } };
  const messages: Message[] = [direct,
    { role: "user", text: "User additional instruction", historyIndex: 5, turnInput: { ...direct.turnInput!, origin: undefined } },
    { role: "user", text: "Old additional instruction", historyIndex: 6, turnInput: { ...direct.turnInput!, state: "unknown", origin: undefined } },
    { role: "user", text: "Queued instruction", historyIndex: 7, turnInput: { ...direct.turnInput!, origin: undefined, queueId: "receipt" } },
  ];
  const noop = () => {};
  const props: SessionMessageColumnProps = { sessionId: "child", inputReadContext: { ownerSessionId: "child", target: { kind: "main", sessionId: "child", incarnationId: "c-inc" } },
    character: { id: "current-child", name: "Current Child", iconPath: "", description: "", roleMarkdown: "", notesMarkdown: "", updatedAt: "", themeColors: { main: "#445566", sub: "#667788" } }, messages, expandedArtifacts: {}, messageListRef: createRef(), isRunning: false,
    liveApprovalRequest: null, approvalActionRequestId: null, liveElicitationRequest: null, elicitationActionRequestId: null,
    liveRunAssistantText: "", hasLiveRunAssistantText: false, liveRunErrorMessage: "", isMessageListFollowing: true,
    onMessageListScroll: noop, onToggleArtifact: noop, onOpenDiff: noop, onResolveLiveApproval: noop, onResolveLiveElicitation: noop };
  let root = createRoot(dom.window.document.getElementById("root")!);
  try {
    for (let reload = 0; reload < 2; reload++) {
      await act(async () => root.render(<SessionMessageColumn {...props} messages={JSON.parse(JSON.stringify(messages))} />));
      const rows = [...dom.window.document.querySelectorAll("article.message-row")];
      assert.equal(rows.length, 4);
      const parent = rows[0];
      assert.ok(parent.classList.contains("session-origin"));
      assert.equal(parent.querySelector(".message-character-name")?.textContent, "Saved Parent");
      assert.match(parent.querySelector("img")?.getAttribute("src") ?? "", /parent\.png/);
      assert.equal(parent.querySelector(".session-message-mention")?.textContent, "@Saved Child");
      assert.equal(parent.querySelector(".related-session-direction")?.textContent, "From");
      assert.equal(parent.querySelector(".turn-input-state")?.textContent, "Additional Input Confirmed");
      await act(async () => (parent.querySelector('[aria-label="Open Sender: Parent Work"]') as HTMLButtonElement).click());
      assert.deepEqual(opened.at(-1), ["parent", undefined]);
      for (const row of rows.slice(1, 3)) {
        assert.ok(row.classList.contains("user")); assert.equal(row.querySelector(".session-message-address"), null);
      }
      assert.equal(rows[2].querySelector(".turn-input-state")?.textContent, "Input Delivery Unknown");
      assert.equal(rows[3].querySelector(".message-character-name")?.textContent, "Turn Starter");
      if (reload === 0) { await act(async () => root.unmount()); root = createRoot(dom.window.document.getElementById("root")!); }
    }
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const key of keys) { const descriptor = previous.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
