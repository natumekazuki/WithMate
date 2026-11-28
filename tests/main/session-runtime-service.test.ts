import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, mock } from "node:test";

import {
  buildNewSession,
  getSessionIncarnationId,
} from "../../src-shared/session/session-state.js";
import type {
  SessionTurnQueueReceipt,
  SessionTurnQueueStore,
} from "../../src-shared/session/session-turn-queue.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { currentTimestampLabel } from "../../src-shared/time-state.js";
import type {
  CancelSessionRunRequest,
  ComposerPreview,
  LiveApprovalDecision,
  LiveApprovalRequest,
  LiveElicitationRequest,
  LiveSessionRunState,
  ProviderQuotaTelemetry,
  SessionContextTelemetry,
} from "../../src-shared/session/runtime-state.js";
import type { CharacterProfile } from "../../src-shared/character/character-state.js";
import type { Session } from "../../src-shared/session/session-state.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import { type ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import {
  ProviderTurnError,
  type ProviderCodingAdapter,
  type ProviderTurnAdapter,
  type RunSessionTurnResult,
  type RunSessionTurnProgressHandler,
} from "../../src-electron/providers/provider-runtime.js";
import {
  SessionRuntimeFixture as SessionRuntimeService,
  type SessionRuntimeFixtureDeps as SessionRuntimeServiceDeps,
} from "./session-runtime-fixture.js";
import {
  hasMeaningfulPartialRunResult,
  isRetryableStaleThreadSessionError,
  stopWindowSessionRun,
} from "../../src-electron/session/session-runtime-service.js";
import { SessionWindowBridge } from "../../src-electron/windows/session-window-bridge.js";
import { WindowBroadcastService } from "../../src-electron/windows/window-broadcast-service.js";
import { AppLifecycleService } from "../../src-electron/app/app-lifecycle-service.js";
import { DEFAULT_PROVIDER_CANCEL_GRACE_MS } from "../../src-electron/session/session-run-timeouts.js";
import { MainProviderFacade } from "../../src-electron/app/main-provider-facade.js";
import { ClaudeAdapter } from "../../src-electron/providers/claude/claude-adapter.js";
import { SessionApprovalService } from "../../src-electron/session/session-approval-service.js";
import { SessionElicitationService } from "../../src-electron/session/session-elicitation-service.js";
import type {
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionTurnRecord } from "../../src-shared/session/session-turn-state.js";
import { SessionObservabilityService } from "../../src-electron/session/session-observability-service.js";
import { createMainSessionRuntime } from "../../src-electron/app/main-session-runtime-assembly.js";
import { createAuxiliarySessionRuntime } from "../../src-electron/auxiliary/auxiliary-session-runtime-assembly.js";
import type { SessionRuntimeService as ProductionSessionRuntimeService } from "../../src-electron/session/session-runtime-service.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import { composeProviderPrompt } from "../../src-electron/providers/provider-prompt.js";
import {
  ApprovalReviewInputFence,
  WithMateApprovalReviewTurn,
} from "../../src-electron/session/withmate-approval-review.js";
import type { ApprovalDecisionSource } from "../../src-electron/providers/provider-runtime.js";
import { registerSessionRuntimeHandlers } from "../../src-electron/ipc/session-runtime.js";
import { registerAuxiliaryHandlers } from "../../src-electron/ipc/auxiliary.js";
import type {
  IpcHandleRegistrar,
  MainIpcAuxiliaryDeps,
  MainIpcSessionRuntimeDeps,
} from "../../src-electron/ipc/contracts.js";
import {
  WITHMATE_CANCEL_AUXILIARY_SESSION_RUN_CHANNEL,
  WITHMATE_CANCEL_SESSION_RUN_CHANNEL,
} from "../../src-shared/ipc/withmate-ipc-channels.js";
import { SessionTurnQueueService } from "../../src-electron/session/session-turn-queue-service.js";
import type { SessionInstructionsTarget } from "../../src-shared/session/session-instructions.js";

/** 状態変化を最長100回のイベントループ待機で観測し、到達しなければ指定の理由で失敗させる。 */
async function waitForCondition(
  condition: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

/** テスト用の既定設定から Session を組み立て、ケースで検証したいフィールドだけを上書きする。 */
function createSession(overrides?: Partial<Session>): Session {
  return {
    ...buildNewSession({
      taskTitle: "Runtime Test",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
      model: "gpt-5.4",
      reasoningEffort: "high",
    }),
    ...overrides,
  };
}

const TEST_EXECUTION_OPTIONS = captureSessionExecutionOptions(createSession());

/** Session と一致する ID・テーマを持つ Character を生成し、ロール文をプロンプト合成に供給する。 */
function createCharacter(): CharacterProfile {
  return {
    id: "char-a",
    name: "A",
    iconPath: "",
    roleMarkdown: "落ち着いて伴走する。",
    description: "",
    notesMarkdown: "",
    themeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    updatedAt: new Date().toISOString(),
  };
}

/** 指定したプロバイダー ID と、既定モデルおよび二つの推論深度を持つカタログを構成する。 */
function createProviderCatalog(id = "codex"): ModelCatalogProvider {
  return {
    id,
    label: id,
    defaultModelId: "gpt-5.4",
    defaultReasoningEffort: "high",
    models: [
      { id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["medium", "high"] },
    ],
  };
}

/** Turn 作成依存先に渡す永続化用の入力型。 */
type CreateSessionTurnInput = Parameters<
  SessionRuntimeServiceDeps["createSessionTurn"]
>[0];
/** Turn 更新依存先が受け取る状態差分の型。 */
type UpdateSessionTurnInput = Parameters<
  SessionRuntimeServiceDeps["updateSessionTurn"]
>[1];
/** 終端通知コールバックに渡す Turn 結果の型。 */
type TerminalNotificationInput = Parameters<
  NonNullable<SessionRuntimeServiceDeps["notifySessionTurnTerminal"]>
>[0];

const previousTestProgress = new WeakMap<
  RunSessionTurnProgressHandler,
  LiveSessionRunState
>();
/** ハンドラー別の直前状態を使い、増減したステップ・背景処理の差分付きで進捗を送る。 */
function emitTestProgress(
  handler: RunSessionTurnProgressHandler | undefined,
  state: LiveSessionRunState,
): void | Promise<void> {
  const previous = handler ? previousTestProgress.get(handler) : undefined;
  if (handler) previousTestProgress.set(handler, state);
  return handler?.(state, {
    steps: {
      upserts: state.steps,
      removes:
        previous?.steps
          .filter((step) => !state.steps.some((next) => next.id === step.id))
          .map((step) => step.id) ?? [],
    },
    backgroundTasks: {
      upserts: state.backgroundTasks,
      removes:
        previous?.backgroundTasks
          .filter(
            (task) =>
              !state.backgroundTasks.some((next) => next.id === task.id),
          )
          .map((task) => task.id) ?? [],
    },
  });
}

/** 依存先を組み替えた SessionRuntimeFixture を標準の実行環境として作る。 */
function createTestRuntime(
  deps: SessionRuntimeServiceDeps,
): SessionRuntimeService {
  return new SessionRuntimeService(deps);
}

/** 保存スタブ用の ID を補い、要求されたフィールドは変更しない。 */
function createSessionTurnBase(
  input: CreateSessionTurnInput,
): SessionTurnRecord {
  return {
    id: 1,
    ...input,
  };
}

/** スレッドも表示可能な出力もない部分結果に、ケースごとの観測値を追加する。 */
function createPartialResult(
  overrides?: Partial<RunSessionTurnResult>,
): RunSessionTurnResult {
  return {
    threadId: null,
    assistantText: "",

    usage: null,
    ...overrides,
  };
}

/** 空の進捗を基準に、本文・ステップ・承認要求など指定された観測項目だけを置き換える。 */
function createLiveRunState(
  overrides?: Partial<LiveSessionRunState>,
): LiveSessionRunState {
  return {
    sessionId: overrides?.sessionId ?? "session-1",
    threadId: overrides?.threadId ?? "",
    assistantText: overrides?.assistantText ?? "",
    reasoningText: overrides?.reasoningText ?? "",
    steps: overrides?.steps ?? [],
    backgroundTasks: overrides?.backgroundTasks ?? [],
    usage: overrides?.usage ?? null,
    errorMessage: overrides?.errorMessage ?? "",
    approvalRequest: overrides?.approvalRequest ?? null,
    elicitationRequest: overrides?.elicitationRequest ?? null,
  };
}

/** 保存・ライブ状態をメモリで追跡し、注入されたプロバイダー実行と依存先で進捗経路を動かす。 */
function createProgressRuntime(
  session: Session,
  run: ProviderCodingAdapter["runSessionTurn"],
  overrides: Partial<SessionRuntimeServiceDeps>,
  createRuntime: (
    deps: SessionRuntimeServiceDeps,
  ) => ProductionSessionRuntimeService = createTestRuntime,
): ProductionSessionRuntimeService {
  let stored = session;
  let live: LiveSessionRunState | null = null;
  const adapter: ProviderCodingAdapter = {
    /** 論理プロンプトとシステム・入力本文に対応する固定文字列を返し、添付や追加ディレクトリは渡さない。 */
    composePrompt() {
      return {
        systemBodyText: "system",
        inputBodyText: "input",
        logicalPrompt: {
          systemText: "system",
          inputText: "input",
          composedText: "system\ninput",
        },
        imagePaths: [],
        additionalDirectories: [],
      };
    },
    /** テスト実行では利用枠計測値を取得しない。 */
    async getProviderQuotaTelemetry() {
      return null;
    },
    /** 単一スレッドの無効化で外部プロバイダーに接続しない。 */
    async invalidateSessionThread() {},
    /** 全スレッド無効化を受けても、このアダプターは消去対象の状態を持たない。 */
    async invalidateAllSessionThreads() {},
    runSessionTurn: run,
  };
  return createRuntime({
    /** 直前に保存した Session を返し、後続の読取に同じ保存内容を見せる。 */
    getSession: () => stored,
    /** 最新の Session をメモリに保存し、書き込んだ値を呼び出し元へ戻す。 */
    upsertSession(next) {
      stored = next;
      return next;
    },
    /** 添付のない入力を再現するため、画像候補と検証エラーをともに空にする。 */
    async resolveComposerPreview() {
      return { attachments: [], errors: [] };
    },
    /** 個別設定を上書きしないケースでは正規化済みの既定設定を供給する。 */
    getAppSettings: () => normalizeAppSettings({}),
    /** 既定モデルを含むカタログを、スナップショットと選択プロバイダーの両方として返す。 */
    resolveProviderCatalog: () => ({
      snapshot: { providers: [createProviderCatalog()] },
      provider: createProviderCatalog(),
    }),
    /** この fixture に注入された実行関数を持つアダプターを選ぶ。 */
    getProviderCodingAdapter: () => adapter,
    createSessionTurn: createSessionTurnBase,
    /** 進捗を検証する既定経路では、Turn レコード更新を記録しない。 */
    updateSessionTurn() {},
    /** 更新または消去されたライブ状態を、次の読取で観測できるようにする。 */
    setLiveSessionRun(_id, state) {
      live = state;
    },
    /** 最新のライブ状態を返し、消去後は null を返す。 */
    getLiveSessionRun: () => live,
    /** 承認の応答が必要な場合は、UI を開かず許可として応答する。 */
    waitForApprovalDecision: () => "approve",
    /** 質問を表示せず、既定ではエリシテーションを取り消す。 */
    waitForElicitationResponse: () => ({ action: "cancel" }),
    /** 進捗以外の利用枠投影は、この fixture では保存しない。 */
    setProviderQuotaTelemetry() {},
    /** コンテキスト計測値を扱うケースだけがこの依存先を差し替える。 */ setSessionContextTelemetry() {},
    /** プロバイダースレッド破棄の副作用を既定経路から切り離す。 */
    invalidateProviderSessionThread() {},
    /** 進捗のテストでは利用枠を後から再取得しない。 */ scheduleProviderQuotaTelemetryRefresh() {},
    /** 既定のライブ出力は Window へ配信せず、メモリから確認する。 */
    broadcastLiveSessionRun() {},
    /** 対話を持たない既定経路では承認要求の解決処理を追加しない。 */ resolvePendingApprovalRequest() {},
    /** 既定経路では保留中の質問を保持しない。 */ resolvePendingElicitationRequest() {},
    currentTimestampLabel,
    ...overrides,
  });
}

/** Main と Auxiliary の本番 Cancel IPC を登録し、所有 Window 照合と実ランタイムの停止を通る入口を返す。 */
function createWindowCancelFixture(
  kind: "main" | "auxiliary",
  session: Session,
  runtime: ProductionSessionRuntimeService,
  queue: Pick<SessionTurnQueueService, "stopClaim">,
  options: {
    authorize: () => boolean;
    lookup?: () => Promise<void>;
    onApply: () => void;
  },
) {
  const handlers = new Map<
    string,
    Parameters<IpcHandleRegistrar["handle"]>[1]
  >();
  const ipc: IpcHandleRegistrar = {
    /** 実 IPC を開かず、登録されたチャンネルとハンドラーだけを写し取る。 */ handle:
      (channel, listener) => {
        handlers.set(channel, listener);
      },
  };
  const event = {} as Parameters<
    Parameters<IpcHandleRegistrar["handle"]>[1]
  >[0];
  const window = {} as NonNullable<
    ReturnType<MainIpcAuxiliaryDeps["resolveEventWindow"]>
  >;
  const otherWindow = {} as typeof window;
  /** 停止以外の依存先を誤って呼んだ場合にテストを失敗させる。 */
  const unused = () => {
    throw new Error("Unrelated IPC fixture dependency");
  };
  const windowDeps = {
    /** 認可条件に応じ、呼出元を所有 Window または別 Window として返す。 */ resolveEventWindow:
      () => (options.authorize() ? window : otherWindow),
    /** Main の ID だけを所有 Window に解決し、他 Session の操作を認めない。 */ resolveSessionWindow:
      (id: string) => (id === "main" ? window : null),
  };
  /** IPC が渡した認可検査を保ったまま、元の停止要求を本番の停止処理へ渡す。 */
  const stop = (request: CancelSessionRunRequest, authorize: () => void) =>
    stopWindowSessionRun(request, runtime, queue, authorize, options.onApply);
  if (kind === "main") {
    // 登録処理は無関係なハンドラーも取得するが、それらの依存先は呼び出さない。
    registerSessionRuntimeHandlers(ipc, {
      ...windowDeps,
      cancelSessionRun: stop,
    } as unknown as MainIpcSessionRuntimeDeps);
  } else {
    registerAuxiliaryHandlers(ipc, {
      ...windowDeps,
      /** Auxiliary の ID を照合し、指定された所有者読取ゲートの後に正しい作成時刻と親を返す。 */
      getAuxiliarySession: async (id: string) => {
        assert.equal(id, session.id);
        await options.lookup?.();
        return {
          id,
          parentSessionId: "main",
          createdAt: getSessionIncarnationId(session),
        } as NonNullable<
          Awaited<
            ReturnType<NonNullable<MainIpcAuxiliaryDeps["getAuxiliarySession"]>>
          >
        >;
      },
      listAuxiliarySessions: unused,
      listOpenAuxiliarySessionSummaries: unused,
      getLatestAuxiliarySession: unused,
      createAuxiliarySession: unused,
      updateAuxiliarySession: unused,
      runAuxiliarySessionTurn: unused,
      getAuxiliaryDraft: unused,
      saveAuxiliaryDraft: unused,
      getAuxiliarySessionStatus: unused,
      cancelAuxiliarySessionRun: stop,
    });
  }
  const invoke = handlers.get(
    kind === "main"
      ? WITHMATE_CANCEL_SESSION_RUN_CHANNEL
      : WITHMATE_CANCEL_AUXILIARY_SESSION_RUN_CHANNEL,
  )!;
  return async (request: CancelSessionRunRequest) => invoke(event, request);
}

// @test-value v2
// kind = "contract"
// claim = "Aに対する古いGUI Cancelは、同じSessionで後から開始したBの実行・承認・質問を取り消さない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/975 — 項目4と受入条件" }
// fault = "Main runtimeのSession読取待ち、またはAuxの所有Window照合待ちの後で対象TurnをSession内の最新実行へ付け替える"
// observable = "BのAbortSignal、live Turn IDと取消状態、承認・質問の要求ID、Providerが受け取る個別決定、Bの保存本文と承認reviewの入力fence"
// observation_boundary = "consumer"
// scope = "Main/Aux GUI Cancel IPCから本番Session runtimeとProvider callbackまで"
// lifecycle = "permanent"
// distinction = "runtimeの親子exact stop単体検査ではGUI IPCが操作時の対象を捨てる欠陥を検出できない"
// @end-test-value
/** 古い Cancel IPC が再開しても、同じ Session で後から始まった Turn のシグナル・承認・質問・保存を変更しないことを Main と Auxiliary の双方で確かめる。 */
it("GUI Cancel IPC leaves the next Main and Auxiliary turns and their requests intact", async () => {
  const results: unknown[] = [];
  for (const kind of ["main", "auxiliary"] as const) {
    const session = createSession({
      id: kind,
      incarnationId: `${kind}-incarnation`,
    });
    const { promise: endA, resolve: finishA } = queueGate();
    const { promise: ownerGate, resolve: resumeOwnerCheck } = queueGate();
    let stored = session;
    let pauseMainLookup = false;
    let turnNumber = 0;
    let live: LiveSessionRunState | null = null;
    let bSignal: AbortSignal | undefined;
    /** ライブ状態が存在するときだけ承認や質問からの更新を適用し、消去済み状態を復活させない。 */
    const updateLiveSessionRun = (
      _id: string,
      recipe: (state: LiveSessionRunState) => LiveSessionRunState,
    ) => (live = live ? recipe(live) : null);
    const approvals = new SessionApprovalService({ updateLiveSessionRun });
    const questions = new SessionElicitationService({ updateLiveSessionRun });
    const decisions: unknown[] = [];
    const runtime = createProgressRuntime(
      session,
      async (input) => {
        if (turnNumber === 1) {
          await endA;
          return createPartialResult({ assistantText: "A completed" });
        }
        bSignal = input.signal;
        decisions.push(
          ...(await Promise.all([
            input.onApprovalRequest!({
              requestId: "approval-B",
              provider: "codex",
              kind: "shell",
              title: "Approval",
              summary: "B",
              decisionMode: "direct-decision",
            }),
            input.onElicitationRequest!({
              requestId: "question-B",
              provider: "codex",
              mode: "form",
              message: "B",
              fields: [],
            }),
          ])),
        );
        return createPartialResult({ assistantText: "B completed" });
      },
      {
        /** Main の所有者読取だけを必要に応じて止め、旧 Cancel を保留したまま次の Turn を開始できるようにする。 */
        getSession: async () => {
          if (pauseMainLookup) {
            pauseMainLookup = false;
            await ownerGate;
          }
          return stored;
        },
        /** プロバイダー実行開始・終端で更新された Session を次の読取に反映する。 */
        upsertSession: (next) => (stored = next),
        /** A と B を識別できるよう、開始順に異なる保存 Turn ID を振る。 */
        createSessionTurn: (input) => ({ ...input, id: ++turnNumber }),
        /** Run の発行・消去をメモリで受け、取消前後の要求を比較可能にする。 */
        setLiveSessionRun: (_id, state) => {
          live = state;
        },
        /** 保留中の Cancel が再開した後のライブ状態を取得できるようにする。 */
        getLiveSessionRun: () => live,
        /** 承認を実サービスで待機し、Cancel の誤適用を中断シグナルと応答から検出する。 */
        waitForApprovalDecision: (id, request, signal) =>
          approvals.waitForLiveApprovalDecision(id, request, signal),
        /** 質問を実サービスで待機し、旧 Cancel が次の質問を消していないか確認可能にする。 */
        waitForElicitationResponse: (id, request, signal) =>
          questions.waitForLiveElicitationResponse(id, request, signal),
        /** 対象 Session の承認を実サービス経由で取り消す。 */
        resolvePendingApprovalRequest: (id) => approvals.cancelSession(id),
        /** 対象 Session の質問を実サービス経由で取り消す。 */
        resolvePendingElicitationRequest: (id) => questions.cancelSession(id),
      },
    );
    const fence = new ApprovalReviewInputFence();
    const stop = createWindowCancelFixture(
      kind,
      session,
      runtime,
      {
        /** Turn を対象にした Cancel が誤って受付停止まで到達したら失敗させる。 */ stopClaim:
          async () => assert.fail("Unexpected receipt stop"),
      },
      {
        /** 競合中の Window 自体は権限を失わない条件に固定する。 */
        authorize: () => true,
        /** Auxiliary 経路で所有 Window 確認を保留する。 */ lookup: () =>
          ownerGate,
        /** 停止が実際に適用された場合にレビュー入力を失効させる。 */ onApply:
          () => fence.invalidate(),
      },
    );
    const request = {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "start",
    };
    /** 非同期コールバックで置き換わった最新のライブ状態を取り直す。 */
    const currentLive = (): LiveSessionRunState | null => live;
    const a = runtime.runSessionTurn(session.id, request);
    try {
      await waitForCondition(
        () => currentLive()?.sessionTurnId === "1",
        "A has started",
      );
      const aStop: CancelSessionRunRequest = {
        sessionId: session.id,
        incarnationId: getSessionIncarnationId(session),
        execution: { kind: "turn", id: currentLive()!.sessionTurnId! },
      };
      // Main は対象ランタイムの停止処理による Session の読み取りで待つ。Auxiliary はそれより前に、
      // 登録済み IPC ハンドラーで所有 Window の検索を待つ。
      pauseMainLookup = kind === "main";
      const stale = stop(aStop);
      finishA();
      assert.equal((await a).messages.at(-1)?.text, "A completed");
      const b = runtime.runSessionTurn(session.id, request);
      await waitForCondition(
        () =>
          !!currentLive()?.approvalRequest &&
          !!currentLive()?.elicitationRequest,
        "B awaits both decisions",
      );
      const reviewCurrent = fence.capture();
      resumeOwnerCheck();
      await stale;
      const preserved = [
        bSignal?.aborted,
        currentLive()?.sessionTurnId,
        currentLive()?.cancellationState,
        currentLive()?.approvalRequest?.requestId,
        currentLive()?.elicitationRequest?.requestId,
        reviewCurrent(),
      ];
      if (!bSignal?.aborted) {
        approvals.resolveLiveApproval(session.id, "approval-B", "approve");
        await questions.resolveLiveElicitation(session.id, "question-B", {
          action: "decline",
        });
      }
      const completed = await b;
      results.push({
        kind,
        preserved,
        decisions,
        text: completed.messages.at(-1)?.text,
      });
    } finally {
      finishA();
      resumeOwnerCheck();
      runtime.cancelAllRuns();
      await runtime.waitForPendingRuns();
    }
  }
  assert.deepEqual(
    results,
    ["main", "auxiliary"].map((kind) => ({
      kind,
      preserved: [false, "2", undefined, "approval-B", "question-B", true],
      decisions: ["approve", { action: "decline" }],
      text: "B completed",
    })),
  );
});

// @test-value v2
// kind = "contract"
// claim = "Copilot/OpenCodeの明示Userと既定Off、ネイティブは従来の手動要求を維持し、仲介選択時は適格な実要求だけを設定先へ渡し、経路不成立は公開せず不許可とする"
// oracle = { type = "contract", ref = "docs/design/withmate-auto-review.md#設定と適用範囲" }
// fault = "旧Userを明示Userと誤る、明示Auto ReviewのOff・設定先不成立を手動に落とす、または実際の判断元をProviderへ渡さない"
// observable = "Provider callbackに返った決定とsource、公開・通知、設定先に渡すbinding、審査会話の開閉と元Turn・実引数"
// observation_boundary = "consumer"
// scope = "SessionRuntimeServiceから審査Turnと既存承認キューを経由するProvider callbackの戻り値"
// lifecycle = "permanent"
// risk_tags = ["authorization", "privacy"]
// distinction = "アダプター単体と審査単体では実効設定によるSession runtimeの振り分けを観測しない"
// @end-test-value
/** 手動・共通自動審査の設定をプロバイダー横断で比較し、指定レビューが失敗または未提供でも手動承認へ切り替えないことを確認する。 */
it(
  "routes configured broker reviews without falling back to manual on an unavailable route",
  { timeout: 4000 },
  async () => {
    const selection = {
      providerId: "codex",
      model: "reviewer",
      reasoningEffort: "high",
    } as const;
    const cases = (["copilot", "opencode"] as const).flatMap(
      (provider) =>
        [
          [provider, "legacy", true, true, "pass", "reviewer"],
          [provider, "legacy", false, true, "pass", "manual"],
          [provider, "user", true, true, "pass", "manual"],
          [provider, "auto-review", true, true, "pass", "reviewer"],
          [provider, "auto-review", false, true, "pass", "blocked"],
          [provider, "auto-review", true, false, "pass", "blocked"],
          [provider, "auto-review", true, true, "fail", "blocked"],
          [provider, "auto-review", true, true, "absent", "blocked"],
          [provider, "auto-review", true, true, "throws", "blocked"],
        ] as const,
    );
    for (const [provider, preference, enabled, hasEvidence, route, source] of [
      ...cases,
      ["codex", "legacy", true, true, "pass", "manual"],
      ["claude", "legacy", true, true, "pass", "manual"],
    ] as const) {
      const session = createSession({
        provider,
        approvalMode: "on-request",
        codexReviewer: preference === "legacy" ? "user" : preference,
        withMateReviewerExplicit: preference === "legacy" ? undefined : true,
      });
      const catalog = createProviderCatalog(provider);
      const sources: ApprovalDecisionSource[] = [];
      const decisions: Array<LiveApprovalDecision | undefined> = [];
      const publications: string[] = [];
      const notifications: string[] = [];
      let opened = 0;
      let closed = 0;
      const binding = {
        bindingId: "source",
        bindingReference: "source-reference",
        providerId: provider,
        executionGeneration: "source-generation",
        transport: "env",
        expiresAt: null,
        turnCapability: "source-turn",
        managedMcp: {
          sessionUrl: "http://127.0.0.1/session",
          glossaryUrl: "",
          token: "source-token",
        },
      } as const;
      let live = createLiveRunState({ sessionId: session.id });
      const approvals = new SessionApprovalService({
        /** 承認状態が新規発行された場合だけ要求 ID を記録し、最新のライブ状態に置き換える。 */
        updateLiveSessionRun: (_id, update) => {
          const next = update(live);
          if (
            next.approvalRequest &&
            next.approvalRequest !== live.approvalRequest
          )
            publications.push(next.approvalRequest.requestId);
          return (live = next);
        },
        /** 手動通知の要求 ID を記録し、同じ要求をマイクロタスクで承認する。 */
        notifyApproval: (id, requestId) => {
          notifications.push(requestId);
          queueMicrotask(() =>
            approvals.resolveLiveApproval(id, requestId, "approve"),
          );
        },
      });
      const runtime = createProgressRuntime(
        session,
        async (input) => {
          const request: LiveApprovalRequest = {
            requestId: "request",
            provider,
            kind: "read",
            title: "Operation",
            summary: "Read fixture",
            decisionMode: "direct-decision",
          };
          decisions.push(
            await input.onApprovalRequest?.(
              request,
              undefined,
              hasEvidence
                ? {
                    operation: {
                      file: "fixture.txt",
                      cwd: session.workspacePath,
                    },
                  }
                : undefined,
              (decisionSource) => {
                sources.push(decisionSource);
              },
            ),
          );
          assert.deepEqual(
            sources,
            [source],
            `${provider}/${preference}/${enabled}/${hasEvidence}/${route}`,
          );
          return createPartialResult({ assistantText: "done" });
        },
        {
          /** ケースが有効にしたプロバイダーと、指定時だけ共通レビュー設定を返す。 */
          getAppSettings: () =>
            normalizeAppSettings({
              codingProviderSettings: { [provider]: { enabled: true } },
              withMateAutoReview: enabled ? selection : null,
            }),
          /** ケース対象のプロバイダーを既定でも解決できるカタログとして渡す。 */
          resolveProviderCatalog: () => ({
            snapshot: { providers: [catalog] },
            provider: catalog,
          }),
          /** レビュー開始時に照合する発信元ターンハンドルとバインディングを固定する。 */
          beginProviderAgentRuntimeTurn: () => ({
            handle: "source-handle",
            binding,
          }),
          /** 受け取った設定と発信元を照合し、レビュー経路の未提供・起動例外・実レビューを切り替える。 */
          startWithMateApprovalReview: (args) => {
            assert.equal(args.binding, binding);
            assert.deepEqual(args.selection, selection);
            if (route === "absent") return undefined;
            if (route === "throws")
              throw new Error("Review route failed to initialize");
            return new WithMateApprovalReviewTurn({
              ...args,
              /** レビュー中の設定差替えは発生しない前提にする。 */ policyCurrent:
                () => true,
              inputs: new ApprovalReviewInputFence(),
              source: {
                kind: "main",
                sessionId: session.id,
                incarnationId: getSessionIncarnationId(session),
              },
              /** レビュー通信の開始回数を記録し、指定ケースでは Reviewer 不可を返す。 */
              open: async () => {
                opened++;
                if (route === "fail") throw new Error("Reviewer unavailable");
                return {
                  /** レビュー終了で開いた通信が閉じられた回数を数える。 */ close() {
                    closed++;
                  },
                  /** レビュー入力に対象操作と Turn が含まれ、発信元の資格情報が除かれることを確かめて承認を返す。 */ review:
                    async (prompt) => {
                      const evidence = JSON.parse(prompt);
                      assert.equal(evidence.turnId, "1");
                      assert.equal(
                        evidence.pendingOperation.operation.file,
                        "fixture.txt",
                      );
                      assert.doesNotMatch(
                        prompt,
                        /source-token|source-reference|source-turn/,
                      );
                      return {
                        decision: "allow_once",
                        reason: "Explicitly authorized.",
                      };
                    },
                };
              },
            });
          },
          /** レビュー経路と決定監視を落とさず、実承認サービスの待機処理に渡す。 */
          waitForApprovalDecision: (
            sessionId,
            request,
            signal,
            review,
            observer,
          ) =>
            approvals.waitForLiveApprovalDecision(
              sessionId,
              request,
              signal,
              review,
              observer,
            ),
        },
      );
      const result = await runtime.runSessionTurn(session.id, {
        userMessage: "Read fixture.txt",
        executionOptions: captureSessionExecutionOptions(session),
      });
      assert.equal(result.runState, "idle");
      assert.deepEqual(decisions, [source === "blocked" ? "deny" : "approve"]);
      assert.deepEqual(
        [opened, closed],
        source === "reviewer" ? [1, 1] : route === "fail" ? [1, 0] : [0, 0],
      );
      assert.deepEqual(
        [publications, notifications],
        source === "manual" ? [["request"], ["request"]] : [[], []],
      );
      assert.deepEqual(
        [result.codexReviewer, result.withMateReviewerExplicit],
        [session.codexReviewer, session.withMateReviewerExplicit],
      );
    }
  },
);

// @test-value v2
// kind = "contract"
// claim = "新しいSafety FocusedではProviderから届いた実承認をread/write問わず拒否し、手動UIや審査役を起動しない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#approval-modes" }
// fault = "実承認を許可するかUserまたはAuto Reviewへ流してSafety Focusedを変質させる"
// observable = "Providerの実承認callbackに返るread/writeの判断とsource、会話結果"
// observation_boundary = "consumer"
// scope = "4 Providerの実承認callbackから共通SessionRuntimeServiceへの判断境界（Provider fixture）"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// impact = "承認を拒否する設定で操作が実行されたり、判断待ちで実行が停止したりする"
// distinction = "Adapterごとの設定testでは実承認と手動・審査への分岐を観測できない"
// @end-test-value
/** Safety Focused では共通レビューが設定済みでも、全プロバイダーの実承認要求を UI や Reviewer へ送らず拒否する。 */
it("Safety Focused rejects real approval callbacks without manual or automatic review", async () => {
  for (const provider of ["codex", "claude", "copilot", "opencode"]) {
    const session = createSession({
      provider,
      approvalMode: "safety-focused",
      codexReviewer: "auto-review",
    });
    const catalog = createProviderCatalog(provider);
    const results: Array<LiveApprovalDecision | undefined> = [];
    const sources: ApprovalDecisionSource[] = [];
    const runtime = createProgressRuntime(
      session,
      async (input) => {
        for (const kind of ["read", "write"]) {
          results.push(
            await input.onApprovalRequest?.(
              {
                requestId: kind,
                provider,
                kind,
                title: kind,
                summary: kind,
                decisionMode: "direct-decision",
              },
              undefined,
              { operation: { kind } },
              (source) => {
                sources.push(source);
              },
            ),
          );
        }
        return createPartialResult({ assistantText: "done" });
      },
      {
        /** レビューが抑止されたのは未設定だからではないと確認できるよう、共通 Reviewer の選択を返す。 */
        getAppSettings: () =>
          normalizeAppSettings({
            codingProviderSettings: { [provider]: { enabled: true } },
            withMateAutoReview: {
              providerId: "codex",
              model: "review",
              reasoningEffort: "",
            },
          }),
        /** 承認コールバックを起動する対象プロバイダーのカタログを返す。 */
        resolveProviderCatalog: () => ({
          snapshot: { providers: [catalog] },
          provider: catalog,
        }),
        /** Safety Focused から手動質問が発行された時点で失敗させる。 */
        waitForApprovalDecision: () =>
          assert.fail("Safety Focused must not open manual approval"),
        /** Safety Focused が共通 Reviewer の作成に進んだ時点で失敗させる。 */
        startWithMateApprovalReview: () =>
          assert.fail("Safety Focused must not start review"),
      },
    );
    const result = await runtime.runSessionTurn(session.id, {
      userMessage: "Safety boundary",
      executionOptions: captureSessionExecutionOptions(session),
    });
    assert.deepEqual(results, ["deny", "deny"]);
    assert.deepEqual(sources, ["blocked", "blocked"]);
    assert.equal(result.messages.at(-1)?.text, "done");
  }
});

// @test-value v2
// kind = "contract"
// claim = "指定WithMate Turn停止は同incarnationの現在Turnだけに適用し、Provider Turn IDや後続Turnへ対象を付け替えない"
// oracle = { type = "contract", ref = "GitHub Issue #832: 取消・Turn停止の権限と対象" }
// fault = "Provider IDで停止する、古いTurnの停止が後続Turnを止める、非同期認可中に変化した対象へ停止を適用する"
// observable = "stopSessionTurn outcomeとProvider AbortSignal、Turn完了後の停止結果"
// observation_boundary = "public-boundary"
// scope = "SessionRuntimeService指定Turn停止と非同期認可の競合"
// lifecycle = "permanent"
// distinction = "既存cancelRunはSession単位であり指定WithMate Turnとの一致を検証しない"
// @end-test-value
/** 停止要求の WithMate Turn ID と owner を固定し、古い要求は次の Turn を止めず、正しい要求だけがシグナルを中断することを確かめる。 */
it("指定Turn停止はWithMate identityを固定し後続へ適用しない", async () => {
  const session = createSession();
  const finish: Array<() => void> = [];
  let turnNumber = 0;
  let activeSignal: AbortSignal | undefined;
  const runtime = createProgressRuntime(
    session,
    async (input, progress) => {
      activeSignal = input.signal;
      await emitTestProgress(
        progress,
        createLiveRunState({ sessionId: session.id, turnId: "provider-id" }),
      );
      await new Promise<void>((resolve) => {
        finish.push(resolve);
      });
      return createPartialResult({ assistantText: "saved partial" });
    },
    {
      /** 実行順に一意な WithMate Turn ID を付け、停止対象を名前で特定できるようにする。 */ createSessionTurn:
        (input) => ({ ...input, id: ++turnNumber }),
    },
  );
  const running = runtime.runSessionTurn(session.id, {
    executionOptions: TEST_EXECUTION_OPTIONS,
    userMessage: "start",
  });
  let next: Promise<Session> | undefined;
  try {
    await waitForCondition(() => Boolean(activeSignal), "provider started");
    const owner = getSessionIncarnationId(session);
    assert.equal(
      (await runtime.stopSessionTurn(session.id, owner, "provider-id")).outcome,
      "not-applied",
    );
    assert.equal(
      (await runtime.stopSessionTurn(session.id, "old-incarnation", "1"))
        .outcome,
      "not-applied",
    );
    assert.equal(activeSignal?.aborted, false);
    let authorize!: () => void;
    const authorized = new Promise<void>((resolve) => {
      authorize = resolve;
    });
    const delayed = runtime.stopSessionTurn(
      session.id,
      owner,
      "1",
      () => authorized,
    );
    finish[0]!();
    await running;
    next = runtime.runSessionTurn(session.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "next",
    });
    await waitForCondition(
      () => finish.length === 2,
      "next provider turn started",
    );
    authorize();
    assert.equal((await delayed).outcome, "not-applied");
    assert.equal(activeSignal?.aborted, false);
    assert.equal(
      (await runtime.stopSessionTurn(session.id, owner, "2")).outcome,
      "applied",
    );
    assert.equal(activeSignal?.aborted, true);
  } finally {
    for (const resolve of finish) resolve();
    await running;
    await next;
  }
});

// @test-value v2
// kind = "contract"
// claim = "直接SteerはProvider呼出前にpendingと固定された返信参照を保存し、通常Turnの会話枠を再提示せず、未送信・結果不明・保存ACK喪失を区別する"
// oracle = { type = "contract", ref = "GitHub Issue #832: 新規Steerの送信前記録と未送信・不明結果の区別; docs/design/prompt-composition.md#metadataと必要時取得" }
// fault = "記録前にProviderへ送る、Steerに通常開始用の所属を足す、未送信を不明にする、または不明送信を再送する"
// observable = "adapter呼出時のpendingと返信参照、Provider入力の返信IDと所属欄、配送状態、呼出件数、terminal後の本文と参照"
// observation_boundary = "public-boundary"
// scope = "SessionRuntimeService直接Steerとfixture永続portの故障注入"
// lifecycle = "permanent"
// distinction = "SQLite testはProvider dispatch境界・取消・ACK喪失時のruntime count回復を通らない"
// @end-test-value
/** 直接 Steer の保存・送信境界に障害を注入し、未送信と結果不明を区別しながら追加入力・返信先・途中回答を重複なく保存することを確認する。 */
it("直接Steerは未送信と不明結果を保存しACK喪失でも自動再送しない", async () => {
  for (const mode of [
    "unknown",
    "not-sent",
    "begin-lost",
    "confirm-lost",
  ] as const) {
    let stored = createSession({ threadId: "thread" });
    const reference = {
      target: {
        kind: "main" as const,
        sessionId: stored.id,
        incarnationId: getSessionIncarnationId(stored),
      },
      seq: 0,
    };
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    let entered = false;
    let injected = false;
    let runtime!: ProductionSessionRuntimeService;
    /** ネイティブ Turn が入力を受け付ける進捗を送信し、Steer 経路が完了するまで実行を保持する。 */
    const run: ProviderCodingAdapter["runSessionTurn"] = async (
      input,
      progress,
    ) => {
      await emitTestProgress(progress, {
        ...createLiveRunState({ sessionId: input.session.id }),
        turnId: "native-turn",
        inputAvailable: true,
      });
      entered = true;
      await done;
      return createPartialResult({
        assistantText: "partial retained",
        threadId: "thread",
      });
    };
    const adapter: ProviderCodingAdapter = {
      /** 直接 Steer 以外の入力加工に依存しないよう、固定プロンプトと空の添付一覧を返す。 */
      composePrompt: () => ({
        systemBodyText: "system",
        inputBodyText: "input",
        logicalPrompt: {
          systemText: "system",
          inputText: "input",
          composedText: "system\ninput",
        },
        imagePaths: [],
        additionalDirectories: [],
      }),
      /** Steer の検証では利用枠計測を行わない。 */
      getProviderQuotaTelemetry: async () => null,
      /** 単一スレッド無効化は記録せず、対象を Steer の保存・送信に限る。 */ invalidateSessionThread:
        async () => {},
      /** 全スレッド無効化に必要な外部プロバイダー状態は持たない。 */ invalidateAllSessionThreads:
        async () => {},
      runSessionTurn: run,
      /** 送信前の pending レコードと両 Turn ID、返信先、組み立てた入力を照合し、結果不明ケースでは送信後の例外を発生させる。 */
      steerSessionTurn: async (input) => {
        calls++;
        assert.equal(stored.messages.at(-1)?.turnInput?.state, "pending");
        assert.equal(stored.messages.at(-1)?.turnInput?.turnId, "1");
        assert.equal(
          stored.messages.at(-1)?.turnInput?.nativeTurnId,
          input.expectedTurnId,
        );
        assert.deepEqual(stored.messages.at(-1)?.replyTo, reference);
        assert.match(
          input.userMessage,
          /# Reply To\n\nsessionId: [^\n]+\nincarnationId: [^\n]+\nseq: 0\n\n# User Input\n\nadditional$/,
        );
        assert.doesNotMatch(input.userMessage, /# Conversation Thread/);
        if (mode === "unknown") throw new Error("Provider outcome unknown");
        return { turnId: input.expectedTurnId };
      },
    };
    runtime = createProgressRuntime(stored, run, {
      /** 障害注入後も最新の追加入力を取得できるよう、メモリ上の Session を返す。 */ getSession:
        () => stored,
      /** Steer 送信回数と受信内容を検査するアダプターを選ぶ。 */ getProviderCodingAdapter:
        () => adapter,
      /** 入力を先に保存し、指定した pending または confirmed の応答喪失・停止を一度だけ発生させる。 */
      upsertSession: (next) => {
        stored = next;
        const state = next.messages.at(-1)?.turnInput?.state;
        if (
          !injected &&
          ((state === "pending" &&
            (mode === "not-sent" || mode === "begin-lost")) ||
            (state === "confirmed" && mode === "confirm-lost"))
        ) {
          injected = true;
          if (mode === "not-sent") runtime.cancelRun(stored.id);
          else throw new Error("Input persistence reply lost");
        }
        return next;
      },
    });
    const turn = runtime.runSessionTurn(stored.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "start",
    });
    try {
      await waitForCondition(() => entered, "direct input active turn");
      await assert.rejects(
        runtime.steerSessionTurn(stored.id, {
          expectedTurnId: "native-turn",
          userMessage: "additional",
          replyTo: reference,
        }),
      );
      assert.equal(
        calls,
        mode === "unknown" || mode === "confirm-lost" ? 1 : 0,
      );
      assert.equal(
        stored.messages.at(-1)?.turnInput?.state,
        mode === "unknown"
          ? "unknown"
          : mode === "confirm-lost"
            ? "confirmed"
            : "not-sent",
      );
      finish();
      await turn;
      assert.deepEqual(
        stored.messages.map((message) => message.text),
        ["start", "additional", "partial retained"],
      );
      assert.deepEqual(stored.messages[1]?.replyTo, reference);
    } finally {
      finish();
      await turn;
    }
  }
});

/** テスト用コールバックを使い、所有者ごとの本番ランタイムを組み立てる。 */
function assembleBackgroundEventRuntime(
  kind: "main" | "auxiliary",
  deps: SessionRuntimeServiceDeps,
  parent: Session,
  readSessionInstructions: (
    target: SessionInstructionsTarget,
  ) => Promise<string> = async () => "",
): ProductionSessionRuntimeService {
  const writes = {
    getSession: deps.getSession,
    persistRunningTurnStart:
      deps.persistRunningTurnStart ??
      ((session: Session) => deps.upsertSession(session)),
    appendRunningInput:
      deps.appendRunningInput ??
      ((session: Session) => deps.upsertSession(session)),
    checkpointRuntimeMetadata:
      deps.checkpointRuntimeMetadata ??
      ((session: Session) => deps.upsertSession(session)),
    appendTerminalSession:
      deps.appendTerminalSession ??
      ((session: Session) => deps.upsertSession(session)),
    beginSourceDisplayTurn: deps.beginSourceDisplayTurn,
  };
  const owner = {
    /** この組み立て fixture では admission による取消を追加しない。 */ assertActive() {},
    /** 通常のプロンプト処理を通すため、所有者が有効と報告する。 */ isActive:
      () => true,
  };
  const admission = {
    /** キュー排他を必要としないケースで、受付処理を直接実行する。 */ runSessionAdmissionExclusive:
      async <T>(_id: string, operation: () => T | Promise<T>): Promise<T> =>
        operation(),
  };
  const resolution = {
    /** 受付ターンの Session を置き換えず、入力時の所有者を維持する。 */ resolveRuntimeSessionForTurn:
      (session: Session) => session,
    resolveComposerPreview: deps.resolveComposerPreview,
    resolveProviderCatalog: deps.resolveProviderCatalog,
  };
  const live = {
    setLiveSessionRun: deps.setLiveSessionRun,
    getLiveSessionRun: deps.getLiveSessionRun,
    setProviderQuotaTelemetry: deps.setProviderQuotaTelemetry,
    setSessionContextTelemetry: deps.setSessionContextTelemetry,
    scheduleProviderQuotaTelemetryRefresh:
      deps.scheduleProviderQuotaTelemetryRefresh,
    broadcastLiveSessionRun: deps.broadcastLiveSessionRun,
  };
  const turn = {
    createSessionTurn: deps.createSessionTurn,
    updateSessionTurn: deps.updateSessionTurn,
  };
  if (kind === "main")
    return createMainSessionRuntime({
      owner,
      admission,
      sessions: {
        ...writes,
        /** Character authoring 状態の解除で、観測中の Session を変更しない。 */ clearCharacterAuthoringRuntimeState:
          (session) => session,
      },
      resolution: {
        ...resolution,
        /** 実行用 Session を別プロバイダー設定へ解決し直さない。 */ resolveProviderSession:
          (session) => session,
        /** Main 用の固定ディレクトリを与え、実フォルダーの作成を避ける。 */ resolveSessionFolderPath:
          () => "C:/fixture",
      },
      provider: { getProviderCodingAdapter: deps.getProviderCodingAdapter },
      context: { getAppSettings: deps.getAppSettings, readSessionInstructions },
      turn,
      live,
      interaction: {
        waitForApprovalDecision: deps.waitForApprovalDecision,
        waitForElicitationResponse: deps.waitForElicitationResponse,
        resolvePendingApprovalRequest: deps.resolvePendingApprovalRequest,
        resolvePendingElicitationRequest: deps.resolvePendingElicitationRequest,
        invalidateProviderSessionThread: deps.invalidateProviderSessionThread,
      },
      notification: {
        notifySessionTurnTerminal: deps.notifySessionTurnTerminal,
      },
      timing: {},
    });
  return createAuxiliarySessionRuntime({
    owner,
    admission,
    auxiliary: {
      ...writes,
      /** Auxiliary のランタイム側から共通の Session 読取スタブに委譲する。 */ getRuntimeSession:
        async (id) => deps.getSession(id),
      /** 取得した Session を親と作成時刻のある Auxiliary 形式に変換し、不在はそのまま返す。 */ getSession:
        async (id) => {
          const session = await deps.getSession(id);
          return session
            ? {
                ...session,
                parentSessionId: parent.id,
                status: "active",
                runState: "idle",
                title: session.taskTitle,
                composerDraft: "",
                createdAt: session.updatedAt,
                displayAfterMessageIndex: null,
                closedAt: "",
              }
            : null;
        },
      /** Auxiliary の開始保存を共通の記録スタブに渡し、期待履歴件数を保つ。 */
      persistRunningTurnStart: async (session, count) =>
        writes.persistRunningTurnStart(session, count),
      /** この組み立て経路では対象が Auxiliary であると報告する。 */ isAuxiliarySession:
        async () => true,
    },
    parent: {
      /** 固定した親 ID だけを親 Session として返す。 */ getSession: async (
        id,
      ) => (id === parent.id ? parent : null),
    },
    resolution,
    provider: {
      getProviderCodingAdapter: deps.getProviderCodingAdapter,
      /** プロバイダースレッドのリセットでは外部サービスへ接続しない。 */ resetProviderSessionThread:
        async () => {},
      /** Auxiliary のプロバイダー設定を入力時の Session から変更しない。 */
      resolveProviderSession: (session) => session,
      /** Auxiliary の実行にも固定の Session フォルダーを与える。 */ resolveSessionFolderPath:
        () => "C:/fixture",
      /** 対象 Auxiliary と選択プロバイダーに紐付く、追加操作権限のないバインディングを発行する。 */
      issueRuntimeBinding: async (session, provider) =>
        new AgentRuntimeBindingRegistry().issueOrReuse({
          actorSessionId: session.id,
          providerId: provider.id,
          operationGrants: [],
        }),
    },
    context: { getAppSettings: deps.getAppSettings, readSessionInstructions },
    turn,
    live,
    interaction: {
      waitForApprovalDecision: deps.waitForApprovalDecision,
      waitForElicitationResponse: deps.waitForElicitationResponse,
      /** Auxiliary 停止時の承認解決を拒否として共通の依存先へ渡す。 */
      cancelApprovals: (id) => deps.resolvePendingApprovalRequest(id, "deny"),
      /** Auxiliary 停止時の質問をキャンセルとして共通の依存先へ渡す。 */ cancelElicitations:
        (id) => deps.resolvePendingElicitationRequest(id, { action: "cancel" }),
      /** プロバイダー ID と Session ID を保って無効化を委譲し、完了を待つ。 */
      invalidateProviderSessionThread: async (provider, id) => {
        await deps.invalidateProviderSessionThread(provider, id);
      },
    },
    /** 組み立て上必要な通知依存先を、外部へ配信しない形で提供する。 */
    notification() {},
  });
}

/** アダプターの実行中に書き込んでも取得済みの本文は変わらず、次の Turn は自身の所有者に対応する本文を読み直す。 */
it("snapshots the exact Main or Auxiliary instructions for each new Turn", async () => {
  const parent = createSession({
    id: "instructions-main",
    incarnationId: "main-inc",
  });
  for (const kind of ["main", "auxiliary"] as const) {
    const session =
      kind === "main"
        ? parent
        : createSession({ id: "instructions-aux", incarnationId: "aux-inc" });
    const target: SessionInstructionsTarget =
      kind === "main"
        ? { kind, sessionId: parent.id, incarnationId: "main-inc" }
        : {
            kind,
            sessionId: session.id,
            incarnationId: "aux-inc",
            mainSessionId: parent.id,
            mainIncarnationId: "main-inc",
          };
    const targets: SessionInstructionsTarget[] = [];
    const observed: string[] = [];
    let saved = "固定本文 A 🐈";
    const running = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const runtime = createProgressRuntime(
      session,
      async (input) => {
        observed.push(input.sessionInstructions ?? "");
        if (observed.length === 1) {
          running.resolve();
          await release.promise;
          assert.match(
            composeProviderPrompt(input).systemBodyText,
            /固定本文 A 🐈$/,
          );
        }
        assert.equal(
          input.session.threadId,
          observed.length === 1 ? "" : "unchanged-thread",
        );
        return createPartialResult({
          assistantText: "ok",
          threadId: "unchanged-thread",
        });
      },
      {},
      (deps) =>
        assembleBackgroundEventRuntime(
          kind,
          deps,
          parent,
          async (requested) => {
            targets.push(requested);
            return saved;
          },
        ),
    );
    /** 同一 Session に異なる入力を送り、その都度現在の実行オプションを捕捉する。 */
    const submit = (userMessage: string) =>
      runtime.runSessionTurn(session.id, {
        userMessage,
        executionOptions: captureSessionExecutionOptions(session),
      });
    const active = submit("first");
    await Promise.race([running.promise, active]);
    saved = "固定本文 B";
    release.resolve();
    await active;
    await submit("second");
    saved = "";
    await submit("third");
    assert.deepEqual(targets, [target, target, target]);
    assert.deepEqual(observed, ["固定本文 A 🐈", "固定本文 B", ""]);
  }
});

/** 指定した所有者の受付を、捕捉・承認・配送入力および参照付き添付を含む状態で組み立てる。 */
function queuedReceipt(session: Session): SessionTurnQueueReceipt {
  const receipt: SessionTurnQueueReceipt = {
    sessionId: session.id,
    incarnationId: getSessionIncarnationId(session),
    id: "queue-1",
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
      provider: session.provider,
      workspacePath: session.workspacePath,
      request: {
        clientRequestId: "13d5a026-53b0-4d79-94bc-a63b7733ab10",
        submitSource: "composer",
        userMessage: "captured message",
        executionOptions: captureSessionExecutionOptions(session),
      },
      attachments: [
        {
          id: "captured-file",
          kind: "file",
          source: "text",
          absolutePath: "C:/workspace/captured.txt",
          displayPath: "captured.txt",
          workspaceRelativePath: "captured.txt",
          isOutsideWorkspace: false,
        },
      ],
    },
  };
  receipt.accepted = structuredClone(receipt.captured);
  receipt.dispatched = structuredClone(receipt.captured);
  return receipt;
}

/** 到着順や完了順を手動で制御できる Promise と解決関数の組を作る。 */
function queueGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// @test-value v2
// kind = "contract"
// claim = "同じ世代のMain/Aux Cancelは開始claimから確定Turnまで同じ実行を取り消し、別Window・別世代・別receiptでは実行も審査も変更しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/975 — 項目4と受入条件; docs/design/session-run-lifecycle.md#session-run-cancel" }
// fault = "Turn IDのないclaimを止められない、実行へpromoteした同じreceiptを見失う、または別Windowや別世代の要求を適用する"
// observable = "受付時のstartingとnull Turn ID、所有違反、入力fence、live取消待ち、Providerの呼出し・AbortSignal、receipt/Turnの終端"
// observation_boundary = "public-boundary"
// scope = "Main/Aux本番Cancel IPC・queue claim・runtime admission・Provider実行"
// lifecycle = "permanent"
// distinction = "旧StopのA→B競合とは別に、正当なclaim取消のruntime前・admission・開始保存中・同一receipt確定後と通常Turn取消を、保存境界のgateで検証する"
// @end-test-value
/** Cancel IPC が所有する開始中の受付または現在の Turn だけを各競合段階で停止し、別の対象や所有者の失効後には適用しないことを確かめる。 */
it("GUI Cancel IPC accepts only the owned starting receipt or current Turn", async () => {
  for (const kind of ["main", "auxiliary"] as const)
    for (const phase of [
      "claim",
      "admission",
      "atomic",
      "promoted",
      "running",
    ] as const) {
      const session = createSession({
        id: kind,
        incarnationId: `${kind}-incarnation`,
      });
      const receipt = queuedReceipt(session);
      const { sessionId, incarnationId } = receipt;
      const request: CancelSessionRunRequest = {
        sessionId,
        incarnationId,
        execution: { kind: "receipt", id: receipt.id },
      };
      const dispatch = queueGate();
      const admission = queueGate();
      const atomic = queueGate();
      const lookup = queueGate();
      let waitedForAdmission = false;
      let waitForPromotion = false;
      let authorized = true;
      let revokeAfterFirstCheck = false;
      let live: LiveSessionRunState | null = null;
      let signal: AbortSignal | undefined;
      let phaseSaved: string | undefined;
      let atomicStarts = 0;
      let state = receipt.state;
      /** 受付・終端で変わるライブ状態をその時点で読み取る。 */
      const readLive = () => live;
      const runtime = createProgressRuntime(
        session,
        async (input) => {
          const currentSignal = input.signal;
          assert.ok(currentSignal);
          signal = currentSignal;
          if (!currentSignal.aborted)
            await new Promise<void>((resolve) =>
              currentSignal.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            );
          throw new ProviderTurnError("canceled", createPartialResult(), true);
        },
        {
          /** 受付排他に到達したことを記録し、admission ケースだけ実処理を保留して停止と競合させる。 */
          runSessionAdmissionExclusive: async (_id, operation) => {
            waitedForAdmission = true;
            if (phase === "admission") await admission.promise;
            return operation();
          },
          /** 受付から実行へ進むときのライブ状態をテストメモリへ発行する。 */
          setLiveSessionRun: (_id, value) => {
            live = value;
          },
          getLiveSessionRun: readLive,
          /** 受付開始の競合だけを検証するため、捕捉された添付の実ファイル検査は成功として扱う。 */
          assertCapturedComposerAttachmentsAvailable: async () => {},
          /** 受付 ID を照合して atomic 開始を数え、指定ケースでは確定前に待機させる。 */
          persistQueuedTurnStart: async (next, _, id, turn) => {
            assert.equal(id, receipt.id);
            atomicStarts++;
            if (phase === "atomic") await atomic.promise;
            return { session: next, turn: { ...turn, id: 41 } };
          },
          /** 終端として保存された phase を記録し、保存後の Session を返す。 */
          appendTerminalSession: async (next, terminal) => {
            phaseSaved = terminal.phase;
            return next;
          },
        },
      );
      /** 受付停止との競合に関係ないストレージ操作が実行された場合は失敗させる。 */
      const unused = () => {
        throw new Error("Unrelated queue storage operation");
      };
      const store: SessionTurnQueueStore = {
        /** この fixture が持つ一件を受け付け、同じ受付を即時に claim した結果を返す。 */
        admit: async () => ({ receipt, claimed: receipt }),
        /** 追加受付が続けて配信されないよう、次の claim は不在とする。 */
        claimNext: async () => null,
        /** 同じ受付から Turn が始まったことを照合し、受付を running へ進める。 */
        markStarted: async (_owner, id, start) => {
          assert.equal(id, receipt.id);
          state = "running";
          return { ...receipt, ...start, state };
        },
        /** 停止または完了した受付の結果を記録し、対象 ID が変わらないことを確かめる。 */
        settle: async (_owner, id, outcome) => {
          assert.equal(id, receipt.id);
          state = outcome;
          return { ...receipt, state: outcome };
        },
        getReceipt: unused,
        getReceiptById: unused,
        listActive: unused,
        listReceipts: unused,
        listPendingOwners: unused,
        claimForInput: unused,
        restoreQueuedInput: unused,
        cancelQueued: unused,
        updateQueued: unused,
        reorderQueued: unused,
        recoverInterrupted: unused,
      };
      const queue = new SessionTurnQueueService({
        store,
        /** キューからの実行中判定は、テスト対象のランタイムに委譲する。 */
        isRunInFlight: (id) => runtime.isRunInFlight(id),
        /** 配信を所定の競合点まで遅らせ、実 runtime に受付・開始通知・制御を渡す。 */
        dispatch: async (claimed, onStarted, control) => {
          await dispatch.promise;
          return runtime.runQueuedSessionTurn(claimed, onStarted, control);
        },
      });
      const review = new ApprovalReviewInputFence();
      const reviewCurrent = review.capture();
      const stop = createWindowCancelFixture(kind, session, runtime, queue, {
        /** 所有 Window の認可状態を返し、指定ケースでは最初の確認後に失効させる。 */
        authorize: () => {
          const current = authorized;
          if (revokeAfterFirstCheck) authorized = false;
          return current;
        },
        /** 受付の昇格待ちと重ねるケースだけ所有者読取を止める。 */
        lookup: () => (waitForPromotion ? lookup.promise : Promise.resolve()),
        /** 正しい取消を受理した時点でレビュー入力を失効させる。 */
        onApply: () => review.invalidate(),
      });
      try {
        const accepted = await queue.enqueue(receipt, receipt.captured);
        assert.deepEqual([accepted.state, accepted.turnId], ["starting", null]);
        authorized = false;
        await assert.rejects(
          stop(request),
          /only available from the target Session window/,
        );
        authorized = true;
        await stop({ ...request, incarnationId: "other-generation" });
        await stop({
          ...request,
          execution: { kind: "receipt", id: "other-receipt" },
        });
        assert.equal(reviewCurrent(), true);
        assert.equal(state, "starting");
        if (phase === "claim") {
          const ack = stop(request);
          // 本番の送出枠を解放する前に、所有者の検索を完了させる。
          await new Promise<void>((resolve) => setImmediate(resolve));
          dispatch.resolve();
          await ack;
          assert.equal(waitedForAdmission, false);
        } else {
          waitForPromotion = phase === "promoted" && kind === "auxiliary";
          const pendingStop = waitForPromotion ? stop(request) : undefined;
          dispatch.resolve();
          if (phase === "admission") {
            await waitForCondition(
              () => waitedForAdmission,
              "runtime reached the admission gate",
            );
            assert.equal(readLive()?.sessionTurnId, undefined);
            await stop(request);
            assert.equal(readLive()?.cancellationState, "requested");
            admission.resolve();
          } else if (phase === "atomic") {
            await waitForCondition(
              () => atomicStarts === 1,
              "atomic start has been issued",
            );
            await stop(request);
            assert.equal(readLive()?.cancellationState, "requested");
            atomic.resolve();
          } else {
            await waitForCondition(
              () => Boolean(signal),
              "the same receipt became a persisted Turn and reached Provider",
            );
            if (phase === "running") {
              const running: CancelSessionRunRequest = {
                ...request,
                execution: { kind: "turn", id: "41" },
              };
              authorized = false;
              await assert.rejects(
                stop(running),
                /only available from the target Session window/,
              );
              authorized = true;
              revokeAfterFirstCheck = true;
              await assert.rejects(
                stop(running),
                /only available from the target Session window/,
              );
              revokeAfterFirstCheck = false;
              authorized = true;
              await stop({ ...running, incarnationId: "other-generation" });
              assert.equal(signal?.aborted, false);
              assert.equal(reviewCurrent(), true);
              await stop(running);
            } else {
              lookup.resolve();
              await (pendingStop ?? stop(request));
            }
            assert.equal(signal?.aborted, true);
          }
        }
        await queue.waitForPending();
        assert.equal(state, "canceled", `${kind} ${phase}`);
        assert.equal(
          reviewCurrent(),
          phase === "claim",
          "only an exact runtime stop invalidates review",
        );
        assert.equal(
          atomicStarts,
          phase === "claim" || phase === "admission" ? 0 : 1,
        );
        if (phase === "atomic")
          assert.equal(
            signal,
            undefined,
            "confirmed start must save cancellation without dispatching the Provider",
          );
        assert.equal(phaseSaved, atomicStarts ? "canceled" : undefined);
        assert.equal(runtime.isRunInFlight(sessionId), false);
      } finally {
        dispatch.resolve();
        admission.resolve();
        atomic.resolve();
        lookup.resolve();
        await queue.stopClaim(receipt, receipt.id);
        await queue.close();
        await runtime.waitForPendingRuns();
      }
    }
});

// @test-value v2
// kind = "contract"
// claim = "GUIが選んだ失敗Turnの固定開始入力はruntime dispatchを通って元Session来歴と共にProviderへ届く"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#gui-turn-queue" }
// fault = "receiptに保存したretrySourceをruntimeが落とす、本文をGUI新規指示として分類する"
// observable = "実runtimeからadapterに渡るprovenanceと組み立てたProvider入力"
// observation_boundary = "consumer"
// scope = "SessionRuntimeService.runQueuedSessionTurnの失敗Turn再実行"
// lifecycle = "permanent"
// impact = "Agentが元Session指示をGUIユーザー自身の新規指示と誤解する"
// distinction = "prompt単体testはqueueからruntime経由でretrySourceが渡ることを検証しない"
// @end-test-value
/** GUI 再実行の受付が保持する元 Session と送信来歴を Provider が受け取ることを確認する。 */
it("queue runtimeはGUI再実行と元Session来歴をProviderへ渡す", async () => {
  const session = createSession();
  const receipt = queuedReceipt(session);
  const target = {
    targetSessionId: session.id,
    targetIncarnationId: getSessionIncarnationId(session),
  };
  const gui = { kind: "gui" as const, operation: "send" as const, ...target };
  const origin = {
    kind: "session" as const,
    operation: "send" as const,
    actorKind: "main" as const,
    actorSessionId: "parent",
    actorIncarnationId: "parent-inc",
    actorTurnId: "12",
    ...target,
    actorSnapshot: {
      sessionTitle: "Source",
      character: { id: "sender", name: "Sender", iconPath: "" },
    },
  };
  receipt.dispatched!.origin = gui;
  receipt.dispatched!.retrySource = {
    receiptId: "old-receipt",
    turnId: "41",
    origin,
    changedSinceAcceptance: true,
  };
  receipt.accepted = structuredClone(receipt.dispatched);
  const runtime = createProgressRuntime(
    session,
    async (input) => {
      assert.deepEqual(input.inputProvenance?.origin, gui);
      assert.deepEqual(
        input.inputProvenance?.retrySource,
        receipt.dispatched!.retrySource,
      );
      const prompt = composeProviderPrompt(input).inputBodyText;
      assert.match(prompt, /Retry requested by: GUI user/);
      assert.match(prompt, /Original sender: Session/);
      assert.match(prompt, /# Retried Session Input\n\ncaptured message/);
      return createPartialResult({ assistantText: "done" });
    },
    {
      /** GUI 再実行の来歴検証では、捕捉添付が利用可能である前提で開始を通す。 */ assertCapturedComposerAttachmentsAvailable:
        async () => {},
      /** 開始保存で履歴件数を一つ進め、固定の保存 Turn ID を割り当てる。 */
      persistQueuedTurnStart: async (next, count, _queueId, turn) => ({
        session: { ...next, messageCount: count + 1 },
        turn: { ...turn, id: 42 },
      }),
      /** 終端保存の戻り値を変えず、再実行の完了に余分な履歴を加えない。 */
      appendTerminalSession: async (next) => next,
    },
  );
  assert.deepEqual(
    await runtime.runQueuedSessionTurn(receipt, async () => {}),
    { state: "completed" },
  );
});

// @test-value v2
// kind = "contract"
// claim = "queue runtimeは予定入力でなくclaim固定本文と添付を実行し、受付時originと原文変更有無を実Provider compositionへ渡す"
// oracle = { type = "contract", ref = "GitHub Issue #832: claim時固定入力; GitHub Issue #837: Provider入力の実送信元" }
// fault = "captured本文を実行へ流す、固定添付を予定添付へ差し替える、originや原文変更値をadapter呼出で落とす"
// observable = "開始保存user本文、Provider RunSessionTurnInput本文/添付/provenance、共通compose結果と元receiptの不変値"
// observation_boundary = "public-boundary"
// scope = "SessionRuntimeService.runQueuedSessionTurnからProviderCodingAdapterまで"
// lifecycle = "permanent"
// distinction = "prompt単体testとstorage claim testの間にあるruntime入力配線を確認する"
// @end-test-value
/** 配送用の固定入力と実際の送信元だけを Provider に渡し、監査用に保存された受付原文を上書きしないことを確認する。 */
it("queue runtimeは固定入力と実送信元をProviderへ渡し受付原文を変更しない", async () => {
  const session = createSession();
  const receipt = queuedReceipt(session);
  receipt.dispatched!.request.userMessage = "fixed instruction";
  receipt.dispatched!.attachments = [];
  receipt.dispatched!.origin = {
    kind: "session",
    actorKind: "main",
    actorSessionId: "parent",
    actorIncarnationId: "parent-incarnation",
    actorTurnId: "12",
    operation: "send",
    targetSessionId: session.id,
    targetIncarnationId: getSessionIncarnationId(session),
  };
  const original = structuredClone(receipt);
  let calls = 0;
  const runtime = createProgressRuntime(
    session,
    async (input) => {
      calls++;
      assert.equal(input.userMessage, "fixed instruction");
      assert.deepEqual(input.attachments, []);
      assert.deepEqual(
        input.inputProvenance?.origin,
        receipt.dispatched!.origin,
      );
      assert.equal(input.inputProvenance?.originalChanged, true);
      const prompt = composeProviderPrompt(input);
      assert.match(
        prompt.inputBodyText,
        /# Session Input\n\nfixed instruction/,
      );
      assert.doesNotMatch(prompt.inputBodyText, /# User Input/);
      return createPartialResult({ assistantText: "done" });
    },
    {
      /** 添付の有無を捕捉時の古い一覧から決め直さず、配送用の空一覧を検証する。 */ assertCapturedComposerAttachmentsAvailable:
        async (_session, attachments) => {
          assert.deepEqual(attachments, []);
        },
      /** 固定指示が利用者本文として保存されることを確認した上で開始 ID と履歴件数を返す。 */
      persistQueuedTurnStart: async (next, count, _queueId, turn) => {
        assert.equal(next.messages.at(-1)?.text, "fixed instruction");
        return {
          session: { ...next, messageCount: count + 1 },
          turn: { ...turn, id: 41 },
        };
      },
      /** 終端に達した Session をそのまま返し、受け付けた指示を改変しない。 */ appendTerminalSession:
        async (next) => next,
    },
  );
  assert.deepEqual(
    await runtime.runQueuedSessionTurn(receipt, async () => {}),
    { state: "completed" },
  );
  assert.equal(calls, 1);
  assert.deepEqual(receipt, original);
});

// @test-value v2
// kind = "contract"
// claim = "runtimeの取消・reset・turn終端はProviderが発行した全承認callbackをdenyで完了し後続を公開しない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#sessionapprovalservice" }
// fault = "runtime cleanupが先頭だけを解決してProvider callbackを残すか終了時に後続を通知する"
// observable = "Provider callback全件のdecision、通知要求列、turn完了とlive承認解除"
// observation_boundary = "consumer"
// scope = "SessionRuntimeServiceからSessionApprovalServiceへの全件取消接続"
// lifecycle = "permanent"
// impact = "取消受付後もturnが承認を待ち続けるか終了後の要求が操作可能になる"
// distinction = "queue単体では保証しないrun lifecycleのcleanup呼出しを実行する"
// @end-test-value
/** 取消・リセット・終端の各経路で承認コールバックを解決し、非表示の二件目を UI に発行しないことを確認する。 */
it("runtimeは取消・reset・終端で全approval callbackを回収する", async () => {
  for (const action of ["cancel", "reset", "terminal"] as const) {
    const session = createSession();
    let live: LiveSessionRunState | null = null;
    const notifications: string[] = [];
    const approvals = new SessionApprovalService({
      /** 既存のライブ状態だけを書き換え、削除後の状態を復元しない。 */
      updateLiveSessionRun: (_id, recipe) =>
        live ? (live = recipe(live)) : null,
      /** 画面へ発行された承認の要求 ID を数え、保留中の二件目の発行を検出する。 */
      notifyApproval: (_id, requestId) => {
        notifications.push(requestId);
      },
    });
    const ready = queueGate();
    let callbacks: Array<Promise<LiveApprovalDecision>> = [];
    const runtime = createProgressRuntime(
      session,
      async (input) => {
        callbacks = ["first", "second", "third"].map((requestId) =>
          Promise.resolve(
            input.onApprovalRequest!({
              requestId,
              provider: "codex",
              kind: "tool",
              title: "Permission",
              summary: requestId,
              decisionMode: "direct-decision",
            }),
          ),
        );
        ready.resolve();
        if (action !== "terminal") await Promise.all(callbacks);
        return createPartialResult({
          threadId: "thread-1",
          assistantText: "done",
        });
      },
      {
        /** 承認の待機または実行終端によるライブ状態の変化を保存する。 */
        setLiveSessionRun: (_id, state) => {
          live = state;
        },
        /** 承認後に UI に残っている要求がないことを確かめるため、現在のライブ状態を返す。 */
        getLiveSessionRun: () => live,
        /** 承認コールバックを本番の承認待機に渡し、取消・リセット・終端で実際に解決されるようにする。 */
        waitForApprovalDecision: (id, request, signal) =>
          approvals.waitForLiveApprovalDecision(id, request, signal),
        /** 承認をまとめて解決する依存先を本番の Session 単位取消へ接続する。 */
        resolvePendingApprovalRequest: (id) => approvals.cancelSession(id),
      },
    );
    const completed = runtime.runSessionTurn(session.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "test",
    });
    await ready.promise;
    if (action === "cancel") runtime.cancelRun(session.id);
    else if (action === "reset") runtime.reset();
    await completed;
    assert.deepEqual(await Promise.all(callbacks), ["deny", "deny", "deny"]);
    assert.deepEqual(notifications, ["first"]);
    assert.equal(
      (live as LiveSessionRunState | null)?.approvalRequest ?? null,
      null,
    );
    assert.throws(
      () => approvals.resolveLiveApproval(session.id, "first", "approve"),
      /no longer exists/,
    );
  }
});

// @test-value v2
// kind = "contract"
// claim = "承認は受信時の本文位置を保持し、後続progress・重複要求・FIFOの先頭交代で挿入位置を取り直さない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#approval-requests" }
// fault = "表示時の本文長で位置を上書きし、待機中または重複した承認が後続本文の末尾へ移動する"
// observable = "実runtimeから承認serviceを通って取得したlive snapshotのrequest IDとtextPosition、および各callbackのdecision"
// observation_boundary = "consumer"
// scope = "SessionRuntimeServiceの承認受信とSessionApprovalServiceのFIFO保持"
// lifecycle = "permanent"
// impact = "承認操作と発生時の説明の対応を利用者が読み違える"
// distinction = "描画testの手製位置では受信時の捕捉を保証できず、既存FIFO testは本文更新を扱わない。2要求の固定列で確認する"
// @end-test-value
/** 次の承認を FIFO で発行するときも、本文内の挿入位置を要求到着時の値で保持することを確認する。 */
it("承認の本文位置を受信時に固定してFIFOの交代まで保持する", async () => {
  const session = createSession();
  const owner = new SessionObservabilityService({
    /** 本文位置の検証は実観測サービスの読取に限り、Window へライブ変更を配信しない。 */ onLiveSessionRunChanged() {},
    /** 利用枠の変更通知を外部に配送しない。 */ onProviderQuotaTelemetryChanged() {},
    /** コンテキスト計測通知を配信せず、承認の本文位置だけを観測する。 */ onSessionContextTelemetryChanged() {},
  });
  const approvals = new SessionApprovalService({
    /** 承認サービスのライブ変更を、本文位置を計算する実観測サービスに渡す。 */ updateLiveSessionRun:
      (id, recipe) => owner.updateLiveSessionRun(id, recipe),
  });
  const before = "最初の操作の説明";
  const queuedAt = `${before}\n\n次の操作の説明`;
  const continued = `${queuedAt}\n\n後続本文`;
  /** 本文を段階的に伸ばしながら二件の承認を発行し、表示位置と切替順を実観測サービスで検証する。 */
  const runtime = createProgressRuntime(
    session,
    async (input, progress) => {
      assert.ok(progress);
      assert.ok(input.onApprovalRequest);
      /** 指定した応答本文を、ステップや背景処理の変更を伴わない進捗として発行する。 */
      const publish = (assistantText: string) =>
        progress(createLiveRunState({ sessionId: session.id, assistantText }), {
          steps: { upserts: [], removes: [] },
          backgroundTasks: { upserts: [], removes: [] },
        });
      /** 本文内の位置を比較するため、異なる要求 ID を持つ直接決定用の承認を組み立てる。 */
      const request = (requestId: string): LiveApprovalRequest => ({
        requestId,
        provider: "codex",
        kind: "tool",
        title: "Permission",
        summary: requestId,
        decisionMode: "direct-decision",
      });
      await publish(before);
      const first = input.onApprovalRequest(request("first"));
      await publish(queuedAt);
      const second = input.onApprovalRequest(request("second"));
      await publish(continued);
      const duplicate = input.onApprovalRequest(request("first"));
      assert.equal(
        owner.getLiveSessionRun(session.id)?.approvalRequest?.textPosition,
        before.length,
      );
      approvals.resolveLiveApproval(session.id, "first", "approve");
      const next = owner.getLiveSessionRun(session.id)?.approvalRequest;
      assert.equal(next?.requestId, "second");
      assert.equal(next?.textPosition, queuedAt.length);
      approvals.resolveLiveApproval(session.id, "second", "deny");
      assert.deepEqual(await Promise.all([first, second, duplicate]), [
        "approve",
        "deny",
        "approve",
      ]);
      assert.equal(owner.getLiveSessionRun(session.id)?.approvalRequest, null);
      return createPartialResult({ assistantText: continued });
    },
    {
      /** 進捗を本番の観測サービスへ保存し、承認要求の本文位置計算に使う。 */
      setLiveSessionRun: (id, state) => owner.setLiveSessionRun(id, state),
      /** 承認の発行位置とキュー切替後の要求を同じ観測サービスから読み取る。 */
      getLiveSessionRun: (id) => owner.getLiveSessionRun(id),
      /** 実承認キューへ要求と中断シグナルを渡し、FIFO の解決順を保つ。 */
      waitForApprovalDecision: (id, request, signal) =>
        approvals.waitForLiveApprovalDecision(id, request, signal),
      /** 実行停止時に対象 Session の承認キューを実サービスから消去する。 */
      resolvePendingApprovalRequest: (id) => approvals.cancelSession(id),
    },
  );
  const result = await runtime.runSessionTurn(session.id, {
    executionOptions: TEST_EXECUTION_OPTIONS,
    userMessage: "test",
  });
  assert.equal(result.runState, "idle");
  assert.equal(result.messages.at(-1)?.text, continued);
});

// @test-value v2
// kind = "contract"
// claim = "Codex・Claude・OpenCodeの正常・失敗turn終端で3秒後のquota更新を依頼し、Copilotの既存周期を維持する"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md" }
// fault = "対象providerの終端で更新予約が欠けるかCopilotの予約周期を置き換える"
// observable = "provider実行後にMainへ渡されるprovider IDとdelay配列"
// observation_boundary = "consumer"
// scope = "session runtime terminal quota refresh"
// lifecycle = "permanent"
// impact = "turnで消費した後の残量更新が周期取得まで遅れる"
// distinction = "cache単体testはturn終端を通らず、この少数のfake turnでruntime接続を検査する"
// @end-test-value
/** プロバイダーごとに、成功・失敗のどちらの終端でも所定間隔の利用枠再取得が一度だけ予約されることを確認する。 */
it("turn終端でprovider別のquota更新を予約する", async () => {
  for (const provider of ["codex", "claude", "opencode", "copilot"]) {
    for (const fails of [false, true]) {
      const session = createSession({ provider, approvalMode: "on-request" });
      const calls: Array<[string, number[]]> = [];
      const catalog = createProviderCatalog(provider);
      const runtime = createProgressRuntime(
        session,
        async () => {
          if (fails)
            throw new ProviderTurnError(
              "failed",
              createPartialResult(),
              false,
              "auth",
            );
          return createPartialResult({ assistantText: "done" });
        },
        {
          /** 対象プロバイダーを有効にし、利用枠予約の分岐を実行できるようにする。 */
          getAppSettings: () =>
            normalizeAppSettings({
              codingProviderSettings: { [provider]: { enabled: true } },
            }),
          /** 現在のプロバイダーとモデルを解決するテストカタログを返す。 */
          resolveProviderCatalog: () => ({
            snapshot: { providers: [catalog] },
            provider: catalog,
          }),
          /** 予約されたプロバイダー ID と遅延一覧を後から比較できるように記録する。 */
          scheduleProviderQuotaTelemetryRefresh: (id, delays) => {
            calls.push([id, delays]);
          },
        },
      );
      const result = await runtime.runSessionTurn(session.id, {
        userMessage: "run",
        executionOptions: captureSessionExecutionOptions(session),
      });
      assert.equal(result.runState, fails ? "error" : "idle");
      assert.deepEqual(calls, [
        [provider, provider === "copilot" ? [0, 3000, 10000] : [3000]],
      ]);
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "runtimeはsnapshotなしprogressの追加・同ID更新・削除を順序付き完全状態へ統合し、無変更controlで本文・usage・pending要求と操作を保持しsnapshot取得へ返す"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Streaming Policy / Codex projection owner" }
// fault = "空の配送stateで既存操作を消す、更新を末尾へ移動する、removeを無視する、またはpending要求を上書きする"
// observable = "runtime callback後の実SessionObservabilityService snapshotのID順・Details・本文/usage・approval/elicitation・inputAvailable"
// observation_boundary = "consumer"
// scope = "SessionRuntimeService incremental progress to Main complete snapshot owner"
// lifecycle = "permanent"
// impact = "再接続したWindowで取得済みDetailsが消えるか制御待ちを誤認する"
// distinction = "projection testはMain consumerを通らず、snapshot付きprovider testは変更配送からの再構築を検査しない。固定更新列のみでCI負担を抑える"
// @end-test-value
/** 差分の更新・削除を Main の完全なステップ一覧へ統合し、制御だけの更新では既存の投影を失わないことを確認する。 */
it("変更progressをMainの完全snapshotへ統合しcontrolでも保持する", async () => {
  const session = createSession();
  const owner = new SessionObservabilityService({
    /** Main のライブ状態を直接読むため、Window 向けの通知を送らない。 */ onLiveSessionRunChanged() {},
    /** 差分統合の fixture では利用枠変更を購読しない。 */ onProviderQuotaTelemetryChanged() {},
    /** コンテキスト計測変更を配信せず、進捗の内容のみを検証する。 */ onSessionContextTelemetryChanged() {},
  });
  /** 同じ ID へ別の詳細を適用できる、完了済みコマンドのステップを組み立てる。 */
  const step = (
    id: string,
    details = id,
  ): LiveSessionRunState["steps"][number] => ({
    id,
    type: "command",
    status: "completed",
    summary: id,
    details,
  });
  /** 差分フレームの追加・更新・削除を順次流し、実観測サービスの保存内容を取得する。 */
  const runtime = createProgressRuntime(
    session,
    async (_input, progress) => {
      assert.ok(progress);
      const frame = {
        ...createLiveRunState({
          sessionId: session.id,
          threadId: "thread",
          assistantText: "assistant",
          reasoningText: "reasoning",
          usage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 2 },
        }),
        inputAvailable: false,
      };
      /** 既存ステップを全置換しない差分フレームとして、指定された更新と削除を配信する。 */
      const publish = (
        upserts: LiveSessionRunState["steps"],
        removes: string[] = [],
      ) =>
        progress(frame, {
          snapshot: false,
          steps: { upserts, removes },
          backgroundTasks: { upserts: [], removes: [] },
        });
      await publish([step("one"), step("two")]);
      assert.deepEqual(
        owner.getLiveSessionRun(session.id)?.steps.map((item) => item.id),
        ["one", "two"],
      );
      await publish([step("one", "corrected"), step("three")]);
      assert.deepEqual(
        owner
          .getLiveSessionRun(session.id)
          ?.steps.map((item) => [item.id, item.details]),
        [
          ["one", "corrected"],
          ["two", "two"],
          ["three", "three"],
        ],
      );
      await publish([step("four")], ["two"]);
      const current = owner.getLiveSessionRun(session.id)!;
      const approvalRequest: LiveApprovalRequest = {
        requestId: "approval",
        provider: "codex",
        kind: "command",
        title: "Approve",
        summary: "command",
        decisionMode: "direct-decision",
      };
      const elicitationRequest: LiveElicitationRequest = {
        requestId: "question",
        provider: "codex",
        mode: "form",
        message: "answer",
        fields: [],
      };
      owner.setLiveSessionRun(session.id, {
        ...current,
        approvalRequest,
        elicitationRequest,
      });
      await publish([]);
      const snapshot = owner.getLiveSessionRun(session.id)!;
      assert.equal(snapshot.steps, current.steps);
      assert.deepEqual(
        snapshot.steps.map((item) => item.id),
        ["one", "three", "four"],
      );
      assert.equal(snapshot.approvalRequest, approvalRequest);
      assert.equal(snapshot.elicitationRequest, elicitationRequest);
      assert.equal(snapshot.assistantText, "assistant");
      assert.equal(snapshot.reasoningText, "reasoning");
      assert.deepEqual(snapshot.usage, frame.usage);
      assert.equal(snapshot.inputAvailable, false);
      // スナップショットを返すプロバイダーでは、明示的な空のスナップショットも含め、引き続きコレクション全体が置き換わる。
      await progress(
        { ...frame, steps: [step("snapshot")] },
        {
          steps: { upserts: [], removes: [] },
          backgroundTasks: { upserts: [], removes: [] },
        },
      );
      assert.deepEqual(
        owner.getLiveSessionRun(session.id)?.steps.map((item) => item.id),
        ["snapshot"],
      );
      await progress(frame, {
        steps: { upserts: [], removes: [] },
        backgroundTasks: { upserts: [], removes: [] },
      });
      assert.deepEqual(owner.getLiveSessionRun(session.id)?.steps, []);
      return createPartialResult({
        assistantText: "final",
        threadId: "thread",
      });
    },
    {
      /** 差分から得た完全なライブ状態を Main の実観測サービスへ格納する。 */ setLiveSessionRun:
        (id, state) => owner.setLiveSessionRun(id, state),
      /** サーバー側で合成された完全なライブ状態を読み取る。 */ getLiveSessionRun:
        (id) => owner.getLiveSessionRun(id),
    },
  );
  try {
    const completed = await runtime.runSessionTurn(session.id, {
      userMessage: "start",
      executionOptions: TEST_EXECUTION_OPTIONS,
    });
    assert.equal(completed.runState, "idle");
    assert.equal(completed.messages.at(-1)?.text, "final");
  } finally {
    owner.dispose();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "runtimeは現在Turnに固定設定を渡し、失敗後も次queued Turnには新しい捕捉値を適用する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md: 次送信用設定と現在Turnのcapture分離" }
// fault = "現在Turnの設定と次queued Turnで既に捕捉した新設定を取り違える"
// observable = "失敗Turn/次queued Turnの状態、Providerへの設定/追加directory、runtime認可の設定"
// observation_boundary = "public-boundary"
// scope = "session runtime current capture and next queued execution"
// lifecycle = "permanent"
// impact = "実行中Turnの権限を無断で広げるか次依頼が利用者の選択を使わない"
// distinction = "単一Turnのadapter/testでは実行中の設定変更と失敗保存後の次queue入力が交差しない"
// @end-test-value
/** 実行中に変更した次回の設定と追加ディレクトリが旧 Turn の失敗保存で戻らず、次のキューへ渡ることを確認する。 */
it("実行中の次設定とdirs変更は現在Turnの失敗後も次queueへ適用する", async () => {
  const session = createSession({
    provider: "copilot",
    threadId: "stale-thread",
    approvalMode: "on-request",
    allowedAdditionalDirectories: ["C:/current-context"],
  });
  let current = session;
  const oldOptions = captureSessionExecutionOptions(session);
  const runtimeOptions: unknown[] = [];
  let attempts = 0;
  const runtime = createProgressRuntime(
    session,
    async (input) => {
      attempts += 1;
      if (attempts === 1) {
        assert.deepEqual(input.executionOptions, oldOptions);
        assert.deepEqual(input.session.allowedAdditionalDirectories, [
          "C:/current-context",
        ]);
      } else {
        assert.equal(input.executionOptions.approvalMode, "never");
        assert.equal(input.executionOptions.customAgentName, "next-agent");
        assert.deepEqual(input.session.allowedAdditionalDirectories, [
          "C:/next-context",
        ]);
      }
      if (attempts === 1) {
        current = {
          ...current,
          approvalMode: "never",
          customAgentName: "next-agent",
          allowedAdditionalDirectories: ["C:/next-context"],
        };
        throw new ProviderTurnError(
          "thread not found",
          createPartialResult({ threadId: "stale-thread" }),
          false,
        );
      }
      return createPartialResult({
        threadId: "fresh-thread",
        assistantText: "done",
      });
    },
    {
      /** ケース内から差し替えた最新の設定と追加ディレクトリを読み出す。 */
      getSession: () => current,
      /** 各 Turn が開始時に捕捉した実行オプションを記録する。 */
      beginProviderAgentRuntimeTurn: ({ executionOptions }) => {
        runtimeOptions.push(executionOptions);
        return undefined;
      },
      /** 通常保存で実行履歴を更新しても、最新の実行設定と追加ディレクトリを維持する。 */
      upsertSession: (next) => {
        current = {
          ...next,
          ...captureSessionExecutionOptions(current),
          allowedAdditionalDirectories: [
            ...current.allowedAdditionalDirectories,
          ],
        };
        return current;
      },
      /** 設定から Copilot を利用可能として返し、次のキューを実行できるようにする。 */
      getAppSettings: () =>
        normalizeAppSettings({
          codingProviderSettings: { copilot: { enabled: true } },
        }),
      /** 旧 Turn と次回の実行に共通の Copilot カタログを用意する。 */
      resolveProviderCatalog: () => ({
        snapshot: { providers: [createProviderCatalog("copilot")] },
        provider: createProviderCatalog("copilot"),
      }),
      /** スレッド無効化では、観測対象の実行設定や追加ディレクトリを書き換えない。 */
      resetProviderSessionThread: () => undefined,
      /** 添付の有効性は失敗条件に含めず、次のキューを開始できるようにする。 */
      assertCapturedComposerAttachmentsAvailable: async () => undefined,
      /** 受付から始まった保存 Turn に ID とユーザーメッセージの位置を補う。 */
      persistQueuedTurnStart: (next, count, _id, turn) => ({
        session: next,
        turn: { ...turn, id: 42, userMessageSeq: count },
      }),
      /** 終端履歴を保存しつつ、旧 Turn の捕捉値で次回設定や追加ディレクトリを戻さない。 */
      appendTerminalSession: (next) => {
        current = {
          ...next,
          ...captureSessionExecutionOptions(current),
          allowedAdditionalDirectories: [
            ...current.allowedAdditionalDirectories,
          ],
        };
        return current;
      },
    },
  );
  await runtime.runSessionTurn(session.id, {
    userMessage: "current",
    executionOptions: oldOptions,
  });
  assert.equal(current.runState, "error");
  assert.deepEqual(
    await runtime.runQueuedSessionTurn(
      queuedReceipt(current),
      async () => undefined,
    ),
    { state: "completed" },
  );
  assert.equal(attempts, 2);
  assert.deepEqual(runtimeOptions, [
    oldOptions,
    captureSessionExecutionOptions(current),
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "queued実行は保存済みTurn・入力seqとprovider native IDを区別し、MainのProviderに正本の入力seqと最終回答目印を渡す。明示返信の参照は開始保存とProviderへ同じ値を渡す"
// oracle = { type = "contract", ref = "docs/design/prompt-composition.md#通常sessionの入力; docs/design/desktop-ui.md: Main／Auxiliaryの通常応答はrequest／turnの表示identityを保つ" }
// fault = "保存Turn/receiptの対応をlive stateで失う、Providerに渡す開始入力seqや最終回答目印を取り違える、または保存・実行の一方で返信参照を失う"
// observable = "開始通知のTurn ID、Provider境界のmessageIdentity（Mainのみ）、Main/Auxiliaryのlive state、開始保存とProviderのreplyTo"
// observation_boundary = "public-boundary"
// scope = "SessionRuntimeServiceのqueued開始とprovider進捗合流"
// lifecycle = "permanent"
// impact = "実行中の本文・質問・承認を受付済み要求へ対応付けられず、native IDを使うsteerが失敗する"
// distinction = "renderer fixtureや型検査はruntimeが保存IDとprovider IDを別々に配信することを検証しない"
// @end-test-value
/** Main・Auxiliary のキューが起動した後、追加入力可否の投影に保存 ID とプロバイダー固有 ID を別々に保持することを確認する。 */
it("queued runtimeは保存turn IDとnative turn IDをlive stateで区別する", async () => {
  for (const auxiliary of [false, true]) {
    const session = createSession({ incarnationId: "owner" });
    const reference = auxiliary
      ? undefined
      : {
          target: {
            kind: "main" as const,
            sessionId: "referenced",
            incarnationId: "reference-v1",
          },
          seq: 7,
          finalAnswerTurnId: "38",
        };
    let live: LiveSessionRunState | null = null;
    const states: LiveSessionRunState[] = [];
    const starts: string[] = [];
    const runtime = createProgressRuntime(
      session,
      async (input, progress) => {
        assert.deepEqual(
          input.messageIdentity,
          auxiliary
            ? undefined
            : {
                sessionId: session.id,
                incarnationId: "owner",
                seq: 0,
                finalAnswerTurnId: "41",
              },
        );
        assert.deepEqual(input.replyTo, reference);
        for (const assistantText of ["partial", "partial updated"]) {
          await emitTestProgress(progress, {
            ...createLiveRunState({
              sessionId: input.session.id,
              assistantText,
            }),
            sessionTurnId: "provider-value",
            turnId: "native-turn",
            inputAvailable: true,
          });
        }
        return createPartialResult({ assistantText: "partial updated" });
      },
      {
        /** 同じ検証を Main と Auxiliary のそれぞれの所有者種別で実行できるようにする。 */
        isAuxiliarySession: () => auxiliary,
        /** この ID 検証では添付の利用可能性を常に認め、実ファイルを読まない。 */
        assertCapturedComposerAttachmentsAvailable: async () => {},
        /** 開始時の返信先を検証し、プロバイダーの ID と異なる保存 Turn ID を付与する。 */
        persistQueuedTurnStart: (next, _count, _id, turn) => {
          assert.deepEqual(next.messages.at(-1)?.replyTo, reference);
          return { session: next, turn: { ...turn, id: 41 } };
        },
        /** 終端保存の結果を変更せず、公開された ID 履歴をそのまま検証できるようにする。 */
        appendTerminalSession: (next) => next,
        /** ライブ状態の最新版を保持し、ID の推移を発行ごとに記録する。 */
        setLiveSessionRun: (_id, state) => {
          live = state;
          if (state) states.push(state);
        },
        /** 追加入力の表示に使われる最新のライブ状態を読み戻す。 */
        getLiveSessionRun: () => live,
      },
    );
    const receipt = queuedReceipt(session);
    if (reference) receipt.dispatched!.request.replyTo = reference;
    assert.deepEqual(
      await runtime.runQueuedSessionTurn(receipt, async ({ turnId }) => {
        starts.push(turnId);
      }),
      { state: "completed" },
    );
    assert.deepEqual(starts, ["41"]);
    assert.equal(states[0]?.sessionTurnId, "41");
    const startedStates = states.filter(
      (state) => state.sessionTurnId === "41",
    );
    assert.ok(startedStates.length >= 3);
    for (const state of startedStates)
      assert.deepEqual(state.queueReceipt, {
        id: receipt.id,
        incarnationId: receipt.incarnationId,
        userMessageSeq: 0,
      });
    assert.deepEqual(
      states
        .filter((state) => state.inputAvailable)
        .map((state) => [
          state.sessionTurnId,
          state.turnId,
          state.assistantText,
        ]),
      [
        ["41", "native-turn", "partial"],
        ["41", "native-turn", "partial updated"],
      ],
    );
  }
});

// @test-value v2
// kind = "contract"
// claim = "queued実行は捕捉設定で原子的開始しterminal ACK後だけ確定しcleanup実解放までexact保存Turn IDと再送guardを保持する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md Session Run Cancel; src-electron/session/session-running-turn-start.ts" }
// fault = "本文を再previewするか捕捉設定を現在選択で置換し、開始を分割保存するかterminal応答でcleanup guardやexact Turn IDを解放する"
// observable = "atomic開始payload・Provider request・onStarted identity・terminal待機中の返却と実guard/release通知・getUnreleasedTurnIds"
// observation_boundary = "public-boundary"
// scope = "queued runtime captured start terminal and real guard"
// lifecycle = "permanent"
// impact = "受付時と異なる入力を実行し、旧provider cleanup中に後続を二重開始する"
// distinction = "store/service testだけではruntimeのProvider request構築とterminal保存ACK境界を通らない"
// @end-test-value
/** キュー実行が捕捉済み入力を使って開始を atomic に保存し、終端の ACK と実際の後片付けを終えてから Run を解放することを確認する。 */
it("queued runtimeは捕捉入力・atomic開始・terminal ACK・実cleanup解放を守る", async () => {
  const session = createSession({
    incarnationId: "owner",
    threadId: "current-thread",
  });
  const receipt = queuedReceipt(session);
  const capturedOptions = receipt.captured.request.executionOptions;
  const currentSession = {
    ...session,
    model: "current-selection",
    catalogRevision: 2,
  };
  const terminalEntered = queueGate();
  const commit = queueGate();
  const cleanup = queueGate();
  const starts: Array<{ turnId: string; userMessageSeq: number }> = [];
  let atomics = 0;
  let releases = 0;
  let runtime!: SessionRuntimeService;
  runtime = createProgressRuntime(
    currentSession,
    async (input) => {
      assert.equal(input.session.threadId, "current-thread");
      assert.equal(input.userMessage, "captured message");
      assert.deepEqual(input.executionOptions, capturedOptions);
      assert.deepEqual(input.attachments, receipt.captured.attachments);
      input.onCleanupPending?.(cleanup.promise);
      return createPartialResult({ assistantText: "done" });
    },
    {
      /** 捕捉入力を再プレビューした場合は、入力が固定されていないことを示す失敗にする。 */
      resolveComposerPreview: async () => {
        assert.fail("queued input must not be re-previewed");
      },
      /** キューの開始を通常 Run の保存へ分割した場合に失敗させる。 */
      persistRunningTurnStart: () => {
        assert.fail("queued start must be atomic");
      },
      /** 最小 Turn を atomic 開始以外で個別作成した場合に失敗させる。 */
      createSessionTurn: () => {
        assert.fail("minimum turn belongs to atomic start");
      },
      /** 現在のスレッド情報と捕捉済みの添付一覧が、開始直前の検査に渡ることを確認する。 */
      assertCapturedComposerAttachmentsAvailable: async (
        current,
        attachments,
      ) => {
        assert.equal(current.threadId, "current-thread");
        assert.deepEqual(attachments, receipt.captured.attachments);
      },
      /** カタログからモデルが消えても、捕捉済みのオプションが維持される条件を作る。 */
      resolveProviderCatalog: () => {
        const provider = createProviderCatalog();
        provider.models = [];
        return { snapshot: { providers: [provider] }, provider };
      },
      /** 受付 ID・本文・既存件数・ユーザー位置を照合し、開始の一括書込み回数を数える。 */
      persistQueuedTurnStart: (next, count, id, turn) => {
        atomics += 1;
        assert.equal(id, receipt.id);
        assert.equal(count, 0);
        assert.equal(next.messages.at(-1)?.text, "captured message");
        assert.equal(turn.userMessageSeq, count);
        return { session: next, turn: { ...turn, id: 41 } };
      },
      /** 終端保存が完了扱いになる前に ACK を止め、保存 Turn ID と完了 phase を照合する。 */
      appendTerminalSession: async (next, terminal) => {
        assert.equal(terminal.phase, "completed");
        assert.equal(terminal.turnId, 41);
        terminalEntered.resolve();
        await commit.promise;
        return next;
      },
      /** 解放の通知時には in-flight と未解放 Turn がどちらもなくなっていることを確認する。 */
      onSessionRunReleased: () => {
        assert.equal(runtime.isRunInFlight(session.id), false);
        assert.deepEqual(runtime.getUnreleasedTurnIds(), []);
        releases += 1;
      },
    },
  );
  let returned = false;
  const running = runtime
    .runQueuedSessionTurn(receipt, async (start) => {
      starts.push(start);
    })
    .then((result) => {
      returned = true;
      return result;
    });
  await terminalEntered.promise;
  assert.deepEqual(runtime.getUnreleasedTurnIds(), ["41"]);
  assert.equal(returned, false);
  assert.equal(runtime.isRunInFlight(session.id), true);
  commit.resolve();
  assert.deepEqual(await running, { state: "completed" });
  assert.equal(atomics, 1);
  assert.deepEqual(starts, [{ turnId: "41", userMessageSeq: 0 }]);
  assert.equal(runtime.isRunInFlight(session.id), true);
  assert.equal(releases, 0);
  assert.deepEqual(runtime.getUnreleasedTurnIds(), ["41"]);
  let drained = false;
  const draining = runtime.waitForPendingRuns().then(() => {
    drained = true;
  });
  assert.equal(drained, false);
  cleanup.resolve();
  await draining;
  assert.equal(runtime.isRunInFlight(session.id), false);
  assert.ok(releases > 0);
  assert.deepEqual(runtime.getUnreleasedTurnIds(), []);
  assert.deepEqual(receipt.captured.request.executionOptions, capturedOptions);
});

// @test-value v2
// kind = "contract"
// claim = "queued開始前にowner/provider/workspace/添付が無効または捕捉modelが空なら未開始の確定failedを返す"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md Session Delete; src-shared/session/session-execution-options.ts validateSessionExecutionOptions" }
// fault = "変更されたowner/実行先や失われた添付を実行するか空modelを既定値へ自動切替する"
// observable = "failed返却、atomic開始とProviderの呼出し件数0"
// observation_boundary = "public-boundary"
// scope = "queued runtime pre-provider capture validation"
// lifecycle = "permanent"
// impact = "古いownerへの送信や受付と異なるpath/modelの外部実行を防ぐ"
// distinction = "受付時facadeとstore検査では実行開始時の現在認可とcatalogを検証できない"
// @end-test-value
/** owner・provider・workspace・添付・モデルのいずれかが無効化された受付を、開始保存と Provider 呼出しの前に失敗させる。 */
it("queued runtimeは無効になった捕捉入力を開始前にfailedで返す", async () => {
  for (const stage of [
    "owner",
    "provider",
    "workspace",
    "attachment",
    "model",
  ] as const) {
    const session = createSession({ incarnationId: "owner" });
    const receipt = queuedReceipt(session);
    const current = {
      ...session,
      ...(stage === "owner" ? { incarnationId: "new-owner" } : {}),
      ...(stage === "provider" ? { provider: "copilot" } : {}),
      ...(stage === "workspace" ? { workspacePath: "C:/other" } : {}),
    };
    let starts = 0;
    let providers = 0;
    const runtime = createProgressRuntime(
      current,
      async () => {
        providers += 1;
        return createPartialResult();
      },
      {
        /** 添付が消えたケースだけ、捕捉済み添付を検証する段階で失敗させる。 */
        assertCapturedComposerAttachmentsAvailable: async () => {
          if (stage === "attachment")
            throw new Error("Captured attachment disappeared");
        },
        /** 検証に失敗した受付が atomic 開始に至っていないことを数える。 */
        persistQueuedTurnStart: (next, _, __, turn) => {
          starts += 1;
          return { session: next, turn: { id: 1, ...turn } };
        },
        /** 通常のモデル解決を与え、各ケースの別の無効化条件を検証する。 */
        resolveProviderCatalog: () => {
          const provider = createProviderCatalog();
          return { snapshot: { providers: [provider] }, provider };
        },
      },
    );
    if (stage === "model")
      receipt.dispatched!.request.executionOptions = {
        ...receipt.dispatched!.request.executionOptions,
        model: "",
      };
    const result = await runtime.runQueuedSessionTurn(receipt, async () => {
      assert.fail("Rejected start cannot be observed as started");
    });
    assert.equal(result.state, "failed");
    assert.ok(result.reason);
    assert.equal(starts, 0);
    assert.equal(providers, 0);
    assert.equal(runtime.isRunInFlight(session.id), false);
  }
});

// @test-value v2
// kind = "contract"
// claim = "queue待ち後や開始準備の待機中にModelまたは接続先が無効なら捕捉IDを保持したまま開始前に失敗する"
// oracle = { type = "contract", ref = "docs/design/model-catalog.md#model-availability" }
// fault = "受付時の設定だけで実行し、後から無効化された接続先やModelを起動する"
// observable = "queued実行のfailed理由、開始保存とProvider呼出し件数0、捕捉Model不変"
// observation_boundary = "public-boundary"
// scope = "共通Runtimeのqueued Model/サービス無効化"
// lifecycle = "permanent"
// impact = "無効化済みサービスへの課金と送信が発生する"
// distinction = "受付testは待機後の設定変更を検出できない"
// @end-test-value
/** キュー待機中にモデルまたはサービスを無効にした場合、捕捉済み選択を別モデルへ差し替えず開始前に拒否する。 */
it("queue待ち後のModelとサービス無効化を開始前に拒否する", async () => {
  for (const reason of ["model", "service"] as const) {
    const session = createSession({
      provider: "opencode",
      model: "openai/saved-model",
      incarnationId: "owner",
      approvalMode: "on-request",
    });
    const receipt = queuedReceipt(session);
    let starts = 0;
    let providers = 0;
    const settings = normalizeAppSettings({
      codingProviderSettings: { opencode: { enabled: true } },
    });
    const runtime = createProgressRuntime(
      session,
      async () => {
        providers++;
        return createPartialResult();
      },
      {
        /** キュー実行時点の無効化設定をコピーして返し、受付原本から再捕捉しない。 */
        getAppSettings: () => structuredClone(settings),
        /** Character 読取中に対象モデルまたはサービスを無効化し、受付時点の選択が再検証されるようにする。 */
        resolveSessionCharacter: async () => {
          settings.modelAvailability = {
            opencode: {
              disabledServiceIds: reason === "service" ? ["openai"] : [],
              disabledModelIds: reason === "model" ? [session.model] : [],
            },
          };
          return null;
        },
        /** 捕捉モデルが現時点のカタログに使われない条件で、無効化設定による拒否を分離する。 */
        resolveProviderCatalog: () => {
          const provider = { ...createProviderCatalog("opencode"), models: [] };
          return { snapshot: { providers: [provider] }, provider };
        },
        /** モデル無効化に関係のない捕捉済み添付は有効と扱う。 */
        assertCapturedComposerAttachmentsAvailable: async () => {},
        /** モデルまたはサービスの拒否後に開始保存へ進んでいないことを数える。 */
        persistQueuedTurnStart: (next, _, __, turn) => {
          starts++;
          return { session: next, turn: { id: 1, ...turn } };
        },
      },
    );
    const result = await runtime.runQueuedSessionTurn(receipt, async () =>
      assert.fail("Disabled Model cannot start"),
    );
    assert.equal(result.state, "failed");
    assert.match(result.reason ?? "", /disabled/);
    assert.equal(starts, 0);
    assert.equal(providers, 0);
    assert.equal(
      receipt.captured.request.executionOptions.model,
      session.model,
    );
  }
});

// @test-value v2
// kind = "contract"
// claim = "atomic開始前に実終了したqueued取消だけcanceledへ収束し、setup生存中のtimeoutと開始保存の結果不明はthrowを維持する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md GUI Turn Queue / Session Run Cancel" }
// fault = "確定した未開始取消をinterruptedへ変換するか、未終了setupや開始commit不明を既知canceledとして後続を許可する"
// observable = "queued実行の返却state/throw、atomic開始・Provider呼出し件数、取消後の実guardと終了wait"
// observation_boundary = "public-boundary"
// scope = "SessionRuntimeService.runQueuedSessionTurn pre-start cancellation"
// lifecycle = "permanent"
// impact = "副作用未開始の取消でFIFOが停止することと結果不明の要求の誤った自動継続を防ぐ"
// distinction = "Provider開始後の取消testとqueue単体ではatomic前のruntime取消分類と未終了guardを検証できない"
// @end-test-value
/** 開始前の取消・準備タイムアウトと、atomic 開始応答が不明になった場合を区別し、実行中状態を残さないことを確かめる。 */
it("queued runtimeはatomic前の確定取消と結果不明を区別する", async () => {
  for (const mode of [
    "before-start",
    "setup-timeout",
    "start-unknown",
  ] as const) {
    const session = createSession({ incarnationId: "owner" });
    const entered = queueGate();
    const validation = queueGate();
    const failure = new Error("Atomic start reply lost after cancel");
    let atomics = 0;
    let providers = 0;
    let runtime!: SessionRuntimeService;
    runtime = createProgressRuntime(
      session,
      async () => {
        providers += 1;
        return createPartialResult();
      },
      {
        providerCancelGraceMs: mode === "setup-timeout" ? 0 : 1_000,
        /** 添付検証に到達したことを知らせ、開始保存の前で取消と競合させる。 */
        assertCapturedComposerAttachmentsAvailable: async () => {
          entered.resolve();
          await validation.promise;
        },
        /** 開始保存中に取消を起こしてから失敗させ、開始結果を推測して救済しない経路を作る。 */
        persistQueuedTurnStart: () => {
          atomics += 1;
          runtime.cancelRun(session.id);
          throw failure;
        },
      },
    );
    const running = runtime.runQueuedSessionTurn(
      queuedReceipt(session),
      async () => {
        assert.fail("Canceled start cannot be observed as started");
      },
    );
    try {
      await entered.promise;
      if (mode !== "start-unknown") runtime.cancelRun(session.id);
      if (mode !== "setup-timeout") validation.resolve();
      if (mode === "before-start") {
        assert.equal((await running).state, "canceled");
        assert.equal(runtime.isRunInFlight(session.id), false);
      } else {
        await assert.rejects(
          running,
          mode === "setup-timeout"
            ? /did not stop/
            : (error: unknown) => error === failure,
        );
        assert.equal(
          runtime.isRunInFlight(session.id),
          mode === "setup-timeout",
        );
      }
      assert.equal(atomics, mode === "start-unknown" ? 1 : 0);
      assert.equal(providers, 0);
    } finally {
      validation.resolve();
      await running.catch(() => {});
      await runtime.waitForPendingRuns();
    }
    assert.equal(runtime.isRunInFlight(session.id), false);
  }
});

// @test-value v2
// kind = "contract"
// claim = "queued atomic開始またはterminal保存の結果不明はgeneric throwのまま伝播し別failed保存で救済しない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md Decision" }
// fault = "commit返信喪失を確定failedへ変換し後続を自動dispatch可能にする"
// observable = "元error同一性、terminal保存phase列、Provider呼出し件数"
// observation_boundary = "public-boundary"
// scope = "queued runtime unknown persistence boundary"
// lifecycle = "permanent"
// impact = "保存済みか不明な要求を再実行したり後続を誤って進める"
// distinction = "store testではruntimeの保存失敗catchとfailed保存への変換を観測できない"
// @end-test-value
/** atomic 開始と終端保存のどちらで応答が失われても、保存結果を推測した再処理や代替保存を行わない。 */
it("queued runtimeは開始とterminal保存の不明結果を救済しない", async () => {
  for (const stage of ["start", "terminal"] as const) {
    const session = createSession({ incarnationId: "owner" });
    const receipt = queuedReceipt(session);
    const failure = new Error(`${stage} commit outcome unknown`);
    const phases: string[] = [];
    let providers = 0;
    const runtime = createProgressRuntime(
      session,
      async () => {
        providers += 1;
        return createPartialResult({ assistantText: "done" });
      },
      {
        /** 開始・終端の応答喪失を対象とし、添付検証そのものは成功させる。 */
        assertCapturedComposerAttachmentsAvailable: async () => {},
        /** 開始結果不明ケースだけ保存例外を投げ、それ以外は保存 Turn を返して実行を進める。 */
        persistQueuedTurnStart: (next, _, __, turn) => {
          if (stage === "start") throw failure;
          return { session: next, turn: { id: 41, ...turn } };
        },
        /** 終端を保存しようとした phase を記録し、ACK を返せなかった状態を再現する。 */
        appendTerminalSession: (_, terminal) => {
          phases.push(terminal.phase);
          throw failure;
        },
      },
    );
    await assert.rejects(
      runtime.runQueuedSessionTurn(receipt, async () => {}),
      (error) => error === failure,
    );
    assert.equal(providers, stage === "start" ? 0 : 1);
    assert.deepEqual(phases, stage === "start" ? [] : ["completed"]);
    await runtime.waitForPendingRuns();
  }
});

// @test-value v2
// kind = "contract"
// claim = "queued失敗は空または部分本文をそのまま保持して失敗理由を分離し、取消はfailedと区別する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Error Handling; docs/design/desktop-ui.md: 確定した送信・実行失敗" }
// fault = "本文へ通知を追記する、空本文の理由を落とす、または取消をfailedとして保存・返却する"
// observable = "appendTerminalのphaseとassistant text/runFailure、dispatch返却state、onStarted minimum turn ID"
// observation_boundary = "public-boundary"
// scope = "queued runtime confirmed failure and cancellation"
// lifecycle = "permanent"
// distinction = "serviceのfake dispatch resultではruntimeの実terminal phaseとの対応を保証できない"
// @end-test-value
/** 通常の失敗と取消をキュー結果と終端 phase で区別し、途中本文および取消注記を対応する形式で保存する。 */
it("queued runtimeは保存済みfailedとcanceledを区別する", async () => {
  for (const [canceled, partial] of [
    [false, ""],
    [false, "  部分本文\n"],
    [true, "部分本文"],
  ] as const) {
    const session = createSession({ incarnationId: "owner" });
    const phases: string[] = [];
    const responses: Session["messages"] = [];
    const runtime = createProgressRuntime(
      session,
      async () => {
        throw new ProviderTurnError(
          "stopped",
          createPartialResult({ assistantText: partial }),
          canceled,
        );
      },
      {
        /** 失敗と取消の終端だけを比較するため、添付検査は外部へ問い合わせない。 */
        assertCapturedComposerAttachmentsAvailable: async () => {},
        /** 開始保存で固定 ID を返し、以降の終端で同じ Turn を使用する。 */
        persistQueuedTurnStart: (next, _, __, turn) => ({
          session: next,
          turn: { id: 41, ...turn },
        }),
        /** 終端 phase と実際に最後へ追加した応答レコードを比較用に記録する。 */
        appendTerminalSession: (next, terminal) => {
          phases.push(terminal.phase);
          responses.push(next.messages.at(-1)!);
          return next;
        },
      },
    );
    const result = await runtime.runQueuedSessionTurn(
      queuedReceipt(session),
      async (started) => {
        assert.equal(started.turnId, "41");
      },
    );
    assert.equal(result.state, canceled ? "canceled" : "failed");
    assert.deepEqual(phases, [canceled ? "canceled" : "failed"]);
    assert.equal(
      responses[0].text,
      canceled ? `${partial}\n\nRun canceled.` : partial,
    );
    assert.equal(responses[0].runFailure, canceled ? undefined : "stopped");
  }
});

/** 古いスレッドの再試行判定と、途中結果がある場合の再試行抑止を検証する。 */
describe("SessionRuntimeService stale retry helpers", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "stale classifierはnarrowなthread/session系errorだけをretry対象にする"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: isRetryableStaleThreadSessionError" }
  // fault = "無関係なprovider errorをstale扱いしてretryする、またはstale errorを見逃す"
  // observable = "isRetryableStaleThreadSessionErrorのthread/session文字列・codeに対するtrueと汎用not_found/model_incompatible/接続errorに対するfalse"
  // observation_boundary = "component-behavior"
  // scope = "SessionRuntimeService stale error classifier"
  // lifecycle = "permanent"
  // @end-test-value
  /** 明示的なスレッド・セッション不在だけを対象とし、接続切断などの曖昧な障害では古いスレッドと判定しない。 */
  it("stale classifier は narrow な thread / session 系だけを対象にする", () => {
    assert.equal(
      isRetryableStaleThreadSessionError(new Error("thread not found")),
      true,
    );
    assert.equal(
      isRetryableStaleThreadSessionError(
        new Error("session expired on provider side"),
      ),
      true,
    );
    assert.equal(
      isRetryableStaleThreadSessionError(
        new Error("invalid-thread identifier"),
      ),
      true,
    );
    assert.equal(
      isRetryableStaleThreadSessionError(
        new Error("thread model incompatible with selected model"),
      ),
      true,
    );
    assert.equal(
      isRetryableStaleThreadSessionError(new Error("SessionNotFound")),
      true,
    );
    assert.equal(
      isRetryableStaleThreadSessionError(new Error("session_not_found")),
      true,
    );
    assert.equal(
      isRetryableStaleThreadSessionError({ code: "thread_not_found" }),
      true,
    );
    assert.equal(
      isRetryableStaleThreadSessionError({ code: "not_found" }),
      false,
    );
    assert.equal(
      isRetryableStaleThreadSessionError({ code: "model_incompatible" }),
      false,
    );
    assert.equal(
      isRetryableStaleThreadSessionError(new Error("Connection is closed.")),
      false,
    );
    assert.equal(
      isRetryableStaleThreadSessionError(new Error("socket hang up")),
      false,
    );
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "meaningful partial判定はassistantTextまたは通常artifactの情報を観測する"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: hasMeaningfulPartialRunResult / hasMeaningfulArtifact" }
  // fault = "利用者に返せるpartial情報を空扱いし、不要なretryまたは破棄を行う"
  // observable = "hasMeaningfulPartialRunResultの空結果=false、本文・operationTimeline・changedFilesあり=true"
  // observation_boundary = "component-behavior"
  // scope = "SessionRuntimeService partial response classification"
  // lifecycle = "permanent"
  // @end-test-value
  /** 空の途中結果と、本文や通常成果物を既に取得した途中結果を区別する。 */
  it("meaningful partial 判定は assistantText と通常artifactを見る", () => {
    assert.equal(hasMeaningfulPartialRunResult(createPartialResult()), false);
    assert.equal(
      hasMeaningfulPartialRunResult(
        createPartialResult({ assistantText: "partial" }),
      ),
      true,
    );
    assert.equal(
      hasMeaningfulPartialRunResult(
        createPartialResult({
          artifact: {
            title: "",
            activitySummary: [],
            changedFiles: [],
            runChecks: [],
            operationTimeline: [
              { type: "command_execution", summary: "npm test" },
            ],
          },
        }),
      ),
      true,
    );
    assert.equal(
      hasMeaningfulPartialRunResult(
        createPartialResult({
          artifact: {
            title: "Artifact",
            activitySummary: [],
            changedFiles: [
              {
                kind: "edit",
                path: "src/a.ts",
                summary: "updated",
                diffRows: [],
              },
            ],
            runChecks: [],
          },
        }),
      ),
      true,
    );
  });
});
/** 受付から Provider 実行・ライブ表示・保存・終了までの Session 契約を検証する。 */
describe("SessionRuntimeService", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "４Providerの通常質問は送信を確認した回答だけを終端履歴へ保存し、未確認の回答を保存しない"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#question-forms; docs/design/database-schema.md: 質問formの記録" }
  // fault = "送信確認前の値を保存するか、確認済みの選択と自由回答を再読込時に失う"
  // observable = "各Providerの送信通知前後のlive recordと終端messageの回答"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService question reply history"
  // lifecycle = "permanent"
  // impact = "送られていない回答を送信済みと誤認するか、送信内容を後から確認できない"
  // distinction = "adapter単体は共通serviceからterminal保存までの回答の伝播を検証しない"
  // @end-test-value
  /** 各プロバイダーの通常質問について、選択回答を実際に送信した通知がある場合だけ終端履歴へ残す。 */
  it("各Providerの質問回答は送信通知後だけ履歴に残す", async () => {
    for (const providerId of [
      "codex",
      "copilot",
      "claude",
      "opencode",
    ] as const)
      for (const delivered of [false, true]) {
        let stored = createSession({
          provider: providerId,
          approvalMode: "on-request",
          codexReviewer: "user",
        });
        let live: LiveSessionRunState | null = null;
        const questions = new SessionElicitationService({
          /** エリシテーションサービスが発行した状態を現在のライブ状態へ取り込む。 */ updateLiveSessionRun:
            (_id, recipe) => {
              live = recipe(live!);
              return live;
            },
        });
        const adapter: ProviderCodingAdapter = {
          /** 質問への応答経路に無関係なプロンプト内容と添付を空にする。 */
          composePrompt: () => ({
            systemBodyText: "",
            inputBodyText: "",
            logicalPrompt: { systemText: "", inputText: "", composedText: "" },
            imagePaths: [],
            additionalDirectories: [],
          }),
          /** 質問の配送済み履歴を比較するケースでは、利用枠計測値を返さない。 */
          getProviderQuotaTelemetry: async () => null,
          /** 質問が終端履歴に残るかだけを検証し、個別スレッドの無効化は外部へ送らない。 */ invalidateSessionThread:
            async () => {},
          /** 全スレッド無効化に必要な外部アダプター状態を作らない。 */ invalidateAllSessionThreads:
            async () => {},
          /** 実質問コールバックに選択フォームを渡し、指定ケースだけ配送通知を送って終端へ進む。 */
          runSessionTurn: async (input) => {
            const request: LiveElicitationRequest = {
              requestId: "question",
              provider: providerId,
              kind: "question",
              mode: "form",
              message: "Choose",
              fields: [
                {
                  type: "select",
                  name: "choice",
                  title: "Choose",
                  required: true,
                  options: [{ value: "a", label: "A" }],
                },
              ],
            };
            const answer = input.onElicitationRequest!(request);
            questions.resolveLiveElicitation(input.session.id, "question", {
              action: "accept",
              content: { choice: "a" },
              answerPresentation: { choice: { selected: [0], text: [] } },
            });
            await answer;
            assert.equal(
              live?.elicitationRecords?.[0].fields[0].answer,
              undefined,
            );
            if (delivered) input.onElicitationDelivered?.("question");
            return createPartialResult({ assistantText: "done" });
          },
        };
        const service = createTestRuntime({
          /** 質問回答の保存前後で実行所有者を同じメモリ上の Session から解決する。 */ getSession:
            () => stored,
          /** 更新された Session を保持し、回答履歴を含む終端の保存内容を確認できるようにする。 */ upsertSession:
            (next) => {
              stored = next;
              return next;
            },
          /** 回答結果に影響する Composer 添付を持たない入力を返す。 */
          resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
          /** その回の質問を発行するプロバイダーを有効にしてから実行する。 */ getAppSettings:
            () =>
              normalizeAppSettings({
                codingProviderSettings: { [providerId]: { enabled: true } },
              }),
          /** 四種のうち今回のプロバイダーを選択済みカタログとして返す。 */
          resolveProviderCatalog: () => ({
            snapshot: { providers: [createProviderCatalog(providerId)] },
            provider: createProviderCatalog(providerId),
          }),
          /** 配送通知の有無を切り替えられる、その回の質問アダプターを使う。 */
          getProviderCodingAdapter: () => adapter,
          createSessionTurn: createSessionTurnBase,
          /** 質問の観測先を Session のメッセージに限定し、別途 Turn 更新を記録しない。 */ updateSessionTurn() {},
          /** 質問発行と解消で変化するライブ状態を書き込む。 */
          setLiveSessionRun: (_id, next) => {
            live = next;
          },
          /** 実エリシテーションサービスとランタイムが共有する最新状態を返す。 */ getLiveSessionRun:
            () => live,
          /** 承認を尋ねないケースでは、誤って承認待機に入っても許可しない。 */
          waitForApprovalDecision: () => "deny",
          /** 質問への返答を、所有者と AbortSignal を保ったまま本番サービスから得る。 */ waitForElicitationResponse:
            (id, request, signal) =>
              questions.waitForLiveElicitationResponse(id, request, signal),
          /** 利用枠を副作用として保存しない。 */
          setProviderQuotaTelemetry() {},
          /** ライブ質問の検証にコンテキスト計測を混ぜない。 */ setSessionContextTelemetry() {},
          /** 終了時にスレッド無効化を実プロバイダーへ送信しない。 */ async invalidateProviderSessionThread() {},
          /** 質問が完了しても利用枠再取得は起動しない。 */ scheduleProviderQuotaTelemetryRefresh() {},
          /** 質問表示の観測はメモリで行い、実 Window へは通知しない。 */ broadcastLiveSessionRun() {},
          /** この fixture は解決対象となる承認を保持しない。 */ resolvePendingApprovalRequest() {},
          /** 終了後に保留中の質問が残らないよう、実サービスへ Session 単位の取消を渡す。 */
          resolvePendingElicitationRequest: (id) => questions.cancelSession(id),
        });
        await service.runSessionTurn(stored.id, {
          executionOptions: captureSessionExecutionOptions(stored),
          userMessage: "start",
        });
        assert.deepEqual(
          stored.messages.at(-1)?.elicitationRecords?.[0].fields[0].answer,
          delivered ? { selected: [0], text: [] } : undefined,
        );
      }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "async質問の回答はACK前に表示用回答を確定せず、ACKと終端が競合しても回答本文と全質問の最終状態を同じturnに保存する"
  // oracle = { type = "contract", ref = "Issue #823; Issue #780 explicit same-turn input" }
  // fault = "通常steerで質問を回答済みにする、provider progressで質問を消す、ACK前に回答済みへ進める、または終端保存が回答ACKを追い越して質問履歴を失う"
  // observable = "実SessionElicitationServiceのlive要求・record、adapter steer入力、保存Sessionのuser本文とterminal elicitationRecords"
  // observation_boundary = "public-boundary"
  // scope = "SessionElicitationServiceとSessionRuntimeServiceのasync質問・同turn入力・正常取消失敗終端の統合"
  // lifecycle = "permanent"
  // impact = "利用者の回答が未送信のまま回答済み表示になるか、受理済み回答と未回答質問を履歴から失う"
  // distinction = "service単体ではruntimeのACK待機・progress合流・terminal保存順を検出できない。短いfake providerの3終端ケースで実service接続を検証する"
  // @end-test-value
  /** Codex の非同期質問に対する ACK が終端と競合しても、完了・失敗・取消で回答と全質問履歴が確定し、遅い再回答を拒否することを確認する。 */
  it("Codex async質問のACKと終端の競合でも回答と全質問履歴を保存する", async () => {
    for (const outcome of ["completed", "canceled", "failed"] as const) {
      let stored = createSession({ threadId: "thread-existing" });
      let live: LiveSessionRunState | null = null;
      /** 質問が発行された時点で存在する最新のライブ状態を読み出す。 */
      const currentLive = () => live!;
      let finishProvider!: () => void;
      const providerEnd = new Promise<void>((resolve) => {
        finishProvider = resolve;
      });
      let acknowledgeAnswer!: () => void;
      const answerAck = new Promise<void>((resolve) => {
        acknowledgeAnswer = resolve;
      });
      let publishProgress!: () => Promise<void>;
      const sent: string[] = [];
      const phases: string[] = [];
      let service!: SessionRuntimeService;
      const questions = new SessionElicitationService({
        /** 質問の表示内容と履歴を更新し、通常の追加入力と同じライブ状態に反映する。 */
        updateLiveSessionRun: (_id, recipe) => {
          live = recipe(currentLive());
          return live;
        },
        /** 回答を送るサービス経路へ、送信先 Turn と質問 ID を省略せず渡す。 */
        sendUserMessage: async (id, turnId, message, answer, requestId) => {
          await service.answerSessionQuestion(
            id,
            turnId,
            message,
            answer,
            requestId,
          );
        },
      });
      const adapter: ProviderCodingAdapter = {
        /** 非同期質問の比較に使う固定本文を返し、追加の画像やフォルダーは解決しない。 */
        composePrompt: () => ({
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: {
            systemText: "system",
            inputText: "input",
            composedText: "system\ninput",
          },
          imagePaths: [],
          additionalDirectories: [],
        }),
        /** Codex の質問テストでは利用枠を取得しない。 */
        getProviderQuotaTelemetry: async () => null,
        /** 実在するスレッドを破棄せず、固定 ID だけで質問の配送を検証する。 */ invalidateSessionThread:
          async () => {},
        /** 全スレッドの実アダプター状態を初期化しない。 */ invalidateAllSessionThreads:
          async () => {},
        /** 異なる質問と応答の進捗を発行し、終端までのゲートおよび指定した完了・取消・失敗結果を制御する。 */
        runSessionTurn: async (input, progress) => {
          publishProgress = async () => {
            await emitTestProgress(progress, {
              ...createLiveRunState(),
              sessionId: input.session.id,
              threadId: "thread-existing",
              turnId: "turn-one",
              inputAvailable: true,
              assistantText: "still running",
            });
          };
          await publishProgress();
          const controller = new AbortController();
          for (const requestId of ["answer-me", "unanswered"]) {
            void input.onElicitationRequest!(
              {
                requestId,
                provider: "codex",
                kind: "question",
                mode: "form",
                blocking: false,
                delivery: "user-message",
                turnId: "turn-one",
                message: "Codex has a question",
                fields: [
                  {
                    name: "answer",
                    title:
                      requestId === "answer-me"
                        ? "Choose a direction"
                        : "Any constraints?",
                    type: "text",
                    required: true,
                  },
                ],
              },
              controller.signal,
            );
          }
          await providerEnd;
          controller.abort();
          const result = createPartialResult({
            threadId: "thread-existing",
            assistantText: "provider result",
          });
          if (outcome !== "completed")
            throw new ProviderTurnError(
              "provider stopped",
              result,
              outcome === "canceled",
            );
          return result;
        },
        /** 送信本文を順に記録し、通常 Steer では待たず、質問回答だけ ACK を遅延させる。 */
        steerSessionTurn: async (input) => {
          sent.push(input.userMessage);
          if (input.userMessage !== "ordinary steer") await answerAck;
          return { turnId: input.expectedTurnId };
        },
      };
      service = createTestRuntime({
        /** 途中応答・質問・終端の保存先として、現在の Session を返す。 */
        getSession: () => stored,
        /** 更新された Session オブジェクトを保持し、全質問履歴を終端後に読み出せるようにする。 */ upsertSession:
          (next) => {
            stored = next;
            return next;
          },
        /** 通常 Steer の Composer 検査で添付やエラーを返さない。 */
        resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
        /** 今回の Codex 実行に、変更を加えていない既定設定を返す。 */ getAppSettings:
          () => normalizeAppSettings({}),
        /** 固定した Codex モデルをカタログから解決する。 */
        resolveProviderCatalog: () => ({
          snapshot: { providers: [createProviderCatalog()] },
          provider: createProviderCatalog(),
        }),
        /** 送信本文と回答 ACK を制御できる fixture の Codex アダプターを取得する。 */
        getProviderCodingAdapter: () => adapter,
        createSessionTurn: createSessionTurnBase,
        /** 質問 ACK と競合した Run がどの phase で保存されたかを記録する。 */ updateSessionTurn:
          (_id, update) => {
            phases.push(update.phase);
          },
        /** 質問表示を含むライブ状態をメモリへ書き込む。 */
        setLiveSessionRun: (_id, next) => {
          live = next;
        },
        /** 質問と Steer で共通の最新ライブ状態を読み取り、固定の Turn を参照できるようにする。 */ getLiveSessionRun:
          () => live,
        /** 質問経路のテストでは承認要求を通さない。 */
        waitForApprovalDecision: () => "deny",
        /** 質問への実回答を、指定されたエリシテーションサービスから取得する。 */ waitForElicitationResponse:
          (id, request, signal) =>
            questions.waitForLiveElicitationResponse(id, request, signal),
        /** 質問 ACK を調べる間、利用枠は別途記録しない。 */
        setProviderQuotaTelemetry() {},
        /** 質問履歴以外のコンテキストテレメトリーを保持しない。 */ setSessionContextTelemetry() {},
        /** 質問が無効になっても、実プロバイダーのスレッド消去は行わない。 */ async invalidateProviderSessionThread() {},
        /** 実行終端後の利用枠計測処理を起動しない。 */ scheduleProviderQuotaTelemetryRefresh() {},
        /** 保存とライブ状態を直接確認するため、Window への中継は行わない。 */ broadcastLiveSessionRun() {},
        /** 今回の fixture では保留承認を作らない。 */ resolvePendingApprovalRequest() {},
        /** 質問サービスの保留要求を Session ごとに解決し、終端後の回答を拒否できるようにする。 */
        resolvePendingElicitationRequest: (id) => questions.cancelSession(id),
      });
      let turnSettled = false;
      const turn = service.runSessionTurn(stored.id, {
        executionOptions: captureSessionExecutionOptions(stored),
        userMessage: "start",
      });
      void turn.then(
        () => {
          turnSettled = true;
        },
        () => {
          turnSettled = true;
        },
      );
      try {
        await waitForCondition(
          () => currentLive()?.elicitationRequests?.length === 2,
          "both async questions displayed",
        );
        await service.steerSessionTurn(stored.id, {
          expectedTurnId: "turn-one",
          userMessage: "ordinary steer",
        });
        assert.deepEqual(
          currentLive().elicitationRecords?.map((record) => record.status),
          ["pending", "pending"],
        );
        await publishProgress();
        assert.equal(
          currentLive().elicitationRequests?.length,
          2,
          "provider progress preserves active questions",
        );
        assert.equal(
          currentLive().elicitationRecords?.length,
          2,
          "provider progress preserves history",
        );
        const answer = questions.resolveLiveElicitation(
          stored.id,
          "answer-me",
          {
            action: "accept",
            content: { answer: "Take option A" },
            answerPresentation: {
              answer: { selected: [], text: ["Take option A"] },
            },
          },
        );
        await waitForCondition(
          () => sent.length === 2,
          "answer dispatched through existing steer",
        );
        assert.equal(
          currentLive().elicitationRecords?.[0].status,
          "pending",
          "ACK is required before answered",
        );
        assert.equal(
          currentLive().elicitationRecords?.[0].fields[0].answer,
          undefined,
        );
        assert.deepEqual(
          stored.messages.map((message) => message.text),
          ["start", "ordinary steer", "Take option A"],
        );
        assert.equal(stored.messages.at(-1)?.turnInput?.state, "pending");
        assert.equal(
          stored.messages.at(-1)?.turnInput?.questionRequestId,
          "answer-me",
        );
        if (outcome === "canceled") service.cancelRun(stored.id);
        finishProvider();
        await waitForCondition(
          () => currentLive().inputAvailable === false,
          "provider terminal stops input admission",
        );
        assert.equal(
          turnSettled,
          false,
          "terminal persistence must wait for answer ACK",
        );
        assert.equal(
          currentLive().elicitationRequests?.length,
          0,
          "terminal questions are no longer actionable",
        );
        assert.throws(
          () =>
            questions.resolveLiveElicitation(stored.id, "unanswered", {
              action: "accept",
              content: { answer: "late" },
            }),
          /no longer exists/,
        );
        acknowledgeAnswer();
        await answer;
        await turn;
        assert.deepEqual(sent, [
          "ordinary steer",
          "【質問】\nChoose a direction\n【回答】\nTake option A",
        ]);
        assert.deepEqual(
          stored.messages
            .filter((message) => message.role === "user")
            .map((message) => message.text),
          ["start", "ordinary steer", "Take option A"],
        );
        assert.deepEqual(
          stored.messages
            .at(-1)
            ?.elicitationRecords?.map((record) => [
              record.requestId,
              record.status,
            ]),
          [
            ["answer-me", "answered"],
            ["unanswered", "expired"],
          ],
        );
        assert.deepEqual(
          stored.messages.at(-1)?.elicitationRecords?.[0].fields[0].answer,
          { selected: [], text: ["Take option A"] },
        );
        assert.equal(phases.at(-1), outcome);
        assert.throws(
          () =>
            questions.resolveLiveElicitation(stored.id, "answer-me", {
              action: "accept",
              content: { answer: "duplicate" },
            }),
          /no longer exists/,
        );
      } finally {
        finishProvider();
        acknowledgeAnswer();
        await turn;
      }
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "streamのdelta数にかかわらず最小turnは開始と終端だけ保存し、取得済み本文と個別操作結果は通常履歴へ保持する"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md: 通常履歴と最小turn; src-electron/session/session-runtime-service.ts: runSessionTurnInternal" }
  // fault = "deltaごとにcreate/updateSessionTurnを呼ぶか、失敗・取消の返却履歴からpartial artifactを捨ててturn phaseから操作結果を生成する"
  // observable = "create/updateSessionTurn入力のphase列とcreatedAt/completedAt、返却Session最終messageの本文とoperationTimeline"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService minimal turn and history persistence"
  // lifecycle = "permanent"
  // impact = "長い応答で保存量が増幅するか、取得済み操作結果を失う"
  // distinction = "storage型検査だけではruntimeのstream配送とterminal history保存を接続できない"
  // @end-test-value
  /** デルタ件数を変えても開始・終端だけを保存し、完了・失敗・取消すべてで取得済み本文と通常操作履歴を保持する。 */
  it("delta数が異なっても開始と終端だけ保存し、全phaseの通常artifactを保持する", async () => {
    for (const outcome of ["completed", "failed", "canceled"] as const)
      for (const deltaCount of [1, 250]) {
        const session = createSession();
        const writes: CreateSessionTurnInput[] = [];
        const operation = {
          id: "command-1",
          type: "command_execution",
          summary: "npm test",
          status: "failed",
          exitCode: 3,
          error: { message: "check failed", code: "CHECK" },
          truncated: true,
        };
        const partial = createPartialResult({
          assistantText: "取得済み本文",
          artifact: {
            title: "",
            activitySummary: [],
            changedFiles: [],
            runChecks: [],
            operationTimeline: [operation],
          },
        });
        const service = createProgressRuntime(
          session,
          async (input, progress) => {
            for (let delta = 0; delta < deltaCount; delta += 1)
              await emitTestProgress(
                progress,
                createLiveRunState({
                  sessionId: input.session.id,
                  assistantText: `partial-${delta}`,
                }),
              );
            if (outcome !== "completed")
              throw new ProviderTurnError(
                "provider stopped",
                partial,
                outcome === "canceled",
              );
            return partial;
          },
          {
            /** 最小 Turn の開始書込みを計数し、デルタの回数だけ増えないことを確認できるようにする。 */
            createSessionTurn(input) {
              writes.push(input);
              return createSessionTurnBase(input);
            },
            /** 終端の Turn 変更を保存一覧へ追加し、途中の永続化を検出する。 */
            updateSessionTurn(_id, input) {
              writes.push(input);
            },
          },
        );
        const result = await service.runSessionTurn(session.id, {
          userMessage: "run",
          executionOptions: TEST_EXECUTION_OPTIONS,
        });
        assert.deepEqual(
          writes.map((entry) => entry.phase),
          ["running", outcome],
        );
        assert.equal(writes[1]?.createdAt, writes[0]?.createdAt);
        assert.equal(typeof writes[1]?.completedAt, "string");
        assert.match(result.messages.at(-1)?.text ?? "", /取得済み本文/);
        assert.deepEqual(result.messages.at(-1)?.artifact?.operationTimeline, [
          operation,
        ]);
      }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Codex失敗時はSessionの保存threadと最小turnの実行threadを維持し、terminal保存後の通知が失敗してもcleanupする"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: runSessionTurnInternal catch / notifySessionTurnTerminalBestEffort / invalidateProviderSessionThreadBestEffort; docs/design/provider-adapter.md: Error Handling" }
  // fault = "保存threadをlive threadで上書きする、partial threadId欠如でturnのlive情報を失う、または通知失敗でcleanupを止める"
  // scope = "session-runtime-failed-terminal-notification"
  // observable = "SessionとturnのthreadId、通知回数と保存・cleanup順序"
  // observation_boundary = "public-boundary"
  // lifecycle = "permanent"
  // impact = "失敗後の会話継続先や実行先を失い、終了処理が止まる"
  // distinction = "復帰失敗の単体testはlive progressと保存threadが異なる場合のturn・Session分離を確認しない"
  // @end-test-value
  /** 失敗の部分結果にスレッドがない場合もライブ進捗のスレッドを最小 Turn に保存し、失敗保存・終端通知・掃除の順を保つ。 */
  it("failed 最小turn は partial threadId が無くても live progress の threadId を維持する", async () => {
    const session = createSession({
      provider: "codex",
      threadId: "thread-stale",
    });
    let live: LiveSessionRunState | null = null;
    const storedSessions: Session[] = [];
    const turnUpdates: UpdateSessionTurnInput[] = [];
    const terminalNotifications: TerminalNotificationInput[] = [];
    const terminalOrder: string[] = [];

    const service = createProgressRuntime(
      session,
      async (input, onProgress) => {
        await emitTestProgress(
          onProgress,
          createLiveRunState({
            sessionId: input.session.id,
            threadId: "thread-live",
          }),
        );
        throw new ProviderTurnError(
          "network timeout",
          createPartialResult(),
          false,
        );
      },
      {
        /** 実行中および失敗 Session の保存を記録し、終端通知より先に失敗保存が来ることを検証する。 */
        upsertSession(next) {
          storedSessions.push(next);
          if (next.runState === "error") terminalOrder.push("failed-upsert");
          return next;
        },
        /** 失敗した最小 Turn に渡った更新内容を後から照合できるようにする。 */
        updateSessionTurn(_id, entry) {
          turnUpdates.push(entry);
        },
        /** スレッドを含むライブ進捗を最新値として保持する。 */
        setLiveSessionRun(_id, state) {
          live = state;
        },
        /** 部分結果にスレッドがない場合に使用するライブ値を返す。 */
        getLiveSessionRun() {
          return live;
        },
        /** プロバイダー掃除の到達順を記録し、保存や通知の先に来ていないことを示す。 */
        invalidateProviderSessionThread() {
          terminalOrder.push("provider-cleanup");
        },
        /** 保存済みの失敗通知を記録してから例外を投げ、通知失敗で掃除が抜けない条件を作る。 */
        notifySessionTurnTerminal(notification) {
          terminalNotifications.push(notification);
          terminalOrder.push("terminal-notification");
          throw new Error("notification failed");
        },
      },
    );

    const result = await service.runSessionTurn(session.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "お願いします",
    });
    await waitForCondition(
      () => turnUpdates.at(-1)?.phase === "failed",
      "failed最小turnが保存されること",
    );

    assert.equal(result.runState, "error");
    assert.equal(result.threadId, "thread-stale");
    assert.equal(storedSessions.at(-1)?.threadId, "thread-stale");
    assert.equal(turnUpdates.at(-1)?.phase, "failed");
    assert.equal(turnUpdates.at(-1)?.threadId, "thread-live");
    assert.equal(terminalNotifications.length, 1);
    assert.equal(terminalNotifications[0]?.outcome, "failed");
    assert.deepEqual(terminalNotifications[0]?.session, {
      ...storedSessions.at(-1),
      messageCount: storedSessions.at(-1)!.messages.length,
    });
    assert.deepEqual(terminalOrder, [
      "failed-upsert",
      "terminal-notification",
      "provider-cleanup",
    ]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "終端保存の例外は自動再保存やfailedへの置換をせず呼出元へ返す"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: appendTerminalSession / runSessionTurnInternal; docs/design/provider-adapter.md: 通常履歴と最小turn" }
  // fault = "終端保存例外をprovider失敗と扱い別のterminalを書き、未確定結果を成功またはfailedに隠す"
  // observable = "公開run APIのreject、terminal保存とProvider・通知の呼出数"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService terminal persistence failure boundary"
  // lifecycle = "permanent"
  // impact = "保存結果が不明な会話の重複や、完了済み応答の結果改変を防ぐ"
  // distinction = "Storage Workerのunknown outcome testはruntimeのcatchから二つ目の終端を保存する経路を通らない"
  // @end-test-value
  /** 終端保存から例外を受けた場合に、二度目の保存や通知を行わず、例外を呼び出し元へ伝えて Run を解放する。 */
  it("終端保存の例外を再保存せず返し、terminal通知をしない", async () => {
    const session = createSession();
    let providerCalls = 0;
    let terminalCalls = 0;
    let notifications = 0;
    const persistenceError = new Error("Persistence outcome unknown");
    const service = createProgressRuntime(
      session,
      async () => {
        providerCalls += 1;
        return createPartialResult({ assistantText: "completed" });
      },
      {
        /** 終端書込みの試行回数を数え、毎回、同じ永続化例外を投げる。 */
        appendTerminalSession() {
          terminalCalls += 1;
          throw persistenceError;
        },
        /** 保存に失敗しても通知してしまう回帰を通知回数から検出する。 */
        notifySessionTurnTerminal() {
          notifications += 1;
        },
      },
    );
    await assert.rejects(
      service.runSessionTurn(session.id, {
        userMessage: "run",
        executionOptions: TEST_EXECUTION_OPTIONS,
      }),
      (error) => error === persistenceError,
    );
    assert.equal(providerCalls, 1);
    assert.equal(terminalCalls, 1);
    assert.equal(notifications, 0);
    assert.equal(service.isRunInFlight(session.id), false);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Main/Auxの実行は終端保存中に当該Turnの送信位置検証用scopeを保持し、保存成否に関わらずreleaseする"
  // oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/974#受入条件検証" }
  // fault = "scopeの解放を保存成功側へ置くか、Main/Auxの片方でscopeを接続しない"
  // observable = "終端保存時のscopeのSession・incarnation・Turn、run終了後のscope解放回数"
  // observation_boundary = "component-behavior"
  // scope = "Main and Auxiliary runtime assembly / source-display scope lifetime"
  // lifecycle = "permanent"
  // impact = "照合前の本文破棄、または終了済みTurnの本文の長期残留を防ぐ"
  // distinction = "既存の終端保存失敗testは送信位置用scopeやMain/Auxのassemblyを通らない"
  // @end-test-value
  /** Main と Auxiliary の送信位置用スコープを、終端保存中は有効に保ち、保存の成功と失敗のどちらでも一度だけ解放する。 */
  it("Main/Auxの送信位置用scopeを終端保存の成否に関わらず解放する", async () => {
    for (const kind of ["main", "auxiliary"] as const) {
      const session = createSession({
        id: kind,
        incarnationId: `${kind}-incarnation`,
      });
      for (const fail of [false, true]) {
        const lost = new Error("Terminal persistence response lost");
        let active: readonly [string, string, string] | undefined;
        let persistedOwner: readonly [string, string, string] | undefined;
        let released = 0;
        const service = createProgressRuntime(
          session,
          async () => createPartialResult({ assistantText: "final text" }),
          {
            /** 発信元の ID・incarnation・Turn ID を現在所有者として記録し、解放時に消去する。 */
            beginSourceDisplayTurn(source, turnId) {
              active = [source.id, getSessionIncarnationId(source), turnId];
              return () => {
                active = undefined;
                released++;
              };
            },
            /** 非同期の終端保存中に見えるスコープを捕捉し、指定ケースで保存応答の喪失を再現する。 */
            async appendTerminalSession(next) {
              await Promise.resolve();
              persistedOwner = active;
              if (fail) throw lost;
              return next;
            },
          },
          (deps) =>
            assembleBackgroundEventRuntime(
              kind,
              deps,
              createSession({ id: `${kind}-parent` }),
            ),
        );
        const run = service.runSessionTurn(session.id, {
          userMessage: "run",
          executionOptions: TEST_EXECUTION_OPTIONS,
        });
        if (fail) await assert.rejects(run, (error) => error === lost);
        else await run;
        assert.deepEqual(persistedOwner, [
          session.id,
          getSessionIncarnationId(session),
          "1",
        ]);
        assert.equal(active, undefined);
        assert.equal(released, 1);
      }
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "取消deadlineで取得済みlive本文と操作を通常artifactへ保存し、未完了の操作statusをcanceledへ改変しない"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: buildCanceledPartialResult / waitForProviderTurnWithCancelDeadline; docs/design/provider-adapter.md: Error Handling / 通常履歴と最小turn" }
  // fault = "deadline partialを本文だけ保存するか、turnの取消を個別操作の確定結果として補完する"
  // observable = "返却Sessionの本文とoperationTimeline、最小turnのphase"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService cancellation deadline artifact"
  // lifecycle = "permanent"
  // impact = "途中出力と操作の実際の確定状態を保持する"
  // distinction = "Provider正常応答のpartial testではdeadlineのlive projection経路を通らない"
  // @end-test-value
  /** 取消期限を超えても、受け取り済みのライブ操作と途中本文を最終の通常成果物に退避する。 */
  it("取消deadlineは取得済みlive操作を通常artifactに保存する", async () => {
    const session = createSession();
    let progressSeen = false;
    let finishProvider!: (result: RunSessionTurnResult) => void;
    const providerEnd = new Promise<RunSessionTurnResult>((resolve) => {
      finishProvider = resolve;
    });
    const writes: CreateSessionTurnInput[] = [];
    const step = {
      id: "command-1",
      type: "command_execution",
      summary: "npm test",
      status: "in_progress",
      details: "取得済み出力",
      truncated: true,
    };
    const service = createProgressRuntime(
      session,
      async (input, progress) => {
        await emitTestProgress(
          progress,
          createLiveRunState({
            sessionId: input.session.id,
            assistantText: "途中本文",
            steps: [step],
          }),
        );
        progressSeen = true;
        return providerEnd;
      },
      {
        providerCancelGraceMs: 1,
        /** 期限切れの Run が保存した終端更新を記録して、途中結果との対応を確認できるようにする。 */ updateSessionTurn(
          _id,
          input,
        ) {
          writes.push(input);
        },
      },
    );
    const run = service.runSessionTurn(session.id, {
      userMessage: "run",
      executionOptions: TEST_EXECUTION_OPTIONS,
    });
    await waitForCondition(() => progressSeen, "provider live state");
    service.cancelRun(session.id);
    const result = await run;
    finishProvider(createPartialResult());
    assert.equal(writes[0]?.phase, "canceled");
    assert.match(result.messages.at(-1)?.text ?? "", /途中本文/);
    assert.deepEqual(result.messages.at(-1)?.artifact?.operationTimeline, [
      step,
    ]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Renderer死亡後の再openと保存待ち中closeでもMainの既存Provider実行は一度だけ継続し、Sessionの最終応答保存を待ってrun結果を返す"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md: Session Window Close; src-electron/session/session-runtime-service.ts: appendTerminalSession / runSessionTurnInternal" }
  // fault = "表示の復旧で既存turnをcancelまたは再実行するか、壊れたRendererへの通知例外でterminal応答保存を失う"
  // observable = "provider呼出し数、abort状態、保存gate前後のstoredSession/run結果の本文・runStateと保存待ち中のisRunInFlight"
  // observation_boundary = "public-boundary"
  // scope = "session-runtime-renderer-recovery-persistence"
  // lifecycle = "permanent"
  // impact = "provider応答を失うか、同じ作業を再実行して結果が二重化する"
  // distinction = "bridge単体のcloseとruntime単体の保存testを実際のrun Promiseで接続し、表示障害とterminal保存待ちの独立性を一つのturnで検証する"
  // @end-test-value
  /** Renderer が再開し、次いで保存中に Window を閉じられても、同じプロバイダー応答を一度だけ確定することを確認する。 */
  it("Rendererの再openと保存待ちcloseを越えてprovider応答を一度だけ保存する", async () => {
    let stored = createSession();
    let live: LiveSessionRunState | null = null;
    let finishProvider!: () => void;
    let finishSave!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      finishProvider = resolve;
    });
    const saveGate = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    let providerCalls = 0;
    let providerSignal: AbortSignal | undefined;
    let saveStarted = false;
    const turnUpdates: UpdateSessionTurnInput[] = [];
    /** 実 Window を作成せず、閉じる競合と Renderer 配信不可を本番のブリッジに再現する。 */
    class RuntimeWindow {
      destroyed = false;
      readonly closedListeners: Array<() => void> = [];
      readonly closeListeners: Array<
        (event: {
          /** 閉じるイベントのリスナーが、保存待ちの間に Window の閉鎖を一時保留できる。 */ preventDefault(): void;
        }) => void
      > = [];
      webContents = {
        /** Renderer が受信できない通知を送った場合に例外を発生させ、永続化と UI 配信を分離する。 */ send() {
          throw new Error("renderer unavailable");
        },
      };
      /** テストが閉鎖した Window が候補として再利用されないよう破棄フラグを返す。 */
      isDestroyed() {
        return this.destroyed;
      }
      /** 初回表示・再表示時に、Window を最小化状態として扱わない。 */
      isMinimized() {
        return false;
      }
      /** 見た目のウィンドウ操作はせず、永続化と close の競合だけを再現する。 */
      minimize() {}
      /** 最小化されない fixture のため、復元状態を変更しない。 */
      restore() {}
      /** 再表示時のフォーカス要求を、実デスクトップへは送らない。 */
      focus() {}
      /** Window の可視化要求を再現しても、実 UI を起動しない。 */
      show() {}
      /** ready-to-show の待機を実時刻に依存させず、登録操作だけを受け入れる。 */
      once(_event: "ready-to-show", _listener: () => void) {}
      /** 閉鎖を保留できるイベントを受け取る close リスナーの登録型。 */
      on(
        event: "close",
        listener: (event: {
          /** close の確定を止め、後続の永続化を待てるイベント操作。 */ preventDefault(): void;
        }) => void,
      ): void;
      /** 破棄完了後に引数なしで通知されるリスナーの登録型。 */
      on(event: "closed", listener: () => void): void;
      /** 閉鎖前の照会と破棄後通知のリスナーを分けて保持し、本番ブリッジを接続する。 */
      on(
        event: "close" | "closed",
        listener:
          | ((event: {
              /** 閉鎖前のコールバックが、その場でウィンドウを破棄させないための操作。 */ preventDefault(): void;
            }) => void)
          | (() => void),
      ) {
        if (event === "closed")
          this.closedListeners.push(listener as () => void);
        else
          this.closeListeners.push(
            listener as (event: {
              /** 閉鎖保留を要求できるリスナーの型を、破棄通知の型と区別する。 */ preventDefault(): void;
            }) => void,
          );
      }
      /** 閉鎖前の全リスナーへ保留機会を与え、誰も保留しなければ Window を破棄する。 */
      close() {
        let prevented = false;
        for (const listener of this.closeListeners)
          listener({
            /** この close 呼出しによる Window 破棄を保留する。 */
            preventDefault() {
              prevented = true;
            },
          });
        if (!prevented) this.destroy();
      }
      /** 破棄を一度だけ確定し、登録していた終了リスナーを一回ずつ呼ぶ。 */
      destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        for (const listener of this.closedListeners.splice(0)) listener();
      }
    }
    const windows: RuntimeWindow[] = [];
    const rendererObservers = new Map<
      RuntimeWindow,
      (state: "responsive" | "unresponsive" | "gone") => void
    >();
    const broadcast = new WindowBroadcastService({
      /** 開いていたテスト Window 全体を配信サービスの対象候補として返す。 */
      getAllWindows: () => windows,
      /** 専用 Session Window だけを作り、Home への重複配信は設けない。 */
      getHomeWindows: () => [],
      /** Home 不在を示し、Session Window が閉じた後に代替送信先を見つけさせない。 */
      getPrimaryHomeWindow: () => null,
      /** ライブ通知の候補として生成済みの Session Window を返す。 */
      getSessionWindows: () => windows,
      /** 独立した実行状況 Window を持たない環境を再現する。 */
      getLiveSessionRunStatusWindows: () => [],
      /** 現在の Session に紐付く Window を本番ブリッジで引き直し、再表示前の Window を使わない。 */
      getLiveSessionRunWindow: () => bridge.getWindow(stored.id),
    });
    const adapter: ProviderCodingAdapter = {
      /** Renderer の生存と無関係な固定プロンプトを返し、添付の解決を省く。 */
      composePrompt: () => ({
        systemBodyText: "system",
        inputBodyText: "input",
        logicalPrompt: {
          systemText: "system",
          inputText: "input",
          composedText: "system\ninput",
        },
        imagePaths: [],
        additionalDirectories: [],
      }),
      /** 再表示と終端保存の競合では利用枠テレメトリーを取得しない。 */
      getProviderQuotaTelemetry: async () => null,
      /** Window の再作成をプロバイダースレッド消去とは結び付けない。 */
      invalidateSessionThread: async () => {},
      /** Renderer が落ちた場合も全スレッド初期化を行わない fixture にする。 */
      invalidateAllSessionThreads: async () => {},
      /** 実行回数と中断シグナルを記録し、再表示後にゲートが解放されるまで同じ応答を保留する。 */
      runSessionTurn: async (input) => {
        providerCalls += 1;
        providerSignal = input.signal;
        await providerGate;
        return createPartialResult({
          assistantText: "durable provider response",
        });
      },
    };
    const service = createTestRuntime({
      /** Renderer の状態によらず、最後に永続化された Session を返す。 */
      getSession: () => stored,
      /** 実行中の通常 Session 更新を、次の Window を開く際にも参照できる形で保持する。 */
      upsertSession: (next) => {
        stored = next;
        return next;
      },
      /** 終端保存の開始を知らせ、Window を閉じる操作が競合するまで ACK を返さない。 */
      upsertTerminalSession: async (next) => {
        saveStarted = true;
        await saveGate;
        stored = next;
        return next;
      },
      /** Renderer 故障のケースで添付や Composer 検査が失敗しないようにする。 */
      resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
      /** ウィンドウを初期化するための既定正規化設定を供給する。 */
      getAppSettings: () => normalizeAppSettings({}),
      /** 固定の Codex テストモデルを対応するカタログとして提供する。 */
      resolveProviderCatalog: () => ({
        snapshot: { providers: [createProviderCatalog()] },
        provider: createProviderCatalog(),
      }),
      /** 再表示後も同じ実行回数・中断シグナルの記録を使うアダプターを返す。 */
      getProviderCodingAdapter: () => adapter,
      createSessionTurn: createSessionTurnBase,
      /** 完了を保存した回数を確認できるよう、Turn の更新内容を記録する。 */
      updateSessionTurn: (_id, input) => {
        turnUpdates.push(input);
      },
      /** Window を作り直す間も、最新版のライブ状態をメモリに格納する。 */
      setLiveSessionRun: (_id, next) => {
        live = next;
      },
      /** 新規 Window の初期投影に使用する現在のライブ状態を返す。 */
      getLiveSessionRun: () => live,
      /** 対話のない実行で承認を求められた場合は許可しない。 */
      waitForApprovalDecision: () => "deny",
      /** 閉鎖との競合に無関係な質問は自動で取り消す。 */
      waitForElicitationResponse: () => ({ action: "cancel" }),
      /** Window の閉鎖テストでは利用枠値を永続化しない。 */
      setProviderQuotaTelemetry() {},
      /** 閉鎖テストではコンテキスト計測を投影しない。 */
      setSessionContextTelemetry() {},
      /** Window が利用不可でも実プロバイダーのスレッドを操作しない。 */
      async invalidateProviderSessionThread() {},
      /** 保存完了後の利用枠再取得はタイマーに登録しない。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** 本番の配信サービスへ最新状態を渡し、利用できない Renderer での送信結果を実経路で扱う。 */
      broadcastLiveSessionRun: (id) =>
        broadcast.broadcastLiveSessionRun(id, live),
      /** このケースでは解決すべき保留承認を作らない。 */
      resolvePendingApprovalRequest() {},
      /** このケースでは保留質問を表示しないため、解消処理を追加しない。 */
      resolvePendingElicitationRequest() {},
    });
    const bridge = new SessionWindowBridge({
      /** 開き直しを観測できるよう、新しい代替 Window を作り全 Window の記録へ追加する。 */
      createWindow: () => {
        const window = new RuntimeWindow();
        windows.push(window);
        return window;
      },
      /** Window ごとの Renderer 状態監視を保持し、故障の発生順をテストから制御する。 */
      observeRendererState: (window, changed) => {
        rendererObservers.set(window, changed);
      },
      /** JavaScript の動作だけを検証するため、Renderer エントリのロードは不要にする。 */
      async loadChatEntry() {},
      /** 再表示のときブリッジが最後に保存された Session を参照できるようにする。 */
      getSession: () => stored,
      /** 閉鎖時の実行中判定は、調査対象の本番ランタイムへ委譲する。 */
      isRunInFlight: (id) => service.isRunInFlight(id),
      /** 実行中の Window を閉じる前の確認で、ユーザーが了承したと扱う。 */
      confirmCloseWhileRunning: () => true,
      /** 在室 Window ID の副次的な配信を省き、対象の Runtime とブリッジだけを検証する。 */
      broadcastOpenSessionWindowIds() {},
      /** Window 自体を Renderer の送信元識別子として使う。 */
      getWindowSender: (window) => window,
      /** Renderer が利用できない場合の下書きフラッシュ送信エラーを再現する。 */
      sendDraftFlushRequest() {
        throw new Error("renderer unavailable");
      },
      /** ブリッジが所有する停止依存先を、実ランタイムの全 Run 取消へ接続する。 */
      cancelInFlightSessionRuns: () => service.cancelAllRuns(),
    });
    const first = await bridge.openSessionWindow(stored.id);
    const turn = service.runSessionTurn(stored.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "start",
    });
    try {
      await waitForCondition(() => providerCalls === 1, "provider must start");
      rendererObservers.get(first)!("gone");
      const second = await bridge.openSessionWindow(stored.id);
      assert.notEqual(first, second);
      assert.equal(providerSignal?.aborted, false);
      finishProvider();
      await waitForCondition(
        () => saveStarted,
        "terminal persistence must start despite failing Renderer broadcasts",
      );
      assert.notEqual(
        stored.messages.at(-1)?.text,
        "durable provider response",
      );
      assert.equal(await bridge.requestCloseSessionWindow(stored.id), true);
      const third = await bridge.openSessionWindow(stored.id);
      assert.notEqual(second, third);
      assert.equal(providerSignal?.aborted, false);
      assert.equal(service.isRunInFlight(stored.id), true);
      finishSave();
      const result = await turn;
      assert.equal(providerCalls, 1);
      assert.equal(result.messages.at(-1)?.text, "durable provider response");
      assert.equal(stored.messages.at(-1)?.text, "durable provider response");
      assert.equal(stored.runState, "idle");
    } finally {
      finishProvider();
      finishSave();
      await turn;
      for (const window of windows) window.destroy();
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "completed結果はcleanup待機で失敗へ変わらず、process実終了の通知までruntimeの再送と未確認quitを保護する"
  // oracle = { type = "contract", ref = "docs/adr/002-provider-turn-terminal-and-cancellation.md#現在の適用範囲" }
  // fault = "adapterのcleanup completionをMainへ接続せず、completed保存後にadmission guardとquit保護を解放する"
  // observable = "返却SessionとTurn phase、isRunInFlight/hasInFlightRuns、live cancellationState、再送拒否、quit確認とDB close回数"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService adapter cleanup admission and quit boundary"
  // lifecycle = "permanent"
  // impact = "生存中のproviderと再送が競合し、未終了processを残したまま未確認終了する"
  // distinction = "transportやadapter単体testはMain callback結線とcompleted保存後のruntime/AppLifecycle保護を通らない。単一の遅延completionで結線を維持する"
  // @end-test-value
  /** Provider から完了が届いた後も、実際の後片付けを終えるまで同じ Session への再送とアプリ終了を保護する。 */
  it("completed後もprovider cleanupの実終了まで再送とquitを保護する", async () => {
    let stored = createSession();
    let live: LiveSessionRunState | null = null;
    let completeCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      completeCleanup = resolve;
    });
    let providerCalls = 0;
    const turnUpdates: UpdateSessionTurnInput[] = [];
    const adapter: ProviderCodingAdapter = {
      /** 完了と掃除の順序だけが変わるよう、固定プロンプトと空添付を返す。 */
      composePrompt: () => ({
        systemBodyText: "system",
        inputBodyText: "input",
        logicalPrompt: {
          systemText: "system",
          inputText: "input",
          composedText: "system\ninput",
        },
        imagePaths: [],
        additionalDirectories: [],
      }),
      /** Provider 掃除の検証では利用枠を取得しない。 */
      getProviderQuotaTelemetry: async () => null,
      /** 掃除完了待ちをスレッド無効化と混ぜないため、個別リセットを外部へ送らない。 */
      invalidateSessionThread: async () => {},
      /** 全スレッドの再初期化を準備せず、掃除ゲートで終了を制御する。 */
      invalidateAllSessionThreads: async () => {},
      /** 最初の Provider 呼出しだけ未完了の掃除 Promise を登録し、応答自体は直ちに返す。 */
      runSessionTurn: async (input) => {
        providerCalls += 1;
        if (providerCalls === 1) input.onCleanupPending?.(cleanup);
        return createPartialResult({ assistantText: "completed response" });
      },
    };
    const service = createTestRuntime({
      /** 完了後も再送の受付判定が参照する現在の Session を返す。 */
      getSession: () => stored,
      /** 実行中に保存したメッセージと終端状態を、再送時に読み直せるようにする。 */
      upsertSession: (next) => {
        stored = next;
        return next;
      },
      /** 掃除と再送の競合では画像や追加ファイルを使わない。 */
      resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
      /** 再送を受け付けられる既定の正規化済み設定を返す。 */
      getAppSettings: () => normalizeAppSettings({}),
      /** 最初の Run と解放後の再送で同じ Codex カタログを使用する。 */
      resolveProviderCatalog: () => ({
        snapshot: { providers: [createProviderCatalog()] },
        provider: createProviderCatalog(),
      }),
      /** 掃除が保留されたかを計測できるアダプターを返す。 */
      getProviderCodingAdapter: () => adapter,
      createSessionTurn: createSessionTurnBase,
      /** 保存された Turn の更新を比較用に記録し、掃除を待つ間の重複を確認する。 */
      updateSessionTurn: (_id, input) => {
        turnUpdates.push(input);
      },
      /** 完了のライブ表示と未解放の in-flight を区別できるよう、最新ライブ状態を保持する。 */
      setLiveSessionRun: (_id, next) => {
        live = next;
      },
      /** アプリ終了の照会が前提とする現在のライブ状態を返す。 */
      getLiveSessionRun: () => live,
      /** 実行を進める間の対話承認は不要とし、依存先を呼んでも許可しない。 */
      waitForApprovalDecision: () => "deny",
      /** 外部質問を待たず、取消で返す。 */
      waitForElicitationResponse: () => ({ action: "cancel" }),
      /** 再送と quit の順序を検証する間は利用枠を保存しない。 */
      setProviderQuotaTelemetry() {},
      /** 掃除終了待ちのケースでコンテキスト投影の状態を持たない。 */
      setSessionContextTelemetry() {},
      /** スレッド無効化と Provider cleanup の完了を別の境界にする。 */
      async invalidateProviderSessionThread() {},
      /** 終端後の利用枠再取得で掃除待機を増やさない。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** ライブ状態はメモリで観測し、別 Window へは送らない。 */
      broadcastLiveSessionRun() {},
      /** 実行が対話を発生させないため、保留承認の解消も不要とする。 */
      resolvePendingApprovalRequest() {},
      /** 質問がないケースなので、保留中の質問が解決された記録は取らない。 */
      resolvePendingElicitationRequest() {},
    });
    let quitConfirmations = 0;
    let storeCloses = 0;
    let quits = 0;
    const lifecycle = new AppLifecycleService({
      /** AppLifecycle の quit 判定へ、終端表示だけでなく実際の in-flight の有無を渡す。 */
      hasInFlightSessionRuns: () => service.hasInFlightRuns(),
      /** 実行中の quit を事前承認していない状態を返す。 */
      getAllowQuitWithInFlightRuns: () => false,
      /** 終了の特例を保存せず、各 quit 判定をその時の in-flight に従わせる。 */
      setAllowQuitWithInFlightRuns() {},
      /** 終了判定だけを検証し、Home Window を開かない。 */
      async createHomeWindow() {},
      /** 全 Window 閉鎖では自動終了させず、明示的な before-quit だけを駆動する。 */
      shouldQuitWhenAllWindowsClosed: () => false,
      /** まだ後片付け中に出た終了確認を数え、ユーザーが拒否したとして扱う。 */
      confirmQuitWhileRunning: () => {
        quitConfirmations += 1;
        return false;
      },
      /** 実後片付け後に永続ストアの閉鎖へ進んだ回数を記録する。 */
      closePersistentStores: () => {
        storeCloses += 1;
      },
      /** アプリの実終了は行わず、終了要求へ到達した回数だけを記録する。 */
      quitApp: () => {
        quits += 1;
      },
    });
    try {
      const result = await service.runSessionTurn(stored.id, {
        executionOptions: TEST_EXECUTION_OPTIONS,
        userMessage: "start",
      });
      assert.equal(result.runState, "idle");
      assert.equal(result.messages.at(-1)?.text, "completed response");
      await waitForCondition(
        () => turnUpdates.some((entry) => entry.phase === "completed"),
        "completed turn must persist while cleanup is pending",
      );
      assert.equal(
        turnUpdates.some((entry) => entry.phase === "failed"),
        false,
      );
      assert.equal(service.isRunInFlight(stored.id), true);
      assert.equal(service.hasInFlightRuns(), true);
      assert.equal(
        (live as LiveSessionRunState | null)?.cancellationState,
        "terminating",
      );
      await assert.rejects(
        service.runSessionTurn(stored.id, {
          executionOptions: TEST_EXECUTION_OPTIONS,
          userMessage: "too early",
        }),
        /already running/,
      );
      assert.equal(providerCalls, 1);
      await lifecycle.handleBeforeQuit({
        /** 掃除が残った最初の before-quit で既定の終了を保留できるイベントを与える。 */ preventDefault() {},
      });
      assert.equal(quitConfirmations, 1);
      assert.equal(storeCloses, 0);
      assert.equal(quits, 0);
      completeCleanup();
      await waitForCondition(
        () => !service.isRunInFlight(stored.id),
        "cleanup completion must release admission",
      );
      assert.equal(service.hasInFlightRuns(), false);
      assert.equal(
        (live as LiveSessionRunState | null)?.cancellationState,
        undefined,
      );
      const next = await service.runSessionTurn(stored.id, {
        executionOptions: TEST_EXECUTION_OPTIONS,
        userMessage: "after cleanup",
      });
      assert.equal(next.runState, "idle");
      assert.equal(providerCalls, 2);
      await lifecycle.handleBeforeQuit({
        /** 掃除を完了した後の before-quit を、同じイベント API で駆動する。 */ preventDefault() {},
      });
      assert.equal(quitConfirmations, 1);
      assert.equal(storeCloses, 1);
      assert.equal(quits, 1);
    } finally {
      completeCleanup();
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Codexの追加入力は捕捉したactive turnだけへ一度送信され、確定user本文をterminal保存へ維持する"
  // oracle = { type = "contract", ref = "Issue #780 explicit same-turn input" }
  // fault = "追加入力を新turnへ送る、重複送信する、またはterminalが受理済み本文を上書きする"
  // observable = "adapter steer要求と回数、公開API結果、保存済みmessage列、重複要求のreject"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService Codex steer admission and terminal persistence"
  // lifecycle = "permanent"
  // impact = "入力が別作業へ適用されるか受理済み会話を失う"
  // distinction = "adapter単体testではruntime排他とterminal保存の競合を検出しない"
  // @end-test-value
  /** ネイティブ Turn を指定した Codex Steer は一度だけ配信し、ACK 済み追加入力を終端保存に残し、遅い追加要求は拒否する。 */
  it("Codex steerは同turnへ一度送りterminalに受理済み入力を残す", async () => {
    let stored = createSession({ threadId: "thread-existing" });
    let live: LiveSessionRunState | null = null;
    let finishTurn!: () => void;
    const turnEnd = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    let finishInput!: () => void;
    const inputEnd = new Promise<void>((resolve) => {
      finishInput = resolve;
    });
    const sent: Array<
      Parameters<NonNullable<ProviderCodingAdapter["steerSessionTurn"]>>[0]
    > = [];
    const adapter: ProviderCodingAdapter = {
      /** Steer の配送と保存を比較するため、固定した初回プロンプトを構成する。 */
      composePrompt: () => ({
        systemBodyText: "system",
        inputBodyText: "input",
        logicalPrompt: {
          systemText: "system",
          inputText: "input",
          composedText: "system\ninput",
        },
        imagePaths: [],
        additionalDirectories: [],
      }),
      /** Steer の成否と無関係な利用枠を返さない。 */
      getProviderQuotaTelemetry: async () => null,
      /** 追加入力可能な既存スレッドの個別無効化では実 API を呼ばない。 */
      invalidateSessionThread: async () => {},
      /** 全スレッド無効化に伴う外部初期化はこのケースでは行わない。 */
      invalidateAllSessionThreads: async () => {},
      /** 入力可能なネイティブ Turn をライブ値に公開し、Steer の ACK と競合できるよう終端を待機する。 */
      runSessionTurn: async (input, progress) => {
        await emitTestProgress(progress, {
          ...createLiveRunState(),
          sessionId: input.session.id,
          threadId: "thread-existing",
          turnId: "turn-one",
          inputAvailable: true,
        });
        await turnEnd;
        return createPartialResult({
          threadId: "thread-existing",
          assistantText: "done",
        });
      },
      /** 実送信した追加入力を記録し、ACK を後から解放して同じネイティブ Turn を返す。 */
      steerSessionTurn: async (input) => {
        sent.push(input);
        await inputEnd;
        return { turnId: input.expectedTurnId };
      },
    };
    const service = createTestRuntime({
      /** 未確認と確認済みの追加入力を比較するため、最新の保存 Session を返す。 */
      getSession: () => stored,
      /** pending・confirmed の追加入力および終端保存をメモリに保持する。 */
      upsertSession: (next) => {
        stored = next;
        return next;
      },
      /** 通常送信と Steer の双方で、添付検査の失敗を追加しない。 */
      resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
      /** Codex の既定設定を返し、特別なレビューや添付条件を設定しない。 */
      getAppSettings: () => normalizeAppSettings({}),
      /** 入力可能な Codex Run を、既定モデルのカタログで開始する。 */
      resolveProviderCatalog: () => ({
        snapshot: { providers: [createProviderCatalog()] },
        provider: createProviderCatalog(),
      }),
      /** 追加入力を記録するテストアダプターを選択する。 */
      getProviderCodingAdapter: () => adapter,
      createSessionTurn: createSessionTurnBase,
      /** Steer 本文の永続化を観測し、Turn レコードの更新は別記録にしない。 */
      updateSessionTurn() {},
      /** 指定 Turn が入力可能かを示す最新ライブ状態を書き込む。 */
      setLiveSessionRun: (_id, next) => {
        live = next;
      },
      /** 追加入力の要求に対応するネイティブ Turn の現在値を返す。 */
      getLiveSessionRun: () => live,
      /** 追加入力のテストでは承認を自動許可しない。 */
      waitForApprovalDecision: () => "deny",
      /** Steer 以外の対話入力をなくすため、質問への回答は取り消す。 */
      waitForElicitationResponse: () => ({ action: "cancel" }),
      /** Codex の Steer 経路では利用枠の測定結果を保持しない。 */
      setProviderQuotaTelemetry() {},
      /** 追加入力の保存と別のコンテキスト通知を記録しない。 */
      setSessionContextTelemetry() {},
      /** Steer の ACK 後に実スレッドの消去を実行しない。 */
      async invalidateProviderSessionThread() {},
      /** 追加入力の完了を起点とした追加の利用枠処理を行わない。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** Steer 状態は fixture から直接読み、Window への通知は省く。 */
      broadcastLiveSessionRun() {},
      /** 対象 Turn に承認がないため、保留承認の解決は何もしない。 */
      resolvePendingApprovalRequest() {},
      /** 質問を発行しない Steer fixture では、保留質問の解消を通知しない。 */
      resolvePendingElicitationRequest() {},
    });
    const turn = service.runSessionTurn(stored.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "start",
    });
    await waitForCondition(
      () => live?.inputAvailable === true,
      "active turn accepts input",
    );
    await assert.rejects(
      service.steerSessionTurn(stored.id, {
        expectedTurnId: "different",
        userMessage: "wrong",
      }),
      /no longer accepts input/,
    );
    const steer = service.steerSessionTurn(stored.id, {
      expectedTurnId: "turn-one",
      userMessage: "additional",
    });
    await waitForCondition(() => sent.length === 1, "input dispatched");
    await assert.rejects(
      service.steerSessionTurn(stored.id, {
        expectedTurnId: "turn-one",
        userMessage: "duplicate",
      }),
      /already being sent/,
    );
    finishTurn();
    finishInput();
    assert.deepEqual(await steer, { turnId: "turn-one" });
    const completed = await turn;
    assert.deepEqual(
      completed.messages.map((message) => message.text),
      ["start", "additional", "done"],
    );
    assert.equal(sent[0]?.expectedTurnId, "turn-one");
    assert.equal(sent[0]?.userMessage, "additional");
    assert.equal(sent.length, 1);
    await assert.rejects(
      service.steerSessionTurn(stored.id, {
        expectedTurnId: "turn-one",
        userMessage: "late",
      }),
      /no longer accepts input/,
    );
  });

  // @test-value v2
  // kind = "contract"
  // claim = "queued steerは固定添付・実送信元・返信先を渡すが予約の会話枠を渡さず、append返信喪失でも本文と参照を維持する"
  // oracle = { type = "contract", ref = "docs/design/prompt-composition.md#metadataと必要時取得; GitHub Issue #801: current-turn queued input atomic commit and captured attachments" }
  // fault = "queued本文を再previewする、通常開始用の予約所属をSteerで出す、参照を予定値に差し替えるかcommit済み追加を終端で失う"
  // observable = "Provider入力内の添付・来歴・返信先・所属欄、重複拒否、appendへ届くqueue contextと返信先、terminalの未装飾本文・参照"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService.steerQueuedSessionTurn and terminal persistence"
  // lifecycle = "permanent"
  // impact = "保存済み入力が別pathへ変わるか終端履歴が失われる"
  // distinction = "通常steerとstorage単体testはqueued append返信喪失後のactive runtimeを確認できない"
  // @end-test-value
  /** キュー Steer は捕捉添付を使用し、追記 ACK を失っても確定済み本文と返信先を終端に一度だけ残すことを確認する。 */
  it("queued steerは捕捉添付とcommit済み入力をterminalへ維持する", async () => {
    let stored = createSession({ threadId: "thread-existing" });
    let live: LiveSessionRunState | null = null;
    let finishTurn!: () => void;
    const turnEnd = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    let finishPrepare!: () => void;
    const preparing = new Promise<void>((resolve) => {
      finishPrepare = resolve;
    });
    let verifying = false;
    const sent: Array<
      Parameters<NonNullable<ProviderCodingAdapter["steerSessionTurn"]>>[0]
    > = [];
    const adapter: ProviderCodingAdapter = {
      /** 初回送信に固定のプロンプトを与え、キュー固有の添付とは別にする。 */
      composePrompt: () => ({
        systemBodyText: "system",
        inputBodyText: "input",
        logicalPrompt: {
          systemText: "system",
          inputText: "input",
          composedText: "system\ninput",
        },
        imagePaths: [],
        additionalDirectories: [],
      }),
      /** キュー Steer の整合性を調べる間は利用枠の取得を省く。 */
      getProviderQuotaTelemetry: async () => null,
      /** 開始済みのスレッド ID は fixture 内に閉じ、実在の Provider へ削除を依頼しない。 */
      invalidateSessionThread: async () => {},
      /** 全スレッドの初期化を必要としないアダプターとして構成する。 */
      invalidateAllSessionThreads: async () => {},
      /** 入力可能な固定 Provider Turn を発行し、キュー Steer が競合するまで実行を保留する。 */
      runSessionTurn: async (input, progress) => {
        await emitTestProgress(progress, {
          ...createLiveRunState(),
          sessionId: input.session.id,
          threadId: "thread-existing",
          turnId: "provider-turn",
          inputAvailable: true,
        });
        await turnEnd;
        return createPartialResult({
          threadId: "thread-existing",
          assistantText: "done",
        });
      },
      /** キューが配送した入力と添付を記録し、指定された Provider Turn の ACK を返す。 */
      steerSessionTurn: async (input) => {
        sent.push(input);
        return { turnId: input.expectedTurnId };
      },
    };
    const receipt: SessionTurnQueueReceipt = {
      sessionId: stored.id,
      incarnationId: getSessionIncarnationId(stored),
      id: "queued-input",
      requestId: "queued-request",
      sequence: 1,
      queuePosition: 1,
      state: "starting",
      turnId: "1",
      inputTurnId: "provider-turn",
      userMessageSeq: null,
      reason: null,
      releasedAt: null,
      createdAt: "now",
      updatedAt: "now",
      captured: {
        request: {
          userMessage: "queued @captured",
          clientRequestId: "queued-request",
          executionOptions: TEST_EXECUTION_OPTIONS,
        },
        attachments: [
          {
            id: "captured",
            kind: "file",
            source: "text",
            absolutePath: "captured-path",
            displayPath: "captured",
            workspaceRelativePath: "captured",
            isOutsideWorkspace: false,
          },
        ],
        provider: stored.provider,
        workspacePath: stored.workspacePath,
      },
    };
    receipt.captured.origin = {
      kind: "session",
      actorKind: "main",
      actorSessionId: "actual-parent",
      actorIncarnationId: "parent-incarnation",
      actorTurnId: "15",
      operation: "send",
      targetSessionId: stored.id,
      targetIncarnationId: getSessionIncarnationId(stored),
    };
    const replyTo = {
      target: {
        kind: "main" as const,
        sessionId: "fixed-reply",
        incarnationId: "fixed-generation",
      },
      seq: 2,
      finalAnswerTurnId: "6",
    };
    receipt.captured.request.replyTo = replyTo;
    receipt.captured.request.mainConversationFrame = {
      kind: "main",
      sessionId: "reserved-peer",
      incarnationId: "peer-v1",
    };
    receipt.accepted = structuredClone(receipt.captured);
    receipt.dispatched = structuredClone(receipt.captured);
    const service = createTestRuntime({
      /** 追記の ACK が失われた場合も、コミット済み履歴を含む最新 Session を返す。 */
      getSession: () => stored,
      /** 開始・追加・終端で書いた Session が同じ保存先で観測できるようにする。 */
      upsertSession: (next) => {
        stored = next;
        return next;
      },
      /** 直接の初回送信だけをプレビューし、キュー本文が再プレビューされないことを確かめる。 */
      resolveComposerPreview: async (_, text) => {
        assert.equal(text, "start");
        return { attachments: [], errors: [] };
      },
      /** 捕捉時の添付一覧を照合し、添付検査をゲートで保留する。 */
      assertCapturedComposerAttachmentsAvailable: async (_, attachments) => {
        assert.deepEqual(attachments, receipt.captured.attachments);
        verifying = true;
        await preparing;
      },
      /** 追記の応答を失った場合に状態確認できる同じキュー受付を返す。 */
      getQueuedInputReceipt: () => receipt,
      /** 保存 Turn・キュー・Provider Turn と返信先を照合し、追記を確定してからコミット応答を失う。 */
      appendRunningInput: (session, text, localTurnId, context, reference) => {
        assert.equal(localTurnId, 1);
        assert.deepEqual(context, {
          queueId: receipt.id,
          inputTurnId: "provider-turn",
        });
        assert.deepEqual(reference, replyTo);
        stored = {
          ...stored,
          messages: [
            ...stored.messages,
            { role: "user", text, replyTo: reference },
          ],
        };
        receipt.state = "completed";
        throw new Error("append commit reply lost");
      },
      /** キュー Steer の実行に既定設定を与える。 */
      getAppSettings: () => normalizeAppSettings({}),
      /** 固定の既定モデルを含む Codex カタログを返す。 */
      resolveProviderCatalog: () => ({
        snapshot: { providers: [createProviderCatalog()] },
        provider: createProviderCatalog(),
      }),
      /** 捕捉済み入力の配送内容を記録できるアダプターを選択する。 */
      getProviderCodingAdapter: () => adapter,
      createSessionTurn: createSessionTurnBase,
      /** 追記の検証は受付と Session 履歴で行い、独立した Turn 更新は記録しない。 */
      updateSessionTurn() {},
      /** Provider Turn の入力可否を含む最新ライブ状態を保持する。 */
      setLiveSessionRun: (_id, next) => {
        live = next;
      },
      /** キュー Steer が参照する既存の入力可能な Turn を返す。 */
      getLiveSessionRun: () => live,
      /** キュー Steer へ追加の承認許可を与えない。 */
      waitForApprovalDecision: () => "deny",
      /** キュー Steer に無関係な質問は取り消す。 */
      waitForElicitationResponse: () => ({ action: "cancel" }),
      /** キュー追記の検証で利用枠投影を行わない。 */
      setProviderQuotaTelemetry() {},
      /** 追記の成否とコンテキスト計測を分け、計測値は保持しない。 */
      setSessionContextTelemetry() {},
      /** キュー受付の状態確認を実プロバイダースレッド操作へ波及させない。 */
      async invalidateProviderSessionThread() {},
      /** 追加入力後に利用枠を再取得するタイマーを設けない。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** ケース中の状態観測はメモリ内で行い、Renderer 配信を省く。 */
      broadcastLiveSessionRun() {},
      /** この経路で保留承認は生成されない。 */
      resolvePendingApprovalRequest() {},
      /** 質問のないキュー追記ではエリシテーション解消を記録しない。 */
      resolvePendingElicitationRequest() {},
    });
    const turn = service.runSessionTurn(stored.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "start",
    });
    await waitForCondition(
      () => live?.inputAvailable === true,
      "active queued input turn",
    );
    receipt.captured.request.replyTo = { ...replyTo, seq: 98 };
    const steer = service.steerQueuedSessionTurn(receipt, "provider-turn");
    await waitForCondition(() => verifying, "captured verification held");
    receipt.dispatched.request.replyTo = { ...replyTo, seq: 99 };
    await assert.rejects(
      service.steerQueuedSessionTurn(receipt, "provider-turn"),
      /already being sent/,
    );
    finishPrepare();
    await steer;
    assert.deepEqual(sent[0]?.attachments, receipt.captured.attachments);
    assert.match(sent[0]!.userMessage, /# Session Input\n\nqueued @captured/);
    assert.match(sent[0]!.userMessage, /Session: "actual-parent"/);
    assert.match(sent[0]!.userMessage, /Changed since acceptance: false/);
    assert.match(
      sent[0]!.userMessage,
      /# Reply To\n\nsessionId: "fixed-reply"\nincarnationId: "fixed-generation"\nseq: 2\nfinalAnswerTurnId: "6"\n\n# Session Input/,
    );
    assert.ok(!sent[0]!.userMessage.includes("# Message Identity"));
    assert.doesNotMatch(
      sent[0]!.userMessage,
      /# Conversation Thread|reserved-peer/,
    );
    assert.equal(sent.length, 1);
    finishTurn();
    const completed = await turn;
    assert.deepEqual(
      completed.messages.map((message) => message.text),
      ["start", "queued @captured", "done"],
    );
    assert.deepEqual(completed.messages[1]?.replyTo, replyTo);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "添付解決中に取消されたCodex steerはproviderへ送信せず会話本文へ追加しない"
  // oracle = { type = "contract", ref = "Issue #780 same-turn input cancellation fence" }
  // fault = "添付解決前だけturnを照合し、取消後に遅延inputをdispatchする"
  // observable = "steer公開APIのreject、adapter steer呼出回数、terminal message列"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService steer preparation cancellation"
  // lifecycle = "permanent"
  // impact = "取消後の入力が実行されるか送信未確定の本文を会話へ追加する"
  // distinction = "adapter単体testはruntimeの非同期添付解決を通らない"
  // @end-test-value
  /** 添付解決中に実行を取り消した場合、完了後の再照合で Codex への送信を止め、未送信本文を履歴に残さない。 */
  it("Codex steerは添付解決後も取消を照合し未送信本文を追加しない", async () => {
    let stored = createSession({ threadId: "thread-existing" });
    let live: LiveSessionRunState | null = null;
    let finishTurn!: () => void;
    const turnEnd = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    let releasePreview!: () => void;
    const previewGate = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    let previewStarted = false;
    let inputCalls = 0;
    const adapter: ProviderCodingAdapter = {
      /** 取消と添付解決の順だけを変えるため、初回のプロンプトを固定する。 */
      composePrompt: () => ({
        systemBodyText: "system",
        inputBodyText: "input",
        logicalPrompt: {
          systemText: "system",
          inputText: "input",
          composedText: "system\ninput",
        },
        imagePaths: [],
        additionalDirectories: [],
      }),
      /** 添付解決の競合では利用枠が未計測と扱う。 */
      getProviderQuotaTelemetry: async () => null,
      /** 競合の結果を実スレッドに反映しないよう、単一スレッドの無効化を空にする。 */
      invalidateSessionThread: async () => {},
      /** 個別の追加入力を検証するので、全スレッドの状態を持たない。 */
      invalidateAllSessionThreads: async () => {},
      /** 追加入力を受け付けるライブ状態を発行し、取消とプレビューの順序を制御できるようにする。 */
      runSessionTurn: async (input, progress) => {
        await emitTestProgress(progress, {
          ...createLiveRunState(),
          sessionId: input.session.id,
          threadId: "thread-existing",
          turnId: "turn-one",
          inputAvailable: true,
        });
        await turnEnd;
        return createPartialResult({
          threadId: "thread-existing",
          assistantText: "done",
        });
      },
      /** 取消後にも誤送信した場合を回数で検出する。 */
      steerSessionTurn: async (input) => {
        inputCalls += 1;
        return { turnId: input.expectedTurnId };
      },
    };
    const service = createTestRuntime({
      /** 競合の前後で、最新の履歴を持つ同じ Session を返す。 */
      getSession: () => stored,
      /** 実行開始や終端で上書きされた Session から、誤って追加した本文を検出可能にする。 */
      upsertSession: (next) => {
        stored = next;
        return next;
      },
      /** 競合対象の追加入力だけを添付解決中に止め、それ以外の本文の検査は通す。 */
      resolveComposerPreview: async (_session, text) => {
        if (text === "race") {
          previewStarted = true;
          await previewGate;
        }
        return { attachments: [], errors: [] };
      },
      /** Codex の選択は既定設定から解決する。 */
      getAppSettings: () => normalizeAppSettings({}),
      /** 添付解決を止めた間も利用可能な同じ Codex カタログを返す。 */
      resolveProviderCatalog: () => ({
        snapshot: { providers: [createProviderCatalog()] },
        provider: createProviderCatalog(),
      }),
      /** 送信回数で取消後の誤送信を検出するアダプターを選ぶ。 */
      getProviderCodingAdapter: () => adapter,
      createSessionTurn: createSessionTurnBase,
      /** この競合では独立した Turn 更新をアサーションの対象にしない。 */
      updateSessionTurn() {},
      /** 入力可否の切替に使うライブ状態を保存する。 */
      setLiveSessionRun: (_id, next) => {
        live = next;
      },
      /** 添付解決後に確認される現在の入力可能状態を返す。 */
      getLiveSessionRun: () => live,
      /** 取消と競合する追加送信には、対話の承認を加えない。 */
      waitForApprovalDecision: () => "deny",
      /** テスト対象外の質問に対しては取消を返す。 */
      waitForElicitationResponse: () => ({ action: "cancel" }),
      /** 添付ゲートの検証では利用枠計測を保存しない。 */
      setProviderQuotaTelemetry() {},
      /** コンテキスト計測を更新せず、追加入力の有無だけを観測する。 */
      setSessionContextTelemetry() {},
      /** 取消で実スレッドに対する無効化を起動しない。 */
      async invalidateProviderSessionThread() {},
      /** 取消の順序を調べる間、利用枠の再取得は省略する。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** ライブ変化を直接保持し、実 Window へ通知しない。 */
      broadcastLiveSessionRun() {},
      /** 個別承認要求が存在しないため、解決として処理しない。 */
      resolvePendingApprovalRequest() {},
      /** 保留質問を作らないケースなので、質問解決は記録しない。 */
      resolvePendingElicitationRequest() {},
    });
    const turn = service.runSessionTurn(stored.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "start",
    });
    await waitForCondition(() => live?.inputAvailable === true, "active turn");
    const steer = service.steerSessionTurn(stored.id, {
      expectedTurnId: "turn-one",
      userMessage: "race",
    });
    await waitForCondition(() => previewStarted, "steer preview held");
    service.cancelRun(stored.id);
    const rejected = assert.rejects(steer, /no longer accepts input/);
    finishTurn();
    const result = await turn;
    releasePreview();
    await rejected;
    assert.equal(inputCalls, 0);
    assert.equal(
      result.messages.some((message) => message.text === "race"),
      false,
    );
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Codexのthread復帰失敗は同じ保存threadを保持して一度の失敗として返し、自動新規threadへ切り替えない"
  // oracle = { type = "contract", ref = "Issue #780 no silent session replacement" }
  // fault = "stale errorでthreadを消すか、新規threadを作るため再試行する"
  // observable = "provider呼出回数、thread reset回数、失敗SessionのthreadとrunFailure"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService Codex resume failure"
  // lifecycle = "permanent"
  // impact = "既存のprovider会話を黙って別の会話へ置換する"
  // distinction = "adapter単体testでは上位runtimeによるretryを検出しない"
  // @end-test-value
  /** Codex の明示復帰が失敗した場合に、保存済みスレッドを維持し、スレッドリセットや自動再試行を行わないことを確かめる。 */
  it("Codex復帰失敗では保存threadを保持し自動retryしない", async () => {
    let stored = createSession({ threadId: "thread-existing" });
    let attempts = 0;
    let resets = 0;
    const adapter: ProviderCodingAdapter = {
      /** 復帰先の ID 以外を一定にするため、固定プロンプトと空の添付を返す。 */
      composePrompt: () => ({
        systemBodyText: "system",
        inputBodyText: "input",
        logicalPrompt: {
          systemText: "system",
          inputText: "input",
          composedText: "system\ninput",
        },
        imagePaths: [],
        additionalDirectories: [],
      }),
      /** 復帰例外の判定は利用枠計測を参照しない。 */
      getProviderQuotaTelemetry: async () => null,
      /** アダプター側のスレッド無効化で外部接続しない。 */
      invalidateSessionThread: async () => {},
      /** 全スレッドのリセットは、保存済みスレッドの維持検証と独立させる。 */
      invalidateAllSessionThreads: async () => {},
      /** 部分結果のない thread-not-found を投げ、試行回数を数えて再試行を検出する。 */
      runSessionTurn: async () => {
        attempts += 1;
        throw new ProviderTurnError(
          "thread not found",
          createPartialResult(),
          false,
        );
      },
    };
    const service = createTestRuntime({
      /** 復帰直前のスレッドを持つ現在の保存 Session を返す。 */
      getSession: () => stored,
      /** 失敗で保存されたスレッドとエラー表示を読み戻せるようにする。 */
      upsertSession: (next) => {
        stored = next;
        return next;
      },
      /** 復帰例外だけが失敗原因になるよう、添付検証は成功にする。 */
      resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
      /** 保存済み Codex スレッドを利用する既定の実行設定を供給する。 */
      getAppSettings: () => normalizeAppSettings({}),
      /** 復帰時のモデルが見つかるテスト用 Codex カタログを返す。 */
      resolveProviderCatalog: () => ({
        snapshot: { providers: [createProviderCatalog()] },
        provider: createProviderCatalog(),
      }),
      /** 最初の復帰試行と、もし実行された場合の再試行を同じアダプターで数える。 */
      getProviderCodingAdapter: () => adapter,
      createSessionTurn: createSessionTurnBase,
      /** 復帰エラーは Session の最終メッセージで比較し、別の Turn 記録は作らない。 */
      updateSessionTurn() {},
      /** この復帰エラー fixture はライブ進捗を公開しない。 */
      setLiveSessionRun() {},
      /** エラーから補えるスレッドを進捗として持たないケースにする。 */
      getLiveSessionRun: () => null,
      /** 復帰障害の検証では承認許可を発行しない。 */
      waitForApprovalDecision: () => "deny",
      /** 対話のないエラー経路では質問をキャンセルする。 */
      waitForElicitationResponse: () => ({ action: "cancel" }),
      /** 保存済みスレッドのリセット処理に到達した回数を記録する。 */
      resetProviderSessionThread: () => {
        resets += 1;
      },
      /** 復帰失敗時の利用枠は観測対象にしない。 */
      setProviderQuotaTelemetry() {},
      /** コンテキスト計測値を持たないエラー fixture にする。 */
      setSessionContextTelemetry() {},
      /** 外部スレッドの無効化を起動せず、復帰リセットの回数を別に観測する。 */
      async invalidateProviderSessionThread() {},
      /** 復帰失敗から利用枠計測のタイマーを追加しない。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** 復帰時の保存結果を直接調べるため、Window 通知は発行しない。 */
      broadcastLiveSessionRun() {},
      /** 保留承認を生成しない復帰条件を維持する。 */
      resolvePendingApprovalRequest() {},
      /** 保留質問を生成しないため、その解決処理も不要とする。 */
      resolvePendingElicitationRequest() {},
    });
    const result = await service.runSessionTurn(stored.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "resume",
    });
    assert.equal(attempts, 1);
    assert.equal(resets, 0);
    assert.equal(result.threadId, "thread-existing");
    assert.equal(result.runState, "error");
    assert.equal(result.messages.at(-1)?.runFailure, "thread not found");
  });
  // @test-value v2
  // kind = "contract"
  // claim = "Claude個別要求取消は共通pending表示とresolverを解放してから後続を表示し、古い回答を拒否する"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md; Issue #751 F751-1" }
  // fault = "SDKのみ取消してpendingを残す、queueを先に進めて上書きする、または旧requestIdへの回答を新要求へ適用する"
  // observable = "共通serviceのlive要求IDと解除通知列、古い回答の例外、SDK判断、turn完了"
  // observation_boundary = "public-boundary"
  // scope = "ClaudeAdapter through SessionRuntimeService and shared pending services"
  // lifecycle = "permanent"
  // impact = "回答待ちの後続承認・質問が停止する、または取消済み操作の回答が別操作へ誤適用される"
  // distinction = "adapter単独mockはMainのsignal接続と実pending cleanupを迂回するためこの軽量統合testで検査する"
  // @end-test-value
  /** Claude の個別 AbortSignal が保留承認・質問だけを解除し、後続要求を処理できる一方、Turn 全体の取消では残りを回収することを確認する。 */
  it("Claude個別取消は共通pendingを解除し、後続要求とturn全体取消を区別する", async () => {
    let stored = createSession({
      provider: "claude",
      workspacePath: process.cwd(),
      approvalMode: "on-request",
    });
    let live: LiveSessionRunState | null = null;
    const displayed: Array<string | null> = [];
    /** 共通のライブ状態を更新し、公開された承認・質問の要求 ID を順に記録する。 */
    const update = (
      _id: string,
      recipe: (current: LiveSessionRunState) => LiveSessionRunState,
    ) => {
      live = recipe(live!);
      displayed.push(
        live.approvalRequest?.requestId ??
          live.elicitationRequest?.requestId ??
          null,
      );
      return live;
    };
    const approvals = new SessionApprovalService({
      updateLiveSessionRun: update,
    });
    const questions = new SessionElicitationService({
      updateLiveSessionRun: update,
    });
    /** SDK コールバックへ渡す toolUseID と個別 AbortSignal を組み立てる。 */
    const context = (id: string, signal: AbortSignal) =>
      ({ toolUseID: id, signal }) as Parameters<
        NonNullable<Options["canUseTool"]>
      >[2];
    let service!: SessionRuntimeService;
    let turnCancelObservation:
      | Promise<{
          behavior: string | null;
          approvalRequest: LiveApprovalRequest | null | undefined;
        }>
      | undefined;
    const adapter = new ClaudeAdapter({
      query: (({ options }: { options: Options }) =>
        (async function* () {
          const canceled = new AbortController();
          const first = options.canUseTool!(
            "Bash",
            { command: "first" },
            context("first", canceled.signal),
          );
          const queued = new AbortController();
          const skipped = options.canUseTool!(
            "Bash",
            { command: "queued" },
            context("queued", queued.signal),
          );
          const second = options.canUseTool!(
            "AskUserQuestion",
            {
              questions: [{ question: "Choose", options: [{ label: "yes" }] }],
            },
            context("second", new AbortController().signal),
          );
          await waitForCondition(
            () => live?.approvalRequest?.requestId === "first",
            "first approval displayed",
          );
          queued.abort();
          canceled.abort();
          assert.deepEqual(await first, {
            behavior: "deny",
            message: "Canceled",
          });
          assert.deepEqual(await skipped, {
            behavior: "deny",
            message: "Canceled",
          });
          await waitForCondition(
            () => live?.elicitationRequest?.requestId === "second",
            "second question displayed after cleanup",
          );
          assert.deepEqual(displayed.slice(0, 3), ["first", null, "second"]);
          assert.throws(
            () => approvals.resolveLiveApproval(stored.id, "first", "approve"),
            /no longer exists/,
          );
          const questionCanceled = new AbortController();
          const third = options.onElicitation!(
            {
              mode: "form",
              serverName: "test",
              message: "Third",
              requestedSchema: {
                type: "object",
                properties: { answer: { type: "string" } },
              },
            } as Parameters<NonNullable<Options["onElicitation"]>>[0],
            {
              requestId: "third",
              signal: questionCanceled.signal,
            } as Parameters<NonNullable<Options["onElicitation"]>>[1],
          );
          questions.resolveLiveElicitation(stored.id, "second", {
            action: "accept",
            content: { "0": "yes" },
          });
          const secondDecision = await second;
          assert.ok(secondDecision);
          assert.equal(secondDecision.behavior, "allow");
          await waitForCondition(
            () => live?.elicitationRequest?.requestId === "third",
            "third question displayed",
          );
          const fourth = options.canUseTool!(
            "Bash",
            { command: "fourth" },
            context("fourth", new AbortController().signal),
          );
          questionCanceled.abort();
          assert.deepEqual(await third, { action: "cancel" });
          await waitForCondition(
            () => live?.approvalRequest?.requestId === "fourth",
            "fourth approval displayed",
          );
          assert.throws(
            () =>
              questions.resolveLiveElicitation(stored.id, "third", {
                action: "accept",
              }),
            /no longer exists/,
          );
          assert.deepEqual(displayed.slice(-3), ["third", null, "fourth"]);
          turnCancelObservation = fourth.then((decision) => ({
            behavior: decision?.behavior ?? null,
            approvalRequest: live?.approvalRequest,
          }));
          service.cancelRun(stored.id);
          await turnCancelObservation;
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "done",
            session_id: "thread",
          } as SDKMessage;
        })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    service = createTestRuntime({
      /** 取消前後に共有する保存済み Claude Session を返す。 */
      getSession: () => stored,
      /** Claude の応答と停止処理で更新された Session をメモリに保持する。 */
      upsertSession: (next) => {
        stored = next;
        return next;
      },
      /** Claude の実質問と承認だけを検証し、添付は持たない状態にする。 */
      resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
      /** Claude を有効にして SDK の実行経路を選ぶ。 */
      getAppSettings: () =>
        normalizeAppSettings({
          codingProviderSettings: { claude: { enabled: true } },
        }),
      /** 実 Claude アダプターを開始できる既定モデル付きカタログを用意する。 */
      resolveProviderCatalog: () => ({
        snapshot: { providers: [createProviderCatalog("claude")] },
        provider: createProviderCatalog("claude"),
      }),
      /** 個別キャンセルを実コールバックで処理する Claude アダプターを返す。 */
      getProviderCodingAdapter: () => adapter,
      createSessionTurn: createSessionTurnBase,
      /** このケースは承認・質問の発行順を比較し、Turn レコードを別途記録しない。 */
      updateSessionTurn() {},
      /** Claude の個別取消で変化したライブ状態を最新値として書き込む。 */
      setLiveSessionRun: (_id, next) => {
        live = next;
      },
      /** 次の承認または質問の有無を直接確認できる現在の状態を返す。 */
      getLiveSessionRun: () => live,
      /** 個別 AbortSignal を渡して、本番承認サービスの待機を開始する。 */
      waitForApprovalDecision: (id, request, signal) =>
        approvals.waitForLiveApprovalDecision(id, request, signal),
      /** 個別 AbortSignal と質問 ID を維持して、本番質問サービスで返答を待つ。 */
      waitForElicitationResponse: (id, request, signal) =>
        questions.waitForLiveElicitationResponse(id, request, signal),
      /** Claude 個別取消時の利用枠を保存しない。 */
      setProviderQuotaTelemetry() {},
      /** 個別取消と別のコンテキスト計測の状態は持たない。 */
      setSessionContextTelemetry() {},
      /** 個別要求の取消に、外部のプロバイダースレッド無効化を追加しない。 */
      async invalidateProviderSessionThread() {},
      /** このケースの完了後に利用枠を再取得するタイマーは作らない。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** 要求の発行順はメモリで比較し、Window には再配信しない。 */
      broadcastLiveSessionRun() {},
      /** 現在表示中の承認だけを、その要求 ID に対する決定で解決する。 */
      resolvePendingApprovalRequest: (id, decision) => {
        if (live?.approvalRequest)
          approvals.resolveLiveApproval(
            id,
            live.approvalRequest.requestId,
            decision,
          );
      },
      /** 現在表示中の質問だけを、その要求 ID に対する回答で解決する。 */
      resolvePendingElicitationRequest: (id, response) => {
        if (live?.elicitationRequest)
          questions.resolveLiveElicitation(
            id,
            live.elicitationRequest.requestId,
            response,
          );
      },
    });
    const completed = await service.runSessionTurn(stored.id, {
      executionOptions: captureSessionExecutionOptions(stored),
      userMessage: "test",
    });
    assert.equal(completed.status, "idle");
    assert.equal(
      completed.runState,
      "idle",
      "request assertions must not become a failed provider outcome",
    );
    assert.ok(turnCancelObservation, "turn-wide cancellation was reached");
    assert.deepEqual(await turnCancelObservation, {
      behavior: "deny",
      approvalRequest: null,
    });
    assert.ok(!displayed.includes("queued"));
  });

  // @test-value v2
  // kind = "contract"
  // claim = "送信開始時に更新されたCharacter定義snapshotはClaudeの継続・明示resume appendへ反映する"
  // oracle = { type = "contract", ref = "docs/design/prompt-composition.md; Issue #775; Issue #751 T751-3" }
  // fault = "runtimeが更新前Sessionをadapterへ渡す、またはClaudeが前turnのsystem appendを使い続ける"
  // observable = "SDK queryのresume値・append内のturn固有Character定義、および保存snapshot identityとmetadata"
  // observation_boundary = "public-boundary"
  // scope = "Main runtime send-time refresh through Claude SDK query boundary"
  // lifecycle = "permanent"
  // impact = "Character編集が継続会話へ反映されず、ユーザーの設定に反する応答になる"
  // distinction = "canonical snapshot更新単体testとadapter単体testの間にあるruntime配線を、実composerとSDK query captureで確認する"
  // @end-test-value
  /** 次の送信時に取得した Character 定義が Claude プロンプトへ反映され、明示復帰では新しい定義を append しつつ保存済み公開プロフィールを維持することを確認する。 */
  it("送信時Character更新をClaudeの次turn・明示resume appendへ接続する", async () => {
    let stored = createSession({
      provider: "claude",
      workspacePath: process.cwd(),
      approvalMode: "on-request",
    });
    let current = "old";
    const seen: Options[] = [];
    /** SDK のプロンプトおよびオプションを記録する query スタブを備えた実 Claude アダプターを作る。 */
    const makeAdapter = () =>
      new ClaudeAdapter({
        query: (({
          options,
          prompt,
        }: {
          options: Options;
          prompt: AsyncIterable<SDKUserMessage>;
        }) => {
          seen.push(options);
          return (async function* () {
            const sent = await prompt[Symbol.asyncIterator]().next();
            assert.ok(!sent.done);
            yield {
              type: "result",
              subtype: "success",
              is_error: false,
              result: "done",
              session_id: "fresh-thread",
              user_message_uuid: sent.value.uuid,
              usage: { input_tokens: 1, output_tokens: 1 },
              modelUsage: {},
            } as SDKMessage;
            yield {
              type: "system",
              subtype: "session_state_changed",
              state: "idle",
              session_id: "fresh-thread",
            } as SDKMessage;
          })();
        }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query,
      });
    let adapter = makeAdapter();
    const service = createTestRuntime({
      /** 連続送信のたびに、直前の保存を反映した Session を返す。 */
      getSession: () => stored,
      /** Run の保存先を更新し、次の Turn で前回のスレッドを読み戻せるようにする。 */
      upsertSession: (next) => {
        stored = next;
        return next;
      },
      /** 保存済みの名前・説明を保持しつつ、Run のたびに異なる定義本文をスナップショットに設定する。 */
      resolveRuntimeSessionForTurn: (session) => ({
        ...session,
        characterRuntimeSnapshot: {
          characterId: "char-a",
          name: "Saved name",
          description: "Saved description",
          iconFilePath: "",
          theme: { main: "#112233", sub: "#445566" },
          definitionMarkdown: `Definition ${current}`,
          definitionSha256: current,
          definitionByteSize: current.length,
          snapshotAt: "2026-10-03T00:00:00Z",
        },
      }),
      /** Character 定義の差替えを添付やプレビューエラーと交差させない。 */
      resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
      /** Claude の実プロンプト組み立てを通すためプロバイダーを有効にする。 */
      getAppSettings: () =>
        normalizeAppSettings({
          codingProviderSettings: { claude: { enabled: true } },
        }),
      /** 新規実行と明示復帰で同じ Claude モデルを選べるようにする。 */
      resolveProviderCatalog: () => ({
        snapshot: { providers: [createProviderCatalog("claude")] },
        provider: createProviderCatalog("claude"),
      }),
      /** 試行時点で選択した Claude アダプターを実行に渡す。 */
      getProviderCodingAdapter: () => adapter,
      createSessionTurn: createSessionTurnBase,
      /** Character 定義の保存比較は Session のスナップショットから行い、Turn 差分は別記録にしない。 */
      updateSessionTurn() {},
      /** プロンプトの比較にライブ表示は必要としない。 */
      setLiveSessionRun() {},
      /** このテストではライブ進捗がなくても、Claude の送信と復帰を確認できるようにする。 */
      getLiveSessionRun: () => null,
      /** Character 更新を理由に承認拒否以外の決定は追加しない。 */
      waitForApprovalDecision: () => "deny",
      /** Character 更新の過程で質問があれば取消として扱う。 */
      waitForElicitationResponse: () => ({ action: "cancel" }),
      /** 利用枠の保存をプロンプト差分に混ぜない。 */
      setProviderQuotaTelemetry() {},
      /** Context 計測を保存せず、Character 定義のスナップショットだけを比較する。 */
      setSessionContextTelemetry() {},
      /** 実行時の定義差替えが外部スレッド無効化を呼ぶことを前提にしない。 */
      async invalidateProviderSessionThread() {},
      /** 連続送信の間に利用枠再取得のタイマーを追加しない。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** Claude の送信内容を SDK スタブで記録し、Window 通知は使わない。 */
      broadcastLiveSessionRun() {},
      /** 承認が発行されない実行で保留承認を解決しない。 */
      resolvePendingApprovalRequest() {},
      /** 質問が存在しない実行で保留質問の解消は行わない。 */
      resolvePendingElicitationRequest() {},
    });
    for (const [index, marker] of ["old", "new", "resumed"].entries()) {
      current = marker;
      if (index === 2) adapter = makeAdapter();
      const completed = await service.runSessionTurn(stored.id, {
        executionOptions: captureSessionExecutionOptions(stored),
        userMessage: marker,
      });
      assert.equal(
        completed.runState,
        "idle",
        JSON.stringify(completed.messages),
      );
      assert.equal(
        seen[index].resume,
        index === 0 ? undefined : "fresh-thread",
      );
      const system = seen[index].systemPrompt;
      assert.ok(
        system &&
          typeof system === "object" &&
          !Array.isArray(system) &&
          system.type === "preset",
      );
      assert.match(system.append!, new RegExp(`Definition ${marker}`));
      for (const other of ["old", "new", "resumed"].filter(
        (value) => value !== marker,
      )) {
        assert.doesNotMatch(system.append!, new RegExp(`Definition ${other}`));
      }
      assert.equal(completed.characterRuntimeSnapshot?.characterId, "char-a");
      assert.equal(completed.characterRuntimeSnapshot?.name, "Saved name");
      assert.equal(
        completed.characterRuntimeSnapshot?.description,
        "Saved description",
      );
    }
  });
  // @test-value v2
  // kind = "contract"
  // claim = "取消はsetup・provider・終端保存の終了待ちをliveへ投影し、保存済みexact Turn IDを実解放まで保持してから次Turn IDへ切り替える"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-run-cancel" }
  // fault = "取消連打で通知を二重化する、未終了中にSendやexact Turn ID解放を許可する、終了通知が欠ける、または次turnへ旧応答/IDを混入する"
  // observable = "live取消状態とbroadcast、Send結果、provider呼出件数、保存message列、getUnreleasedTurnIdsの保持・解放・次ID"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService cancellation lifecycle"
  // lifecycle = "permanent"
  // impact = "取消済み表示なのにSendを拒否する状態や、履歴欠損・同一会話の二重実行を防ぐ"
  // distinction = "既存deadline testのguard確認に加え、live解除通知・連打の冪等性・実Send再開をdeferred境界で確認する"
  // @end-test-value
  /** 受付・準備・実行・終端の各取消を連打や遅い成否と競合させ、実際の解放までは取消状態を表示して次の送信を止める。 */
  it("取消待ちを実終了まで投影し、単発・連打後の次Sendを安全に再開する", async () => {
    for (const phase of [
      "admission",
      "setup",
      "provider",
      "terminal",
    ] as const) {
      for (const lateOutcome of ["resolve", "reject"] as const) {
        let stored = createSession();
        let live: LiveSessionRunState | null = null;
        const broadcasts: Array<LiveSessionRunState | null> = [];
        let releaseGate!: () => void;
        const gate = new Promise<void>((resolve) => {
          releaseGate = resolve;
        });
        let announceGate!: () => void;
        const gateReady = new Promise<void>((resolve) => {
          announceGate = resolve;
        });
        let resolveProvider!: (result: RunSessionTurnResult) => void;
        let rejectProvider!: (error: Error) => void;
        let providerCalls = 0;
        let emitLateProgress: (() => void) | undefined;
        let announceNext!: () => void;
        const nextReady = new Promise<void>((resolve) => {
          announceNext = resolve;
        });
        let finishNext!: (result: RunSessionTurnResult) => void;
        /** 遅延中の古い実行と、新たな送信のライブ状態をその都度読み直す。 */
        const readLive = (): LiveSessionRunState | null => live;
        const adapter: ProviderCodingAdapter = {
          /** 取消の段階だけが実行結果へ影響するよう、固定プロンプトと空の追加情報を返す。 */
          composePrompt: () => ({
            systemBodyText: "system",
            inputBodyText: "input",
            logicalPrompt: {
              systemText: "system",
              inputText: "input",
              composedText: "system\ninput",
            },
            imagePaths: [],
            additionalDirectories: [],
          }),
          /** 各段階の取消と利用枠計測を分け、計測値を返さない。 */
          async getProviderQuotaTelemetry() {
            return null;
          },
          /** 反復する取消で実プロバイダースレッドの削除を起こさない。 */
          async invalidateSessionThread() {},
          /** スレッド全消去を介さず、保留中の実行を明示したゲートから解放する。 */
          async invalidateAllSessionThreads() {},
          /** Provider での保留・成功・失敗を切り替え、次の要求には専用ゲートを用いる。 */
          runSessionTurn(input, onProgress) {
            providerCalls += 1;
            if (input.userMessage === "next request") {
              announceNext();
              return new Promise<RunSessionTurnResult>((resolve) => {
                finishNext = resolve;
              });
            }
            if (phase === "provider" && providerCalls === 1) {
              emitLateProgress = () => {
                void emitTestProgress(
                  onProgress,
                  createLiveRunState({
                    sessionId: stored.id,
                    assistantText: "old late progress",
                  }),
                );
              };
              announceGate();
              return new Promise<RunSessionTurnResult>((resolve, reject) => {
                resolveProvider = resolve;
                rejectProvider = reject;
              });
            }
            return Promise.resolve(
              createPartialResult({ assistantText: "completed answer" }),
            );
          },
        };
        let firstAdmission = true;
        let firstSetup = true;
        let firstTerminal = true;
        let nextTurnId = 1;
        const savedPhases: Array<UpdateSessionTurnInput["phase"]> = [];
        const service = createTestRuntime({
          providerCancelGraceMs: 5,
          /** 受付段階が対象のときだけ最初の排他を保留し、次の受付は直接実行する。 */
          async runSessionAdmissionExclusive(_id, operation) {
            if (phase === "admission" && firstAdmission) {
              firstAdmission = false;
              announceGate();
              await gate;
            }
            return operation();
          },
          /** 取消後に保存された状態を含む現在の Session を返す。 */
          getSession: () => stored,
          /** 仮反映および完了以外の Session の書込みを保持する。 */
          upsertSession: (next) => {
            stored = next;
            return next;
          },
          /** 終端段階が対象の場合だけ、初回終端の ACK を止めて取消を競合させる。 */
          async upsertTerminalSession(next, terminal) {
            if (phase === "terminal" && firstTerminal) {
              firstTerminal = false;
              announceGate();
              await gate;
            }
            stored = next;
            savedPhases.push(terminal.phase);
            return next;
          },
          /** 準備段階が対象のときだけ最初の添付検査を保留し、以後はエラーのない結果を返す。 */
          async resolveComposerPreview() {
            if (phase === "setup" && firstSetup) {
              firstSetup = false;
              announceGate();
              await gate;
            }
            return { attachments: [], errors: [] };
          },
          /** 段階ごとの差を設定ではなく待機位置に限定する。 */
          getAppSettings: () => normalizeAppSettings({}),
          /** 共通の Codex カタログで、保留前後のモデル選択を同じにする。 */
          resolveProviderCatalog: () => ({
            snapshot: { providers: [createProviderCatalog()] },
            provider: createProviderCatalog(),
          }),
          /** 新旧の呼出しを別々のゲートで観測できるアダプターを選ぶ。 */
          getProviderCodingAdapter: () => adapter,
          /** 同じ Session の旧送信と次の送信に異なる保存 Turn ID を割り当てる。 */
          createSessionTurn: (input) => ({
            ...createSessionTurnBase(input),
            id: nextTurnId++,
          }),
          /** 開始と終端など実際に保存された phase を収集する。 */
          updateSessionTurn(_id, input) {
            savedPhases.push(input.phase);
          },
          /** 段階をまたいだ取消状態を後から読めるよう、最新のライブ値を保持する。 */
          setLiveSessionRun: (_id, next) => {
            live = next;
          },
          /** 取消要求が参照する現在の Run 状態をメモリから取得する。 */
          getLiveSessionRun: () => live,
          /** 承認待ちの差を追加しないよう、指定があっても即時承認する。 */
          async waitForApprovalDecision() {
            return "approve" as const;
          },
          /** 質問による別の待機が実行されないよう、取消を直ちに返す。 */
          async waitForElicitationResponse() {
            return { action: "cancel" } as const;
          },
          /** 取消後に利用枠を保存する副作用を作らない。 */
          setProviderQuotaTelemetry() {},
          /** コンテキスト計測を持たない取消 fixture とする。 */
          setSessionContextTelemetry() {},
          /** 停止の前後に実プロバイダースレッドを変更しない。 */
          async invalidateProviderSessionThread() {},
          /** 再取得タイマーは起動せず、各 Run の実完了をゲートで観測する。 */
          scheduleProviderQuotaTelemetryRefresh() {},
          /** ライブ状態を発行順に収集し、取消状態が解放まで継続したか確認可能にする。 */
          broadcastLiveSessionRun() {
            broadcasts.push(live);
          },
          /** 承認が保留されないケースでは承認解消の状態を記録しない。 */
          resolvePendingApprovalRequest() {},
          /** 質問を保持しないケースでは Turn 取消で質問を個別管理しない。 */
          resolvePendingElicitationRequest() {},
        });
        const firstRun = service.runSessionTurn(stored.id, {
          executionOptions: TEST_EXECUTION_OPTIONS,
          userMessage: "first request",
        });
        const firstOutcome = firstRun.then(
          (session) => session,
          () => null,
        );
        await gateReady;
        service.cancelRun(stored.id);
        assert.equal(broadcasts.at(-1)?.cancellationState, "requested", phase);
        const cancelBroadcastCount = broadcasts.length;
        if (lateOutcome === "reject") {
          service.cancelRun(stored.id);
          service.cancelRun(stored.id);
          assert.equal(
            broadcasts.length,
            cancelBroadcastCount,
            "repeated cancel is idempotent",
          );
        }
        if (phase !== "terminal") {
          await firstOutcome;
          assert.equal(
            broadcasts.at(-1)?.cancellationState,
            "terminating",
            phase,
          );
        } else {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          assert.equal(
            broadcasts.at(-1)?.cancellationState,
            "requested",
            "terminal persistence retains cancellation after grace",
          );
        }
        assert.equal(service.isRunInFlight(stored.id), true);
        assert.deepEqual(
          service.getUnreleasedTurnIds(),
          phase === "provider" || phase === "terminal" ? ["1"] : [],
          phase,
        );
        if (phase === "provider") {
          assert.ok(
            savedPhases.includes("canceled"),
            "canceled terminal is saved while the Provider promise remains unsettled",
          );
          assert.match(stored.messages.at(-1)?.text ?? "", /Run canceled/);
        }
        await assert.rejects(
          service.runSessionTurn(stored.id, {
            executionOptions: TEST_EXECUTION_OPTIONS,
            userMessage: "too early",
          }),
          /already running/,
        );
        if (phase === "provider") {
          if (lateOutcome === "resolve") {
            resolveProvider(
              createPartialResult({ assistantText: "old late answer" }),
            );
          } else {
            rejectProvider(new Error("old late rejection"));
          }
        } else {
          releaseGate();
        }
        await firstOutcome;
        await waitForCondition(
          () => !service.isRunInFlight(stored.id),
          "original run must finish",
        );
        assert.deepEqual(service.getUnreleasedTurnIds(), []);
        assert.equal(broadcasts.at(-1)?.cancellationState, undefined);
        const historyBeforeNext = [...stored.messages];
        const secondRun = service.runSessionTurn(stored.id, {
          executionOptions: TEST_EXECUTION_OPTIONS,
          userMessage: "next request",
        });
        await nextReady;
        assert.deepEqual(service.getUnreleasedTurnIds(), [
          phase === "provider" || phase === "terminal" ? "2" : "1",
        ]);
        emitLateProgress?.();
        assert.equal(readLive()?.assistantText.includes("old late"), false);
        assert.equal(readLive()?.cancellationState, undefined);
        finishNext(createPartialResult({ assistantText: "completed answer" }));
        const second = await secondRun;
        assert.deepEqual(service.getUnreleasedTurnIds(), []);
        assert.deepEqual(
          stored.messages.slice(0, historyBeforeNext.length),
          historyBeforeNext,
        );
        assert.equal(second.messageCount, stored.messages.length);
        assert.equal(second.messages.at(-2)?.text, "next request");
        assert.equal(second.messages.at(-1)?.text, "completed answer");
        assert.equal(
          second.messages.some((message) => /old late/.test(message.text)),
          false,
        );
        assert.equal(
          broadcasts.at(-1)?.assistantText.includes("old late"),
          undefined,
        );
        assert.equal(
          providerCalls,
          phase === "setup" || phase === "admission" ? 1 : 2,
        );
      }
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "保存済みSessionのProviderが未対応なら、Codexでも有効なmodelでも実行開始・保存・binding発行前に拒否する"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md#current-runtime" }
  // fault = "保存ProviderをcatalogまたはAdapterでCodexへ置き換えてturnを開始する"
  // observable = "runSessionTurnのreject、adapter呼出し回数、保存とbinding発行回数"
  // observation_boundary = "public-boundary"
  // scope = "session-runtime-provider-identity"
  // lifecycle = "permanent"
  // impact = "誤った契約へのprompt送信・課金・Session履歴変更を防止する"
  // distinction = "resolverとlaunchの単体testだけでは保存済みSessionからの本番Facade経由の実行を保証できない"
  // @end-test-value
  /** 保存済みで有効化されていても未対応の Provider を開始前に拒否し、実アダプター・書込み・バインディングのいずれにも進まない。 */
  it("未対応Providerの保存Sessionは実Adapterを呼ばずturn開始前に拒否する", async () => {
    const session = createSession({ provider: "custom", model: "gpt-5.4" });
    let adapterCalls = 0;
    let writes = 0;
    let bindingIssues = 0;
    /** 未対応 Provider から呼ばれてはいけない実アダプターの入口を、計数と例外に置き換える。 */
    const unexpectedAdapterCall = (): never => {
      adapterCalls += 1;
      throw new Error("Unexpected adapter call");
    };
    const adapter: ProviderTurnAdapter = {
      composePrompt: unexpectedAdapterCall,
      getProviderQuotaTelemetry: unexpectedAdapterCall,
      invalidateSessionThread: unexpectedAdapterCall,
      invalidateAllSessionThreads: unexpectedAdapterCall,
      runSessionTurn: unexpectedAdapterCall,
    };
    const catalog = {
      providers: [createProviderCatalog(), createProviderCatalog("custom")],
    };
    const facade = new MainProviderFacade({
      codexAdapter: adapter,
      copilotAdapter: adapter,
      claudeAdapter: adapter,
      opencodeAdapter: adapter,
      /** カタログ上には存在する未対応 Provider を、実 Provider ファサードへ返す。 */
      getModelCatalog: () => catalog,
    });
    /** 未対応 Provider の拒否前にストレージへ到達した場合を、回数と例外で検出する。 */
    const unexpectedWrite = (): never => {
      writes += 1;
      throw new Error("Unexpected write");
    };
    const service = createTestRuntime({
      /** 未対応 Provider を保存した Session を返す。 */
      getSession: () => session,
      upsertSession: unexpectedWrite,
      /** 未対応であること以外の入力エラーがないよう、添付検査は成功させる。 */
      resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
      /** 設定上は未対応 ID を有効にして、拒否理由をアダプター未対応に絞る。 */
      getAppSettings: () =>
        normalizeAppSettings({
          codingProviderSettings: { custom: { enabled: true } },
        }),
      /** カタログ解決を実 Provider ファサードへ渡す。 */
      resolveProviderCatalog: (id) => facade.resolveProviderCatalog(id),
      /** プロバイダー ID を省略せず、本番ファサードで実アダプター選択を行う。 */
      getProviderCodingAdapter: (id) => facade.getProviderCodingAdapter(id),
      /** バインディング要求に到達した回数を記録し、開始前拒否を確かめる。 */
      getProviderAgentRuntimeBinding: () => {
        bindingIssues += 1;
        return null;
      },
      createSessionTurn: unexpectedWrite,
      updateSessionTurn: unexpectedWrite,
      /** 未対応 Provider は事前に動いていない状態とする。 */
      getLiveSessionRun: () => null,
      /** この fixture では Renderer のライブ状態を保持しない。 */
      setLiveSessionRun: () => {},
      /** 未対応 Provider の実行を承認で許可しない。 */
      waitForApprovalDecision: () => "deny",
      /** 未対応 Provider に届くエリシテーションは作らない。 */
      waitForElicitationResponse: () => ({ action: "cancel" }),
      /** 事前拒否する Run に利用枠記録を持たせない。 */
      setProviderQuotaTelemetry: () => {},
      /** 事前拒否でコンテキスト公開を作らない。 */
      setSessionContextTelemetry: () => {},
      /** 仮に無効化依頼が来た場合も、指定 ID を本番ファサードで照合する。 */
      invalidateProviderSessionThread: (id, sessionId) =>
        facade.invalidateProviderSessionThread(id, sessionId),
      /** 事前拒否のケースで利用枠再測定を行わない。 */
      scheduleProviderQuotaTelemetryRefresh: () => {},
      /** 対応がない Provider にライブ配信先を作らない。 */
      broadcastLiveSessionRun: () => {},
      /** 対話が始まらないため、保留承認を解消する副作用を作らない。 */
      resolvePendingApprovalRequest: () => {},
      /** 未開始のケースなので、保留質問を保持しない。 */
      resolvePendingElicitationRequest: () => {},
    });
    await assert.rejects(
      service.runSessionTurn(session.id, {
        userMessage: "Test provider identity",
        executionOptions: TEST_EXECUTION_OPTIONS,
      }),
      /Unsupported provider: custom/,
    );
    assert.equal(adapterCalls, 0);
    assert.equal(writes, 0);
    assert.equal(bindingIssues, 0);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "terminal保存ACK後に通知して次turnを受け付ける"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: runSessionTurnInternal / notifySessionTurnTerminalBestEffort" }
  // fault = "永続化前の通知により通知先が未保存状態を読むか、次turnを受付できない"
  // observable = "terminal保存ACK前後の通知数と呼出し順、次turn受付時のrun状態"
  // observation_boundary = "public-boundary"
  // scope = "session-runtime-terminal-completion-order"
  // lifecycle = "permanent"
  // @end-test-value
  /** 各送信が直前の保存を使い、終端書込みの確定後に通知してから呼び出し元へ返り、次の Turn を受け付けることを確認する。 */
  it("各turnの保存済み状態を用い、terminal commit後に通知して次turnを受け付ける", async () => {
    let storedSession = createSession();
    let turnId = 0;
    let completionNotificationCount = 0;
    const callOrder: string[] = [];
    let lastCommittedAt: string | null = null;
    const confirmedPreviewTexts: Array<string | null | undefined> = [];
    let terminalUpsertCount = 0;
    let terminalUpsertStarted = false;
    let releaseFirstTerminalUpsert!: () => void;
    const firstTerminalUpsertReleased = new Promise<void>((resolve) => {
      releaseFirstTerminalUpsert = resolve;
    });
    const adapter: ProviderCodingAdapter = {
      /** 複数の Turn で同じ固定プロンプトを返し、順序の差を入力加工に帰さない。 */
      composePrompt(input) {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: {
            systemText: "system",
            inputText: "input",
            composedText: "system\ninput",
          },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      /** 開始・終端・通知順を観測する間は利用枠を取得しない。 */
      async getProviderQuotaTelemetry() {
        return null;
      },
      /** 完了のたびに外部スレッドを破棄する経路を追加しない。 */
      async invalidateSessionThread() {},
      /** 複数の Turn を同じアダプターで順に実行し、全スレッドは消去しない。 */
      async invalidateAllSessionThreads() {},
      /** 本文と、通知経路が使用する最終非空メッセージを固定して成功を返す。 */
      async runSessionTurn(input) {
        return {
          ...createPartialResult({ assistantText: "完了" }),
          lastNonEmptyAssistantMessageText: "完了",
        };
      },
    };

    const service = createTestRuntime({
      /** 指定 Session ID に一致する場合だけ、直前の永続化結果を読み取る。 */
      getSession(sessionId) {
        return sessionId === storedSession.id ? storedSession : null;
      },
      /** 開始時の変更を保存し、後続の読取対象にする。 */
      upsertSession(next) {
        storedSession = next;
        return next;
      },
      /** 終端書込みの ID・本文・保存オプションを記録し、通知前に Session と確定時刻を格納する。 */
      upsertTerminalSession(next, terminalCommit, options) {
        if (
          next.status === "idle" &&
          next.messages.at(-1)?.role === "assistant"
        ) {
          terminalUpsertCount += 1;
          terminalUpsertStarted = true;
          callOrder.push(`completed-upsert:${terminalCommit.turnId}`);
          assert.equal(
            terminalCommit.assistantMessageSeq,
            next.messages.length - 1,
          );
          confirmedPreviewTexts.push(options?.confirmedFinalAssistantText);
        }
        if (terminalUpsertCount === 1) {
          return firstTerminalUpsertReleased.then(() => {
            lastCommittedAt = terminalCommit.completedAt;
            storedSession = next;
            return next;
          });
        }
        lastCommittedAt = terminalCommit.completedAt;
        storedSession = next;
        return next;
      },
      /** 終端順序の比較に添付検査の失敗を持ち込まない。 */
      async resolveComposerPreview() {
        return { attachments: [], errors: [] };
      },
      /** この順序検証の Run は特別な設定を必要としない。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** 固定の既定モデルを含む現在の選択 Provider を返す。 */
      resolveProviderCatalog() {
        const provider = createProviderCatalog();
        return { snapshot: { providers: [provider] }, provider };
      },
      /** 固定の完了本文を返すアダプターを選択する。 */
      getProviderCodingAdapter() {
        return adapter;
      },
      /** 開始時に採番し、どの終端保存と通知を対応させるか識別できるようにする。 */
      createSessionTurn(input) {
        turnId += 1;
        return { ...createSessionTurnBase(input), id: turnId };
      },
      /** 通常の Turn 差分更新を記録せず、一括終端保存の順序を見分ける。 */
      updateSessionTurn() {},
      /** 永続化と通知の順だけを検証し、ライブ投影は保持しない。 */
      setLiveSessionRun() {},
      /** 表示用進捗がない Run として扱う。 */
      getLiveSessionRun() {
        return null;
      },
      /** 対話なしの条件で承認待ちに入っても即時に解決する。 */
      waitForApprovalDecision() {
        return "approve" as const;
      },
      /** 質問回答の待機を終端保存の順序へ追加しない。 */
      waitForElicitationResponse() {
        return { action: "cancel" };
      },
      /** 終端通知順の計測には利用枠テレメトリーを含めない。 */
      setProviderQuotaTelemetry() {},
      /** 通知・保存順を観測する間、コンテキストの計測記録は持たない。 */
      setSessionContextTelemetry() {},
      /** 終端保存後の実スレッド無効化は検証の外に置く。 */
      async invalidateProviderSessionThread() {},
      /** 追加の利用枠更新が通知順序のログに入らないようにする。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** 永続化後の終端通知とライブ配信を分離する。 */
      broadcastLiveSessionRun() {},
      /** この Turn では承認の終端通知を発行しない。 */
      resolvePendingApprovalRequest() {},
      /** 質問無しの Run では保留要求の回収を記録しない。 */
      resolvePendingElicitationRequest() {},
      /** 終端通知の回数と呼ばれた順番を、対応する保存ログと比較できるよう記録する。 */
      notifySessionTurnTerminal() {
        completionNotificationCount += 1;
        callOrder.push(
          `completion-notification:${completionNotificationCount}`,
        );
      },
      currentTimestampLabel,
    });

    const firstRun = service.runSessionTurn(storedSession.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "first",
      clientRequestId: "7c26d875-9117-4ad5-97b5-e9af775b94b1",
      submitSource: "composer",
    });
    await waitForCondition(
      () => terminalUpsertStarted,
      "terminal upsertが通知前に開始されること",
    );
    assert.equal(completionNotificationCount, 0);
    releaseFirstTerminalUpsert();
    await firstRun;
    callOrder.push("first-returned");
    assert.equal(service.isRunInFlight(storedSession.id), false);
    assert.equal(confirmedPreviewTexts[0], "完了");
    await service.runSessionTurn(storedSession.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "second",
      clientRequestId: "7c26d875-9117-4ad5-97b5-e9af775b94b2",
      submitSource: "retry",
    });
    callOrder.push("second-returned");

    for (const [turnId, returned] of [
      [1, "first-returned"],
      [2, "second-returned"],
    ] as const) {
      assert.ok(
        callOrder.indexOf(`completed-upsert:${turnId}`) <
          callOrder.indexOf(`completion-notification:${turnId}`),
      );
      assert.ok(
        callOrder.indexOf(`completion-notification:${turnId}`) <
          callOrder.indexOf(returned),
      );
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "character-authoring turnの通知対象はturn開始時の最新Character snapshotを含む保存済みSession結果である"
  // oracle = { type = "adr", ref = "docs/adr/006-windows-session-turn-notifications.md" }
  // fault = "staleなSession snapshotを通知へ渡して誤ったCharacter iconまたはSession情報を表示する"
  // scope = "session-runtime-terminal-notification-snapshot"
  // observable = "terminal通知へ渡されたSessionのcharacterRuntimeSnapshot"
  // observation_boundary = "public-boundary"
  // lifecycle = "permanent"
  // @end-test-value
  /** Character authoring の最新スナップショットと Session フォルダーを Turn 開始時に使用し、保存と終端通知にも最新値と最終応答を残す。 */
  it("character-authoring session は turn 開始時の最新 Character snapshot を使う", async () => {
    const staleSession = createSession({
      sessionKind: "character-authoring",
      characterRuntimeSnapshot: {
        characterId: "char-a",
        name: "Old",
        description: "",
        iconFilePath: "",
        theme: { main: "#111111", sub: "#222222" },
        definitionMarkdown: "# Old",
        definitionSha256: "old",
        definitionByteSize: 5,
        snapshotAt: "old",
      },
    });
    const freshSession = {
      ...staleSession,
      character: "Fresh",
      characterRuntimeSnapshot: {
        characterId: "char-a",
        name: "Fresh",
        description: "",
        iconFilePath: "",
        theme: { main: "#333333", sub: "#444444" },
        definitionMarkdown: "# Fresh",
        definitionSha256: "fresh",
        definitionByteSize: 7,
        snapshotAt: "fresh",
      },
    };
    let runSessionName = "";
    let runSessionFolderPath = "";
    const notifiedSessions: Session[] = [];
    let notifiedLastNonEmptyAssistantMessageText = "";

    const adapter: ProviderCodingAdapter = {
      /** Authoring 開始時にスナップショットを受け取るプロンプト依存先を、固定の出力で接続する。 */
      composePrompt(input) {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: {
            systemText: "system",
            inputText: "input",
            composedText: "system\ninput",
          },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      /** Character 更新の観測では利用枠の値を取得しない。 */
      async getProviderQuotaTelemetry() {
        return null;
      },
      /** 古い Character 定義を実スレッド無効化で取り除く経路は作らない。 */
      async invalidateSessionThread() {},
      /** 全スレッドへの影響を与えず Authoring の対象だけを観測する。 */
      async invalidateAllSessionThreads() {},
      /** 実行時の Character 名と Session フォルダーを捕捉し、途中案内と最終非空本文を区別できる応答を返す。 */
      runSessionTurn(input) {
        runSessionName = input.session.characterRuntimeSnapshot?.name ?? "";
        runSessionFolderPath = input.sessionFolderPath ?? "";
        return Promise.resolve(
          createPartialResult({
            threadId: "thread-1",
            assistantText: "途中の案内\n\n完了したよ。",
            lastNonEmptyAssistantMessageText: "完了したよ。",
          }),
        );
      },
    };

    const service = createTestRuntime({
      /** 対象 ID の永続化済み Session を古いスナップショット付きで返す。 */
      getSession(sessionId) {
        return sessionId === staleSession.id ? staleSession : null;
      },
      /** 保存結果をそのまま返して、受け取った Authoring スナップショットを保持する。 */
      upsertSession(next) {
        return next;
      },
      /** 入力側が確かに古い Character を持っていたことを照合し、最新の Authoring Session に解決する。 */
      resolveRuntimeSessionForTurn(session) {
        assert.equal(session.characterRuntimeSnapshot?.name, "Old");
        return freshSession;
      },
      /** 旧定義と新定義の比較に添付の収集結果を含めない。 */
      async resolveComposerPreview() {
        return { attachments: [], errors: [] } satisfies ComposerPreview;
      },
      /** 最新 Character の選択以外に調整を加えない既定設定を返す。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** Authoring の実行先として既定の Codex カタログを供給する。 */
      resolveProviderCatalog() {
        return {
          snapshot: { providers: [createProviderCatalog()] },
          provider: createProviderCatalog(),
        };
      },
      /** 最新定義とフォルダーを受け取る検証用アダプターを選ぶ。 */
      getProviderCodingAdapter() {
        return adapter;
      },
      /** Session ID ごとに異なる固定フォルダーを返し、Provider 入力への伝播を確認できるようにする。 */
      resolveSessionFolderPath(sessionId) {
        return `F:/user-data/session-files/${sessionId}`;
      },
      /** 開始時に受け取った入力を、固定 ID の最小 Turn に組み立てる。 */
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      /** スナップショットの検証は Session 保存で行い、Turn 更新を別保存しない。 */
      updateSessionTurn() {},
      /** Authoring のスナップショットをライブ表示の更新とは分けて検証する。 */
      setLiveSessionRun() {},
      /** 最新スナップショットを使う Run に、再利用するライブ状態は含めない。 */
      getLiveSessionRun() {
        return null;
      },
      /** 対話のない Authoring fixture で承認を即時解決する。 */
      async waitForApprovalDecision(): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      /** 質問に対する待機を追加せず、取消応答を返す。 */
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      /** Character の再解決とは独立した利用枠は保存しない。 */
      setProviderQuotaTelemetry() {},
      /** Character の差替えにコンテキスト計測の永続化を追加しない。 */
      setSessionContextTelemetry() {},
      /** Authoring の定義更新を実スレッドの無効化と結び付けない。 */
      async invalidateProviderSessionThread() {},
      /** Authoring の実行終端で利用枠測定を予約しない。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** 最新の Authoring 状態を Window には送らず、保存結果と終端通知から観測する。 */
      broadcastLiveSessionRun() {},
      /** 承認を発行しないケースで保留承認を持たない。 */
      resolvePendingApprovalRequest() {},
      /** エリシテーションを生成しない Authoring 条件に固定する。 */
      resolvePendingElicitationRequest() {},
      /** 完了通知の Session と最後の非空応答を取得し、最新の定義が保存結果だけに留まらないことを照合する。 */
      notifySessionTurnTerminal(notification) {
        assert.equal(notification.outcome, "completed");
        notifiedSessions.push(notification.session);
        notifiedLastNonEmptyAssistantMessageText =
          notification.outcome === "completed"
            ? notification.lastNonEmptyAssistantMessageText
            : "";
      },
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(staleSession.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "お願いします",
    });

    assert.equal(runSessionName, "Fresh");
    assert.equal(
      runSessionFolderPath,
      `F:/user-data/session-files/${freshSession.id}`,
    );
    assert.equal(result.characterRuntimeSnapshot?.name, "Fresh");
    const notifiedSession = notifiedSessions.at(-1);
    assert.ok(notifiedSession);
    assert.equal(notifiedSession, result);
    assert.equal(notifiedSession?.id, freshSession.id);
    assert.equal(
      notifiedSession?.characterRuntimeSnapshot?.definitionSha256,
      "fresh",
    );
    assert.equal(notifiedLastNonEmptyAssistantMessageText, "完了したよ。");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "resolveSessionCharacter未提供でもprovider turnを実行できる"
  // oracle = { type = "contract", ref = "Session runtime optional character resolver contract" }
  // fault = "任意依存の未提供を理由にprovider turnを中断する"
  // observable = "provider turn resultと保存されたSession state"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService provider turn setup"
  // lifecycle = "permanent"
  // @end-test-value
  /** Character 読取依存先が未提供でも Run を開始・完了し、Provider コールに character キーを付けないことを確認する。 */
  it("resolveSessionCharacter 未提供でも provider turn まで進む", async () => {
    const session = createSession();
    let runCalled = false;
    let hasCharacterKey = false;

    const adapter: ProviderCodingAdapter = {
      /** Character がない状態でも利用できる固定プロンプトを用意する。 */
      composePrompt(input) {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: {
            systemText: "system",
            inputText: "input",
            composedText: "system\ninput",
          },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      /** 任意の Character 依存先の省略時に利用枠の問い合わせを追加しない。 */
      async getProviderQuotaTelemetry() {
        return null;
      },
      /** Character が未提供でも実スレッドを削除しない。 */
      async invalidateSessionThread() {},
      /** この成功経路では全スレッド状態を所有しない。 */
      async invalidateAllSessionThreads() {},
      /** Provider 到達と character キーの有無を記録し、以後は通常の成功を返す。 */
      runSessionTurn(input) {
        runCalled = true;
        hasCharacterKey = Object.prototype.hasOwnProperty.call(
          input,
          "character",
        );
        return Promise.resolve(
          createPartialResult({
            threadId: "thread-1",
            assistantText: "完了したよ。",
          }),
        );
      },
    };

    const service = createTestRuntime({
      /** 要求された ID と一致する既定の Session を返す。 */
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      /** このケースの保存戻り値として、Runtime が渡した Session を保持する。 */
      upsertSession(next) {
        return next;
      },
      /** Character 依存先の有無以外の要因を除くため添付・エラーを空にする。 */
      async resolveComposerPreview() {
        return { attachments: [], errors: [] } satisfies ComposerPreview;
      },
      /** 任意依存先が欠けても起動できる既定設定を返す。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** 既定モデルを含む有効な Provider を返し、Character 不在以外の準備を通す。 */
      resolveProviderCatalog() {
        return {
          snapshot: { providers: [createProviderCatalog()] },
          provider: createProviderCatalog(),
        };
      },
      /** Character の入力形状を観測するアダプターを選ぶ。 */
      getProviderCodingAdapter() {
        return adapter;
      },
      /** 任意依存先の省略で Turn 作成を妨げず、固定 ID を返す。 */
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      /** Character 省略の検証で追加の Turn 書込みを追跡しない。 */
      updateSessionTurn() {},
      /** このケースは入力形状を検査し、ライブ表示を保持しない。 */
      setLiveSessionRun() {},
      /** 以前のライブ状態を必要としない Run とする。 */
      getLiveSessionRun() {
        return null;
      },
      /** Character がなくても、通常の承認依存先は即時応答できるようにする。 */
      async waitForApprovalDecision(
        _sessionId,
        _request,
        _signal,
      ): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      /** 任意依存先を除いた経路で、質問を保留しない。 */
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      /** テスト用 Provider の利用枠は保存しない。 */
      setProviderQuotaTelemetry() {},
      /** Character 不在をコンテキスト計測に書き出さない。 */
      setSessionContextTelemetry() {},
      /** この成功 fixture で外部スレッドを無効化しない。 */
      async invalidateProviderSessionThread() {},
      /** 利用枠の再取得を、Character 不在のフォールバックから切り離す。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** 任意依存先の省略時も Renderer 配信に頼らず、ルートの成否を比較する。 */
      broadcastLiveSessionRun() {},
      /** このテストでは回収対象となる承認を作らない。 */
      resolvePendingApprovalRequest() {},
      /** 質問の回収対象がない fixture とする。 */
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "お願い",
    });

    assert.equal(runCalled, true);
    assert.equal(hasCharacterKey, false);
    assert.equal(result.runState, "idle");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "turn setup失敗時もlive stateを掃除する"
  // oracle = { type = "contract", ref = "Session runtime cleanup contract" }
  // fault = "setup例外後にin-flight/live stateを残し、再送やUI表示を阻害する"
  // observable = "live state、in-flight判定、cleanup呼び出し"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService setup failure cleanup"
  // lifecycle = "permanent"
  // @end-test-value
  /** 最小 Turn の作成が失敗して Provider に達しなくても、保留中の対話とライブ状態を掃除して in-flight を解放する。 */
  it("setup 失敗でも live state を掃除する", async () => {
    const session = createSession();
    const calls: string[] = [];
    const liveStates: Array<LiveSessionRunState | null> = [];
    const adapter: ProviderCodingAdapter = {
      /** 初回プロンプトの合成まで到達したことを記録し、その後の Turn 作成失敗と順番を比較する。 */
      composePrompt() {
        calls.push("compose");
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: {
            systemText: "system",
            inputText: "input",
            composedText: "system\ninput",
          },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      /** 準備失敗の前後に利用枠を取得しない。 */
      async getProviderQuotaTelemetry() {
        return null;
      },
      /** Turn 作成に失敗した Run で実スレッドの無効化を実行しない。 */
      async invalidateSessionThread() {},
      /** セットアップの検証で全スレッドの状態を持たない。 */
      async invalidateAllSessionThreads() {},
      /** 準備失敗を無視して Provider を起動した場合に失敗させる。 */
      runSessionTurn() {
        throw new Error("provider should not run");
      },
    };

    const service = createTestRuntime({
      /** テストが作った ID に対してだけ Session を提供する。 */
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      /** セットアップ時に保存しようとした Session の Run 状態を呼出し順に記録する。 */
      upsertSession(next) {
        calls.push(`upsert:${next.runState}`);
        return next;
      },
      /** 添付検査を通過させ、準備失敗を Turn 作成に限定する。 */
      async resolveComposerPreview() {
        return { attachments: [], errors: [] } satisfies ComposerPreview;
      },
      /** 既定設定でセットアップを開始できるようにする。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** 既定の Codex モデルを解決し、Provider 選択を失敗点にしない。 */
      resolveProviderCatalog() {
        return {
          snapshot: { providers: [createProviderCatalog()] },
          provider: createProviderCatalog(),
        };
      },
      /** 合成到達と Provider 未起動を観測するアダプターを返す。 */
      getProviderCodingAdapter() {
        return adapter;
      },
      /** 最小 Turn の作成が呼ばれたことを記録して失敗させる。 */
      createSessionTurn() {
        calls.push("createSessionTurn");
        throw new Error("turn failed");
      },
      /** 作成されなかった Turn の更新記録は保持しない。 */
      updateSessionTurn() {},
      /** ライブ状態の設定と最後の消去を、時系列で比較できるようにする。 */
      setLiveSessionRun(_sessionId, state) {
        liveStates.push(state);
      },
      /** 未初期化または消去後は null、それ以外は最後に設定されたライブ状態を返す。 */
      getLiveSessionRun() {
        return liveStates.at(-1) ?? null;
      },
      /** セットアップ中の承認を保留状態にしない。 */
      async waitForApprovalDecision(): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      /** 未開始 Run が質問を待ち続けないようにする。 */
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      /** セットアップ失敗を利用枠値として保存しない。 */
      setProviderQuotaTelemetry() {},
      /** コンテキスト状態を準備しないため、セットアップ掃除だけを観測する。 */
      setSessionContextTelemetry() {},
      /** 失敗後の実プロバイダー通信に依存せず、掃除の順序を調べる。 */
      async invalidateProviderSessionThread() {},
      /** セットアップで失敗した Turn の利用枠再取得を予約しない。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** 実 Window を使わず、ライブ状態更新の配信順を記録する。 */
      broadcastLiveSessionRun() {
        calls.push("broadcast");
      },
      /** 準備失敗で保留承認を拒否する掃除に到達したことを記録する。 */
      resolvePendingApprovalRequest() {
        calls.push("approval:deny");
      },
      /** 準備失敗で保留質問を取り消す掃除に到達したことを記録する。 */
      resolvePendingElicitationRequest() {
        calls.push("elicitation:cancel");
      },
      currentTimestampLabel,
    });

    await assert.rejects(
      service.runSessionTurn(session.id, {
        executionOptions: TEST_EXECUTION_OPTIONS,
        userMessage: "お願い",
      }),
      /turn failed/,
    );

    assert.deepEqual(calls, [
      "upsert:running",
      "createSessionTurn",
      "approval:deny",
      "elicitation:cancel",
      "upsert:error",
      "broadcast",
    ]);
    assert.equal(liveStates.at(-1), null);
    assert.equal(service.isRunInFlight(session.id), false);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "成功turnはrunningからidleを保存し、最小turnのcompletedと本文位置を記録してlive stateを解放する"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: runSessionTurnInternal; docs/design/provider-adapter.md: Session Flow 9-10 / 通常履歴と最小turn" }
  // fault = "runningからidleへの2回のSession保存を失う、completed turnのphase/本文位置を誤る、またはReasoning/taskがない成功turnのlive stateとin-flightを残す"
  // observable = "保存runState、completed turnのphaseとassistantMessageSeq、live stateの解放"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService successful turn completion"
  // lifecycle = "permanent"
  // @end-test-value
  /** 成功した Run が running から idle を順に保存し、最終応答の位置を Turn に記録してライブ状態を解放する。 */
  it("成功時に running -> idle を保存し、完了後に live state を解放する", async () => {
    const session = createSession();
    const storedSessions: Session[] = [];
    const turnUpdates: UpdateSessionTurnInput[] = [];
    const liveStates: Array<LiveSessionRunState | null> = [];
    const adapter: ProviderCodingAdapter = {
      /** 成功シナリオへ固定プロンプトを渡し、画像と追加ディレクトリは空にする。 */
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: {
            systemText: "system",
            inputText: "input",
            composedText: "system\ninput",
          },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      /** Provider 実行前の利用枠問い合わせでは計測値を返さない。 */
      async getProviderQuotaTelemetry() {
        return null;
      },
      /** 正常終了の前後に外部スレッドを削除しない。 */
      async invalidateSessionThread() {},
      /** 複数 Session のスレッド状態を準備せず、一件の Run だけを検証する。 */
      async invalidateAllSessionThreads() {},
      /** ライブ進捗を段階的に発行し、最終本文・スレッド・使用量・利用枠を含む正常な Provider 結果を返す。 */
      async runSessionTurn(input, onProgress) {
        await emitTestProgress(
          onProgress,
          createLiveRunState({
            sessionId: input.session.id,
          }),
        );
        await emitTestProgress(
          onProgress,
          createLiveRunState({
            sessionId: input.session.id,
            threadId: "thread-progress",
            assistantText: "途中経過だよ。",
            steps: [
              {
                id: "step-1",
                type: "command_execution",
                summary: "npm test",
                details: "実行中",
                status: "in_progress",
              },
            ],
            usage: { inputTokens: 4, cachedInputTokens: 0, outputTokens: 1 },
          }),
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        return {
          threadId: "thread-1",
          assistantText: "完了したよ。",

          usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 220 },
          providerQuotaTelemetry: {
            provider: "copilot",
            updatedAt: "2026-03-29T04:10:00.000Z",
            snapshots: [
              {
                quotaKey: "premium_interactions",
                entitlementRequests: 500,
                usedRequests: 120,
                remainingPercentage: 76.4,
                overage: 0,
                overageAllowedWithExhaustedQuota: false,
                resetDate: "2026-04-01T00:00:00.000Z",
              },
            ],
          },
        };
      },
    };

    const service = createTestRuntime({
      /** Run 対象の ID に対応する Session だけを読み出す。 */
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      /** 実行開始・終端で保存を求められた Session を順に記録する。 */
      upsertSession(next) {
        storedSessions.push(next);
        return next;
      },
      /** 正常経路が添付失敗で終端しないよう、空の検証結果を返す。 */
      async resolveComposerPreview() {
        return { attachments: [], errors: [] } satisfies ComposerPreview;
      },
      /** Session の参照先と同じ Character を実行時解決から返す。 */
      async resolveSessionCharacter() {
        return createCharacter();
      },
      /** 正常経路の Run に正規化済みの既定設定を返す。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** テスト用の ModelCatalog 内から既定モデルを解決できるようにする。 */
      resolveProviderCatalog() {
        return {
          snapshot: { providers: [createProviderCatalog()] },
          provider: createProviderCatalog(),
        };
      },
      /** 進捗と最終応答を発行するアダプターを供給する。 */
      getProviderCodingAdapter() {
        return adapter;
      },
      /** 最小 Turn を固定 ID で作り、完了時の位置更新と対応付ける。 */
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      /** 保存された Turn の phase と応答位置を比較用に保持する。 */
      updateSessionTurn(_id, entry) {
        turnUpdates.push(entry);
      },
      /** 開始から終端消去までに発行したライブ状態を順に記録する。 */
      setLiveSessionRun(_sessionId, state) {
        liveStates.push(state);
      },
      /** 進捗イベント以外に先行ライブ状態を供給しない。 */
      getLiveSessionRun() {
        return null;
      },
      /** 正常 Turn で承認が必要になっても拒否理由を追加しない。 */
      async waitForApprovalDecision(
        _sessionId,
        _request,
        _signal,
      ): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      /** 正常 Turn の成果物に関係しない質問は取り消す。 */
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      /** アダプターが返した利用枠を外部ストアへは書かない。 */
      setProviderQuotaTelemetry(_telemetry: ProviderQuotaTelemetry) {},
      /** 正常経路の主なアサーションはコンテキスト計測を必要としない。 */
      setSessionContextTelemetry(_telemetry: SessionContextTelemetry) {},
      /** 正常完了を実プロバイダーのスレッド破棄へ波及させない。 */
      async invalidateProviderSessionThread() {},
      /** 正常終了後の利用枠再計測タイマーは動かさない。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** 発行したライブ値を fixture が保持し、Renderer への配送は行わない。 */
      broadcastLiveSessionRun() {},
      /** この正常実行は回収対象となる承認を残さない条件にする。 */
      resolvePendingApprovalRequest() {},
      /** この正常実行は回収対象の質問を生成しない。 */
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "お願いします",
    });
    await waitForCondition(
      () => turnUpdates.length === 1,
      "completed最小turnが保存されること",
    );

    assert.equal(result.runState, "idle");
    assert.equal(storedSessions.length, 2);
    assert.equal(storedSessions[0]?.runState, "running");
    assert.equal(storedSessions[1]?.runState, "idle");
    assert.equal(storedSessions[1]?.messages.at(-1)?.text, "完了したよ。");
    assert.equal(turnUpdates.length, 1);
    assert.equal(turnUpdates.at(-1)?.phase, "completed");
    assert.equal(turnUpdates.at(-1)?.assistantMessageSeq, 1);
    assert.equal(liveStates.at(-1), null);
    assert.equal(service.isRunInFlight(session.id), false);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "成功時のfinally処理でも保存済みcompleted SessionのthreadIdをlive projectionへ反映し、backgroundTasksを失わない"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: pickPreferredThreadId / runSessionTurnInternal finally; docs/design/provider-adapter.md: Streaming Policy" }
  // fault = "background task保持処理がliveまたは旧threadIdでcompleted sessionを上書きする"
  // observable = "保存SessionのthreadIdとfinally後のlive projectionに保持されたthreadId/backgroundTasks"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService completed thread persistence"
  // lifecycle = "permanent"
  // @end-test-value
  /** 成功後も背景処理を引き継ぐ finally が、旧スレッドでなく完了済み Session の新しいスレッド ID でライブ表示を保存する。 */
  it("成功時に backgroundTasks を保持する finally でも completed session の threadId を使う", async () => {
    const session = createSession({
      provider: "codex",
      threadId: "thread-old",
    });
    const storedSessions: Session[] = [];
    const backgroundTasks = [
      {
        id: "bg-1",
        kind: "shell" as const,
        status: "running" as const,
        title: "npm run watch",
        details: "watch mode",
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
    ];
    const liveStates: Array<LiveSessionRunState | null> = [];
    let liveState: LiveSessionRunState | null = createLiveRunState({
      sessionId: session.id,
      threadId: session.threadId,
      backgroundTasks,
    });

    const adapter: ProviderCodingAdapter = {
      /** 背景処理の引継ぎを調べる Run に、固定内容のプロンプトを与える。 */
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: {
            systemText: "system",
            inputText: "input",
            composedText: "system\ninput",
          },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      /** スレッド ID と背景処理の検証に利用枠の実測を混ぜない。 */
      async getProviderQuotaTelemetry() {
        return null;
      },
      /** 新旧スレッドの比較を外部の個別無効化依頼に頼らない。 */
      async invalidateSessionThread() {},
      /** 別のスレッドを保持しないテスト用アダプターとして使う。 */
      async invalidateAllSessionThreads() {},
      /** 完了時に新しいスレッド ID を返し、既存ライブ状態の旧 ID と区別する。 */
      async runSessionTurn() {
        return createPartialResult({
          threadId: "thread-new",
          assistantText: "完了したよ。",
        });
      },
    };

    const service = createTestRuntime({
      /** 対象 ID の保存前 Session に残る古いスレッドを読取に供給する。 */
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      /** 書込み要求を保存順に記録し、完了 Session が使用したスレッドを確認できるようにする。 */
      upsertSession(next) {
        storedSessions.push(next);
        return next;
      },
      /** 背景処理の引継ぎが添付エラーで妨げられない状態を返す。 */
      async resolveComposerPreview() {
        return { attachments: [], errors: [] } satisfies ComposerPreview;
      },
      /** 元の Session に対応する Character を解決する。 */
      async resolveSessionCharacter() {
        return createCharacter();
      },
      /** 背景処理のケースで特別な設定やサービス無効化を加えない。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** 既存の Codex で完了するためのテストカタログを供給する。 */
      resolveProviderCatalog() {
        return {
          snapshot: { providers: [createProviderCatalog()] },
          provider: createProviderCatalog(),
        };
      },
      /** 新しいスレッド ID を返す固定のアダプターを選ぶ。 */
      getProviderCodingAdapter() {
        return adapter;
      },
      /** 背景処理を持つ Run に最小 Turn を生成する。 */
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      /** 背景処理の引継ぎは Session とライブ状態で確認し、Turn 更新は別に保持しない。 */
      updateSessionTurn() {},
      /** 最新ライブ状態を更新し、finally による最後の投影も履歴へ残す。 */
      setLiveSessionRun(_sessionId, next) {
        liveState = next;
        liveStates.push(next);
      },
      /** 完了後の掃除が背景処理を引き継ぐ元となる最新ライブ状態を返す。 */
      getLiveSessionRun() {
        return liveState;
      },
      /** 背景処理を保持する正常 Run に手動待機を作らない。 */
      async waitForApprovalDecision(
        _sessionId,
        _request,
        _signal,
      ): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      /** 背景処理と無関係なエリシテーションは取消として応答する。 */
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      /** 背景処理の維持を利用枠保存の副作用から切り離す。 */
      setProviderQuotaTelemetry() {},
      /** 終了時に残すライブ表示をコンテキスト計測とは分ける。 */
      setSessionContextTelemetry() {},
      /** ライブに残った背景処理のスレッドを、外部無効化で消去しない。 */
      async invalidateProviderSessionThread() {},
      /** 背景処理の状態を確認する間は利用枠再取得を予約しない。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** 背景処理の最終投影はメモリから確認し、Renderer 通知は使わない。 */
      broadcastLiveSessionRun() {},
      /** この正常経路は承認要求を残さない。 */
      resolvePendingApprovalRequest() {},
      /** この正常経路は質問の回収状態を持たない。 */
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "お願いします",
    });

    assert.equal(result.threadId, "thread-new");
    assert.equal(storedSessions[1]?.threadId, "thread-new");
    assert.equal(liveStates.at(-1)?.threadId, "thread-new");
    assert.deepEqual(liveStates.at(-1)?.backgroundTasks, backgroundTasks);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "成功後のReasoningはlive stateに保持し、次turn開始時のlive stateでは空に初期化する"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: buildEmptyLiveSessionRunState / runSessionTurnInternal finally; docs/design/provider-adapter.md: Streaming Policy" }
  // fault = "reasoningをlive stateから失う、または次turnへ古いreasoningを持ち越す"
  // observable = "各turnのlive reasoningText"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService reasoning lifecycle"
  // lifecycle = "permanent"
  // @end-test-value
  /** 成功後も推論が表示に残り、次のプロンプトの実行では前回分を引き継がないことを確かめる。 */
  it("成功後も Reasoning は live state に保持し、次の prompt 用 state で空にする", async () => {
    const session = createSession({
      provider: "codex",
      threadId: "thread-old",
    });
    let liveState: LiveSessionRunState | null = null;
    const liveStates: Array<LiveSessionRunState | null> = [];
    let runCount = 0;

    const service = createProgressRuntime(
      session,
      async (input, onProgress) => {
        runCount += 1;
        await emitTestProgress(
          onProgress,
          createLiveRunState({
            sessionId: session.id,
            threadId: "thread-new",
            reasoningText:
              runCount === 1
                ? "既存経路を確認してから表示へ流す"
                : "二回目のturnの推論を表示へ流す",
          }),
        );
        return createPartialResult({
          threadId: "thread-new",
          assistantText: "完了したよ。",
        });
      },
      {
        /** 現在の実行状態を置き換え、推論の表示順を確認できるよう更新も記録する。 */
        setLiveSessionRun(_sessionId, next) {
          liveState = next;
          liveStates.push(next);
        },
        /** 直近に保存された実行状態を返す。 */
        getLiveSessionRun() {
          return liveState;
        },
      },
    );

    await service.runSessionTurn(session.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "お願いします",
    });

    assert.equal(liveStates[0]?.reasoningText, "");
    assert.equal(liveStates.at(-1)?.threadId, "thread-new");
    assert.equal(
      liveStates.at(-1)?.reasoningText,
      "既存経路を確認してから表示へ流す",
    );

    await service.runSessionTurn(session.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "二回目もお願いします",
    });

    assert.equal(runCount, 2);
    assert.equal(
      liveStates.filter((state) => state?.reasoningText === "").length >= 2,
      true,
    );
    assert.equal(
      liveStates.at(-1)?.reasoningText,
      "二回目のturnの推論を表示へ流す",
    );
  });

  // @test-value v2
  // kind = "contract"
  // claim = "全終端のlive snapshotはReasoning/taskを保持してもterminal runStateでstepsを空にし、終了後の履歴復元を妨げない"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: runSessionTurn finally; docs/design/desktop-ui.md: 操作履歴" }
  // fault = "終了済みsnapshotをrunningのまま保持するか、Reasoning/taskを消す、または古いlive stepsを残す"
  // observable = "production runtime終了後のlive runState、steps、reasoningText、backgroundTasksと保存artifact"
  // observation_boundary = "public-boundary"
  // scope = "session-runtime-terminal-retained-live"
  // lifecycle = "permanent"
  // impact = "Rendererが実行中と終了後の表示保持を区別できず履歴復元またはReasoning/task表示を失う"
  // distinction = "Renderer fixtureのみではMainが配信するterminal stateとpartial artifact保存を確認できない"
  // @end-test-value
  /** 成功・失敗・キャンセルのいずれでも、終了後は推論とタスクを残して進行ステップを空にすることを確かめる。 */
  it("全terminal後のretained liveはReasoning/tasksを保持してstepsを空にする", async () => {
    for (const outcome of ["completed", "failed", "canceled"] as const) {
      const session = createSession();
      const retained: { value: LiveSessionRunState | null } = { value: null };
      const task = {
        id: "task-1",
        kind: "shell" as const,
        status: "running" as const,
        title: "retained task",
        updatedAt: "now",
      };
      const operation = {
        id: "command-1",
        type: "command_execution",
        status: "completed",
        summary: "fixture command",
        exitCode: 0,
      };
      const partial = createPartialResult({
        assistantText: "acquired response",
        artifact: {
          title: "Result",
          activitySummary: [],
          runChecks: [],
          changedFiles: [],
          operationTimeline: [operation],
        },
      });
      const service = createProgressRuntime(
        session,
        async (input, progress) => {
          await emitTestProgress(
            progress,
            createLiveRunState({
              sessionId: input.session.id,
              reasoningText: "retained reasoning",
              backgroundTasks: [task],
              steps: [operation],
            }),
          );
          if (outcome !== "completed")
            throw new ProviderTurnError(
              "fixture stopped",
              partial,
              outcome === "canceled",
            );
          return partial;
        },
        {
          /** 終了処理が保存した実行状態を控える。 */
          setLiveSessionRun(_id, next) {
            retained.value = next;
          },
          /** 表示に残っている直近の実行状態を返す。 */
          getLiveSessionRun: () => retained.value,
        },
      );
      const result = await service.runSessionTurn(session.id, {
        executionOptions: TEST_EXECUTION_OPTIONS,
        userMessage: "run",
      });
      assert.equal(
        retained.value?.runState,
        outcome === "failed" ? "error" : "idle",
      );
      assert.equal(retained.value?.cancellationState, undefined);
      assert.deepEqual(retained.value?.steps, []);
      assert.equal(retained.value?.reasoningText, "retained reasoning");
      assert.deepEqual(retained.value?.backgroundTasks, [task]);
      assert.deepEqual(result.messages.at(-1)?.artifact?.operationTimeline, [
        operation,
      ]);
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "利用者cancelはidle Sessionを保存し、failed terminal通知を依頼しない"
  // oracle = { type = "contract", ref = "accepted contract: user cancel is not a failure notification" }
  // fault = "利用者cancelをfailed通知して意図した中止をエラーと誤認させる"
  // scope = "session-runtime-terminal-cancel"
  // observable = "cancel時の保存status/runStateとterminal通知呼び出し"
  // observation_boundary = "public-boundary"
  // lifecycle = "permanent"
  // @end-test-value
  /** 利用者によるキャンセルを、失敗として通知しないことと Session を待機状態に戻すことを確かめる。 */
  it("利用者cancel時は idle session を保存し、failed通知を依頼しない", async () => {
    const baseSession = createSession();
    const storedSessions: Session[] = [];
    const turnUpdates: UpdateSessionTurnInput[] = [];
    let detachedSessionId: string | null = null;
    let cleanupStartedSessionId: string | null = null;
    let notificationCount = 0;
    /** キャンセル後のスレッド無効化を完了させる。 */
    let releaseInvalidation: () => void = () => undefined;
    const invalidationBarrier = new Promise<void>((resolve) => {
      releaseInvalidation = resolve;
    });
    /** 無効化の後始末が始まったことをキャンセル検証側へ伝える。 */
    let signalInvalidationStarted: () => void = () => undefined;
    const invalidationStarted = new Promise<void>((resolve) => {
      signalInvalidationStarted = resolve;
    });
    const partialResult: RunSessionTurnResult = {
      threadId: "thread-before-cancel",
      assistantText: "途中まで進んだよ。",
      artifact: {
        title: "",
        activitySummary: [],
        changedFiles: [],
        runChecks: [],
        operationTimeline: [
          {
            id: "step-1",
            type: "command_execution",
            summary: "npm run build",
            status: "in_progress",
          },
        ],
      },

      usage: null,
    };
    const adapter: ProviderCodingAdapter = {
      /** 添付や追加ディレクトリのない入力を用意する。 */
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: {
            systemText: "system",
            inputText: "input",
            composedText: "system\ninput",
          },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      /** キャンセル時に割当量の取得結果を混ぜない。 */
      async getProviderQuotaTelemetry() {
        return null;
      },
      /** 対象 Session を記録してから後始末の開始を知らせ、テストが解放するまで待つ。 */
      async invalidateSessionThread(sessionId) {
        detachedSessionId = sessionId;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        cleanupStartedSessionId = sessionId;
        signalInvalidationStarted();
        await invalidationBarrier;
      },
      /** この Session のキャンセルでは全スレッドの無効化は扱わない。 */
      async invalidateAllSessionThreads() {},
      /** キャンセル前のスレッドと途中結果を返すエラーを発生させ、遅れて実行状態を通知する。 */
      async runSessionTurn(input, onProgress) {
        await emitTestProgress(
          onProgress,
          createLiveRunState({
            sessionId: input.session.id,
            threadId: "thread-before-cancel",
            assistantText: "途中まで進んだよ。",
            steps: [
              {
                id: "step-1",
                type: "command_execution",
                summary: "npm run build",
                status: "in_progress",
              },
            ],
            usage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 2 },
          }),
        );
        setTimeout(() => {
          void emitTestProgress(
            onProgress,
            createLiveRunState({
              sessionId: input.session.id,
              threadId: "thread-late",
              assistantText: "late cancel progress",
              steps: [
                {
                  id: "step-late",
                  type: "command_execution",
                  summary: "late cancel step",
                  status: "in_progress",
                },
              ],
            }),
          );
        }, 0);
        throw new ProviderTurnError("cancelled", partialResult, true);
      },
    };

    const service = createTestRuntime({
      /** キャンセル前にある Session を返す。 */
      getSession() {
        return baseSession;
      },
      /** キャンセル後に保存される Session を記録する。 */
      upsertSession(next) {
        storedSessions.push(next);
        return next;
      },
      /** 添付や入力エラーのないプレビューで Turn を開始できるようにする。 */
      async resolveComposerPreview() {
        return { attachments: [], errors: [] };
      },
      /** この Turn の開始に必要なキャラクター設定を返す。 */
      async resolveSessionCharacter() {
        return createCharacter();
      },
      /** キャンセルの確認に使う既定のアプリ設定を返す。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** 実行に必要な Provider をカタログと選択結果の両方に載せる。 */
      resolveProviderCatalog() {
        return {
          snapshot: { providers: [createProviderCatalog()] },
          provider: createProviderCatalog(),
        };
      },
      /** 途中結果付きキャンセルを発生させるアダプターを返す。 */
      getProviderCodingAdapter() {
        return adapter;
      },
      /** 途中結果を書き込む Turn 履歴を作る。 */
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      /** キャンセル処理が保存する Turn の更新を記録する。 */
      updateSessionTurn(_id, entry) {
        turnUpdates.push(entry);
      },
      /** この検証では実行状態の書き込みを保存しない。 */
      setLiveSessionRun() {},
      /** キャンセル処理が読み戻す既存の表示状態は用意しない。 */
      getLiveSessionRun() {
        return null;
      },
      /** 承認待ちが発生したときは許可せずに進める。 */
      async waitForApprovalDecision(
        _sessionId,
        _request,
        _signal,
      ): Promise<LiveApprovalDecision> {
        return "deny";
      },
      /** 追加質問が出たときは応答せずに取り消す。 */
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      /** キャンセル検証では割当量の更新を保存しない。 */
      setProviderQuotaTelemetry() {},
      /** キャンセル検証ではコンテキスト情報の更新を記録しない。 */
      setSessionContextTelemetry() {},
      /** 対象 Session のスレッド切断をキャンセル用アダプターへ渡す。 */
      invalidateProviderSessionThread(providerId, sessionId) {
        return adapter.invalidateSessionThread(sessionId);
      },
      /** キャンセル処理からの割当量再取得は予約しない。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** 遅れて来る実行状態の通知を外部へ配信しない。 */
      broadcastLiveSessionRun() {},
      /** この入力では解決すべき保留中の承認はない。 */
      resolvePendingApprovalRequest() {},
      /** この入力では解決すべき保留中の追加質問はない。 */
      resolvePendingElicitationRequest() {},
      /** 利用者キャンセルから終端通知が要求された回数を記録する。 */
      notifySessionTurnTerminal() {
        notificationCount += 1;
      },
      currentTimestampLabel,
    });

    const run = service.runSessionTurn(baseSession.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "お願いします",
    });
    const result = await run;
    assert.equal(service.isRunInFlight(baseSession.id), false);
    assert.equal(detachedSessionId, baseSession.id);
    assert.equal(cleanupStartedSessionId, null);
    await invalidationStarted;
    assert.equal(cleanupStartedSessionId, baseSession.id);
    releaseInvalidation();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(result.runState, "idle");
    assert.equal(result.status, "idle");
    assert.equal(storedSessions.at(-1)?.status, "idle");
    assert.equal(storedSessions.at(-1)?.runState, "idle");
    assert.match(result.messages.at(-1)?.text ?? "", /Run canceled/);
    assert.equal(turnUpdates.length, 1);
    assert.equal(turnUpdates.at(-1)?.phase, "canceled");
    assert.equal(turnUpdates.at(-1)?.threadId, "thread-before-cancel");
    assert.equal(detachedSessionId, baseSession.id);
    assert.equal(notificationCount, 0);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "実行中sessionはin-flightとして見え、完了後に解放される"
  // oracle = { type = "contract", ref = "Session runtime in-flight contract" }
  // fault = "実行中判定がfalseになる、または完了後もin-flightを保持する"
  // observable = "hasInFlightRuns/isRunInFlightの値"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService in-flight tracking"
  // lifecycle = "permanent"
  // @end-test-value
  /** アダプターが未完了の間だけ Session が実行中として見えることを確かめる。 */
  it("実行中の session は in-flight として見え、完了後に解放される", async () => {
    const session = createSession();
    let resolveRun: ((value: RunSessionTurnResult) => void) | null = null;

    const adapter: ProviderCodingAdapter = {
      /** 実行時間だけを制御できるよう、添付のない固定プロンプトを返す。 */
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: {
            systemText: "system",
            inputText: "input",
            composedText: "system\ninput",
          },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      /** 進行中フラグの確認に割当量の取得結果を混ぜない。 */
      async getProviderQuotaTelemetry() {
        return null;
      },
      /** 正常完了する実行では対象スレッドを無効化しない。 */
      async invalidateSessionThread() {},
      /** この検証では全 Session のスレッド操作を行わない。 */
      async invalidateAllSessionThreads() {},
      /** テストが結果を渡すまで Provider の実行を完了させない。 */
      runSessionTurn() {
        return new Promise<RunSessionTurnResult>((resolve) => {
          resolveRun = resolve;
        });
      },
    };

    const service = createTestRuntime({
      /** 実行中フラグを確認する Session を返す。 */
      getSession() {
        return session;
      },
      /** Session 更新の値だけを返し、進行中フラグの検証には保存を持ち込まない。 */
      upsertSession(next) {
        return next;
      },
      /** 添付処理を行わず、そのまま Turn を準備できるようにする。 */
      async resolveComposerPreview() {
        return { attachments: [], errors: [] };
      },
      /** 実行開始に必要なキャラクター設定を返す。 */
      async resolveSessionCharacter() {
        return createCharacter();
      },
      /** 実行中フラグを既定のアプリ設定で確認する。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** Turn を実行できる Provider のカタログと解決結果を返す。 */
      resolveProviderCatalog() {
        return {
          snapshot: { providers: [createProviderCatalog()] },
          provider: createProviderCatalog(),
        };
      },
      /** テストから実行完了を制御するアダプターを返す。 */
      getProviderCodingAdapter() {
        return adapter;
      },
      /** 実行開始に必要な Turn レコードを構築する。 */
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      /** 進行中フラグの検証では Turn 履歴の変更を保持しない。 */
      updateSessionTurn() {},
      /** 進行中フラグを表示状態とは独立に検証するため、書き込みを記録しない。 */
      setLiveSessionRun() {},
      /** 進行中フラグの確認に既存の表示状態を持ち込まない。 */
      getLiveSessionRun() {
        return null;
      },
      /** 承認が要求された場合は承認して Turn が進めるようにする。 */
      async waitForApprovalDecision(
        _sessionId,
        _request,
        _signal,
      ): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      /** 質問が出た場合は追加の利用者入力を待たずに取り消す。 */
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      /** 実行中フラグに関係しない割当量の書き込みを保持しない。 */
      setProviderQuotaTelemetry() {},
      /** 実行中フラグの検証ではコンテキスト情報を保存しない。 */
      setSessionContextTelemetry() {},
      /** 正常完了する検証なのでスレッドの切断を発生させない。 */
      async invalidateProviderSessionThread() {},
      /** 実行中フラグの変化に割当量更新の予定を加えない。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** 実行中フラグの検証では表示状態を配信しない。 */
      broadcastLiveSessionRun() {},
      /** この入力では保留した承認結果を解決しない。 */
      resolvePendingApprovalRequest() {},
      /** この入力では保留した質問への応答を解決しない。 */
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const promise = service.runSessionTurn(session.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "お願いします",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(service.isRunInFlight(session.id), true);
    if (!resolveRun) {
      throw new Error("runSessionTurn の resolve が取得できていないよ。");
    }
    const completeRun: (value: RunSessionTurnResult) => void = resolveRun;
    completeRun({
      threadId: "thread-3",
      assistantText: "完了したよ。",

      usage: null,
    });
    await promise;
    assert.equal(service.isRunInFlight(session.id), false);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "setup dependency停止時もcancel deadlineで呼び出しを収束させ、実終了まで再送を拒否する"
  // oracle = { type = "contract", ref = "Session runtime cancellation deadline contract" }
  // fault = "cancelが無期限に待機する、またはdependency実行中に再送を許可する"
  // observable = "cancel completion、再送拒否、dependency終了後のin-flight state"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService cancellation deadline"
  // lifecycle = "permanent"
  // @end-test-value
  /** 準備処理が停止した場合もキャンセル期限で呼び出しを終了し、準備処理が実際に終わるまで再送を拒否することを確かめる。 */
  it("setup dependency が停止しても cancel deadline で呼び出しを収束させ、dependency の実終了まで再送を拒否する", async () => {
    const session = createSession();
    /** 停止させている入力プレビューをテスト側から完了させる。 */
    let resolveComposer: (preview: ComposerPreview) => void = () => undefined;
    let providerCalled = false;
    const adapter: ProviderCodingAdapter = {
      /** 準備が完了した場合に Provider へ渡せる固定プロンプトを用意する。 */
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: {
            systemText: "system",
            inputText: "input",
            composedText: "system\ninput",
          },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      /** キャンセル期限の検証を割当量の取得から切り離す。 */
      async getProviderQuotaTelemetry() {
        return null;
      },
      /** 準備中キャンセルの対象スレッドには無効化処理を実行しない。 */
      async invalidateSessionThread() {},
      /** 準備中の単一 Turn の検証では全スレッドを無効化しない。 */
      async invalidateAllSessionThreads() {},
      /** 準備中のキャンセルでも Provider が呼ばれたかどうかを記録する。 */
      async runSessionTurn() {
        providerCalled = true;
        return createPartialResult();
      },
    };

    const service = createTestRuntime({
      /** 準備が止まっている Session を返す。 */
      getSession() {
        return session;
      },
      /** 更新結果だけを返し、準備処理の検証では永続化しない。 */
      upsertSession(next) {
        return next;
      },
      /** テストが解放するまで入力プレビューを未完了のままにする。 */
      resolveComposerPreview() {
        return new Promise<ComposerPreview>((resolve) => {
          resolveComposer = resolve;
        });
      },
      /** 入力プレビューが完了した際に使うキャラクターを返す。 */
      async resolveSessionCharacter() {
        return createCharacter();
      },
      /** キャンセル期限の検証に使う既定の設定を返す。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** 準備完了後に選択できる Provider をカタログと選択結果に用意する。 */
      resolveProviderCatalog() {
        return {
          snapshot: { providers: [createProviderCatalog()] },
          provider: createProviderCatalog(),
        };
      },
      /** 実行に到達したかを記録するアダプターを返す。 */
      getProviderCodingAdapter() {
        return adapter;
      },
      /** 準備が先に進んだ場合の Turn レコードを構築する。 */
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      /** 準備中にキャンセルしたケースでは Turn の更新を記録しない。 */
      updateSessionTurn() {},
      /** 準備中のキャンセルの検証に進捗の保存を加えない。 */
      setLiveSessionRun() {},
      /** 準備前の実行表示はないものとして扱う。 */
      getLiveSessionRun() {
        return null;
      },
      /** 準備後に承認を待つ場合は許可する。 */
      async waitForApprovalDecision(
        _sessionId,
        _request,
        _signal,
      ): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      /** 準備後に追加質問へ到達した場合は回答せずに取り消す。 */
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      /** キャンセル期限を確認するケースでは割当量を保存しない。 */
      setProviderQuotaTelemetry() {},
      /** 準備中にキャンセルするケースではコンテキスト情報の更新は扱わない。 */
      setSessionContextTelemetry() {},
      /** 準備中のキャンセルではアダプターのスレッド切断を実行しない。 */
      async invalidateProviderSessionThread() {},
      /** キャンセル期限の検証では割当量の再取得を予約しない。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** 準備中のキャンセルに伴う表示状態を外部へ通知しない。 */
      broadcastLiveSessionRun() {},
      /** 入力準備中のため保留中の承認は処理しない。 */
      resolvePendingApprovalRequest() {},
      /** 入力準備中のため保留中の質問応答は処理しない。 */
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
      providerCancelGraceMs: 5,
    });

    const runPromise = service.runSessionTurn(session.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "お願いします",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!resolveComposer) {
      throw new Error("composer setup が開始されていないよ。");
    }
    assert.equal(service.isRunInFlight(session.id), true);
    service.cancelRun(session.id);
    const outcome = await Promise.race([
      runPromise.then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<"deadline">((resolve) =>
        setTimeout(() => resolve("deadline"), 25),
      ),
    ]);

    assert.equal(service.hasInFlightRuns(), true);
    await assert.rejects(
      service.runSessionTurn(session.id, {
        executionOptions: TEST_EXECUTION_OPTIONS,
        userMessage: "再送",
      }),
      /This session is already running/,
    );
    if (!resolveComposer) {
      throw new Error("composer resolve が取得できていないよ。");
    }
    resolveComposer!({ attachments: [], errors: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(outcome, "rejected");
    assert.equal(providerCalled, false);
    assert.equal(service.hasInFlightRuns(), false);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "quitはproviderを先にcancelし、非協力providerの猶予満了後もterminal保存を待ってDBを閉じ、実終了までは再送を拒否する"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#app-quit" }
  // fault = "cancelより先に送信結果を待つか、cancel猶予と同時にquitがtimeoutするか、terminal保存前にDBを閉じる"
  // observable = "provider abort、保存gate中のDB close回数、quit完了、再送拒否、provider実終了後のin-flight解除"
  // observation_boundary = "public-boundary"
  // scope = "runtime-bridge-lifecycle-quit"
  // lifecycle = "permanent"
  // distinction = "実runtimeの非協力providerとbridge・lifecycleを接続し、復元保存単体では検出できない停止順序と待機期限を確認する"
  // @end-test-value
  /** キャンセル済みの Session でも、Provider が解放される前の再送は拒否し、終端の保存後に終了することを確かめる。 */
  it("provider が cancel 後も生存する間は terminal session への再送を拒否する", async () => {
    const session = createSession();
    const approvalResolutions: Array<{
      sessionId: string;
      decision: LiveApprovalDecision;
    }> = [];
    let observedAbortSignal: AbortSignal | undefined;
    let observedAbort = false;
    let providerStarted!: () => void;
    const providerReady = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    let terminalStarted!: () => void;
    const terminalReady = new Promise<void>((resolve) => {
      terminalStarted = resolve;
    });
    let releaseTerminal!: () => void;
    const terminalGate = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    let terminalStored = false;
    /** キャンセルに即応しない Provider をテストの任意の時点で完了させる。 */
    let resolveProvider: (result: RunSessionTurnResult) => void = () =>
      undefined;
    const adapter: ProviderCodingAdapter = {
      /** 追加の入力処理で Provider の開始が遅れないよう固定のプロンプトを返す。 */
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: {
            systemText: "system",
            inputText: "input",
            composedText: "system\ninput",
          },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      /** キャンセルで生存する Provider の検証に割当量を混ぜない。 */
      async getProviderQuotaTelemetry() {
        return null;
      },
      /** キャンセル後の生存期間はスレッドを無効化しても短縮しない。 */
      async invalidateSessionThread() {},
      /** 単一の Provider 実行を扱うため全スレッド無効化は行わない。 */
      async invalidateAllSessionThreads() {},
      /** 中止シグナルと開始を観測し、シグナル発火後もテストが完了させるまで実行を止めない。 */
      runSessionTurn(input) {
        observedAbortSignal = input.signal;
        if (!input.signal) {
          throw new Error("AbortSignal が渡されていないよ。");
        }
        const signal = input.signal;
        observedAbort = signal.aborted;
        signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
          },
          { once: true },
        );
        providerStarted();
        return new Promise<RunSessionTurnResult>((resolve) => {
          resolveProvider = resolve;
        });
      },
    };

    const service = createTestRuntime({
      /** 再送の拒否を確認する Session を返す。 */
      getSession() {
        return session;
      },
      /** 通常の Session 保存では終端保存のゲートを通さない。 */
      upsertSession(next) {
        return next;
      },
      /** 入力準備を追加の待ち時間なしで完了させる。 */
      async resolveComposerPreview() {
        return { attachments: [], errors: [] };
      },
      /** キャンセル前に実行を開始できるキャラクター設定を返す。 */
      async resolveSessionCharacter() {
        return createCharacter();
      },
      /** キャンセルと再送の順序を既定の設定で確認する。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** 開始に必要な Provider をカタログと選択結果に用意する。 */
      resolveProviderCatalog() {
        return {
          snapshot: { providers: [createProviderCatalog()] },
          provider: createProviderCatalog(),
        };
      },
      /** 中止シグナルを観測しつつ処理を継続するアダプターを返す。 */
      getProviderCodingAdapter() {
        return adapter;
      },
      /** キャンセル前に開始した Turn のレコードを作る。 */
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      /** このケースでは保存順序を Session 側で観測し、Turn の更新は記録しない。 */
      updateSessionTurn() {},
      /** Provider の生存期間の検証に実行表示を保存しない。 */
      setLiveSessionRun() {},
      /** 再送を止める判定に使う既存の表示状態を用意しない。 */
      getLiveSessionRun() {
        return null;
      },
      /** 承認を要求した場合は、キャンセル前の Turn が進めるよう許可する。 */
      async waitForApprovalDecision(
        _sessionId,
        _request,
        _signal,
      ): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      /** 追加質問が発生した場合は応答せずに取り消す。 */
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      /** Provider の終了順序の検証に割当量の保存を混ぜない。 */
      setProviderQuotaTelemetry() {},
      /** 再送の検証ではコンテキスト情報の更新を保持しない。 */
      setSessionContextTelemetry() {},
      /** スレッドの切断によって Provider の完了を早めない。 */
      async invalidateProviderSessionThread() {},
      /** アプリ終了までの順序に割当量の更新を追加しない。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** 実行の終了順を外部への表示イベントとは切り離す。 */
      broadcastLiveSessionRun() {},
      /** キャンセル経路で保留中の承認に与えられた決定を呼び出し順に記録する。 */
      resolvePendingApprovalRequest(sessionId, decision) {
        approvalResolutions.push({ sessionId, decision });
      },
      /** 終端保存の開始を通知し、テストが解放してから保存済みとする。 */
      async upsertTerminalSession(next) {
        terminalStarted();
        await terminalGate;
        terminalStored = true;
        return next;
      },
      /** 終端保存の順序とは独立した質問応答は解決しない。 */
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const promise = service.runSessionTurn(session.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "お願いします",
    });
    await providerReady;
    if (!observedAbortSignal) {
      throw new Error("provider setup が開始されていないよ。");
    }
    // すでに閉じた Window からはレンダラーの ACK が来ない。それでも Main は、
    // `AppLifecycle` が永続化層を閉じる前に、送信をキャンセルしてそのライフサイクルの完了を待つ必要がある。
    const bridge = new SessionWindowBridge({
      /** この終了テストで Session ウィンドウを開こうとしたら失敗させる。 */
      createWindow() {
        throw new Error("no Window should be created");
      },
      /** 終了の検証ではチャット画面をロードしない。 */
      async loadChatEntry() {},
      /** 終了対象として参照する Session を返す。 */
      getSession: () => session,
      /** ウィンドウ側からサービスの実行中判定を参照する。 */
      isRunInFlight: (id) => service.isRunInFlight(id),
      /** 実行中のウィンドウを閉じる確認は承認する。 */
      confirmCloseWhileRunning: () => true,
      /** アプリ終了の検証では開いているウィンドウの ID を配信しない。 */
      broadcastOpenSessionWindowIds() {},
      /** ウィンドウ側のキャンセル要求をサービスの全実行に渡す。 */
      cancelInFlightSessionRuns: () => service.cancelAllRuns(),
      /** 保留中の送信は、実行の呼び出しが完了するまで待ってから終了可能とする。 */
      waitForPendingDraftSends: async () => {
        await promise;
        return true;
      },
    });
    let closeCount = 0;
    let quitCount = 0;
    const lifecycle = new AppLifecycleService({
      /** サービスに残っている実行をアプリ終了の判定に使う。 */
      hasInFlightSessionRuns: () => service.hasInFlightRuns(),
      /** 実行中のまま終了するには確認が必要な設定にする。 */
      getAllowQuitWithInFlightRuns: () => false,
      /** 終了を許可する設定の書き込みは保存しない。 */
      setAllowQuitWithInFlightRuns() {},
      /** 終了の検証中に Home ウィンドウは作成しない。 */
      async createHomeWindow() {},
      /** ウィンドウがなくなったことだけではアプリを終了させない。 */
      shouldQuitWhenAllWindowsClosed: () => false,
      /** 実行中のアプリ終了を利用者が承認したことにする。 */
      confirmQuitWhileRunning: () => true,
      /** アプリ終了時にウィンドウ側のドラフト処理を通す。 */
      flushSessionWindowDrafts: () => bridge.flushSessionWindowDrafts(),
      /** 永続ストアの閉鎖が終端の保存より後であることを検証し、閉鎖回数を記録する。 */
      closePersistentStores: () => {
        assert.equal(terminalStored, true);
        closeCount += 1;
      },
      /** アプリ終了が実際に要求された回数を記録する。 */
      quitApp: () => {
        quitCount += 1;
      },
    });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const quitting = lifecycle.handleBeforeQuit({
        /** アプリ終了イベントの既定動作を抑止する入口を用意する。 */ preventDefault() {},
      });
      assert.equal(observedAbort, true);
      assert.equal(bridge.isQuitPending(), true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      mock.timers.tick(DEFAULT_PROVIDER_CANCEL_GRACE_MS);
      await terminalReady;
      mock.timers.tick(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(closeCount, 0);
      assert.equal(quitCount, 0);
      assert.equal(
        bridge.isQuitPending(),
        true,
        "quit must allow persistence time after cancellation grace",
      );
      releaseTerminal();
      await quitting;
      assert.equal(closeCount, 1);
      assert.equal(quitCount, 1);
    } finally {
      mock.timers.reset();
    }
    const result = await promise;

    if (!observedAbortSignal) {
      throw new Error("abort signal が観測できていないよ。");
    }
    assert.equal(observedAbort, true);
    assert.equal(result.runState, "idle");
    assert.equal(service.hasInFlightRuns(), true);
    await assert.rejects(
      service.runSessionTurn(session.id, {
        executionOptions: TEST_EXECUTION_OPTIONS,
        userMessage: "再送",
      }),
      /This session is already running/,
    );
    if (!resolveProvider) {
      throw new Error("provider resolve が取得できていないよ。");
    }
    resolveProvider!(createPartialResult());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.hasInFlightRuns(), false);
    assert.deepEqual(approvalResolutions, [
      { sessionId: session.id, decision: "deny" },
      { sessionId: session.id, decision: "deny" },
    ]);
  });

  // @test-value v2
  // kind = "regression"
  // claim = "利用者cancelとprovider成功が競合してもterminal通知を依頼しない"
  // oracle = { type = "contract", ref = "accepted contract: user cancel is not a failure notification" }
  // fault = "cancel後に到着したprovider成功をcompleted通知し、利用者の中止操作と矛盾する"
  // scope = "session-runtime-terminal-cancel-race"
  // observable = "terminal通知呼び出し回数と保存済みrunState"
  // observation_boundary = "public-boundary"
  // lifecycle = "permanent"
  // distinction = "通常のprovider canceled errorではなく、cancel後にproviderがgrace内で成功する競合を扱う"
  // @end-test-value
  /** キャンセル後の猶予内に Provider が成功しても、結果を残して完了通知を出さないことを確かめる。 */
  it("cancel 後に provider が grace 内で成功しても完了通知しない", async () => {
    const session = createSession();
    /** キャンセルを開始してから Provider を成功させるために結果を渡す。 */
    let resolveProvider: (result: RunSessionTurnResult) => void = () =>
      undefined;
    let notificationCount = 0;
    const adapter: ProviderCodingAdapter = {
      /** キャンセルと成功の競合を固定のプロンプトで再現する。 */
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: {
            systemText: "system",
            inputText: "input",
            composedText: "system\ninput",
          },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      /** キャンセル後に成功する経路では割当量を取得しない。 */
      async getProviderQuotaTelemetry() {
        return null;
      },
      /** 対象スレッドの無効化では実行を終わらせず、成功結果を待てるようにする。 */
      async invalidateSessionThread() {},
      /** 単一の Turn を扱うテストでは全スレッドを変更しない。 */
      async invalidateAllSessionThreads() {},
      /** キャンセル後まで完了を保留し、テストから成功結果を渡せるようにする。 */
      runSessionTurn() {
        return new Promise<RunSessionTurnResult>((resolve) => {
          resolveProvider = resolve;
        });
      },
    };

    const service = createTestRuntime({
      /** 後から成功した応答を書き込む対象の Session を返す。 */
      getSession() {
        return session;
      },
      /** 保存に渡された更新後の Session をそのまま返す。 */
      upsertSession(next) {
        return next;
      },
      /** 入力準備を待たず、キャンセルと実行完了の競合へ進めるようにする。 */
      async resolveComposerPreview() {
        return { attachments: [], errors: [] };
      },
      /** 競合を再現する Turn に必要なキャラクターを返す。 */
      async resolveSessionCharacter() {
        return createCharacter();
      },
      /** キャンセル時の通知の有無を既定の設定で確認する。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** 実行に使う Provider をカタログと選択結果に用意する。 */
      resolveProviderCatalog() {
        return {
          snapshot: { providers: [createProviderCatalog()] },
          provider: createProviderCatalog(),
        };
      },
      /** 成功の時刻をテストから操作できるアダプターを返す。 */
      getProviderCodingAdapter() {
        return adapter;
      },
      /** キャンセル前に実行を始めるための Turn レコードを作る。 */
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      /** 成功時の通知を観測し、Turn 履歴の更新は保持しない。 */
      updateSessionTurn() {},
      /** キャンセル後の成功を確認するケースでは表示状態を保存しない。 */
      setLiveSessionRun() {},
      /** 成功した応答の反映に既存の表示状態を持ち込まない。 */
      getLiveSessionRun() {
        return null;
      },
      /** 承認要求が発生した場合は許可する。 */
      async waitForApprovalDecision(): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      /** 追加質問が発生した場合は応答を待たずに取り消す。 */
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      /** 完了通知の有無を調べるケースなので割当量の更新を保持しない。 */
      setProviderQuotaTelemetry() {},
      /** 成功時の通知の検証にコンテキスト情報の更新を混ぜない。 */
      setSessionContextTelemetry() {},
      /** キャンセルによるスレッド切断は模擬実行の成功結果を変えない。 */
      async invalidateProviderSessionThread() {},
      /** 成功結果を得てもこのテストで割当量の取得を予約しない。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** 実行状態の配信とは独立に終端通知を検証する。 */
      broadcastLiveSessionRun() {},
      /** このケースには解決対象となる保留中の承認がない。 */
      resolvePendingApprovalRequest() {},
      /** このケースには解決対象となる保留中の質問がない。 */
      resolvePendingElicitationRequest() {},
      /** キャンセル後の成功に対して依頼された終端通知の回数を記録する。 */
      notifySessionTurnTerminal() {
        notificationCount += 1;
      },
      currentTimestampLabel,
      providerCancelGraceMs: 1_000,
    });

    const runPromise = service.runSessionTurn(session.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "お願いします",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!resolveProvider) {
      throw new Error("provider resolve が取得できていないよ。");
    }

    service.cancelRun(session.id);
    resolveProvider(createPartialResult({ assistantText: "完了したよ。" }));
    const result = await runPromise;

    assert.equal(result.runState, "idle");
    assert.equal(result.messages.at(-1)?.text, "完了したよ。");
    assert.equal(notificationCount, 0);
  });

  // @test-value v2
  // kind = "regression"
  // claim = "利用者cancel後にproviderがgrace内でnoncanceled errorを返してもfailed terminal通知を依頼しない"
  // oracle = { type = "contract", ref = "accepted contract: user cancel is not a failure notification" }
  // fault = "adapterがcancel前にcanceled=falseを確定して遅延rejectすると、abort済みturnをfailed通知して利用者に失敗と誤認させる"
  // scope = "session-runtime-terminal-cancel-race"
  // observable = "failed terminal通知呼び出し回数と保存済みrunState"
  // observation_boundary = "public-boundary"
  // lifecycle = "permanent"
  // distinction = "cancel後のprovider成功ではなく、grace内にcanceled=falseのProviderTurnErrorがrejectする経路を扱う"
  // @end-test-value
  /** キャンセル後の猶予内に Provider がキャンセル以外のエラーを返しても、失敗通知を出さないことを確かめる。 */
  it("cancel 後に provider が grace 内で noncanceled error を返しても失敗通知しない", async () => {
    const session = createSession();
    /** 利用者がキャンセルした後に Provider を任意のエラーで失敗させる。 */
    let rejectProvider: (error: Error) => void = () => undefined;
    let notificationCount = 0;
    const adapter: ProviderCodingAdapter = {
      /** 失敗が入力構成でなく Provider から生じるように固定のプロンプトを返す。 */
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: {
            systemText: "system",
            inputText: "input",
            composedText: "system\ninput",
          },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      /** 失敗通知の検証では取得済みの割当量を用意しない。 */
      async getProviderQuotaTelemetry() {
        return null;
      },
      /** スレッドの無効化では保留中の Provider 実行を終了させない。 */
      async invalidateSessionThread() {},
      /** 単一 Session のキャンセルで全スレッドの無効化は扱わない。 */
      async invalidateAllSessionThreads() {},
      /** テストからエラーを渡すまで Provider の実行を保留する。 */
      runSessionTurn() {
        return new Promise<RunSessionTurnResult>((_resolve, reject) => {
          rejectProvider = reject;
        });
      },
    };

    const service = createTestRuntime({
      /** キャンセル後の失敗状態を反映する Session を返す。 */
      getSession() {
        return session;
      },
      /** 永続化は行わず、失敗状態を反映した Session の値を呼び出し元に返す。 */
      upsertSession(next) {
        return next;
      },
      /** 失敗の発生源を Provider に限定するため、添付と入力エラーを用意しない。 */
      async resolveComposerPreview() {
        return { attachments: [], errors: [] };
      },
      /** Provider の実行に必要なキャラクターを返す。 */
      async resolveSessionCharacter() {
        return createCharacter();
      },
      /** キャンセル後の失敗通知の扱いを既定のアプリ設定で確認する。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** エラーを返す Provider をカタログと選択結果の両方に用意する。 */
      resolveProviderCatalog() {
        return {
          snapshot: { providers: [createProviderCatalog()] },
          provider: createProviderCatalog(),
        };
      },
      /** 利用者のキャンセル後に失敗させるアダプターを返す。 */
      getProviderCodingAdapter() {
        return adapter;
      },
      /** Provider を開始するための Turn レコードを構築する。 */
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      /** Session の状態と通知を確認し、Turn 履歴の更新は保存しない。 */
      updateSessionTurn() {},
      /** 失敗通知の確認では表示進捗を書き込まない。 */
      setLiveSessionRun() {},
      /** キャンセル前から残っている表示進捗はないものとして扱う。 */
      getLiveSessionRun() {
        return null;
      },
      /** 承認の待ち時間を追加せずに許可する。 */
      async waitForApprovalDecision(): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      /** 質問を待つ処理が呼ばれた場合は取り消しを返す。 */
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      /** 失敗状態の反映と別に割当量が更新されても保存しない。 */
      setProviderQuotaTelemetry() {},
      /** 通知の検証に不要なコンテキスト情報は保持しない。 */
      setSessionContextTelemetry() {},
      /** キャンセルによるスレッド切断で模擬 Provider の失敗を早めない。 */
      async invalidateProviderSessionThread() {},
      /** 失敗後に割当量の再取得は予約しない。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** エラー状態の配信は記録せず終端通知だけを観測する。 */
      broadcastLiveSessionRun() {},
      /** 失敗通知の検証に保留中の承認処理を混ぜない。 */
      resolvePendingApprovalRequest() {},
      /** 失敗通知の検証に保留中の追加質問の解決を混ぜない。 */
      resolvePendingElicitationRequest() {},
      /** キャンセル後にエラーが出た際の終端通知要求を数える。 */
      notifySessionTurnTerminal() {
        notificationCount += 1;
      },
      currentTimestampLabel,
      providerCancelGraceMs: 1_000,
    });

    const runPromise = service.runSessionTurn(session.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "お願いします",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!rejectProvider) {
      throw new Error("provider reject が取得できていないよ。");
    }

    service.cancelRun(session.id);
    rejectProvider!(
      new ProviderTurnError(
        "workspace snapshot failed",
        createPartialResult(),
        false,
      ),
    );
    const result = await runPromise;

    assert.equal(result.runState, "error");
    assert.equal(notificationCount, 0);
  });

  // @test-value v2
  // kind = "regression"
  // claim = "adapter呼出後のstaleエラーはpartialがなくても再実行せず、元の開始入力に一度だけFailedを保存・通知する"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#persistence-expectations" }
  // fault = "履歴やpartialが空のstaleエラーで、入力を新しいProvider threadへ自動送信する"
  // scope = "SessionRuntimeService adapter failure and terminal persistence"
  // observable = "adapter呼出のthread、保存済みuser/assistant、Turn phaseとterminal通知回数"
  // observation_boundary = "public-boundary"
  // lifecycle = "permanent"
  // @end-test-value
  /** アダプターの実行後に古いスレッドのエラーが発生した場合は、途中結果がなくても同じ Turn を再実行しないことを確かめる。 */
  it("adapter呼出後のstale errorはpartialがなくても再実行しない", async () => {
    const session = createSession({
      provider: "copilot",
      threadId: "thread-stale",
    });
    const storedSessions: Session[] = [];
    const invalidated: Array<{
      providerId: string | null | undefined;
      sessionId: string;
    }> = [];
    const reset: Array<{
      providerId: string | null | undefined;
      sessionId: string;
    }> = [];
    const turnUpdates: UpdateSessionTurnInput[] = [];
    const seenThreadIds: string[] = [];
    const seenBindingGenerations: Array<string | undefined> = [];
    let bindingGeneration = 0;
    const fixedObservedAt = new Date("2026-08-04T12:32:00.000Z");

    let attempt = 0;
    let notificationCount = 0;
    let currentDateCount = 0;
    const runtimeTurnHandles: object[] = [];
    const endedRuntimeTurnHandles: unknown[] = [];
    const seenTurnCapabilities: Array<string | undefined> = [];

    const adapter: ProviderCodingAdapter = {
      /** スレッド失効時の処理を固定のプロンプトで検証できるようにする。 */
      composePrompt(input) {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: {
            systemText: "system",
            inputText: "input",
            composedText: "system\ninput",
          },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      /** 古いスレッドからのエラー処理では割当量を取得しない。 */
      async getProviderQuotaTelemetry() {
        return null;
      },
      /** 古いスレッドの解放を記録するのは依存先のフックとし、アダプター側では行わない。 */
      async invalidateSessionThread() {},
      /** スレッド失効の検証では全スレッドを無効化しない。 */
      async invalidateAllSessionThreads() {},
      /** 実行時のスレッドとバインディングを記録し、最初は失効エラー、意図せず再実行された場合は成功を返す。 */
      async runSessionTurn(input) {
        attempt += 1;
        seenThreadIds.push(input.session.threadId);
        seenBindingGenerations.push(
          input.agentRuntimeBinding?.executionGeneration,
        );
        seenTurnCapabilities.push(input.agentRuntimeBinding?.turnCapability);
        if (attempt === 1) {
          throw new ProviderTurnError(
            "thread not found",
            createPartialResult({ threadId: "thread-stale" }),
            false,
          );
        }

        return createPartialResult({
          threadId: "thread-fresh",
          assistantText: "再試行で成功したよ。",
        });
      },
    };

    const service = createTestRuntime({
      /** 失効スレッドを保持する Session は対象 ID に一致したときだけ返す。 */
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      /** 失効エラーの処理で書き込まれた Session の状態を記録する。 */
      upsertSession(next) {
        storedSessions.push(next);
        return next;
      },
      /** スレッド失効の発生源をアダプターに絞るため、添付も入力エラーも返さない。 */
      async resolveComposerPreview() {
        return { attachments: [], errors: [] };
      },
      /** Copilot の実行に必要なキャラクターを返す。 */
      async resolveSessionCharacter() {
        return createCharacter();
      },
      /** 古いスレッドの再試行方針を確認するため Copilot を有効にする。 */
      getAppSettings() {
        return normalizeAppSettings({
          codingProviderSettings: { copilot: { enabled: true } },
        });
      },
      /** 失効したスレッドを使う Copilot をカタログと選択結果に載せる。 */
      resolveProviderCatalog() {
        return {
          snapshot: { providers: [createProviderCatalog("copilot")] },
          provider: createProviderCatalog("copilot"),
        };
      },
      /** 古いスレッドに対してエラーを返すアダプターを選択する。 */
      getProviderCodingAdapter() {
        return adapter;
      },
      /** 再実行の有無を見分けられるよう、取得するたびに異なる世代の実行バインディングを作る。 */
      getProviderAgentRuntimeBinding({ session: bindingSession, provider }) {
        bindingGeneration += 1;
        return {
          bindingId: `binding-${bindingGeneration}`,
          bindingReference: `reference-${bindingGeneration}`,
          providerId: provider.id,
          executionGeneration: `generation-${bindingGeneration}`,
          transport: "env",
          expiresAt: null,
        };
      },
      /** 最初の世代でランタイム Turn を開始することを確認し、終了処理を追跡できるハンドルと Turn capability を渡す。 */
      beginProviderAgentRuntimeTurn({ binding }) {
        assert.equal(binding?.executionGeneration, "generation-1");
        const handle = {};
        runtimeTurnHandles.push(handle);
        return {
          handle,
          binding: binding
            ? { ...binding, turnCapability: "turn-capability-a" }
            : null,
        };
      },
      /** 失効エラーの終了処理で閉じたランタイム Turn のハンドルを記録する。 */
      endProviderAgentRuntimeTurn(handle) {
        endedRuntimeTurnHandles.push(handle);
      },
      /** 最初の試行に対応する Turn 履歴を構築する。 */
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      /** 失効エラー後に履歴へ保存した Turn の状態を記録する。 */
      updateSessionTurn(_id, entry) {
        turnUpdates.push(entry);
      },
      /** スレッド失効の検証では表示状態を書き込まない。 */
      setLiveSessionRun() {},
      /** 再実行の判断に既存の表示状態を持ち込まない。 */
      getLiveSessionRun() {
        return null;
      },
      /** 失効エラーより前に承認を要求した場合は許可する。 */
      async waitForApprovalDecision(
        _sessionId,
        _request,
        _signal,
      ): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      /** 失効エラーより前に追加質問を要求した場合は取り消す。 */
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      /** このスレッド失効ケースでは割当量を保存しない。 */
      setProviderQuotaTelemetry() {},
      /** 再実行の有無を確認するケースにコンテキスト情報を保持しない。 */
      setSessionContextTelemetry() {},
      /** 古いスレッドを無効化した Provider と Session の組を記録する。 */
      invalidateProviderSessionThread(providerId, retrySessionId) {
        invalidated.push({ providerId, sessionId: retrySessionId });
      },
      /** 新たな実行の準備としてスレッドをリセットした対象を記録する。 */
      resetProviderSessionThread(providerId, retrySessionId) {
        reset.push({ providerId, sessionId: retrySessionId });
      },
      /** 失効エラーの後処理では割当量の再取得を予約しない。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** 画面への配信とは独立に失効後の処理を検証する。 */
      broadcastLiveSessionRun() {},
      /** 失効エラーの検証で保留中の承認は解決しない。 */
      resolvePendingApprovalRequest() {},
      /** 失効エラーの検証で保留中の質問応答は解決しない。 */
      resolvePendingElicitationRequest() {},
      /** 失効エラーの終端通知の要求を数える。 */
      notifySessionTurnTerminal() {
        notificationCount += 1;
      },
      currentTimestampLabel,
      /** 観測時刻を固定し、再試行などで余分に取得していないかを数える。 */
      currentDate() {
        currentDateCount += 1;
        return fixedObservedAt;
      },
    });

    const result = await service.runSessionTurn(session.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "お願いします",
    });
    await waitForCondition(
      () => turnUpdates.length === 1,
      "元TurnのFailedが保存されること",
    );

    assert.equal(result.runState, "error");
    assert.equal(result.threadId, "");
    assert.equal(result.messages.at(-1)?.text, "");
    assert.match(result.messages.at(-1)?.runFailure ?? "", /thread not found/i);
    assert.equal(
      result.messages.filter((message) => message.role === "user").length,
      1,
    );
    assert.equal(
      result.messages.filter((message) => message.role === "assistant").length,
      1,
    );
    assert.deepEqual(seenThreadIds, ["thread-stale"]);
    assert.deepEqual(seenBindingGenerations, ["generation-1"]);
    assert.deepEqual(seenTurnCapabilities, ["turn-capability-a"]);
    assert.equal(bindingGeneration, 1);
    assert.equal(runtimeTurnHandles.length, 1);
    assert.deepEqual(endedRuntimeTurnHandles, runtimeTurnHandles);
    assert.deepEqual(reset, []);
    assert.deepEqual(invalidated, [
      { providerId: "copilot", sessionId: session.id },
    ]);
    assert.equal(storedSessions.length, 2);
    assert.equal(storedSessions[1]?.threadId, "");
    assert.equal(turnUpdates.length, 1);
    assert.equal(turnUpdates.at(-1)?.phase, "failed");
    assert.equal(notificationCount, 1);
    assert.equal(currentDateCount, 1);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "usage_limit reasonは最小turnと応答の失敗理由へ利用制限と再開可能時刻を保存する"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Error Handling" }
  // fault = "usage limitを通常provider failureとして表示し、利用者の制限理由を隠す"
  // observable = "turn error fieldsとassistant runFailure"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService usage limit failure mapping"
  // lifecycle = "permanent"
  // @end-test-value
  /** 割当量制限エラーの理由を Turn 履歴と保存された応答に残し、途中のテキストも保持することを確かめる。 */
  it("usage_limit reason は最小turnと応答の失敗理由に保存する", async () => {
    const session = createSession({
      provider: "codex",
      threadId: "thread-before-limit",
    });
    const storedSessions: Session[] = [];
    const turnUpdates: UpdateSessionTurnInput[] = [];
    const usageLimitMessage =
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jun 12th, 2026 2:07 AM.";

    const adapter: ProviderCodingAdapter = {
      /** 割当量制限をアダプターから発生させるため、入力の組み立ては固定する。 */
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: {
            systemText: "system",
            inputText: "input",
            composedText: "system\ninput",
          },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      /** 取得済み割当量ではなく実行時エラーの理由を検証する。 */
      async getProviderQuotaTelemetry() {
        return null;
      },
      /** 割当量制限の検証では対象スレッドの無効化を行わない。 */
      async invalidateSessionThread() {},
      /** 割当量制限で失敗する単独の Turn では全スレッド無効化を扱わない。 */
      async invalidateAllSessionThreads() {},
      /** 同じスレッドの途中結果を添えた割当量制限エラーを返す。 */
      async runSessionTurn() {
        throw new ProviderTurnError(
          usageLimitMessage,
          createPartialResult({ threadId: "thread-before-limit" }),
          false,
          "usage_limit",
        );
      },
    };

    const service = createTestRuntime({
      /** 割当量制限で失敗する Session を、対応する ID で取得する。 */
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      /** 失敗理由と途中の応答が書き込まれた Session の値を記録する。 */
      upsertSession(next) {
        storedSessions.push(next);
        return next;
      },
      /** 入力エラーを混ぜず割当量制限エラーまで進める。 */
      async resolveComposerPreview() {
        return { attachments: [], errors: [] };
      },
      /** 割当量制限で失敗する Turn のキャラクターを返す。 */
      async resolveSessionCharacter() {
        return createCharacter();
      },
      /** 割当量制限の理由の変換を既定の設定で確認する。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** 割当量制限を返す Provider のカタログと選択結果を用意する。 */
      resolveProviderCatalog() {
        return {
          snapshot: { providers: [createProviderCatalog()] },
          provider: createProviderCatalog(),
        };
      },
      /** 割当量制限エラーを発生させるアダプターを返す。 */
      getProviderCodingAdapter() {
        return adapter;
      },
      /** 失敗理由を書き込む先の Turn レコードを作る。 */
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      /** 割当量制限の理由が履歴に保存されたかを照合できるようにする。 */
      updateSessionTurn(_id, entry) {
        turnUpdates.push(entry);
      },
      /** 割当量制限の検証では表示進捗の書き込みを保持しない。 */
      setLiveSessionRun() {},
      /** 割当量制限エラーが発生する前の表示進捗は用意しない。 */
      getLiveSessionRun() {
        return null;
      },
      /** 承認で停止せず、割当量制限を返すアダプターまで進める。 */
      async waitForApprovalDecision() {
        return "approve" as const;
      },
      /** 追加質問が発生したら受け付けずに取り消す。 */
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      /** 制限理由の検証と別に割当量が更新されても保持しない。 */
      setProviderQuotaTelemetry() {},
      /** 制限理由の永続化の検証にコンテキスト情報を混ぜない。 */
      setSessionContextTelemetry() {},
      /** 割当量制限エラーが発生した Session に対するスレッド切断は実行しない。 */
      async invalidateProviderSessionThread() {},
      /** 割当量制限の理由の保存は割当量の再取得なしで検証する。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** エラーの表示状態は外部へ配信しない。 */
      broadcastLiveSessionRun() {},
      /** 割当量制限のケースでは保留中の承認の解決を記録しない。 */
      resolvePendingApprovalRequest() {},
      /** 割当量制限のケースでは保留中の質問の解決を記録しない。 */
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "お願いします",
    });
    await waitForCondition(
      () => turnUpdates.at(-1)?.phase === "failed",
      "usage limit最小turnが保存されること",
    );
    const expectedMessage =
      "Codex usage limit reached.\nTry again at: Jun 12th, 2026 2:07 AM";

    assert.equal(result.runState, "error");
    assert.equal(turnUpdates.at(-1)?.phase, "failed");
    assert.equal(turnUpdates.at(-1)?.errorMessage, expectedMessage);
    assert.equal(
      storedSessions.at(-1)?.messages.at(-1)?.runFailure,
      expectedMessage,
    );
    assert.equal(
      storedSessions.at(-1)?.messages.at(-1)?.text,
      createPartialResult().assistantText,
    );
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Codexのstale失敗は再実行せず取得済みpartial本文をerror Sessionへ保持する"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: runSessionTurnInternal catch; docs/design/provider-adapter.md: Error Handling / 通常履歴と最小turn" }
  // fault = "Codexの失敗を自動再実行する、取得済み本文を返却履歴から落とす、またはerror Session保存とthread invalidationを省く"
  // observable = "Codex adapter呼出数、返却SessionのrunState/最終本文、Session保存数とinvalidation対象"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService stale error partial handling"
  // lifecycle = "permanent"
  // @end-test-value
  /** 表示可能な途中応答を伴うスレッド失効では、再実行せず対象スレッドを無効化することを確かめる。 */
  it("meaningful partial が出た stale error は internal retry しない", async () => {
    const session = createSession({
      provider: "codex",
      threadId: "thread-stale",
    });
    const storedSessions: Session[] = [];
    const invalidated: Array<{
      providerId: string | null | undefined;
      sessionId: string;
    }> = [];
    let attempt = 0;

    const adapter: ProviderCodingAdapter = {
      /** スレッド失効の原因を入力準備から分離するため、固定のプロンプトを返す。 */
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: {
            systemText: "system",
            inputText: "input",
            composedText: "system\ninput",
          },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      /** 途中応答を伴う失効の検証に取得済みの割当量を持ち込まない。 */
      async getProviderQuotaTelemetry() {
        return null;
      },
      /** 失効時に無効化した対象はサービス側の依存先で記録し、ここでは変更しない。 */
      async invalidateSessionThread() {},
      /** 途中応答を伴う単一の失効で全スレッドを無効化しない。 */
      async invalidateAllSessionThreads() {},
      /** 実行回数を数え、表示できる途中応答付きのスレッド失効エラーを発生させる。 */
      async runSessionTurn() {
        attempt += 1;
        throw new ProviderTurnError(
          "thread not found",
          createPartialResult({ assistantText: "途中まで出たよ。" }),
          false,
        );
      },
    };

    const service = createTestRuntime({
      /** 失効済みのスレッドを保持する Session を返す。 */
      getSession() {
        return session;
      },
      /** 失効に伴う Session の保存を順番に記録する。 */
      upsertSession(next) {
        storedSessions.push(next);
        return next;
      },
      /** スレッド失効の発生前には添付や入力エラーで止めない。 */
      async resolveComposerPreview() {
        return { attachments: [], errors: [] };
      },
      /** 失効済みスレッドに送信する Turn のキャラクターを返す。 */
      async resolveSessionCharacter() {
        return createCharacter();
      },
      /** 途中応答付き失効時の保存処理を既定の設定で確認する。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** 失効したスレッドで送信する Provider をカタログと選択結果に用意する。 */
      resolveProviderCatalog() {
        return {
          snapshot: { providers: [createProviderCatalog()] },
          provider: createProviderCatalog(),
        };
      },
      /** 途中応答を伴う失効エラーを返すアダプターを使う。 */
      getProviderCodingAdapter() {
        return adapter;
      },
      /** 失効エラーを返す実行の Turn レコードを用意する。 */
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      /** 失効後の状態は Session の保存で確認し、Turn の更新は記録しない。 */
      updateSessionTurn() {},
      /** 途中応答の検証では表示状態を書き込まない。 */
      setLiveSessionRun() {},
      /** エラーに添付された途中応答だけを検証できるよう、以前の表示状態は用意しない。 */
      getLiveSessionRun() {
        return null;
      },
      /** スレッド失効前に承認が必要になった場合は許可する。 */
      async waitForApprovalDecision(
        _sessionId,
        _request,
        _signal,
      ): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      /** スレッド失効前に追加質問が出た場合は取り消す。 */
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      /** スレッド失効と途中応答の検証では割当量の更新を保持しない。 */
      setProviderQuotaTelemetry() {},
      /** 途中応答とスレッド失効の検証ではコンテキスト情報を保存しない。 */
      setSessionContextTelemetry() {},
      /** 途中応答付きエラーの処理で無効化した Provider と Session を控える。 */
      invalidateProviderSessionThread(providerId, retrySessionId) {
        invalidated.push({ providerId, sessionId: retrySessionId });
      },
      /** 失効時に割当量の再取得は予約しない。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** 失効後の保存を検証し、画面向け進捗は配信しない。 */
      broadcastLiveSessionRun() {},
      /** 途中応答付き失効のケースでは保留中の承認を解決しない。 */
      resolvePendingApprovalRequest() {},
      /** 途中応答付き失効のケースでは保留中の質問を解決しない。 */
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "お願いします",
    });

    assert.equal(attempt, 1);
    assert.equal(result.runState, "error");
    assert.equal(result.messages.at(-1)?.text, "途中まで出たよ。");
    assert.equal(result.messages.at(-1)?.runFailure, "thread not found");
    assert.deepEqual(invalidated, [
      { providerId: "codex", sessionId: session.id },
    ]);
    assert.equal(storedSessions.length, 2);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "not_foundを返したCodex/OpenCode turnは再送せず、既知threadを保持したerror Sessionとして返る"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: runSessionTurnInternal catch / invalidateProviderSessionThreadBestEffort; docs/design/provider-adapter.md: Error Handling" }
  // fault = "汎用not_found errorで入力を自動再送する、既知threadを消す、またはerror Session保存やinvalidationを省く"
  // observable = "adapter呼出数、返却SessionのthreadId/runState/runFailure、Session保存数とinvalidation対象"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService provider error classification"
  // lifecycle = "permanent"
  // @end-test-value
  /** Codex と OpenCode で `not_found` だけのエラーを受けても実行を再試行せず、対象スレッドを無効化することを確かめる。 */
  it("not_found 単独 code の provider error では internal retry しない", async () => {
    for (const providerId of ["codex", "opencode"]) {
      const session = createSession({
        provider: providerId,
        threadId: "thread-stale",
      });
      const storedSessions: Session[] = [];
      const invalidated: Array<{
        providerId: string | null | undefined;
        sessionId: string;
      }> = [];
      let attempt = 0;

      const adapter: ProviderCodingAdapter = {
        /** 両 Provider で入力条件を揃え、エラーコード以外の差を持ち込まない。 */
        composePrompt() {
          return {
            systemBodyText: "system",
            inputBodyText: "input",
            logicalPrompt: {
              systemText: "system",
              inputText: "input",
              composedText: "system\ninput",
            },
            imagePaths: [],
            additionalDirectories: [],
          };
        },
        /** `not_found` の判定に取得済みの割当量を含めない。 */
        async getProviderQuotaTelemetry() {
          return null;
        },
        /** サービスが指定した無効化対象だけを別の依存先で記録する。 */
        async invalidateSessionThread() {},
        /** 各 Provider の個別の失敗に対して全スレッドを無効化しない。 */
        async invalidateAllSessionThreads() {},
        /** 呼び出し回数を数え、スレッド固有の情報を含まない `not_found` エラーを発生させる。 */
        async runSessionTurn() {
          attempt += 1;
          const error = new ProviderTurnError(
            "resource not found",
            createPartialResult(),
            false,
          ) as ProviderTurnError & { code?: string };
          error.code = "not_found";
          throw error;
        },
      };

      const service = createTestRuntime({
        /** 現在の反復で検証している Provider の Session を返す。 */
        getSession() {
          return session;
        },
        /** Provider ごとに Session の保存回数と書き込んだ値を検証できるよう記録する。 */
        upsertSession(next) {
          storedSessions.push(next);
          return next;
        },
        /** 添付や入力エラーを用意せず、Provider のエラーまで進める。 */
        async resolveComposerPreview() {
          return { attachments: [], errors: [] };
        },
        /** 各 Provider の検証に同じキャラクター設定を使う。 */
        async resolveSessionCharacter() {
          return createCharacter();
        },
        /** 現在の反復で検証している Provider を有効にする。 */
        getAppSettings() {
          return normalizeAppSettings({
            codingProviderSettings: { [providerId]: { enabled: true } },
          });
        },
        /** 検証中の Provider をカタログと選択結果に用意する。 */
        resolveProviderCatalog() {
          return {
            snapshot: { providers: [createProviderCatalog(providerId)] },
            provider: createProviderCatalog(providerId),
          };
        },
        /** 共通の `not_found` エラーを返す模擬アダプターを選択する。 */
        getProviderCodingAdapter() {
          return adapter;
        },
        /** `not_found` エラーを発生させる Turn の履歴を作る。 */
        createSessionTurn(input) {
          return createSessionTurnBase(input);
        },
        /** 再実行の有無はアダプターの呼び出しで数え、Turn 更新は保持しない。 */
        updateSessionTurn() {},
        /** 再実行の判断に画面向け進捗の書き込みを持ち込まない。 */
        setLiveSessionRun() {},
        /** 用途を特定しないエラーの検証で既存の進捗表示を用意しない。 */
        getLiveSessionRun() {
          return null;
        },
        /** エラーを返す前に承認を待つ場合は許可する。 */
        async waitForApprovalDecision(
          _sessionId,
          _request,
          _signal,
        ): Promise<LiveApprovalDecision> {
          return "approve" as const;
        },
        /** エラーを返す前に質問が発生した場合は取り消す。 */
        async waitForElicitationResponse() {
          return { action: "cancel" } as const;
        },
        /** Provider 間の再実行方針を比べる際に割当量は更新しない。 */
        setProviderQuotaTelemetry() {},
        /** この比較ではコンテキスト情報の更新を保持しない。 */
        setSessionContextTelemetry() {},
        /** 各 Provider の失敗処理で無効化したスレッドの対象を記録する。 */
        invalidateProviderSessionThread(providerId, retrySessionId) {
          invalidated.push({ providerId, sessionId: retrySessionId });
        },
        /** `not_found` の処理では割当量の再取得を予約しない。 */
        scheduleProviderQuotaTelemetryRefresh() {},
        /** 再実行回数と保存を検証するケースでは進捗を配信しない。 */
        broadcastLiveSessionRun() {},
        /** `not_found` のケースでは保留中の承認を解決しない。 */
        resolvePendingApprovalRequest() {},
        /** `not_found` のケースでは保留中の質問応答を解決しない。 */
        resolvePendingElicitationRequest() {},
        currentTimestampLabel,
      });

      const result = await service.runSessionTurn(session.id, {
        executionOptions: {
          ...TEST_EXECUTION_OPTIONS,
          approvalMode: "on-request",
        },
        userMessage: "お願いします",
      });

      assert.equal(attempt, 1);
      assert.equal(result.runState, "error");
      assert.equal(result.messages.at(-1)?.runFailure, "resource not found");
      assert.equal(result.threadId, "thread-stale");
      assert.deepEqual(invalidated, [{ providerId, sessionId: session.id }]);
      assert.equal(storedSessions.length, 2);
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "成功turnの通知には保存されたcompleted Sessionと同じ内容を渡し、通知Promise rejectionはturn成功を変更しない"
  // oracle = { type = "adr", ref = "docs/adr/006-windows-session-turn-notifications.md" }
  // fault = "保存結果と異なるSessionを通知するか、通知Promise rejectionでcompleted turnをfailedへ変更する"
  // scope = "session-runtime-completed-terminal-notification"
  // observable = "通知へ渡される保存済みSessionとturn結果"
  // observation_boundary = "public-boundary"
  // lifecycle = "permanent"
  // @end-test-value
  /** 成功通知が保存した応答を含み、通知自体の失敗では成功した Turn が失敗に変わらないことを確かめる。 */
  it("Session success の保存内容を通知し、通知 failure は turn を失敗させない", async () => {
    const session = createSession();
    let persistedCompletedSession: Session | null = null;
    let notifiedSession: Session | null = null;
    const adapter: ProviderCodingAdapter = {
      /** 通知の検証用に添付や追加ディレクトリのない固定プロンプトを返す。 */
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: {
            systemText: "system",
            inputText: "input",
            composedText: "system\ninput",
          },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      /** 終端通知と独立に割当量は取得しない。 */
      async getProviderQuotaTelemetry() {
        return null;
      },
      /** 成功した Turn の通知ではスレッドの無効化を行わない。 */
      async invalidateSessionThread() {},
      /** 単独の成功通知の検証に全スレッド操作を持ち込まない。 */
      async invalidateAllSessionThreads() {},
      /** 通知内容と照合できるスレッド ID とアシスタント応答を返す。 */
      async runSessionTurn() {
        return createPartialResult({
          threadId: "thread-1",
          assistantText: "完了したよ。",
        });
      },
    };

    const service = createTestRuntime({
      /** 通知対象とは異なる ID には Session が存在しないものとする。 */
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      /** アシスタントの応答を含む待機状態を保存値として記録し、通知に渡った Session と比較する。 */
      upsertSession(next) {
        if (
          next.runState === "idle" &&
          next.messages.at(-1)?.role === "assistant"
        ) {
          persistedCompletedSession = next;
        }
        return next;
      },
      /** 成功時の通知へ進むため、入力エラーや添付のないプレビューを用意する。 */
      async resolveComposerPreview() {
        return { attachments: [], errors: [] } satisfies ComposerPreview;
      },
      /** 成功応答を返す Turn のキャラクターを用意する。 */
      async resolveSessionCharacter() {
        return createCharacter();
      },
      /** 成功応答の通知を既定設定で確認する。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** 成功応答を返す Provider をカタログと選択結果に登録する。 */
      resolveProviderCatalog() {
        return {
          snapshot: { providers: [createProviderCatalog()] },
          provider: createProviderCatalog(),
        };
      },
      /** 通知と照合する応答を作るアダプターを返す。 */
      getProviderCodingAdapter() {
        return adapter;
      },
      /** 成功として終わる Turn の初期レコードを作る。 */
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      /** 通知と照合する対象を Session の保存内容に絞り、Turn 更新は記録しない。 */
      updateSessionTurn() {},
      /** 成功通知の比較では実行進捗を保存しない。 */
      setLiveSessionRun() {},
      /** 通知用の Session に既存の実行進捗を含めない。 */
      getLiveSessionRun() {
        return null;
      },
      /** Turn が承認を要求したら許可して成功通知まで進める。 */
      async waitForApprovalDecision(): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      /** Turn が追加質問を出したら取り消す。 */
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      /** 保存した応答と通知を比べる検証に割当量を書き込まない。 */
      setProviderQuotaTelemetry() {},
      /** 成功通知の確認にコンテキスト情報の更新を混ぜない。 */
      setSessionContextTelemetry() {},
      /** 通知の失敗をアダプターの失敗として扱わず、スレッド切断も行わない。 */
      async invalidateProviderSessionThread() {},
      /** 成功通知の検証では割当量の再取得を予約しない。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** 実行状態の配信は行わず終端通知だけを記録する。 */
      broadcastLiveSessionRun() {},
      /** 成功通知の検証では保留中の承認を解決しない。 */
      resolvePendingApprovalRequest() {},
      /** 成功通知の検証では保留中の質問を解決しない。 */
      resolvePendingElicitationRequest() {},
      /** 通知に渡された成功時の Session を保存し、通知失敗のエラーを返す。 */
      notifySessionTurnTerminal(notification) {
        assert.equal(notification.outcome, "completed");
        notifiedSession = notification.session;
        return Promise.reject(new Error("notification failed"));
      },
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "お願い",
    });

    assert.equal(result.runState, "idle");
    assert.equal(result.messages.at(-1)?.text, "完了したよ。");
    assert.deepEqual(notifiedSession, result);
    const { messageCount, ...persistedProjection } = result;
    assert.equal(messageCount, result.messages.length);
    assert.deepEqual(persistedCompletedSession, persistedProjection);
    assert.equal(
      (notifiedSession as Session | null)!.messages.at(-1)?.text,
      "完了したよ。",
    );
  });
});
