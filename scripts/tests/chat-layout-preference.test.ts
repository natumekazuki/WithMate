import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CHAT_LAYOUT_PREFERENCE,
  isChatLayoutPreferenceUpdate,
  normalizeChatLayoutPreference,
  persistChatLayoutPreference,
  type ChatLayoutPreferenceUpdate,
} from "../../src/chat/chat-layout-preference.js";

test("persistChatLayoutPreference は専用 API へ単一 target の更新を保存する", async () => {
  const saved: ChatLayoutPreferenceUpdate[] = [];
  const update: ChatLayoutPreferenceUpdate = { target: "actionDock", value: "expanded" };

  await persistChatLayoutPreference({
    async updateChatLayoutPreference(nextUpdate) {
      saved.push(nextUpdate);
      return {} as never;
    },
    reportRendererLog() {},
  }, update);

  assert.deepEqual(saved, [update]);
});

test("persistChatLayoutPreference は保存失敗を記録し、呼び出し元へは送出しない", async () => {
  const logs: Array<{ kind: string; data?: Record<string, unknown> }> = [];
  const update: ChatLayoutPreferenceUpdate = { target: "header", value: "visible" };

  await persistChatLayoutPreference({
    async updateChatLayoutPreference() {
      throw new Error("save failed");
    },
    reportRendererLog(input) {
      logs.push(input);
    },
  }, update);

  assert.equal(logs[0]?.kind, "chat.layout-preference-save-failed");
  assert.deepEqual(logs[0]?.data, { update });
});

test("isChatLayoutPreferenceUpdate は target/value だけを持つ canonical update を受理する", () => {
  assert.equal(isChatLayoutPreferenceUpdate({ target: "header", value: "hidden" }), true);
  assert.equal(isChatLayoutPreferenceUpdate({ target: "actionDock", value: "expanded" }), true);
  assert.equal(isChatLayoutPreferenceUpdate({ target: "sidePane", value: "context" }), true);
  assert.equal(isChatLayoutPreferenceUpdate({ target: "priority", value: "side-pane-first" }), true);
  assert.equal(isChatLayoutPreferenceUpdate({ target: "priority", value: "dock-first" }), true);
  assert.equal(isChatLayoutPreferenceUpdate({ target: "header", value: "shown" }), false);
  assert.equal(isChatLayoutPreferenceUpdate({ target: "sidePane", value: "files", header: "visible" }), false);
  assert.equal(isChatLayoutPreferenceUpdate({ target: "sidePane" }), false);
  assert.equal(isChatLayoutPreferenceUpdate({ target: "priority", value: "left-first" }), false);
});

test("chat layout priority は旧設定と不正値を side pane 優先へ正規化する", () => {
  assert.equal(DEFAULT_CHAT_LAYOUT_PREFERENCE.priority, "side-pane-first");
  assert.equal(normalizeChatLayoutPreference({}).priority, "side-pane-first");
  assert.equal(normalizeChatLayoutPreference({ priority: "dock-first" }).priority, "dock-first");
  assert.equal(normalizeChatLayoutPreference({ priority: "invalid" }).priority, "side-pane-first");
});
