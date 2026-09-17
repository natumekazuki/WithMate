import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
// claim = "Home Monitorの状態アイコンは各状態を個別の形で表現し、旧status selectorを残さずreduced motionにも従う"
// oracle = { type = "contract", ref = "issue-722 monitor status icon styling" }
// fault = "状態を色だけで表現する、状態ruleの確認が別blockへ跨る、旧home-monitor-status selectorを残す、またはreduced motion時も回転を続ける"
// observable = "状態別status icon rule本体、旧selectorの不在、reduced motion時のanimation無効化CSS"
// observation_boundary = "implementation"
// scope = "Home Monitor status icon CSS"
// lifecycle = "permanent"
// impact = "実行中・失敗・待機・未確定を視認可能な形で区別し、動きが苦手な環境でも静止表示する"
// distinction = "現行のMonitor DOMへ対応する専用iconの形・状態・motion契約だけを検証する"
// @end-test-value
test("Home Monitor の status icon は状態ごとの形とmotion制御で styling される", async () => {
  const stylesSource = await readFile("src/styles.css", "utf8");

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
    /border-radius: 2px;/,
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
  assert.match(
    reducedMotionBlock,
    /\.home-monitor-status-icon\.running \.home-monitor-status-icon-mark,\s*\.home-monitor-status-icon\.loading \.home-monitor-status-icon-mark\s*\{\s*animation: none;/s,
  );
});

// @test-value v2
// kind = "contract"
// claim = "Home Characters panelはright pane内のmonitor bodyをscroll containerとして使う"
// oracle = { type = "contract", ref = "Home Characters right pane scroll contract" }
// fault = "panel全体がoverflowせず、right paneの外側へ内容がはみ出すか固定領域が縮まない"
// observable = "HomeCharactersPanelのmonitor body要素とflex・min-height・overflow-y CSS"
// observation_boundary = "implementation"
// scope = "Home Characters panel scroll container"
// lifecycle = "permanent"
// impact = "Character一覧がright pane内で収まり、他のHome領域のlayoutを押し広げない"
// distinction = "Monitor status iconのCSSとは分離して、right pane内のscroll境界だけを検証する"
// @end-test-value
test("Home Characters は right pane 内の scroll container を使う", async () => {
  const [componentSource, stylesSource] = await Promise.all([
    readFile("src/home/HomeCharactersPanel.tsx", "utf8"),
    readFile("src/styles.css", "utf8"),
  ]);

  assert.match(componentSource, /<div className="home-monitor-body">/);
  const scrollContainerRule = stylesSource.match(/\.home-page \.home-monitor-body\s*{([^}]*)}/)?.[1];

  assert.ok(scrollContainerRule);
  assert.match(scrollContainerRule, /flex:\s*1 1 auto;/);
  assert.match(scrollContainerRule, /min-height:\s*0;/);
  assert.match(scrollContainerRule, /overflow-y:\s*auto;/);
});
