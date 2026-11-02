import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import type { BackgroundPurpose } from "../../src-shared/agent-runtime/background-execution-scope.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import { BackgroundExecutionService, type BackgroundExecution } from "../../src-electron/providers/background-execution-service.js";
import { BackgroundCallService, type BackgroundCallInput, type BackgroundAgentInput } from "../../src-electron/providers/background-call-service.js";
import { assertRuntimeTurnAdmission, currentRuntimeTurnAdmissionState, runWithRuntimeTurnAdmission,
  RuntimeTurnInactiveError } from "../../src-electron/platform/memory/runtime-turn-admission.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const bindings = new AgentRuntimeBindingRegistry();
  const turns = new ProviderAgentRuntimeTurnCoordinator();
  const closes: string[] = [];
  const executions = new BackgroundExecutionService({ bindings, turns,
    closeConnection: (handle) => { closes.push(handle.bindingId!); } });
  executions.start();
  function input(purpose: BackgroundPurpose = "affect", id = "main"): BackgroundCallInput {
    const session = { ...buildNewSession({ taskTitle: "Source", workspaceLabel: "fixture", workspacePath: "C:/fixture",
      branch: "fixture", characterId: "character", character: "Character", characterIconPath: "",
      characterThemeColors: { main: "#123456", sub: "#abcdef" }, approvalMode: "on-request" }),
      id, incarnationId: "inc-" + id, threadId: "normal-native-thread" };
    const source = id === "aux"
      ? { kind: "auxiliary" as const, sessionId: id, incarnationId: session.incarnationId,
        ownerIdentity: JSON.stringify(["auxiliary", id, "draft-a", "main", "inc-main", session.incarnationId]),
        parent: { sessionId: "main", incarnationId: "inc-main" } }
      : { kind: "main" as const, sessionId: id, incarnationId: session.incarnationId,
        ownerIdentity: JSON.stringify(["main", id, session.incarnationId]) };
    return {
      context: { actorSessionId: id, session, authoritySnapshot: { characterId: "character", userId: "local-user" },
        operationGrants: ["session_history.route.list_messages"],
        scope: { purpose, history: { source, fromMessageSeq: 0, throughMessageSeq: 1 },
          processing: { afterTurnId: null, throughTurnId: 1 }, memoryTargets: [] } },
      selection: { providerId: "claude", modelId: "fixed-model" }, userInput: "Use the permitted saved material.",
      onAdmitted: () => {},
    };
  }
  return { bindings, turns, executions, closes, input };
}

// @test-value v2
// kind = "contract"
// claim = "一回のAgentへ同一背景bindingと入力を渡し、主会話Cancelから独立してadmissionを終了まで保つ"
// oracle = { type = "contract", ref = "docs/adr/035-background-execution-binding-and-history-scope.md#背景実行内のmcpcli直接登録" }
// fault = "Agentへ別bindingや入力を渡す、主会話終了で取消す、またはAgent待ち中に権限を閉じる"
// observable = "port回数と入力、admission状態、主会話継続、終了後のbindingと接続閉鎖"
// observation_boundary = "consumer"
// scope = "runOnce with real binding and turn ownership"
// lifecycle = "permanent"
// impact = "背景登録が誤った会話権限で動くか通常会話を阻害する"
// distinction = "begin単体testと型検査はAgentのawaitを通じた権限寿命を観測しない"
// @end-test-value
test("runOnce forwards Agent inputs and keeps admission independently of the main turn", async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  const base = f.input();
  let begun: BackgroundExecution | undefined, agent: BackgroundAgentInput | undefined;
  let calls = 0, admitted = 0;
  const begin = f.executions.begin.bind(f.executions);
  f.executions.begin = (input) => {
    const result = begin(input); if (result.ok) begun = result.execution; return result;
  };
  const normal = f.bindings.issueOrReuse({ actorSessionId: "main", providerId: "codex", operationGrants: [] });
  const first = f.turns.begin({ actorSessionId: "main", providerId: "codex" });
  const service = new BackgroundCallService({ executions: f.executions, runAgent: async (input) => {
    calls += 1; agent = input;
    assert.equal(admitted, 1);
    assert.equal(input.session, base.context.session); assert.equal(input.scope, base.context.scope);
    assert.equal(input.selection, base.selection); assert.equal(input.userInput, base.userInput);
    assert.equal(input.binding, begun!.binding); assert.equal(input.handle, begun!.handle);
    assert.equal(input.signal, begun!.signal); assert.equal(input.binding.background, true);
    assert.equal(input.binding.providerId, "claude"); assert.notEqual(input.binding.bindingId, normal.bindingId);
    assert.equal(currentRuntimeTurnAdmissionState(), begun!.admission.state);
    entered.resolve(); await release.promise; assertRuntimeTurnAdmission();
  } });
  const pending = service.runOnce({ ...base, onAdmitted: () => { admitted += 1; } });
  try {
    await entered.promise;
    f.turns.end(first); assert.equal(agent!.signal.aborted, false);
    const next = f.turns.begin({ actorSessionId: "main", providerId: "codex" });
    assert.equal(f.bindings.getActiveBindingCount(), 2); assert.equal(f.closes.length, 0);
    runWithRuntimeTurnAdmission(begun!.admission, assertRuntimeTurnAdmission);
    assert.equal(f.bindings.getExecutionGeneration("main", "codex"), normal.executionGeneration);
    assert.equal(base.context.session.threadId, "normal-native-thread");
    release.resolve(); assert.deepEqual(await pending, { kind: "completed" });
    assert.equal(calls, 1); assert.equal(f.bindings.getActiveBindingCount(), 1);
    assert.deepEqual(f.closes, [agent!.binding.bindingId]);
    assert.throws(() => runWithRuntimeTurnAdmission(begun!.admission, assertRuntimeTurnAdmission), RuntimeTurnInactiveError);
    assert.equal(f.turns.admit({ actorSessionId: "main", providerId: "codex", turnCapability: next.capability }).ok, true);
    f.turns.end(next);
  } finally { release.resolve(); f.executions.stop(); }
});

// @test-value v2
// kind = "contract"
// claim = "Agent終了と例外を区別し、受付通知失敗時はAgentを呼ばず、どの終了でも実行枠を解放する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#共通の単発呼出" }
// fault = "例外を正常終了にする、通知失敗後もAgentを起動する、または失敗でbindingを残す"
// observable = "結果code、port回数、終了後のbinding件数と再受付"
// observation_boundary = "consumer"
// scope = "Agent completion and callback failures"
// lifecycle = "permanent"
// impact = "処理失敗が隠れるか枠漏れで後続が止まる"
// distinction = "begin単体testにはAgentや受付通知の例外経路がない"
// @end-test-value
test("Agent completion and callback errors release ownership", async () => {
  for (const scenario of ["completed", "agent", "coded-agent", "admitted"] as const) {
    const f = fixture(); let calls = 0;
    const service = new BackgroundCallService({ executions: f.executions, runAgent: () => {
      calls += 1;
      if (scenario === "agent") throw new Error("failed");
      if (scenario === "coded-agent") throw Object.assign(new Error("failed"), { code: "PROVIDER_FAILED" });
    } });
    try {
      const base = f.input();
      assert.deepEqual(await service.runOnce({ ...base,
        onAdmitted: () => { if (scenario === "admitted") throw new Error("callback failed"); },
      }), scenario === "completed" ? { kind: "completed" } : { kind: "failed",
        code: scenario === "admitted" ? "BACKGROUND_ADMISSION_CALLBACK_FAILED"
          : scenario === "coded-agent" ? "PROVIDER_FAILED" : "BACKGROUND_AGENT_FAILED" });
      assert.equal(calls, scenario === "admitted" ? 0 : 1);
      assert.equal(f.bindings.getActiveBindingCount(), 0); assert.equal(f.closes.length, 1);
      assert.equal(f.executions.begin({ ...base.context, providerId: base.selection.providerId }).ok, true);
    } finally { f.executions.stop(); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "背景全体3・用途owner1の見送りではportを呼ばず、Agent待ち中も枠を保持して終了後に再受付する"
// oracle = { type = "contract", ref = "docs/adr/035-background-execution-binding-and-history-scope.md#維持する境界" }
// fault = "Agent待ち中に枠を解放するか見送りでも受付通知やAgentを呼ぶ"
// observable = "skipped reason、port回数、binding数、終了後の同owner再実行"
// observation_boundary = "consumer"
// scope = "runOnce capacity delegation including Main/Auxiliary scope"
// lifecycle = "permanent"
// impact = "上限超過や同一会話用途の二重実行を許す"
// distinction = "begin単体testはrunOnceがAgentのawait前にfinishする欠陥を検出しない"
// @end-test-value
test("capacity and owner-purpose skips retain slots through Agent invocation", async () => {
  const f = fixture(), release = deferred(), entered = deferred(); let admitted = 0, agents = 0;
  const service = new BackgroundCallService({ executions: f.executions, runAgent: async () => {
    agents += 1; if (agents === 3) entered.resolve(); await release.promise; assertRuntimeTurnAdmission();
  } });
  const run = (purpose: BackgroundPurpose, id = "main") => service.runOnce({ ...f.input(purpose, id),
    onAdmitted: () => { admitted += 1; } });
  const pending = [run("affect"), run("character-memory"), run("affect", "aux")];
  try {
    await entered.promise;
    assert.deepEqual(await run("affect"), { kind: "skipped", reason: "already_active" });
    assert.deepEqual(await run("target-memory", "other"), { kind: "skipped", reason: "capacity" });
    assert.deepEqual([admitted, agents, f.bindings.getActiveBindingCount()], [3, 3, 3]);
    release.resolve();
    for (const result of await Promise.all(pending)) assert.deepEqual(result, { kind: "completed" });
    assert.equal(f.bindings.getActiveBindingCount(), 0); assert.deepEqual(await run("affect"), { kind: "completed" });
  } finally { release.resolve(); f.executions.stop(); }
});

// @test-value v2
// kind = "contract"
// claim = "背景取消・失効はAgentの未確定writeを拒否し、先行確定した効果を消さず取消結果で終了する"
// oracle = { type = "contract", ref = "docs/adr/035-background-execution-binding-and-history-scope.md#維持する境界" }
// fault = "停止後もadmissionを有効にするか取消を正常終了にする"
// observable = "signal、保存境界のRuntimeTurnInactiveError、取消結果、保存済みfixtureの保持"
// observation_boundary = "consumer"
// scope = "source revocation, explicit abort and runtime stop during Agent execution"
// lifecycle = "permanent"
// impact = "失効後writeを許すか先行保存を全件未保存と誤認する"
// distinction = "store単件testだけではAgentのawait後も同じadmissionが伝播することを確認できない"
// risk_tags = ["authorization"]
// @end-test-value
test("cancellation rejects pending Agent writes while preserving prior effects", async () => {
  for (const cause of ["abort", "source", "stop"] as const) for (const ending of ["resolve", "reject"] as const) {
    const f = fixture(), entered = deferred(), release = deferred(), controller = new AbortController();
    const saved: string[] = []; let signal: AbortSignal | undefined;
    const service = new BackgroundCallService({ executions: f.executions, runAgent: async (input) => {
      signal = input.signal; assertRuntimeTurnAdmission(); saved.push("confirmed first");
      entered.resolve(); await release.promise;
      assert.throws(assertRuntimeTurnAdmission, RuntimeTurnInactiveError);
      if (ending === "reject") throw new RuntimeTurnInactiveError();
    } });
    const base = f.input();
    const pending = service.runOnce({ ...base, context: { ...base.context, signal: controller.signal } });
    try {
      await entered.promise;
      if (cause === "abort") controller.abort();
      else if (cause === "source") f.bindings.revokeSession("main"); else f.executions.stop();
      assert.equal(signal!.aborted, true); release.resolve();
      assert.deepEqual(await pending, { kind: "canceled", code: "BACKGROUND_CALL_CANCELED" });
      assert.deepEqual(saved, ["confirmed first"]); assert.equal(f.bindings.getActiveBindingCount(), 0);
    } finally { release.resolve(); f.executions.stop(); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "begin時の不正sourceと停止runtimeを見送りへ潰さず、事前取消ではportを呼ばない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#共通の単発呼出" }
// fault = "begin例外を容量待ちへ変換するか事前取消でもAgentを呼ぶ"
// observable = "runOnceのrejectと取消結果、port回数とbinding件数"
// observation_boundary = "consumer"
// scope = "begin failures before acquiring a background execution"
// lifecycle = "permanent"
// impact = "認可失敗を容量待ちと誤認するか取消済み要求へ生成を課金する"
// distinction = "begin単体testはrunOnceによる例外の誤変換を検出しない"
// @end-test-value
test("begin failures remain errors and pre-cancel does not start work", async () => {
  const f = fixture(); let ports = 0;
  const service = new BackgroundCallService({ executions: f.executions, runAgent: () => { ports += 1; } });
  const base = f.input(), input = { ...base, onAdmitted: () => { ports += 1; } };
  try {
    await assert.rejects(service.runOnce({ ...input, context: { ...base.context, actorSessionId: "wrong" } }), /eligible source/);
    const controller = new AbortController(); controller.abort();
    assert.deepEqual(await service.runOnce({ ...input, context: { ...base.context, signal: controller.signal } }),
      { kind: "canceled", code: "BACKGROUND_CALL_CANCELED" });
    f.executions.stop(); await assert.rejects(service.runOnce(input), /runtime is unavailable/);
    assert.equal(ports, 0); assert.equal(f.bindings.getActiveBindingCount(), 0);
  } finally { f.executions.stop(); }
});
