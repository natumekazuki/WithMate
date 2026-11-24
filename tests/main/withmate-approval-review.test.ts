import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { LiveApprovalRequest, LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import { SessionApprovalService } from "../../src-electron/session/session-approval-service.js";
import { ApprovalReviewInputFence, WithMateApprovalReviewTurn } from "../../src-electron/session/withmate-approval-review.js";

const source = { kind: "main", sessionId: "source", incarnationId: "source-generation" } as const;
const allow = { decision: "allow_once", reason: "The saved request authorizes this operation." };
const deny = { decision: "deny", reason: "The saved request prohibits this operation." };

function fixture(review: (prompt: string, signal: AbortSignal) => unknown, timeoutMs?: number, provider: {
  open?(signal: AbortSignal): Promise<void>;
  close?(): Promise<void>;
} = {}) {
  const inputs = new ApprovalReviewInputFence();
  const stats = { opened: 0, closed: 0 };
  let state: LiveSessionRunState = { sessionId: source.sessionId, threadId: "", assistantText: "", steps: [], backgroundTasks: [],
    usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null };
  const approvals = new SessionApprovalService({ updateLiveSessionRun(_id, update) { return state = update(state); } });
  function run(turnId: string) {
    const owner = new AbortController();
    let policyCurrent = true;
    let operationCurrent = true;
    const turn = new WithMateApprovalReviewTurn({
      turnId, source, signal: owner.signal, workspacePath: "workspace", inputs, policyCurrent: () => policyCurrent, timeoutMs,
      open: async (signal) => {
        stats.opened++;
        await provider.open?.(signal);
        let stopped: { confirmed: Promise<void> | void } | undefined;
        const close = () => {
          if (!stopped) {
            stats.closed++;
            stopped = { confirmed: provider.close?.() };
          }
          return stopped.confirmed;
        };
        if (signal.aborted) close();
        else signal.addEventListener("abort", close, { once: true });
        return { review: async (prompt) => review(prompt, signal), close };
      },
    });
    return {
      wait(id: string, signal = owner.signal) {
        const request: LiveApprovalRequest = { requestId: id, kind: "shell", provider: "copilot", title: "Run", summary: "Test operation", decisionMode: "direct-decision" };
        const native = { operation: { command: `echo ${id}`, target: "workspace" }, isCurrent: () => operationCurrent };
        return approvals.waitForLiveApprovalDecision(source.sessionId, request, signal, turn.pending(request, native));
      },
      cancel: () => owner.abort(), close: () => turn.close(),
      changePolicy: () => { policyCurrent = false; }, supersedeNativeRequest: () => { operationCurrent = false; },
    };
  }
  return { run, stats, inputs, head: () => state.approvalRequest?.requestId,
    manual: (id: string, decision: "approve" | "deny") => approvals.resolveLiveApproval(source.sessionId, id, decision) };
}

// @test-value v2
// kind = "contract"
// claim = "実要求を受けてから初めて審査会話を開き、同じTurn内の次の操作は同じ会話で別判定し、次Turnとは共有しない"
// oracle = { type = "contract", ref = "docs/design/withmate-auto-review.md#審査会話と履歴の境界" }
// fault = "審査会話を要求前か要求ごとに開く、判定を次の要求へ再利用する、またはTurn終端で会話を閉じない"
// observable = "保留要求の決定、Providerへ渡した操作と起点、会話の開閉回数"
// observation_boundary = "consumer"
// scope = "WithMate審査Turnと実承認キューの接続"
// lifecycle = "permanent"
// impact = "前の認可が別操作や別Turnへ適用される"
// distinction = "キューやProvider単体testではTurnに束縛した再利用・解放と最終決定を一緒に確認できない"
// risk_tags = ["authorization", "privacy"]
// @end-test-value
test("approval review reuses only conversation context inside a source turn", async () => {
  const prompts: string[] = [];
  const run = fixture((prompt) => { prompts.push(prompt); return prompts.length === 2 ? deny : allow; });
  const first = run.run("42");
  assert.equal(run.stats.opened, 0);
  assert.equal(await first.wait("a"), "approve");
  assert.equal(await first.wait("b"), "deny");
  assert.equal(run.stats.opened, 1);
  first.close();
  const second = run.run("43");
  assert.equal(await second.wait("c"), "approve");
  second.cancel();
  assert.deepEqual(run.stats, { opened: 2, closed: 2 });
  assert.deepEqual(prompts.map((prompt) => {
    const input = JSON.parse(prompt);
    return [input.source, input.turnId, input.pendingOperation.requestId, input.pendingOperation.operation.command];
  }), [[source, "42", "a", "echo a"], [source, "42", "b", "echo b"], [source, "43", "c", "echo c"]]);
});

// @test-value v2
// kind = "contract"
// claim = "本人確認・不正結果・Provider失敗・timeoutでは先頭の手動承認を保持し、自動許可にしない"
// oracle = { type = "contract", ref = "docs/design/withmate-auto-review.md#一件の判定と手動承認" }
// fault = "自然文や不完全な構造化結果を許可へ変換するか、失敗時に保留要求を先に解決する"
// observable = "結果到着後の手動キュー先頭、手動否認の返値、timeoutでの会話終了"
// observation_boundary = "consumer"
// scope = "WithMate審査結果の検証と手動承認への復帰"
// lifecycle = "permanent"
// distinction = "schemaだけでは結果不成立が元pendingの状態を変えないことを検出できない"
// risk_tags = ["authorization"]
// @end-test-value
test("unusable review outcomes leave the original request manual", async () => {
  const cases = [
    () => "allow_once",
    () => ({ ...allow, extra: "not in contract" }),
    () => ({ ...allow, reason: " " }),
    () => ({ decision: "ask_user", reason: "Uncertain" }),
    () => { throw new Error("Provider failed"); },
  ];
  for (const review of cases) {
    const run = fixture(review);
    const turn = run.run("42");
    const decision = turn.wait("pending");
    await setImmediate();
    assert.equal(run.head(), "pending");
    run.manual("pending", "deny");
    assert.equal(await decision, "deny");
    turn.close();
  }
  const closed = Promise.withResolvers<void>();
  const run = fixture(() => closed.promise, 0);
  const turn = run.run("42");
  const decision = turn.wait("timeout");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(run.head(), "timeout");
  assert.equal(run.stats.closed, 1);
  run.manual("timeout", "deny");
  assert.equal(await decision, "deny");
  closed.resolve();
});

// @test-value v2
// kind = "contract"
// claim = "手動解決・元Turn取消・追加入力・設定変更・並行要求・native要求失効より後に届いた許可は適用されない"
// oracle = { type = "contract", ref = "docs/design/withmate-auto-review.md#一件の判定と手動承認" }
// fault = "進行中に対象や根拠が変化した判定を適用する、または別のpendingに付け替える"
// observable = "競合後の先頭request、元・後続の決定、元Turn取消での会話終了"
// observation_boundary = "consumer"
// scope = "WithMate審査と承認キューの競合"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// distinction = "承認キューの手動FIFO検査では審査結果が非同期で解決する順序を観測できない"
// @end-test-value
test("a stale allow cannot overwrite a manual decision or settle an invalidated pending", async () => {
  for (const race of ["manual", "cancel", "input", "settings", "native", "parallel"] as const) {
    const result = Promise.withResolvers<unknown>();
    const started = Promise.withResolvers<void>();
    const run = fixture(() => { started.resolve(); return result.promise; });
    const turn = run.run("42");
    const first = turn.wait("a");
    await started.promise;
    const competing = new AbortController();
    if (race === "manual") run.manual("a", "deny");
    if (race === "cancel") turn.cancel();
    if (race === "input") await run.inputs.during(() => undefined);
    if (race === "settings") turn.changePolicy();
    if (race === "native") turn.supersedeNativeRequest();
    if (race === "parallel") {
      const other = turn.wait("b", competing.signal);
      competing.abort();
      assert.equal(await other, "deny");
    }
    result.resolve(allow);
    await setImmediate();
    if (race !== "manual" && race !== "cancel") {
      assert.equal(run.head(), "a");
      run.manual("a", "deny");
    }
    assert.equal(await first, "deny");
    assert.equal(run.head(), undefined);
    if (race === "cancel") assert.equal(run.stats.closed, 1);
    turn.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "手動approve・denyまたは要求取消で実行中の審査を停止し、停止確認後は同じTurnの次の先頭要求を審査できる"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/980 (受入条件・検証)" }
// fault = "要求の失効を審査Providerに伝えない、停止確認前に審査を重ねる、または古い審査が新しい要求やその会話を閉じる"
// observable = "Provider境界のabort、停止確認前後の審査呼出、遅延結果後のキュー先頭と後続要求の決定・会話の再利用"
// observation_boundary = "consumer"
// scope = "WithMate仲介審査と承認サービスの要求寿命"
// lifecycle = "permanent"
// impact = "後続の対象要求が手動待ちに固定されるか、審査が重複する"
// distinction = "古い許可の不採用だけでは停止伝播と後続の審査開始を検出できない"
// @end-test-value
test("settling a request stops its review and releases only its conversation", { timeout: 2000 }, async () => {
  for (const action of ["approve", "deny", "cancel"] as const) {
    const oldResult = Promise.withResolvers<unknown>();
    const newResult = Promise.withResolvers<unknown>();
    const oldStopped = Promise.withResolvers<void>();
    const calls: Array<{ id: string; signal: AbortSignal }> = [];
    let closes = 0;
    const run = fixture((prompt, signal) => {
      const id = JSON.parse(prompt).pendingOperation.requestId as string;
      calls.push({ id, signal });
      return id === "a" ? oldResult.promise : id === "b" ? newResult.promise : allow;
    }, undefined, { close: () => ++closes === 1 ? oldStopped.promise : Promise.resolve() });
    const turn = run.run("42");
    try {
      const request = new AbortController();
      const first = turn.wait("a", request.signal);
      await setImmediate();
      assert.deepEqual(calls.map(({ id }) => id), ["a"]);

      if (action === "cancel") request.abort();
      else run.manual("a", action);
      const next = turn.wait("b");
      assert.equal(await first, action === "approve" ? "approve" : "deny");
      await setImmediate();
      const beforeStop = { calls: calls.map(({ id }) => id), aborted: calls[0].signal.aborted };
      oldStopped.resolve();
      await setImmediate();
      assert.deepEqual({ beforeStop, afterStop: calls.map(({ id }) => id) },
        { beforeStop: { calls: ["a"], aborted: true }, afterStop: ["a", "b"] }, action);
      assert.notEqual(calls[0].signal, calls[1].signal);
      if (action === "deny") oldResult.reject(new Error("Late failure from the canceled reviewer"));
      else oldResult.resolve(allow);
      await setImmediate();
      assert.equal(run.head(), "b");
      assert.equal(calls[1].signal.aborted, false);
      newResult.resolve(deny);
      assert.equal(await next, "deny");
      assert.equal(await turn.wait("c"), "approve");
      assert.deepEqual(calls.map(({ id }) => id), ["a", "b", "c"]);
      assert.equal(calls[2].signal, calls[1].signal);
      assert.deepEqual(run.stats, { opened: 2, closed: 1 });
    } finally {
      turn.cancel();
      oldStopped.resolve();
      oldResult.resolve(allow);
      newResult.resolve(deny);
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "要求取消は審査Providerの起動にも届き、遅れて開いた審査会話は閉じるまで後続要求と重ならない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/980 (対応方針・必要な判断)" }
// fault = "起動中の要求を取り消しても古いProviderを停止しない、または起動中のProviderが後続要求を処理する"
// observable = "起動signal、起動・終了回数、Providerに渡った要求と後続の決定"
// observation_boundary = "consumer"
// scope = "WithMate仲介審査の遅延起動と要求取消"
// lifecycle = "permanent"
// distinction = "審査入力到達後の取消だけでは、起動途中で失効する経路を検出できない"
// @end-test-value
test("cancellation during reviewer startup cannot leak the stale conversation into the next request", { timeout: 2000 }, async () => {
  const oldOpened = Promise.withResolvers<void>();
  const oldStopped = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  const calls: string[] = [];
  const run = fixture((prompt) => { calls.push(JSON.parse(prompt).pendingOperation.requestId); return allow; }, undefined, {
    open: async (signal) => {
      signals.push(signal);
      if (signals.length === 1) await oldOpened.promise;
    },
    close: () => oldStopped.promise,
  });
  const turn = run.run("42");
  try {
    const request = new AbortController();
    const first = turn.wait("a", request.signal);
    await setImmediate();
    request.abort();
    const next = turn.wait("b");
    assert.equal(await first, "deny");
    await setImmediate();
    assert.deepEqual({ opened: signals.length, aborted: signals[0]?.aborted }, { opened: 1, aborted: true });
    assert.deepEqual(calls, []);
    oldOpened.resolve();
    await setImmediate();
    assert.deepEqual(run.stats, { opened: 1, closed: 1 });
    assert.deepEqual(calls, []);
    oldStopped.resolve();
    await setImmediate();
    assert.deepEqual(calls, ["b"]);
    assert.equal(await next, "approve");
    assert.deepEqual(run.stats, { opened: 2, closed: 1 });
    assert.equal(signals[1].aborted, false);
  } finally {
    turn.cancel();
    oldOpened.resolve();
    oldStopped.resolve();
  }
});

// @test-value v2
// kind = "contract"
// claim = "停止確認待ちの期限が過ぎた要求は手動のまま、停止確認後に来た要求の審査は再開できる"
// oracle = { type = "contract", ref = "docs/design/withmate-auto-review.md#一件の判定と手動承認" }
// fault = "未停止の審査と重ねて判定する、または停止待ちの期限切れで元Turnの残りの審査を無効にする"
// observable = "停止待ちの期限前後の審査入力、保留要求の決定、停止確認後の審査入力"
// observation_boundary = "consumer"
// scope = "WithMate仲介審査の停止未確認時の手動承認"
// lifecycle = "permanent"
// distinction = "停止が期限内に確認される場合だけでは、未確認時の手動承認と後続の回復を観測できない"
// @end-test-value
test("unconfirmed reviewer shutdown leaves approval manual without disabling later reviews", { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const oldResult = Promise.withResolvers<unknown>();
  const oldStopped = Promise.withResolvers<void>();
  const calls: string[] = [];
  const run = fixture((prompt) => {
    const id = JSON.parse(prompt).pendingOperation.requestId as string;
    calls.push(id);
    return id === "a" ? oldResult.promise : allow;
  }, 100, { close: () => oldStopped.promise });
  const turn = run.run("42");
  try {
    const first = turn.wait("a");
    await setImmediate();
    run.manual("a", "deny");
    assert.equal(await first, "deny");
    const next = turn.wait("b");
    await setImmediate();
    t.mock.timers.tick(100);
    await setImmediate();
    oldStopped.resolve();
    await setImmediate();
    assert.deepEqual(calls, ["a"]);
    assert.equal(run.head(), "b");
    run.manual("b", "deny");
    assert.equal(await next, "deny");

    const later = turn.wait("c");
    await setImmediate();
    assert.deepEqual(calls, ["a", "c"]);
    assert.equal(await later, "approve");
  } finally {
    turn.cancel();
    oldResult.resolve(allow);
    oldStopped.resolve();
  }
});
