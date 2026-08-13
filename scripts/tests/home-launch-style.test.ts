import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Workspace validation error は表示有無で field の高さを変えない", async () => {
  const [componentSource, stylesSource] = await Promise.all([
    readFile("src/home/HomeLaunchDialog.tsx", "utf8"),
    readFile("src/styles.css", "utf8"),
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

test("Workspace validation spinner は debounce 中から遅延なく描画する", async () => {
  const stylesSource = await readFile("src/styles.css", "utf8");
  const spinnerRule = stylesSource.match(/\.workspace-validation-spinner\s*{([^}]*)}/)?.[1];

  assert.ok(spinnerRule);
  assert.match(spinnerRule, /animation:\s*workspace-validation-spin\s+0\.7s\s+linear\s+infinite;/);
  assert.doesNotMatch(spinnerRule, /opacity:\s*0;/);
  assert.doesNotMatch(spinnerRule, /animation-delay:/);
});

test("Session 作成画面は Character 一覧だけをスクロール領域にする", async () => {
  const [componentSource, stylesSource] = await Promise.all([
    readFile("src/home/HomeLaunchDialog.tsx", "utf8"),
    readFile("src/styles.css", "utf8"),
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
