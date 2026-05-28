import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ModelCatalogProvider } from "../../src/model-catalog.js";
import {
  AUXILIARY_LAUNCH_NO_PROVIDER_FEEDBACK,
  AUXILIARY_LAUNCH_NO_SELECTION_FEEDBACK,
  buildAuxiliaryLaunchProviderItems,
  resolveAuxiliaryLaunchInitialState,
  resolveAuxiliaryLaunchProviderId,
} from "../../src/chat/auxiliary-launch-state.js";

function makeProvider(
  id: string,
  label: string,
  options: { hasModel?: boolean } = {},
): ModelCatalogProvider {
  const hasModel = options.hasModel ?? true;
  return {
    id,
    label,
    defaultModelId: hasModel ? "gpt-5.4-mini" : "",
    defaultReasoningEffort: "high",
    models: hasModel
      ? [{
        id: "gpt-5.4-mini",
        label: "GPT 5.4 mini",
        reasoningEfforts: ["high"],
      }]
      : [],
  };
}

describe("auxiliary-launch-state", () => {
  it("provider filter と item 化を provider 条件で行う", () => {
    const providers: ModelCatalogProvider[] = [
      makeProvider("a", "A", { hasModel: false }),
      makeProvider("b", "B"),
      makeProvider("c", "C", { hasModel: false }),
      makeProvider("d", "D"),
    ];
    const items = buildAuxiliaryLaunchProviderItems(providers, (provider) => provider.models.length > 0);

    assert.deepEqual(items, [
      { id: "b", label: "B" },
      { id: "d", label: "D" },
    ]);
  });

  it("resolve 初期 provider は current provider を優先し、なければ先頭を使う", () => {
    const items = [
      { id: "b", label: "B" },
      { id: "d", label: "D" },
    ];

    assert.equal(resolveAuxiliaryLaunchProviderId(items, "d"), "d");
    assert.equal(resolveAuxiliaryLaunchProviderId(items, "missing"), "b");
  });

  it("初期 state は provider 解決と feedback を同時に返す", () => {
    const items = [
      { id: "b", label: "B" },
      { id: "d", label: "D" },
    ];

    assert.deepEqual(resolveAuxiliaryLaunchInitialState(items, "d"), {
      providerId: "d",
      feedback: "",
    });
    assert.deepEqual(resolveAuxiliaryLaunchInitialState(items, "missing"), {
      providerId: "b",
      feedback: "",
    });
  });

  it("provider が空のときは resolveAuxiliaryLaunchProviderId が null を返す", () => {
    const emptyItems: Array<{ id: string; label: string }> = [];

    assert.equal(resolveAuxiliaryLaunchProviderId(emptyItems, "codex"), null);
  });

  it("provider が空のときは初期 state の feedback が空 provider 用になる", () => {
    const emptyItems: Array<{ id: string; label: string }> = [];

    assert.deepEqual(resolveAuxiliaryLaunchInitialState(emptyItems, "codex"), {
      providerId: null,
      feedback: AUXILIARY_LAUNCH_NO_PROVIDER_FEEDBACK,
    });
  });

  it("feedback 文言は固定文言を使う", () => {
    assert.equal(AUXILIARY_LAUNCH_NO_PROVIDER_FEEDBACK, "有効な Coding Provider がないよ。");
    assert.equal(AUXILIARY_LAUNCH_NO_SELECTION_FEEDBACK, "有効な Coding Provider を選んでね。");
  });
});
