import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { FailedTurnRetry } from "../../src/chat/conversation/failed-turn-retry.js";
import { FailedTurnRetryContext } from "../../src/chat/runtime/failed-turn-retry-context.js";
import {
  TurnExecutionDetails,
  TurnInputReadBoundary,
} from "../../src/chat/conversation/turn-input-details.js";
import {
  executionOperationResultSchemas,
  executionWindowResultSchemas,
} from "../../src-shared/session/session-execution-read.js";
import type {
  RetryFailedSessionTurnRequest,
  SessionTurnQueueReceipt,
} from "../../src-shared/session/session-turn-queue.js";

// @test-value v2
// kind = "contract"
// claim = "失敗レスポンスから保存済みの確定失敗を再実行し、Detailsで編集差と元送信者を示す。取得失敗から再取得でき、二重送信を防ぐ"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action Dock・回復操作; docs/design/session-run-lifecycle.md#gui-turn-queue" }
// fault = "失敗以外に操作を出す、編集差や取得失敗を伏せる、対象identityを取り違える、受付中に二重送信する"
// observable = "失敗レスポンスの操作、Detailsの編集差・元送信者の項目と説明文の不在、失敗の表示・回復、送信された対象と要求数"
// observation_boundary = "component-behavior"
// scope = "保存済み失敗messageの再実行 UI。IPCはfixture"
// lifecycle = "permanent"
// impact = "意図しない対象や入力を再実行し、二重受付する"
// distinction = "main facadeとstorageのtestは画面の対象選択と受付中の操作を検証しない"
// @end-test-value
/** 失敗メッセージの再送先と二重送信防止、元送信者・入力の編集差、履歴読込失敗からの回復を画面で確認する。 */
test("failed message resends its saved Turn once and reports edited input", async () => {
  const dom = new JSDOM("<div id='root'></div>", {
    pretendToBeVisual: true,
    url: "https://fixture.invalid",
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const target = {
    kind: "main" as const,
    sessionId: "recipient",
    incarnationId: "recipient-inc",
  };
  let turnState = "failed";
  const origin = {
    kind: "session" as const,
    operation: "send" as const,
    targetSessionId: target.sessionId,
    targetIncarnationId: target.incarnationId,
    actorKind: "main" as const,
    actorSessionId: "sender",
    actorIncarnationId: "sender-inc",
    actorTurnId: "12",
    actorSnapshot: {
      sessionTitle: "Source",
      character: { id: "sender-character", name: "Sender", iconPath: "" },
    },
  };
  let retried = false;
  const guiOrigin = {
    kind: "gui" as const,
    operation: "send" as const,
    targetSessionId: target.sessionId,
    targetIncarnationId: target.incarnationId,
  };
  /** 再送後は GUI 送信と元の Session 送信を区別できる実行詳細を組み立てる。 */
  const execution = () =>
    executionOperationResultSchemas.get_execution.parse({
      ok: true,
      origin: retried ? guiOrigin : origin,
      retrySource: retried
        ? {
            receiptId: "original",
            turnId: "40",
            origin,
            changedSinceAcceptance: true,
          }
        : null,
      receiptId: "source",
      receiptState: turnState,
      turnId: "42",
      turnState,
      resultState: "partial",
      userMessageSeq: 4,
      assistantMessageSeq: 5,
      inputs: {
        entry: {
          receiptId: "source",
          inputSeq: 4,
          kind: "start",
          stage: "fixed",
          comparison: retried ? "unchanged" : "changed",
          detail: { operation: "get_execution_input", receiptId: "source" },
        },
        startChanged: !retried,
        additional: {
          confirmedCount: 0,
          references: [],
          referencesNextOffset: null,
          unresolved: [],
          unresolvedCount: 0,
          unresolvedNextOffset: null,
          notSent: [],
          notSentCount: 0,
          notSentNextOffset: null,
          coverage: "recorded",
        },
      },
      executionSettings: null,
      output: null,
    });
  /** 保存済みの確定入力を、指定 Turn ID と現在の試験用状態で表示用に返す。 */
  const display = (id = "42") =>
    executionWindowResultSchemas.read_turn_input_display.parse({
      ok: true,
      origin,
      receiptId: "source",
      receiptState: turnState,
      turnId: id,
      turnState,
      isFixedStart: true,
      senderTheme: null,
      retryInputUnchanged: null,
    });
  const reads: unknown[] = [];
  Object.defineProperty(dom.window, "withmate", {
    configurable: true,
    value: {
      /** 取得要求を記録し、要求された実行詳細または入力表示を返す。 */
      readSessionExecution: async (
        _owner: string,
        operation: string,
        request: { turnId?: string },
      ) => {
        reads.push(request);
        if (operation === "get_execution") return execution();
        assert.equal(operation, "read_turn_input_display");
        return display(request.turnId);
      },
    },
  });
  const sent: Array<Omit<RetryFailedSessionTurnRequest, "executionOptions">> =
    [];
  let finish: (() => void) | undefined;
  let submissionError = "";
  const context = {
    /** 再送要求を記録し、指定の失敗を返すか、テストが受付を完了するまで待つ。 */
    submit: async (
      request: Omit<RetryFailedSessionTurnRequest, "executionOptions">,
    ) => {
      sent.push(request);
      if (submissionError) throw new Error(submissionError);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return {} as SessionTurnQueueReceipt;
    },
    /** 受付中の抑止だけを確認できるよう外部の操作ブロックは無効にする。 */
    blocked: () => false,
  };
  const message = {
    role: "assistant" as const,
    text: "failure",
    runFailure: "failed",
    historyIndex: 5,
  };
  const readContext = { ownerSessionId: "recipient", target };
  /** 同じ失敗メッセージの取得境界と再送ボタンを試験用受付に接続する。 */
  const render = () => (
    <FailedTurnRetryContext.Provider value={context}>
      <TurnInputReadBoundary message={message} context={readContext}>
        {(read) => (
          <FailedTurnRetry
            message={message}
            context={readContext}
            read={read}
          />
        )}
      </TurnInputReadBoundary>
    </FailedTurnRetryContext.Provider>
  );
  try {
    await act(async () => root.render(render()));
    const button =
      dom.window.document.querySelector<HTMLButtonElement>("button")!;
    assert.deepEqual(reads[0], { target, messageSeq: 5 });
    assert.equal(button.getAttribute("aria-label"), "Main: Resend Failed Turn");
    assert.equal(sent.length, 0);
    await act(async () => {
      button.click();
      button.click();
    });
    assert.equal(sent.length, 1);
    assert.equal(button.disabled, true);
    assert.equal(sent[0]?.receiptId, "source");
    assert.equal(sent[0]?.turnId, "42");
    assert.deepEqual(sent[0]?.target, target);
    await act(async () => finish?.());
    submissionError = "Path not found: fixture.txt";
    await act(async () => button.click());
    assert.match(
      dom.window.document.querySelector('[role="alert"]')!.textContent!,
      /Path not found: fixture.txt/,
    );
    retried = true;
    await act(async () =>
      root.render(
        <TurnExecutionDetails message={message} context={readContext} />,
      ),
    );
    assert.match(
      dom.window.document.body.textContent!,
      /Edited before the original Turn started/,
    );
    const originalSender = [...dom.window.document.querySelectorAll("dt")].find(
      (label) => label.textContent === "Original Sender",
    );
    assert.equal(originalSender?.nextElementSibling?.textContent, "Sender");
    assert.doesNotMatch(
      dom.window.document.body.textContent!,
      /Retry requested by you|Previous input from/,
    );
    retried = false;
    await act(async () => root.render(<></>));
    let failHistoryRead = true;
    Object.defineProperty(dom.window, "withmate", {
      configurable: true,
      value: {
        /** 詳細を返せる状態でも、表示用履歴の取得だけを選択的に失敗させる。 */
        readSessionExecution: async (_owner: string, operation: string) => {
          if (operation === "read_turn_input_display") {
            if (failHistoryRead) throw new Error("History read unavailable");
            return display();
          }
          return execution();
        },
      },
    });
    await act(async () =>
      root.render(
        <FailedTurnRetryContext.Provider value={context}>
          <TurnInputReadBoundary message={message} context={readContext}>
            {(read) => (
              <>
                <FailedTurnRetry
                  message={message}
                  context={readContext}
                  read={read}
                />
                <TurnExecutionDetails
                  message={message}
                  context={readContext}
                  displayReadError={read.readError}
                  onRetryDisplay={() => read.setRevision((value) => value + 1)}
                />
              </>
            )}
          </TurnInputReadBoundary>
        </FailedTurnRetryContext.Provider>,
      ),
    );
    assert.equal(
      dom.window.document.querySelector(
        'button[aria-label="Main: Resend Failed Turn"]',
      ),
      null,
    );
    assert.match(
      dom.window.document.body.textContent!,
      /Edited before this Turn started/,
    );
    assert.match(
      dom.window.document.querySelector('[role="alert"]')!.textContent!,
      /History read unavailable/,
    );
    failHistoryRead = false;
    await act(async () =>
      [...dom.window.document.querySelectorAll("button")]
        .find((item) => item.textContent === "Retry Input Details")!
        .click(),
    );
    assert.ok(
      dom.window.document.querySelector(
        'button[aria-label="Main: Resend Failed Turn"]',
      ),
    );
    turnState = "canceled";
    await act(async () => root.render(<></>));
    await act(async () => root.render(render()));
    assert.equal(dom.window.document.querySelector("button"), null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
