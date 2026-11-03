import assert from "node:assert/strict";
import { it } from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { BackgroundExecutionSettings } from "../../src/settings/BackgroundExecutionSettings.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// @test-value v2
// kind = "contract"
// claim = "背景用途は有効ProviderからModel・Depthの順に選べ、無効化やcatalog更新では用途別draftを保持し無効ProviderのModel・Depth編集を止める"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md#current-scope" }
// fault = "無効Providerを新規選択可能にするか、無効化やcatalog更新で保存選択を書き換えるか、Providerと異なるModel候補や別用途のDepthを適用する"
// observable = "Provider・Model・Depth selectの順序と値・候補・disabled状態、用途別設定とonChangePurpose呼出回数"
// observation_boundary = "component-behavior"
// scope = "background-settings-selection"
// lifecycle = "permanent"
// impact = "意図しないmodelまたはDepthでMemory・Affectを生成する"
// distinction = "保存testや型検査ではProvider選択可否、DOM optionの範囲、明示操作とcatalog更新の差を検出できない"
// @end-test-value
it("背景modelとDepthの選択を用途別に保ちcatalog更新では変更しない", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const globals = ["window", "document", "Node", "HTMLElement", "Event"] as const;
  const previous = Object.fromEntries(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  let settings = createDefaultAppSettings();
  let changes = 0;
  let catalog: ModelCatalogSnapshot = { providers: ["codex", "copilot", "claude", "opencode"].map((id) => ({
    id, label: id, defaultModelId: `${id}-deep`, defaultReasoningEffort: "high",
    models: [
      { id: `${id}-deep`, label: "Deep", reasoningEfforts: ["low", "high", "native-depth"], defaultReasoningEffort: "high" },
      { id: `${id}-plain`, label: "Plain", reasoningEfforts: [] },
    ],
  })) };
  const render = () => root.render(<BackgroundExecutionSettings settings={settings} catalog={catalog}
    onChangePurpose={(purpose, value) => {
      changes++;
      settings = { ...settings, backgroundExecutionSettings: { ...settings.backgroundExecutionSettings, [purpose]: value } };
      render();
    }} onChangeFrequencies={() => {}} />);
  const select = (label: string) => dom.window.document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  const choose = async (label: string, value: string) => act(async () => {
    const control = select(label);
    control.value = value;
    control.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  try {
    await act(async () => render());
    assert.equal(select("Character Memory Provider").value, "");
    assert.equal(select("Character Memory Model").disabled, true);
    assert.equal(select("Character Memory Depth"), null);
    assert.deepEqual(Array.from(select("Character Memory Provider").options, (option) => option.value), ["", "codex"]);
    for (const id of ["copilot", "claude", "opencode"]) settings.codingProviderSettings[id] = { ...settings.codingProviderSettings.codex, enabled: true };
    await act(async () => render());
    for (const [index, label] of ["Character Memory", "Target Memory", "Character Affect"].entries()) {
      const providerId = ["codex", "copilot", "opencode"][index];
      await choose(`${label} Provider`, providerId);
      assert.equal(select(`${label} Model`).value, `${providerId}-deep`);
      assert.deepEqual(Array.from(select(`${label} Model`).options, (option) => option.value), [`${providerId}-deep`, `${providerId}-plain`]);
      assert.equal(select(`${label} Depth`).value, "high");
      assert.deepEqual(Array.from(select(`${label} Provider`).closest(".settings-background-model-selection")!.querySelectorAll("select"), (entry) => entry.getAttribute("aria-label")), [`${label} Provider`, `${label} Model`, `${label} Depth`]);
      await choose(`${label} Depth`, ["native-depth", "low", ""][index]);
      assert.equal(select(`${label} Model`).value, `${providerId}-deep`);
    }
    const snapshot = structuredClone(settings.backgroundExecutionSettings);
    const changeCount = changes;
    settings.codingProviderSettings.codex = { ...settings.codingProviderSettings.codex, enabled: false };
    await act(async () => render());
    assert.equal(select("Character Memory Provider").selectedOptions[0].disabled, true);
    assert.match(select("Character Memory Provider").selectedOptions[0].textContent!, /Disabled/);
    assert.equal(select("Character Memory Model").disabled, true);
    assert.equal(select("Character Memory Depth").disabled, true);
    assert.deepEqual(settings.backgroundExecutionSettings, snapshot);
    settings.codingProviderSettings.codex = { ...settings.codingProviderSettings.codex, enabled: true };
    catalog = { ...catalog, providers: catalog.providers.map((provider) => ({ ...provider, models: provider.models.map((model) => model.id.endsWith("-deep") ? { ...model, reasoningEfforts: ["low"] } : model) })) };
    await act(async () => render());
    assert.equal(changes, changeCount);
    assert.deepEqual(settings.backgroundExecutionSettings, snapshot);
    assert.equal(select("Character Memory Depth").value, "native-depth");
    await choose("Character Memory Provider", "claude");
    await choose("Character Memory Model", "claude-plain");
    assert.equal(select("Character Memory Depth"), null);
    assert.equal(settings.backgroundExecutionSettings["character-memory"].selection?.reasoningEffort, undefined);
    assert.deepEqual(settings.backgroundExecutionSettings["target-memory"], snapshot["target-memory"]);
    assert.deepEqual(settings.backgroundExecutionSettings.affect, snapshot.affect);
    const missingSnapshot = structuredClone(settings.backgroundExecutionSettings);
    catalog = { providers: [] };
    const missingChangeCount = changes;
    await act(async () => render());
    assert.equal(select("Character Memory Provider").value, "claude");
    assert.equal(select("Character Memory Provider").selectedOptions[0].disabled, true);
    assert.equal(select("Character Memory Model").value, "claude-plain");
    assert.equal(select("Character Memory Model").disabled, true);
    assert.equal(changes, missingChangeCount);
    assert.deepEqual(settings.backgroundExecutionSettings, missingSnapshot);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of globals) {
      const descriptor = previous[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
