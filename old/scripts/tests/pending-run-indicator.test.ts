import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPANION_PENDING_MESSAGE_TEXT,
  COMPANION_PENDING_RUN_INDICATOR_TEXT,
} from "../../src/chat/pending-run-indicator.js";

test("Companion pending 文言は共通定義から解決する", () => {
  assert.equal(COMPANION_PENDING_MESSAGE_TEXT, "Companion の応答を待っています。");
  assert.deepEqual(COMPANION_PENDING_RUN_INDICATOR_TEXT, {
    pendingRunIndicatorAnnouncement: "Companion が実行中",
    pendingRunIndicatorText: "Companion が応答を生成中...",
  });
});
