import assert from "node:assert/strict";
import test from "node:test";
import { searchModelPickerOptions } from "../../src/chat/composer/model-picker-options.js";

// @test-value v2
// kind = "contract"
// claim = "Model候補は名前の自然昇順、同名時sourceとIDの順で並び、検索は名前とIDの完全一致・前方・部分・sourceのみの順を守る"
// oracle = { type = "contract", ref = "docs/design/model-catalog.md#model-ui" }
// fault = "辞書順だけでmodel番号を比較するかsource一致を名前とIDの一致より上位にする"
// observable = "空検索と大小文字を混ぜた検索で得られるvalue列"
// observation_boundary = "public-boundary"
// scope = "model-picker-options"
// lifecycle = "permanent"
// impact = "大量の同名modelから意図した候補を探せなくなる"
// distinction = "型検査や描画確認では検出できない比較と検索順位を少数の候補で検証する"
// @end-test-value
test("Model search ranks name and ID matches before source and sorts naturally", () => {
  const options = [
    { value: "z", label: "Model 10", sourceLabel: "Beta" },
    { value: "b", label: "Model 2", sourceLabel: "Beta" },
    { value: "a2", label: "Model 2", sourceLabel: "Alpha" },
    { value: "a1", label: "Model 2", sourceLabel: "Alpha" },
  ];
  assert.deepEqual(searchModelPickerOptions(options, "").map((option) => option.value), ["a1", "a2", "b", "z"]);
  const matches = [
    { value: "source", label: "A", sourceLabel: "Model" },
    { value: "substring", label: "My Model" },
    { value: "prefix", label: "Model 2" },
    { value: "id", label: "Model" },
    { value: "model", label: "Z" },
    { value: "other", label: "Other" },
  ];
  assert.deepEqual(searchModelPickerOptions(matches, " MoDeL ").map((option) => option.value), ["id", "model", "prefix", "substring", "source"]);
});
