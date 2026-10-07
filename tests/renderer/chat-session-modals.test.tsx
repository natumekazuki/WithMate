import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AuxiliaryLaunchProviderDialog } from "../../src/chat/AuxiliaryLaunchProviderDialog.js";



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
  assert.doesNotMatch(readyZeroHtml, /class="launch-feedback"/);

  const readyHtml = renderDialog({
    providers: [{ id: "codex", label: "Codex" }],
    providerLoadStatus: "loaded",
  });
  assert.match(readyHtml, /aria-selected="true"[^>]*tabindex="0"/);
  assert.match(readyHtml, /class="start-session-button"[^>]*aria-disabled="false"/);
  assert.doesNotMatch(readyHtml, /launch-feedback[^>]*>No enabled coding providers\./);
});
