import assert from "node:assert/strict";
import test from "node:test";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import {
  subscribeSessionLiveEvents,
  subscribeSessionLiveSelection,
  subscribeSessionRunControls,
  updateSessionLiveState,
  type SessionLiveIngressApi,
} from "../../src/chat/runtime/session-window-live-ingress.js";

/** 公開 API の配送を手動で進められ、初回取得・購読・解除を記録する fixture。 */
function fixture() {
  /** 購読が始まるまでは live 通知を何も処理しない。 */
  let listener: Parameters<
    SessionLiveIngressApi["subscribeLiveSessionRun"]
  >[0] = () => {};
  const gets: Array<{
    id: string;
    resolve: (state: LiveSessionRunState | null) => void;
  }> = [];
  let subscriptions = 0;
  let disposals = 0;
  const api: SessionLiveIngressApi = {
    /** API に登録された最新コールバックを保持し、購読と解除を数える。 */
    subscribeLiveSessionRun: (next) => {
      listener = next;
      ++subscriptions;
      return () => {
        ++disposals;
      };
    },
    /** 初回取得の ID と応答の解決関数を保存し、先行通知との順序を制御する。 */
    getLiveSessionRun: (id) =>
      new Promise((resolve) => {
        gets.push({ id, resolve });
      }),
  };
  return {
    api,
    gets,
    /** 指定セッションの live スナップショットを公開 API 経由で通知する。 */
    emit: (id: string, state: LiveSessionRunState | null) =>
      listener(id, state),
    /** 境界をまたいだ実購読の累計を返す。 */
    get subscriptions() {
      return subscriptions;
    },
    /** 公開 API の解除が呼ばれた累計を返す。 */
    get disposals() {
      return disposals;
    },
  };
}
/** セッション ID と本文を識別可能にした実行中スナップショットを作る。 */
const live = (
  sessionId: string,
  assistantText = "body",
): LiveSessionRunState => ({
  sessionId,
  threadId: "thread",
  runState: "running",
  assistantText,
  steps: [],
  backgroundTasks: [],
  usage: null,
  errorMessage: "",
  approvalRequest: null,
  elicitationRequest: null,
});
/** 保留していた取得の解決が購読側に届くまでマイクロタスクを進める。 */
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

// @test-value v2
// kind = "contract"
// claim = "同じWindowの複数live consumerは1本の公開API callbackとownerごと1回の初回取得を共有し、各会話に同じ最新snapshotを配送する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: メッセージの投影とWindow内live受信" }
// fault = "consumer追加でfull payloadの境界コピーが増える、初回IPCを重複する、または別ownerの本文を混入する"
// observable = "公開APIの登録・解除回数、get対象ID列、consumerへ届いたsnapshot参照とowner"
// observation_boundary = "public-boundary"
// scope = "SessionWindow live ingress sharing"
// lifecycle = "permanent"
// impact = "長い応答のconsumer数比例コピーと会話取り違えを防ぐ"
// distinction = "型検査や個別Column testでは複数consumer間の公開API呼出数を保証できない。少数のdeferredで計測し壁時計閾値を使わない"
// @end-test-value
/** 同じウィンドウの購読と同じ owner の初回取得は共有され、遅い旧取得や別 owner の本文が最新の表示を上書きしないことを確認する。 */
test("Window liveはcallbackとinitial getを共有しownerを分離する", async () => {
  const f = fixture();
  const main: Array<LiveSessionRunState | null> = [];
  const audit: Array<LiveSessionRunState | null> = [];
  const auxiliary: Array<LiveSessionRunState | null> = [];
  const dispose = [
    subscribeSessionLiveEvents(f.api, () => {}),
    subscribeSessionLiveSelection({
      api: f.api,
      sessionId: "main",
      /** Main のスナップショットを加工せず参照の同一性を確認できるようにする。 */
      select: (state) => state,
      /** Main 表示の受信順を記録する。 */
      onChange: (state) => main.push(state),
    }),
    subscribeSessionLiveSelection({
      api: f.api,
      sessionId: "main",
      /** 二つ目の Main 購読も同じ全スナップショットを選択する。 */
      select: (state) => state,
      /** 監査用の Main 購読が受けた参照を記録する。 */
      onChange: (state) => audit.push(state),
    }),
    subscribeSessionLiveSelection({
      api: f.api,
      sessionId: "aux",
      /** Auxiliary 側も本文を含む全内容を選択する。 */
      select: (state) => state,
      /** Auxiliary 専用の受信履歴へ保存する。 */
      onChange: (state) => auxiliary.push(state),
    }),
  ];
  assert.equal(f.subscriptions, 1);
  assert.deepEqual(
    f.gets.map((get) => get.id),
    ["main", "aux"],
  );
  const latest = live("main");
  f.emit("main", latest);
  f.gets[0]!.resolve(live("main", "stale"));
  f.gets[1]!.resolve(live("aux", "aux body"));
  await flush();
  assert.strictEqual(main.at(-1), latest);
  assert.strictEqual(audit.at(-1), latest);
  assert.equal(auxiliary.at(-1)?.assistantText, "aux body");
  dispose.forEach((release) => release());
  assert.equal(f.disposals, 1);
});

// @test-value v2
// kind = "contract"
// claim = "controlsは本文deltaで更新せず取消を最新に保ち、最後の表示consumerを閉じた後の再openはdetailを再取得する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: メッセージの投影とWindow内live受信; docs/design/desktop-ui.md: Mainの取消受付後" }
// fault = "controlsがfull本文を保持またはtokenごと更新する、取消を見失う、再openで古いdetailを表示する"
// observable = "controlsの通知列、再open時のget回数と取得した本文、action updaterの本文・steps・background保持内容"
// observation_boundary = "consumer"
// scope = "SessionWindow controls and detail lifetime"
// lifecycle = "permanent"
// impact = "非表示時の保持負荷と取消中の誤送信を防ぎ、最新の応答を再表示する"
// distinction = "型検査では通知の省略や保持寿命を確認できない。snapshotの取得・取消・再openを1つの短い操作列で検証する"
// @end-test-value
/** 本文だけでは操作の購読を更新せず、詳細を閉じて解放した後も取消状態を受け、再表示では詳細を再取得して古い結果で完了を巻き戻さないことを確認する。 */
test("controlsは本文とdetail寿命から独立して取消解除を受け取る", async () => {
  const f = fixture();
  const controls: Array<
    Parameters<Parameters<typeof subscribeSessionRunControls>[0]["onChange"]>[0]
  > = [];
  const closeControls = subscribeSessionRunControls({
    api: f.api,
    sessionId: "main",
    /** 操作状態の通知回数と最新値を記録する。 */
    onChange: (value) => controls.push(value),
  });
  const closeDisplay = subscribeSessionLiveSelection({
    api: f.api,
    sessionId: "main",
    /** 詳細表示が開いている間は本文やステップも購読対象にする。 */
    select: (state) => state,
    /** 表示側は詳細の保持を有効にするだけで、この購読の描画結果は使わない。 */
    onChange: () => {},
  });
  const withDetail = {
    ...live("main"),
    steps: [
      {
        id: "step",
        type: "command_execution",
        summary: "command",
        details: "large operation detail",
        status: "in_progress",
      },
    ],
    backgroundTasks: [
      {
        id: "background",
        kind: "shell" as const,
        status: "running" as const,
        title: "shell",
        details: "large background detail",
        updatedAt: "now",
      },
    ],
  };
  f.gets[0]!.resolve(withDetail);
  await flush();
  const count = controls.length;
  for (let i = 0; i < 100; ++i)
    f.emit("main", {
      ...withDetail,
      assistantText: `body ${i}`,
    });
  assert.equal(controls.length, count);
  const closeOtherControls = subscribeSessionRunControls({
    api: f.api,
    sessionId: "main",
    /** 後から購読した操作側にも本文の有無だけは伝わることを確認する。 */
    onChange: (value) => assert.equal(value.hasAssistantText, true),
  });
  closeOtherControls();
  closeDisplay();
  updateSessionLiveState(f.api, "main", (current) => {
    assert.equal(current.state?.assistantText, "");
    assert.deepEqual(current.state?.steps, []);
    assert.deepEqual(current.state?.backgroundTasks, []);
    return current;
  });
  f.emit("main", { ...live("main"), cancellationState: "terminating" });
  assert.equal(controls.at(-1)?.cancellationState, "terminating");
  const reopened: Array<LiveSessionRunState | null> = [];
  const closeReopen = subscribeSessionLiveSelection({
    api: f.api,
    sessionId: "main",
    /** 再表示された購読で再取得後の本文まで読み取る。 */
    select: (state) => state,
    /** 再取得の後に届いた表示内容を残す。 */
    onChange: (state) => reopened.push(state),
  });
  assert.equal(f.gets.length, 2);
  f.gets[1]!.resolve({
    ...live("main", "latest detail"),
    cancellationState: "terminating",
  });
  await flush();
  assert.equal(reopened.at(-1)?.assistantText, "latest detail");
  closeReopen();
  const closeTerminalReopen = subscribeSessionLiveSelection({
    api: f.api,
    sessionId: "main",
    /** 終了通知と競合する再取得でも詳細全体を監視する。 */
    select: (state) => state,
    /** 終了通知が遅い取得結果で上書きされないか、最後の表示値を記録する。 */
    onChange: (state) => reopened.push(state),
  });
  assert.equal(f.gets.length, 3);
  f.emit("main", null);
  f.gets[2]!.resolve({
    ...live("main", "obsolete"),
    cancellationState: "terminating",
  });
  await flush();
  assert.equal(controls.at(-1)?.hasLiveRun, false);
  assert.equal(reopened.at(-1), null);
  closeTerminalReopen();
  closeControls();
});

// @test-value v2
// kind = "invariant"
// claim = "無購読ownerの遅い取得は同じIDを再openした新しいownerへ適用しない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: メッセージの投影とWindow内live受信" }
// fault = "解放済みownerの初回結果が新しい表示を上書きする"
// observable = "再open consumerの本文と初回get回数"
// observation_boundary = "consumer"
// scope = "SessionWindow owner lifetime race"
// lifecycle = "permanent"
// impact = "Auxiliaryの反復切替で古い会話や取消状態が復活することを防ぐ"
// distinction = "既存の単一購読race testと異なり同じ公開API・同じIDのowner破棄と再作成を検証する。短いdeferredで維持できる"
// @end-test-value
/** 一度すべての購読を解除した同じ ID を開き直しても、旧 owner の初回取得が新しい本文を上書きしないことを確認する。 */
test("解放したownerのgetは再openしたownerを巻き戻さない", async () => {
  const f = fixture();
  const close = subscribeSessionLiveSelection({
    api: f.api,
    sessionId: "aux",
    /** 旧 owner の初回取得を開始するため全状態を購読する。 */
    select: (state) => state,
    /** 旧 owner の描画内容は観察せず、取得だけを保留する。 */
    onChange: () => {},
  });
  close();
  const values: Array<LiveSessionRunState | null> = [];
  const closeNew = subscribeSessionLiveSelection({
    api: f.api,
    sessionId: "aux",
    /** 再度開いた owner について本文を含む全状態を選択する。 */
    select: (state) => state,
    /** 再度開いた購読に届いた状態を保存し、最後の本文を確認できるようにする。 */
    onChange: (state) => values.push(state),
  });
  assert.equal(f.gets.length, 2);
  f.gets[1]!.resolve(live("aux", "new"));
  await flush();
  f.gets[0]!.resolve(live("aux", "old"));
  await flush();
  assert.equal(values.at(-1)?.assistantText, "new");
  closeNew();
});
