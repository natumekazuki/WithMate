import assert from "node:assert/strict";
import { test } from "node:test";
import {
  coerceModelSelection, getProviderCatalog, getReasoningEffortOptionsForModel,
  resolveModelChangeSelection, resolveModelSelection, type ModelCatalogProvider,
} from "../../src-shared/settings/model-catalog.js";

const provider: ModelCatalogProvider = {
  id: "opencode", label: "OpenCode", defaultModelId: "sdk/model", defaultReasoningEffort: "adaptive",
  models: [
    { id: "sdk/model", label: "SDK Model", reasoningEfforts: ["adaptive", "high"], defaultReasoningEffort: "adaptive" },
    { id: "sdk/plain", label: "Plain Model", reasoningEfforts: [] },
  ],
};

// @test-value v2
// kind = "contract"
// claim = "provider一覧の照合は完全一致し、refresh後も保存済みの未知modelとdepthを無断変更しない"
// oracle = { type = "contract", ref = "Issue #879: discovered list refresh must preserve saved model and reasoning effort selections" }
// fault = "未知providerを別providerへ置換するか、SDK一覧から消えた保存済みmodelとdepthを既定値へ置換する"
// observable = "provider検索結果、未知modelのdepth候補、coerceとresolveが返す選択値"
// observation_boundary = "public-boundary"
// scope = "discovered-model-selection-continuity"
// lifecycle = "permanent"
// impact = "利用者の保存済み実行設定がrefreshによって別modelへ変わる"
// distinction = "型検査ではprovider間fallbackと保存済み選択の値変更を検出できない"
// @end-test-value
test("SDK一覧にない保存済み選択は維持しproviderを混同しない", () => {
  assert.equal(getProviderCatalog([provider], "codex"), null);
  assert.equal(getProviderCatalog([provider], "opencode"), provider);
  assert.deepEqual(getReasoningEffortOptionsForModel(provider, "retired/model"), []);
  for (const resolve of [coerceModelSelection, resolveModelSelection]) {
    assert.deepEqual(resolve(provider, "retired/model", "native-depth"), {
      requestedModel: "retired/model", resolvedModel: "retired/model",
      requestedReasoningEffort: "native-depth", resolvedReasoningEffort: "native-depth",
    });
  }
  assert.throws(() => resolveModelSelection(provider, "", ""), /model must be selected/);
});

// @test-value v2
// kind = "contract"
// claim = "明示model変更は対応depthを保持し、非対応depthだけを選択modelのSDK既定値または明示深度なしへ変更する"
// oracle = { type = "contract", ref = "Issue #879: explicit model changes use model-level SDK reasoning defaults and no-depth models use empty effort" }
// fault = "別modelの既定depthを流用するか、depth非対応modelへ古いdepthを送る"
// observable = "resolveModelChangeSelectionが返すresolvedReasoningEffortと未知model変更時の例外"
// observation_boundary = "public-boundary"
// scope = "explicit-sdk-model-selection"
// lifecycle = "permanent"
// impact = "model切替直後にSDKが受け付けない実行オプションを生成する"
// distinction = "型とschemaはSDKのmodelごとのdepth集合と既定値の選択を保証しない"
// @end-test-value
test("明示model切替はそのmodelのSDK depth契約を採用する", () => {
  assert.equal(resolveModelChangeSelection(provider, "sdk/model", "high").resolvedReasoningEffort, "high");
  assert.equal(resolveModelChangeSelection(provider, "sdk/model", "other").resolvedReasoningEffort, "adaptive");
  assert.equal(resolveModelChangeSelection(provider, "sdk/plain", "high").resolvedReasoningEffort, "");
  assert.throws(() => resolveModelChangeSelection(provider, "unknown", "high"), /not in the discovered model list/);
});
