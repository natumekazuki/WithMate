import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runWithMateSessionCli } from "../../src-cli/session/withmate-session.js";
import { createWithMateSessionMcpServer } from "../../src-electron/platform/mcp/withmate-session-mcp.js";
import type {
  callAgentRuntime,
  AgentRuntimeConnection,
} from "../../src-electron/platform/agent-runtime/runtime-client.js";
import {
  SessionManagementApplication,
  SessionManagementError,
} from "../../src-electron/session/session-management-application.js";
import { SessionManagementRuntimeService } from "../../src-electron/session/session-management-runtime-service.js";
import { SessionOperatingPolicyService } from "../../src-electron/session/session-operating-policy-service.js";
import {
  MainSessionTurnQueueFacade,
  SessionTurnQueuePreflightRejectedError,
} from "../../src-electron/app/main-session-turn-queue-facade.js";
import { SessionTurnQueueService } from "../../src-electron/session/session-turn-queue-service.js";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import { getSessionAgentRuntimeOperations } from "../../src-shared/session/session-management-contract.js";
import {
  buildNewSession,
  getSessionIncarnationId,
  type Session,
} from "../../src-shared/session/session-state.js";
import {
  captureSessionExecutionOptions,
  type SessionExecutionOptions,
} from "../../src-shared/session/session-execution-options.js";
import type { SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";
import {
  createDefaultAppSettings,
  DEFAULT_PROVIDER_APP_SETTINGS,
} from "../../src-shared/settings/provider-settings-state.js";
import { SessionPersistenceService } from "../../src-electron/session/session-persistence-service.js";
import { MainSessionCommandFacade } from "../../src-electron/app/main-session-command-facade.js";
import { ProviderRuntimeOperationCoordinator } from "../../src-electron/providers/provider-runtime-operation-coordinator.js";
import { ChildSessionCreationRejectedError } from "../../src-electron/session/session-storage-errors.js";
import { SessionRuntimeService } from "../../src-electron/session/session-runtime-service.js";
import { composeProviderPrompt } from "../../src-electron/providers/provider-prompt.js";
import type { RunSessionTurnInput } from "../../src-electron/providers/provider-runtime.js";

/** 世代を添えてキューや公開操作の Main 宛先を組み立てる。 */
const target = (session: Session) => ({
  kind: "main" as const,
  sessionId: session.id,
  incarnationId: getSessionIncarnationId(session),
});
const connection: AgentRuntimeConnection = {
  api: {
    baseUrl: "http://127.0.0.1:7777",
    apiSecret: "secret",
    applicationInstanceId: "instance",
    runtimeGenerationId: "generation",
  },
  credential: { adapter: "mcp", adapterSecret: "adapter" },
};

/** 実際の SQLite Worker と両公開入口を使い、親子の実行設定を追跡できるようにする。 */
async function fixture(provider = "codex") {
  const directory = await mkdtemp(join(tmpdir(), "withmate-enqueue-settings-"));
  const options = {
    dbPath: join(directory, "withmate-v6.db"),
    userDataPath: directory,
    workerUrl: new URL(
      "../../src-electron/storage/storage-worker-entry.ts",
      import.meta.url,
    ),
    handlerModule: new URL(
      "../../src-electron/storage/storage-worker-bundle.ts",
      import.meta.url,
    ),
    workerOptions: { execArgv: ["--import", "tsx"] },
  };
  let bundle = createV6StorageWorkerBundle(options);
  await bundle.initialize();
  /** 親の有無に応じて Crew のルートまたは実行担当の子を DB に保存する。 */
  const create = (id: string, parentSessionId?: string) =>
    bundle.stores.session.insertSession(
      buildNewSession({
        id,
        taskTitle: id,
        workspaceLabel: id,
        workspacePath: join(directory, id),
        branch: "main",
        characterId: "unknown",
        character: "Unknown",
        characterIconPath: "",
        characterThemeColors: { main: "#123456", sub: "#abcdef" },
        provider,
        model: "deep",
        reasoningEffort: "high",
        approvalMode: "on-request",
        sessionRole: parentSessionId ? "executor" : "overall-coordinator",
        rootSessionId: parentSessionId ?? id,
        parentSessionId: parentSessionId ?? null,
        createdBySessionId: parentSessionId ?? null,
      }),
    );
  const parent = await create("parent"),
    child = await create("child", parent.id);
  const sourceTurns = new Map<string, string>();
  for (const session of [parent, child]) {
    const turn = await bundle.stores.turn.createSessionTurn({
      sessionId: session.id,
      phase: "running",
      createdAt: new Date().toISOString(),
      provider,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      approvalMode: session.approvalMode,
      threadId: "",
      errorMessage: "",
    });
    sourceTurns.set(session.id, String(turn.id));
  }
  const bindings = new AgentRuntimeBindingRegistry(),
    turns = new ProviderAgentRuntimeTurnCoordinator();
  const settings = createDefaultAppSettings();
  const models = [
    { id: "fast", label: "Fast", reasoningEfforts: ["low"] },
    { id: "deep", label: "Deep", reasoningEfforts: ["high"] },
    { id: "plain", label: "Plain", reasoningEfforts: [] },
  ];
  const catalogs = ["codex", "copilot", "claude", "opencode"].map((id) => ({
    id,
    label: id,
    defaultModelId: "deep",
    defaultReasoningEffort: "high",
    models,
  }));
  for (const { id } of catalogs)
    settings.codingProviderSettings[id] = {
      ...DEFAULT_PROVIDER_APP_SETTINGS,
      enabled: true,
    };
  /** 指定したプロバイダーの検証用モデルと Depth 候補を返す。 */
  const catalogFor = (id: string) =>
    catalogs.find((catalog) => catalog.id === id)!;
  /** 検証対象外の依存が呼ばれた時点で失敗させる。 */
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected operation");
  };
  let cached = await bundle.stores.session.listSessions();
  const persistence = new SessionPersistenceService({
    /** 永続化サービスが参照するメモリー上の Session 一覧を返す。 */
    getSessions: () => cached,
    /** 保存後の一覧更新をメモリーに反映する。 */
    setSessions: (next) => {
      cached = next;
    },
    /** 一覧を ID で検索する。 */
    getSession: (id) => cached.find((item) => item.id === id) ?? null,
    /** キャッシュを介さず保存済みの Session を取得する。 */
    getStoredSession: (id) => bundle.stores.session.getSession(id),
    /** 永続化サービスには実行中の Session がないものとして扱わせる。 */
    isSessionRunInFlight: () => false,
    /** 新規作成と更新を区別して SQLite Worker に渡す。 */
    upsertStoredSession: (session, operation) =>
      operation === "create"
        ? bundle.stores.session.insertSession(session)
        : bundle.stores.session.updateSession(session),
    /** 保存済み Session の一括置換を Worker に委譲する。 */
    replaceStoredSessions: async (sessions) => {
      await bundle.stores.session.replaceSessions(sessions);
    },
    /** DB 内の Session 一覧を取得する。 */
    listStoredSessions: () => bundle.stores.session.listSessions(),
    /** 保存済み Session の要約を読み出す。 */
    listStoredSessionSummaries: () =>
      bundle.stores.session.listSessionSummaries(),
    /** 指定した ID のライフサイクル操作を取得する。 */
    getSessionLifecycleOperation: (id) =>
      bundle.stores.session.getSessionLifecycleOperation(id),
    /** 途中まで進んだライフサイクル操作を列挙する。 */
    listPendingSessionLifecycleOperations: () =>
      bundle.stores.session.listPendingSessionLifecycleOperations(),
    /** 作成の進行を追跡するライフサイクル操作の初期記録を保存する。 */
    beginSessionLifecycleOperation: (input) =>
      bundle.stores.session.beginSessionLifecycleOperation(input),
    /** 作成前の準備結果を対象ライフサイクル操作へ保存する。 */
    prepareSessionLifecycleCreation: (id, input) =>
      bundle.stores.session.prepareSessionLifecycleCreation(id, input),
    /** ライフサイクル操作の段階と確保済みリソースを進める。 */
    advanceSessionLifecycleOperation: (id, phase, resources) =>
      bundle.stores.session.advanceSessionLifecycleOperation(
        id,
        phase,
        resources,
      ),
    /** Turn 開始時の Session 更新を実際のストアへ渡す。 */
    appendStoredRunningTurnStart: (input) =>
      bundle.stores.session.appendRunningTurnStart(input),
    /** Turn 終了時の Session の状態を実際のストアへ渡す。 */
    appendStoredSessionTerminal: (input) =>
      bundle.stores.session.appendSessionTerminal(input),
    /** 実行中に更新されたメタデータを SQLite に保存する。 */
    checkpointStoredSessionRunMetadata: (input) =>
      bundle.stores.session.checkpointSessionRunMetadata(input),
    /** テスト内で変更した共通設定の現在値を返す。 */
    getAppSettings: () => settings,
    /** 実プロバイダーを問い合わせず全モデル候補を返す。 */
    getModelCatalogSnapshot: () => ({ providers: catalogs }),
    /** 画面なしの検証ではコンテキスト計測を消去しない。 */
    clearSessionContextTelemetry() {},
    /** 実プロバイダーにスレッドの無効化を送らない。 */
    invalidateProviderSessionThread() {},
    /** 開いていない Session ウィンドウの終了処理を省く。 */
    closeSessionWindow() {},
    /** 保存後の一覧を画面へ配信しない。 */
    broadcastSessions() {},
  });
  const coordinator = new ProviderRuntimeOperationCoordinator();
  let childSequence = 0;
  const commands = new MainSessionCommandFacade({
    /** 作成コマンドが読む Session の一覧キャッシュを返す。 */
    getSessions: () => cached,
    /** 作成コマンドが参照する Session を ID で探す。 */
    getSession: (id) => cached.find((item) => item.id === id) ?? null,
    /** 作成判定に使う保存済み Session の要約を返す。 */
    getStoredSessionSummaries: () =>
      bundle.stores.session.listSessionSummaries(),
    /** 現在接続中の Worker を保存先の識別子として返す。 */
    getSessionStorageIdentity: () => bundle,
    /** プロバイダー操作を本番相当の排他境界で実行する。 */
    runProviderRuntimeOperationExclusive: (operation) =>
      coordinator.runExclusive(operation),
    resolveSessionLaunchSelection: unused,
    /** 結果を DB に保存する永続化サービスを渡す。 */
    getSessionPersistenceService: () => persistence,
    /** 作成処理が本物の GUI 用 runtime を要求したら失敗させる。 */
    getSessionRuntimeService: () => {
      throw new Error("Unexpected GUI runtime");
    },
    /** 利用枠を観測していない状態を返す。 */
    getProviderQuotaTelemetry: () => null,
    /** 未測定値を古い観測として扱わない。 */
    isProviderQuotaTelemetryStale: () => false,
    /** 外部への問い合わせなしで利用枠の更新を終える。 */
    refreshProviderQuotaTelemetry: async () => null,
    /** 作成済み Main 用の補助 Session を、親の世代とともに保存する。 */
    initializeCreatedSession: async (session) => {
      await bundle.stores.auxiliary.upsertAuxiliarySession({
        ...session,
        id: `${session.id}-aux`,
        parentSessionId: session.id,
        title: "Aux",
        runState: "idle",
        createdAt: session.updatedAt,
        composerDraft: "",
        displayAfterMessageIndex: null,
        creationContext: {
          generationId: "test",
          parentIncarnationId: getSessionIncarnationId(session),
        },
      });
    },
    /** 子を複数作成しても衝突しない連番 ID を割り当てる。 */
    createSessionId: () => `created-${++childSequence}`,
    /** 作成した子の SessionFiles ディレクトリを分離する。 */
    createSessionFilesDirectory: async (id) => {
      const folder = join(directory, `files-${id}`);
      await mkdir(folder);
      return folder;
    },
    /** SessionFiles のパスを Session ID から再計算する。 */
    resolveSessionFilesDirectory: (id) => join(directory, `files-${id}`),
    /** テストのワークスペースを SessionFiles と同一扱いしない。 */
    isSessionFilesWorkspace: () => false,
    /** 画面に通知を出していないため消去も省く。 */
    dismissSessionTurnNotification() {},
    /** 作成検証を実機固有のワークスペース条件から切り離す。 */
    validateWorkspaceDirectory: async () => ({ valid: true }),
    /** 子の選択に使える Character をストアから取得する。 */
    listActiveCharacters: () => bundle.stores.character.listCharacters(),
    /** 選択した Character の実行用スナップショットを作る。 */
    createCharacterRuntimeSnapshot: (id) =>
      bundle.stores.character.createRuntimeSnapshot(id),
  });
  let service: SessionTurnQueueService;
  let facade: MainSessionTurnQueueFacade;
  /** 現在の Worker にキューをつなぎ、受付後の claim をテスト側で行えるようにする。 */
  const startQueue = () => {
    service = new SessionTurnQueueService({
      store: bundle.stores.queue,
      /** 実行中扱いに固定し、受付直後の自動 dispatch を止める。 */
      isRunInFlight: () => true,
      dispatch: unused,
    });
    facade = new MainSessionTurnQueueFacade({
      /** キュー受付の稼働確認を通す。 */
      assertActive() {},
      /** フィクスチャ内でメッセージ受付を停止しない。 */
      assertAccepting() {},
      /** 受付に使う宛先設定を DB の現在値から読み直す。 */
      getSession: (id) => bundle.stores.session.getSession(id),
      /** 受付時に共通設定の現在値を供給する。 */
      getAppSettings: async () => settings,
      /** 受付検証から実ファイルシステム条件を切り離す。 */
      validateWorkspace: async () => {},
      /** 宛先プロバイダーのモデルカタログを返す。 */
      validateProvider: async (session) => ({
        provider: catalogFor(session.provider),
      }),
      /** 添付も入力エラーもない送信プレビューを返す。 */
      preview: async () => ({ errors: [], attachments: [] }),
      store: bundle.stores.queue,
      service,
    });
  };
  startQueue();
  const operatingPolicy = new SessionOperatingPolicyService({
    /** 選択方針に実際の設定ストアを使う。 */
    getStore: () => bundle.stores.settings,
    /** 外部の利用枠測定に依存せず選択方針を検証する。 */
    getQuota: () => null,
  });
  const application = new SessionManagementApplication({
    /** 呼出元のワークスペースを基準に選択方針の読み書きを実行する。 */
    operatingPolicy: (actor, operation, request, current) =>
      operatingPolicy.execute(operation, request, actor.workspacePath, current),
    getInstructions: unused,
    setInstructions: unused,
    /** 操作した Session と対象選択を実際の可視範囲の読取へ渡す。 */
    readSessionScope: (actor, selection) =>
      bundle.stores.session.readSessionManagementScope(actor, selection),
    /** 各 Session に作成済みの送信元 Turn を割り当てる。 */
    currentTurn: async (actor) => ({
      turnId: sourceTurns.get(actor.id)!,
      receipt: null,
      origin: null,
    }),
    /** 隔離したディレクトリを親の Crew Folder として公開する。 */
    crewFolder: async () => ({ rootSessionId: parent.id, path: directory }),
    /** プロバイダーとワークスペースの指定がなければ、全候補と呼出元のパスを返す。 */
    catalog: async (actor, input) => ({
      workspacePath: input.workspacePath ?? actor.workspacePath,
      providers: input.provider ? [catalogFor(input.provider)] : catalogs,
    }),
    /** 送信者・Turn・宛先の世代を受付へ渡し、事前拒否を公開エラーに変換する。 */
    enqueue: async (recipient, input, actor, turnId, assertCurrent) => {
      try {
        return await facade.enqueueSessionMessage(
          input,
          {
            kind: "session",
            actorKind: actor.kind,
            actorSessionId: actor.id,
            actorIncarnationId: actor.incarnationId,
            actorTurnId: turnId,
            operation: "send",
            targetSessionId: recipient.id,
            targetIncarnationId: recipient.incarnationId,
          },
          assertCurrent,
        );
      } catch (error) {
        if (error instanceof SessionTurnQueuePreflightRejectedError)
          throw new SessionManagementError("SESSION_REJECTED", error.message);
        throw error;
      }
    },
    /** 宛先の世代を固定して既存の受付を読む。 */
    getReceipt: (recipient, id) =>
      facade.getSessionTurnQueueReceipt(
        recipient.id,
        id,
        recipient.incarnationId,
      ),
    /** 呼出元 Turn の検証と実行設定を子作成へ渡し、業務上の拒否を公開エラーに変換する。 */
    createChild: async (actor, input, assertCurrent, actorExecution) => {
      try {
        return await commands.createChildSession(
          actor,
          input,
          assertCurrent,
          actorExecution,
        );
      } catch (error) {
        if (error instanceof ChildSessionCreationRejectedError)
          throw new SessionManagementError("SESSION_REJECTED", error.message);
        throw error;
      }
    },
    directories: unused,
    updateMetadata: unused,
    cancelReceipt: unused,
    stopTurn: unused,
    steer: unused,
    readExecution: unused,
    coordinate: unused,
  });
  const runtime = new SessionManagementRuntimeService({
    application,
    bindingRegistry: bindings,
    providerAgentRuntimeTurns: turns,
  });
  /** 外部 HTTP を介さず binding と Turn capability 付きで実 runtime にルーティングする。 */
  const runtimeCall: typeof callAgentRuntime = async (
    _connection,
    operation,
    bound,
  ) => {
    const response = await runtime.route({
      ...operation,
      transport: "mcp",
      bindingReference: bound.bindingReference,
      turnCapability: bound.turnCapability,
    });
    assert.ok(response);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      value: response.value,
    };
  };
  const cleanups: (() => Promise<void>)[] = [];
  /** Session にバインドされた実行中 Turn を用意し、同じ権限で CLI と MCP を呼び出せるようにする。 */
  async function endpoint(
    session: Session,
    executionOptions: SessionExecutionOptions | null = captureSessionExecutionOptions(
      session,
    ),
  ) {
    const binding = bindings.issueOrReuse({
      actorSessionId: session.id,
      providerId: provider,
      authoritySnapshot: { sessionIdentity: target(session) },
      operationGrants: getSessionAgentRuntimeOperations(),
    });
    const turn = turns.begin({
      actorSessionId: session.id,
      providerId: provider,
      executionOptions: executionOptions ?? undefined,
    });
    const env = {
      WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: binding.bindingReference,
      WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: turn.capability,
    };
    const server = createWithMateSessionMcpServer({
      env,
      connection,
      runtimeCall,
    });
    const client = new Client({ name: "enqueue-settings", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    cleanups.push(async () => {
      await client.close();
      await server.close();
      turns.end(turn);
    });
    /** 両入口から返る構造化結果を同じ形で比較できるようにする。 */
    const call = async (
      transport: "cli" | "mcp",
      operation: string,
      body: Record<string, unknown>,
    ) => {
      if (transport === "mcp") {
        const result = await client.callTool({
          name: `session.${operation}`,
          arguments: body,
        });
        return (result.structuredContent ?? result) as Record<string, unknown>;
      }
      let output = "";
      await runWithMateSessionCli(
        [operation.replaceAll("_", "-"), "--json", JSON.stringify(body)],
        {
          env,
          connection,
          runtimeCall,
          stdout: {
            /** CLI の標準出力を連結して JSON として読めるようにする。 */
            write: (text) => {
              output += String(text);
              return true;
            },
          },
          stderr: {
            /** CLI のエラー出力をテストプロセスへ流さない。 */
            write: () => true,
          },
        },
      );
      return JSON.parse(output) as Record<string, unknown>;
    };
    return Object.assign(call, {
      /** SDK 接続は残し、操作元の Turn だけを失効させる。 */
      endTurn: () => turns.end(turn),
    });
  }
  return {
    parent,
    child,
    sourceTurns,
    models,
    settings,
    endpoint,
    /** 再接続後の操作には最新の Worker を参照させる。 */
    get bundle() {
      return bundle;
    },
    /** 再起動後の受付口をテストへ渡す。 */
    get facade() {
      return facade;
    },
    /** 受付を実 Session runtime に渡し、完了状態と adapter が受け取った入力を返す。 */
    async dispatchNext(session: Session) {
      const receipt = await bundle.stores.queue.claimNext(target(session));
      assert.ok(receipt);
      const executed: {
        provider: string | null | undefined;
        input: RunSessionTurnInput;
      }[] = [];
      const runtime = new SessionRuntimeService({
        /** dispatch 時点の Session を SQLite から読み直す。 */
        getSession: (id) => bundle.stores.session.getSession(id),
        persistRunningTurnStart:
          persistence.persistRunningTurnStart.bind(persistence),
        persistQueuedTurnStart:
          persistence.persistQueuedTurnStart.bind(persistence),
        /** 受付済み Turn に添付の参照が紛れ込んでいないことを確認する。 */
        assertCapturedComposerAttachmentsAvailable: async (
          _session,
          attachments,
        ) => {
          assert.deepEqual(attachments, []);
        },
        appendRunningInput: persistence.appendRunningInput.bind(persistence),
        appendTerminalSession:
          persistence.appendTerminalSession.bind(persistence),
        checkpointRuntimeMetadata:
          persistence.checkpointRuntimeMetadata.bind(persistence),
        resolveComposerPreview: unused,
        /** dispatch 時に参照する共通設定の現在値を返す。 */
        getAppSettings: () => settings,
        /** 指定があれば該当プロバイダーを、なければ宛先 Session のカタログを選ぶ。 */
        resolveProviderCatalog: (providerId) => ({
          snapshot: { providers: catalogs },
          provider: catalogFor(providerId ?? session.provider),
        }),
        /** 外部通信なしで dispatch 入力を観測できる adapter を提供する。 */
        getProviderCodingAdapter: (providerId) => ({
          composePrompt: composeProviderPrompt,
          /** fixture adapter はプロバイダーの利用枠を報告しない。 */
          getProviderQuotaTelemetry: async () => null,
          /** 実プロバイダーの個別スレッドを無効化しない。 */
          invalidateSessionThread: async () => {},
          /** 実プロバイダーの全スレッドを無効化しない。 */
          invalidateAllSessionThreads: async () => {},
          /** adapter に届いた入力を記録し、実プロバイダーを呼ばずに正常結果を返す。 */
          runSessionTurn: async (input) => {
            executed.push({ provider: providerId, input });
            return {
              assistantText: "done",
              threadId: "fixture-thread",
              usage: null,
            };
          },
        }),
        /** dispatch が始めた Turn を実際の DB に記録する。 */
        createSessionTurn: (input) =>
          bundle.stores.turn.createSessionTurn(input),
        /** 進行に伴う Turn の状態を DB へ反映する。 */
        updateSessionTurn: (id, input) =>
          bundle.stores.turn.updateSessionTurn(id, input),
        /** 画面向けの実行状態は記録しない。 */
        setLiveSessionRun() {},
        /** 画面に紐づく進行中の実行はないことを示す。 */
        getLiveSessionRun: () => null,
        /** 承認要求が発生した場合に権限を与えない。 */
        waitForApprovalDecision: () => "deny",
        /** 追加入力を求められてもユーザー応答を待たない。 */
        waitForElicitationResponse: () => ({ action: "cancel" }),
        /** 計測していない利用枠を記録しない。 */
        setProviderQuotaTelemetry() {},
        /** 画面向けのコンテキスト利用状況を記録しない。 */
        setSessionContextTelemetry() {},
        /** 実スレッドの無効化を行わない。 */
        invalidateProviderSessionThread() {},
        /** dispatch 後に外部の計測処理を予約しない。 */
        scheduleProviderQuotaTelemetryRefresh() {},
        /** 画面向けの実行通知を送らない。 */
        broadcastLiveSessionRun() {},
        /** 終了時に画面の承認ダイアログを解決する必要はない。 */
        resolvePendingApprovalRequest() {},
        /** 終了時に画面の追加入力を解決する必要はない。 */
        resolvePendingElicitationRequest() {},
      });
      const result = await runtime.runQueuedSessionTurn(
        receipt,
        async (started) => {
          await bundle.stores.queue.markStarted(
            target(session),
            receipt.id,
            started,
          );
        },
      );
      return { result, executed };
    },
    /** DB を保持したまま Worker とキューを立ち上げ直し、受付の復元を検証可能にする。 */
    async reopen() {
      await service.close();
      await bundle.client.close();
      bundle = createV6StorageWorkerBundle(options);
      await bundle.initialize();
      startQueue();
    },
    /** 登録した SDK 接続、キュー、Worker を閉じてから隔離ディレクトリを片付ける。 */
    async close() {
      for (const cleanup of cleanups) await cleanup();
      await service.close();
      await bundle.client.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "通常子作成は実行中の親権限と明示Reviewerを継承し、異種で制限を再現できなければ作成しない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md: Bound Session API; docs/design/provider-adapter.md#approval-modes" }
// fault = "親の保存設定を実行中設定と誤認する、実行中の権限が取れないのに作成する、異種で制限を失う、再試行で作成済み条件を再解決する"
// observable = "両入口の作成結果、拒否理由と保存子・lifecycle不存在、再試行、adapter境界に渡る初回受付設定"
// observation_boundary = "public-boundary"
// scope = "SDK MCP/bound CLI→admitted Turn→作成・queue・runtime→実Storage Workerとadapter境界。catalog/Workspace検証/HTTP/Provider実行はfixture"
// lifecycle = "permanent"
// impact = "権限を広げた新規子の作成、または依頼時に継承した権限を失う"
// distinction = "設定候補やmapper単体では実行中と保存値の区別、永続化および初回通常依頼への伝達を検証できない"
// @end-test-value
/** 子の権限は親の保存値ではなく実行中 Turn から継承し、再送や初回 dispatch でも変わらない。継承できない場合は子も途中の作成記録も残さない。 */
test("child creation uses the active parent permissions through retry and first dispatch", async () => {
  const f = await fixture();
  try {
    await f.bundle.stores.character.createCharacter({ name: "Child fixture" });
    const active = {
      ...captureSessionExecutionOptions(f.parent),
      codexSandboxMode: "danger-full-access" as const,
      codexReviewer: "auto-review" as const,
      codexSpeed: "fast" as const,
    };
    await f.bundle.stores.session.updateSession({
      ...f.parent,
      approvalMode: "never",
      codexSandboxMode: "read-only",
      codexReviewer: "user",
    });
    const parent = await f.endpoint(f.parent, active);
    const base = {
      role: "executor",
      provider: "codex",
      model: "fast",
      reasoningEffort: "low",
      workspacePath: join(f.parent.workspacePath, ".."),
    };
    const created: {
      session: Session;
      request: typeof base & { requestId: string };
      requestId: string;
      reviewer: string;
      explicit: true | undefined;
      sandbox: string;
      response: Record<string, unknown>;
    }[] = [];
    for (const transport of ["mcp", "cli"] as const) {
      for (const [provider, reviewer, sandbox, explicit] of [
        ["codex", "auto-review", "danger-full-access", undefined],
        ["claude", "auto-review", "workspace-write", undefined],
        ["copilot", "auto-review", "workspace-write", true],
        ["opencode", "auto-review", "workspace-write", true],
      ] as const) {
        const request = { ...base, provider, requestId: randomUUID() };
        const response = await parent(transport, "create_child", request);
        assert.equal(response.ok, true, JSON.stringify(response));
        const options = response.executionOptions as SessionExecutionOptions;
        assert.equal(options.approvalMode, "on-request");
        assert.equal(options.codexReviewer, reviewer);
        assert.equal(options.withMateReviewerExplicit, explicit);
        assert.equal(options.codexSandboxMode, sandbox);
        assert.equal(options.model, "fast");
        assert.equal(options.reasoningEffort, "low");
        assert.equal(options.codexSpeed, "standard");
        const session = (await f.bundle.stores.session.getSession(
          (response.session as { id: string }).id,
        ))!;
        assert.equal(session.provider, provider);
        assert.deepEqual(captureSessionExecutionOptions(session), options);
        const requestId = randomUUID();
        const sent = await parent(transport, "enqueue", {
          target: target(session),
          requestId,
          message: "first assigned task",
          model: "fast",
          reasoningEffort: "low",
        });
        assert.equal(sent.ok, true, JSON.stringify(sent));
        assert.deepEqual(
          (sent.receipt as SessionTurnQueueReceipt).accepted!.request
            .executionOptions,
          options,
        );
        created.push({
          session,
          request,
          requestId,
          reviewer,
          sandbox,
          explicit,
          response,
        });
      }
    }

    parent.endTurn();
    const restricted = await f.endpoint(f.parent, {
      ...active,
      codexSandboxMode: "workspace-write-network",
    });
    await f.reopen();
    for (const {
      session,
      request,
      requestId,
      reviewer,
      sandbox,
      explicit,
      response,
    } of created) {
      assert.deepEqual(
        await restricted("cli", "create_child", request),
        response,
      );
      assertRejected(
        await restricted("cli", "create_child", {
          ...request,
          title: "different request",
        }),
      );
      const dispatched = await f.dispatchNext(session);
      assert.deepEqual(dispatched.result, { state: "completed" });
      assert.equal(dispatched.executed.length, 1);
      assert.equal(dispatched.executed[0].provider, session.provider);
      assert.equal(
        dispatched.executed[0].input.executionOptions.approvalMode,
        "on-request",
      );
      assert.equal(
        dispatched.executed[0].input.executionOptions.codexReviewer,
        reviewer,
      );
      assert.equal(
        dispatched.executed[0].input.executionOptions.withMateReviewerExplicit,
        explicit,
      );
      assert.equal(
        dispatched.executed[0].input.executionOptions.codexSandboxMode,
        sandbox,
      );
      assert.equal(
        (await f.bundle.stores.queue.getReceipt(target(session), requestId))!
          .state,
        "completed",
      );
    }
    const sameProvider = await restricted("mcp", "create_child", {
      ...base,
      requestId: randomUUID(),
    });
    assert.equal(sameProvider.ok, true, JSON.stringify(sameProvider));
    assert.equal(
      (sameProvider.executionOptions as SessionExecutionOptions)
        .codexSandboxMode,
      "workspace-write-network",
    );
    const before = (await f.bundle.stores.session.listSessionSummaries())
      .length;
    for (const transport of ["mcp", "cli"] as const) {
      const rejected = await restricted(transport, "create_child", {
        ...base,
        provider: "claude",
        requestId: randomUUID(),
      });
      assertRejected(rejected);
      assert.match(
        String(rejected.message),
        /sandbox mode "workspace-write-network" in claude/,
      );
    }
    assert.equal(
      (await f.bundle.stores.session.listSessionSummaries()).length,
      before,
    );
    assert.equal(
      (await f.bundle.stores.session.listPendingSessionLifecycleOperations())
        .length,
      0,
    );
    restricted.endTurn();
    const unavailable = await f.endpoint(f.parent, null);
    for (const transport of ["mcp", "cli"] as const) {
      const rejected = await unavailable(transport, "create_child", {
        ...base,
        requestId: randomUUID(),
      });
      assertRejected(rejected);
      assert.match(
        String(rejected.message),
        /effective permissions are unavailable/,
      );
    }
    assert.equal(
      (await f.bundle.stores.session.listSessionSummaries()).length,
      before,
    );
  } finally {
    await f.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "通常子の明示4方針が全12方向で保存・初回実行され、制限付きCodex Sandboxや選択済みCopilot Agentでは新規異種作成しない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#子sessionへの承認設定の継承; docs/design/session-run-lifecycle.md#bound-session-api" }
// fault = "公開モードを拒否する、手動を仲介に置換する、初回Turnで既定に戻す、または制限付きSandbox・選択済みCopilot Agentを捨てて異種の子を作る"
// observable = "両入口の子・受付・初回adapter入力にあるApprovalとReviewer・Sandbox、拒否時のeffectとlifecycle不在"
// observation_boundary = "public-boundary"
// scope = "MCP SDK・bound CLIからTurn binding・実SQLite・queue dispatch・宛先adapter境界まで。native実行・catalog・HTTP交換はfixture"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// distinction = "共通変換関数のtest単体では公開入口での親Turn設定の使用と、拒否時に登録や作成が残らないことを検証できない"
// @end-test-value
/** 四つの承認方針を両公開入口で子の保存から初回実行まで照合し、移せない Sandbox や選択 Agent の制限があるときは新規作成しない。 */
test("child creation distinguishes per-Provider approval choices from cross-Provider inheritance", async () => {
  const providers = ["codex", "claude", "copilot", "opencode"] as const;
  for (const source of providers) {
    const f = await fixture(source);
    try {
      await f.bundle.stores.character.createCharacter({
        name: "Child fixture",
      });
      for (const [approvalMode, reviewer] of [
        ["never", "user"],
        ["on-request", "auto-review"],
        ["on-request", "user"],
        ["safety-focused", "user"],
      ] as const) {
        const scenarios = [
          {
            codexSandboxMode: "danger-full-access",
            customAgentName: source === "copilot" ? " " : "unused-agent",
          },
          ...(source === "codex"
            ? [{ codexSandboxMode: "read-only", customAgentName: "" } as const]
            : []),
          ...(source === "copilot"
            ? [
                {
                  codexSandboxMode: "danger-full-access",
                  customAgentName: " selected-agent ",
                } as const,
              ]
            : []),
        ] as const;
        let retry:
          | {
              request: Record<string, unknown>;
              result: Record<string, unknown>;
            }
          | undefined;
        for (const { codexSandboxMode, customAgentName } of scenarios) {
          const origin = await f.endpoint(f.parent, {
            ...captureSessionExecutionOptions(f.parent),
            approvalMode,
            codexSandboxMode,
            customAgentName,
            codexReviewer: reviewer,
            ...(source === "copilot" || source === "opencode"
              ? { withMateReviewerExplicit: true }
              : {}),
          });
          try {
            const initialCount = (
              await f.bundle.stores.session.listSessionSummaries()
            ).length;
            let created = 0;
            for (const provider of providers) {
              const sandboxBlocked =
                source === "codex" &&
                provider !== source &&
                codexSandboxMode === "read-only";
              const agentBlocked =
                source === "copilot" &&
                provider !== source &&
                customAgentName.trim() !== "";
              for (const transport of ["mcp", "cli"] as const) {
                const requestId = randomUUID();
                const context = `${transport} ${source} → ${provider}: ${approvalMode}, ${reviewer}, ${codexSandboxMode}`;
                const request = {
                  role: "executor",
                  provider,
                  model: "fast",
                  reasoningEffort: "low",
                  workspacePath: f.parent.workspacePath,
                  requestId,
                };
                const result = await origin(transport, "create_child", request);
                if (sandboxBlocked || agentBlocked) {
                  assert.equal(result.ok, false, context);
                  assert.equal(result.effect, "none", context);
                  assert.match(
                    String(result.message),
                    sandboxBlocked
                      ? /Cannot inherit the Codex sandbox mode/
                      : /selected Copilot agent's tool restrictions/,
                    context,
                  );
                  const lifecycleId = JSON.stringify([
                    "create",
                    "agent",
                    f.parent.id,
                    getSessionIncarnationId(f.parent),
                    requestId,
                  ]);
                  assert.equal(
                    await f.bundle.stores.session.getSessionLifecycleOperation(
                      lifecycleId,
                    ),
                    null,
                    context,
                  );
                  continue;
                }
                assert.equal(
                  result.ok,
                  true,
                  `${context}: ${JSON.stringify(result)}`,
                );
                if (source === "copilot" && provider === "claude" && !retry)
                  retry = { request, result };
                const child = await f.bundle.stores.session.getSession(
                  (result.session as { id: string }).id,
                );
                assert.ok(child, context);
                assert.equal(child.provider, provider, context);
                /** 子の保存値・初回受付・adapter 入力の承認と審査設定を揃え、Codex の Sandbox が継承元に応じて選ばれることを照合する。 */
                const assertInherited = (options: SessionExecutionOptions) => {
                  assert.equal(options.approvalMode, approvalMode, context);
                  assert.equal(options.codexReviewer, reviewer, context);
                  assert.equal(
                    options.withMateReviewerExplicit,
                    provider === "copilot" || provider === "opencode"
                      ? true
                      : undefined,
                    context,
                  );
                  if (provider === "codex")
                    assert.equal(
                      options.codexSandboxMode,
                      source === provider ? codexSandboxMode : "read-only",
                      context,
                    );
                };
                assertInherited(child);
                const sent = await origin(transport, "enqueue", {
                  target: target(child),
                  requestId: randomUUID(),
                  message: "first task",
                  model: "fast",
                  reasoningEffort: "low",
                });
                assert.equal(
                  sent.ok,
                  true,
                  `${context}: ${JSON.stringify(sent)}`,
                );
                assertInherited(
                  (sent.receipt as SessionTurnQueueReceipt).accepted!.request
                    .executionOptions,
                );
                const first = await f.dispatchNext(child);
                assert.deepEqual(first.result, { state: "completed" }, context);
                assert.deepEqual(
                  first.executed.map((run) => run.provider),
                  [provider],
                  context,
                );
                assertInherited(first.executed[0].input.executionOptions);
                created++;
              }
            }
            assert.equal(
              (await f.bundle.stores.session.listSessionSummaries()).length,
              initialCount + created,
            );
            if (retry && source === "copilot" && customAgentName.trim()) {
              assert.deepEqual(
                await origin("mcp", "create_child", retry.request),
                retry.result,
              );
            }
          } finally {
            origin.endTurn();
          }
        }
      }
    } finally {
      await f.close();
    }
  }
});

// @test-value v2
// kind = "compatibility"
// claim = "旧未指定の仲介親からは共通Settings On/Offともにnative子が手動、仲介子は未指定のまま作成される"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#子sessionへの承認設定の継承" }
// fault = "親の共通Onをnative Auto Reviewや明示Userに変換して保存する、または旧未指定のために作成を拒否する"
// observable = "公開作成後に再読込した子と親の承認方針・審査先・明示marker、native子の初回実行設定"
// observation_boundary = "public-boundary"
// scope = "Copilot/OpenCodeの旧保存値、共通Settings On/Off、bound MCP・CLI→隔離SQLiteと初回adapter入力"
// lifecycle = "permanent"
// distinction = "明示4択の継承試験は選択前の旧値と当時の共通設定を区別できない"
// @end-test-value
/** 旧データの審査先未指定は共通 Auto Review 設定に連動せず、native の子の初回実行は User、仲介型の子には明示マーカーを付けない。 */
test("legacy unset reviewers use native User or remain unset on mediated children", async () => {
  for (const source of ["copilot", "opencode"]) {
    const f = await fixture(source);
    try {
      await f.bundle.stores.character.createCharacter({
        name: "Child fixture",
      });
      const origin = await f.endpoint(f.parent);
      for (const configured of [false, true]) {
        f.settings.withMateAutoReview = configured
          ? { providerId: "codex", model: "review", reasoningEffort: "" }
          : null;
        for (const provider of [
          "codex",
          "claude",
          source === "copilot" ? "opencode" : "copilot",
        ]) {
          for (const transport of ["mcp", "cli"] as const) {
            const response = await origin(transport, "create_child", {
              requestId: randomUUID(),
              provider,
              model: "fast",
              role: "executor",
              reasoningEffort: "low",
              workspacePath: f.parent.workspacePath,
            });
            assert.equal(response.ok, true, JSON.stringify(response));
            const child = await f.bundle.stores.session.getSession(
              (response.session as { id: string }).id,
            );
            assert.ok(child);
            assert.deepEqual(
              [
                child.provider,
                child.approvalMode,
                child.codexReviewer,
                child.withMateReviewerExplicit,
              ],
              [provider, "on-request", "user", undefined],
            );
            if (provider === "codex" || provider === "claude") {
              const sent = await origin(transport, "enqueue", {
                target: target(child),
                requestId: randomUUID(),
                message: "first task",
                model: "fast",
                reasoningEffort: "low",
              });
              assert.equal(sent.ok, true, JSON.stringify(sent));
              const first = await f.dispatchNext(child);
              assert.deepEqual(
                first.executed.map(({ provider, input }) => [
                  provider,
                  input.executionOptions.approvalMode,
                  input.executionOptions.codexReviewer,
                ]),
                [[provider, "on-request", "user"]],
              );
            }
          }
        }
        const parent = await f.bundle.stores.session.getSession(f.parent.id);
        assert.deepEqual(
          captureSessionExecutionOptions(parent!),
          captureSessionExecutionOptions(f.parent),
        );
      }
    } finally {
      await f.close();
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "親が方針と宛先catalogを読んで選ぶ単発Depthは通常Turn受付だけへ反映され、共有方針は保存時のまま残る"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/926" }
// fault = "一度のenqueueで恒久方針が学習更新される、方針読取がcatalogを置き換える、単発指定が受付へ届かない"
// observable = "公開方針read、宛先catalog、receipt実効設定、送信後の同じ方針本文"
// observation_boundary = "public-boundary"
// scope = "両入口→runtime→policy service/queue facade→実Storage Worker。catalogとHTTP交換はfixture"
// lifecycle = "permanent"
// distinction = "方針CRUD単体では通常送信の単発指定と恒久方針が分離されていることを検出できない"
// @end-test-value
/** 親が方針と宛先カタログを読み分け、一回限りの Model・Depth 指定を受付に反映しても、共有方針は保存時のままとする。 */
test("parent reads policy and recipient catalog without persisting one-off enqueue choices", async () => {
  const f = await fixture();
  try {
    const parent = await f.endpoint(f.parent);
    const policy = {
      selectionCriteria:
        "Judgment-heavy tasks use deep; routine work uses fast.",
      executionGuidelines: "Select Depth per task.",
      contractRoutes: [
        {
          name: "subscription",
          provider: "codex",
          conditions: "Use observed contract quota.",
        },
      ],
    };
    await parent("cli", "set_selection_policy", { policy });
    for (const transport of ["mcp", "cli"] as const) {
      assert.deepEqual(
        (await parent(transport, "get_selection_policy", {})).policy,
        policy,
      );
      const choices = await parent(transport, "get_catalog", {
        provider: f.child.provider,
        workspacePath: f.child.workspacePath,
      });
      const catalog = choices.catalog as {
        workspacePath: string;
        providers: { models: { id: string; reasoningEfforts: string[] }[] }[];
      };
      assert.equal(catalog.workspacePath, f.child.workspacePath);
      assert.ok(
        catalog.providers[0].models.some(
          (model) =>
            model.id === "fast" && model.reasoningEfforts.includes("low"),
        ),
      );
      const sent = await parent(transport, "enqueue", {
        target: target(f.child),
        requestId: randomUUID(),
        message: "routine task with one-off low Depth",
        model: "fast",
        reasoningEffort: "low",
      });
      assert.equal(sent.ok, true);
      const effective = (sent.receipt as SessionTurnQueueReceipt).accepted!
        .request.executionOptions;
      assert.equal(effective.model, "fast");
      assert.equal(effective.reasoningEffort, "low");
      assert.deepEqual(
        (await parent(transport, "get_selection_policy", {})).policy,
        policy,
      );
    }
  } finally {
    await f.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "MCPとCLIの親子送信は宛先の保存権限を使い、送信方向に応じたModel/DepthとReviewer整合を検証して不正受付を作らない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md: Bound Session API" }
// fault = "宛先の保存権限を使わない、親送信のModel/Depth省略や無効組合せを受け付ける、子報告の省略を拒否する、保存Reviewerを自動降格する"
// observable = "両公開入口の成功receiptと実効設定、理由付きeffect noneと保存receipt不存在、宛先Provider/Workspaceとcatalog options"
// observation_boundary = "public-boundary"
// scope = "SDK MCP/bound CLI→runtime binding→application→queue facade→実Storage Worker、Provider catalogとHTTP交換はfixture"
// lifecycle = "permanent"
// impact = "親子依頼が誤ったモデルや権限で実行される"
// distinction = "schema/typecheckでは実送信方向や省略解決後の整合と両入口の保存まで確認できない"
// @end-test-value
/** 両方向の送信で宛先の保存権限を保ち、必要な Model・Depth の組や審査先の妥当性を検証し、拒否した場合は受付を作らない。 */
test("enqueue settings validate both directions and all Provider options through MCP and CLI", async () => {
  for (const provider of ["codex", "copilot", "claude", "opencode"]) {
    const f = await fixture(provider);
    try {
      const parent = await f.endpoint(f.parent),
        child = await f.endpoint(f.child);
      const savedChild = {
        ...f.child,
        approvalMode: "never" as const,
        codexSandboxMode: "read-only" as const,
      };
      await f.bundle.stores.session.updateSession(savedChild);
      for (const transport of ["cli", "mcp"] as const) {
        const read = await parent(transport, "get", {
          target: target(f.child),
        });
        const recipient = read.session as {
          provider: string;
          workspacePath: string;
        };
        assert.equal(recipient.provider, provider);
        assert.equal(recipient.workspacePath, f.child.workspacePath);
        const choices = await parent(transport, "get_catalog", {
          provider: recipient.provider,
          workspacePath: recipient.workspacePath,
        });
        assert.equal(choices.ok, true);
        assert.equal(
          (choices.catalog as { workspacePath: string }).workspacePath,
          f.child.workspacePath,
        );
        const native = (
          choices.options as {
            provider: string;
            approvalModes: { value: string }[];
            sandboxModes: { value: string }[];
            reviewers: { value: string }[];
          }[]
        )[0];
        assert.equal(native.provider, provider);
        assert.deepEqual(native.approvalModes, [
          { value: "auto-run", label: "Auto Run" },
          { value: "auto-review", label: "Auto Review" },
          { value: "user", label: "User" },
          { value: "safety-focused", label: "Safety Focused" },
        ]);
        assert.equal(
          native.sandboxModes.some((option) => option.value === "read-only"),
          provider === "codex",
        );
        if (provider !== "codex") assert.deepEqual(native.sandboxModes, []);
        assert.deepEqual(native.reviewers, []);
        const request = {
          target: target(f.child),
          requestId: randomUUID(),
          message: "do work",
          model: "plain",
          reasoningEffort: "",
        };
        const sent = await parent(transport, "enqueue", request);
        assert.equal(sent.ok, true);
        const options = (sent.receipt as SessionTurnQueueReceipt).accepted!
          .request.executionOptions;
        assert.deepEqual(options, {
          ...captureSessionExecutionOptions(savedChild),
          model: "plain",
          reasoningEffort: "",
        });
        assert.equal(options.approvalMode, "never");
        assert.equal(options.codexSandboxMode, "read-only");
        assert.deepEqual(
          captureSessionExecutionOptions(
            (await f.bundle.stores.session.getSession(f.child.id))!,
          ),
          captureSessionExecutionOptions(savedChild),
        );
        const report = await child(transport, "enqueue", {
          target: target(f.parent),
          requestId: randomUUID(),
          message: "report",
        });
        assert.equal(report.ok, true);
        assert.equal(
          (report.receipt as SessionTurnQueueReceipt).accepted!.request
            .executionOptions.model,
          "deep",
        );
        const selected = await child(transport, "enqueue", {
          target: target(f.parent),
          requestId: randomUUID(),
          message: "report requiring another model",
          model: "fast",
          reasoningEffort: "low",
        });
        assert.equal(selected.ok, true);
        assert.deepEqual(
          (selected.receipt as SessionTurnQueueReceipt).accepted!.request
            .executionOptions,
          {
            ...captureSessionExecutionOptions(f.parent),
            model: "fast",
            reasoningEffort: "low",
          },
        );
        assert.equal(
          (selected.receipt as SessionTurnQueueReceipt).accepted!.request
            .executionOptions.approvalMode,
          "on-request",
        );
        const invalid = [
          { model: undefined },
          { reasoningEffort: undefined },
          { model: "missing" },
          { reasoningEffort: "high" },
        ];
        for (const patch of invalid) {
          const body = JSON.parse(
            JSON.stringify({ ...request, requestId: randomUUID(), ...patch }),
          );
          const rejected = await parent(transport, "enqueue", body);
          assertRejected(rejected);
          assert.equal(
            await f.bundle.stores.queue.getReceipt(
              target(f.child),
              body.requestId,
            ),
            null,
          );
        }
        for (const patch of [{ model: "fast" }, { reasoningEffort: "low" }]) {
          const body = {
            target: target(f.parent),
            requestId: randomUUID(),
            message: "report",
            ...patch,
          };
          const rejected = await child(transport, "enqueue", body);
          assertRejected(rejected);
          assert.equal(
            await f.bundle.stores.queue.getReceipt(
              target(f.parent),
              body.requestId,
            ),
            null,
          );
        }
      }
      if (provider === "claude") {
        await f.bundle.stores.session.updateSession({
          ...savedChild,
          approvalMode: "accept-edits",
          codexReviewer: "auto-review",
        });
        for (const transport of ["cli", "mcp"] as const) {
          const id = randomUUID();
          const rejected = await parent(transport, "enqueue", {
            target: target(f.child),
            requestId: id,
            message: "work",
            model: "deep",
            reasoningEffort: "high",
          });
          assert.equal(rejected.effect, "none");
          assert.match(String(rejected.message), /reviewer/);
          assert.equal(
            await f.bundle.stores.queue.getReceipt(target(f.child), id),
            null,
          );
        }
        assert.equal(
          (await f.bundle.stores.session.getSession(f.child.id))!.codexReviewer,
          "auto-review",
        );
      }
    } finally {
      await f.close();
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "即時・遅延の受付設定は再起動・保存設定変更後も固定され、同UUID再送は元受付を返し明示設定変更を拒否する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md: Bound Session API; https://github.com/natumekazuki/WithMate/issues/936" }
// fault = "再送やdispatchで省略値を再解決する、明示/省略の変更を許可する、遅延保存で設定を失う、過去受付を読めなくする"
// observable = "両入口のreceipt ID・accepted設定、再起動後claimの設定、競合effect none、保存Session設定、旧権限指定の有無それぞれの既存受付read/claim"
// observation_boundary = "public-boundary"
// scope = "SDK MCP/bound CLI→通常キュー受付lock→Storage Worker再起動→dispatch claim"
// lifecycle = "permanent"
// impact = "依頼の重複実行や待機中にModel・実行権限が変質する"
// distinction = "単純な入力validationやqueue storage単体は受付時省略解決と公開再試行を検証しない"
// @end-test-value
/** 即時・遅延の受付設定は保存変更と再起動後も固定し、同一再送と変更再送を区別する。旧形式の受付も読取・dispatch できる。 */
test("enqueue freezes per-Turn settings across retries, delayed dispatch and restart", async () => {
  const f = await fixture();
  try {
    const child = await f.endpoint(f.child),
      parent = await f.endpoint(f.parent);
    const accepted: {
      body: Record<string, unknown>;
      receipt: SessionTurnQueueReceipt;
    }[] = [];
    for (const deliveryTiming of ["immediate", "after_source_turn"]) {
      const body = {
        target: target(f.parent),
        requestId: randomUUID(),
        message: "report",
        deliveryTiming,
      };
      const replies = await Promise.all([
        child("cli", "enqueue", body),
        child("mcp", "enqueue", body),
      ]);
      assert.equal(replies[0].ok, true);
      assert.deepEqual(replies[0], replies[1]);
      accepted.push({
        body,
        receipt: replies[0].receipt as SessionTurnQueueReceipt,
      });
    }
    const saved = captureSessionExecutionOptions(f.parent);
    assert.deepEqual(
      captureSessionExecutionOptions(
        (await f.bundle.stores.session.getSession(f.parent.id))!,
      ),
      saved,
    );
    await f.bundle.stores.session.updateSession({
      ...f.parent,
      model: "fast",
      reasoningEffort: "low",
      approvalMode: "untrusted",
      codexSandboxMode: "danger-full-access",
    });
    await f.reopen();
    for (const { body, receipt } of accepted) {
      for (const transport of ["cli", "mcp"] as const) {
        const retry = await child(transport, "enqueue", body);
        assert.equal(retry.ok, true);
        assert.deepEqual(
          (retry.receipt as SessionTurnQueueReceipt).accepted,
          receipt.accepted,
        );
        const recovered = await child(transport, "get_receipt", {
          target: target(f.parent),
          requestId: body.requestId,
        });
        assert.equal(
          (recovered.receipt as SessionTurnQueueReceipt).id,
          receipt.id,
        );
        for (const patch of [
          { model: "deep" },
          { reasoningEffort: "high" },
          { deliveryTiming: deliveryTimingOther(String(body.deliveryTiming)) },
          { message: "different" },
        ]) {
          const rejected = await child(transport, "enqueue", {
            ...body,
            ...patch,
          });
          assert.equal(rejected.ok, false);
          assert.equal(rejected.effect, "none");
        }
      }
    }
    const rows = await f.bundle.stores.queue.listReceipts(target(f.parent));
    assert.equal(rows.receipts.length, 2);
    const immediate = await f.bundle.stores.queue.claimNext(target(f.parent));
    assert.equal(immediate!.id, accepted[0].receipt.id);
    await f.bundle.stores.queue.settle(
      target(f.parent),
      immediate!.id,
      "completed",
    );
    assert.equal(await f.bundle.stores.queue.claimNext(target(f.parent)), null);
    await f.bundle.stores.turn.updateSessionTurn(
      Number(f.sourceTurns.get(f.child.id)),
      {
        sessionId: f.child.id,
        phase: "completed",
        createdAt: new Date().toISOString(),
        provider: "codex",
        model: "deep",
        reasoningEffort: "high",
        approvalMode: "on-request",
        threadId: "",
        errorMessage: "",
      },
    );
    const delayed = await f.bundle.stores.queue.claimNext(target(f.parent));
    assert.equal(delayed!.id, accepted[1].receipt.id);
    for (const receipt of [immediate!, delayed!]) {
      assert.deepEqual(receipt.dispatched!.request.executionOptions, saved);
    }
    const changed = await f.bundle.stores.session.getSession(f.parent.id);
    assert.equal(changed!.model, "fast");
    assert.equal(changed!.approvalMode, "untrusted");
    assert.equal(changed!.codexSandboxMode, "danger-full-access");
    const next = await child("mcp", "enqueue", {
      target: target(f.parent),
      requestId: randomUUID(),
      message: "new report",
    });
    assert.equal(next.ok, true, JSON.stringify(next));
    assert.equal(
      (next.receipt as SessionTurnQueueReceipt).accepted!.request
        .executionOptions.approvalMode,
      "untrusted",
    );
    assert.equal(
      (next.receipt as SessionTurnQueueReceipt).accepted!.request
        .executionOptions.codexSandboxMode,
      "danger-full-access",
    );
    const legacyOptions = {
      ...saved,
      approvalMode: "never",
      codexSandboxMode: "read-only",
    } as const;
    const legacyExplicit = {
      model: legacyOptions.model,
      reasoningEffort: legacyOptions.reasoningEffort,
      approvalMode: legacyOptions.approvalMode,
      codexSandboxMode: legacyOptions.codexSandboxMode,
    };
    const legacyReceipts = [];
    for (const requestedExecutionOptions of [undefined, legacyExplicit]) {
      const legacyId = randomUUID();
      const receipt = await f.bundle.stores.queue.enqueue(target(f.child), {
        request: {
          clientRequestId: legacyId,
          userMessage: "legacy",
          submitSource: "composer",
          executionOptions: legacyOptions,
        },
        provider: "codex",
        workspacePath: f.child.workspacePath,
        attachments: [],
        origin: {
          kind: "session",
          actorKind: "main",
          actorSessionId: f.parent.id,
          actorIncarnationId: getSessionIncarnationId(f.parent),
          actorTurnId: f.sourceTurns.get(f.parent.id)!,
          operation: "send",
          targetSessionId: f.child.id,
          targetIncarnationId: getSessionIncarnationId(f.child),
          ...(requestedExecutionOptions === undefined
            ? {}
            : { requestedExecutionOptions }),
        },
      });
      legacyReceipts.push({ legacyId, receipt, requestedExecutionOptions });
    }
    await f.reopen();
    for (const {
      legacyId,
      receipt,
      requestedExecutionOptions,
    } of legacyReceipts) {
      for (const transport of ["cli", "mcp"] as const) {
        const read = await parent(transport, "get_receipt", {
          target: target(f.child),
          requestId: legacyId,
        });
        assert.equal(read.ok, true);
        const reloaded = read.receipt as SessionTurnQueueReceipt;
        assert.equal(reloaded.id, receipt.id);
        assert.deepEqual(
          reloaded.accepted!.origin!.requestedExecutionOptions,
          requestedExecutionOptions,
        );
        assert.deepEqual(
          reloaded.accepted!.request.executionOptions,
          legacyOptions,
        );
      }
      const dispatched = await f.bundle.stores.queue.claimNext(target(f.child));
      assert.equal(dispatched!.id, receipt.id);
      assert.deepEqual(
        dispatched!.dispatched!.request.executionOptions,
        legacyOptions,
      );
      await f.bundle.stores.queue.settle(
        target(f.child),
        receipt.id,
        "completed",
      );
    }
  } finally {
    await f.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "明示User/Auto ReviewはMainとAuxiliaryで再読込でき、変更前の未指定受付を上書きしない"
// oracle = { type = "contract", ref = "docs/design/withmate-auto-review.md#設定と適用範囲; docs/design/session-run-lifecycle.md#bound-session-api" }
// fault = "旧Userを明示設定と解釈する、新しい明示User/Auto Reviewをチェックポイントで失う、または受付済み設定に現在値を反映する"
// observable = "実Storage Worker再接続後のMain/AuxiliaryのReviewer選択と、変更前/後の公開受付の捕捉値"
// observation_boundary = "public-boundary"
// scope = "CopilotのSession選択チェックポイント、Auxiliary保存、MCP/CLIの通常送信"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// impact = "手動と仲介Auto Reviewが再起動やキュー待機で利用者の選択に反して切り替わる"
// distinction = "runtimeの審査テストはSQLiteや過去受付を通さず、型検査は選択の保存と復元を保証しない"
// @end-test-value
/** 明示 User の Main と明示 Auto Review の補助 Session を再接続後も復元し、審査先未指定だった過去受付を上書きしない。 */
test("explicit WithMate reviewer survives reopening without changing an earlier receipt", async () => {
  const f = await fixture("copilot");
  try {
    const child = await f.endpoint(f.child);
    const original = captureSessionExecutionOptions(f.parent);
    const input = {
      target: target(f.parent),
      message: "review checkpoint",
      requestId: randomUUID(),
      deliveryTiming: "after_source_turn",
    };
    const legacy = await child("mcp", "enqueue", input);
    assert.equal(legacy.ok, true, JSON.stringify(legacy));
    assert.equal(
      (legacy.receipt as SessionTurnQueueReceipt).accepted!.request
        .executionOptions.withMateReviewerExplicit,
      undefined,
    );
    const auxiliary = {
      ...f.parent,
      id: "review-aux",
      parentSessionId: f.parent.id,
      title: "Reviewer",
      createdAt: f.parent.updatedAt,
      runState: "idle" as const,
      composerDraft: "",
      displayAfterMessageIndex: null,
    };
    await f.bundle.stores.auxiliary.upsertAuxiliarySession(auxiliary);
    const manual = {
      ...original,
      codexReviewer: "user" as const,
      withMateReviewerExplicit: true as const,
    };
    const auto = { ...manual, codexReviewer: "auto-review" as const };
    await f.bundle.stores.session.setSessionExecutionOptions(
      f.parent.id,
      getSessionIncarnationId(f.parent),
      manual,
    );
    assert.equal(
      await f.bundle.stores.auxiliary.updateAuxiliaryExecutionOptionsIfMatches({
        auxiliarySessionId: auxiliary.id,
        parentSessionId: f.parent.id,
        createdAt: auxiliary.createdAt,
        updatedAt: auxiliary.updatedAt,
        options: { ...auto, provider: "copilot" },
      }),
      true,
    );
    await f.reopen();
    const parentStored = await f.bundle.stores.session.getSession(f.parent.id);
    const auxStored = await f.bundle.stores.auxiliary.getAuxiliarySession(
      auxiliary.id,
    );
    assert.deepEqual(captureSessionExecutionOptions(parentStored!), manual);
    assert.deepEqual(captureSessionExecutionOptions(auxStored!), auto);
    const prior = await child("cli", "get_receipt", {
      target: target(f.parent),
      requestId: input.requestId,
    });
    assert.deepEqual(
      (prior.receipt as SessionTurnQueueReceipt).accepted,
      (legacy.receipt as SessionTurnQueueReceipt).accepted,
    );
    const current = await child("cli", "enqueue", {
      ...input,
      requestId: randomUUID(),
    });
    assert.equal(current.ok, true, JSON.stringify(current));
    assert.deepEqual(
      (current.receipt as SessionTurnQueueReceipt).accepted!.request
        .executionOptions,
      manual,
    );
  } finally {
    await f.close();
  }
});

/** 再送で配信タイミングだけを変えた競合入力を作るため、もう一方の値を返す。 */
function deliveryTimingOther(timing: string) {
  return timing === "immediate" ? "after_source_turn" : "immediate";
}

// @test-value v2
// kind = "contract"
// claim = "Depth候補のある親のDefaultを子の報告がそのまま継承し、MCP/CLIの保存受付と次Turnへのdispatchで空文字を保つ"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/941; docs/design/model-catalog.md" }
// fault = "Defaultを不正Depthとして拒否するか具体的Depthへ置換する、または不正Depthを許可する"
// observable = "公開両入口のreceipt設定、再起動後dispatch requestの空Depth、理由付き拒否と未作成receipt"
// observation_boundary = "public-boundary"
// scope = "Codex/OpenCode/Claudeのbound MCP/CLI→application→queue facade→実Storage Worker、catalog fixture"
// lifecycle = "permanent"
// impact = "Default利用中の親へ子が完了報告できず作業が停止する"
// distinction = "schemaや具象Depthの既存testでは空文字の継承・具体候補validation・保存dispatchの接続を検証しない"
// @end-test-value
/** 子の報告で省略した Depth は親の空文字の Default を引き継いで再起動後の実行に届き、候補外の具体値は受付を残さず拒否する。 */
test("child reports inherit provider Default depth through acceptance and dispatch", async () => {
  for (const provider of ["codex", "opencode", "claude"]) {
    const f = await fixture(provider);
    try {
      await f.bundle.stores.session.updateSession({
        ...f.parent,
        reasoningEffort: "",
      });
      const child = await f.endpoint(f.child);
      const ids: string[] = [];
      for (const transport of ["mcp", "cli"] as const) {
        const body = {
          target: target(f.parent),
          requestId: randomUUID(),
          message: "completed",
        };
        const sent = await child(transport, "enqueue", body);
        assert.equal(sent.ok, true, JSON.stringify(sent));
        const receipt = sent.receipt as SessionTurnQueueReceipt;
        ids.push(receipt.id);
        assert.equal(receipt.accepted!.request.executionOptions.model, "deep");
        assert.equal(
          receipt.accepted!.request.executionOptions.reasoningEffort,
          "",
        );
        const invalid = {
          ...body,
          reasoningEffort: "low",
          requestId: randomUUID(),
        };
        assertRejected(await child(transport, "enqueue", invalid));
        assert.equal(
          await f.bundle.stores.queue.getReceipt(
            target(f.parent),
            invalid.requestId,
          ),
          null,
        );
      }
      await f.reopen();
      for (const id of ids) {
        const dispatch = await f.bundle.stores.queue.claimNext(
          target(f.parent),
        );
        assert.equal(dispatch!.id, id);
        assert.equal(
          dispatch!.dispatched!.request.executionOptions.reasoningEffort,
          "",
        );
        await f.bundle.stores.queue.settle(target(f.parent), id, "completed");
      }
      assert.equal(
        (await f.bundle.stores.session.getSession(f.parent.id))!
          .reasoningEffort,
        "",
      );
    } finally {
      await f.close();
    }
  }
});

/** MCP の入力スキーマエラーと業務上の受付拒否を、それぞれの応答形式に合わせて検証する。 */
function assertRejected(result: Record<string, unknown>) {
  if (result.isError === true) {
    // SDK のスキーマ検証では、アプリケーションの `structuredContent` ではなくテキストが返る。
    assert.match(JSON.stringify(result.content), /[Ii]nvalid|[Rr]equired/);
  } else {
    assert.equal(result.ok, false);
    assert.equal(result.effect, "none");
    assert.ok(result.message);
  }
}
