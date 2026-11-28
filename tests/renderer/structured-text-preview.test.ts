import assert from "node:assert/strict";
import test from "node:test";

import {
  canProjectStructuredText,
  projectStructuredText,
  resolveStructuredTextFormat,
  STRUCTURED_TEXT_PREVIEW_MAX_BYTES,
} from "../../src/file-explorer/structured-text-preview.js";

/** 対応する JSON・JSONC・YAML を拡張子で分類し、大文字表記は許容するが他の構造形式までは受理しない。 */
test("structured text format は対応拡張子だけを大小文字を区別せず分類する", () => {
  assert.equal(resolveStructuredTextFormat("settings.JSON"), "json");
  assert.equal(resolveStructuredTextFormat("config.jsonc"), "jsonc");
  assert.equal(resolveStructuredTextFormat("config.yaml"), "yaml");
  assert.equal(resolveStructuredTextFormat("config.yml"), "yaml");
  assert.equal(resolveStructuredTextFormat("config.ts"), null);
  assert.equal(resolveStructuredTextFormat("table.csv"), null);
});

/** JSON の元テキストを復元できるトークンと、整形後のインデント・改行を復元できるトークンを別々に返す。 */
test("structured text projection は JSON の raw を保持しつつ整形結果とtokenを返す", async () => {
  const raw = '{"nested":{"enabled":true},"count":2}';
  const projection = await projectStructuredText(raw, "json");

  assert.equal(
    projection.formattedText,
    [
      "{",
      '  "nested": {',
      '    "enabled": true',
      "  },",
      '  "count": 2',
      "}",
      "",
    ].join("\n"),
  );
  assert.equal(
    projection.rawTokens
      .flat()
      .map((token) => token.content)
      .join(""),
    raw,
  );
  assert.equal(
    projection.formattedTokens
      .map((line) => line.map((token) => token.content).join(""))
      .join("\n"),
    projection.formattedText,
  );
});

/** 同じ整形入口で JSONC のコメントや元トークンを保持し、YAML も整形済みの本文を返す。 */
test("structured text projection は JSONC と YAML を同じ境界で整形する", async () => {
  const jsonc = await projectStructuredText(
    '{/* keep */"enabled":true}',
    "jsonc",
  );
  const yaml = await projectStructuredText("root:\n  enabled: true\n", "yaml");

  assert.match(jsonc.formattedText, /\/\* keep \*\//);
  assert.equal(
    jsonc.rawTokens
      .flat()
      .map((token) => token.content)
      .join(""),
    '{/* keep */"enabled":true}',
  );
  assert.equal(yaml.formattedText, "root:\n  enabled: true\n");
});

/** 解析できない JSON と YAML を、空の整形結果や成功で代用せず拒否する。 */
test("structured text projection は不正構文を成功扱いしない", async () => {
  await assert.rejects(() => projectStructuredText('{"missing":', "json"));
  await assert.rejects(() => projectStructuredText("root: [", "yaml"));
});

/** 256 KiB ちょうどまでは整形対象とし、1バイトでも増えると対象から外す。 */
test("structured text projection は256 KiBを上限にする", () => {
  assert.equal(
    canProjectStructuredText(STRUCTURED_TEXT_PREVIEW_MAX_BYTES),
    true,
  );
  assert.equal(
    canProjectStructuredText(STRUCTURED_TEXT_PREVIEW_MAX_BYTES + 1),
    false,
  );
});
