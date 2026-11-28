import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { createMainSessionRuntime } from "../../src-electron/app/main-session-runtime-assembly.js";
import { MainSessionCommandFacade } from "../../src-electron/app/main-session-command-facade.js";
import { MainSessionTurnQueueFacade } from "../../src-electron/app/main-session-turn-queue-facade.js";
import { SessionPersistenceService } from "../../src-electron/session/session-persistence-service.js";
import { SessionApprovalService } from "../../src-electron/session/session-approval-service.js";
import { SessionObservabilityService } from "../../src-electron/session/session-observability-service.js";
import { readSessionMonitorPage } from "../../src-electron/session/session-monitor-query.js";
import { SessionTurnQueueService } from "../../src-electron/session/session-turn-queue-service.js";
import { sessionSummaryToSession } from "../../src-electron/session/session-summary-adapter.js";
import {
  assertCapturedComposerAttachmentsAvailable,
  resolveComposerPreview,
} from "../../src-electron/files/composer-attachments.js";
import {
  buildNewSession,
  getSessionIncarnationId,
  type Session,
} from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import {
  projectLiveSessionRunStatus,
  type LiveSessionRunStatus,
} from "../../src-shared/session/live-session-run-status.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type {
  ProviderCodingAdapter,
  RunSessionTurnInput,
} from "../../src-electron/providers/provider-runtime.js";
import { composeProviderPrompt } from "../../src-electron/providers/provider-prompt.js";
import {
  SessionWindowBridge,
  type SessionWindowLike,
} from "../../src-electron/windows/session-window-bridge.js";
import { WindowBroadcastService } from "../../src-electron/windows/window-broadcast-service.js";
import { WITHMATE_LIVE_SESSION_RUN_STATUS_EVENT } from "../../src-shared/ipc/withmate-ipc-channels.js";
import { buildHomeSessionProjection } from "../../src/home/home-session-projection.js";

/** 実行や受付を指定の検証地点で止め、テストから再開できる待機点を作る。 */
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// @test-value v2
// kind = "contract"
// claim = "親が作成または復旧した子はWindowなしで保存・実行でき、両Monitorは実行・承認待ちとWindowなしで終了した子を表示する。明示openは一つのWindowを作り、続くopenは同じWindowを再利用する"
// oracle = { type = "contract", ref = "docs/design/window-architecture.md#sessionの起動と継続; docs/design/session-run-lifecycle.md#session-window-close" }
// fault = "子の公開やqueue実行でSession Windowを生成する、作成復旧を完了しない、実Windowのない子を実行中・実行後にMonitorから落とす、明示openでWindowを二重生成する"
// observable = "Window factoryの呼出数とopen identity、復旧直後の公開summary、保存receiptの状態、両Monitor送信先のlive状態通知、MonitorのRunning・Attention・Stopped対象、公開済み承認要求、Stopped close後のMonitor query"
// observation_boundary = "component-behavior"
// scope = "Main child lifecycle, queued runtime, Monitor query and Session Window bridge with real SQLite Worker and a synthetic provider and window factory"
// lifecycle = "permanent"
// @end-test-value
/** 子セッションの作成・復旧・実行をウィンドウと分離し、Monitor から明示して開く場合だけ生成・再利用する。 */
test(
  "子の作成・復旧と実行にはWindowを作らずMonitorから明示openする",
  { timeout: 15000 },
  async () => {
    const temporary = await mkdtemp(
      path.join(os.tmpdir(), "withmate-child-window-"),
    );
    const bundle = createV6StorageWorkerBundle({
      dbPath: path.join(temporary, "withmate-v6.db"),
      userDataPath: temporary,
    });
    const saved = bundle.stores.session;
    const queueStore = bundle.stores.queue;
    const running = gate(),
      allowApproval = gate(),
      attention = gate();
    const settings = normalizeAppSettings({});
    let queue: SessionTurnQueueService | undefined;
    let closeConfirmations = 0;
    let windowCount = 0;
    let providerCalls = 0;
    /** 実ウィンドウの契約に、表示可能通知とフォーカス回数を観測する手段を加える。 */
    type Window = SessionWindowLike & {
      /** レンダラーなしでエントリーの表示可能通知を送る。 */ emit(
        event: "ready-to-show",
      ): boolean;
      focusCount: number;
    };
    const bridge = new SessionWindowBridge<Window>({
      /** 作成回数を数えながら、画面を表示しないイベント付きウィンドウを作る。 */
      createWindow: () => {
        windowCount += 1;
        let destroyed = false;
        const events = new EventEmitter();
        const window = Object.assign(events, {
          focusCount: 0,
          /** 閉鎖済みかをウィンドウの代替状態から返す。 */ isDestroyed: () =>
            destroyed,
          /** 作成したウィンドウを最小化していないものとして扱う。 */ isMinimized:
            () => false,
          /** 検証ではウィンドウを実際に最小化しない。 */
          minimize() {},
          /** 画面に触れず復帰操作を受け付ける。 */ restore() {},
          /** ネイティブ画面を開かずに表示要求を受け付ける。 */ show() {},
          /** 既存ウィンドウを開き直した際のフォーカスを計数する。 */ focus() {
            this.focusCount += 1;
          },
          /** 閉鎖イベントを発火し、取り消されなければウィンドウを破棄する。 */
          close: () => {
            let prevented = false;
            events.emit("close", {
              /** 実行中の閉鎖が取り消されたことをマークする。 */ preventDefault:
                () => {
                  prevented = true;
                },
            });
            if (!prevented) window.destroy();
          },
          /** 破棄済みにして閉鎖通知を送る。 */
          destroy: () => {
            destroyed = true;
            events.emit("closed");
          },
        });
        return window;
      },
      /** チャットの描画を省略し、表示可能になった通知だけを送る。 */
      loadChatEntry: async (window) => {
        window.emit("ready-to-show");
      },
      /** 表示対象を保持中のキャッシュから識別子で探す。 */
      getSession: (id) => cache.find((session) => session.id === id) ?? null,
      /** ウィンドウの有無と独立した実行状態をランタイムから得る。 */
      isRunInFlight: (id) => runtime.isRunInFlight(id),
      /** 実行中に閉じる際の確認を計数し、閉鎖を許可する。 */
      confirmCloseWhileRunning: () => {
        closeConfirmations += 1;
        return true;
      },
      /** ウィンドウ一覧の通知は、実行状態のイベント検証とは分離する。 */
      broadcastOpenSessionWindowIds() {},
    });
    /** Monitor に届いたセッションごとの実行状態の変更を記録する。 */
    type MonitorSignal = {
      sessionId: string;
      status: LiveSessionRunStatus | null;
    };
    const monitorSignals: [MonitorSignal[], MonitorSignal[]] = [[], []];
    const monitorWindows = monitorSignals.map((signals) => ({
      /** 実行状態の送信先となる Monitor を常に生存中として扱う。 */ isDestroyed:
        () => false,
      webContents: {
        /** 実行状態のチャンネルに送られたペイロードだけを各 Monitor の記録へ追加する。 */
        send: (channel: string, payload: unknown) => {
          if (channel === WITHMATE_LIVE_SESSION_RUN_STATUS_EVENT)
            signals.push(payload as MonitorSignal);
        },
      },
    }));
    const broadcast = new WindowBroadcastService({
      /** 配信用の総ウィンドウ一覧に二つの Monitor の代替だけを供給する。 */ getAllWindows:
        () => monitorWindows,
      /** 最初のウィンドウを Home の一覧として返す。 */ getHomeWindows: () =>
        monitorWindows.slice(0, 1),
      /** 一つ目の配信先を優先 Home として返す。 */
      getPrimaryHomeWindow: () => monitorWindows[0],
      /** 実行状態の通知対象に二つの Monitor を含める。 */ getLiveSessionRunStatusWindows:
        () => monitorWindows,
      /** チャットのウィンドウを経由せず Monitor へ配信する条件を作る。 */
      getSessionWindows: () => [],
      /** 実行中の Session と結び付くチャット画面がないことを示す。 */ getLiveSessionRunWindow:
        () => null,
    });
    const live = new SessionObservabilityService({
      /** Monitor の実行状態に利用枠の通知を混ぜない。 */ onProviderQuotaTelemetryChanged() {},
      /** 会話使用量の変更に対する別の通知を発生させない。 */ onSessionContextTelemetryChanged() {},
      /** 実行中・承認待ちを Monitor の対象に保持し、状態通知とテストの待機解除を行う。 */
      onLiveSessionRunChanged: (id, state) => {
        const status = projectLiveSessionRunStatus(state);
        // 通常の実行（Auxiliary ではない）でも同じ Main の組み立て用コールバックを使う。
        if (
          status?.runState === "running" ||
          status?.cancellationState ||
          status?.approvalPending
        )
          bridge.retainSessionForMonitor(id);
        broadcast.broadcastLiveSessionRun(id, state);
        if (state?.approvalRequest) attention.resolve();
      },
    });
    const approvals = new SessionApprovalService({
      updateLiveSessionRun: live.updateLiveSessionRun.bind(live),
    });
    let cache: Session[] = [];
    const model = {
      id: "model",
      label: "Model",
      reasoningEfforts: ["high" as const],
    };
    const provider = {
      id: "codex",
      label: "Codex",
      defaultModelId: model.id,
      defaultReasoningEffort: "high" as const,
      models: [model],
    };
    const snapshot = { providers: [provider] };
    const persistence = new SessionPersistenceService({
      /** 永続化サービスに現在の Session キャッシュを返す。 */
      getSessions: () => cache,
      /** 永続化で変更された Session のキャッシュを保持する。 */ setSessions: (
        next,
      ) => {
        cache = next;
      },
      /** 対象の Session をキャッシュ内で識別子から解決する。 */ getSession: (
        id,
      ) => cache.find((session) => session.id === id) ?? null,
      getStoredSession: saved.getSession,
      getStoredSessionSummary: saved.getSessionSummary,
      listStoredSessionSummaries: saved.listSessionSummaries,
      /** 保存の判断にランタイムの実行状態を使う。 */
      isSessionRunInFlight: (id) => runtime.isRunInFlight(id),
      /** 新規作成か更新かを区別し、実 Worker の保存へ渡す。 */ upsertStoredSession:
        (session, op) =>
          op === "create"
            ? saved.insertSession(session)
            : saved.updateSession(session),
      appendStoredRunningTurnStart: saved.appendRunningTurnStart,
      appendStoredSessionTerminal: saved.appendSessionTerminal,
      checkpointStoredSessionRunMetadata: saved.checkpointSessionRunMetadata,
      /** セッション全体を置換する必要があれば、実データベースで完了するまで待つ。 */ replaceStoredSessions:
        async (sessions) => {
          await saved.replaceSessions(sessions);
        },
      listStoredSessions: saved.listSessions,
      /** 作成と実行に同じアプリ設定を供給する。 */ getAppSettings: () =>
        settings,
      /** 保存の構成に検証用モデルカタログを使う。 */ getModelCatalogSnapshot:
        () => snapshot,
      getSessionLifecycleOperation: saved.getSessionLifecycleOperation,
      listPendingSessionLifecycleOperations:
        saved.listPendingSessionLifecycleOperations,
      beginSessionLifecycleOperation: saved.beginSessionLifecycleOperation,
      prepareSessionLifecycleCreation: saved.prepareSessionLifecycleCreation,
      advanceSessionLifecycleOperation: saved.advanceSessionLifecycleOperation,
      /** 保存後に使用量表示の副作用を起こさない。 */
      clearSessionContextTelemetry() {},
      /** 保存サービスからプロバイダーの外部スレッドを破棄しない。 */ invalidateProviderSessionThread() {},
      /** 保存に伴う閉鎖を、テストで明示するウィンドウ操作と分離する。 */ closeSessionWindow() {},
      /** 保存一覧の通知に実画面を必要としないようにする。 */ broadcastSessions() {},
    });
    const approval = {
      requestId: "approval",
      provider: "codex",
      kind: "test",
      title: "Synthetic approval",
      summary: "Fixture",
      decisionMode: "direct-decision" as const,
    };
    const waitForApproval = "Wait for approval without a Window";
    const runtime = createMainSessionRuntime({
      owner: {
        /** この実行中に保存世代が失効しない条件を作る。 */ assertActive() {},
        /** 実行オーナーは待機中も有効なままとする。 */ isActive: () => true,
      },
      admission: {
        /** 競合する受付を用意せず、予約処理をその場で実行する。 */ runSessionAdmissionExclusive:
          async (_, reserve) => reserve(),
      },
      sessions: {
        getSession: saved.getSession,
        persistRunningTurnStart:
          persistence.persistRunningTurnStart.bind(persistence),
        persistQueuedTurnStart:
          persistence.persistQueuedTurnStart.bind(persistence),
        appendRunningInput: persistence.appendRunningInput.bind(persistence),
        appendTerminalSession:
          persistence.appendTerminalSession.bind(persistence),
        checkpointRuntimeMetadata:
          persistence.checkpointRuntimeMetadata.bind(persistence),
        clearCharacterAuthoringRuntimeState:
          persistence.clearCharacterAuthoringRuntimeState.bind(persistence),
      },
      resolution: {
        /** 選択された Session を別の実行用 Session に差し替えない。 */ resolveRuntimeSessionForTurn:
          (session) => session,
        /** 保存している Session をそのままプロバイダーへ渡す。 */ resolveProviderSession:
          (session) => session,
        resolveComposerPreview,
        assertCapturedComposerAttachmentsAvailable,
        /** 会話用フォルダーを検証の一時領域に解決する。 */ resolveSessionFolderPath:
          () => temporary,
        /** 実行に固定モデルのプロバイダーとカタログを返す。 */
        resolveProviderCatalog: () => ({ snapshot, provider }),
      },
      provider: {
        /** 実接続を使わず、承認待ちを模擬できるアダプターを提供する。 */ getProviderCodingAdapter:
          () => ({
            composePrompt: composeProviderPrompt,
            /** 承認待ちの状態に利用枠の条件を追加しない。 */ getProviderQuotaTelemetry:
              async () => null,
            /** 単一のプロバイダースレッドを外部で無効化しない。 */
            invalidateSessionThread: async () => {},
            /** 全スレッドの無効化を外部へ送らない。 */ invalidateAllSessionThreads:
              async () => {},
            /** 呼び出しを計数し、指定の入力だけを承認待ちに進めて中断可能にする。 */ runSessionTurn:
              async (input) => {
                providerCalls += 1;
                if (input.userMessage === waitForApproval) {
                  running.resolve();
                  await allowApproval.promise;
                  await input.onApprovalRequest!(approval);
                  input.signal?.throwIfAborted();
                }
                return {
                  assistantText: "fixture result",
                  threadId: "fixture-thread",
                  usage: null,
                };
              },
          }),
      },
      context: {
        /** ターン開始時に参照するアプリ設定を固定する。 */ getAppSettings:
          () => settings,
        /** 実行には追加のセッション指示を含めない。 */ readSessionInstructions:
          async () => "",
      },
      turn: {
        createSessionTurn: bundle.stores.turn.createSessionTurn,
        updateSessionTurn: bundle.stores.turn.updateSessionTurn,
      },
      live: {
        setLiveSessionRun: live.setLiveSessionRun.bind(live),
        getLiveSessionRun: live.getLiveSessionRun.bind(live),
        /** この検証では利用枠の測定結果を別に保存しない。 */
        setProviderQuotaTelemetry() {},
        /** この検証では会話の使用量状態を変更しない。 */ setSessionContextTelemetry() {},
        /** 実行前後に利用枠の更新処理を別途起動させない。 */ scheduleProviderQuotaTelemetryRefresh() {},
        /** 配信の正本を状態変更のコールバックに限定する。 */ broadcastLiveSessionRun() {},
      },
      interaction: {
        waitForApprovalDecision:
          approvals.waitForLiveApprovalDecision.bind(approvals),
        /** 検証対象外の追加入力要求は取り消す。 */ waitForElicitationResponse:
          () => ({ action: "cancel" }),
        /** 対象の実行に残っている承認要求を実承認サービスで解放する。 */
        resolvePendingApprovalRequest: (id) => approvals.cancelSession(id),
        /** この試験では保留中の追加質問を作らない。 */ resolvePendingElicitationRequest() {},
        /** 実行が終了しても外部のスレッド状態は変更しない。 */ invalidateProviderSessionThread() {},
      },
      notification: {
        /** ランタイムの占有が解けたら対象のキューを再確認させる。 */ onSessionRunReleased:
          (id) => queue?.wake(id),
      },
      timing: {},
    });
    try {
      await bundle.initialize();
      await bundle.stores.character.createCharacter({ name: "Child fixture" });
      const parent = await saved.insertSession(
        buildNewSession({
          id: "parent",
          taskTitle: "Parent",
          workspaceLabel: "Fixture",
          workspacePath: temporary,
          branch: "",
          characterId: "unknown",
          character: "Unknown",
          characterIconPath: "",
          characterThemeColors: { main: "#fff", sub: "#000" },
          provider: "codex",
          model: model.id,
          reasoningEffort: "high",
          approvalMode: "on-request",
          sessionRole: "overall-coordinator",
        }),
      );
      cache = [parent];
      let interruptAuxiliary = false;
      const commands = new MainSessionCommandFacade({
        /** 子の作成と復旧に現在のキャッシュを使う。 */
        getSessions: () => cache,
        /** 親の Session は実行と同じ識別子でキャッシュから解決する。 */ getSession:
          (id) => cache.find((session) => session.id === id) ?? null,
        getStoredSessionSummaries: saved.listSessionSummaries,
        /** 子の作成処理を現在の Worker 世代に結び付ける。 */
        getSessionStorageIdentity: () => bundle,
        /** プロバイダーの競合を挟まず、作成の操作をただちに評価する。 */ runProviderRuntimeOperationExclusive:
          async (operation) => operation(),
        /** 子の作成が Home からの新規起動経路を使ったら失敗させる。 */
        resolveSessionLaunchSelection: async () =>
          assert.fail("Not a Home launch"),
        /** 子の永続化操作を共通の実ストレージへ結ぶ。 */ getSessionPersistenceService:
          () => persistence,
        /** 作成コマンドが使うランタイムをキューと共有させる。 */ getSessionRuntimeService:
          () => runtime,
        /** 子の作成判断に利用枠の測定値を与えない。 */
        getProviderQuotaTelemetry: () => null,
        /** 利用枠の情報の古さを理由に外部更新を発生させない。 */ isProviderQuotaTelemetryStale:
          () => false,
        /** 検証用プロバイダーは利用枠を更新しても測定値を返さない。 */ refreshProviderQuotaTelemetry:
          async () => null,
        /** 子の初期 Auxiliary を保存し、指定時だけ中断して次の復旧を試せるようにする。 */
        initializeCreatedSession: async (session) => {
          if (interruptAuxiliary) {
            interruptAuxiliary = false;
            throw new Error("Initial Auxiliary interrupted");
          }
          await bundle.stores.auxiliary.upsertAuxiliarySession({
            ...session,
            id: `${session.id}-aux`,
            parentSessionId: session.id,
            title: "Aux",
            runState: "idle",
            createdAt: "now",
            composerDraft: "",
            displayAfterMessageIndex: null,
            creationContext: {
              generationId: "test",
              parentIncarnationId: getSessionIncarnationId(session),
            },
          });
        },
        createSessionId: randomUUID,
        /** 新規 Session のフォルダーを一時領域の名前へ割り当てる。 */ createSessionFilesDirectory:
          (id) => path.join(temporary, id),
        /** 復旧時も同じ識別子を同じ一時フォルダーへ解決する。 */ resolveSessionFilesDirectory:
          (id) => path.join(temporary, id),
        /** 一時作業領域を既存 Session の作業領域として扱わない。 */
        isSessionFilesWorkspace: () => false,
        /** 子の処理にデスクトップの通知操作を伴わせない。 */ dismissSessionTurnNotification() {},
        /** 指定した一時作業領域を有効として受け付ける。 */ validateWorkspaceDirectory:
          async () => ({ valid: true }),
        listActiveCharacters: bundle.stores.character.listCharacters,
        createCharacterRuntimeSnapshot:
          bundle.stores.character.createRuntimeSnapshot,
      });
      const request = {
        requestId: randomUUID(),
        role: "executor" as const,
        provider: "codex",
        model: model.id,
        reasoningEffort: "high",
        workspacePath: temporary,
      };
      const actor = {
        id: parent.id,
        incarnationId: getSessionIncarnationId(parent),
      };
      const actorExecution = {
        providerId: parent.provider,
        executionOptions: captureSessionExecutionOptions(parent),
      };
      /** 同じ親と実行設定で作成要求を呼び、冪等性と途中状態からの復旧を検証する。 */
      const create = (input: typeof request) =>
        commands.createChildSession(actor, input, () => {}, actorExecution);
      /** Worker の保存概要と実行状態をつないで Monitor のページを読む。 */
      const readMonitor = () =>
        readSessionMonitorPage({
          /** ウィンドウがなくても追跡される対象をブリッジから取得する。 */ listMonitorSessionIds:
            () => bridge.listMonitorSessionIds(),
          /** Monitor 向けに指定された項目だけを実 Worker から読み込む。 */
          readSummaries: async (ids) =>
            (
              await saved.listSessionSummaryPage({
                scope: "open",
                sessionIds: ids,
              })
            ).entries,
          readAuxiliarySummaries:
            bundle.stores.auxiliary.listAuxiliarySessionSummaries,
          getLiveSessionRun: live.getLiveSessionRun.bind(live),
          /** この検証では未読結果ではなく実行と承認の状態を比較する。 */ hasUnreadResult:
            () => false,
        });
      /** 開いたウィンドウの識別情報を使う Crew 一覧を実ストレージから取得する。 */
      const readCrew = () =>
        saved.listHomeCrewMembersPage(
          bridge.listOpenSessionWindowIdentities(),
          null,
          100,
        );
      const child = await create(request);
      assert.equal((await create(request)).id, child.id);
      interruptAuxiliary = true;
      const recoveryRequest = { ...request, requestId: randomUUID() };
      await assert.rejects(
        create(recoveryRequest),
        /Initial Auxiliary interrupted/,
      );
      const recoveryTarget = (
        await saved.listPendingSessionLifecycleOperations()
      )[0]!.targets[0]!.id;
      /** 指定の子が公開済み概要に出ているかを実ストレージに問い合わせる。 */
      const isPublished = async (id: string) =>
        (await saved.listSessionSummaries()).some(
          (summary) => summary.id === id,
        );
      assert.equal(await isPublished(recoveryTarget), false);
      await commands.recoverPendingSessionLifecycleOperations();
      assert.equal(await isPublished(recoveryTarget), true);
      const recovered = await create(recoveryRequest);
      assert.equal(recovered.id, recoveryTarget);
      assert.notEqual(recovered.id, child.id);
      assert.equal(
        windowCount,
        0,
        "created and recovered children must not call the Window factory",
      );
      assert.deepEqual((await readMonitor()).entries, []);
      assert.deepEqual(await readCrew(), []);

      queue = new SessionTurnQueueService({
        store: queueStore,
        /** 対象の起動が既に進行中かをランタイムから判断する。 */ isRunInFlight:
          (id) => runtime.isRunInFlight(id),
        /** 受け付けたターンを実ランタイムへ渡し、開始通知と制御を引き継ぐ。 */
        dispatch: (receipt, started, control) =>
          runtime.runQueuedSessionTurn(receipt, started, control),
      });
      await queue.start();
      const senderTurn = await bundle.stores.turn.createSessionTurn({
        sessionId: parent.id,
        phase: "running",
        createdAt: "now",
        provider: "codex",
        model: parent.model,
        reasoningEffort: parent.reasoningEffort,
        approvalMode: parent.approvalMode,
        threadId: "",
        errorMessage: "",
      });
      const sender = new MainSessionTurnQueueFacade({
        /** 同じ保存世代の稼働中に親からの送信を検証する。 */ assertActive() {},
        /** 受付停止を試さないため、親からの通常送信を受け付ける。 */ assertAccepting() {},
        getSession: saved.getSession,
        /** 送信にターンと同じアプリ設定を使う。 */
        getAppSettings: async () => settings,
        /** 検証用の作業領域を外部に依存せず受理する。 */ validateWorkspace:
          async () => {},
        /** 送信時のモデル選択を検証用プロバイダーへ解決する。 */ validateProvider:
          async () => ({ provider }),
        /** 送信本文の取り込みに実 Composer のプレビュー処理を使う。 */
        preview: async (session, text) => resolveComposerPreview(session, text),
        store: queueStore,
        service: queue,
      });
      /** キューの宛先にセッション種別と現在の世代を含める。 */
      const targetOf = (session: Session) => ({
        kind: "main" as const,
        sessionId: session.id,
        incarnationId: getSessionIncarnationId(session),
      });
      /** 保存された親ターンから、指定の子へキュー経由でメッセージを送る。 */
      const enqueue = (target: ReturnType<typeof targetOf>, message: string) =>
        sender.enqueueSessionMessage(
          { requestId: randomUUID(), target, message },
          {
            kind: "session",
            operation: "send",
            actorKind: "main",
            actorSessionId: parent.id,
            actorIncarnationId: actor.incarnationId,
            actorTurnId: String(senderTurn.id),
            targetSessionId: target.sessionId,
            targetIncarnationId: target.incarnationId,
          },
          () => {},
        );
      const target = targetOf(child);
      const accepted = await enqueue(target, waitForApproval);
      assert.equal(accepted.state, "starting");
      await running.promise;
      const active = await queueStore.getReceipt(target, accepted.requestId);
      assert.equal(active?.state, "running");
      assert.deepEqual(
        (await readMonitor()).entries.map(({ id, runState }) => [id, runState]),
        [[child.id, "running"]],
      );
      assert.deepEqual(await readCrew(), []);
      allowApproval.resolve();
      await attention.promise;
      assert.equal(windowCount, 0);
      const snapshot = await readMonitor();
      const attentionEntries = buildHomeSessionProjection(
        snapshot.entries,
        snapshot.entries.map(({ id }) => id),
        "",
        snapshot.auxiliarySessions,
      ).approvalMonitorEntries;
      assert.deepEqual(
        attentionEntries.map(({ session, state }) => [session.id, state.label]),
        [[child.id, "Attention"]],
      );
      for (const signals of monitorSignals)
        assert.ok(
          signals.some(
            ({ sessionId, status }) =>
              sessionId === child.id && status?.approvalPending,
          ),
        );

      const fromAttention = attentionEntries[0]!.session.id;
      const window = await bridge.openSessionWindow(fromAttention);
      assert.equal(await bridge.openSessionWindow(fromAttention), window);
      assert.equal(windowCount, 1);
      assert.equal(window.focusCount, 2);
      assert.ok((await readCrew()).some((member) => member.id === child.id));
      assert.equal(
        live.getLiveSessionRun(child.id)?.approvalRequest?.requestId,
        approval.requestId,
      );
      assert.ok(active?.turnId);
      assert.equal(
        (
          await runtime.stopSessionTurn(
            child.id,
            target.incarnationId,
            active.turnId,
          )
        ).outcome,
        "applied",
      );
      await queue.waitForPending();
      await runtime.waitForPendingRuns();
      assert.equal(
        (await queueStore.getReceipt(target, accepted.requestId))?.state,
        "canceled",
      );
      assert.equal(providerCalls, 1);
      assert.deepEqual(
        (await readMonitor()).entries.map(
          ({ id, runState, approvalPending }) => [
            id,
            runState,
            approvalPending,
          ],
        ),
        [[child.id, "idle", false]],
      );
      assert.equal(await bridge.requestCloseSessionWindow(child.id), true);
      assert.equal(closeConfirmations, 0);
      assert.deepEqual((await readMonitor()).entries, []);

      const recoveredTarget = targetOf(recovered);
      const finishing = await enqueue(
        recoveredTarget,
        "Complete without a Window",
      );
      await queue.waitForPending();
      await runtime.waitForPendingRuns();
      assert.equal(
        (await queueStore.getReceipt(recoveredTarget, finishing.requestId))
          ?.state,
        "completed",
      );
      assert.equal(providerCalls, 2);
      assert.equal(windowCount, 1, "the recovered child never opened a Window");
      const stopped = await readMonitor();
      const stoppedEntries = buildHomeSessionProjection(
        stopped.entries,
        stopped.entries.map(({ id }) => id),
        "",
        stopped.auxiliarySessions,
      ).nonRunningMonitorEntries;
      assert.deepEqual(
        stoppedEntries.map(({ session }) => session.id),
        [recovered.id],
      );
      assert.deepEqual(await readCrew(), []);
      await bridge.openSessionWindow(recovered.id);
      assert.equal(await bridge.requestCloseSessionWindow(recovered.id), true);
      assert.deepEqual((await readMonitor()).entries, []);
    } finally {
      allowApproval.resolve();
      runtime.cancelAllRuns();
      approvals.reset();
      await Promise.all([queue?.close(), runtime.waitForPendingRuns()]);
      live.dispose();
      await bundle.client.close();
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

// @test-value v2
// kind = "contract"
// claim = "初回受付で実行枠を同時確保し、後続の固定入力・Provider thread・会話枠を保持する。終端返信喪失は正本を保持し、開始保存の返信不明は稼働中に実guard解放後だけ照合して後続を進める"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#gui-turn-queue; docs/design/electron-session-store.md#turn-queue; docs/design/prompt-composition.md#metadataと必要時取得" }
// fault = "即時開始の受付を先にqueuedでcommitまたは通知する、同時送信も開始する、受付後に入力や表示所属が変わる、または不明実行を自動再送する"
// observable = "Worker commit直後と受付通知からの一覧、ACK、保存receipt、Provider入力に含む会話枠と呼出順、公開履歴seq、実guard解除前後の実WorkerのTurn状態・thread・終端"
// observation_boundary = "public-boundary"
// scope = "MainSessionRuntimeAssembly + QueueFacade/Service + SessionPersistenceService + V6StorageWorkerBundle"
// lifecycle = "permanent"
// impact = "受付した指示が異なる設定/pathで実行される、同じ会話が重複実行される、receiptと履歴が乖離することを防ぐ"
// distinction = "個別fake port testではMain owner guard・async Worker proxy・partial persistenceの実結合を検証できない"
// @end-test-value
/** キューへの受付時に入力と設定を取得するが、指示は実行を送出する時点で初めて Worker から読み取る。 */
test("Main queued runtimeは実Worker保存でFIFO捕捉とthread継承を結合する", async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "withmate-queue-runtime-"),
  );
  const bundle = createV6StorageWorkerBundle({
    dbPath: path.join(temporary, "withmate-v6.db"),
    userDataPath: temporary,
  });
  let queue: SessionTurnQueueService | undefined;
  const finishFirst = gate();
  const allowDispatch = gate();
  const firstCommit = gate();
  const releaseFirstReply = gate();
  try {
    await bundle.initialize();
    await writeFile(path.join(temporary, "input.txt"), "captured path fixture");
    const saved = await bundle.stores.session.insertSession({
      ...buildNewSession({
        id: "queue-runtime",
        taskTitle: "Queue",
        workspaceLabel: "workspace",
        workspacePath: temporary,
        branch: "main",
        characterId: "unknown",
        character: "Unknown",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: "on-request",
        model: "captured-native-model",
        reasoningEffort: "native-depth",
      }),
      sessionRole: "overall-coordinator",
      rootSessionId: "queue-runtime",
    });
    const owner = {
      sessionId: saved.id,
      incarnationId: getSessionIncarnationId(saved),
    };
    const target = { kind: "main" as const, ...owner };
    await bundle.stores.instructions.set(target, "before acceptance");
    const [a, b] = await Promise.all(
      ["peer-a", "peer-b"].map(async (id) => {
        const peer = await bundle.stores.session.insertSession({
          ...saved,
          id,
          incarnationId: id + "-v1",
          sessionRole: "executor",
          parentSessionId: saved.id,
          createdBySessionId: saved.id,
        });
        return {
          kind: "main" as const,
          sessionId: peer.id,
          incarnationId: getSessionIncarnationId(peer),
        };
      }),
    );
    const provider = {
      id: "codex",
      label: "Codex",
      defaultModelId: saved.model,
      defaultReasoningEffort: saved.reasoningEffort,
      models: [
        {
          id: saved.model,
          label: "Model",
          reasoningEfforts: ["medium", "high"] as Array<"medium" | "high">,
        },
      ],
    };
    const snapshot = { providers: [provider] };
    let cache: Session[] = [saved];
    /** Worker から履歴全体を読み込まず、ターンに必要な Session 概要と正本の本文件数を取り出す。 */
    const getSession = async (id: string) => {
      const metadata = await bundle.stores.session.getSessionMetadata(id);
      return metadata
        ? {
            ...sessionSummaryToSession(metadata.summary),
            characterRuntimeSnapshot: metadata.characterRuntimeSnapshot,
            messageCount: metadata.messageCount,
          }
        : null;
    };
    const persistence = new SessionPersistenceService({
      /** 永続化が参照する Session 一覧のキャッシュを供給する。 */
      getSessions: () => cache,
      /** 永続化後のキャッシュ更新をメモリーに反映する。 */ setSessions: (
        next,
      ) => {
        cache = next;
      },
      /** 検証中の最新キャッシュから対象 Session を探す。 */ getSession: (id) =>
        cache.find((session) => session.id === id) ?? null,
      /** 保存時の競合判定に対象 Session のランタイム状態を使用する。 */
      isSessionRunInFlight: () => runtime.isRunInFlight(saved.id),
      /** キュー実行が履歴全体を保存し直した場合は失敗させる。 */ upsertStoredSession:
        () => {
          throw new Error("Queued runtime cannot full-upsert history");
        },
      /** 開始時点のユーザーメッセージとターンを実 Worker に追加する。 */
      appendStoredRunningTurnStart: (input) =>
        bundle.stores.session.appendRunningTurnStart(input),
      /** 実行中の追加入力を Worker が所有するストレージへ追記する。 */
      appendStoredSessionSteer: (input) =>
        bundle.stores.session.appendSessionSteer(input),
      /** 終了応答とターン結果を実 Worker に追記する。 */
      appendStoredSessionTerminal: (input) =>
        bundle.stores.session.appendSessionTerminal(input),
      /** 履歴全体を書き換えず実行時メタデータを Worker に保存する。 */
      checkpointStoredSessionRunMetadata: (input) =>
        bundle.stores.session.checkpointSessionRunMetadata(input),
      /** キュー実行がセッション集合の全置換に退避したら失敗させる。 */
      replaceStoredSessions: () => {
        throw new Error("Unexpected replace");
      },
      /** キュー実行が履歴全体を一覧読み込みしたら失敗させる。 */ listStoredSessions:
        () => {
          throw new Error("Unexpected full list");
        },
      /** 永続化時にアプリ設定の既定値を使う。 */
      getAppSettings: () => normalizeAppSettings({}),
      /** 永続化が参照するモデル一覧を固定する。 */ getModelCatalogSnapshot:
        () => snapshot,
      /** 会話の使用量に対する画面の副作用を発生させない。 */
      clearSessionContextTelemetry() {},
      /** 終了処理ではプロバイダーの実スレッドを無効にしない。 */
      invalidateProviderSessionThread() {},
      /** 履歴の追記に伴って実ウィンドウを閉じない。 */ closeSessionWindow() {},
      /** 保存済み一覧の更新を画面へ送らない。 */ broadcastSessions() {},
    });
    const startedFirst = gate();
    const calls: Array<{
      text: string;
      thread: string;
      model: string;
      depth: string;
      attachment: string;
    }> = [];
    const providerInputs: RunSessionTurnInput[] = [];
    const firstRequestId = randomUUID();
    const secondRequestId = randomUUID();
    const unknownRequestId = randomUUID();
    const followerRequestId = randomUUID();
    let rejectStarted = false;
    let cleanupGuard = false;
    let dispatches = 0;
    let acceptanceWrites = 0;
    const adapter: ProviderCodingAdapter = {
      composePrompt: composeProviderPrompt,
      /** 実行メタデータに利用枠の結果を含めない。 */
      getProviderQuotaTelemetry: async () => null,
      /** 一つのスレッドに対する無効化要求を外部へ送らない。 */ invalidateSessionThread:
        async () => {},
      /** 全スレッドを無効化する外部処理を行わない。 */ invalidateAllSessionThreads:
        async () => {},
      /** 実行開始の受付とターンが先に保存されたことを確認してから、受け取った本文・設定・添付を記録する。 */
      runSessionTurn: async (input) => {
        const requestId =
          calls.length === 0
            ? firstRequestId
            : calls.length === 1
              ? secondRequestId
              : followerRequestId;
        const receipt = await bundle.stores.queue.getReceipt(owner, requestId);
        const turn = await bundle.stores.turn.getLatestSessionTurn(saved.id);
        assert.equal(receipt?.state, "running");
        assert.equal(receipt?.turnId, String(turn?.id));
        assert.equal(receipt?.userMessageSeq, turn?.userMessageSeq);
        providerInputs.push(input);
        calls.push({
          text: input.userMessage,
          thread: input.session.threadId,
          model: input.executionOptions.model,
          depth: input.executionOptions.reasoningEffort,
          attachment: input.attachments[0]?.absolutePath ?? "",
        });
        if (calls.length === 1) {
          startedFirst.resolve();
          await finishFirst.promise;
        }
        return {
          assistantText: `answer-${calls.length}`,
          threadId: `thread-${calls.length}`,
          usage: null,
        };
      },
    };
    let live: LiveSessionRunState | null = null;
    let terminalReplyLost = false;
    const runtime = createMainSessionRuntime({
      owner: {
        /** 受付と実行を通じて同じ所有世代を保つ。 */ assertActive() {},
        /** 同じ Worker を使い続けるため所有者を有効として扱う。 */ isActive:
          () => true,
      },
      admission: {
        /** 他のプロセスからの競合を挟まず、渡された予約処理を実行する。 */ runSessionAdmissionExclusive:
          async (_, operation) => operation(),
      },
      sessions: {
        getSession,
        /** 通常のターン開始を永続化サービスに委ねる。 */ persistRunningTurnStart:
          (session, count) =>
            persistence.persistRunningTurnStart(session, count),
        /** キューの受付と実行開始を同時に保存する。 */
        persistQueuedTurnStart: (session, count, id, turn) =>
          persistence.persistQueuedTurnStart(session, count, id, turn),
        /** 実行中の追加入力を永続化サービスで保存する。 */
        appendRunningInput: (session, text, id) =>
          persistence.appendRunningInput(session, text, id),
        /** 最初の終了確定だけは実ストレージへの反映後に応答を失わせ、照合による回復を検証する。 */
        appendTerminalSession: async (session, terminal) => {
          const committed = await persistence.appendTerminalSession(
            session,
            terminal,
          );
          if (!terminalReplyLost) {
            terminalReplyLost = true;
            throw new Error("First terminal commit reply lost");
          }
          return committed;
        },
        /** 本文数との整合を保ったメタデータの中間保存を行う。 */
        checkpointRuntimeMetadata: (session, expected) =>
          persistence.checkpointRuntimeMetadata(session, expected),
        /** 永続化サービスにキャラクター作成用の実行状態を消去させる。 */
        clearCharacterAuthoringRuntimeState: (session) =>
          persistence.clearCharacterAuthoringRuntimeState(session),
      },
      resolution: {
        /** キューに保存した Session をターン用に差し替えない。 */ resolveRuntimeSessionForTurn:
          (session) => session,
        /** プロバイダー処理にも同じ Session を渡す。 */ resolveProviderSession:
          (session) => session,
        /** 受け付け済みの本文をもう一度プレビューで解析したら失敗させる。 */
        resolveComposerPreview: async () => {
          assert.fail("Accepted queue body must not be re-previewed");
        },
        assertCapturedComposerAttachmentsAvailable,
        /** 相対参照を解釈する Session フォルダーを一時領域に固定する。 */ resolveSessionFolderPath:
          () => temporary,
        /** 保存済みのモデルを実行するために固定カタログを返す。 */
        resolveProviderCatalog: () => ({ snapshot, provider }),
      },
      provider: {
        /** 保存から実行への入力を捕捉するアダプターを返す。 */ getProviderCodingAdapter:
          () => adapter,
      },
      context: {
        /** 検証用ターンの実行設定にはアプリの既定値を使う。 */ getAppSettings:
          () => normalizeAppSettings({}),
        /** 受付時の値を再利用せず、実行時に所有者の最新指示を Worker から取得する。 */ readSessionInstructions:
          async (owner) => {
            const body = await bundle.stores.instructions.get(owner);
            assert.ok(body !== null);
            return body;
          },
      },
      turn: {
        /** 実行の開始レコードを Worker のターン用ストレージに作る。 */ createSessionTurn:
          (input) => bundle.stores.turn.createSessionTurn(input),
        /** 実行ターンの状態変更を Worker の保存へ渡す。 */ updateSessionTurn: (
          id,
          input,
        ) => bundle.stores.turn.updateSessionTurn(id, input),
      },
      live: {
        /** 現在の実行状態を検証中の変数に保持する。 */ setLiveSessionRun: (
          _,
          next,
        ) => {
          live = next;
        },
        /** 直近に設定した実行中の状態を返す。 */ getLiveSessionRun: () => live,
        /** 受け取った利用枠の測定情報を外部へ反映しない。 */
        setProviderQuotaTelemetry() {},
        /** 使用量の測定情報を画面状態に反映しない。 */ setSessionContextTelemetry() {},
        /** 検証中に利用枠を別途取得しない。 */ scheduleProviderQuotaTelemetryRefresh() {},
        /** 検証中の実行状態を画面へ配信しない。 */ broadcastLiveSessionRun() {},
      },
      interaction: {
        /** この検証で承認待ちが発生した場合は許可を返す。 */ waitForApprovalDecision:
          () => "approve",
        /** 対象外の追加質問で入力待ちを続けず取り消す。 */ waitForElicitationResponse:
          () => ({ action: "cancel" }),
        /** 終了時に承認要求の画面通知を発生させない。 */
        resolvePendingApprovalRequest() {},
        /** 終了時に追加質問の画面通知を発生させない。 */ resolvePendingElicitationRequest() {},
        /** 実行終了で外部のスレッドを破棄しない。 */ invalidateProviderSessionThread() {},
      },
      notification: {
        /** 実行の占有が解けた Session のキューを再確認する。 */ onSessionRunReleased:
          (id) => queue?.wake(id),
      },
      timing: {},
    });
    /** 最初の受付は保存完了後にだけ応答を保留し、保存順と応答順が異なる状況を作る。 */
    const admitWithGatedReply = async (
      ...args: Parameters<typeof bundle.stores.queue.admit>
    ) => {
      const result = await bundle.stores.queue.admit(...args);
      acceptanceWrites += 1;
      if (acceptanceWrites === 1) {
        firstCommit.resolve();
        await releaseFirstReply.promise;
      }
      return result;
    };
    const queueStore = new Proxy(bundle.stores.queue, {
      /** 受付の応答だけを待機させ、その他のキュー操作は実ストレージへそのまま渡す。 */
      get: (target, property) =>
        property === "admit"
          ? admitWithGatedReply
          : Reflect.get(target, property),
    });
    const notifications: Array<
      ReturnType<MainSessionTurnQueueFacade["listSessionTurnQueue"]>
    > = [];
    queue = new SessionTurnQueueService({
      store: queueStore,
      /** 実行状態と確認失敗後の片付け中の両方で次の起動を抑える。 */ isRunInFlight:
        (id) => cleanupGuard || runtime.isRunInFlight(id),
      /** キュー変更が通知された時点で、同じ公開経路から一覧を読み直す。 */
      onChanged: () => {
        notifications.push(facade.listSessionTurnQueue(saved.id));
      },
      /** 最初の起動を保留できるようにし、指定時だけ開始確定後の応答を失わせる。 */
      dispatch: async (receipt, started) => {
        dispatches += 1;
        if (receipt.requestId === firstRequestId) await allowDispatch.promise;
        return runtime.runQueuedSessionTurn(receipt, async (input) => {
          if (rejectStarted) {
            rejectStarted = false;
            cleanupGuard = true;
            throw new Error("Atomic start acknowledgement lost");
          }
          await started(input);
        });
      },
    });
    await queue.start();
    let previews = 0;
    const facade = new MainSessionTurnQueueFacade({
      /** Session の保存世代を有効なまま保つ。 */ assertActive() {},
      /** 検証中にキューの受付が閉じない条件を置く。 */ assertAccepting() {},
      getSession,
      /** 送信受付時に検証用の既定設定を読み込む。 */
      getAppSettings: async () => normalizeAppSettings({}),
      /** 検証の一時作業領域を有効とみなす。 */
      validateWorkspace: async () => {},
      /** 送信に指定したモデルと推論強度を検証用プロバイダーで照合する。 */ validateProvider:
        async () => ({ provider }),
      /** 受付時にだけ呼ばれるべき実プレビューの回数を記録する。 */
      preview: async (session, text) => {
        previews += 1;
        return resolveComposerPreview(session, text);
      },
      store: bundle.stores.queue,
      service: queue,
    });
    const options = captureSessionExecutionOptions(saved);
    const firstInput = {
      incarnationId: owner.incarnationId,
      clientRequestId: firstRequestId,
      submitSource: "composer" as const,
      userMessage: "First @input.txt",
      executionOptions: options,
      mainConversationFrame: a,
    };
    const secondInput = {
      incarnationId: owner.incarnationId,
      clientRequestId: secondRequestId,
      submitSource: "composer" as const,
      userMessage: "Second @input.txt",
      executionOptions: { ...options, reasoningEffort: "medium" as const },
      mainConversationFrame: b,
    };
    const accepting = Promise.all([
      facade.enqueueSessionTurn(saved.id, firstInput),
      facade.enqueueSessionTurn(saved.id, secondInput),
    ]);
    await Promise.race([firstCommit.promise, accepting]);
    const committed = (await facade.listSessionTurnQueue(saved.id)).map(
      ({ requestId, state }) => [requestId, state],
    );
    assert.equal(dispatches, 0);
    releaseFirstReply.resolve();
    const [first, second] = await accepting;
    assert.deepEqual(committed, [[firstRequestId, "starting"]]);
    assert.equal(first.state, "starting");
    assert.equal(second.state, "queued");
    assert.equal(
      (await notifications[0])?.find((entry) => entry.id === first.id)?.state,
      "starting",
    );
    assert.equal(dispatches, 1);
    const reconciled = await facade.enqueueSessionTurn(saved.id, firstInput);
    assert.equal(reconciled.id, first.id);
    assert.equal(reconciled.state, "starting");
    assert.equal(acceptanceWrites, 2);
    await bundle.stores.instructions.set(target, "before first dispatch");
    allowDispatch.resolve();
    await startedFirst.promise;
    await bundle.stores.instructions.set(target, "after first dispatch");
    assert.match(
      composeProviderPrompt(providerInputs[0]).systemBodyText,
      /# Session Instructions\n\nbefore first dispatch$/,
    );
    secondInput.userMessage = "Edited after durable ACK";
    secondInput.executionOptions = {
      ...secondInput.executionOptions,
      model: "invalid-after-ACK",
    };
    secondInput.mainConversationFrame = a;
    assert.equal(calls.length, 1);
    finishFirst.resolve();
    await queue.waitForPending();
    await runtime.waitForPendingRuns();
    assert.deepEqual(calls, [
      {
        text: "First @input.txt",
        thread: "",
        model: options.model,
        depth: options.reasoningEffort,
        attachment: path.join(temporary, "input.txt"),
      },
      {
        text: "Second @input.txt",
        thread: "thread-1",
        model: options.model,
        depth: "medium",
        attachment: path.join(temporary, "input.txt"),
      },
    ]);
    assert.match(
      composeProviderPrompt(providerInputs[1]).systemBodyText,
      /# Session Instructions\n\nafter first dispatch$/,
    );
    assert.equal(previews, 2);
    const page = await bundle.stores.queue.listReceipts(owner);
    assert.deepEqual(
      page.receipts.map((receipt) => [
        receipt.id,
        receipt.state,
        receipt.userMessageSeq,
      ]),
      [
        [first.id, "completed", 0],
        [second.id, "completed", 2],
      ],
    );
    assert.notEqual(page.receipts[0]!.turnId, page.receipts[1]!.turnId);
    const stored = await bundle.stores.session.getSession(saved.id);
    assert.deepEqual(
      stored?.messages.map((message) => message.text),
      ["First @input.txt", "answer-1", "Second @input.txt", "answer-2"],
    );
    assert.equal(stored?.threadId, "thread-2");
    for (const [index, thread] of [a, b].entries()) {
      const prompt = composeProviderPrompt(providerInputs[index]);
      const identity = `sessionId: "${saved.id}"\nincarnationId: "${owner.incarnationId}"\nseq: ${2 * index}\n`;
      assert.ok(prompt.inputBodyText.includes(identity));
      const frame = prompt.inputBodyText.match(
        /^# Conversation Thread\n\nthread: (.+)$/m,
      );
      assert.ok(frame);
      assert.deepEqual(JSON.parse(frame[1]), thread);
      assert.doesNotMatch(prompt.systemBodyText, /Conversation Thread/);
      const result = await bundle.stores.execution.execute({
        target,
        operation: "list_messages",
        request: { target, thread },
      });
      assert.ok(result.ok);
      assert.deepEqual(
        (result.items as Array<{ seq: number }>).map(({ seq }) => seq),
        [2 * index, 2 * index + 1],
      );
    }

    rejectStarted = true;
    const unknown = await facade.enqueueSessionTurn(saved.id, {
      incarnationId: owner.incarnationId,
      clientRequestId: unknownRequestId,
      submitSource: "composer",
      userMessage: "Unknown start",
      executionOptions: options,
    });
    await queue.waitForPending();
    assert.equal(
      (await bundle.stores.queue.getReceipt(owner, unknownRequestId))?.state,
      "interrupted",
    );
    const follower = await facade.enqueueSessionTurn(saved.id, {
      incarnationId: owner.incarnationId,
      clientRequestId: followerRequestId,
      submitSource: "composer",
      userMessage: "After recovery",
      executionOptions: options,
    });
    queue.wake(owner.sessionId);
    await queue.waitForPending();
    assert.equal(dispatches, 3);
    assert.equal(
      (await bundle.stores.session.getSession(saved.id))?.runState,
      "running",
    );
    assert.equal(
      (await bundle.stores.turn.getLatestSessionTurn(saved.id))?.phase,
      "running",
    );
    assert.equal(
      (await bundle.stores.queue.getReceipt(owner, followerRequestId))?.state,
      "queued",
    );
    cleanupGuard = false;
    queue.wake(owner.sessionId);
    await queue.waitForPending();
    await runtime.waitForPendingRuns();
    assert.equal(dispatches, 4);
    assert.equal(
      (await bundle.stores.queue.getReceipt(owner, followerRequestId))?.state,
      "completed",
      (await bundle.stores.queue.getReceipt(owner, followerRequestId))
        ?.reason ?? "Follower must complete",
    );
    assert.equal(calls.length, 3);
    assert.equal(calls[2]?.thread, "thread-2");
    assert.equal(calls[2]?.text, "After recovery");
    const recoveredUnknown = await bundle.stores.queue.getReceipt(
      owner,
      unknownRequestId,
    );
    assert.equal(recoveredUnknown?.id, unknown.id);
    assert.equal(recoveredUnknown?.state, "failed");
    assert.equal(recoveredUnknown?.releasedAt, null);
    const recoveredMessage = (await bundle.stores.session.getSession(saved.id))
      ?.messages[5];
    assert.equal(recoveredMessage?.text, "");
    assert.equal(recoveredMessage?.runFailure, recoveredUnknown?.reason);
    assert.equal(
      (await bundle.stores.queue.getReceipt(owner, followerRequestId))?.id,
      follower.id,
    );
    assert.equal(
      (await bundle.stores.session.getSession(saved.id))?.threadId,
      "thread-3",
    );
  } finally {
    releaseFirstReply.resolve();
    allowDispatch.resolve();
    finishFirst.resolve();
    await queue?.close();
    await bundle.client.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
