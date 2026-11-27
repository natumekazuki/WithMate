import { readStylesheet } from "../support/read-stylesheet.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { HomeMonitorContent } from "../../src/home/HomeMonitorContent.js";
import { HomeRightPane } from "../../src/home/HomeRightPane.js";

function readCssRules(stylesSource: string, selector: string): string[] {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Array.from(stylesSource.matchAll(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "g")), (match) => match[1]!);
}

function readCssRule(stylesSource: string, selector: string): string {
  return readCssRules(stylesSource, selector)[0] ?? "";
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
// claim = "Monitorは上段のAttention・Coordinationを左右に、Running・Stoppedを下段に配置し、4分類の件数枠を保つ。SSRで未取得のCoordinationには件数を提示せず、一覧scrollと内容幅740pxでの列数切替をCSSへ宣言する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window; docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "分類境界・見出し・件数枠を欠落させる、未取得の相談件数を0で提示する、一覧が割当高さ内でscrollできない、またはviewport幅で列数を決める"
// observable = "SSRのsection・separator・4分類それぞれの件数枠、準備済みの空分類の0と未取得Coordinationの空・aria-labelなし、一覧scrollとcontainer queryのCSS"
// observation_boundary = "implementation"
// scope = "HomeMonitorContentとMonitor専用layout CSS"
// lifecycle = "permanent"
// impact = "10〜20親の状態を件数の偏りに応じて連続して確認でき、Homeでも実際のMonitor幅に合う密度を使える"
// distinction = "初回SSRの件数枠とCSS宣言を確認する。確定0・失敗・境界操作は動的component test、実寸法と列の整列はbrowserで確認する"
// @end-test-value
test("Monitorは上段左右分割と分類内scrollと内容幅に応じた列数を宣言する", async () => {
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
      [null, "separator", "home-monitor-running", "separator", "home-monitor-inactive"],
    );
    const topRow = sections?.querySelector(".home-monitor-top-row");
    assert.ok(topRow);
    assert.deepEqual([...topRow.children].map((section) => section.getAttribute("aria-labelledby") ?? section.getAttribute("role")),
      ["home-monitor-approval", null, "home-monitor-coordination"]);
    assert.ok(topRow.querySelector(".home-monitor-top-divider"));
    assert.deepEqual([...document.querySelectorAll(".home-monitor-section-head h3")].map((heading) => heading.textContent), ["Attention", "Coordination", "Running", "Stopped"]);
    const headings = [...document.querySelectorAll(".home-monitor-section-head")];
    assert.equal(headings.length, 4);
    const [attention, coordination, running, stopped] = headings.map((heading) => {
      const slots = heading.querySelectorAll(".home-monitor-count");
      assert.equal(slots.length, 1);
      return slots[0]!;
    });
    assert.deepEqual([attention, running, stopped].map((count) => count?.textContent), ["0", "0", "0"]);
    assert.ok(coordination);
    assert.equal(coordination.textContent?.trim(), "");
    assert.equal(coordination.hasAttribute("aria-label"), false);
  }
  const sectionRule = readCssRule(stylesSource, ".home-page .home-monitor-sections .home-monitor-section");
  assert.match(sectionRule, /display:\s*flex;\s*flex-direction:\s*column;/);
  const sectionsRule = readCssRule(stylesSource, ".home-page .home-monitor-sections");
  assert.match(sectionsRule, /overflow:\s*hidden;/);
  assert.match(readCssRule(stylesSource, ".home-page .home-monitor-list"), /overflow-y:\s*auto;/);
  assert.match(sectionRule, /container:\s*monitor-section \/ inline-size;/);
  const columns = readCssAtRuleBlocks(stylesSource, "@container monitor-section (min-width: 740px)")[0];
  assert.ok(columns);
  assert.match(readCssRule(columns, ".home-page .home-monitor-list-items"), /--home-monitor-columns:\s*2;/);
  assert.match(readCssRule(stylesSource, ".home-page .home-monitor-list-items"), /--home-monitor-columns:\s*1;/);
  assert.match(readCssRule(stylesSource, ".home-page .home-monitor-body > .home-session-list-load-status"), /position:\s*absolute;/);
});

// @test-value v2
// kind = "contract"
// claim = "Homeと独立Monitorで共有する実行中マークは静止した右向き三角で、待機・終了の中空円や承認の丸囲み感嘆符と形状で区別する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-monitor-window" }
// fault = "実行中マークを回すか中空円にする、または承認の丸囲み感嘆符・失敗の警告三角・待機と終了の中空円のCSS宣言を失う"
// observable = "状態別status iconのCSS宣言から実行中の三角の向きとアニメーション有効化の不在、他状態の形状を確認する"
// observation_boundary = "implementation"
// scope = "Home Monitor and shared session status icon CSS"
// lifecycle = "permanent"
// impact = "動きや色に頼らず、実行中を承認待ち・失敗・待機・終了から見分けられる"
// distinction = "CSSが宣言するマーク形状を確認する。状態判定・件数・操作はcomponent test、実描画とフレームはbrowser測定で確認する"
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
  for (const state of ["running", "error", "neutral"]) {
    assert.match(
      stylesSource,
      new RegExp(
        String.raw`\.home-page \.home-session-chip-status\.${state}` +
          String.raw`(?:,\s*\.home-page \.home-session-status\.${state})?\s*{`,
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
  assert.notEqual(readCssRule(stylesSource, ".home-page .home-monitor-status-icon.neutral"), "");
  const runningRules = readCssRules(stylesSource, ".home-page .home-monitor-status-icon.running .home-monitor-status-icon-mark");
  const runningRule = runningRules.find((rule) => rule.includes("clip-path"));
  assert.ok(runningRule);
  assert.match(runningRule, /background: currentColor;/);
  const triangle = runningRule.match(/clip-path:\s*polygon\(\s*([\d.]+)%?\s+([\d.]+)%?\s*,\s*([\d.]+)%?\s+([\d.]+)%?\s*,\s*([\d.]+)%?\s+([\d.]+)%?\s*\)/);
  assert.ok(triangle);
  const [topX, topY, tipX, tipY, bottomX, bottomY] = triangle.slice(1).map(Number);
  assert.equal(topX, bottomX);
  assert.ok(tipX! > topX! && topY! < tipY! && tipY! < bottomY!);
  for (const rule of runningRules) {
    for (const declaration of rule.matchAll(/(?:^|;)\s*animation(?:-name)?:\s*([^;]+)/g)) {
      assert.match(declaration[1]!, /^none(?:\s+!important)?\s*$/);
    }
  }
  assert.match(
    readCssRule(stylesSource, ".home-page .home-monitor-status-icon.error .home-monitor-status-icon-mark"),
    /clip-path: polygon\(50% 0, 100% 100%, 0 100%\);/,
  );
  assert.match(
    readCssRule(stylesSource, ".home-page .home-monitor-status-icon.neutral .home-monitor-status-icon-mark"),
    /border: 1\.5px solid currentColor;/,
  );
  assert.match(
    readCssRule(stylesSource, ".home-page .home-monitor-status-icon.neutral .home-monitor-status-icon-mark"),
    /border-radius: 50%;/,
  );
});

// @test-value v2
// kind = "contract"
// claim = "Home Charactersは作成ボタンを一覧の外に描画し、一覧DOMへoverflow-y:auto、bodyへoverflow:hiddenを適用する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "toolbarを一覧のscroll owner内へ移すか、描画DOMにbodyのoverflow:hidden・一覧のoverflow-y:auto・縮小可能なmin-heightを適用しない"
// observable = "HomeRightPaneのCharacters panel内のtoolbar/list親子関係と、JSDOM computed styleのoverflow・min-height・flex"
// observation_boundary = "implementation"
// scope = "Home Characters panelのスクロール境界"
// lifecycle = "permanent"
// impact = "長いCharacter一覧でも作成へ到達でき、下端の項目も操作できる"
// distinction = "source文字列の存在ではなく描画DOMへのselector適用を確認する。実レイアウトのscroll寸法や操作はJSDOMでは測定しない"
// @end-test-value
test("Home Characters は一覧をscroll ownerにするDOMとCSSを適用する", async () => {
  const stylesSource = await readStylesheet();
  const noOp = () => {};
  const html = renderToStaticMarkup(createElement(HomeRightPane, {
    rightPaneView: "characters",
    searchText: "",
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
