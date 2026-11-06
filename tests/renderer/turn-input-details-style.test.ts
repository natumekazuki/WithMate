import assert from "node:assert/strict";
import test from "node:test";
import { readStylesheet } from "../support/read-stylesheet.js";

// @test-value v2
// kind = "contract"
// claim = "入力比較本文は会話と同じ1.6行高で折り返し、比較列は実pane幅に収まる20remを基準に自動配置する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md 一貫性と視認性; docs/design/desktop-ui.md Input Details; src/chat/session.css message本文の1.6行高" }
// fault = "祖先の詰まった行高を比較本文へ継承する、またはWindowが広いだけで狭い会話paneにも2列を強制する"
// observable = "展開後stylesheetの比較pre line-height/折返し、実container基準auto-fit列指定とsection min-width"
// observation_boundary = "declaration"
// scope = "turn-input-details.cssの入力比較本文と列構成。実寸法・通常/狭幅の描画確認はnativeへ分担する"
// lifecycle = "permanent"
// impact = "長い実入力を行間不足や狭い列で読み違え、原文と実行入力の比較が困難になることを防ぐ"
// distinction = "内容と差分のDOM testや型検査では実幅への応答とCSS行高の継承を検出できない"
// @end-test-value
test("Input comparison uses readable lines and container-width-driven columns", async () => {
  const styles = await readStylesheet();
  const comparison = styles.match(/\.turn-input-comparison\s*\{([^}]*)\}/)?.[1] ?? "";
  const text = styles.match(/\.turn-input-comparison pre\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(comparison, /grid-template-columns:\s*repeat\(auto-fit, minmax\(min\(100%, 20rem\), 1fr\)\)/);
  assert.match(styles, /\.turn-input-comparison > section\s*\{[^}]*min-width:\s*0/);
  assert.match(text, /line-height:\s*1\.6/);
  assert.match(text, /white-space:\s*pre-wrap/);
  assert.match(text, /overflow-wrap:\s*anywhere/);
});
