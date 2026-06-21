import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCatalogItem, ModelCatalogProvider } from "../../src/model-catalog.js";
import {
  buildModelSelectOptions,
  buildReasoningEffortSelectOptions,
  resolveModelFallbackLabel,
} from "../../src/model-select-options.js";

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

test("buildReasoningEffortSelectOptions は reasoning effort を select option に変換する", () => {
  assert.deepEqual(buildReasoningEffortSelectOptions(["low", "medium", "xhigh"]), [
    { value: "low", label: "low" },
    { value: "medium", label: "medium" },
    { value: "xhigh", label: "xhigh" },
  ]);
});

test("resolveModelFallbackLabel は catalog label または model id を返す", () => {
  assert.equal(resolveModelFallbackLabel(providerCatalog, "gpt-test"), "GPT Test");
  assert.equal(resolveModelFallbackLabel(providerCatalog, "unknown-model"), "unknown-model");
  assert.equal(resolveModelFallbackLabel(null, "gpt-test"), "gpt-test");
});
