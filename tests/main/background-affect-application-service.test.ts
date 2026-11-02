import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAffectCompositionOutput, type AffectCandidate, type AffectCompositionOutput } from "../../src-shared/character-affect/affect-composition.js";
import { CHARACTER_CONTEXT_SCHEMA_VERSION, isCharacterContextError } from "../../src-shared/character-context/character-context-contract.js";
import { BackgroundAffectApplicationService } from "../../src-electron/character/background-affect-application-service.js";
import { CharacterAffectIdempotencyConflictError, CharacterAffectVersionConflictError } from "../../src-electron/character/character-affect-storage.js";
import { currentRuntimeTurnAdmissionState } from "../../src-electron/platform/memory/runtime-turn-admission.js";
import { StorageWorkerUnknownOutcomeError } from "../../src-electron/storage/storage-worker-client.js";
import { backgroundAffectFixture, completedAt, secondCompletedAt } from "../helpers/background-affect-fixture.js";

function candidate(overrides: Partial<AffectCandidate> = {}): AffectCandidate {
  return { layer: "session", targetType: "bug", targetId: "bug-910", family: "determination",
    value: { label: "Investigation", valence: 0.4, arousal: 0.2, dimensions: { focus: 0.5 } },
    intensity: 0.6, reason: "Reproduction narrows the cause", evidence: "Saved conversation", sourceTurnId: 1, ...overrides };
}
const output = (...candidates: AffectCandidate[]): AffectCompositionOutput => ({ kind: "events", candidates });

// @test-value v2
// kind = "contract"
// claim = "外部finalは1〜10件のdomain候補かno_changeだけを受理し、不正な型・値・余剰fieldを全体で拒否する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#affect候補とmain内部保存; src-shared/character-affect/affect-contract.ts" }
// fault = "未知出力の型assertionや非strict parseが不正enum・数値・空events・保存identity・episodeを通す"
// observable = "validatorのparse結果と不正finalごとの例外"
// observation_boundary = "component-behavior"
// scope = "background-affect candidate trust boundary"
// lifecycle = "permanent"
// impact = "外部生成値がアプリ所有の保存ownerやMemory書込を指定できる"
// distinction = "既存の型付きAffect invariantは未知JSONの構造や余剰fieldを検証しない"
// @end-test-value
test("strict final validates the complete external shape and domain ranges", () => {
  assert.deepEqual(validateAffectCompositionOutput(JSON.stringify(output(candidate()))), output(candidate()));
  assert.deepEqual(validateAffectCompositionOutput({ kind: "no_change" }), { kind: "no_change" });
  assert.equal(validateAffectCompositionOutput(output(...Array.from({ length: 10 }, () => candidate()))).kind, "events");
  const invalid: unknown[] = ["not JSON", null, [], {}, { kind: "none" }, output(), output(...Array(11).fill(candidate())),
    { kind: "no_change", candidates: [] }, { ...output(candidate()), authority: {} }];
  for (const extra of ["memoryEpisode", "schemaVersion", "characterId", "userId", "sessionId", "idempotencyKey", "occurredAt", "admission"]) {
    invalid.push(output({ ...candidate(), [extra]: "injected" }));
  }
  for (const patch of [{ layer: "invalid" }, { targetType: "invalid" }, { family: "invalid" }, { targetId: " " },
    { reason: "" }, { evidence: " " }, { intensity: -0.1 }, { intensity: 1.1 }, { intensity: NaN },
    { sourceTurnId: 0 }, { sourceTurnId: 1.5 }, { sourceTurnId: Number.MAX_SAFE_INTEGER + 1 },
    { layer: "relationship", targetType: "bug" }, { value: null }, { value: { label: "", valence: 0 } },
    { value: { label: "a", valence: Infinity } }, { value: { label: "a", valence: -1.1 } },
    { value: { label: "a", valence: 0, arousal: 1.1 } }, { value: { label: "a", valence: 0, other: 1 } },
    { value: { label: "a", valence: 0, dimensions: { " ": 0 } } }, { value: { label: "a", valence: 0, dimensions: { x: 2 } } }]) {
    invalid.push({ kind: "events", candidates: [candidate(), { ...candidate(), ...patch }] });
  }
  for (const value of invalid) assert.throws(() => validateAffectCompositionOutput(value));
});

// @test-value v2
// kind = "contract"
// claim = "保存済みMain Turnをアプリidentity・時刻・keyへ変換し、背景admission下の実Worker保存を次の通常contextで利用できる"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#affect候補とmain内部保存" }
// fault = "source・時刻・ownerを誤変換するか、背景保存を公開appraise/version再取得/episodeへ流し、通常contextへ反映しない"
// observable = "保存入力のadmission/options、実Workerから取得したevent、通常getContextのeffective、Memory件数"
// observation_boundary = "consumer"
// scope = "Main background Application to Worker/store/context"
// lifecycle = "permanent"
// impact = "保存成功でも次の会話で利用できないか誤owner・Memoryへ残る"
// distinction = "同期storageや公開appraiseのtestでなく新しいtrusted入口から実Workerと通常contextまで通す"
// @end-test-value
test("Main candidates cross the real Worker and appear in normal context without Memory episodes", async () => {
  const f = await backgroundAffectFixture();
  try {
    const execution = f.start();
    const received: unknown[] = [];
    const app = new BackgroundAffectApplicationService({ ...f.deps, affectService: {
      async recordAppraisal(event, options) {
        assert.equal(currentRuntimeTurnAdmissionState(), execution.admission.state);
        assert.equal(options, undefined);
        received.push(event);
        return f.affect.recordAppraisal(event, options);
      },
    } });
    const result = await app.apply(execution, output(candidate(), candidate({ layer: "relationship", targetType: "user",
      targetId: "local-user", family: "relief", sourceTurnId: 2 })));
    assert.equal(result.kind, "saved");
    if (result.kind !== "saved") return;
    assert.deepEqual(result.saved.map(({ candidateIndex, created, replayed }) => ({ candidateIndex, created, replayed })),
      [{ candidateIndex: 0, created: true, replayed: false }, { candidateIndex: 1, created: true, replayed: false }]);
    const keys = new Set<string>();
    for (const saved of result.saved) {
      const event = await f.worker.affectStorage.getEvent({ eventId: saved.eventId, characterId: "character", userId: "local-user" });
      assert.ok(event);
      assert.equal(event.schemaVersion, "withmate-affect-v1");
      assert.equal(event.sessionId, saved.candidateIndex === 0 ? "main" : null);
      assert.equal(event.sourceSessionId, "main"); assert.equal(event.characterId, "character"); assert.equal(event.userId, "local-user");
      assert.equal(event.occurredAt, saved.candidateIndex === 0 ? completedAt : secondCompletedAt); assert.ok(event.idempotencyKey);
      keys.add(event.idempotencyKey);
    }
    assert.equal(keys.size, 2); assert.equal(received.length, 2); assert.equal(f.eventCount(), 2);
    f.executions.finish(execution);
    const context = await f.context.getContext({ schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION, characterId: "character", sessionId: "main" });
    assert.equal(isCharacterContextError(context), false);
    if (isCharacterContextError(context)) return;
    assert.ok(context.affect.effective.some((item) => item.targetId === "bug-910" && item.family === "determination"));
    assert.ok(context.affect.effective.some((item) => item.targetId === "local-user" && item.family === "relief"));
    assert.equal(f.episodeCalls(), 0); assert.equal(f.memoryCount(), 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "検証済みno_changeは正常終了し、AffectとMemoryのwriteを呼ばない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#affect候補とmain内部保存" }
// fault = "no_changeからeventを捏造して保存する"
// observable = "用途結果、recordAppraisal呼出件数とDBのAffect/Memory件数"
// observation_boundary = "consumer"
// scope = "background-affect preflight"
// lifecycle = "permanent"
// impact = "変化なしから不要な永続変更が起きる"
// distinction = "validator単体ではApplicationが変化なしから永続変更しないことを保証できない"
// @end-test-value
test("validated no_change never dispatches writes", async () => {
  const f = await backgroundAffectFixture();
  try {
    let writes = 0;
    const app = new BackgroundAffectApplicationService({ ...f.deps, affectService: {
      async recordAppraisal(...args) { writes++; return f.affect.recordAppraisal(...args); },
    } });
    const execution = f.start();
    assert.deepEqual(await app.apply(execution, { kind: "no_change" }), { kind: "no_change" });
    assert.equal(writes, 0); assert.equal(f.eventCount(), 0); assert.equal(f.memoryCount(), 0); assert.equal(f.episodeCalls(), 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "実Main/Character/ownerIdentityと許可read・processing範囲の保存済み終端Turnだけを受け入れ、AuxiliaryをMainへ付け替えない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#affect候補とmain内部保存" }
// fault = "候補のTurn所属、取得owner identity、Characterまたは未対応sourceの検証を省く"
// observable = "各不正sourceのstopped codeと実DBのevent件数"
// observation_boundary = "consumer"
// scope = "Main background-affect authorization"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// impact = "別ownerや許可されていない会話が感情の保存根拠になる"
// distinction = "既存storeのMain FK確認は入力材料のTurn範囲やAuxiliaryの付替えを防がない"
// @end-test-value
test("source ownership, Character, Turn scope and unsupported Auxiliary are checked before saving", async () => {
  const f = await backgroundAffectFixture();
  try {
    const execution = f.start();
    const app = new BackgroundAffectApplicationService(f.deps);
    for (const sourceTurnId of [3, 4, 5, 99]) {
      const result = await app.apply(execution, output(candidate(), candidate({ sourceTurnId })));
      assert.equal(result.kind, "stopped");
      if (result.kind !== "stopped") continue;
      assert.equal(result.failure.code, "invalid_output"); assert.equal(result.failure.candidateIndex, 1);
      assert.deepEqual(result.unattemptedCandidateIndexes, [0, 1]);
    }
    const source = await f.deps.readMainSource(f.scope().history);
    assert.ok(source);
    for (const changed of [{ ...source, ownerIdentity: "other-owner" },
      { ...source, session: { ...source.session, id: "other" } },
      { ...source, session: { ...source.session, characterId: "other-character" } },
      { ...source, session: { ...source.session, accessMode: "legacy_readonly" as const } }]) {
      const result = await new BackgroundAffectApplicationService({ ...f.deps, readMainSource: async () => changed }).apply(execution, output(candidate()));
      assert.equal(result.kind, "stopped");
      if (result.kind === "stopped") assert.equal(result.failure.code, "authority_denied");
    }
    f.executions.finish(execution);
    const restricted = f.scope();
    for (const [processing, sourceTurnId] of [[{ afterTurnId: 1, throughTurnId: 2 }, 1],
      [{ afterTurnId: null, throughTurnId: 1 }, 2]] as const) {
      const ranged = f.start({ ...restricted, processing });
      assert.equal((await app.apply(ranged, output(candidate({ sourceTurnId })))).kind, "stopped");
      f.executions.finish(ranged);
    }
    const wrongPurpose = f.start({ ...restricted, purpose: "character-memory" });
    const denied = await app.apply(wrongPurpose, output(candidate()));
    assert.equal(denied.kind, "stopped");
    if (denied.kind === "stopped") assert.equal(denied.failure.code, "authority_denied");
    f.executions.finish(wrongPurpose);
    const auxiliary = f.start(f.scope("auxiliary"));
    const result = await app.apply(auxiliary, output(candidate()));
    assert.equal(result.kind, "stopped");
    if (result.kind === "stopped") assert.equal(result.failure.code, "unsupported_source");
    assert.equal(f.eventCount(), 0); assert.equal(f.memoryCount(), 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "最初の既知拒否または送信後unknownで停止し、確認済みprefix・不明candidate・未呼出分を分ける"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#affect候補とmain内部保存" }
// fault = "例外を握り潰して後続を保存するか、送信後不明を未保存扱いし再照合・自動再送する"
// observable = "用途結果のprefix/failure/未呼出index、実DB件数、保存とsource readの呼出回数"
// observation_boundary = "consumer"
// scope = "Main background-affect partial effects"
// lifecycle = "permanent"
// impact = "確認していない保存効果を成功・未保存と誤報告して重複変更や取り消しを誘発する"
// distinction = "既存Workerの単発error testでは候補列の停止と確定prefixを確認できない"
// @end-test-value
test("known failures and unknown acknowledgments preserve confirmed prefix and never continue", async () => {
  const f = await backgroundAffectFixture();
  try {
    for (const mode of ["version", "idempotency", "unknown", "canceled-unknown"] as const) {
      const before = f.eventCount();
      const execution = f.start();
      let writes = 0; let reads = 0;
      const app = new BackgroundAffectApplicationService({ ...f.deps,
        async readMainSource(scope) { reads++; return f.deps.readMainSource(scope); },
        affectService: { async recordAppraisal(event) {
          writes++;
          if (writes !== 2) return f.affect.recordAppraisal(event);
          if (mode === "version") throw new CharacterAffectVersionConflictError("stale", "current");
          if (mode === "idempotency") throw new CharacterAffectIdempotencyConflictError();
          await f.affect.recordAppraisal(event);
          if (mode === "canceled-unknown") f.executions.finish(execution);
          if (mode === "unknown") throw new StorageWorkerUnknownOutcomeError("Write response lost");
          throw new Error("Write response lost");
        } },
      });
      const result = await app.apply(execution, output(candidate(), candidate({ sourceTurnId: 2 }), candidate()));
      assert.equal(result.kind, "stopped");
      if (result.kind !== "stopped") continue;
      assert.equal(result.saved.length, 1); assert.equal(result.saved[0].candidateIndex, 0);
      assert.ok(result.saved[0].eventId); assert.equal(result.saved[0].created, true);
      assert.deepEqual(result.failure, { candidateIndex: 1,
        code: mode === "version" ? "version_conflict" : mode === "idempotency" ? "idempotency_conflict" : "save_failed",
        effect: mode === "version" || mode === "idempotency" ? "none" : "unknown" });
      assert.deepEqual(result.unattemptedCandidateIndexes, [2]); assert.equal(writes, 2); assert.equal(reads, 1);
      assert.equal(f.eventCount() - before, mode === "version" || mode === "idempotency" ? 1 : 2);
      f.executions.finish(execution);
    }
    assert.equal(f.memoryCount(), 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "Worker未送信が確定した失敗は保存前でも確定prefix後でもeffect noneとし、先行結果と後続未呼出を保持する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#affect候補とmain内部保存; src-electron/storage/storage-worker-client.ts" }
// fault = "recordAppraisalの呼出開始をWorker送信済みと同一視し、close済みWorkerの既知未送信をunknownへ分類する"
// observable = "実Memory Worker close後の用途結果・保存呼出件数・DBのevent件数"
// observation_boundary = "consumer"
// scope = "background-affect known-unsent Worker failure"
// lifecycle = "permanent"
// impact = "呼出元が既知の未保存と結果不明を区別できない"
// distinction = "既存のtyped error注入と異なり、実Worker clientの未送信拒否から用途結果までを通す"
// @end-test-value
test("closed Worker failures are known-unsaved before and after an acknowledged prefix", async () => {
  const f = await backgroundAffectFixture();
  try {
    let writes = 0;
    const app = new BackgroundAffectApplicationService({ ...f.deps, affectService: {
      async recordAppraisal(event) {
        writes++;
        const result = await f.affect.recordAppraisal(event);
        await f.worker.close();
        return result;
      },
    } });
    const execution = f.start();
    const partial = await app.apply(execution, output(candidate(), candidate(), candidate()));
    assert.equal(partial.kind, "stopped");
    if (partial.kind !== "stopped") return;
    assert.equal(partial.saved.length, 1); assert.equal(partial.saved[0].candidateIndex, 0);
    assert.ok(partial.saved[0].eventId); assert.equal(partial.saved[0].created, true);
    assert.deepEqual(partial.failure, { code: "save_failed", effect: "none", candidateIndex: 1 });
    assert.deepEqual(partial.unattemptedCandidateIndexes, [2]); assert.equal(writes, 2); assert.equal(f.eventCount(), 1);
    f.executions.finish(execution);

    const next = f.start();
    const rejected = await app.apply(next, output(candidate(), candidate()));
    assert.deepEqual(rejected, { kind: "stopped", saved: [],
      failure: { code: "save_failed", effect: "none", candidateIndex: 0 }, unattemptedCandidateIndexes: [1] });
    assert.equal(writes, 3); assert.equal(f.eventCount(), 1); assert.equal(f.memoryCount(), 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "失効済みadmissionは保存前に拒否し、prefix確定後の取消は確定分を保持して後続保存を止める"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#接続と論理実行の寿命" }
// fault = "取消後にも保存するか、確定済みprefixを失敗扱いで消す"
// observable = "取消結果・確認済みprefixと実DB件数"
// observation_boundary = "consumer"
// scope = "background-affect logical admission lifetime"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// impact = "失効権限で保存されるか、確定済み結果が未保存と誤報告される"
// distinction = "共通lifetime単体でなくAffect用途の候補間境界まで確認する"
// @end-test-value
test("revoked admission stops saving while keeping already acknowledged events", async () => {
  const f = await backgroundAffectFixture();
  try {
    const stale = f.start(); f.executions.finish(stale);
    const rejected = await new BackgroundAffectApplicationService(f.deps).apply(stale, output(candidate()));
    assert.equal(rejected.kind, "stopped");
    if (rejected.kind === "stopped") assert.equal(rejected.failure.code, "canceled");
    assert.equal(f.eventCount(), 0);
    const execution = f.start();
    let writes = 0;
    const app = new BackgroundAffectApplicationService({ ...f.deps, affectService: {
      async recordAppraisal(event) {
        writes++; const result = await f.affect.recordAppraisal(event); f.executions.finish(execution); return result;
      },
    } });
    const result = await app.apply(execution, output(candidate(), candidate(), candidate()));
    assert.equal(result.kind, "stopped");
    if (result.kind !== "stopped") return;
    assert.equal(result.saved.length, 1);
    assert.deepEqual(result.failure, { code: "canceled", candidateIndex: 1, effect: "none" });
    assert.deepEqual(result.unattemptedCandidateIndexes, [2]); assert.equal(writes, 1); assert.equal(f.eventCount(), 1);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "Main側の検査後に失効したSharedArrayBufferを実Memory Workerへ伝え、Worker保存境界で未保存拒否する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#affect候補とmain内部保存" }
// fault = "Applicationがadmissionを適用せず、Worker clientが失効stateを受け取れない"
// observable = "実Worker queued/started後のcanceled/none結果とDB件数"
// observation_boundary = "consumer"
// scope = "background-affect Worker admission propagation"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// impact = "取消がMainの事前検査より遅い場合に保存境界へ届かない"
// distinction = "既に失効したadmissionの早期拒否とは別にWorkerへ実送信する境界を確認する"
// @end-test-value
test("the real Worker rejects admission revoked after the client check", async () => {
  let revoke: (() => void) | undefined; let started = false;
  const f = await backgroundAffectFixture((event) => {
    if (event.operation !== "affect.recordEvent") return;
    if (event.stage === "queued") revoke?.();
    if (event.stage === "started") started = true;
  });
  try {
    const execution = f.start();
    revoke = () => { Atomics.store(new Int32Array(execution.admission.state), 0, 1); };
    const result = await new BackgroundAffectApplicationService(f.deps).apply(execution, output(candidate()));
    assert.equal(started, true); assert.equal(result.kind, "stopped");
    if (result.kind === "stopped") assert.deepEqual(result.failure, { code: "canceled", candidateIndex: 0, effect: "none" });
    assert.equal(f.eventCount(), 0); assert.equal(f.memoryCount(), 0);
  } finally { await f.close(); }
});
