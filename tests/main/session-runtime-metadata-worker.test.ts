import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { StorageWorkerGenerationError } from "../../src-electron/storage/storage-worker-client.js";

async function fixture() {
  const userDataPath = await mkdtemp(join(tmpdir(), "withmate-runtime-worker-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(userDataPath);
  const options = { dbPath, userDataPath, bundledModelCatalogPath: join(process.cwd(), "public/model-catalog.json"),
    workerUrl: new URL("../../src-electron/storage/storage-worker-entry.ts", import.meta.url),
    handlerModule: new URL("../../src-electron/storage/storage-worker-bundle.ts", import.meta.url),
    workerOptions: { execArgv: ["--import", "tsx"] } };
  const bundle = createV6StorageWorkerBundle(options);
  await bundle.initialize();
  return { options, bundle, async dispose() { await bundle.client.close(); await rm(userDataPath, { recursive: true, force: true }); } };
}

function session(id: string) {
  return buildNewSession({ id, taskTitle: "runtime", workspaceLabel: "workspace", workspacePath: "C:/workspace",
    branch: "main", characterId: "mate", character: "Mate", characterIconPath: "",
    characterThemeColors: { main: "#123456", sub: "#abcdef" }, approvalMode: DEFAULT_APPROVAL_MODE });
}

// @test-value v2
// kind = "contract"
// claim = "Main/Aux runtimeのtyped commandは実Workerを往復し小さい同owner ACKを返しterminalとturnを原子的に保存しclosed generationの操作を拒否する"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md 書込みとowner" }
// fault = "allowlist欠落やstructured clone不整合でruntime commandが実行できない、terminal失敗でmessageだけ保存する、旧generationが新DBを更新する"
// observable = "metadata ACK、identity、turn phase、失敗後count、close後のGenerationErrorとreopen後のcount"
// observation_boundary = "public-boundary"
// scope = "実V6 storage WorkerのMain/Aux runtime command"
// lifecycle = "permanent"
// impact = "非同期永続化境界で確定入力や結果を失い別ownerへ書くことを防ぐ"
// distinction = "direct storage testはWorker allowlist、clone、async generationを通らず、この一連の実Worker testでのみ接続を確認する"
// @end-test-value
test("runtime metadata commandは実Workerのownerとatomic境界を保つ", async () => {
  const f = await fixture();
  let reopened: ReturnType<typeof createV6StorageWorkerBundle> | undefined;
  try {
    const main = await f.bundle.stores.session.insertSession(session("main"));
    const owner = { sessionId: main.id, incarnationId: main.incarnationId! };
    const started = await f.bundle.stores.session.appendRunningTurnStart({ ...owner, expectedMessageCount: 0,
      userMessage: { role: "user", text: "send" }, updatedAt: "start" });
    assert.equal(started.summary.id, main.id);
    const mainTurn = await f.bundle.stores.turn.createSessionTurn({ sessionId: main.id, phase: "running", createdAt: "start",
      provider: main.provider, model: main.model, reasoningEffort: main.reasoningEffort, approvalMode: main.approvalMode,
      threadId: "", errorMessage: "", userMessageSeq: 0 });
    const steered = await f.bundle.stores.session.appendSessionSteer({ ...owner, turnId: mainTurn.id, expectedMessageCount: 1,
      userMessage: { role: "user", text: "steer" }, updatedAt: "steer" });
    assert.equal(steered.messageCount, 2);
    assert.equal("messages" in steered, false);
    const checkpoint = await f.bundle.stores.session.checkpointSessionRunMetadata({ ...owner,
      expected: { status: "running", runState: "running", threadId: "" },
      next: { status: "running", runState: "running", threadId: "thread", updatedAt: "checkpoint" } });
    assert.equal(checkpoint?.summary.threadId, "thread");
    const terminal = { ...owner, expectedMessageCount: 2, assistantMessage: { role: "assistant" as const, text: "done" },
      metadata: { status: "idle" as const, runState: "idle", threadId: "thread", updatedAt: "terminal" },
      terminalCommit: { turnId: mainTurn.id, sessionId: main.id, phase: "completed" as const, assistantMessageSeq: 2,
        threadId: "thread", errorMessage: "", completedAt: "terminal" } };
    await f.bundle.stores.session.appendSessionTerminal(terminal);
    assert.equal((await f.bundle.stores.session.getSessionMetadata(main.id))?.messageCount, 3);
    assert.deepEqual(await f.bundle.stores.session.getSessionMessageIdentity({ ...owner, messageIndex: 2 }),
      { role: "assistant", text: "done", historyIndex: 2 });
    assert.equal((await f.bundle.stores.turn.getLatestSessionTurn(main.id))?.phase, "completed");

    const aux = await f.bundle.stores.auxiliary.upsertAuxiliarySession({ id: "aux", parentSessionId: main.id,
      status: "active", runState: "idle", title: "aux", provider: main.provider, catalogRevision: main.catalogRevision,
      model: main.model, reasoningEffort: main.reasoningEffort, approvalMode: main.approvalMode,
      codexSandboxMode: main.codexSandboxMode, codexSpeed: main.codexSpeed, codexReviewer: main.codexReviewer,
      customAgentName: "", threadId: "", composerDraft: "", messages: [],
      displayAfterMessageIndex: null, createdAt: "created", updatedAt: "created", closedAt: "" });
    const auxOwner = { auxiliarySessionId: aux.id, parentSessionId: main.id, createdAt: aux.createdAt };
    assert.equal((await f.bundle.stores.auxiliary.getAuxiliarySessionMetadata(aux.id))?.messageCount, 0);
    assert.equal((await f.bundle.stores.auxiliary.appendAuxiliaryRunningTurnStart({ ...auxOwner, expectedMessageCount: 0,
      userMessage: { role: "user", text: "send" }, updatedAt: "start" }))?.messageCount, 1);
    const auxTurn = await f.bundle.stores.turn.createSessionTurn({ sessionId: aux.id, phase: "running", createdAt: "start",
      provider: main.provider, model: main.model, reasoningEffort: main.reasoningEffort, approvalMode: main.approvalMode,
      threadId: "", errorMessage: "", userMessageSeq: 0 });
    const auxSteer = await f.bundle.stores.auxiliary.appendAuxiliarySteer({ ...auxOwner, expectedMessageCount: 1,
      turnId: auxTurn.id, userMessage: { role: "user", text: "steer" }, updatedAt: "steer" });
    assert.deepEqual(auxSteer?.messages, []);
    assert.equal(auxSteer?.messageCount, 2);
    assert.equal((await f.bundle.stores.auxiliary.checkpointAuxiliaryRuntimeMetadata({ ...auxOwner, expectedMessageCount: 2,
      provider: main.provider, expectedThreadId: "", expectedRunState: "running", threadId: "thread", runState: "running",
      updatedAt: "checkpoint" }))?.threadId, "thread");
    const auxTerminal = { ...auxOwner, expectedMessageCount: 2, assistantMessage: { role: "assistant" as const, text: "done" },
      runState: "idle" as const, threadId: "thread", preview: "done", updatedAt: "terminal",
      terminalCommit: { ...terminal.terminalCommit, sessionId: aux.id, turnId: auxTurn.id } };
    await assert.rejects(f.bundle.stores.auxiliary.appendAuxiliaryTerminal({ ...auxTerminal,
      terminalCommit: { ...auxTerminal.terminalCommit, turnId: mainTurn.id } }), /terminal commit target mismatch/);
    assert.equal((await f.bundle.stores.auxiliary.getAuxiliarySessionMetadata(aux.id))?.messageCount, 2);
    assert.equal((await f.bundle.stores.turn.getLatestSessionTurn(aux.id))?.phase, "running");
    assert.equal((await f.bundle.stores.auxiliary.appendAuxiliaryTerminal(auxTerminal))?.messageCount, 3);
    assert.equal((await f.bundle.stores.turn.getLatestSessionTurn(aux.id))?.phase, "completed");

    const oldMain = f.bundle.stores.session;
    const oldAux = f.bundle.stores.auxiliary;
    await f.bundle.client.close();
    reopened = createV6StorageWorkerBundle(f.options);
    await reopened.initialize();
    await assert.rejects(oldMain.getSessionMetadata(main.id), StorageWorkerGenerationError);
    await assert.rejects(oldMain.appendSessionTerminal(terminal), StorageWorkerGenerationError);
    await assert.rejects(oldAux.appendAuxiliaryTerminal(auxTerminal), StorageWorkerGenerationError);
    assert.equal((await reopened.stores.session.getSessionMetadata(main.id))?.messageCount, 3);
    assert.equal((await reopened.stores.auxiliary.getAuxiliarySessionMetadata(aux.id))?.messageCount, 3);
  } finally { if (reopened) await reopened.client.close(); await f.dispose(); }
});

// @test-value v2
// kind = "contract"
// claim = "固定件数の履歴本文bytesだけが増えても実Workerのmetadataとsteer commandのJSON request/ACK bytesは増えない"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md 読取と通知・書込みとowner" }
// fault = "metadataやappend commandのrequestまたはACKに保存済み本文が混入し転送量が増える"
// observable = "1KiBと4MiB本文fixtureの公開typed request/ACK JSON byte数と保存済み本文長"
// observation_boundary = "public-boundary"
// scope = "実Worker Main metadata/steer transportの本文bytes独立性"
// lifecycle = "permanent"
// impact = "長い本文を持つ会話でMain Worker転送量とclone負担が増加する"
// distinction = "direct testとtypecheckでは実Worker ACK転送量を測れず、固定2fixtureのbyte比較は低コストの性能契約確認になる"
// @end-test-value
test("runtime commandのrequestとACKは保存本文bytesに依存しない", async () => {
  const f = await fixture();
  try {
    const records = [];
    for (const [id, bodyBytes] of [["sml", 1024], ["big", 4 * 1024 * 1024]] as const) {
      const main = await f.bundle.stores.session.insertSession({ ...session(id), updatedAt: "created",
        status: "running", runState: "running", messages: [{ role: "user", text: "fixture" }] });
      const db = new DatabaseSync(f.options.dbPath);
      try { db.prepare("UPDATE session_messages_v6 SET body = ? WHERE session_id = ?")
        .run(JSON.stringify({ role: "user", text: "x".repeat(bodyBytes) }), id); } finally { db.close(); }
      const turn = await f.bundle.stores.turn.createSessionTurn({ sessionId: id, phase: "running", createdAt: "created",
        provider: main.provider, model: main.model, reasoningEffort: main.reasoningEffort, approvalMode: main.approvalMode,
        threadId: "", errorMessage: "", userMessageSeq: 0 });
      const metadata = await f.bundle.stores.session.getSessionMetadata(id);
      const input = { sessionId: id, incarnationId: main.incarnationId!, expectedMessageCount: 1, turnId: turn.id,
        userMessage: { role: "user" as const, text: "steer" }, updatedAt: "steer" };
      const ack = await f.bundle.stores.session.appendSessionSteer(input);
      const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
      records.push({ metadataRequest: bytes([id]), metadataAck: bytes(metadata), appendRequest: bytes([input]), appendAck: bytes(ack) });
      assert.equal((await f.bundle.stores.session.getSession(id))?.messages[0].text.length, bodyBytes);
      assert.equal(ack.messageCount, 2);
    }
    assert.deepEqual(records[0], records[1]);
  } finally { await f.dispose(); }
});
