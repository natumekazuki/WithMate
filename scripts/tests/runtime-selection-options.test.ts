import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCatalogProvider } from "../../src/model-catalog.js";
import type { ApprovalMode } from "../../src/approval-mode.js";
import type { CodexSandboxMode } from "../../src/codex-sandbox-mode.js";
import { buildRuntimeSelectionOptions } from "../../src/runtime-selection-options.js";

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

test("buildRuntimeSelectionOptions は approval / sandbox / model / reasoning / fallback をまとめて構築する", () => {
  const options = buildRuntimeSelectionOptions({
    providerId: "copilot",
    providerCatalog,
    models: providerCatalog.models,
    selectedModel: "legacy-model",
    reasoningEfforts: ["high", "low"],
    selectedApprovalMode: "on-failure" as ApprovalMode,
    selectedCodexSandboxMode: "danger-full-access" as CodexSandboxMode,
  });

  assert.deepEqual(options.approvalChoiceOptions, [
    { value: "on-failure", label: "on-failure" },
    { value: "never", label: "never" },
    { value: "on-request", label: "on-request" },
    { value: "untrusted", label: "untrusted" },
  ]);
  assert.deepEqual(options.sandboxChoiceOptions, []);
  assert.deepEqual(options.modelSelectOptions[0], { value: "legacy-model", label: "legacy-model" });
  assert.equal(options.selectedModelFallbackLabel, "legacy-model");
  assert.deepEqual(options.reasoningSelectOptions, [
    { value: "high", label: "high" },
    { value: "low", label: "low" },
  ]);
});

test("buildRuntimeSelectionOptions は Copilot 以外で sandbox 選択肢が空でも保持できる", () => {
  const options = buildRuntimeSelectionOptions({
    providerId: "openai",
    providerCatalog: null,
    models: [],
    selectedModel: "",
    reasoningEfforts: [],
    selectedApprovalMode: "untrusted",
    selectedCodexSandboxMode: "workspace-write",
  });

  assert.deepEqual(options.sandboxChoiceOptions, []);
  assert.deepEqual(options.modelSelectOptions, []);
});
