import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CoordinationApplicationService } from "../../src-electron/coordination/coordination-application-service.js";
import { CoordinationStorageV7 } from "../../src-electron/coordination/coordination-storage-v7.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { SessionTurnQueueStorageV6 } from "../../src-electron/session/session-turn-queue-storage-v6.js";
import { QueuedInputPreDispatchError, SessionTurnQueueService } from "../../src-electron/session/session-turn-queue-service.js";
import { SessionRuntimeService } from "../../src-electron/session/session-runtime-service.js";
import { SessionExecutionReadStorage } from "../../src-electron/storage/session-execution-read.js";
import { sessionSummaryToSession } from "../../src-electron/session/session-summary-adapter.js";
import { composeProviderPrompt } from "../../src-electron/providers/provider-prompt.js";
import type { ProviderCodingAdapter } from "../../src-electron/providers/provider-runtime.js";
import { buildNewSession, getSessionIncarnationId, type Session } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { CoordinationActor, CoordinationIdentity, CoordinationResult } from "../../src-shared/coordination/coordination-contract.js";
import type { SessionTurnQueueCapturedInput, SessionTurnQueueStore } from "../../src-shared/session/session-turn-queue.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { executionOperationResultSchemas } from "../../src-shared/session/session-execution-read.js";

const gui = { kind: "user" as const };
function savedRecord(result: CoordinationResult) { assert.ok("record" in result); return result.record; }
const mainIdentity = (session: Session) => ({ kind: "main" as const, sessionId: session.id, incarnationId: getSessionIncarnationId(session) });
function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}
async function openFixture() {
  const directory = await mkdtemp(join(tmpdir(), "coordination-turn-input-"));
  const filename = join(directory, "withmate-v6.db");
  const sessions = new SessionStorageV6(filename), queue = new SessionTurnQueueStorageV6(filename), coordination = new CoordinationStorageV7(filename);
  const db = new DatabaseSync(filename);
  const newSession = (id: string, relationship?: Pick<Session, "sessionRole" | "rootSessionId" | "parentSessionId" | "createdBySessionId">) => sessions.insertSession({ ...buildNewSession({ id, taskTitle: id, workspaceLabel: "test", workspacePath: directory,
    branch: "test", model: "fixture-model", reasoningEffort: "medium", approvalMode: "on-request", characterId: "unknown", character: "Unknown",
    characterIconPath: "", characterThemeColors: { main: "#456789", sub: "#789abc" } }), ...relationship });
  const input = (session: Session, clientRequestId: string = randomUUID(), body = "Start task"): SessionTurnQueueCapturedInput => ({
    request: { clientRequestId, userMessage: body, executionOptions: captureSessionExecutionOptions(session) }, attachments: [], provider: session.provider, workspacePath: session.workspacePath,
  });
  const begin = (session: Session, captured = input(session)) => {
    const owner = mainIdentity(session);
    queue.enqueue(owner, captured);
    const receipt = queue.claimNext(owner)!;
    const options = captured.request.executionOptions;
    const started = sessions.appendRunningTurnStart({ ...owner, expectedMessageCount: 0, userMessage: { role: "user", text: captured.request.userMessage }, updatedAt: "start",
      queuedTurn: { queueId: receipt.id, turn: { sessionId: session.id, phase: "running", userMessageSeq: 0, provider: session.provider, model: options.model,
        reasoningEffort: options.reasoningEffort, approvalMode: options.approvalMode, sandboxMode: options.codexSandboxMode, createdAt: "start", errorMessage: "", threadId: "" } } });
    return { ...owner, turnId: String(started.queuedTurn!.id) };
  };
  const ask = (actor: CoordinationIdentity & { turnId: string }, toUser = true) => savedRecord(coordination.execute({ actor,
    request: { operation: "create", operationId: randomUUID(), kind: "blocker", body: "Choose a direction", choices: [], deliver: false, ...(toUser ? { respondent: gui } : {}) } }));
  const answer = (id: string, target: CoordinationIdentity, session: Session, actor: CoordinationActor = gui) => {
    const operationId = randomUUID();
    const request = { operation: "answer" as const, id, operationId, body: "Proceed", selectedChoices: [], expectedAnswerRevision: 0, send: true };
    const result = coordination.execute({ actor, request, delivery: { target, captured: input(session, operationId) } });
    assert.ok("receipt" in result && result.receipt);
    return { receipt: result.receipt, request };
  };
  const port: SessionTurnQueueStore = {
    admit: async (...args) => queue.admit(...args), getReceipt: async (...args) => queue.getReceipt(...args), getReceiptById: async (...args) => queue.getReceiptById(...args),
    listActive: async (...args) => queue.listActive(...args), listReceipts: async (...args) => queue.listReceipts(...args), listPendingOwners: async (...args) => queue.listPendingOwners(...args),
    claimNext: async (...args) => queue.claimNext(...args), claimForInput: async (...args) => queue.claimForInput(...args), restoreQueuedInput: async (...args) => queue.restoreQueuedInput(...args),
    markStarted: async (...args) => queue.markStarted(...args), settle: async (...args) => queue.settle(...args), cancelQueued: async (...args) => queue.cancelQueued(...args),
    updateQueued: async (...args) => queue.updateQueued(...args), reorderQueued: async (...args) => queue.reorderQueued(...args), recoverInterrupted: async () => queue.recoverInterrupted(),
    releaseInterrupted: async (...args) => queue.releaseInterrupted(...args),
  };
  return { directory, filename, db, sessions, queue, coordination, port, newSession, input, begin, ask, answer,
    async dispose() { db.close(); coordination.close(); queue.close(); sessions.close(); await rm(directory, { recursive: true, force: true }); } };
}

// @test-value v2
// kind = "contract"
// claim = "相談は開始receiptのexact caller Turnだけへ、Agent/昇格ユーザー回答は起票TurnだけへSteerでき、追加inputや別世代から関係を補わない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#coordinationの関連turn配送" }
// fault = "別Turn/kind/incarnationを同じ仕事と扱う、開始receiptの代わりに追加入力を選ぶ、または昇格回答を同一起票Turnへ届けられない"
// observable = "SQLite claim成功/拒否、receiptのqueued維持・Turn ID・accepted/dispatched通知、unknownのescalate拒否"
// observation_boundary = "public-boundary"
// scope = "Coordination保存とqueue input claimの起因照合"
// lifecycle = "permanent"
// impact = "無関係な仕事への割込みと回答不達を防ぐ"
// distinction = "型検査と通常enqueueは複数Turnの因果関係を判定しない。小さいSQLite fixtureで保存事実の照合を確認する"
// @end-test-value
test("Coordination input follows the original exact Turn", async () => {
  const f = await openFixture();
  try {
    const parent = f.newSession("parent"), child = f.newSession("child");
    const parentTurn = f.begin(parent);
    const startInput = f.input(child);
    startInput.origin = { kind: "session", operation: "send", actorKind: parentTurn.kind, actorSessionId: parent.id,
      actorIncarnationId: parentTurn.incarnationId, actorTurnId: parentTurn.turnId, targetSessionId: child.id, targetIncarnationId: getSessionIncarnationId(child) };
    const childTurn = f.begin(child, startInput);
    const extra = f.queue.enqueue(childTurn, f.input(child, randomUUID(), "Additional GUI instruction"));
    f.queue.claimForInput(childTurn, extra.id, "native-child");
    f.sessions.appendSessionSteer({ ...childTurn, turnId: Number(childTurn.turnId), expectedMessageCount: 1, updatedAt: "extra",
      userMessage: { role: "user", text: extra.captured.request.userMessage }, queuedInput: { queueId: extra.id, inputTurnId: "native-child" } });
    const operationId = randomUUID();
    const sent = f.coordination.execute({ actor: childTurn, request: { operation: "create", operationId, kind: "blocker", body: "Question", choices: [], deliver: true },
      delivery: { target: parentTurn, captured: f.input(parent, operationId) } });
    assert.ok("receipt" in sent && sent.receipt);
    const questionReceipt = sent.receipt;
    const json = (f.db.prepare("SELECT payload_json FROM coordination_records_v7 WHERE id=?").get(sent.record.id) as { payload_json: string }).payload_json;
    const original = JSON.parse(json);
    for (const change of [{ caller: { ...parentTurn, kind: "auxiliary" } }, { caller: { ...parentTurn, incarnationId: "different" } }, { originReceiptId: extra.id }]) {
      f.db.prepare("UPDATE coordination_records_v7 SET payload_json=? WHERE id=?").run(JSON.stringify({ ...original, ...change }), sent.record.id);
      assert.throws(() => f.queue.claimForInput(parentTurn, questionReceipt.id, "native-parent"), /does not belong/);
      assert.equal(f.queue.getReceiptById(parentTurn, questionReceipt.id)?.state, "queued");
    }
    f.db.prepare("UPDATE coordination_records_v7 SET payload_json=? WHERE id=?").run(json, sent.record.id);
    const startReceipt = f.queue.getReceiptById(childTurn, original.originReceiptId)!;
    for (const actorTurnId of [undefined, "another-turn"]) {
      f.db.prepare("UPDATE session_turn_queue_v6 SET accepted_json=? WHERE id=?").run(JSON.stringify({ ...startReceipt.accepted,
        origin: { ...startReceipt.accepted!.origin, actorTurnId } }), startReceipt.id);
      assert.throws(() => f.queue.claimForInput(parentTurn, questionReceipt.id, "native-parent"), /does not belong/);
    }
    f.db.prepare("UPDATE session_turn_queue_v6 SET accepted_json=? WHERE id=?").run(JSON.stringify(startReceipt.accepted), startReceipt.id);
    assert.equal(f.queue.claimForInput(parentTurn, questionReceipt.id, "native-parent").turnId, parentTurn.turnId);
    const agentAnswer = f.answer(sent.record.id, childTurn, child, parentTurn);
    assert.equal(f.queue.claimForInput(childTurn, agentAnswer.receipt.id, "native-child").turnId, childTurn.turnId);
    f.queue.settle(childTurn, agentAnswer.receipt.id, "interrupted", "ACK unknown");
    assert.throws(() => f.coordination.execute({ actor: parentTurn, request: { operation: "escalate", operationId: randomUUID(), id: sent.record.id, body: "Ask user" } }), /unknown/);
    const escalated = f.ask(childTurn, false);
    f.coordination.execute({ actor: parentTurn, request: { operation: "escalate", operationId: randomUUID(), id: escalated.id, body: "Need user" } });
    const uiAnswer = f.answer(escalated.id, childTurn, child);
    f.coordination.execute({ actor: gui, request: { operation: "withdraw", operationId: randomUUID(), id: escalated.id, reason: "No longer needed" } });
    const selected = f.queue.claimForInput(childTurn, uiAnswer.receipt.id, "native-child");
    assert.equal(selected.turnId, childTurn.turnId);
    assert.equal(selected.accepted?.coordination?.notification?.state, "open");
    assert.equal(selected.dispatched?.coordination?.notification?.state, "withdrawn");
    f.queue.restoreQueuedInput(childTurn, uiAnswer.receipt.id, "native-child");
    f.db.prepare("UPDATE session_turns_v6 SET phase='completed' WHERE id=?").run(childTurn.turnId);
    f.db.prepare("INSERT INTO session_turns_v6(session_id,phase,started_at,updated_at) VALUES(?,'running','later','later')").run(child.id);
    assert.throws(() => f.queue.claimForInput(childTurn, uiAnswer.receipt.id, "later-native"), /does not belong/);
  } finally { await f.dispose(); }
});

// @test-value v2
// kind = "contract"
// claim = "Main/AuxのSteerは入力・回答受領・receipt完了を同時保存し、rollbackやrestart後の不明配送を受領/未送信と誤認しない"
// oracle = { type = "contract", ref = "docs/design/database-schema.md#coordination" }
// fault = "append失敗後にacquiredAtだけ残す、成功後に回答変更できる、またはinterrupted回答を再送する"
// observable = "message件数、acquiredAt、consumedByOperationId、record state、receipt state、修正/再claim拒否"
// observation_boundary = "public-boundary"
// scope = "Main/Aux SQLite Steer transactionとCoordination回答更新・queue recovery"
// lifecycle = "permanent"
// impact = "未受領の判断喪失、配送済み回答の置換と重複送信を防ぐ"
// distinction = "通常Turn開始と型checkは異なるSteer append transactionの部分commitを検出できない"
// @end-test-value
test("Main and Auxiliary acquire an answer only with committed input", async () => {
  const f = await openFixture(), auxiliaries = new AuxiliarySessionStorage(f.filename);
  try {
    const main = f.newSession("main"), parent = f.newSession("aux-parent");
    const mainTurn = f.begin(main);
    const aux = auxiliaries.upsertAuxiliarySession({ ...parent, id: "aux", parentSessionId: parent.id, title: "Aux", runState: "running", messages: [],
      composerDraft: "", displayAfterMessageIndex: null, characterId: undefined, characterRuntimeSnapshot: undefined, createdAt: "aux-v1", updatedAt: "now" });
    const auxTurn = { kind: "auxiliary" as const, sessionId: aux.id, incarnationId: aux.createdAt,
      turnId: String(f.db.prepare("INSERT INTO session_turns_v6(auxiliary_session_id,phase,started_at,updated_at) VALUES(?,'running','now','now')").run(aux.id).lastInsertRowid) };
    for (const actor of [mainTurn, auxTurn]) {
      const consultation = f.ask(actor);
      const { receipt, request } = f.answer(consultation.id, actor, actor.kind === "main" ? main : parent);
      f.queue.claimForInput(actor, receipt.id, "native");
      const read = () => savedRecord(f.coordination.execute({ actor: gui, request: { operation: "get", id: consultation.id } }));
      const append = () => actor.kind === "main"
        ? f.sessions.appendSessionSteer({ ...actor, turnId: Number(actor.turnId), expectedMessageCount: 1, updatedAt: "input", userMessage: { role: "user", text: "Proceed" }, queuedInput: { queueId: receipt.id, inputTurnId: "native" } })
        : auxiliaries.appendAuxiliarySteer({ auxiliarySessionId: aux.id, parentSessionId: parent.id, createdAt: aux.createdAt, expectedMessageCount: 0,
          turnId: Number(actor.turnId), updatedAt: "input", userMessage: { role: "user", text: "Proceed" }, queuedInput: { queueId: receipt.id, inputTurnId: "native" } });
      f.db.exec("CREATE TRIGGER deny_input_commit BEFORE UPDATE ON session_turn_queue_v6 WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'commit failed'); END");
      assert.throws(append, /commit failed/);
      f.db.exec("DROP TRIGGER deny_input_commit");
      assert.equal(read().answers[0]?.acquiredAt, undefined);
      assert.equal(f.queue.getReceiptById(actor, receipt.id)?.state, "starting");
      assert.equal(actor.kind === "main" ? f.sessions.getSession(main.id)?.messages.length : auxiliaries.getAuxiliarySession(aux.id)?.messages.length, actor.kind === "main" ? 1 : 0);
      assert.ok(append());
      assert.ok(read().answers[0]?.acquiredAt);
      assert.equal(read().answers[0]?.consumedByOperationId, undefined);
      assert.equal(read().state, "open");
      assert.equal(f.queue.getReceiptById(actor, receipt.id)?.state, "completed");
      assert.throws(() => f.coordination.execute({ actor: gui, request: { ...request, operationId: randomUUID(), expectedAnswerRevision: 1 } }), /already received/);
    }
    const pending = f.ask(mainTurn), unknown = f.answer(pending.id, mainTurn, main);
    f.queue.claimForInput(mainTurn, unknown.receipt.id, "native");
    f.queue.recoverInterrupted();
    const restarted = new SessionTurnQueueStorageV6(f.filename);
    try { assert.equal(restarted.getReceiptById(mainTurn, unknown.receipt.id)?.state, "interrupted"); } finally { restarted.close(); }
    assert.throws(() => f.queue.claimForInput(mainTurn, unknown.receipt.id, "native"), /Only a queued/);
    assert.throws(() => f.coordination.execute({ actor: gui, request: { ...unknown.request, operationId: randomUUID(), expectedAnswerRevision: 1 } }), /unknown/);
  } finally { auxiliaries.close(); await f.dispose(); }
});

// @test-value v2
// kind = "contract"
// claim = "GUI回答は起票枠を受付・同Turnの追加入力／終端後の通常配送・Provider文脈・再読込まで維持し、自動Steerの原文と配送結果も正本と一致する"
// oracle = { type = "contract", ref = "docs/design/session-history.md#main列の初期枠子session枠; docs/design/session-run-lifecycle.md#coordinationの関連turn配送" }
// fault = "回答を初期枠や別Turnの会話文脈に移す、旧回答の所属を復元しない、原文をtrimする、またはACK不明で自動再送する"
// observable = "待機receiptの枠、adapterの会話文脈/原文/native ID/回数、再読込した相手枠と初期/全体のseq、受領/終端状態"
// observation_boundary = "public-boundary"
// scope = "実Coordination application・queue service・runtime・SQLite保存とProvider mockの結合"
// lifecycle = "permanent"
// impact = "受理済み判断の遅延・喪失と二重実行を防ぐ"
// distinction = "fake dispatch単体では実runtimeのnative/WithMate照合とProvider受理後の保存/ACK喪失を結合できない"
// @end-test-value
test("GUI Coordination replies retain original thread and accepted text through live runtime", async () => {
  for (const outcome of ["confirmed", "append-ack-lost", "unknown"] as const) {
    const f = await openFixture(), entered = latch(), finish = latch();
    let execution: Promise<unknown> | undefined, service: SessionTurnQueueService | undefined;
    try {
      const session = f.newSession("runtime", { sessionRole: "overall-coordinator", rootSessionId: "runtime" }), owner = mainIdentity(session);
      const peer = mainIdentity(f.newSession("peer", { sessionRole: "executor", rootSessionId: session.id,
        parentSessionId: session.id, createdBySessionId: session.id }));
      const metadata = (id: string) => { const value = f.sessions.getSessionMetadata(id); return value ? { ...sessionSummaryToSession(value.summary), messageCount: value.messageCount } : null; };
      let live: LiveSessionRunState | null = null, consultationId = "";
      const sent: string[] = [];
      const started: string[] = [];
      const promptFrame = (text: string) => JSON.parse(text.match(/^thread: (.+)$/m)?.[1] ?? "null");
      let allowNormal = false;
      const adapter: ProviderCodingAdapter = { composePrompt: composeProviderPrompt, getProviderQuotaTelemetry: async () => null,
        invalidateSessionThread: async () => {}, invalidateAllSessionThreads: async () => {},
        runSessionTurn: async (input, progress) => {
          started.push(composeProviderPrompt(input).inputBodyText);
          await progress?.({ sessionId: input.session.id, threadId: "thread", turnId: "native-runtime", inputAvailable: true, assistantText: "", reasoningText: "",
            steps: [], backgroundTasks: [], usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null },
          { steps: { upserts: [], removes: [] }, backgroundTasks: { upserts: [], removes: [] } });
          entered.release(); await finish.wait;
          return { assistantText: "Completed", threadId: "thread", usage: null };
        },
        steerSessionTurn: async (input) => {
          sent.push(input.userMessage);
          assert.equal(input.expectedTurnId, "native-runtime");
          const active = f.queue.listActive(owner).filter((receipt) => receipt.state === "starting" && receipt.inputTurnId);
          assert.equal(active.length, 1);
          if (active[0]?.captured.coordination) assert.equal(savedRecord(f.coordination.execute({ actor: gui, request: { operation: "get", id: consultationId } })).answers[0]?.acquiredAt, undefined);
          if (outcome === "unknown") throw new Error("Provider ACK unavailable");
          return { turnId: input.expectedTurnId };
        } };
      const catalog = { id: "codex", label: "Codex", defaultModelId: session.model, defaultReasoningEffort: session.reasoningEffort,
        models: [{ id: session.model, label: "Fixture", reasoningEfforts: [session.reasoningEffort] }] };
      const runtime = new SessionRuntimeService({ getSession: metadata, persistRunningTurnStart: () => { throw new Error("Expected queued start"); },
        persistQueuedTurnStart: (next, expectedMessageCount, queueId, turn) => {
          const saved = f.sessions.appendRunningTurnStart({ ...mainIdentity(next), expectedMessageCount, userMessage: next.messages.at(-1)!, updatedAt: next.updatedAt, queuedTurn: { queueId, turn } });
          return { session: { ...metadata(next.id)!, messages: next.messages }, turn: saved.queuedTurn! };
        }, appendRunningInput: (next, text, turnId, queuedInput) => {
          f.sessions.appendSessionSteer({ ...mainIdentity(next), expectedMessageCount: next.messageCount!, turnId, userMessage: { role: "user", text }, updatedAt: next.updatedAt, queuedInput });
          if (outcome === "append-ack-lost") throw new Error("Append result lost");
          return { ...metadata(next.id)!, messages: [...next.messages, { role: "user", text }] };
        }, getQueuedInputReceipt: (receipt) => f.queue.getReceiptById(receipt, receipt.id),
        appendTerminalSession: (next, terminalCommit) => {
          f.sessions.appendSessionTerminal({ ...mainIdentity(next), expectedMessageCount: next.messageCount! - 1, assistantMessage: next.messages.at(-1)!,
            metadata: { status: next.status, runState: next.runState, threadId: next.threadId, updatedAt: next.updatedAt }, terminalCommit });
          return { ...metadata(next.id)!, messages: next.messages };
        }, checkpointRuntimeMetadata: (next) => next,
        assertCapturedComposerAttachmentsAvailable: async () => {}, resolveComposerPreview: async () => { throw new Error("Never parse Coordination body as attachments"); },
        getAppSettings: () => createDefaultAppSettings(), resolveProviderCatalog: () => ({ snapshot: { providers: [catalog] }, provider: catalog }), getProviderCodingAdapter: () => adapter,
        createSessionTurn: () => { throw new Error("Expected atomic queued Turn"); }, updateSessionTurn() {}, setLiveSessionRun: (_, state) => { live = state; }, getLiveSessionRun: () => live,
        waitForApprovalDecision: () => "deny", waitForElicitationResponse: () => ({ action: "cancel" }), resolvePendingApprovalRequest() {}, resolvePendingElicitationRequest() {},
        setProviderQuotaTelemetry() {}, setSessionContextTelemetry() {}, scheduleProviderQuotaTelemetryRefresh() {}, invalidateProviderSessionThread() {}, broadcastLiveSessionRun() {} });
      service = new SessionTurnQueueService({ store: f.port, isRunInFlight: () => runtime.isRunInFlight(session.id),
        getCoordinationInputTurnId: (receipt) => runtime.getCoordinationInputTurnId(receipt), sendInput: (receipt, native) => runtime.steerQueuedSessionTurn(receipt, native),
        dispatch: (receipt, onStarted) => {
          assert.ok(allowNormal, "Expected same-Turn input while the origin is running");
          return runtime.runQueuedSessionTurn(receipt, onStarted);
        } });
      const store = { deliveryTarget: async (input: Parameters<typeof f.coordination.deliveryTarget>[0]) => f.coordination.deliveryTarget(input),
        execute: async (input: Parameters<typeof f.coordination.execute>[0]) => f.coordination.execute(input) };
      const app = new CoordinationApplicationService({ getStore: () => store, prepareDelivery: async (_, id) => f.input(session, id), onAccepted: (receipt) => service!.acceptCommittedReceipt(receipt) });
      const firstInput = f.input(session);
      firstInput.request = { ...firstInput.request, submitSource: "composer", mainConversationFrame: peer };
      firstInput.origin = { kind: "gui", operation: "send", targetSessionId: owner.sessionId, targetIncarnationId: owner.incarnationId };
      const first = f.queue.enqueue(owner, firstInput);
      execution = runtime.runQueuedSessionTurn(f.queue.claimNext(owner)!, async (value) => { f.queue.markStarted(owner, first.id, value); });
      await entered.wait;
      consultationId = savedRecord(await app.executeAgent({ ...owner, turnId: live!.sessionTurnId! },
        { operation: "create", operationId: randomUUID(), kind: "blocker", body: "Question", choices: [], respondent: gui, deliver: false })).id;
      const later = outcome === "confirmed" ? f.ask({ ...owner, turnId: live!.sessionTurnId! }) : null;
      const body = "  Proceed @literal\n";
      const request = { operation: "answer" as const, operationId: randomUUID(), id: consultationId, body, selectedChoices: [], expectedAnswerRevision: 0, send: true };
      const response = await app.executeUser(request, () => true);
      assert.ok("receipt" in response && response.receipt);
      assert.deepEqual(response.receipt.captured.request.mainConversationFrame, peer);
      await service.waitForPending();
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.split("# User Input\n\n")[1], body);
      assert.match(sent[0]!, /Coordination operation: "answer"/);
      assert.deepEqual(promptFrame(sent[0]!), peer);
      const delivered = f.queue.getReceiptById(owner, response.receipt.id)!;
      assert.equal(delivered.turnId, live!.sessionTurnId);
      assert.equal(delivered.state, outcome === "unknown" ? "interrupted" : "completed");
      assert.equal(Boolean(savedRecord(f.coordination.execute({ actor: gui, request: { operation: "get", id: consultationId } })).answers[0]?.acquiredAt), outcome !== "unknown");
      await app.executeUser(request, () => true); await service.waitForPending();
      assert.equal(sent.length, 1);
      const ordinary = " \tAdditional queued input\n";
      if (outcome !== "unknown") {
        const captured = f.input(session, randomUUID(), ordinary);
        const regular = f.queue.enqueue(owner, captured);
        await service.sendQueuedInput(owner, regular.id, "native-runtime");
        assert.equal(sent[1]!.split("# Queued Input\n\n")[1], ordinary);
        const blank = f.queue.enqueue(owner, f.input(session, randomUUID(), " \n"));
        await assert.rejects(service.sendQueuedInput(owner, blank.id, "native-runtime"), /message are required/);
        assert.equal(f.queue.getReceiptById(owner, blank.id)?.state, "queued");
        assert.equal(sent.length, 2);
        f.queue.cancelQueued(owner, blank.id);
      }
      finish.release(); await execution;
      assert.deepEqual(f.sessions.getSession(session.id)?.messages.map((message) => message.text), outcome === "unknown" ? ["Start task", "Completed"] : ["Start task", body, ordinary, "Completed"]);
      if (later) {
        allowNormal = true;
        const unrelated = f.input(session, randomUUID(), "Intervening initial-frame Turn");
        unrelated.request = { ...unrelated.request, submitSource: "composer", mainConversationFrame: null };
        unrelated.origin = firstInput.origin;
        await service.enqueue(owner, unrelated);
        await service.waitForPending();
        assert.equal(promptFrame(started[1]!), null);
        const reply = f.answer(later.id, owner, session).receipt;
        assert.deepEqual(reply.captured.request.mainConversationFrame, peer);
        // A preview.4 receipt had the same immutable Coordination link but no frame.
        f.db.prepare(`UPDATE session_turn_queue_v6 SET captured_json=json_remove(captured_json,'$.request.mainConversationFrame'),
          accepted_json=json_remove(accepted_json,'$.request.mainConversationFrame') WHERE id=?`).run(reply.id);
        const parked = f.queue.listActive(owner).find(({ id }) => id === reply.id);
        assert.deepEqual(parked?.captured.request.mainConversationFrame, peer);
        assert.equal(f.queue.getReceiptById(owner, reply.id)?.accepted?.request.mainConversationFrame, undefined);
        service.acceptCommittedReceipt(reply);
        await service.waitForPending();
        const after = f.queue.getReceiptById(owner, reply.id);
        assert.equal(after?.state, "completed");
        assert.deepEqual(promptFrame(started[2]!), peer);
        assert.ok(after.turnId);
        assert.notEqual(after.turnId, delivered.turnId);

        const read = new SessionExecutionReadStorage(f.filename);
        try {
          const list = (thread?: typeof peer | null) => (executionOperationResultSchemas.list_messages.parse(read.execute({
            target: owner, operation: "list_messages", request: { target: owner, thread },
          })).items as { seq: number }[]).map(({ seq }) => seq);
          assert.deepEqual(list(peer), [0, 1, 3, 6, 7]);
          assert.deepEqual(list(null), [2, 4, 5]);
          assert.deepEqual(list(), [0, 1, 2, 3, 4, 5, 6, 7]);
        } finally { read.close(); }
      }
    } finally { finish.release(); await execution; await service?.close(); await f.dispose(); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "自動Steerは不一致/非対応/送信前拒否なら同じ受付を通常queueへ残し、unknownはrestartでも自動再送しない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#coordinationの関連turn配送" }
// fault = "送信前拒否で入力を失う、fallbackで新receiptを作る、またはunknownを再dispatchする"
// observable = "入力呼出回数、receiptの状態、restart後の通常dispatch回数と受付数"
// observation_boundary = "public-boundary"
// scope = "実SQLite queueとQueueServiceの自動Steer選択・復元・restart"
// lifecycle = "permanent"
// impact = "相談不達と外部操作の重複を防ぐ"
// distinction = "実runtime testとは別に、queueのfallbackとrestartの分岐を小さいProvider portで確認する"
// @end-test-value
test("Automatic Coordination fallback preserves the receipt without replaying unknown input", async () => {
  for (const state of ["unrelated", "unsupported", "pre-dispatch", "unknown"] as const) {
    const f = await openFixture();
    let service: SessionTurnQueueService | undefined;
    try {
      const session = f.newSession("fallback"), actor = f.begin(session), consultation = f.ask(actor);
      const { receipt } = f.answer(consultation.id, actor, session);
      if (state === "unrelated") f.db.prepare("UPDATE coordination_records_v7 SET payload_json=json_set(payload_json,'$.initiatorTurnId','other') WHERE id=?").run(consultation.id);
      let busy = true, inputCalls = 0, normalCalls = 0;
      service = new SessionTurnQueueService({ store: f.port, isRunInFlight: () => busy, getCoordinationInputTurnId: async () => state === "unsupported" ? null : "native",
        sendInput: async () => { inputCalls++; if (state === "pre-dispatch") throw new QueuedInputPreDispatchError("Ended before dispatch"); throw new Error("ACK unknown"); },
        dispatch: async () => { normalCalls++; return { state: "completed" }; } });
      service.acceptCommittedReceipt(receipt); await service.waitForPending();
      assert.equal(f.queue.getReceiptById(actor, receipt.id)?.state, state === "unknown" ? "interrupted" : "queued");
      assert.equal(inputCalls, state === "unrelated" || state === "unsupported" ? 0 : 1);
      await service.close(); busy = false;
      f.db.prepare("UPDATE session_turn_queue_v6 SET state='completed' WHERE turn_id=? AND input_turn_id IS NULL").run(actor.turnId);
      service = new SessionTurnQueueService({ store: f.port, isRunInFlight: () => busy, dispatch: async () => { normalCalls++; return { state: "completed" }; } });
      await service.start(); await service.waitForPending();
      assert.equal(normalCalls, state === "unknown" ? 0 : 1);
      assert.equal(f.queue.listReceipts(actor).receipts.length, 2);
    } finally { await service?.close(); await f.dispose(); }
  }
});
