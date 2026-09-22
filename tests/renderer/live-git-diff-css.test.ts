import { readStylesheet } from "../support/read-stylesheet.js";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

// @test-value v2
// kind = "invariant"
// claim = "live Git DiffのSplit表示は単一のscroll領域と仮想row containerで行を収める"
// oracle = { type = "contract", ref = "live Git Diff split layout CSS" }
// fault = "左右splitが個別scrollまたはrow containerの位置基準を失い、長いdiffの表示範囲が崩れる"
// observable = "session-live-diff-split、scroll、rowsのgrid、overflow、position CSS宣言"
// observation_boundary = "declaration"
// scope = "live-git-diff-split-layout-css"
// lifecycle = "permanent"
// distinction = "diff行の生成やvirtualizer計算ではなく、split表示のscroll ownershipとrow positioningを確認する"
// @end-test-value
test("live Git DiffのSplit表示は単一scroll領域と仮想row containerを持つ", async () => {
  const css = await readStylesheet();
  const splitRule = css.match(/\.session-live-diff-split\s*\{(?<body>[^}]+)\}/)?.groups?.body ?? "";
  const scrollRule = css.match(/\.session-live-diff-split-scroll\s*\{(?<body>[^}]+)\}/)?.groups?.body ?? "";
  const rowsRule = css.match(/\.session-live-diff-split-rows\s*\{(?<body>[^}]+)\}/)?.groups?.body ?? "";

  assert.match(splitRule, /grid-template-rows:\s*auto minmax\(0,\s*1fr\);/);
  assert.match(splitRule, /overflow:\s*hidden;/);
  assert.match(scrollRule, /overflow:\s*auto;/);
  assert.match(rowsRule, /position:\s*relative;/);
});
