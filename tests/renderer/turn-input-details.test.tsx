import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { TurnExecutionDetails, TurnInputStatus } from "../../src/chat/conversation/turn-input-details.js";

// @test-value v2
// kind = "contract"
// claim = "配送不明・未送信の追加入力は理由を表示し、確認済み入力と誤認させない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details" }
// fault = "不明や未送信を確認済み追加と表示する"
// observable = "入力枠の不明・未送信のalertと説明"
// observation_boundary = "component-behavior"
// scope = "TurnInputStatusの保存済み追加入力表示"
// lifecycle = "permanent"
// impact = "利用者が未送信や配送不明の指示を確認済み追加と誤認する"
// distinction = "型検査と保存testでは入力枠の配送不明・未送信の説明を確認しない。小さいSSRで2状態を検証する"
// @end-test-value
test("additional input failures remain visible", () => {
  const cases = [["unknown", /not a confirmed addition/], ["not-sent", /not delivered to the Turn/]] as const;
  for (const [state, reason] of cases) {
    const markup = renderToStaticMarkup(<TurnInputStatus message={{ role: "user", text: "instruction", turnInput: { turnId: "42", nativeTurnId: "native-turn-9", state, attachments: [] } }} />);
    const document = new JSDOM(markup).window.document;
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", reason);
  }
});

// @test-value v2
// kind = "contract"
// claim = "応答Detailsは正確な保存応答から開始受付を解決し、保存実行設定と配送・処理状態を独立して開閉できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details; user: 入力比較をUIから外しAPIに残す" }
// fault = "別の入力の状態を表示する、保存設定を現在設定に置き換える、または設定と配送状態の開閉を連動させる"
// observable = "開始受付を解決するrequestのmessageSeq、保存設定の項目値、配送とTurn状態、native details.open"
// observation_boundary = "consumer"
// scope = "TurnExecutionDetailsとreadSessionExecutionのrenderer接続"
// lifecycle = "permanent"
// impact = "利用者が実行設定と配送状態を取り違え、別の指示の結果を確認する"
// distinction = "storageや型検査では応答から受付への接続とDOMの開閉・表示を確認できない"
// @end-test-value
test("response details keep captured settings and exact delivery state", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of [["window", dom.window], ["document", dom.window.document], ["IS_REACT_ACT_ENVIRONMENT", true]] as const) Object.defineProperty(globalThis, key, { value, configurable: true });
  const requests: { messageSeq: number }[] = [];
  Object.defineProperty(dom.window, "withmate", { value: { readSessionExecution: async (_owner: string, operation: string, request: { messageSeq: number }) => {
    assert.equal(operation, "get_execution"); requests.push(request);
    return { ok: true, origin: null, receiptId: request.messageSeq === 7 ? null : "receipt", receiptState: "completed", turnId: "42", turnState: "completed", userMessageSeq: 6,
      executionSettings: { source: "input", provider: "codex", model: "captured-model", approvalMode: "on-request", codexReviewer: "auto-review", codexSpeed: "fast", reasoningEffort: "xhigh", codexSandboxMode: "workspace-write", customAgentName: "" } };
  } } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(<TurnExecutionDetails context={{ ownerSessionId: "main", target: { kind: "main", sessionId: "main", incarnationId: "inc" } }} message={{ role: "assistant", text: "saved response", historyIndex: 7 }} />));
    assert.deepEqual(requests.map(request => request.messageSeq), [7, 6]);
    const settings = dom.window.document.querySelector<HTMLDetailsElement>('details[aria-label="Execution Settings"]')!;
    const state = dom.window.document.querySelector<HTMLDetailsElement>('details[aria-label="Input State"]')!;
    assert.deepEqual([...settings.querySelectorAll("dt")].map(term => [term.textContent, term.nextElementSibling?.textContent]), [
      ["provider", "Codex"], ["approval", "Provider Controlled"], ["reviewer", "auto-review"], ["speed", "fast"], ["model", "captured-model"], ["reasoning", "X High"], ["sandbox", "Workspace Write"],
    ]);
    assert.deepEqual([...state.querySelectorAll("dt")].map(term => [term.textContent, term.nextElementSibling?.textContent]), [["Receipt State", "Completed"], ["Turn State", "Completed"]]);
    await act(async () => { settings.open = false; settings.dispatchEvent(new dom.window.Event("toggle")); });
    assert.equal(settings.open, false); assert.equal(state.open, true);
    await act(async () => { state.open = false; state.dispatchEvent(new dom.window.Event("toggle")); });
    assert.equal(settings.open, false); assert.equal(state.open, false);
    await act(async () => { settings.open = true; settings.dispatchEvent(new dom.window.Event("toggle")); });
    assert.equal(settings.open, true); assert.equal(state.open, false);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const key of keys) { const descriptor = previous.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
