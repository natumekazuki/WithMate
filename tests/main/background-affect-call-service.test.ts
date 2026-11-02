import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  AFFECT_COMPOSITION_INSTRUCTIONS, affectCompositionOutputSchema, type AffectCandidate,
} from "../../src-shared/character-affect/affect-composition.js";
import { CHARACTER_CONTEXT_SCHEMA_VERSION, isCharacterContextError } from "../../src-shared/character-context/character-context-contract.js";
import { BackgroundAffectApplicationService } from "../../src-electron/character/background-affect-application-service.js";
import { BackgroundAffectCallService } from "../../src-electron/character/background-affect-call-service.js";
import { BackgroundCallService, type BackgroundGenerationPort } from "../../src-electron/providers/background-call-service.js";
import type { BackgroundExecution } from "../../src-electron/providers/background-execution-service.js";
import { CharacterAffectVersionConflictError, CharacterAffectIdempotencyConflictError } from "../../src-electron/character/character-affect-storage.js";
import { StorageWorkerUnknownOutcomeError } from "../../src-electron/storage/storage-worker-client.js";
import { assertRuntimeTurnAdmission, runWithRuntimeTurnAdmission, RuntimeTurnInactiveError } from "../../src-electron/platform/memory/runtime-turn-admission.js";
import { backgroundAffectFixture } from "../helpers/background-affect-fixture.js";

function candidate(sourceTurnId = 1): AffectCandidate {
  return { layer: "session", targetType: "bug", targetId: "bug-910", family: "determination",
    value: { label: "Investigation", valence: 0.4 }, intensity: 0.6, reason: "Cause narrowed",
    evidence: "Saved conversation", sourceTurnId };
}
const final = { kind: "events", candidates: [candidate(), candidate(2), candidate()] };

function connection(f: Awaited<ReturnType<typeof backgroundAffectFixture>>, generate: BackgroundGenerationPort) {
  const application = new BackgroundAffectApplicationService(f.deps);
  let saves = 0;
  let execution: BackgroundExecution | undefined;
  const service = new BackgroundAffectCallService({
    calls: new BackgroundCallService({ executions: f.executions, generate }),
    application: { apply: (current, output) => {
      saves++; execution = current;
      return application.apply(current, output);
    } },
  });
  const input = { context: { actorSessionId: f.session.id, session: f.session, scope: f.scope(),
    authoritySnapshot: { characterId: f.session.characterId, userId: "local-user" }, operationGrants: [] },
  selection: { providerId: "claude", modelId: "fixed-model" }, userInput: "Saved permitted material", onAdmitted() {} };
  return { service, input, saves: () => saves, execution: () => execution };
}

// @test-value v2
// kind = "contract"
// claim = "Affect用途は共通runOnceの実行で固定finalを検証しnative完了後に実Worker保存し、finish失効後の通常contextへ反映する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#affect候補とmain内部保存" }
// fault = "用途のschema/指示や実binding/handleが接続されず、native完了で保存権限を失うか保存結果が通常contextに現れない"
// observable = "generation入力、saveのbinding/handle、native close時のadmission、共通保存件数、通常contextとMemory件数"
// observation_boundary = "consumer"
// scope = "fixed generation to common runOnce to Affect Worker/store/context"
// lifecycle = "permanent"
// impact = "単独serviceが成功しても実際の用途呼出で感情が保存・利用されない"
// distinction = "単独Affect保存と汎用callbackのtestを別々に通しても用途同士の受渡し不整合を検出できない"
// @end-test-value
test("Affect runOnce saves with its generated execution after native completion and feeds normal context", async () => {
  const f = await backgroundAffectFixture();
  try {
    let generations = 0;
    const c = connection(f, (input) => {
      generations++;
      assert.deepEqual(input.finalSchema, z.toJSONSchema(affectCompositionOutputSchema, { io: "input" }));
      assert.equal(input.userInput, `${AFFECT_COMPOSITION_INSTRUCTIONS}\n\n${c.input.userInput}`);
      const record = f.affect.recordAppraisal.bind(f.affect);
      f.affect.recordAppraisal = (event, options) => {
        const execution = c.execution()!;
        assert.equal(execution.binding, input.binding); assert.equal(execution.handle, input.handle);
        assert.equal(execution.signal, input.signal); assert.equal(f.closes.length, 1);
        assert.equal(f.closes[0], input.binding.bindingId); assert.equal(f.bindings.getActiveBindingCount(), 1);
        assertRuntimeTurnAdmission();
        return record(event, options);
      };
      return JSON.stringify({ kind: "events", candidates: [candidate(2)] });
    });
    assert.deepEqual(await c.service.runOnce(c.input), { kind: "generated", save: { kind: "saved", confirmedSavedCount: 1 } });
    assert.equal(generations, 1); assert.equal(c.saves(), 1); assert.equal(f.eventCount(), 1);
    assert.equal(f.bindings.getActiveBindingCount(), 0);
    assert.throws(() => runWithRuntimeTurnAdmission(c.execution()!.admission, assertRuntimeTurnAdmission), RuntimeTurnInactiveError);
    const context = await f.context.getContext({ schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
      characterId: f.session.characterId, sessionId: f.session.id });
    assert.equal(isCharacterContextError(context), false);
    if (!isCharacterContextError(context)) assert.ok(context.affect.effective.some((item) => item.targetId === "bug-910"));
    assert.equal(f.memoryCount(), 0); assert.equal(f.episodeCalls(), 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "Affect no_changeはnoneを返し、生成失敗・不正final・開始見送りから保存へ進まない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#共通の単発呼出; docs/design/background-execution.md#affect候補とmain内部保存" }
// fault = "Affectのfinal parserを省くか変化なし・見送りを候補として保存する"
// observable = "共通結果codeとgeneration/save回数、実DBのAffect/Memory件数"
// observation_boundary = "consumer"
// scope = "Affect composition early exits and no_change"
// lifecycle = "permanent"
// impact = "不正な生成出力が保存されるか見送りでも不要な処理が走る"
// distinction = "汎用runOnceの任意schemaではAffect固有のstrict parserの配線を検証できない"
// @end-test-value
test("Affect no_change, invalid final, generation failure and admission skips do not write", async () => {
  for (const mode of ["no_change", "invalid", "generation", "already_active", "capacity"] as const) {
    const f = await backgroundAffectFixture();
    try {
      let generations = 0;
      const c = connection(f, () => {
        generations++;
        if (mode === "generation") throw new Error("Fixed generation failed");
        return mode === "no_change" ? { kind: "no_change" }
          : { kind: "events", candidates: [candidate(), { ...candidate(), memoryEpisode: {} }] };
      });
      if (mode === "already_active") f.start();
      if (mode === "capacity") {
        f.start({ ...f.scope(), purpose: "character-memory" }); f.start({ ...f.scope(), purpose: "target-memory" });
        const scope = f.scope();
        f.start({ ...scope, history: { ...scope.history, source: { kind: "main", sessionId: "other", incarnationId: "inc-other",
          ownerIdentity: JSON.stringify(["main", "other", "inc-other"]) } } });
      }
      const result = await c.service.runOnce(c.input);
      assert.deepEqual(result, mode === "no_change" ? { kind: "generated", save: { kind: "none" } }
        : mode === "invalid" ? { kind: "invalid_output", code: "BACKGROUND_FINAL_INVALID" }
          : mode === "generation" ? { kind: "failed", code: "BACKGROUND_GENERATION_FAILED" }
            : { kind: "skipped", reason: mode });
      assert.equal(generations, mode === "already_active" || mode === "capacity" ? 0 : 1);
      assert.equal(c.saves(), mode === "no_change" ? 1 : 0);
      assert.equal(f.eventCount(), 0); assert.equal(f.memoryCount(), 0);
    } finally { await f.close(); }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Affect callbackは実sourceのowner・Turn範囲・read中のadmission失効を検査し、共通結果にも拒否や失効原因を保つ"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#affect候補とmain内部保存" }
// fault = "callback接続のためにsource/owner検証を迂回するか、失効を一般保存成功へ変換する"
// observable = "共通stoppedのcause/code/確認済み0件と実DB件数"
// observation_boundary = "consumer"
// scope = "Affect runOnce source authorization and admission"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// impact = "許可外の会話を根拠に保存するか失効後の権限を使用する"
// distinction = "Affect単独保存の検査が実際のcallback接続でも使われることを確認する"
// @end-test-value
test("Affect runOnce retains source ownership, range and revoked admission rejection", async () => {
  for (const mode of ["owner", "range", "revoked", "unavailable"] as const) {
    const f = await backgroundAffectFixture();
    try {
      const read = f.deps.readMainSource;
      f.deps.readMainSource = async (scope) => {
        if (mode === "unavailable") return null;
        const source = await read(scope);
        assert.ok(source);
        if (mode === "revoked") f.executions.stop();
        return mode === "owner" ? { ...source, ownerIdentity: "other-owner" } : source;
      };
      const c = connection(f, () => ({ kind: "events", candidates: [candidate(mode === "range" ? 5 : 1)] }));
      assert.deepEqual(await c.service.runOnce(c.input), { kind: "generated", save: { kind: "stopped", confirmedSavedCount: 0,
        cause: mode === "revoked" ? "revoked" : mode === "unavailable" ? "failed" : "rejected",
        code: mode === "owner" ? "authority_denied" : mode === "range" ? "invalid_output"
          : mode === "unavailable" ? "source_unavailable" : "canceled" } });
      assert.equal(c.saves(), 1); assert.equal(f.eventCount(), 0); assert.equal(f.memoryCount(), 0);
      assert.equal(f.bindings.getActiveBindingCount(), 0);
    } finally { await f.close(); }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Affectの途中拒否・未送信・取消・unknownは共通stoppedにprefix件数とcode/効果を保持し、後続を保存しない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#保存結果と例外; docs/design/background-execution.md#affect候補とmain内部保存" }
// fault = "用途の途中停止を一般例外へ落としてprefixを失うかunknownをnoneへ誤分類する"
// observable = "共通結果の確認済み件数/cause/code、実保存件数と保存callback回数"
// observation_boundary = "consumer"
// scope = "Affect application result to common save result"
// lifecycle = "permanent"
// impact = "呼出元が確定済み保存を未保存と扱うか結果不明を成功/未保存に断定する"
// distinction = "汎用save reportのtestでは実Affectエラーから共通結果への写像を検証できない"
// @end-test-value
test("Affect partial effects map to common counts and causes without losing confirmed prefix", async () => {
  for (const mode of ["version", "idempotency", "unsent", "revoked", "unknown", "canceled-unknown"] as const) {
    const f = await backgroundAffectFixture();
    try {
      let writes = 0;
      const record = f.affect.recordAppraisal.bind(f.affect);
      f.affect.recordAppraisal = async (event) => {
        writes++;
        if (writes !== 2) return record(event);
        if (mode === "version") throw new CharacterAffectVersionConflictError("stale", "current");
        if (mode === "idempotency") throw new CharacterAffectIdempotencyConflictError();
        if (mode === "unsent") { await f.worker.close(); return record(event); }
        if (mode === "revoked") { f.executions.stop(); return record(event); }
        await record(event);
        if (mode === "canceled-unknown") f.executions.stop();
        throw new StorageWorkerUnknownOutcomeError("Write response lost");
      };
      const c = connection(f, () => final);
      assert.deepEqual(await c.service.runOnce(c.input), { kind: "generated", save: { kind: "stopped", confirmedSavedCount: 1,
        cause: mode === "version" || mode === "idempotency" ? "rejected" : mode === "unsent" ? "failed"
          : mode === "revoked" ? "revoked" : "unknown",
        code: mode === "version" ? "version_conflict" : mode === "idempotency" ? "idempotency_conflict"
          : mode === "revoked" ? "canceled" : "save_failed" } });
      assert.equal(writes, 2); assert.equal(c.saves(), 1);
      assert.equal(f.eventCount(), mode === "unknown" || mode === "canceled-unknown" ? 2 : 1);
      assert.equal(f.memoryCount(), 0); assert.equal(f.bindings.getActiveBindingCount(), 0);
    } finally { await f.close(); }
  }
});
