import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveHomeWindowModeFromSearch, resolveHomeWindowTitle } from "../../src/home/home-window-mode.js";

describe("home-window-mode", () => {
  it("known mode を解決する", () => {
    assert.equal(resolveHomeWindowModeFromSearch("?mode=monitor"), "monitor");
    assert.equal(resolveHomeWindowModeFromSearch("?mode=settings"), "settings");
    assert.equal(resolveHomeWindowModeFromSearch("?mode=memory-review"), "memory-review");
  });

  it("unknown mode は home に戻す", () => {
    assert.equal(resolveHomeWindowModeFromSearch(""), "home");
    assert.equal(resolveHomeWindowModeFromSearch("?mode=memory"), "home");
    assert.equal(resolveHomeWindowModeFromSearch("?mode=mate-talk"), "home");
  });
});

// @test-value v2
// kind = "contract"
// claim = "共通Home entryから開く各Windowのdocument titleは表示modeの役割名に対応する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Home Window and Settings Window" }
// fault = "Settings、Session Monitor、Memory ReviewがHomeというtitleで表示される"
// observable = "modeごとのresolveHomeWindowTitleの返却文字列"
// observation_boundary = "public-boundary"
// scope = "Home renderer window titles"
// lifecycle = "permanent"
// impact = "複数Windowを見分けられず、taskbarとtitlebarから操作対象を誤る"
// distinction = "HTML entryを共有するWindowのmode別titleは型検査とbuildでは確認できない"
// @end-test-value
it("共通Home entryのWindow titleはmodeの役割に一致する", () => {
  assert.equal(resolveHomeWindowTitle("home"), "Home");
  assert.equal(resolveHomeWindowTitle("monitor"), "Session Monitor");
  assert.equal(resolveHomeWindowTitle("settings"), "Settings");
  assert.equal(resolveHomeWindowTitle("memory-review"), "Memory Review");
});
