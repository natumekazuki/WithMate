import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { buildLiveSessionRetryBanner } from "../../src/chat/retry-banner-adapter.js";

const noop = () => {};

// @test-value v2
// kind = "contract"
// claim = "retry banner adapterはretry状態、固定説明、resend/edit actionをmode-neutralなUIへ投影する"
// oracle = { type = "contract", ref = "docs/design/session-character-copy.md#rendering-policy" }
// fault = "retry説明、action label、accessible label、draft conflict actionsのいずれかを失う"
// observable = "retry class、aria label、固定説明、resend/edit buttons、draft conflict actionsのrender結果"
// observation_boundary = "component-behavior"
// scope = "session-retry-banner"
// lifecycle = "permanent"
// impact = "中断・失敗したrequestを再送または編集できず、状態説明も利用者へ届かなくなる"
// distinction = "固定説明をbadgeのaccessible nameへ保持し、操作とdraft保護を同時に確認する"
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
  assert.match(html, /title="前回の依頼は完了できませんでした"/);
  assert.match(html, /class="sr-only">: 前回の依頼は完了できませんでした<\/span>/);
  assert.match(html, /Your current draft is preserved\.<\/p>/);
  assert.match(html, />ReplacePreviousRequest<\/button>/);
  assert.match(html, />KeepCurrentDraft<\/button>/);
  assert.doesNotMatch(html, /停止地点|>Details<|>Hide</);
});

// @test-value v2
// kind = "contract"
// claim = "既定のretry説明を短縮しても失敗状態のaccessible説明と再送・編集操作を保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window" }
// fault = "既定文の表示整理で失敗理由のaccessible説明または回復操作を失う"
// observable = "Failed badge、sr-only説明、ResendとEditの有効なbutton"
// observation_boundary = "component-behavior"
// scope = "session-retry-banner"
// lifecycle = "permanent"
// impact = "失敗状態の理解と再送・編集による回復が難しくなる"
// distinction = "custom可視testと異なり既定説明を短縮した分岐のaccessible内容と回復操作を観測する"
// @end-test-value
test("SessionRetryBanner は既定説明を短縮しても状態と回復操作を保つ", () => {
  const html = renderToStaticMarkup(buildLiveSessionRetryBanner({
    retryBanner: {
      kind: "failed",
      badge: "Failed",
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
  assert.match(html, /class="sr-only">: The previous request could not be completed<\/span>/);
  assert.match(html, />Failed<span/);
  assert.match(html, />Resend<\/button>/);
  assert.match(html, />Edit<\/button>/);
  assert.doesNotMatch(html, /disabled=""/);
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
