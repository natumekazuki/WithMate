import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// @test-value v1
// kind = "contract"
// claim = "Session composer設定は通常幅で一行を保ち狭幅ではcontrol単位で折り返す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md" }
// failure_mode = "設定labelとcontrolが分断されるか狭幅でcomposer外へはみ出す"
// scope = "Session composer responsive layout CSS"
// lifecycle = "permanent"
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
