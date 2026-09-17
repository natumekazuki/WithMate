import assert from "node:assert/strict";
import test from "node:test";

import {
  isChatLayoutPreferenceUpdate,
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

// @test-value v2
// kind = "invariant"
// claim = "chat layout update は canonical target だけを受理する"
// oracle = { type = "contract", ref = "Chat layout update validation" }
// fault = "削除済み priority target が IPC 境界を通過する"
// observable = "isChatLayoutPreferenceUpdate の判定結果"
// observation_boundary = "public-boundary"
// scope = "chat-layout-update-validation"
// lifecycle = "permanent"
// impact = "廃止済み設定が契約へ再流入する"
// distinction = "target/value 形状と enum 値の検証を確認する"
// @end-test-value
test("isChatLayoutPreferenceUpdate は target/value だけを持つ canonical update を受理する", () => {
  assert.equal(isChatLayoutPreferenceUpdate({ target: "header", value: "hidden" }), true);
  assert.equal(isChatLayoutPreferenceUpdate({ target: "actionDock", value: "expanded" }), true);
  assert.equal(isChatLayoutPreferenceUpdate({ target: "sidePane", value: "context" }), true);
  assert.equal(isChatLayoutPreferenceUpdate({ target: "header", value: "shown" }), false);
  assert.equal(isChatLayoutPreferenceUpdate({ target: "sidePane", value: "files", header: "visible" }), false);
  assert.equal(isChatLayoutPreferenceUpdate({ target: "sidePane" }), false);
  assert.equal(isChatLayoutPreferenceUpdate({ target: "priority", value: "left-first" }), false);
  assert.equal(isChatLayoutPreferenceUpdate({ target: "priority", value: "side-pane-first" }), false);
  assert.equal(isChatLayoutPreferenceUpdate({ target: "priority", value: "dock-first" }), false);
});
