import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { buildNewSession, getSessionIncarnationId, type Message, type Session } from "../../src-shared/session/session-state.js";
import type { SessionHistoryOperation, SessionHistoryReadScope, SessionHistoryRequest, SessionHistoryResult } from "../../src-shared/session-history/session-history-contract.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { SessionTurnStorageV6 } from "../../src-electron/session/session-turn-storage-v6.js";

const longDetail = "ab😀cdef";
const messages: Message[] = [
  { role: "user", text: "run the tests" },
  { role: "assistant", text: "tests failed", artifact: {
    title: "Run", activitySummary: ["ran"],
    operationTimeline: [
      { id: "op-1", type: "command_execution", summary: "npm test", status: "failed", exitCode: 1, truncated: true, details: longDetail },
      { id: "op-2", type: "mcp_tool_call", summary: "server/tool", status: "completed" },
    ],
    changedFiles: [{ kind: "edit", path: "src/a.ts", summary: "edited", diffRows: [
      { kind: "context", leftNumber: 1, rightNumber: 1, leftText: "a", rightText: "a" },
      { kind: "add", rightNumber: 2, rightText: "b" }, { kind: "add", rightNumber: 3, rightText: "c" },
    ] }],
    runChecks: [{ label: "npm test", value: "fail" }],
  } },
  { role: "user", text: "retry" },
  { role: "assistant", text: "capacity reached", elicitationRecords: [{ requestId: "q1", kind: "question", message: "Q".repeat(50), fields: [{ title: "choice" }], status: "pending" }] },
  { role: "user", text: "still waiting" },
  { role: "user", text: "steered input" },
];

function mainSession(id: string): Session {
  return { ...buildNewSession({
    id, taskTitle: "history", workspaceLabel: "workspace", workspacePath: "C:/workspace", branch: "main", characterId: "mate", character: "Mate",
    characterIconPath: "", characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: DEFAULT_APPROVAL_MODE,
  }), messages };
}

function auxiliarySession(parentSessionId: string): AuxiliarySession {
  return {
    id: "aux-1", parentSessionId, status: "active", runState: "idle", title: "Aux", provider: "codex", catalogRevision: 1, model: "gpt-5.4",
    reasoningEffort: "high", approvalMode: DEFAULT_APPROVAL_MODE, codexSandboxMode: "danger-full-access", codexSpeed: "standard", codexReviewer: "user",
    customAgentName: "", threadId: "", composerDraft: "", messages: [{ role: "user", text: "aux question" }, { role: "assistant", text: "aux answer" }],
    displayAfterMessageIndex: null, createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T00:00:00.000Z", closedAt: "",
  };
}

function addTurns(turns: SessionTurnStorageV6, sessionId: string): void {
  const base = { sessionId, provider: "codex", model: "gpt-5.4", reasoningEffort: "high" as const, approvalMode: DEFAULT_APPROVAL_MODE, threadId: "", createdAt: "2026-07-30T00:00:00.000Z" };
  turns.createSessionTurn({ ...base, phase: "completed", userMessageSeq: 0, assistantMessageSeq: 1, errorMessage: "" });
  turns.createSessionTurn({ ...base, phase: "failed", userMessageSeq: 2, assistantMessageSeq: 3, errorMessage: "Model capacity reached." });
  turns.createSessionTurn({ ...base, phase: "running", userMessageSeq: 4, errorMessage: "" });
}

async function withStorages(action: (context: { main: SessionStorageV6; auxiliary: AuxiliarySessionStorage; turns: SessionTurnStorageV6 }) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-history-"));
  const dbPath = path.join(directory, "app.db");
  const main = new SessionStorageV6(dbPath);
  const auxiliary = new AuxiliarySessionStorage(dbPath);
  const turns = new SessionTurnStorageV6(dbPath);
  try { await action({ main, auxiliary, turns }); }
  finally { turns.close(); auxiliary.close(); main.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}

function mainScope(session: Session, toSeq = 4): SessionHistoryReadScope {
  return { source: { kind: "main", sessionId: session.id, incarnationId: getSessionIncarnationId(session) }, window: { fromSeq: 0, toSeq } };
}

function read<K extends SessionHistoryOperation>(storage: { readSessionHistory(input: never): SessionHistoryResult }, scope: SessionHistoryReadScope, operation: K, request: SessionHistoryRequest<K>) {
  return (storage as { readSessionHistory(input: unknown): SessionHistoryResult }).readSessionHistory({ scope, operation, request });
}

function failureCode(result: SessionHistoryResult): string | undefined { return result.ok ? undefined : result.code; }

// @test-value v2
// kind = "contract"
// claim = "固定windowの保存済み会話は順序・Turn対応・操作の成否と詳細を保存どおり返し、window外・未保存・追加入力を区別して空の成功にしない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/908" }
// fault = "windowを超えて追加入力を返す、Turnを推定で付ける、縮約済み本文から成否を補う、未保存を空の成功で返す、または多バイト文字の途中で分割する"
// observable = "storageのreadSessionHistoryの結果（件数・Turn・status・exitCode・本文断片・失敗code）"
// observation_boundary = "public-boundary"
// scope = "session-history-read"
// lifecycle = "permanent"
// impact = "背景生成が欠落や別範囲の履歴を根拠に誤った記録を作ることを防ぐ"
// distinction = "型やschemaでは実SQLiteのseq・Turn表・artifact_bodyの結合と固定範囲を保証できない"
// @end-test-value
test("Mainの固定範囲を順序とTurn対応を保って返し、省略と未保存を区別する", async () => {
  await withStorages(async ({ main, turns }) => {
    const session = main.insertSession(mainSession("main-1"));
    addTurns(turns, session.id);
    const scope = mainScope(session);
    const list = read(main, scope, "list_messages", {}) as Record<string, any>;
    assert.equal(list.ok, true);
    assert.equal(list.total, 5);
    assert.deepEqual(list.items.map((item: any) => [item.seq, item.role, item.turn?.id ?? null, item.turn?.phase ?? null]),
      [[0, "user", 1, "completed"], [1, "assistant", 1, "completed"], [2, "user", 2, "failed"], [3, "assistant", 2, "failed"], [4, "user", 3, "running"]]);
    assert.equal(list.items[3].turn.errorMessage, "Model capacity reached.");
    assert.deepEqual(list.items[1].artifact, { operationCount: 2, changedFileCount: 1, runCheckCount: 1 });
    const paged = read(main, scope, "list_messages", { offset: 3, limit: 1 }) as Record<string, any>;
    assert.deepEqual([paged.items.map((item: any) => item.seq), paged.nextOffset], [[3], 4]);

    main.upsertSession({ ...session, messages: [...messages, { role: "assistant", text: "appended later" }] });
    const after = read(main, scope, "list_messages", {}) as Record<string, any>;
    assert.equal(after.total, 5);
    assert.equal(failureCode(read(main, scope, "get_message", { seq: 5 })), "HISTORY_OUT_OF_RANGE");
    assert.equal(failureCode(read(main, scope, "get_message", { seq: 6 })), "HISTORY_OUT_OF_RANGE");
    const steered = read(main, mainScope(session, 5), "get_message", { seq: 5 }) as Record<string, any>;
    assert.deepEqual([steered.text, steered.turn], ["steered input", null]);

    const operations = read(main, scope, "list_operations", { seq: 1 }) as Record<string, any>;
    assert.equal(operations.artifactDetailSaved, true);
    assert.deepEqual(operations.items, [
      { index: 0, id: "op-1", type: "command_execution", summary: "npm test", status: "failed", exitCode: 1, truncated: true, detailSaved: true },
      { index: 1, id: "op-2", type: "mcp_tool_call", summary: "server/tool", status: "completed", detailSaved: false },
    ]);
    const files = read(main, scope, "list_operations", { seq: 1, section: "changed_files" }) as Record<string, any>;
    assert.deepEqual(files.items, [{ index: 0, kind: "edit", path: "src/a.ts", summary: "edited", diffRowCount: 3 }]);
    assert.equal(failureCode(read(main, scope, "list_operations", { seq: 0 })), "HISTORY_NOT_SAVED");

    const first = read(main, scope, "get_operation_detail", { seq: 1, kind: "operation", index: 0, maxChars: 3 }) as Record<string, any>;
    assert.deepEqual([first.text, first.nextOffset, first.totalChars, first.truncatedAtSave], ["ab", 2, longDetail.length, true]);
    const rest = read(main, scope, "get_operation_detail", { seq: 1, kind: "operation", index: 0, offset: first.nextOffset }) as Record<string, any>;
    assert.deepEqual([first.text + rest.text, rest.nextOffset], [longDetail, null]);
    assert.equal(failureCode(read(main, scope, "get_operation_detail", { seq: 1, kind: "operation", index: 1 })), "HISTORY_NOT_SAVED");
    const emoji = read(main, scope, "get_operation_detail", { seq: 1, kind: "operation", index: 0, maxChars: 1, offset: 0 }) as Record<string, any>;
    assert.deepEqual([emoji.text, emoji.nextOffset], ["a", 1]);
    assert.equal(failureCode(read(main, scope, "get_operation_detail", { seq: 1, kind: "operation", index: 0, offset: 3 })), "HISTORY_INVALID_REQUEST");
    const pair = read(main, scope, "get_operation_detail", { seq: 1, kind: "operation", index: 0, maxChars: 1, offset: 2 }) as Record<string, any>;
    assert.deepEqual([pair.text, pair.nextOffset], ["\u{1F600}", 4]);
    const budgeted = read(main, scope, "get_operation_detail", { seq: 1, kind: "changed_file", index: 0, maxChars: 80 }) as Record<string, any>;
    assert.deepEqual([budgeted.rows.length, budgeted.nextOffset], [1, 1]);
    const oneRow = read(main, scope, "get_operation_detail", { seq: 1, kind: "changed_file", index: 0, row: 1, maxChars: 10 }) as Record<string, any>;
    assert.deepEqual([oneRow.text.length, oneRow.nextOffset, oneRow.row], [10, 10, 1]);
    const rows = read(main, scope, "get_operation_detail", { seq: 1, kind: "changed_file", index: 0, offset: 1, maxRows: 1 }) as Record<string, any>;
    assert.deepEqual([rows.rows.length, rows.nextOffset, rows.totalRows], [1, 2, 3]);
    assert.equal(failureCode(read(main, scope, "get_operation_detail", { seq: 1, kind: "operation", index: 0, maxRows: 1 })), "HISTORY_INVALID_REQUEST");
    const withQuestion = read(main, scope, "get_message", { seq: 3, maxChars: 1 }) as Record<string, any>;
    assert.deepEqual([withQuestion.text, withQuestion.elicitationRecordCount, withQuestion.elicitationRecords], ["c", 1, undefined]);
    const question = read(main, scope, "get_operation_detail", { seq: 3, kind: "elicitation", index: 0, maxChars: 20 }) as Record<string, any>;
    assert.deepEqual([question.text.length, question.nextOffset], [20, 20]);
    assert.equal(failureCode(read(main, scope, "get_operation_detail", { seq: 3, kind: "elicitation", index: 1 })), "HISTORY_NOT_SAVED");
    assert.equal(failureCode(read(main, mainScope(session, 99), "list_messages", {})), "HISTORY_RANGE_UNAVAILABLE");
  });
});

// @test-value v2
// kind = "security"
// claim = "削除・再作成された元Sessionと、親が置き換わったAuxiliaryを、固定済みscopeの取得として成功させない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/908" }
// fault = "同じIDの別会話や親の別incarnationの履歴を、許可済みの元会話として返す"
// observable = "readSessionHistoryの失敗codeと成功時の件数"
// observation_boundary = "public-boundary"
// scope = "session-history-read"
// lifecycle = "permanent"
// impact = "別会話の内容が背景生成のMemory・Affect根拠へ混入することを防ぐ"
// distinction = "ID文字列のschema検証ではincarnationと親子関係の実保存状態を検出できない"
// @end-test-value
test("削除・再作成された元Sessionと親が一致しないAuxiliaryを拒否し、Mainと取り違えない", async () => {
  await withStorages(async ({ main, auxiliary }) => {
    const session = main.insertSession(mainSession("main-2"));
    const aux = auxiliary.upsertAuxiliarySession(auxiliarySession(session.id));
    const auxScope: SessionHistoryReadScope = { source: { kind: "auxiliary", sessionId: aux.id, parentSessionId: session.id,
      parentIncarnationId: getSessionIncarnationId(session), createdAt: aux.createdAt }, window: { fromSeq: 0, toSeq: 1 } };
    const auxList = read(auxiliary, auxScope, "list_messages", {}) as Record<string, any>;
    assert.deepEqual(auxList.items.map((item: any) => item.textPreview), ["aux question", "aux answer"]);
    const staleParent = { ...auxScope, source: { ...auxScope.source, parentIncarnationId: "another-incarnation" } } as SessionHistoryReadScope;
    assert.equal(failureCode(read(auxiliary, staleParent, "list_messages", {})), "HISTORY_SOURCE_REPLACED");
    assert.throws(() => read(main, auxScope, "list_messages", {}), /require a main source/);
    assert.throws(() => read(auxiliary, mainScope(session), "list_messages", {}), /require an auxiliary source/);

    const scope = mainScope(session);
    main.deleteSession(session.id);
    assert.equal(failureCode(read(main, scope, "list_messages", {})), "HISTORY_SOURCE_DELETED");
    assert.equal(failureCode(read(auxiliary, auxScope, "list_messages", {})), "HISTORY_SOURCE_DELETED");
    const recreated = main.insertSession(mainSession("main-2"));
    assert.notEqual(getSessionIncarnationId(recreated), getSessionIncarnationId(session));
    assert.equal(failureCode(read(main, scope, "list_messages", {})), "HISTORY_SOURCE_REPLACED");
    assert.equal(failureCode(read(auxiliary, auxScope, "list_messages", {})), "HISTORY_SOURCE_DELETED");
  });
});
