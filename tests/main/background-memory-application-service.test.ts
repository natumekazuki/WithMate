import assert from "node:assert/strict";
import { test } from "node:test";
import { CHARACTER_CONTEXT_SCHEMA_VERSION, createCharacterContextError } from "../../src-shared/character-context/character-context-contract.js";
import { MEMORY_V6_SCHEMA_VERSION } from "../../src-shared/memory/memory-contract.js";
import { createMemoryErrorResponse } from "../../src-shared/memory/memory-response-contract.js";
import { BackgroundMemoryApplicationService, toBackgroundMemorySaveResult } from "../../src-electron/memory/background-memory-application-service.js";
import { createLocalUserMemoryPrincipal } from "../../src-electron/memory/memory-v6-permission.js";
import { currentRuntimeTurnAdmissionState } from "../../src-electron/platform/memory/runtime-turn-admission.js";
import { StorageWorkerGenerationError, StorageWorkerRemoteError, StorageWorkerUnknownOutcomeError } from "../../src-electron/storage/storage-worker-client.js";
import { backgroundMemoryFixture, characterTarget, generalTarget, memoryFinal, type MemoryPurpose } from "../helpers/background-memory-fixture.js";

const purposes: MemoryPurpose[] = ["character-memory", "target-memory"];

// @test-value v2
// kind = "contract"
// claim = "実Mainの二用途候補は同一背景admissionの実Workerへ保存し、正しいsourceと正規化tagで通常readから取得できる"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memory候補のmain内部保存" }
// fault = "別principalやadmissionで保存するか、内部tagの余剰fieldで失敗し、成功応答だけ返して通常readに残らない"
// observable = "principal、admission、確認済みID、通常get_entry/searchとCharacter searchの保存内容、Affect件数"
// observation_boundary = "consumer"
// scope = "Main memory save to real Worker and normal retrieval"
// lifecycle = "permanent"
// distinction = "純粋候補validatorや同期storage testでは新しい背景入口と実Workerの接続を通らない"
// @end-test-value
test("both Main purposes save through the real Worker and normal reads", async () => {
  for (const purpose of purposes) {
    const f = await backgroundMemoryFixture();
    try {
      const scope = f.memoryScope(purpose);
      const execution = f.start(scope);
      f.executions.nativeCompleted(execution);
      let calls = 0;
      const checkPrincipal = (principal: Parameters<typeof f.memory.append>[0]) => {
        calls++;
        assert.equal(currentRuntimeTurnAdmissionState(), execution.admission.state);
        assert.ok(principal?.type === "session_binding");
        assert.equal(principal.sessionId, "main");
        assert.equal(principal.characterId, "character");
        assert.deepEqual(principal.permissions, ["memory.append"]);
        const resolved = f.bindings.resolveIdentity(execution.binding.bindingReference);
        assert.ok(resolved.ok);
        assert.equal(principal.bindingIdHash, resolved.binding.bindingIdHash);
      };
      const app = new BackgroundMemoryApplicationService({ ...f.deps,
        memoryService: { append(principal, request) { checkPrincipal(principal); return f.memory.append(principal, request); } },
        characterService: { appendEpisode(request, transport, principal) {
          checkPrincipal(principal!); return f.character.appendEpisode(request, transport, principal);
        } },
      });
      const result = await app.apply(execution, memoryFinal(purpose, 2), f.memoryContext(scope));
      assert.equal(result.kind, "saved");
      if (result.kind !== "saved") throw new Error("save missing");
      assert.equal(calls, 2);
      assert.deepEqual(result.saved.map(({ candidateIndex, created }) => ({ candidateIndex, created })),
        [{ candidateIndex: 0, created: true }, { candidateIndex: 1, created: true }]);
      assert.deepEqual(toBackgroundMemorySaveResult(result), { kind: "saved", confirmedSavedCount: 2 });
      const target = purpose === "character-memory" ? characterTarget : generalTarget;
      for (const saved of result.saved) {
        const entry = await f.memory.getEntry(createLocalUserMemoryPrincipal(), {
          schemaVersion: MEMORY_V6_SCHEMA_VERSION, target, entryId: saved.entryId,
        });
        assert.ok(!("error" in entry));
        assert.equal(entry.entry.body, `Saved content ${saved.candidateIndex}`);
        assert.equal(entry.entry.source.sessionId, "main");
        assert.equal(entry.entry.source.providerId, "codex");
        assert.equal(entry.entry.owner.type, purpose === "character-memory" ? "character" : "user");
        assert.equal(entry.entry.tags.filter((tag) => tag.type.toLowerCase() === "topic").length, purpose === "target-memory" ? 1 : 0);
      }
      const search = await f.memory.search(createLocalUserMemoryPrincipal(), { schemaVersion: MEMORY_V6_SCHEMA_VERSION, targets: [target], query: "Memory" });
      assert.ok(!("error" in search)); assert.equal(search.items.length, 2);
      if (purpose === "character-memory") {
        const search = await f.character.searchMemory({ schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
          characterId: "character", scope: { scope: "character" }, query: "Memory" });
        assert.ok(!("error" in search)); assert.equal(search.items.length, 2);
      }
      assert.equal(f.eventCount(), 0);
      assert.equal(f.episodeCalls(), 0);
      f.executions.finish(execution);
    } finally { await f.close(); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "二用途の明示no_candidatesは認可後にwriteせず共通noneへ対応する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memory候補のmain内部保存" }
// fault = "正常0件にダミーentryを書き込むか、共通結果を保存済み/失敗へ変える"
// observable = "no_candidates、none、append呼出と実Memory件数0"
// observation_boundary = "consumer"
// scope = "Main memory no candidates"
// lifecycle = "permanent"
// distinction = "純粋parserの0件受理だけでは保存callbackと共通結果の無write契約を確認できない"
// @end-test-value
test("no_candidates performs no writes for either purpose", async () => {
  const f = await backgroundMemoryFixture();
  try {
    let writes = 0;
    const append = f.worker.storage.appendEntry;
    f.worker.storage.appendEntry = (...args) => { writes++; return append(...args); };
    for (const purpose of purposes) {
      const scope = f.memoryScope(purpose), execution = f.start(scope);
      const result = await f.app.apply(execution, { outcome: "no_candidates" }, f.memoryContext(scope));
      assert.deepEqual(result, { kind: "no_candidates" });
      assert.deepEqual(toBackgroundMemorySaveResult(result), { kind: "none" });
      f.executions.finish(execution);
    }
    assert.equal(writes, 0); assert.equal(f.memoryCount(), 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "不正な後続候補も含め全finalを検証してから最初のwriteを行う"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memory候補のmain内部保存" }
// fault = "候補ごとの逐次parseで先頭だけ保存してから不正候補や許可外slotに気づく"
// observable = "invalid_output、保存prefix空、実Memory件数0"
// observation_boundary = "consumer"
// scope = "Main memory whole-final validation before writes"
// lifecycle = "permanent"
// distinction = "純粋validatorの拒否だけではwrite開始との順序を保証できない"
// @end-test-value
test("invalid later candidates never allow an earlier write", async () => {
  const f = await backgroundMemoryFixture();
  try {
    for (const purpose of purposes) {
      const scope = f.memoryScope(purpose), execution = f.start(scope);
      const final = purpose === "character-memory"
        ? { outcome: "candidates", episodes: [{ episode: { title: "valid", body: "valid", preview: "valid", observedFact: "fact" },
          grounding: [{ basis: "shared_exchange", refs: [{ kind: "message", seq: 1 }] }] }, { owner: "injected" }] }
        : { outcome: "candidates", entries: [
          { targetSlot: "general", kind: "note", title: "valid", body: "valid", preview: "valid", grounding: [{ basis: "shared_exchange", refs: [{ kind: "message", seq: 1 }] }] },
          { targetSlot: "not-granted", kind: "note", title: "invalid", body: "invalid", preview: "invalid", grounding: [{ basis: "shared_exchange", refs: [{ kind: "message", seq: 1 }] }] },
        ] };
      const result = await f.app.apply(execution, final, f.memoryContext(scope));
      assert.equal(result.kind, "stopped");
      if (result.kind !== "stopped") throw new Error("stop missing");
      assert.equal(result.failure.code, "MEMORY_BACKGROUND_INVALID_OUTPUT");
      assert.equal(result.failure.effect, "none"); assert.deepEqual(result.saved, []);
      assert.equal(f.memoryCount(), 0);
      f.executions.finish(execution);
    }
  } finally { await f.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "contextは実bindingのsource/history/processing/許可targetを拡張できず、別handleや失効admissionでも保存しない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memory候補のmain内部保存" }
// fault = "呼出側contextや別executionのhandleを権限と誤認して別owner/targetへ書き込む"
// observable = "各不整合のstopped/effect noneと実Memory件数0"
// observation_boundary = "consumer"
// scope = "Main memory captured execution authority"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// distinction = "共有層validatorは実binding/handle/admissionとscopeの対応を知らない"
// @end-test-value
test("context cannot widen the binding and execution handles cannot be substituted", async () => {
  const f = await backgroundMemoryFixture();
  try {
    const scope = f.memoryScope("target-memory"), execution = f.start(scope), context = f.memoryContext(scope);
    for (const changed of [
      { ...context, history: { ...context.history, throughMessageSeq: 5 } },
      { ...context, history: { ...context.history, source: { ...context.history.source, ownerIdentity: "other" } } },
      { ...context, processing: { ...context.processing, throughTurnId: 100 } },
      { ...context, allowedTargets: new Map([["general", characterTarget]]) },
      { ...context, allowedTargets: new Map([["general", { owner: "project", scope: "project", project: { type: "id", id: "not-granted" } } as const]]) },
    ]) {
      const result = await f.app.apply(execution, memoryFinal("target-memory"), changed);
      assert.ok(result.kind === "stopped" && result.failure.effect === "none");
    }
    const other = f.start(f.memoryScope("character-memory"));
    const swapped = await f.app.apply({ ...execution, handle: other.handle }, memoryFinal("target-memory"), context);
    assert.ok(swapped.kind === "stopped" && swapped.failure.code === "MEMORY_BACKGROUND_AUTHORITY_DENIED");
    f.executions.cancel(execution.binding.bindingId);
    const revoked = await f.app.apply(execution, memoryFinal("target-memory"), context);
    assert.ok(revoked.kind === "stopped" && revoked.failure.effect === "none");
    assert.equal(f.memoryCount(), 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "保存前の実Main照合でsource不存在・別owner/Character・read-only・authoringと未対応Auxiliaryを拒否する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memory候補のmain内部保存" }
// fault = "source読取結果を照合せず偽装Mainや対象外Sessionを保存sourceに使う"
// observable = "各source不整合のstopped/effect none、保存prefix空と実Memory件数0"
// observation_boundary = "consumer"
// scope = "Main memory real source eligibility"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// distinction = "begin時にeligibleでもsource portの結果を用いる保存入口での照合が必要"
// @end-test-value
test("ineligible and unsupported saved sources are rejected without writes", async () => {
  const f = await backgroundMemoryFixture();
  try {
    for (const purpose of purposes) {
      const scope = f.memoryScope(purpose), execution = f.start(scope), context = f.memoryContext(scope);
      const source = await f.deps.readMainSource(scope.history); assert.ok(source);
      for (const changed of [null, { ...source, ownerIdentity: "other" },
        { ...source, session: { ...source.session, characterId: "other" } },
        { ...source, session: { ...source.session, accessMode: "legacy_readonly" as const } },
        { ...source, session: { ...source.session, sessionKind: "character-authoring" as const } }]) {
        const app = new BackgroundMemoryApplicationService({ ...f.deps, async readMainSource() { return changed; } });
        const result = await app.apply(execution, memoryFinal(purpose), context);
        assert.ok(result.kind === "stopped" && result.failure.effect === "none");
        assert.deepEqual(result.saved, []);
      }
      f.executions.finish(execution);
      const auxiliaryScope = f.memoryScope(purpose, "auxiliary"), auxiliary = f.start(auxiliaryScope);
      const result = await f.app.apply(auxiliary, memoryFinal(purpose), f.memoryContext(auxiliaryScope));
      assert.ok(result.kind === "stopped" && result.failure.code === "MEMORY_BACKGROUND_UNSUPPORTED_SOURCE");
      f.executions.finish(auxiliary);
    }
    assert.equal(f.memoryCount(), 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "service ErrorResponseでは確認済みprefixだけを残し最初の拒否で残りを呼ばない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memory候補のmain内部保存" }
// fault = "ErrorResponseを成功とみなすか後続保存を続け、部分保存を全件成功/0件へ変える"
// observable = "保存prefix、停止index、未呼出index、共通結果、呼出数と実Memory件数"
// observation_boundary = "consumer"
// scope = "Main memory partial ErrorResponse"
// lifecycle = "permanent"
// distinction = "例外testではserviceの正常resolveで返るErrorResponse分岐を通らない"
// @end-test-value
test("ErrorResponse stops at the rejected candidate and preserves the saved prefix", async () => {
  for (const purpose of purposes) {
    const f = await backgroundMemoryFixture();
    try {
      const scope = f.memoryScope(purpose), execution = f.start(scope);
      let calls = 0;
      const app = new BackgroundMemoryApplicationService({ ...f.deps,
        memoryService: { append(principal, request) { return ++calls === 2
          ? Promise.resolve(createMemoryErrorResponse({ code: "MEMORY_FORBIDDEN", message: "denied" })) : f.memory.append(principal, request); } },
        characterService: { appendEpisode(request, transport, principal) { return ++calls === 2
          ? Promise.resolve(createCharacterContextError("authority_denied", "denied", { retryable: false, conversationMayContinue: true, effect: "none" }))
          : f.character.appendEpisode(request, transport, principal); } },
      });
      const result = await app.apply(execution, memoryFinal(purpose, 3), f.memoryContext(scope));
      assert.ok(result.kind === "stopped");
      assert.equal(result.saved.length, 1); assert.equal(result.failure.candidateIndex, 1);
      assert.equal(result.failure.effect, "none"); assert.equal(result.failure.cause, "rejected");
      assert.deepEqual(result.unattemptedCandidateIndexes, [2]);
      assert.deepEqual(toBackgroundMemorySaveResult(result), { kind: "stopped", confirmedSavedCount: 1,
        cause: "rejected", code: purpose === "character-memory" ? "authority_denied" : "MEMORY_FORBIDDEN" });
      assert.equal(calls, 2); assert.equal(f.memoryCount(), 1);
    } finally { await f.close(); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "未送信generation/Worker拒否はnone、保存後の応答不明はunknownとし、確認済みprefixと未呼出分を保持する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memory候補のmain内部保存" }
// fault = "未送信をunknownに潰すか、効果不明の候補を成功/未保存確定にし、後続/再送を呼ぶ"
// observable = "両用途のeffect/cause、prefixと停止index、共通件数、呼出数と実Worker保存件数"
// observation_boundary = "consumer"
// scope = "Main memory Worker failure effects"
// lifecycle = "permanent"
// distinction = "実Worker保存を含むprefixと応答消失を作り、Characterのerror変換も含め確認する"
// @end-test-value
test("unsent and unknown Worker outcomes remain distinct for both purposes", async () => {
  for (const purpose of purposes) for (const failure of ["generation", "rejected", "unknown"] as const) {
    const f = await backgroundMemoryFixture();
    try {
      let calls = 0;
      const append = f.worker.storage.appendEntry;
      f.worker.storage.appendEntry = async (...args) => {
        if (++calls === 2) {
          if (failure === "generation") throw new StorageWorkerGenerationError();
          if (failure === "rejected") throw new StorageWorkerRemoteError("rejected", "TEST_REJECTED", "rejected");
          await append(...args); throw new StorageWorkerUnknownOutcomeError();
        }
        return append(...args);
      };
      const scope = f.memoryScope(purpose), execution = f.start(scope);
      const result = await f.app.apply(execution, memoryFinal(purpose, 3), f.memoryContext(scope));
      assert.ok(result.kind === "stopped");
      assert.equal(result.saved.length, 1); assert.equal(result.failure.candidateIndex, 1);
      assert.equal(result.failure.effect, failure === "unknown" ? "unknown" : "none");
      assert.equal(result.failure.cause, failure === "unknown" ? "unknown" : "failed");
      assert.deepEqual(result.unattemptedCandidateIndexes, [2]);
      assert.equal(toBackgroundMemorySaveResult(result).kind, "stopped");
      const common = toBackgroundMemorySaveResult(result);
      assert.ok(common.kind === "stopped"); assert.equal(common.confirmedSavedCount, 1); assert.equal(common.cause, result.failure.cause);
      assert.equal(calls, 2); assert.equal(f.memoryCount(), failure === "unknown" ? 2 : 1);
    } finally { await f.close(); }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Mainでqueueされた保存にも同一背景の失効stateが届き、取消後writeしない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memory候補のmain内部保存" }
// fault = "Mainだけでadmissionを確認しWorkerへ伝播せず、取消後に保存する"
// observable = "実Workerの保存拒否、canceled/effect none、保存prefixと実Memory件数0"
// observation_boundary = "consumer"
// scope = "Main memory queued Worker cancellation"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// distinction = "保存開始前の失効testではWorker側のtransaction境界を通る取消を確認できない"
// @end-test-value
test("the real Worker rejects a queued write when its background execution is canceled", async () => {
  for (const purpose of purposes) {
    let cancel: (() => void) | undefined;
    const f = await backgroundMemoryFixture((event) => {
      if (event.operation === "memory.appendEntry" && event.stage === "queued") cancel?.();
    });
    try {
      const scope = f.memoryScope(purpose), execution = f.start(scope);
      cancel = () => f.executions.cancel(execution.binding.bindingId);
      const result = await f.app.apply(execution, memoryFinal(purpose, 3), f.memoryContext(scope));
      assert.ok(result.kind === "stopped");
      assert.equal(result.failure.cause, "canceled"); assert.equal(result.failure.effect, "none");
      assert.equal(result.failure.candidateIndex, 0); assert.deepEqual(result.saved, []);
      assert.deepEqual(result.unattemptedCandidateIndexes, [1, 2]); assert.equal(f.memoryCount(), 0);
    } finally { await f.close(); }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "取消時も確認済み保存を保持し、残りの候補だけを未呼出として停止する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memory候補のmain内部保存" }
// fault = "先行保存を取消で0件へ戻すか、失効後も次候補を呼ぶ"
// observable = "確認済みprefix1件、次候補停止、未呼出index、append呼出と実Memory件数1"
// observation_boundary = "consumer"
// scope = "Main memory confirmed prefix on cancellation"
// lifecycle = "permanent"
// distinction = "初回writeの拒否だけでは成功済みprefixを維持する契約を確認できない"
// @end-test-value
test("cancellation preserves an acknowledged write and does not call later saves", async () => {
  const f = await backgroundMemoryFixture();
  try {
    const scope = f.memoryScope("target-memory"), execution = f.start(scope);
    let calls = 0;
    const append = f.worker.storage.appendEntry;
    f.worker.storage.appendEntry = async (...args) => {
      calls++; const result = await append(...args); f.executions.stop(); return result;
    };
    const result = await f.app.apply(execution, memoryFinal("target-memory", 3), f.memoryContext(scope));
    assert.ok(result.kind === "stopped");
    assert.equal(result.saved.length, 1); assert.equal(result.failure.candidateIndex, 1);
    assert.equal(result.failure.effect, "none"); assert.equal(result.failure.cause, "canceled");
    assert.deepEqual(result.unattemptedCandidateIndexes, [2]); assert.equal(calls, 1); assert.equal(f.memoryCount(), 1);
  } finally { await f.close(); }
});
