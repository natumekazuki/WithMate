import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import BootApp from "../../src/app/BootApp.js";

// @test-value v2
// kind = "contract"
// claim = "Bootは起動中のstageを名前とcurrent stepで示し、起動通知を一つのstatusとして提供する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#boot-window" }
// fault = "起動対象名または現在stageの非視覚的識別を失い、待機状態が判別できなくなる"
// observable = "初期描画のstatus、startup progress一覧、current stepとIn progressの内容"
// observation_boundary = "component-behavior"
// scope = "Boot初期状態の描画とaccessibility"
// lifecycle = "permanent"
// distinction = "型検査では分からないBoot consumerのstageと非視覚的状態の結び付きを確認する"
// @end-test-value
test("BootApp はPascalCaseの起動stageと読み上げstatusを表示する", () => {
  const html = renderToStaticMarkup(React.createElement(BootApp));

  assert.match(html, /<div class="page-shell home-page boot-page">/);
  assert.match(html, /<main class="home-layout home-layout-minimal boot-page-shell">/);
  assert.match(html, /<h1><span role="status" aria-atomic="true">Starting WithMate<\/span><\/h1>/);
  assert.match(html, /<p class="kicker">WithMate<\/p>/);
  assert.match(html, /<ol class="boot-stage-list" aria-label="Startup progress">/);
  assert.match(html, /<li class="active" aria-current="step">.*?PreparingStartup.*?In progress<\/span><\/li>/);
  assert.equal((html.match(/role="status"/g) ?? []).length, 1);
});
