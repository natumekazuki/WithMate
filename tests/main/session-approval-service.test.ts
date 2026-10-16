import assert from "node:assert/strict";
import test from "node:test";

import { SessionApprovalService } from "../../src-electron/session/session-approval-service.js";
import type { LiveApprovalRequest, LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
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

function approval(requestId: string): LiveApprovalRequest {
  return { requestId, provider: "copilot", kind: "tool", title: "Permission", summary: requestId, decisionMode: "direct-decision" };
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

// @test-value v2
// kind = "contract"
// claim = "会話ごとのFIFO先頭だけを公開・通知し、重複要求は同じdecisionを共有し別会話は独立に解決する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#sessionapprovalservice" }
// fault = "後続要求が先頭のresolverを上書きするか、重複callbackを取り残すか、別会話の判断を混ぜる"
// observable = "live request ID、公開・通知列、共有Promise、全callbackのdecisionとstale応答拒否"
// observation_boundary = "public-boundary"
// scope = "SessionApprovalServiceの会話別FIFOと重複要求"
// lifecycle = "permanent"
// impact = "Provider callbackが未解決になるか未表示の別要求を承認する"
// distinction = "単一要求testでは同時要求の保持順序と全callbackの決着を確認できない"
// risk_tags = ["authorization"]
// @end-test-value
test("承認FIFOは重複callbackの判断を共有しMainとAuxを独立に進める", async () => {
  const states = new Map(["main", "aux"].map((id) => [id, { ...createLiveRunState(), sessionId: id }]));
  const published: string[] = [];
  const notified: Array<{ id: string; signal: AbortSignal }> = [];
  const service = new SessionApprovalService({
    updateLiveSessionRun: (id, recipe) => {
      const next = recipe(states.get(id)!);
      states.set(id, next);
      published.push(`${id}:${next.approvalRequest?.requestId ?? "none"}`);
      return next;
    },
    notifyApproval: (_id, id, signal) => { notified.push({ id, signal }); },
  });
  const first = service.waitForLiveApprovalDecision("main", approval("first"), new AbortController().signal);
  const second = service.waitForLiveApprovalDecision("main", approval("second"), new AbortController().signal);
  const queuedDuplicate = service.waitForLiveApprovalDecision("main", approval("second"), new AbortController().signal);
  const duplicate = service.waitForLiveApprovalDecision("main", approval("first"), new AbortController().signal);
  const auxiliary = service.waitForLiveApprovalDecision("aux", approval("auxiliary"), new AbortController().signal);
  assert.equal(first, duplicate);
  assert.equal(second, queuedDuplicate);
  assert.deepEqual(published, ["main:first", "aux:auxiliary"]);
  assert.deepEqual(notified.map((item) => item.id), ["first", "auxiliary"]);
  assert.throws(() => service.resolveLiveApproval("main", "second", "approve"), /no longer exists/);
  service.resolveLiveApproval("main", "first", "approve");
  assert.equal(states.get("main")!.approvalRequest?.requestId, "second");
  assert.deepEqual(published, ["main:first", "aux:auxiliary", "main:second"]);
  assert.equal(notified[0].signal.aborted, true);
  assert.equal(notified[2].signal.aborted, false);
  assert.throws(() => service.resolveLiveApproval("main", "first", "approve"), /no longer exists/);
  service.resolveLiveApproval("aux", "auxiliary", "deny");
  assert.equal(states.get("main")!.approvalRequest?.requestId, "second");
  service.resolveLiveApproval("main", "second", "deny");
  assert.deepEqual(await Promise.all([first, duplicate, second, queuedDuplicate, auxiliary]), ["approve", "approve", "deny", "deny", "deny"]);
  assert.ok([...states.values()].every((state) => state.approvalRequest === null));
  assert.ok(notified.every((item) => item.signal.aborted));
});

// @test-value v2
// kind = "contract"
// claim = "個別abortは対象要求だけを失効させ、待機中要求を表示せず先頭取消後は次の有効要求へ進む"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#sessionapprovalservice" }
// fault = "待機中の取消が先頭を消すか、取消済み要求を通知するか、古いsignalが後続要求を失効させる"
// observable = "各要求のdecision、live request、通知された要求列と通知signal"
// observation_boundary = "public-boundary"
// scope = "SessionApprovalServiceのqueued/head abortと重複signal cleanup"
// lifecycle = "permanent"
// impact = "不要になった操作を承認させるか有効な後続処理を停止する"
// distinction = "共有turn取消とは異なる個別要求の取消と残るFIFOを検証する"
// @end-test-value
test("個別abortはqueued要求と重複先頭だけを取消し後続通知へ干渉しない", async () => {
  let state = createLiveRunState();
  const notifications: Array<{ id: string; signal: AbortSignal }> = [];
  const service = new SessionApprovalService({
    updateLiveSessionRun: (_id, recipe) => (state = recipe(state)),
    notifyApproval: (_id, id, signal) => { notifications.push({ id, signal }); },
  });
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const first = service.waitForLiveApprovalDecision("session-1", approval("first"), controllers[0].signal);
  const queued = service.waitForLiveApprovalDecision("session-1", approval("queued"), controllers[1].signal);
  const next = service.waitForLiveApprovalDecision("session-1", approval("next"), controllers[2].signal);
  const duplicate = service.waitForLiveApprovalDecision("session-1", approval("first"), controllers[3].signal);
  controllers[1].abort();
  assert.equal(await queued, "deny");
  assert.equal(state.approvalRequest?.requestId, "first");
  assert.deepEqual(notifications.map((item) => item.id), ["first"]);
  controllers[3].abort();
  assert.deepEqual(await Promise.all([first, duplicate]), ["deny", "deny"]);
  assert.equal(state.approvalRequest?.requestId, "next");
  assert.deepEqual(notifications.map((item) => item.id), ["first", "next"]);
  controllers[0].abort();
  assert.equal(state.approvalRequest?.requestId, "next");
  assert.equal(notifications[1].signal.aborted, false);
  service.resolveLiveApproval("session-1", "next", "approve");
  assert.equal(await next, "approve");
  assert.equal(state.approvalRequest, null);
});

// @test-value v2
// kind = "contract"
// claim = "会話取消・共有signal abort・全体resetは全待機をdenyで回収し後続を公開・通知しない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#sessionapprovalservice" }
// fault = "終了処理が先頭だけを解決して待機Promiseを残すか終了途中の後続要求を公開する"
// observable = "全callbackのdecision、会話別live request、公開と通知の要求列"
// observation_boundary = "public-boundary"
// scope = "SessionApprovalServiceの会話取消とreset"
// lifecycle = "permanent"
// impact = "取消したProvider処理が終了せず、失効要求への通知が残る"
// distinction = "通常の先頭解決と個別abortで保証しない一括終了を検証する"
// @end-test-value
test("会話取消とresetは全承認を通知せず回収し次の会話利用を妨げない", async () => {
  for (const action of ["cancel", "abort", "reset"] as const) {
    const states = new Map(["main", "aux"].map((id) => [id, { ...createLiveRunState(), sessionId: id }]));
    const published: string[] = [];
    const notified: string[] = [];
    const service = new SessionApprovalService({
      updateLiveSessionRun: (id, recipe) => {
        const next = recipe(states.get(id)!);
        states.set(id, next);
        if (next.approvalRequest) published.push(next.approvalRequest.requestId);
        return next;
      },
      notifyApproval: (_id, id) => { notified.push(id); },
    });
    const controller = new AbortController();
    const pending = ["first", "second", "third"].map((id) => service.waitForLiveApprovalDecision("main", approval(id), controller.signal));
    const other = service.waitForLiveApprovalDecision("aux", approval("other"), new AbortController().signal);
    if (action === "cancel") service.cancelSession("main");
    else if (action === "abort") controller.abort();
    else service.reset();
    assert.deepEqual(await Promise.all(pending), ["deny", "deny", "deny"]);
    assert.equal(states.get("main")!.approvalRequest, null);
    assert.deepEqual(published, ["first", "other"]);
    assert.deepEqual(notified, ["first", "other"]);
    if (action !== "reset") {
      assert.equal(states.get("aux")!.approvalRequest?.requestId, "other");
      service.cancelSession("aux");
    }
    assert.equal(await other, "deny");
    assert.equal(states.get("aux")!.approvalRequest, null);
    controller.abort();
    service.cancelSession("main");
    service.reset();
    const alreadyCanceled = service.waitForLiveApprovalDecision("main", approval("expired"), controller.signal);
    assert.equal(await alreadyCanceled, "deny");
    const fresh = service.waitForLiveApprovalDecision("main", approval("fresh"), new AbortController().signal);
    service.resolveLiveApproval("main", "fresh", "approve");
    assert.equal(await fresh, "approve");
  }
});

// @test-value v2
// kind = "contract"
// claim = "既にabortされた同一identityの重複callbackも元の待機と判断を共有し該当要求だけをdenyで失効させる"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#sessionapprovalservice" }
// fault = "重複だけdenyを返して元の要求を後からapproveできるか、queued取消が別の先頭を消す"
// observable = "重複Promise同一性、全callbackのdecision、live request、通知要求列"
// observation_boundary = "public-boundary"
// scope = "SessionApprovalServiceのhead/queued要求への事前abort済み重複"
// lifecycle = "permanent"
// impact = "一つのProvider要求へ矛盾する認可結果を返すか有効な別要求を停止させる"
// distinction = "新規要求の事前abortとjoin後abortでは検出できないidentity再入時の失効を確認する"
// risk_tags = ["authorization"]
// @end-test-value
test("事前abort済みの重複要求はheadとqueuedの共有判断をdenyで失効させる", async () => {
  for (const target of ["first", "second"]) {
    let state = createLiveRunState();
    const notified: string[] = [];
    const service = new SessionApprovalService({
      updateLiveSessionRun: (_id, recipe) => (state = recipe(state)),
      notifyApproval: (_id, id) => { notified.push(id); },
    });
    const first = service.waitForLiveApprovalDecision("session-1", approval("first"), new AbortController().signal);
    const second = service.waitForLiveApprovalDecision("session-1", approval("second"), new AbortController().signal);
    const aborted = new AbortController();
    aborted.abort();
    const duplicate = service.waitForLiveApprovalDecision("session-1", approval(target), aborted.signal);
    assert.equal(duplicate, target === "first" ? first : second);
    assert.equal(await duplicate, "deny");
    const remaining = target === "first" ? "second" : "first";
    assert.equal(state.approvalRequest?.requestId, remaining);
    assert.deepEqual(notified, target === "first" ? ["first", "second"] : ["first"]);
    assert.throws(() => service.resolveLiveApproval("session-1", target, "approve"), /no longer exists/);
    service.resolveLiveApproval("session-1", remaining, "approve");
    assert.deepEqual(await Promise.all([first, second, duplicate]), target === "first" ? ["deny", "approve", "deny"] : ["approve", "deny", "deny"]);
    assert.equal(state.approvalRequest, null);
  }
});
