import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { SessionTurnQueueStatus } from "../../src/chat/conversation/session-turn-queue-row.js";
import { TurnInputDetails } from "../../src/chat/conversation/turn-input-details.js";
import type { SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";

const receipt: SessionTurnQueueReceipt = {
  id: "receipt", sessionId: "target", incarnationId: "target-inc", requestId: "request", sequence: 1, queuePosition: 1,
  state: "queued", turnId: null, userMessageSeq: null, reason: null, releasedAt: null, createdAt: "now", updatedAt: "now",
  captured: { origin: { kind: "session", operation: "send", targetSessionId: "target", targetIncarnationId: "target-inc", deliveryTiming: "after_source_turn" },
    request: { userMessage: "Report", clientRequestId: "request", executionOptions: { model: "model", reasoningEffort: "medium", approvalMode: "on-request", codexSandboxMode: "workspace-write", codexSpeed: "standard", codexReviewer: "user", customAgentName: "" } }, attachments: [], provider: "codex", workspacePath: "workspace" },
};

// @test-value v2
// kind = "contract"
// claim = "遅延入力の通常待機理由はInput Detailsで確認でき、不明状態を表示し、送信元Turnの終端・実解放までSteerを無効にして取消と即時入力を妨げない"
// oracle = { type = "contract", ref = "approved delayed Session message feature: after_source_turn gating" }
// fault = "待機理由を詳細で確認できない、不明状態を通常待機と混同する、未解放中にSteerを許可する、実解放後も無効にする、または即時入力や取消を巻き込む"
// observable = "Input Details内の待機理由、不明状態表示と各送信元状態のSteer・Cancel buttonのdisabled状態"
// observation_boundary = "component-behavior"
// scope = "SessionTurnQueueStatusとTurnInputDetailsの配送待機表示・操作"
// lifecycle = "permanent"
// impact = "送信元の完了前に受信Turnへ入力されるか、利用可能な操作が妨げられる"
// distinction = "backendの配送検査はrendererの表示とbutton状態を検出しない"
// @end-test-value
test("delayed delivery reports source state and gates only steer until terminal", () => {
  const render = (value: SessionTurnQueueReceipt) => new JSDOM(renderToStaticMarkup(<SessionTurnQueueStatus receipt={value} busy={false} onCancel={() => {}} onRelease={() => {}} onSendInput={() => {}} />)).window.document;
  const details = (value: SessionTurnQueueReceipt) => new JSDOM(renderToStaticMarkup(<TurnInputDetails message={{ role: "user", text: "Report" }} receipt={value} />)).window.document.querySelector("details")!;
  const button = (document: Document, name: string) => [...document.querySelectorAll("button")].find((item) => item.textContent === name || item.getAttribute("aria-label")?.startsWith(name))!;
  for (const phase of ["running", "unknown", undefined] as const) {
    const document = render({ ...receipt, sourceTurnPhase: phase });
    if (phase === "running") assert.match(details({ ...receipt, sourceTurnPhase: phase }).textContent!, /Waiting For Sender Turn/);
    else assert.match(document.body.textContent!, /Source Turn State Unknown/);
    assert.equal(button(document, "Steer").disabled, true);
    assert.equal(button(document, "Cancel").disabled, false);
  }
  for (const phase of ["completed", "failed", "canceled"] as const) {
    const document = render({ ...receipt, sourceTurnPhase: phase });
    assert.equal(button(document, "Steer").disabled, false);
    assert.doesNotMatch(document.body.textContent!, /Waiting For Sender Turn|Source Turn State Unknown/);
  }
  const releasing = render({ ...receipt, sourceTurnPhase: "canceled", sourceTurnPendingRelease: true });
  assert.match(details({ ...receipt, sourceTurnPhase: "canceled", sourceTurnPendingRelease: true }).textContent!, /Waiting For Sender Turn/);
  assert.equal(button(releasing, "Steer").disabled, true);
  assert.equal(button(releasing, "Cancel").disabled, false);
  const immediate = render({ ...receipt, captured: { ...receipt.captured, origin: { ...receipt.captured.origin!, deliveryTiming: "immediate" } }, sourceTurnPhase: "running" });
  assert.equal(button(immediate, "Steer").disabled, false);
});
