import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCatalogItem, ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import {
  buildModelSelectOptions,
  buildReasoningEffortSelectOptions,
  resolveModelFallbackLabel,
} from "../../src/settings/model-select-options.js";
import { buildRuntimeSelectionOptions } from "../../src/settings/runtime-selection-options.js";

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
// kind = "contract"
// claim = "モデル候補は取得元表示とSDKのopaque IDを分離し、候補外の保存選択も保持する"
// oracle = { type = "contract", ref = "Issue #879 source-grouped discovered model picker" }
// fault = "取得元を落とす、IDを表示用labelへ変える、または未収録の選択を消す"
// observable = "buildModelSelectOptionsのvalue/label/sourceLabel"
// observation_boundary = "consumer"
// scope = "discovered model option projection"
// lifecycle = "permanent"
// impact = "取得元の識別または保存済みモデルの再送条件が失われる"
// distinction = "構造の型検査ではSDK IDと取得元の値が正しく伝わることを確認できない"
// @end-test-value
test("取得元とopaque model IDを保持して保存済み候補を残す", () => {
  assert.deepEqual(buildModelSelectOptions([
    { id: "vendor/model.v1", label: "Model", sourceLabel: "Vendor", reasoningEfforts: [] },
  ], "saved/model"), [
    { value: "saved/model", label: "saved/model" },
    { value: "vendor/model.v1", label: "Model", sourceLabel: "Vendor" },
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "現在のSDK候補から消えた保存済みDepthも選択肢に残す"
// oracle = { type = "contract", ref = "Issue #879 preserve saved model and Depth during discovery" }
// fault = "候補更新で選択中のDepthを表示できなくする"
// observable = "runtime option projectionのreasoningSelectOptions"
// observation_boundary = "consumer"
// scope = "saved SDK-specific Depth projection"
// lifecycle = "permanent"
// impact = "利用者がSendへ渡される現在のDepthを判断できなくなる"
// distinction = "型検査では保存値と新しい候補一覧の不一致を検出できない"
// @end-test-value
test("SDK候補にない保存済みDepthを表示候補に保持する", () => {
  const options = buildRuntimeSelectionOptions({
    providerId: "codex", providerCatalog, models, selectedModel: "gpt-test",
    selectedReasoningEffort: "sdk-specific-depth", reasoningEfforts: ["low"],
    selectedApprovalMode: "never", selectedCodexSandboxMode: "workspace-write",
    selectedCodexSpeed: "standard", selectedCodexReviewer: "user",
  });
  assert.deepEqual(options.reasoningSelectOptions, [
    { value: "sdk-specific-depth", label: "sdk-specific-depth" }, { value: "", label: "Default" }, { value: "low", label: "Low" },
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "SDK候補があるDepthでは省略値をDefaultとして一度だけ表示し、候補なしでは欄を隠すため空一覧を返す"
// oracle = { type = "contract", ref = "Issue #879 SDK Depth omission and unsupported Depth controls" }
// fault = "省略値を先頭のSDK Depthとして表示する、省略optionを重複させる、または非対応モデルへDepth欄を作る"
// observable = "空選択とSDK候補有無に対するreasoningSelectOptionsのvalueとlabel"
// observation_boundary = "consumer"
// scope = "SDK Depth omission option projection"
// lifecycle = "permanent"
// impact = "画面の選択DepthとSendへ捕捉される空文字が食い違う"
// distinction = "型検査ではnative selectが選択option不在時に先頭値を表示する不一致を検出できない"
// @end-test-value
test("Depthの省略値をDefaultとして一度だけ表示し非対応モデルでは欄を作らない", () => {
  const input = {
    providerId: "codex", providerCatalog, models, selectedModel: "gpt-test", selectedReasoningEffort: "",
    selectedApprovalMode: "never" as const, selectedCodexSandboxMode: "workspace-write" as const,
    selectedCodexSpeed: "standard" as const, selectedCodexReviewer: "user" as const,
  };
  const expected = [{ value: "", label: "Default" }, { value: "low", label: "Low" }];
  assert.deepEqual(buildRuntimeSelectionOptions({ ...input, reasoningEfforts: ["low"] }).reasoningSelectOptions, expected);
  assert.deepEqual(buildRuntimeSelectionOptions({ ...input, reasoningEfforts: ["", "low"] }).reasoningSelectOptions, expected);
  assert.deepEqual(buildRuntimeSelectionOptions({
    ...input, selectedReasoningEffort: "saved-depth", reasoningEfforts: [],
  }).reasoningSelectOptions, []);
  assert.equal(input.selectedReasoningEffort, "");
});

// @test-value v2
// kind = "invariant"
// claim = "reasoning effort選択肢は保存用IDを保持してTitle Caseの表示名を返す"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#表示言語と文言" }
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
