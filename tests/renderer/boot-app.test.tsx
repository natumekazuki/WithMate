import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import BootApp from "../../src/app/BootApp.js";

// @test-value v2
// kind = "contract"
// claim = "Bootは起動中であることと処理名を一つのaccessible statusとして提供する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#boot-window" }
// fault = "spinnerのみの起動画面からbusyと処理名の非視覚的識別を失い、待機状態が判別できなくなる"
// observable = "初期描画のstatus内の処理名と領域のaria-busy"
// observation_boundary = "component-behavior"
// scope = "Boot初期状態の描画とaccessibility"
// lifecycle = "permanent"
// distinction = "型検査では分からないBoot consumerのstageと非視覚的状態の結び付きを確認する"
// @end-test-value
test("BootApp は起動中の領域と処理名を支援技術へ伝える", () => {
  const html = renderToStaticMarkup(React.createElement(BootApp));

  assert.match(html, /<section[^>]*aria-busy="true"/);
  assert.match(html, /role="status" aria-atomic="true">.*?<span class="sr-only">PreparingStartup<\/span>/);
  assert.equal((html.match(/role="status"/g) ?? []).length, 1);
});
