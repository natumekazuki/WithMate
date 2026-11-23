import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { LiveApprovalRequest, LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import { SessionApprovalService } from "../../src-electron/session/session-approval-service.js";
import { ApprovalReviewInputFence, WithMateApprovalReviewTurn } from "../../src-electron/session/withmate-approval-review.js";

const source = { kind: "main", sessionId: "source", incarnationId: "source-generation" } as const;
const allow = { decision: "allow_once", reason: "The saved request authorizes this operation." };
const deny = { decision: "deny", reason: "The saved request prohibits this operation." };

function fixture(review: (prompt: string) => unknown, timeoutMs?: number) {
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
      open: async () => {
        stats.opened++;
        return { review: async (prompt) => review(prompt), close: () => { stats.closed++; } };
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
