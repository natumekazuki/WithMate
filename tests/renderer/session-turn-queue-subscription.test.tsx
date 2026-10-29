import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { useSessionTurnQueue, type SessionTurnQueueApi } from "../../src/chat/conversation/use-session-turn-queue.js";
import { SessionTurnQueueRow, SessionTurnQueueStatus } from "../../src/chat/conversation/session-turn-queue-row.js";
import { projectSessionTurnQueue } from "../../src/chat/conversation/session-turn-queue-projection.js";
import type { SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";

function receipt(overrides: Partial<SessionTurnQueueReceipt> = {}): SessionTurnQueueReceipt {
  return { sessionId: "session", incarnationId: "incarnation", id: "item", requestId: "request", sequence: 1, queuePosition: overrides.sequence ?? 1, state: "running",
    captured: { request: { clientRequestId: "request", userMessage: "original prompt", executionOptions: { model: "model", reasoningEffort: "medium", approvalMode: "on-request", codexSandboxMode: "workspace-write", codexSpeed: "standard", codexReviewer: "user", customAgentName: "" } }, attachments: [], provider: "codex", workspacePath: "workspace" },
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
    const { projection, metadata, tail } = projectSessionTurnQueue({
      messages: seqs.map(() => ({ role: "user" as const, text: "saved prompt" })),
      keys: seqs.map((seq) => `saved-${seq}`), sources: seqs.map((seq) => ({ kind: "session" as const, messageIndex: seq })), groups: seqs.map(() => null),
    }, current.receipts, { sessionId: "session", incarnationId: "incarnation" });
    const row = (item: SessionTurnQueueReceipt) => <SessionTurnQueueRow key={item.id} character={{ name: "Mate", iconPath: "" }} receipt={item} busy={current.busyId !== null} busyKind={current.busyId === item.id ? current.busyKind : null} onCancel={current.cancel} onRelease={current.release} onSendInput={(selected) => current.sendInput(selected, "current-turn")} />;
    return <>
      {projection.messages.map((message, index) => <div key={projection.keys[index]}><p>{message.text}</p>{metadata.has(projection.keys[index]) ? <SessionTurnQueueStatus receipt={metadata.get(projection.keys[index])!} busy={current.busyId !== null} busyKind={current.busyId === metadata.get(projection.keys[index])!.id ? current.busyKind : null} onCancel={current.cancel} onRelease={current.release} onSendInput={(selected) => current.sendInput(selected, "current-turn")} /> : null}</div>)}
      {tail.map(row)}
      {current.error ? <div role="alert">{current.error}<button onClick={current.reload}>Retry Queue</button></div> : null}
    </>;
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => { root.render(<View seqs={[]} />); });
  return {
    get current() { return current; }, document: dom.window.document,
    async canonical(seqs: number[]) { await act(async () => { root.render(<View seqs={seqs} />); }); },
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
// claim = "通常購読はactiveのみ取得し、消えた実行のterminal receiptだけ照会してcanonical seq到着まで橋渡しする。初回失敗後の再試行は読込待ちを示し、取得済みの背景更新と失敗は表示を保持する。canonical到着は追加取得なしでbridgeを解消する"
// oracle = { type = "contract", ref = "Issue #801: active subscription and canonical bridge" }
// fault = "通知ごとに全receipt履歴を取得する、terminal先着で本文を落とす、または取得失敗を空queueへ置換する"
// observable = "購読APIの呼出し、hookのreceipt・error・初回loading、canonical seq到着後のbridge除去"
// observation_boundary = "consumer"
// scope = "queue-active-subscription"
// lifecycle = "permanent"
// impact = "履歴量に比例した再取得と通知逆順による本文消失を防ぐ"
// distinction = "純粋projection testは実購読通知・API失敗・terminal照会の境界を通らない"
// @end-test-value
test("active subscription bridges only disappeared runs and retains failures", async () => {
  let active = [receipt()]; let fail = true; let historyCalls = 0;
  let activeCalls = 0;
  let resumeRefresh: (() => void) | undefined;
  let holdRefresh = false;
  let listener!: (id: string) => void;
  const lookups: string[] = [];
  const view = await mount({
    listSessionTurnQueue: async () => {
      ++activeCalls;
      if (holdRefresh) await new Promise<void>((resolve) => { resumeRefresh = resolve; });
      if (fail) throw new Error("active unavailable"); return active;
    },
    getSessionTurnQueueReceipt: async (_session, id) => { lookups.push(id); return receipt({ state: "completed" }); },
    listSessionTurnQueueReceipts: async () => { ++historyCalls; return { receipts: [], nextCursor: null }; },
    onSessionTurnQueueChanged: (next) => { listener = next; return () => {}; },
  });
  try {
    assert.equal(view.current.receipts.length, 0);
    assert.match(view.current.error, /active unavailable/);
    fail = false; holdRefresh = true;
    await act(async () => view.current.reload());
    assert.equal(view.current.loading, true, "an initial failure has not established a ready queue");
    await act(async () => resumeRefresh?.());
    holdRefresh = false;
    assert.equal(view.current.loading, false);
    assert.equal(view.current.receipts[0]?.state, "running");
    holdRefresh = true;
    await act(async () => listener("session"));
    assert.equal(view.current.loading, false, "refresh preserves the ready conversation instead of restoring initial loading");
    assert.equal(view.current.receipts[0]?.state, "running");
    holdRefresh = false; fail = true;
    await act(async () => resumeRefresh?.());
    assert.equal(view.current.receipts[0]?.state, "running");
    assert.match(view.current.error, /active unavailable/);
    fail = false; active = []; await act(async () => view.current.reload());
    assert.deepEqual(lookups, ["request"]);
    assert.equal(view.current.receipts[0]?.state, "completed");
    const callsBeforeCanonical = activeCalls;
    await view.canonical([40]);
    assert.equal(view.current.receipts.length, 1);
    await view.canonical([40, 42]);
    assert.equal(view.current.receipts.length, 0);
    assert.equal(activeCalls, callsBeforeCanonical, "canonical arrival only retires the resolved bridge");
    assert.equal(historyCalls, 0);
    await act(async () => listener("session"));
    assert.equal(lookups.length, 1);
    assert.equal(historyCalls, 0);
  } finally { await view.unmount(); }
});

// @test-value v2
// kind = "contract"
// claim = "予約から開始を観測せずterminalへ進んでも、receipt照会失敗時は受付本文とRetryを保持し、照会回復後はcanonical到着まで本文を橋渡しする"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md: GUI Turn Queueのterminal先着bridgeと取得失敗時の表示保持" }
// fault = "消えたqueuedを照会しない、照会失敗で空にする、またはcanonical保存本文より先にterminal本文を捨てる"
// observable = "同request IDのreceipt照会、本文とRetry、completed/failed/canceled receiptからcanonical本文への重複なしの切替"
// observation_boundary = "consumer"
// scope = "queued-terminal-subscription-bridge"
// lifecycle = "permanent"
// impact = "ACK後にdraftが消えた受付済み本文を読取障害や短時間の実行で見失うことを防ぐ"
// distinction = "runningからの既存購読testとSteer応答testは通常queuedの開始通知を観測しない経路を通らない。実hookとprojectionの小さい検証で通知順序の契約を守る"
// @end-test-value
test("queued receipts bridge skipped starts and failed receipt reads until canonical arrival", async () => {
  for (const terminalState of ["completed", "failed", "canceled"] as const) {
    let active = [receipt({ state: "queued", turnId: null, userMessageSeq: null })];
    let lookupFails = true;
    let listener!: (id: string) => void;
    const lookups: Array<[string, string]> = [];
    const view = await mount({
      listSessionTurnQueue: async () => active,
      getSessionTurnQueueReceipt: async (sessionId, requestId) => {
        lookups.push([sessionId, requestId]);
        if (lookupFails) throw new Error("receipt unavailable");
        return receipt({ state: terminalState });
      },
      onSessionTurnQueueChanged: (next) => { listener = next; return () => {}; },
    });
    try {
      assert.match(view.document.body.textContent!, /original prompt/);
      active = [];
      await act(async () => listener("session"));
      assert.deepEqual(lookups, [["session", "request"]]);
      assert.match(view.document.body.textContent!, /original prompt/);
      assert.match(view.document.querySelector("[role=alert]")!.textContent!, /receipt unavailable/);
      lookupFails = false;
      await view.click("Retry Queue");
      assert.equal(view.current.receipts[0]?.state, terminalState);
      assert.equal(view.current.error, "");
      assert.equal([...view.document.querySelectorAll("p")].filter((item) => item.textContent === "original prompt").length, 1);
      assert.match(view.document.body.textContent!, /original prompt/);
      await view.canonical([42]);
      assert.equal(view.current.receipts.length, 0);
      assert.equal(view.document.querySelectorAll("p").length, 1);
      assert.equal(view.document.querySelector("p")!.textContent, "saved prompt");
      assert.deepEqual(lookups, [["session", "request"], ["session", "request"]]);
    } finally { await view.unmount(); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "チャットの予約から現在turnへの入力を一度だけ要求し、実行中のSteerだけをspinner表示にし、成功receiptの本文をcanonical seq到着まで保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 予約項目のSteer" }
// fault = "現在turn IDを送らない、連打で重複操作する、または開始通知なしの完了で受付本文が消える"
// observable = "button操作のAPI引数と回数、待機中のdisabled・busy・spinnerの所属、完了後のbridgeとcanonical到着後の除去"
// observation_boundary = "component-behavior"
// scope = "queued-current-turn-input"
// lifecycle = "permanent"
// impact = "予約本文の二重入力とACK先着による本文消失を防ぐ"
// distinction = "service/storage testsはチャット操作とrenderer bridgeを通らない"
// @end-test-value
test("queued chat input captures the turn once and bridges a fast canonical acceptance", async () => {
  const queued = receipt({ state: "queued", turnId: null, userMessageSeq: null });
  let active = [queued];
  let resolve!: (value: SessionTurnQueueReceipt) => void;
  const calls: Array<[string, string, string]> = [];
  const view = await mount({
    listSessionTurnQueue: async () => active,
    sendQueuedSessionInput: async (sessionId, id, turnId) => {
      calls.push([sessionId, id, turnId]);
      return new Promise((accept) => { resolve = accept; });
    },
  });
  try {
    await view.click("Steer");
    await view.click("Steer");
    assert.deepEqual(calls, [["session", "item", "current-turn"]]);
    assert.equal([...view.document.querySelectorAll("button")].find((button) => button.textContent === "Steer")!.disabled, true);
    const steer = [...view.document.querySelectorAll("button")].find((button) => button.textContent === "Steer")!;
    const cancel = view.document.querySelector<HTMLButtonElement>('button[aria-label="Cancel queued turn"]')!;
    assert.equal(steer.getAttribute("aria-busy"), "true");
    assert.ok(steer.querySelector(".button-content-spinner"));
    assert.equal(cancel.disabled, true);
    assert.equal(cancel.querySelector(".button-content-spinner"), null);
    active = [];
    await act(async () => resolve(receipt({ state: "completed", inputTurnId: "current-turn" })));
    assert.equal(view.current.receipts[0]?.captured.request.userMessage, "original prompt");
    assert.equal(view.current.receipts[0]?.state, "completed");
    await view.canonical([42]);
    assert.equal(view.current.receipts.length, 0);
    assert.equal(calls.length, 1);
  } finally { await view.unmount(); }
});

// @test-value v2
// kind = "contract"
// claim = "結果不明の予約本文は同じbubbleに保持し、後続turnの解放を一度だけ要求し、取得失敗時は本文と明示Retryを維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 予約行の結果不明とRelease Later Turns" }
// fault = "結果不明の本文を落とす、解放を連打で重複する、または取得失敗を空成功へ置換する"
// observable = "bubbleの本文と状態、解放API引数と回数、待機中disabled、失敗後本文とRetry後error解消"
// observation_boundary = "component-behavior"
// scope = "queue-bubble-recovery"
// lifecycle = "permanent"
// impact = "元要求を再実行せず後続を解放でき、取得障害中に受付本文を見失わない"
// distinction = "純粋projectionやstorage testではbubbleの回復buttonと購読hookへの接続を検証できない"
// @end-test-value
test("interrupted bubble releases later turns once and retains its body through retry", async () => {
  let interrupted = receipt({ state: "interrupted", turnId: null, userMessageSeq: null });
  let fail = false;
  let completeRelease!: () => void;
  const released: Array<[string, string]> = [];
  let listener!: (id: string) => void;
  const view = await mount({
    listSessionTurnQueue: async () => { if (fail) throw new Error("queue unavailable"); return [interrupted]; },
    onSessionTurnQueueChanged: (next) => { listener = next; return () => {}; },
    releaseInterruptedSessionTurn: async (sessionId, id) => {
      released.push([sessionId, id]);
      await new Promise<void>((resolve) => { completeRelease = resolve; });
      interrupted = { ...interrupted, releasedAt: "released" };
      return interrupted;
    },
  });
  try {
    const bubble = view.document.querySelector(".message-card.user")!;
    assert.match(bubble.textContent!, /original prompt/);
    assert.match(bubble.textContent!, /Execution outcome is unknown/);
    await view.click("Release Later Turns");
    await view.click("Release Later Turns");
    assert.deepEqual(released, [["session", "item"]]);
    assert.equal(bubble.querySelector("button")!.disabled, true);
    await act(async () => completeRelease());
    assert.equal(view.current.receipts[0]?.releasedAt, "released");
    fail = true;
    await act(async () => listener("session"));
    assert.match(bubble.textContent!, /original prompt/);
    assert.match(view.document.querySelector("[role=alert]")!.textContent!, /queue unavailable/);
    fail = false;
    await view.click("Retry Queue");
    assert.equal(view.current.error, "");
    assert.equal(view.current.receipts[0]?.captured.request.userMessage, "original prompt");
    assert.equal(released.length, 1);
  } finally { await view.unmount(); }
});

// @test-value v2
// kind = "contract"
// claim = "予約bubbleの取消は対象要求を一度だけ指定し、取消確定まで本文を保持し、保存user seqのない取消は本文bridgeを残さない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 予約行の個別Cancel" }
// fault = "取消を別要求へ送る、連打で重複する、または未確定取消で本文を消す"
// observable = "bubble本文、取消API引数と回数、待機中disabled、確定後queueと本文bridge"
// observation_boundary = "component-behavior"
// scope = "queued-bubble-cancellation"
// lifecycle = "permanent"
// impact = "取消対象の誤りと未確定時の受付本文消失を防ぐ"
// distinction = "storage取消testはbubble操作からhookへの接続と待機中表示を確認しない"
// @end-test-value
test("queued bubble preserves input until its single cancellation settles", async () => {
  let active = [receipt({ state: "queued", turnId: null, userMessageSeq: null })];
  let completeCancel!: () => void;
  const canceled: Array<[string, string]> = [];
  const view = await mount({
    listSessionTurnQueue: async () => active,
    getSessionTurnQueueReceipt: async () => receipt({ state: "canceled", turnId: null, userMessageSeq: null }),
    cancelQueuedSessionTurn: async (sessionId, id) => {
      canceled.push([sessionId, id]);
      await new Promise<void>((resolve) => { completeCancel = resolve; });
      active = [];
      return receipt({ state: "canceled", turnId: null, userMessageSeq: null });
    },
  });
  try {
    await view.click("Cancel");
    await view.click("Cancel");
    assert.deepEqual(canceled, [["session", "item"]]);
    assert.match(view.document.querySelector(".message-card.user")!.textContent!, /original prompt/);
    assert.equal(view.document.querySelector<HTMLButtonElement>('button[aria-label="Cancel queued turn"]')!.disabled, true);
    assert.ok(view.document.querySelector('button[aria-label="Cancel queued turn"] .button-content-spinner'));
    assert.equal(view.current.busyKind, "cancel");
    await act(async () => completeCancel());
    assert.equal(view.current.receipts.length, 0);
    assert.equal(view.document.querySelectorAll("p").length, 0);
    assert.equal(canceled.length, 1);
  } finally { await view.unmount(); }
});
