import assert from "node:assert/strict";
import { it } from "node:test";
import { ProviderProgressDelivery, ProviderProgressMap } from "../../src-electron/providers/provider-progress.js";
import { createProviderAgentRuntimeBindingRedactor } from "../../src-electron/providers/provider-agent-runtime-binding.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";

const noChanges = { steps: { upserts: [], removes: [] }, backgroundTasks: { upserts: [], removes: [] } };
const state: LiveSessionRunState = {
  sessionId: "session", threadId: "thread", assistantText: "text", steps: [], backgroundTasks: [], usage: null,
  errorMessage: "", approvalRequest: null, elicitationRequest: null,
};

// @test-value v2
// kind = "security"
// claim = "変更stepだけの配送は全snapshotを作らずredactor交換時には残存stepのsecret集合を再処理する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Codex projection owner" }
// fault = "secret集合が変わっても旧sanitized cacheを返し追加secretを漏らす"
// observable = "変更配送のsnapshotとupserts、redactor交換後のsnapshot文字列"
// observation_boundary = "component-behavior"
// scope = "ProviderProgressMap sanitized projection cache"
// lifecycle = "permanent"
// risk_tags = ["privacy"]
// impact = "bindingやcredentialの追加・交換後に旧projectionから秘密を露出させない"
// distinction = "単発redactor testは同じmapに残ったstepのcache無効化を通らない"
// @end-test-value
it("変更配送とsecret集合変更の再projectionを分離する", () => {
  const steps = new ProviderProgressMap<{ id: string; text: string }>();
  steps.set("one", { id: "one", text: "old-secret new-secret" });
  const first = createProviderAgentRuntimeBindingRedactor(null, ["old-secret"]);
  const patch = steps.takeProgress(first, false);
  assert.deepEqual(patch.snapshot, []);
  assert.equal(patch.changes.upserts.length, 1);
  assert.equal(steps.takeProgress(first, false).changes.upserts.length, 0);
  const second = createProviderAgentRuntimeBindingRedactor(null, ["old-secret", "new-secret"]);
  const rebuilt = steps.takeProgress(second);
  assert.equal(rebuilt.changes.upserts.length, 1);
  assert.ok(!JSON.stringify(rebuilt.snapshot).includes("secret"));
});
