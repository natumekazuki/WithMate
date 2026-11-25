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
       clearSessionContextTelemetry: () => undefined,
       invalidateProviderSessionThread: () => undefined,
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
// claim = "再open後も受付内容・同request照合・取消を維持し、照合不能なreceiptは再実行・FIFO保留せず、Crew削除では不明結果の証拠を残す"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#persistence-expectations" }
// fault = "受付をメモリだけに保持、terminal再送を別受付にする、異payloadを許可、または不明な先頭を再実行する"
// observable = "再open後のreceipt・ページ・claim結果、Crew削除と別incarnationの拒否"
// observation_boundary = "public-boundary"
// scope = "SessionTurnQueueStorageV6の実SQLiteによる受付から終端・再起動回復"
// lifecycle = "permanent"
// impact = "ユーザー指示の消失、二重実行、不明結果による待機の固定を防ぐ"
// distinction = "型・schema checkでは永続ACK、状態遷移と再起動後の照合結果を検証できない。単一DBの短いtestで確認する"
// @end-test-value
test("queue receiptはcapture・再送照合・FIFOと不明結果を永続化する", async () => {
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
    assert.deepEqual(first.captured, original);
    firstInput.request.userMessage = "changed later";
    firstInput.attachments[0]!.absolutePath = "C:/workspace/other.txt";
    const second = queue.enqueue(owner, input("Second"));
    const third = queue.enqueue(owner, input("Third"));
    queue.cancelQueued(owner, third.id);
    queue.close();
    queue = new SessionTurnQueueStorageV6(dbPath);
    assert.deepEqual(queue.getReceipt(owner, original.request.clientRequestId)?.captured, original);
    assert.deepEqual(queue.getReceipt(owner, original.request.clientRequestId), first);
    assert.equal(queue.enqueue(owner, original).id, first.id);
    assert.throws(() => queue.enqueue(owner, { ...original, request: { ...original.request, userMessage: "different" } }), /different payload/);
    assert.equal(queue.claimNext(owner)?.id, first.id);
    assert.equal(queue.claimNext(owner), null);
    assert.equal(queue.cancelQueued(owner, first.id).state, "starting");
    queue.markStarted(owner, first.id, { turnId: "turn-1", userMessageSeq: 0 });
    queue.close();
    queue = new SessionTurnQueueStorageV6(dbPath);
    assert.equal(queue.recoverInterrupted(), 1);
    const unresolved = queue.getReceipt(owner, original.request.clientRequestId);
    assert.equal(unresolved?.state, "interrupted");
    assert.equal(unresolved?.releasedAt, null);
    queue.close();
    queue = new SessionTurnQueueStorageV6(dbPath);
    assert.deepEqual(queue.getReceipt(owner, original.request.clientRequestId), unresolved);
    assert.equal(queue.claimNext(owner)?.id, second.id);
    queue.settle(owner, second.id, "completed");
    assert.equal(queue.claimNext(owner), null);
    assert.equal(queue.enqueue(owner, original).state, "interrupted");
    const page = queue.listReceipts(owner, { limit: 2 });
    assert.deepEqual(page.receipts.map((receipt) => receipt.id), [first.id, second.id]);
    assert.deepEqual(queue.listReceipts(owner, { cursor: page.nextCursor!, limit: 2 }).receipts.map((receipt) => receipt.state), ["canceled"]);
    assert.deepEqual(queue.listActive(owner).map((receipt) => receipt.id), [first.id]);
    assert.throws(() => sessions.deleteSession(session.id), /unresolved/);
    assert.throws(() => queue.enqueue({ ...owner, incarnationId: "stale" }, original), /incarnation mismatch/);
    assert.equal(queue.getReceipt(owner, original.request.clientRequestId)?.id, first.id);
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


// @test-value v2
// kind = "contract"
// claim = "起動回収は実開始を既存TurnのFailed一件へ収束し、旧保留のrelease時刻によらず入力・部分本文・Details・確定結果を保持する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#persistence-expectations" }
// fault = "旧保留だけを残す、別のownerまたはuser seqで確定する、成功をfailedへ変更する、通知と同文の実発言を削る、または部分内容を失う"
// observable = "隔離DB再open後のreceipt状態、Turn phaseと本文・artifact、次回claim順、再回収の件数"
// observation_boundary = "public-boundary"
// scope = "実SQLiteの開始・終端・旧保留・起動回収"
// lifecycle = "permanent"
// @end-test-value
test("起動回収は遺失・旧保留・確定成功を照合し、保存結果を書き潰さない", async () => {
  const temporary = await mkdtemp(join(os.tmpdir(), "withmate-turn-restart-"));
  const dbPath = join(temporary, "withmate-v6.db");
  const sessions = new SessionStorageV6(dbPath);
  let queue = new SessionTurnQueueStorageV6(dbPath);
  const turns = new SessionTurnStorageV6(dbPath);
  const db = new DatabaseSync(dbPath);
  const sameWords = "The previous run may have been interrupted when the app quit. Send again if needed.";
  const detail = { title: "Provider detail", activitySummary: ["Kept"], changedFiles: [], runChecks: [] };
  try {
    for (const scenario of ["running", "held", "released", "committed", "wrong-seq", "old-incarnation"] as const) {
      const session = sessions.insertSession({ ...newSession(), id: scenario, taskTitle: scenario, threadId: "thread",
        messages: [{ role: "user", text: sameWords }, { role: "assistant", text: sameWords, accent: true }] });
      const owner = { sessionId: session.id, incarnationId: getSessionIncarnationId(session) };
      const captured = input("Original start");
      const receipt = queue.enqueue(owner, captured);
      assert.equal(queue.claimNext(owner)?.id, receipt.id);
      const options = captured.request.executionOptions;
      const time = "2026-11-24T15:00:00.000Z";
      const start = sessions.appendRunningTurnStart({ ...owner, expectedMessageCount: 2, updatedAt: time,
        userMessage: { role: "user", text: "Original start" }, queuedTurn: { queueId: receipt.id, turn: {
          sessionId: session.id, phase: "running", threadId: "thread", userMessageSeq: 2, createdAt: time,
          provider: captured.provider, model: options.model, reasoningEffort: options.reasoningEffort,
          approvalMode: options.approvalMode, sandboxMode: options.codexSandboxMode, errorMessage: "" } } });
      const turnId = start.queuedTurn!.id;
      const pending = [queue.enqueue(owner, input("Second")), queue.enqueue(owner, input("Third"))];
      const markLegacy = (released: string | null) => db.prepare(
        "UPDATE session_turn_queue_v6 SET state='interrupted', released_at=? WHERE id=?").run(released, receipt.id);
      if (scenario === "held" || scenario === "released") {
        markLegacy(scenario === "held" ? null : time);
        db.prepare("UPDATE sessions_v6 SET runtime_policy_json=json_set(runtime_policy_json,'$.runState','interrupted','$.appStatus','idle') WHERE id=?")
          .run(session.id);
        const text = "Partial reply\n\nThe app stopped before this Turn finished.";
        db.prepare("INSERT INTO session_messages_v6(session_id,seq,role,body,artifact_body,created_at) VALUES (?,3,'assistant',?,?,?)")
          .run(session.id, JSON.stringify({ role: "assistant", text, artifact: detail }), JSON.stringify(detail), time);
        db.prepare("UPDATE session_turns_v6 SET assistant_message_seq=3 WHERE id=?").run(turnId);
      } else if (scenario === "wrong-seq") {
        markLegacy(null);
        db.prepare("UPDATE session_turn_queue_v6 SET user_message_seq=0 WHERE id=?").run(receipt.id);
      } else if (scenario === "old-incarnation") {
        markLegacy(null);
        db.prepare("UPDATE session_turn_queue_v6 SET incarnation_id='retired' WHERE id=?").run(receipt.id);
        db.prepare("UPDATE sessions_v6 SET runtime_policy_json=json_set(runtime_policy_json,'$.runState','idle','$.appStatus','idle') WHERE id=?")
          .run(session.id);
      } else if (scenario === "committed") {
        sessions.appendSessionTerminal({ ...owner, expectedMessageCount: 3,
          assistantMessage: { role: "assistant", text: sameWords, artifact: detail, accent: true },
          metadata: { status: "idle", runState: "idle", threadId: "thread", updatedAt: time },
          terminalCommit: { turnId, sessionId: session.id, phase: "completed", assistantMessageSeq: 3,
            threadId: "thread", completedAt: time, errorMessage: "" } });
        markLegacy(null); // Stale receipt alongside a real saved terminal.
      }
      queue.close();
      queue = new SessionTurnQueueStorageV6(dbPath);
      queue.recoverInterrupted();
      const actual = queue.getReceipt(owner, receipt.requestId);
      const savedTurn = turns.getLatestSessionTurn(session.id);
      const savedSession = sessions.getSession(session.id)!;
      assert.equal(savedTurn?.id, turnId);
      assert.deepEqual(savedSession.messages.slice(0, 3).map((message) => message.text), [sameWords, sameWords, "Original start"]);
      assert.equal(savedSession.threadId, "thread");
      assert.equal(savedSession.taskTitle, scenario);
      if (scenario === "old-incarnation" || scenario === "wrong-seq") {
        assert.equal(actual?.state ?? null, scenario === "old-incarnation" ? null : "interrupted");
        assert.equal(savedTurn?.phase, "running");
        assert.equal(savedTurn?.completedAt, undefined);
        assert.equal(savedSession.messages.length, 3);
        if (scenario === "old-incarnation") assert.equal((db.prepare("SELECT state FROM session_turn_queue_v6 WHERE id=?").get(receipt.id) as { state: string }).state, "interrupted");
      } else {
        const phase = scenario === "committed" ? "completed" : "failed";
        assert.equal(actual?.state, phase);
        assert.equal(savedTurn?.phase, phase);
        assert.equal(savedTurn?.assistantMessageSeq, 3);
        assert.ok(savedTurn?.completedAt);
        assert.equal(savedSession.runState, phase === "completed" ? "idle" : "error");
        assert.equal(savedSession.messages.length, 4);
        assert.equal(savedSession.messages[3]?.text,
          scenario === "running" ? "" : scenario === "committed" ? sameWords : "Partial reply\n\nThe app stopped before this Turn finished.");
        assert.equal(savedSession.messages[3]?.runFailure, phase === "completed" ? undefined : actual?.reason);
        if (scenario !== "running") assert.deepEqual(sessions.getSessionMessageArtifact(session.id, 3), {
          ...detail, detailAvailable: undefined, operationTimeline: undefined,
        });
      }
      assert.equal(queue.recoverInterrupted(), 0);
      assert.deepEqual(sessions.getSession(session.id)?.messages, savedSession.messages);
      const additional = queue.enqueue(owner, input("New input"));
      for (const expected of [...pending, additional]) {
        assert.equal(queue.claimNext(owner)?.id, expected.id);
        queue.settle(owner, expected.id, "completed");
      }
      assert.equal(queue.claimNext(owner), null);
    }
  } finally {
    db.close(); turns.close(); queue.close(); sessions.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
