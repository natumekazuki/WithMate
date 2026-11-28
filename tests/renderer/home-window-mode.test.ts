import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveHomeWindowModeFromSearch,
  resolveHomeWindowTitle,
} from "../../src/home/home-window-mode.js";

/** 共通 Home エントリーの検索文字列から、安全に表示モードを選ぶ。 */
describe("home-window-mode", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "Home共通entryのmonitorとsettingsのquery modeをそれぞれ対応するWindow modeとして解決する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md: HomeからSession MonitorとSettingsを開くWindow構成" }
  // fault = "有効なmonitorまたはsettingsをhomeに戻すか、別のWindow modeへ取り違える"
  // observable = "monitorとsettingsのqueryに対するresolveHomeWindowModeFromSearchの返却値"
  // observation_boundary = "public-boundary"
  // scope = "Home rendererの有効な補助Window mode解決"
  // lifecycle = "permanent"
  // distinction = "union型ではURL文字列から選ばれる実際のmodeを保証できない"
  // @end-test-value
  /** 明示した monitor と settings がそれぞれ対応するモードとして解決される。 */
  it("known mode を解決する", () => {
    assert.equal(resolveHomeWindowModeFromSearch("?mode=monitor"), "monitor");
    assert.equal(resolveHomeWindowModeFromSearch("?mode=settings"), "settings");
  });

  /** モードを省略した場合と、過去や未知の値を渡した場合は Home へ戻す。 */
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
// fault = "Settings、Session MonitorがHomeというtitleで表示される"
// observable = "modeごとのresolveHomeWindowTitleの返却文字列"
// observation_boundary = "public-boundary"
// scope = "Home renderer window titles"
// lifecycle = "permanent"
// impact = "複数Windowを見分けられず、taskbarとtitlebarから操作対象を誤る"
// distinction = "HTML entryを共有するWindowのmode別titleは型検査とbuildでは確認できない"
// @end-test-value
/** 共通エントリーを共有しても Home・Session Monitor・Settings の Window タイトルを区別する。 */
it("共通Home entryのWindow titleはmodeの役割に一致する", () => {
  assert.equal(resolveHomeWindowTitle("home"), "Home");
  assert.equal(resolveHomeWindowTitle("monitor"), "Session Monitor");
  assert.equal(resolveHomeWindowTitle("settings"), "Settings");
});
