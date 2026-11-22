import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { FailedTurnRetry, FailedTurnRetryWithRead } from "../../src/chat/conversation/failed-turn-retry.js";
import { FailedTurnRetryContext } from "../../src/chat/runtime/failed-turn-retry-context.js";
import { SessionRecoveryActions } from "../../src/chat/runtime/session-recovery-actions.js";
import { TurnExecutionDetails, TurnInputDetailsContent, TurnInputReadBoundary } from "../../src/chat/conversation/turn-input-details.js";
import { executionOperationResultSchemas } from "../../src-shared/session/session-execution-read.js";
import type { RetryFailedSessionTurnRequest, SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";

// @test-value v2
// kind = "contract"
// claim = "確定失敗を履歴またはDockから一操作で再実行し、Detailsで編集差と元送信者を示す。履歴とDockの取得失敗から再取得でき、二重送信を防ぐ"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action Dock・回復操作; docs/design/session-run-lifecycle.md#gui-turn-queue" }
// fault = "失敗以外に操作を出す、編集差や取得失敗を伏せる、対象identityを取り違える、受付中に二重送信する"
// observable = "履歴とDockの操作の出し分け、Detailsの編集差と元送信者、失敗の表示・回復、送信された対象と要求数"
// observation_boundary = "component-behavior"
// scope = "保存済み失敗messageの再実行 UI。IPCはfixture"
// lifecycle = "permanent"
// impact = "意図しない対象や入力を再実行し、二重受付する"
// distinction = "main facadeとstorageのtestは画面の対象選択と受付中の操作を検証しない"
// @end-test-value
test("failed message resends its saved Turn once and reports edited input", async () => {
  const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true, url: "https://fixture.invalid" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const target = { kind: "main" as const, sessionId: "recipient", incarnationId: "recipient-inc" };
  let turnState = "failed";
  const origin = { kind: "session" as const, operation: "send" as const, targetSessionId: target.sessionId, targetIncarnationId: target.incarnationId,
    actorKind: "main" as const, actorSessionId: "sender", actorIncarnationId: "sender-inc", actorTurnId: "12", actorSnapshot: { sessionTitle: "Source", character: { id: "sender-character", name: "Sender", iconPath: "" } } };
  let retried = false;
  const guiOrigin = { kind: "gui" as const, operation: "send" as const, targetSessionId: target.sessionId, targetIncarnationId: target.incarnationId };
  const execution = () => executionOperationResultSchemas.get_execution.parse({ ok: true, origin: retried ? guiOrigin : origin, retrySource: retried ? { receiptId: "original", turnId: "40", origin, changedSinceAcceptance: true } : null, receiptId: "source", receiptState: turnState, turnId: "42", turnState, resultState: "partial", userMessageSeq: 4, assistantMessageSeq: 5,
    inputs: { entry: { receiptId: "source", inputSeq: 4, kind: "start", stage: "fixed", comparison: retried ? "unchanged" : "changed", detail: { operation: "get_execution_input", receiptId: "source" } }, startChanged: !retried,
      additional: { confirmedCount: 0, references: [], referencesNextOffset: null, unresolved: [], unresolvedCount: 0, unresolvedNextOffset: null, notSent: [], notSentCount: 0, notSentNextOffset: null, coverage: "recorded" } }, executionSettings: null, output: null });
  const reads: unknown[] = [];
  let dockReadFails = false;
  Object.defineProperty(dom.window, "withmate", { configurable: true, value: { readSessionExecution: async (_owner: string, _operation: string, request: { turnId?: string }) => { reads.push(request); if (dockReadFails && request.turnId) throw new Error("Fixture read unavailable"); return { ...execution(), turnId: request.turnId ?? "42" }; } } });
  const sent: Array<Omit<RetryFailedSessionTurnRequest, "executionOptions">> = [];
  let finish: (() => void) | undefined;
  let submissionError = "";
  const context = { submit: async (request: Omit<RetryFailedSessionTurnRequest, "executionOptions">) => { sent.push(request); if (submissionError) throw new Error(submissionError); await new Promise<void>((resolve) => { finish = resolve; }); return {} as SessionTurnQueueReceipt; }, blocked: () => false };
  const render = () => <FailedTurnRetryContext.Provider value={context}><FailedTurnRetry message={{ role: "assistant", text: "failure", runFailure: "failed", historyIndex: 5 }} context={{ ownerSessionId: "recipient", target }} /></FailedTurnRetryContext.Provider>;
  try {
    await act(async () => root.render(render()));
    const button = dom.window.document.querySelector<HTMLButtonElement>("button")!;
    assert.deepEqual(reads[0], { target, messageSeq: 5 });
    assert.equal(button.getAttribute("aria-label"), "Main: Resend Failed Turn");
    assert.equal(sent.length, 0);
    await act(async () => { button.click(); button.click(); });
    assert.equal(sent.length, 1);
    assert.equal(button.disabled, true);
    assert.equal(sent[0]?.receiptId, "source");
    assert.equal(sent[0]?.turnId, "42");
    assert.deepEqual(sent[0]?.target, target);
    await act(async () => finish?.());
    const message = { role: "assistant" as const, text: "failure", runFailure: "failed", historyIndex: 5 };
    const readContext = { ownerSessionId: "recipient", target };
    await act(async () => root.render(<FailedTurnRetryContext.Provider value={{ ...context, dockTurn: { sessionId: "recipient", turnId: "42" } }}>
      <FailedTurnRetry message={message} context={readContext} />
      <SessionRecoveryActions retryState={{ kind: "failed", lastRequestText: "A later input" }} requestKey="recipient:42" targetLabel="Main" isRetryActionDisabled={false} isRetryEditDisabled={false} isRetryDraftReplacePending={false}
        onResendLastMessage={() => { throw new Error("must not send latest message text"); }} onEditLastMessage={() => {}} onConfirmRetryDraftReplace={() => {}} onCancelRetryDraftReplace={() => {}}
        failedRetry={{ context: readContext, turnId: "42" }} />
    </FailedTurnRetryContext.Provider>));
    const dockButton = dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Main: Resend Previous Request"]');
    assert.ok(dockButton);
    assert.equal(dom.window.document.querySelector('button[aria-label="Main: Resend Failed Turn"]'), null);
    assert.ok(reads.some((request) => JSON.stringify(request) === JSON.stringify({ target, turnId: "42" })));
    await act(async () => dockButton.click());
    assert.equal(sent.length, 2);
    assert.equal(sent[1]?.turnId, "42");
    await act(async () => finish?.());
    await act(async () => root.render(<></>));
    dockReadFails = true;
    const dockView = (turnId: string) => <FailedTurnRetryContext.Provider value={{ ...context, dockTurn: { sessionId: "recipient", turnId } }}>
      <SessionRecoveryActions retryState={{ kind: "failed", lastRequestText: "A later input" }} requestKey="recipient" targetLabel="Main" isRetryActionDisabled={false} isRetryEditDisabled={false} isRetryDraftReplacePending={false}
        onResendLastMessage={() => { throw new Error("must not send latest message text"); }} onEditLastMessage={() => {}} onConfirmRetryDraftReplace={() => {}} onCancelRetryDraftReplace={() => {}}
        failedRetry={{ context: readContext, turnId }} />
    </FailedTurnRetryContext.Provider>;
    await act(async () => root.render(dockView("42")));
    assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /Fixture read unavailable/);
    dockReadFails = false;
    const retryRead = [...dom.window.document.querySelectorAll("button")].find((item) => item.textContent === "Retry")!;
    await act(async () => retryRead.click());
    submissionError = "Path not found: fixture.txt";
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Main: Resend Previous Request"]')!.click());
    assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /Path not found: fixture.txt/);
    await act(async () => root.render(dockView("43")));
    assert.equal(dom.window.document.querySelector('[role="alert"]'), null);
    assert.ok(dom.window.document.querySelector('button[aria-label="Main: Resend Previous Request"]'));
    retried = true;
    await act(async () => root.render(<TurnExecutionDetails message={message} context={readContext} />));
    assert.match(dom.window.document.body.textContent!, /Edited before the original Turn started/);
    assert.match(dom.window.document.body.textContent!, /By you · Originally from Sender/);
    retried = false;
    await act(async () => root.render(<></>));
    let failHistoryRead = true;
    Object.defineProperty(dom.window, "withmate", { configurable: true, value: { readSessionExecution: async () => { if (failHistoryRead) throw new Error("History read unavailable"); return execution(); } } });
    await act(async () => root.render(<FailedTurnRetryContext.Provider value={context}><TurnInputReadBoundary message={message} context={readContext}>{(read) => <>
      <FailedTurnRetryWithRead message={message} context={readContext} read={read} />
      <TurnInputDetailsContent message={message} read={read} />
    </>}</TurnInputReadBoundary></FailedTurnRetryContext.Provider>));
    assert.equal(dom.window.document.querySelector('button[aria-label="Main: Resend Failed Turn"]'), null);
    assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /History read unavailable/);
    failHistoryRead = false;
    await act(async () => [...dom.window.document.querySelectorAll("button")].find((item) => item.textContent === "Retry Input Details")!.click());
    assert.ok(dom.window.document.querySelector('button[aria-label="Main: Resend Failed Turn"]'));
    turnState = "canceled";
    await act(async () => root.render(<></>));
    await act(async () => root.render(render()));
    assert.equal(dom.window.document.querySelector("button"), null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
