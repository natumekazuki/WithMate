import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { SessionTurnQueueService } from "../../src-electron/session/session-turn-queue-service.js";
import { buildNewSession, getSessionIncarnationId, type Session } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { SessionTurnQueueCapturedInput, SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";
import { executionOperationResultSchemas } from "../../src-shared/session/session-execution-read.js";
import { MainSessionTurnQueueFacade } from "../../src-electron/app/main-session-turn-queue-facade.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "withmate-delayed-delivery-"));
  const options = { dbPath: join(directory, "withmate-v6.db"), userDataPath: directory,
    workerUrl: new URL("../../src-electron/storage/storage-worker-entry.ts", import.meta.url),
    handlerModule: new URL("../../src-electron/storage/storage-worker-bundle.ts", import.meta.url),
    workerOptions: { execArgv: ["--import", "tsx"] } };
  let bundle = createV6StorageWorkerBundle(options);
  await bundle.initialize();
  const owner = (session: Session) => ({ sessionId: session.id, incarnationId: getSessionIncarnationId(session) });
  const create = (id: string) => bundle.stores.session.insertSession(buildNewSession({ id, taskTitle: id,
    workspaceLabel: "workspace", workspacePath: directory, branch: "main", characterId: "unknown", character: "Unknown",
    characterIconPath: "", characterThemeColors: { main: "#123456", sub: "#abcdef" }, approvalMode: "on-request" }));
  const turnInput = (session: Session, userMessageSeq: number) => ({ sessionId: session.id, phase: "running" as const,
    createdAt: new Date().toISOString(), provider: session.provider, model: session.model, reasoningEffort: session.reasoningEffort,
    approvalMode: session.approvalMode, sandboxMode: session.codexSandboxMode, threadId: "", errorMessage: "", userMessageSeq });
  async function start(session: Session) {
    const count = (await bundle.stores.session.getSessionMetadata(session.id))!.messageCount;
    await bundle.stores.session.appendRunningTurnStart({ ...owner(session), expectedMessageCount: count,
      userMessage: { role: "user", text: "source work" }, updatedAt: new Date().toISOString() });
    return bundle.stores.turn.createSessionTurn(turnInput(session, count));
  }
  async function finish(session: Session, turnId: number, phase: "completed" | "failed" | "canceled") {
    const count = (await bundle.stores.session.getSessionMetadata(session.id))!.messageCount;
    const time = new Date().toISOString();
    await bundle.stores.session.appendSessionTerminal({ ...owner(session), expectedMessageCount: count,
      assistantMessage: { role: "assistant", text: `saved ${phase}` },
      metadata: { status: "idle", runState: "idle", threadId: "", updatedAt: time },
      terminalCommit: { sessionId: session.id, turnId, phase, assistantMessageSeq: count,
        threadId: "", errorMessage: phase === "failed" ? "source failed" : "", completedAt: time } });
  }
  function input(recipient: Session, source: Session, sourceTurnId: number, timing: "immediate" | "after_source_turn" = "after_source_turn"): SessionTurnQueueCapturedInput {
    return { request: { clientRequestId: randomUUID(), userMessage: "report", submitSource: "composer",
      executionOptions: captureSessionExecutionOptions(recipient) }, attachments: [], provider: recipient.provider, workspacePath: directory,
      origin: { kind: "session", actorKind: "main", actorSessionId: source.id, actorIncarnationId: getSessionIncarnationId(source),
        actorTurnId: String(sourceTurnId), deliveryTiming: timing, operation: "send", targetSessionId: recipient.id,
        targetIncarnationId: getSessionIncarnationId(recipient) } };
  }
  function service(recipient: Session, dispatched: SessionTurnQueueReceipt[], getUnreleasedSourceTurnIds: () => readonly string[] = () => []) {
    return new SessionTurnQueueService({ store: bundle.stores.queue, isRunInFlight: () => false,
      getUnreleasedSourceTurnIds,
      sendInput: async () => { throw new Error("Unexpected Provider input."); },
      dispatch: async (receipt, onStarted) => {
        const count = (await bundle.stores.session.getSessionMetadata(recipient.id))!.messageCount;
        const started = await bundle.stores.session.appendRunningTurnStart({ ...owner(recipient), expectedMessageCount: count,
          userMessage: { role: "user", text: receipt.captured.request.userMessage }, updatedAt: new Date().toISOString(),
          queuedTurn: { queueId: receipt.id, turn: turnInput(recipient, count) } });
        assert.ok(started.queuedTurn);
        await onStarted({ turnId: String(started.queuedTurn.id), userMessageSeq: count });
        dispatched.push(receipt);
        await finish(recipient, started.queuedTurn.id, "completed");
        return { state: "completed" };
      } });
  }
  return { get bundle() { return bundle; }, owner, create, start, finish, input, service,
    async reopen() { await bundle.client.close(); bundle = createV6StorageWorkerBundle(options); await bundle.initialize(); },
    async close() { await bundle.client.close(); await rm(directory, { recursive: true, force: true }); } };
}

// @test-value v2
// kind = "contract"
// claim = "遅延報告は受付を返して送信元Turn保存までclaim/Steerを拒否し、後続即時入力を妨げず、exact Turn保存後wakeだけで通常Turnを実行する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#bound-session-api" }
// fault = "未保存報告を開始する、先頭待機で即時配送を塞ぐ、送信元の最新Turnまで待つ、またはwakeが実Workerで接続されない"
// observable = "receipt状態、claim/Steer拒否、dispatch順、保存された送信元本文/phase、dispatch originと宛先本文/receipt終端"
// observation_boundary = "public-boundary"
// scope = "SessionTurnQueueServiceと実Storage Worker/SQLiteの受付・source終端transaction・claim・宛先終端transaction"
// lifecycle = "permanent"
// distinction = "fake queue portやschema testでは実SQL条件とWorkerのwake引数転送および保存順を検証できない"
// @end-test-value
test("delayed delivery waits for exact saved source Turn without blocking immediate work", async () => {
  const f = await fixture();
  let queue: SessionTurnQueueService | undefined;
  try {
    const source = await f.create("source");
    const recipient = await f.create("recipient");
    const turn = await f.start(source);
    const dispatched: SessionTurnQueueReceipt[] = [];
    queue = f.service(recipient, dispatched);
    await queue.start();
    const captured = f.input(recipient, source, turn.id);
    const delayed = await queue.enqueue(f.owner(recipient), captured);
    assert.equal(delayed.state, "queued");
    assert.equal(delayed.sourceTurnPhase, "running");
    await queue.waitForPending();
    assert.equal(dispatched.length, 0);
    assert.equal(await f.bundle.stores.queue.claimNext(f.owner(recipient)), null);
    await assert.rejects(f.bundle.stores.queue.claimForInput(f.owner(recipient), delayed.id, "any"), /sender Turn/);
    assert.equal((await queue.enqueue(f.owner(recipient), captured)).id, delayed.id);
    await assert.rejects(queue.enqueue(f.owner(recipient), { ...captured, origin: { ...captured.origin!, deliveryTiming: "immediate" } }), /different payload/);
    assert.equal((await f.bundle.stores.queue.listReceipts(f.owner(recipient))).receipts.length, 1);
    const immediate = await queue.enqueue(f.owner(recipient), f.input(recipient, source, turn.id, "immediate"));
    await queue.waitForPending();
    assert.deepEqual(dispatched.map((receipt) => receipt.id), [immediate.id]);
    assert.equal((await f.bundle.stores.queue.getReceiptById(f.owner(recipient), delayed.id))?.state, "queued");
    await f.finish(source, turn.id, "completed");
    await f.start(source);
    assert.equal((await f.bundle.stores.turn.getLatestSessionTurn(source.id))?.phase, "running");
    assert.equal((await f.bundle.stores.session.getSession(source.id))?.messages[1]?.text, "saved completed");
    await queue.wakeSourceTurnDependents(source.id);
    await queue.waitForPending();
    assert.deepEqual(dispatched.map((receipt) => receipt.id), [immediate.id, delayed.id]);
    assert.equal(dispatched[1]?.dispatched?.origin?.sourceTurnPhase, "completed");
    const target = { kind: "main" as const, ...f.owner(recipient) };
    const execution = executionOperationResultSchemas.get_execution.parse(await f.bundle.stores.execution.execute({
      target, operation: "get_execution", request: { target, receiptId: delayed.id },
    }));
    assert.equal(execution.origin?.deliveryTiming, "after_source_turn");
    assert.equal(execution.origin?.sourceTurnPhase, "completed");
    assert.equal((await f.bundle.stores.queue.getReceiptById(f.owner(recipient), delayed.id))?.state, "completed");
    assert.equal((await f.bundle.stores.session.getSession(recipient.id))?.messages.length, 4);
  } finally { await queue?.close(); await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "保存済み失敗・取消も遅延配送を解除するが、不明状態・異incarnation・不明Turnは解除せず、取消済み配送は復活しない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#bound-session-api" }
// fault = "completedしか解除しない、unknownを成功扱いする、source identityを無視する、または取消済み報告を再実行する"
// observable = "実Workerのreceipt sourceTurnPhase、claim不可、失敗/取消保存後のdispatch origin、取消receipt状態"
// observation_boundary = "public-boundary"
// scope = "実SQLite source phase/identity条件とSessionTurnQueueServiceの再評価"
// lifecycle = "permanent"
// distinction = "completed正常系では失敗・取消とunknownの違い、identity不一致、取消済みの保持を検出できない"
// @end-test-value
test("source failure and cancellation release delivery but unknown identities do not", async () => {
  const f = await fixture();
  let queue: SessionTurnQueueService | undefined;
  try {
    const recipient = await f.create("recipient");
    const dispatched: SessionTurnQueueReceipt[] = [];
    queue = f.service(recipient, dispatched);
    await queue.start();
    for (const phase of ["failed", "canceled"] as const) {
      const source = await f.create(phase);
      const turn = await f.start(source);
      const receipt = await queue.enqueue(f.owner(recipient), f.input(recipient, source, turn.id));
      await queue.waitForPending();
      await f.finish(source, turn.id, phase);
      await queue.wakeSourceTurnDependents(source.id);
      await queue.waitForPending();
      assert.equal(dispatched.at(-1)?.id, receipt.id);
      assert.equal(dispatched.at(-1)?.dispatched?.origin?.sourceTurnPhase, phase);
    }
    const source = await f.create("unknown");
    const turn = await f.start(source);
    await f.bundle.stores.session.checkpointSessionRunMetadata({ ...f.owner(source),
      expected: { status: "running", runState: "running", threadId: "" },
      next: { status: "idle", runState: "interrupted", threadId: "", updatedAt: new Date().toISOString() } });
    const unknown = f.input(recipient, source, turn.id);
    const stale = f.input(recipient, source, turn.id);
    stale.origin!.actorIncarnationId = "old-incarnation";
    const missing = f.input(recipient, source, 999999);
    const absent = f.input(recipient, source, turn.id);
    absent.origin!.actorSessionId = "missing-session";
    for (const input of [unknown, stale, missing, absent]) {
      const receipt = await queue.enqueue(f.owner(recipient), input);
      assert.equal(receipt.sourceTurnPhase, "unknown");
    }
    await queue.waitForPending();
    assert.equal(await f.bundle.stores.queue.claimNext(f.owner(recipient)), null);
    const canceled = await f.bundle.stores.queue.getReceipt(f.owner(recipient), unknown.request.clientRequestId);
    assert.ok(canceled);
    await f.bundle.stores.queue.cancelQueued(f.owner(recipient), canceled.id);
    await f.finish(source, turn.id, "completed");
    await queue.wakeSourceTurnDependents(source.id);
    await queue.waitForPending();
    assert.equal(dispatched.length, 2);
    assert.equal((await f.bundle.stores.queue.getReceiptById(f.owner(recipient), canceled.id))?.state, "canceled");
  } finally { await queue?.close(); await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "再openした実Workerは保存済み送信元Turnの遅延受付を再評価し追加送信なしで実行する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#bound-session-api" }
// fault = "待機条件がmemoryだけに残るか起動時pending owner列挙から遅延受付が漏れる"
// observable = "close前queuedとreopen後同receiptのcompleted、dispatch一件と保存されたsource phase"
// observation_boundary = "public-boundary"
// scope = "Storage Worker close/reopenとSessionTurnQueueService.startの永続再評価"
// lifecycle = "permanent"
// distinction = "同processのwake正常系は保存済み受付とsource終端の再読込みを確認できない"
// @end-test-value
test("reopened Worker resumes saved eligible delayed receipt without another send", async () => {
  const f = await fixture();
  let queue: SessionTurnQueueService | undefined;
  try {
    const source = await f.create("source");
    const recipient = await f.create("recipient");
    const turn = await f.start(source);
    const receipt = await f.bundle.stores.queue.enqueue(f.owner(recipient), f.input(recipient, source, turn.id));
    assert.equal(await f.bundle.stores.queue.claimNext(f.owner(recipient)), null);
    await f.finish(source, turn.id, "completed");
    assert.equal((await f.bundle.stores.queue.getReceiptById(f.owner(recipient), receipt.id))?.state, "queued");
    await f.reopen();
    const dispatched: SessionTurnQueueReceipt[] = [];
    queue = f.service(recipient, dispatched);
    await queue.start();
    await queue.waitForPending();
    assert.deepEqual(dispatched.map((item) => item.id), [receipt.id]);
    assert.equal(dispatched[0]?.dispatched?.origin?.sourceTurnPhase, "completed");
    assert.equal((await f.bundle.stores.queue.getReceiptById(f.owner(recipient), receipt.id))?.state, "completed");
  } finally { await queue?.close(); await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "取消終端の保存後も実解放前の送信元Turnは配送/Steerを開始せず、即時入力を進め、解放後は別Turn実行中でも配送する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#bound-session-api; docs/design/session-run-lifecycle.md#session-run-cancel" }
// fault = "保存済canceledだけで実解放前にclaim/Steerする、待機を表示しない、または後続別Turnまで待つ"
// observable = "宛先のdispatch順、Steer拒否、公開queue/receiptのsourceTurnPendingRelease、実解放後の同receipt完了"
// observation_boundary = "public-boundary"
// scope = "実Worker/SQLiteとSessionTurnQueueService/MainSessionTurnQueueFacadeのruntime解放port接続"
// lifecycle = "permanent"
// impact = "取消待ちの送信元処理と宛先の成果物確認・変更が同時に走ることを防ぐ"
// distinction = "runtimeのguard testだけでは実SQLの適格条件・Steer・宛先queueのgateと表示投影を確認できない"
// @end-test-value
test("saved cancellation still waits for exact source execution release", async () => {
  const f = await fixture();
  let queue: SessionTurnQueueService | undefined;
  try {
    const source = await f.create("source");
    const recipient = await f.create("recipient");
    const turn = await f.start(source);
    let unreleased = [String(turn.id)];
    const dispatched: SessionTurnQueueReceipt[] = [];
    queue = f.service(recipient, dispatched, () => unreleased);
    await queue.start();
    const captured = f.input(recipient, source, turn.id);
    const delayed = await queue.enqueue(f.owner(recipient), captured);
    await queue.waitForPending();
    await f.finish(source, turn.id, "canceled");
    const immediate = await queue.enqueue(f.owner(recipient), f.input(recipient, source, turn.id, "immediate"));
    await queue.waitForPending();
    assert.deepEqual(dispatched.map((entry) => entry.id), [immediate.id]);
    await assert.rejects(queue.sendQueuedInput(f.owner(recipient), delayed.id, "receiver-turn"), /still releasing/);
    const facade = new MainSessionTurnQueueFacade({ store: f.bundle.stores.queue, service: queue,
      getUnreleasedSourceTurnIds: () => unreleased,
      assertActive() {}, assertAccepting() {}, getSession: (id) => f.bundle.stores.session.getSession(id),
      getAppSettings: async () => { throw new Error("Unused preflight"); },
      validateWorkspace: async () => {}, validateProvider: async () => { throw new Error("Unused preflight"); },
      preview: async () => ({ attachments: [], errors: [] }) });
    const waiting = await facade.getSessionTurnQueueReceipt(recipient.id, captured.request.clientRequestId);
    assert.equal(waiting?.state, "queued");
    assert.equal(waiting?.sourceTurnPhase, "canceled");
    assert.equal(waiting?.sourceTurnPendingRelease, true);
    assert.equal((await facade.listSessionTurnQueue(recipient.id)).find((entry) => entry.id === delayed.id)?.sourceTurnPendingRelease, true);
    unreleased = [];
    const next = await f.start(source);
    unreleased = [String(next.id)];
    await queue.wakeSourceTurnDependents(source.id);
    await queue.waitForPending();
    assert.deepEqual(dispatched.map((entry) => entry.id), [immediate.id, delayed.id]);
    assert.equal((await facade.getSessionTurnQueueReceipt(recipient.id, captured.request.clientRequestId))?.state, "completed");
  } finally { await queue?.close(); await f.close(); }
});
