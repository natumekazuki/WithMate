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
