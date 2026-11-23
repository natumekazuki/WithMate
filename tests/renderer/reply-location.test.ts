import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { locateReply } from "../../src/chat/conversation/reply-location.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { SessionTurnStorageV6 } from "../../src-electron/session/session-turn-storage-v6.js";
import { SessionTurnQueueStorageV6 } from "../../src-electron/session/session-turn-queue-storage-v6.js";
import { SessionExecutionReadStorage } from "../../src-electron/storage/session-execution-read.js";
import { buildNewSession, getSessionIncarnationId } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { conversationPeerKey, conversationThreadsResultSchema } from "../../src-shared/session/conversation-threads.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { executionWindowResultSchemas } from "../../src-shared/session/session-execution-read.js";

// @test-value v2
// kind = "contract"
// claim = "旧送信receipt引用は受信先のseqでも同じTurnの別receiptでもなく、親の正確な送信カードだけを移動先にする"
// oracle = { type = "contract", ref = "docs/design/session-history.md#本文操作詳細のpaging" }
// fault = "宛先の保存seqで移動する、最初に見つけた同文別receiptを採用する、親世代が異なるか投影外でもリンクを出す"
// observable = "実SQLiteの複数ページの送信履歴から確定した会話枠・親側の保存seq・receipt ID、世代違い／投影外のリンク可否"
// observation_boundary = "public-boundary"
// scope = "引用ナビゲーションの保存元解決と既存DB読取の接続"
// lifecycle = "permanent"
// impact = "同じ指示が複数ある履歴で利用者が別の指示へ誘導される"
// distinction = "SQLiteの取得単体と画面表示の検査だけでは投影先・送信元・receiptの三つの照合を検出できない"
// @end-test-value
test("legacy reply receipts locate only the exact outgoing card in its parent's projection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "withmate-reply-location-"));
  const db = join(dir, "synthetic.db");
  const sessions = new SessionStorageV6(db);
  const turns = new SessionTurnStorageV6(db);
  const queue = new SessionTurnQueueStorageV6(db);
  const read = new SessionExecutionReadStorage(db);
  try {
    const seed = buildNewSession({ id: "parent", taskTitle: "Parent", workspaceLabel: "Fixture", workspacePath: "C:/fixture", branch: "test",
      characterId: "test", character: "Test", characterIconPath: "", characterThemeColors: { main: "#112233", sub: "#445566" }, approvalMode: "on-request" });
    const parent = sessions.insertSession({ ...seed, rootSessionId: seed.id, sessionRole: "overall-coordinator", model: "test-model",
      messages: [{ role: "user", text: "job" }, { role: "assistant", text: "source anchor" }] });
    const childSession = sessions.insertSession({ ...seed, id: "child", rootSessionId: parent.id, parentSessionId: parent.id,
      createdBySessionId: parent.id, sessionRole: "executor", model: parent.model, messages: [{ role: "user", text: "unrelated recipient seq" }] });
    const main = { kind: "main" as const, sessionId: parent.id, incarnationId: getSessionIncarnationId(parent) };
    const child = { kind: "main" as const, sessionId: childSession.id, incarnationId: getSessionIncarnationId(childSession) };
    const sourceTurn = turns.createSessionTurn({ sessionId: parent.id, provider: parent.provider, model: parent.model, reasoningEffort: parent.reasoningEffort,
      approvalMode: parent.approvalMode, phase: "completed", threadId: "", errorMessage: "", userMessageSeq: 0, assistantMessageSeq: 1, createdAt: "2026-11-23T00:00:00Z" });
    const origin = { kind: "session" as const, operation: "send" as const, actorKind: "main" as const, actorSessionId: main.sessionId,
      actorIncarnationId: main.incarnationId, actorTurnId: String(sourceTurn.id), targetSessionId: child.sessionId, targetIncarnationId: child.incarnationId };
    const enqueue = (actorIncarnationId: string) => queue.enqueue(child, { provider: childSession.provider, workspacePath: childSession.workspacePath, attachments: [],
      origin: { ...origin, actorIncarnationId }, request: { userMessage: "same text", clientRequestId: randomUUID(),
        executionOptions: captureSessionExecutionOptions(childSession) } });
    const first = enqueue(main.incarnationId);
    for (let i = 0; i < 19; ++i) enqueue(main.incarnationId);
    const exact = enqueue(main.incarnationId);
    const obsolete = enqueue("old-parent");
    const scope = { main, threads: conversationThreadsResultSchema.parse(read.execute({
      target: main, operation: "read_conversation_threads", request: { target: main },
    })) };
    const readSessionExecution: WithMateWindowApi["readSessionExecution"] = async (_owner, operation, request) =>
      executionWindowResultSchemas[operation].parse(read.execute({ target: request.target, operation, request })) as never;
    const api = { readSessionExecution, getConversationPage: async (id: string) => sessions.getConversationPage(id) };
    const resolveReceipt = async (receiptId: string, where = scope) => {
      const reference = { target: child, receiptId };
      const source = await readSessionExecution(parent.id, "get_execution_input", { ...reference, stage: "original" });
      assert.ok(source.ok);
      return locateReply(api, parent.id, where, { reference, origin: source.origin, text: source.text });
    };
    const destination = { column: "main", ownerKey: conversationPeerKey(main), frameId: conversationPeerKey(child), seq: 1 };
    assert.deepEqual(await resolveReceipt(first.id), { ...destination, receiptId: first.id });
    assert.deepEqual(await resolveReceipt(exact.id), { ...destination, receiptId: exact.id });
    assert.equal(await resolveReceipt(obsolete.id), null);
    assert.equal(await resolveReceipt(exact.id, { ...scope, threads: { ...scope.threads, children: [] } }), null);
  } finally {
    read.close(); queue.close(); turns.close(); sessions.close();
    await rm(dir, { recursive: true, force: true });
  }
});
