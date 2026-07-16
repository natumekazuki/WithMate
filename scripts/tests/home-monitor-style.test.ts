import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Home Monitor の status badge は Home session と同じ状態 selector で styling される", async () => {
  const stylesSource = await readFile("src/styles.css", "utf8");

  assert.match(
    stylesSource,
    /\.home-page \.home-session-chip-status,\s*\.home-page \.home-session-status,\s*\.home-page \.home-monitor-status,\s*\.home-page \.session-mode-badge\s*{/,
  );

  for (const state of ["running", "interrupted", "error", "neutral"]) {
    assert.match(
      stylesSource,
      new RegExp(
        String.raw`\.home-page \.home-session-chip-status\.${state},\s*` +
          String.raw`\.home-page \.home-session-status\.${state},\s*` +
          String.raw`\.home-page \.home-monitor-status\.${state}\s*{`,
      ),
    );
  }
});

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
