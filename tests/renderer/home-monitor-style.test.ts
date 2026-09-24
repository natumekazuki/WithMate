import { readStylesheet } from "../support/read-stylesheet.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { HomeMonitorContent } from "../../src/home/HomeMonitorContent.js";

function readCssRule(stylesSource: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return stylesSource.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

function readCssAtRuleBlocks(stylesSource: string, header: string): string[] {
  const blocks: string[] = [];
  let searchStart = 0;
  while (searchStart < stylesSource.length) {
    const start = stylesSource.indexOf(`${header} {`, searchStart);
    if (start === -1) {
      break;
    }
    let depth = 0;
    for (let index = start; index < stylesSource.length; index += 1) {
      if (stylesSource[index] === "{") {
        depth += 1;
      } else if (stylesSource[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          blocks.push(stylesSource.slice(start, index + 1));
          searchStart = index + 1;
          break;
        }
      }
    }
    if (depth !== 0) {
      break;
    }
  }
  return blocks;
}

// @test-value v2
// kind = "contract"
// claim = "Homeと独立MonitorのRunning／Stopped領域は、件数や空状態に依存せず同じ高さの2行を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "片側が空の時にsectionを縮める、見出しを下へずらす、またはloading indicatorで2領域の高さを変える"
// observable = "描画した2 sectionの親子関係、等分rowとsection内配置とloading overlayのCSS"
// observation_boundary = "implementation"
// scope = "HomeMonitorContentとhome.cssのMonitor専用layout"
// lifecycle = "permanent"
// impact = "Session Windowの開閉や片側0件のときにもMonitor領域が跳ねず、両状態を同じ面積で確認できる"
// distinction = "手動の実描画確認とは別に、5:5を破るCSS・DOM構造の変更を自動検出する"
// @end-test-value
test("MonitorのRunning／Stopped領域は空状態と読込状態でも等分する", async () => {
  const stylesSource = await readStylesheet();
  const html = renderToStaticMarkup(createElement(HomeMonitorContent, {
    runningEntries: [],
    nonRunningEntries: [],
    auxiliaryDataState: "loading",
    onOpenSession: () => {},
    onShowContextMenu: () => {},
  }));
  const document = new JSDOM(html).window.document;
  const sections = document.querySelector(".home-monitor-sections");

  assert.deepEqual(
    [...(sections?.children ?? [])].map((section) => section.getAttribute("aria-labelledby")),
    ["home-monitor-running", "home-monitor-inactive"],
  );
  assert.match(readCssRule(stylesSource, ".home-page .home-monitor-sections"), /grid-template-rows:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
  assert.match(readCssRule(stylesSource, ".home-page .home-monitor-sections > .home-monitor-section"), /display:\s*flex;\s*flex-direction:\s*column;/);
  assert.match(readCssRule(stylesSource, ".home-page .home-monitor-body > .home-session-list-load-status"), /position:\s*absolute;/);
  assert.doesNotMatch(stylesSource, /\.home-monitor-section\.is-empty/);
});

// @test-value v2
// kind = "contract"
// claim = "Home Monitorの状態アイコンは実行状態に応じた形を使い、待機と終了は円形で揃え、旧status selectorを残さずreduced motionにも従う"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-monitor-window" }
// fault = "状態を色だけで表現する、終了状態を待機と異なる角形で表現する、状態ruleの確認が別blockへ跨る、旧home-monitor-status selectorを残す、またはreduced motion時も回転を続ける"
// observable = "状態別status icon rule本体、旧selectorの不在、reduced motion時のanimation無効化CSS"
// observation_boundary = "implementation"
// scope = "Home Monitor and shared session status icon CSS"
// lifecycle = "permanent"
// impact = "実行中・失敗・中断・待機・終了・未確定を視認可能な形で区別し、動きが苦手な環境でも静止表示する"
// distinction = "Home Monitor専用iconのclosed形状と、共有status iconの既存形状・旧selector不在・reduced motionをまとめて検証する"
// @end-test-value
test("Home Monitor の status icon は状態ごとの形とmotion制御で styling される", async () => {
  const stylesSource = await readStylesheet();

  assert.match(
    stylesSource,
    /\.home-page \.home-monitor-status-icon\s*{/,
  );
  assert.match(
    stylesSource,
    /\.home-page \.home-session-chip-status,\s*\.home-page \.home-session-status,\s*\.home-page \.session-mode-badge\s*{/,
  );
  assert.doesNotMatch(stylesSource, /\.home-page \.home-monitor-status(?:[.\s,{]|$)/);
  for (const state of ["running", "interrupted", "error", "neutral"]) {
    assert.match(
      stylesSource,
      new RegExp(
        String.raw`\.home-page \.home-session-chip-status\.${state},\s*` +
          String.raw`\.home-page \.home-session-status\.${state}\s*{`,
      ),
    );
  }

  assert.notEqual(readCssRule(stylesSource, ".home-page .home-monitor-status-icon.running"), "");
  assert.notEqual(readCssRule(stylesSource, ".home-page .home-monitor-status-icon.error"), "");
  assert.notEqual(readCssRule(stylesSource, ".home-page .home-monitor-status-icon.interrupted"), "");
  assert.notEqual(readCssRule(stylesSource, ".home-page .home-monitor-status-icon.neutral"), "");
  assert.notEqual(readCssRule(stylesSource, ".home-page .home-monitor-status-icon.closed"), "");
  assert.notEqual(readCssRule(stylesSource, ".home-page .home-monitor-status-icon.loading"), "");
  assert.match(
    readCssRule(stylesSource, ".home-page .home-monitor-status-icon.running .home-monitor-status-icon-mark"),
    /border-top-color: currentColor;/,
  );
  assert.match(
    readCssRule(stylesSource, ".home-page .home-monitor-status-icon.error .home-monitor-status-icon-mark"),
    /clip-path: polygon\(50% 0, 100% 100%, 0 100%\);/,
  );
  assert.match(
    readCssRule(stylesSource, ".home-page .home-monitor-status-icon.interrupted .home-monitor-status-icon-mark"),
    /linear-gradient\(/,
  );
  assert.match(
    readCssRule(stylesSource, ".home-page .home-monitor-status-icon.neutral .home-monitor-status-icon-mark"),
    /border: 1\.5px solid currentColor;/,
  );
  assert.match(
    readCssRule(stylesSource, ".home-page .home-monitor-status-icon.closed .home-monitor-status-icon-mark"),
    /border: 1\.5px solid currentColor;/,
  );
  assert.match(
    readCssRule(stylesSource, ".home-page .home-monitor-status-icon.closed .home-monitor-status-icon-mark"),
    /border-radius: 50%;/,
  );
  assert.match(
    readCssRule(stylesSource, ".home-page .home-monitor-status-icon.loading .home-monitor-status-icon-mark"),
    /border: 1\.5px dashed currentColor;/,
  );
  const reducedMotionBlock = readCssAtRuleBlocks(
    stylesSource,
    "@media (prefers-reduced-motion: reduce)",
  ).find((block) => block.includes(".home-monitor-status-icon.running"));
  assert.ok(reducedMotionBlock);
  for (const state of ["running", "loading"]) {
    assert.match(
      reducedMotionBlock,
      new RegExp(
        String.raw`\.home-monitor-status-icon\.${state} \.home-monitor-status-icon-mark[^{}]*\{[^}]*animation:\s*none;`,
      ),
    );
  }
});

// @test-value v2
// kind = "contract"
// claim = "Home Charactersは検索欄と作成ボタンを固定し、Character一覧だけをpane内でスクロールする"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "monitor body全体をスクロールして検索欄が移動する、または一覧が縮まず下端で切れる"
// observable = "Characters panelとtoolbar/listのDOM構造、およびbody・section・listのoverflowとflex CSS"
// observation_boundary = "implementation"
// scope = "Home Characters panelのスクロール境界"
// lifecycle = "permanent"
// impact = "長いCharacter一覧でも検索と作成へ到達でき、下端の項目も操作できる"
// distinction = "component testと型検査では検出できないscroll ownerのCSS設定を確認する"
// @end-test-value
test("Home Characters は一覧だけをスクロールする", async () => {
  const [componentSource, paneSource, stylesSource] = await Promise.all([
    readFile("src/home/HomeCharactersPanel.tsx", "utf8"),
    readFile("src/home/HomeRightPane.tsx", "utf8"),
    readStylesheet(),
  ]);

  assert.match(componentSource, /<div className="home-monitor-body"[^>]*>/);
  assert.match(componentSource, /className="home-character-toolbar"/);
  assert.match(componentSource, /className="home-character-list"/);
  assert.match(paneSource, /className="home-monitor-panel home-characters-panel"/);
  assert.match(readCssRule(stylesSource, ".home-page .home-monitor-body"), /overflow:\s*hidden;/);
  const sectionRule = readCssRule(stylesSource, ".home-page .home-characters-panel .home-monitor-section");
  assert.match(sectionRule, /flex:\s*1 1 auto;/);
  assert.match(sectionRule, /min-height:\s*0;/);
  const listRule = readCssRule(stylesSource, ".home-page .home-character-list");
  assert.match(listRule, /min-height:\s*0;/);
  assert.match(listRule, /overflow-y:\s*auto;/);
});
