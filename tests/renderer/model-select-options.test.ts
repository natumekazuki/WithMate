import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCatalogItem, ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import {
  buildModelSelectOptions,
  buildReasoningEffortSelectOptions,
  resolveModelFallbackLabel,
} from "../../src/settings/model-select-options.js";

const models: ModelCatalogItem[] = [
  {
    id: "gpt-test",
    label: "GPT Test",
    reasoningEfforts: ["low", "medium"],
  },
  {
    id: "gpt-other",
    label: "GPT Other",
    reasoningEfforts: ["high"],
  },
];

const providerCatalog: ModelCatalogProvider = {
  id: "codex",
  label: "Codex",
  defaultModelId: "gpt-test",
  defaultReasoningEffort: "medium",
  models,
};

test("buildModelSelectOptions は model catalog item を select option に変換する", () => {
  assert.deepEqual(buildModelSelectOptions(models), [
    { value: "gpt-test", label: "GPT Test" },
    { value: "gpt-other", label: "GPT Other" },
  ]);
});

test("buildModelSelectOptions は catalog にない選択中 model を先頭に保持する", () => {
  assert.deepEqual(buildModelSelectOptions(models, "legacy-model"), [
    { value: "legacy-model", label: "legacy-model" },
    { value: "gpt-test", label: "GPT Test" },
    { value: "gpt-other", label: "GPT Other" },
  ]);
});

// @test-value v2
// kind = "invariant"
// claim = "reasoning effort選択肢は保存用IDを保持してTitle Caseの表示名を返す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#表示言語・操作・状態" }
// fault = "表示名の変換で選択valueも変わるか、未変換の表示名がselectに露出する"
// observable = "buildReasoningEffortSelectOptionsが返すvalueとlabelの対応"
// observation_boundary = "public-boundary"
// scope = "reasoning effort select options"
// lifecycle = "permanent"
// @end-test-value
test("buildReasoningEffortSelectOptions は reasoning effort を select option に変換する", () => {
  assert.deepEqual(buildReasoningEffortSelectOptions(["low", "medium", "xhigh", "max", "ultra"]), [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "xhigh", label: "X High" },
    { value: "max", label: "Max" },
    { value: "ultra", label: "Ultra" },
  ]);
});

test("resolveModelFallbackLabel は catalog label または model id を返す", () => {
  assert.equal(resolveModelFallbackLabel(providerCatalog, "gpt-test"), "GPT Test");
  assert.equal(resolveModelFallbackLabel(providerCatalog, "unknown-model"), "unknown-model");
  assert.equal(resolveModelFallbackLabel(null, "gpt-test"), "gpt-test");
});
