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
import { DatabaseSync } from "node:sqlite";

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
// oracle = { type = "contract", ref = "docs/design/background-execution.md#内部background-source-read" }
// fault = "最新Turnだけを返す、時刻を補完する、範囲外や同じIDのAuxiliaryをMainとして返す"
// observable = "実Storage WorkerのreadBackgroundSourceが返すsession、ownerIdentity、turns"
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
    const aux: AuxiliarySession = { ...parent, id: "source", parentSessionId: parent.id, runState: "idle",
      title: "Auxiliary", composerDraft: "", displayAfterMessageIndex: null,
      createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" };
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
    const result = await main.readBackgroundSource(readScope);
    assert.deepEqual(result, {
      session: { id: saved.id, incarnationId: saved.incarnationId, characterId: saved.characterId,
        accessMode: saved.accessMode, sourceSchemaVersion: saved.sourceSchemaVersion, sessionKind: saved.sessionKind },
      ownerIdentity: readScope.source.ownerIdentity,
      turns: [...stored.slice(0, 3).map((item) => ({ id: item.id, sessionId: saved.id, phase: item.phase,
        completedAt: item.completedAt, assistantMessageSeq: item.assistantMessageSeq })),
        { id: missingTime.id, sessionId: saved.id, phase: "running", assistantMessageSeq: 4 }],
    });
    assert.ok(!result!.turns.some((item) => item.id === auxiliaryTurn.id));
    assert.deepEqual((await main.readBackgroundSource(scope(saved, 3, 3)))!.turns.map((item) => item.id), [stored[1].id]);
    await main.upsertSession({ ...saved, sessionKind: "character-authoring", accessMode: "legacy_readonly", sourceSchemaVersion: 4 });
    assert.deepEqual((await main.readBackgroundSource(readScope))!.session, {
      id: saved.id, incarnationId: saved.incarnationId, characterId: saved.characterId,
      sessionKind: "character-authoring", accessMode: "legacy_readonly", sourceSchemaVersion: 4,
    });
  } finally { await f.close(); }
});

// @test-value v2
// kind = "security"
// claim = "共通source readは削除・再作成、owner不一致、実在しないAuxiliary sourceと未保存範囲を許可済みsourceとして返さない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#内部background-source-read" }
// fault = "IDだけでsourceを解決するか範囲不足を成功snapshotにする"
// observable = "実WorkerのreadBackgroundSourceによるnull"
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
    assert.equal(await main.readBackgroundSource({ ...readScope, source: { ...readScope.source, ownerIdentity: "other-owner" } }), null);
    assert.equal(await main.readBackgroundSource({ ...readScope, source: { ...readScope.source, incarnationId: "other-incarnation" } }), null);
    assert.equal(await main.readBackgroundSource({ ...readScope, throughMessageSeq: 8 }), null);
    assert.equal(await main.readBackgroundSource({ ...readScope, source: { ...readScope.source, kind: "auxiliary",
      parent: { sessionId: saved.id, incarnationId: readScope.source.incarnationId } } }), null);
    await main.deleteSession(saved.id);
    assert.equal(await main.readBackgroundSource(readScope), null);
    await main.insertSession(session(saved.id));
    assert.equal(await main.readBackgroundSource(readScope), null);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "security"
// claim = "Main source readのruntime admissionはproxyだけでなくWorker実行前の失効も拒否する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#内部background-source-read" }
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
    const pending = runWithRuntimeTurnAdmission({ state }, () => reopened!.stores.session.readBackgroundSource(scope(saved)));
    Atomics.store(new Int32Array(state), 0, 1);
    await assert.rejects(pending, RuntimeTurnInactiveError);
    assert.throws(() => runWithRuntimeTurnAdmission({ state }, () => reopened!.stores.session.readBackgroundSource(scope(saved))), RuntimeTurnInactiveError);
    await assert.rejects(reopened.client.call("store.call", { store: "session", method: "readBackgroundSource", args: [scope(saved)],
      runtimeTurnAdmissionState: state }), RuntimeTurnInactiveError);
    assert.ok(await reopened.stores.session.readBackgroundSource(scope(saved)));
  } finally { await reopened?.client.close(); await f.close(); }
});

// @test-value v2
// kind = "security"
// claim = "共通captureとreadはMainと同名Auxiliaryをkindで区別し、実Aux Character・owner列・固定保存範囲を維持して親とdraft再作成不一致を拒否する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#内部background-source-read" }
// fault = "Auxiliaryを親や同名Mainへ代用する、capture後の末尾を読み足す、別親や再作成draftを許す"
// observable = "実Workerのcapture/read snapshotと不一致時null"
// observation_boundary = "public-boundary"
// scope = "Main/Auxiliary shared Worker source boundary"
// lifecycle = "permanent"
// impact = "別会話の本文とCharacterを背景登録の根拠へ混入させない"
// distinction = "同名IDとdraft再作成を含むSQLite owner照合は型検査やstubでは検証できない。小さいWorker fixtureで確認する"
// @end-test-value
test("共通source captureは実Auxiliaryと固定範囲を保持し親とdraft identityを照合する", async () => {
  const f = await fixture();
  try {
    const { session: main, auxiliary, turn } = f.bundle.stores;
    const parent = await main.insertSession(session("parent"));
    const aux: AuxiliarySession = { ...parent, id: "same", parentSessionId: parent.id, characterId: "aux-character",
      runState: "idle", title: "Auxiliary", composerDraft: "", displayAfterMessageIndex: null,
      createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" };
    await auxiliary.upsertAuxiliarySession(aux);
    const terminal = await turn.createSessionTurn({ ...turnBase, sessionId: aux.id, phase: "failed", assistantMessageSeq: 3,
      completedAt: "2026-11-01T01:01:00.000Z" });
    const sameMain = await main.insertSession(session(aux.id));
    const mainTurn = await turn.createSessionTurn({ ...turnBase, sessionId: sameMain.id, phase: "completed", assistantMessageSeq: 3,
      completedAt: "2026-11-01T02:01:00.000Z" });
    const ref = { kind: "auxiliary" as const, sessionId: aux.id, incarnationId: aux.createdAt,
      parent: { sessionId: parent.id, incarnationId: getSessionIncarnationId(parent) } };
    const captured = await main.captureBackgroundSource(ref);
    assert.ok(captured);
    assert.equal(captured.snapshot.session.id, aux.id);
    assert.equal(captured.snapshot.session.characterId, "aux-character");
    assert.deepEqual(captured.snapshot.turns, [{ id: terminal.id, sessionId: null, auxiliarySessionId: aux.id,
      phase: "failed", completedAt: terminal.completedAt, assistantMessageSeq: 3 }]);
    assert.deepEqual(captured.history, { source: { ...ref, ownerIdentity: captured.snapshot.ownerIdentity }, fromMessageSeq: 0, throughMessageSeq: 7 });
    const capturedMain = await main.captureBackgroundSource({ kind: "main", sessionId: sameMain.id, incarnationId: getSessionIncarnationId(sameMain) });
    assert.deepEqual(capturedMain!.snapshot.turns.map((item) => item.id), [mainTurn.id]);
    assert.notEqual(capturedMain!.snapshot.ownerIdentity, captured.snapshot.ownerIdentity);
    await auxiliary.upsertAuxiliarySession({ ...aux, messages: [...aux.messages, { role: "assistant", text: "saved later" }] });
    assert.deepEqual(await main.readBackgroundSource(captured.history), captured.snapshot);
    assert.equal(await main.readBackgroundSource({ ...captured.history, throughMessageSeq: 9 }), null);
    assert.equal(await main.captureBackgroundSource({ ...ref, parent: { ...ref.parent, incarnationId: "wrong" } }), null);
    const other = await main.insertSession({ ...session("other"), incarnationId: ref.parent.incarnationId });
    assert.equal(await main.readBackgroundSource({ ...captured.history,
      source: { ...captured.history.source, kind: "auxiliary", parent: { sessionId: other.id, incarnationId: ref.parent.incarnationId } } }), null);
    const db = new DatabaseSync(f.options.dbPath);
    try { db.prepare("UPDATE auxiliary_session_drafts SET incarnation = 'recreated-draft' WHERE auxiliary_session_id = ?").run(aux.id); }
    finally { db.close(); }
    assert.equal(await main.readBackgroundSource(captured.history), null);
    assert.notEqual((await main.captureBackgroundSource(ref))!.snapshot.ownerIdentity, captured.snapshot.ownerIdentity);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "security"
// claim = "source captureは実Worker実行前に同一admissionが失効するとmetadataと固定履歴範囲を返さない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#内部background-source-read" }
// fault = "capture portだけSharedArrayBufferの伝播を忘れる"
// observable = "Worker起動待ちcaptureのRuntimeTurnInactiveError"
// observation_boundary = "public-boundary"
// scope = "captureBackgroundSource Worker admission propagation"
// lifecycle = "permanent"
// impact = "停止後の背景controllerが元会話の材料を取得しない"
// distinction = "read portとは異なるWorker許可methodの失効伝播を実起動queueで確認する"
// @end-test-value
test("共通source captureは同一admissionをWorkerへ伝播する", async () => {
  const f = await fixture();
  let reopened: ReturnType<typeof createV6StorageWorkerBundle> | undefined;
  try {
    const saved = await f.bundle.stores.session.insertSession(session("capture"));
    await f.bundle.client.close();
    reopened = createV6StorageWorkerBundle(f.options);
    const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const pending = runWithRuntimeTurnAdmission({ state }, () => reopened!.stores.session.captureBackgroundSource({
      kind: "main", sessionId: saved.id, incarnationId: getSessionIncarnationId(saved),
    }));
    Atomics.store(new Int32Array(state), 0, 1);
    await assert.rejects(pending, RuntimeTurnInactiveError);
  } finally { await reopened?.client.close(); await f.close(); }
});
