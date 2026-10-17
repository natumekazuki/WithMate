import { readStylesheet } from "../support/read-stylesheet.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


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
