import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { useSessionTurnQueue, type SessionTurnQueueApi } from "../../src/chat/conversation/use-session-turn-queue.js";
import { SessionTurnQueueHistory } from "../../src/chat/conversation/session-turn-queue-history.js";
import type { SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";

function receipt(overrides: Partial<SessionTurnQueueReceipt> = {}): SessionTurnQueueReceipt {
  return { sessionId: "session", incarnationId: "incarnation", id: "item", requestId: "request", sequence: 1, state: "running",
    captured: { request: { clientRequestId: "request", userMessage: "original prompt", executionOptions: { catalogRevision: 1, model: "model", reasoningEffort: "medium", approvalMode: "on-request", codexSandboxMode: "workspace-write", codexSpeed: "standard", codexReviewer: "user", customAgentName: "" } }, attachments: [], provider: "codex", workspacePath: "workspace" },
    turnId: "turn", userMessageSeq: 42, reason: null, releasedAt: null, createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z", ...overrides };
}

async function mount(api: SessionTurnQueueApi) {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://withmate.test", pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let current!: ReturnType<typeof useSessionTurnQueue>;
  function View({ seqs }: { seqs: number[] }) {
    current = useSessionTurnQueue(api, "session", "incarnation", true, seqs);
    return <SessionTurnQueueHistory api={api} sessionId="session" incarnationId="incarnation" busyId={current.busyId} onCancel={current.cancel} onRelease={current.release} />;
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => { root.render(<View seqs={[]} />); });
  return {
    get current() { return current; }, document: dom.window.document,
    async canonical(seqs: number[]) { await act(async () => { root.render(<View seqs={seqs} />); }); },
    async openHistory() { await act(async () => { const details = dom.window.document.querySelector("details")!; details.open = true; details.dispatchEvent(new dom.window.Event("toggle")); }); },
    async click(text: string) { await act(async () => {
      const button = [...dom.window.document.querySelectorAll("button")].find((item) => item.textContent === text);
      assert.ok(button, text); button.click();
    }); },
    async unmount() { await act(async () => root.unmount()); dom.window.close(); for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    } },
  };
}

// @test-value v2
// kind = "contract"
// claim = "通常購読はactiveのみ取得し、消えた実行のterminal receiptだけ照会してcanonical seq到着まで橋渡しする。取得失敗は表示を保持する"
// oracle = { type = "contract", ref = "Issue #801: active subscription and canonical bridge" }
// fault = "通知ごとに全receipt履歴を取得する、terminal先着で本文を落とす、または取得失敗を空queueへ置換する"
// observable = "購読APIの呼出し、hookのreceiptとerror、canonical seq到着後のbridge除去"
// observation_boundary = "consumer"
// scope = "queue-active-subscription"
// lifecycle = "permanent"
// impact = "履歴量に比例した再取得と通知逆順による本文消失を防ぐ"
// distinction = "純粋projection testは実購読通知・API失敗・terminal照会の境界を通らない"
// @end-test-value
test("active subscription bridges only disappeared runs and retains failures", async () => {
  let active = [receipt()]; let fail = false; let historyCalls = 0;
  let listener!: (id: string) => void;
  const lookups: string[] = [];
  const view = await mount({
    listSessionTurnQueue: async () => { if (fail) throw new Error("active unavailable"); return active; },
    getSessionTurnQueueReceipt: async (_session, id) => { lookups.push(id); return receipt({ state: "completed" }); },
    listSessionTurnQueueReceipts: async () => { ++historyCalls; return { receipts: [], nextCursor: null }; },
    onSessionTurnQueueChanged: (next) => { listener = next; return () => {}; },
  });
  try {
    assert.equal(view.current.receipts[0]?.state, "running");
    fail = true; await act(async () => listener("session"));
    assert.equal(view.current.receipts[0]?.state, "running");
    assert.match(view.current.error, /active unavailable/);
    fail = false; active = []; await act(async () => view.current.reload());
    assert.deepEqual(lookups, ["request"]);
    assert.equal(view.current.receipts[0]?.state, "completed");
    await view.canonical([40]);
    assert.equal(view.current.receipts.length, 1);
    await view.canonical([40, 42]);
    assert.equal(view.current.receipts.length, 0);
    assert.equal(historyCalls, 0);
    await act(async () => listener("session"));
    assert.equal(lookups.length, 1);
    assert.equal(historyCalls, 0);
  } finally { await view.unmount(); }
});

// @test-value v2
// kind = "contract"
// claim = "再open後の通常terminal receiptは明示的に一pageずつ選択でき、次page失敗時は既存pageとRetryを保持する"
// oracle = { type = "contract", ref = "Issue #801: explicit paged receipt history" }
// fault = "履歴を自動全page取得する、completedを選択表示できない、またはpage失敗を空成功へ置換する"
// observable = "明示操作前後のcursor呼出し列、Completed本文、失敗後の既存optionとRetry、次pageへの置換"
// observation_boundary = "component-behavior"
// scope = "queue-receipt-history"
// lifecycle = "permanent"
// impact = "再open後の受付照会を可能にし、過去全件の常駐と取得失敗の隠蔽を防ぐ"
// distinction = "active subscriptionのtestは利用者による履歴選択・ページ遷移を検証しない"
// @end-test-value
test("receipt history fetches one page per explicit action and exposes retry", async () => {
  const cursors: Array<number | undefined> = []; let failNext = true;
  const view = await mount({
    listSessionTurnQueue: async () => [],
    listSessionTurnQueueReceipts: async (_session, options) => {
      cursors.push(options?.cursor);
      if (options?.cursor === 1) {
        if (failNext) throw new Error("history unavailable");
        return { receipts: [receipt({ id: "second", sequence: 2, state: "canceled", captured: { ...receipt().captured, request: { ...receipt().captured.request, clientRequestId: "second", userMessage: "second prompt" } } })], nextCursor: null };
      }
      return { receipts: [receipt({ state: "completed" })], nextCursor: 1 };
    },
  });
  try {
    assert.equal(cursors.length, 0);
    await view.openHistory();
    assert.deepEqual(cursors, [undefined]);
    assert.match(view.document.body.textContent!, /Completed/);
    assert.match(view.document.body.textContent!, /original prompt/);
    await view.click("Next Receipts");
    assert.deepEqual(cursors, [undefined, 1]);
    assert.match(view.document.querySelector("[role=alert]")!.textContent!, /history unavailable/);
    assert.match(view.document.querySelector("option")!.textContent!, /Completed/);
    failNext = false; await view.click("Retry Receipts");
    assert.deepEqual(cursors, [undefined, 1, 1]);
    assert.equal(view.document.querySelectorAll("option").length, 1);
    assert.match(view.document.querySelector("option")!.textContent!, /Canceled/);
    assert.doesNotMatch(view.document.body.textContent!, /original prompt/);
    await view.click("Previous Receipts");
    assert.deepEqual(cursors, [undefined, 1, 1, undefined]);
  } finally { await view.unmount(); }
});
