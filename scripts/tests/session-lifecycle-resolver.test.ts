import assert from "node:assert/strict";
import test from "node:test";
import { SessionLifecycleResolver } from "../../src-electron/session-lifecycle-resolver.js";
import { buildNewSession } from "../../src/session-state.js";

const resolver = new SessionLifecycleResolver({
  currentModelCatalog: () => ({ revision: 7, providers: [{
    id: "codex", label: "Codex", defaultModelId: "model-a", defaultReasoningEffort: "low",
    models: [{ id: "model-a", label: "Model A", reasoningEfforts: ["low", "high"] }],
  }] }),
  isProviderEnabled: () => true,
  isProviderSupported: () => true,
  listCharacters: () => [],
  createCharacterRuntimeSnapshot: () => null,
  resolveSessionFilesDirectory: (id) => `/session-files/${id}`,
});

// @test-value v2
// kind = "invariant"
// claim = "Lifecycle runtime tupleはcatalog不一致と未提供reasoningを拒否し、別値へ補正しない"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Direct validation" }
// fault = "現在catalogまたは対応reasoningへ要求値を暗黙補正して設定を保存できる"
// observable = "resolverが返すerror codeと有効tupleの解決結果"
// observation_boundary = "component-behavior"
// scope = "Session lifecycle runtime tuple resolution"
// lifecycle = "permanent"
// @end-test-value
test("lifecycle provider selection rejects stale catalogs and unsupported reasoning without clamping", () => {
  const tuple = { id: "codex", catalogRevision: 7, model: "model-a", reasoningEffort: "high", threadContinuity: "reset" } as const;
  assert.throws(() => resolver.provider({ ...tuple, catalogRevision: 6 }), { code: "CATALOG_REVISION_STALE" });
  assert.throws(() => resolver.provider({ ...tuple, reasoningEffort: "medium" }), { code: "INVALID_INPUT" });
  assert.throws(() => resolver.provider({ ...tuple, model: "missing" }), { code: "INVALID_INPUT" });
  assert.deepEqual(resolver.provider(tuple), {
    provider: "codex", catalogRevision: 7, model: "model-a", reasoningEffort: "high", threadId: "",
  });
});

// @test-value v2
// kind = "invariant"
// claim = "Provider切替で旧threadを継承せず、同一Providerの明示continueだけがthreadを保持する"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Session identity と変更可能性" }
// fault = "別Providerのthread IDを新bindingへ引き継ぐ"
// observable = "continue要求の拒否と解決後threadId"
// observation_boundary = "component-behavior"
// scope = "Session lifecycle thread continuity"
// lifecycle = "permanent"
// @end-test-value
test("lifecycle thread continuity requires the same existing provider", () => {
  const tuple = { id: "codex", catalogRevision: 7, model: "model-a", reasoningEffort: "high", threadContinuity: "continue" } as const;
  const current = { ...buildNewSession({
    id: "session-a", provider: "codex", taskTitle: "Task", workspaceLabel: "Workspace",
    workspacePath: "/workspace", branch: "", characterId: "character-a", character: "Character",
    characterIconPath: "", characterThemeColors: { main: "#123456", sub: "#654321" }, approvalMode: "untrusted",
  }), threadId: "old-thread" };
  assert.throws(() => resolver.provider(tuple), { code: "INVALID_INPUT" });
  assert.throws(() => resolver.provider(tuple, { ...current, provider: "copilot" }), { code: "INVALID_INPUT" });
  assert.equal(resolver.provider(tuple, current).threadId, "old-thread");
  assert.equal(resolver.provider({ ...tuple, threadContinuity: "reset" }, current).threadId, "");
});
