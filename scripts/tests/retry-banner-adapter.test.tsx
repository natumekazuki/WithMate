import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { buildLiveSessionRetryBanner } from "../../src/chat/retry-banner-adapter.js";

const noop = () => {};

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
    isRetryDraftReplacePending: false,
    onResendLastMessage: noop,
    onEditLastMessage: noop,
    onConfirmRetryDraftReplace: noop,
    onCancelRetryDraftReplace: noop,
  }));

  assert.match(html, /retry-banner failed/);
  assert.match(html, /aria-label="完了できなかった依頼の操作"/);
  assert.match(html, />再送<\/button>/);
  assert.match(html, />編集<\/button>/);
  assert.match(html, /title="前回の依頼は完了できませんでした"/);
  assert.doesNotMatch(html, /停止地点|resume-banner-title|>Details<|>Hide</);
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

test("TN-PROJ-06: source failure bannerはterminal通知の配送状態を既存surfaceへ表示する", () => {
  const html = renderToStaticMarkup(buildLiveSessionRetryBanner({
    retryBanner: {
      kind: "failed",
      badge: "失敗",
      title: "前回の依頼は完了できませんでした",
      lastRequestText: "直して",
      terminalFailureNotification: {
        state: "enqueued",
        targetSessionId: "target-session",
        notificationExecutionId: "notification-execution",
        errorCode: null,
        updatedAt: "2026-08-18T00:00:00.000Z",
      },
    },
    isRetryActionDisabled: false,
    isRetryEditDisabled: false,
    isRetryDraftReplacePending: false,
    onResendLastMessage: noop,
    onEditLastMessage: noop,
    onConfirmRetryDraftReplace: noop,
    onCancelRetryDraftReplace: noop,
  }));

  assert.match(html, /通知先 target-session · 通知を登録済み/);
  assert.doesNotMatch(html, /transport|notification-badge/);
});
