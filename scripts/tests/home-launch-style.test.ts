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
