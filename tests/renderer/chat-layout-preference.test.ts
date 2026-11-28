import assert from "node:assert/strict";
import test from "node:test";

import { persistChatLayoutPreference } from "../../src/chat/chat-layout-preference.js";
import {
  isChatLayoutPreferenceUpdate,
  type ChatLayoutPreferenceUpdate,
} from "../../src-shared/settings/chat-layout-preference.js";

/** アクションドックの変更をまとめ設定ではなく、一つの対象と値として専用保存APIへ渡す。 */
test("persistChatLayoutPreference は専用 API へ単一 target の更新を保存する", async () => {
  const saved: ChatLayoutPreferenceUpdate[] = [];
  const update: ChatLayoutPreferenceUpdate = {
    target: "actionDock",
    value: "expanded",
  };

  await persistChatLayoutPreference(
    {
      /** 保存APIで受け取った更新を記録する。 */
      async updateChatLayoutPreference(nextUpdate) {
        saved.push(nextUpdate);
        return {} as never;
      },
      /** 保存成功時のログは観測対象にしない。 */
      reportRendererLog() {},
    },
    update,
  );

  assert.deepEqual(saved, [update]);
});

// @test-value v2
// kind = "invariant"
// claim = "chat layout preference保存失敗はrenderer logへ記録し呼び出し元へ再送出しない"
// oracle = { type = "contract", ref = "chat layout preference persistence" }
// fault = "保存失敗が未記録になるか呼び出し元へ例外が伝播する"
// observable = "reported failure kind/data and resolved persistence call"
// observation_boundary = "public-boundary"
// scope = "chat-layout-preference-save-failure"
// lifecycle = "permanent"
// @end-test-value
/** 保存失敗は更新内容とともにログへ残し、呼び出し元には失敗を伝播させない。 */
test("persistChatLayoutPreference は保存失敗を記録し、呼び出し元へは送出しない", async () => {
  const logs: Array<{ kind: string; data?: unknown }> = [];
  const update: ChatLayoutPreferenceUpdate = {
    target: "header",
    value: "visible",
  };

  await persistChatLayoutPreference(
    {
      /** 保存処理を失敗させ、レンダラーへの例外伝播を検出できるようにする。 */
      async updateChatLayoutPreference() {
        throw new Error("save failed");
      },
      /** 保存失敗時に報告されたログを記録する。 */
      reportRendererLog(input) {
        logs.push(input);
      },
    },
    update,
  );

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
/** 対象に対応する値だけを受理し、余分な項目や廃止済みのpriorityを拒む。 */
test("isChatLayoutPreferenceUpdate は target/value だけを持つ canonical update を受理する", () => {
  assert.equal(
    isChatLayoutPreferenceUpdate({ target: "header", value: "hidden" }),
    true,
  );
  assert.equal(
    isChatLayoutPreferenceUpdate({ target: "actionDock", value: "expanded" }),
    true,
  );
  assert.equal(
    isChatLayoutPreferenceUpdate({ target: "sidePane", value: "context" }),
    true,
  );
  assert.equal(
    isChatLayoutPreferenceUpdate({ target: "header", value: "shown" }),
    false,
  );
  assert.equal(
    isChatLayoutPreferenceUpdate({
      target: "sidePane",
      value: "files",
      header: "visible",
    }),
    false,
  );
  assert.equal(isChatLayoutPreferenceUpdate({ target: "sidePane" }), false);
  assert.equal(
    isChatLayoutPreferenceUpdate({ target: "priority", value: "left-first" }),
    false,
  );
  assert.equal(
    isChatLayoutPreferenceUpdate({
      target: "priority",
      value: "side-pane-first",
    }),
    false,
  );
  assert.equal(
    isChatLayoutPreferenceUpdate({ target: "priority", value: "dock-first" }),
    false,
  );
});
