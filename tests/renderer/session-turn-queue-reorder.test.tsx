import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { ReorderQueuedSessionTurnsRequest, SessionTurnQueueReceipt, SessionTurnQueueReorderResult } from "../../src-shared/session/session-turn-queue.js";
import { useSessionTurnQueue, type SessionTurnQueueApi } from "../../src/chat/conversation/use-session-turn-queue.js";
import { SessionTurnQueueRow } from "../../src/chat/conversation/session-turn-queue-row.js";
import { projectSessionTurnQueue } from "../../src/chat/conversation/session-turn-queue-projection.js";
import { buildMessageListProjection } from "../../src/chat/auxiliary/auxiliary-session-message-projection.js";

function receipt(id: string, sequence: number): SessionTurnQueueReceipt {
  return { sessionId: "session", incarnationId: "inc", id, requestId: id, sequence, queuePosition: sequence, state: "queued",
    captured: { request: { clientRequestId: id, userMessage: `Message ${id}`, executionOptions: { model: "model", reasoningEffort: "medium", approvalMode: "on-request", codexSandboxMode: "workspace-write", codexSpeed: "standard", codexReviewer: "user", customAgentName: "" } }, attachments: [], provider: "codex", workspacePath: "workspace" },
    turnId: null, userMessageSeq: null, reason: null, releasedAt: null, createdAt: "now", updatedAt: "now" };
}

async function mount() {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://withmate.test", pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let items = [receipt("A", 1), receipt("B", 2), receipt("C", 3)];
  let finish!: (result: SessionTurnQueueReorderResult) => void;
  let fail!: (error: Error) => void;
  let readError: Error | null = null;
  let reads = 0;
  const requests: ReorderQueuedSessionTurnsRequest[] = [];
  const api: SessionTurnQueueApi = {
    listSessionTurnQueue: async () => { reads += 1; if (readError) throw readError; return items; },
    getSessionTurnQueueReceipt: async (_sessionId, id) => ({ ...receipt(id, 1), state: "canceled" }),
    reorderQueuedSessionTurns: async (_sessionId, request) => {
      requests.push(request);
      return new Promise<SessionTurnQueueReorderResult>((resolve, reject) => { finish = resolve; fail = reject; });
    },
  };
  let current!: ReturnType<typeof useSessionTurnQueue>;
  function View({ sessionId }: { sessionId: string }) {
    current = useSessionTurnQueue(api, sessionId, "inc", true);
    return <div className="session-message-list" tabIndex={-1}>
      {current.queuedReceipts.map((item, index) => <SessionTurnQueueRow key={item.id} receipt={item} character={{ name: "Mate", iconPath: "" }}
        position={index + 1} queueSize={current.queuedReceipts.length} busy={current.busyId !== null} busyKind={current.busyId === item.id ? current.busyKind : null}
        onMove={current.move} onCancel={current.cancel} onRelease={current.release} />)}
      <span role="status">{current.announcement}</span>
      {current.error ? <div role="alert">{current.error}<button onClick={current.reload}>Retry Queue</button></div> : null}
    </div>;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(<View sessionId="session" />));
  return {
    document: dom.window.document, requests,
    get current() { return current; },
    get reads() { return reads; },
    setReadError(error: Error | null) { readError = error; },
    setItems(next: SessionTurnQueueReceipt[]) { items = next; },
    button(position: number, direction: string) { return dom.window.document.querySelector<HTMLButtonElement>(`button[aria-label="Move queued turn ${position} ${direction}"]`)!; },
    async click(button: HTMLButtonElement) { button.focus(); await act(async () => button.click()); },
    async resolve(outcome: SessionTurnQueueReorderResult["outcome"]) { await act(async () => finish({ outcome, receipts: items })); },
    async reject() { await act(async () => fail(new Error("reply lost"))); },
    async switchOwner() { await act(async () => root.render(<View sessionId="another" />)); },
    async close() { await act(async () => root.unmount()); dom.window.close(); for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    } },
  };
}

// @test-value v2
// kind = "contract"
// claim = "待機列の投影は受付順ではなく保存済み実行順を使い、Main/Auxiliaryの確定履歴と現在応答の位置は維持する"
// oracle = { type = "contract", ref = "Issue #912: 表示・保存・実行順の一致" }
// fault = "Rendererがreceiptをsequenceで再sortして保存した並べ替えを無効に見せる"
// observable = "投影された履歴・live本文とqueued tailのID順、開始候補のID"
// observation_boundary = "consumer"
// scope = "queue reorder projection"
// lifecycle = "permanent"
// impact = "実行順と見える順番が食い違い、利用者が誤った順序を前提に操作する"
// distinction = "storageのclaim testはrenderer側の再sortを検出しない。小さい純粋投影で両会話を確認する"
// @end-test-value
test("queue projection follows persisted execution order without moving history", () => {
  for (const kind of ["session", "auxiliary"] as const) {
    const receipts = [{ ...receipt("A", 1), queuePosition: 3 }, { ...receipt("B", 2), queuePosition: 1 }, { ...receipt("C", 3), queuePosition: 2 }];
    const history = buildMessageListProjection([{ role: "user", text: "saved", historyIndex: 0 }], [], "session", {
      primaryMessageSourceKind: kind, liveAssistant: { sessionId: "session", threadId: "thread", messageIndex: 1, text: "live" },
    });
    const projected = projectSessionTurnQueue(history, receipts, { sessionId: "session", incarnationId: "inc" }, { submissions: [], hasActiveRun: true });
    assert.deepEqual(projected.projection.messages.map((item) => item.text), ["saved", "live"]);
    assert.deepEqual(projected.tail.map((item) => item.id), ["B", "C", "A"]);
    assert.equal(projectSessionTurnQueue(history, receipts, { sessionId: "session", incarnationId: "inc" }, { submissions: [], hasActiveRun: false }).activeReceipt?.id, "B");
  }
});

// @test-value v2
// kind = "contract"
// claim = "上下操作は表示時の待機ID列を送信し、保存前に順序や成功を先行表示せず、保存後は対象のfocusを維持して境界方向だけを無効にする"
// oracle = { type = "contract", ref = "Issue #912: 上下操作・focus維持・保存確定の採用方針" }
// fault = "IDでなく位置だけを送る、未ACKで並べ替える、連打で二重送信する、または移動でfocusを失う"
// observable = "IPC payloadと呼出数、button disabled/busy、表示receipt順、activeElement、成功status"
// observation_boundary = "component-behavior"
// scope = "queue move controls and acknowledgement"
// lifecycle = "permanent"
// impact = "誤った項目の変更やkeyboard操作の中断、未保存の成功表示を防ぐ"
// distinction = "型検査とstorage testはReactのbusy/focus/ACK表示を確認しない。deferred ACKで実hookとcomponentを通る"
// @end-test-value
test("queue move keeps receipt focus and waits for the saved order", async () => {
  const view = await mount();
  try {
    assert.equal(view.button(1, "up").disabled, true);
    assert.equal(view.button(3, "down").disabled, true);
    const button = view.button(3, "up");
    await view.click(button);
    await view.click(button);
    assert.deepEqual(view.requests, [{ incarnationId: "inc", expectedQueuedIds: ["A", "B", "C"], queuedIds: ["A", "C", "B"] }]);
    assert.deepEqual(view.current.queuedReceipts.map((item) => item.id), ["A", "B", "C"]);
    assert.equal(view.current.announcement, "");
    assert.equal(button.getAttribute("aria-busy"), "true");
    view.setItems([receipt("A", 1), { ...receipt("C", 3), queuePosition: 2 }, { ...receipt("B", 2), queuePosition: 3 }]);
    await view.resolve("reordered");
    assert.deepEqual(view.current.queuedReceipts.map((item) => item.id), ["A", "C", "B"]);
    assert.equal(view.document.activeElement, button);
    assert.equal(button.getAttribute("aria-label"), "Move queued turn 2 up");
    assert.match(view.current.announcement, /position 2 of 3/);
    await view.click(button);
    view.setItems([{ ...receipt("C", 3), queuePosition: 1 }, { ...receipt("A", 1), queuePosition: 2 }, { ...receipt("B", 2), queuePosition: 3 }]);
    await view.resolve("reordered");
    assert.equal(button.disabled, true);
    assert.equal(view.document.activeElement?.getAttribute("aria-label"), "Queued turn 1 of 3");
  } finally { await view.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "競合と応答不明は成功表示や自動再送をせず正本を再取得し、会話切替後の古い操作結果は新しい会話へ反映しない"
// oracle = { type = "contract", ref = "Issue #912: 競合時再取得と保存失敗・応答不明の扱い" }
// fault = "競合を成功扱いする、返信喪失で再送して二重移動する、または旧ownerのerror/順序を新ownerへ適用する"
// observable = "IPC回数、再取得後のID順、alert、成功status不在、切替先のreceiptとerror"
// observation_boundary = "component-behavior"
// scope = "queue reorder conflict and uncertain acknowledgement"
// lifecycle = "permanent"
// impact = "保存と表示の不一致、意図しない再操作、会話間の状態混入を防ぐ"
// distinction = "storageのrollback/競合testではrendererの再送と非同期owner境界を検出できない"
// @end-test-value
test("queue move refreshes conflict and uncertain outcomes without replaying", async () => {
  for (const outcome of ["conflict", "lost-saved", "lost-unsaved", "switched"] as const) {
    const view = await mount();
    try {
      await view.click(view.button(2, "up"));
      if (outcome === "conflict") {
        view.setItems([receipt("B", 2), receipt("C", 3)]);
        await view.resolve("conflict");
        assert.deepEqual(view.current.queuedReceipts.map((item) => item.id), ["B", "C"]);
        assert.match(view.current.error, /queue changed/);
      } else {
        if (outcome === "lost-saved") view.setItems([{ ...receipt("B", 2), queuePosition: 1 }, { ...receipt("A", 1), queuePosition: 2 }, receipt("C", 3)]);
        if (outcome === "switched") await view.switchOwner();
        await view.reject();
        assert.deepEqual(view.current.queuedReceipts.map((item) => item.id), outcome === "switched" ? [] : outcome === "lost-saved" ? ["B", "A", "C"] : ["A", "B", "C"]);
        if (outcome === "switched") assert.equal(view.current.error, "");
        else assert.match(view.current.error, /could not be confirmed/);
      }
      assert.equal(view.current.announcement, "");
      assert.equal(view.requests.length, 1);
    } finally { await view.close(); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "競合後の再取得失敗は保持した列が古い可能性と取得失敗を表示し、Retry Queueで最新列へ回復するが並べ替えは再送しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 並べ替え競合時の再取得と失敗時の本文保持・回復導線" }
// fault = "競合のaction errorでread errorを隠し、古い列を更新済みとして案内する"
// observable = "alertの失敗・古い列の説明、表示ID順、readとmutationの回数、Retry後のalert消去"
// observation_boundary = "component-behavior"
// scope = "queue conflict refresh failure and retry"
// lifecycle = "permanent"
// impact = "取得失敗時に消失済み項目を最新と誤認せず、再取得から操作へ戻れる"
// distinction = "既存競合testは再取得成功のみ。API失敗と操作ACKを実hookで組み合わせる小さいtestであり型検査では代替できない"
// @end-test-value
test("queue conflict exposes refresh failure and retries the read without replaying the move", async () => {
  const view = await mount();
  try {
    await view.click(view.button(2, "up"));
    view.setItems([receipt("B", 2), receipt("C", 3)]);
    view.setReadError(new Error("queue read unavailable"));
    await view.resolve("conflict");
    assert.deepEqual(view.current.queuedReceipts.map((item) => item.id), ["A", "B", "C"]);
    const alert = view.document.querySelector('[role="alert"]')!;
    assert.match(alert.textContent ?? "", /queue changed/);
    assert.match(alert.textContent ?? "", /Queue refresh failed.*may be out of date.*queue read unavailable/);
    assert.equal(view.current.announcement, "");
    assert.equal(view.reads, 2);
    assert.equal(view.requests.length, 1);
    view.setReadError(null);
    const retry = alert.querySelector<HTMLButtonElement>("button")!;
    assert.equal(retry.textContent, "Retry Queue");
    await view.click(retry);
    assert.deepEqual(view.current.queuedReceipts.map((item) => item.id), ["B", "C"]);
    assert.equal(view.document.querySelector('[role="alert"]'), null);
    assert.equal(view.current.announcement, "");
    assert.equal(view.reads, 3);
    assert.equal(view.requests.length, 1);
  } finally { await view.close(); }
});
