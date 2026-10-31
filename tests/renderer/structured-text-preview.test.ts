import assert from "node:assert/strict";
import test from "node:test";

import {
  canProjectStructuredText,
  projectStructuredText,
  resolveStructuredTextFormat,
  STRUCTURED_TEXT_PREVIEW_MAX_BYTES,
} from "../../src/file-explorer/structured-text-preview.js";

test("structured text format は対応拡張子だけを大小文字を区別せず分類する", () => {
  assert.equal(resolveStructuredTextFormat("settings.JSON"), "json");
  assert.equal(resolveStructuredTextFormat("config.jsonc"), "jsonc");
  assert.equal(resolveStructuredTextFormat("config.yaml"), "yaml");
  assert.equal(resolveStructuredTextFormat("config.yml"), "yaml");
  assert.equal(resolveStructuredTextFormat("config.ts"), null);
  assert.equal(resolveStructuredTextFormat("table.csv"), null);
});

test("structured text projection は JSON の raw を保持しつつ整形結果とtokenを返す", async () => {
  const raw = "{\"nested\":{\"enabled\":true},\"count\":2}";
  const projection = await projectStructuredText(raw, "json");

  assert.equal(projection.formattedText, [
    "{",
    "  \"nested\": {",
    "    \"enabled\": true",
    "  },",
    "  \"count\": 2",
    "}",
    "",
  ].join("\n"));
  assert.equal(projection.rawTokens.flat().map((token) => token.content).join(""), raw);
  assert.equal(
    projection.formattedTokens.map((line) => line.map((token) => token.content).join("")).join("\n"),
    projection.formattedText,
  );
});

test("structured text projection は JSONC と YAML を同じ境界で整形する", async () => {
  const jsonc = await projectStructuredText("{/* keep */\"enabled\":true}", "jsonc");
  const yaml = await projectStructuredText("root:\n  enabled: true\n", "yaml");

  assert.match(jsonc.formattedText, /\/\* keep \*\//);
  assert.equal(jsonc.rawTokens.flat().map((token) => token.content).join(""), "{/* keep */\"enabled\":true}");
  assert.equal(yaml.formattedText, "root:\n  enabled: true\n");
});

test("structured text projection は不正構文を成功扱いしない", async () => {
  await assert.rejects(() => projectStructuredText("{\"missing\":", "json"));
  await assert.rejects(() => projectStructuredText("root: [", "yaml"));
});

test("structured text projection は256 KiBを上限にする", () => {
  assert.equal(canProjectStructuredText(STRUCTURED_TEXT_PREVIEW_MAX_BYTES), true);
  assert.equal(canProjectStructuredText(STRUCTURED_TEXT_PREVIEW_MAX_BYTES + 1), false);
});
