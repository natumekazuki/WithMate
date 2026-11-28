import assert from "node:assert/strict";
import test from "node:test";

import { WindowBroadcastService } from "../../src-electron/windows/window-broadcast-service.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";

/** 生存または破棄済みの窓を模し、受け取った IPC のチャンネルと内容を記録する。 */
function createWindow(destroyed = false) {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    window: {
      /** 作成時に選んだ破棄状態を返し、配信対象からの除外を試せるようにする。 */
      isDestroyed: () => destroyed,
      webContents: {
        /** IPC を実送信せず、配送先ごとの通知と payload を順に記録する。 */
        send: (channel: string, payload: unknown) => {
          sent.push({ channel, payload });
        },
      },
    },
    sent,
  };
}

// @test-value v2
// kind = "contract"
// claim = "送信元の無効化は指定されたMainまたはAux所属MainのWindowだけへ送信元IDで配信し、宛先queue通知の範囲を変えない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details; https://github.com/natumekazuki/WithMate/issues/966" }
// fault = "送信元Windowへの通知がなく一覧が更新されない、Auxの所属Mainを誤る、Home・他Windowへ送信情報を配る"
// observable = "実broadcast serviceから各Windowが受け取ったchannelとpayload"
// observation_boundary = "public-boundary"
// scope = "送信元invalidationと宛先queue eventのWindow routing"
// lifecycle = "permanent"
// impact = "新しい指示が送信元で欠落するか、無関係なWindowへ送信先情報が漏れる"
// distinction = "hookのfixture通知ではMainの実routingを検証できず、型検査は誤ったbroadcast先を検出しない。固定3Windowで低コストに境界を確認する"
// @end-test-value
/** 宛先キューの通知先は変えず、送信元の変更を Main または所属 Main にだけ元の送信元 ID で配信することを確認する。 */
test("outgoing invalidation targets only the source owner without changing queue routing", () => {
  const sender = createWindow(),
    recipient = createWindow(),
    other = createWindow();
  const service = new WindowBroadcastService({
    /** 誤って全窓へ配信した場合も検出できるよう、送信元・宛先・無関係の窓を返す。 */
    getAllWindows: () => [sender.window, recipient.window, other.window],
    /** Home 系に無関係な窓を登録し、送信元の通知が漏れないことを試す。 */
    getHomeWindows: () => [other.window],

    /** メイン Home を無関係な窓に割り当てる。 */
    getPrimaryHomeWindow: () => other.window,
    /** キュー通知の所有者になり得る二つのセッション窓を返す。 */
    getSessionWindows: () => [sender.window, recipient.window],
    /** 軽量の実行状態向けに登録された窓はないものとする。 */
    getLiveSessionRunStatusWindows: () => [],
    /** セッション ID から送信元または宛先窓を選び、終了済みの送信元には窓を返さない。 */
    getLiveSessionRunWindow: (id) =>
      id === "source"
        ? sender.window
        : id === "recipient"
          ? recipient.window
          : null,
  });
  service.broadcastSessionTurnQueueChanged("recipient");
  service.broadcastSessionSentDeliveriesChanged("source");
  service.broadcastSessionSentDeliveriesChanged("source-aux", "source");
  service.broadcastSessionSentDeliveriesChanged("closed-source");
  assert.deepEqual(
    sender.sent,
    ["source", "source-aux"].map((payload) => ({
      channel: "withmate:session-sent-deliveries-changed",
      payload,
    })),
  );
  assert.deepEqual(recipient.sent, [
    { channel: "withmate:session-turn-queue-changed", payload: "recipient" },
  ]);
  assert.deepEqual(other.sent, []);
});

// @test-value v2
// kind = "invariant"
// claim = "到達不能Rendererをskipし、軽量通知の送信例外と診断例外を隔離して他Windowとownerへlive通知を配信する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#decision" }
// fault = "到達不能Rendererへ送信するか、一つの送信失敗がMainのpublicationをthrowで中断する"
// observable = "live run通知の配信payload、到達不能Windowの送信数、送信失敗通知数、publicationの例外"
// observation_boundary = "public-boundary"
// scope = "window-broadcast-renderer-failure-isolation"
// lifecycle = "permanent"
// impact = "表示障害が他Windowの状態更新とMain所有のprovider進行を妨げる"
// distinction = "用途別routing testと型検査では観測できない実send例外の伝播を三つの小さいWindowで検証する"
// @end-test-value
/** 到達不能な窓を除外し、送信と診断が例外を出しても正常な窓への状態通知と所有窓への詳細通知が継続することを確かめる。 */
test("WindowBroadcastServiceはRenderer送信失敗を隔離して他Windowへ配信する", () => {
  const unreachable = createWindow();
  const broken = createWindow();
  const healthy = createWindow();
  let failures = 0;
  broken.window.webContents.send = () => {
    throw new TypeError("Object has been destroyed");
  };
  const service = new WindowBroadcastService({
    /** 配信不能・送信失敗・正常という三つの窓を同時に返す。 */
    getAllWindows: () => [unreachable.window, broken.window, healthy.window],
    /** 配信失敗の試験では Home グループに窓を登録しない。 */
    getHomeWindows: () => [],
    /** 主要 Home がない状態で配信の例外分離を試す。 */
    getPrimaryHomeWindow: () => null,
    /** 実行詳細の送信先は所有者の解決に限り、セッション窓一覧は供給しない。 */
    getSessionWindows: () => [],
    /** 軽量通知の配信先に、正常に送れない窓も含める。 */
    getLiveSessionRunStatusWindows: () => [
      unreachable.window,
      broken.window,
      healthy.window,
    ],
    /** 正常な窓を実行詳細を受け取る所有者にする。 */
    getLiveSessionRunWindow: () => healthy.window,
    /** 到達不能とした窓だけを送信前の判定で除外する。 */
    canSendToWindow: (window) => window !== unreachable.window,
    /** 送信失敗を数え、診断処理自身の例外が配信を止めないか試す。 */
    onSendFailed: () => {
      failures += 1;
      throw new Error("diagnostics failed");
    },
  });
  assert.doesNotThrow(() => service.broadcastLiveSessionRun("session-1", null));
  assert.equal(unreachable.sent.length, 0);
  assert.equal(failures, 1);
  assert.deepEqual(healthy.sent, [
    {
      channel: "withmate:live-session-run-status",
      payload: { sessionId: "session-1", status: null },
    },
    {
      channel: "withmate:live-session-run",
      payload: { sessionId: "session-1", state: null },
    },
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "用途別配送を維持し、turn更新は生存windowへ、queue変更は生存Session windowだけへ対象Session IDを渡す"
// oracle = { type = "contract", ref = "src-shared/ipc/withmate-ipc-channels.ts notification contracts" }
// fault = "必要なWindowへ通知しない、destroyed Windowへ配信する、またはturn/queue通知へ本文や履歴詳細を混入する"
// observable = "home/session/closed Windowのchannelとpayload"
// observation_boundary = "public-boundary"
// scope = "window broadcast routing"
// lifecycle = "permanent"
// @end-test-value
/** ターン更新は生存中の Home とセッション窓に届き、キュー変更は対象 ID だけで生存中のセッション窓へ届くことを確かめる。 */
test("WindowBroadcastService は用途別 window に event を振り分ける", () => {
  const home = createWindow(false);
  const session = createWindow(false);
  const closed = createWindow(true);
  const service = new WindowBroadcastService({
    /** 用途共通の配信候補に、Home、セッション、破棄済みの各窓を含める。 */
    getAllWindows: () => [home.window, session.window, closed.window],
    /** Home 向けの候補にも破棄済みの窓を混ぜ、除外を試す。 */
    getHomeWindows: () => [home.window, closed.window],
    /** 生存中の Home を代表窓として返す。 */
    getPrimaryHomeWindow: () => home.window,
    /** セッション向けの候補に破棄済みの窓を混ぜる。 */
    getSessionWindows: () => [session.window, closed.window],
    /** 実行状態の送信先として Home を指定する。 */
    getLiveSessionRunStatusWindows: () => [home.window],
    /** 詳細を扱う所有者をセッション窓へ割り当てる。 */
    getLiveSessionRunWindow: () => session.window,
  });

  service.broadcastSessionInvalidation({
    scope: "ids",
    sessionIds: ["session-1"],
  });
  service.broadcastOpenSessionWindowIds(["session-1"]);
  service.broadcastPromptTemplates([]);
  service.broadcastSessionTurnUpdated("session-1");
  service.broadcastSessionTurnQueueChanged("session-1");

  assert.deepEqual(
    home.sent.map((entry) => entry.channel),
    [
      "withmate:sessions-invalidated",
      "withmate:open-session-windows-changed",
      "withmate:prompt-templates-changed",
      "withmate:session-turn-updated",
    ],
  );
  assert.deepEqual(
    session.sent.map((entry) => entry.channel),
    [
      "withmate:sessions-invalidated",
      "withmate:open-session-windows-changed",
      "withmate:prompt-templates-changed",
      "withmate:session-turn-updated",
      "withmate:session-turn-queue-changed",
    ],
  );
  assert.equal(closed.sent.length, 0);
  assert.deepEqual(home.sent[1]?.payload, {
    scope: "ids",
    sessionIds: ["session-1"],
  });
  assert.equal(home.sent[3]?.payload, "session-1");
  assert.equal(session.sent[3]?.payload, "session-1");
  assert.equal(session.sent[4]?.payload, "session-1");
});

// @test-value v2
// kind = "security"
// claim = "Aux queue変更は親owner Windowだけへ実Aux target IDを配信する"
// oracle = { type = "contract", ref = "src-electron/windows/window-broadcast-service.ts broadcastSessionTurnQueueChanged" }
// fault = "queue変更を全Session Windowへ公開するかpayloadを親IDへ置換する"
// observable = "owner/nonowner Windowの送信eventとpayload"
// observation_boundary = "public-boundary"
// scope = "Auxiliary queue owner notification routing"
// lifecycle = "permanent"
// impact = "別会話WindowへAux target識別子が漏れるかAux queue一覧が更新されない"
// distinction = "IPC認可testはMainからRendererへのevent配送先を検証しない"
// risk_tags = ["privacy"]
// @end-test-value
/** Auxiliary のキュー変更を所属する親窓だけに通知し、通知の値は親 ID ではなく Auxiliary 自身の ID とすることを確認する。 */
test("Aux queue変更は親WindowだけへAux IDで配信する", () => {
  const owner = createWindow();
  const other = createWindow();
  const service = new WindowBroadcastService({
    /** 所有窓と無関係窓の両方を一般の配信候補に含める。 */
    getAllWindows: () => [owner.window, other.window],

    /** 親セッションへの配送を確認するため Home グループは空にする。 */
    getHomeWindows: () => [],
    /** 代表 Home は存在しないものとする。 */
    getPrimaryHomeWindow: () => null,
    /** セッション窓一覧には両方を登録し、一斉送信を検出できるようにする。 */
    getSessionWindows: () => [owner.window, other.window],
    /** 軽量な実行状態の購読窓は用意しない。 */
    getLiveSessionRunStatusWindows: () => [],
    /** 親 ID の解決だけが所有窓を返すようにして、誤った ID での検索を検出する。 */
    getLiveSessionRunWindow: (id) =>
      id === "parent-1" ? owner.window : other.window,
  });
  service.broadcastSessionTurnQueueChanged("aux-1", "parent-1");
  assert.deepEqual(owner.sent, [
    { channel: "withmate:session-turn-queue-changed", payload: "aux-1" },
  ]);
  assert.deepEqual(other.sent, []);
});

// @test-value v2
// kind = "contract"
// claim = "Window復元集合はprimary Homeだけへ配信する"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#sessionwindowbridge" }
// fault = "復元集合をSettingsやSessionにも送信する"
// observable = "各Windowの受信payloadと送信件数"
// observation_boundary = "public-boundary"
// scope = "window-restore-set-routing"
// lifecycle = "permanent"
// @end-test-value
/** 復元セットの ID 列は主要 Home にだけ届き、Settings・セッション・破棄済みの窓には送らないことを確かめる。 */
test("WindowBroadcastService は Session Window復元集合をHomeだけへ通知する", () => {
  const home = createWindow(false);
  const settings = createWindow(false);
  const session = createWindow(false);
  const closedPrimaryHome = createWindow(true);
  const service = new WindowBroadcastService({
    /** 復元セットの宛先にならない窓も含めて全窓を列挙する。 */
    getAllWindows: () => [
      home.window,
      settings.window,
      session.window,
      closedPrimaryHome.window,
    ],
    /** Home グループには Settings もあるため、グループ全体の配信を検出できる。 */
    getHomeWindows: () => [home.window, settings.window],
    /** 復元セットの唯一の受信先となる主要 Home を返す。 */
    getPrimaryHomeWindow: () => home.window,
    /** 主要 Home とは別のセッション窓を返す。 */
    getSessionWindows: () => [session.window],
    /** 主要 Home を通常の実行状態通知先にも登録する。 */
    getLiveSessionRunStatusWindows: () => [home.window],
    /** 復元通知とは無関係な実行詳細の所有窓を指定する。 */
    getLiveSessionRunWindow: () => session.window,
  });

  service.broadcastSessionWindowRestoreSet(["session-1", "session-2"]);

  assert.deepEqual(home.sent, [
    {
      channel: "withmate:session-window-restore-set-changed",
      payload: ["session-1", "session-2"],
    },
  ]);
  assert.equal(settings.sent.length, 0);
  assert.equal(session.sent.length, 0);
  assert.equal(closedPrimaryHome.sent.length, 0);
});

// @test-value v2
// kind = "contract"
// claim = "primary Homeがない時は他の管理Windowへ復元集合を流さない"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#sessionwindowbridge" }
// fault = "primary不在時にSettingsを代替宛先にする"
// observable = "Settingsの受信件数"
// observation_boundary = "public-boundary"
// scope = "window-restore-set-without-home"
// lifecycle = "permanent"
// @end-test-value
/** 主要 Home が不在のときは、同じ Home グループに Settings があっても復元セットを代替配信しないことを確かめる。 */
test("WindowBroadcastService はprimary Home不在時に復元集合を通知しない", () => {
  const settings = createWindow(false);
  const service = new WindowBroadcastService({
    /** 起動中の窓が Settings だけの状態を作る。 */
    getAllWindows: () => [settings.window],
    /** Settings を Home 系グループに残し、代替送信を検出できるようにする。 */
    getHomeWindows: () => [settings.window],
    /** 主要 Home を解決できないことを示す。 */
    getPrimaryHomeWindow: () => null,
    /** 起動済みのセッション窓は存在しないものとする。 */
    getSessionWindows: () => [],
    /** 実行状態向けの購読窓はないものとする。 */
    getLiveSessionRunStatusWindows: () => [],
    /** 実行詳細の受信窓もないものとする。 */
    getLiveSessionRunWindow: () => null,
  });

  service.broadcastSessionWindowRestoreSet(["session-1"]);

  assert.equal(settings.sent.length, 0);
});

// @test-value v2
// kind = "contract"
// claim = "open Session ID通知は上限超過時にall無効化へ縮退する"
// oracle = { type = "contract", ref = "src-shared/window/withmate-window-types.ts#OPEN_SESSION_WINDOW_IDS_BROADCAST_MAX" }
// fault = "上限を超えるID列をeventへ保持する"
// observable = "Homeが受信したscope"
// observation_boundary = "public-boundary"
// scope = "window-open-id-broadcast-bound"
// lifecycle = "permanent"
// @end-test-value
/** 開いているセッション ID が通知上限を超えたときは、個別一覧でなく全体無効化を送ることを確かめる。 */
test("WindowBroadcastService は open Session ID の上限超過を all にする", () => {
  const home = createWindow(false);
  const service = new WindowBroadcastService({
    /** 全窓の候補を一つの Home に固定し、その通知内容を読む。 */
    getAllWindows: () => [home.window],
    /** ID の変更を受け取る Home グループを一窓だけ返す。 */
    getHomeWindows: () => [home.window],
    /** 同じ窓を主要 Home として解決する。 */
    getPrimaryHomeWindow: () => home.window,
    /** ID 一覧の上限試験にセッション窓は用意しない。 */
    getSessionWindows: () => [],
    /** Home を実行状態向けの候補にも登録する。 */
    getLiveSessionRunStatusWindows: () => [home.window],
    /** 実行詳細を処理する個別窓は存在しないものとする。 */
    getLiveSessionRunWindow: () => null,
  });

  service.broadcastOpenSessionWindowIds(
    Array.from({ length: 101 }, (_, index) => `session-${index}`),
  );

  assert.deepEqual(home.sent[0]?.payload, { scope: "all" });
});

/** 本文・推論・操作詳細を大きくし、軽量通知に混入した場合にサイズの差を検出できる状態を作る。 */
function createLiveState(): LiveSessionRunState {
  return {
    sessionId: "aux-1",
    threadId: "thread-1",
    runState: "running",
    turnId: "turn-1",
    cancellationState: "terminating",
    assistantText: "large assistant body".repeat(10000),
    reasoningText: "large reasoning".repeat(10000),
    steps: [
      {
        id: "step-1",
        type: "command",
        summary: "operation",
        status: "in_progress",
        details: "large operation".repeat(10000),
      },
    ],
    backgroundTasks: [],
    usage: null,
    errorMessage: "",
    approvalRequest: null,
    elicitationRequest: null,
  };
}

// @test-value v2
// kind = "contract"
// claim = "live詳細はMainが解決したowner Windowだけへ元sessionIdで届き、HomeとMonitorには本文サイズと独立した状態だけが届く"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#live-run-delivery" }
// fault = "全Windowへ詳細を送るか、Auxiliary IDを親IDへ書き換えるか、軽量通知に本文やoperationを含める"
// observable = "各Windowの受信channel・payloadと軽量payloadの直列化サイズ"
// observation_boundary = "public-boundary"
// scope = "live-run-owner-and-status-delivery"
// lifecycle = "permanent"
// impact = "無関係Windowへの会話詳細転送と本文増加に比例する複数WindowのIPC負荷を防ぐ"
// distinction = "型はruntime objectの余剰fieldと実配送先を制約しないため、小さいWindow stubで現行の公開配送境界を継続確認する"
// @end-test-value
/** 実行詳細は元のセッション ID のまま所有窓だけに届き、Home と Monitor の状態通知は本文量にかかわらず同じ大きさになることを確認する。 */
test("live配信はowner詳細とHome／Monitorの固定サイズstatusに分離する", () => {
  const home = createWindow();
  const monitor = createWindow();
  const owner = createWindow();
  const unrelated = createWindow();
  const settings = createWindow();
  const memoryReview = createWindow();
  const state = createLiveState();
  const service = new WindowBroadcastService({
    /** 用途外の窓への漏れを検出するため、開いている全種類の窓を返す。 */
    getAllWindows: () => [
      home.window,
      monitor.window,
      owner.window,
      unrelated.window,
      settings.window,
      memoryReview.window,
    ],
    /** Home 系の集合に監視窓と詳細不要な管理窓を含める。 */
    getHomeWindows: () => [
      home.window,
      monitor.window,
      settings.window,
      memoryReview.window,
    ],
    /** Home 系の中から主要 Home を解決する。 */
    getPrimaryHomeWindow: () => home.window,
    /** 実行を所有する窓と無関係なセッション窓の両方を返す。 */
    getSessionWindows: () => [owner.window, unrelated.window],
    /** 軽量の実行状態を受け取る窓を Home と Monitor に絞る。 */
    getLiveSessionRunStatusWindows: () => [home.window, monitor.window],
    /** Main とその Auxiliary の両 ID を同じ所有窓へ対応付ける。 */
    getLiveSessionRunWindow: (id) =>
      id === "aux-1" || id === "main-1" ? owner.window : null,
  });
  service.broadcastLiveSessionRun("aux-1", state);
  assert.deepEqual(owner.sent, [
    {
      channel: "withmate:live-session-run",
      payload: { sessionId: "aux-1", state },
    },
  ]);
  const expectedStatus = {
    channel: "withmate:live-session-run-status",
    payload: {
      sessionId: "aux-1",
      status: { runState: "running", cancellationState: "terminating" },
    },
  };
  assert.deepEqual(home.sent, [expectedStatus]);
  assert.deepEqual(monitor.sent, [expectedStatus]);
  assert.equal(
    unrelated.sent.length + settings.sent.length + memoryReview.sent.length,
    0,
  );
  const size = JSON.stringify(home.sent[0]).length;
  service.broadcastLiveSessionRun("aux-1", {
    ...state,
    assistantText: "",
    reasoningText: "",
    steps: [],
  });
  assert.equal(JSON.stringify(home.sent[1]).length, size);
  service.broadcastLiveSessionRun("main-1", { ...state, sessionId: "main-1" });
  assert.equal(
    (owner.sent[2]?.payload as { sessionId: string }).sessionId,
    "main-1",
  );
});

// @test-value v2
// kind = "contract"
// claim = "非表示ownerと再open後の新ownerへ終端nullを配信し、owner不明・lookup例外でも他Sessionへ詳細を代替配信しない"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#live-run-delivery" }
// fault = "visibilityでowner通知を落とすか、古いWindowへnullを送るか、lookup失敗を全Window配信で救済する"
// observable = "旧／新ownerと無関係Sessionの受信payload、lookup例外時のpublication結果とHome status"
// observation_boundary = "public-boundary"
// scope = "live-run-owner-lifecycle"
// lifecycle = "permanent"
// impact = "再open後の取消待ち解除と宛先限定を維持し、無関係会話への詳細漏出を防ぐ"
// distinction = "Window生存とowner解決はruntime依存のため、型検査ではnull配送やlookup障害を検出できない。追加基盤なしの短いfixtureで確認する"
// @end-test-value
/** 所有窓の再起動後は新しい窓だけに終端の null を配信し、所有者の不在・解決失敗でも無関係な窓へ詳細を渡さないことを確かめる。 */
test("live配送は再openとowner lookup失敗でも宛先境界を維持する", () => {
  const home = createWindow();
  const unrelated = createWindow();
  const first = createWindow();
  const reopened = createWindow();
  let target: typeof first.window | null = first.window;
  let lookupFailed = false;
  const service = new WindowBroadcastService({
    /** 旧窓、新窓、無関係な窓も含めて一般の配信候補を返す。 */
    getAllWindows: () => [
      home.window,
      unrelated.window,
      first.window,
      reopened.window,
    ],

    /** Home を管理窓グループの唯一の候補とする。 */
    getHomeWindows: () => [home.window],
    /** 管理窓の中で主要となる Home を返す。 */
    getPrimaryHomeWindow: () => home.window,
    /** 所有者の解決によらない一斉送信を検出できるように三つのセッション窓を返す。 */
    getSessionWindows: () => [unrelated.window, first.window, reopened.window],
    /** 所有者の解決に失敗しても状態通知を受ける Home を指定する。 */
    getLiveSessionRunStatusWindows: () => [home.window],
    /** 試験段階ごとに現在の所有窓・窓なし・解決例外を切り替える。 */
    getLiveSessionRunWindow: () => {
      if (lookupFailed) throw new Error("owner unavailable");
      return target;
    },
  });
  // 可視性を調べる API は使わない。登録済みで有効な所有 Window は非表示でも状態を受け取る。
  service.broadcastLiveSessionRun("aux-1", createLiveState());
  target = reopened.window;
  first.window.isDestroyed = () => true;
  service.broadcastLiveSessionRun("aux-1", null);
  assert.equal(first.sent.length, 1);
  assert.deepEqual(reopened.sent, [
    {
      channel: "withmate:live-session-run",
      payload: { sessionId: "aux-1", state: null },
    },
  ]);
  target = null;
  service.broadcastLiveSessionRun("aux-1", createLiveState());
  lookupFailed = true;
  assert.doesNotThrow(() => service.broadcastLiveSessionRun("aux-1", null));
  assert.equal(unrelated.sent.length, 0);
  assert.equal(reopened.sent.length, 1);
  assert.deepEqual(home.sent.at(-1), {
    channel: "withmate:live-session-run-status",
    payload: { sessionId: "aux-1", status: null },
  });
});
