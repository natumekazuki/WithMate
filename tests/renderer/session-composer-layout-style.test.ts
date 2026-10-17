import { readStylesheet } from "../support/read-stylesheet.js";
import assert from "node:assert/strict";
import test from "node:test";

// @test-value v2
// kind = "contract"
// claim = "設定群は折り返せるがSendは独立した列で40pxの操作領域を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action Dock; docs/manual-test-checklist.md: MT-023C" }
// fault = "設定群のwrapを外すかSendの列と操作寸法を変更し、狭幅やbusy時に送信位置が変わる"
// observable = "合成stylesheetの設定群wrap・独立Send列・40px寸法宣言"
// observation_boundary = "declaration"
// scope = "Session composer settings and Send layout"
// lifecycle = "permanent"
// impact = "狭いActionDockでも送信操作を一定の位置と大きさで扱える"
// distinction = "DOMでは計測できないレイアウト指定を確認し、実描画での収容確認とは区別する"
// @end-test-value
test("Session composer は設定群だけを折り返しSendの40px領域を保つ", async () => {
  const css = await readStylesheet();
  assert.match(css, /\.composer-settings\s*{[^}]*flex-wrap:\s*wrap;/);
  assert.match(css, /\.composer-control-row\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto;/);
  const send = css.match(/\.composer-control-row > \.session-send-button\s*{([^}]*)}/)?.[1];
  assert.ok(send);
  assert.match(send, /(?:^|;)\s*width:\s*40px;/);
  assert.match(send, /(?:^|;)\s*min-width:\s*40px;/);
  assert.match(send, /(?:^|;)\s*height:\s*40px;/);
});

// @test-value v2
// kind = "contract"
// claim = "Cancelの40px領域は非実行中も不可視のまま予約される"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action Dock" }
// fault = "Cancel予約幅を解除またはdisplay:noneへ変えて実行状態に応じて隣の操作が移動する"
// observable = "合成stylesheetのCancel slotの固定flex幅・最小幅・visibilityと、layout boxを消すdisplay宣言の不在"
// observation_boundary = "declaration"
// scope = "Session composer Cancel slot"
// lifecycle = "permanent"
// impact = "実行開始・取消中でも対象切替など隣接操作の位置を安定させる"
// distinction = "component testのslot存続に加え、レイアウト領域を維持するCSS宣言を確認する"
// @end-test-value
test("Session composer の Cancel slot は40pxの不可視領域を予約する", async () => {
  const css = await readStylesheet();
  const slot = css.match(/\.session-action-dock-cancel-slot\s*{([^}]*)}/)?.[1];
  assert.ok(slot);
  assert.match(slot, /(?:^|;)\s*flex:\s*0 0 40px;/);
  assert.match(slot, /(?:^|;)\s*min-width:\s*40px;/);
  const inactive = css.match(/\.session-action-dock-cancel-slot:not\(\.is-active\)\s*{([^}]*)}/)?.[1];
  assert.ok(inactive);
  assert.match(inactive, /(?:^|;)\s*visibility:\s*hidden;/);
  for (const [, declarations] of css.matchAll(/\.session-action-dock-cancel-slot(?::not\(\.is-active\))?\s*{([^}]*)}/g)) {
    assert.doesNotMatch(declarations, /(?:^|;)\s*display:\s*(?:none|contents)\b/);
  }
});
