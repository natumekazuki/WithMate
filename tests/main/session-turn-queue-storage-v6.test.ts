import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { SessionTurnStorageV6 } from "../../src-electron/session/session-turn-storage-v6.js";
import { SessionPersistenceService } from "../../src-electron/session/session-persistence-service.js";
import { SessionNotFoundError, SessionRunningTurnStartConflictError } from "../../src-electron/session/session-storage-errors.js";
import { SessionTurnQueueStorageV6 } from "../../src-electron/session/session-turn-queue-storage-v6.js";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { buildNewSession, getSessionIncarnationId } from "../../src-shared/session/session-state.js";
import type { SessionTurnQueueCapturedInput } from "../../src-shared/session/session-turn-queue.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { Session } from "../../src-shared/session/session-state.js";
import type { SessionTurnInput } from "../../src-shared/session/session-turn-state.js";

function newSession() {
  return buildNewSession({ id: "queue-main", taskTitle: "Queue", workspaceLabel: "workspace", workspacePath: "C:/workspace", branch: "main",
    characterId: "unknown", character: "Unknown", characterIconPath: "", characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE });
}

function input(userMessage = "First"): SessionTurnQueueCapturedInput {
  return { request: { userMessage, clientRequestId: randomUUID(), submitSource: "composer", executionOptions: captureSessionExecutionOptions(newSession()) },
    provider: "codex", workspacePath: "C:/workspace", attachments: [{ id: "file", kind: "file", source: "text", absolutePath: "C:/workspace/input.txt",
      displayPath: "input.txt", workspaceRelativePath: "input.txt", isOutsideWorkspace: false }] };
}

// @test-value v2
// kind = "contract"
// claim = "queued開始・終端はmessage・minimum turn・receiptを同一commitする。失敗はrollbackしpartial runtime/cacheを維持し、再起動・不明結果報告でも既知terminalを保持する"
// oracle = { type = "contract", ref = "GitHub Issue #801: atomic queued start/terminal; docs/design/database-schema.md: turn runtime incremental append" }
// fault = "queueとmessage/turnを別commit、旧ownerや異本文/seqを採用、partial runtimeをfull upsertへ渡す、または既知terminalをinterruptedへ退行させる"
// observable = "失敗後のSession/turn/receipt、成功後のmessageとturn id、partial runtime/cache、開始再照合と終端後再open/settleのreceipt"
// observation_boundary = "public-boundary"
// scope = "SessionPersistenceService.persistQueuedTurnStart と実SQLite start/terminal append、queue settle/recovery"
// lifecycle = "permanent"
// impact = "再起動後に受付と実行履歴が分離して二重実行・指示喪失することと既存履歴の破壊を防ぐ"
// distinction = "通常append testはqueue receiptを含まない。SQLite triggerでturn/receipt書込失敗を注入しreceiptまでの原子境界と既知終端保持を確認する"
// @end-test-value
test("queued開始・終端はmessage・minimum turn・receiptを原子的に保存して確定結果を保つ", async () => {
  const temporary = await mkdtemp(join(os.tmpdir(), "withmate-atomic-queue-start-"));
  const dbPath = join(temporary, "withmate-v6.db");
  const sessions = new SessionStorageV6(dbPath);
  const queue = new SessionTurnQueueStorageV6(dbPath);
  const turns = new SessionTurnStorageV6(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    const saved = sessions.insertSession({ ...newSession(), messages: [{ role: "user", text: "previous" }, { role: "assistant", text: "answer" }] });
    const owner = { sessionId: saved.id, incarnationId: getSessionIncarnationId(saved) };
    const captured = input("Queued prompt");
    const receipt = queue.enqueue(owner, captured);
    const options = captured.request.executionOptions;
    const turn: SessionTurnInput = { sessionId: saved.id, phase: "running", provider: captured.provider,
      model: options.model, reasoningEffort: options.reasoningEffort, approvalMode: options.approvalMode,
      sandboxMode: options.codexSandboxMode, userMessageSeq: 2, threadId: "", errorMessage: "", createdAt: "2026-10-10T00:00:00.000Z" };
    const start = { ...owner, expectedMessageCount: 2, userMessage: { role: "user" as const, text: captured.request.userMessage },
      updatedAt: turn.createdAt, queuedTurn: { queueId: receipt.id, turn } };
    assert.throws(() => sessions.appendRunningTurnStart(start), /not starting/);
    queue.claimNext(owner);
    assert.throws(() => sessions.appendRunningTurnStart({ ...start, incarnationId: "stale" }), SessionNotFoundError);
    assert.throws(() => sessions.appendRunningTurnStart({ ...start, expectedMessageCount: 1 }), SessionRunningTurnStartConflictError);
    assert.throws(() => sessions.appendRunningTurnStart({ ...start, userMessage: { role: "user", text: "different" } }), /captured request/);
    assert.throws(() => sessions.appendRunningTurnStart({ ...start, queuedTurn: { queueId: receipt.id, turn: { ...turn, userMessageSeq: 1 } } }), /captured request/);

    const runtime: Session = { ...saved, taskTitle: "stale title", status: "running", runState: "running", updatedAt: turn.createdAt,
      messages: [start.userMessage], messageCount: 3 };
    let cache: Session[] = [{ ...saved, messages: [], messageCount: 2 }];
    const beforeCache = structuredClone(cache);
    const broadcasts: string[][] = [];
    const service = new SessionPersistenceService({
      getSessions: () => cache, setSessions: (next) => { cache = next; }, getSession: () => cache[0]!,
      isSessionRunInFlight: () => true, getStoredSession: () => { throw new Error("Unexpected full read"); },
      upsertStoredSession: () => { throw new Error("Unexpected full write"); },
      appendStoredRunningTurnStart: (command) => sessions.appendRunningTurnStart(command),
      replaceStoredSessions: () => undefined, listStoredSessions: () => { throw new Error("Unexpected full list"); },
      getAppSettings: () => normalizeAppSettings({}), getModelCatalogSnapshot: () => ({ revision: 1, providers: [] }),
      syncSessionDependencies: () => undefined, clearSessionContextTelemetry: () => undefined,
      clearSessionBackgroundActivities: () => undefined, invalidateProviderSessionThread: () => undefined,
      closeSessionWindow: () => undefined, broadcastSessions: (ids) => broadcasts.push(Array.from(ids ?? [])),
    });
    for (const target of ["turn", "receipt"] as const) {
      db.exec(target === "turn"
        ? "CREATE TRIGGER fail_queue_start BEFORE INSERT ON session_turns_v6 BEGIN SELECT RAISE(ABORT, 'atomic start failed'); END"
        : "CREATE TRIGGER fail_queue_start BEFORE UPDATE ON session_turn_queue_v6 WHEN NEW.state = 'running' BEGIN SELECT RAISE(ABORT, 'atomic start failed'); END");
      await assert.rejects(service.persistQueuedTurnStart(runtime, 2, receipt.id, turn), /atomic start failed/);
      db.exec("DROP TRIGGER fail_queue_start");
      assert.deepEqual(sessions.getSession(saved.id)?.messages, saved.messages);
      assert.equal(sessions.getSession(saved.id)?.runState, saved.runState);
      assert.equal(turns.getLatestSessionTurn(saved.id), null);
      assert.equal(queue.getReceipt(owner, captured.request.clientRequestId)?.state, "starting");
      assert.deepEqual(cache, beforeCache);
      assert.deepEqual(broadcasts, []);
    }
    sessions.setSessionTitle(saved.id, owner.incarnationId, "Current title");
    const committed = await service.persistQueuedTurnStart(runtime, 2, receipt.id, turn);
    assert.equal(committed.session.taskTitle, "Current title");
    assert.equal(committed.session.messageCount, 3);
    assert.deepEqual(committed.session.messages, [start.userMessage]);
    assert.deepEqual(sessions.getSession(saved.id)?.messages.map(({ role, text }) => ({ role, text })),
      [...saved.messages, start.userMessage].map(({ role, text }) => ({ role, text })));
    assert.equal(turns.getLatestSessionTurn(saved.id)?.id, committed.turn.id);
    assert.equal(committed.turn.userMessageSeq, 2);
    const canonical = queue.getReceipt(owner, captured.request.clientRequestId)!;
    assert.equal(canonical.state, "running");
    assert.equal(canonical.turnId, String(committed.turn.id));
    assert.equal(canonical.userMessageSeq, 2);
    assert.deepEqual(queue.markStarted(owner, receipt.id, { turnId: canonical.turnId!, userMessageSeq: 2 }), canonical);
    assert.throws(() => queue.markStarted(owner, receipt.id, { turnId: "another", userMessageSeq: 2 }), /not starting/);
    assert.throws(() => queue.markStarted(owner, receipt.id, { turnId: canonical.turnId!, userMessageSeq: 1 }), /not starting/);
    assert.equal(cache[0]?.taskTitle, "Current title");
    assert.deepEqual(cache[0]?.messages, []);
    assert.deepEqual(broadcasts, [[saved.id]]);

    const terminal = { ...owner, expectedMessageCount: 3, assistantMessage: { role: "assistant" as const, text: "Done" },
      metadata: { status: "idle" as const, runState: "idle" as const, threadId: "thread", updatedAt: "2026-10-10T00:01:00.000Z" },
      terminalCommit: { sessionId: saved.id, turnId: committed.turn.id, phase: "completed" as const, assistantMessageSeq: 3,
        threadId: "thread", errorMessage: "", completedAt: "2026-10-10T00:01:00.000Z" } };
    db.exec("CREATE TRIGGER fail_queue_terminal BEFORE UPDATE ON session_turn_queue_v6 WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'atomic terminal failed'); END");
    assert.throws(() => sessions.appendSessionTerminal(terminal), /atomic terminal failed/);
    db.exec("DROP TRIGGER fail_queue_terminal");
    assert.equal(sessions.getSession(saved.id)?.messages.length, 3);
    assert.equal(sessions.getSession(saved.id)?.runState, "running");
    assert.equal(turns.getLatestSessionTurn(saved.id)?.phase, "running");
    assert.deepEqual(queue.getReceipt(owner, captured.request.clientRequestId), canonical);
    sessions.appendSessionTerminal(terminal);
    assert.equal(sessions.getSession(saved.id)?.messages.at(-1)?.text, "Done");
    assert.equal(turns.getLatestSessionTurn(saved.id)?.phase, "completed");
    const settled = queue.getReceipt(owner, captured.request.clientRequestId)!;
    assert.equal(settled.state, "completed");
    assert.deepEqual(queue.settle(owner, receipt.id, "completed", "late reply"), settled);
    assert.deepEqual(queue.settle(owner, receipt.id, "interrupted", "reply lost"), settled);
    assert.deepEqual(queue.releaseInterrupted(owner, receipt.id, { runReleased: true }), settled);
    assert.throws(() => queue.settle(owner, receipt.id, "failed"), /not executing/);
    const reopened = new SessionTurnQueueStorageV6(dbPath);
    try {
      assert.equal(reopened.recoverInterrupted(), 0);
      assert.deepEqual(reopened.getReceipt(owner, captured.request.clientRequestId), settled);
      assert.deepEqual(reopened.settle(owner, receipt.id, "interrupted"), settled);
    } finally { reopened.close(); }
  } finally {
    db.close(); turns.close(); queue.close(); sessions.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "不明queued turnの明示解除は実guard解放までSession runningを保持し、解放後は一致する最新turnだけをidle/interruptedへ収束させ後続を開始できる"
// oracle = { type = "contract", ref = "GitHub Issue #801: explicit unknown-result release after actual runtime guard release; docs/design/session-run-lifecycle.md: actual cancellation guard" }
// fault = "早期解除でSessionをidleへ変更、解放後もrunningを残す、古いreceiptが次turnを変更、または更新失敗でreleaseAtだけcommitする"
// observable = "解除前後・再open後のSession status/runState/thread/title、receipt releasedAt、minimum turn phase、後続claim/start"
// observation_boundary = "public-boundary"
// scope = "SessionTurnQueueStorageV6.releaseInterrupted 実SQLiteの明示解除と限定metadata CAS"
// lifecycle = "permanent"
// impact = "未終了処理への重複実行、解除後FIFOの永久停止、または新turnの誤った中断表示を防ぐ"
// distinction = "runtime guard testはDB metadataを観測しない。少量の実SQLiteで解放指示・transaction rollback・最新turn identityを確認する"
// @end-test-value
test("不明queued turnの解除は実解放後だけcurrent metadataを収束し過去receiptを再適用しない", async () => {
  const temporary = await mkdtemp(join(os.tmpdir(), "withmate-queue-release-"));
  const dbPath = join(temporary, "withmate-v6.db");
  const sessions = new SessionStorageV6(dbPath);
  const queue = new SessionTurnQueueStorageV6(dbPath);
  const turns = new SessionTurnStorageV6(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    const saved = sessions.insertSession({ ...newSession(), threadId: "keep-thread", taskTitle: "keep-title" });
    const owner = { sessionId: saved.id, incarnationId: getSessionIncarnationId(saved) };
    const startQueued = (captured: SessionTurnQueueCapturedInput, count: number) => {
      const receipt = queue.enqueue(owner, captured);
      assert.equal(queue.claimNext(owner)?.id, receipt.id);
      const options = captured.request.executionOptions;
      const result = sessions.appendRunningTurnStart({ ...owner, expectedMessageCount: count,
        userMessage: { role: "user", text: captured.request.userMessage }, updatedAt: "2026-10-10T00:00:00.000Z",
        queuedTurn: { queueId: receipt.id, turn: { sessionId: saved.id, phase: "running", provider: captured.provider,
          model: options.model, reasoningEffort: options.reasoningEffort, approvalMode: options.approvalMode,
          sandboxMode: options.codexSandboxMode, userMessageSeq: count, threadId: saved.threadId,
          errorMessage: "", createdAt: "2026-10-10T00:00:00.000Z" } } });
      return { receipt, turn: result.queuedTurn! };
    };
    const first = startQueued(input("First unknown"), 0);
    queue.recoverInterrupted();
    db.exec("CREATE TRIGGER fail_release BEFORE UPDATE ON sessions_v6 BEGIN SELECT RAISE(ABORT, 'release failed'); END");
    assert.throws(() => queue.releaseInterrupted(owner, first.receipt.id, { runReleased: true }), /release failed/);
    db.exec("DROP TRIGGER fail_release");
    assert.equal(queue.getReceipt(owner, first.receipt.requestId)?.releasedAt, null);
    assert.equal(sessions.getSession(saved.id)?.runState, "running");
    const early = queue.releaseInterrupted(owner, first.receipt.id, { runReleased: false });
    assert.ok(early.releasedAt);
    assert.equal(sessions.getSession(saved.id)?.runState, "running");
    const reopened = new SessionTurnQueueStorageV6(dbPath);
    try {
      assert.deepEqual(reopened.listPendingOwners(), [owner]);
      assert.throws(() => reopened.releaseInterrupted({ ...owner, incarnationId: "stale" }, first.receipt.id, { runReleased: true }), /incarnation mismatch/);
      assert.deepEqual(reopened.releaseInterrupted(owner, first.receipt.id, { runReleased: true }), early);
    } finally { reopened.close(); }
    const releasedSession = sessions.getSession(saved.id)!;
    assert.equal(releasedSession.status, "idle");
    assert.equal(releasedSession.runState, "interrupted");
    assert.equal(releasedSession.threadId, saved.threadId);
    assert.equal(releasedSession.taskTitle, saved.taskTitle);
    assert.equal(releasedSession.messages.length, 1);
    assert.equal(turns.getLatestSessionTurn(saved.id)?.phase, "running");
    assert.deepEqual(queue.listPendingOwners(), []);
    const second = startQueued(input("Next queued"), 1);
    assert.notEqual(second.turn.id, first.turn.id);
    queue.releaseInterrupted(owner, first.receipt.id, { runReleased: true });
    assert.equal(sessions.getSession(saved.id)?.runState, "running");
    assert.equal(queue.getReceipt(owner, first.receipt.requestId)?.state, "interrupted");
    assert.equal(queue.getReceipt(owner, second.receipt.requestId)?.state, "running");
  } finally {
    db.close(); turns.close(); queue.close(); sessions.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "受付receiptは再open後もcapture値と同request照合を保持し、FIFO・queued限定取消・不明結果保留を維持する"
// oracle = { type = "contract", ref = "GitHub Issue #801: durable ACK, immutable capture, FIFO, queued cancellation, uncertain outcome hold" }
// fault = "受付をメモリだけに保持、terminal再送を別受付にする、異payloadを許可、または不明な先頭を再実行する"
// observable = "再open後のreceipt・ページ・claim結果と拒否例外"
// observation_boundary = "public-boundary"
// scope = "SessionTurnQueueStorageV6の実SQLiteによる受付から終端・再起動回復"
// lifecycle = "permanent"
// impact = "ユーザー指示の消失、二重実行、不明結果の後続実行を防ぐ"
// distinction = "型・schema checkでは永続ACK、状態遷移と再起動後の照合結果を検証できない。単一DBの短いtestで確認する"
// @end-test-value
test("queue receipt はcapture・再送照合・FIFO・中断保留を永続化する", async () => {
  const temporary = await mkdtemp(join(os.tmpdir(), "withmate-turn-queue-"));
  const dbPath = join(temporary, "withmate-v6.db");
  const sessions = new SessionStorageV6(dbPath);
  let queue = new SessionTurnQueueStorageV6(dbPath);
  try {
    const session = sessions.insertSession(newSession());
    const owner = { sessionId: session.id, incarnationId: getSessionIncarnationId(session) };
    const firstInput = input();
    const original = structuredClone(firstInput);
    const first = queue.enqueue(owner, firstInput);
    firstInput.request.userMessage = "changed later";
    firstInput.attachments[0]!.absolutePath = "C:/workspace/other.txt";
    const second = queue.enqueue(owner, input("Second"));
    const third = queue.enqueue(owner, input("Third"));
    queue.cancelQueued(owner, third.id);
    queue.close();
    queue = new SessionTurnQueueStorageV6(dbPath);
    assert.deepEqual(queue.getReceipt(owner, original.request.clientRequestId), first);
    assert.equal(queue.enqueue(owner, original).id, first.id);
    assert.throws(() => queue.enqueue(owner, { ...original, request: { ...original.request, userMessage: "different" } }), /different payload/);
    assert.equal(queue.claimNext(owner)?.id, first.id);
    assert.equal(queue.claimNext(owner), null);
    assert.throws(() => queue.cancelQueued(owner, first.id), /Only a queued/);
    queue.markStarted(owner, first.id, { turnId: "turn-1", userMessageSeq: 0 });
    queue.close();
    queue = new SessionTurnQueueStorageV6(dbPath);
    assert.equal(queue.recoverInterrupted(), 1);
    assert.equal(queue.claimNext(owner), null);
    assert.equal(queue.getReceipt(owner, original.request.clientRequestId)?.state, "interrupted");
    const released = queue.releaseInterrupted(owner, first.id);
    assert.equal(released.state, "interrupted");
    assert.ok(released.releasedAt);
    queue.close();
    queue = new SessionTurnQueueStorageV6(dbPath);
    assert.deepEqual(queue.getReceipt(owner, original.request.clientRequestId), released);
    assert.equal(queue.claimNext(owner)?.id, second.id);
    queue.settle(owner, second.id, "completed");
    assert.equal(queue.claimNext(owner), null);
    assert.equal(queue.enqueue(owner, original).state, "interrupted");
    const page = queue.listReceipts(owner, { limit: 2 });
    assert.deepEqual(page.receipts.map((receipt) => receipt.id), [first.id, second.id]);
    assert.deepEqual(queue.listReceipts(owner, { cursor: page.nextCursor!, limit: 2 }).receipts.map((receipt) => receipt.state), ["canceled"]);
    assert.deepEqual(queue.listActive(owner).map((receipt) => receipt.id), [first.id]);
    sessions.deleteSession(session.id);
    const recreated = sessions.insertSession(newSession());
    assert.throws(() => queue.enqueue(owner, original), /incarnation mismatch/);
    const currentOwner = { sessionId: recreated.id, incarnationId: getSessionIncarnationId(recreated) };
    assert.deepEqual(queue.listReceipts(currentOwner).receipts, []);
    assert.notEqual(queue.enqueue(currentOwner, original).id, first.id);
  } finally {
    queue.close();
    sessions.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Queue APIを実storage Workerから利用でき、terminal receiptはWorker再open後も同受付として再照会できる"
// oracle = { type = "contract", ref = "GitHub Issue #801: durable queue receipt through existing storage Worker" }
// fault = "queue commandがWorker未登録、またはterminal受付の再openで喪失"
// observable = "Worker APIの受付id・state・pending ownerと再open後のreceipt"
// observation_boundary = "public-boundary"
// scope = "V6StorageWorkerBundle.stores.queue のcommand経路・structured clone・実SQLite永続化"
// lifecycle = "permanent"
// impact = "GUIからのQueue Turnが保存不能または再照会不能になることを防ぐ"
// distinction = "直接storage testではWorker allowlistとasync proxyを通らない。1 Workerのreopenだけを追加確認する"
// @end-test-value
test("queue store は実Worker経路で受付とterminal再照会を保持する", async () => {
  const temporary = await mkdtemp(join(os.tmpdir(), "withmate-turn-queue-worker-"));
  const options = { dbPath: join(temporary, "withmate-v6.db"), userDataPath: temporary,
    bundledModelCatalogPath: join(process.cwd(), "public", "model-catalog.json") };
  let bundle = createV6StorageWorkerBundle(options);
  try {
    await bundle.initialize();
    const session = await bundle.stores.session.insertSession(newSession());
    const owner = { sessionId: session.id, incarnationId: getSessionIncarnationId(session) };
    const captured = input();
    const receipt = await bundle.stores.queue.enqueue(owner, captured);
    assert.deepEqual(await bundle.stores.queue.listPendingOwners(), [owner]);
    assert.equal((await bundle.stores.queue.claimNext(owner))?.id, receipt.id);
    await bundle.stores.queue.markStarted(owner, receipt.id, { turnId: "worker-turn", userMessageSeq: 0 });
    await bundle.stores.queue.settle(owner, receipt.id, "canceled");
    await bundle.client.close();
    bundle = createV6StorageWorkerBundle(options);
    await bundle.initialize();
    const replay = await bundle.stores.queue.enqueue(owner, captured);
    assert.equal(replay.id, receipt.id);
    assert.equal(replay.state, "canceled");
    assert.deepEqual(await bundle.stores.queue.listPendingOwners(), []);
    await assert.rejects(bundle.stores.queue.enqueue({ ...owner, incarnationId: "stale" }, captured), /incarnation mismatch/);
  } finally {
    await bundle.client.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
