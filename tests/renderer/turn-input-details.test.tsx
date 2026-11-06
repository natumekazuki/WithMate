import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { TurnInputDetails } from "../../src/chat/conversation/turn-input-details.js";
import type { TurnInputDeliveryState } from "../../src-shared/session/session-state.js";

// @test-value v2
// kind = "contract"
// claim = "追加入力のpending・confirmed・unknown・not-sentを配送状態として表示し、WithMate TurnとProvider Turnの参照を混同しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/837#追加入力の表示と取得" }
// fault = "不明や未送信を確認済み追加と表示する、または異なるTurn identityを同じ参照で表示する"
// observable = "入力詳細DOMの配送label、WithMate Turn・Provider Turnの対応する値"
// observation_boundary = "component-behavior"
// scope = "TurnInputDetailsの保存済み追加入力表示"
// lifecycle = "permanent"
// impact = "利用者が未送信の指示を実行済みと誤認したり、異なるTurnの結果を参照する"
// distinction = "型検査と保存testでは利用者向けlabelとIDの表示対応を確認しない。小さいSSRで4状態を検証する"
// @end-test-value
test("input details distinguish delivery states and WithMate/native identities", () => {
  const cases: [TurnInputDeliveryState, string][] = [["pending", "Input Acceptance Pending"], ["confirmed", "Additional Input Confirmed"], ["unknown", "Input Delivery Unknown"], ["not-sent", "Input Not Sent"]];
  for (const [state, label] of cases) {
    const markup = renderToStaticMarkup(<TurnInputDetails message={{ role: "user", text: "instruction", turnInput: { turnId: "42", nativeTurnId: "native-turn-9", state, attachments: [] } }} />);
    const document = new JSDOM(markup).window.document;
    assert.equal(document.querySelector(".turn-input-state")?.textContent, label);
    const refs = [...document.querySelectorAll("dt")].map((term) => [term.textContent, term.nextElementSibling?.textContent]);
    assert.deepEqual(refs, [["WithMate Turn", "42"], ["Provider Turn", "native-turn-9"]]);
  }
});

// @test-value v2
// kind = "contract"
// claim = "入力詳細は同じ受付の共通読取snapshotの原文・比較対象と添付参照を表示し、入力の変更と未確定追加入力を区別する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/836#queueの指示差分を取得する契約" }
// fault = "会話本文や別取得の原文でsnapshotを上書きし、同名添付を識別できなくするか不明入力を追加なしとする"
// observable = "共通読取の受付request、原文・比較対象DOM、添付参照、変更labelと未確定coverage"
// observation_boundary = "consumer"
// scope = "TurnInputDetailsとreadSessionExecutionのrenderer境界。保存serviceは固定snapshotで代替"
// lifecycle = "permanent"
// impact = "利用者が編集された指示や添付の変更を見落とし、配送不明を追加なしと誤認する"
// distinction = "storageのsnapshot testや型検査ではlazy読取から実DOMへの接続を確認しない"
// @end-test-value
test("input details render the common paired snapshot rather than message text", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  const requests: { operation: string; request: unknown }[] = [];
  const description = { ok: true, origin: null, receiptId: "receipt-2", receiptState: "queued", turnId: null, turnState: null, resultState: "not-started", userMessageSeq: null, assistantMessageSeq: null,
    inputs: { entry: { receiptId: "receipt-2", inputSeq: null, kind: "start", stage: "planned", comparison: "changed", detail: { operation: "get_execution_input", receiptId: "receipt-2" } }, startChanged: null, additional: { confirmedCount: 0, references: [], unresolved: [{ seq: 7, state: "unknown" }], notSent: [], coverage: "unknown" } } };
  const piece = (text: string, reference: string) => ({ ok: true, text, offset: 0, nextOffset: null, totalChars: text.length, attachments: [{ id: reference, kind: "file", name: "input.md", reference }] });
  Object.defineProperty(dom.window, "withmate", { value: { readSessionExecution: async (_owner: string, operation: string, request: unknown) => {
    requests.push({ operation, request });
    return operation === "get_execution" ? { ...description, output: null, inputs: { ...description.inputs, entry: { ...description.inputs.entry, comparison: "unchanged" } } } : { ...description, ...piece("saved changed input", "after/input.md"), expectedInput: "snapshot", originalKnown: true, inputPair: { original: piece("saved original input", "before/input.md"), comparison: piece("saved changed input", "after/input.md") } };
  } } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => { root.render(<TurnInputDetails context={{ ownerSessionId: "main", target: { kind: "main", sessionId: "main", incarnationId: "inc" } }} message={{ role: "user", text: "not the saved snapshot", historyIndex: 7 }} />); });
    const details = dom.window.document.querySelector("details")!;
    await act(async () => { details.open = true; details.dispatchEvent(new dom.window.Event("toggle")); });
    assert.deepEqual([...dom.window.document.querySelectorAll("pre")].map((element) => element.textContent), ["saved original input", "saved changed input"]);
    const text = dom.window.document.body.textContent!;
    assert.match(text, /Changed From Original/);
    assert.match(text, /1 Unresolved.*Input Coverage Unknown/);
    assert.match(text, /before\/input.md/); assert.match(text, /after\/input.md/);
    assert.deepEqual(requests.map(({ operation }) => operation), ["get_execution", "get_execution_input"]);
    assert.equal((requests[0].request as { messageSeq: number }).messageSeq, 7);
    assert.equal((requests[1].request as { receiptId: string }).receiptId, "receipt-2");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of keys) { const descriptor = previous.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
