import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSessionWindowRestoreFeedback,
  selectPendingSessionWindowRestoreIds,
} from "../../src/home/home-session-window-restore.js";

test("未復元SessionだけをCTA対象にし、全件open済みなら空にする", () => {
  assert.deepEqual(
    selectPendingSessionWindowRestoreIds(["session-a", "session-b"], ["session-c"]),
    ["session-a", "session-b"],
  );
  assert.deepEqual(
    selectPendingSessionWindowRestoreIds(["session-a", "session-b"], ["session-a", "session-b"]),
    [],
  );
});

// @test-value v1
// kind = "regression"
// claim = "復元結果のvisible feedbackは失敗したSessionと理由だけを含み、正常終了と対象なしでは空になる"
// oracle = { type = "contract", ref = "docs/features/session-window-restore.md#復元操作" }
// failure_mode = "成功件数または対象なしの正常系文言が残るか、成功文言の削除時に復元失敗の対象と理由まで失われる"
// scope = "buildSessionWindowRestoreFeedback result-to-feedback boundary"
// lifecycle = "permanent"
// distinction = "復元対象集合の選択ではなく、正常系・部分失敗・全件失敗を利用者向け文字列へ投影する境界を検証する"
// @end-test-value
test("復元feedbackは正常系を空にし、失敗したSessionと理由だけを返す", () => {
  assert.equal(buildSessionWindowRestoreFeedback({
    requestedSessionIds: ["session-a", "session-b"],
    openedSessionIds: ["session-a", "session-b"],
    failures: [],
  }), "");
  assert.equal(buildSessionWindowRestoreFeedback({
    requestedSessionIds: [],
    openedSessionIds: [],
    failures: [],
  }), "");
  assert.equal(buildSessionWindowRestoreFeedback({
    requestedSessionIds: ["session-a", "session-b", "session-c", "session-d"],
    openedSessionIds: ["session-a"],
    failures: [
      { sessionId: "session-b", reason: "missing" },
      { sessionId: "session-c", reason: "unreadable" },
      { sessionId: "session-d", reason: "open-failed" },
    ],
  }), "復元できなかったSession: session-b（削除済み）、session-c（読込不能）、session-d（Windowを開けませんでした）");
  assert.equal(buildSessionWindowRestoreFeedback({
    requestedSessionIds: ["session-e"],
    openedSessionIds: [],
    failures: [{ sessionId: "session-e", reason: "missing" }],
  }), "復元できなかったSession: session-e（削除済み）");
});
