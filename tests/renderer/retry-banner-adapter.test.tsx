import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { buildLiveSessionRetryBanner } from "../../src/chat/retry-banner-adapter.js";

const noop = () => {};

// @test-value v2
// kind = "contract"
// claim = "retry banner adapterは未完了requestのresend/edit actionとdraft保護をmode-neutralなUIへ投影する"
// oracle = { type = "contract", ref = "docs/design/session-character-copy.md#rendering-policy" }
// fault = "action label、accessible label、draft conflict actionsのいずれかを失う"
// observable = "retry class、aria label、resend/edit buttons、draft conflict actionsのrender結果"
// observation_boundary = "component-behavior"
// scope = "session-retry-banner"
// lifecycle = "permanent"
// impact = "中断・失敗したrequestの回復操作とdraft保護を利用できなくなる"
// distinction = "command単体ではadapterを経由した操作とdraft保護の同時表示を確認できない"
// @end-test-value
test("buildLiveSessionRetryBanner は retry banner UI を mode-neutral に組み立てる", () => {
  const html = renderToStaticMarkup(buildLiveSessionRetryBanner({
    retryBanner: {
      kind: "failed",
      badge: "失敗",
      title: "前回の依頼は完了できませんでした",
      lastRequestText: "直して",
    },
    isRetryActionDisabled: false,
    isRetryEditDisabled: false,
    isRetryDraftReplacePending: true,
    onResendLastMessage: noop,
    onEditLastMessage: noop,
    onConfirmRetryDraftReplace: noop,
    onCancelRetryDraftReplace: noop,
  }));

  assert.match(html, /retry-banner failed/);
  assert.match(html, /aria-label="Actions for an unfinished request"/);
  assert.match(html, />Resend<\/button>/);
  assert.match(html, />Edit<\/button>/);
  assert.match(html, /Your current draft is preserved\.<\/p>/);
  assert.match(html, />Replace Previous Request<\/button>/);
  assert.match(html, />Keep Current Draft<\/button>/);
  assert.doesNotMatch(html, /停止地点|>Details<|>Hide</);
});

// @test-value v2
// kind = "contract"
// claim = "失敗の回復操作は応答側のFailedを重ねずResend/Editを提供し、中断・取消には固有の状態説明を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window" }
// fault = "失敗badgeを重ねる、再送・編集操作を失う、または中断・取消を判別できなくする"
// observable = "状態別のbadge・sr-only説明、ResendとEditの有効なbutton"
// observation_boundary = "component-behavior"
// scope = "session-retry-banner"
// lifecycle = "permanent"
// impact = "失敗状態の理解と再送・編集による回復が難しくなる"
// distinction = "draft保護testと異なりfailed/interrupted/canceledの状態分岐と回復操作の維持を小さい描画fixtureで確認する"
// @end-test-value
test("SessionRetryBanner は状態に応じた表示と回復操作を保つ", () => {
  for (const kind of ["failed", "interrupted", "canceled"] as const) {
  const html = renderToStaticMarkup(buildLiveSessionRetryBanner({
    retryBanner: {
      kind,
      badge: kind,
      title: "The previous request could not be completed",
      lastRequestText: "Fix it",
    },
    isRetryActionDisabled: false,
    isRetryEditDisabled: false,
    isRetryDraftReplacePending: false,
    onResendLastMessage: noop,
    onEditLastMessage: noop,
    onConfirmRetryDraftReplace: noop,
    onCancelRetryDraftReplace: noop,
  }));

  assert.doesNotMatch(html, /class="resume-banner-title"/);
  if (kind === "failed") assert.doesNotMatch(html, /resume-banner-badge/);
  else {
    assert.match(html, /class="sr-only">: The previous request could not be completed<\/span>/);
    assert.match(html, new RegExp(`>${kind}<span`));
  }
  assert.match(html, />Resend<\/button>/);
  assert.match(html, />Edit<\/button>/);
  assert.doesNotMatch(html, /disabled=""/);
  }
});

test("buildLiveSessionRetryBanner は banner がない場合 null を描画する", () => {
  const html = renderToStaticMarkup(buildLiveSessionRetryBanner({
    retryBanner: null,
    isRetryActionDisabled: true,
    isRetryEditDisabled: true,
    isRetryDraftReplacePending: false,
    onResendLastMessage: noop,
    onEditLastMessage: noop,
    onConfirmRetryDraftReplace: noop,
    onCancelRetryDraftReplace: noop,
  }));

  assert.equal(html, "");
});
