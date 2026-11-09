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
import { buildNewSession, getSessionIncarnationId } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { projectProviderOutput } from "../../src-shared/session/provider-output.js";
import { executionOperationResultSchemas, type ExecutionReadOperation } from "../../src-shared/session/session-execution-read.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { captureSessionTurnQueueDisplay } from "../../src-shared/session/session-turn-queue.js";

async function fixture(action: (context: { sessions: SessionStorageV6; turns: SessionTurnStorageV6; queue: SessionTurnQueueStorageV6; read: SessionExecutionReadStorage; auxiliary: AuxiliarySessionStorage }) => void) {
  const directory = await mkdtemp(join(tmpdir(), "withmate-execution-read-"));
  const db = join(directory, "app.db");
  const sessions = new SessionStorageV6(db), turns = new SessionTurnStorageV6(db), queue = new SessionTurnQueueStorageV6(db), read = new SessionExecutionReadStorage(db);
  const auxiliary = new AuxiliarySessionStorage(db);
  try { action({ sessions, turns, queue, read, auxiliary }); }
  finally { auxiliary.close(); read.close(); queue.close(); turns.close(); sessions.close(); await rm(directory, { recursive: true, force: true }); }
}
function session() { return buildNewSession({ id: "read-main", taskTitle: "Read", workspaceLabel: "workspace", workspacePath: "C:/workspace", branch: "main", characterId: "unknown", character: "Unknown", characterIconPath: "", characterThemeColors: { main: "#112233", sub: "#445566" }, approvalMode: "on-request" }); }

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
// claim = "表示範囲の送信はsource Turnと実actorを一致させて一度だけ返し、受付順の件数pageで原文全文と配送状態を保持し、保存済みCoordination通知だけに人向け全文を併記する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/837" }
// fault = "同じTurnのuserとassistant参照で送信を重複させる、他actorの受付を混ぜる、編集本文を原文へ置換する、またはcursorで送信を欠落する"
// observable = "共通list_sent_deliveriesのreceipt ID順、source anchor、編集前の全文、原状態、続きcursor、Coordination全文投影と原文の分離"
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
    const notification = JSON.stringify({ consultation: "Saved question", answer: { body: answer } });
    const ordinary = send(notification);
    const coordinated = queue.enqueue(recipientOwner, { request: { userMessage: notification, clientRequestId: randomUUID(), submitSource: "composer", executionOptions: captureSessionExecutionOptions(recipient) }, attachments: [], provider: recipient.provider, workspacePath: recipient.workspacePath, origin,
      coordination: { id: "coordination", operation: "answer", actor: { kind: "main", sessionId: sender.id, incarnationId: getSessionIncarnationId(sender), turnId: String(first.id) } } });
    const projected = call({ limit: 20 });
    const item = projected.items.find((entry) => entry.receiptId === coordinated.id)!;
    assert.deepEqual(item.coordination, { id: "coordination", text: answer });
    assert.equal(item.text, notification);
    assert.equal(projected.items.find((entry) => entry.receiptId === ordinary.id)?.coordination, undefined);
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
