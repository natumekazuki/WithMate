import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import type { BackgroundPurpose } from "../../src-shared/agent-runtime/background-execution-scope.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import { BackgroundExecutionService } from "../../src-electron/providers/background-execution-service.js";
import {
  BackgroundCallService, type BackgroundCallInput, type BackgroundGenerationInput, type BackgroundSaveResult,
} from "../../src-electron/providers/background-call-service.js";
import {
  assertRuntimeTurnAdmission, currentRuntimeTurnAdmissionState, runWithRuntimeTurnAdmission,
  RuntimeTurnInactiveError, type RuntimeTurnAdmission,
} from "../../src-electron/platform/memory/runtime-turn-admission.js";

const finalOutput = z.union([
  z.strictObject({ kind: z.literal("items"), items: z.array(z.string()).min(1) }),
  z.strictObject({ kind: z.literal("none") }),
]);
type Output = z.infer<typeof finalOutput>;
const schema = z.toJSONSchema(finalOutput);
const generated = { kind: "items", items: ["candidate"] };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const bindings = new AgentRuntimeBindingRegistry();
  const turns = new ProviderAgentRuntimeTurnCoordinator();
  const closes: string[] = [];
  const executions = new BackgroundExecutionService({ bindings, turns,
    closeConnection: (handle) => { closes.push(handle.bindingId!); } });
  executions.start();
  function input(purpose: BackgroundPurpose = "affect", id = "main"): BackgroundCallInput<Output> {
    const session = { ...buildNewSession({ taskTitle: "Source", workspaceLabel: "fixture", workspacePath: "C:/fixture",
      branch: "fixture", characterId: "character", character: "Character", characterIconPath: "",
      characterThemeColors: { main: "#123456", sub: "#abcdef" }, approvalMode: "on-request" }),
      id, incarnationId: `inc-${id}`, threadId: "normal-native-thread" };
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
      final: { schema, parse: (raw) => finalOutput.parse(raw) }, onAdmitted: () => {},
      save: (output) => output.kind === "none" ? { kind: "none" } : { kind: "saved", confirmedSavedCount: output.items.length },
    };
  }
  return { bindings, turns, executions, closes, input };
}

// @test-value v2
// kind = "contract"
// claim = "runOnceは一度生成したfinalだけをparseして保存し、native閉鎖後の保存権限を保持してfinishで失効する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#共通の単発呼出" }
// fault = "parse前に保存する、generationへ入力やschemaを渡さない、またはnative閉鎖で保存権限も終了する"
// observable = "portの入力、呼出順、保存待ち中とfinish後のadmission、通常bindingと次turnの利用可否"
// observation_boundary = "consumer"
// scope = "runOnce with real binding/turn ownership and fixed generation/save ports"
// lifecycle = "permanent"
// impact = "候補を誤保存するか、背景保存が通常会話の継続を阻害する"
// distinction = "既存のbegin/host testは共通generation/parse/saveのawaitを通らず、型検査では寿命を観測できない"
// @end-test-value
test("runOnce forwards inputs and keeps save admission after native completion without owning the main turn", async () => {
  const f = fixture();
  const generating = deferred<void>();
  const resumeGeneration = deferred<unknown>();
  const saving = deferred<RuntimeTurnAdmission>();
  const release = deferred<void>();
  const events: string[] = [];
  const base = f.input();
  const normal = f.bindings.issueOrReuse({ actorSessionId: "main", providerId: "codex", operationGrants: [] });
  const first = f.turns.begin({ actorSessionId: "main", providerId: "codex" });
  let native: BackgroundGenerationInput | undefined;
  const calls = new BackgroundCallService({ executions: f.executions, generate: (input) => {
    events.push("generate"); native = input;
    assert.equal(input.session, base.context.session);
    assert.equal(input.scope, base.context.scope);
    assert.equal(input.selection, base.selection);
    assert.equal(input.userInput, base.userInput);
    assert.equal(input.finalSchema, schema);
    assert.equal(input.binding.background, true);
    assert.equal(input.binding.providerId, "claude");
    assert.notEqual(input.binding.bindingId, normal.bindingId);
    assert.equal(f.closes.length, 0);
    generating.resolve(undefined);
    return resumeGeneration.promise;
  } });
  const pending = calls.runOnce({ ...base, onAdmitted: () => { events.push("admitted"); },
    final: { schema, parse: (raw) => {
      events.push("parse"); assert.equal(raw, generated); assert.equal(f.closes.length, 1);
      return finalOutput.parse(raw);
    } }, save: async (output, context) => {
      events.push("save"); assert.deepEqual(output, generated);
      assert.equal(context.scope, base.context.scope);
      assert.equal(context.signal, native!.signal);
      assert.equal(currentRuntimeTurnAdmissionState(), context.admission.state);
      saving.resolve(context.admission);
      await release.promise;
      assertRuntimeTurnAdmission();
      return { kind: "saved", confirmedSavedCount: 1 };
    } });
  try {
    await generating.promise;
    assert.deepEqual(events, ["admitted", "generate"]);
    f.turns.end(first);
    assert.equal(native!.signal.aborted, false);
    const next = f.turns.begin({ actorSessionId: "main", providerId: "codex" });
    resumeGeneration.resolve(generated);
    const admission = await saving.promise;
    assert.deepEqual(events, ["admitted", "generate", "parse", "save"]);
    assert.equal(f.bindings.getActiveBindingCount(), 2);
    runWithRuntimeTurnAdmission(admission, assertRuntimeTurnAdmission);
    f.turns.end(next);
    assert.equal(native!.signal.aborted, false);
    const afterSaveStarted = f.turns.begin({ actorSessionId: "main", providerId: "codex" });
    assert.equal(f.bindings.getExecutionGeneration("main", "codex"), normal.executionGeneration);
    assert.equal(base.context.session.threadId, "normal-native-thread");
    assert.equal(base.context.session.provider, "codex");
    release.resolve(undefined);
    assert.deepEqual(await pending, { kind: "generated", save: { kind: "saved", confirmedSavedCount: 1 } });
    assert.throws(() => runWithRuntimeTurnAdmission(admission, assertRuntimeTurnAdmission), RuntimeTurnInactiveError);
    assert.equal(f.turns.admit({ actorSessionId: "main", providerId: "codex", turnCapability: afterSaveStarted.capability }).ok, true);
    assert.equal(f.bindings.getActiveBindingCount(), 1);
    f.turns.end(afterSaveStarted);
  } finally { resumeGeneration.resolve(generated); release.resolve(undefined); f.executions.stop(); }
});

// @test-value v2
// kind = "contract"
// claim = "明示noneは正常結果として返し、生成失敗・不正final・callback失敗では後続保存を呼ばず実行枠を解放する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#共通の単発呼出" }
// fault = "空配列や途中応答をnoneへ変換するか、例外でbindingを残し次回を妨げる"
// observable = "runOnceの結果code、generation/parse/save回数、終了後のbinding件数と再受付"
// observation_boundary = "consumer"
// scope = "validated final and early callback exits"
// lifecycle = "permanent"
// impact = "失敗を正常保存と誤認するか、必要な背景処理が枠漏れで停止する"
// distinction = "beginの単体testにはfinalやcallbackがなく、schema単体では例外時の終了処理を観測できない"
// @end-test-value
test("none, invalid output, generation failure, and callback errors have distinct terminal results", async () => {
  for (const scenario of ["none", "empty", "intermediate", "generation", "admitted", "parse"] as const) {
    const f = fixture();
    let generates = 0, parses = 0, saves = 0;
    const calls = new BackgroundCallService({ executions: f.executions, generate: () => {
      generates += 1;
      if (scenario === "generation") throw Object.assign(new Error("failed"), { code: "FIXED_GENERATION_FAILED" });
      return scenario === "none" ? { kind: "none" } : scenario === "empty"
        ? { kind: "items", items: [] } : scenario === "intermediate" ? { ...generated, preface: "not final" } : generated;
    } });
    const base = f.input();
    const result = await calls.runOnce({ ...base,
      onAdmitted: () => { if (scenario === "admitted") throw new Error("callback failed"); },
      final: { schema, parse: (raw) => {
        parses += 1; if (scenario === "parse") throw new Error("parse failed");
        return finalOutput.parse(raw);
      } },
      save: (output) => { saves += 1; assert.deepEqual(output, { kind: "none" }); return { kind: "none" }; },
    });
    assert.deepEqual(result, scenario === "none" ? { kind: "generated", save: { kind: "none" } }
      : scenario === "generation" ? { kind: "failed", code: "FIXED_GENERATION_FAILED" }
        : scenario === "admitted" ? { kind: "failed", code: "BACKGROUND_ADMISSION_CALLBACK_FAILED" }
          : { kind: "invalid_output", code: "BACKGROUND_FINAL_INVALID" });
    assert.equal(generates, scenario === "admitted" ? 0 : 1);
    assert.equal(parses, ["admitted", "generation"].includes(scenario) ? 0 : 1);
    assert.equal(saves, scenario === "none" ? 1 : 0);
    assert.equal(f.bindings.getActiveBindingCount(), 0);
    assert.ok(f.closes.length >= 1);
    const next = f.executions.begin({ ...base.context, providerId: base.selection.providerId });
    assert.equal(next.ok, true);
    f.executions.stop();
  }
});

// @test-value v2
// kind = "contract"
// claim = "用途側が報告した部分保存prefixと停止原因を保ち、保存例外で不明な件数を0へ断定しない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#保存結果と例外" }
// fault = "saveのunknownや部分保存を共通成功/取消へ上書きするか、例外後を0件未保存と返す"
// observable = "save返却値の同一性、confirmedSavedCount null、呼出回数とfixtureの既存保存分"
// observation_boundary = "consumer"
// scope = "trusted save result and unreported callback exception"
// lifecycle = "permanent"
// impact = "保存済みデータを未保存と誤表示し、再送やデータ損失判断を誘発する"
// distinction = "storeの単件transaction testでは複数候補を扱うcallbackの返却保存件数を確認できない"
// @end-test-value
test("partial and unknown save reports survive, while opaque save exceptions keep their count unknown", async () => {
  const reports: BackgroundSaveResult[] = [
    { kind: "saved", confirmedSavedCount: 2 },
    ...(["rejected", "failed", "unknown", "canceled", "revoked"] as const)
      .map((cause) => ({ kind: "stopped" as const, confirmedSavedCount: 1, cause, code: "USE_CASE_STOP" })),
  ];
  for (const report of reports) {
    const f = fixture();
    let saves = 0;
    const calls = new BackgroundCallService({ executions: f.executions, generate: () => generated });
    const result = await calls.runOnce({ ...f.input(), save: () => { saves += 1; return report; } });
    assert.equal(result.kind, "generated");
    if (result.kind === "generated") assert.deepEqual(result.save, report);
    assert.equal(saves, 1);
    assert.equal(f.bindings.getActiveBindingCount(), 0);
    f.executions.stop();
  }
  for (const error of [new Error("lost response"), new RuntimeTurnInactiveError()]) {
    const f = fixture();
    const saved: string[] = [];
    const calls = new BackgroundCallService({ executions: f.executions, generate: () => generated });
    assert.deepEqual(await calls.runOnce({ ...f.input(), save: () => { saved.push("confirmed first"); throw error; } }),
      { kind: "generated", save: { kind: "stopped", confirmedSavedCount: null,
        cause: error instanceof RuntimeTurnInactiveError ? "revoked" : "unknown",
        code: error instanceof RuntimeTurnInactiveError ? "RUNTIME_TURN_INACTIVE" : "BACKGROUND_SAVE_UNKNOWN" } });
    assert.deepEqual(saved, ["confirmed first"]);
    assert.equal(f.bindings.getActiveBindingCount(), 0);
    f.executions.stop();
  }
});

// @test-value v2
// kind = "contract"
// claim = "保存待ちを含めた既存の全体3・用途owner1の見送りではcallbackを実行せず、終了後に再受付できる"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#共通の単発呼出" }
// fault = "runOnceが別の枠管理で保存待ちを解放するか、見送りでも通知・生成・保存を始める"
// observable = "skipped reason、各port回数、実binding数、保存完了後の同owner再実行"
// observation_boundary = "consumer"
// scope = "runOnce capacity delegation including Main/Auxiliary scope"
// lifecycle = "permanent"
// impact = "生成が上限を超えるか、同じ会話用途が二重に保存される"
// distinction = "既存begin testはrunOnceによる早期finishや見送りcallback呼出を検出しない"
// @end-test-value
test("capacity and owner-purpose skips do not invoke ports and retain slots through save", async () => {
  const f = fixture();
  const release = deferred<void>();
  const allSaving = deferred<void>();
  let admitted = 0, generates = 0, saves = 0;
  const calls = new BackgroundCallService({ executions: f.executions, generate: () => { generates += 1; return generated; } });
  const run = (purpose: BackgroundPurpose, id = "main") => calls.runOnce({ ...f.input(purpose, id),
    onAdmitted: () => { admitted += 1; }, save: async () => {
      saves += 1; if (saves === 3) allSaving.resolve(undefined);
      await release.promise; assertRuntimeTurnAdmission(); return { kind: "saved", confirmedSavedCount: 1 };
    } });
  const pending = [run("affect"), run("character-memory"), run("affect", "aux")];
  try {
    await allSaving.promise;
    assert.deepEqual(await run("affect"), { kind: "skipped", reason: "already_active" });
    assert.deepEqual(await run("target-memory", "other"), { kind: "skipped", reason: "capacity" });
    assert.deepEqual([admitted, generates, saves, f.bindings.getActiveBindingCount()], [3, 3, 3, 3]);
    release.resolve(undefined);
    for (const result of await Promise.all(pending)) assert.equal(result.kind, "generated");
    assert.equal(f.bindings.getActiveBindingCount(), 0);
    assert.equal((await run("affect")).kind, "generated");
  } finally { release.resolve(undefined); f.executions.stop(); }
});

// @test-value v2
// kind = "contract"
// claim = "背景取消・失効は未確定writeを拒否し、保存済みの結果や不明な効果を全件未保存に上書きしない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#保存結果と例外" }
// fault = "取消後にsaveを開始する、admissionを伝播しない、または保存確認後のstopで成功やunknownを消す"
// observable = "取消結果、save呼出回数、保存境界のRuntimeTurnInactiveError、保持された保存済み結果とunknown"
// observation_boundary = "consumer"
// scope = "background signal, registry revocation and runtime stop at generation/parse/save boundaries"
// lifecycle = "permanent"
// impact = "失効後のwriteを許すか、確定済みデータを誤って未保存と扱う"
// distinction = "単件storeのadmission testだけではrunOnceが取消をいつ結果へ反映するか確認できない"
// risk_tags = ["authorization"]
// @end-test-value
test("cancellation blocks unconfirmed work without discarding committed or unknown save effects", async () => {
  for (const phase of ["generation", "parse", "save", "committed", "unknown"] as const) {
    const f = fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    let saves = 0;
    const base = f.input();
    const calls = new BackgroundCallService({ executions: f.executions, generate: async () => {
      if (phase === "generation") { entered.resolve(undefined); await release.promise; }
      return generated;
    } });
    const pending = calls.runOnce({ ...base,
      final: { schema, parse: (raw) => {
        if (phase === "parse") f.bindings.revokeBackgroundProvider("claude");
        return finalOutput.parse(raw);
      } }, save: async () => {
        saves += 1; entered.resolve(undefined); await release.promise;
        if (phase === "save") assertRuntimeTurnAdmission();
        return phase === "unknown" ? { kind: "stopped", confirmedSavedCount: 1, cause: "unknown", code: "STORE_UNKNOWN" }
          : { kind: "saved", confirmedSavedCount: 1 };
      } });
    try {
      if (phase !== "parse") {
        await entered.promise;
        if (phase === "generation") f.bindings.revokeSession("main"); else f.executions.stop();
        release.resolve(undefined);
      }
      const result = await pending;
      assert.deepEqual(result, phase === "generation" ? { kind: "canceled", code: "BACKGROUND_CALL_CANCELED" }
        : phase === "parse" ? { kind: "canceled", code: "RUNTIME_TURN_INACTIVE" }
          : phase === "save" ? { kind: "generated", save: { kind: "stopped", confirmedSavedCount: null, cause: "revoked", code: "RUNTIME_TURN_INACTIVE" } }
            : phase === "unknown" ? { kind: "generated", save: { kind: "stopped", confirmedSavedCount: 1, cause: "unknown", code: "STORE_UNKNOWN" } }
              : { kind: "generated", save: { kind: "saved", confirmedSavedCount: 1 } });
      assert.equal(saves, phase === "generation" || phase === "parse" ? 0 : 1);
      assert.equal(f.bindings.getActiveBindingCount(), 0);
    } finally { release.resolve(undefined); f.executions.stop(); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "begin時の不正sourceと停止runtimeを見送り成功へ潰さず、既に取消された要求はportを呼ばない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#共通の単発呼出" }
// fault = "beginの全例外をunavailableへ変換して認可失敗を隠すか、事前取消でも生成する"
// observable = "runOnceのrejectと取消結果、port呼出回数とbinding件数"
// observation_boundary = "consumer"
// scope = "begin failures before acquiring any background execution"
// lifecycle = "permanent"
// impact = "権限不備を通常の容量待ちと誤認するか取消済み要求へ生成を課金する"
// distinction = "既存begin testはrunOnceによる例外の誤変換を検出しない"
// @end-test-value
test("begin authorization and runtime failures remain errors and pre-cancel does not start work", async () => {
  const f = fixture();
  let ports = 0;
  const calls = new BackgroundCallService({ executions: f.executions, generate: () => { ports += 1; return generated; } });
  const base = f.input();
  const input = { ...base, onAdmitted: () => { ports += 1; }, save: () => { ports += 1; return { kind: "none" as const }; } };
  await assert.rejects(calls.runOnce({ ...input, context: { ...base.context, actorSessionId: "wrong" } }), /eligible source/);
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await calls.runOnce({ ...input, context: { ...base.context, signal: controller.signal } }),
    { kind: "canceled", code: "BACKGROUND_CALL_CANCELED" });
  f.executions.stop();
  await assert.rejects(calls.runOnce(input), /runtime is unavailable/);
  assert.equal(ports, 0);
  assert.equal(f.bindings.getActiveBindingCount(), 0);
});
