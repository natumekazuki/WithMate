import assert from "node:assert/strict";
import test from "node:test";

import { resolveChatHeaderVisibility } from "../../src/chat/chat-header-visibility.js";

// @test-value v2
// kind = "invariant"
// claim = "通常Sessionのheaderはrenameとdeleteを許可しdelete capabilityの停止を尊重する"
// oracle = { type = "contract", ref = "src/chat/chat-header-visibility.ts" }
// fault = "delete禁止時にもdelete導線を許可する"
// observable = "showRenameButtonとshowDeleteButton"
// observation_boundary = "consumer"
// scope = "main-header-capabilities"
// lifecycle = "permanent"
// @end-test-value
test("resolveChatHeaderVisibility は通常 session の header 操作を capability で返す", () => {
  assert.deepEqual(resolveChatHeaderVisibility({}), {
    showRenameButton: true,
    showDeleteButton: true,
  });
  assert.deepEqual(resolveChatHeaderVisibility({ canDeleteSession: false }), {
    showRenameButton: true,
    showDeleteButton: false,
  });
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary headerは親Sessionを変更するrename/delete導線を表示しない"
// oracle = { type = "contract", ref = "src/chat/chat-header-visibility.ts" }
// fault = "Auxiliaryから親の変更操作を可能にする"
// observable = "showRenameButtonとshowDeleteButton"
// observation_boundary = "consumer"
// scope = "auxiliary-header-capabilities"
// lifecycle = "permanent"
// @end-test-value
test("resolveChatHeaderVisibility は Auxiliary mode で parent 操作を隠す", () => {
  assert.deepEqual(resolveChatHeaderVisibility({
    isAuxiliaryMode: true,
    canDeleteSession: true,
  }), {
    showRenameButton: false,
    showDeleteButton: false,
  });
});
