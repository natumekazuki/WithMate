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
import { composeProviderInput, composeProviderPrompt } from "../../src-electron/providers/provider-prompt.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import { SessionExecutionReadStorage } from "../../src-electron/storage/session-execution-read.js";
import { executionOperationResultSchemas } from "../../src-shared/session/session-execution-read.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";

const record = (result: CoordinationResult): CoordinationRecord => { assert.ok("record" in result); return result.record; };

// @test-value v2
// kind = "contract"
// claim = "取り下げ後の回答を一度だけ自然文として保存し、構造化通知を分けてProviderへ渡し、Turn入力保存と回答取得済みを一体で確定する"
// oracle = { type = "contract", ref = "docs/design/database-schema.md#coordination" }
// fault = "回答とqueueを別transactionへ分離、再送で二重配送、Turn保存の失敗後も取得済みにする、またはTurn保存後も回答変更を許す"
// observable = "実SQLiteの自然文と受付/採用通知、開始保存失敗時のrollback、Providerへの自然文と別context、新旧保存本文の再読込と原文を変えないexecution投影、取得後の変更拒否"
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
    store.execute({ actor: user, request: { operation: "withdraw", operationId: randomUUID(), id: original.id, reason: "New reason" } });
    const dispatched = queue.claimNext(actor)!;
    assert.equal(record(store.execute({ actor: user, request: { operation: "get", id: original.id } })).answers[0]?.acquiredAt, undefined);
    assert.equal(dispatched.dispatched!.request.userMessage, "A is correct");
    assert.equal(dispatched.accepted!.request.userMessage, "A is correct");
    assert.equal(dispatched.dispatched!.coordination?.notification?.withdrawalReason, "New reason");
    assert.equal(dispatched.accepted!.coordination?.notification?.withdrawalReason, "Already solved");
    assert.equal(dispatched.dispatched!.coordination?.notification?.answer?.revision, 1);
    const beforeRun = structuredClone(dispatched);
    const queuedInput = dispatched.dispatched!;
    const options = queuedInput.request.executionOptions;
    const turnCountBefore = (db.prepare("SELECT count(*) AS n FROM session_turns_v6 WHERE session_id=?").get(source.id) as { n: number }).n;
    db.exec("CREATE TRIGGER reject_main_queue_start BEFORE UPDATE ON session_turn_queue_v6 WHEN NEW.state = 'running' BEGIN SELECT RAISE(ABORT, 'main start failed'); END");
    assert.throws(() => sessions.appendRunningTurnStart({ sessionId: source.id, incarnationId: actor.incarnationId, expectedMessageCount: 0,
      userMessage: { role: "user", text: queuedInput.request.userMessage }, updatedAt: "start", queuedTurn: { queueId: dispatched.id,
        turn: { sessionId: source.id, phase: "running", provider: queuedInput.provider, model: options.model, reasoningEffort: options.reasoningEffort,
          approvalMode: options.approvalMode, sandboxMode: options.codexSandboxMode, userMessageSeq: 0, threadId: "", errorMessage: "", createdAt: "start" } } }), /main start failed/);
    db.exec("DROP TRIGGER reject_main_queue_start");
    assert.equal(record(store.execute({ actor: user, request: { operation: "get", id: original.id } })).answers[0]?.acquiredAt, undefined);
    assert.equal(sessions.getSession(source.id)?.messages.length, 0);
    assert.equal((db.prepare("SELECT count(*) AS n FROM session_turns_v6 WHERE session_id=?").get(source.id) as { n: number }).n, turnCountBefore);
    assert.equal(queue.getReceipt(actor, answerId)?.state, "starting");
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
          assert.ok(record(store.execute({ actor: user, request: { operation: "get", id: original.id } })).answers[0]?.acquiredAt);
          assert.equal(input.userMessage, "A is correct");
          assert.equal(input.inputProvenance?.coordination?.withdrawalReason, "New reason");
          assert.equal(input.inputProvenance?.coordination?.coordinationId, original.id);
          assert.equal(input.inputProvenance?.coordination?.answer?.revision, 1);
          assert.deepEqual(input.inputProvenance?.coordination?.answer?.selectedChoices, ["A"]);
          const prompt = composeProviderInput(input.userMessage, input.inputProvenance);
          assert.equal(prompt.split("# User Input\n\n")[1], "A is correct");
          assert.match(prompt.split("# User Input")[0], /"withdrawalReason": "New reason"/);
          assert.equal(input.inputProvenance?.originalChanged, false);
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
    assert.equal(sessions.getSession(source.id)?.messages[0]?.text, "A is correct");
    assert.deepEqual(finished.accepted, beforeRun.accepted);
    assert.deepEqual(finished.captured, beforeRun.captured);
    assert.deepEqual(finished.dispatched, beforeRun.dispatched);
    const executions = new SessionExecutionReadStorage(dbPath);
    try {
      const target = { kind: "main" as const, sessionId: source.id, incarnationId: actor.incarnationId };
      const get = () => executionOperationResultSchemas.get_execution.parse(executions.execute({ target, operation: "get_execution", request: { target, messageSeq: 0 } }));
      assert.deepEqual(get().coordination, { id: original.id, text: "A is correct" });
      // Reproduce a released saved input, not a migration of the user's database.
      const legacy = structuredClone(beforeRun.dispatched!);
      legacy.request.userMessage = JSON.stringify(legacy.coordination!.notification);
      delete legacy.coordination!.notification;
      db.prepare("UPDATE session_turn_queue_v6 SET captured_json=?,accepted_json=?,dispatched_json=? WHERE id=?").run(JSON.stringify(legacy), JSON.stringify(legacy), JSON.stringify(legacy), finished.id);
      db.prepare("UPDATE session_messages_v6 SET body=json_set(body,'$.text',?) WHERE session_id=? AND seq=0").run(legacy.request.userMessage, source.id);
      assert.deepEqual(get().coordination, { id: original.id, text: "A is correct" });
      assert.deepEqual(get().origin, legacy.origin);
      assert.equal(sessions.getSession(source.id)?.messages[0]?.text, legacy.request.userMessage);
      const input = executionOperationResultSchemas.get_execution_input.parse(executions.execute({ target, operation: "get_execution_input", request: { target, messageSeq: 0, stage: "original" } }));
      assert.equal(input.text, legacy.request.userMessage);
    } finally { executions.close(); }
    assert.equal(listCrewCoordinationBlockers(db, [{ id: source.id, kind: "main" }]).length, 0);
    assert.throws(() => store.execute({ actor: user, request: { ...answer, operationId: randomUUID(), expectedAnswerRevision: 1, body: "Changed" } }), /already received/);
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
// claim = "保存された実呼出元だけへ相談を届け、未取得回答の引継ぎでは旧配送を退けて理由と元の起票Sessionを保つ"
// oracle = { type = "contract", ref = "docs/design/database-schema.md#coordination" }
// fault = "宛先や起票元を取り違える、引継ぎ時に未取得の旧回答を配送する、または引継ぎ理由を失う"
// observable = "保存recordのcaller/initiator/respondentと引継ぎ理由、相談配送の自然文と別通知、旧形式受付の不変原文と自然文dispatch、旧receipt取消、ユーザー回答receiptのowner、権限外操作の拒否"
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
  for (const value of [caller, initiator, other]) db.prepare("INSERT INTO session_turns_v6(id,session_id,phase,user_message_seq,started_at,updated_at) VALUES(?,?,'completed',0,'now','now')").run(value.turnId, value.sessionId);
  const captured = (session: typeof a, operationId: string) => ({ request: { clientRequestId: operationId, userMessage: "request", executionOptions: captureSessionExecutionOptions(session) }, attachments: [], provider: session.provider, workspacePath: session.workspacePath });
  const queue = new SessionTurnQueueStorageV6(dbPath);
  const originId = randomUUID();
  const origin = queue.enqueue(initiator, { ...captured(b, originId), origin: { kind: "session", actorKind: "main", actorSessionId: a.id, actorIncarnationId: caller.incarnationId, actorTurnId: caller.turnId, operation: "send", targetSessionId: b.id, targetIncarnationId: initiator.incarnationId } });
  db.prepare("UPDATE session_turn_queue_v6 SET state='completed',turn_id='2',user_message_seq=0 WHERE id=?").run(origin.id);
  const store = new CoordinationStorageV7(dbPath);
  try {
    const operationId = randomUUID();
    assert.throws(() => store.execute({ actor: initiator, request: { operation: "create", operationId: randomUUID(), kind: "escalation", body: "Question", choices: [], respondent: { kind: other.kind, sessionId: other.sessionId, incarnationId: other.incarnationId }, deliver: true }, delivery: { target: other, captured: captured(stranger, randomUUID()) } }), /saved actual caller/);
    const created = store.execute({ actor: initiator, request: { operation: "create", operationId, kind: "escalation", body: "Question", choices: [], deliver: true }, delivery: { target: caller, captured: captured(a, operationId) } });
    assert.ok("receipt" in created && created.receipt);
    assert.equal(created.receipt.sessionId, a.id);
    assert.equal(created.receipt.captured.request.userMessage, "Question");
    assert.equal(created.receipt.captured.coordination?.notification?.coordinationId, created.record.id);
    assert.equal(created.receipt.captured.coordination?.notification?.operation, "create");
    // Released preview histories stored the complete notification as userMessage.
    const legacy = structuredClone(created.receipt.captured);
    const legacyNotification = legacy.coordination!.notification!;
    legacy.request.userMessage = JSON.stringify(legacyNotification);
    delete legacy.coordination!.notification;
    db.prepare("UPDATE session_turn_queue_v6 SET captured_json=?,accepted_json=? WHERE id=?").run(JSON.stringify(legacy), JSON.stringify(legacy), created.receipt.id);
    const deliveredQuestion = queue.claimNext(caller)!;
    assert.deepEqual(deliveredQuestion.accepted, legacy);
    assert.equal(deliveredQuestion.dispatched!.request.userMessage, "Question");
    assert.equal(deliveredQuestion.dispatched!.coordination?.notification?.state, "open");
    const id = created.record.id;
    assert.throws(() => store.execute({ actor: caller, request: { operation: "withdraw", operationId: randomUUID(), id, reason: "Not mine" } }), /originating/);
    const preliminaryId = randomUUID();
    const preliminary = store.execute({ actor: caller, request: { operation: "answer", operationId: preliminaryId, id, body: "Preliminary", selectedChoices: [], expectedAnswerRevision: 0, send: true }, delivery: { target: initiator, captured: captured(b, preliminaryId) } });
    assert.ok("receipt" in preliminary && preliminary.receipt);
    const escalated = record(store.execute({ actor: caller, request: { operation: "escalate", operationId: randomUUID(), id, body: "Need user decision" } }));
    assert.equal(escalated.id, id);
    assert.equal(escalated.initiator.sessionId, b.id);
    assert.equal(escalated.respondent.kind, "user");
    assert.equal(escalated.escalationBody, "Need user decision");
    assert.deepEqual(escalated.answers, []);
    assert.equal(queue.getReceipt(initiator, preliminaryId)?.state, "canceled");
    const answerId = randomUUID();
    const response = store.execute({ actor: { kind: "user" }, request: { operation: "answer", operationId: answerId, id, body: "Proceed", selectedChoices: [], expectedAnswerRevision: escalated.answerRevision, send: true }, delivery: { target: initiator, captured: captured(b, answerId) } });
    assert.ok("receipt" in response && response.receipt);
    assert.equal(response.receipt.sessionId, b.id);
    assert.equal(response.record.originReceiptId, origin.id);
    assert.equal(response.record.caller?.sessionId, a.id);
  } finally { store.close(); queue.close(); sessions.close(); db.close(); await rm(temporary, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "contract"
// claim = "Coordinationの既定相談先と元受付はTurn開始入力の保存originに一致し、受付順を逆転したGUI Steerも独立した追加入力として取得できる"
// oracle = { type = "contract", ref = "GitHub Issue #929 目的と影響・受入条件" }
// fault = "受付sequenceの早い追加入力を開始受付と取り違え、親から開始した依頼をユーザー担当へ変更する"
// observable = "deliveryTarget、保存recordのcaller/respondent/originReceiptId、配送receiptのSession、追加receiptのTurn対応と保存原文、異なる回答担当の拒否"
// observation_boundary = "public-boundary"
// scope = "実SQLiteのreorderQueued・claimNext・appendRunningTurnStart・claimForInput・appendSessionSteerからCoordination起票と実行入力読取まで"
// lifecycle = "permanent"
// impact = "実呼出元への相談の不達と不要なユーザー対応待ちを防ぎ、追加依頼の原文を保持する"
// distinction = "既存のCoordination testは正常順の手動Turn関連付けであり、Queue実行順と受付順の逆転を通らない。少量の隔離SQLiteで三つの開始条件を比較する"
// @end-test-value
test("Coordination uses the Turn start receipt after reordered GUI Steer", async () => {
  const temporary = await mkdtemp(join(os.tmpdir(), "withmate-coordination-start-"));
  const dbPath = join(temporary, "withmate-v6.db");
  const sessions = new SessionStorageV6(dbPath);
  const queue = new SessionTurnQueueStorageV6(dbPath);
  const store = new CoordinationStorageV7(dbPath);
  const executions = new SessionExecutionReadStorage(dbPath);
  const create = (id: string, parentSessionId?: string) => sessions.insertSession({ ...buildNewSession({ id, taskTitle: id,
    workspaceLabel: "Workspace", workspacePath: "C:/workspace", branch: "main", characterId: "unknown", character: "Unknown",
    characterIconPath: "", characterThemeColors: { main: "#123456", sub: "#234567" }, approvalMode: DEFAULT_APPROVAL_MODE }),
    ...(parentSessionId ? { parentSessionId, rootSessionId: parentSessionId, createdBySessionId: parentSessionId,
      sessionRole: "executor" as const } : { sessionRole: "overall-coordinator" as const }) });
  const identity = (session: ReturnType<typeof create>) => ({ kind: "main" as const, sessionId: session.id, incarnationId: getSessionIncarnationId(session) });
  const captured = (session: ReturnType<typeof create>, text: string, operationId = randomUUID()) => ({
    request: { clientRequestId: operationId, userMessage: text, executionOptions: captureSessionExecutionOptions(session) },
    attachments: [], provider: session.provider, workspacePath: session.workspacePath });
  const start = (session: ReturnType<typeof create>, receiptId: string) => {
    const claimed = queue.claimNext(identity(session))!;
    assert.equal(claimed.id, receiptId);
    const input = claimed.dispatched!;
    const options = input.request.executionOptions;
    const started = sessions.appendRunningTurnStart({ ...identity(session), expectedMessageCount: 0,
      userMessage: { role: "user", text: input.request.userMessage }, updatedAt: "2026-11-08T00:00:00.000Z",
      queuedTurn: { queueId: claimed.id, turn: { sessionId: session.id, phase: "running", provider: input.provider,
        model: options.model, reasoningEffort: options.reasoningEffort, approvalMode: options.approvalMode,
        sandboxMode: options.codexSandboxMode, userMessageSeq: 0, threadId: "", errorMessage: "", createdAt: "2026-11-08T00:00:00.000Z" } } });
    return { ...identity(session), turnId: String(started.queuedTurn!.id) };
  };
  try {
    const parent = create("parent"), stranger = create("stranger");
    const parentActor = start(parent, queue.enqueue(identity(parent), captured(parent, "Parent task")).id);
    for (const scenario of ["parent", "reordered-steer", "gui"] as const) {
      const child = create(`child-${scenario}`, parent.id);
      const target = identity(child);
      const guiInput = captured(child, "G: additional GUI request");
      const gui = scenario === "reordered-steer" ? queue.enqueue(target, guiInput) : null;
      const origin = scenario === "gui" ? { kind: "gui" as const, operation: "send" as const,
        targetSessionId: child.id, targetIncarnationId: target.incarnationId } : {
        kind: "session" as const, actorKind: "main" as const, actorSessionId: parent.id,
        actorIncarnationId: parentActor.incarnationId, actorTurnId: parentActor.turnId, operation: "send" as const,
        targetSessionId: child.id, targetIncarnationId: target.incarnationId };
      const initial = queue.enqueue(target, { ...captured(child, "D: start request"), origin });
      if (gui) {
        assert.equal(initial.sequence, gui.sequence + 1);
        assert.equal(queue.reorderQueued(target, [gui.id, initial.id], [initial.id, gui.id]).outcome, "reordered");
      }
      const actor = start(child, initial.id);
      const request = { operation: "create" as const, operationId: randomUUID(), kind: "escalation" as const,
        body: "Which approach?", choices: [], deliver: true };
      const expectedCaller = scenario === "gui" ? null : identity(parent);
      assert.deepEqual(store.deliveryTarget({ actor, request }), expectedCaller);
      if (gui) {
        const nativeTurnId = "provider-steer-turn";
        queue.claimForInput(target, gui.id, nativeTurnId);
        sessions.appendSessionSteer({ ...target, expectedMessageCount: 1, turnId: Number(actor.turnId),
          userMessage: { role: "user", text: guiInput.request.userMessage }, updatedAt: "2026-11-08T00:00:01.000Z",
          queuedInput: { queueId: gui.id, inputTurnId: nativeTurnId } });
        const savedGui = queue.getReceiptById(target, gui.id)!;
        const savedStart = queue.getReceiptById(target, initial.id)!;
        assert.equal(savedGui.turnId, savedStart.turnId);
        assert.equal(savedStart.inputTurnId, null);
        assert.equal(savedGui.inputTurnId, nativeTurnId);
        assert.equal(savedGui.userMessageSeq, 1);
        assert.deepEqual(savedGui.accepted, guiInput);
        const additional = executionOperationResultSchemas.get_execution_input.parse(executions.execute({ target,
          operation: "get_execution_input", request: { target, receiptId: gui.id, stage: "original" } }));
        assert.equal(additional.text, guiInput.request.userMessage);
        const inputs = executionOperationResultSchemas.list_execution_inputs.parse(executions.execute({ target,
          operation: "list_execution_inputs", request: { target, turnId: actor.turnId } }));
        assert.deepEqual(inputs.items.map((item) => [item.seq, item.kind]), [[0, "start"], [1, "additional"]]);
      }
      assert.deepEqual(store.deliveryTarget({ actor, request }), expectedCaller);
      assert.throws(() => store.execute({ actor, request: { ...request, operationId: randomUUID(),
        respondent: identity(stranger), deliver: false } }), /saved actual caller/);
      const created = store.execute({ actor, request, ...(expectedCaller ? {
        delivery: { target: expectedCaller, captured: captured(parent, "notification", request.operationId) } } : {}) });
      assert.ok("record" in created);
      assert.deepEqual(created.record.caller, expectedCaller);
      assert.deepEqual(created.record.respondent, expectedCaller ?? { kind: "user" });
      assert.equal(created.record.originReceiptId, initial.id);
      if (expectedCaller) {
        assert.ok("receipt" in created && created.receipt);
        assert.equal(created.receipt.sessionId, parent.id);
        assert.throws(() => store.execute({ actor: { kind: "user" }, request: { operation: "answer", operationId: randomUUID(),
          id: created.record.id, body: "Unauthorized", selectedChoices: [], expectedAnswerRevision: 0, send: false } }), /assigned respondent/);
      }
      const saved = record(store.execute({ actor, request: { operation: "get", id: created.record.id } }));
      assert.deepEqual(saved, created.record);
    }
  } finally { executions.close(); store.close(); queue.close(); sessions.close(); await rm(temporary, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "contract"
// claim = "未対応相談はstorage Worker再起動後も同じidentityで参照でき、保存後の通知失敗で回答受付を失敗扱いせず、存在しない記録はtyped削除結果として識別できる"
// oracle = { type = "contract", ref = "GitHub Issue #838 sections 1,6" }
// fault = "Worker command未登録、再起動時の相談消失、または通知例外で確定受付を失敗応答に変換する"
// observable = "Worker経由list/getのidentityと取得済み状態、Application回答のreceipt、再取得した回答本文、欠落get/listのCOORDINATION_DELETED code"
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
    assert.ok(saved.answers[0]?.acquiredAt);
    const deleted = (error: unknown) => error instanceof Error && "code" in error && error.code === "COORDINATION_DELETED";
    await assert.rejects(service.executeUser({ operation: "get", id: "missing-record" }, () => true), deleted);
    await assert.rejects(service.executeUser({ operation: "list", allCrews: true, mainSessionId: "deleted-main", offset: 0, limit: 50 }, () => true), deleted);
  } finally { await bundle.client.close(); await rm(temporary, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "contract"
// claim = "起票元以外の参照では回答を確定せず、未取得の更新は旧配送を取り消し、起票元の取得後は回答変更を拒否する"
// oracle = { type = "contract", ref = "docs/design/database-schema.md#coordination" }
// fault = "GUIや他Sessionの参照で確定する、旧回答を配送する、または起票元の取得後に別の回答を受け付ける"
// observable = "各actorの取得状態、Coordination本体の現在回答、旧配送の取消、新配送の固定本文、取得後の変更拒否"
// observation_boundary = "public-boundary"
// scope = "実SQLiteのCoordinationStorageV7とSessionTurnQueueStorageV6"
// lifecycle = "permanent"
// impact = "起票元へ古い判断が届くことと取得済み回答のすり替えを防ぐ"
// distinction = "描画fixtureや通常queue testはactor identityと回答変更・配送のtransactionを検証しない"
// @end-test-value
test("only the origin acquires the current answer and queued replacements deliver the latest", async () => {
  const temporary = await mkdtemp(join(os.tmpdir(), "withmate-coordination-acquire-"));
  const dbPath = join(temporary, "withmate-v6.db");
  const sessions = new SessionStorageV6(dbPath);
  const create = (id: string) => sessions.insertSession(buildNewSession({ id, taskTitle: id, workspaceLabel: "Workspace", workspacePath: "C:/workspace", branch: "main", characterId: "unknown", character: "Unknown", characterIconPath: "", characterThemeColors: { main: "#123456", sub: "#234567" }, approvalMode: DEFAULT_APPROVAL_MODE }));
  const source = create("origin-acquire"), outsider = create("other-acquire");
  const origin = { kind: "main" as const, sessionId: source.id, incarnationId: getSessionIncarnationId(source), turnId: "1" };
  const other = { kind: "main" as const, sessionId: outsider.id, incarnationId: getSessionIncarnationId(outsider), turnId: "2" };
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT INTO session_turns_v6(id,session_id,phase,started_at,updated_at) VALUES(1,?,'completed','now','now')").run(source.id);
  const store = new CoordinationStorageV7(dbPath), queue = new SessionTurnQueueStorageV6(dbPath);
  const user = { kind: "user" as const };
  const capture = (id: string) => ({ request: { clientRequestId: id, userMessage: "ignored", executionOptions: captureSessionExecutionOptions(source) }, attachments: [], provider: source.provider, workspacePath: source.workspacePath });
  try {
    const created = record(store.execute({ actor: origin, request: { operation: "create", operationId: randomUUID(), kind: "blocker", body: "Choose", choices: [], respondent: user, deliver: false } }));
    assert.equal(record(store.execute({ actor: origin, request: { operation: "get", id: created.id } })).answers.length, 0);
    const firstId = randomUUID();
    const first = { operation: "answer" as const, id: created.id, operationId: firstId, body: "First answer", selectedChoices: [], expectedAnswerRevision: 0, send: true };
    store.execute({ actor: user, request: first, delivery: { target: origin, captured: capture(firstId) } });
    for (const actor of [user, other]) assert.equal(record(store.execute({ actor, request: { operation: "get", id: created.id } })).answers[0]?.acquiredAt, undefined);
    const secondId = randomUUID();
    const second = { ...first, operationId: secondId, body: "Current answer", expectedAnswerRevision: 1 };
    const replaced = store.execute({ actor: user, request: second, delivery: { target: origin, captured: capture(secondId) } });
    assert.equal(queue.getReceipt(origin, firstId)?.state, "canceled");
    assert.equal(replaced.queueUpdates?.[0]?.state, "canceled");
    assert.deepEqual(record(replaced).answers.map((answer) => answer.body), ["Current answer"]);
    assert.equal("history" in record(replaced), false);
    const payload = db.prepare("SELECT payload_json FROM coordination_records_v7 WHERE id=?").get(created.id) as { payload_json: string };
    assert.doesNotMatch(payload.payload_json, /First answer/);
    assert.throws(() => store.execute({ actor: user, request: first }), /answer was replaced/);
    const received = record(store.execute({ actor: origin, request: { operation: "get", id: created.id } }));
    assert.ok(received.answers[0]?.acquiredAt);
    assert.equal(record(store.execute({ actor: origin, request: { operation: "get", id: created.id } })).answers[0]?.acquiredAt, received.answers[0]?.acquiredAt);
    assert.throws(() => store.execute({ actor: user, request: { ...second, operationId: randomUUID(), expectedAnswerRevision: 2 } }), /already received/);
    const delivered = queue.claimNext(origin)!;
    assert.equal(delivered.requestId, secondId);
    assert.equal(delivered.dispatched!.request.userMessage, "Current answer");
    assert.equal(delivered.dispatched!.coordination?.notification?.answer?.body, "Current answer");
  } finally { queue.close(); store.close(); sessions.close(); db.close(); await rm(temporary, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliaryへの自動配送はTurn入力が保存された時だけ回答取得を確定し、保存失敗では確定しない"
// oracle = { type = "contract", ref = "docs/design/database-schema.md#coordination" }
// fault = "claim時に先行確定する、Turn保存のrollback後も確定する、または保存後に回答の変更を許す"
// observable = "開始中・保存失敗後・成功後の回答取得状態と回答変更の拒否"
// observation_boundary = "public-boundary"
// scope = "実SQLiteのAuxiliarySessionStorage、SessionTurnQueueStorageV6とCoordinationStorageV7"
// lifecycle = "permanent"
// impact = "未配送を取得済みと誤認することと配送済み回答の変更を防ぐ"
// distinction = "Mainのruntime testはAuxiliaryの別の原子的開始経路とrollbackを通らない"
// @end-test-value
test("Auxiliary answer acquisition commits with the queued Turn input", async () => {
  const temporary = await mkdtemp(join(os.tmpdir(), "withmate-coordination-aux-acquire-"));
  const dbPath = join(temporary, "withmate-v6.db");
  const sessions = new SessionStorageV6(dbPath), auxiliaries = new AuxiliarySessionStorage(dbPath);
  const source = sessions.insertSession(buildNewSession({ id: "aux-parent", taskTitle: "Parent", workspaceLabel: "Workspace", workspacePath: "C:/workspace", branch: "main", characterId: "unknown", character: "Unknown", characterIconPath: "", characterThemeColors: { main: "#123456", sub: "#234567" }, approvalMode: DEFAULT_APPROVAL_MODE }));
  const aux = auxiliaries.upsertAuxiliarySession({ ...source, id: "aux-origin", parentSessionId: source.id, title: "Aux", runState: "idle", composerDraft: "", messages: [], displayAfterMessageIndex: null, characterId: undefined, characterRuntimeSnapshot: undefined, createdAt: "created", updatedAt: "created" });
  const actor = { kind: "auxiliary" as const, sessionId: aux.id, incarnationId: aux.createdAt, turnId: "1" };
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT INTO session_turns_v6(id,auxiliary_session_id,phase,started_at,updated_at) VALUES(1,?,'completed','now','now')").run(aux.id);
  const store = new CoordinationStorageV7(dbPath), queue = new SessionTurnQueueStorageV6(dbPath);
  const user = { kind: "user" as const };
  try {
    const created = record(store.execute({ actor, request: { operation: "create", operationId: randomUUID(), kind: "blocker", body: "Choose", choices: [], respondent: user, deliver: false } }));
    const operationId = randomUUID();
    const request = { operation: "answer" as const, id: created.id, operationId, body: "Proceed", selectedChoices: [], expectedAnswerRevision: 0, send: true };
    const captured = { request: { clientRequestId: operationId, userMessage: "ignored", executionOptions: captureSessionExecutionOptions(source) }, attachments: [], provider: source.provider, workspacePath: source.workspacePath };
    store.execute({ actor: user, request, delivery: { target: actor, captured } });
    const claimed = queue.claimNext(actor)!;
    const input = claimed.dispatched!, options = input.request.executionOptions;
    const start = { auxiliarySessionId: aux.id, parentSessionId: source.id, createdAt: aux.createdAt, expectedMessageCount: 0, updatedAt: "start",
      userMessage: { role: "user" as const, text: input.request.userMessage }, queuedTurn: { queueId: claimed.id, turn: { sessionId: aux.id, phase: "running" as const, provider: input.provider,
        model: options.model, reasoningEffort: options.reasoningEffort, approvalMode: options.approvalMode, sandboxMode: options.codexSandboxMode,
        userMessageSeq: 0, threadId: "", errorMessage: "", createdAt: "start" } } };
    assert.equal(record(store.execute({ actor: user, request: { operation: "get", id: created.id } })).answers[0]?.acquiredAt, undefined);
    assert.throws(() => store.execute({ actor: user, request: { ...request, operationId: randomUUID(), expectedAnswerRevision: 1 } }), /being delivered/);
    db.exec("CREATE TRIGGER fail_coordination_start BEFORE UPDATE ON session_turn_queue_v6 WHEN NEW.state = 'running' BEGIN SELECT RAISE(ABORT, 'start failed'); END");
    assert.throws(() => auxiliaries.appendAuxiliaryRunningTurnStart(start), /start failed/);
    db.exec("DROP TRIGGER fail_coordination_start");
    assert.equal(record(store.execute({ actor: user, request: { operation: "get", id: created.id } })).answers[0]?.acquiredAt, undefined);
    assert.ok(auxiliaries.appendAuxiliaryRunningTurnStart(start)?.queuedTurn);
    assert.equal(auxiliaries.getAuxiliarySession(aux.id)?.messages[0]?.text, "Proceed");
    assert.ok(record(store.execute({ actor: user, request: { operation: "get", id: created.id } })).answers[0]?.acquiredAt);
    assert.throws(() => store.execute({ actor: user, request: { ...request, operationId: randomUUID(), expectedAnswerRevision: 1 } }), /already received/);
  } finally { queue.close(); store.close(); auxiliaries.close(); sessions.close(); db.close(); await rm(temporary, { recursive: true, force: true }); }
});
