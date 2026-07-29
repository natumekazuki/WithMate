import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Session composer は Action Dock 実幅で Send を設定群の下へ移す", async () => {
  const stylesSource = await readFile("src/styles.css", "utf8");

  assert.match(
    stylesSource,
    /\.session-action-dock\s*{[\s\S]*?container:\s*session-action-dock\s*\/\s*inline-size;/,
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
  assert.ok(settingsWrapWidth > controlStackWidth, "設定群を先に折り返してから Send を次段へ移す");
});
