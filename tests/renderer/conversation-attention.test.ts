import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceAttentionAnnouncement,
  initialAttentionAnnouncementState,
  resolveConversationAttentionEntries,
  type AttentionAnnouncementState,
} from "../../src/chat/conversation-attention.js";

const entriesFor = (input: Partial<Parameters<typeof resolveConversationAttentionEntries>[0]> = {}) => resolveConversationAttentionEntries({
  sessionId: "main",
  approvalRequestId: "",
  blockingElicitationRequestIds: "",
  optionalElicitationRequestIds: "",
  hasUnreadMessages: false,
  ...input,
});

// @test-value v2
// kind = "contract"
// claim = "会話非表示中の支援技術通知は新しい要求だけを一度読み上げ、同じ要求の再描画では再通知せず、解決で解除し（通知済みの要求の一部だけが解消しても古い文言を残さず）、同じ文言の別requestと別会話の要求は再通知し、会話表示中に出た要求は戻った後に読み上げない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/896: 支援技術への通知を一元化する" }
// fault = "rerenderごとに同じ要求を読み上げる、解決後や一部解消後も古い文言を残す、文言だけで重複判定して別requestを通知しない、会話表示中に見た要求をPreviewへ戻った時に再通知する、nonblocking質問を回答必須と読み上げる、または対象会話の取り違えで通知を落とす"
// observable = "各状態遷移後のannouncement messageとserial（serialの増加が新しい読み上げ）"
// observation_boundary = "public-boundary"
// scope = "conversation attention announcement state transitions"
// lifecycle = "permanent"
// impact = "Preview内で作業する支援技術利用者が応答待ちを知れない、または同じ要求を何度も読み上げられて作業を妨げられる"
// distinction = "可視ボタンの描画testでは読み上げの発生・抑止・解除の遷移を観測できない"
// @end-test-value
test("conversation attention announces each hidden request once and clears resolved ones", () => {
  let state: AttentionAnnouncementState = initialAttentionAnnouncementState;
  const step = (entries: ReturnType<typeof entriesFor>, hidden: boolean, label = "Main") => {
    const previous = state.serial;
    state = advanceAttentionAnnouncement(state, entries, hidden, label);
    return { announced: state.serial > previous, message: state.message };
  };

  assert.deepEqual(step(entriesFor({ approvalRequestId: "approval-1" }), true), {
    announced: true,
    message: "Main: Approval required. Show the chat from the Action Dock to respond.",
  });
  assert.equal(step(entriesFor({ approvalRequestId: "approval-1" }), true).announced, false, "re-render keeps the same request quiet");
  assert.deepEqual(step(entriesFor(), true), { announced: false, message: "" }, "resolution clears the stale text");
  assert.deepEqual(step(entriesFor({ approvalRequestId: "approval-2" }), true), {
    announced: true,
    message: "Main: Approval required. Show the chat from the Action Dock to respond.",
  }, "a different request with the same wording is announced again");

  assert.deepEqual(step(entriesFor({ approvalRequestId: "approval-3", hasUnreadMessages: true }), true), {
    announced: true,
    message: "Main: Approval required, New messages. Show the chat from the Action Dock to respond.",
  });
  assert.deepEqual(step(entriesFor({ hasUnreadMessages: true }), true), { announced: false, message: "" },
    "resolving one announced request clears the text even while another entry remains");
  assert.deepEqual(step(entriesFor({ approvalRequestId: "approval-2" }), true), {
    announced: true,
    message: "Main: Approval required. Show the chat from the Action Dock to respond.",
  });
  assert.deepEqual(step(entriesFor({ approvalRequestId: "approval-2", optionalElicitationRequestIds: "question-1" }), true), {
    announced: true,
    message: "Main: Input requested. Show the chat from the Action Dock to respond.",
  }, "only the new nonblocking question is announced and it is not reported as required");
  assert.deepEqual(step(entriesFor({ blockingElicitationRequestIds: "question-2" }), true), {
    announced: true,
    message: "Main: Input required. Show the chat from the Action Dock to respond.",
  });

  assert.deepEqual(step(entriesFor({ blockingElicitationRequestIds: "question-2", hasUnreadMessages: true }), false), { announced: false, message: "" });
  assert.deepEqual(step(entriesFor({ blockingElicitationRequestIds: "question-2", hasUnreadMessages: true }), true), {
    announced: false,
    message: "",
  }, "requests seen while the conversation was visible stay quiet after hiding it again");

  assert.deepEqual(step(entriesFor({ sessionId: "aux-1", approvalRequestId: "approval-2" }), true, "Aux · Review"), {
    announced: true,
    message: "Aux · Review: Approval required. Show the chat from the Action Dock to respond.",
  }, "the same request id in another conversation is a different request");
  assert.deepEqual(step(entriesFor({ sessionId: "aux-1", approvalRequestId: "approval-2", hasUnreadMessages: true }), true, "Aux · Review"), {
    announced: true,
    message: "Aux · Review: New messages. Show the chat from the Action Dock to read them.",
  });
});
