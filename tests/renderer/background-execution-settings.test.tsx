import assert from "node:assert/strict";
import { it } from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { BackgroundExecutionSettings } from "../../src/settings/BackgroundExecutionSettings.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import { AFFECT_COMPOSITION_INSTRUCTIONS } from "../../src-shared/character-affect/affect-composition.js";
import { MEMORY_REGISTRATION_PRESETS } from "../../src-shared/memory-recording/memory-registration-input.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// @test-value v2
// kind = "contract"
// claim = "背景候補は共通Model・サービス無効設定を反映し、保存値を保持したまま有効候補へ変更できる"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md#current-scope" }
// fault = "無効Modelが選択できる、全Model無効のProviderを選べる、または無効化で保存選択を自動置換する"
// observable = "selectの値と選択可能option、Disabled表示、Depth、変更callback、再有効化後のProvider選択結果"
// observation_boundary = "component-behavior"
// scope = "background model availability editing"
// lifecycle = "permanent"
// impact = "意図しない背景Modelへの切替や利用停止したModelの選択を誘発する"
// distinction = "runtimeの拒否testでは候補の除外と保存選択を修正するUI操作を観測できない"
// @end-test-value
it("無効な背景Modelを保持し候補から除外して再有効化を反映する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const globals = ["window", "document", "Node", "HTMLElement", "Event"] as const;
  const previous = Object.fromEntries(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const settings = createDefaultAppSettings();
  settings.codingProviderSettings.opencode = { ...settings.codingProviderSettings.codex, enabled: true };
  settings.backgroundExecutionSettings["character-memory"] = { selection: { providerId: "codex", modelId: "deep", reasoningEffort: "high" } };
  settings.backgroundExecutionSettings.affect = { selection: { providerId: "opencode", modelId: "service/deep", reasoningEffort: "high" } };
  settings.modelAvailability = {
    codex: { disabledModelIds: ["deep"], disabledServiceIds: [] },
    opencode: { disabledModelIds: ["service/deep"], disabledServiceIds: ["service"] },
  };
  const catalog: ModelCatalogSnapshot = { providers: ["codex", "opencode"].map((id) => {
    const prefix = id === "opencode" ? "service/" : "";
    return { id, label: id, defaultModelId: `${prefix}deep`, defaultReasoningEffort: "high", models: [
      { id: `${prefix}deep`, label: "Deep", reasoningEfforts: ["low", "high"] },
      { id: `${prefix}plain`, label: "Plain", reasoningEfforts: [] },
    ] };
  }) };
  let changes = 0;
  const render = () => root.render(<BackgroundExecutionSettings settings={settings} catalog={catalog}
    onChangePurpose={(purpose, value) => { changes++; settings.backgroundExecutionSettings[purpose] = value; render(); }} onChangeFrequencies={() => {}} />);
  const select = (label: string) => dom.window.document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  const enabledValues = (label: string) => Array.from(select(label).options).filter((option) => !option.disabled).map((option) => option.value);
  const choose = async (label: string, value: string) => act(async () => {
    select(label).value = value;
    select(label).dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  try {
    const before = structuredClone(settings.backgroundExecutionSettings);
    await act(async () => render());
    assert.deepEqual(enabledValues("Character Memory Model"), ["plain"]);
    assert.equal(select("Character Memory Model").value, "deep");
    assert.equal(select("Character Memory Model").disabled, false);
    assert.match(select("Character Memory Model").selectedOptions[0]!.textContent!, /Disabled/);
    assert.equal(select("Character Memory Depth").value, "high");
    assert.equal(select("Character Memory Depth").disabled, true);
    assert.deepEqual(enabledValues("Character Affect Model"), []);
    assert.equal(select("Character Affect Model").value, "service/deep");
    assert.equal(select("Character Affect Model").disabled, true);
    assert.ok(!enabledValues("Target Memory Provider").includes("opencode"));
    assert.match(dom.window.document.body.textContent!, /Enable the selected model and its service in Models/);
    assert.deepEqual(settings.backgroundExecutionSettings, before);
    assert.equal(changes, 0);
    settings.modelAvailability.opencode.disabledServiceIds = [];
    await act(async () => render());
    assert.deepEqual(enabledValues("Character Affect Model"), ["service/plain"]);
    assert.equal(changes, 0);
    await choose("Target Memory Provider", "opencode");
    assert.equal(select("Target Memory Model").value, "service/plain");
    await choose("Character Memory Model", "plain");
    assert.equal(settings.backgroundExecutionSettings["character-memory"].selection!.modelId, "plain");
    assert.equal(select("Character Memory Depth"), null);
    settings.modelAvailability = {};
    await act(async () => render());
    assert.deepEqual(enabledValues("Character Affect Model"), ["service/deep", "service/plain"]);
    assert.equal(select("Character Affect Depth").value, "high");
    assert.equal(select("Character Affect Depth").disabled, false);
    assert.deepEqual(settings.backgroundExecutionSettings.affect, before.affect);
    assert.equal(changes, 2);
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

// @test-value v2
// kind = "contract"
// claim = "背景用途は有効ProviderからModel・Depthと対応権限を選べ、Provider変更だけ権限を初期化し不正組合せを修正でき、catalog更新ではdraftを保持する"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md#current-scope" }
// fault = "Provider変更で非対応権限を持ち越すか、Model変更で権限を捨てるか、保存済み不正組合せを隠すか、catalog更新でdraftを書き換える"
// observable = "用途別selectの値・候補・disabled・aria-invalid状態、用途別設定とonChangePurpose呼出回数"
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
    assert.equal(select("Character Memory Approval"), null);
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
    assert.equal(select("Character Memory Approval").value, "on-request");
    assert.equal(select("Character Memory Sandbox"), null);
    await choose("Character Memory Reviewer", "auto-review");
    assert.equal(Array.from(select("Character Memory Approval").options).find((option) => option.value === "accept-edits")!.disabled, true);
    await choose("Character Memory Reviewer", "user");
    await choose("Character Memory Approval", "accept-edits");
    await choose("Character Memory Model", "claude-plain");
    assert.equal(select("Character Memory Approval").value, "accept-edits");
    assert.equal(select("Character Memory Depth"), null);
    assert.equal(settings.backgroundExecutionSettings["character-memory"].selection?.reasoningEffort, undefined);
    assert.deepEqual(settings.backgroundExecutionSettings["target-memory"], snapshot["target-memory"]);
    assert.deepEqual(settings.backgroundExecutionSettings.affect, snapshot.affect);
    settings.backgroundExecutionSettings["character-memory"].selection!.codexReviewer = "auto-review";
    await act(async () => render());
    assert.equal(select("Character Memory Reviewer").value, "auto-review");
    assert.equal(select("Character Memory Reviewer").getAttribute("aria-invalid"), "true");
    assert.match(dom.window.document.body.textContent!, /reviewer is not supported with this approval mode/);
    await choose("Character Memory Reviewer", "user");
    await choose("Character Memory Provider", "codex");
    await choose("Character Memory Sandbox", "read-only");
    await choose("Character Memory Provider", "opencode");
    assert.equal(select("Character Memory Approval").value, "on-request");
    assert.equal(select("Character Memory Reviewer"), null);
    assert.equal(select("Character Memory Sandbox"), null);
    assert.equal(settings.backgroundExecutionSettings["character-memory"].selection!.codexSandboxMode, undefined);
    settings.backgroundExecutionSettings["character-memory"].selection!.approvalMode = "untrusted";
    settings.backgroundExecutionSettings["character-memory"].selection!.codexSandboxMode = "read-only";
    await act(async () => render());
    assert.equal(select("Character Memory Approval").value, "untrusted");
    assert.equal(select("Character Memory Approval").getAttribute("aria-invalid"), "true");
    assert.equal(select("Character Memory Sandbox").value, "read-only");
    await choose("Character Memory Sandbox", "");
    await choose("Character Memory Approval", "on-request");
    assert.equal(select("Character Memory Sandbox"), null);
    await choose("Character Memory Provider", "claude");
    await choose("Character Memory Model", "claude-plain");
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

// @test-value v2
// kind = "contract"
// claim = "三用途のUse Presetボタンは現在本文を用途presetの明示本文へ置換し、本文は未設定時も置換後も編集できる"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md#current-scope" }
// fault = "押下が別用途や権限を変更する、preset参照モードへ戻す、または本文を編集不能にする"
// observable = "用途別button押下後のinstructionText・textarea値とreadOnly、他用途設定とselectionの保持"
// observation_boundary = "component-behavior"
// scope = "background registration instructions editing and preset replacement"
// lifecycle = "permanent"
// impact = "ユーザーが登録promptを置換・編集できないか、別用途の設定を意図せず失う"
// distinction = "共有preset定数や保存schemaのtestではUI操作が正しい用途のdraft本文へ届くことを検出できない"
// @end-test-value
it("Use Presetで用途本文を置換し編集可能な状態を保つ", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const globals = ["window", "document", "Node", "HTMLElement", "Event"] as const;
  const previous = Object.fromEntries(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  let settings = createDefaultAppSettings();
  let changes = 0;
  const render = () => root.render(<BackgroundExecutionSettings settings={settings} catalog={null}
    onChangePurpose={(purpose, value) => {
      changes++;
      settings = { ...settings, backgroundExecutionSettings: { ...settings.backgroundExecutionSettings, [purpose]: value } };
      render();
    }} onChangeFrequencies={() => assert.fail("Preset replacement must not change frequencies")} />);
  try {
    await act(async () => render());
    for (const [purpose, label] of [["character-memory", "Character Memory"], ["target-memory", "Target Memory"], ["affect", "Character Affect"]] as const) {
      const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label} Registration Instructions"]`)!;
      assert.equal(textarea.readOnly, false);
      const preset = purpose === "affect" ? AFFECT_COMPOSITION_INSTRUCTIONS : MEMORY_REGISTRATION_PRESETS[purpose];
      assert.equal(textarea.value, preset);
      settings.backgroundExecutionSettings[purpose] = { instructionText: "Edited prompt", selection: {
        providerId: "codex", modelId: "test", approvalMode: "on-request", codexSandboxMode: "read-only",
      } };
      await act(async () => render());
      const before = structuredClone(settings.backgroundExecutionSettings);
      const button = dom.window.document.querySelector<HTMLButtonElement>(`button[aria-label="${label} Use Preset"]`)!;
      assert.equal(button.type, "button");
      await act(async () => button.click());
      assert.equal(changes, 1);
      changes = 0;
      assert.equal(settings.backgroundExecutionSettings[purpose].instructionText, preset);
      assert.equal(textarea.value, preset);
      assert.equal(textarea.readOnly, false);
      assert.deepEqual(settings.backgroundExecutionSettings, { ...before, [purpose]: { ...before[purpose], instructionText: preset } });
    }
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
