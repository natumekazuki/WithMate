import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

test("DiffViewer の inline view は本文を高さ制約付きスクロール領域にする", async () => {
  const css = await readFile(new URL("../../src/styles.css", import.meta.url), "utf8");
  const inlineViewRule = css.match(/\.diff-inline-view\s*\{(?<body>[^}]+)\}/)?.groups?.body ?? "";

  assert.match(inlineViewRule, /display:\s*grid;/);
  assert.match(inlineViewRule, /grid-template-rows:\s*minmax\(0,\s*1fr\);/);
  assert.match(inlineViewRule, /height:\s*100%;/);
  assert.match(inlineViewRule, /overflow:\s*hidden;/);
});
