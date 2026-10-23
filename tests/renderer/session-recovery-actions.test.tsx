import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildLiveSessionRecoveryActions } from "../../src/chat/live-session-projection.js";
import { SessionRecoveryActions } from "../../src/chat/runtime/session-recovery-actions.js";

const noop = () => {};

// @test-value v2
// kind = "contract"
// claim = "回復操作は対象会話と前回依頼を示し、Resend/Editと既存draftの明示的な置換・保持を提供する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: terminal state 後の再送導線" }
// fault = "回復対象の区別またはdraft保護の置換・保持操作を失う"
// observable = "対象付きgroupと依頼preview、Resend/Edit、置換・保持buttonの描画"
// observation_boundary = "component-behavior"
// scope = "session-recovery-actions"
// lifecycle = "permanent"
// impact = "別会話を再送したり既存draftを失う判断を誤る"
// distinction = "command単体testでは対象表示とdraft保護操作のUI接続を確認できない"
// @end-test-value
test("recovery actions は対象と前回依頼とdraft保護操作を表示する", () => {
  const recovery = buildLiveSessionRecoveryActions({
    retryState: { kind: "failed", badge: "Failed", title: "Could not complete", lastRequestText: "Fix this request" },
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
  assert.match(html, /Fix this request/);
  assert.match(html, />Resend<\/button>/);
  assert.match(html, />Edit<\/button>/);
  assert.match(html, /Your current draft is preserved\./);
  assert.match(html, />Replace With Previous Request<\/button>/);
  assert.match(html, />Keep Current Draft<\/button>/);
});

// @test-value v2
// kind = "contract"
// claim = "既知の回復操作は最新実行記録の再読込と取得失敗でも保持し、Interrupted/Canceledの区別と無効化を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: terminal state 後の再送導線" }
// fault = "再取得中や取得失敗で回復操作を消すかdisabled guardを失う"
// observable = "状態badge、disabled Resend/Edit、Loading latest execution、取得errorとRetryの描画"
// observation_boundary = "component-behavior"
// scope = "session-recovery-loading-and-error"
// lifecycle = "permanent"
// impact = "一時的な最新turn取得障害により再送・編集が到達不能になる"
// distinction = "実行状態と取得状態の直交分岐を小さい描画fixtureで検証する"
// @end-test-value
test("recovery actions はlatest turn再取得中とerrorでも既知の操作を保持する", () => {
  for (const kind of ["failed", "interrupted", "canceled"] as const) {
    const html = renderToStaticMarkup(<SessionRecoveryActions
      retryState={{ kind, badge: kind, title: "Previous request", lastRequestText: "Fix it" }}
      requestKey={`main:incarnation:0:${kind}`} targetLabel="Main"
      isRetryActionDisabled isRetryEditDisabled isRetryDraftReplacePending={false}
      onResendLastMessage={noop} onEditLastMessage={noop}
      onConfirmRetryDraftReplace={noop} onCancelRetryDraftReplace={noop}
      latestTurnLoading latestTurnError="Read failed" onRetryLatestTurn={noop}
    />);
    assert.match(html, /aria-busy="true"/);
    assert.match(html, /disabled="">Resend<\/button>/);
    assert.match(html, /disabled="">Edit<\/button>/);
    assert.match(html, /Loading latest execution/);
    assert.match(html, /Could not load the latest execution: Read failed/);
    assert.match(html, /Retry<\/button>/);
    if (kind !== "failed") assert.match(html, new RegExp(`>${kind}<\/span>`));
  }
});
