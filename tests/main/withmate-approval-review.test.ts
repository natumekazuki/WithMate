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
  const publications: string[] = [];
  const notifications: string[] = [];
  const approvals = new SessionApprovalService({
    updateLiveSessionRun(_id, update) {
      const next = update(state);
      if (next.approvalRequest && next.approvalRequest !== state.approvalRequest) {
        publications.push(next.approvalRequest.requestId);
      }
      return state = next;
    },
    notifyApproval: (_id, requestId) => { notifications.push(requestId); },
  });
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
      wait(id: string, signal?: AbortSignal, automatic = true) {
        const request: LiveApprovalRequest = { requestId: id, kind: "shell", provider: "copilot", title: "Run", summary: "Test operation", decisionMode: "direct-decision" };
        const native = { operation: { command: `echo ${id}`, target: "workspace" }, isCurrent: () => operationCurrent };
        return approvals.waitForLiveApprovalDecision(source.sessionId, request,
          signal ? AbortSignal.any([owner.signal, signal]) : owner.signal, automatic ? turn.pending(request, native) : undefined);
      },
      cancel: () => owner.abort(), close: () => turn.close(),
      changePolicy: () => { policyCurrent = false; }, supersedeNativeRequest: () => { operationCurrent = false; },
    };
  }
  return { run, stats, inputs, publications, notifications, head: () => state.approvalRequest?.requestId,
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
// claim = "本人確認・不正結果・Provider利用不能・失敗・timeoutまで手動操作を受け付けず、同じ先頭のみ一度公開・通知する"
// oracle = { type = "contract", ref = "docs/design/withmate-auto-review.md#一件の判定と手動承認" }
// fault = "審査中に手動解決する、自然文等で自動許可する、またはfallbackの公開・通知を欠落・重複する"
// observable = "判定前の手動応答拒否と公開・通知履歴、fallback後の同じ手動先頭とdecision、期限切れでのclose呼出"
// observation_boundary = "consumer"
// scope = "WithMate審査結果の検証と手動承認への復帰"
// lifecycle = "permanent"
// distinction = "結果schemaや終端のdecisionだけでは公開・通知を開始するタイミングと手動認可境界を確認できない"
// risk_tags = ["authorization"]
// @end-test-value
test("unusable review outcomes publish and notify only the original head", { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cases = [
    () => "allow_once",
    () => ({ ...allow, extra: "not in contract" }),
    () => ({ ...allow, reason: " " }),
    () => ({ decision: "ask_user", reason: "Uncertain" }),
    () => { throw new Error("Provider failed"); },
  ];
  for (const review of cases) {
    const finish = Promise.withResolvers<void>();
    const run = fixture(async () => { await finish.promise; return review(); });
    const turn = run.run("42");
    const decision = turn.wait("pending");
    await setImmediate();
    assert.deepEqual([run.publications, run.notifications], [[], []]);
    assert.throws(() => run.manual("pending", "approve"), /no longer exists/);
    finish.resolve();
    await setImmediate();
    assert.equal(run.head(), "pending");
    assert.deepEqual([run.publications, run.notifications], [["pending"], ["pending"]]);
    run.manual("pending", "deny");
    assert.equal(await decision, "deny");
    turn.close();
  }
  const unavailable = fixture(() => assert.fail("Unavailable reviewer cannot review"), undefined, {
    open: async () => { throw new Error("Reviewer unavailable"); },
  });
  const unavailableTurn = unavailable.run("42");
  const unavailableDecision = unavailableTurn.wait("unavailable");
  await setImmediate();
  assert.deepEqual([unavailable.publications, unavailable.notifications], [["unavailable"], ["unavailable"]]);
  unavailable.manual("unavailable", "deny");
  assert.equal(await unavailableDecision, "deny");
  unavailableTurn.close();
  const closed = Promise.withResolvers<void>();
  const run = fixture(() => closed.promise, 100);
  const turn = run.run("42");
  const decision = turn.wait("timeout");
  await setImmediate();
  assert.deepEqual([run.publications, run.notifications], [[], []]);
  t.mock.timers.tick(100);
  await setImmediate();
  assert.equal(run.head(), "timeout");
  assert.deepEqual([run.publications, run.notifications], [["timeout"], ["timeout"]]);
  assert.equal(run.stats.closed, 1);
  run.manual("timeout", "deny");
  assert.equal(await decision, "deny");
  closed.resolve();
});

// @test-value v2
// kind = "contract"
// claim = "元Turn取消で審査中と待機中の要求を公開せず全て拒否し、追加入力・設定変更・native要求の鮮度喪失後の許可も適用しない"
// oracle = { type = "contract", ref = "docs/design/withmate-auto-review.md#一件の判定と手動承認" }
// fault = "進行中に対象や根拠が変化した判定を適用する、または別のpendingに付け替える"
// observable = "競合後の手動先頭と公開・通知履歴、元と待機中の決定、元Turn取消での会話終了"
// observation_boundary = "consumer"
// scope = "WithMate審査と承認キューの競合"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// distinction = "承認キューの手動FIFO検査では審査結果が非同期で解決する順序を観測できない"
// @end-test-value
test("a stale allow cannot settle an invalidated pending", { timeout: 2000 }, async () => {
  for (const race of ["cancel", "input", "settings", "native"] as const) {
    const result = Promise.withResolvers<unknown>();
    const started = Promise.withResolvers<void>();
    const reviewed: string[] = [];
    const run = fixture((prompt) => {
      reviewed.push(JSON.parse(prompt).pendingOperation.requestId);
      started.resolve();
      return result.promise;
    });
    const turn = run.run("42");
    const first = turn.wait("a");
    await started.promise;
    if (race === "cancel") {
      const queuedAuto = turn.wait("b");
      const queuedManual = turn.wait("c", undefined, false);
      turn.cancel();
      assert.deepEqual(await Promise.all([first, queuedAuto, queuedManual]), ["deny", "deny", "deny"]);
    }
    if (race === "input") await run.inputs.during(() => undefined);
    if (race === "settings") turn.changePolicy();
    if (race === "native") turn.supersedeNativeRequest();
    result.resolve(allow);
    await setImmediate();
    if (race !== "cancel") {
      assert.equal(run.head(), "a");
      assert.deepEqual([run.publications, run.notifications], [["a"], ["a"]]);
      run.manual("a", "deny");
    } else {
      assert.deepEqual([run.publications, run.notifications], [[], []]);
      assert.deepEqual(reviewed, ["a"]);
    }
    assert.equal(await first, "deny");
    assert.equal(run.head(), undefined);
    if (race === "cancel") assert.equal(run.stats.closed, 1);
    turn.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Aの審査中のB/C到着やBの取消だけではAの有効な許可・拒否を失効させず、手動公開・通知なしに保留先頭を順に審査する"
// oracle = { type = "contract", ref = "docs/design/withmate-auto-review.md#一件の判定と手動承認; docs/design/withmate-auto-review.md#審査会話と履歴の境界" }
// fault = "後着でAの判定を捨てる、後続取消がAを停止する、後続を追い越す、または自動判断だけで公開・通知する"
// observable = "審査要求ID列、各承認callbackの決定、審査会話の開閉回数、live承認公開と通知の履歴"
// observation_boundary = "consumer"
// scope = "WithMate仲介審査を使う同一Turnの承認FIFO"
// lifecycle = "permanent"
// distinction = "Aの終了後にBを新規追加する検査と異なり、Aの審査中にB/Cの両方をキューへ入れる"
// risk_tags = ["authorization"]
// @end-test-value
test("queued reviews retain the current decision despite later arrivals and queued cancellation", { timeout: 2000 }, async () => {
  for (const [result, cancelB] of [[allow, false], [deny, true]] as const) {
    const aResult = Promise.withResolvers<unknown>();
    const bResult = Promise.withResolvers<unknown>();
    const b = new AbortController();
    const calls: string[] = [];
    const run = fixture((prompt) => {
      const id = JSON.parse(prompt).pendingOperation.requestId as string;
      calls.push(id);
      return id === "a" ? aResult.promise : id === "b" ? bResult.promise : deny;
    });
    const turn = run.run("42");
    try {
      const first = turn.wait("a");
      const decisions: string[] = [];
      void first.then((decision) => { decisions.push(decision); });
      await setImmediate();
      assert.deepEqual(calls, ["a"]);
      const second = turn.wait("b", b.signal);
      const third = turn.wait("c");
      if (cancelB) {
        b.abort();
        assert.equal(await second, "deny");
      }
      await setImmediate();
      assert.deepEqual([...decisions], []);
      assert.deepEqual([...calls], ["a"]);
      assert.equal(run.stats.closed, 0);
      aResult.resolve(result);
      await setImmediate();
      assert.deepEqual({ decisions: [...decisions], calls: [...calls], publications: run.publications, notifications: run.notifications }, {
        decisions: [result === allow ? "approve" : "deny"],
        calls: cancelB ? ["a", "c"] : ["a", "b"],
        publications: [], notifications: [],
      });
      bResult.resolve(allow);
      assert.equal(await second, cancelB ? "deny" : "approve");
      assert.equal(await third, "deny");
      assert.deepEqual(calls, cancelB ? ["a", "c"] : ["a", "b", "c"]);
      assert.deepEqual(run.stats, { opened: 1, closed: 0 });
      assert.deepEqual(run.publications, []);
      assert.deepEqual(run.notifications, []);
    } finally {
      b.abort();
      turn.cancel();
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "手動必須・入力が古い・ask_userの後続先頭は手動のままになり、未解決中は次の審査を始めない"
// oracle = { type = "contract", ref = "docs/design/withmate-auto-review.md#一件の判定と手動承認" }
// fault = "後続に先行の適格性を引き継ぐ、開始時に古い入力を使う、本人確認の結果を再試行する、または手動先頭を追い越す"
// observable = "審査入力の要求ID列、手動先頭の公開・通知履歴と判断、解決後の最終decision"
// observation_boundary = "consumer"
// scope = "WithMate仲介審査キューの昇格時の適格性と手動fallback"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// @end-test-value
test("a manual head blocks later review without retrying its own", { timeout: 2000 }, async () => {
  for (const blocker of ["ineligible", "stale input", "ask_user"] as const) {
    const aResult = Promise.withResolvers<unknown>();
    const calls: string[] = [];
    const run = fixture((prompt) => {
      const id = JSON.parse(prompt).pendingOperation.requestId as string;
      calls.push(id);
      return id === "a" ? aResult.promise : id === "b" ? { decision: "ask_user", reason: "Uncertain" } : allow;
    });
    const turn = run.run("42");
    try {
      const manualPredecessor = blocker === "stale input";
      const first = turn.wait("a", undefined, !manualPredecessor);
      await setImmediate();
      const second = turn.wait("b", undefined, blocker !== "ineligible");
      if (blocker === "stale input") run.inputs.invalidate();
      const third = turn.wait("c");
      if (manualPredecessor) run.manual("a", "deny");
      else aResult.resolve(deny);
      assert.equal(await first, "deny");
      await setImmediate();
      const expectedCalls = blocker === "ask_user" ? ["a", "b"] : manualPredecessor ? [] : ["a"];
      const expectedPublications = manualPredecessor ? ["a", "b"] : ["b"];
      assert.deepEqual({ head: run.head(), calls },
        { head: "b", calls: expectedCalls }, blocker);
      assert.deepEqual([run.publications, run.notifications], [expectedPublications, expectedPublications]);
      assert.throws(() => run.manual("c", "approve"), /no longer exists/);
      run.manual("b", "deny");
      assert.equal(await second, "deny");
      assert.equal(await third, "approve");
      assert.deepEqual(calls, [...expectedCalls, "c"], blocker);
      assert.deepEqual([run.publications, run.notifications], [expectedPublications, expectedPublications]);
    } finally {
      turn.cancel();
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "実審査の失敗・期限切れはその要求だけを手動にし、解決と停止確認の後は同じTurnの次の適格な先頭を審査する"
// oracle = { type = "contract", ref = "docs/design/withmate-auto-review.md#一件の判定と手動承認" }
// fault = "失敗や期限切れで審査を重ねるか、Turn全体の審査を止めて残りの適格な要求を手動に固定する"
// observable = "手動先頭、Providerへの要求ID列、旧会話の停止と後続のdecision"
// observation_boundary = "consumer"
// scope = "WithMate仲介審査が失敗した同じTurnでの次の先頭"
// lifecycle = "permanent"
// distinction = "停止待ち中ではなく、実行中のProvider審査そのものの期限切れと失敗を検証する"
// @end-test-value
test("review timeout and failure do not disable the next head in the same turn", { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const failure of ["timeout", "provider error"] as const) {
    const aResult = Promise.withResolvers<unknown>();
    const stopped = Promise.withResolvers<void>();
    const calls: string[] = [];
    const run = fixture((prompt) => {
      const id = JSON.parse(prompt).pendingOperation.requestId as string;
      calls.push(id);
      return id === "a" ? aResult.promise : allow;
    }, 100, { close: () => stopped.promise });
    const turn = run.run("42");
    try {
      const first = turn.wait("a");
      await setImmediate();
      const second = turn.wait("b");
      if (failure === "timeout") t.mock.timers.tick(100);
      else aResult.reject(new Error("Provider failed"));
      await setImmediate();
      assert.deepEqual({ head: run.head(), calls, closed: run.stats.closed }, { head: "a", calls: ["a"], closed: 1 }, failure);
      run.manual("a", "deny");
      assert.equal(await first, "deny");
      await setImmediate();
      assert.deepEqual({ head: run.head(), calls }, { head: undefined, calls: ["a"] }, failure);
      stopped.resolve();
      await setImmediate();
      assert.deepEqual(calls, ["a", "b"], failure);
      assert.equal(await second, "approve");
    } finally {
      turn.cancel();
      stopped.resolve();
      aResult.resolve(deny);
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "同じ会話の次Turnは旧審査の停止確認まで審査を起動せず、待機を取消または期限切れにしても古い結果を採用しない"
// oracle = { type = "contract", ref = "docs/design/withmate-auto-review.md#一件の判定と手動承認" }
// fault = "Turn交代で停止待ちを捨てる、古い審査結果が現審査に干渉する、または待機の取消・期限切れ後に審査を開始する"
// observable = "旧要求のdecision、審査会話の開閉、Providerに渡る要求ID列、新Turn内の承認先頭とdecision"
// observation_boundary = "consumer"
// scope = "同一会話の審査停止確認のTurn境界"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// @end-test-value
test("review shutdown remains a fence across turns in the same session", { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const action of ["confirm", "timeout", "cancel"] as const) {
    const aResult = Promise.withResolvers<unknown>();
    const bResult = Promise.withResolvers<unknown>();
    const stopped = Promise.withResolvers<void>();
    const calls: string[] = [];
    let closes = 0;
    const run = fixture((prompt) => {
      const id = JSON.parse(prompt).pendingOperation.requestId as string;
      calls.push(id);
      return id === "a" ? aResult.promise : id === "b" ? bResult.promise : deny;
    }, 100, { close: () => ++closes === 1 ? stopped.promise : Promise.resolve() });
    const old = run.run("old");
    const current = run.run("current");
    const nextRequest = new AbortController();
    try {
      const first = old.wait("a");
      await setImmediate();
      old.cancel();
      assert.equal(await first, "deny");
      const second = current.wait("b", nextRequest.signal);
      const decisions: string[] = [];
      void second.then((decision) => { decisions.push(decision); });
      await setImmediate();
      assert.deepEqual({ head: run.head(), calls, ...run.stats },
        { head: undefined, calls: ["a"], opened: 1, closed: 1 }, action);
      if (action === "timeout") {
        t.mock.timers.tick(100);
        await setImmediate();
      } else if (action === "cancel") {
        nextRequest.abort();
        assert.equal(await second, "deny");
      }
      stopped.resolve();
      await setImmediate();
      aResult.resolve(allow);
      await setImmediate();
      if (action === "confirm") {
        assert.deepEqual({ head: run.head(), calls }, { head: undefined, calls: ["a", "b"] });
        assert.deepEqual([...decisions], []);
        bResult.resolve(deny);
        assert.equal(await second, "deny");
      } else {
        assert.deepEqual(calls, ["a"]);
        assert.equal(run.head(), action === "timeout" ? "b" : undefined);
        if (action === "timeout") run.manual("b", "deny");
        assert.equal(await second, "deny");
      }
      assert.equal(await current.wait("c"), "deny");
      assert.deepEqual(calls, action === "confirm" ? ["a", "b", "c"] : ["a", "c"]);
    } finally {
      old.cancel();
      current.cancel();
      nextRequest.abort();
      stopped.resolve();
      aResult.resolve(allow);
      bResult.resolve(deny);
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "要求取消で実行中の審査を停止し、停止確認後は同じTurnの次の先頭要求を審査できる"
// oracle = { type = "contract", ref = "docs/design/withmate-auto-review.md#一件の判定と手動承認" }
// fault = "要求の失効を審査Providerに伝えない、停止確認前に審査を重ねる、または古い審査が新しい要求やその会話を閉じる"
// observable = "Provider境界のabort、停止確認前後の審査呼出、遅延結果後の公開・通知、後続要求の決定・会話の再利用"
// observation_boundary = "consumer"
// scope = "WithMate仲介審査と承認サービスの要求寿命"
// lifecycle = "permanent"
// impact = "後続の対象要求が手動待ちに固定されるか、審査が重複する"
// distinction = "古い許可の不採用だけでは停止伝播と後続の審査開始を検出できない"
// @end-test-value
test("canceling a request stops its review and releases only its conversation", { timeout: 2000 }, async () => {
  for (const lateResult of ["allow", "error"] as const) {
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

      const next = turn.wait("b");
      const decisions: string[] = [];
      void next.then((decision) => { decisions.push(decision); });
      request.abort();
      assert.equal(await first, "deny");
      await setImmediate();
      const beforeStop = { calls: calls.map(({ id }) => id), aborted: calls[0].signal.aborted };
      oldStopped.resolve();
      await setImmediate();
      assert.deepEqual({ beforeStop, afterStop: calls.map(({ id }) => id) },
        { beforeStop: { calls: ["a"], aborted: true }, afterStop: ["a", "b"] }, lateResult);
      assert.notEqual(calls[0].signal, calls[1].signal);
      if (lateResult === "error") oldResult.reject(new Error("Late failure from the canceled reviewer"));
      else oldResult.resolve(allow);
      await setImmediate();
      assert.deepEqual([run.publications, run.notifications], [[], []]);
      assert.deepEqual([...decisions], []);
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
  const request = new AbortController();
  try {
    const first = turn.wait("a", request.signal);
    await setImmediate();
    request.abort();
    assert.equal(await first, "deny");
    const next = turn.wait("b");
    await setImmediate();
    t.mock.timers.tick(100);
    await setImmediate();
    assert.equal(run.head(), "b");
    assert.deepEqual(calls, ["a"]);
    assert.deepEqual([run.publications, run.notifications], [["b"], ["b"]]);
    oldStopped.resolve();
    await setImmediate();
    assert.deepEqual(calls, ["a"]);
    assert.equal(run.head(), "b");
    assert.deepEqual([run.publications, run.notifications], [["b"], ["b"]]);
    run.manual("b", "deny");
    assert.equal(await next, "deny");

    const later = turn.wait("c");
    await setImmediate();
    assert.deepEqual(calls, ["a", "c"]);
    assert.equal(await later, "approve");
  } finally {
    request.abort();
    turn.cancel();
    oldResult.resolve(allow);
    oldStopped.resolve();
  }
});
