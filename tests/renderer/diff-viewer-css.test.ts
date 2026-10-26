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

// @test-value v2
// kind = "contract"
// claim = "Snapshot Diffの本文CSSは原文の空白を保つ非折返し表示、1行分の高さ、pane内の横スクロールを宣言する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#diff-window" }
// fault = "本文の折返しまたは空側の高さ縮小で対応行がずれ、横overflowを隠すと長行を読めなくなる"
// observable = "本文cellのwhite-spaceとheight、本文paneのoverflow-x、innerのintrinsic幅と最小幅のCSS宣言"
// observation_boundary = "declaration"
// scope = "Snapshot Diff本文の行高と横overflowのCSS"
// lifecycle = "permanent"
// impact = "長い変更行や追加・削除の空側があっても行単位の比較と原文の閲覧を維持する"
// distinction = "既存のmode切替testとinline高さtestは本文CSSを検査しない。軽量な宣言検査で契約を守り、実寸・同期操作はbrowser描画確認で別途検証する"
// @end-test-value
test("DiffViewer の本文は折り返さず1行高で横スクロールする", async () => {
  const css = await readStylesheet();
  const cellRule = css.match(/\.diff-line-number,\s*\.diff-pane-cell\s*\{(?<body>[^}]+)\}/)?.groups?.body ?? "";
  const bodyRule = css.match(/\.diff-pane-body\s*\{(?<body>[^}]+)\}/)?.groups?.body ?? "";
  const innerRule = css.match(/\.diff-pane-head-inner,\s*\.diff-pane-body-inner\s*\{(?<body>[^}]+)\}/)?.groups?.body ?? "";

  assert.match(cellRule, /white-space:\s*pre;/);
  assert.match(cellRule, /height:\s*calc\(1\.5em\s*\+\s*8px\);/);
  assert.match(bodyRule, /overflow-x:\s*auto;/);
  assert.match(innerRule, /width:\s*max-content;/);
  assert.match(innerRule, /min-width:\s*calc\(100%\s*\+\s*var\(--diff-overflow-width,\s*0px\)\);/);
});
