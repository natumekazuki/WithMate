import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { LiveApprovalRequest, LiveElicitationRequest } from "../../src-shared/session/runtime-state.js";
import { LiveRequestSurface } from "../../src/chat/runtime/live-request-surface.js";

const approvalRequest: LiveApprovalRequest = {
  requestId: "approval-1",
  provider: "codex",
  kind: "shell",
  title: "Run a command",
  summary: "npm test",
  details: "The command will inspect the workspace.",
  warning: "This command can change workspace state.",
  decisionMode: "direct-decision",
};

const elicitationRequest: LiveElicitationRequest = {
  requestId: "input-1",
  provider: "codex",
  mode: "form",
  message: "Choose a branch",
  fields: [{
    name: "branch",
    title: "Branch",
    type: "text",
    required: true,
  }],
};

// @test-value v2
// kind = "contract"
// claim = "Live approvalとinput requestは解決中に対象領域のbusy stateと既存spinnerを示し、要求内容と操作識別を維持する"
// oracle = { type = "contract", ref = "src/chat/runtime/live-request-surface.tsx" }
// fault = "解決中のrequestがdisabled操作だけになり、処理中であることを支援技術へ伝えられないか、request本文・操作labelを失う"
// observable = "request領域のaria-busy、settings-action-spinnerのstatus、request本文、warning/details、approval/input操作label"
// observation_boundary = "component-behavior"
// scope = "live-request-resolution-feedback"
// lifecycle = "permanent"
// impact = "承認・入力回答の送信中に再操作や待機状態を誤認し、安全判断に必要な要求内容を見失う"
// distinction = "disabled属性の有無だけでなく、busy announcementが一つだけ存在し、要求内容と操作識別が同時に残ることを確認する"
// @end-test-value
test("LiveRequestSurface はapproval解決中のbusy announcementと要求内容を保つ", () => {
  const html = renderToStaticMarkup(React.createElement(LiveRequestSurface, {
    liveApprovalRequest: approvalRequest,
    approvalActionRequestId: approvalRequest.requestId,
    liveElicitationRequest: null,
    elicitationActionRequestId: null,
    onResolveLiveApproval() {},
    onResolveLiveElicitation() {},
  }));

  assert.match(html, /class="live-approval-card"[^>]*aria-busy="true"/);
  assert.match(html, /role="status" aria-label="Processing approval request"/);
  assert.equal((html.match(/class="settings-action-spinner"/g) ?? []).length, 1);
  assert.match(html, /Run a command/);
  assert.match(html, /npm test/);
  assert.match(html, /This command can change workspace state\./);
  assert.match(html, />AllowOnce<\/button>/);
  assert.match(html, />Reject<\/button>/);
});

// @test-value v2
// kind = "contract"
// claim = "Live input requestは解決中に対象領域のbusy stateと既存spinnerを示し、要求内容と操作識別を維持する"
// oracle = { type = "contract", ref = "src/chat/runtime/live-request-surface.tsx" }
// fault = "解決中のinput requestがdisabled操作だけになり、処理中であることを支援技術へ伝えられないか、request本文・操作labelを失う"
// observable = "input request領域のaria-busy、settings-action-spinnerのstatus、request本文、input操作label"
// observation_boundary = "component-behavior"
// scope = "live-input-request-resolution-feedback"
// lifecycle = "permanent"
// impact = "入力回答の送信中に再操作や待機状態を誤認し、要求内容を見失う"
// distinction = "disabled属性の有無だけでなく、busy announcementが一つだけ存在し、要求内容と操作識別が同時に残ることを確認する"
// @end-test-value
test("LiveRequestSurface はinput解決中のbusy announcementと操作labelを保つ", () => {
  const html = renderToStaticMarkup(React.createElement(LiveRequestSurface, {
    liveApprovalRequest: null,
    approvalActionRequestId: null,
    liveElicitationRequest: elicitationRequest,
    elicitationActionRequestId: elicitationRequest.requestId,
    onResolveLiveApproval() {},
    onResolveLiveElicitation() {},
  }));

  assert.match(html, /class="live-elicitation-card"[^>]*aria-busy="true"/);
  assert.match(html, /role="status" aria-label="Processing input request"/);
  assert.equal((html.match(/class="settings-action-spinner"/g) ?? []).length, 1);
  assert.match(html, /Choose a branch/);
  assert.match(html, />Submit<\/button>/);
  assert.match(html, />Reject<\/button>/);
  assert.match(html, />Close<\/button>/);
});
