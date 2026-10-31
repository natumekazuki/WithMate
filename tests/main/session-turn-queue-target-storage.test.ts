import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { ensureV6Schema } from "../../src-electron/storage/database-schema-v6.js";
import { buildNewSession, getSessionIncarnationId } from "../../src-shared/session/session-state.js";
import { SessionTurnQueueService } from "../../src-electron/session/session-turn-queue-service.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { SessionTurnInput } from "../../src-shared/session/session-turn-state.js";
import type { SessionTurnQueueCapturedInput, SessionTurnQueueOwner, SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";

// @test-value v2
// kind = "contract"
// claim = "Main/Auxの待機順変更は捕捉内容と受付履歴を保持して永続化し、列競合と書込失敗では部分変更せず、移行後も保存順でclaimする"
// oracle = { type = "contract", ref = "GitHub Issue #912: Main/Aux未開始だけの順変更と列競合時非適用" }
// fault = "sequenceやcaptureを書き換える、stale列を上書きする、position更新を部分commitする、または再open/旧schema更新で順序を失う"
// observable = "Worker再open後のreceipt全field、履歴cursor、競合outcome、rollback後の順、claim ID列"
// observation_boundary = "public-boundary"
// scope = "実V6 Worker queue保存・Main/Aux owner・schema追加・順変更transaction"
// lifecycle = "permanent"
// impact = "指示内容の破壊、取消や開始済み指示の復活、意図しない順の実行を防ぐ"
// distinction = "既存FIFO testは並べ替えやposition更新途中のrollbackを通らない。2 ownerを同じ小規模DBで確認する"
// @end-test-value
test("Main/Auxの順変更は原子的に保存し競合と履歴を保持する", async () => {
  const f = await fixture();
  const db = new DatabaseSync(f.options.dbPath);
  let reopened: ReturnType<typeof createV6StorageWorkerBundle> | undefined;
  try {
    const aux = await f.bundle.stores.auxiliary.upsertAuxiliarySession({ ...f.session, id: "reorder-aux", parentSessionId: f.session.id,
      title: "Aux", status: "active", runState: "idle", composerDraft: "draft", messages: [], displayAfterMessageIndex: null,
      characterId: undefined, characterRuntimeSnapshot: undefined, createdAt: "created", updatedAt: "created", closedAt: "" });
    const owners = [{ sessionId: f.session.id, incarnationId: getSessionIncarnationId(f.session) }, { sessionId: aux.id, incarnationId: aux.createdAt }];
    const snapshots: Array<{ owner: SessionTurnQueueOwner; ids: string[]; receipts: SessionTurnQueueReceipt[] }> = [];
    for (const owner of owners) {
      const rows = [];
      for (const text of ["one", "two", "three"]) rows.push(await f.bundle.stores.queue.enqueue(owner,
        { ...f.captured(text), request: { ...f.captured(text).request, submitSource: "retry" },
          attachments: [{ id: text, kind: "file", source: "text", absolutePath: "C:/workspace/input.txt", displayPath: "input.txt", workspaceRelativePath: "input.txt", isOutsideWorkspace: false }] }));
      const ids = rows.map((row) => row.id);
      await assert.rejects(f.bundle.stores.queue.reorderQueued(owner, ids, [ids[0]!, ids[0]!, ids[2]!]), /unique identities/);
      await assert.rejects(f.bundle.stores.queue.reorderQueued({ ...owner, incarnationId: "stale" }, ids, [...ids].reverse()), /incarnation mismatch/);
      db.exec(`CREATE TRIGGER fail_reorder BEFORE UPDATE OF queue_position ON session_turn_queue_v6
        WHEN OLD.id = '${ids[1]}' BEGIN SELECT RAISE(ABORT, 'reorder failed'); END`);
      await assert.rejects(f.bundle.stores.queue.reorderQueued(owner, ids, [...ids].reverse()), /reorder failed/);
      db.exec("DROP TRIGGER fail_reorder");
      assert.deepEqual(await f.bundle.stores.queue.listActive(owner), rows);
      const result = await f.bundle.stores.queue.reorderQueued(owner, ids, [...ids].reverse());
      assert.equal(result.outcome, "reordered");
      assert.deepEqual(result.receipts.map((row) => row.id), [...ids].reverse());
      for (const original of rows) {
        const actual = result.receipts.find((row) => row.id === original.id)!;
        assert.deepEqual({ ...actual, queuePosition: original.queuePosition, updatedAt: original.updatedAt }, original);
      }
      assert.equal((await f.bundle.stores.queue.reorderQueued(owner, ids, [...ids].reverse())).outcome, "conflict");
      const page = await f.bundle.stores.queue.listReceipts(owner, { limit: 2 });
      assert.deepEqual(page.receipts.map((row) => row.id), ids.slice(0, 2));
      assert.equal((await f.bundle.stores.queue.listReceipts(owner, { cursor: page.nextCursor! })).receipts[0]?.id, ids[2]);
      snapshots.push({ owner, ids, receipts: result.receipts });
    }
    assert.equal((await f.bundle.stores.auxiliary.getAuxiliaryDraft(aux.id))?.text, "draft");
    await f.bundle.client.close();
    reopened = createV6StorageWorkerBundle(f.options);
    await reopened.initialize();
    for (const snapshot of snapshots) {
      assert.deepEqual(await reopened.stores.queue.listActive(snapshot.owner), snapshot.receipts);
      const extra = await reopened.stores.queue.enqueue(snapshot.owner, { ...f.captured("extra"), request: { ...f.captured("extra").request, submitSource: "retry" } });
      const reverse = [...snapshot.ids].reverse();
      assert.equal((await reopened.stores.queue.reorderQueued(snapshot.owner, reverse, snapshot.ids)).outcome, "conflict");
      await reopened.stores.queue.cancelQueued(snapshot.owner, extra.id);
      await reopened.stores.queue.cancelQueued(snapshot.owner, snapshot.ids[1]!);
      assert.equal((await reopened.stores.queue.reorderQueued(snapshot.owner, reverse, snapshot.ids)).outcome, "conflict");
      assert.equal((await reopened.stores.queue.claimNext(snapshot.owner))?.id, snapshot.ids[2]);
      assert.equal((await reopened.stores.queue.reorderQueued(snapshot.owner, [snapshot.ids[2]!, snapshot.ids[0]!], [snapshot.ids[0]!, snapshot.ids[2]!])).outcome, "conflict");
      await reopened.stores.queue.settle(snapshot.owner, snapshot.ids[2]!, "completed");
      assert.equal((await reopened.stores.queue.claimNext(snapshot.owner))?.id, snapshot.ids[0]);
    }
    await reopened.client.close();
    reopened = undefined;
    db.exec("ALTER TABLE session_turn_queue_v6 DROP COLUMN queue_position");
    reopened = createV6StorageWorkerBundle(f.options);
    await reopened.initialize();
    for (const snapshot of snapshots) {
      const receipts: SessionTurnQueueReceipt[] = (await reopened.stores.queue.listReceipts(snapshot.owner)).receipts;
      assert.ok(receipts.every((receipt) => receipt.queuePosition === receipt.sequence));
      assert.deepEqual(receipts.slice(0, 3).map((receipt) => receipt.captured), [...snapshot.receipts].reverse().map((receipt) => receipt.captured));
    }
  } finally {
    await reopened?.client.close();
    db.close();
    await f.dispose();
  }
});

// @test-value v2
// kind = "contract"
// claim = "共通Session lockは追加と順変更を直列化し、保存返信不明を再送せず正本順で一度ずつdispatchする"
// oracle = { type = "contract", ref = "GitHub Issue #912: 保存順で直列実行、追加競合非適用、応答不明の自動再送禁止" }
// fault = "追加済み項目をstale順で消す、返信不明mutationを再送する、または旧順でdispatchする"
// observable = "reorder呼出回数/結果、保存正本のID列、dispatchで受け取る本文/設定/添付と順、shutdown拒否"
// observation_boundary = "public-boundary"
// scope = "SessionTurnQueueService + 実Worker QueueStoreのlock・返信喪失・dispatch境界"
// lifecycle = "permanent"
// impact = "並び変更時の受付喪失や異なる順序での指示実行を防ぐ"
// distinction = "storage単独testではservice lock、drainと保存返信喪失時の再送回数を検証できない"
// @end-test-value
test("serviceは順変更の返信不明を再送せず保存順をdispatchする", async () => {
  const f = await fixture();
  const owner = { sessionId: f.session.id, incarnationId: getSessionIncarnationId(f.session) };
  let held = true;
  let loseReply = false;
  let mutations = 0;
  const dispatched: SessionTurnQueueCapturedInput[] = [];
  const store = new Proxy(f.bundle.stores.queue, { get: (target, property) => property === "reorderQueued"
    ? async (...args: Parameters<typeof target.reorderQueued>) => {
      mutations += 1;
      const result = await target.reorderQueued(...args);
      if (loseReply) throw new Error("reorder reply lost");
      return result;
    } : Reflect.get(target, property) });
  const service = new SessionTurnQueueService({ store, isRunInFlight: () => held,
    dispatch: async (receipt) => { dispatched.push(receipt.captured); return { state: "completed" }; } });
  try {
    const first = await service.enqueue(owner, f.captured("first"));
    const second = await service.enqueue(owner, f.captured("second"));
    const original = [first.id, second.id];
    const adding = service.enqueue(owner, f.captured("third"));
    const stale = service.reorderQueued(owner, original, [...original].reverse());
    const third = await adding;
    assert.equal((await stale).outcome, "conflict");
    const ids = [...original, third.id];
    loseReply = true;
    await assert.rejects(service.reorderQueued(owner, ids, [third.id, first.id, second.id]), /reply lost/);
    assert.equal(mutations, 2);
    assert.deepEqual((await store.listActive(owner)).map((receipt) => receipt.id), [third.id, first.id, second.id]);
    assert.deepEqual(dispatched, []);
    held = false;
    service.wake(owner.sessionId);
    await service.waitForPending();
    assert.deepEqual(dispatched, [third.captured, first.captured, second.captured]);
    assert.equal(mutations, 2);
    service.beginShutdown();
    assert.throws(() => service.reorderQueued(owner, [], []), /shutting down/);
  } finally {
    await service.close();
    await f.dispose();
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "withmate-queue-target-"));
  const options = { dbPath: join(directory, "withmate-v6.db"), userDataPath: directory,
    bundledModelCatalogPath: join(process.cwd(), "public/model-catalog.json") };
  const bundle = createV6StorageWorkerBundle(options);
  await bundle.initialize();
  const session = await bundle.stores.session.insertSession(buildNewSession({ id: "main", taskTitle: "Queue",
    workspaceLabel: "workspace", workspacePath: "C:/workspace", branch: "main", characterId: "unknown",
    character: "Unknown", characterIconPath: "", characterThemeColors: { main: "#123456", sub: "#abcdef" }, approvalMode: DEFAULT_APPROVAL_MODE }));
  const captured = (text: string): SessionTurnQueueCapturedInput => ({ request: { userMessage: text,
    clientRequestId: randomUUID(), executionOptions: captureSessionExecutionOptions(session) },
    provider: session.provider, workspacePath: session.workspacePath, attachments: [] });
  const turn = (sessionId: string, count = 0): SessionTurnInput => ({ sessionId, phase: "running", provider: session.provider,
    model: session.model, reasoningEffort: session.reasoningEffort, approvalMode: session.approvalMode,
    sandboxMode: session.codexSandboxMode, userMessageSeq: count, threadId: "", errorMessage: "", createdAt: "start" });
  return { directory, options, bundle, session, captured, turn,
    async dispose() { await bundle.client.close(); await rm(directory, { recursive: true, force: true }); } };
}

// @test-value v2
// kind = "contract"
// claim = "Auxiliaryのretry受付は前回本文をreceiptへ保存し現在draftの本文とrevisionを一致・不一致・空の各場合に保持し、同requestをdedupし、古いownerを拒否し、通常composer受付ではdraft消費を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: terminal state 後の再送導線" }
// fault = "retryが現在draftを消費または本文一致を要求する、別incarnationを受け入れる、同requestを二重受付する、または通常送信のdraft消費をやめる"
// observable = "実Storage Workerのreceipt本文/id、Auxiliary draft text/durableRevision、owner mismatch例外"
// observation_boundary = "public-boundary"
// scope = "auxiliary-retry-queue-draft-preservation"
// lifecycle = "permanent"
// impact = "再送で未送信draftを喪失するか現在draftが前回本文と異なるために回復できなくなる"
// distinction = "renderer stubはSQLite受付transaction内のdraft消費を実行せず、通常queue testはretryを扱わない"
// @end-test-value
test("Aux retry受付は現在draftを保持し通常composer受付だけがdraftを消費する", async () => {
  const f = await fixture();
  try {
    for (const [index, text] of ["Different unsent draft", "Previous request", ""].entries()) {
      const aux = await f.bundle.stores.auxiliary.upsertAuxiliarySession({ ...f.session,
        id: `retry-aux-${index}`, parentSessionId: f.session.id, title: "Recovery", status: "active", runState: "error",
        composerDraft: text, messages: [], displayAfterMessageIndex: null,
        characterId: undefined, characterRuntimeSnapshot: undefined, createdAt: `created-${index}`, updatedAt: "created", closedAt: "",
      });
      const owner = { sessionId: aux.id, incarnationId: aux.createdAt };
      const before = (await f.bundle.stores.auxiliary.getAuxiliaryDraft(aux.id))!;
      const retry = f.captured("Previous request");
      retry.request.submitSource = "retry";
      await assert.rejects(f.bundle.stores.queue.enqueue({ ...owner, incarnationId: "stale" }, retry), /incarnation mismatch/);
      const receipt = await f.bundle.stores.queue.enqueue(owner, retry);
      assert.equal(receipt.captured.request.userMessage, "Previous request");
      assert.equal(receipt.captured.request.submitSource, "retry");
      assert.equal((await f.bundle.stores.queue.enqueue(owner, retry)).id, receipt.id);
      const after = (await f.bundle.stores.auxiliary.getAuxiliaryDraft(aux.id))!;
      assert.equal(after.text, text);
      assert.equal(after.durableRevision, before.durableRevision);

      const saved = await f.bundle.stores.auxiliary.saveAuxiliaryDraft({ auxiliarySessionId: aux.id,
        parentSessionId: aux.parentSessionId, incarnation: after.incarnation, expectedDurableRevision: after.durableRevision,
        text: "Normal composer request", updatedAt: "normal-draft" });
      assert.equal(saved.outcome, "saved");
      const normalDraft = (await f.bundle.stores.auxiliary.getAuxiliaryDraft(aux.id))!;
      const normal = f.captured("Normal composer request");
      normal.request.submitSource = "composer";
      normal.request.auxiliaryDraftIncarnation = normalDraft.incarnation;
      normal.request.auxiliaryDraftDurableRevision = normalDraft.durableRevision;
      await f.bundle.stores.queue.enqueue(owner, normal);
      const consumed = (await f.bundle.stores.auxiliary.getAuxiliaryDraft(aux.id))!;
      assert.equal(consumed.text, "");
      assert.equal(consumed.durableRevision, normalDraft.durableRevision + 1);
    }
  } finally { await f.dispose(); }
});

// @test-value v2
// kind = "contract"
// claim = "Mainの予約入力はcurrent turnへ一度だけ原子的に保存され、dispatch前復元と不明結果解放はcanonical turnを変えない"
// oracle = { type = "contract", ref = "Issue #801: selected queued current-turn input, atomic append, pre-provider restore and unknown hold" }
// fault = "provider turn IDとSQLite turn IDを同一視する、receiptだけcompletedにする、inputを二重appendする、stale ownerを受け入れる、またはinput解放でcurrent turnを中断する"
// observable = "Worker receipt state/inputTurnId、canonical message count/textとturn phase、例外"
// observation_boundary = "public-boundary"
// scope = "実Storage WorkerのMain queue claim/restoreとatomic steer append"
// lifecycle = "permanent"
// impact = "指示喪失・二重送信と現在turnの誤中断を防ぐ"
// distinction = "通常steerはqueue receiptを扱わず、実WorkerとSQLite triggerの失敗注入で原子境界を確認する"
// @end-test-value
test("Main queued inputはWorkerで原子的にappendし不明解放でcurrent turnを変えない", async () => {
  const f = await fixture();
  const db = new DatabaseSync(f.options.dbPath);
  try {
    const owner = { sessionId: f.session.id, incarnationId: f.session.incarnationId! };
    const original = f.captured("original");
    const receipt = await f.bundle.stores.queue.enqueue(owner, original);
    await f.bundle.stores.queue.claimNext(owner);
    const started = await f.bundle.stores.session.appendRunningTurnStart({ ...owner, expectedMessageCount: 0,
      userMessage: { role: "user", text: "original" }, updatedAt: "start", queuedTurn: { queueId: receipt.id, turn: f.turn(owner.sessionId) } });
    const turnId = String(started.queuedTurn!.id);
    const providerTurnId = "provider-turn";
    assert.notEqual(providerTurnId, turnId);
    const captured = f.captured("input");
    const queued = await f.bundle.stores.queue.enqueue(owner, captured);
    await assert.rejects(f.bundle.stores.queue.claimForInput({ ...owner, incarnationId: "stale" }, queued.id, providerTurnId), /incarnation mismatch/);
    await f.bundle.stores.queue.claimForInput(owner, queued.id, providerTurnId);
    await f.bundle.stores.queue.restoreQueuedInput(owner, queued.id, providerTurnId);
    assert.equal((await f.bundle.stores.queue.getReceipt(owner, queued.requestId))?.inputTurnId, null);
    await f.bundle.stores.queue.claimForInput(owner, queued.id, providerTurnId);
    await assert.rejects(f.bundle.stores.queue.markStarted(owner, queued.id, { turnId, userMessageSeq: 1 }), /not starting/);
    const append = { ...owner, expectedMessageCount: 1, turnId: Number(turnId), userMessage: { role: "user" as const, text: "input" },
      updatedAt: "input", queuedInput: { queueId: queued.id, inputTurnId: providerTurnId } };
    db.exec("CREATE TRIGGER fail_input BEFORE UPDATE ON session_turn_queue_v6 WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'input failed'); END");
    await assert.rejects(f.bundle.stores.session.appendSessionSteer(append), /input failed/);
    db.exec("DROP TRIGGER fail_input");
    assert.equal((await f.bundle.stores.session.getSessionMetadata(owner.sessionId))?.messageCount, 1);
    assert.equal((await f.bundle.stores.queue.getReceipt(owner, queued.requestId))?.state, "starting");
    await f.bundle.stores.session.appendSessionSteer(append);
    const completed = await f.bundle.stores.queue.claimForInput(owner, queued.id, providerTurnId);
    assert.equal(completed.state, "completed");
    assert.equal(completed.inputTurnId, providerTurnId);
    assert.equal(completed.turnId, turnId);
    await assert.rejects(f.bundle.stores.queue.restoreQueuedInput(owner, queued.id, providerTurnId), /cannot be restored/);
    assert.deepEqual((await f.bundle.stores.session.getSession(owner.sessionId))?.messages.map((m) => m.text), ["original", "input"]);
    const unknown = await f.bundle.stores.queue.enqueue(owner, f.captured("unknown"));
    await f.bundle.stores.queue.claimForInput(owner, unknown.id, providerTurnId);
    await f.bundle.stores.queue.settle(owner, unknown.id, "interrupted");
    await f.bundle.stores.queue.releaseInterrupted(owner, unknown.id, { runReleased: true });
    assert.equal((await f.bundle.stores.session.getSessionMetadata(owner.sessionId))?.summary.runState, "running");
    assert.equal((await f.bundle.stores.turn.getLatestSessionTurn(owner.sessionId))?.phase, "running");
  } finally { db.close(); await f.dispose(); }
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliary予約はdraftを受付と原子的に消費しtarget別にdedup、開始/入力/終端を既存履歴に保存し中断回復後に指定Auxだけ解放する"
// oracle = { type = "contract", ref = "Issue #801: durable Auxiliary queue, draft CAS, atomic start/input/terminal and explicit release" }
// fault = "別Auxにrequestが衝突、stale draftを消費、receiptと履歴が別commit、providerとSQLite turn IDを同一視、または指定Auxの解放で別Auxを変更する"
// observable = "Worker draft text/revision、receipt id/state、Aux message count/text、turn id/phase、再open後owner一覧"
// observation_boundary = "public-boundary"
// scope = "実Storage WorkerとSQLiteのAux queue受付・開始・入力・終端・再open・解放"
// lifecycle = "permanent"
// impact = "Auxiliaryの下書きと受付済み指示の喪失、二重実行を防ぐ"
// distinction = "Main queue testではAux createdAt identity、独立draftと親CASCADEを通らない"
// @end-test-value
test("Aux queueはdraft CASとtarget別dedupとatomic履歴をWorker再open後も保つ", async () => {
  const f = await fixture();
  const db = new DatabaseSync(f.options.dbPath);
  let reopened: ReturnType<typeof createV6StorageWorkerBundle> | undefined;
  try {
    const aux = await f.bundle.stores.auxiliary.upsertAuxiliarySession({ ...f.session, id: "aux", parentSessionId: f.session.id,
      title: "Aux", status: "active", runState: "idle", composerDraft: " queued\n", messages: [], displayAfterMessageIndex: null,
      characterId: undefined, characterRuntimeSnapshot: undefined, createdAt: "created", updatedAt: "created", closedAt: "" });
    const aux2 = await f.bundle.stores.auxiliary.upsertAuxiliarySession({ ...aux, id: "aux2", composerDraft: "queued" });
    const owner = { sessionId: aux.id, incarnationId: aux.createdAt };
    const writeOwner = { auxiliarySessionId: aux.id, parentSessionId: aux.parentSessionId, createdAt: aux.createdAt };
    const draft = (await f.bundle.stores.auxiliary.getAuxiliaryDraft(aux.id))!;
    const captured = f.captured("queued");
    captured.request.auxiliaryDraftIncarnation = draft.incarnation;
    captured.request.auxiliaryDraftDurableRevision = draft.durableRevision;
    captured.request.displayAnchorParentMessageCount = 2;
    await assert.rejects(f.bundle.stores.queue.enqueue(owner, { ...captured, request: { ...captured.request, userMessage: "different" } }), /stale/);
    assert.equal((await f.bundle.stores.auxiliary.getAuxiliaryDraft(aux.id))?.text, " queued\n");
    db.exec("CREATE TRIGGER fail_accept BEFORE INSERT ON session_turn_queue_v6 BEGIN SELECT RAISE(ABORT, 'accept failed'); END");
    await assert.rejects(f.bundle.stores.queue.enqueue(owner, captured), /accept failed/);
    db.exec("DROP TRIGGER fail_accept");
    assert.equal((await f.bundle.stores.auxiliary.getAuxiliaryDraft(aux.id))?.durableRevision, draft.durableRevision);
    const receipt = await f.bundle.stores.queue.enqueue(owner, captured);
    assert.equal((await f.bundle.stores.auxiliary.getAuxiliaryDraft(aux.id))?.text, "");
    assert.equal((await f.bundle.stores.queue.enqueue(owner, captured)).id, receipt.id);
    const draft2 = (await f.bundle.stores.auxiliary.getAuxiliaryDraft(aux2.id))!;
    const second = await f.bundle.stores.queue.enqueue({ sessionId: aux2.id, incarnationId: aux2.createdAt },
      { ...captured, request: { ...captured.request, auxiliaryDraftIncarnation: draft2.incarnation } });
    assert.notEqual(receipt.id, second.id);
    await f.bundle.stores.queue.claimNext(owner);
    const start = { ...writeOwner, expectedMessageCount: 0, userMessage: { role: "user" as const, text: "queued" }, updatedAt: "start",
      queuedTurn: { queueId: receipt.id, turn: f.turn(aux.id) } };
    db.exec("CREATE TRIGGER fail_start BEFORE UPDATE ON session_turn_queue_v6 WHEN NEW.state = 'running' BEGIN SELECT RAISE(ABORT, 'start failed'); END");
    await assert.rejects(f.bundle.stores.auxiliary.appendAuxiliaryRunningTurnStart(start), /start failed/);
    db.exec("DROP TRIGGER fail_start");
    assert.equal((await f.bundle.stores.auxiliary.getAuxiliarySessionMetadata(aux.id))?.messageCount, 0);
    assert.equal(await f.bundle.stores.turn.getLatestSessionTurn(aux.id), null);
    const started = (await f.bundle.stores.auxiliary.appendAuxiliaryRunningTurnStart(start))!;
    const turnId = String(started.queuedTurn!.id);
    const providerTurnId = "provider-turn";
    assert.notEqual(providerTurnId, turnId);
    assert.equal((await f.bundle.stores.queue.getReceipt(owner, receipt.requestId))?.turnId, turnId);
    const currentDraft = (await f.bundle.stores.auxiliary.getAuxiliaryDraft(aux.id))!;
    await f.bundle.stores.auxiliary.saveAuxiliaryDraft({ auxiliarySessionId: aux.id, parentSessionId: aux.parentSessionId,
      incarnation: currentDraft.incarnation, expectedDurableRevision: currentDraft.durableRevision, text: "steer", updatedAt: "draft-steer" });
    const nextDraft = (await f.bundle.stores.auxiliary.getAuxiliaryDraft(aux.id))!;
    const nextCaptured = f.captured("steer");
    nextCaptured.request.auxiliaryDraftIncarnation = nextDraft.incarnation;
    nextCaptured.request.auxiliaryDraftDurableRevision = nextDraft.durableRevision;
    const input = await f.bundle.stores.queue.enqueue(owner, nextCaptured);
    await f.bundle.stores.queue.claimForInput(owner, input.id, providerTurnId);
    const append = { ...writeOwner, expectedMessageCount: 1, turnId: Number(turnId), userMessage: { role: "user" as const, text: "steer" },
      updatedAt: "steer", queuedInput: { queueId: input.id, inputTurnId: providerTurnId } };
    assert.equal(await f.bundle.stores.auxiliary.appendAuxiliarySteer({ ...append, createdAt: "stale" }), null);
    await f.bundle.stores.auxiliary.appendAuxiliarySteer(append);
    const completedInput = await f.bundle.stores.queue.getReceipt(owner, input.requestId);
    assert.equal(completedInput?.state, "completed");
    assert.equal(completedInput?.inputTurnId, providerTurnId);
    assert.equal(completedInput?.turnId, turnId);
    const terminal = { ...writeOwner, expectedMessageCount: 2, assistantMessage: { role: "assistant" as const, text: "done" },
      updatedAt: "done", runState: "idle" as const, threadId: "thread", preview: "done", terminalCommit: {
        sessionId: aux.id, turnId: Number(turnId), phase: "completed" as const, assistantMessageSeq: 2,
        threadId: "thread", errorMessage: "", completedAt: "done" } };
    db.exec("CREATE TRIGGER fail_terminal BEFORE UPDATE ON session_turn_queue_v6 WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'terminal failed'); END");
    await assert.rejects(f.bundle.stores.auxiliary.appendAuxiliaryTerminal(terminal), /terminal failed/);
    db.exec("DROP TRIGGER fail_terminal");
    assert.equal((await f.bundle.stores.auxiliary.getAuxiliarySessionMetadata(aux.id))?.messageCount, 2);
    await f.bundle.stores.auxiliary.appendAuxiliaryTerminal(terminal);
    assert.equal((await f.bundle.stores.queue.getReceipt(owner, receipt.requestId))?.state, "completed");
    assert.deepEqual((await f.bundle.stores.auxiliary.getAuxiliarySession(aux.id))?.messages.map((m) => m.text), ["queued", "steer", "done"]);
    await f.bundle.stores.queue.claimNext({ sessionId: aux2.id, incarnationId: aux2.createdAt });
    const aux2Start = await f.bundle.stores.auxiliary.appendAuxiliaryRunningTurnStart({ ...start,
      auxiliarySessionId: aux2.id, queuedTurn: { queueId: second.id, turn: f.turn(aux2.id) } });
    assert.ok(aux2Start?.queuedTurn);
    await f.bundle.client.close();
    reopened = createV6StorageWorkerBundle(f.options);
    await reopened.initialize();
    assert.equal(await reopened.stores.queue.recoverInterrupted(), 1);
    const owner2 = { sessionId: aux2.id, incarnationId: aux2.createdAt };
    assert.deepEqual(await reopened.stores.queue.listPendingOwners(), [owner2]);
    await reopened.stores.queue.releaseInterrupted(owner2, second.id, { runReleased: false });
    assert.equal((await reopened.stores.auxiliary.getAuxiliarySessionMetadata(aux2.id))?.runState, "running");
    await reopened.stores.queue.releaseInterrupted(owner2, second.id, { runReleased: true });
    assert.equal((await reopened.stores.auxiliary.getAuxiliarySessionMetadata(aux2.id))?.runState, "error");
    assert.equal((await reopened.stores.auxiliary.getAuxiliarySessionMetadata(aux.id))?.runState, "idle");
    await reopened.stores.session.deleteSession(f.session.id);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM session_turn_queue_v6").get() as { n: number }).n, 0);
  } finally { db.close(); await reopened?.client.close(); await f.dispose(); }
});

// @test-value v2
// kind = "contract"
// claim = "既存Main queue schema更新はreceipt全列と受付順を維持し次の受付sequenceを進める"
// oracle = { type = "contract", ref = "Issue #801: existing durable Main queue receipts survive additive target schema migration" }
// fault = "table再構成で既存receiptやsequenceを失いcaptured requestまたはterminal状態を変更する"
// observable = "migration前後のSQLite全receipt列と次のsequence"
// observation_boundary = "public-boundary"
// scope = "ensureV6Schemaの旧Main queue table移行"
// lifecycle = "permanent"
// impact = "既存受付の喪失と二重実行を防ぐ"
// distinction = "fresh schema testは既存tableのinline UNIQUE変更と全行保存を検証しない"
// @end-test-value
test("旧Main queue schema移行はreceiptと受付順を保持する", async () => {
  const f = await fixture();
  const db = new DatabaseSync(f.options.dbPath);
  try {
    await f.bundle.client.close();
    db.exec(`DROP TABLE session_turn_queue_v6;
      CREATE TABLE session_turn_queue_v6 (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL, incarnation_id TEXT NOT NULL, request_id TEXT NOT NULL, state TEXT NOT NULL,
        captured_json TEXT NOT NULL, turn_id TEXT, user_message_seq INTEGER, reason TEXT, released_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(session_id, incarnation_id, request_id),
        FOREIGN KEY(session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE);`);
    db.prepare(`INSERT INTO session_turn_queue_v6 VALUES (42, 'receipt', ?, ?, 'request', 'interrupted', ?, '5', 3, 'unknown', 'released', 'created', 'updated')`)
      .run(f.session.id, f.session.incarnationId!, JSON.stringify(f.captured("keep")));
    db.prepare(`INSERT INTO session_turn_queue_v6 VALUES (80, 'deleted', ?, ?, 'deleted', 'completed', '{}', NULL, NULL, NULL, NULL, 'created', 'updated')`)
      .run(f.session.id, f.session.incarnationId!);
    db.exec("DELETE FROM session_turn_queue_v6 WHERE id = 'deleted'");
    const before = db.prepare("SELECT * FROM session_turn_queue_v6").get();
    ensureV6Schema(db);
    const after = db.prepare("SELECT * FROM session_turn_queue_v6").get() as Record<string, unknown>;
    const { auxiliary_session_id, input_turn_id, queue_position, ...retained } = after;
    assert.deepEqual(retained, { ...before });
    assert.equal(queue_position, 42);
    assert.equal(auxiliary_session_id, null);
    assert.equal(input_turn_id, null);
    ensureV6Schema(db);
    db.prepare(`INSERT INTO session_turn_queue_v6 (id,session_id,incarnation_id,request_id,state,captured_json,created_at,updated_at)
      VALUES ('next',?,?, 'next', 'queued', '{}', 'now','now')`).run(f.session.id, f.session.incarnationId!);
    assert.equal((db.prepare("SELECT sequence FROM session_turn_queue_v6 WHERE id = 'next'").get() as { sequence: number }).sequence, 81);
  } finally { db.close(); await f.dispose(); }
});
