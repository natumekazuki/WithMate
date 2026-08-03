import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

test("live Git DiffのSplit表示は単一scroll領域と仮想row containerを持つ", async () => {
  const css = await readFile(new URL("../../src/styles.css", import.meta.url), "utf8");
  const splitRule = css.match(/\.session-live-diff-split\s*\{(?<body>[^}]+)\}/)?.groups?.body ?? "";
  const scrollRule = css.match(/\.session-live-diff-split-scroll\s*\{(?<body>[^}]+)\}/)?.groups?.body ?? "";
  const rowsRule = css.match(/\.session-live-diff-split-rows\s*\{(?<body>[^}]+)\}/)?.groups?.body ?? "";

  assert.match(splitRule, /grid-template-rows:\s*auto minmax\(0,\s*1fr\);/);
  assert.match(splitRule, /overflow:\s*hidden;/);
  assert.match(scrollRule, /overflow:\s*auto;/);
  assert.match(rowsRule, /position:\s*relative;/);
});
