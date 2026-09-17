import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// @test-value v2
// kind = "contract"
// claim = "Session composerの6つの設定field selectorと共通CSSのflex配置・折り返し、設定群がSendのstackより先に発火するbreakpoint宣言が定義されている"
// oracle = { type = "contract", ref = "docs/manual-test-checklist.md: MT-023C; docs/design/desktop-ui.md: Action Dock" }
// fault = "6つの設定field selector、共通CSSのflex配置・折り返し、または設定群のbreakpoint宣言が欠ける、個別fieldへwidth・min-width・flex-basisの固定指定が入る、もしくは設定群のbreakpointがSendのstackより後になる"
// observable = "src/session-components.tsxの6設定field selectorとsrc/styles.cssの設定field宣言・container breakpoint宣言"
// observation_boundary = "declaration"
// scope = "Session composer settings layout"
// lifecycle = "permanent"
// impact = "Session composerの設定fieldとSend / Cancel主操作に必要なresponsive CSS契約を維持する"
// distinction = "このtestはsource declarationとselector構成を確認し、typecheck/buildや実画面確認では得られないCSS契約を補う"
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
  const settingFieldNames = ["approval", "reviewer", "sandbox", "model", "depth", "speed"] as const;
  const sessionComponentsSource = await readFile("src/session-components.tsx", "utf8");
  for (const fieldName of settingFieldNames) {
    assert.match(
      sessionComponentsSource,
      new RegExp(`className=\\"composer-setting-field composer-setting-${fieldName}\\"`),
      `${fieldName}設定field selectorをproduction実装で確認する`,
    );
  }
  const settingFieldRule = stylesSource.match(
    /(?:^|\n)\s*\.composer-setting-field\s*{(?<body>[^}]*)}/,
  )?.groups?.body;
  assert.ok(settingFieldRule, "共通設定field ruleを取得できる");
  assert.doesNotMatch(settingFieldRule, /(?:^|[;\n])\s*(?:width|flex-basis)\s*:/, "共通設定fieldへ固定widthやflex-basisを付けない");
  assert.match(settingFieldRule, /min-width:\s*0;/, "共通設定fieldは縮小可能なmin-widthを持つ");
  const settingFieldClassPattern = settingFieldNames.join("|");
  assert.doesNotMatch(
    stylesSource,
    new RegExp(
      `[^{}]*\\.composer-setting-(?:${settingFieldClassPattern})(?=[\\s,.:>#]|$)[^{}]*\\{[^{}]*(?:\\bwidth|\\bmin-width|\\bflex-basis)\\s*:`,
    ),
    "6つの設定field selectorへ固定width・min-width・flex-basisを残さない",
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
// claim = "Session composerのexpanded SendとActionDock Cancel予約領域に、通常幅の固定幅・非active時の不可視・狭幅時の操作列追従に必要なCSS宣言が定義されている"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action Dock" }
// fault = "expandedのSend最小幅、Cancel slotの固定幅・非実行中の不可視・狭幅overrideのいずれかが欠け、ActionDockの主操作領域が崩れる"
// observable = "src/styles.cssのexpanded Send最小幅、Cancel slot固定幅・不可視・狭幅上書き宣言"
// observation_boundary = "declaration"
// scope = "Session composer action controls CSS"
// lifecycle = "permanent"
// impact = "compact / expandedのSendとCancelの主操作領域に必要なCSS契約を、通常幅と狭幅のActionDockで維持する"
// distinction = "component render testはDOM上のslot位置と状態を確認し、このtestはsource declarationの幅とresponsive overrideを確認する"
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
