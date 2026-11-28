import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildNewSession,
  getSessionIncarnationId,
  projectHomeSessionSummary,
} from "../../src-shared/session/session-state.js";
import type { Session } from "../../src-shared/session/session-state.js";
import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { projectLiveSessionRunStatus } from "../../src-shared/session/live-session-run-status.js";
import { AuxiliaryLiveRunParents } from "../../src-electron/auxiliary/auxiliary-live-run-parents.js";
import { SessionRuntimeService } from "../../src-electron/session/session-runtime-service.js";
import { SessionObservabilityService } from "../../src-electron/session/session-observability-service.js";
import { admitSessionTurn } from "../../src-electron/session/session-turn-admission.js";
import { readSessionMonitorPage } from "../../src-electron/session/session-monitor-query.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import {
  SessionWindowBridge,
  type SessionWindowCloseEvent,
  type SessionWindowLike,
  type SessionWindowRendererState,
} from "../../src-electron/windows/session-window-bridge.js";
import {
  DEFAULT_DRAFT_FLUSH_TIMEOUT_MS,
  DEFAULT_QUIT_DRAFT_FLUSH_TIMEOUT_MS,
  type DraftFlushResult,
} from "../../src-electron/platform/draft-flush-coordinator.js";

// @test-value v2
// kind = "contract"
// claim = "Auxiliaryのqueue開始準備中にquitが取消を要求して失敗しても、親の通常closeは取消収束後までMonitorを保持しStopped再closeで解除する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-window-close" }
// fault = "admission予約前またはprovider読取待ちの取消が子IDを保持し、親closeをStoppedと誤判定する"
// observable = "実runtimeのguardと取消state、close確認回数、Monitor queryの親entryとAuxiliary取消状態、Stopped再close後の空のMonitor"
// observation_boundary = "public-boundary"
// scope = "AuxiliaryLiveRunParents + SessionRuntimeService + admitSessionTurn + SessionWindowBridge + Monitor query"
// lifecycle = "permanent"
// impact = "履歴に状態を表示しない構成で取消終了待ちと結果の確認先を失う"
// distinction = "個別guard stubでは検出できないqueue開始前の親登録と実取消通知、quit失敗後closeの結合をメモリのみで検証する"
// @end-test-value
/** Auxiliary の開始準備中に quit が取消を要求して失敗しても、親窓を閉じた後は停止しても監視に残り、閉じ直した時点で監視を終えることを確かめる。 */
it("queue準備中のAuxiliary取消はquit中止後のcloseでも親を監視保持する", async () => {
  for (const phase of ["reservation", "provider-read"] as const) {
    const parent = createSession({ id: "parent" });
    const auxiliary: AuxiliarySessionSummary = {
      ...parent,
      id: "aux",
      parentSessionId: parent.id,
      title: "Auxiliary",
      runState: "idle",
      displayAfterMessageIndex: null,
      createdAt: "now",
    };
    const owner = {};
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    /** 準備の到達を知らせ、取消と窓終了を試験側で済ませるまで先へ進ませない。 */
    const pause = () => {
      entered();
      return gate;
    };
    let confirmations = 0;
    const bridge = new SessionWindowBridge({
      /** 親セッション用の試験窓を割り当てる。 */
      createWindow: () => new StubWindow(),
      /** チャット UI は読み込まず、ブリッジの終了と監視への登録を試す。 */
      async loadChatEntry() {},
      /** 開いて監視する親だけを永続セッションとして返す。 */
      getSession: (id) => (id === parent.id ? parent : null),
      /** 親自身または親に所属する実行が保留中なら、終了確認が必要と判定する。 */
      isRunInFlight: (id) =>
        runtime.isRunInFlight(id) || parents.hasPendingRunForParent(id),
      /** 実行中の窓を閉じる確認を記録し、通常終了は承認する。 */
      confirmCloseWhileRunning: () => {
        confirmations += 1;
        return true;
      },
      /** 開いている窓の変更は配信せず、公開一覧を直接調べる。 */
      broadcastOpenSessionWindowIds() {},
      /** flush が発行された窓をそのまま応答の送信元に使う。 */
      getWindowSender: (window) => window,
      /** quit の flush には失敗、通常終了の flush には成功を非同期に応答する。 */
      sendDraftFlushRequest: (window, request) => {
        queueMicrotask(() =>
          bridge.acknowledgeDraftFlush(
            request.requestId,
            window,
            request.reason === "close",
          ),
        );
      },
      /** quit からの取消要求を実際の実行管理サービスへ渡す。 */
      cancelInFlightSessionRuns: () => runtime.cancelAllRuns(),
    });
    const parents = new AuxiliaryLiveRunParents({
      /** Auxiliary の関連付けが属する固定のストレージ世代を返す。 */
      getStorageOwner: () => owner,
      /** Auxiliary が実行管理でまだ処理中かを返す。 */
      isRunPending: (id) => runtime.isRunInFlight(id),
      /** 実行詳細が観測用サービスに存在するかを返す。 */
      hasLiveSessionRun: (id) => Boolean(observability.getLiveSessionRun(id)),
      /** 実行中・取消中・承認待ちの通知から、監視すべき親を保持する。 */
      broadcastLiveSessionRun: (id, state) => {
        const status = projectLiveSessionRunStatus(state);
        if (
          status?.runState === "running" ||
          status?.cancellationState ||
          status?.approvalPending
        ) {
          bridge.retainSessionForMonitor(parents.get(id) ?? id);
        }
      },
    });
    const observability = new SessionObservabilityService({
      /** 観測サービスでの状態変更を実際の親解決へ伝える。 */
      onLiveSessionRunChanged: (id, state) => parents.publish(id, state, owner),

      /** この終了試験では Provider 利用枠の通知を扱わない。 */
      onProviderQuotaTelemetryChanged() {},
      /** 文脈使用量の変更は親の監視状態に影響させない。 */
      onSessionContextTelemetryChanged() {},
    });
    /** 取消済みの要求が Provider 準備や永続化まで到達した場合を失敗にする。 */
    const unexpected = () =>
      assert.fail(
        "Canceled admission must not reach provider preparation or persistence",
      );
    const runtime = new SessionRuntimeService({
      /** 実際の開始受付へ予約と取消シグナルを渡し、準備の各段階を試す。 */
      runSessionAdmissionExclusive: (_id, reserve, signal) =>
        admitSessionTurn({
          /** 予約段階を検証するときは、排他内の処理に入る直前で待機する。 */
          runExclusive: async (operation) => {
            if (phase === "reservation") await pause();
            return operation();
          },
          /** 受付で現在状態を再照合するたび、取消済みなら拒否する。 */
          assertCurrent: () => {
            if (signal.aborted) throw new Error("Session run canceled.");
          },
          reserve,
          /** Provider 読取り段階で待機し、解放後は固定の Provider を返す。 */
          readProvider: async () => {
            await pause();
            return "codex";
          },
          /** Provider 自体は利用可能とし、準備を止めた原因を取消に絞る。 */
          assertProviderAvailable() {},
        }),
      getSession: unexpected,
      persistRunningTurnStart: unexpected,
      appendRunningInput: unexpected,
      appendTerminalSession: unexpected,
      checkpointRuntimeMetadata: unexpected,
      resolveComposerPreview: unexpected,
      getAppSettings: unexpected,
      resolveProviderCatalog: unexpected,
      getProviderCodingAdapter: unexpected,
      createSessionTurn: unexpected,
      updateSessionTurn: unexpected,
      /** 実行状態の変更を観測サービスへ保存する。 */
      setLiveSessionRun: (id, state) =>
        observability.setLiveSessionRun(id, state),
      /** 観測サービスから対象 ID の実行状態を取得する。 */
      getLiveSessionRun: (id) => observability.getLiveSessionRun(id),
      /** 保存済みの実行状態を、親の監視情報を扱うサービスへ通知する。 */
      broadcastLiveSessionRun: (id) =>
        parents.publish(id, observability.getLiveSessionRun(id), owner),
      waitForApprovalDecision: unexpected,
      waitForElicitationResponse: unexpected,

      /** 実行準備の試験では Provider 利用枠を保存しない。 */
      setProviderQuotaTelemetry() {},
      /** 文脈のテレメトリ保存はこの試験に含めない。 */
      setSessionContextTelemetry() {},
      /** Provider ネイティブスレッドは終了試験で変更しない。 */
      invalidateProviderSessionThread() {},

      /** 終了・取消の検証中は利用枠の更新を起動しない。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** 承認待ちの UI や応答は試験に作らない。 */
      resolvePendingApprovalRequest() {},
      /** 入力要求への応答は準備中の取消試験に含めない。 */
      resolvePendingElicitationRequest() {},
    });
    const receipt: SessionTurnQueueReceipt = {
      sessionId: auxiliary.id,
      incarnationId: getSessionIncarnationId(parent),
      id: "queue",
      requestId: "13d5a026-53b0-4d79-94bc-a63b7733ab10",
      sequence: 1,
      queuePosition: 1,
      state: "starting",
      turnId: null,
      userMessageSeq: null,
      reason: null,
      releasedAt: null,
      createdAt: "now",
      updatedAt: "now",
      captured: {
        provider: parent.provider,
        workspacePath: parent.workspacePath,
        attachments: [],
        request: {
          clientRequestId: "13d5a026-53b0-4d79-94bc-a63b7733ab10",
          submitSource: "composer",
          userMessage: "queued input",
          executionOptions: captureSessionExecutionOptions(parent),
        },
      },
    };
    receipt.dispatched = structuredClone(receipt.captured);
    /** 実行状態とブリッジの監視保持を公開 Monitor ページへ投影する。 */
    const readMonitor = () =>
      readSessionMonitorPage({
        /** 未読結果の有無ではなく実行・終了状態だけで保持を検証する。 */
        hasUnreadResult: () => false,
        /** ブリッジが実際に監視対象として保持した ID を返す。 */
        listMonitorSessionIds: () => bridge.listMonitorSessionIds(),
        /** 監視対象になった場合だけ親の永続サマリーを返す。 */
        readSummaries: async (ids) =>
          ids.includes(parent.id) ? [projectHomeSessionSummary(parent)] : [],
        /** 親が監視対象に含まれる場合だけ所属 Auxiliary のサマリーを返す。 */
        readAuxiliarySummaries: async (ids) =>
          ids.includes(parent.id) ? [auxiliary] : [],
        /** Monitor に重ねる実際の実行状態を観測サービスから取得する。 */
        getLiveSessionRun: (id) => observability.getLiveSessionRun(id),
      });
    await bridge.openSessionWindow(parent.id);
    const run = parents.trackRun(auxiliary, owner, () =>
      runtime.runQueuedSessionTurn(receipt, unexpected),
    );
    const canceled = assert.rejects(run, /Session run canceled/);
    try {
      await preparing;
      assert.equal(runtime.isRunInFlight(auxiliary.id), true, phase);
      assert.equal(await bridge.flushSessionWindowDrafts(), false);
      assert.equal(bridge.isQuitPending(), false);
      assert.equal(
        observability.getLiveSessionRun(auxiliary.id)?.cancellationState,
        "requested",
      );
      assert.equal(await bridge.requestCloseSessionWindow(parent.id), true);
      assert.equal(confirmations, 1);
      assert.deepEqual(bridge.listOpenSessionWindowIds(), []);
      assert.deepEqual(bridge.listMonitorSessionIds(), [parent.id]);
      assert.equal(runtime.isRunInFlight(auxiliary.id), true);
      const canceling = await readMonitor();
      assert.deepEqual(
        canceling.entries.map((entry) => entry.id),
        [parent.id],
      );
      assert.equal(
        canceling.auxiliarySessions[0]!.cancellationState,
        "requested",
      );

      release();
      await canceled;
      await runtime.waitForPendingRuns();
      assert.equal(runtime.isRunInFlight(auxiliary.id), false);
      assert.equal(parents.size, 0);
      const stopped = await readMonitor();
      assert.deepEqual(
        stopped.entries.map((entry) => entry.id),
        [parent.id],
      );
      assert.equal(stopped.auxiliarySessions[0]!.cancellationState, undefined);
      await bridge.openSessionWindow(parent.id);
      assert.equal(await bridge.requestCloseSessionWindow(parent.id), true);
      assert.equal(confirmations, 1);
      assert.deepEqual(bridge.listMonitorSessionIds(), []);
      assert.deepEqual((await readMonitor()).entries, []);
    } finally {
      release();
      await canceled;
      observability.dispose();
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "実行中のcloseは確認中に完了してもMonitorに残し、再open後のStopped closeでだけ除外する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-window-close" }
// fault = "非同期close完了時の状態で保持判断を上書きする"
// observable = "WindowとMonitorのID一覧、確認取消後のclose結果"
// observation_boundary = "public-boundary"
// scope = "monitor-close-intent"
// lifecycle = "permanent"
// @end-test-value
/** 確認待ちで実行が終わっても終了開始時の実行状態を使って監視を保持し、停止状態で閉じ直す場合だけ解除することを確かめる。 */
it("Monitor保持はclose開始時の状態を使い、Stoppedでの再closeを解除とする", async () => {
  let running = true;
  let resolveConfirmation!: (value: boolean) => void;
  const bridge = new SessionWindowBridge({
    /** 窓の再起動と再終了を試すために新しい試験窓を作る。 */
    createWindow: () => new StubWindow(),
    /** 実画面を読み込まず、窓の登録と終了判断を試す。 */
    async loadChatEntry() {},
    /** 要求した ID に対応する保存済みセッションを返す。 */
    getSession: (id) => createSession({ id }),
    /** 確認待ちの間に切り替わる現在の実行状態を返す。 */
    isRunInFlight: () => running,
    /** 終了確認を試験側が決めるまで待ち、確認中の実行完了を再現する。 */
    confirmCloseWhileRunning: () =>
      new Promise<boolean>((resolve) => {
        resolveConfirmation = resolve;
      }),
    /** 変更通知は発行せず、窓と監視の登録はブリッジの公開一覧で確かめる。 */
    broadcastOpenSessionWindowIds() {},
  });
  await bridge.openSessionWindow("parent");
  bridge.retainSessionForMonitor("parent");
  const closing = bridge.requestCloseSessionWindow("parent");
  running = false;
  resolveConfirmation(true);
  assert.equal(await closing, true);
  assert.deepEqual(bridge.listOpenSessionWindowIds(), []);
  assert.deepEqual(bridge.listMonitorSessionIds(), ["parent"]);
  await bridge.openSessionWindow("parent");
  assert.deepEqual(bridge.listMonitorSessionIds(), ["parent"]);
  assert.equal(await bridge.requestCloseSessionWindow("parent"), true);
  assert.deepEqual(bridge.listMonitorSessionIds(), []);

  running = true;
  await bridge.openSessionWindow("parent");
  const canceled = bridge.requestCloseSessionWindow("parent");
  resolveConfirmation(false);
  assert.equal(await canceled, false);
  running = false;
  assert.equal(await bridge.requestCloseSessionWindow("parent"), true);
  assert.deepEqual(bridge.listMonitorSessionIds(), []);
});

// @test-value v2
// kind = "contract"
// claim = "closeのdraft flush中に完了または新規実行したSessionは結果確認前にMonitorから除外しない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-window-close" }
// fault = "flush ACK後にStoppedだけを見て実行中closeを監視解除する"
// observable = "ACK前後のMonitor ID、実Window ID"
// observation_boundary = "public-boundary"
// scope = "monitor-close-flush"
// lifecycle = "permanent"
// @end-test-value
/** 下書き flush 待ちに実行が完了した場合と新規に開始した場合は、いずれも終了後に Monitor から消えないことを確かめる。 */
it("draft flush中の完了と新規実行をMonitorへ保持する", async () => {
  let running = true;
  const f = createDraftFlushBridge({
    /** flush の前後で変化する実行状態を返す。 */
    isRunInFlight: () => running,
    /** 実行中の終了確認は受理し、下書き保存との競合を試す。 */
    confirmCloseWhileRunning: () => true,
  });
  await f.bridge.openSessionWindow("running-parent");
  const firstClose = f.bridge.requestCloseSessionWindow("running-parent");
  await new Promise((resolve) => setImmediate(resolve));
  running = false;
  let request = f.requests.at(-1)!;
  f.bridge.acknowledgeDraftFlush(request.requestId, request.window, true);
  assert.equal(await firstClose, true);
  assert.deepEqual(f.bridge.listMonitorSessionIds(), ["running-parent"]);

  await f.bridge.openSessionWindow("new-work");
  const nextClose = f.bridge.requestCloseSessionWindow("new-work");
  f.bridge.retainSessionForMonitor("new-work");
  request = f.requests.at(-1)!;
  f.bridge.acknowledgeDraftFlush(request.requestId, request.window, true);
  assert.equal(await nextClose, true);
  assert.deepEqual(
    new Set(f.bridge.listMonitorSessionIds()),
    new Set(["running-parent", "new-work"]),
  );
  assert.deepEqual(f.bridge.listOpenSessionWindowIds(), []);
});

// @test-value v2
// kind = "contract"
// claim = "未実行Windowの通常closeは監視終了し、明示削除とDB resetは閉鎖済み監視対象と保留closeの保持意図を除去する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-window-close" }
// fault = "Windowのない保持IDが削除やreset後も残る、保留closeの完了で削除済みIDが復活する"
// observable = "Monitor ID一覧と実Window一覧"
// observation_boundary = "public-boundary"
// scope = "monitor-cleanup"
// lifecycle = "permanent"
// @end-test-value
/** 未実行窓の終了では監視を解除し、明示削除や reset は閉鎖済み・終了待ちの監視保持も取り除くことを確認する。 */
it("未実行Windowと削除・resetのMonitor対象を整理する", async () => {
  const f = createDraftFlushBridge();
  const window = await f.bridge.openSessionWindow("unrun");
  assert.deepEqual(f.bridge.listMonitorSessionIds(), ["unrun"]);
  const closing = f.bridge.requestCloseSessionWindow("unrun");
  f.bridge.acknowledgeDraftFlush(f.requests[0]!.requestId, window, true);
  assert.equal(await closing, true);
  assert.deepEqual(f.bridge.listMonitorSessionIds(), []);
  f.bridge.retainSessionForMonitor("deleted");
  f.bridge.discardSessionWindow("deleted");
  assert.deepEqual(f.bridge.listMonitorSessionIds(), []);
  f.bridge.retainSessionForMonitor("retained");
  await f.bridge.openSessionWindow("open");
  f.bridge.closeAllSessionWindows();
  assert.deepEqual(f.bridge.listMonitorSessionIds(), []);
  assert.deepEqual(f.bridge.listOpenSessionWindowIds(), []);

  for (const action of ["delete", "reset"] as const) {
    for (const phase of ["confirmation", "flush"] as const) {
      let running = true;
      const race = createDraftFlushBridge({
        /** 削除や reset を挟む前のセッションの実行状態を返す。 */
        isRunInFlight: () => running,
        /** 終了確認の拒否ではなく削除・reset が保持しない理由になるよう、確認を承認する。 */
        confirmCloseWhileRunning: () => true,
      });
      await race.bridge.openSessionWindow("running");
      const pendingClose = race.bridge.requestCloseSessionWindow("running");
      if (phase === "flush")
        await new Promise((resolve) => setImmediate(resolve));
      running = false;
      if (action === "delete") race.bridge.discardSessionWindow("running");
      else race.bridge.closeAllSessionWindows();
      assert.equal(await pendingClose, true);
      const request = race.requests.at(-1);
      if (request)
        assert.equal(
          race.bridge.acknowledgeDraftFlush(
            request.requestId,
            request.window,
            true,
          ),
          false,
        );
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(
        race.bridge.listMonitorSessionIds(),
        [],
        `${action} during ${phase}`,
      );
      assert.deepEqual(race.bridge.listOpenSessionWindowIds(), []);
    }
  }
});

/** 窓を開ける基本の保存セッションを、各試験で ID や状態を上書きできる形で作る。 */
function createSession(overrides?: Partial<Session>): Session {
  return {
    ...buildNewSession({
      taskTitle: "Window Test",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
    }),
    ...overrides,
  };
}

/** 実 Electron を使わず、窓の表示・最小化・終了とイベントの順序を観測できる代替窓。 */
class StubWindow implements SessionWindowLike {
  destroyed = false;
  delayClosedEvent = false;
  minimized = false;
  visible = false;
  focused = false;
  showCount = 0;
  focusCount = 0;
  restoreCount = 0;
  closeCount = 0;
  destroyCount = 0;
  readonly activationOperations: string[] = [];
  private readonly readyListeners: Array<() => void> = [];
  private readonly closeListeners: Array<
    (event: SessionWindowCloseEvent) => void
  > = [];
  private readonly closedListeners: Array<() => void> = [];

  /** 強制または通常終了で破棄された状態を返す。 */
  isDestroyed(): boolean {
    return this.destroyed;
  }

  /** 表示操作の結果として保持している最小化状態を返す。 */
  isMinimized(): boolean {
    return this.minimized;
  }

  /** 窓を不可視・非フォーカスにし、最小化だけを要求されたことを記録する。 */
  minimize(): void {
    this.minimized = true;
    this.visible = false;
    this.focused = false;
    this.activationOperations.push("minimize");
  }

  /** 最小化を解除して表示状態にし、復元操作を記録する。 */
  restore(): void {
    this.minimized = false;
    this.visible = true;
    this.restoreCount += 1;
    this.activationOperations.push("restore");
  }

  /** フォーカス状態に移し、操作回数と順序を記録する。 */
  focus(): void {
    this.focused = true;
    this.focusCount += 1;
    this.activationOperations.push("focus");
  }

  /** 表示とフォーカスを有効にし、表示操作を記録する。 */
  show(): void {
    this.visible = true;
    this.focused = true;
    this.showCount += 1;
    this.activationOperations.push("show");
  }

  /** close イベントでキャンセルできる通常終了を模し、必要なら終了通知を保留する。 */
  close(): void {
    this.closeCount += 1;
    if (this.destroyed) {
      return;
    }

    let prevented = false;
    const event: SessionWindowCloseEvent = {
      /** close リスナーが既定終了を止めたことを保存する。 */
      preventDefault() {
        prevented = true;
      },
    };
    for (const listener of this.closeListeners) {
      listener(event);
    }
    if (prevented) {
      return;
    }

    this.destroyed = true;
    if (!this.delayClosedEvent) {
      this.emitClosed();
    }
  }

  /** close イベントを経由しない強制終了を模し、終了通知の遅延も再現する。 */
  destroy(): void {
    this.destroyCount += 1;
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    if (!this.delayClosedEvent) {
      this.emitClosed();
    }
  }

  /** 表示準備の合図を一度だけ受け取るリスナーを登録する。 */
  once(event: "ready-to-show", listener: () => void): void {
    if (event === "ready-to-show") {
      this.readyListeners.push(listener);
    }
  }

  /** 既定終了を止められる close リスナーを受け付ける。 */
  on(event: "close", listener: (event: SessionWindowCloseEvent) => void): void;
  /** 終了確定時だけ呼ぶ closed リスナーを受け付ける。 */
  on(event: "closed", listener: () => void): void;
  /** 通常終了確認と終了確定を別のリスナー集合へ登録する。 */
  on(
    event: "close" | "closed",
    listener: ((event: SessionWindowCloseEvent) => void) | (() => void),
  ): void {
    if (event === "close") {
      this.closeListeners.push(
        listener as (event: SessionWindowCloseEvent) => void,
      );
      return;
    }

    this.closedListeners.push(listener as () => void);
  }

  /** ready の保留リスナーを一回だけ実行する。 */
  emitReady(): void {
    for (const listener of this.readyListeners.splice(0)) {
      listener();
    }
  }

  /** 終了通知を待っていたリスナーを一回だけ実行する。 */
  emitClosed(): void {
    for (const listener of this.closedListeners.splice(0)) {
      listener();
    }
  }

  /** 指定した可視・最小化状態へ戻し、前段の操作履歴を消して比較を始める。 */
  resetActivation(options: { minimized: boolean; visible: boolean }): void {
    this.minimized = options.minimized;
    this.visible = options.visible;
    this.focused = false;
    this.showCount = 0;
    this.focusCount = 0;
    this.restoreCount = 0;
    this.activationOperations.splice(0);
  }
}

/** 下書き flush 要求と解除、窓終了、レンダラー状態を試験側で操作・観測できるブリッジを用意する。 */
function createDraftFlushBridge(
  options: {
    waitForPendingDraftSends?: () => Promise<boolean>;
    getWindowSender?: (window: StubWindow) => unknown;
    isRunInFlight?: () => boolean;
    confirmCloseWhileRunning?: () => boolean;
  } = {},
) {
  const requests: Array<{
    window: StubWindow;
    requestId: string;
    sessionId: string;
    reason: "close" | "quit";
  }> = [];
  const releases: StubWindow[] = [];
  const closedIds: string[] = [];
  const windows: StubWindow[] = [];
  const settled: DraftFlushResult[] = [];
  const rendererObservers = new Map<
    StubWindow,
    (state: SessionWindowRendererState) => void
  >();
  const bridge = new SessionWindowBridge({
    /** 生成した試験窓を記録し、終了要求の応答元として指定できるようにする。 */
    createWindow: () => {
      const window = new StubWindow();
      windows.push(window);
      return window;
    },
    /** renderer 復旧や停止を後から通知できるよう窓ごとの監視処理を保持する。 */
    observeRendererState: (window, changed) => {
      rendererObservers.set(window, changed);
    },
    /** 下書き flush がどの結果で決着したかを順に記録する。 */
    onDraftFlushSettled: (result) => {
      settled.push(result);
    },
    /** 実チャットは起動せず終了プロトコルだけを試す。 */
    async loadChatEntry() {},
    /** 開くために要求された ID の保存済みセッションを組み立てる。 */
    getSession: (id) => createSession({ id }),
    isRunInFlight: options.isRunInFlight ?? (() => false),
    confirmCloseWhileRunning: options.confirmCloseWhileRunning ?? (() => false),
    /** 配信内容は試験対象ではないため、実 renderer には送信しない。 */
    broadcastOpenSessionWindowIds() {},
    /** 終了通知を受けたセッション ID を保存する。 */
    onSessionWindowClosed: (id) => {
      closedIds.push(id);
    },
    getWindowSender: options.getWindowSender ?? ((window) => window),
    /** 要求 ID と送信先の窓を記録して、試験側から後で応答できるようにする。 */
    sendDraftFlushRequest: (window, request) => {
      requests.push({ window, ...request });
    },
    /** 終了中止後に編集を再開した窓を記録する。 */
    sendDraftFlushRelease: (window) => {
      releases.push(window);
    },
    waitForPendingDraftSends: options.waitForPendingDraftSends,
  });
  /** 指定した窓の監視処理に renderer 状態の変化を直接届ける。 */
  const notifyRenderer = (
    window: StubWindow,
    state: SessionWindowRendererState,
  ) => rendererObservers.get(window)!(state);
  return {
    bridge,
    requests,
    releases,
    closedIds,
    windows,
    settled,
    notifyRenderer,
  };
}

/** セッション窓の表示、終了時の下書き保存、再起動時の復元と監視の連携を確認する。 */
describe("SessionWindowBridge", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "自動新規Windowは通常表示・focusなしで最小化し、既存Windowの表示を変えず、明示openは最小化解除・focusする"
  // oracle = { type = "contract", ref = "docs/features/session-window-restore.md#復元操作; GitHub Issue #927" }
  // fault = "自動作成でshow/focusするか、既存Windowを再最小化するか、明示openでWindowを利用できない"
  // observable = "Windowのactivation操作列、registry・Monitor・保存集合、Window作成数"
  // observation_boundary = "component-behavior"
  // scope = "session-window-minimized-presentation"
  // lifecycle = "permanent"
  // distinction = "native表示の実機QAとは別にBridgeが表示前にshow/focusを要求しないことと保存経路の接続を確認する"
  // @end-test-value
  /** 自動で開く新規窓には最小化だけを要求し、自動で開き直しても操作を増やさず、明示要求でだけ通常表示とフォーカスに切り替えることを確かめる。 */
  it("自動openは最小化だけを要求し、既存Windowには触らず明示openを前面化する", async () => {
    const windows: StubWindow[] = [];
    const snapshots: string[][] = [];
    const bridge = new SessionWindowBridge({
      /** 二重生成を検出できるよう、作成した試験窓をすべて登録する。 */
      createWindow() {
        const window = new StubWindow();
        windows.push(window);
        return window;
      },
      /** チャットを実読込みせず、窓表示の切替だけを観測する。 */
      async loadChatEntry() {},
      /** 表示試験に利用できる保存済みセッションを返す。 */
      getSession: () => createSession(),
      /** 実行中の終了確認の影響を避け、実行はないと返す。 */
      isRunInFlight: () => false,
      /** この試験では実行中の終了は承認しない。 */
      confirmCloseWhileRunning: () => false,
      /** 表示と復元対象の記録を直接確認し、IPC 配信は使わない。 */
      broadcastOpenSessionWindowIds() {},
      /** 復元対象として保存を求められた ID 列のコピーを記録する。 */
      async persistOpenSessionWindowIds(ids) {
        snapshots.push([...ids]);
      },
    });
    const window = await bridge.openSessionWindow("auto", {
      presentation: "minimized",
    });
    assert.deepEqual(window.activationOperations, []);
    window.emitReady();
    assert.deepEqual(window.activationOperations, ["minimize"]);
    assert.equal(window.focused, false);
    assert.deepEqual(bridge.listMonitorSessionIds(), ["auto"]);
    assert.deepEqual(snapshots.at(-1), ["auto"]);
    assert.equal(
      await bridge.openSessionWindow("auto", { presentation: "minimized" }),
      window,
    );
    assert.deepEqual(window.activationOperations, ["minimize"]);
    await bridge.openSessionWindow("auto");
    assert.deepEqual(window.activationOperations, [
      "minimize",
      "restore",
      "show",
      "focus",
    ]);
    await bridge.openSessionWindow("auto", { presentation: "minimized" });
    assert.deepEqual(window.activationOperations, [
      "minimize",
      "restore",
      "show",
      "focus",
    ]);
    assert.equal(windows.length, 1);
    window.destroy();
  });

  // @test-value v2
  // kind = "contract"
  // claim = "最小化生成中の明示openはreadyとloadの前後を問わず通常表示を優先し、遅い自動処理で再最小化・再focusしない"
  // oracle = { type = "contract", ref = "GitHub Issue #927: ユーザーの明示操作を優先する" }
  // fault = "生成中の明示openを最小化で上書きするか、遅いready/loadで二度focusするか、Auxiliary移動を失う"
  // observable = "共有open結果、activation操作列、Window作成数、Auxiliary navigation payload"
  // observation_boundary = "component-behavior"
  // scope = "session-window-minimized-explicit-open-race"
  // lifecycle = "permanent"
  // @end-test-value
  /** ready と load の前後いずれでも、生成中の自動窓への明示要求が通常表示を優先し、窓を増やさず目的の Auxiliary へ移動することを確認する。 */
  it("ready前・ready後・load後の明示openは自動最小化より優先し、Auxiliaryへ移動する", async () => {
    for (const phase of [
      "before-ready",
      "after-ready",
      "after-load",
    ] as const) {
      let finishLoad!: () => void;
      const loading = new Promise<void>((resolve) => {
        finishLoad = resolve;
      });
      const window = new StubWindow();
      const navigations: unknown[] = [];
      let created = 0;
      const bridge = new SessionWindowBridge({
        /** 同じ試験窓を返して呼出しを数え、競合時の二重生成を検出する。 */
        createWindow() {
          created += 1;
          return window;
        },
        /** 準備段階を試験側で切り替えるまでチャットの読込みを保留する。 */
        loadChatEntry: () => loading,
        /** 明示要求に対応する Auxiliary の移動先を記録する。 */
        sendAuxiliarySessionNavigation(_window, payload) {
          navigations.push(payload);
        },
        /** 自動または明示で窓を開ける保存済みセッションを返す。 */
        getSession: () => createSession(),
        /** 表示切替の試験では実行中のセッションを作らない。 */
        isRunInFlight: () => false,
        /** 表示競合だけを観測し、終了要求は承認しない。 */
        confirmCloseWhileRunning: () => false,
        /** 窓の表示と移動を直接記録するため、開窓一覧は通知しない。 */
        broadcastOpenSessionWindowIds() {},
      });
      const automatic = bridge.openSessionWindow("auto", {
        presentation: "minimized",
      });
      if (phase === "after-ready") window.emitReady();
      if (phase === "after-load") {
        finishLoad();
        await automatic;
      }
      const explicit = bridge.openAuxiliarySessionWindow("auto", "aux");
      const repeatedAutomatic = bridge.openSessionWindow("auto", {
        presentation: "minimized",
      });
      if (phase === "before-ready") window.emitReady();
      if (phase !== "after-load") finishLoad();
      assert.equal(await automatic, window);
      assert.equal(await explicit, window);
      assert.equal(await repeatedAutomatic, window);
      window.emitReady();
      assert.deepEqual(
        window.activationOperations,
        phase === "after-ready"
          ? ["minimize", "restore", "show", "focus"]
          : ["show", "focus"],
      );
      assert.deepEqual(navigations, [
        { parentSessionId: "auto", auxiliarySessionId: "aux" },
      ]);
      assert.equal(created, 1);
      window.destroy();
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "初回queued AuxiliaryのadmissionとSession読込み待機中も親Windowのcloseを確認し、開始失敗後は警告と不要な親関連を残さない"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-window-close; GitHub Issue #877" }
  // fault = "親関連をprovider session解決まで登録しないか、開始失敗で親関連を解放しない"
  // observable = "実runtimeのin-flight、Close確認回数と結果、Window生存、flush要求、queue失敗結果、親関連数"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService queued admission + AuxiliaryLiveRunParents + SessionWindowBridge"
  // lifecycle = "permanent"
  // impact = "送信済みAuxiliaryの開始準備中に警告なく閉じるか、開始失敗後も不要な警告を出す"
  // distinction = "登録済みregistryの状態比較では検出できない、実queued runtimeの最初のguardと親関連の登録タイミングを待機gateで確認する"
  // @end-test-value
  /** Auxiliary で初めてキューから実行するとき、受付やセッション読取り中でも親窓の終了を確認し、開始失敗後は警告なく閉じられることを確かめる。 */
  it("初回queued Auxの開始準備中もcloseを確認し開始失敗後は解除する", async () => {
    for (const phase of ["admission", "session-read"] as const) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      /** 開始失敗の試験で Provider 準備が呼ばれた場合にその場で失敗する。 */
      const unexpected = (): never => {
        throw new Error("Provider setup must not start");
      };
      const runtime = new SessionRuntimeService({
        /** 試験段階に応じて受付を保留し、下流の開始処理より前に窓の終了を要求できるようにする。 */
        runSessionAdmissionExclusive: async (_id, operation) => {
          if (phase === "admission") {
            entered();
            await gate;
          }
          return operation();
        },
        /** 受付後の読取り中にも競合を作り、開始失敗となるセッション読取り結果を返す。 */
        getSession: async () => {
          if (phase === "session-read") {
            entered();
            await gate;
          }
          return null;
        },
        persistRunningTurnStart: unexpected,
        appendRunningInput: unexpected,
        checkpointRuntimeMetadata: unexpected,
        appendTerminalSession: unexpected,
        resolveComposerPreview: unexpected,
        getAppSettings: unexpected,
        resolveProviderCatalog: unexpected,
        getProviderCodingAdapter: unexpected,
        createSessionTurn: unexpected,
        updateSessionTurn: unexpected,

        /** 実行詳細の保存は行わず、受付中の状態だけを試す。 */
        setLiveSessionRun() {},
        /** 初回のため保存された実行詳細は存在しないと返す。 */
        getLiveSessionRun: () => null,
        waitForApprovalDecision: unexpected,
        waitForElicitationResponse: unexpected,
        setProviderQuotaTelemetry: unexpected,
        setSessionContextTelemetry: unexpected,
        invalidateProviderSessionThread: unexpected,
        scheduleProviderQuotaTelemetryRefresh: unexpected,

        /** 開始前の試験では実行詳細の配信は行わない。 */
        broadcastLiveSessionRun() {},
        /** 承認応答を経由しない開始試験として扱う。 */
        resolvePendingApprovalRequest() {},
        /** ユーザーへの入力要求は試験に作らない。 */
        resolvePendingElicitationRequest() {},
      });
      const owner = {};
      const auxiliary = { id: "first-aux", parentSessionId: "parent" as const };
      const parents = new AuxiliaryLiveRunParents({
        /** Auxiliary と親を照合する固定の保存世代を返す。 */
        getStorageOwner: () => owner,
        /** Auxiliary の処理中かどうかを実行管理サービスの状態から判定する。 */
        isRunPending: (id) => runtime.isRunInFlight(id),

        /** 初回受付中はまだ実行詳細がないものとする。 */
        hasLiveSessionRun: () => false,
        /** 親関連付けの有無は内部状態を読むため、配信は行わない。 */
        broadcastLiveSessionRun() {},
      });
      const receipt: SessionTurnQueueReceipt = {
        id: "queue-1",
        requestId: "request-1",
        sessionId: auxiliary.id,
        incarnationId: "incarnation-1",
        sequence: 1,
        queuePosition: 1,
        state: "starting",
        turnId: null,
        userMessageSeq: null,
        reason: null,
        releasedAt: null,
        createdAt: "2026-10-24T00:00:00Z",
        updatedAt: "2026-10-24T00:00:00Z",
        captured: {
          request: {
            userMessage: "Start",
            clientRequestId: "request-1",
            submitSource: "composer",
            executionOptions: captureSessionExecutionOptions(createSession()),
          },
          attachments: [],
          provider: "codex",
          workspacePath: "C:/workspace",
        },
      };
      assert.equal(parents.size, 0);
      receipt.dispatched = structuredClone(receipt.captured);
      const running = parents.trackRun(auxiliary, owner, () =>
        runtime.runQueuedSessionTurn(receipt, unexpected),
      );
      try {
        await ready;
        assert.equal(runtime.isRunInFlight(auxiliary.id), true);
        let confirmations = 0;
        const { bridge, requests } = createDraftFlushBridge({
          /** 対象の親に処理中の Auxiliary がある間は終了確認対象にする。 */
          isRunInFlight: () => parents.hasPendingRunForParent("parent"),
          /** 終了確認を記録して拒否し、処理中の親窓を保持する。 */
          confirmCloseWhileRunning: () => {
            confirmations += 1;
            return false;
          },
        });
        const window = await bridge.openSessionWindow("parent");
        assert.equal(await bridge.requestCloseSessionWindow("parent"), false);
        assert.equal(confirmations, 1);
        assert.equal(window.isDestroyed(), false);
        assert.equal(requests.length, 0);
        assert.equal(runtime.isRunInFlight(auxiliary.id), true);
        release();
        assert.equal((await running).state, "failed");
        assert.equal(runtime.isRunInFlight(auxiliary.id), false);
        assert.equal(parents.size, 0);
        const closing = bridge.requestCloseSessionWindow("parent");
        assert.equal(confirmations, 1);
        assert.equal(requests.length, 1);
        bridge.acknowledgeDraftFlush(requests[0].requestId, window, true);
        assert.equal(await closing, true);
      } finally {
        release();
        await running;
      }
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Mainまたは親配下Auxiliaryの実行中closeは一つの確認を行い、取消ではWindowとrunを維持し、続行ではdraft flush後にrunを維持して閉じる"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-window-close; GitHub Issue #877" }
  // fault = "Auxiliaryのみの実行を取りこぼす、確認が重複する、取消でflushやcloseを行う、または実行なしでも警告する"
  // observable = "確認回数、close要求結果、Window生存、draft flush要求とACK、取消呼出回数、保持run集合"
  // observation_boundary = "public-boundary"
  // scope = "SessionWindowBridge + AuxiliaryLiveRunParents close lifecycle"
  // lifecycle = "permanent"
  // impact = "非選択Auxiliaryを見落とすか、取消の意思に反してWindowまたは実行を失う"
  // distinction = "Mainのみのboolean stubによる既存close testと異なり、親関連registryで複数Auxiliaryと別親の実guardを結合する"
  // @end-test-value
  /** Main または Auxiliary の実行があれば一回だけ確認し、終了の取消・承認いずれでも実行自体は取り消さないことを確かめる。 */
  it("Mainと全Auxiliaryのclose確認を集約し実行を維持する", async () => {
    for (const running of [
      [],
      ["parent"],
      ["aux-background"],
      ["parent", "aux-background"],
      ["aux-background", "aux-second"],
      ["aux-other-parent"],
    ]) {
      const runs = new Set(running);
      const owner = {};
      const parents = new AuxiliaryLiveRunParents({
        /** 親と Auxiliary の関連を固定されたストレージ世代で管理する。 */
        getStorageOwner: () => owner,
        /** 試験で実行中とした ID だけを処理中とする。 */
        isRunPending: (id) => runs.has(id),
        /** 最新の実行詳細ではなく処理受理の状態だけを使って確認を試す。 */
        hasLiveSessionRun: () => false,
        /** 実行詳細をつかう UI は起動しない。 */
        broadcastLiveSessionRun() {},
      });
      for (const id of ["aux-background", "aux-second", "aux-other-parent"]) {
        parents.remember(
          {
            id,
            parentSessionId:
              id === "aux-other-parent" ? "other-parent" : "parent",
          },
          owner,
        );
      }
      const requests: Array<{
        requestId: string;
        sessionId: string;
        reason: "close" | "quit";
      }> = [];
      let confirmations = 0;
      let cancellations = 0;
      let decide!: (approved: boolean) => void;
      const bridge = new SessionWindowBridge({
        /** 終了の取消と承認を同じ試験窓で観測する。 */
        createWindow: () => new StubWindow(),
        /** チャットを読まずに窓を開き、終了の流れだけを試す。 */
        async loadChatEntry() {},
        /** 開かれた ID に対応する保存済みセッションを返す。 */
        getSession: (id) => createSession({ id }),
        /** Main 自身または所属 Auxiliary のいずれかが実行中であれば終了確認の対象にする。 */
        isRunInFlight: (id) =>
          runs.has(id) || parents.hasPendingRunForParent(id),
        /** 終了確認を数え、試験側が回答するまで終了手続を保留する。 */
        confirmCloseWhileRunning: () => {
          confirmations += 1;
          return new Promise<boolean>((resolve) => {
            decide = resolve;
          });
        },
        /** 開窓一覧の通知は発行せず、窓の状態を直接確認する。 */
        broadcastOpenSessionWindowIds() {},
        /** flush 応答の識別に試験窓自身を使う。 */
        getWindowSender: (window) => window,
        /** 終了を承認した後で発行された下書き保存要求を記録する。 */
        sendDraftFlushRequest: (_window, request) => {
          requests.push(request);
        },
        /** 窓を閉じただけで実行が取り消された場合に呼出数と実行一覧で検出する。 */
        cancelInFlightSessionRuns: () => {
          cancellations += 1;
          runs.clear();
        },
      });
      const window = await bridge.openSessionWindow("parent", {
        auxiliarySessionId: "aux-selected-idle",
      });
      const shouldWarn = running.some((id) => id !== "aux-other-parent");
      const firstClose = bridge.requestCloseSessionWindow("parent");
      window.close();
      assert.equal(confirmations, shouldWarn ? 1 : 0, running.join(","));
      assert.equal(window.isDestroyed(), false);

      let closing = firstClose;
      if (shouldWarn) {
        assert.equal(requests.length, 0);
        decide(false);
        assert.equal(await firstClose, false);
        assert.equal(bridge.getWindow("parent"), window);
        assert.equal(window.isDestroyed(), false);
        assert.equal(requests.length, 0);
        assert.deepEqual([...runs], running);
        closing = bridge.requestCloseSessionWindow("parent");
        assert.equal(confirmations, 2);
        decide(true);
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(requests.length, 1);
      assert.equal(requests[0].reason, "close");
      assert.equal(window.isDestroyed(), false);
      assert.equal(
        bridge.acknowledgeDraftFlush(requests[0].requestId, window, true),
        true,
      );
      assert.equal(await closing, true);
      assert.equal(window.isDestroyed(), true);
      assert.equal(bridge.getWindow("parent"), null);
      assert.equal(confirmations, shouldWarn ? 2 : 0);
      assert.equal(cancellations, 0);
      assert.deepEqual([...runs], running);
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "死亡RendererはACKなしでcloseを完了でき、再openは旧Windowの実closed後に一つだけ新規Windowをloadする"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#close-behavior" }
  // fault = "死亡RendererのACK待ちでcloseが止まるか、実closed前や並行openでWindowを重複生成する"
  // observable = "close結果、flush分類、新規Window数、並行openの結果とclosed通知"
  // observation_boundary = "public-boundary"
  // scope = "session-window-renderer-gone-recovery"
  // lifecycle = "permanent"
  // impact = "黒画面から戻れないか、同一Sessionの表示Windowが重複する"
  // distinction = "健康なWindowのopenやload failureでは表現できないRenderer死亡と遅延closedをメモリWindowで検証する"
  // @end-test-value
  /** 停止した renderer の窓は flush 応答なしで閉じ、新しい窓は旧窓の実 closed が届いた後に一つだけ開くことを確認する。 */
  it("死亡Rendererのcloseと実closed後の単一再openを完了する", async () => {
    const { bridge, windows, requests, settled, closedIds, notifyRenderer } =
      createDraftFlushBridge();
    const closedWindow = await bridge.openSessionWindow("gone-close");
    notifyRenderer(closedWindow, "gone");
    assert.equal(await bridge.requestCloseSessionWindow("gone-close"), true);
    assert.deepEqual(
      settled.map((result) => result.outcome),
      ["renderer-gone"],
    );
    assert.equal(closedWindow.isDestroyed(), true);

    const oldWindow = await bridge.openSessionWindow("gone-reopen");
    oldWindow.delayClosedEvent = true;
    notifyRenderer(oldWindow, "gone");
    const firstOpen = bridge.openSessionWindow("gone-reopen");
    const secondOpen = bridge.openSessionWindow("gone-reopen");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(oldWindow.destroyCount, 1);
    assert.equal(
      windows.length,
      2,
      "replacement must wait for the real closed event",
    );
    oldWindow.emitClosed();
    const [first, second] = await Promise.all([firstOpen, secondOpen]);
    assert.equal(first, second);
    assert.notEqual(first, oldWindow);
    assert.equal(windows.length, 3);
    assert.equal(bridge.getWindow("gone-reopen"), first);
    assert.deepEqual(closedIds, ["gone-close", "gone-reopen"]);
    assert.deepEqual(requests, []);
    first.destroy();
  });

  // @test-value v2
  // kind = "contract"
  // claim = "応答不能Rendererの再openは実行中close確認の取消を尊重し、承認後は負ACKまたはtimeoutで旧入力を破棄して再生成する"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#close-behavior" }
  // fault = "取消時にWindowを破棄するか、承認後の負ACKまたはtimeoutで復旧できず、旧ACKが新Windowを閉じる"
  // observable = "確認回数、open結果、Window生成数、flush分類、旧ACK受理と新Window生存状態"
  // observation_boundary = "public-boundary"
  // scope = "session-window-unresponsive-reopen"
  // lifecycle = "permanent"
  // impact = "ユーザーの取消を無視するか、応答不能の入力画面から復旧できない"
  // distinction = "close確認とflushの失敗期限を組み合わせ、既存の正常close・quit競合とは別の再open動作を検証する"
  // @end-test-value
  /** 応答不能な窓を開き直す際も終了確認の拒否を尊重し、許可後は負の ACK または時間切れで古い窓を閉じて再生成することを確かめる。 */
  it("応答不能の再openは取消を維持し負ACKとtimeoutから復旧する", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const outcome of ["rejected", "timeout"] as const) {
      let approved = false;
      let confirmations = 0;
      const { bridge, requests, windows, settled, notifyRenderer } =
        createDraftFlushBridge({
          /** renderer が応答不能でもセッションの実行は継続中とする。 */
          isRunInFlight: () => true,
          /** 試験段階に応じて終了を拒否または承認し、その確認回数を記録する。 */
          confirmCloseWhileRunning: () => {
            confirmations += 1;
            return approved;
          },
        });
      const oldWindow = await bridge.openSessionWindow("unresponsive");
      notifyRenderer(oldWindow, "unresponsive");
      assert.equal(await bridge.openSessionWindow("unresponsive"), oldWindow);
      assert.equal(oldWindow.isDestroyed(), false);
      assert.equal(requests.length, 0);
      approved = true;
      const reopening = bridge.openSessionWindow("unresponsive");
      await new Promise((resolve) => setImmediate(resolve));
      const request = requests[0];
      assert.equal(request.reason, "close");
      if (outcome === "rejected")
        bridge.acknowledgeDraftFlush(request.requestId, oldWindow, false);
      else t.mock.timers.tick(DEFAULT_DRAFT_FLUSH_TIMEOUT_MS);
      const replacement = await reopening;
      assert.equal(confirmations, 2);
      assert.equal(oldWindow.isDestroyed(), true);
      assert.notEqual(replacement, oldWindow);
      assert.equal(windows.length, 2);
      assert.deepEqual(
        settled.map((result) => result.outcome),
        [outcome],
      );
      assert.equal(
        bridge.acknowledgeDraftFlush(request.requestId, oldWindow, true),
        false,
      );
      assert.equal(bridge.getWindow("unresponsive"), replacement);
      assert.equal(replacement.isDestroyed(), false);
      replacement.destroy();
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "応答不能通知後にresponsiveへ復帰したRendererは再openで再利用されfocusされる"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#close-behavior" }
  // fault = "一時的な応答不能を永久障害として扱い、復帰後もWindowを破棄して入力を失う"
  // observable = "open結果の同一性、作成Window数、focus状態とflush要求"
  // observation_boundary = "public-boundary"
  // scope = "session-window-renderer-responsive-recovery"
  // lifecycle = "permanent"
  // impact = "復帰済みの表示・未保存入力を不要に失う"
  // distinction = "通常の健康Window再利用では検証できない障害通知後の復帰遷移を観測する"
  // @end-test-value
  /** 応答不能から復帰した窓を再度開く場合、古い窓を破棄したり flush を始めたりせずそのまま前面化することを確かめる。 */
  it("responsive復帰後の再openは同じWindowを再利用する", async () => {
    const { bridge, requests, windows, notifyRenderer } =
      createDraftFlushBridge();
    const window = await bridge.openSessionWindow("responsive");
    notifyRenderer(window, "unresponsive");
    notifyRenderer(window, "responsive");
    window.resetActivation({ minimized: false, visible: true });
    assert.equal(await bridge.openSessionWindow("responsive"), window);
    assert.equal(windows.length, 1);
    assert.deepEqual(window.activationOperations, ["show", "focus"]);
    assert.deepEqual(requests, []);
    window.destroy();
  });

  // @test-value v2
  // kind = "contract"
  // claim = "新規Session WindowをopenするとWindowを作成し、registryへ登録してopen通知を行う"
  // oracle = { type = "contract", ref = "SessionWindowBridge#openSessionWindow" }
  // fault = "新規Windowが作成されない、registryへ登録されない、またはopen通知が行われない"
  // observable = "作成Window、loadされたchat mode、registryとopen Session ID通知"
  // observation_boundary = "public-boundary"
  // scope = "session-window-open"
  // lifecycle = "permanent"
  // impact = "Session画面を開けず、復元対象のWindow集合が不整合になる"
  // distinction = "open処理のregistryとentry load結果を確認し、既存Window再利用や失敗時claim破棄とは分ける"
  // @end-test-value
  /** 初回の open が窓を登録して対象セッションのチャットを読み込み、開窓 ID の通知と表示を行うことを確かめる。 */
  it("新規 open で registry 更新・entry load を行う", async () => {
    const session = createSession();
    const windows: StubWindow[] = [];
    const broadcasts: string[][] = [];
    let loadedChatMode: unknown = null;

    const bridge = new SessionWindowBridge({
      /** 初回 open で作られた窓を保持し、登録された窓と照合する。 */
      createWindow() {
        const window = new StubWindow();
        windows.push(window);
        return window;
      },
      /** 読込み要求に含まれるセッションとチャットのモードを記録する。 */
      async loadChatEntry(_window, mode) {
        loadedChatMode = mode;
      },
      /** 開く ID に一致する保存済みセッションを返す。 */
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      /** 新規表示の試験では現在の実行はないとする。 */
      isRunInFlight() {
        return false;
      },
      /** 新規表示だけを検証し、実行中の終了要求は承認しない。 */
      confirmCloseWhileRunning() {
        return false;
      },
      /** 開窓一覧の通知を順に保存し、登録直後の ID を観測する。 */
      broadcastOpenSessionWindowIds(openIds) {
        broadcasts.push([...openIds]);
      },
    });

    const window = await bridge.openSessionWindow(session.id);
    window.emitReady();

    assert.equal(bridge.getWindow(session.id), window);
    assert.deepEqual(loadedChatMode, { kind: "agent", sessionId: session.id });
    assert.deepEqual(broadcasts.at(-1), [session.id]);
    assert.equal(window.showCount, 1);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "既存Session WindowへのAuxiliary navigationは親Windowを再利用して対象Auxiliaryの識別情報だけをrendererへ渡す"
  // oracle = { type = "adr", ref = "docs/adr/006-windows-session-turn-notifications.md" }
  // fault = "Auxiliary通知のclickで別Windowを作る、親Windowをfocusしない、または対象AuxiliaryのIDを失う"
  // observable = "作成Window数、Windowのactivation操作、renderer navigation payload"
  // observation_boundary = "public-boundary"
  // scope = "session-window-auxiliary-navigation"
  // lifecycle = "permanent"
  // distinction = "通常のSession Window open testでは検証できない、既存Window再利用時のAuxiliary navigationを専用に検証する"
  // @end-test-value
  /** 既存の親窓に Auxiliary を開く場合は窓を再利用し、対象を示す移動通知だけを送って前面化することを確認する。 */
  it("既存Session WindowへのAuxiliary openはWindowを再利用して対象を通知する", async () => {
    const session = createSession();
    const window = new StubWindow();
    const navigationPayloads: unknown[] = [];
    let createCount = 0;
    const bridge = new SessionWindowBridge({
      /** 既存窓を再利用したかを生成回数で確かめられるようにする。 */
      createWindow() {
        createCount += 1;
        return window;
      },
      /** チャットの読み込みは省略し、既存 renderer への移動を観測する。 */
      async loadChatEntry() {},
      /** 親と Auxiliary の識別子を含む移動通知を記録する。 */
      sendAuxiliarySessionNavigation(_window, payload) {
        navigationPayloads.push(payload);
      },
      /** 移動先の親 ID に一致する保存セッションを返す。 */
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      /** 窓再利用の試験では実行中の処理を扱わない。 */
      isRunInFlight() {
        return false;
      },
      /** 終了確認の承認なしで窓再利用が成立する条件を作る。 */
      confirmCloseWhileRunning() {
        return false;
      },
      /** 開窓通知は記録せず、窓数と移動通知を照合する。 */
      broadcastOpenSessionWindowIds() {},
    });

    await bridge.openSessionWindow(session.id);
    window.resetActivation({ minimized: false, visible: true });
    await bridge.openAuxiliarySessionWindow(session.id, "auxiliary-1");

    assert.equal(createCount, 1);
    assert.deepEqual(window.activationOperations, ["show", "focus"]);
    assert.deepEqual(navigationPayloads, [
      {
        parentSessionId: session.id,
        auxiliarySessionId: "auxiliary-1",
      },
    ]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "新規Session WindowへのAuxiliary openはentry loadへ対象Auxiliary IDを渡す"
  // oracle = { type = "adr", ref = "docs/adr/006-windows-session-turn-notifications.md" }
  // fault = "Auxiliary通知のclickで新規に親Windowを開くとき、対象Auxiliary IDをqueryへ渡さずMain会話を表示する"
  // observable = "作成Window数とentry loadへ渡されたChatEntryMode"
  // observation_boundary = "public-boundary"
  // scope = "session-window-auxiliary-navigation"
  // lifecycle = "permanent"
  // distinction = "既存Window再利用時のrenderer event通知とは分離して、新規Windowのentry query経路を専用に検証する"
  // @end-test-value
  /** まだ親窓がない場合は新規窓を一つ作り、チャットの初回読込みへ Auxiliary ID を渡すことを確かめる。 */
  it("新規Session WindowへのAuxiliary openはentry loadへ対象を渡す", async () => {
    const session = createSession();
    let loadedChatMode: unknown = null;
    let createCount = 0;
    const bridge = new SessionWindowBridge({
      /** 初回の Auxiliary open で必要となった窓の数を記録する。 */
      createWindow() {
        createCount += 1;
        return new StubWindow();
      },
      /** 初回読込みの対象へ Auxiliary が含まれたかを確認するため、モードを保存する。 */
      async loadChatEntry(_window, mode) {
        loadedChatMode = mode;
      },
      /** 指定した親セッションに対応する保存結果を返す。 */
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      /** 初回の表示条件として実行はないと返す。 */
      isRunInFlight() {
        return false;
      },
      /** 開く処理だけを調べるので終了確認は受理しない。 */
      confirmCloseWhileRunning() {
        return false;
      },
      /** 開窓通知の代わりに生成数と読込み引数で結果を検証する。 */
      broadcastOpenSessionWindowIds() {},
    });

    await bridge.openAuxiliarySessionWindow(session.id, "auxiliary-1");

    assert.equal(createCount, 1);
    assert.deepEqual(loadedChatMode, {
      kind: "agent",
      sessionId: session.id,
      auxiliarySessionId: "auxiliary-1",
    });
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "親Session Windowのentry load中にAuxiliary openが重なっても、Window作成とentry loadを重複させずnavigationを保持する"
  // oracle = { type = "adr", ref = "docs/adr/006-windows-session-turn-notifications.md" }
  // fault = "通知clickが親Windowのload中に発生した時、別Windowを作る、Auxiliary navigationを失う、またはentry loadを二重実行する"
  // observable = "作成Window数、entry load回数、navigation payload、open結果のWindow同一性"
  // observation_boundary = "public-boundary"
  // scope = "session-window-auxiliary-navigation"
  // lifecycle = "permanent"
  // distinction = "settledな既存Window・新規Windowのquery経路とは分離して、opening中の共有promise経路を専用に検証する"
  // @end-test-value
  /** 親チャットの読込み中に Auxiliary を開いても窓と読込みを重複させず、既存の読込み完了後に対象へ移動することを確認する。 */
  it("entry load中のAuxiliary openは親Windowの共有結果へnavigationする", async () => {
    const session = createSession();
    /** チャット読込みを試験側から完了させるための処理を、開始後に差し替える。 */
    let resolveLoad: () => void = () => undefined;
    let createCount = 0;
    let loadCount = 0;
    const navigationPayloads: unknown[] = [];
    const bridge = new SessionWindowBridge({
      /** 共有される親窓が何度生成されたかを数える。 */
      createWindow() {
        createCount += 1;
        return new StubWindow();
      },
      /** チャットの読込み完了を試験側の合図まで待たせ、重複読込みを数える。 */
      loadChatEntry() {
        loadCount += 1;
        return new Promise<void>((resolve) => {
          resolveLoad = resolve;
        });
      },
      /** 共有された親窓へ送った Auxiliary 移動を記録する。 */
      sendAuxiliarySessionNavigation(_window, payload) {
        navigationPayloads.push(payload);
      },
      /** 同じ親の open と Auxiliary open が参照する保存済みセッションを返す。 */
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      /** 親の読込みと同時に走る実行はないものとする。 */
      isRunInFlight() {
        return false;
      },
      /** 重複する open の試験では、窓の終了確認を承認しない。 */
      confirmCloseWhileRunning() {
        return false;
      },
      /** 開窓一覧は配信せず、生成・読込み・移動をそれぞれ記録する。 */
      broadcastOpenSessionWindowIds() {},
    });

    const mainOpen = bridge.openSessionWindow(session.id);
    const auxiliaryOpen = bridge.openAuxiliarySessionWindow(
      session.id,
      "auxiliary-1",
    );
    assert.equal(createCount, 1);
    assert.equal(loadCount, 1);
    assert.ok(resolveLoad);
    resolveLoad!();

    const [mainWindow, auxiliaryWindow] = await Promise.all([
      mainOpen,
      auxiliaryOpen,
    ]);
    assert.equal(mainWindow, auxiliaryWindow);
    assert.deepEqual(navigationPayloads, [
      {
        parentSessionId: session.id,
        auxiliarySessionId: "auxiliary-1",
      },
    ]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "既存Session Windowをopenすると通常・最小化・非表示の状態にかかわらず可視化してfocusする"
  // oracle = { type = "contract", ref = "SessionWindowBridge#openSessionWindow" }
  // fault = "既存Windowが可視化またはfocusされず、ユーザー操作の対象にならない"
  // observable = "各Window状態後のvisible、restore、focusの結果"
  // observation_boundary = "public-boundary"
  // scope = "session-window-reuse-visibility"
  // lifecycle = "permanent"
  // impact = "既存Sessionへ戻れず、重複Windowを開く誘因になる"
  // distinction = "既存Windowの状態遷移だけを確認し、新規openやentry loadとは分ける"
  // @end-test-value
  /** 通常表示中・最小化中・非表示の既存窓を、新しく作らず可視化してフォーカスすることを確かめる。 */
  it("既存 window は通常・最小化・非表示の各状態から可視化して focus する", async (t) => {
    const cases = [
      {
        name: "通常",
        minimized: false,
        visible: true,
        expectedOperations: ["show", "focus"],
      },
      {
        name: "最小化",
        minimized: true,
        visible: false,
        expectedOperations: ["restore", "show", "focus"],
      },
      {
        name: "非表示",
        minimized: false,
        visible: false,
        expectedOperations: ["show", "focus"],
      },
    ] as const;

    for (const testCase of cases) {
      /** 初期表示状態ごとの復元・表示・フォーカス操作の順序を照合する。 */
      await t.test(testCase.name, async () => {
        const session = createSession();
        const createdWindow = new StubWindow();
        let createCount = 0;
        const bridge = new SessionWindowBridge({
          /** 作成済みの窓が再利用されたか、作成回数を記録して判定する。 */
          createWindow() {
            createCount += 1;
            return createdWindow;
          },
          /** 表示状態の復旧だけを試すためチャット UI は読み込まない。 */
          async loadChatEntry() {},
          /** 既存窓と同じ保存セッションを返す。 */
          getSession() {
            return session;
          },
          /** 窓の前面化とは独立した実行状態を停止中とする。 */
          isRunInFlight() {
            return false;
          },
          /** 前面化を試す間は終了確認を承認しない。 */
          confirmCloseWhileRunning() {
            return false;
          },
          /** 窓の活性化操作を直接記録し、開窓一覧の通知は行わない。 */
          broadcastOpenSessionWindowIds() {},
        });

        const first = await bridge.openSessionWindow(session.id);
        first.emitReady();
        first.resetActivation(testCase);
        const second = await bridge.openSessionWindow(session.id);

        assert.equal(first, second);
        assert.equal(createCount, 1);
        assert.equal(createdWindow.visible, true);
        assert.equal(createdWindow.focused, true);
        assert.deepEqual(
          createdWindow.activationOperations,
          testCase.expectedOperations,
        );
      });
    }
  });

  // @test-value v2
  // kind = "compatibility"
  // claim = "旧schema versionのSessionでも履歴閲覧用Windowをopenできる"
  // oracle = { type = "contract", ref = "SessionWindowBridge#openSessionWindow" }
  // fault = "旧Sessionのsource schemaを理由に履歴閲覧用Windowの作成またはloadを拒否する"
  // observable = "作成回数、entry load mode、open後のWindow状態"
  // observation_boundary = "public-boundary"
  // scope = "legacy-session-window-open"
  // lifecycle = "permanent"
  // impact = "維持対象の旧Sessionを閲覧できない"
  // distinction = "旧schema互換のopenだけを確認し、通常の新規Session openとは分ける"
  // @end-test-value
  /** 旧バージョンの保存セッションも再実行ではなく履歴表示用のチャット窓として開けることを確かめる。 */
  it("V4 以前の session でも履歴閲覧用に window を開ける", async () => {
    const legacySession = createSession({ sourceSchemaVersion: 4 });
    let createCount = 0;
    let loadedChatMode: unknown = null;

    const bridge = new SessionWindowBridge({
      /** 履歴用に作成した窓の数を記録する。 */
      createWindow() {
        createCount += 1;
        return new StubWindow();
      },
      /** 旧セッションを開くときに渡されたチャットモードを記録する。 */
      async loadChatEntry(_window, mode) {
        loadedChatMode = mode;
      },
      /** 移行前のスキーマバージョンを持つ保存済みセッションを返す。 */
      getSession() {
        return legacySession;
      },
      /** 履歴を見るセッションには実行中の処理がないとする。 */
      isRunInFlight() {
        return false;
      },
      /** 履歴表示の試験では終了確認を承認しない。 */
      confirmCloseWhileRunning() {
        return false;
      },
      /** 履歴窓の生成と読み込みを直接確認し、開窓通知は配信しない。 */
      broadcastOpenSessionWindowIds() {},
    });

    await bridge.openSessionWindow(legacySession.id);

    assert.equal(createCount, 1);
    assert.deepEqual(loadedChatMode, {
      kind: "agent",
      sessionId: legacySession.id,
    });
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "entry load失敗時は失敗Windowのclaimを破棄し、次回openで再作成できる"
  // oracle = { type = "contract", ref = "SessionWindowBridge#openSessionWindow" }
  // fault = "失敗Windowのclaimが残り、次回openが壊れたWindowを再利用する"
  // observable = "load失敗後のregistryと次回openのWindow作成回数"
  // observation_boundary = "public-boundary"
  // scope = "session-window-load-failure-recovery"
  // lifecycle = "permanent"
  // impact = "一時的なload失敗からSession Windowを復旧できない"
  // distinction = "失敗claimの破棄と再作成を確認し、同時openの共有とは分ける"
  // @end-test-value
  /** チャット読込みに失敗した窓を破棄して登録を空にし、次の open では別の窓を読み込めることを確かめる。 */
  it("entry load 失敗時は失敗した window の claim を破棄し、次回 open で作り直す", async () => {
    const session = createSession();
    const windows: StubWindow[] = [];
    let loadCount = 0;
    const bridge = new SessionWindowBridge({
      /** 失敗した窓と次の試行で作られる窓を区別して保持する。 */
      createWindow() {
        const window = new StubWindow();
        windows.push(window);
        return window;
      },
      /** 初回の読込みを失敗させ、再試行では正常に完了させる。 */
      async loadChatEntry() {
        loadCount += 1;
        if (loadCount === 1) {
          throw new Error("load failed");
        }
      },
      /** 両方の開窓要求に同じ保存済みセッションを返す。 */
      getSession() {
        return session;
      },
      /** 読込み失敗による破棄は、進行中の実行を持たない条件で試す。 */
      isRunInFlight() {
        return false;
      },
      /** 読込み失敗の後片付けは通常終了確認では承認しない。 */
      confirmCloseWhileRunning() {
        return false;
      },
      /** 失敗した登録の状態は通知でなく直接照会して確認する。 */
      broadcastOpenSessionWindowIds() {},
    });

    await assert.rejects(bridge.openSessionWindow(session.id), /load failed/);
    assert.equal(bridge.getWindow(session.id), null);
    assert.equal(windows[0]?.destroyCount, 1);

    const recoveredWindow = await bridge.openSessionWindow(session.id);

    assert.equal(windows.length, 2);
    assert.equal(loadCount, 2);
    assert.equal(recoveredWindow, windows[1]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "entry load中に同一Sessionのopenが重なっても一つのload結果を共有する"
  // oracle = { type = "contract", ref = "SessionWindowBridge#openSessionWindow" }
  // fault = "同一Sessionの重複openが複数Windowまたは複数entry loadを開始する"
  // observable = "Window作成数、load呼出数、重複openの結果と失敗後registry"
  // observation_boundary = "public-boundary"
  // scope = "session-window-open-coalescing"
  // lifecycle = "permanent"
  // impact = "重複Windowや競合するnavigationが発生する"
  // distinction = "load中の同一Sessionだけを確認し、既存Window再利用とは分ける"
  // @end-test-value
  /** 同じセッションの同時 open は窓生成とチャット読込みを共有し、読込み失敗を両方に伝えて登録を除去することを確認する。 */
  it("entry load 中に重なった open は同じ load 結果を共有する", async () => {
    const session = createSession();
    let createCount = 0;
    let loadCount = 0;
    /** 共有読込みを二つの open が待つ状態で、試験側から失敗させるための処理を保持する。 */
    let rejectLoad: (error: Error) => void = () => undefined;
    const bridge = new SessionWindowBridge({
      /** 同時 open で作成された窓の数を数える。 */
      createWindow() {
        createCount += 1;
        return new StubWindow();
      },
      /** 読込みを保留して呼出しを数え、試験側の拒否を待つ。 */
      loadChatEntry() {
        loadCount += 1;
        return new Promise<void>((_resolve, reject) => {
          rejectLoad = reject;
        });
      },
      /** 同時の要求に同じ保存セッションを返し、同一窓を必要とする条件を作る。 */
      getSession() {
        return session;
      },
      /** 読込み失敗以外で実行状態が変わらないようにする。 */
      isRunInFlight() {
        return false;
      },
      /** 二つの open が失敗する経路では実行中の終了確認を承認しない。 */
      confirmCloseWhileRunning() {
        return false;
      },
      /** 同時要求の決着と窓登録を直接確かめ、一覧通知は発行しない。 */
      broadcastOpenSessionWindowIds() {},
    });

    const firstOpen = bridge.openSessionWindow(session.id);
    const secondOpen = bridge.openSessionWindow(session.id);
    assert.ok(rejectLoad);
    rejectLoad!(new Error("load failed"));

    const results = await Promise.allSettled([firstOpen, secondOpen]);

    assert.equal(createCount, 1);
    assert.equal(loadCount, 1);
    assert.deepEqual(
      results.map(({ status }) => status),
      ["rejected", "rejected"],
    );
    assert.equal(bridge.getWindow(session.id), null);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "opening中のWindowを公開open Session ID集合へ含め、settled集合とrestore stateはload完了後だけ確定する"
  // oracle = { type = "contract", ref = "SessionWindowBridge#listOpenSessionWindowIds / listSettledOpenSessionWindowIds / getSessionWindowRestoreStates" }
  // fault = "opening中のWindowが公開open集合から欠落する、またはsettled/restore stateがload完了前に確定する"
  // observable = "公開open集合、settled集合、restore stateのload前後"
  // observation_boundary = "public-boundary"
  // scope = "session-window-opening-state"
  // lifecycle = "permanent"
  // impact = "Window復元やHome表示の対象が不整合になる"
  // distinction = "openingとsettledの集合境界を確認し、load失敗時のclaim破棄とは分ける"
  // @end-test-value
  /** 読込み中の窓は公開一覧に含める一方、復元から除外する確定集合は読込みが終わるまで更新しないことを確かめる。 */
  it("open通知の集合にはopening中を含め、復元除外用の集合にはload完了後だけ含める", async () => {
    const session = createSession();
    /** 状態の比較を済ませてから、試験側で読込みを完了させる。 */
    let resolveLoad: () => void = () => undefined;
    const bridge = new SessionWindowBridge({
      /** 読込み中の状態を持てる試験窓を作る。 */
      createWindow: () => new StubWindow(),
      /** 公開一覧と復元状態を読み取るまでチャットの読込みを待たせる。 */
      loadChatEntry: () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
      /** 開窓対象の固定セッションを返す。 */
      getSession: () => session,
      /** 窓の状態比較は実行中の処理なしで行う。 */
      isRunInFlight: () => false,

      /** 作成中と作成後の状態だけを観測し、終了確認は承認しない。 */
      confirmCloseWhileRunning: () => false,
      /** 一覧イベントを模擬せず、公開一覧と確定一覧の両方を直接読む。 */
      broadcastOpenSessionWindowIds() {},
    });

    const opening = bridge.openSessionWindow(session.id);

    assert.deepEqual(bridge.listOpenSessionWindowIds(), [session.id]);
    assert.deepEqual(bridge.listSettledOpenSessionWindowIds(), []);
    assert.equal(
      bridge.getSessionWindowRestoreStates().get(session.id)?.kind,
      "opening",
    );

    assert.ok(resolveLoad);
    resolveLoad!();
    await opening;

    assert.deepEqual(bridge.listSettledOpenSessionWindowIds(), [session.id]);
    assert.equal(
      bridge.getSessionWindowRestoreStates().get(session.id)?.kind,
      "settled-open",
    );
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "別Sessionのopen完了時に読込中Windowをsnapshotへ混ぜず、load失敗後に失敗claimを残さない"
  // oracle = { type = "contract", ref = "SessionWindowBridge#openSessionWindow" }
  // fault = "別Sessionの完了処理が読込中Windowを復元snapshotへ混入させる、または失敗claimを残す"
  // observable = "保存されたsnapshotとload失敗後の対象Session registry"
  // observation_boundary = "public-boundary"
  // scope = "session-window-cross-session-open"
  // lifecycle = "permanent"
  // impact = "再起動時に未完成または失敗したSession Windowを復元する"
  // distinction = "別Sessionの同時open境界を確認し、単一Sessionのload失敗とは分ける"
  // @end-test-value
  /** 先に読込みが完了した別の窓だけを復元スナップショットに保存し、失敗した窓を後から登録に残さないことを確かめる。 */
  it("別Sessionのopen完了時に読込中のWindowをsnapshotへ混ぜず、読込失敗後も残さない", async () => {
    const sessionA = createSession({ id: "session-a" });
    const sessionB = createSession({ id: "session-b" });
    /** 別セッションが開き終わった後で、最初の読込みを失敗させる。 */
    let rejectSessionA: (error: Error) => void = () => undefined;
    const savedSnapshots: string[][] = [];
    const bridge = new SessionWindowBridge({
      /** セッションの異なる要求に独立した試験窓を割り当てる。 */
      createWindow: () => new StubWindow(),
      /** 最初のセッションだけ読込みを保留し、もう一方を先に完了させる。 */
      loadChatEntry(_window, mode) {
        if (mode.sessionId === sessionA.id) {
          return new Promise<void>((_resolve, reject) => {
            rejectSessionA = reject;
          });
        }
        return Promise.resolve();
      },
      /** 要求された ID に応じて読込み完了時期が異なるセッションを返す。 */
      getSession: (sessionId) =>
        sessionId === sessionA.id ? sessionA : sessionB,
      /** 二つのセッション間の違いを読込み段階に限定する。 */
      isRunInFlight: () => false,

      /** 復元スナップショットの試験では実行中の終了を承認しない。 */
      confirmCloseWhileRunning: () => false,
      /** 開窓一覧の IPC でなく永続化対象を検証する。 */
      broadcastOpenSessionWindowIds() {},
      /** 復元用として保存されたセッション ID を記録する。 */
      async persistOpenSessionWindowIds(sessionIds) {
        savedSnapshots.push([...sessionIds]);
      },
    });

    const openingA = bridge.openSessionWindow(sessionA.id);
    await bridge.openSessionWindow(sessionB.id);
    assert.deepEqual(savedSnapshots, [[sessionB.id]]);

    assert.ok(rejectSessionA);
    rejectSessionA!(new Error("load failed"));
    await assert.rejects(openingA, /load failed/);

    assert.deepEqual(savedSnapshots, [[sessionB.id]]);
    assert.equal(bridge.getWindow(sessionA.id), null);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "同一Sessionの古いWindowから遅れて届くclosed通知は新しいWindowのclaimを解放しない"
  // oracle = { type = "contract", ref = "SessionWindowBridge#releaseWindowClaim" }
  // fault = "古いWindowの遅延closedが新しいWindowのregistry claimを削除する"
  // observable = "遅延closed後の新しいWindowのregistry claim"
  // observation_boundary = "public-boundary"
  // scope = "session-window-stale-close"
  // lifecycle = "permanent"
  // impact = "利用中のSession Windowが復元・close管理から外れる"
  // distinction = "古いWindowと新しいWindowのclaim世代だけを確認し、通常closeとは分ける"
  // @end-test-value
  /** 旧窓から closed が遅れて届いても、同じセッションの新しい窓が登録から消えず、再度の open で利用されることを確認する。 */
  it("古い window の遅延 closed は同じ Session の新しい window claim を解放しない", async () => {
    const session = createSession();
    const windows: StubWindow[] = [];
    const bridge = new SessionWindowBridge({
      /** 同じセッションの旧窓と新窓を新しい実体として作り、生成順を記録する。 */
      createWindow() {
        const window = new StubWindow();
        windows.push(window);
        return window;
      },
      /** 遅延した終了通知の競合だけを観測し、実エントリは読まない。 */
      async loadChatEntry() {},
      /** 古い窓と新しい窓に同じセッションを割り当てる。 */
      getSession() {
        return session;
      },
      /** 遅延する closed と実行状態を切り離し、実行はないと返す。 */
      isRunInFlight() {
        return false;
      },
      /** 旧窓の終了通知の試験では実行中の終了を承認しない。 */
      confirmCloseWhileRunning() {
        return false;
      },
      /** 窓の再取得で新しい登録を照合するため、一覧通知には依存しない。 */
      broadcastOpenSessionWindowIds() {},
    });

    const oldWindow = await bridge.openSessionWindow(session.id);
    oldWindow.delayClosedEvent = true;
    oldWindow.close();
    const currentWindow = await bridge.openSessionWindow(session.id);

    oldWindow.emitClosed();
    const reopenedWindow = await bridge.openSessionWindow(session.id);

    assert.equal(windows.length, 2);
    assert.equal(reopenedWindow, currentWindow);
    assert.equal(bridge.getWindow(session.id), currentWindow);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "実行中Sessionの通常closeは確認ダイアログで承認された場合にWindowを閉じる"
  // oracle = { type = "contract", ref = "SessionWindowBridge#handleWindowClose" }
  // fault = "実行中のSessionを確認なしに閉じる、または確認承認後にWindowを閉じない"
  // observable = "確認ダイアログ呼出しとWindowの破棄状態"
  // observation_boundary = "public-boundary"
  // scope = "session-window-running-close"
  // lifecycle = "permanent"
  // impact = "実行中Sessionの利用者操作と実行継続確認が壊れる"
  // distinction = "実行中closeの承認経路を確認し、確認拒否やdraft flush失敗時のclose拒否とは分ける"
  // @end-test-value
  /** 実行中の窓を通常 close すると確認を一度だけ行い、承認後に再度 close して破棄することを確かめる。 */
  it("running 中の close は確認ダイアログで継続可否を決める", async () => {
    const session = createSession();
    const window = new StubWindow();
    const confirms: boolean[] = [];

    const bridge = new SessionWindowBridge({
      /** ネイティブ close の発行と破棄を記録する試験窓を返す。 */
      createWindow() {
        return window;
      },
      /** 通常の終了だけを観測し、チャット UI は読み込まない。 */
      async loadChatEntry() {},
      /** close する窓に対応する保存セッションを返す。 */
      getSession() {
        return session;
      },
      /** 通常終了に確認が必要になるよう、対象を実行中とする。 */
      isRunInFlight() {
        return true;
      },
      /** 通常終了の確認を一度の承認として記録する。 */
      confirmCloseWhileRunning() {
        confirms.push(true);
        return true;
      },
      /** 閉じた回数と破棄状態を観測するため、開窓一覧は配信しない。 */
      broadcastOpenSessionWindowIds() {},
    });

    await bridge.openSessionWindow(session.id);
    window.close();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(confirms.length, 1);
    assert.equal(window.destroyed, true);
    assert.equal(window.closeCount, 2);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Session MonitorからのSession Window close requestも通常closeと同じrunning確認を経て、承認時だけ閉じる"
  // oracle = { type = "contract", ref = "SessionWindowBridge requestCloseSessionWindow and running close contract" }
  // fault = "Monitorからのclose requestが実行中確認を飛ばす、確認後のcloseを二重化する、または対象Windowを閉じない"
  // observable = "確認回数、Windowのdestroyed state、close呼出し回数"
  // observation_boundary = "public-boundary"
  // scope = "Session Window normal close request"
  // lifecycle = "permanent"
  // impact = "Monitorの閉じる操作が削除用force closeにならず、既存の実行中確認を維持する"
  // distinction = "削除用closeSessionWindowのforce close経路やrenderer/native menu dispatchとは分離してbridgeの通常close契約を検証する"
  // @end-test-value
  /** Monitor からの終了要求も実行中の通常確認を経て、一回の承認で窓を破棄して公開一覧から除くことを確かめる。 */
  it("requestCloseSessionWindow は通常closeの確認経路を使う", async () => {
    const session = createSession();
    const window = new StubWindow();
    let confirmCount = 0;
    const bridge = new SessionWindowBridge({
      /** Monitor 経由の終了要求が届く同じ試験窓を返す。 */
      createWindow() {
        return window;
      },
      /** Monitor の終了操作だけを試すため、チャットは起動しない。 */
      async loadChatEntry() {},
      /** Monitor が指定する ID の保存済みセッションを返す。 */
      getSession() {
        return session;
      },
      /** Monitor からの要求でも確認に進むよう、実行は継続中とする。 */
      isRunInFlight() {
        return true;
      },
      /** 確認が行われた回数を数え、終了を受け入れる。 */
      confirmCloseWhileRunning() {
        confirmCount += 1;
        return true;
      },
      /** 保存済み窓一覧ではなく、終了後の公開一覧を直接調べる。 */
      broadcastOpenSessionWindowIds() {},
    });

    await bridge.openSessionWindow(session.id);
    const closeResult = bridge.requestCloseSessionWindow(session.id);
    assert.equal(await closeResult, true);

    assert.equal(confirmCount, 1);
    assert.equal(window.destroyed, true);
    assert.equal(window.closeCount, 2);
    assert.deepEqual(bridge.listOpenSessionWindowIds(), []);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Session MonitorからのSession Window close requestを実行中確認で取消すると、対象Windowとregistryを維持する"
  // oracle = { type = "contract", ref = "SessionWindowBridge requestCloseSessionWindow cancellation contract" }
  // fault = "確認取消後にWindowが閉じる、registryから消える、または確認が重複する"
  // observable = "確認回数、Windowのdestroyed state、close呼出し回数、open session IDs"
  // observation_boundary = "public-boundary"
  // scope = "Session Window normal close cancellation"
  // lifecycle = "permanent"
  // impact = "実行中SessionをMonitorの誤操作で失わず、既存の通常close取消を維持する"
  // distinction = "menu取消とは分離して、閉じる項目選択後のWindowClose確認取消を検証する"
  // @end-test-value
  /** 実行中の終了要求を確認で拒否すると、同じ窓を破棄せず開窓一覧にも残すことを確認する。 */
  it("running 中の close request取消ではWindowとregistryを維持する", async () => {
    const session = createSession();
    const window = new StubWindow();
    let confirmCount = 0;

    const bridge = new SessionWindowBridge({
      /** 確認を拒否したとき保持すべき窓を作成経路へ渡す。 */
      createWindow() {
        return window;
      },
      /** 終了要求の取消の試験には実チャットを読み込まない。 */
      async loadChatEntry() {},
      /** 終了を要求された窓のセッションとして保存結果を返す。 */
      getSession() {
        return session;
      },
      /** 取消を試す窓は実行中とする。 */
      isRunInFlight() {
        return true;
      },

      /** 確認が重複しないか数えつつ、終了を拒否する。 */
      confirmCloseWhileRunning() {
        confirmCount += 1;
        return false;
      },
      /** 終了を取り消した後の開窓一覧は公開照会から検証する。 */
      broadcastOpenSessionWindowIds() {},
    });

    await bridge.openSessionWindow(session.id);
    const closeResult = bridge.requestCloseSessionWindow(session.id);
    assert.equal(await closeResult, false);

    assert.equal(confirmCount, 1);
    assert.equal(window.destroyed, false);
    assert.equal(window.closeCount, 1);
    assert.deepEqual(bridge.listOpenSessionWindowIds(), [session.id]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "確認が必要なTerminalを持つWindowの非同期closeは重複確認を作らず、承認後もdraft保存ACKまでWindowを維持する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md Terminal; docs/design/session-run-lifecycle.md" }
  // fault = "確認待ちの重複closeが複数dialogを開くか、承認のみでdraft flushを飛ばしてWindowを破棄する"
  // observable = "確認回数、close要求の同一Promise、draft flush要求とACK前後のWindow状態"
  // observation_boundary = "public-boundary"
  // scope = "Session Window close with terminal work and draft flush"
  // lifecycle = "permanent"
  // impact = "Terminal操作の確認が重複するか、保存前のAuxiliary draftを失う"
  // distinction = "同期確認とidle closeの既存testでは非同期dialog中の重複と承認後の保存境界を観測できない"
  // @end-test-value
  /** Terminal の終了確認待ちに重ねた要求を一つにまとめ、承認後も下書き flush の成功応答が来るまで窓を保持することを確かめる。 */
  it("Terminal確認待ちのcloseを一つにし、承認後もdraft保存を待つ", async () => {
    const session = createSession();
    const window = new StubWindow();
    const requests: Array<{ requestId: string }> = [];
    let confirmCount = 0;
    let approve!: (value: boolean) => void;
    const bridge = new SessionWindowBridge({
      /** 同じ対象への複数の終了要求を一つの試験窓へ通す。 */
      createWindow: () => window,
      /** Terminal と下書きの待機だけを調べるため、実チャットは読まない。 */
      async loadChatEntry() {},
      /** Terminal 確認の対象となる保存済みセッションを返す。 */
      getSession: () => session,
      /** 実行中の確認を除き、Terminal を理由とする確認だけを発生させる。 */
      isRunInFlight: () => false,
      /** 終了前に確認を要する Terminal が一つあると報告する。 */
      getTerminalCloseConfirmationCount: () => 1,
      /** 終了確認を数え、試験側から承認するまで待機する。 */
      confirmCloseWhileRunning: () => {
        confirmCount += 1;
        return new Promise<boolean>((resolve) => {
          approve = resolve;
        });
      },
      /** 開窓一覧の通知は無視し、窓の破棄状態を直接確認する。 */
      broadcastOpenSessionWindowIds() {},
      /** 下書き保存を応答する送信元に対象窓を使用する。 */
      getWindowSender: () => window,
      /** 承認後に依頼された下書き flush とその要求 ID を記録する。 */
      sendDraftFlushRequest: (_window, request) => {
        requests.push(request);
      },
    });

    await bridge.openSessionWindow(session.id);
    const first = bridge.requestCloseSessionWindow(session.id);
    const repeated = bridge.requestCloseSessionWindow(session.id);
    window.close();
    assert.equal(first, repeated);
    assert.equal(confirmCount, 1);
    assert.equal(window.isDestroyed(), false);
    assert.equal(requests.length, 0);

    approve(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 1);
    assert.equal(window.isDestroyed(), false);
    bridge.acknowledgeDraftFlush(requests[0].requestId, window, true);
    assert.equal(await first, true);
    assert.equal(window.isDestroyed(), true);
    assert.equal(confirmCount, 1);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "確認中に元Windowが破棄された場合、遅れた承認は同じSessionの新Windowを閉じない"
  // oracle = { type = "contract", ref = "docs/design/window-architecture.md" }
  // fault = "古い確認結果をSession IDだけで適用し、再作成済みWindowを閉じる"
  // observable = "古いclose要求の結果、新Windowの生存、古い確認後のclose呼出し数"
  // observation_boundary = "public-boundary"
  // scope = "Session Window close confirmation identity"
  // lifecycle = "permanent"
  // impact = "別のWindowで再開したSessionとその入力を意図せず終了する"
  // distinction = "通常closeと古いclosed通知の既存testでは保留中dialogの遅延承認を観測できない"
  // @end-test-value
  /** 終了確認中に元の窓が破棄されても、その遅い承認が同一セッションの新しい窓を閉じないことを確かめる。 */
  it("破棄済みWindowへの遅い承認を新Windowへ適用しない", async () => {
    const session = createSession();
    const windows: StubWindow[] = [];
    let approve!: (value: boolean) => void;
    let needsConfirmation = true;
    const bridge = new SessionWindowBridge({
      /** セッションに割り当てた旧窓と新窓を別々に作成して記録する。 */
      createWindow: () => {
        const window = new StubWindow();
        windows.push(window);
        return window;
      },
      /** チャット起動なしで古い確認に対応する窓を識別する。 */
      async loadChatEntry() {},
      /** 旧窓と新窓でセッション ID が同じ条件を作る。 */
      getSession: () => session,
      /** 通常実行はなく、終了確認は Terminal に限る。 */
      isRunInFlight: () => false,
      /** 元の窓でだけ Terminal の終了確認が必要になるよう切り替える。 */
      getTerminalCloseConfirmationCount: () => (needsConfirmation ? 1 : 0),
      /** 元窓を破棄して新窓を開くまで確認の応答を保留する。 */
      confirmCloseWhileRunning: () =>
        new Promise<boolean>((resolve) => {
          approve = resolve;
        }),
      /** 窓の破棄と登録の変化を直接確認し、一覧通知は配信しない。 */
      broadcastOpenSessionWindowIds() {},
    });

    const oldWindow = await bridge.openSessionWindow(session.id);
    const closing = bridge.requestCloseSessionWindow(session.id);
    bridge.discardSessionWindow(session.id);
    assert.equal(await closing, true);
    needsConfirmation = false;
    const newWindow = await bridge.openSessionWindow(session.id);
    approve(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(oldWindow.closeCount, 2);
    assert.equal(newWindow.isDestroyed(), false);
    assert.equal(bridge.getWindow(session.id), newWindow);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "quit失敗で中止した通常closeの遅い承認はWindowを閉じず、新しいclose確認も無効化しない"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-window-close" }
  // fault = "quit失敗後の旧dialog承認でdraft flushとWindow closeを再開するか、新retryの確認を消す"
  // observable = "quitと通常closeの結果、flush要求数、Window生存、新retryの確認結果"
  // observation_boundary = "public-boundary"
  // scope = "Session Window close confirmation and failed quit overlap"
  // lifecycle = "permanent"
  // impact = "中止済みの終了操作が後からWindowと作業中Terminalを終了する"
  // distinction = "既存のclose/quit競合testはcloseの確認待ち中にquitが失敗する順序を扱わない"
  // @end-test-value
  /** quit の失敗で中止された旧確認は遅れて承認しても窓を閉じず、その間に新しく開始した終了確認も有効なままか確かめる。 */
  it("quit失敗後の古い確認承認を無視して新しいclose確認を維持する", async () => {
    const session = createSession();
    const window = new StubWindow();
    const confirmations: Array<(value: boolean) => void> = [];
    const signals: AbortSignal[] = [];
    const requests: Array<{ requestId: string; reason: "close" | "quit" }> = [];
    const bridge = new SessionWindowBridge({
      /** quit からの復帰と次の終了要求を同じ窓で試す。 */
      createWindow: () => window,
      /** 確認の世代を検査するため、チャットの読込みは実行しない。 */
      async loadChatEntry() {},
      /** 両方の終了要求に共通する一つの保存セッションを返す。 */
      getSession: () => session,
      /** 実行中の確認は発生させず、Terminal による確認だけを使う。 */
      isRunInFlight: () => false,
      /** 再試行を含め、終了前に確認する Terminal を一つ返す。 */
      getTerminalCloseConfirmationCount: () => 1,
      /** 各確認の取消シグナルと応答関数を記録し、新旧を個別に決着させる。 */
      confirmCloseWhileRunning: (_window, _sessionId, signal) => {
        signals.push(signal);
        return new Promise<boolean>((resolve) => {
          confirmations.push(resolve);
        });
      },
      /** 終了処理と下書き保存要求は直接記録し、開窓一覧の通知は行わない。 */
      broadcastOpenSessionWindowIds() {},
      /** quit と通常終了の ACK を同じ試験窓から返せるようにする。 */
      getWindowSender: () => window,
      /** 古い承認が余分な保存要求を発行しないことを確かめるため、要求を順に記録する。 */
      sendDraftFlushRequest: (_window, request) => {
        requests.push(request);
      },
    });

    await bridge.openSessionWindow(session.id);
    const oldClose = bridge.requestCloseSessionWindow(session.id);
    const quitting = bridge.flushSessionWindowDrafts();
    assert.deepEqual(
      requests.map((request) => request.reason),
      ["quit"],
    );
    bridge.acknowledgeDraftFlush(requests[0].requestId, window, false);
    assert.equal(await quitting, false);
    assert.equal(await oldClose, false);
    assert.equal(signals[0].aborted, true);

    const retry = bridge.requestCloseSessionWindow(session.id);
    assert.equal(confirmations.length, 2);
    assert.equal(signals[1].aborted, false);
    confirmations[0](true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      requests.map((request) => request.reason),
      ["quit"],
    );
    assert.equal(window.isDestroyed(), false);
    window.close();
    assert.equal(
      confirmations.length,
      2,
      "old approval must not remove the new confirmation guard",
    );
    assert.equal(signals[1].aborted, false);
    confirmations[1](false);
    assert.equal(await retry, false);
    assert.equal(window.isDestroyed(), false);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "idle Sessionと確認不要なTerminalのcloseでは確認経路を起動せず、Window registry通知を更新する"
  // oracle = { type = "contract", ref = "SessionWindowBridge#handleWindowClose" }
  // fault = "入力待ちTerminalを生存中というだけで確認する、またはregistry通知を失う"
  // observable = "確認呼出し回数とclose後のregistry通知"
  // observation_boundary = "public-boundary"
  // scope = "session-window-idle-close"
  // lifecycle = "permanent"
  // impact = "不要な副作用やWindow一覧の不整合が発生する"
  // distinction = "idle closeの副作用境界を確認し、running closeやsnapshot persistenceとは分ける"
  // @end-test-value
  /** 実行中でなく確認を要する Terminal もない窓を閉じると、確認を発生させず開窓一覧を空にすることを確認する。 */
  it("idle の window close では Memory hook を起動せず window registry だけ更新する", async () => {
    const session = createSession();
    const broadcasts: string[][] = [];
    let confirmCount = 0;

    const bridge = new SessionWindowBridge({
      /** 終了後に一覧が空になる単一の試験窓を作る。 */
      createWindow() {
        return new StubWindow();
      },
      /** アイドル状態の終了だけを観測するため、チャットは読み込まない。 */
      async loadChatEntry() {},
      /** 開窓を要求された ID に対応する保存セッションだけを返す。 */
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      /** 通常実行を停止中として終了確認の対象から外す。 */
      isRunInFlight() {
        return false;
      },
      /** 生存する Terminal の有無ではなく、確認対象はゼロと返す。 */
      getTerminalCloseConfirmationCount: () => 0,

      /** 確認不要なのに終了確認が呼ばれた場合に回数を残す。 */
      confirmCloseWhileRunning() {
        confirmCount += 1;
        return false;
      },
      /** 終了後に影響する開窓 ID の通知をコピーして蓄積する。 */
      broadcastOpenSessionWindowIds(openIds) {
        broadcasts.push([...openIds]);
      },
    });

    const window = await bridge.openSessionWindow(session.id);
    window.close();

    assert.equal(confirmCount, 0);
    assert.deepEqual(broadcasts.at(-1), []);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Session windowが閉じたときAuxiliary creation owner release hookを一度だけ通知する"
  // oracle = { type = "contract", ref = "src-electron/session-window-bridge.ts" }
  // fault = "window close後も作成ownerが保持され、遅延commitが旧scopeへ保存される"
  // observable = "close後のsession ID通知"
  // observation_boundary = "public-boundary"
  // scope = "session-window-creation-owner-release"
  // lifecycle = "permanent"
  // impact = "window closeで未完了Auxiliary作成を失効させる"
  // distinction = "registry更新だけを確認する既存close testではowner release通知を観測しない"
  // @end-test-value
  /** アイドル窓の終了時に、そのセッションの Auxiliary 作成を解放する通知を一度だけ発行することを確かめる。 */
  it("idle の window close ではAuxiliary creation ownerを解放する", async () => {
    const session = createSession();
    const closedSessionIds: string[] = [];
    const bridge = new SessionWindowBridge({
      /** 通常の終了通知を発行できる試験窓を用意する。 */
      createWindow: () => new StubWindow(),
      /** Auxiliary 作成の所有者解放を観測し、チャットは読み込まない。 */
      async loadChatEntry() {},
      /** Auxiliary 作成の所有者となる保存済みセッションを返す。 */
      getSession: () => session,
      /** 所有者解放の試験は進行中の実行がない状態で行う。 */
      isRunInFlight: () => false,

      /** アイドル窓では終了確認を承認しない。 */
      confirmCloseWhileRunning: () => false,
      /** 開窓一覧と区別してセッション窓の終了通知だけを観測する。 */
      broadcastOpenSessionWindowIds() {},
      /** Auxiliary 作成の所有者を解放すべきセッション ID を記録する。 */
      onSessionWindowClosed: (sessionId) => closedSessionIds.push(sessionId),
    });

    const window = await bridge.openSessionWindow(session.id);
    window.close();
    window.close();

    assert.deepEqual(closedSessionIds, [session.id]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Window snapshot保存が失敗してもopenとcloseのregistry処理を維持する"
  // oracle = { type = "contract", ref = "SessionWindowBridge#handleWindowClose" }
  // fault = "snapshot保存エラーでWindow registryのclose処理を中断し、閉じたWindowを残す"
  // observable = "保存エラー通知、close後のregistry、Window破棄状態"
  // observation_boundary = "public-boundary"
  // scope = "session-window-snapshot-failure"
  // lifecycle = "permanent"
  // impact = "Windowを閉じられず、open Window一覧が実態とずれる"
  // distinction = "snapshot persistence failure時のclose継続だけを確認し、draft flush failureとは分ける"
  // @end-test-value
  /** 復元候補の永続化が失敗しても窓は開閉でき、登録の更新と保存エラーの通知の両方が行われることを確認する。 */
  it("snapshot保存失敗でもopenとcloseを維持する", async () => {
    const session = createSession();
    const errors: unknown[] = [];
    const bridge = new SessionWindowBridge({
      /** 復元候補の保存が失敗しても開閉する試験窓を作る。 */
      createWindow: () => new StubWindow(),
      /** 読込みは正常終了させ、失敗をスナップショット保存だけに限定する。 */
      async loadChatEntry() {},
      /** 開閉する試験窓のセッションを返す。 */
      getSession: () => session,
      /** 保存失敗による影響を実行中の確認と切り離す。 */
      isRunInFlight: () => false,

      /** 開閉と永続化の試験では終了確認は承認しない。 */
      confirmCloseWhileRunning: () => false,
      /** 開窓 ID の配信ではなくブリッジ内で窓を取得できるか調べる。 */
      broadcastOpenSessionWindowIds() {},
      /** open と close それぞれの復元スナップショットの保存を失敗させる。 */
      async persistOpenSessionWindowIds() {
        throw new Error("save failed");
      },
      /** 永続化のエラーが通知されるたびに例外を保存する。 */
      onSnapshotPersistenceError(error) {
        errors.push(error);
      },
    });

    const window = await bridge.openSessionWindow(session.id);
    assert.equal(bridge.getWindow(session.id), window);
    window.close();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(bridge.getWindow(session.id), null);
    assert.equal(errors.length, 2);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Window復元候補の保存が未完了でもopenとquit準備を完了し、quit準備後のcloseで保存候補を空にしない"
  // oracle = { type = "contract", ref = "SessionWindowBridge#prepareSnapshotForQuit" }
  // fault = "任意保存をopenやquitの待機条件にする、またはquit準備中のcloseで復元候補を空にする"
  // observable = "保存未完了中のopen・quit準備の完了と、保存へ渡されたWindow ID"
  // observation_boundary = "public-boundary"
  // scope = "session-window-restore"
  // lifecycle = "permanent"
  // impact = "復元情報の保存遅延だけでWindow操作やアプリ終了が停止する"
  // distinction = "本文を保護するdraft flushとは別に、復元候補の保存待ちを制御可能なPromiseで観測する"
  // @end-test-value
  /** 復元候補の書込みが保留中でも open と quit 準備が完了し、その後の窓終了で復元候補を空に更新しないことを確かめる。 */
  it("復元候補の保存を待たずopenとquit準備を完了し、closeで候補を空にしない", async () => {
    const session = createSession();
    const savedSnapshots: string[][] = [];
    let finishSave!: () => void;
    const saving = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    const bridge = new SessionWindowBridge({
      /** 開く処理と quit を保存から分離して試す窓を作る。 */
      createWindow: () => new StubWindow(),
      /** チャットの読込みには待機を設けず、保存だけを遅延させる。 */
      async loadChatEntry() {},
      /** 次回の復元候補として記録されるセッションを供給する。 */
      getSession: () => session,
      /** quit の待機条件から実行中セッションを除く。 */
      isRunInFlight: () => false,

      /** 復元単位を検証するため、実行中の終了は承認しない。 */
      confirmCloseWhileRunning: () => false,
      /** 復元候補の保存だけを観測し、開窓一覧は配信しない。 */
      broadcastOpenSessionWindowIds() {},
      /** 永続化を開始した ID 集合を記録し、試験側の合図まで書込み完了を保留する。 */
      async persistOpenSessionWindowIds(sessionIds) {
        savedSnapshots.push([...sessionIds]);
        await saving;
      },
    });

    let opened = false;
    const opening = bridge.openSessionWindow(session.id).then((window) => {
      opened = true;
      return window;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(opened, true);
      const window = await opening;
      savedSnapshots.splice(0);
      let prepared = false;
      const preparing = bridge.prepareSnapshotForQuit().then(() => {
        prepared = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(prepared, true);
      await preparing;
      window.close();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(savedSnapshots, [[session.id]]);
    } finally {
      finishSave();
      await opening;
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "通常closeはdraft flushの負ACKでも入力だけを破棄して完了し、保存成功とは分類しない"
  // oracle = { type = "contract", ref = "SessionWindowBridge#requestCloseSessionWindow" }
  // fault = "負ACKでcloseが完了しない、保存成功と分類する、または破棄済みWindowのsender取得で例外になる"
  // observable = "close結果、Windowの破棄状態、draft flush結果分類"
  // observation_boundary = "public-boundary"
  // scope = "session-window-draft-flush"
  // lifecycle = "permanent"
  // impact = "保存できない入力surfaceから離脱できない、または未保存入力を保存済みと誤認する"
  // distinction = "負ACKによるclose完了と保存成否の区別を観測する。型検査や成功ACKだけではこの境界を検証できない"
  // @end-test-value
  /** 通常 close は下書きの負 ACK で窓を閉じても、結果の分類は保存成功ではなく拒否として記録することを確かめる。 */
  it("draft flush負ACKを保存成功にせず通常closeを完了する", async () => {
    const session = createSession({ id: "draft-close" });
    let bridge!: SessionWindowBridge<StubWindow>;
    const settled: DraftFlushResult[] = [];
    const window = new StubWindow();
    bridge = new SessionWindowBridge({
      /** 負の ACK を経て破棄される同じ窓を作成経路へ渡す。 */
      createWindow: () => window,
      /** 負の ACK の試験では実チャットを起動しない。 */
      async loadChatEntry() {},
      /** 保存失敗を再現する窓に割り当てるセッションを返す。 */
      getSession: () => session,
      /** 下書き保存以外の終了確認が起きない実行状態にする。 */
      isRunInFlight: () => false,

      /** 下書きの否定応答だけを原因にするため、終了確認では承認しない。 */
      confirmCloseWhileRunning: () => false,
      /** 開窓の通知は記録せず、終了と下書き結果に観測を限定する。 */
      broadcastOpenSessionWindowIds() {},
      /** 通常終了の flush に付いた結果区分を記録する。 */
      onDraftFlushSettled: (result) => {
        settled.push(result);
      },
      /** 有効な試験窓の送信元を返し、破棄済み窓の照会は Electron と同様に拒否する。 */
      getWindowSender: (candidate) => {
        if (candidate.isDestroyed())
          throw new TypeError("Object has been destroyed");
        return "sender";
      },
      /** 通常終了の下書き保存に試験用送信元から負の ACK を返す。 */
      sendDraftFlushRequest: (_window, request) => {
        queueMicrotask(() =>
          bridge.acknowledgeDraftFlush(request.requestId, "sender", false),
        );
      },
    });
    await bridge.openSessionWindow(session.id);
    assert.equal(await bridge.requestCloseSessionWindow(session.id), true);
    assert.equal(window.destroyed, true);
    assert.deepEqual(
      settled.map(({ reason, outcome }) => ({ reason, outcome })),
      [{ reason: "close", outcome: "rejected" }],
    );
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "quitは全renderer ACK後にMainの送信確定待ちを開始し、成功後だけ終了を許可し、失敗・例外・timeoutでは解凍する"
  // oracle = { type = "contract", ref = "SessionWindowBridge#flushSessionWindowDrafts" }
  // fault = "draft保存ACKだけでDB closeへ進み、送信失敗後の復元保存を待たない"
  // observable = "ACK前後のMain待機呼出し回数、送信確定前後のquit結果、Window closeと失敗release"
  // observation_boundary = "public-boundary"
  // scope = "session-window-pending-send-settlement"
  // lifecycle = "permanent"
  // @end-test-value
  /** quit は renderer の ACK を揃えてから Main の送信確定を待ち、成功だけを通し、失敗・例外・時間切れでは入力を解凍することを確かめる。 */
  it("quitはrenderer ACK後の送信確定まで待ち、失敗やtimeoutでは解凍する", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const outcome of ["success", "failure", "timeout", "throw"]) {
      let releasePending!: (success: boolean) => void;
      const pendingSend = new Promise<boolean>((resolve) => {
        releasePending = resolve;
      });
      let waitCalls = 0;
      let quitCompleted = false;
      const { bridge, requests, releases } = createDraftFlushBridge({
        /** Main の送信確定待ちの開始を数え、試験段階に応じて例外または保留中の結果を返す。 */
        waitForPendingDraftSends: () => {
          waitCalls += 1;
          if (outcome === "throw") throw new Error("send settlement failed");
          return pendingSend;
        },
      });
      const window = await bridge.openSessionWindow("pending-send");
      const quitting = bridge.flushSessionWindowDrafts().then((result) => {
        quitCompleted = true;
        return result;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        waitCalls,
        0,
        "Main must snapshot pending sends only after renderer send/recovery ACKs",
      );
      assert.equal(requests[0].reason, "quit");
      bridge.acknowledgeDraftFlush(requests[0].requestId, window, true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(waitCalls, 1);
      if (outcome !== "throw") {
        assert.equal(quitCompleted, false);
        assert.deepEqual(releases, []);
        if (outcome === "timeout")
          t.mock.timers.tick(DEFAULT_QUIT_DRAFT_FLUSH_TIMEOUT_MS);
        else releasePending(outcome === "success");
      }
      assert.equal(await quitting, outcome === "success");
      assert.deepEqual(releases, outcome === "success" ? [] : [window]);
      assert.equal(window.isDestroyed(), false);
      if (outcome === "success") {
        window.close();
        assert.equal(window.isDestroyed(), true);
      }
      releasePending(true);
      window.destroy();
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "app quitの全Window flushは全ackを待ち、1件失敗なら全Windowへreleaseする"
  // oracle = { type = "contract", ref = "SessionWindowBridge#flushSessionWindowDrafts" }
  // fault = "先に失敗したWindowだけで終了し、別Windowの未完了flushやfreeze解除を取りこぼす"
  // observable = "flush結果、release対象、完了までの待機"
  // observation_boundary = "public-boundary"
  // scope = "session-window-draft-flush"
  // lifecycle = "permanent"
  // @end-test-value
  /** quit は一窓の失敗だけで先に決着せず全窓の ACK を待ち、失敗後は入力制限の解除を全窓に送ることを確認する。 */
  it("全Window flushの完了を待って失敗releaseを全Windowへ送る", async () => {
    const sessions = [
      createSession({ id: "flush-a" }),
      createSession({ id: "flush-b" }),
    ];
    const windows = new Map<string, StubWindow>();
    const releases: string[] = [];
    let bridge!: SessionWindowBridge<StubWindow>;
    const bridgeWindows = new Map<StubWindow, string>();
    const requests = new Map<
      string,
      { requestId: string; sessionId: string }
    >();
    bridge = new SessionWindowBridge({
      /** セッション ID と生成窓を双方向に記録し、後で解除通知の宛先を照合する。 */
      createWindow: (id) => {
        const window = new StubWindow();
        windows.set(id, window);
        bridgeWindows.set(window, id);
        return window;
      },
      /** 複数窓への保存要求を観測し、チャットは実読込みしない。 */
      async loadChatEntry() {},
      /** 開窓対象の各 ID を保存済みセッション一覧から解決する。 */
      getSession: (id) => sessions.find((session) => session.id === id) ?? null,
      /** quit の失敗条件を下書き保存に絞り、実行中のセッションはないものとする。 */
      isRunInFlight: () => false,

      /** すべての窓を対象とする quit の試験では通常終了確認を承認しない。 */
      confirmCloseWhileRunning: () => false,
      /** 開窓一覧の通知と別に、失敗時の解除通知だけを記録する。 */
      broadcastOpenSessionWindowIds() {},
      /** 要求ごとの ACK を返すための固定の送信元を返す。 */
      getWindowSender: () => "sender",
      /** セッション単位で下書き保存要求を保持し、試験側から順に ACK を返す。 */
      sendDraftFlushRequest: (_window, request) => {
        requests.set(request.sessionId, request);
      },
      /** 保存失敗時に解除を受けた窓を元のセッション ID へ変換して記録する。 */
      sendDraftFlushRelease: (window, payload) => {
        if (!payload.success) releases.push(bridgeWindows.get(window)!);
      },
    });
    await bridge.openSessionWindow("flush-a");
    await bridge.openSessionWindow("flush-b");
    const flushing = bridge.flushSessionWindowDrafts();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.deepEqual(releases, []);
    bridge.acknowledgeDraftFlush(
      requests.get("flush-a")!.requestId,
      "sender",
      false,
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.deepEqual(releases, []);
    bridge.acknowledgeDraftFlush(
      requests.get("flush-b")!.requestId,
      "sender",
      true,
    );
    assert.equal(await flushing, false);
    assert.deepEqual(releases.sort(), ["flush-a", "flush-b"]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "明示的DBリセットの一括closeは保存ACKを待たずWindowを破棄し、closedに合わせて管理とownerを解放する"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-window-close" }
  // fault = "通常closeのflush失敗で実Windowが残り、registryだけ空になる"
  // observable = "Window破棄状態、公開registry、closed通知、進行中closeの結果"
  // observation_boundary = "public-boundary"
  // scope = "session-window-reset-discard"
  // lifecycle = "permanent"
  // impact = "削除済みSessionのWindowが管理外で残り、終了や対象解決が壊れる"
  // distinction = "DBを書き換えずreset consumerの一括closeと遅延closedを検証する。通常close単独のtestでは検出できない"
  // @end-test-value
  /** データベース reset は未応答の下書き保存を待たず窓を破棄し、実 closed に合わせて管理と所有者を解放することを確かめる。 */
  it("resetの一括closeは未応答のdraft保存を待たず実Windowと管理を解放する", async () => {
    const { bridge, requests, closedIds } = createDraftFlushBridge();
    const first = await bridge.openSessionWindow("reset-a");
    const second = await bridge.openSessionWindow("reset-b");
    second.delayClosedEvent = true;
    const closing = bridge.requestCloseSessionWindow("reset-a");
    try {
      bridge.closeAllSessionWindows();
      assert.equal(first.isDestroyed(), true);
      assert.equal(second.isDestroyed(), true);
      assert.equal(await closing, true);
      assert.deepEqual(bridge.listOpenSessionWindowIds(), []);
      assert.deepEqual(closedIds, ["reset-a"]);
      second.emitClosed();
      assert.deepEqual(closedIds, ["reset-a", "reset-b"]);
      assert.equal(bridge.getWindow("reset-b"), null);
      for (const request of requests) {
        assert.equal(
          bridge.acknowledgeDraftFlush(
            request.requestId,
            request.window,
            false,
          ),
          false,
        );
      }
    } finally {
      first.destroy();
      second.destroy();
      second.emitClosed();
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "通常closeとquitが重なってもquitの強いflushを待ち、保存済みcloseだけでrendererを先に破棄しない"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md" }
  // fault = "close ACKだけでrendererを破棄し、quitの強いflushやpending sendのsettlementを取りこぼす"
  // observable = "closeとquitの結果、Window破棄状態、rendererへの保存要求数"
  // observation_boundary = "public-boundary"
  // scope = "session-window-close-quit-overlap"
  // lifecycle = "permanent"
  // impact = "送信結果が未確定の下書きを失ったままDBを閉じる"
  // distinction = "両方の開始順序を制御し、単独closeやquitでは観測できない競合を小さいメモリWindowで検証する"
  // @end-test-value
  /** 通常 close と quit のどちらを先に要求しても、必要な quit の保存を待ち、それだけで古い窓を先に破棄しないことを確認する。 */
  it("close先行とquit先行のどちらでも保存成功を共有する", async () => {
    for (const closeFirst of [true, false]) {
      const { bridge, requests } = createDraftFlushBridge();
      const window = await bridge.openSessionWindow("overlap");
      const first = closeFirst
        ? bridge.requestCloseSessionWindow("overlap")
        : bridge.flushSessionWindowDrafts();
      const second = closeFirst
        ? bridge.flushSessionWindowDrafts()
        : bridge.requestCloseSessionWindow("overlap");
      const quitting = closeFirst ? second : first;
      try {
        assert.deepEqual(
          requests.map((request) => request.reason),
          closeFirst ? ["close", "quit"] : ["quit"],
        );
        bridge.acknowledgeDraftFlush(requests[0].requestId, window, true);
        await new Promise((resolve) => setImmediate(resolve));
        for (const request of requests.slice(1))
          bridge.acknowledgeDraftFlush(request.requestId, window, true);
        assert.equal(await quitting, true);
        assert.equal(window.isDestroyed(), false);
        window.close();
        assert.equal(window.isDestroyed(), true);
        assert.deepEqual(await Promise.all([first, second]), [true, true]);
        assert.equal(requests.length, closeFirst ? 2 : 1);
      } finally {
        window.destroy();
      }
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "quit失敗後の新しいclose retryは、失敗した旧close ACKに破棄や失敗を汚染されない"
  // oracle = { type = "contract", ref = "SessionWindowBridge#requestCloseSessionWindow" }
  // fault = "quit failure後に到着した旧close ACKがWindowを閉じる、または新しいclose flushを失敗扱いにする"
  // observable = "旧ACK前後のWindow破棄状態、新retryの結果、flush release対象"
  // observation_boundary = "public-boundary"
  // scope = "session-window-close-quit-stale-ack"
  // lifecycle = "permanent"
  // @end-test-value
  /** quit の失敗後に再試行した close を、旧 close の遅い ACK が解凍・破棄せず、新しい ACK だけで完了させることを確かめる。 */
  it("quit失敗後の旧close ACKを無視して新しいclose retryを完了する", async () => {
    const { bridge, requests, releases } = createDraftFlushBridge();
    const window = await bridge.openSessionWindow("stale-close");
    const closing = bridge.requestCloseSessionWindow("stale-close");
    const quitting = bridge.flushSessionWindowDrafts();
    assert.deepEqual(
      requests.map((request) => request.reason),
      ["close", "quit"],
    );
    bridge.acknowledgeDraftFlush(requests[1].requestId, window, false);
    assert.equal(await quitting, false);
    assert.deepEqual(releases, [window]);
    const retry = bridge.requestCloseSessionWindow("stale-close");
    const retryRequest = requests.at(-1)!;
    assert.equal(retryRequest.reason, "close");
    bridge.acknowledgeDraftFlush(requests[0].requestId, window, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(window.isDestroyed(), false);
    assert.deepEqual(
      releases,
      [window],
      "a late close ACK must not release the retry's freeze",
    );
    bridge.acknowledgeDraftFlush(retryRequest.requestId, window, true);
    assert.equal(await retry, true);
    assert.equal(await closing, false);
    assert.equal(window.isDestroyed(), true);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "close失敗またはclose timeoutがquitと重なっても、quitの強いflush結果を優先する"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md" }
  // fault = "弱いclose timeoutをquitの失敗と誤認し、強いquit ACK前にWindowを破棄する"
  // observable = "close timeout後のquit結果、release通知、Window生存状態"
  // observation_boundary = "public-boundary"
  // scope = "session-window-close-quit-failure"
  // lifecycle = "permanent"
  // impact = "送信settlement待ちを省略し、未保存本文を失う"
  // distinction = "closeの弱い失敗とquitの強いflush結果を分離して確認する"
  // @end-test-value
  /** 通常 close が失敗または時間切れでも、並行する quit の保存が終わるまで入力を解凍しないことを確かめる。 */
  it("closeの失敗とtimeoutではquit全体が終わるまで解凍しない", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const failure of ["ack", "timeout"]) {
      const { bridge, requests, releases } = createDraftFlushBridge();
      const first = await bridge.openSessionWindow("failure-a");
      const second = await bridge.openSessionWindow("failure-b");
      const closing = bridge.requestCloseSessionWindow("failure-a");
      t.mock.timers.tick(5_000);
      const quitting = bridge.flushSessionWindowDrafts();
      try {
        if (failure === "ack")
          bridge.acknowledgeDraftFlush(requests[0].requestId, first, false);
        else t.mock.timers.tick(5_000);
        assert.equal(first.isDestroyed(), false);
        assert.deepEqual(releases, []);
        for (const request of requests.slice(1))
          bridge.acknowledgeDraftFlush(request.requestId, request.window, true);
        assert.equal(await quitting, true);
        assert.deepEqual(releases, []);
        assert.equal(first.isDestroyed(), false);
        assert.deepEqual(
          requests.map((request) => request.reason),
          ["close", "quit", "quit"],
        );
        first.close();
        second.close();
        assert.equal(await closing, true);
      } finally {
        first.destroy();
        second.destroy();
      }
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "quitのACK後も通常closeはquit gate中にWindowを破棄せず、quitの結果を優先する"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md" }
  // fault = "quit gate中の通常closeでrendererを先に破棄し、pending sendのsettlementを迂回する"
  // observable = "quit完了前後のWindow生存、close要求の保留、release対象"
  // observation_boundary = "public-boundary"
  // scope = "session-window-quit-ack-close"
  // lifecycle = "permanent"
  // impact = "送信結果が未確定のままWindowを閉じ、復元対象の本文を失う"
  // distinction = "quit gate中のcloseが追加flushや破棄へ進まず、quitの強いACK境界を守ることを確認する"
  // @end-test-value
  /** quit の renderer ACK 後に通常 close を要求しても、Main の送信確定と quit の結果が決まる前に窓を破棄しないことを確認する。 */
  it("quit中のACK後closeはWindowを破棄せずquit結果を待つ", async () => {
    let releasePending!: () => void;
    const pendingSend = new Promise<boolean>((resolve) => {
      releasePending = () => resolve(true);
    });
    const { bridge, requests, releases } = createDraftFlushBridge({
      /** ACK の後も送信確定待ちを保留し、その間に通常終了を要求できるようにする。 */
      waitForPendingDraftSends: () => pendingSend,
    });
    const first = await bridge.openSessionWindow("saved-a");
    const second = await bridge.openSessionWindow("saved-b");
    let quitCompleted = false;
    const quitting = bridge.flushSessionWindowDrafts().then((result) => {
      quitCompleted = true;
      return result;
    });
    try {
      bridge.acknowledgeDraftFlush(requests[0].requestId, first, true);
      await new Promise((resolve) => setImmediate(resolve));
      let closeCompleted = false;
      const closing = bridge
        .requestCloseSessionWindow("saved-a")
        .then((result) => {
          closeCompleted = true;
          return result;
        });
      assert.equal(first.isDestroyed(), false);
      assert.equal(requests.length, 2);
      bridge.acknowledgeDraftFlush(requests[1].requestId, second, true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        quitCompleted,
        false,
        "renderer ACKs alone must not bypass Main's pending sends",
      );
      assert.equal(closeCompleted, false);
      assert.deepEqual(releases, []);
      assert.equal(first.isDestroyed(), false);
      first.close();
      assert.equal(
        first.isDestroyed(),
        false,
        "close remains deferred during Main send settlement",
      );
      releasePending();
      assert.equal(await quitting, true);
      first.close();
      assert.equal(first.isDestroyed(), true);
      assert.equal(await closing, true);
      assert.equal(await quitting, true);
    } finally {
      first.destroy();
      second.destroy();
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "共有flushのACK前にWindowが消滅した場合は破棄済みsenderへアクセスせずそのWindowの要求だけ失効させ、quit失敗後に生存Windowで再試行できる"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md" }
  // fault = "破棄済みWindowへのアクセスで例外となる、消滅を保存成功扱いする、または別Windowの未完了flushまで失効させる"
  // observable = "破棄時の例外の不在、破棄済み・生存WindowのACK受理結果、quitの失敗、生存Windowへのrelease、再試行の成功"
  // observation_boundary = "public-boundary"
  // scope = "session-window-close-quit-destroy"
  // lifecycle = "permanent"
  // impact = "保存成否不明なのに全体終了するか、残ったWindowを編集できなくなる"
  // distinction = "Windowとsenderを別identityにし破棄後の取得を拒否して、ACK前destroyの失敗と別Windowの要求保持を確認する。型検査・正常closeだけでは代替できず実プロセス起動も不要"
  // @end-test-value
  /** 保存 ACK の前に窓が消えたら壊れた送信元を照会せず、その要求を失効させて quit を失敗とし、残った窓で再試行できることを確かめる。 */
  it("共有flushのACK前destroyはquit失敗となり生存Windowで再試行できる", async () => {
    const senders = new Map<StubWindow, object>();
    const { bridge, requests, releases } = createDraftFlushBridge({
      /** 生存窓ごとに安定した送信元を返し、破棄済みの窓を照会した場合には例外にする。 */
      getWindowSender: (window) => {
        if (window.isDestroyed())
          throw new TypeError("Object has been destroyed");
        let sender = senders.get(window);
        if (!sender) {
          sender = {};
          senders.set(window, sender);
        }
        return sender;
      },
    });
    const first = await bridge.openSessionWindow("destroy-a");
    const second = await bridge.openSessionWindow("destroy-b");
    void bridge.requestCloseSessionWindow("destroy-a");
    const quitting = bridge.flushSessionWindowDrafts();
    assert.doesNotThrow(() => first.destroy());
    for (const request of requests) {
      assert.equal(
        bridge.acknowledgeDraftFlush(
          request.requestId,
          senders.get(request.window),
          true,
        ),
        request.window === second,
      );
    }
    assert.equal(await quitting, false);
    assert.deepEqual(releases, [second]);
    const retry = bridge.flushSessionWindowDrafts();
    const latest = requests.at(-1)!;
    assert.equal(
      bridge.acknowledgeDraftFlush(latest.requestId, senders.get(second), true),
      true,
    );
    assert.equal(await retry, true);
    second.close();
    assert.equal(second.isDestroyed(), true);
  });
});
