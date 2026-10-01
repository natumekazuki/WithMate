import assert from "node:assert/strict";
import { it } from "node:test";
import { TerminalActivityParser, TerminalActivityTracker } from "../../src-electron/terminal/terminal-activity.js";
import type { TerminalActivity } from "../../src-electron/terminal/terminal-worker-protocol.js";

const marker = "\x1b]633;P;WithMateActivity=test-terminal;";

// @test-value v2
// kind = "contract"
// claim = "単独のfocus通知は入力待ち・実行中・判別不能の状態を変えず、空Enter後もshell通知で入力待ちに戻れる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md Terminal" }
// fault = "終了ボタンへfocusを移すだけでidleを失効させるか、focus通知で実行中の保護を解除する"
// observable = "入力とshell通知を受けたtrackerのactivity"
// observation_boundary = "component-behavior"
// scope = "Terminal activity input and focus transitions"
// lifecycle = "permanent"
// impact = "通常の終了操作で不要な警告が必ず出る、または実行中作業を確認せず終了する"
// distinction = "serviceのPTY stubではxterm由来のfocus通知を通らないため、少数の状態遷移を直接検査する"
// @end-test-value
it("preserves shell activity across focus reports and returns to idle after empty Enter", () => {
  const tracker = new TerminalActivityTracker();
  for (const activity of ["unknown", "busy", "idle"] as const) {
    tracker.onActivity(activity);
    for (const report of ["\x1b[I", "\x1b[O", ""]) {
      tracker.onInput(report);
      assert.equal(tracker.getActivity(), activity);
    }
  }
  tracker.onInput("\r");
  assert.equal(tracker.getActivity(), "unknown");
  tracker.onActivity("busy");
  tracker.onActivity("idle");
  tracker.onInput("\x1b[O");
  assert.equal(tracker.getActivity(), "idle");
});

// @test-value v2
// kind = "invariant"
// claim = "実入力・focus通知と混在した入力・修飾F3と同形の制御列は直ちにidleを失効させ、古いidle通知では保護を解除しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md Terminal" }
// fault = "制御列の広い除外や遅着idleの受理により、入力から実行開始通知までの間に無確認終了を許す"
// observable = "入力・遅着idle・busyとidleの順に通知されたactivity"
// observation_boundary = "component-behavior"
// scope = "Terminal activity pending user input safety"
// lifecycle = "permanent"
// impact = "送信済みコマンドや編集中の入力を終了確認なしで失う"
// distinction = "文字列の分類と通知順序は型検査やservice stubでは保証できず、小さい入力集合で保護境界を検査する"
// @end-test-value
it("invalidates idle for keyboard or mixed input until the shell returns from read-line", () => {
  for (const input of ["a", "\r", "\x03", "\x1b[1;5R", "\x1b[Oecho work\r", "echo work\r\x1b[I"]) {
    const tracker = new TerminalActivityTracker();
    tracker.onActivity("idle");
    tracker.onInput(input);
    assert.equal(tracker.getActivity(), "unknown");
    tracker.onInput("\x1b[O");
    tracker.onActivity("idle");
    assert.equal(tracker.getActivity(), "unknown");
    tracker.onActivity("busy");
    tracker.onInput("\x1b[I");
    assert.equal(tracker.getActivity(), "busy");
    tracker.onActivity("idle");
    assert.equal(tracker.getActivity(), "idle");
  }
});

// @test-value v2
// kind = "contract"
// claim = "PTY chunk境界によらず自端末のactivity通知を読み取り、利用者の出力と他端末の制御列を保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md Terminal" }
// fault = "分割されたidle通知を読み落とすか、通常出力・別端末のマーカーをactivityへ誤変換する"
// observable = "parserを通過した出力と通知されたactivity列"
// observation_boundary = "component-behavior"
// scope = "Terminal shell activity framing"
// lifecycle = "permanent"
// impact = "入力待ちの誤判定または端末出力の欠落"
// distinction = "型検査は任意位置に分割されるPTY文字列を保証せず、小さいfixtureの境界全走査で検出する"
// @end-test-value
it("preserves output and recognizes only complete terminal-scoped activity records across chunks", () => {
  const foreign = "\x1b]633;P;WithMateActivity=another-terminal;idle\x07";
  const malformed = `${marker}unexpected\x07`;
  const source = `before${marker}idle\x07middle${marker}busy\x07${foreign}${malformed}${marker}unknown\x07after`;
  for (let split = 0; split <= source.length; split++) {
    const activities: TerminalActivity[] = [];
    const parser = new TerminalActivityParser(marker, (activity) => activities.push(activity));
    const output = parser.push(source.slice(0, split)) + parser.push(source.slice(split)) + parser.flush();
    assert.equal(output, `beforemiddle${foreign}${malformed}after`);
    assert.deepEqual(activities, ["idle", "busy", "unknown"]);
  }
});

// @test-value v2
// kind = "contract"
// claim = "未完のactivity文字列はidleとみなさず、端末終了時に元の出力として残す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md Terminal" }
// fault = "終端のないマーカーを受理して無確認終了を許すか、終了時に末尾出力を捨てる"
// observable = "通知されたactivity列とflushされた出力"
// observation_boundary = "component-behavior"
// scope = "Terminal shell activity incomplete output"
// lifecycle = "permanent"
// @end-test-value
it("keeps incomplete activity records unknown and flushes their text on exit", () => {
  const activities: TerminalActivity[] = [];
  const parser = new TerminalActivityParser(marker, (activity) => activities.push(activity));
  assert.equal(parser.push(`output${marker}idle`), "output");
  assert.deepEqual(activities, []);
  assert.equal(parser.flush(), `${marker}idle`);
  assert.equal(parser.flush(), "");
});
