import { readStylesheet } from "../support/read-stylesheet.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// @test-value v2
// kind = "invariant"
// claim = "Workspace validation errorはfieldの固定高を保ち、表示時に後続入力を押し下げない"
// oracle = { type = "contract", ref = "HomeLaunch workspace validation field layout" }
// fault = "validation errorの表示でfield高が変動し、入力欄の位置または内容がずれる"
// observable = "launch-field-errorのheight、line-height、overflow、white-spaceと見出し内error配置"
// observation_boundary = "declaration"
// scope = "home-launch-workspace-validation-error-css"
// lifecycle = "permanent"
// distinction = "validation結果の生成やdebounce動作ではなく、表示状態間で一定となるCSS境界を確認する"
// @end-test-value
test("Workspace validation error は表示有無で field の高さを変えない", async () => {
  const [componentSource, stylesSource] = await Promise.all([
    readFile("src/home/HomeLaunchDialog.tsx", "utf8"),
    readStylesheet(),
  ]);
  const errorRule = stylesSource.match(/\.home-page \.launch-field-error\s*{([^}]*)}/)?.[1];

  assert.match(
    componentSource,
    /<div className="launch-field-heading">[\s\S]*?launch-workspace-path-error[\s\S]*?<\/div>\s*<div className="launch-field-input-shell/,
  );
  assert.ok(errorRule);
  assert.match(errorRule, /height:\s*1rem;/);
  assert.match(errorRule, /line-height:\s*1rem;/);
  assert.match(errorRule, /overflow:\s*hidden;/);
  assert.match(errorRule, /white-space:\s*nowrap;/);
});

// @test-value v2
// kind = "invariant"
// claim = "Workspace validation spinnerはdebounce中も遅延なしで可視表示される"
// oracle = { type = "contract", ref = "HomeLaunch workspace validation feedback" }
// fault = "spinnerがopacity 0またはanimation delayで隠れ、検証中であることを即時に示せない"
// observable = "workspace-validation-spinnerのanimation、opacity、animation-delay CSS宣言"
// observation_boundary = "declaration"
// scope = "home-launch-workspace-validation-spinner-css"
// lifecycle = "permanent"
// distinction = "debounce timerやvalidation serviceの結果ではなく、検証中feedbackの描画遅延をCSS宣言で確認する"
// @end-test-value
test("Workspace validation spinner は debounce 中から遅延なく描画する", async () => {
  const stylesSource = await readStylesheet();
  const spinnerRule = stylesSource.match(/\.workspace-validation-spinner\s*{([^}]*)}/)?.[1];

  assert.ok(spinnerRule);
  assert.match(spinnerRule, /animation:\s*workspace-validation-spin\s+0\.7s\s+linear\s+infinite;/);
  assert.doesNotMatch(spinnerRule, /opacity:\s*0;/);
  assert.doesNotMatch(spinnerRule, /animation-delay:/);
});

// @test-value v2
// kind = "invariant"
// claim = "Session作成画面はCharacter一覧だけを内部スクロールし、周辺操作領域を固定する"
// oracle = { type = "contract", ref = "HomeLaunch character selection layout" }
// fault = "launch panel全体がスクロールする、またはfocus-visibleの選択肢が視認できない"
// observable = "launch panelのgridとoverflow、character listのoverflow、focus-visible outline CSSおよびcomponent class"
// observation_boundary = "declaration"
// scope = "home-launch-character-list-layout-css"
// lifecycle = "permanent"
// distinction = "Character取得や選択状態ではなく、作成画面のscroll containmentとfocus affordanceを確認する"
// @end-test-value
test("Session 作成画面は Character 一覧だけをスクロール領域にする", async () => {
  const [componentSource, stylesSource] = await Promise.all([
    readFile("src/home/HomeLaunchDialog.tsx", "utf8"),
    readStylesheet(),
  ]);
  const panelRule = stylesSource.match(/\.home-launch-dialog \.launch-panel\s*{([^}]*)}/)?.[1];
  const characterListRule = stylesSource.match(
    /\.home-launch-character-section \.launch-character-list\s*{([^}]*)}/,
  )?.[1];
  const characterFocusRule = stylesSource.match(/\.launch-character-option:focus-visible\s*{([^}]*)}/)?.[1];

  assert.match(componentSource, /dialogClassName="home-launch-dialog"/);
  assert.match(componentSource, /className="launch-section minimal home-launch-character-section"/);
  assert.ok(panelRule);
  assert.match(panelRule, /grid-template-rows:\s*auto auto auto minmax\(0, 1fr\);/);
  assert.match(panelRule, /overflow:\s*hidden;/);
  assert.ok(characterListRule);
  assert.match(characterListRule, /overflow-y:\s*auto;/);
  assert.match(characterListRule, /overscroll-behavior:\s*contain;/);
  assert.ok(characterFocusRule);
  assert.match(characterFocusRule, /outline:\s*2px solid/);
  assert.match(characterFocusRule, /outline-offset:\s*-3px;/);
});
