import { readStylesheet } from "../support/read-stylesheet.js";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

// @test-value v2
// kind = "invariant"
// claim = "DiffViewerのinline本文は親の高さを超えず内部スクロール領域として表示される"
// oracle = { type = "contract", ref = "DiffViewer inline view layout CSS" }
// fault = "inline本文が親の高さ制約またはoverflow制御を失い、差分表示が外側へ押し出される"
// observable = "diff-inline-viewのgrid、行track、height、overflowのCSS宣言"
// observation_boundary = "declaration"
// scope = "diff-viewer-inline-layout-css"
// lifecycle = "permanent"
// distinction = "DOMの差分内容や実機スクロール操作ではなく、本文領域のCSS containment契約を確認する"
// @end-test-value
test("DiffViewer の inline view は本文を高さ制約付きスクロール領域にする", async () => {
  const css = await readStylesheet();
  const inlineViewRule = css.match(/\.diff-inline-view\s*\{(?<body>[^}]+)\}/)?.groups?.body ?? "";

  assert.match(inlineViewRule, /display:\s*grid;/);
  assert.match(inlineViewRule, /grid-template-rows:\s*minmax\(0,\s*1fr\);/);
  assert.match(inlineViewRule, /height:\s*100%;/);
  assert.match(inlineViewRule, /overflow:\s*hidden;/);
});
