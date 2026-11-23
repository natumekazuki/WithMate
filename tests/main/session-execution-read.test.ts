import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { SessionTurnStorageV6 } from "../../src-electron/session/session-turn-storage-v6.js";
import { SessionTurnQueueStorageV6 } from "../../src-electron/session/session-turn-queue-storage-v6.js";
import { SessionExecutionReadStorage } from "../../src-electron/storage/session-execution-read.js";
import { buildNewSession, getSessionIncarnationId, projectHomeSessionSummary } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { projectProviderOutput } from "../../src-shared/session/provider-output.js";
import { executionOperationResultSchemas, type ExecutionReadOperation } from "../../src-shared/session/session-execution-read.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { captureSessionTurnQueueDisplay } from "../../src-shared/session/session-turn-queue.js";
import { projectConversationBatch } from "../../src-electron/storage/conversation-projection-worker.js";
import { MainSessionTurnQueueFacade } from "../../src-electron/app/main-session-turn-queue-facade.js";
import { SessionTurnQueueService } from "../../src-electron/session/session-turn-queue-service.js";
import { registerSessionRuntimeHandlers } from "../../src-electron/ipc/session-runtime.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { SessionTurnQueueStore } from "../../src-shared/session/session-turn-queue.js";
import type { MainIpcSessionRuntimeDeps } from "../../src-electron/ipc/contracts.js";
import type { IpcMainInvokeEvent } from "electron";
import { conversationThreadsResultSchema } from "../../src-shared/session/conversation-threads.js";
import type { SessionReply } from "../../src-shared/session/session-reply.js";
import { initiatingReply } from "../../src-electron/session/initiating-reply.js";
import { registerSessionExecutionHandlers } from "../../src-electron/ipc/session-execution.js";
import type { IpcHandleRegistrar } from "../../src-electron/ipc/contracts.js";
import { WITHMATE_READ_SESSION_EXECUTION_CHANNEL } from "../../src-shared/ipc/withmate-ipc-channels.js";
import { SessionResultReadService } from "../../src-electron/session/session-result-read-service.js";
import { readSessionMonitorPage } from "../../src-electron/session/session-monitor-query.js";

async function fixture(action: (context: { sessions: SessionStorageV6; turns: SessionTurnStorageV6; queue: SessionTurnQueueStorageV6; read: SessionExecutionReadStorage; auxiliary: AuxiliarySessionStorage }) => void | Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "withmate-execution-read-"));
  const db = join(directory, "app.db");
  const sessions = new SessionStorageV6(db), turns = new SessionTurnStorageV6(db), queue = new SessionTurnQueueStorageV6(db), read = new SessionExecutionReadStorage(db);
  const auxiliary = new AuxiliarySessionStorage(db);
  try { await action({ sessions, turns, queue, read, auxiliary }); }
  finally { auxiliary.close(); read.close(); queue.close(); turns.close(); sessions.close(); await rm(directory, { recursive: true, force: true }); }
}
function session() { return buildNewSession({ id: "read-main", taskTitle: "Read", workspaceLabel: "workspace", workspacePath: "C:/workspace", branch: "main", characterId: "unknown", character: "Unknown", characterIconPath: "", characterThemeColors: { main: "#112233", sub: "#445566" }, approvalMode: "on-request" }); }

// @test-value v2
// kind = "contract"
// claim = "Main相手候補の未読はMonitorと同じ終了結果の既読に追従し、会話の更新時刻には該当する保存済み送受信・応答だけを使う"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#main-conversation-switcher" }
// fault = "スレッドの表示やメタデータ更新から未読／新しさを推定する、片側の既読がもう一方に届かない、または所有外の投影を読む"
// observable = "所有Windowの実行read IPCとMonitor queryが返す未読、実SQLiteの候補別最終時刻、所有Session外の投影要求の拒否"
// observation_boundary = "public-boundary"
// scope = "実ストレージ、Monitor、未読サービス、実行read IPC。Electron Windowと運用データはfixture"
// lifecycle = "permanent"
// impact = "最新の相手とのやり取りが埋もれる、MonitorとMainが矛盾する、または別ユーザーの結果状態を露出する"
// distinction = "既読サービス単体やMonitor単体では、認可済み会話枠との接続と保存活動の帰属を検証しない"
// @end-test-value
test("Main thread projection and Monitor share terminal unread state while recency comes from saved thread activity", async () => {
  await fixture(async ({ sessions, turns, queue, read }) => {
    const main = sessions.insertSession({ ...session(), sessionRole: "overall-coordinator", rootSessionId: "read-main",
      messages: [{ role: "user", text: "source" }, { role: "assistant", text: "source answer" }] });
    const makeChild = (id: string) => sessions.insertSession({ ...session(), id, sessionRole: "executor", parentSessionId: main.id,
      createdBySessionId: main.id, rootSessionId: main.id, updatedAt: "2099-01-07T00:00:00Z" });
    const [a, b, c] = ["A", "B", "C"].map(makeChild);
    const target = (s: typeof main) => ({ kind: "main" as const, sessionId: s.id, incarnationId: getSessionIncarnationId(s) });
    const owner = target(main);
    const turn = (seq: number) => turns.createSessionTurn({
      sessionId: main.id, provider: main.provider, model: main.model, reasoningEffort: main.reasoningEffort, approvalMode: main.approvalMode,
      phase: "completed", userMessageSeq: seq, assistantMessageSeq: seq + 1, threadId: "", errorMessage: "", createdAt: "2099-01-01T00:00:00Z",
    });
    const send = (actor: typeof main, recipient: typeof main, actorTurnId?: string) => queue.enqueue(target(recipient), {
      request: { userMessage: "fixture input", clientRequestId: randomUUID(), executionOptions: captureSessionExecutionOptions(recipient) },
      provider: recipient.provider, workspacePath: recipient.workspacePath, attachments: [],
      origin: { kind: "session", operation: "send", actorKind: "main", actorSessionId: actor.id, actorIncarnationId: target(actor).incarnationId,
        actorTurnId, targetSessionId: recipient.id, targetIncarnationId: target(recipient).incarnationId },
    });
    const outgoing = send(main, a, String(turn(0).id));
    const incoming = send(b, main);
    queue.claimNext(owner);
    queue.markStarted(owner, incoming.id, { turnId: String(turn(2).id), userMessageSeq: 2 });
    queue.settle(owner, incoming.id, "completed");
    const savedAt = "2099-01-02T00:00:00Z";
    const incomingSaved = sessions.updateSession({ ...main, updatedAt: "2099-01-01T00:00:00Z", messages: [...main.messages,
      { role: "user", text: "child B report" }] });
    sessions.updateSession({ ...incomingSaved, updatedAt: savedAt, messages: [...incomingSaved.messages,
      { role: "assistant", text: "parent response" }] });
    const service = new SessionResultReadService(() => {});
    const hasUnreadResult = (id: string) => service.getUnreadResult(id) !== null;
    const monitor = () => readSessionMonitorPage({ hasUnreadResult, listMonitorSessionIds: () => [a.id, b.id, c.id],
      readSummaries: async () => [a, b, c].map(projectHomeSessionSummary), readAuxiliarySummaries: async () => [], getLiveSessionRun: () => null });
    const handlers = new Map<string, Parameters<IpcHandleRegistrar["handle"]>[1]>();
    const window = {} as NonNullable<ReturnType<Parameters<typeof registerSessionExecutionHandlers>[1]["resolveEventWindow"]>>;
    const mainFrame = {};
    const event = { senderFrame: mainFrame, sender: { mainFrame, isDestroyed: () => false } } as unknown as IpcMainInvokeEvent;
    registerSessionExecutionHandlers({ handle: (channel, handler) => { handlers.set(channel, handler); } }, {
      resolveEventWindow: () => window, resolveSessionWindow: (id) => id === main.id ? window : null,
      hasUnreadResult, readExecution: async (input) => read.execute(input),
    });
    const invoke = (target: typeof owner) => handlers.get(WITHMATE_READ_SESSION_EXECUTION_CHANNEL)!(event, main.id, "read_conversation_threads", { target });
    const snapshot = async () => conversationThreadsResultSchema.parse(await invoke(owner)).children;
    await assert.rejects(Promise.resolve().then(() => invoke(target(a))), /owning Session/);
    service.recordResult({ sessionId: a.id, turnId: 2, phase: "completed", assistantMessageSeq: 1, threadId: "", errorMessage: "", completedAt: savedAt });
    const updated = await snapshot();
    assert.deepEqual(updated.map(({ target, lastActivityAt, hasUnreadResult }) => [target.sessionId, lastActivityAt, hasUnreadResult]),
      [[a.id, Date.parse(outgoing.createdAt), true], [b.id, Date.parse(savedAt), false], [c.id, undefined, false]]);
    assert.equal((await monitor()).entries.find(({ id }) => id === a.id)?.hasUnreadResult, true);
    assert.equal(service.markRead(a.id, 2), true, "both projections left the result unread");
    assert.equal((await monitor()).entries.find(({ id }) => id === a.id)?.hasUnreadResult, false);
    assert.deepEqual(await snapshot(), updated.map((child) => ({ ...child, hasUnreadResult: false })));
  });
});

// @test-value v2
// kind = "contract"
// claim = "後続Turnのある保存履歴から選んだ失敗開始receiptは認可IPCを通り、元来歴付きGUIの新しい受付になる"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#gui-turn-queue; docs/design/database-schema.md: retrySource" }
// fault = "最新Turnを代用する、履歴や元受付を変更する、Session送信者を新actorにする"
// observable = "実SQLiteで読んだ選択Turn、新受付の本文と送信来歴、履歴本文と元受付"
// observation_boundary = "public-boundary"
// scope = "IPC、MainSessionTurnQueueFacade、queue service、SQLite実行履歴"
// lifecycle = "permanent"
// impact = "古い失敗とは異なる指示を実行したり既存履歴を書き換える"
// distinction = "facadeとUIのfake receiptだけでは実SQLiteのTurn・receipt対応を確認できない"
// @end-test-value
test("IPC retries the selected older failed Turn from real saved execution state", async () => {
  await fixture(async ({ sessions, turns, queue, read }) => {
    const saved = sessions.insertSession({ ...session(), model: "current-model", reasoningEffort: "medium", messages: [
      { role: "user", text: "fixed instruction" }, { role: "assistant", text: "failed response", runFailure: "failed" },
      { role: "user", text: "later instruction" }, { role: "assistant", text: "later response" },
    ] });
    const owner = { sessionId: saved.id, incarnationId: getSessionIncarnationId(saved) };
    const target = { kind: "main" as const, ...owner };
    const sourceOrigin = { kind: "session" as const, operation: "send" as const, targetSessionId: owner.sessionId, targetIncarnationId: owner.incarnationId,
      actorKind: "main" as const, actorSessionId: "sender", actorIncarnationId: "sender-inc", actorTurnId: "91", actorSnapshot: { sessionTitle: "Sender", character: { id: "sender-character", name: "Sender", iconPath: "" } } };
    const original = queue.enqueue(owner, { request: { userMessage: "fixed instruction", clientRequestId: randomUUID(), executionOptions: captureSessionExecutionOptions(saved) }, provider: saved.provider, workspacePath: saved.workspacePath, attachments: [], origin: sourceOrigin });
    const turnBase = { sessionId: saved.id, provider: saved.provider, model: saved.model, reasoningEffort: saved.reasoningEffort, approvalMode: saved.approvalMode, threadId: "", errorMessage: "", createdAt: "now" };
    const failed = turns.createSessionTurn({ ...turnBase, phase: "running", userMessageSeq: 0 });
    queue.claimNext(owner); queue.markStarted(owner, original.id, { turnId: String(failed.id), userMessageSeq: 0 });
    turns.updateSessionTurn(failed.id, { ...turnBase, phase: "failed", userMessageSeq: 0, assistantMessageSeq: 1 });
    queue.settle(owner, original.id, "failed", "failed");
    const later = turns.createSessionTurn({ ...turnBase, phase: "running", userMessageSeq: 2 });
    turns.updateSessionTurn(later.id, { ...turnBase, phase: "completed", userMessageSeq: 2, assistantMessageSeq: 3 });
    const store = new Proxy(queue, { get(instance, key) { const value = Reflect.get(instance, key); return typeof value === "function" ? async (...args: unknown[]) => value.apply(instance, args) : value; } }) as unknown as SessionTurnQueueStore;
    const service = new SessionTurnQueueService({ store, isRunInFlight: () => true, dispatch: async () => { throw new Error("No provider calls in fixture"); } });
    const facade = new MainSessionTurnQueueFacade({ assertActive() {}, assertAccepting() {}, getSession: async (id) => sessions.getSession(id),
      getAppSettings: async () => createDefaultAppSettings(), validateWorkspace: async () => {},
      validateProvider: async () => ({ provider: { id: "codex", label: "Codex", defaultModelId: saved.model, defaultReasoningEffort: saved.reasoningEffort, models: [{ id: saved.model, label: "Model", reasoningEfforts: [saved.reasoningEffort] }] } }),
      preview: async () => { throw new Error("must not reconstruct captured attachments"); }, validateRetryAttachments: async () => {},
      readRetryExecution: async (input) => executionOperationResultSchemas.get_execution.parse(read.execute({ target: input.target, operation: "get_execution", request: { target: input.target, receiptId: input.receiptId } })), store, service });
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: any[]) => any>();
    const window = {}, frame = {}, sender = { mainFrame: frame, isDestroyed: () => false };
    const deps = { queue: { retryFailedSessionTurn: facade.retryFailedSessionTurn.bind(facade) }, resolveEventWindow: () => window, resolveSessionWindow: () => window,
      getAuxiliarySessionStatus: async () => null } as unknown as MainIpcSessionRuntimeDeps;
    registerSessionRuntimeHandlers({ handle: (channel, handler) => { handlers.set(channel, handler); } }, deps);
    try {
      const result = await handlers.get("withmate:retry-failed-session-turn")!({ sender, senderFrame: frame } as unknown as IpcMainInvokeEvent, saved.id,
        { target, receiptId: original.id, turnId: String(failed.id), clientRequestId: randomUUID(), executionOptions: captureSessionExecutionOptions(saved) });
      assert.equal(result.captured.request.userMessage, "fixed instruction");
      assert.equal(result.captured.origin.kind, "gui");
      assert.deepEqual(result.captured.retrySource.origin, sourceOrigin);
      assert.equal(result.captured.retrySource.turnId, String(failed.id));
      assert.deepEqual(sessions.getSession(saved.id)?.messages.map((message) => message.text), ["fixed instruction", "failed response", "later instruction", "later response"]);
      assert.equal(queue.getReceiptById(owner, original.id)?.state, "failed");
      const reread = executionOperationResultSchemas.get_execution.parse(read.execute({ target, operation: "get_execution", request: { target, receiptId: result.id } }));
      assert.equal(reread.retrySource?.receiptId, original.id);
    } finally { await service.close(); }
  });
});

// @test-value v2
// kind = "contract"
// claim = "開始受付、同じTurnへ追加した受付、直接Steerは、それぞれ確定された返信先を本文と別に保存し、再読込しても置き換わらない"
// oracle = { type = "contract", ref = "docs/design/session-history.md#明示返信" }
// fault = "最新やTurn開始側の返信先で上書きする、独立した追加入力の参照を捨てる、元の本文を変える"
// observable = "実SQLiteの受付・保存message pageの本文、正本seq、replyTo、受理済み追加入力"
// observation_boundary = "public-boundary"
// scope = "Mainの開始入力・追加queue・直接Steerと既存の一通読取"
// lifecycle = "permanent"
// impact = "履歴を開き直したとき別の発言を引用するか、選んだ発言に戻れない"
// distinction = "provider builderやrendererは保存JSONの往復と三つの記録が混ざらないことを確認できない"
// @end-test-value
test("saved start, queued Steer and direct Steer retain their own reply references", async () => {
  await fixture(({ sessions, turns, queue, read }) => {
    const seeded = sessions.insertSession({ ...session(), messages: [
      { role: "user", text: "original user" }, { role: "assistant", text: "original final answer" },
    ] });
    const owner = { sessionId: seeded.id, incarnationId: getSessionIncarnationId(seeded) };
    const target = { kind: "main" as const, ...owner };
    const base = { sessionId: seeded.id, provider: seeded.provider, model: seeded.model, reasoningEffort: seeded.reasoningEffort,
      approvalMode: seeded.approvalMode, sandboxMode: seeded.codexSandboxMode, threadId: "", errorMessage: "", createdAt: "start" };
    const earlier = turns.createSessionTurn({ ...base, phase: "completed", userMessageSeq: 0, assistantMessageSeq: 1 });
    const request = (userMessage: string, replyTo?: SessionReply) => queue.enqueue(owner, { provider: seeded.provider, workspacePath: seeded.workspacePath,
      attachments: [], request: { userMessage, clientRequestId: randomUUID(), executionOptions: captureSessionExecutionOptions(seeded), ...(replyTo ? { replyTo } : {}) } });
    const finalReply = { target, seq: 1, finalAnswerTurnId: String(earlier.id) };
    const first = request("start reply", finalReply);
    queue.claimNext(owner);
    const started = sessions.appendRunningTurnStart({ ...owner, updatedAt: "running", expectedMessageCount: 2,
      userMessage: { role: "user", text: "start reply", replyTo: finalReply },
      queuedTurn: { queueId: first.id, turn: { ...base, phase: "running", userMessageSeq: 2 } } });
    assert.ok(started.queuedTurn);
    const turnId = started.queuedTurn.id;
    const queueReply = { target, seq: 0 };
    const pending = request("queued reply", queueReply);
    const edited = queue.updateQueued(owner, pending.id, { userMessage: "edited queued reply", attachments: [] });
    assert.deepEqual(edited.captured.request.replyTo, queueReply);
    queue.claimForInput(owner, pending.id, "native");
    sessions.appendSessionSteer({ ...owner, expectedMessageCount: 3, turnId, updatedAt: "additional", queuedInput: { queueId: pending.id, inputTurnId: "native" },
      userMessage: { role: "user", text: "edited queued reply", replyTo: queueReply } });
    const receiptReply = { target, receiptId: first.id };
    sessions.beginSessionSteer({ ...owner, expectedMessageCount: 4, turnId, nativeTurnId: "native", updatedAt: "direct", attachments: [],
      userMessage: { role: "user", text: "direct reply", replyTo: receiptReply } });
    sessions.settleSessionSteer({ ...owner, turnId, messageSeq: 4, state: "confirmed", updatedAt: "confirmed", expectedMessageCount: 5 });
    const ordinary = request("# Reply To\n\nseq: 9");
    assert.equal(queue.getReceipt(owner, ordinary.requestId)?.accepted?.request.replyTo, undefined);
    assert.deepEqual(queue.getReceipt(owner, first.requestId)?.accepted?.request.replyTo, finalReply);
    assert.deepEqual(queue.getReceipt(owner, pending.requestId)?.dispatched?.request.replyTo, queueReply);
    const history = sessions.getConversationPage(seeded.id)!;
    assert.deepEqual(history.messages.map(({ text, historyIndex, replyTo }) => [historyIndex, text, replyTo]), [
      [0, "original user", undefined], [1, "original final answer", undefined],
      [2, "start reply", finalReply], [3, "edited queued reply", queueReply], [4, "direct reply", receiptReply],
    ]);
    const saved = executionOperationResultSchemas.get_message.parse(read.execute({ target, operation: "get_message", request: { target, seq: finalReply.seq } }));
    assert.equal(saved.text, "original final answer");
    assert.equal(String((saved.turn as { id: number }).id), finalReply.finalAnswerTurnId);
    const accepted = executionOperationResultSchemas.get_execution_input.parse(read.execute({ target, operation: "get_execution_input", request: { ...receiptReply, stage: "original" } }));
    assert.deepEqual([accepted.receiptId, accepted.text], [first.id, "start reply"]);
  });
});

// @test-value v2
// kind = "contract"
// claim = "GUIによる失敗Turn再実行の保存済receiptから今回のactorと元の送信者を別々に読み出せる"
// oracle = { type = "contract", ref = "docs/design/database-schema.md: retrySource; docs/design/session-run-lifecycle.md#gui-turn-queue" }
// fault = "queue JSONから再実行元を落とす、元Sessionを今回のactorへ投影する"
// observable = "実SQLiteの受付をexecution schema経由で読んだoriginとretrySource"
// observation_boundary = "public-boundary"
// scope = "queue storageからexecution readへの再実行来歴"
// lifecycle = "permanent"
// impact = "会話表示とProviderが再実行者と元送信者を混同する"
// distinction = "facade fixtureだけではSQLite保存とexecution schemaを通した再読込を検出できない"
// @end-test-value
test("failed Turn retry provenance survives queue storage and execution reads", async () => {
  await fixture(({ sessions, queue, read }) => {
    const saved = sessions.insertSession(session());
    const owner = { sessionId: saved.id, incarnationId: getSessionIncarnationId(saved) };
    const target = { kind: "main" as const, ...owner };
    const gui = { kind: "gui" as const, operation: "send" as const, targetSessionId: saved.id, targetIncarnationId: owner.incarnationId };
    const original = { ...gui, kind: "session" as const, actorKind: "main" as const, actorSessionId: "source", actorIncarnationId: "source-inc", actorTurnId: "12", actorSnapshot: { sessionTitle: "Source", character: { id: "character", name: "Sender", iconPath: "" } } };
    const retrySource = { receiptId: "old-receipt", turnId: "42", origin: original, changedSinceAcceptance: true };
    const stored = queue.enqueue(owner, { request: { userMessage: "fixed instruction", clientRequestId: randomUUID(), executionOptions: captureSessionExecutionOptions(saved) }, provider: saved.provider, workspacePath: saved.workspacePath, attachments: [], origin: gui, retrySource });
    const result = executionOperationResultSchemas.get_execution.parse(read.execute({ target, operation: "get_execution", request: { target, receiptId: stored.id } }));
    assert.deepEqual(result.origin, gui);
    assert.deepEqual(result.retrySource, retrySource);
  });
});

// @test-value v2
// kind = "contract"
// claim = "Mainの子候補は子自身のキャラ・実行状態を使い、実行終了で表示状態のみが変わる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#main-conversation-switcher" }
// fault = "全候補に親のキャラを使う、画像なしの子に別の画像を流用する、終了後も実行中を返す"
// observable = "実SQLiteから実行履歴read契約で返る子IDごとのキャラ名・画像・実行状態"
// observation_boundary = "public-boundary"
// scope = "作成済みの子の読取projection。CSSと描画は対象外"
// lifecycle = "permanent"
// impact = "送信先確認に必要な人物表示が誤り、終了後も実行中に見える"
// distinction = "履歴の帰属や単独Session summaryだけでは、枠ごとの表示用情報が正しく返るか分からない"
// @end-test-value
test("Main child candidates keep their own avatar and reflect run completion", async () => {
  await fixture(({ sessions, read }) => {
    const parent = sessions.insertSession({ ...session(), characterId: "parent-agent", character: "Parent",
      characterIconPath: "C:/fixture/parent.png", sessionRole: "overall-coordinator" });
    const child = { ...session(), sessionRole: "executor" as const, rootSessionId: parent.id,
      parentSessionId: parent.id, createdBySessionId: parent.id, updatedAt: "2026-11-23T00:00:00.000Z" };
    const running = sessions.insertSession({ ...child, id: "child-B", taskTitle: "Child B", characterId: "child-b-agent",
      character: "Reviewer", characterIconPath: "C:/fixture/reviewer.png", runState: "running" });
    sessions.insertSession({ ...child, id: "child-A", taskTitle: "Child A", characterId: "child-a-agent",
      character: "Writer", characterIconPath: "" });
    const target = { kind: "main" as const, sessionId: parent.id, incarnationId: getSessionIncarnationId(parent) };
    const candidates = () => new Map(conversationThreadsResultSchema.parse(read.execute({
      target, operation: "read_conversation_threads", request: { target },
    })).children.map(({ target: childTarget, character, isProcessing }) => [childTarget.sessionId, { character, isProcessing }]));
    const writer = { character: { name: "Writer", iconPath: "" }, isProcessing: false };
    const reviewer = { character: { name: "Reviewer", iconPath: "C:/fixture/reviewer.png" }, isProcessing: false };
    assert.deepEqual(candidates(), new Map([["child-A", writer], ["child-B", { ...reviewer, isProcessing: true }]]));
    sessions.updateSession({ ...running, runState: "idle", updatedAt: "2026-11-23T00:01:00.000Z" });
    assert.deepEqual(candidates(), new Map([["child-A", writer], ["child-B", reviewer]]));
  });
});

// @test-value v2
// kind = "contract"
// claim = "直接の子の枠は正確な来歴に従い、Agentの返信参照も現在Turnを開始した本来の送信元宛でだけ保存入力を指す"
// oracle = { type = "contract", ref = "docs/design/session-history.md#main列の初期枠子session枠; docs/design/session-history.md#明示返信" }
// fault = "送受信相手から枠を作る、本文や同じTurnだけで所属を推定する、子の会話を初期枠にも載せる"
// observable = "実SQLiteの枠と正本seq、既存送信一覧と履歴page、同じ保存受付を使うAgent送信の返信先判定"
// observation_boundary = "public-boundary"
// scope = "初期枠・直接の子の枠と既存送信一覧・本文pageの接続。人工fixtureだけを使用"
// lifecycle = "permanent"
// impact = "アクセス可能な過去の指示を失う、または別人への指示や応答を正しい返信と誤認する"
// distinction = "既存の送信一覧や単独pagingでは、枠の親子選定、初期枠への重複による混在、別枠送信と正本の対応を検証できない"
// @end-test-value
test("Main conversation frames keep only created children and preserve unattributed history in the initial frame", async () => {
  await fixture(({ sessions, turns, queue, read }) => {
    const parent = sessions.insertSession({ ...session(), id: "parent", sessionRole: "overall-coordinator", rootSessionId: "parent" });
    const main = sessions.insertSession({ ...session(), sessionRole: "task-coordinator", rootSessionId: parent.id, parentSessionId: parent.id, createdBySessionId: parent.id });
    const [a, b, c] = ["A", "B", "C"].map((id) => sessions.insertSession({ ...session(), id, taskTitle: `Child ${id}`,
      sessionRole: "executor", rootSessionId: parent.id, parentSessionId: main.id, createdBySessionId: main.id }));
    const sibling = sessions.insertSession({ ...session(), id: "sibling", sessionRole: "task-coordinator",
      rootSessionId: parent.id, parentSessionId: parent.id, createdBySessionId: parent.id });
    const owner = (s: typeof main) => ({ sessionId: s.id, incarnationId: getSessionIncarnationId(s) });
    const select = (s: typeof main) => ({ kind: "main" as const, ...owner(s) });
    const target = select(main);
    const send = (actor: typeof main, recipient: typeof main, actorTurnId?: string, actorIncarnationId = getSessionIncarnationId(actor)) => queue.enqueue(owner(recipient), {
      request: { userMessage: "identical text", clientRequestId: randomUUID(), executionOptions: captureSessionExecutionOptions(recipient) },
      attachments: [], provider: recipient.provider, workspacePath: recipient.workspacePath,
      origin: { kind: "session", operation: "send", actorKind: "main", actorSessionId: actor.id, actorIncarnationId, actorTurnId,
        targetSessionId: recipient.id, targetIncarnationId: getSessionIncarnationId(recipient) },
    });
    const base = { sessionId: main.id, provider: main.provider, model: main.model, reasoningEffort: main.reasoningEffort, approvalMode: main.approvalMode, threadId: "", errorMessage: "", createdAt: "now", phase: "running" as const };
    const fromA = send(a, main);
    const mainTurn = turns.createSessionTurn({ ...base, userMessageSeq: 0 });
    const turnId = String(mainTurn.id);
    queue.claimNext(owner(main)); queue.markStarted(owner(main), fromA.id, { turnId, userMessageSeq: 0 });
    const toA = send(main, a, turnId); const toB = send(main, b, turnId); const toParent = send(main, parent, turnId);
    const fromB = send(b, main);
    sessions.updateSession({ ...main, runState: "running", messages: [{ role: "user", text: "identical text" }] });
    queue.claimForInput(owner(main), fromB.id, "native-main-turn");
    sessions.appendSessionSteer({ ...owner(main), expectedMessageCount: 1, turnId: mainTurn.id, userMessage: { role: "user", text: "identical text" },
      updatedAt: "input", queuedInput: { queueId: fromB.id, inputTurnId: "native-main-turn" } });
    const active = queue.listActive(owner(main));
    assert.deepEqual(initiatingReply(target, select(a), turnId, active), { target, seq: 0 });
    assert.equal(initiatingReply(target, select(b), turnId, active), undefined);
    assert.equal(initiatingReply(target, { ...select(a), incarnationId: "old-incarnation" }, turnId, active), undefined);
    assert.equal(initiatingReply(target, select(a), "9999", active), undefined);
    const additional = queue.getReceipt(owner(main), fromB.requestId)!;
    assert.equal(initiatingReply(target, select(b), turnId, [additional]), undefined);
    const projection = () => conversationThreadsResultSchema.parse(read.execute({ target, operation: "read_conversation_threads", request: { target } }));
    const live = projection();
    assert.deepEqual(live.children.map(({ target }) => target).sort((x, y) => x.sessionId.localeCompare(y.sessionId)), [select(a), select(b), select(c)]);
    assert.deepEqual(live.children.find((child) => child.target.sessionId === b.id)?.sentMessageIndexes, [0]);
    assert.deepEqual(live.initialMessageIndexes, []);
    turns.updateSessionTurn(mainTurn.id, { ...base, phase: "completed", userMessageSeq: 0, assistantMessageSeq: 2 });
    queue.settle(owner(main), fromA.id, "completed");
    const bind = (actor: typeof main, userMessageSeq: number, assistantMessageSeq: number | undefined, incarnationId?: string) => {
      const receipt = send(actor, main, undefined, incarnationId);
      const turn = turns.createSessionTurn({ ...base, userMessageSeq });
      queue.claimNext(owner(main));
      queue.markStarted(owner(main), receipt.id, { turnId: String(turn.id), userMessageSeq });
      queue.settle(owner(main), receipt.id, "completed");
      turns.updateSessionTurn(turn.id, { ...base, phase: "completed", userMessageSeq, assistantMessageSeq });
      return String(turn.id);
    };
    const steerSourceTurnId = bind(parent, 3, undefined);
    const steer = { role: "user" as const, text: "identical text", turnInput: { turnId: "22", nativeTurnId: "native", state: "confirmed" as const, attachments: [],
      origin: { kind: "session" as const, operation: "steer" as const, actorKind: "main" as const, actorSessionId: main.id, actorIncarnationId: target.incarnationId,
        actorTurnId: steerSourceTurnId, targetSessionId: b.id, targetIncarnationId: getSessionIncarnationId(b) } } };
    sessions.updateSession({ ...b, messages: [steer] });
    bind(a, 4, undefined, "deleted-incarnation");
    bind(b, 5, 6);
    bind(sibling, 7, undefined);
    sessions.updateSession({ ...main, messages: [{ role: "user", text: "identical text" }, { role: "user", text: "identical text" },
      { role: "assistant", text: "reply from the starting input" }, { role: "user", text: "parent" }, { role: "user", text: "identical text" },
      { role: "user", text: "B report" }, { role: "assistant", text: "B report response" },
      { role: "user", text: "identical text" }, { role: "user", text: "unattributed supervisor input" },
      ...Array.from({ length: 65 }, () => ({ role: "assistant" as const, text: "unlinked legacy" }))] });
    const history = projection();
    assert.deepEqual(history.initialMessageIndexes, [3, 4, 7, 8, ...Array.from({ length: 65 }, (_, i) => i + 9)]);
    const saved = new Map(history.children.map((thread) => [thread.target.sessionId, thread]));
    assert.deepEqual([...saved.keys()].sort(), [a.id, b.id, c.id]);
    assert.deepEqual(saved.get("A")?.messageIndexes, [0, 2]);
    assert.deepEqual(saved.get("B")?.messageIndexes, [1, 5, 6]);
    assert.deepEqual(saved.get("B")?.sentMessageIndexes, [2, 3]);
    const { character: _character, isProcessing: _isProcessing, ...untouched } = saved.get("C")!;
    assert.deepEqual(untouched, { target: select(c), title: "Child C", messageIndexes: [], inboundTurnIds: [], sentMessageIndexes: [] });
    const exact = executionOperationResultSchemas.list_sent_deliveries.parse(read.execute({ target, operation: "list_sent_deliveries", request: { target, messageSeqs: [2] } }));
    assert.deepEqual(exact.items.map(({ receiptId, sourceMessageSeq }) => [receiptId, sourceMessageSeq]), [[toA.id, 2], [toB.id, 2], [toParent.id, 2]]);
    const direct = executionOperationResultSchemas.list_sent_steers.parse(read.execute({ target, operation: "list_sent_steers", request: { target, messageSeqs: [3] } }));
    assert.deepEqual(direct.items.map(({ target, messageSeq, sourceMessageSeq }) => [target, messageSeq, sourceMessageSeq]), [[select(b), 0, 3]]);
    assert.ok(sessions.getConversationPage(main.id)!.startIndex > 2);
    assert.deepEqual(sessions.getConversationPage(main.id, { messageIndexes: [1, 2, 67] })!.messages.map(({ historyIndex, text }) => [historyIndex, text]),
      [[1, "identical text"], [2, "reply from the starting input"], [67, "unlinked legacy"]]);
  });
});

// @test-value v2
// kind = "contract"
// claim = "直接Steerの送信元読取は正確なactor/incarnation/Turnと宛先に結び、4状態と本文全文を複数page・live/保存後で維持する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/966; docs/design/database-schema.md: 親からの直接Steer・送信側の読取" }
// fault = "queue専用一覧で直接入力を落とす、他世代・別actorの本文を混ぜる、pendingをconfirmed扱いする、cursorで同じTurnの複数入力を欠落させる"
// observable = "実SQLiteから公開schemaを通して取得する送信元pageの本文、状態、宛先、messageSeq、sourceMessageSeq、cursor"
// observation_boundary = "public-boundary"
// scope = "保存済みrecipient message由来の一括送信元projection。通常receiptの一覧は既存testで確認"
// lifecycle = "permanent"
// impact = "送った訂正を追えない、未確定入力を受信済みと誤認する、別Sessionの指示を漏らす"
// distinction = "型・schemaとrenderer fixtureではSQLiteの逆引き条件とmessage keysetの接続を検証できない。単一小型DBで必要な境界をまとめる"
// @end-test-value
test("outgoing direct Steers retain exact identity, full text and four states across pages", async () => {
  await fixture(({ sessions, turns, read }) => {
    const sender = sessions.insertSession({ ...session(), id: "source", taskTitle: "Original Source", messages: [{ role: "user", text: "request" }, { role: "assistant", text: "answer" }, { role: "user", text: "later" }] });
    const base = { sessionId: sender.id, provider: sender.provider, model: sender.model, reasoningEffort: sender.reasoningEffort, approvalMode: sender.approvalMode, threadId: "", errorMessage: "", createdAt: "now", phase: "running" as const };
    const source = turns.createSessionTurn({ ...base, userMessageSeq: 0 });
    const later = turns.createSessionTurn({ ...base, userMessageSeq: 2 });
    const recipient = sessions.insertSession({ ...session(), id: "recipient" });
    const recipientIncarnation = getSessionIncarnationId(recipient);
    const origin = { kind: "session" as const, operation: "steer" as const, actorKind: "main" as const, actorSessionId: sender.id,
      actorIncarnationId: getSessionIncarnationId(sender), actorTurnId: String(source.id), actorSnapshot: captureSessionTurnQueueDisplay(sender),
      targetSessionId: "recipient", targetIncarnationId: recipientIncarnation };
    const states = ["pending", "confirmed", "unknown", "not-sent"] as const;
    const messages = Array.from({ length: 24 }, (_, index) => ({ role: "user" as const, text: `${index}: ${"Full instruction ".repeat(40)}`,
      turnInput: { turnId: "999", nativeTurnId: "native-target", attachments: [], state: states[index % 4], origin } }));
    sessions.updateSession({ ...recipient, messages: [...messages,
      ...[{ actorSessionId: "other" }, { actorIncarnationId: "old" }, { actorTurnId: String(later.id) }, { targetIncarnationId: "old" }, { targetSessionId: "other" }].map((patch) => ({ ...messages[0], text: "not in this source range", turnInput: { ...messages[0].turnInput, origin: { ...origin, ...patch } } })),
      { ...messages[0], text: "GUI input", turnInput: { ...messages[0].turnInput, origin: undefined } },
    ] });
    sessions.patchSessionMetadata(sender.id, getSessionIncarnationId(sender), { title: "Renamed Source" });
    const target = { kind: "main" as const, sessionId: sender.id, incarnationId: getSessionIncarnationId(sender) };
    const call = (extra: object = {}) => executionOperationResultSchemas.list_sent_steers.parse(read.execute({ target, operation: "list_sent_steers", request: { target, messageSeqs: [], liveTurnIds: [String(source.id)], limit: 20, ...extra } }));
    const first = call();
    assert.equal(first.items.length, 20);
    const next = call({ cursor: first.nextCursor });
    assert.equal(next.nextCursor, null);
    const all = [...first.items, ...next.items];
    assert.deepEqual(all.map((item) => [item.messageSeq, item.text, item.state, item.sourceMessageSeq]), messages.map((message, seq) => [seq, message.text, message.turnInput.state, null]));
    assert.ok(all.every((item) => item.target.sessionId === "recipient" && item.target.incarnationId === recipientIncarnation && item.origin.actorSnapshot?.sessionTitle === "Original Source"));
    turns.updateSessionTurn(source.id, { ...base, phase: "completed", userMessageSeq: 0, assistantMessageSeq: 1 });
    const saved = call({ messageSeqs: [0, 1], liveTurnIds: [] });
    assert.deepEqual(saved.items.map((item) => [item.sequence, item.sourceMessageSeq]), first.items.map((item) => [item.sequence, 1]));
    assert.equal(call({ messageSeqs: [], liveTurnIds: [] }).items.length, 0);
    assert.equal(call({ liveTurnIds: [String(later.id)] }).items.length, 1);
  });
});

// @test-value v2
// kind = "contract"
// claim = "受信側の一覧と実行読取は同じ保存messageから送信元CharacterとそのSession色を得る"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details; https://github.com/natumekazuki/WithMate/issues/958" }
// fault = "user roleから人間と誤判定するか別Session世代の色を混ぜる"
// observable = "実SQLite receiptとmessage seqを経由したnavigator speakerとexecution senderTheme"
// observation_boundary = "public-boundary"
// scope = "受信一覧とカードの保存来歴"
// lifecycle = "permanent"
// impact = "発言者とカード色を別の人やSessionと取り違える"
// distinction = "renderer fixtureや個別role testでは保存receiptからUI用一覧とカード両方への結合を検証できない"
// @end-test-value
test("incoming sender and theme follow the exact saved receipt", async () => {
  await fixture(({ sessions, queue, turns, read }) => {
    const sender = sessions.insertSession({ ...session(), id: "sender", characterId: "sender-character", character: "Sender", characterThemeColors: { main: "#ff8c3c", sub: "#f6ebef" } });
    const recipient = sessions.insertSession({ ...session(), messages: [{ role: "user", text: "from sender" }, { role: "user", text: "from user" }] });
    const owner = { sessionId: recipient.id, incarnationId: getSessionIncarnationId(recipient) };
    const target = { kind: "main" as const, ...owner };
    const origin = { kind: "session" as const, operation: "send" as const, actorKind: "main" as const, actorSessionId: sender.id, actorIncarnationId: getSessionIncarnationId(sender), actorSnapshot: captureSessionTurnQueueDisplay(sender), targetSessionId: recipient.id, targetIncarnationId: owner.incarnationId };
    const send = (text: string, source: typeof origin | { kind: "gui"; operation: "send"; targetSessionId: string; targetIncarnationId: string }) => queue.enqueue(owner, { request: { userMessage: text, clientRequestId: randomUUID(), executionOptions: captureSessionExecutionOptions(recipient) }, provider: recipient.provider, workspacePath: recipient.workspacePath, attachments: [], origin: source });
    const receipt = send("from sender", origin);
    const get = (request: { receiptId: string } | { messageSeq: number }) => executionOperationResultSchemas.get_execution.parse(read.execute({ target, operation: "get_execution", request: { target, ...request } }));
    assert.deepEqual(get({ receiptId: receipt.id }).senderTheme, sender.characterThemeColors);
    const turn = turns.createSessionTurn({ sessionId: recipient.id, phase: "running", provider: recipient.provider, model: recipient.model, reasoningEffort: recipient.reasoningEffort, approvalMode: recipient.approvalMode, threadId: "", errorMessage: "", userMessageSeq: 0, createdAt: "2026-11-17T00:00:00Z" });
    queue.claimNext(owner); queue.markStarted(owner, receipt.id, { turnId: String(turn.id), userMessageSeq: 0 }); queue.settle(owner, receipt.id, "completed");
    const gui = send("from user", { kind: "gui", operation: "send", targetSessionId: recipient.id, targetIncarnationId: owner.incarnationId });
    const userTurn = turns.createSessionTurn({ sessionId: recipient.id, phase: "running", provider: recipient.provider, model: recipient.model, reasoningEffort: recipient.reasoningEffort, approvalMode: recipient.approvalMode, threadId: "", errorMessage: "", userMessageSeq: 1, createdAt: "2026-11-17T00:00:00Z" });
    queue.claimNext(owner); queue.markStarted(owner, gui.id, { turnId: String(userTurn.id), userMessageSeq: 1 });
    const rows = sessions.readConversationQueryBatch(recipient.id, -1);
    const nav = projectConversationBatch({ cacheScope: "sender-test", provider: recipient.provider, rows, query: { kind: "navigator", filter: "all" }, offset: 0, countBefore: 0 });
    assert.deepEqual(nav.items.map((item) => "speaker" in item ? item.speaker : null), [{ kind: "agent", name: "Sender", iconPath: "" }, { kind: "user" }]);
    assert.deepEqual(get({ messageSeq: 0 }).senderTheme, sender.characterThemeColors);
    const stale = send("stale", { ...origin, actorIncarnationId: "other-generation" });
    assert.equal(get({ receiptId: stale.id }).senderTheme, null);
  });
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliary送信者の色はその保存SessionのCharacterから取得し、世代と親の異なるSessionを混ぜない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details; https://github.com/natumekazuki/WithMate/issues/958" }
// fault = "Auxiliaryの親の色を使うか別世代または別の親の色を使う"
// observable = "受信receiptのexecution senderThemeと誤った親・世代の結果"
// observation_boundary = "public-boundary"
// scope = "Auxiliary送信元の保存色"
// lifecycle = "permanent"
// impact = "他の発言者の色を受信カードに表示する"
// distinction = "Mainの色testではAuxiliaryの別テーブルと親identityの確認を通らない"
// @end-test-value
test("incoming Auxiliary theme uses its exact saved identity", async () => {
  await fixture(({ sessions, auxiliary, queue, read }) => {
    const parent = sessions.insertSession({ ...session(), id: "aux-parent" });
    const recipient = sessions.insertSession(session());
    const snapshot = { characterId: "aux-character", name: "Aux Sender", description: "", iconFilePath: "", theme: { main: "#ff8c3c", sub: "#f6ebef" }, definitionMarkdown: "definition", definitionSha256: "", definitionByteSize: 0, snapshotAt: "now" };
    const aux = auxiliary.upsertAuxiliarySession({ ...captureSessionExecutionOptions(parent), id: "sender-aux", parentSessionId: parent.id, runState: "idle", title: "Aux", provider: "codex", catalogRevision: 1, threadId: "", composerDraft: "", messages: [], displayAfterMessageIndex: null, createdAt: "2026-11-07T00:00:00.000Z", updatedAt: "2026-11-07T00:00:00.000Z", characterId: snapshot.characterId, characterRuntimeSnapshot: snapshot });
    const owner = { sessionId: recipient.id, incarnationId: getSessionIncarnationId(recipient) }, target = { kind: "main" as const, ...owner };
    const origin = { kind: "session" as const, operation: "send" as const, actorKind: "auxiliary" as const, actorSessionId: aux.id, actorMainSessionId: parent.id, actorIncarnationId: aux.createdAt, actorSnapshot: { sessionTitle: aux.title, character: { id: snapshot.characterId, name: snapshot.name, iconPath: "" } }, targetSessionId: recipient.id, targetIncarnationId: owner.incarnationId };
    const readTheme = (source: typeof origin) => {
      const receipt = queue.enqueue(owner, { request: { userMessage: "incoming", clientRequestId: randomUUID(), executionOptions: captureSessionExecutionOptions(recipient) }, provider: recipient.provider, workspacePath: recipient.workspacePath, attachments: [], origin: source });
      return executionOperationResultSchemas.get_execution.parse(read.execute({ target, operation: "get_execution", request: { target, receiptId: receipt.id } })).senderTheme;
    };
    assert.deepEqual(readTheme(origin), snapshot.theme);
    assert.equal(readTheme({ ...origin, actorIncarnationId: "different" }), null);
    assert.equal(readTheme({ ...origin, actorMainSessionId: "different" }), null);
  });
});

// @test-value v2
// kind = "contract"
// claim = "直接Steer入力の色はTurn開始者ではなく入力自身の保存送信者から解決する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details; https://github.com/natumekazuki/WithMate/issues/958" }
// fault = "追加入力を開始Turnの送信者に帰属させる"
// observable = "直接Steer message seqのexecution senderThemeとnavigator speaker"
// observation_boundary = "public-boundary"
// scope = "直接Steerの保存送信者と色"
// lifecycle = "permanent"
// impact = "親Sessionの追加指示を別の発言者の色で表示する"
// distinction = "queue receiptのtestではmessage本文に保存された直接Steer originを通らない"
// @end-test-value
test("direct Steer uses the input sender theme and speaker", async () => {
  await fixture(({ sessions, turns, queue, read }) => {
    const sender = sessions.insertSession({ ...session(), id: "steer-sender", characterId: "parent-character", character: "Parent", characterThemeColors: { main: "#ff8c3c", sub: "#f6ebef" } });
    const starter = sessions.insertSession({ ...session(), id: "starter", characterId: "starter-character", character: "Starter" });
    const origin = { kind: "session" as const, operation: "steer" as const, actorKind: "main" as const, actorSessionId: sender.id, actorIncarnationId: getSessionIncarnationId(sender), actorTurnId: "7", actorSnapshot: captureSessionTurnQueueDisplay(sender), targetSessionId: "read-main", targetIncarnationId: "recipient-inc" };
    const recipient = sessions.insertSession({ ...session(), incarnationId: "recipient-inc", messages: [{ role: "user", text: "start" }, { role: "user", text: "steer", turnInput: { turnId: "1", nativeTurnId: "native", attachments: [], state: "confirmed", origin } }] });
    const turn = turns.createSessionTurn({ sessionId: recipient.id, phase: "running", provider: recipient.provider, model: recipient.model, reasoningEffort: recipient.reasoningEffort, approvalMode: recipient.approvalMode, threadId: "", errorMessage: "", userMessageSeq: 0, createdAt: "2026-11-17T00:00:00Z" });
    assert.equal(String(turn.id), "1");
    const target = { kind: "main" as const, sessionId: recipient.id, incarnationId: getSessionIncarnationId(recipient) };
    const startOrigin = { ...origin, operation: "send" as const, actorSessionId: starter.id, actorIncarnationId: getSessionIncarnationId(starter), actorSnapshot: captureSessionTurnQueueDisplay(starter) };
    const receipt = queue.enqueue({ sessionId: recipient.id, incarnationId: target.incarnationId }, { request: { userMessage: "start", clientRequestId: randomUUID(), executionOptions: captureSessionExecutionOptions(recipient) }, provider: recipient.provider, workspacePath: recipient.workspacePath, attachments: [], origin: startOrigin });
    queue.claimNext(target); queue.markStarted(target, receipt.id, { turnId: String(turn.id), userMessageSeq: 0 });
    const result = executionOperationResultSchemas.get_execution.parse(read.execute({ target, operation: "get_execution", request: { target, messageSeq: 1 } }));
    assert.deepEqual(result.senderTheme, sender.characterThemeColors);
    const rows = sessions.readConversationQueryBatch(recipient.id, -1);
    const nav = projectConversationBatch({ cacheScope: "steer-test", provider: recipient.provider, rows, query: { kind: "navigator", filter: "all" }, offset: 0, countBefore: 0 });
    assert.deepEqual(nav.items.map((item) => "speaker" in item && item.speaker), [{ kind: "agent", name: "Starter", iconPath: "" }, { kind: "agent", name: "Parent", iconPath: "" }]);
  });
});

// @test-value v2
// kind = "contract"
// claim = "複数宛先と同一宛先への受付を順に保持し、再試行では最初の位置を保ち、確定前の履歴では位置を公開しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/953" }
// fault = "宛先や送信ごとにreceiptを失う、再試行で位置を上書きする、または未検証の位置を保存履歴へ公開する"
// observable = "receipt IDと宛先の受付順、およびlist_sent_deliveriesの保存後のsourceDisplayPosition"
// observation_boundary = "public-boundary"
// scope = "送信receiptへの表示位置保存と履歴読み出し"
// lifecycle = "permanent"
// impact = "同じ送信が重複したり、異なる発言位置に表示されたりする"
// distinction = "型検査と既存のreceiptテストは表示位置の受付と公開条件を検証しない"
// @end-test-value
test("sent position survives idempotent retry only after verification", async () => {
  await fixture(({ sessions, turns, queue, read }) => {
    const sender = sessions.insertSession({ ...session(), messages: [{ role: "user", text: "start" }, { role: "assistant", text: "before after" }] });
    const recipient = sessions.insertSession({ ...session(), id: "recipient-position" });
    const otherRecipient = sessions.insertSession({ ...session(), id: "recipient-other" });
    const source = { kind: "main" as const, sessionId: sender.id, incarnationId: getSessionIncarnationId(sender) };
    const owner = { sessionId: recipient.id, incarnationId: getSessionIncarnationId(recipient) };
    const turn = turns.createSessionTurn({ sessionId: sender.id, provider: sender.provider, model: sender.model, reasoningEffort: sender.reasoningEffort, approvalMode: sender.approvalMode, threadId: "", errorMessage: "", createdAt: "2026-11-07T00:00:00Z", phase: "completed", userMessageSeq: 0, assistantMessageSeq: 1 });
    const origin = { kind: "session" as const, actorKind: "main" as const, actorSessionId: sender.id, actorIncarnationId: source.incarnationId, actorTurnId: String(turn.id), operation: "send" as const, targetSessionId: recipient.id, targetIncarnationId: owner.incarnationId };
    const captured = { request: { userMessage: "message", clientRequestId: randomUUID(), submitSource: "composer" as const, executionOptions: captureSessionExecutionOptions(recipient) }, attachments: [], provider: recipient.provider, workspacePath: recipient.workspacePath, origin, sourceDisplayPosition: 6 };
    const first = queue.enqueue(owner, captured);
    assert.equal(queue.enqueue(owner, { ...captured, sourceDisplayPosition: 11 }).id, first.id);
    const otherOwner = { sessionId: otherRecipient.id, incarnationId: getSessionIncarnationId(otherRecipient) };
    const second = queue.enqueue(otherOwner, { ...captured, request: { ...captured.request, clientRequestId: randomUUID() }, origin: { ...origin, targetSessionId: otherOwner.sessionId, targetIncarnationId: otherOwner.incarnationId } });
    const third = queue.enqueue(owner, { ...captured, request: { ...captured.request, clientRequestId: randomUUID() }, sourceDisplayPosition: 9 });
    const readItems = () => executionOperationResultSchemas.list_sent_deliveries.parse(read.execute({ target: source, operation: "list_sent_deliveries", request: { target: source, messageSeqs: [1] } })).items;
    assert.deepEqual(readItems().map((item) => [item.receiptId, item.target.sessionId]), [[first.id, owner.sessionId], [second.id, otherOwner.sessionId], [third.id, owner.sessionId]]);
    const readPosition = () => executionOperationResultSchemas.list_sent_deliveries.parse(read.execute({ target: source, operation: "list_sent_deliveries", request: { target: source, messageSeqs: [1] } })).items[0].sourceDisplayPosition;
    assert.equal(readPosition(), null);
    queue.verifySourceDisplayPosition(first.id, sender.id, source.incarnationId, String(turn.id), true);
    assert.equal(readPosition(), 6);
    queue.verifySourceDisplayPosition(first.id, sender.id, source.incarnationId, String(turn.id), false);
    assert.equal(readPosition(), null);
  });
});

// @test-value v2
// kind = "contract"
// claim = "execution読取は未開始と完了後も入力に捕捉した実行設定を返し、受付のない過去Turnでは保存済み設定と未記録を区別する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details; user request: 現行のProvider等を保持して改善" }
// fault = "現在のSession設定で受付を上書きする、完了後の保存message参照で設定を落とす、過去Turnへ未記録Reviewer等を補う"
// observable = "実SQLiteの共通get_executionを公開schemaでparseしたexecutionSettingsとその出典"
// observation_boundary = "public-boundary"
// scope = "receiptと保存messageSeq、receipt-less Turnからの実行設定投影"
// lifecycle = "permanent"
// impact = "利用者が指示に指定したProvider・Model・承認設定を取り違える"
// distinction = "型検査とrenderer固定fixtureでは受付の保存値・現在設定・履歴参照の選択を検証できない。単一SQLite fixtureで必要な3状態を確認する"
// @end-test-value
test("execution settings retain the captured selection through queued and saved input reads", async () => {
  await fixture(({ sessions, queue, turns, read }) => {
    const saved = sessions.insertSession({ ...session(), model: "captured-model", reasoningEffort: "xhigh", codexReviewer: "auto-review", codexSpeed: "fast", messages: [{ role: "user", text: "instruction" }] });
    const owner = { sessionId: saved.id, incarnationId: getSessionIncarnationId(saved) }, target = { kind: "main" as const, ...owner };
    const options = captureSessionExecutionOptions(saved);
    const receipt = queue.enqueue(owner, { request: { userMessage: "instruction", clientRequestId: randomUUID(), executionOptions: options }, attachments: [], provider: saved.provider, workspacePath: saved.workspacePath });
    sessions.setSessionExecutionOptions(saved.id, owner.incarnationId, { ...options, model: "next-model", codexSpeed: "standard", approvalMode: "never" });
    const get = (reference: { receiptId: string } | { messageSeq: number } | { turnId: string }) => executionOperationResultSchemas.get_execution.parse(read.execute({ target, operation: "get_execution", request: { target, ...reference } }));
    const expected = { source: "input", provider: saved.provider, ...options };
    assert.deepEqual(get({ receiptId: receipt.id }).executionSettings, expected);
    const turn = turns.createSessionTurn({ sessionId: saved.id, phase: "completed", provider: saved.provider, model: "resolved-model", reasoningEffort: "high", approvalMode: "on-request", threadId: "", errorMessage: "", userMessageSeq: 0, createdAt: "2026-11-08T00:00:00Z" });
    queue.claimNext(owner); queue.markStarted(owner, receipt.id, { turnId: String(turn.id), userMessageSeq: 0 }); queue.settle(owner, receipt.id, "completed");
    assert.equal(queue.listActive(owner).length, 0);
    assert.deepEqual(get({ messageSeq: 0 }).executionSettings, expected);
    const historical = turns.createSessionTurn({ sessionId: saved.id, phase: "completed", provider: "codex", model: "historical-model", reasoningEffort: "low", approvalMode: "untrusted", threadId: "", errorMessage: "", createdAt: "2026-11-07T00:00:00Z" });
    assert.deepEqual(get({ turnId: String(historical.id) }).executionSettings, { source: "turn", provider: "codex", model: "historical-model", reasoningEffort: "low", approvalMode: "untrusted", codexSandboxMode: "", codexReviewer: null, codexSpeed: null, customAgentName: null });
  });
});

// @test-value v2
// kind = "contract"
// claim = "送信時のCharacterとSession名は保存済みoriginから取得し、名称変更・編集・終端後も過去の送信者を入れ替えない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/837" }
// fault = "execution読取のschemaが表示snapshotを落とすか、入力編集・終端で保存済み送信者を置き換える"
// observable = "実SQLite receiptと保存messageSeqのexecution公開結果に含まれるorigin snapshot"
// observation_boundary = "public-boundary"
// scope = "受付originから完了済み会話executionへの投影"
// lifecycle = "permanent"
// impact = "別Sessionからの指示を誰の発言か取り違えることを防ぐ"
// distinction = "型検査とqueue単体ではexecutionの公開schemaと保存message参照を通るsnapshot保持を検証できない"
// @end-test-value
test("saved sender display survives edits and completion without adopting current metadata", async () => {
  await fixture(({ sessions, queue, turns, read }) => {
    const sender = sessions.insertSession({ ...session(), id: "sender", taskTitle: "Original Sender", character: "Sender", characterIconPath: "C:/sender.png" });
    const receiver = sessions.insertSession({ ...session(), messages: [{ role: "user", text: "edited instruction" }, { role: "assistant", text: "answer" }] });
    const owner = { sessionId: receiver.id, incarnationId: getSessionIncarnationId(receiver) };
    const origin = { kind: "session" as const, actorKind: "main" as const, actorSessionId: sender.id, actorIncarnationId: getSessionIncarnationId(sender), actorTurnId: "12", actorSnapshot: captureSessionTurnQueueDisplay(sender), operation: "send" as const, targetSessionId: owner.sessionId, targetIncarnationId: owner.incarnationId, targetSnapshot: captureSessionTurnQueueDisplay(receiver) };
    const receipt = queue.enqueue(owner, { request: { userMessage: "original instruction", clientRequestId: randomUUID(), submitSource: "composer", executionOptions: captureSessionExecutionOptions(receiver) }, attachments: [], provider: receiver.provider, workspacePath: receiver.workspacePath, origin });
    queue.updateQueued(owner, receipt.id, { userMessage: "edited instruction", attachments: [] });
    sessions.patchSessionMetadata(sender.id, getSessionIncarnationId(sender), { title: "Renamed Sender" });
    const turn = turns.createSessionTurn({ sessionId: receiver.id, provider: receiver.provider, model: receiver.model, reasoningEffort: receiver.reasoningEffort, approvalMode: receiver.approvalMode, threadId: "", errorMessage: "", createdAt: "2026-11-07T00:00:00Z", phase: "completed", userMessageSeq: 0, assistantMessageSeq: 1 });
    queue.claimNext(owner); queue.markStarted(owner, receipt.id, { turnId: String(turn.id), userMessageSeq: 0 }); queue.settle(owner, receipt.id, "completed");
    assert.equal(queue.listActive(owner).length, 0);
    const target = { kind: "main" as const, ...owner };
    const result = executionOperationResultSchemas.get_execution.parse(read.execute({ target, operation: "get_execution", request: { target, messageSeq: 0 } }));
    assert.deepEqual(result.origin, origin);
    assert.equal(result.origin?.actorSnapshot?.sessionTitle, "Original Sender");
  });
});

// @test-value v2
// kind = "contract"
// claim = "表示範囲の送信は実actorのTurnへ一意に結び、原文全文と配送状態を保持し、新旧Coordination通知だけに送受信共通で人向け全文を併記する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/837" }
// fault = "同じTurnのuserとassistant参照で送信を重複させる、他actorの受付を混ぜる、編集本文を原文へ置換する、またはcursorで送信を欠落する"
// observable = "共通list_sent_deliveriesのreceipt ID順とcursor、原文、get_executionの正確な受付による新旧Coordination全文、通常JSONの原文維持"
// observation_boundary = "public-boundary"
// scope = "既存receiptからの送信側一括execution読取"
// lifecycle = "permanent"
// impact = "利用者が送信相手や送信内容、取消済み受付を取り違えることを防ぐ"
// distinction = "受信側queueや型検査ではsource message群から複数宛先receiptを逆引く結合とkeyset継続を検証できない"
// @end-test-value
test("outgoing deliveries batch exact source Turns with full immutable content and cursor", async () => {
  await fixture(({ sessions, turns, queue, read }) => {
    const sender = sessions.insertSession({ ...session(), messages: [{ role: "user", text: "start" }, { role: "assistant", text: "answer" }, { role: "user", text: "later" }, { role: "assistant", text: "later answer" }] });
    const recipient = sessions.insertSession({ ...session(), id: "recipient" });
    const recipientOwner = { sessionId: recipient.id, incarnationId: getSessionIncarnationId(recipient) };
    const base = { sessionId: sender.id, provider: sender.provider, model: sender.model, reasoningEffort: sender.reasoningEffort, approvalMode: sender.approvalMode, threadId: "", errorMessage: "", createdAt: "2026-11-07T00:00:00Z", phase: "completed" as const };
    const first = turns.createSessionTurn({ ...base, userMessageSeq: 0, assistantMessageSeq: 1 });
    const later = turns.createSessionTurn({ ...base, userMessageSeq: 2, assistantMessageSeq: 3 });
    const origin = { kind: "session" as const, actorKind: "main" as const, actorSessionId: sender.id, actorIncarnationId: getSessionIncarnationId(sender), actorTurnId: String(first.id), operation: "send" as const, targetSessionId: recipient.id, targetIncarnationId: recipientOwner.incarnationId };
    const send = (text: string, patch: object = {}) => queue.enqueue(recipientOwner, { request: { userMessage: text, clientRequestId: randomUUID(), submitSource: "composer", executionOptions: captureSessionExecutionOptions(recipient) }, attachments: [], provider: recipient.provider, workspacePath: recipient.workspacePath, origin: { ...origin, ...patch } });
    const a = send("a".repeat(400));
    const b = send("second"); queue.cancelQueued(recipientOwner, b.id);
    send("other incarnation", { actorIncarnationId: "different" });
    send("other kind", { actorKind: "auxiliary" });
    send("later", { actorTurnId: String(later.id) });
    queue.updateQueued(recipientOwner, a.id, { userMessage: "edited", attachments: [] });
    const target = { kind: "main" as const, sessionId: sender.id, incarnationId: getSessionIncarnationId(sender) };
    const call = (extra: object = {}) => executionOperationResultSchemas.list_sent_deliveries.parse(read.execute({ target, operation: "list_sent_deliveries", request: { target, messageSeqs: [0, 1], limit: 1, ...extra } }));
    const page = call();
    assert.deepEqual(page.items.map((item) => [item.receiptId, item.sourceMessageSeq, item.text, item.state]), [[a.id, 1, "a".repeat(400), "queued"]]);
    assert.equal(page.items[0].origin.actorSnapshot, undefined);
    assert.deepEqual(page.items[0].target, { kind: "main", ...recipientOwner });
    const next = call({ cursor: page.nextCursor });
    assert.deepEqual(next.items.map((item) => [item.receiptId, item.state]), [[b.id, "canceled"]]);
    assert.equal(next.nextCursor, null);
    const live = call({ messageSeqs: [], liveTurnIds: [String(first.id)], limit: 20 });
    assert.deepEqual(live.items.map((item) => [item.receiptId, item.sourceMessageSeq]), [[a.id, null], [b.id, null]]);
    assert.deepEqual(call({ messageSeqs: [2, 3] }).items.map((item) => item.text), ["later"]);
    const answer = "Saved answer ".repeat(80);
    const actor = { kind: "main" as const, sessionId: sender.id, incarnationId: getSessionIncarnationId(sender), turnId: String(first.id) };
    const snapshot = { coordinationId: "coordination", kind: "blocker" as const, consultation: "Saved question", actor, operation: "answer", answer: { id: "answer", revision: 1, actor, body: answer, selectedChoices: [], createdAt: "now" }, state: "open" as const, withdrawalReason: null };
    const notification = JSON.stringify(snapshot);
    const ordinary = send(notification);
    const legacy = { request: { userMessage: notification, clientRequestId: randomUUID(), submitSource: "composer" as const, executionOptions: captureSessionExecutionOptions(recipient) }, attachments: [], provider: recipient.provider, workspacePath: recipient.workspacePath, origin,
      coordination: { id: "coordination", operation: "answer", actor, answerId: "answer", answerRevision: 1 } };
    const coordinated = queue.enqueue(recipientOwner, legacy);
    const natural = queue.enqueue(recipientOwner, { ...legacy, request: { ...legacy.request, clientRequestId: randomUUID(), userMessage: answer }, coordination: { ...legacy.coordination, notification: snapshot } });
    const projected = call({ limit: 20 });
    const item = projected.items.find((entry) => entry.receiptId === coordinated.id)!;
    assert.deepEqual(item.coordination, { id: "coordination", text: answer, consultation: "Saved question" });
    assert.equal(item.text, notification);
    assert.equal(projected.items.find((entry) => entry.receiptId === ordinary.id)?.coordination, undefined);
    assert.deepEqual(projected.items.find((entry) => entry.receiptId === natural.id)?.coordination, { id: "coordination", text: answer, consultation: "Saved question" });
    const recipientTarget = { kind: "main" as const, ...recipientOwner };
    for (const receipt of [coordinated, natural, ordinary]) {
      const execution = executionOperationResultSchemas.get_execution.parse(read.execute({ target: recipientTarget, operation: "get_execution", request: { target: recipientTarget, receiptId: receipt.id } }));
      assert.deepEqual(execution.coordination, receipt === ordinary ? undefined : { id: "coordination", text: answer, consultation: "Saved question" });
      const original = executionOperationResultSchemas.get_execution_input.parse(read.execute({ target: recipientTarget, operation: "get_execution_input", request: { target: recipientTarget, receiptId: receipt.id, stage: "original" } }));
      assert.equal(original.text, receipt === natural ? answer : notification);
    }
  });
});

// @test-value v2
// kind = "contract"
// claim = "受付とTurnの結果は正確な保存seqを参照し、後続回答・未確定追加入力・取消後の本文確定を取り違えない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/836" }
// fault = "最新assistantを返す、未確定入力をconfirmedへ含める、または取消時に本文の確定情報を落とす"
// observable = "実SQLiteから取得するexecutionのTurn参照・input概要・output断片・artifact操作と公開結果schema検証"
// observation_boundary = "public-boundary"
// scope = "saved execution exact result and input read"
// lifecycle = "permanent"
// impact = "別の依頼結果を回収し、未配送指示を実行済みと誤認することを防ぐ"
// distinction = "型検査やqueue単体ではreceipt→Turn→Messageと既存artifact読取の結合を保証できない"
// @end-test-value
test("exact receipt and Turn reads preserve partial output and committed input identity", async () => {
  await fixture(({ sessions, turns, queue, read }) => {
    const projected = projectProviderOutput([{ id: "answer", text: "あ😀answer", phase: "final_answer", role: "answer", completion: "complete", final: true, evidence: "codex.final_answer:item/completed" }], "identified");
    const saved = sessions.insertSession({ ...session(), messages: [
      { role: "user", text: "start" },
      { role: "user", text: "confirmed", turnInput: { turnId: "1", nativeTurnId: "native", state: "confirmed", attachments: [] } },
      { role: "user", text: "uncertain", turnInput: { turnId: "1", nativeTurnId: "native", state: "unknown", attachments: [] } },
      { role: "assistant", text: projected.assistantText, output: projected.output, artifact: { title: "tool", activitySummary: [], changedFiles: [], runChecks: [], operationTimeline: [{ id: "tool", type: "command_execution", summary: "check", details: "saved detail", status: "failed" }] } },
      { role: "user", text: "later" }, { role: "assistant", text: "wrong latest" },
    ] });
    const base = { sessionId: saved.id, provider: "codex", model: saved.model, reasoningEffort: saved.reasoningEffort, approvalMode: saved.approvalMode, threadId: "", errorMessage: "", createdAt: "2026-11-07T00:00:00.000Z" };
    const turn = turns.createSessionTurn({ ...base, phase: "canceled", userMessageSeq: 0, assistantMessageSeq: 3 });
    turns.createSessionTurn({ ...base, phase: "completed", userMessageSeq: 4, assistantMessageSeq: 5 });
    const owner = { sessionId: saved.id, incarnationId: getSessionIncarnationId(saved) };
    const receipt = queue.enqueue(owner, { request: { userMessage: "start", clientRequestId: randomUUID(), submitSource: "composer", executionOptions: captureSessionExecutionOptions(saved) }, attachments: [], provider: "codex", workspacePath: saved.workspacePath });
    queue.claimNext(owner); queue.markStarted(owner, receipt.id, { turnId: String(turn.id), userMessageSeq: 0 });
    queue.settle(owner, receipt.id, "canceled");
    const target = { kind: "main" as const, ...owner };
    const call = (operation: ExecutionReadOperation, fields: object) => read.execute({ target, operation, request: { target, ...fields } as never }) as Record<string, any>;
    const result = call("get_execution", { receiptId: receipt.id });
    executionOperationResultSchemas.get_execution.parse(result);
    assert.deepEqual([result.turnId, result.turnState, result.resultState, result.assistantMessageSeq], ["1", "canceled", "partial", 3]);
    assert.equal(result.inputs.additional.confirmedCount, 1);
    assert.deepEqual([call("get_execution", { messageSeq: 0 }).receiptId, call("get_execution", { messageSeq: 1 }).turnId, call("get_execution", { messageSeq: 5 }).turnId], [receipt.id, "1", "2"]);
    assert.equal(call("get_execution_input", { messageSeq: 1 }).text, "confirmed");
    assert.deepEqual(result.inputs.additional.unresolved, [{ seq: 2, state: "unknown" }]);
    const output = call("get_execution_output", { receiptId: receipt.id, index: 0, maxChars: 2 });
    executionOperationResultSchemas.get_execution_output.parse(output);
    assert.equal(output.text, "あ"); assert.equal(output.nextOffset, 1); assert.equal(output.unit.final, true);
    assert.equal(call("get_execution_output", { turnId: "1", index: 0, offset: 1, maxChars: 1 }).text, "😀");
    assert.equal(call("get_execution_output", { turnId: "1", index: 0, offset: 2 }).code, "EXECUTION_INVALID_REQUEST");
    assert.equal(call("get_execution_operation_detail", { turnId: "1", kind: "operation", index: 0 }).text, "saved detail");
    const inputs = call("list_execution_inputs", { receiptId: receipt.id });
    executionOperationResultSchemas.list_execution_inputs.parse(inputs);
    assert.deepEqual(inputs.items.map((entry: any) => [entry.seq, entry.kind]), [[0, "start"], [1, "additional"]]);
    const unresolved = call("list_execution_inputs", { receiptId: receipt.id, state: "unresolved" });
    executionOperationResultSchemas.list_execution_inputs.parse(unresolved);
    assert.deepEqual(unresolved.items.map((entry: any) => [entry.seq, entry.state]), [[2, "unknown"]]);
    assert.equal(call("get_execution_input", { turnId: "1", seq: 4 }).code, "EXECUTION_INPUT_NOT_FOUND");
    assert.equal(call("get_execution", { turnId: "999" }).code, "EXECUTION_NOT_FOUND");
    assert.equal(read.execute({ target: { ...target, incarnationId: "replaced" }, operation: "get_execution", request: { target: { ...target, incarnationId: "replaced" }, turnId: "1" } }).ok, false);
  });
});

// @test-value v2
// kind = "contract"
// claim = "長文予定入力の続きを編集中の古いsnapshotへ継ぎ足さず、原文比較と未実行受付を結果へ偽装しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/836" }
// fault = "予定入力の再編集後に旧cursorで新本文を返すか、取消済み未開始受付へ最新Turnを割り当てる"
// observable = "公開input pageの短いcursor・原文本文・比較状態・restart失敗と未開始のresultState"
// observation_boundary = "public-boundary"
// scope = "receipt planned input paging and immutable accepted comparison"
// lifecycle = "permanent"
// impact = "異なる入力版を混在させた指示を実行入力として回収することを防ぐ"
// distinction = "編集storageだけの検証では公開readのcursorと保存snapshot比較を観測しない"
// @end-test-value
test("mutable input paging requires the same saved version and preserves original", async () => {
  await fixture(({ sessions, queue, read }) => {
    const saved = sessions.insertSession(session());
    const owner = { sessionId: saved.id, incarnationId: getSessionIncarnationId(saved) }, target = { kind: "main" as const, ...owner };
    const receipt = queue.enqueue(owner, { request: { userMessage: "original", clientRequestId: randomUUID(), submitSource: "composer", executionOptions: captureSessionExecutionOptions(saved) }, attachments: [], provider: "codex", workspacePath: saved.workspacePath });
    const get = (operation: ExecutionReadOperation, more: object = {}) => read.execute({ target, operation, request: { target, receiptId: receipt.id, ...more } as never }) as Record<string, any>;
    queue.updateQueued(owner, receipt.id, { userMessage: "changed".repeat(10000), attachments: [] });
    const first = get("get_execution_input", { maxChars: 3 });
    executionOperationResultSchemas.get_execution_input.parse(first);
    assert.equal(first.text, "cha"); assert.ok(first.expectedInput.length < 1024);
    assert.equal(first.inputs.entry.comparison, "changed");
    queue.updateQueued(owner, receipt.id, { userMessage: "original", attachments: [] });
    assert.equal(get("get_execution_input", { offset: 3, expectedInput: first.expectedInput }).code, "EXECUTION_INPUT_RESTART_REQUIRED");
    assert.equal(get("get_execution_input", { stage: "original" }).text, "original");
    assert.equal(get("get_execution").inputs.entry.comparison, "unchanged");
    queue.cancelQueued(owner, receipt.id);
    assert.deepEqual([get("get_execution").receiptState, get("get_execution").turnId, get("get_execution").resultState], ["canceled", null, "not-started"]);
    const listing = read.execute({ target, operation: "list_executions", request: { target, limit: 1 } });
    executionOperationResultSchemas.list_executions.parse(listing);
  });
});

// @test-value v2
// kind = "contract"
// claim = "受付を持たない既存Auxiliary Turnの保存本文は親identityを検証して取得し、記録されていない出力分類と追加入力網羅性を不明のまま返す"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/836" }
// fault = "AuxiliaryをMainや別親へ取り違える、原文・最終回答・追加なしを過去本文から捏造する"
// observable = "実SQLiteのAuxiliary exact Turn読取、unknown分類と原文未記録失敗、異なる親identityでの拒否"
// observation_boundary = "public-boundary"
// scope = "Auxiliary saved execution legacy coverage and owner identity"
// lifecycle = "permanent"
// impact = "別会話の結果を回収し、欠けている履歴を完全な実行記録と誤認することを防ぐ"
// distinction = "Main結果のtestはAuxiliaryの別message表・親incarnationの照合を通らない"
// @end-test-value
test("Auxiliary receipt-less saved Turns preserve unknown historical classification", async () => {
  await fixture(({ sessions, auxiliary, turns, read }) => {
    const main = sessions.insertSession(session());
    const aux = auxiliary.upsertAuxiliarySession({ ...captureSessionExecutionOptions(main), id: "aux-read", parentSessionId: main.id, runState: "idle", title: "aux", provider: "codex", catalogRevision: 1, threadId: "", composerDraft: "", messages: [{ role: "user", text: "old input" }, { role: "assistant", text: "old answer" }, { role: "user", text: "unlinked history" }], displayAfterMessageIndex: null, createdAt: "2026-11-07T00:00:00.000Z", updatedAt: "2026-11-07T00:00:00.000Z" });
    const turn = turns.createSessionTurn({ sessionId: aux.id, provider: "codex", model: main.model, reasoningEffort: main.reasoningEffort, approvalMode: main.approvalMode, threadId: "", phase: "completed", userMessageSeq: 0, assistantMessageSeq: 1, errorMessage: "", createdAt: aux.createdAt });
    const target = { kind: "auxiliary" as const, sessionId: aux.id, incarnationId: aux.createdAt, mainSessionId: main.id, mainIncarnationId: getSessionIncarnationId(main) };
    const call = (operation: ExecutionReadOperation) => read.execute({ target, operation, request: { target, turnId: String(turn.id), ...(operation === "get_execution_output" ? { index: 0 } : {}) } as never }) as Record<string, any>;
    assert.equal(call("get_execution").inputs.additional.coverage, "unknown");
    const output = call("get_execution_output");
    assert.deepEqual([output.text, output.unit.completion, output.finality], ["old answer", "unknown", "unknown"]);
    const badTarget = { ...target, mainIncarnationId: "wrong" };
    assert.equal(read.execute({ target: badTarget, operation: "get_execution", request: { target: badTarget, turnId: String(turn.id) } }).ok, false);
    const input = read.execute({ target, operation: "get_execution_input", request: { target, turnId: String(turn.id), stage: "original" } }) as Record<string, any>;
    assert.equal(input.code, "EXECUTION_INPUT_UNKNOWN");
    const history = read.execute({ target, operation: "get_message", request: { target, seq: 2 } }) as Record<string, any>;
    executionOperationResultSchemas.get_message.parse(history);
    assert.deepEqual([history.text, history.turn], ["unlinked history", null]);
    const missingLink = read.execute({ target, operation: "get_execution", request: { target, messageSeq: 2 } }) as Record<string, any>;
    assert.equal(missingLink.code, "EXECUTION_LINK_UNAVAILABLE");
    const list = read.execute({ target, operation: "list_messages", request: { target, limit: 1, offset: 2 } }) as Record<string, any>;
    executionOperationResultSchemas.list_messages.parse(list);
    assert.deepEqual([list.total, list.items[0].seq, list.nextOffset], [3, 2, null]);
  });
});
