import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CoordinationStorageV7 } from "../../src-electron/coordination/coordination-storage-v7.js";
import { listCrewCoordinationBlockers } from "../../src-electron/coordination/coordination-schema-v7.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { SessionTurnQueueStorageV6 } from "../../src-electron/session/session-turn-queue-storage-v6.js";
import { buildNewSession, getSessionIncarnationId } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { CoordinationApplicationService } from "../../src-electron/coordination/coordination-application-service.js";
import type { CoordinationIdentity, CoordinationRecord, CoordinationResult } from "../../src-shared/coordination/coordination-contract.js";
import { SessionRuntimeService } from "../../src-electron/session/session-runtime-service.js";
import { sessionSummaryToSession } from "../../src-electron/session/session-summary-adapter.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { composeProviderPrompt } from "../../src-electron/providers/provider-prompt.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";

const record = (result: CoordinationResult): CoordinationRecord => { assert.ok("record" in result); return result.record; };

// @test-value v2
// kind = "contract"
// claim = "取り下げ後の回答を原文revisionと共に一度だけ保存し、実runtimeは現在状態を反映したclaim固定入力で原子的開始・Provider配送・終端する"
// oracle = { type = "contract", ref = "GitHub Issue #838 sections 3-5,7" }
// fault = "回答とqueueを別transactionへ分離、取り下げ回答を拒否、再送二重配送、またはdispatch時に古い状態を渡す"
// observable = "実SQLiteのrecord.answersとreceipt原文/予定/固定本文、実runtimeのProvider入力と開始/終端message、Crew blocker、consume拒否"
// observation_boundary = "public-boundary"
// scope = "CoordinationStorageV7.execute、SessionTurnQueueStorageV6、SessionRuntimeServiceとMain atomic start/terminalの実SQLite連携"
// lifecycle = "permanent"
// impact = "判断情報の喪失とユーザー回答の二重配送を防ぐ"
// distinction = "既存queue testはCoordinationの回答revision・取り下げ状態と同一transactionを扱わない"
// @end-test-value
test("Coordination answers survive withdrawal and atomic queue acceptance", async () => {
  const temporary = await mkdtemp(join(os.tmpdir(), "withmate-coordination-"));
  const dbPath = join(temporary, "withmate-v6.db");
  const sessions = new SessionStorageV6(dbPath);
  const source = sessions.insertSession(buildNewSession({ id: "origin", taskTitle: "Origin", workspaceLabel: "Workspace", workspacePath: "C:/workspace", branch: "main", characterId: "unknown", character: "Unknown", characterIconPath: "", characterThemeColors: { main: "#123456", sub: "#234567" }, approvalMode: DEFAULT_APPROVAL_MODE, model: "test-model", reasoningEffort: "medium" }));
  const actor = { kind: "main" as const, sessionId: source.id, incarnationId: getSessionIncarnationId(source), turnId: "1" };
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare("INSERT INTO session_turns_v6(id,session_id,phase,started_at,updated_at) VALUES(1,?,'completed','now','now')").run(source.id);
  const store = new CoordinationStorageV7(dbPath);
  const queue = new SessionTurnQueueStorageV6(dbPath);
  const user = { kind: "user" as const };
  const captured = (operationId: string) => ({ request: { clientRequestId: operationId, userMessage: "ignored", executionOptions: captureSessionExecutionOptions(source) }, attachments: [], provider: source.provider, workspacePath: source.workspacePath });
  try {
    const createId = randomUUID();
    const original = record(store.execute({ actor, request: { operation: "create", operationId: createId, kind: "blocker", body: "Which?", choices: ["A", "B"], respondent: user, deliver: true } }));
    assert.equal(listCrewCoordinationBlockers(db, [{ id: source.id, kind: "main" }]).length, 1);
    assert.equal(listCrewCoordinationBlockers(db, [{ id: source.id, kind: "auxiliary" }]).length, 0);
    const answerId = randomUUID();
    const answer = { operation: "answer" as const, operationId: answerId, id: original.id, body: "A is correct", selectedChoices: ["A"], expectedAnswerRevision: 0, send: true };
    db.exec("CREATE TRIGGER reject_coordination_queue BEFORE INSERT ON session_turn_queue_v6 BEGIN SELECT RAISE(ABORT,'queue rejected'); END");
    assert.throws(() => store.execute({ actor: user, request: answer, delivery: { target: actor, captured: captured(answerId) } }), /queue rejected/);
    assert.equal(record(store.execute({ actor, request: { operation: "get", id: original.id } })).answers.length, 0);
    db.exec("DROP TRIGGER reject_coordination_queue");
    store.execute({ actor, request: { operation: "withdraw", operationId: randomUUID(), id: original.id, reason: "Already solved" } });
    const accepted = store.execute({ actor: user, request: answer, delivery: { target: actor, captured: captured(answerId) } });
    assert.ok("receipt" in accepted && accepted.receipt);
    assert.equal(accepted.record.state, "withdrawn");
    assert.equal(accepted.record.answers[0]?.actor.kind, "user");
    const retry = store.execute({ actor: user, request: answer });
    assert.ok("receipt" in retry && retry.receipt);
    assert.equal(retry.receipt.id, accepted.receipt.id);
    assert.equal(queue.listReceipts(actor).receipts.length, 1);
    store.execute({ actor, request: { operation: "withdraw", operationId: randomUUID(), id: original.id, reason: "New reason" } });
    const dispatched = queue.claimNext(actor)!;
    assert.equal(JSON.parse(dispatched.dispatched!.request.userMessage).withdrawalReason, "New reason");
    assert.equal(JSON.parse(dispatched.accepted!.request.userMessage).withdrawalReason, "Already solved");
    const beforeRun = structuredClone(dispatched);
    let live: LiveSessionRunState | null = null;
    let providerCalls = 0;
    const catalog = { id: source.provider, label: source.provider, defaultModelId: source.model, defaultReasoningEffort: source.reasoningEffort,
      models: [{ id: source.model, label: source.model, reasoningEfforts: [source.reasoningEffort] }] };
    const runtime = new SessionRuntimeService({ getSession: async (id) => sessions.getSession(id),
      persistRunningTurnStart: () => { throw new Error("Coordination must use atomic queued start"); },
      persistQueuedTurnStart: async (next, count, queueId, turn) => {
        const saved = sessions.appendRunningTurnStart({ sessionId: next.id, incarnationId: getSessionIncarnationId(next), expectedMessageCount: count,
          userMessage: next.messages.at(-1)!, updatedAt: next.updatedAt, queuedTurn: { queueId, turn } });
        return { session: { ...sessionSummaryToSession(saved.summary), messages: next.messages, messageCount: count + 1 }, turn: saved.queuedTurn! };
      },
      appendRunningInput: () => { throw new Error("Unexpected additional input"); },
      appendTerminalSession: async (next, terminalCommit) => {
        const saved = sessions.appendSessionTerminal({ sessionId: next.id, incarnationId: getSessionIncarnationId(next), expectedMessageCount: (next.messageCount ?? next.messages.length) - 1,
          assistantMessage: next.messages.at(-1)!, metadata: { status: next.status, runState: next.runState, threadId: next.threadId, updatedAt: next.updatedAt }, terminalCommit });
        return { ...sessionSummaryToSession(saved.summary), messages: next.messages, messageCount: saved.messageCount };
      },
      checkpointRuntimeMetadata: async (next) => next, assertCapturedComposerAttachmentsAvailable: async () => {},
      resolveComposerPreview: async () => { throw new Error("Queued input must not be recaptured"); }, getAppSettings: () => createDefaultAppSettings(),
      resolveProviderCatalog: () => ({ snapshot: { providers: [catalog] }, provider: catalog }),
      getProviderCodingAdapter: () => ({ composePrompt: composeProviderPrompt, getProviderQuotaTelemetry: async () => null,
        invalidateSessionThread: async () => {}, invalidateAllSessionThreads: async () => {},
        runSessionTurn: async (input) => {
          providerCalls++;
          assert.equal(JSON.parse(input.userMessage).withdrawalReason, "New reason");
          assert.equal(input.inputProvenance?.originalChanged, true);
          assert.equal(input.inputProvenance?.coordinationOperation, "answer");
          return { assistantText: "received current withdrawal state", threadId: "thread", usage: null };
        } }),
      createSessionTurn: () => { throw new Error("Queue must create its Turn atomically"); }, updateSessionTurn: () => {},
      setLiveSessionRun: (_id, value) => { live = value; }, getLiveSessionRun: () => live,
      waitForApprovalDecision: () => "deny", waitForElicitationResponse: () => ({ action: "cancel" }),
      setProviderQuotaTelemetry() {}, setSessionContextTelemetry() {}, invalidateProviderSessionThread() {}, scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {}, resolvePendingApprovalRequest() {}, resolvePendingElicitationRequest() {},
    });
    assert.deepEqual(await runtime.runQueuedSessionTurn(dispatched, async (input) => { queue.markStarted(actor, dispatched.id, input); }), { state: "completed" });
    assert.equal(providerCalls, 1);
    const finished = queue.getReceipt(actor, answerId)!;
    assert.equal(finished.state, "completed");
    assert.equal(sessions.getSession(source.id)?.messages[0]?.text, dispatched.dispatched!.request.userMessage);
    assert.deepEqual(finished.accepted, beforeRun.accepted);
    assert.deepEqual(finished.captured, beforeRun.captured);
    assert.deepEqual(finished.dispatched, beforeRun.dispatched);
    assert.equal(listCrewCoordinationBlockers(db, [{ id: source.id, kind: "main" }]).length, 0);
    const consume = { operation: "consume" as const, operationId: randomUUID(), id: original.id, answerId, answerRevision: 1 };
    store.execute({ actor, request: consume });
    store.execute({ actor, request: consume });
    assert.throws(() => store.execute({ actor, request: { ...consume, operationId: randomUUID() } }), /already consumed/);
    assert.throws(() => store.execute({ actor, request: { ...answer, operationId: randomUUID(), expectedAnswerRevision: 1 } }), /assigned respondent/);
    assert.throws(() => store.execute({ actor: { ...actor, incarnationId: "stale" } as CoordinationIdentity & { turnId: string }, request: { operation: "get", id: original.id } }), /deleted or replaced/);
  } finally { queue.close(); store.close(); sessions.close(); db.close(); await rm(temporary, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "contract"
// claim = "保存された実呼出元だけへ相談を届け、同一identityでユーザーへ引き継いだ回答は作成親でなく元の起票Sessionへ返る"
// oracle = { type = "contract", ref = "GitHub Issue #838 sections 1-3,6" }
// fault = "caller申告の宛先を採用、引継ぎで起票元を変更、担当者へ取下げ権限を付与、またはユーザー回答を担当Agentへ配送する"
// observable = "保存recordのcaller/initiator/respondent、返答receiptのowner、権限外取下げと異宛先起票の拒否"
// observation_boundary = "public-boundary"
// scope = "CoordinationStorageV7の保存origin解決・引継ぎ・通常queue返信"
// lifecycle = "permanent"
// impact = "相談相手の取り違えと無権限状態変更を防ぐ"
// distinction = "通常enqueue testでは相談の固定起票元と可変担当者の異なる経路を検証しない"
// @end-test-value
test("Coordination escalation retains original initiator and exact saved caller", async () => {
  const temporary = await mkdtemp(join(os.tmpdir(), "withmate-coordination-routing-"));
  const dbPath = join(temporary, "withmate-v6.db");
  const sessions = new SessionStorageV6(dbPath);
  const create = (id: string) => sessions.insertSession(buildNewSession({ id, taskTitle: id, workspaceLabel: "Workspace", workspacePath: "C:/workspace", branch: "main", characterId: "unknown", character: "Unknown", characterIconPath: "", characterThemeColors: { main: "#123456", sub: "#234567" }, approvalMode: DEFAULT_APPROVAL_MODE }));
  const a = create("caller"), b = create("initiator"), stranger = create("stranger");
  const actor = (session: typeof a, turnId: string) => ({ kind: "main" as const, sessionId: session.id, incarnationId: getSessionIncarnationId(session), turnId });
  const caller = actor(a, "1"), initiator = actor(b, "2"), other = actor(stranger, "3");
  const db = new DatabaseSync(dbPath);
  for (const value of [caller, initiator, other]) db.prepare("INSERT INTO session_turns_v6(id,session_id,phase,started_at,updated_at) VALUES(?,?,'completed','now','now')").run(value.turnId, value.sessionId);
  const captured = (session: typeof a, operationId: string) => ({ request: { clientRequestId: operationId, userMessage: "request", executionOptions: captureSessionExecutionOptions(session) }, attachments: [], provider: session.provider, workspacePath: session.workspacePath });
  const queue = new SessionTurnQueueStorageV6(dbPath);
  const originId = randomUUID();
  const origin = queue.enqueue(initiator, { ...captured(b, originId), origin: { kind: "session", actorKind: "main", actorSessionId: a.id, actorIncarnationId: caller.incarnationId, actorTurnId: caller.turnId, operation: "send", targetSessionId: b.id, targetIncarnationId: initiator.incarnationId } });
  db.prepare("UPDATE session_turn_queue_v6 SET state='completed',turn_id='2' WHERE id=?").run(origin.id);
  const store = new CoordinationStorageV7(dbPath);
  try {
    const operationId = randomUUID();
    assert.throws(() => store.execute({ actor: initiator, request: { operation: "create", operationId: randomUUID(), kind: "escalation", body: "Question", choices: [], respondent: { kind: other.kind, sessionId: other.sessionId, incarnationId: other.incarnationId }, deliver: true }, delivery: { target: other, captured: captured(stranger, randomUUID()) } }), /saved actual caller/);
    const created = store.execute({ actor: initiator, request: { operation: "create", operationId, kind: "escalation", body: "Question", choices: [], deliver: true }, delivery: { target: caller, captured: captured(a, operationId) } });
    assert.ok("receipt" in created && created.receipt);
    assert.equal(created.receipt.sessionId, a.id);
    const id = created.record.id;
    assert.throws(() => store.execute({ actor: caller, request: { operation: "withdraw", operationId: randomUUID(), id, reason: "Not mine" } }), /originating/);
    const escalated = record(store.execute({ actor: caller, request: { operation: "escalate", operationId: randomUUID(), id, body: "Need user decision" } }));
    assert.equal(escalated.id, id);
    assert.equal(escalated.initiator.sessionId, b.id);
    assert.equal(escalated.respondent.kind, "user");
    const answerId = randomUUID();
    const response = store.execute({ actor: { kind: "user" }, request: { operation: "answer", operationId: answerId, id, body: "Proceed", selectedChoices: [], expectedAnswerRevision: 0, send: true }, delivery: { target: initiator, captured: captured(b, answerId) } });
    assert.ok("receipt" in response && response.receipt);
    assert.equal(response.receipt.sessionId, b.id);
    assert.equal(response.record.originReceiptId, origin.id);
    assert.equal(response.record.caller?.sessionId, a.id);
  } finally { store.close(); queue.close(); sessions.close(); db.close(); await rm(temporary, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "contract"
// claim = "未対応相談はstorage Worker再起動後も同じidentityで参照でき、保存後の通知失敗で回答受付を失敗扱いせず、存在しない記録はtyped削除結果として識別できる"
// oracle = { type = "contract", ref = "GitHub Issue #838 sections 1,6" }
// fault = "Worker command未登録、再起動時の相談消失、または通知例外で確定受付を失敗応答に変換する"
// observable = "Worker経由list/getのidentity、Application回答のreceipt、再取得した回答本文、欠落get/listのCOORDINATION_DELETED code"
// observation_boundary = "public-boundary"
// scope = "V6StorageWorkerBundle.coordinationとCoordinationApplicationService.executeUser"
// lifecycle = "permanent"
// impact = "閉じたWindowから判断依頼が消えることと確定回答の誤再送を防ぐ"
// distinction = "直接SQLite testではWorkerのallowlist・structured clone・再起動と保存後通知の境界を通らない"
// @end-test-value
test("Coordination Worker restart and failed notification preserve accepted answer", async () => {
  const temporary = await mkdtemp(join(os.tmpdir(), "withmate-coordination-worker-"));
  const options = { dbPath: join(temporary, "withmate-v6.db"), userDataPath: temporary, bundledModelCatalogPath: join(process.cwd(), "public", "model-catalog.json") };
  let bundle = createV6StorageWorkerBundle(options);
  try {
    await bundle.initialize();
    const source = await bundle.stores.session.insertSession(buildNewSession({ id: "worker-origin", taskTitle: "Origin", workspaceLabel: "Workspace", workspacePath: "C:/workspace", branch: "main", characterId: "unknown", character: "Unknown", characterIconPath: "", characterThemeColors: { main: "#123456", sub: "#234567" }, approvalMode: DEFAULT_APPROVAL_MODE }));
    const db = new DatabaseSync(options.dbPath);
    db.prepare("INSERT INTO session_turns_v6(id,session_id,phase,started_at,updated_at) VALUES(1,?,'completed','now','now')").run(source.id); db.close();
    const actor = { kind: "main" as const, sessionId: source.id, incarnationId: getSessionIncarnationId(source), turnId: "1" };
    const created = record(await bundle.stores.coordination.execute({ actor, request: { operation: "create", operationId: randomUUID(), kind: "user_decision_required", body: "Please decide", choices: [], deliver: true } }));
    await bundle.client.close();
    bundle = createV6StorageWorkerBundle(options); await bundle.initialize();
    const pending = await bundle.stores.coordination.execute({ actor, request: { operation: "list", allCrews: true, userPending: true, offset: 0, limit: 50 } });
    assert.ok("items" in pending); assert.equal(pending.items[0]?.id, created.id); assert.equal(pending.items[0]?.bodyPreview, "Please decide");
    let notifications = 0;
    const service = new CoordinationApplicationService({ getStore: () => bundle.stores.coordination, prepareDelivery: async (_target, operationId) => ({ request: { clientRequestId: operationId, userMessage: "ignored", executionOptions: captureSessionExecutionOptions(source) }, attachments: [], provider: source.provider, workspacePath: source.workspacePath }), onAccepted: () => { notifications++; throw new Error("notification unavailable"); } });
    const answered = await service.executeUser({ operation: "answer", operationId: randomUUID(), id: created.id, body: "Proceed", selectedChoices: [], expectedAnswerRevision: 0, send: true }, () => true);
    assert.ok("receipt" in answered && answered.receipt); assert.equal(notifications, 1);
    const saved = record(await bundle.stores.coordination.execute({ actor, request: { operation: "get", id: created.id } }));
    assert.equal(saved.answers[0]?.body, "Proceed"); assert.equal(saved.answers[0]?.receiptId, answered.receipt.id);
    const deleted = (error: unknown) => error instanceof Error && "code" in error && error.code === "COORDINATION_DELETED";
    await assert.rejects(service.executeUser({ operation: "get", id: "missing-record" }, () => true), deleted);
    await assert.rejects(service.executeUser({ operation: "list", allCrews: true, mainSessionId: "deleted-main", offset: 0, limit: 50 }, () => true), deleted);
  } finally { await bundle.client.close(); await rm(temporary, { recursive: true, force: true }); }
});
