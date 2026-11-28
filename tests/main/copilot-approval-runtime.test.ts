import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import {
  CopilotSession,
  type CopilotClient,
  type PermissionRequestedData,
  type SessionConfig,
  type SessionEvent,
} from "@github/copilot-sdk";
import { CopilotAdapter } from "../../src-electron/providers/copilot/copilot-adapter.js";
import { SessionApprovalService } from "../../src-electron/session/session-approval-service.js";
import {
  ApprovalReviewInputFence,
  WithMateApprovalReviewTurn,
} from "../../src-electron/session/withmate-approval-review.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { SessionRuntimeFixture } from "./session-runtime-fixture.js";

/** SDKの保留中権限要求への応答を、送信先Session ID付きで捕捉するための型。 */
type PermissionWire = Parameters<
  CopilotSession["rpc"]["permissions"]["handlePendingPermissionRequest"]
>[0] & { sessionId: string };
/** 審査役の単発結果と、審査役が利用できない技術失敗を区別する。 */
type Review = "allow_once" | "deny" | "ask_user" | "technical-failure";

/** 実SDKの通知経路にテスト用RPCと審査役を接続し、通知・手動判断・SDK応答を個別に待てるようにする。 */
function createCopilotReadRuntime(options: {
  workspacePath: string;
  review: Review;
  reviewerMode?: "user" | "auto-review";
  reviewerOff?: boolean;
}) {
  const { workspacePath } = options;
  const selection = {
    providerId: "codex",
    model: "fixture-reviewer",
    reasoningEffort: "high",
  } as const;
  const catalog: ModelCatalogProvider = {
    id: "copilot",
    label: "Copilot",
    defaultModelId: "gpt-4.1",
    defaultReasoningEffort: "high",
    models: [{ id: "gpt-4.1", label: "GPT-4.1", reasoningEfforts: ["high"] }],
  };
  let stored = buildNewSession({
    provider: "copilot",
    model: "gpt-4.1",
    reasoningEffort: "high",
    approvalMode: "on-request",
    taskTitle: "Copilot read fixture",
    workspaceLabel: "fixture",
    workspacePath,
    branch: "fixture",
    characterId: "fixture",
    character: "Fixture",
    characterIconPath: "",
    characterThemeColors: { main: "#000000", sub: "#ffffff" },
  });
  if (options.reviewerMode)
    stored = {
      ...stored,
      codexReviewer: options.reviewerMode,
      withMateReviewerExplicit: true,
    };
  let live: LiveSessionRunState | null = null;
  let turn = 0;
  let eventId = 0;
  let opened = 0;
  let session: CopilotSession;
  const published = Promise.withResolvers<string>();
  const publishedIds: string[] = [];
  const notifications: string[] = [];
  const outbound = Promise.withResolvers<PermissionWire>();
  const sent = Promise.withResolvers<void>();
  const reviewing = Promise.withResolvers<string>();
  const reviewerDone = Promise.withResolvers<void>();
  /** 連番IDを割り振った合成通知を、実SDK Sessionのイベントディスパッチャーへ渡す。 */
  const emit = <E extends SessionEvent["type"]>(
    type: E,
    data: Extract<SessionEvent, { type: E }>["data"],
  ) => {
    // バージョンを固定した SDK の実際のイベントディスパッチャーを通じて、サーバー通知を配信する。
    Reflect.get(session, "_dispatchEvent").call(session, {
      type,
      data,
      id: `event-${++eventId}`,
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
    });
  };
  const wire = {
    /** 送信の開始と保留権限への応答を捕捉し、想定外のSDKリクエストをテスト失敗にする。 */
    async sendRequest(method: string, payload: unknown) {
      switch (method) {
        case "session.send":
          sent.resolve();
          return { messageId: "synthetic-input" };
        case "session.eventLog.registerInterest":
          return { handle: "synthetic-interest" };
        case "session.eventLog.releaseInterest":
          return {};
        case "session.detach":
          return { success: true };
        case "session.abort":
          emit("session.idle", {});
          return {};
        case "session.permissions.handlePendingPermissionRequest":
          outbound.resolve(payload as PermissionWire);
          return { success: true };
        default:
          throw new Error(`Unexpected synthetic native request: ${method}`);
      }
    },
  };
  /** 接続せずに実SDK Sessionを構築し、アダプターが渡した権限ハンドラーを登録する。 */
  const createSession = async (config: SessionConfig) => {
    // パッケージのコンストラクターと設定登録は、通常 `CopilotClient` が呼ぶ内部メソッドである。
    // ここでは通信経路もプロセスも初期化しない。
    session = Reflect.construct(CopilotSession, [
      "synthetic-native-session",
      wire,
    ]);
    Reflect.get(session, "registerPermissionHandler").call(
      session,
      config.onPermissionRequest,
    );
    return session;
  };
  const adapter = new CopilotAdapter({
    /** 合成通信を使うSDK Sessionを返すスタブクライアントを供給する。 */
    createClient: () =>
      ({
        createSession,
        /** スタブクライアントの停止では実プロセスを扱わず、エラーを返さない。 */
        stop: async () => [],
      }) as unknown as CopilotClient,
  });
  const approvals = new SessionApprovalService({
    /** 進行中の状態を更新し、新たに公開された承認要求IDだけを記録する。 */
    updateLiveSessionRun: (_sessionId, update) => {
      if (!live) return null;
      const previousId = live.approvalRequest?.requestId;
      live = update(live);
      const id = live.approvalRequest?.requestId;
      if (id && id !== previousId) publishedIds.push(id);
      return live;
    },
    /** 承認通知のIDを記録し、手動判断可能な時点を待機側へ伝える。 */
    notifyApproval: (_sessionId, requestId) => {
      notifications.push(requestId);
      published.resolve(requestId);
    },
  });
  const runtime = new SessionRuntimeFixture({
    /** Fixtureに保持しているSessionをランタイムから読み出せるようにする。 */
    getSession: () => stored,
    /** 更新されたSessionを次の読込に使えるようメモリに保持する。 */
    upsertSession: (next) => (stored = next),
    /** 合成ターンに連番IDを付けて入力フィールドを保持する。 */
    createSessionTurn: (data) => ({ id: ++turn, ...data }),
    /** 承認経路の検証ではターン更新を外部へ永続化しない。 */
    updateSessionTurn() {},
    /** Copilotを有効化し、ケースに応じて審査設定を選択先または未設定として渡す。 */
    getAppSettings: () =>
      normalizeAppSettings({
        withMateAutoReview: options.reviewerOff ? null : selection,
        codingProviderSettings: { copilot: { enabled: true } },
      }),
    /** 合成通知を受ける実Copilotアダプターをランタイムへ渡す。 */
    getProviderCodingAdapter: () => adapter,
    /** 固定モデルを含むカタログと、その中のCopilot定義を返す。 */
    resolveProviderCatalog: () => ({
      snapshot: { revision: 1, providers: [catalog] },
      provider: catalog,
    }),
    /** 添付のない合成メッセージ向けに空のプレビュー結果を返す。 */
    resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
    /** 実外部資格情報を使わず、合成ターン専用のランタイム結び付けを返す。 */
    beginProviderAgentRuntimeTurn: () => ({
      handle: "synthetic-handle",
      binding: {
        bindingId: "synthetic-binding",
        bindingReference: "synthetic-capability",
        providerId: "copilot",
        executionGeneration: "synthetic-generation",
        transport: "env",
        expiresAt: null,
      },
    }),
    /** 指定された審査先を検査してから、固定ポリシーの合成審査ターンを作る。 */
    startWithMateApprovalReview: (input) => {
      assert.deepEqual(input.selection, selection);
      return new WithMateApprovalReviewTurn({
        ...input,
        source: {
          kind: "main",
          sessionId: stored.id,
          incarnationId: "synthetic-incarnation",
        },
        inputs: new ApprovalReviewInputFence(),
        /** このフィクスチャでは審査開始後にポリシーを変更しない。 */
        policyCurrent: () => true,
        /** 審査が開かれた回数を記録し、テストで結果を制御できる審査役を返す。 */
        open: async () => {
          opened++;
          return {
            /** 合成審査役には閉じるべき通信やプロセスがない。 */
            close() {},
            /** 審査本文を公開して検査を待ち、ケース指定の判断または技術失敗を返す。 */
            review: async (prompt) => {
              reviewing.resolve(prompt);
              await reviewerDone.promise;
              if (options.review === "technical-failure")
                throw new Error("Synthetic reviewer unavailable");
              return {
                decision: options.review,
                reason: "Synthetic reviewer result",
              };
            },
          };
        },
      });
    },
    /** ランタイムから通知された進行状態をFixtureへ反映する。 */
    setLiveSessionRun: (_id, next) => {
      live = next;
    },
    /** 承認要求が公開中か確認できるよう、現在保持する進行状態を返す。 */
    getLiveSessionRun: () => live,
    /** ランタイムを実承認サービスの決着待ちへつなぐ。 */
    waitForApprovalDecision: (...args) =>
      approvals.waitForLiveApprovalDecision(...args),
    /** 承認経路と無関係な追加質問にはキャンセルを返す。 */
    waitForElicitationResponse: () => ({ action: "cancel" }),
    /** 審査の発行を検証するフィクスチャでは利用枠の測定値を保存しない。 */
    setProviderQuotaTelemetry() {},
    /** コンテキストの測定値は合成権限通知の結果に使わないため保存しない。 */
    setSessionContextTelemetry() {},
    /** 利用枠のバックグラウンド更新は起動しない。 */
    scheduleProviderQuotaTelemetryRefresh() {},
    /** スレッド無効化を実Copilotアダプターへ委譲する。 */
    invalidateProviderSessionThread: (_provider, id) =>
      adapter.invalidateSessionThread(id),
    /** 外部Windowへの進行状態配信は行わず、Fixtureの状態を直接観測する。 */
    broadcastLiveSessionRun() {},
    /** 汎用の承認解決通知では状態を変えず、手動判断を実承認サービスに任せる。 */
    resolvePendingApprovalRequest() {},
    /** 追加入力が発生しない経路なので質問の解決通知は記録しない。 */
    resolvePendingElicitationRequest() {},
  });

  return {
    /** テスト側に現在の承認欄を含む進行状態を公開する。 */
    live: () => live,
    publishedIds,
    notifications,
    /** ケースごとに審査役が開かれた回数を返す。 */
    opened: () => opened,
    reviewing: reviewing.promise,
    reviewerDone,
    pending: published.promise,
    outbound: outbound.promise,
    /** 公開された要求IDを使い、同じSessionの保留承認を手動で確定する。 */
    manual: (requestId: string, decision: "approve" | "deny") =>
      approvals.resolveLiveApproval(stored.id, requestId, decision),
    /** 保存した実行オプションを使って、合成Readの依頼でターンを開始する。 */
    start: () =>
      runtime.runSessionTurn(stored.id, {
        userMessage: "Read the synthetic fixture",
        executionOptions: captureSessionExecutionOptions(stored),
      }),
    /** SDKへの入力送信まで待ってから、権限要求を実SDK Sessionへ配信する。 */
    async request(data: PermissionRequestedData) {
      await sent.promise;
      emit("permission.requested", data);
    },
    /** SDK Sessionをidleにし、ランタイムのターンを完了させる。 */
    finish: () => emit("session.idle", {}),
    /** 審査の待機と承認を解消し、SDK Sessionとキャッシュ済みスレッドを片付ける。 */
    async cleanup() {
      reviewerDone.resolve();
      approvals.reset();
      if (session) emit("session.idle", {});
      await adapter.invalidateAllSessionThreads();
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "Copilotの単発の明示判断Readは設定した審査先へ渡り、ask_userだけが公開され、人と審査と技術失敗の結果は別のSDK応答になる"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: CopilotAdapterのon-requestとSDK応答; docs/design/withmate-auto-review.md#一件の判定と手動承認" }
// fault = "明示判断を人間専用と誤る、pendingを先に公開する、または審査結果・失敗を人間の決定に変換する"
// observable = "審査役への実要求、live承認欄と公開通知hook、SDKのpending permission RPC本文"
// observation_boundary = "consumer"
// scope = "合成native通知から固定SDK、CopilotAdapter、SessionRuntime、実承認キュー、審査Turnを経由してSDK応答まで"
// lifecycle = "permanent"
// distinction = "callback単体ではSDKによる出所転送や、実Turnでの選択審査先と手動公開を観測できない"
// @end-test-value
/** SDKの合成Read要求が審査または手動判断に渡る順序と、SDK応答に残る判断主体をケース別に確認する。 */
it(
  "Copilotの合成Readは実SDKと共通runtimeを通り決着主体を維持する",
  { timeout: 10_000 },
  async (t) => {
    const root = path.resolve("synthetic-copilot-approval-workspace");
    t.mock.method(os, "homedir", () => root);
    const read = {
      kind: "read",
      path: path.join(root, "synthetic.txt"),
      intention: "Read one fixture",
    } as const;
    const explicit = {
      status: "completed",
      recommendation: "requireApproval",
    } as const;
    for (const scenario of [
      {
        label: "ordinary classification",
        review: "allow_once",
        native: { permissionRequest: read },
        expected: "approve-once",
      },
      {
        label: "review allow",
        review: "allow_once",
        expected: "approve-once",
        source: "host_policy",
      },
      {
        label: "review deny",
        review: "deny",
        expected: "user-not-available",
        source: "host_policy",
      },
      {
        label: "review ask_user",
        review: "ask_user",
        manual: "approve",
        expected: "approve-once",
        source: "human_response",
      },
      {
        label: "review failure",
        review: "technical-failure",
        expected: "user-not-available",
        source: "unattended_fallback",
      },
      {
        label: "managed Auto Review",
        review: "allow_once",
        native: {
          permissionRequest: { ...read, managedApprovalRequired: true },
        },
        expected: "user-not-available",
        source: "unattended_fallback",
      },
      {
        label: "managed User",
        review: "allow_once",
        reviewerMode: "user",
        native: { promptRequest: { ...read, managedApprovalRequired: true } },
        manual: "deny",
        expected: "reject",
        source: "human_response",
      },
      {
        label: "explicit Auto Review Off",
        review: "allow_once",
        reviewerMode: "auto-review",
        reviewerOff: true,
        expected: "user-not-available",
        source: "unattended_fallback",
      },
    ] as const) {
      const f = createCopilotReadRuntime({ workspacePath: root, ...scenario });
      const run = f.start();
      try {
        const eligible = scenario.label.startsWith("review ");
        const data: PermissionRequestedData = {
          requestId: "synthetic-read-request",
          permissionRequest: read,
          ...(scenario.label === "ordinary classification"
            ? {}
            : { promptRequest: read, assistedApprovalAssessment: explicit }),
          ...("native" in scenario ? scenario.native : {}),
        };
        await f.request(data);
        if (eligible) {
          const first = await Promise.race([
            f.reviewing.then((prompt) => ({ boundary: "review", prompt })),
            f.pending.then(() => ({ boundary: "manual", prompt: "" })),
            f.outbound.then(() => ({
              boundary: "native response",
              prompt: "",
            })),
          ]);
          assert.equal(first.boundary, "review", scenario.label);
          const prompt = JSON.parse(first.prompt);
          assert.deepEqual(prompt.pendingOperation.operation, {
            request: read,
            workspacePath: root,
            promptRequest: read,
            assistedApprovalAssessment: explicit,
          });
          assert.deepEqual(f.notifications, []);
          assert.equal(f.live()?.approvalRequest, null);
          f.reviewerDone.resolve();
        }
        const manualDecision =
          "manual" in scenario ? scenario.manual : undefined;
        const expectedPublications: string[] = [];
        if (manualDecision !== undefined) {
          const requestId = await f.pending;
          expectedPublications.push(requestId);
          assert.equal(f.live()?.approvalRequest?.requestId, requestId);
          f.manual(requestId, manualDecision);
        }
        const response = await f.outbound;
        assert.equal(
          response.sessionId,
          "synthetic-native-session",
          scenario.label,
        );
        assert.equal(response.requestId, data.requestId, scenario.label);
        assert.deepEqual(
          response.result,
          { kind: scenario.expected },
          scenario.label,
        );
        assert.equal(
          response.decisionContext?.source,
          "source" in scenario ? scenario.source : undefined,
          scenario.label,
        );
        assert.equal(f.opened(), Number(eligible), scenario.label);
        assert.deepEqual(f.publishedIds, expectedPublications, scenario.label);
        assert.deepEqual(f.notifications, expectedPublications, scenario.label);
        assert.equal(f.live()?.approvalRequest, null);
        f.finish();
        assert.equal((await run).runState, "idle");
      } finally {
        await f.cleanup();
      }
    }
  },
);
