import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../../src-shared/session/session-state.js";
import type { AuditLogSummary } from "../../src-shared/session/runtime-state.js";
import { createOptimisticRunningSessionState } from "../../src-shared/session/session-run-transition.js";
import { mergeMessageBookmarkProjection } from "../../src/chat/runtime/session-submit-coordinator.js";
import { resolveRetryBannerSource } from "../../src/chat/retry-state.js";

// @test-value v2
// kind = "contract"
// claim = "部分会話からの送信は履歴上の次の位置へ一度だけ追加し、表示保持数と元snapshotを維持する"
// oracle = { type = "contract", ref = "docs/features/long-session-performance.md" }
// fault = "ページ長を履歴位置として送信を追加する、総件数を増やさない、または元snapshotを破壊する"
// observable = "楽観状態の総件数、末尾messageの履歴index、本文、保持数と送信前snapshot"
// observation_boundary = "public-boundary"
// scope = "conversation-optimistic-send"
// lifecycle = "permanent"
// impact = "streamingと永続化後の位置がずれ、重複表示や別messageの操作になる"
// distinction = "型検査はページ長と全履歴数を区別できず、full-array送信testではoffsetが常に0である"
// @end-test-value
test("paged optimistic send keeps global history positions and a bounded tail", () => {
  const messages: Message[] = Array.from({ length: 60 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    text: `history-${940 + index}`,
    historyIndex: 940 + index,
  }));
  const session = { messages, messageCount: 1000, runState: "idle", updatedAt: "before" };
  const running = createOptimisticRunningSessionState(session, "next request", "after");
  assert.equal(running.runState, "running");
  assert.equal(running.messageCount, 1001);
  assert.equal(running.messages.length, 60);
  assert.equal(running.messages[0].historyIndex, 941);
  assert.deepEqual(running.messages.at(-1), { role: "user", text: "next request", historyIndex: 1000 });
  assert.equal(session.messageCount, 1000);
  assert.equal(session.messages.length, 60);
  assert.equal(session.messages[0].historyIndex, 940);
});

// @test-value v2
// kind = "invariant"
// claim = "ページ境界がずれてもBookmarkは同じ履歴位置と本文にだけ合成される"
// oracle = { type = "contract", ref = "docs/features/message-bookmark-filter.md" }
// fault = "array indexまたは同じ本文だけでBookmarkを対応付ける"
// observable = "更新後message配列の各historyIndexに対するBookmark値"
// observation_boundary = "public-boundary"
// scope = "conversation-bookmark-convergence"
// lifecycle = "permanent"
// impact = "送信完了時にBookmarkが消えるか同じ本文の別messageへ移る"
// distinction = "既存full-array合成ではoffset変更を通らず、型検査でも誤対応を検出できない"
// @end-test-value
test("bookmark convergence follows global positions across shifted pages", () => {
  const current: Message[] = [
    { role: "assistant", text: "same", historyIndex: 100, isBookmarked: true },
    { role: "assistant", text: "same", historyIndex: 101 },
    { role: "user", text: "request", historyIndex: 102, isBookmarked: true },
  ];
  const incoming: Message[] = [
    { role: "assistant", text: "same", historyIndex: 101, isBookmarked: true },
    { role: "user", text: "request", historyIndex: 102 },
    { role: "assistant", text: "same", historyIndex: 103 },
    { role: "user", text: "changed", historyIndex: 100 },
  ];
  assert.deepEqual(mergeMessageBookmarkProjection(current, incoming).map((message) => [message.historyIndex, message.isBookmarked === true]), [
    [101, false], [102, true], [103, false], [100, false],
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "再送元のterminal監査を全履歴indexで特定し、最新userが表示page外でも再送本文を保持する"
// oracle = { type = "contract", ref = "docs/features/long-session-performance.md" }
// fault = "page内indexをuserMessageSeqと比較する、またはpage外userを失う"
// observable = "再送bannerのkind、lastRequestText、対応terminalAuditLog"
// observation_boundary = "consumer"
// scope = "paged-conversation-retry"
// lifecycle = "permanent"
// impact = "キャンセルした依頼の再送導線が消えるか別の依頼本文を復元する"
// distinction = "既存retry testは全履歴を渡しておりpage外userとoffsetを検証しない"
// @end-test-value
test("retry resolves a global user sequence inside and outside the loaded page", () => {
  const user: Message = { role: "user", text: "retry this", historyIndex: 420 };
  const assistant: Message = { role: "assistant", text: "canceled", historyIndex: 421 };
  const canceled: AuditLogSummary = {
    id: 1, sessionId: "main", createdAt: "now", phase: "canceled", provider: "codex", model: "model",
    reasoningEffort: "medium", approvalMode: "never", userMessageSeq: 420, assistantMessageSeq: 421,
    threadId: "thread", assistantTextPreview: "canceled", operations: [], usage: null, errorMessage: "", detailAvailable: true,
  };
  const expected = { kind: "canceled", lastRequestText: "retry this", terminalAuditLog: canceled };
  assert.deepEqual(resolveRetryBannerSource({ sessionId: "main", messages: [user, assistant], auditLogs: [canceled], runState: "idle" }), expected);
  assert.deepEqual(resolveRetryBannerSource({ sessionId: "main", messages: [assistant], latestUserMessage: user, auditLogs: [canceled], runState: "idle" }), expected);
  assert.equal(resolveRetryBannerSource({ sessionId: "main", messages: [user, assistant], auditLogs: [{ ...canceled, userMessageSeq: 0 }], runState: "idle" }), null);
});
