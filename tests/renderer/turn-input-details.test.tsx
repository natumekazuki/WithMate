import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { TurnExecutionDetails, TurnInputStatus } from "../../src/chat/conversation/turn-input-details.js";
import type { TurnInputDeliveryState } from "../../src-shared/session/session-state.js";

// @test-value v2
// kind = "contract"
// claim = "追加入力のpending・confirmed・unknown・not-sentを入力枠の配送状態として表示する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/837#追加入力の表示と取得" }
// fault = "不明や未送信を確認済み追加と表示する"
// observable = "入力枠の配送labelと不明・未送信の説明"
// observation_boundary = "component-behavior"
// scope = "TurnInputStatusの保存済み追加入力表示"
// lifecycle = "permanent"
// impact = "利用者が未送信や配送不明の指示を確認済み追加と誤認する"
// distinction = "型検査と保存testでは入力枠の利用者向けlabelと説明を確認しない。小さいSSRで4状態を検証する"
// @end-test-value
test("input rows distinguish additional input delivery states", () => {
  const cases: [TurnInputDeliveryState, string][] = [["pending", "Input Acceptance Pending"], ["confirmed", "Additional Input Confirmed"], ["unknown", "Input Delivery Unknown"], ["not-sent", "Input Not Sent"]];
  for (const [state, label] of cases) {
    const markup = renderToStaticMarkup(<TurnInputStatus message={{ role: "user", text: "instruction", turnInput: { turnId: "42", nativeTurnId: "native-turn-9", state, attachments: [] } }} />);
    const document = new JSDOM(markup).window.document;
    assert.equal(document.querySelector(".turn-input-state")?.textContent, label);
    if (state === "unknown") assert.match(document.body.textContent!, /not a confirmed addition/);
    if (state === "not-sent") assert.match(document.body.textContent!, /not delivered to the Turn/);
  }
});

// @test-value v2
// kind = "contract"
// claim = "応答側の詳細は正確な保存応答から開始入力を解決し、保存設定・入力状態・同じ受付snapshotの比較と添付・同一TurnのProvider参照を表示する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details; user request: 今のDetailsの延長線上で再設計して修正" }
// fault = "応答と異なる入力へ結び付ける、保存設定や状態を失う、会話本文で比較を上書きするか、補助参照を比較より先に展開する"
// observable = "共通読取request、設定と状態のnative開閉状態・Provider等の値と順序、比較DOM、添付、Referencesの受付・WithMate/Provider Turn値"
// observation_boundary = "consumer"
// scope = "TurnExecutionDetailsとreadSessionExecutionのrenderer境界。保存serviceは固定snapshotで代替"
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
  const description = { ok: true, origin: null, receiptId: "receipt-2", receiptState: "completed", turnId: "42", turnState: "completed", resultState: "saved", userMessageSeq: 6, assistantMessageSeq: 7,
    inputs: { entry: { receiptId: "receipt-2", inputSeq: null, kind: "start", stage: "planned", comparison: "changed", detail: { operation: "get_execution_input", receiptId: "receipt-2" } }, startChanged: null, additional: { confirmedCount: 0, references: [], referencesNextOffset: null, unresolved: [{ seq: 7, state: "unknown" }], unresolvedCount: 1, unresolvedNextOffset: null, notSent: [], notSentCount: 0, notSentNextOffset: null, coverage: "unknown" } } };
  const piece = (text: string, reference: string) => ({ ok: true, text, offset: 0, nextOffset: null, totalChars: text.length, attachments: [{ id: reference, kind: "file", name: "input.md", reference }] });
  Object.defineProperty(dom.window, "withmate", { value: { readSessionExecution: async (_owner: string, operation: string, request: unknown) => {
    requests.push({ operation, request });
    if (operation === "get_execution" && (request as { messageSeq?: number }).messageSeq === 7) return { ...description, receiptId: null };
    return operation === "get_execution" ? { ...description, executionSettings: { source: "input", provider: "codex", model: "captured-model", approvalMode: "on-request", codexReviewer: "auto-review", codexSpeed: "fast", reasoningEffort: "xhigh", codexSandboxMode: "workspace-write", customAgentName: "" }, output: null, inputs: { ...description.inputs, entry: { ...description.inputs.entry, comparison: "unchanged" } } } : { ...description, ...piece("saved changed input", "after/input.md"), expectedInput: "snapshot", originalKnown: true, inputPair: { original: piece("saved original input", "before/input.md"), comparison: piece("saved changed input", "after/input.md") } };
  } } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => { root.render(<TurnExecutionDetails context={{ ownerSessionId: "main", target: { kind: "main", sessionId: "main", incarnationId: "inc" } }} message={{ role: "assistant", text: "response, not the saved input", historyIndex: 7 }} inputMessages={[
      { role: "user", text: "additional", turnInput: { turnId: "42", nativeTurnId: "native-turn-9", state: "confirmed", attachments: [] } },
      { role: "user", text: "other", turnInput: { turnId: "other", nativeTurnId: "other-native", state: "confirmed", attachments: [] } },
    ]} />); });
    assert.deepEqual([...dom.window.document.querySelectorAll("pre")].map((element) => element.textContent), ["saved original input", "saved changed input"]);
    const text = dom.window.document.body.textContent!;
    assert.match(text, /Changed From Original/);
    assert.match(text, /1 Unresolved.*Input Coverage Unknown/);
    assert.match(text, /before\/input.md/); assert.match(text, /after\/input.md/);
    const inputState = dom.window.document.querySelector('dl[aria-label="Input State"]')!;
    const settings = dom.window.document.querySelector<HTMLDetailsElement>('details[aria-label="Execution Settings"]')!;
    const stateDetails = dom.window.document.querySelector<HTMLDetailsElement>('details[aria-label="Input State"]')!;
    assert.equal(settings.open, true); assert.equal(stateDetails.open, true);
    assert.deepEqual([...settings.querySelectorAll("dt")].map((term) => [term.textContent, term.nextElementSibling?.textContent]), [
      ["provider", "Codex"], ["approval", "Provider Controlled"], ["reviewer", "auto-review"], ["speed", "fast"],
      ["model", "captured-model"], ["reasoning", "X High"], ["sandbox", "Workspace Write"],
    ]);
    assert.ok(settings.compareDocumentPosition(inputState) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    const stateRows = new Map([...inputState.querySelectorAll("dt")].map((term) => [term.textContent, term.nextElementSibling?.textContent]));
    assert.equal(stateRows.get("Receipt State"), "Completed");
    assert.equal(stateRows.get("Turn State"), "Completed");
    assert.equal(stateRows.get("Input"), "Start Input · Changed From Original");
    assert.equal(stateRows.get("Additional Inputs"), "0 Confirmed Additional Inputs · 1 Unresolved · Input Coverage Unknown");
    const comparison = dom.window.document.querySelector('section[aria-label="Input Comparison"]')!;
    await act(async () => { settings.open = false; settings.dispatchEvent(new dom.window.Event("toggle")); });
    assert.equal(settings.open, false); assert.equal(stateDetails.open, true);
    await act(async () => { stateDetails.open = false; stateDetails.dispatchEvent(new dom.window.Event("toggle")); });
    assert.equal(stateDetails.open, false); assert.equal(settings.open, false);
    assert.equal(comparison.closest("details"), null);
    await act(async () => { settings.open = true; settings.dispatchEvent(new dom.window.Event("toggle")); });
    assert.equal(settings.open, true); assert.equal(stateDetails.open, false);
    const references = dom.window.document.querySelector<HTMLDetailsElement>('details[aria-label="References"]')!;
    assert.equal(references.open, false);
    assert.ok(comparison.compareDocumentPosition(references) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    await act(async () => { references.open = true; references.dispatchEvent(new dom.window.Event("toggle")); });
    const receiptTerm = [...references.querySelectorAll("dt")].find((term) => term.textContent === "Receipt")!;
    assert.equal(receiptTerm.nextElementSibling?.textContent, "receipt-2");
    const turnTerm = [...references.querySelectorAll("dt")].find((term) => term.textContent === "WithMate Turn")!;
    assert.equal(turnTerm.nextElementSibling?.textContent, "42");
    const nativeTerm = [...references.querySelectorAll("dt")].find((term) => term.textContent === "Provider Turn")!;
    assert.equal(nativeTerm.nextElementSibling?.textContent, "native-turn-9");
    assert.deepEqual(requests.map(({ operation }) => operation), ["get_execution", "get_execution", "get_execution_input"]);
    assert.equal((requests[0].request as { messageSeq: number }).messageSeq, 7);
    assert.equal((requests[1].request as { messageSeq: number }).messageSeq, 6);
    assert.equal((requests[2].request as { receiptId: string }).receiptId, "receipt-2");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of keys) { const descriptor = previous.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "入力詳細は各配送分類の総数を表示し、100件以降を正確なTurnの継続参照で開き、失敗時も既読と続きの位置を保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details" }
// fault = "summary配列長を総数にする、開始入力を含むoffsetをずらす、失敗で既読を失う、またはseq未確定の受付を別入力として読む"
// observable = "総件数DOM、分類別継続requestと再試行offset、追加された入力行、受付から取得した原文DOM"
// observation_boundary = "consumer"
// scope = "TurnExecutionDetailsとreadSessionExecution。100件summaryと継続pageを固定fixtureで返す"
// lifecycle = "permanent"
// impact = "多数の指示を含むTurnで保存済み入力へ到達できず、配送状況の件数を誤認する"
// distinction = "storage testはrendererのoffset引継ぎや失敗からの継続操作を検証しない。3分類を単一component fixtureで確認する"
// @end-test-value
test("input details page all delivery groups and retry without losing saved references", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  const target = { kind: "auxiliary", sessionId: "aux", mainSessionId: "main", mainIncarnationId: "main-inc", incarnationId: "inc" } as const;
  const description = { ok: true, origin: null, receiptId: "start-receipt", receiptState: "running", turnId: "42", turnState: "running", resultState: "running", userMessageSeq: 0, assistantMessageSeq: null,
    inputs: { entry: null, startChanged: false, additional: {
      confirmedCount: 102, references: Array.from({ length: 100 }, (_, index) => ({ seq: index + 1 })), referencesNextOffset: 101,
      unresolvedCount: 101, unresolved: Array.from({ length: 100 }, (_, index) => ({ seq: index + 200, state: "unknown" })), unresolvedNextOffset: 100,
      notSentCount: 101, notSent: Array.from({ length: 100 }, (_, index) => ({ seq: index + 400 })), notSentNextOffset: 100, coverage: "recorded",
    } } };
  const requests: { operation: string; request: Record<string, unknown> }[] = [];
  let failConfirmed = true;
  const piece = (text: string) => ({ ok: true, text, offset: 0, nextOffset: null, totalChars: text.length, attachments: [] });
  Object.defineProperty(dom.window, "withmate", { value: { readSessionExecution: async (owner: string, operation: string, request: Record<string, unknown>) => {
    assert.equal(owner, "main"); assert.deepEqual(request.target, target);
    requests.push({ operation, request });
    if (operation === "get_execution") return { ...description, output: null };
    if (operation === "list_execution_inputs") {
      assert.equal(request.turnId, "42");
      if (request.state === "confirmed" && failConfirmed) { failConfirmed = false; return { ok: false, code: "READ_FAILED", message: "Saved input list unavailable" }; }
      const items = request.state === "confirmed" ? [{ seq: 101, kind: "additional", state: "confirmed" }, { seq: 102, kind: "additional", state: "confirmed" }]
        : request.state === "unresolved" ? [{ seq: null, kind: "additional", state: "pending", queueId: "pending-receipt" }]
        : [{ seq: 500, kind: "additional", state: "not-sent", queueId: "not-sent-receipt" }];
      return { ...description, offset: request.offset, nextOffset: null, total: request.state === "confirmed" ? 103 : 101, items };
    }
    return { ...description, ...piece(String(request.receiptId ?? request.seq)), expectedInput: "snapshot", originalKnown: true, inputPair: { original: piece(String(request.receiptId ?? request.seq)), comparison: piece(String(request.receiptId ?? request.seq)) } };
  } } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const click = async (button: Element) => act(async () => { button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  const buttonNamed = (text: string) => [...dom.window.document.querySelectorAll("button")].find((button) => button.textContent === text)!;
  try {
    await act(async () => { root.render(<TurnExecutionDetails context={{ ownerSessionId: "main", target }} message={{ role: "assistant", text: "response", historyIndex: 1 }} />); });
    assert.match(dom.window.document.body.textContent!, /102 Confirmed Additional Inputs · 101 Unresolved/);
    assert.match(dom.window.document.body.textContent!, /101 Inputs Not Sent/);
    const confirmed = dom.window.document.querySelector('section[aria-label="Confirmed Inputs"]')!;
    await click(buttonNamed("Load More Confirmed Inputs"));
    assert.equal(confirmed.querySelectorAll("li").length, 100);
    assert.match(confirmed.textContent!, /Could Not Read Confirmed Inputs/);
    assert.ok(confirmed.querySelector('button[aria-label="Confirmed Inputs Read Error Details"]'));
    await click(buttonNamed("Retry Confirmed Inputs"));
    assert.equal(confirmed.querySelectorAll("li").length, 102);
    for (const label of ["Unresolved Inputs", "Not Sent Inputs"]) await click(buttonNamed(`Load More ${label}`));
    const unresolved = dom.window.document.querySelector('section[aria-label="Unresolved Inputs"]')!;
    assert.equal(unresolved.querySelectorAll("li").length, 101);
    const pending = [...unresolved.querySelectorAll("li")].at(-1)!;
    assert.match(pending.textContent!, /Input Acceptance Pending · Receipt pending-receipt/);
    await click(pending.querySelector("button")!);
    assert.deepEqual([...pending.querySelectorAll("pre")].map((element) => element.textContent), ["pending-receipt", "pending-receipt"]);
    const notSent = dom.window.document.querySelector('section[aria-label="Not Sent Inputs"]')!;
    assert.equal(notSent.querySelectorAll("li").length, 101);
    await click([...confirmed.querySelectorAll("li")].at(-1)!.querySelector("button")!);
    await click([...notSent.querySelectorAll("li")].at(-1)!.querySelector("button")!);
    assert.deepEqual(requests.filter(({ operation }) => operation === "list_execution_inputs").map(({ request }) => [request.state, request.offset]), [["confirmed", 101], ["confirmed", 101], ["unresolved", 100], ["not-sent", 100]]);
    const reads = requests.filter(({ operation }) => operation === "get_execution_input").map(({ request }) => request);
    assert.ok(reads.some((request) => request.receiptId === "pending-receipt" && request.seq === undefined));
    assert.ok(reads.some((request) => request.turnId === "42" && request.seq === 102));
    assert.ok(reads.some((request) => request.receiptId === "not-sent-receipt" && request.seq === undefined));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of keys) { const descriptor = previous.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
