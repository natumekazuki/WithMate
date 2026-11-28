import assert from "node:assert/strict";
import test from "node:test";

import { AuxiliaryLiveRunParents } from "../../src-electron/auxiliary/auxiliary-live-run-parents.js";
import { SessionObservabilityService } from "../../src-electron/session/session-observability-service.js";
import { WindowBroadcastService } from "../../src-electron/windows/window-broadcast-service.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";

// @test-value v2
// kind = "contract"
// claim = "親の停止判定は全Auxiliaryの実guardを集約し、保持liveだけでは実行中にせず、owner交換後は解除する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-window-close" }
// fault = "選択外Auxiliaryや取消終了待ちを見落とす、完了後も停止不能にする"
// observable = "親ごとのhasPendingRunForParent結果"
// observation_boundary = "public-boundary"
// scope = "monitor-auxiliary-aggregate"
// lifecycle = "permanent"
// @end-test-value
/** 同じ親の別の Auxiliary が実行中なら停止判定が残り、保持された表示状態だけになった場合とストア世代交代後には解除される。 */
test("全Auxiliaryの実guardを親の停止判定へ集約する", () => {
  const f = fixture();
  f.inFlight.add("a");
  f.inFlight.add("b");
  f.parents.remember(auxiliary("a"), f.owner);
  f.parents.remember(auxiliary("b"), f.owner);
  f.observability.setLiveSessionRun(
    "b",
    live("b", { runState: "idle", cancellationState: "terminating" }),
  );
  f.inFlight.delete("a");
  assert.equal(f.parents.hasPendingRunForParent("parent-a"), true);
  assert.equal(f.parents.hasPendingRunForParent("parent-b"), false);
  f.inFlight.delete("b");
  assert.equal(f.parents.hasPendingRunForParent("parent-a"), false);
  f.inFlight.add("b");
  f.replaceOwner();
  assert.equal(f.parents.hasPendingRunForParent("parent-a"), false);
});

/** 配送先を区別するため、既定または指定の親と Auxiliary の ID を関連づける。 */
function auxiliary(id: string, parentSessionId = "parent-a") {
  return { id, parentSessionId };
}

/** 実行中の既定状態を作り、取消処理や保持表示などの段階だけを上書きできるようにする。 */
function live(
  sessionId: string,
  overrides: Partial<LiveSessionRunState> = {},
): LiveSessionRunState {
  return {
    sessionId,
    threadId: "thread",
    runState: "running",
    assistantText: "body",
    steps: [],
    backgroundTasks: [],
    usage: null,
    errorMessage: "",
    approvalRequest: null,
    elicitationRequest: null,
    ...overrides,
  };
}

/** 実際の配信サービスと観測サービスをつなぎ、宛先やストア所有者の交代をテストから制御できるようにする。 */
function fixture() {
  let owner: object | null = {};
  const admission = new Set<string>();
  const inFlight = new Set<string>();
  const sent: Array<{ windowId: string; channel: string; payload: unknown }> =
    [];
  const windows = new Map(
    ["home", "monitor", "parent-a", "parent-b", "unrelated"].map((windowId) => [
      windowId,
      {
        /** 各テスト用ウィンドウを配信可能な状態にする。 */
        isDestroyed: () => false,
        webContents: {
          /** 宛先と内容を検証できるよう、実送信に代えて IPC メッセージを記録する。 */
          send: (channel: string, payload: unknown) => {
            sent.push({ windowId, channel, payload });
          },
        },
      },
    ]),
  );
  /** 配信先の候補となる既知のウィンドウを ID で引く。 */
  const getWindow = (id: string) => windows.get(id)!;
  const broadcaster = new WindowBroadcastService({
    /** 全ウィンドウ向けの通知で利用できる疑似ウィンドウを返す。 */
    getAllWindows: () => [...windows.values()],
    /** ホーム向け通知の宛先を一つに限定する。 */
    getHomeWindows: () => [getWindow("home")],
    /** 主ホームとして状態確認用のホームウィンドウを返す。 */
    getPrimaryHomeWindow: () => getWindow("home"),
    /** 親に加えて無関係なセッションも候補に含め、詳細の誤配送を検出できるようにする。 */
    getSessionWindows: () => [
      getWindow("parent-a"),
      getWindow("parent-b"),
      getWindow("unrelated"),
    ],
    /** 実行状態の要約を受け取るホームとモニターを返す。 */
    getLiveSessionRunStatusWindows: () => [
      getWindow("home"),
      getWindow("monitor"),
    ],
    /** Auxiliary の詳細を現在の親ウィンドウへ送り、親関連がなければ送信先なしとする。 */
    getLiveSessionRunWindow: (id) => {
      const parent = parents.get(id);
      return parent ? (windows.get(parent) ?? null) : null;
    },
  });
  const parents = new AuxiliaryLiveRunParents({
    /** 世代交代時に入れ替えたストア所有者を返す。 */
    getStorageOwner: () => owner,
    /** 新規受付中と既に実行中のいずれも保留中として扱う。 */
    isRunPending: (id) => admission.has(id) || inFlight.has(id),
    /** 観測サービスに状態が残っているかを返し、実行の有無とは分けて扱う。 */
    hasLiveSessionRun: (id) => Boolean(observability.getLiveSessionRun(id)),
    /** 親関連から発行された状態を実配信サービスに通す。 */
    broadcastLiveSessionRun: (id, state) =>
      broadcaster.broadcastLiveSessionRun(id, state),
  });
  /** 生成元のストア所有者を捕捉した観測サービスを組み立てる。 */
  const createObservability = () => {
    const capturedOwner = owner;
    return new SessionObservabilityService({
      /** プロバイダーの使用量通知は配送テストの対象に含めない。 */
      onProviderQuotaTelemetryChanged: () => {},
      /** セッションのコンテキスト計測は配信記録に混ぜない。 */
      onSessionContextTelemetryChanged: () => {},

      /** 状態変更の通知を、作成元の所有者とともに親関連へ渡す。 */
      onLiveSessionRunChanged: (id, state) =>
        parents.publish(id, state, capturedOwner),
    });
  };
  let observability = createObservability();
  return {
    admission,
    inFlight,
    parents,
    sent,
    /** 登録や解除操作に渡す現行のストア所有者を取得する。 */
    get owner() {
      return owner!;
    },
    /** 現在の世代が使う観測サービスを返す。 */
    get observability() {
      return observability;
    },
    /** 旧世代の通知、親関連、受付・実行状態を廃棄し、新世代の観測を開始する。 */
    replaceOwner: () => {
      observability.dispose();
      parents.clear();
      admission.clear();
      inFlight.clear();
      owner = {};
      observability = createObservability();
    },
    /** 配信記録からセッションの詳細通知だけを取り出す。 */
    details: () =>
      sent.filter((entry) => entry.channel === "withmate:live-session-run"),
  };
}

// @test-value v2
// kind = "contract"
// claim = "親SessionのClose判定は同じstorage ownerに属する全Auxiliaryの実guardを参照し、保持liveだけや別の親と旧ownerを実行中にしない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-window-close; GitHub Issue #877" }
// fault = "先頭Auxiliaryだけを調べる、保持liveを実行中とする、または親IDとstorage ownerを無視する"
// observable = "子のguard解放とowner交換前後のhasPendingRunForParentの戻り値"
// observation_boundary = "public-boundary"
// scope = "auxiliary-parent-close-running-state"
// lifecycle = "permanent"
// impact = "非表示Auxiliaryの実行中警告が漏れるか、実行なしで不要な警告を出す"
// distinction = "既存の配送testは親IDの逆引きしか確認せず、親配下の実行有無と保持liveの区別を検出しない"
// @end-test-value
/** 待機の判定が選択中の会話や保持状態に依存せず、親ごとの実行状態と現行のストア所有者だけを反映することを確認する。 */
test("親配下の全Auxiliaryの実guardをowner付きで判定する", () => {
  let owner: object | null = {};
  const pending = new Set(["selected-idle", "background", "other-parent"]);
  const parents = new AuxiliaryLiveRunParents({
    /** テストで切り替えるストア所有者を返す。 */
    getStorageOwner: () => owner,
    /** 保留中の集合にある ID のみを停止判定に数える。 */
    isRunPending: (id) => pending.has(id),
    /** 保持された表示状態が常にある条件でも、停止判定に混ざらないことを試す。 */
    hasLiveSessionRun: () => true,
    /** 停止判定だけを検証するため、外部への配信は行わない。 */
    broadcastLiveSessionRun() {},
  });
  parents.remember(auxiliary("selected-idle"), owner);
  parents.remember(auxiliary("background"), owner);
  parents.remember(auxiliary("other-parent", "parent-b"), owner);
  pending.delete("selected-idle");
  parents.releaseIfUnused("selected-idle", owner);
  assert.equal(parents.get("selected-idle"), "parent-a");
  assert.equal(parents.hasPendingRunForParent("parent-a"), true);
  assert.equal(parents.hasPendingRunForParent("parent-b"), true);
  assert.equal(parents.hasPendingRunForParent("unrelated"), false);

  pending.delete("background");
  parents.releaseIfUnused("background", owner);
  assert.equal(parents.get("background"), "parent-a");
  assert.equal(parents.hasPendingRunForParent("parent-a"), false);
  assert.equal(parents.hasPendingRunForParent("parent-b"), true);

  owner = {};
  assert.equal(parents.hasPendingRunForParent("parent-b"), false);
  parents.remember(auxiliary("other-parent", "parent-c"), owner);
  assert.equal(parents.hasPendingRunForParent("parent-b"), false);
  assert.equal(parents.hasPendingRunForParent("parent-c"), true);
  owner = null;
  assert.equal(parents.hasPendingRunForParent("parent-c"), false);
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliaryの取消終了待ちとretained liveを親Windowへ配送し、最後のnullを届けてから親関連を解除する"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#live-run-delivery" }
// fault = "run呼出し収束で親関連を失う、保持live中に解除する、または終端nullの前に解除する"
// observable = "親Windowが実WindowBroadcastServiceから受け取る詳細payload列、Home/Monitorのstatus列、残存親関連数"
// observation_boundary = "public-boundary"
// scope = "auxiliary-live-owner-retention-and-terminal-routing"
// lifecycle = "permanent"
// impact = "取消終了待ちや保持liveとその解除が表示へ届かず、Windowに古い状態が残る"
// distinction = "既存routing単独testに対し実observability更新と親関連lifecycleを結合し、Promise収束後の宛先継続を確認する"
// @end-test-value
/** 取消終了待ちと保持表示の詳細を親へ、要約をホームとモニターへ配送し、最後の空状態を送ってから親関連を解除する。 */
test("取消graceと保持liveの配送後に終端nullで親関連を解除する", () => {
  const f = fixture();
  const id = "aux-cancel";
  f.admission.add(id);
  f.inFlight.add(id);
  f.parents.remember(auxiliary(id), f.owner);
  const running = live(id);
  f.observability.setLiveSessionRun(id, running);
  const requested = live(id, { cancellationState: "requested" });
  f.observability.setLiveSessionRun(id, requested);
  f.admission.delete(id);
  f.parents.releaseIfUnused(id, f.owner);
  const terminating = live(id, {
    runState: "idle",
    cancellationState: "terminating",
  });
  f.observability.setLiveSessionRun(id, terminating);
  assert.equal(f.parents.get(id), "parent-a");
  // 実際の終了処理が保留中に `null` が来ても、その通知経路を失ってはならない。
  f.observability.setLiveSessionRun(id, null);
  assert.equal(f.parents.get(id), "parent-a");
  const retained = live(id, {
    runState: "idle",
    reasoningText: "retained reasoning",
  });
  f.inFlight.delete(id);
  f.observability.setLiveSessionRun(id, retained);
  f.parents.releaseIfUnused(id, f.owner);
  assert.equal(f.parents.get(id), "parent-a");
  const background = live(id, {
    runState: "idle",
    backgroundTasks: [
      {
        id: "task",
        kind: "agent",
        title: "background",
        status: "running",
        updatedAt: "2026-10-10T00:00:00.000Z",
      },
    ],
  });
  f.observability.setLiveSessionRun(id, background);
  assert.equal(f.parents.size, 1);
  f.observability.setLiveSessionRun(id, null);
  assert.equal(f.parents.size, 0);
  assert.deepEqual(
    f.details(),
    [running, requested, terminating, null, retained, background, null].map(
      (state) => ({
        windowId: "parent-a",
        channel: "withmate:live-session-run",
        payload: { sessionId: id, state },
      }),
    ),
  );
  for (const windowId of ["home", "monitor"]) {
    assert.deepEqual(
      f.sent
        .filter((entry) => entry.windowId === windowId)
        .map((entry) => entry.payload),
      [
        {
          sessionId: id,
          status: { runState: "running", cancellationState: undefined },
        },
        {
          sessionId: id,
          status: { runState: "running", cancellationState: "requested" },
        },
        {
          sessionId: id,
          status: { runState: "idle", cancellationState: "terminating" },
        },
        { sessionId: id, status: null },
        {
          sessionId: id,
          status: { runState: "idle", cancellationState: undefined },
        },
        {
          sessionId: id,
          status: { runState: "idle", cancellationState: undefined },
        },
        { sessionId: id, status: null },
      ],
    );
  }
});

// @test-value v2
// kind = "invariant"
// claim = "完了または受付失敗したAuxiliaryの親関連は蓄積せず、遅い会話読込みでも再登録されない"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#live-run-delivery" }
// fault = "admission終了時の不要entryを残すか、実行していない会話読込みで親関連を復活させる"
// observable = "反復完了後の親関連数と、各親Windowの終端null payload"
// observation_boundary = "public-boundary"
// scope = "auxiliary-live-owner-completion-release"
// lifecycle = "permanent"
// impact = "完了会話数に比例してvolatile配送metadataが増加する"
// distinction = "取消・保持liveの継続とは別にadmissionが終端nullより遅く解除される通常完了と受付失敗を小さい反復fixtureで確認する"
// @end-test-value
/** 終端通知後に受付が解除される通常完了と受付失敗を繰り返し、遅れて読み込んだ会話からも不要な親関連が復活しないことを確認する。 */
test("完了と受付失敗を繰り返しても不要な親関連を残さない", () => {
  const f = fixture();
  for (let i = 0; i < 40; i += 1) {
    const row = auxiliary(`aux-${i}`, i % 2 === 0 ? "parent-a" : "parent-b");
    f.admission.add(row.id);
    f.parents.remember(row, f.owner);
    f.observability.setLiveSessionRun(row.id, live(row.id));
    f.observability.setLiveSessionRun(row.id, null);
    assert.equal(f.parents.size, 1);
    f.admission.delete(row.id);
    f.parents.releaseIfUnused(row.id, f.owner);
    f.parents.remember(row, f.owner);
    assert.equal(f.parents.size, 0);
    const rejected = auxiliary(`rejected-${i}`);
    f.admission.add(rejected.id);
    f.parents.remember(rejected, f.owner);
    f.admission.delete(rejected.id);
    f.parents.releaseIfUnused(rejected.id, f.owner);
    assert.equal(f.parents.size, 0);
  }
  assert.deepEqual(
    f
      .details()
      .filter((entry) => (entry.payload as { state: unknown }).state === null),
    Array.from({ length: 40 }, (_, i) => ({
      windowId: i % 2 === 0 ? "parent-a" : "parent-b",
      channel: "withmate:live-session-run",
      payload: { sessionId: `aux-${i}`, state: null },
    })),
  );
});

// @test-value v2
// kind = "contract"
// claim = "親削除で保持liveの親関連を解除し、遅い会話読込みを再登録しない"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#live-run-delivery" }
// fault = "親削除後の保持liveを根拠に親関連を復活させ、不要entryまたは詳細宛先を残す"
// observable = "親関連数と親削除後にWindowBroadcastServiceが送る詳細通知数"
// observation_boundary = "public-boundary"
// scope = "auxiliary-live-owner-delete-release"
// lifecycle = "permanent"
// impact = "破棄済み会話のrouting metadataが残り、遅い状態が旧親Windowに配信される"
// distinction = "通常完了では解除できない保持liveありの明示teardownと同generationの遅い読込みを確認する"
// @end-test-value
/** 明示的に親関連を削除した後は、保持中の表示状態や遅い再登録があっても親への詳細配送を復活させない。 */
test("保持live付き会話の親削除で親関連を解除する", () => {
  const f = fixture();
  for (let i = 0; i < 40; i += 1) {
    const row = auxiliary(`deleted-${i}`);
    f.admission.add(row.id);
    f.parents.remember(row, f.owner);
    f.observability.setLiveSessionRun(
      row.id,
      live(row.id, { runState: "idle", reasoningText: "retained" }),
    );
    f.admission.delete(row.id);
    f.parents.releaseIfUnused(row.id, f.owner);
    assert.equal(f.parents.size, 1);
    f.parents.delete(row.id, f.owner);
    f.parents.remember(row, f.owner);
    assert.equal(f.parents.size, 0);
    const detailsBefore = f.details().length;
    f.observability.setLiveSessionRun(row.id, null);
    assert.equal(f.details().length, detailsBefore);
  }
});

// @test-value v2
// kind = "contract"
// claim = "旧storage ownerの遅い登録・通知・解除は同じAuxiliary IDを持つ新ownerの配送に影響しない"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#live-run-delivery" }
// fault = "旧ownerのparentで新entryを上書きする、旧通知を新Windowへ送る、または旧finallyで新entryを解除する"
// observable = "owner交換後の親Window/Home/Monitor受信列と新ownerの親関連"
// observation_boundary = "public-boundary"
// scope = "auxiliary-live-owner-generation-isolation"
// lifecycle = "permanent"
// risk_tags = ["privacy"]
// impact = "旧会話の本文が新しいstorage ownerのWindowへ誤配送される"
// distinction = "owner lookup失敗testではなく同一会話IDの再利用中に遅い旧observability callbackと解除を実配送へ通す"
// @end-test-value
/** 同じ Auxiliary ID でストア所有者を交代させても、旧世代の登録、状態通知、解除が新しい親関連や配送記録を変更しない。 */
test("旧generationの処理は新ownerの親関連と配送先を変更しない", () => {
  const f = fixture();
  const id = "same-aux-id";
  const oldOwner = f.owner;
  const oldObservability = f.observability;
  f.admission.add(id);
  f.parents.remember(auxiliary(id), oldOwner);
  f.replaceOwner();
  assert.equal(f.parents.size, 0);
  f.admission.add(id);
  f.parents.remember(auxiliary(id, "parent-b"), f.owner);
  const current = live(id, { assistantText: "new owner's body" });
  f.observability.setLiveSessionRun(id, current);
  const sentBefore = [...f.sent];
  f.parents.remember(auxiliary(id, "parent-a"), oldOwner);
  oldObservability.setLiveSessionRun(
    id,
    live(id, { assistantText: "old owner's body" }),
  );
  oldObservability.setLiveSessionRun(id, null);
  f.parents.delete(id, oldOwner);
  f.parents.releaseIfUnused(id, oldOwner);
  assert.deepEqual(f.sent, sentBefore);
  assert.equal(f.parents.get(id), "parent-b");
  f.admission.delete(id);
  f.parents.releaseIfUnused(id, f.owner);
  assert.equal(f.parents.size, 1);
  f.observability.setLiveSessionRun(id, null);
  assert.equal(f.parents.size, 0);
  assert.deepEqual(
    f.details(),
    [current, null].map((state) => ({
      windowId: "parent-b",
      channel: "withmate:live-session-run",
      payload: { sessionId: id, state },
    })),
  );
});
