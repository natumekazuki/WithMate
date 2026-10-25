import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { buildLiveSessionRecoveryActions } from "../../src/chat/live-session-projection.js";
import { SessionRecoveryActions } from "../../src/chat/runtime/session-recovery-actions.js";

const noop = () => {};

// @test-value v2
// kind = "contract"
// claim = "icon-onlyのResend/Editは対象付き操作名を保ち、draftの明示的な置換・保持を提供する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: terminal state 後の再送導線" }
// fault = "回復対象の区別、icon-only操作のaccessible name、またはdraft保護の置換・保持操作を失う"
// observable = "対象付きgroup、Resend/Editのaccessible nameとtooltip、置換・保持buttonの描画"
// observation_boundary = "component-behavior"
// scope = "session-recovery-actions"
// lifecycle = "permanent"
// impact = "別会話を再送したり既存draftを失う判断を誤る"
// distinction = "command単体testでは対象付き操作名とdraft保護操作のUI接続を確認できない"
// @end-test-value
test("recovery actions は対象付き操作名とdraft保護操作を提供する", () => {
  const recovery = buildLiveSessionRecoveryActions({
    retryState: { kind: "failed", lastRequestText: "Fix this request" },
    requestKey: "aux:incarnation:4",
    targetLabel: "Auxiliary: Review",
    isRetryActionDisabled: false,
    isRetryEditDisabled: false,
    isRetryDraftReplacePending: true,
    onResendLastMessage: noop,
    onEditLastMessage: noop,
    onConfirmRetryDraftReplace: noop,
    onCancelRetryDraftReplace: noop,
  });
  const html = renderToStaticMarkup(<SessionRecoveryActions {...recovery} />);
  assert.match(html, /aria-label="Auxiliary: Review: Previous Request Actions"/);
  const document = new JSDOM(html).window.document;
  for (const action of ["Resend", "Edit"]) {
    const name = `Auxiliary: Review: ${action} Previous Request`;
    const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
    assert.ok(button);
    assert.equal(button.title, name);
    assert.equal(button.querySelector("svg")?.getAttribute("aria-hidden"), "true");
  }
  assert.match(html, /Your current draft is preserved\./);
  assert.match(html, />Replace With Previous Request<\/button>/);
  assert.match(html, />Keep Current Draft<\/button>/);
});

// @test-value v2
// kind = "contract"
// claim = "failed/interrupted/canceledの既知の回復操作は最新実行記録の再読込と取得失敗でも保持し、無効化を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: terminal state 後の再送導線" }
// fault = "再取得中や取得失敗で回復操作を消すかdisabled guardを失う"
// observable = "disabled Resend/Edit、Loading latest execution、取得errorとRetryの描画"
// observation_boundary = "component-behavior"
// scope = "session-recovery-loading-and-error"
// lifecycle = "permanent"
// impact = "一時的な最新turn取得障害により再送・編集が到達不能になる"
// distinction = "実行状態と取得状態の直交分岐を小さい描画fixtureで検証する"
// @end-test-value
test("recovery actions はlatest turn再取得中とerrorでも既知の操作を保持する", () => {
  for (const kind of ["failed", "interrupted", "canceled"] as const) {
    const html = renderToStaticMarkup(<SessionRecoveryActions
      retryState={{ kind, lastRequestText: "Fix it" }}
      requestKey={`main:incarnation:0:${kind}`} targetLabel="Main"
      isRetryActionDisabled isRetryEditDisabled isRetryDraftReplacePending={false}
      onResendLastMessage={noop} onEditLastMessage={noop}
      onConfirmRetryDraftReplace={noop} onCancelRetryDraftReplace={noop}
      latestTurnLoading latestTurnError="Read failed" onRetryLatestTurn={noop}
    />);
    assert.match(html, /aria-busy="true"/);
    const document = new JSDOM(html).window.document;
    for (const action of ["Resend", "Edit"]) {
      const button = document.querySelector<HTMLButtonElement>(`button[aria-label="Main: ${action} Previous Request"]`);
      assert.ok(button);
      assert.equal(button.disabled, true);
    }
    assert.match(html, /Loading latest execution/);
    assert.match(html, /Could not load the latest execution: Read failed/);
    const retryButton = document.querySelector<HTMLButtonElement>('[role="alert"] button');
    assert.ok(retryButton);
    assert.equal(retryButton.textContent, "Retry");
    assert.equal(retryButton.disabled, true);
  }
});
