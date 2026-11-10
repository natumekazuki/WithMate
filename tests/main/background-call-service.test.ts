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
        scope: { purpose, history: { source, fromMessageSeq: 0, throughMessageSeq: 1 }, memoryTargets: [] } },
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
    begun = begin(input); return begun;
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
// claim = "Agent終了と例外を区別し、受付通知失敗時はAgentを呼ばず、どの終了でも実行権限を閉じる"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#共通の単発呼出" }
// fault = "例外を正常終了にする、通知失敗後もAgentを起動する、または失敗でbindingを残す"
// observable = "結果code、port回数、終了後のbinding件数と再受付"
// observation_boundary = "consumer"
// scope = "Agent completion and callback failures"
// lifecycle = "permanent"
// impact = "処理失敗が隠れるか終了済み実行の権限が残る"
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
      assert.equal(f.executions.begin({ ...base.context, providerId: base.selection.providerId }).signal.aborted, false);
    } finally { f.executions.stop(); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "同source用途のnative threadは直列継続し、他用途と別sourceは並行して各回の権限を独立に閉じる"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "同threadへ同時送信する、native文脈を失う、または別source用途まで待機させる"
// observable = "Agent開始数・継続ID/thread、bindingとcapabilityの更新、別実行の有効性、終了後権限"
// observation_boundary = "consumer"
// scope = "concurrent runOnce ownership through Agent awaits"
// lifecycle = "permanent"
// impact = "生成文脈や操作が同thread内で競合し、別用途や会話まで止まる"
// distinction = "型検査とbegin単体testはnative継続と呼出権限の異なる寿命を確認できない"
// @end-test-value
test("same-scope native context is serial while other sources and purposes remain independent", async () => {
  const f = fixture(), releases = Array.from({ length: 4 }, deferred);
  const agents: BackgroundAgentInput[] = []; let admitted = 0;
  const service = new BackgroundCallService({ executions: f.executions, runAgent: async (input) => {
    const index = agents.length; agents.push(input);
    assert.equal(admitted, index + 1);
    input.continuation.onThreadId(`native-${input.continuation.id}`);
    await releases[index]!.promise; assertRuntimeTurnAdmission();
  } });
  const invoke = (purpose: BackgroundPurpose = "affect", id = "main") => service.runOnce({ ...f.input(purpose, id), onAdmitted: () => { admitted += 1; } });
  const pending = [invoke(), invoke(), invoke("target-memory"), invoke("affect", "aux")];
  try {
    assert.deepEqual([admitted, agents.length, f.bindings.getActiveBindingCount()], [3, 3, 3]);
    assert.equal(new Set(agents.map((agent) => agent.continuation.id)).size, 3);
    releases[0]!.resolve(); assert.deepEqual(await pending[0], { kind: "completed" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(agents.length, 4);
    assert.equal(agents[3]!.continuation.id, agents[0]!.continuation.id);
    assert.equal(agents[3]!.continuation.threadId, `native-${agents[0]!.continuation.id}`);
    assert.notEqual(agents[3]!.binding.bindingId, agents[0]!.binding.bindingId);
    assert.notEqual(agents[3]!.handle.capability, agents[0]!.handle.capability);
    assert.equal(f.bindings.resolveIdentity(agents[0]!.binding.bindingReference).ok, false);
    assert.equal(f.bindings.getActiveBindingCount(), 3);
    for (const index of [1, 2, 3]) {
      assert.equal(agents[index]!.signal.aborted, false);
      releases[index]!.resolve();
    }
    assert.ok((await Promise.all(pending)).every((result) => result.kind === "completed"));
    assert.equal(f.bindings.getActiveBindingCount(), 0);
    assert.equal(new Set(f.closes).size, 4); assert.equal(f.closes.length, 4);
  } finally {
    service.stop(); f.executions.stop(); for (const release of releases) release.resolve(); await Promise.allSettled(pending);
  }
});

// @test-value v2
// kind = "contract"
// claim = "失敗後も利用可能threadを次回へ引継ぎ、失敗材料を渡し、正常な登録不要終了後は古い失敗を再送しない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "失敗でthreadを消すか、全件未保存と推定するか、成功後も古い失敗を繰返す"
// observable = "次回Agentの継続thread・userInputの実失敗原因と元入力、呼出回数、正常終了"
// observation_boundary = "consumer"
// scope = "BackgroundCallService across failed and subsequent successful invocations"
// lifecycle = "permanent"
// distinction = "単発保存testやadapter resume testだけでは次回発火へ渡す失敗材料を確認できない"
// @end-test-value
test("usable thread and failure evidence continue on the next call without an automatic retry", async () => {
  const f = fixture(), agents: BackgroundAgentInput[] = [];
  const service = new BackgroundCallService({ executions: f.executions, runAgent(input) {
    agents.push(input);
    if (agents.length === 1) {
      input.continuation.onThreadId("usable-native-thread");
      throw Object.assign(new Error("Registration was refused token=PRIVATE"), { code: "MEMORY_FORBIDDEN" });
    }
  } });
  try {
    assert.equal((await service.runOnce(f.input())).kind, "failed");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(agents.length, 1);
    assert.deepEqual(await service.runOnce({ ...f.input(), userInput: "New saved turn" }), { kind: "completed" });
    assert.equal(agents[1]!.continuation.id, agents[0]!.continuation.id);
    assert.equal(agents[1]!.continuation.threadId, "usable-native-thread");
    assert.ok(agents[1]!.userInput.startsWith("New saved turn"));
    assert.match(agents[1]!.userInput, /MEMORY_FORBIDDEN/);
    assert.match(agents[1]!.userInput, /Registration was refused token=\[REDACTED\]/);
    assert.equal(agents[1]!.userInput.includes("PRIVATE"), false);
    await service.runOnce(f.input());
    assert.equal(agents[2]!.userInput, f.input().userInput);
  } finally { service.stop(); f.executions.stop(); }
});

// @test-value v2
// kind = "contract"
// claim = "Provider切替は旧呼出の権限を失効しcleanup後に新threadを開始、遅延結果を無視しruntime停止とsource削除で継続を破棄する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "旧credentialを延命するか遅延threadを新状態へ混ぜるか、停止・削除後にnative文脈を復元する"
// observable = "切替時signalとbinding失効、新AgentのProvider/継続ID/thread、停止・削除後の新thread"
// observation_boundary = "consumer"
// scope = "provider selection invalidation, source lifecycle and in-memory continuity ownership"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// distinction = "型検査や逐次resumeでは取消中の遅延結果と再起動境界を観測できない"
// @end-test-value
test("provider changes revoke old calls and ignore late thread updates before starting fresh", async () => {
  const f = fixture(), release = deferred(), agents: BackgroundAgentInput[] = [];
  const service = new BackgroundCallService({ executions: f.executions, runAgent: async (input) => {
    agents.push(input);
    if (agents.length === 1) { await release.promise; input.continuation.onThreadId("late-old-thread"); }
    else input.continuation.onThreadId("new-native-thread");
  } });
  const old = service.runOnce(f.input());
  try {
    service.setProvider("affect", "codex");
    assert.equal(agents[0]!.signal.aborted, true);
    assert.equal(f.bindings.resolveIdentity(agents[0]!.binding.bindingReference).ok, false);
    const nextInput = { ...f.input(), selection: { providerId: "codex", modelId: "next" } };
    const next = service.runOnce(nextInput);
    assert.equal(agents.length, 1);
    release.resolve(); assert.equal((await old).kind, "canceled");
    assert.equal((await next).kind, "completed");
    assert.notEqual(agents[1]!.continuation.id, agents[0]!.continuation.id);
    assert.equal(agents[1]!.continuation.threadId, null);
    assert.equal(agents[1]!.selection.providerId, "codex");
    service.stop(); f.executions.stop(); f.executions.start();
    await service.runOnce(nextInput);
    assert.equal(agents[2]!.continuation.threadId, null);
    assert.notEqual(agents[2]!.continuation.id, agents[1]!.continuation.id);
    service.forgetSource("main", "main");
    await service.runOnce(nextInput);
    assert.equal(agents[3]!.continuation.threadId, null);
    assert.notEqual(agents[3]!.continuation.id, agents[2]!.continuation.id);
  } finally { release.resolve(); service.stop(); f.executions.stop(); await old; }
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
// claim = "begin時の不正sourceと停止runtimeを失敗として返し、事前取消ではportを呼ばない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#共通の単発呼出" }
// fault = "begin例外を正常な終了へ変換するか事前取消でもAgentを呼ぶ"
// observable = "runOnceの失敗と取消結果、port回数とbinding件数"
// observation_boundary = "consumer"
// scope = "begin failures before acquiring a background execution"
// lifecycle = "permanent"
// impact = "認可失敗を隠すか取消済み要求へ生成を課金する"
// distinction = "begin単体testはrunOnceによる失敗結果への変換を検出しない"
// @end-test-value
test("begin failures remain errors and pre-cancel does not start work", async () => {
  const f = fixture(); let ports = 0;
  const service = new BackgroundCallService({ executions: f.executions, runAgent: () => { ports += 1; } });
  const base = f.input(), input = { ...base, onAdmitted: () => { ports += 1; } };
  try {
    assert.deepEqual(await service.runOnce({ ...input, context: { ...base.context, actorSessionId: "wrong" } }), { kind: "failed", code: "BACKGROUND_SETUP_FAILED" });
    const controller = new AbortController(); controller.abort();
    assert.deepEqual(await service.runOnce({ ...input, context: { ...base.context, signal: controller.signal } }),
      { kind: "canceled", code: "BACKGROUND_CALL_CANCELED" });
    f.executions.stop(); assert.deepEqual(await service.runOnce(input), { kind: "failed", code: "BACKGROUND_SETUP_FAILED" });
    assert.equal(ports, 0); assert.equal(f.bindings.getActiveBindingCount(), 0);
  } finally { f.executions.stop(); }
});
