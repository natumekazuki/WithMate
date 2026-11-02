import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { RuntimeTurnInactiveError, runWithRuntimeTurnAdmission } from "../../src-electron/platform/memory/runtime-turn-admission.js";
import { buildNewSession, getSessionIncarnationId, type Session } from "../../src-shared/session/session-state.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { SessionHistoryReadScope } from "../../src-shared/session/session-history-read-scope.js";

function session(id: string): Session {
  return { ...buildNewSession({ id, taskTitle: "Main source", workspaceLabel: "workspace", workspacePath: "C:/workspace",
    branch: "main", characterId: "source-character", character: "Character", characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: "never" }),
    messages: Array.from({ length: 8 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, text: `saved ${index}` })) };
}

function scope(saved: Session, fromMessageSeq = 1, throughMessageSeq = 5): SessionHistoryReadScope {
  const incarnationId = getSessionIncarnationId(saved);
  return { source: { kind: "main", sessionId: saved.id, incarnationId,
    ownerIdentity: JSON.stringify(["main", saved.id, incarnationId]) }, fromMessageSeq, throughMessageSeq };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "withmate-main-source-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const options = { dbPath, userDataPath: directory };
  const bundle = createV6StorageWorkerBundle(options);
  await bundle.initialize();
  return { options, bundle, close: async () => {
    await bundle.client.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } };
}

const turnBase = { provider: "codex", model: "gpt-5.4", reasoningEffort: "high" as const,
  approvalMode: "never" as const, threadId: "", errorMessage: "", createdAt: "2026-11-01T01:00:00.000Z" };

// @test-value v2
// kind = "contract"
// claim = "内部Main source readは実Mainのmetadataと固定inclusive範囲内の複数保存済みTurn・時刻を返し、同名Auxiliaryや別ownerのTurnを混ぜない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#内部main-source-read" }
// fault = "最新Turnだけを返す、時刻を補完する、範囲外や同じIDのAuxiliaryをMainとして返す"
// observable = "実Storage WorkerのreadMainSourceが返すsession、ownerIdentity、turns"
// observation_boundary = "public-boundary"
// scope = "background-main-source-read"
// lifecycle = "permanent"
// impact = "Affect用途保存が別sourceや捏造時刻に結び付くことを防ぐ"
// distinction = "実SQLiteとWorker経路のowner・seq絞込みは型検査やAffectの入力stubでは検証できない。小規模fixtureで保存読取を確認する"
// @end-test-value
test("Main sourceは同名Auxiliaryと別ownerを除外し、範囲内の保存済み時刻とmetadataを返す", async () => {
  const f = await fixture();
  try {
    const { session: main, auxiliary, turn } = f.bundle.stores;
    const parent = await main.insertSession(session("parent"));
    const aux: AuxiliarySession = { ...parent, id: "source", parentSessionId: parent.id, status: "active", runState: "idle",
      title: "Auxiliary", composerDraft: "", displayAfterMessageIndex: null,
      createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", closedAt: "" };
    await auxiliary.upsertAuxiliarySession(aux);
    const auxiliaryTurn = await turn.createSessionTurn({ ...turnBase, sessionId: aux.id, phase: "completed", assistantMessageSeq: 3,
      completedAt: "2026-11-01T01:01:00.000Z" });
    const saved = await main.insertSession(session("source"));
    const stored = [];
    for (const assistantMessageSeq of [1, 3, 5, 7]) {
      stored.push(await turn.createSessionTurn({ ...turnBase, sessionId: saved.id, phase: "completed", assistantMessageSeq,
        completedAt: `2026-11-01T02:0${assistantMessageSeq}:00.000Z` }));
    }
    const missingTime = await turn.createSessionTurn({ ...turnBase, sessionId: saved.id, phase: "running", assistantMessageSeq: 4 });
    await turn.createSessionTurn({ ...turnBase, sessionId: parent.id, phase: "failed", assistantMessageSeq: 3,
      completedAt: "2026-11-01T03:00:00.000Z" });
    const readScope = scope(saved);
    const result = await main.readMainSource(readScope);
    assert.deepEqual(result, {
      session: { id: saved.id, incarnationId: saved.incarnationId, characterId: saved.characterId,
        accessMode: saved.accessMode, sourceSchemaVersion: saved.sourceSchemaVersion, sessionKind: saved.sessionKind },
      ownerIdentity: readScope.source.ownerIdentity,
      turns: [...stored.slice(0, 3).map((item) => ({ id: item.id, sessionId: saved.id, phase: item.phase,
        completedAt: item.completedAt, assistantMessageSeq: item.assistantMessageSeq })),
        { id: missingTime.id, sessionId: saved.id, phase: "running", assistantMessageSeq: 4 }],
    });
    assert.ok(!result!.turns.some((item) => item.id === auxiliaryTurn.id));
    assert.deepEqual((await main.readMainSource(scope(saved, 3, 3)))!.turns.map((item) => item.id), [stored[1].id]);
    await main.upsertSession({ ...saved, sessionKind: "character-authoring", accessMode: "legacy_readonly", sourceSchemaVersion: 4 });
    assert.deepEqual((await main.readMainSource(readScope))!.session, {
      id: saved.id, incarnationId: saved.incarnationId, characterId: saved.characterId,
      sessionKind: "character-authoring", accessMode: "legacy_readonly", sourceSchemaVersion: 4,
    });
  } finally { await f.close(); }
});

// @test-value v2
// kind = "security"
// claim = "Main source readは削除・再作成、owner不一致、Auxiliary sourceと未保存範囲を許可済みMainとして返さない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#内部main-source-read" }
// fault = "IDだけでsourceを解決するか範囲不足を成功snapshotにする"
// observable = "実WorkerのreadMainSourceによるnullまたはkind不一致エラー"
// observation_boundary = "public-boundary"
// scope = "background-main-source-identity"
// lifecycle = "permanent"
// impact = "削除再作成後の別会話を保存根拠にすることを防ぐ"
// distinction = "実保存状態と固定scopeの照合は型や公開履歴projectionのcheckでは代替できない"
// @end-test-value
test("Main sourceはsource identityとkindと保存範囲を照合する", async () => {
  const f = await fixture();
  try {
    const main = f.bundle.stores.session;
    const saved = await main.insertSession(session("identity"));
    const readScope = scope(saved);
    assert.equal(await main.readMainSource({ ...readScope, source: { ...readScope.source, ownerIdentity: "other-owner" } }), null);
    assert.equal(await main.readMainSource({ ...readScope, source: { ...readScope.source, incarnationId: "other-incarnation" } }), null);
    assert.equal(await main.readMainSource({ ...readScope, throughMessageSeq: 8 }), null);
    await assert.rejects(main.readMainSource({ ...readScope, source: { ...readScope.source, kind: "auxiliary",
      parent: { sessionId: saved.id, incarnationId: readScope.source.incarnationId } } }), /require a main source/);
    await main.deleteSession(saved.id);
    assert.equal(await main.readMainSource(readScope), null);
    await main.insertSession(session(saved.id));
    assert.equal(await main.readMainSource(readScope), null);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "security"
// claim = "Main source readのruntime admissionはproxyだけでなくWorker実行前の失効も拒否する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#内部main-source-read" }
// fault = "SharedArrayBufferをWorkerへ伝播せず、送信後失効したadmissionで保存sourceを読む"
// observable = "queued facade read、失効済みproxy read、直接Worker呼出のRuntimeTurnInactiveError"
// observation_boundary = "public-boundary"
// scope = "background-main-source-admission"
// lifecycle = "permanent"
// impact = "runtime停止後の背景用途が保存材料を取得することを防ぐ"
// distinction = "proxyの同期assertだけでは送信後の失効を保証できないため実Worker起動前queueで検証する"
// @end-test-value
test("Main sourceのadmissionはproxyからWorkerへ伝播し、実行前の失効を拒否する", async () => {
  const f = await fixture();
  let reopened: ReturnType<typeof createV6StorageWorkerBundle> | undefined;
  try {
    const saved = await f.bundle.stores.session.insertSession(session("admission"));
    await f.bundle.client.close();
    reopened = createV6StorageWorkerBundle(f.options);
    const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const pending = runWithRuntimeTurnAdmission({ state }, () => reopened!.stores.session.readMainSource(scope(saved)));
    Atomics.store(new Int32Array(state), 0, 1);
    await assert.rejects(pending, RuntimeTurnInactiveError);
    assert.throws(() => runWithRuntimeTurnAdmission({ state }, () => reopened!.stores.session.readMainSource(scope(saved))), RuntimeTurnInactiveError);
    await assert.rejects(reopened.client.call("store.call", { store: "session", method: "readMainSource", args: [scope(saved)],
      runtimeTurnAdmissionState: state }), RuntimeTurnInactiveError);
    assert.ok(await reopened.stores.session.readMainSource(scope(saved)));
  } finally { await reopened?.client.close(); await f.close(); }
});
