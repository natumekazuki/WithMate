import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { SessionTurnQueueStatus } from "../../src/chat/conversation/session-turn-queue-row.js";
import type { SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";

const receipt: SessionTurnQueueReceipt = {
  id: "receipt", sessionId: "target", incarnationId: "target-inc", requestId: "request", sequence: 1, queuePosition: 1,
  state: "queued", turnId: null, userMessageSeq: null, reason: null, releasedAt: null, createdAt: "now", updatedAt: "now",
  captured: { origin: { kind: "session", operation: "send", targetSessionId: "target", targetIncarnationId: "target-inc", deliveryTiming: "after_source_turn" },
    request: { userMessage: "Report", clientRequestId: "request", executionOptions: { model: "model", reasoningEffort: "medium", approvalMode: "on-request", codexSandboxMode: "workspace-write", codexSpeed: "standard", codexReviewer: "user", customAgentName: "" } }, attachments: [], provider: "codex", workspacePath: "workspace" },
};

// @test-value v2
// kind = "contract"
// claim = "遅延入力は送信元Turnの終端・実解放確認まで待機理由を示してSteerを無効にし、取消と他の即時入力を妨げない"
// oracle = { type = "contract", ref = "approved delayed Session message feature: after_source_turn gating" }
// fault = "実行中や不明の送信元からSteerを許可する、終端後も無効にする、または即時入力や取消を巻き込む"
// observable = "各送信元状態における待機表示とSteer・Cancel buttonのdisabled状態"
// observation_boundary = "component-behavior"
// scope = "SessionTurnQueueStatusの配送待機表示と操作"
// lifecycle = "permanent"
// impact = "送信元の完了前に受信Turnへ入力されるか、利用可能な操作が妨げられる"
// distinction = "backendの配送検査はrendererの表示とbutton状態を検出しない"
// @end-test-value
test("delayed delivery reports source state and gates only steer until terminal", () => {
  const render = (value: SessionTurnQueueReceipt) => new JSDOM(renderToStaticMarkup(<SessionTurnQueueStatus receipt={value} busy={false} onCancel={() => {}} onRelease={() => {}} onSendInput={() => {}} />)).window.document;
  const button = (document: Document, name: string) => [...document.querySelectorAll("button")].find((item) => item.textContent === name || item.getAttribute("aria-label")?.startsWith(name))!;
  for (const phase of ["running", "unknown", undefined] as const) {
    const document = render({ ...receipt, sourceTurnPhase: phase });
    assert.match(document.body.textContent!, phase === "running" ? /Waiting For Sender Turn/ : /Source Turn State Unknown/);
    assert.equal(button(document, "Steer").disabled, true);
    assert.equal(button(document, "Cancel").disabled, false);
  }
  for (const phase of ["completed", "failed", "canceled"] as const) {
    const document = render({ ...receipt, sourceTurnPhase: phase });
    assert.equal(button(document, "Steer").disabled, false);
    assert.doesNotMatch(document.body.textContent!, /Waiting For Sender Turn|Source Turn State Unknown/);
  }
  const releasing = render({ ...receipt, sourceTurnPhase: "canceled", sourceTurnPendingRelease: true });
  assert.match(releasing.body.textContent!, /Waiting For Sender Turn/);
  assert.equal(button(releasing, "Steer").disabled, true);
  assert.equal(button(releasing, "Cancel").disabled, false);
  const immediate = render({ ...receipt, captured: { ...receipt.captured, origin: { ...receipt.captured.origin!, deliveryTiming: "immediate" } }, sourceTurnPhase: "running" });
  assert.equal(button(immediate, "Steer").disabled, false);
});
