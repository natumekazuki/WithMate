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
  assert.match(
    stylesSource,
    /\.composer-settings\s*{\s*display:\s*flex;\s*flex-wrap:\s*wrap;/,
    "設定群は折り返し可能にする",
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
  assert.ok(settingsWrapWidth > controlStackWidth, "設定群の折り返しはSendのstackより先に発火する");
});

// @test-value v2
// kind = "contract"
// claim = "Session composerのSend領域とActionDockのCancel予約領域は、通常幅で必要な幅を確保し、狭幅では指定した折り返しと操作列追従を行う"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action Dock" }
// fault = "expandedのSend最小幅、Cancel slotの固定幅・非実行中の不可視・狭幅overrideのいずれかが欠け、ActionDockの主操作領域が崩れる"
// observable = "src/styles.cssのexpanded Send最小幅、Cancel slot固定幅・不可視・狭幅上書き宣言"
// observation_boundary = "declaration"
// scope = "Session composer action controls CSS"
// lifecycle = "permanent"
// impact = "compact / expandedのSendとCancelの主操作領域を、通常幅と狭幅のActionDockで到達可能に保つ"
// distinction = "component render testはDOM上のslot位置と状態を確認し、typecheck/buildはCSSの幅とresponsive overrideを確認しない"
// @end-test-value
test("Session composer の Cancel slot は固定幅と狭幅上書きを持つ", async () => {
  const stylesSource = await readFile("src/styles.css", "utf8");

  assert.match(
    stylesSource,
    /\.composer-control-row > \.session-send-button\s*{[\s\S]*?min-width:\s*86px;/,
    "expandedのSend buttonは最小幅86pxを使う",
  );
  const cancelSlotRule = stylesSource.match(
    /\.session-action-dock-cancel-slot\s*{(?<body>[^}]*)}/,
  )?.groups?.body;
  assert.ok(cancelSlotRule, "Cancel slotの通常幅ruleを取得できる");
  assert.match(cancelSlotRule, /flex:\s*0 0 86px;/, "Cancel領域は固定flex幅を予約する");
  assert.match(cancelSlotRule, /width:\s*86px;/, "Cancel領域は固定widthを予約する");
  assert.match(cancelSlotRule, /min-width:\s*86px;/, "Cancel領域は最小幅を固定する");

  const cancelButtonRule = stylesSource.match(
    /\.session-action-dock-cancel-slot > \.session-send-button\s*{(?<body>[^}]*)}/,
  )?.groups?.body;
  assert.ok(cancelButtonRule, "Cancel buttonのslot内ruleを取得できる");
  assert.match(cancelButtonRule, /width:\s*100%;/, "Cancel buttonは予約slotいっぱいに表示する");

  const idleCancelSlotRule = stylesSource.match(
    /\.session-action-dock-cancel-slot:not\(\.is-active\)\s*{(?<body>[^}]*)}/,
  )?.groups?.body;
  assert.ok(idleCancelSlotRule, "非実行中Cancel slotのruleを取得できる");
  assert.match(idleCancelSlotRule, /visibility:\s*hidden;/, "非実行中のCancelは領域を保ったまま不可視にする");

  const narrowCancelSlotRule = stylesSource.match(
    /@media \(max-width:\s*760px\)\s*{(?:(?!@media\b)[\s\S])*?\.session-action-dock-cancel-slot\s*{(?<body>[^}]*)}/,
  )?.groups?.body;
  assert.ok(narrowCancelSlotRule, "狭幅Cancel slotのoverride ruleを取得できる");
  assert.match(narrowCancelSlotRule, /flex:\s*0 0 auto;/, "狭幅ではCancel領域を内容幅に戻す");
  assert.match(narrowCancelSlotRule, /width:\s*100%;/, "狭幅ではCancel領域を操作列幅へ追従させる");
  assert.match(narrowCancelSlotRule, /min-width:\s*0;/, "狭幅ではCancel領域の固定最小幅を解除する");
});
