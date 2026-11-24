import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { SessionTurnQueueRow } from "../../src/chat/conversation/session-turn-queue-row.js";
import type { SessionTurnQueueCapturedInput, SessionTurnQueueOrigin, SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";

const target = { kind: "main" as const, sessionId: "owner", incarnationId: "owner-v1" };
const origin: SessionTurnQueueOrigin = { kind: "gui", operation: "send", targetSessionId: target.sessionId, targetIncarnationId: target.incarnationId };
const original: SessionTurnQueueOrigin = { ...origin, kind: "session", actorKind: "main", actorSessionId: "sender", actorIncarnationId: "sender-v1", actorTurnId: "12",
  actorSnapshot: { sessionTitle: "Sender Workspace", character: { id: "sender", name: "Original Agent", iconPath: "" } } };
const character = { id: "owner", name: "Owner", iconPath: "", description: "", roleMarkdown: "", notesMarkdown: "", updatedAt: "", themeColors: { main: "#112233", sub: "#445566" } };
const settings = captureSessionExecutionOptions(buildNewSession({ id: "owner", taskTitle: "Fixture", workspacePath: "C:/fixture", workspaceLabel: "Fixture",
  branch: "main", characterId: character.id, character: character.name, characterIconPath: "", characterThemeColors: character.themeColors, approvalMode: "on-request" }));

// @test-value v2
// kind = "contract"
// claim = "再実行の待機中に元の指示を変更していなければ元話者を示し、編集後は元話者の発言として表示しない"
// oracle = { type = "contract", ref = "docs/design/session-history.md: Main列の初期枠・子Session枠" }
// fault = "GUI起点を常に話者とみなす、または編集済み再送を元Sessionの原文に見せる"
// observable = "本番の予約カードに表示される本文・再送label・元話者名とリンクの有無"
// observation_boundary = "component-behavior"
// scope = "同一受付で本文編集した再送予約。providerとIPCは使わない"
// lifecycle = "permanent"
// impact = "相手から新規の依頼が来たか、利用者が編集した再実行かを取り違える"
// distinction = "SQLiteが来歴を分けて保存しても実際にどの話者をカードへ出すかは決まらない"
// @end-test-value
test("Retry queue cards distinguish a replay from a user edit", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const prior = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const accepted: SessionTurnQueueCapturedInput = { origin, provider: "codex", workspacePath: "C:/fixture", attachments: [],
    retrySource: { receiptId: "original", turnId: "13", origin: original, changedSinceAcceptance: false },
    request: { userMessage: "Original content", clientRequestId: "request", submitSource: "retry", executionOptions: settings } };
  const receipt: SessionTurnQueueReceipt = { id: "retry", requestId: "request", sessionId: target.sessionId, incarnationId: target.incarnationId, state: "queued",
    captured: accepted, accepted, dispatched: null, turnId: null, userMessageSeq: null, inputTurnId: null, reason: null, releasedAt: null,
    queuePosition: 1, sequence: 1, createdAt: "now", updatedAt: "now" };
  const renderQueue = (next: SessionTurnQueueReceipt) => root.render(<SessionTurnQueueRow receipt={next} character={character} busy={false} onCancel={() => {}} onRelease={() => {}} />);
  const article = () => dom.window.document.querySelector("article")!;
  try {
    await act(async () => renderQueue(receipt));
    assert.equal(article().querySelector(".message-character-name")?.textContent, "Original Agent");
    assert.ok(article().querySelector('button[aria-label="Open Sender: Sender Workspace"]'));
    assert.match(article().textContent!, /Retry requested by you · Previous input from Original Agent/);
    assert.match(article().textContent!, /Original content/);

    const changed = { ...accepted, request: { ...accepted.request, userMessage: "User edited content" } };
    await act(async () => renderQueue({ ...receipt, captured: changed, updatedAt: "edited" }));
    assert.ok(article().classList.contains("user"));
    assert.equal(article().querySelector('button[aria-label="Open Sender: Sender Workspace"]'), null);
    assert.deepEqual([...article().querySelectorAll(".message-character-name")].map((node) => node.textContent),
      ["Retry requested by you · Previous input from Original Agent"]);
    assert.match(article().textContent!, /User edited content/);
    assert.doesNotMatch(article().textContent!, /Original content/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of prior) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
