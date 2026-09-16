import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// @test-value v2
// kind = "contract"
// claim = "Session composerは設定fieldを通常幅で横並びに保ち、狭幅では設定群を先に折り返してSend領域を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: composer runtime settings" }
// fault = "設定fieldが一行に収まらず、設定群の折り返し前にSend領域が押し出されるか、狭幅で設定が到達不能になる"
// observable = "src/styles.cssのcomposer settingsとcontainer breakpoint宣言"
// observation_boundary = "declaration"
// scope = "Session composer settings layout"
// lifecycle = "permanent"
// impact = "runtime settingsとSend / Cancel主操作を同じActionDock内で到達可能に保つ"
// distinction = "typecheck/buildはCSSの設定field幅とcontainer breakpointの順序を観測しない"
// @end-test-value
test("Session composer は設定field内を一行にし、通常幅で設定群を保ち、狭幅で折り返す", async () => {
  const stylesSource = await readFile("src/styles.css", "utf8");

  assert.match(
    stylesSource,
    /\.session-action-dock\s*{[\s\S]*?container:\s*session-action-dock\s*\/\s*inline-size;/,
  );
  assert.match(
    stylesSource,
    /\.composer-setting-field\s*{\s*display:\s*flex;\s*align-items:\s*center;\s*gap:\s*8px;\s*flex:\s*1 1 max-content;/,
    "設定fieldはlabelとselectを横並びにし、選択肢の内容幅を基準にする",
  );
  assert.match(
    stylesSource,
    /\.composer-setting-field span\s*{\s*flex:\s*0 0 auto;\s*white-space:\s*nowrap;\s*text-transform:\s*uppercase;/,
    "設定labelは折り返さない",
  );
  assert.match(
    stylesSource,
    /\.composer-setting-field select\s*{\s*flex:\s*1 1 max-content;\s*width:\s*max-content;\s*min-width:\s*0;/,
    "selectは最長の選択肢を基準にし、必要に応じて縮小できる",
  );
  assert.doesNotMatch(
    stylesSource,
    /\.composer-setting-(?:approval|sandbox|model|depth)\s*{\s*flex-basis:/,
    "設定fieldごとの固定幅を残さない",
  );
  assert.match(
    stylesSource,
    /\.composer-control-row > \.session-send-button\s*{\s*align-self:\s*center;/,
    "Send buttonは設定rowの中央に揃える",
  );
  const settingsWrapWidth = Number(
    stylesSource.match(
      /@container session-action-dock \(max-width:\s*(?<width>\d+)px\)\s*{\s*\.composer-settings > \.composer-setting-field\s*{\s*flex-basis:\s*calc\(50% - 7px\);/,
    )?.groups?.width,
  );
  const controlStackWidth = Number(
    stylesSource.match(
      /@container session-action-dock \(max-width:\s*(?<width>\d+)px\)\s*{\s*\.composer-control-row\s*{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);\s*}\s*\.composer-control-row > \.session-send-button\s*{\s*width:\s*100%;/,
    )?.groups?.width,
  );

  assert.ok(Number.isFinite(settingsWrapWidth));
  assert.ok(Number.isFinite(controlStackWidth));
  assert.ok(settingsWrapWidth <= controlStackWidth, "通常幅では設定群を Send より先に折り返さない");
});

// @test-value v2
// kind = "contract"
// claim = "ActionDockのCancel予約領域は通常幅で固定幅を持ち、非実行中は領域を保ったまま不可視になり、狭幅では操作列へ追従する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action Dock" }
// fault = "CSS宣言からCancel slotの固定幅、非実行中の不可視、狭幅overrideのいずれかが欠け、予約領域の幅契約が崩れる"
// observable = "src/styles.cssのCancel slot固定幅・不可視・狭幅上書き宣言"
// observation_boundary = "declaration"
// scope = "ActionDock Cancel slot CSS"
// lifecycle = "permanent"
// impact = "compact / expandedが共有するCancel slotの幅・visibility・狭幅挙動をCSS上で保つ"
// distinction = "component render testはDOM上のslot位置を確認し、typecheck/buildはCSSの固定幅とresponsive overrideを確認しない"
// @end-test-value
test("Session composer の Cancel slot は固定幅と狭幅上書きを持つ", async () => {
  const stylesSource = await readFile("src/styles.css", "utf8");

  assert.match(
    stylesSource,
    /\.composer-control-row > \.session-send-button\s*{[\s\S]*?min-width:\s*86px;/,
    "expandedのSend buttonは最小幅86pxを使う",
  );
  assert.match(
    stylesSource,
    /\.session-action-dock-cancel-slot\s*{\s*flex:\s*0 0 86px;\s*width:\s*86px;\s*min-width:\s*86px;/,
    "ActionDockのCancel領域は固定幅を予約する",
  );
  assert.match(
    stylesSource,
    /\.session-action-dock-cancel-slot > \.session-send-button\s*{\s*width:\s*100%;/,
    "Cancel buttonは予約slotいっぱいに表示する",
  );
  assert.match(
    stylesSource,
    /\.session-action-dock-cancel-slot:not\(\.is-active\)\s*{\s*visibility:\s*hidden;/,
    "非実行中のCancelは領域を保ったまま不可視にする",
  );
  assert.match(
    stylesSource,
    /@media \(max-width:\s*760px\)\s*{(?:(?!@media\b)[\s\S])*?\.session-action-dock-cancel-slot\s*{\s*flex:\s*0 0 auto;\s*width:\s*100%;\s*min-width:\s*0;/,
    "狭幅ではCancel領域を操作列幅へ追従させる",
  );
});
