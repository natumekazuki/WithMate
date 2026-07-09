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
      stopSummary: "assistant error",
      lastRequestText: "直して",
    },
    isRetryDetailsOpen: true,
    isRetryActionDisabled: false,
    isRetryEditDisabled: false,
    isRetryDraftReplacePending: false,
    onToggleDetails: noop,
    onResendLastMessage: noop,
    onEditLastMessage: noop,
    onConfirmRetryDraftReplace: noop,
    onCancelRetryDraftReplace: noop,
    onOpenPath: noop,
  }));

  assert.match(html, /retry-banner failed/);
  assert.match(html, />同じ依頼を再送<\/button>/);
  assert.match(html, />編集して再送<\/button>/);
  assert.match(html, /前回の依頼/);
});

test("buildLiveSessionRetryBanner は banner がない場合 null を描画する", () => {
  const html = renderToStaticMarkup(buildLiveSessionRetryBanner({
    retryBanner: null,
    isRetryDetailsOpen: false,
    isRetryActionDisabled: true,
    isRetryEditDisabled: true,
    isRetryDraftReplacePending: false,
    onToggleDetails: noop,
    onResendLastMessage: noop,
    onEditLastMessage: noop,
    onConfirmRetryDraftReplace: noop,
    onCancelRetryDraftReplace: noop,
    onOpenPath: noop,
  }));

  assert.equal(html, "");
});
