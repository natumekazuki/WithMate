import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { CoordinationPane } from "../../src/coordination/CoordinationPane.js";
import { readStylesheet } from "../support/read-stylesheet.js";

// @test-value v2
// kind = "contract"
// claim = "Coordination右paneの操作はSession共通dark buttonを使い、一覧・詳細はpane上端から配置する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md 一貫性と視認性; docs/design/desktop-ui.md Coordination" }
// fault = "Home向け明色buttonをdark Sessionへ配置してlabelを不可視にする、またはcommand用bottom alignmentで内容を下方へ押し出す"
// observable = "実toolbar buttonの共通class、Session共通buttonの背景/文字色宣言、Coordination stackのmargin-top宣言"
// observation_boundary = "declaration"
// scope = "CoordinationPaneの既存Session表現への接続とstack配置。実寸法・contrastはnative描画で確認する"
// lifecycle = "permanent"
// impact = "回答・再取得・一覧移動の操作名を読めず、短い相談で不要な空白を挟んで操作する状態を防ぐ"
// distinction = "機能DOM testと型検査ではpageごとのCSS cascadeとcommand専用alignmentの流入を検出できない"
// @end-test-value
test("Coordination toolbar uses the Session button surface and starts at the pane top", async () => {
  const html = renderToStaticMarkup(createElement(CoordinationPane, { sessionId: "main", active: true, navigation: null }));
  const document = new JSDOM(html).window.document;
  const refresh = document.querySelector<HTMLButtonElement>(".coordination-toolbar button")!;
  assert.equal(refresh.textContent, "Refresh");
  assert.ok(refresh.classList.contains("drawer-toggle"));
  assert.ok(refresh.classList.contains("compact"));
  assert.ok(refresh.classList.contains("secondary"));
  const css = await readStylesheet();
  assert.match(css, /\.session-page \.drawer-toggle,\s*\.session-page \.browse-button\s*\{[^}]*background:\s*rgba\(255, 255, 255, 0\.06\);[^}]*color:\s*var\(--ink\)/);
  assert.match(css, /\.command-monitor-stack\.coordination\s*\{[^}]*margin-top:\s*0;/);
});
