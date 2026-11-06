import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test, { mock } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { SessionTurnQueueStorageV6 } from "../../src-electron/session/session-turn-queue-storage-v6.js";
import { SessionTurnQueueService } from "../../src-electron/session/session-turn-queue-service.js";
import { MainSessionTurnQueueFacade } from "../../src-electron/app/main-session-turn-queue-facade.js";
import { buildNewSession, getSessionIncarnationId } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { SessionTurnQueueCapturedInput, SessionTurnQueueStore } from "../../src-shared/session/session-turn-queue.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";

async function fixture() {
  const temporary = await mkdtemp(join(os.tmpdir(), "withmate-queue-edit-"));
  const dbPath = join(temporary, "withmate-v6.db");
  const sessions = new SessionStorageV6(dbPath);
  const queue = new SessionTurnQueueStorageV6(dbPath);
  const session = sessions.insertSession(buildNewSession({ taskTitle: "Queue", workspaceLabel: "workspace", workspacePath: "C:/workspace", branch: "main",
    characterId: "character", character: "Character", characterIconPath: "", characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: "on-request" }));
  const owner = { sessionId: session.id, incarnationId: getSessionIncarnationId(session) };
  const capture = (userMessage: string): SessionTurnQueueCapturedInput => ({ request: { userMessage, clientRequestId: randomUUID(), submitSource: "composer",
    executionOptions: captureSessionExecutionOptions(session) }, attachments: [], provider: session.provider, workspacePath: session.workspacePath,
    origin: { kind: "gui", operation: "send", targetSessionId: owner.sessionId, targetIncarnationId: owner.incarnationId } });
  const store: SessionTurnQueueStore = {
    enqueue: async (...args) => queue.enqueue(...args), getReceipt: async (...args) => queue.getReceipt(...args),
    getReceiptById: async (...args) => queue.getReceiptById(...args),
    listActive: async (...args) => queue.listActive(...args), listReceipts: async (...args) => queue.listReceipts(...args),
    listPendingOwners: async () => queue.listPendingOwners(), claimNext: async (...args) => queue.claimNext(...args),
    claimForInput: async (...args) => queue.claimForInput(...args), restoreQueuedInput: async (...args) => queue.restoreQueuedInput(...args),
    markStarted: async (...args) => queue.markStarted(...args), settle: async (...args) => queue.settle(...args),
    cancelQueued: async (...args) => queue.cancelQueued(...args), updateQueued: async (...args) => queue.updateQueued(...args),
    reorderQueued: async (...args) => queue.reorderQueued(...args), recoverInterrupted: async () => queue.recoverInterrupted(),
    releaseInterrupted: async (...args) => queue.releaseInterrupted(...args),
  };
  return { sessions, queue, session, owner, capture, store, dbPath, temporary, close: async () => { queue.close(); sessions.close(); await rm(temporary, { recursive: true, force: true }); } };
}

// @test-value v2
// kind = "contract"
// claim = "後方queuedの編集は会話全体の開始を保留し、実行中と別ownerを継続させ、更新確定後は同じ識別子と設定を保って再開する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md: GUI Turn Queue; docs/design/electron-session-store.md: Turn Queue編集" }
// fault = "先行queuedを編集中にdispatchする、別ownerも停止する、編集で設定または受付識別子と順を置換する"
// observable = "dispatch済み本文列、queued receiptのID/requestID/sequence/queuePosition/captured、編集対象cancelとSteer拒否"
// observation_boundary = "public-boundary"
// scope = "SessionTurnQueueService編集とSQLite queue"
// lifecycle = "permanent"
// distinction = "既存queue drain/reorder testは編集pause中の実行継続と保存更新を扱わない"
// @end-test-value
test("後方queued編集中は対象会話だけを保留して更新後に同じreceiptで再開する", async () => {
  const f = await fixture();
  const dispatched: string[] = [];
  let finish!: () => void;
  const running = new Promise<void>((resolve) => { finish = resolve; });
  const service = new SessionTurnQueueService({ store: f.store, isRunInFlight: () => false, dispatch: async (receipt) => {
    dispatched.push(receipt.captured.request.userMessage);
    if (receipt.captured.request.userMessage === "running") await running;
    return { state: "completed" };
  } });
  try {
    await service.enqueue(f.owner, f.capture("running"));
    await setImmediate();
    const earlier = await service.enqueue(f.owner, f.capture("earlier"));
    const rear = await service.enqueue(f.owner, f.capture("rear"));
    assert.equal((await service.beginQueuedEdit(f.owner, rear.id, async () => {})).id, rear.id);
    finish();
    await setImmediate();
    service.reconcileKnownReceipt(rear);
    await setImmediate();
    assert.deepEqual(dispatched, ["running"]);
    await assert.rejects(service.cancelQueued(f.owner, rear.id), /being edited/);
    await assert.rejects(service.sendQueuedInput(f.owner, rear.id, "turn"), /being edited/);
    const other = f.sessions.insertSession({ ...f.session, id: "other", incarnationId: "other-incarnation" });
    await service.enqueue({ sessionId: other.id, incarnationId: getSessionIncarnationId(other) }, f.capture("independent"));
    await setImmediate();
    assert.deepEqual(dispatched, ["running", "independent"]);
    await service.reorderQueued(f.owner, [earlier.id, rear.id], [rear.id, earlier.id]);
    const updated = await service.updateQueued(f.owner, rear.id, async () => ({ userMessage: "edited", attachments: [] }));
    assert.deepEqual({ id: updated.id, requestId: updated.requestId, sequence: updated.sequence }, { id: rear.id, requestId: rear.requestId, sequence: rear.sequence });
    assert.equal(updated.queuePosition, earlier.queuePosition);
    assert.deepEqual(updated.captured, { ...rear.captured, request: { ...rear.captured.request, userMessage: "edited" } });
    assert.deepEqual(updated.accepted, rear.captured);
    assert.equal(updated.dispatched, null);
    await service.waitForPending();
    assert.deepEqual(dispatched, ["running", "independent", "edited", "earlier"]);
  } finally { finish(); await service.close(); await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "同じ受付の原文とclaim採用入力を別保存し、編集後も原文の再試行だけを受け付け、不明な過去原文を現在値で補わない"
// oracle = { type = "contract", ref = "GitHub Issue #832: 待機中の指示編集と再試行" }
// fault = "編集で再試行照合元を置換する、claim後に採用入力を失う、過去行の現在値を原文として返す"
// observable = "再open後のaccepted/dispatched/captured、再試行receipt ID、競合例外とID照会結果"
// observation_boundary = "public-boundary"
// scope = "SessionTurnQueueStorageV6のSQLite受付・編集・claim・終端・過去行読取"
// lifecycle = "permanent"
// impact = "再送による二重実行と送信原文の誤表示を防ぐ"
// distinction = "既存編集testのplanned本文とdispatch順だけでは不変原文と固定採用入力の永続性を検出できない"
// @end-test-value
test("受付原文とclaim採用入力は編集・取消・再open後も取り違えない", async () => {
  const f = await fixture();
  try {
    const sent = f.capture("sent @original");
    const receipt = f.queue.enqueue(f.owner, sent);
    assert.equal(f.queue.getReceiptById(f.owner, receipt.id)?.requestId, receipt.requestId);
    assert.equal(f.queue.getReceiptById(f.owner, "absent"), null);
    assert.throws(() => f.queue.getReceiptById({ ...f.owner, incarnationId: "old" }, receipt.id), /incarnation mismatch/);
    const planned = f.queue.updateQueued(f.owner, receipt.id, { userMessage: "edited", attachments: [] });
    assert.deepEqual(planned.accepted, sent);
    assert.equal(planned.dispatched, null);
    assert.equal(f.queue.enqueue(f.owner, sent).id, receipt.id);
    assert.throws(() => f.queue.enqueue(f.owner, planned.captured), /different payload/);
    const claimed = f.queue.claimNext(f.owner)!;
    assert.deepEqual(claimed.dispatched, planned.captured);
    assert.equal(f.queue.cancelQueued(f.owner, receipt.id).state, "starting");
    f.queue.settle(f.owner, receipt.id, "interrupted", "provider reply unknown");
    const reopened = new SessionTurnQueueStorageV6(f.dbPath);
    try {
      const saved = reopened.getReceipt(f.owner, receipt.requestId)!;
      assert.deepEqual(saved.accepted, sent);
      assert.deepEqual(saved.dispatched, planned.captured);
      assert.equal(reopened.enqueue(f.owner, sent).state, "interrupted");
    } finally { reopened.close(); }
    const db = new DatabaseSync(f.dbPath);
    try { db.prepare("UPDATE session_turn_queue_v6 SET accepted_json = NULL, dispatched_json = NULL WHERE id = ?").run(receipt.id); }
    finally { db.close(); }
    assert.equal(f.queue.getReceipt(f.owner, receipt.requestId)?.accepted, null);
    assert.equal(f.queue.getReceipt(f.owner, receipt.requestId)?.dispatched, null);
    assert.throws(() => f.queue.enqueue(f.owner, sent), /original.*unavailable/);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "同ms内の複数queue編集でも既存updatedAtを厳密前進させ、入力分割readが別の本文を混在させない変更検出値を持つ"
// oracle = { type = "contract", ref = "GitHub Issue #836: queue指示差分の分割取得中の変更検出" }
// fault = "同ms再編集で同じupdatedAtを返し古いcursorの続きに新本文を混ぜる"
// observable = "時刻固定下の2編集のreceipt.updatedAtとcaptured本文"
// observation_boundary = "public-boundary"
// scope = "SessionTurnQueueStorageV6.updateQueuedの既存更新時刻"
// lifecycle = "permanent"
// distinction = "通常の編集永続化testは同ms複数保存の更新識別を検証しない"
// @end-test-value
test("同msのqueue編集でもupdatedAtは厳密に前進する", async () => {
  const f = await fixture();
  try {
    const receipt = f.queue.enqueue(f.owner, f.capture("original"));
    mock.method(Date, "now", () => Date.parse(receipt.updatedAt));
    const first = f.queue.updateQueued(f.owner, receipt.id, { userMessage: "first", attachments: [] });
    const second = f.queue.updateQueued(f.owner, receipt.id, { userMessage: "second", attachments: [] });
    assert.ok(first.updatedAt > receipt.updatedAt);
    assert.ok(second.updatedAt > first.updatedAt);
    assert.equal(second.captured.request.userMessage, "second");
    assert.equal(second.accepted?.request.userMessage, "original");
  } finally { mock.restoreAll(); await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "編集失敗は停止を保持し、編集保存後も受付時入力の再試行は同じreceiptへ収束し、変更後入力でkeyを再利用できない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md: GUI Turn Queue編集の停止と再開; docs/design/electron-session-store.md: Turn Queue本文添付更新" }
// fault = "失敗時にqueueを再開する、取消で本文を消す、添付を旧本文のまま保存する、旧incarnation/read-onlyを更新する"
// observable = "保存receipt payload、dispatch本文列、保存呼出回数、preview引数、旧owner/read-only/state拒否"
// observation_boundary = "public-boundary"
// scope = "MainSessionTurnQueueFacade編集、Service pause、SQLite queued条件"
// lifecycle = "permanent"
// distinction = "受付preflight testは保存済みqueuedの本文添付更新と編集停止の解除条件を扱わない"
// @end-test-value
test("編集失敗は停止を保持し取消と成功時だけ再開する", async () => {
  const f = await fixture();
  let busy = true;
  let previewFails = true;
  let previewText = "";
  const dispatched: string[] = [];
  const service = new SessionTurnQueueService({ store: f.store, isRunInFlight: () => busy, dispatch: async (receipt) => {
    dispatched.push(receipt.captured.request.userMessage); return { state: "completed" };
  } });
  const attachment = { id: "new", kind: "file" as const, source: "text" as const, absolutePath: "C:/workspace/new.txt", displayPath: "new.txt", workspaceRelativePath: "new.txt", isOutsideWorkspace: false };
  const facade = new MainSessionTurnQueueFacade({ assertActive() {}, assertAccepting() {}, getSession: async (id) => f.sessions.getSession(id),
    getAppSettings: async () => createDefaultAppSettings(),
    validateWorkspace: async () => {}, validateProvider: async () => ({ provider: { id: "codex", label: "Codex", models: [], defaultModelId: "model", defaultReasoningEffort: "medium" } }),
    preview: async (_session, text) => { previewText = text; return { errors: previewFails ? ["attachment unavailable"] : [], attachments: [attachment] }; }, store: f.store, service });
  try {
    const original = await service.enqueue(f.owner, f.capture("original"));
    const edit = { incarnationId: f.owner.incarnationId, id: original.id };
    await assert.rejects(facade.beginQueuedSessionTurnEdit(f.session.id, { ...edit, incarnationId: "old" }), /identity changed/);
    await facade.beginQueuedSessionTurnEdit(f.session.id, edit);
    busy = false;
    await assert.rejects(facade.updateQueuedSessionTurn(f.session.id, { ...edit, userMessage: "new @new.txt" }), /attachment unavailable/);
    service.wake(f.session.id);
    await setImmediate();
    assert.deepEqual(dispatched, []);
    assert.deepEqual(f.queue.getReceipt(f.owner, original.requestId)?.captured, original.captured);
    previewFails = false;
    const save = f.store.updateQueued;
    let saves = 0;
    f.store.updateQueued = async () => { saves++; throw new Error("save failed"); };
    await assert.rejects(facade.updateQueuedSessionTurn(f.session.id, { ...edit, userMessage: "new @new.txt" }), /save failed/);
    assert.equal(saves, 1);
    service.wake(f.session.id);
    await setImmediate();
    assert.deepEqual(dispatched, []);
    assert.deepEqual(f.queue.getReceipt(f.owner, original.requestId)?.captured, original.captured);
    busy = true;
    await facade.cancelQueuedSessionTurnEdit(f.session.id, edit);
    assert.deepEqual(f.queue.getReceipt(f.owner, original.requestId)?.captured, original.captured);
    await facade.beginQueuedSessionTurnEdit(f.session.id, edit);
    busy = false;
    f.store.updateQueued = async (...args) => { saves++; await save(...args); throw new Error("save reply unknown"); };
    await assert.rejects(facade.updateQueuedSessionTurn(f.session.id, { ...edit, userMessage: "saved before reply loss" }), /save reply unknown/);
    assert.equal(saves, 2);
    service.reconcileKnownReceipt(f.queue.getReceipt(f.owner, original.requestId)!);
    await setImmediate();
    assert.deepEqual(dispatched, []);
    assert.equal(f.queue.getReceipt(f.owner, original.requestId)?.captured.request.userMessage, "saved before reply loss");
    await facade.cancelQueuedSessionTurnEdit(f.session.id, edit);
    await service.waitForPending();
    assert.deepEqual(dispatched, ["saved before reply loss"]);
    f.store.updateQueued = save;
    busy = true;
    const next = await service.enqueue(f.owner, f.capture("second"));
    const nextEdit = { ...edit, id: next.id };
    await facade.beginQueuedSessionTurnEdit(f.session.id, nextEdit);
    const updated = await facade.updateQueuedSessionTurn(f.session.id, { ...nextEdit, userMessage: "  new @new.txt  " });
    assert.equal(previewText, "new @new.txt");
    assert.deepEqual(updated.captured, { ...next.captured, request: { ...next.captured.request, userMessage: "new @new.txt" }, attachments: [attachment] });
    assert.equal((await facade.enqueueSessionTurn(f.session.id, { ...next.captured.request, incarnationId: f.owner.incarnationId })).id, next.id);
    await assert.rejects(facade.enqueueSessionTurn(f.session.id, { ...updated.captured.request, incarnationId: f.owner.incarnationId }), /different input/);
    assert.equal(f.queue.listReceipts(f.owner).receipts.length, 2);
    assert.throws(() => f.queue.updateQueued({ ...f.owner, incarnationId: "old" }, next.id, { userMessage: "bad", attachments: [] }), /incarnation mismatch/);
    f.sessions.updateSession({ ...f.session, accessMode: "legacy_readonly" });
    await assert.rejects(facade.beginQueuedSessionTurnEdit(f.session.id, nextEdit), /read-only/);
    f.sessions.updateSession(f.session);
    f.queue.claimNext(f.owner);
    assert.throws(() => f.queue.updateQueued(f.owner, next.id, { userMessage: "bad", attachments: [] }), /Only a queued/);
    await assert.rejects(facade.beginQueuedSessionTurnEdit(f.session.id, nextEdit), /Only a queued/);
  } finally { await service.close(); await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "Worker経由の編集は同じreceiptを更新し、SQLite書込失敗では本文添付がrollbackされ、他ownerと開始済み項目は更新しない"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md: Turn Queue本文添付の同一transaction更新" }
// fault = "Worker methodが未公開、部分的に本文だけ保存、他ownerまたはstarting receiptの編集を保存する"
// observable = "Worker更新replyとSQLite正本のcaptured、ID/requestID/sequence/queuePosition、失敗後payload、owner/state拒否"
// observation_boundary = "public-boundary"
// scope = "V6StorageWorkerBundle.stores.queue.updateQueued"
// lifecycle = "permanent"
// distinction = "直接storageやservice fixtureはWorker allowlistと実SQLite失敗時の原子性を保証しない"
// @end-test-value
test("Worker queue編集は本文添付を同じreceiptへ原子的に保存する", async () => {
  const f = await fixture();
  const bundle = createV6StorageWorkerBundle({ dbPath: f.dbPath, userDataPath: f.temporary });
  const db = new DatabaseSync(f.dbPath);
  try {
    await bundle.initialize();
    const receipt = await bundle.stores.queue.enqueue(f.owner, f.capture("original"));
    const attachment = { id: "new", kind: "file" as const, source: "text" as const, absolutePath: "C:/workspace/new.txt", displayPath: "new.txt", workspaceRelativePath: "new.txt", isOutsideWorkspace: false };
    const updated = await bundle.stores.queue.updateQueued(f.owner, receipt.id, { userMessage: "edited", attachments: [attachment] });
    assert.deepEqual(updated, { ...receipt, updatedAt: updated.updatedAt, captured: { ...receipt.captured, request: { ...receipt.captured.request, userMessage: "edited" }, attachments: [attachment] } });
    db.exec("CREATE TRIGGER reject_edit BEFORE UPDATE OF captured_json ON session_turn_queue_v6 BEGIN SELECT RAISE(ABORT, 'edit save failed'); END");
    await assert.rejects(bundle.stores.queue.updateQueued(f.owner, receipt.id, { userMessage: "partial", attachments: [] }), /edit save failed/);
    assert.deepEqual(f.queue.getReceipt(f.owner, receipt.requestId)?.captured, updated.captured);
    db.exec("DROP TRIGGER reject_edit");
    const other = f.sessions.insertSession({ ...f.session, id: "other", incarnationId: "other-incarnation" });
    await assert.rejects(bundle.stores.queue.updateQueued({ sessionId: other.id, incarnationId: getSessionIncarnationId(other) }, receipt.id, { userMessage: "wrong owner", attachments: [] }), /owner mismatch/);
    await bundle.stores.queue.claimNext(f.owner);
    await assert.rejects(bundle.stores.queue.updateQueued(f.owner, receipt.id, { userMessage: "too late", attachments: [] }), /Only a queued/);
    assert.deepEqual(f.queue.getReceipt(f.owner, receipt.requestId)?.captured, updated.captured);
  } finally { db.close(); await bundle.client.close(); await f.close(); }
});
