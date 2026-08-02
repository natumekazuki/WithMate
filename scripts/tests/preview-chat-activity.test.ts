import assert from "node:assert/strict";
import test from "node:test";

import {
  acknowledgePreviewChatMessageCount,
  beginPreviewChatActivity,
  endPreviewChatActivity,
  observePreviewChatMessageCount,
} from "../../src/file-explorer/preview-chat-activity.js";

test("preview chat activity は送信した user message を既読基準へ含め、完了応答だけを未読にする", () => {
  let state = beginPreviewChatActivity("session-1", 1);

  state = acknowledgePreviewChatMessageCount(state, "session-1", 2);
  state = observePreviewChatMessageCount(state, "session-1", 2);
  assert.equal(state.hasUnreadMessages, false);

  state = observePreviewChatMessageCount(state, "session-1", 3);
  assert.equal(state.hasUnreadMessages, true);

  state = observePreviewChatMessageCount(state, "session-1", 3);
  assert.equal(state.hasUnreadMessages, true);

  assert.deepEqual(endPreviewChatActivity(), {
    ownerSessionId: null,
    observedMessageCount: 0,
    hasUnreadMessages: false,
  });
});

test("preview chat activity は別 session の count を引き継がない", () => {
  const unread = observePreviewChatMessageCount(
    beginPreviewChatActivity("session-1", 1),
    "session-1",
    2,
  );

  assert.deepEqual(observePreviewChatMessageCount(unread, "session-2", 5), {
    ownerSessionId: "session-2",
    observedMessageCount: 5,
    hasUnreadMessages: false,
  });
});
