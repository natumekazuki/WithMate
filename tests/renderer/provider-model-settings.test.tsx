import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import type { ModelAvailabilitySettings } from "../../src-shared/settings/model-availability.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function withSettings(run: (context: {
  document: Document;
  window: JSDOM["window"];
  render: (props: import("../../src/settings/provider-model-settings.js").ProviderModelSettingsProps) => Promise<void>;
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const globals = ["window", "document", "Node", "HTMLElement", "HTMLInputElement", "Event", "MouseEvent", "KeyboardEvent"] as const;
  const previous = Object.fromEntries(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  const { createRoot } = await import("react-dom/client");
  const { ProviderModelSettings } = await import("../../src/settings/provider-model-settings.js");
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await run({ document: dom.window.document, window: dom.window, render: async (props) => {
      await act(async () => root.render(<ProviderModelSettings {...props} />));
    } });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of globals) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]!);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const provider = (id: string): ModelCatalogProvider => ({
  id, label: id === "opencode" ? "OpenCode" : "Codex", defaultModelId: "", defaultReasoningEffort: "",
  models: [
    { id: "vendor/model10", label: "Model 10", sourceLabel: "vendor", reasoningEfforts: [] },
    { id: "vendor/model2", label: "Model 2", sourceLabel: "vendor", reasoningEfforts: [] },
  ],
});

// @test-value v2
// kind = "contract"
// claim = "OpenCodeのサービス無効化は個別チェックと他Provider設定を保持し、一時消失した無効Modelも再有効化できる"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md" }
// fault = "サービス変更で個別設定を消去するか、cacheにない保存済み無効Modelの再有効化を不能にする"
// observable = "サービスとModel checkboxのchecked/disabledおよびonChangeの全Provider設定"
// observation_boundary = "component-behavior"
// scope = "ProviderModelSettings OpenCode draft編集"
// lifecycle = "permanent"
// impact = "サービス再有効化で意図しないModelが復活するか、消失したModelの無効設定を取り消せない"
// distinction = "設定helperやstorageのtestでは検出できないnative checkboxと全体draft更新の対応を検証する"
// @end-test-value
test("service toggles preserve model choices and missing disabled models remain editable", async () => {
  await withSettings(async ({ document, render }) => {
    let availability: ModelAvailabilitySettings = {
      codex: { disabledServiceIds: [], disabledModelIds: ["other"] },
      opencode: { disabledServiceIds: [], disabledModelIds: ["vendor/model2", "missing/old"] },
    };
    const props = () => ({ provider: provider("opencode"), availability, providerEnabled: true, onChange: (next: ModelAvailabilitySettings) => { availability = next; }, onBack: () => {} });
    const service = () => document.querySelector<HTMLInputElement>('[aria-label="vendor Service"]')!;
    const model = (id: string) => document.querySelector<HTMLInputElement>(`label[title="${id}"] input`)!;
    await render(props());
    assert.equal(model("vendor/model2").checked, false);
    await act(async () => service().click());
    await render(props());
    assert.equal(model("vendor/model10").checked, true);
    assert.equal(model("vendor/model10").disabled, true);
    assert.equal(model("vendor/model2").checked, false);
    assert.deepEqual(availability.codex.disabledModelIds, ["other"]);
    await act(async () => service().click());
    await render(props());
    assert.equal(model("vendor/model2").checked, false);
    assert.equal(model("vendor/model2").disabled, false);
    assert.equal(model("missing/old").checked, false);
    await act(async () => model("missing/old").click());
    assert.deepEqual(availability.opencode.disabledModelIds, ["vendor/model2"]);
  });
});

// @test-value v2
// kind = "contract"
// claim = "非階層ProviderはModel名の自然順と共有検索で直接編集でき、Provider OFF中は保存済みチェックを保持して編集を止める"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md" }
// fault = "Model 10を2より前へ並べる、検索語を無視する、またはProvider無効時にチェックを解除する"
// observable = "検索後のModel label一覧、checkboxのchecked/disabled、Back callback"
// observation_boundary = "component-behavior"
// scope = "ProviderModelSettings 非階層Providerの検索と無効状態"
// lifecycle = "permanent"
// impact = "目的のModelを見つけられないかProvider再有効化時の選択状態を誤認する"
// distinction = "共有検索のpure testとは異なり検索input・候補表示・Provider状態の結線を検証する"
// @end-test-value
test("flat provider models use natural search ordering and retain checks while provider is disabled", async () => {
  await withSettings(async ({ document, window, render }) => {
    let back = 0;
    const props = { provider: provider("codex"), availability: { codex: { disabledServiceIds: [], disabledModelIds: ["vendor/model2"] } }, providerEnabled: false, onChange: () => assert.fail("disabled model changed"), onBack: () => { back += 1; } };
    await render(props);
    const rows = () => [...document.querySelectorAll<HTMLLabelElement>('label[title]')];
    assert.deepEqual(rows().map((label) => label.title), ["vendor/model2", "vendor/model10"]);
    assert.equal(rows()[0].querySelector("input")!.checked, false);
    assert.equal(rows()[1].querySelector("input")!.checked, true);
    assert.ok(rows().every((label) => label.querySelector("input")!.disabled));
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search Models"]')!;
    assert.equal(search.hasAttribute("placeholder"), false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(search, "Model 10");
      search.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.deepEqual(rows().map((label) => label.title), ["vendor/model10"]);
    await act(async () => document.querySelector<HTMLButtonElement>("button")!.click());
    assert.equal(back, 1);
  });
});

// @test-value v2
// kind = "contract"
// claim = "Model候補の背景再取得は取得済み内容・操作中のcheckbox focus・未保存設定を保持し、取得中と失敗を区別する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込空失敗" }
// fault = "再取得でfocus中の行を消去するか、loading/errorでcache候補を空へ置換する"
// observable = "activeElement、保持されたcheckbox、busy status、失敗alertとonChange値"
// observation_boundary = "component-behavior"
// scope = "ProviderModelSettings discovery更新"
// lifecycle = "permanent"
// impact = "候補更新中にkeyboard操作先を失うか編集中のModel設定を消す"
// distinction = "static/buildや検索helperでは扱わない再描画時のnative focusとdraft callbackを検証する"
// @end-test-value
test("background discovery keeps focused rows and drafts while exposing loading and failure", async () => {
  await withSettings(async ({ document, render }) => {
    const changes: ModelAvailabilitySettings[] = [];
    const props = { provider: provider("codex"), availability: {}, providerEnabled: true, onChange: (value: ModelAvailabilitySettings) => changes.push(value), onBack: () => {} };
    await render(props);
    const input = document.querySelector<HTMLInputElement>('label[title="vendor/model2"] input')!;
    await act(async () => input.focus());
    await render({ ...props, provider: { ...props.provider, models: [] }, discovery: { status: "loading" } });
    assert.equal(document.activeElement, input);
    assert.ok(document.querySelector('[aria-label="Loading Codex Models"][aria-busy="true"]'));
    await render({ ...props, provider: { ...props.provider, models: [] }, discovery: { status: "error", error: "Provider unavailable." } });
    assert.equal(document.activeElement, input);
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /Provider unavailable/);
    assert.deepEqual(changes, []);
    await act(async () => input.click());
    assert.deepEqual(changes, [{ codex: { disabledServiceIds: [], disabledModelIds: ["vendor/model2"] } }]);
  });
});
