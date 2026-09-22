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

// @test-value v2
// kind = "contract"
// claim = "buildSessionWindowRestoreFeedbackは正常終了・対象なしでは空を返し、失敗したSessionと理由だけをvisible feedbackへ投影する"
// oracle = { type = "contract", ref = "Issue #731 session-window restore feedback" }
// fault = "成功件数または対象なしの正常系文言を残すか、失敗時に対象Sessionと理由の一方を失う"
// observable = "buildSessionWindowRestoreFeedbackの空文字またはsession ID・失敗理由を含むfeedback string"
// observation_boundary = "public-boundary"
// scope = "buildSessionWindowRestoreFeedback result-to-feedback boundary"
// lifecycle = "permanent"
// impact = "復元結果を誤認させる成功文を避け、開けなかったSessionと理由を利用者が識別できる"
// distinction = "復元対象集合の選択ではなく、正常系・部分失敗・全件失敗を利用者向け文字列へ投影する境界を確認する"
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
  }), "Could not restore sessions: session-b (Deleted), session-c (Unavailable), session-d (Could not open window)");
  assert.equal(buildSessionWindowRestoreFeedback({
    requestedSessionIds: ["session-e"],
    openedSessionIds: [],
    failures: [{ sessionId: "session-e", reason: "missing" }],
  }), "Could not restore sessions: session-e (Deleted)");
});
