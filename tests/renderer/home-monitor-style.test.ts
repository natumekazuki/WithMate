import { readStylesheet } from "../support/read-stylesheet.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { HomeMonitorContent } from "../../src/home/HomeMonitorContent.js";
import { HomeRightPane } from "../../src/home/HomeRightPane.js";

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
// claim = "Monitorは3分類の見出しと水平境界を表示し、分類内一覧をscrollし内容幅740pxで独立した縦積みを1列から2列へ切り替える"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "分類境界や見出しを欠落させる、一覧が割当高さ内でscrollできない、またはviewport幅で列数を決める"
// observable = "描画したsectionとseparatorの順序と件数、busy属性、一覧scrollとcontainer queryのCSS"
// observation_boundary = "implementation"
// scope = "HomeMonitorContentとhome.cssのMonitor専用layout"
// lifecycle = "permanent"
// impact = "10〜20親の状態を件数の偏りに応じて連続して確認でき、Homeでも実際のMonitor幅に合う密度を使える"
// distinction = "component描画とCSSのscroll責務・container境界を確認する。境界操作は別component test、実寸法と列の整列はbrowserで確認する"
// @end-test-value
test("Monitorは3分類の境界と分類内scrollと内容幅に応じた列数を宣言する", async () => {
  const stylesSource = await readStylesheet();
  for (const auxiliaryDataState of ["loading", "ready"] as const) {
    const html = renderToStaticMarkup(createElement(HomeMonitorContent, {
      approvalEntries: [],
      runningEntries: [],
      nonRunningEntries: [],
      auxiliaryDataState,
      onOpenSession: () => {},
      onShowContextMenu: () => {},
    }));
    const document = new JSDOM(html).window.document;
    const sections = document.querySelector(".home-monitor-sections");

    assert.deepEqual(
      [...(sections?.children ?? [])].map((section) => section.getAttribute("aria-labelledby") ?? section.getAttribute("role")),
      ["home-monitor-approval", "separator", "home-monitor-running", "separator", "home-monitor-inactive"],
    );
    assert.deepEqual([...document.querySelectorAll(".home-monitor-section-head h3")].map((heading) => heading.textContent), ["Attention", "Running", "Stopped"]);
    assert.deepEqual([...document.querySelectorAll(".home-monitor-count")].map((count) => count.textContent), ["0", "0", "0"]);
    assert.equal(document.querySelector(".home-monitor-body")?.getAttribute("aria-busy"), String(auxiliaryDataState === "loading"));
  }
  assert.match(readCssRule(stylesSource, ".home-page .home-monitor-sections > .home-monitor-section"), /display:\s*flex;\s*flex-direction:\s*column;/);
  const sectionsRule = readCssRule(stylesSource, ".home-page .home-monitor-sections");
  assert.match(sectionsRule, /overflow:\s*hidden;/);
  assert.match(readCssRule(stylesSource, ".home-page .home-monitor-list"), /overflow-y:\s*auto;/);
  assert.match(sectionsRule, /container:\s*monitor-content \/ inline-size;/);
  const columns = readCssAtRuleBlocks(stylesSource, "@container monitor-content (min-width: 740px)")[0];
  assert.ok(columns);
  assert.match(columns, /--home-monitor-columns:\s*2;/);
  assert.match(readCssRule(stylesSource, ".home-page .home-monitor-list-items"), /--home-monitor-columns:\s*1;/);
  assert.match(readCssRule(stylesSource, ".home-page .home-monitor-body > .home-session-list-load-status"), /position:\s*absolute;/);
});

// @test-value v2
// kind = "contract"
// claim = "Home Monitorの承認は静止した感嘆符、他の状態は固有形状で区別し、待機と終了は円形で揃えreduced motionにも従う"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-monitor-window" }
// fault = "承認を回転spinnerや色だけで示す、他の状態の形を失う、旧status selectorを残す、またはreduced motion時も回転を続ける"
// observable = "状態別status icon rule本体、旧selectorの不在、reduced motion時のanimation無効化CSS"
// observation_boundary = "implementation"
// scope = "Home Monitor and shared session status icon CSS"
// lifecycle = "permanent"
// impact = "承認待ちを実行中と混同せず、失敗・中断・待機・終了・未確定も静止形状で区別できる"
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
  const approvalRule = readCssRule(stylesSource, ".home-page .home-monitor-status-icon.approval .home-monitor-status-icon-mark");
  assert.match(approvalRule, /border: 1\.5px solid currentColor;/);
  assert.match(approvalRule, /border-radius: 50%;/);
  assert.match(readCssRule(stylesSource, ".home-page .home-monitor-status-icon.approval .home-monitor-status-icon-mark::before"), /content: "!";/);
  assert.doesNotMatch(approvalRule, /animation:/);
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
// claim = "Home Charactersは検索欄と作成ボタンを一覧の外に描画し、一覧DOMへoverflow-y:auto、bodyへoverflow:hiddenを適用する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "toolbarを一覧のscroll owner内へ移すか、描画DOMにbodyのoverflow:hidden・一覧のoverflow-y:auto・縮小可能なmin-heightを適用しない"
// observable = "HomeRightPaneのCharacters panel内のtoolbar/list親子関係と、JSDOM computed styleのoverflow・min-height・flex"
// observation_boundary = "implementation"
// scope = "Home Characters panelのスクロール境界"
// lifecycle = "permanent"
// impact = "長いCharacter一覧でも検索と作成へ到達でき、下端の項目も操作できる"
// distinction = "source文字列の存在ではなく描画DOMへのselector適用を確認する。実レイアウトのscroll寸法や操作はJSDOMでは測定しない"
// @end-test-value
test("Home Characters は一覧をscroll ownerにするDOMとCSSを適用する", async () => {
  const stylesSource = await readStylesheet();
  const noOp = () => {};
  const html = renderToStaticMarkup(createElement(HomeRightPane, {
    rightPaneView: "characters",
    approvalMonitorEntries: [],
    runningMonitorEntries: [],
    nonRunningMonitorEntries: [],
    auxiliaryDataState: "ready",
    characterEntries: [{
      id: "character-1", name: "Mia", description: "", iconFilePath: "",
      theme: { main: "#3b82f6", sub: "#1d4ed8" }, state: "active",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", archivedAt: null,
    }],
    onCreateCharacter: noOp,
    onEditCharacter: noOp,
    onOpenSession: noOp,
    onShowSessionMonitorContextMenu: noOp,
  }));
  const dom = new JSDOM(`<style>${stylesSource}</style><div class="home-page">${html}</div>`, {
    url: "https://withmate.invalid/",
  });
  const document = dom.window.document;
  const panel = document.querySelector(".home-characters-panel");
  const body = panel?.querySelector(".home-monitor-body");
  const section = body?.querySelector(".home-monitor-section");
  const head = section?.querySelector(".home-monitor-section-head");
  const toolbar = head?.querySelector(".home-character-toolbar");
  const list = section?.querySelector(".home-character-list");
  assert.ok(body && section && head && toolbar && list);
  assert.equal(section.parentElement, body);
  assert.equal(head.parentElement, section);
  assert.equal(list.parentElement, section);
  assert.equal(list.contains(toolbar), false);
  assert.ok(toolbar.querySelector('input[type="search"]'));
  assert.ok(toolbar.querySelector('button[aria-label="Create character"]'));
  assert.equal(list.querySelectorAll(".home-character-card").length, 1);
  assert.equal(dom.window.getComputedStyle(body).overflow, "hidden");
  assert.equal(dom.window.getComputedStyle(list).overflowY, "auto");
  assert.equal(dom.window.getComputedStyle(list).minHeight, "0px");
  assert.equal(dom.window.getComputedStyle(head).flex, "0 0 auto");
  const sectionRule = readCssRule(stylesSource, ".home-page .home-characters-panel .home-monitor-section");
  assert.match(sectionRule, /flex:\s*1 1 auto;/);
  assert.match(sectionRule, /min-height:\s*0;/);
  const listRule = readCssRule(stylesSource, ".home-page .home-character-list");
  assert.match(listRule, /min-height:\s*0;/);
  assert.match(listRule, /overflow-y:\s*auto;/);
  dom.window.close();
});
