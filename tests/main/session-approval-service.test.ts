import assert from "node:assert/strict";
import test from "node:test";

import { SessionApprovalService } from "../../src-electron/session/session-approval-service.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { SessionTurnNotificationService } from "../../src-electron/session/session-turn-notification-service.js";

function createLiveRunState(): LiveSessionRunState {
  return {
    sessionId: "session-1",
    threadId: "thread-1",
    assistantText: "",
    steps: [],
    backgroundTasks: [],
    usage: null,
    errorMessage: "",
    approvalRequest: null,
    elicitationRequest: null,
  };
}

test("SessionApprovalService は承認待ちを live run に反映し、resolve 後に片付ける", async () => {
  let state = createLiveRunState();
  const service = new SessionApprovalService({
    updateLiveSessionRun: (_sessionId, recipe) => {
      state = recipe(state);
      return state;
    },
  });

  const waitPromise = service.waitForLiveApprovalDecision(
    "session-1",
    {
      requestId: "req-1",
      provider: "copilot",
      kind: "tool",
      title: "approval",
      summary: "need approval",
      decisionMode: "direct-decision",
    },
    new AbortController().signal,
  );

  assert.equal(state.approvalRequest?.requestId, "req-1");
  service.resolveLiveApproval("session-1", "req-1", "approve");
  assert.equal(await waitPromise, "approve");
  assert.equal(state.approvalRequest, null);
});

// @test-value v2
// kind = "contract"
// claim = "要求signalのabortで承認待機をdenyで解決しlive表示を解除する"
// oracle = { type = "contract", ref = "src-electron/session/session-approval-service.ts" }
// fault = "abort後も承認Promiseが未解決か承認待ち表示が残る"
// observable = "返却decisionとlive approvalRequest"
// observation_boundary = "consumer"
// scope = "SessionApprovalServiceの要求取消"
// lifecycle = "permanent"
// impact = "取消済み処理が承認待機のまま終了できない"
// distinction = "通常の承認解決とは異なるsignal経路での後片付けを確認する"
// @end-test-value
test("SessionApprovalService は abort 時に deny を返す", async () => {
  let state = createLiveRunState();
  const controller = new AbortController();
  const service = new SessionApprovalService({
    updateLiveSessionRun: (_sessionId, recipe) => {
      state = recipe(state);
      return state;
    },
  });

  const waitPromise = service.waitForLiveApprovalDecision(
    "session-1",
    {
      requestId: "req-2",
      provider: "copilot",
      kind: "tool",
      title: "approval",
      summary: "need approval",
      decisionMode: "direct-decision",
    },
    controller.signal,
  );

  controller.abort();
  assert.equal(await waitPromise, "deny");
  assert.equal(state.approvalRequest, null);
});

// @test-value v2
// kind = "contract"
// claim = "live承認要求の公開で通知し、approve・deny・abort・resetで対応通知を撤去する。配送や撤去失敗でもdecisionを返す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#windows-session-notifications" }
// fault = "公開前に通知する、承認解決後も通知を残す、または通知失敗で承認Promiseを中断する"
// observable = "公開済みrequest ID、通知show/close回数、返却decisionとlive approvalRequest"
// observation_boundary = "consumer"
// scope = "SessionApprovalServiceとSessionTurnNotificationServiceのlifecycle接続"
// lifecycle = "permanent"
// impact = "操作済み要求の通知が残るか、通知障害でProviderがユーザー判断を受け取れない"
// distinction = "両serviceの単体testだけではrequest公開と通知signalの有効期間の接続を確認できない"
// @end-test-value
test("承認公開から解決までを通知の有効期間とし通知失敗を判断へ伝播させない", async () => {
  for (const settlement of ["approve", "deny", "abort", "reset"] as const) {
    for (const failure of ["none", "show", "close"] as const) {
      let state = createLiveRunState();
      let shown = 0;
      let closed = 0;
      const session = buildNewSession({
        taskTitle: "Approval lifecycle", workspaceLabel: "workspace", workspacePath: "C:/workspace", branch: "main",
        characterId: "mate", character: "Mate", characterIconPath: "", characterThemeColors: { main: "#223344", sub: "#88bbcc" },
        approvalMode: "on-request",
      });
      const notificationService = new SessionTurnNotificationService({
        platform: "win32", isNotificationSupported: () => true,
        isNotificationEnabled: () => false, isApprovalNotificationEnabled: () => true,
        isResponsePreviewEnabled: () => false, isSessionWindowOpen: () => true,
        isSessionWindowFocused: () => false, loadCharacterIcon: () => null,
        createNotification: () => ({
          show: () => { shown += 1; if (failure === "show") throw new Error("delivery failed"); },
          close: () => { closed += 1; if (failure === "close") throw new Error("dismissal failed"); },
          onClick: () => {}, onClose: () => {}, onFailed: () => {},
        }),
        getSession: () => session, openSessionWindow: () => {}, openAuxiliarySessionWindow: () => {},
        openHomeWindow: () => {}, logWarning: () => {},
      });
      const deliveries: Promise<boolean>[] = [];
      const service = new SessionApprovalService({
        updateLiveSessionRun: (_id, recipe) => { state = recipe(state); return state; },
        notifyApproval: (_id, requestId, signal) => {
          assert.equal(state.approvalRequest?.requestId, requestId);
          deliveries.push(notificationService.notifyApproval(session, requestId, signal));
        },
      });
      const controller = new AbortController();
      const pending = service.waitForLiveApprovalDecision("session-1", {
        requestId: "approval", provider: "copilot", kind: "tool", title: "Permission",
        summary: "Private command", decisionMode: "direct-decision",
      }, controller.signal);
      await Promise.all(deliveries);
      assert.equal(shown, 1);
      if (settlement === "abort") controller.abort();
      else if (settlement === "reset") service.reset();
      else service.resolveLiveApproval("session-1", "approval", settlement);
      assert.equal(await pending, settlement === "approve" ? "approve" : "deny");
      assert.equal(state.approvalRequest, null);
      assert.equal(closed, failure === "show" ? 0 : 1);
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "未公開要求は通知せず、通知hookの例外でも公開済み承認要求の操作を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#windows-session-notifications" }
// fault = "live stateが存在しない要求を通知するか通知hook例外でdecision待機を壊す"
// observable = "通知callback回数、live要求とapproveの返却値"
// observation_boundary = "public-boundary"
// scope = "SessionApprovalService notification publication and failure boundary"
// lifecycle = "permanent"
// impact = "操作できない要求へ通知されるかProviderに承認判断が返らない"
// distinction = "通知service内部の配送失敗とは異なる、公開境界のhook例外を検証する"
// @end-test-value
test("未公開の承認を通知せずhook例外でも公開済みの判断を受け付ける", async () => {
  for (const publish of [false, true]) {
    let state = createLiveRunState();
    let notifications = 0;
    const service = new SessionApprovalService({
      updateLiveSessionRun: (_id, recipe) => publish ? (state = recipe(state)) : null,
      notifyApproval: () => { notifications += 1; throw new Error("notification hook failed"); },
    });
    const pending = service.waitForLiveApprovalDecision("session-1", {
      requestId: "approval", provider: "codex", kind: "tool", title: "Permission",
      summary: "Request", decisionMode: "direct-decision",
    }, new AbortController().signal);
    assert.equal(notifications, publish ? 1 : 0);
    service.resolveLiveApproval("session-1", "approval", "approve");
    assert.equal(await pending, "approve");
    assert.equal(state.approvalRequest, null);
  }
});
