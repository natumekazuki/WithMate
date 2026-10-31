import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import BootApp from "../../src/app/BootApp.js";

// @test-value v2
// kind = "contract"
// claim = "起動待機画面は表示名と詳細なaccessible statusを一つの領域で提供する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window-startup" }
// fault = "待機中の表示名または処理名とbusy状態が欠落し、長い初期化を停止と区別できない"
// observable = "初期描画のstatus内の表示名、非視覚的処理名、領域のaria-busy"
// observation_boundary = "component-behavior"
// scope = "Boot初期状態の描画とaccessibility"
// lifecycle = "permanent"
// distinction = "型検査では分からないBoot consumerのstageと非視覚的状態の結び付きを確認する"
// @end-test-value
test("BootApp は起動中の領域と処理名を支援技術へ伝える", () => {
  const html = renderToStaticMarkup(React.createElement(BootApp));

  assert.match(html, /<section[^>]*aria-busy="true"/);
  assert.match(html, /role="status" aria-atomic="true">.*?Starting WithMate.*?<span class="sr-only">Preparing Startup<\/span>/);
  assert.equal((html.match(/role="status"/g) ?? []).length, 1);
});
