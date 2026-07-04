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
