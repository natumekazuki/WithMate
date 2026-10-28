import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import type { CodexSandboxMode } from "../../src-shared/settings/codex-sandbox-mode.js";
import { buildRuntimeSelectionOptions } from "../../src/settings/runtime-selection-options.js";

const providerCatalog: ModelCatalogProvider = {
  id: "codex",
  label: "Codex",
  defaultModelId: "model-a",
  defaultReasoningEffort: "medium",
  models: [
    {
      id: "model-a",
      label: "Model A",
      reasoningEfforts: ["low", "medium", "high"],
    },
  ],
};

// @test-value v2
// kind = "contract"
// claim = "Claude selectorは保存済みApprovalを維持し、対応値は選択可能、非対応値はdisabledのUnsupportedとして表示する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md; docs/design/provider-adapter.md#approval-modes" }
// fault = "保存済みuntrustedを自動実行へ暗黙変換するか、neverを非対応として扱う"
// observable = "選択値を含むapprovalChoiceOptionsのvalue、label、disabled"
// observation_boundary = "public-boundary"
// scope = "Claude runtime selection saved approval"
// lifecycle = "permanent"
// impact = "利用者の承認設定が意図せず変わるかAuto Runを選べなくなる"
// distinction = "provider候補一覧testは保存済み選択値を補完するrenderer側の経路を通らない"
// @end-test-value
test("Claude runtime options preserve supported and unsupported saved approval values", () => {
  const supported = [
    { value: "never", label: "Auto Run" },
    { value: "on-request", label: "Provider Controlled" },
    { value: "accept-edits", label: "Accept Edits" },
    { value: "dont-ask", label: "Preapproved Only" },
    { value: "plan", label: "Plan" },
  ];
  for (const selectedApprovalMode of ["never", "on-request", "accept-edits", "dont-ask", "plan", "untrusted"] as const) {
    const options = buildRuntimeSelectionOptions({
      providerId: "claude", providerCatalog: null, models: [], selectedModel: "claude-opus-5-5",
      reasoningEfforts: ["high"], selectedApprovalMode, selectedCodexSandboxMode: "workspace-write",
      selectedCodexSpeed: "standard", selectedCodexReviewer: "user",
    });
    assert.deepEqual(options.approvalChoiceOptions, selectedApprovalMode === "untrusted"
      ? [{ value: "untrusted", label: "Unsupported (untrusted)", disabled: true }, ...supported]
      : supported);
  }
});

// @test-value v2
// kind = "contract"
// claim = "providerと現在の選択値からruntime optionsを構築し、Depth候補へ省略用Defaultを含める"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#approval-modes; docs/design/provider-adapter.md#sandbox-modes; docs/design/model-catalog.md" }
// fault = "provider非対応の設定が現れるか、既存sessionのmodelまたはreasoning表示が失われる"
// observable = "approval、sandbox、model、reasoning optionsとfallback label"
// observation_boundary = "public-boundary"
// scope = "runtime-selection-options"
// lifecycle = "permanent"
// @end-test-value
test("buildRuntimeSelectionOptions は approval / sandbox / model / reasoning / fallback をまとめて構築する", () => {
  const options = buildRuntimeSelectionOptions({
    providerId: "copilot",
    providerCatalog,
    models: providerCatalog.models,
    selectedModel: "legacy-model",
    reasoningEfforts: ["high", "low"],
    selectedApprovalMode: "on-request",
    selectedCodexSandboxMode: "danger-full-access" as CodexSandboxMode,
    selectedCodexSpeed: "standard",
    selectedCodexReviewer: "auto-review",
  });

  assert.deepEqual(options.approvalChoiceOptions, [
    { value: "never", label: "Auto Run" },
    { value: "on-request", label: "Provider Controlled" },
    { value: "untrusted", label: "Safety Focused" },
  ]);
  assert.deepEqual(options.sandboxChoiceOptions, []);
  assert.deepEqual(options.modelSelectOptions[0], { value: "legacy-model", label: "legacy-model", model: null });
  assert.equal(options.selectedModelFallbackLabel, "legacy-model");
  assert.deepEqual(options.reasoningSelectOptions, [
    { value: "", label: "Default" },
    { value: "high", label: "High" },
    { value: "low", label: "Low" },
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "Codex以外でもsandbox候補を空に保ちmodelとDepth候補および省略用Defaultを構築する"
// oracle = { type = "contract", ref = "runtime-selection-options provider capability contract" }
// fault = "非対応providerにsandbox選択肢を表示するか空の選択結果を返せない"
// observable = "sandboxChoiceOptionsとmodelSelectOptions"
// observation_boundary = "public-boundary"
// scope = "runtime-selection-options non-Codex sandbox"
// lifecycle = "permanent"
// @end-test-value
test("buildRuntimeSelectionOptions は Copilot 以外で sandbox 選択肢が空でも保持できる", () => {
  const options = buildRuntimeSelectionOptions({
    providerId: "openai",
    providerCatalog,
    models: providerCatalog.models,
    selectedModel: "model-a",
    reasoningEfforts: ["low", "high"],
    selectedApprovalMode: "untrusted",
    selectedCodexSandboxMode: "workspace-write",
    selectedCodexSpeed: "standard",
    selectedCodexReviewer: "auto-review",
  });

  assert.deepEqual(options.sandboxChoiceOptions, []);
  assert.deepEqual(options.modelSelectOptions, [{ value: "model-a", label: "Model A", model: providerCatalog.models[0] }]);
  assert.equal(options.selectedModelFallbackLabel, "Model A");
  assert.deepEqual(options.reasoningSelectOptions, [
    { value: "", label: "Default" },
    { value: "low", label: "Low" },
    { value: "high", label: "High" },
  ]);
});
