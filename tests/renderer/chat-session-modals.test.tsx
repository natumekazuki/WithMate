import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { AuxiliaryLaunchProviderDialog } from "../../src/chat/AuxiliaryLaunchProviderDialog.js";

// @test-value v2
// kind = "contract"
// claim = "Auxiliaryを背景のtriggerから開くと、provider取得中・失敗・0件でもfocusをdialog内に移し、利用可能な開始・取消を優先してTabを内部に保ちEscape後はtriggerへ戻す"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#操作とアクセシビリティ" }
// fault = "初期focus先のStartがdisabledな時に背景へfocusを残すか、通常のStart優先・取消への到達・閉じた後の復帰を壊す"
// observable = "実dialogのactiveElement、両方向TabのdefaultPreventedと移動先、Escape後のdialog不在とtrigger focus"
// observation_boundary = "component-behavior"
// scope = "Auxiliary dialogのempty/loading/error/ready/作成中からの初期表示とkeyboard操作"
// lifecycle = "permanent"
// impact = "keyboard利用者がprovider未準備時にもdialogを閉じ、作成待ちでは取消へ到達できる"
// distinction = "静的markup検査や作成開始後のfocus testでは検出できない、背景triggerから開くeffectとfocus復帰を少数のDOM条件で保持する"
// @end-test-value
test("Auxiliary dialog focuses inside on open and restores its trigger across provider states", async (t) => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/" });
  const properties = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = Object.keys(properties).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(properties)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const document = dom.window.document;
  const root = createRoot(document.getElementById("root")!);
  t.after(async () => {
    await act(async () => root.unmount());
    t.mock.timers.reset();
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  for (const scenario of ["empty", "loading", "error", "ready", "preparing"] as const) {
    function Harness() {
      const [open, setOpen] = React.useState(false);
      return <>
        <button onClick={() => setOpen(true)}>Add Auxiliary</button>
        <AuxiliaryLaunchProviderDialog
          open={open}
          providers={scenario === "empty" ? [] : [{ id: "codex", label: "Codex" }]}
          selectedProviderId={scenario === "empty" ? null : "codex"}
          providerLoadStatus={scenario === "loading" || scenario === "error" ? scenario : "loaded"}
          feedback=""
          starting={scenario === "preparing"}
          canCancelCreation={scenario === "preparing"}
          onCancelCreation={() => {}}
          onClose={() => setOpen(false)}
          onSelectProvider={() => {}}
          onStart={() => {}}
        />
      </>;
    }
    await act(async () => root.render(<Harness />));
    const trigger = document.querySelector<HTMLButtonElement>("button")!;
    trigger.focus();
    await act(async () => trigger.click());
    await act(async () => { t.mock.timers.tick(0); });

    const dialog = document.querySelector<HTMLElement>(".auxiliary-launch-dialog")!;
    const expectedFocus = scenario === "ready"
      ? dialog.querySelector(".start-session-button")
      : scenario === "preparing" ? dialog.querySelector(".launch-cancel-button") : dialog;
    assert.ok(document.activeElement === expectedFocus, `${scenario}: initial focus stays inside`);
    for (const shiftKey of [false, true]) {
      const event = new dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
      await act(async () => { document.activeElement!.dispatchEvent(event); });
      assert.equal(event.defaultPrevented, true, `${scenario}: Tab is trapped`);
      const expectedTabFocus = scenario === "ready" && !shiftKey ? dialog.querySelector("[role=option]") : expectedFocus;
      assert.ok(document.activeElement === expectedTabFocus, `${scenario}: Tab stays on an available dialog target`);
    }

    await act(async () => { document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    assert.equal(document.querySelector("[role=dialog]"), null, `${scenario}: Escape closes the dialog`);
    assert.ok(document.activeElement === trigger, `${scenario}: closing restores the trigger`);
  }
});



// @test-value v2
// kind = "contract"
// claim = "Auxiliary起動dialogは利用可能なcoding providerと起動操作を表示し、dialogのaccessible nameを提供する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#auxiliary-session-issue-710" }
// fault = "起動可能なprovider・起動操作・dialogのaccessible nameのいずれかが表示結果から欠落する"
// observable = "dialog role/aria-label、Coding Providerの項目名、Codex/Copilot候補、Start Auxiliary操作"
// observation_boundary = "component-behavior"
// scope = "auxiliary-launch-dialog"
// lifecycle = "permanent"
// @end-test-value
test("AuxiliaryLaunchProviderDialog は Provider だけを選択対象として描画する", () => {
  const html = renderToStaticMarkup(
    <AuxiliaryLaunchProviderDialog
      open={true}
      providers={[
        { id: "codex", label: "Codex" },
        { id: "copilot", label: "Copilot" },
      ]}
      selectedProviderId="copilot"
      feedback=""
      starting={false}
      onClose={() => {}}
      onSelectProvider={() => {}}
      onStart={() => {}}
    />,
  );

  assert.match(html, /<div class="launch-modal" role="dialog" aria-modal="true" aria-label="Start Auxiliary">/);
  assert.match(html, /Coding Provider/);
  assert.match(html, /Codex/);
  assert.match(html, /Copilot/);
  assert.match(html, /Start Auxiliary/);
  assert.doesNotMatch(html, /Reasoning/);
  assert.doesNotMatch(html, /Sandbox/);
});

// @test-value v2
// kind = "regression"
// claim = "Auxiliary起動dialogはprovider catalogのloading/errorを空一覧へ誤変換せず、ready後は有効な先頭候補を選択可能にする"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#auxiliary-session-issue-710" }
// fault = "ロード中・失敗時に通常の空一覧または古いfeedbackを表示するか、ready後のprovider全件がtabIndex -1になって開始できない"
// observable = "loading status、error alert、開始buttonのdisabled、ready-emptyの単一empty説明、ready後の先頭providerのaria-selected/tabIndex"
// observation_boundary = "component-behavior"
// scope = "auxiliary-launch-provider-load-state"
// lifecycle = "permanent"
// impact = "provider catalogの非同期状態を正しく通知し、選択可能なproviderだけを起動対象にする"
// distinction = "ready空一覧だけでなくloading/error/ready遷移とprovider選択の契約を同一dialogで検証する"
// @end-test-value
test("AuxiliaryLaunchProviderDialog は provider catalog の loading/error と ready 選択を区別する", () => {
  const renderDialog = (overrides: Partial<React.ComponentProps<typeof AuxiliaryLaunchProviderDialog>>) =>
    renderToStaticMarkup(
      <AuxiliaryLaunchProviderDialog
        open={true}
        providers={[]}
        selectedProviderId={null}
        feedback="No enabled coding providers."
        starting={false}
        onClose={() => {}}
        onSelectProvider={() => {}}
        onStart={() => {}}
        {...overrides}
      />,
    );

  const loadingHtml = renderDialog({ providerLoadStatus: "loading" });
  assert.match(loadingHtml, /aria-busy="true"/);
  assert.match(loadingHtml, /class="start-session-button"[^>]*disabled/);
  assert.doesNotMatch(loadingHtml, /No enabled coding providers\./);

  const errorHtml = renderDialog({
    providerLoadStatus: "error",
    providerLoadError: "Catalog unavailable.",
  });
  assert.match(errorHtml, /role="alert"[^>]*>Catalog unavailable\.<\/p>/);
  assert.match(errorHtml, /class="start-session-button"[^>]*disabled/);
  assert.doesNotMatch(errorHtml, /No enabled coding providers\./);

  const readyZeroHtml = renderDialog({ providerLoadStatus: "loaded" });
  assert.equal((readyZeroHtml.match(/No enabled coding providers\./g) ?? []).length, 1);
  assert.match(readyZeroHtml, /class="launch-feedback" role="status"><\/p>/);

  const readyHtml = renderDialog({
    providers: [{ id: "codex", label: "Codex" }],
    providerLoadStatus: "loaded",
  });
  assert.match(readyHtml, /aria-selected="true"[^>]*tabindex="0"/);
  assert.match(readyHtml, /class="start-session-button"[^>]*aria-disabled="false"/);
  assert.doesNotMatch(readyHtml, /launch-feedback[^>]*>No enabled coding providers\./);
});
