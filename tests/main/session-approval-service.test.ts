import assert from "node:assert/strict";
import test from "node:test";

import { SessionApprovalService } from "../../src-electron/session/session-approval-service.js";
import type { ApprovalDecisionSource } from "../../src-electron/providers/provider-runtime.js";
import type {
  LiveApprovalRequest,
  LiveSessionRunState,
} from "../../src-shared/session/runtime-state.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { SessionTurnNotificationService } from "../../src-electron/session/session-turn-notification-service.js";

/** 承認も質問も保持していない実行状態を一件作る。 */
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

/** 重複時に ID で対応を比較できるよう、直接判断型の承認要求を用意する。 */
function approval(requestId: string): LiveApprovalRequest {
  return {
    requestId,
    provider: "copilot",
    kind: "tool",
    title: "Permission",
    summary: requestId,
    decisionMode: "direct-decision",
  };
}

/** 待機要求が表示状態に出て、手動承認の確定後に消えることを確かめる。 */
test("SessionApprovalService は承認待ちを live run に反映し、resolve 後に片付ける", async () => {
  let state = createLiveRunState();
  const service = new SessionApprovalService({
    /** サービスの公開更新を、テスト側で確認できる実行状態へ適用する。 */
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
/** 実行の中止信号だけで承認を拒否し、画面に待機を残さないことを確かめる。 */
test("SessionApprovalService は abort 時に deny を返す", async () => {
  let state = createLiveRunState();
  const controller = new AbortController();
  const service = new SessionApprovalService({
    /** 中止時の表示解除を観測できるよう、同じ実行状態を更新する。 */
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
/** 表示後だけ通知し、解決経路や OS 通知の成否にかかわらず本来の判断を返す。 */
test("承認公開から解決までを通知の有効期間とし通知失敗を判断へ伝播させない", async () => {
  for (const settlement of ["approve", "deny", "abort", "reset"] as const) {
    for (const failure of ["none", "show", "close"] as const) {
      let state = createLiveRunState();
      let shown = 0;
      let closed = 0;
      const session = buildNewSession({
        taskTitle: "Approval lifecycle",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "mate",
        character: "Mate",
        characterIconPath: "",
        characterThemeColors: { main: "#223344", sub: "#88bbcc" },
        approvalMode: "on-request",
      });
      const notificationService = new SessionTurnNotificationService({
        platform: "win32",
        /** テストプラットフォーム上で通知機能が使える前提にする。 */ isNotificationSupported:
          () => true,
        /** 通常の応答通知を無効にして、承認通知だけを検証する。 */
        isNotificationEnabled: () => false,
        /** 一般通知の設定とは別に、承認通知を有効にする。 */ isApprovalNotificationEnabled:
          () => true,
        /** 通知本文に応答のプレビューを付けない。 */
        isResponsePreviewEnabled: () => false,
        /** 会話ウィンドウは既に開かれている状態にする。 */ isSessionWindowOpen:
          () => true,
        /** 対象ウィンドウが前面ではないため、通知を表示できる状態にする。 */
        isSessionWindowFocused: () => false,
        /** 通知アイコンのファイル取得を省略する。 */ loadCharacterIcon: () =>
          null,
        /** 表示と撤去それぞれの例外を注入できる通知を用意する。 */
        createNotification: () => ({
          /** 表示回数を記録し、配送に失敗するケースでは例外を送出する。 */
          show: () => {
            shown += 1;
            if (failure === "show") throw new Error("delivery failed");
          },
          /** 撤去回数を記録し、撤去自体が失敗する経路も再現する。 */
          close: () => {
            closed += 1;
            if (failure === "close") throw new Error("dismissal failed");
          },
          /** 通知をクリックする経路はこの検証では使わない。 */
          onClick: () => {},
          /** OS 経由の閉じるイベントは発火させない。 */ onClose: () => {},
          /** 失敗イベントの代わりに表示と撤去の呼び出しから例外を発生させる。 */ onFailed:
            () => {},
        }),
        /** 承認の対象として同じ保存会話を返す。 */
        getSession: () => session,
        /** 通知から Main の画面を開く操作は模擬せず、通知の寿命に絞る。 */ openSessionWindow:
          () => {},
        /** Auxiliary の画面を開く副作用は持たせない。 */ openAuxiliarySessionWindow:
          () => {},
        /** Home を開く実際の UI 操作は行わない。 */
        openHomeWindow: () => {},
        /** 通知障害を想定した試験中は警告を外へ出さない。 */ logWarning:
          () => {},
      });
      const deliveries: Promise<boolean>[] = [];
      const service = new SessionApprovalService({
        /** 承認の公開済み状態を、通知コールバックから参照できるようにする。 */
        updateLiveSessionRun: (_id, recipe) => {
          state = recipe(state);
          return state;
        },
        /** 公開された ID を確認したうえで、実際の通知サービスへ同じ寿命の信号を渡す。 */
        notifyApproval: (_id, requestId, signal) => {
          assert.equal(state.approvalRequest?.requestId, requestId);
          deliveries.push(
            notificationService.notifyApproval(session, requestId, signal),
          );
        },
      });
      const controller = new AbortController();
      const pending = service.waitForLiveApprovalDecision(
        "session-1",
        {
          requestId: "approval",
          provider: "copilot",
          kind: "tool",
          title: "Permission",
          summary: "Private command",
          decisionMode: "direct-decision",
        },
        controller.signal,
      );
      await Promise.all(deliveries);
      assert.equal(shown, 1);
      if (settlement === "abort") controller.abort();
      else if (settlement === "reset") service.reset();
      else service.resolveLiveApproval("session-1", "approval", settlement);
      assert.equal(
        await pending,
        settlement === "approve" ? "approve" : "deny",
      );
      assert.equal(state.approvalRequest, null);
      assert.equal(closed, failure === "show" ? 0 : 1);
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "従来nativeの未公開要求は通知せず、observerの有無・障害で戻り値を変えない。公開済み本人応答だけmanualと報告する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#windows-session-notifications; docs/design/session-run-lifecycle.md#sessionapprovalservice" }
// fault = "未公開を通知・manual扱いするか、observerの有無・通知や観測hookの例外で従来の承認を失う"
// observable = "通知callback回数、live要求、approveの返却値とmanual／blocked報告"
// observation_boundary = "public-boundary"
// scope = "SessionApprovalService notification publication and failure boundary"
// lifecycle = "permanent"
// impact = "操作できない要求へ通知されるかProviderに承認判断が返らない"
// distinction = "通知service内部の配送失敗とは異なる、公開境界のhook例外を検証する"
// @end-test-value
/** 公開されなかった旧形式の要求は通知せず、観測フックに失敗しても判断は返す。 */
test("未公開の承認を通知せずhook例外でも公開済みの判断を受け付ける", async () => {
  for (const [publish, observe] of [
    [false, false],
    [false, true],
    [true, true],
  ] as const) {
    let state = createLiveRunState();
    let notifications = 0;
    const sources: ApprovalDecisionSource[] = [];
    const service = new SessionApprovalService({
      /** ケースに応じて表示更新を拒み、サービスが公開の成否を区別できるようにする。 */
      updateLiveSessionRun: (_id, recipe) =>
        publish ? (state = recipe(state)) : null,
      /** 通知が試みられた回数を数え、公開済みでも通知側は失敗し得る状況を作る。 */
      notifyApproval: () => {
        notifications += 1;
        throw new Error("notification hook failed");
      },
    });
    const pending = service.waitForLiveApprovalDecision(
      "session-1",
      {
        requestId: "approval",
        provider: "codex",
        kind: "tool",
        title: "Permission",
        summary: "Request",
        decisionMode: "direct-decision",
      },
      new AbortController().signal,
      undefined,
      observe
        ? (source) => {
            sources.push(source);
            throw new Error("decision observer failed");
          }
        : undefined,
    );
    assert.equal(notifications, publish ? 1 : 0);
    service.resolveLiveApproval("session-1", "approval", "approve");
    assert.equal(await pending, "approve");
    assert.deepEqual(sources, observe ? [publish ? "manual" : "blocked"] : []);
    assert.equal(state.approvalRequest, null);
  }
});

// @test-value v2
// kind = "contract"
// claim = "会話ごとのFIFO先頭だけを公開・通知し、重複要求は同じdecisionとsourceを共有し別会話は独立に解決する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#sessionapprovalservice" }
// fault = "後続が先頭を上書きする、同じobserverへのsourceが重複する／別observerが結果を得られない、または別会話の判断を混ぜる"
// observable = "live request ID、公開・通知列、共有Promise、全callbackのdecision、各observerのsource、stale応答拒否"
// observation_boundary = "public-boundary"
// scope = "SessionApprovalServiceの会話別FIFOと重複要求"
// lifecycle = "permanent"
// impact = "Provider callbackが未解決になるか未表示の別要求を承認する"
// distinction = "単一要求testでは同時要求の保持順序と全callbackの決着を確認できない"
// risk_tags = ["authorization"]
// @end-test-value
/** 会話ごとに先頭だけを公開し、重複した待機だけが同じ判断と通知元を共有する。 */
test("承認FIFOは重複callbackの判断を共有しMainとAuxを独立に進める", async () => {
  const states = new Map(
    ["main", "aux"].map((id) => [
      id,
      { ...createLiveRunState(), sessionId: id },
    ]),
  );
  const published: string[] = [];
  const notified: Array<{ id: string; signal: AbortSignal }> = [];
  const service = new SessionApprovalService({
    /** Main と Auxiliary の状態を分け、公開された順序を会話 ID とともに保存する。 */
    updateLiveSessionRun: (id, recipe) => {
      const next = recipe(states.get(id)!);
      states.set(id, next);
      published.push(`${id}:${next.approvalRequest?.requestId ?? "none"}`);
      return next;
    },
    /** 通知された要求と信号を保存し、先頭交代で古い通知が失効したか調べる。 */
    notifyApproval: (_id, id, signal) => {
      notified.push({ id, signal });
    },
  });
  const sources: string[] = [];
  /** 同じ観測先の重複登録と、観測後に拒否された非同期処理の影響を確かめる。 */
  const firstObserver = async (source: ApprovalDecisionSource) => {
    sources.push(`first:${source}`);
    throw new Error("observer rejected");
  };
  const first = service.waitForLiveApprovalDecision(
    "main",
    approval("first"),
    new AbortController().signal,
    undefined,
    firstObserver,
  );
  const second = service.waitForLiveApprovalDecision(
    "main",
    approval("second"),
    new AbortController().signal,
    undefined,
    (source) => {
      sources.push(`second:${source}`);
    },
  );
  const queuedDuplicate = service.waitForLiveApprovalDecision(
    "main",
    approval("second"),
    new AbortController().signal,
    undefined,
    (source) => {
      sources.push(`queued-duplicate:${source}`);
    },
  );
  const duplicate = service.waitForLiveApprovalDecision(
    "main",
    approval("first"),
    new AbortController().signal,
    undefined,
    firstObserver,
  );
  const auxiliary = service.waitForLiveApprovalDecision(
    "aux",
    approval("auxiliary"),
    new AbortController().signal,
  );
  assert.equal(first, duplicate);
  assert.equal(second, queuedDuplicate);
  assert.deepEqual(published, ["main:first", "aux:auxiliary"]);
  assert.deepEqual(
    notified.map((item) => item.id),
    ["first", "auxiliary"],
  );
  assert.deepEqual(sources, []);
  assert.throws(
    () => service.resolveLiveApproval("main", "second", "approve"),
    /no longer exists/,
  );
  service.resolveLiveApproval("main", "first", "approve");
  assert.equal(states.get("main")!.approvalRequest?.requestId, "second");
  assert.deepEqual(published, ["main:first", "aux:auxiliary", "main:second"]);
  assert.equal(notified[0].signal.aborted, true);
  assert.equal(notified[2].signal.aborted, false);
  assert.throws(
    () => service.resolveLiveApproval("main", "first", "approve"),
    /no longer exists/,
  );
  service.resolveLiveApproval("aux", "auxiliary", "deny");
  assert.equal(states.get("main")!.approvalRequest?.requestId, "second");
  service.resolveLiveApproval("main", "second", "deny");
  assert.deepEqual(
    await Promise.all([first, duplicate, second, queuedDuplicate, auxiliary]),
    ["approve", "approve", "deny", "deny", "deny"],
  );
  assert.deepEqual(sources, [
    "first:manual",
    "second:manual",
    "queued-duplicate:manual",
  ]);
  assert.ok(
    [...states.values()].every((state) => state.approvalRequest === null),
  );
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
/** 取消対象以外の先頭を守り、古い信号が次の通知に影響しないことを確かめる。 */
test("個別abortはqueued要求と重複先頭だけを取消し後続通知へ干渉しない", async () => {
  let state = createLiveRunState();
  const notifications: Array<{ id: string; signal: AbortSignal }> = [];
  const service = new SessionApprovalService({
    /** 取消後の表示から、次に有効な先頭が選ばれたかを観測する。 */
    updateLiveSessionRun: (_id, recipe) => (state = recipe(state)),
    /** 取消済み要求が通知されていないことと、現行の通知が生きていることを調べる。 */
    notifyApproval: (_id, id, signal) => {
      notifications.push({ id, signal });
    },
  });
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const first = service.waitForLiveApprovalDecision(
    "session-1",
    approval("first"),
    controllers[0].signal,
  );
  const queued = service.waitForLiveApprovalDecision(
    "session-1",
    approval("queued"),
    controllers[1].signal,
  );
  const next = service.waitForLiveApprovalDecision(
    "session-1",
    approval("next"),
    controllers[2].signal,
  );
  const duplicate = service.waitForLiveApprovalDecision(
    "session-1",
    approval("first"),
    controllers[3].signal,
  );
  controllers[1].abort();
  assert.equal(await queued, "deny");
  assert.equal(state.approvalRequest?.requestId, "first");
  assert.deepEqual(
    notifications.map((item) => item.id),
    ["first"],
  );
  controllers[3].abort();
  assert.deepEqual(await Promise.all([first, duplicate]), ["deny", "deny"]);
  assert.equal(state.approvalRequest?.requestId, "next");
  assert.deepEqual(
    notifications.map((item) => item.id),
    ["first", "next"],
  );
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
/** 会話単位の中止や全体リセットで待機をすべて回収し、終了途中の候補を公開しない。 */
test("会話取消とresetは全承認を通知せず回収し次の会話利用を妨げない", async () => {
  for (const action of ["cancel", "abort", "reset"] as const) {
    const states = new Map(
      ["main", "aux"].map((id) => [
        id,
        { ...createLiveRunState(), sessionId: id },
      ]),
    );
    const published: string[] = [];
    const notified: string[] = [];
    const service = new SessionApprovalService({
      /** 会話ごとの状態を更新し、終了中に新たに公開された要求がないかを記録する。 */
      updateLiveSessionRun: (id, recipe) => {
        const next = recipe(states.get(id)!);
        states.set(id, next);
        if (next.approvalRequest)
          published.push(next.approvalRequest.requestId);
        return next;
      },
      /** 公開済みの要求だけが通知されたことを記録から確認する。 */
      notifyApproval: (_id, id) => {
        notified.push(id);
      },
    });
    const controller = new AbortController();
    const pending = ["first", "second", "third"].map((id) =>
      service.waitForLiveApprovalDecision(
        "main",
        approval(id),
        controller.signal,
      ),
    );
    const other = service.waitForLiveApprovalDecision(
      "aux",
      approval("other"),
      new AbortController().signal,
    );
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
    const alreadyCanceled = service.waitForLiveApprovalDecision(
      "main",
      approval("expired"),
      controller.signal,
    );
    assert.equal(await alreadyCanceled, "deny");
    const fresh = service.waitForLiveApprovalDecision(
      "main",
      approval("fresh"),
      new AbortController().signal,
    );
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
/** 既に中止された同一要求が加わると、その共有判断だけを拒否で確定する。 */
test("事前abort済みの重複要求はheadとqueuedの共有判断をdenyで失効させる", async () => {
  for (const target of ["first", "second"]) {
    let state = createLiveRunState();
    const notified: string[] = [];
    const service = new SessionApprovalService({
      /** 中止対象に応じて公開中の要求が残るか交代するかを確認できるようにする。 */
      updateLiveSessionRun: (_id, recipe) => (state = recipe(state)),
      /** 対象が先頭か待機中かによって通知列が変わるので、要求 ID を記録する。 */
      notifyApproval: (_id, id) => {
        notified.push(id);
      },
    });
    const first = service.waitForLiveApprovalDecision(
      "session-1",
      approval("first"),
      new AbortController().signal,
    );
    const second = service.waitForLiveApprovalDecision(
      "session-1",
      approval("second"),
      new AbortController().signal,
    );
    const aborted = new AbortController();
    aborted.abort();
    const duplicate = service.waitForLiveApprovalDecision(
      "session-1",
      approval(target),
      aborted.signal,
    );
    assert.equal(duplicate, target === "first" ? first : second);
    assert.equal(await duplicate, "deny");
    const remaining = target === "first" ? "second" : "first";
    assert.equal(state.approvalRequest?.requestId, remaining);
    assert.deepEqual(
      notified,
      target === "first" ? ["first", "second"] : ["first"],
    );
    assert.throws(
      () => service.resolveLiveApproval("session-1", target, "approve"),
      /no longer exists/,
    );
    service.resolveLiveApproval("session-1", remaining, "approve");
    assert.deepEqual(
      await Promise.all([first, second, duplicate]),
      target === "first"
        ? ["deny", "approve", "deny"]
        : ["approve", "deny", "deny"],
    );
    assert.equal(state.approvalRequest, null);
  }
});
