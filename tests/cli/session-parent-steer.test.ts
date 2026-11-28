import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
import { SessionManagementApplication } from "../../src-electron/session/session-management-application.js";
import { SessionManagementRuntimeService } from "../../src-electron/session/session-management-runtime-service.js";
import { SessionRuntimeService } from "../../src-electron/session/session-runtime-service.js";
import { SessionPersistenceService } from "../../src-electron/session/session-persistence-service.js";
import {
  resolveRelatedSessions,
  type RelatedSession,
} from "../../src-electron/session/session-relationship-resolver.js";
import { MainSessionTurnQueueFacade } from "../../src-electron/app/main-session-turn-queue-facade.js";
import { SessionTurnQueueService } from "../../src-electron/session/session-turn-queue-service.js";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import type {
  ProviderCodingAdapter,
  RunSessionTurnInput,
} from "../../src-electron/providers/provider-runtime.js";
import {
  getSessionAgentRuntimeOperations,
  type SessionTarget,
} from "../../src-shared/session/session-management-contract.js";
import {
  buildNewSession,
  getSessionIncarnationId,
  type Session,
  type TurnInputDeliveryState,
} from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { executionOperationResultSchemas } from "../../src-shared/session/session-execution-read.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";

/** 送信先の Main を ID と世代で指定する。 */
const target = (session: Session): SessionTarget => ({
  kind: "main",
  sessionId: session.id,
  incarnationId: getSessionIncarnationId(session),
});
/** 操作対象の Session を所有者として世代まで特定する。 */
const owner = (session: Session) => ({
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
/** 非同期の開始や中断をテストから明示的に解除できる待機点を作る。 */
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** 親子関係と実 Worker を用意し、子の実行・追加入力を CLI と MCP から観測できるようにする。 */
async function fixture(provider = "codex") {
  const directory = await mkdtemp(join(tmpdir(), "withmate-parent-steer-"));
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
  const bundle = createV6StorageWorkerBundle(options);
  try {
    await bundle.initialize();
    /** 同じ Crew に親や子孫を作成し、関係に応じた Role と実行環境を保存する。 */
    const create = (
      id: string,
      parentSessionId: string | null,
      childProvider = provider,
    ) =>
      bundle.stores.session.insertSession(
        buildNewSession({
          id,
          taskTitle: id,
          workspaceLabel: id,
          workspacePath: directory,
          branch: "main",
          characterId: id,
          character: id,
          characterIconPath: "",
          characterThemeColors: { main: "#123456", sub: "#abcdef" },
          provider: childProvider,
          model: "model",
          reasoningEffort: "high",
          approvalMode: "on-request",
          codexSandboxMode: "workspace-write",
          sessionRole:
            parentSessionId === "child"
              ? "executor"
              : parentSessionId
                ? "task-coordinator"
                : "overall-coordinator",
          rootSessionId: "parent",
          parentSessionId,
          createdBySessionId: parentSessionId,
        }),
      );
    const parent = await create("parent", null, "copilot"),
      child = await create("child", parent.id);
    const sibling = await create("sibling", parent.id),
      grandchild = await create("grandchild", child.id);
    let cached = [parent, child, sibling, grandchild];
    const settings = createDefaultAppSettings();
    settings.codingProviderSettings[provider] = {
      enabled: true,
      apiKey: "",
      skillRootPath: "",
    };
    const catalog = {
      id: provider,
      label: provider,
      defaultModelId: "model",
      defaultReasoningEffort: "high",
      models: [{ id: "model", label: "Model", reasoningEfforts: ["high"] }],
    };
    /** 追加入力の検証に含めない操作が呼ばれたら失敗させる。 */
    const unused = async (): Promise<never> => {
      throw new Error("Unexpected operation");
    };
    const hooks = {
      /** プレビュー処理の進行をテストで止められる差し替え点を設ける。 */
      preview: async () => {},
      /** 追加入力の pending 保存直後に動作を差し込めるようにする。 */
      afterBegin: async () => {},
      /** プロバイダーに渡った追加入力の応答を差し替えられるようにする。 */
      dispatch: async () => {},
      /** 追加入力の結果が DB に保存された時点で状態を観測できるようにする。 */
      afterSettle: (_state: Exclude<TurnInputDeliveryState, "pending">) => {},
      /** 確定した追加入力の保存応答に障害を差し込めるようにする。 */
      afterConfirm: async () => {},
    };
    const sentInputChanges: import("../../src-shared/session/session-turn-queue.js").SessionSteerOrigin[] =
      [];
    const persistence = new SessionPersistenceService({
      /** 永続化サービスに現在の Session キャッシュを返す。 */
      getSessions: () => cached,
      /** 保存後に Session のキャッシュを置き換える。 */
      setSessions: (next) => {
        cached = next;
      },
      /** メモリー上の Session を ID で探す。 */
      getSession: (id) => cached.find((session) => session.id === id) ?? null,
      /** キャッシュでなく実 DB の Session を調べる。 */
      getStoredSession: (id) => bundle.stores.session.getSession(id),
      /** 永続化側では実行中の Session として扱う。 */
      isSessionRunInFlight: () => true,
      upsertStoredSession: unused,
      replaceStoredSessions: unused,
      /** 永続化済みの Crew 一覧を Worker から取得する。 */
      listStoredSessions: () => bundle.stores.session.listSessions(),
      /** 実行開始時の Session 更新を DB へ渡す。 */
      appendStoredRunningTurnStart: (input) =>
        bundle.stores.session.appendRunningTurnStart(input),
      /** Steer を pending で保存し、保存直後の割り込み位置を開く。 */
      beginStoredSessionSteer: async (input) => {
        const result = await bundle.stores.session.beginSessionSteer(input);
        await hooks.afterBegin();
        return result;
      },
      /** 結果を DB に確定してから観測 hook を呼び、confirmed では保存応答の障害も再現できるようにする。 */
      settleStoredSessionSteer: async (input) => {
        const result = await bundle.stores.session.settleSessionSteer(input);
        hooks.afterSettle(input.state);
        if (input.state === "confirmed") await hooks.afterConfirm();
        return result;
      },
      /** Session の終了状態を実際の DB へ反映する。 */
      appendStoredSessionTerminal: (input) =>
        bundle.stores.session.appendSessionTerminal(input),
      /** 進行中 Turn のメタデータを Worker に記録する。 */
      checkpointStoredSessionRunMetadata: (input) =>
        bundle.stores.session.checkpointSessionRunMetadata(input),
      /** 永続化サービスへフィクスチャの共通設定を渡す。 */
      getAppSettings: () => settings,
      /** 対象 Provider の固定モデル候補を永続化サービスへ渡す。 */
      getModelCatalogSnapshot: () => ({ providers: [catalog] }),
      /** 画面を使わないためコンテキスト計測の消去を省く。 */
      clearSessionContextTelemetry() {},
      /** 実プロバイダーのスレッド無効化は送信しない。 */
      invalidateProviderSessionThread() {},
      /** 開いていない Session ウィンドウの終了を省略する。 */
      closeSessionWindow() {},
      /** Session キャッシュの更新は画面へ通知しない。 */
      broadcastSessions() {},
    });
    const live = new Map<string, LiveSessionRunState | null>();
    const runs: RunSessionTurnInput[] = [],
      sent: Parameters<
        NonNullable<ProviderCodingAdapter["steerSessionTurn"]>
      >[0][] = [];
    let started = deferred(),
      finish = deferred();
    const adapter: ProviderCodingAdapter = {
      /** プロンプト生成の違いを除外し、追加入力を検証するための初回入力を固定する。 */
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
      /** スタブは利用枠の観測値を返さない。 */
      getProviderQuotaTelemetry: async () => null,
      /** スタブは外部の個別スレッドを切断しない。 */
      invalidateSessionThread: async () => {},
      /** スタブは外部の全スレッドを切断しない。 */
      invalidateAllSessionThreads: async () => {},
      /** 実行の入力を記録し、native Turn が追加入力を受けられる状態を通知して、明示解除まで実行を継続する。 */
      runSessionTurn: async (input, progress) => {
        runs.push(input);
        await progress?.(
          {
            sessionId: child.id,
            threadId: "thread",
            turnId: "native-turn",
            inputAvailable: true,
            assistantText: "",
            reasoningText: "",
            steps: [],
            backgroundTasks: [],
            usage: null,
            errorMessage: "",
            approvalRequest: null,
            elicitationRequest: null,
          },
          {
            steps: { upserts: [], removes: [] },
            backgroundTasks: { upserts: [], removes: [] },
          },
        );
        started.resolve();
        await finish.promise;
        return { threadId: "thread", assistantText: "done", usage: null };
      },
      /** 来歴つき pending 入力が先に保存済みであることを検査してから、指定された native Turn の応答を模擬する。 */
      steerSessionTurn: async (input) => {
        sent.push(input);
        const saved = await bundle.stores.session.getSession(child.id);
        assert.equal(saved!.messages.at(-1)!.turnInput!.state, "pending");
        assert.equal(
          saved!.messages.at(-1)!.turnInput!.origin!.actorSessionId,
          parent.id,
        );
        await hooks.dispatch();
        return { turnId: input.expectedTurnId };
      },
    };
    const runtime = new SessionRuntimeService({
      /** 実行サービスが参照する Session を Worker から取得する。 */
      getSession: (id) => bundle.stores.session.getSession(id),
      /** 初回入力で実行開始する Session を永続化サービスに渡す。 */
      persistRunningTurnStart: (...args) =>
        persistence.persistRunningTurnStart(...args),
      /** 実行中に追加された入力を実際に保存する経路へ渡す。 */
      appendRunningInput: (...args) => persistence.appendRunningInput(...args),
      /** 追加入力の pending 保存を永続化サービスに委ねる。 */
      beginRunningInput: (...args) => persistence.beginRunningInput(...args),
      /** 送信結果に応じた追加入力の確定を永続化サービスに渡す。 */
      settleRunningInput: (...args) => persistence.settleRunningInput(...args),
      /** 実行途中のメタデータを永続化サービスへ渡す。 */
      checkpointRuntimeMetadata: (...args) =>
        persistence.checkpointRuntimeMetadata(...args),
      /** 実行終了時の状態と確定内容を実際の保存処理へ渡す。 */
      appendTerminalSession: (session, commit) =>
        persistence.appendTerminalSession(session, commit),
      /** 初回入力は待機させず、追加入力のプレビューだけに障害や実行競合を差し込めるようにする。 */
      resolveComposerPreview: async (_session, text) => {
        if (text !== "A") await hooks.preview();
        return { attachments: [], errors: [] };
      },
      /** 実行サービスが読む共通設定を固定する。 */
      getAppSettings: () => settings,
      /** 外部問い合わせを行わず対象 Provider のモデルカタログを返す。 */
      resolveProviderCatalog: () => ({
        snapshot: { providers: [catalog] },
        provider: catalog,
      }),
      /** 実際のモデル実行を、入力を記録できる adapter に差し替える。 */
      getProviderCodingAdapter: () => adapter,
      /** 公開履歴に使う Turn を実際に作成する。 */
      createSessionTurn: (input) => bundle.stores.turn.createSessionTurn(input),
      /** Turn の進行に伴う変化を Worker のストアに書き込む。 */
      updateSessionTurn: (id, input) =>
        bundle.stores.turn.updateSessionTurn(id, input),
      /** 進行中 Turn の更新を Session ID ごとにメモリーへ反映する。 */
      setLiveSessionRun: (id, value) => {
        live.set(id, value);
      },
      /** 実行中の Turn があれば ID から状態を取得する。 */
      getLiveSessionRun: (id) => live.get(id) ?? null,
      /** 承認 UI を待たず実行を継続する。 */
      waitForApprovalDecision: () => "approve",
      /** 追加入力を要求された場合は実ユーザーの応答を待たず取り消す。 */
      waitForElicitationResponse: () => ({ action: "cancel" }),
      /** 外部計測を伴わないため利用枠を記録しない。 */
      setProviderQuotaTelemetry() {},
      /** 画面向けコンテキスト使用量は保持しない。 */
      setSessionContextTelemetry() {},
      /** 実行終了に伴う実プロバイダーの無効化を省略する。 */
      invalidateProviderSessionThread() {},
      /** 外部サービスへの利用枠更新を予約しない。 */
      scheduleProviderQuotaTelemetryRefresh() {},
      /** 進行状態はメモリーだけで観測し、画面へ配信しない。 */
      broadcastLiveSessionRun() {},
      /** 送信履歴更新の通知を来歴付きで記録し、pending と終端の別を追跡できるようにする。 */
      onSentInputChanged(origin) {
        sentInputChanges.push(origin);
      },
      /** 画面に保留中の承認要求はないため解決しない。 */
      resolvePendingApprovalRequest() {},
      /** 画面に保留中の入力要求はないため解決しない。 */
      resolvePendingElicitationRequest() {},
    });
    const source = await bundle.stores.turn.createSessionTurn({
      sessionId: parent.id,
      phase: "running",
      createdAt: new Date().toISOString(),
      provider: parent.provider,
      model: parent.model,
      reasoningEffort: parent.reasoningEffort,
      approvalMode: parent.approvalMode,
      threadId: "",
      errorMessage: "",
    });
    const queue = new SessionTurnQueueService({
      store: bundle.stores.queue,
      /** 通常メッセージを受付済みのキューに留め、Steer の即時呼出と区別する。 */
      isRunInFlight: () => true,
      dispatch: unused,
    });
    const facade = new MainSessionTurnQueueFacade({
      /** テスト中の受付用 facade を常に稼働中とみなす。 */
      assertActive() {},
      /** 通常メッセージの受付停止はこのフィクスチャでは再現しない。 */
      assertAccepting() {},
      /** キューも同じ Worker の Session を参照する。 */
      getSession: (id) => bundle.stores.session.getSession(id),
      /** 受付時点の共通設定をキューへ返す。 */
      getAppSettings: async () => settings,
      /** キュー検証を実環境のワークスペース条件から分離する。 */
      validateWorkspace: async () => {},
      /** 実プロバイダーの問い合わせなしで受付用モデル候補を返す。 */
      validateProvider: async () => ({ provider: catalog }),
      /** 受け付けたテキストは添付もエラーもないものとして扱う。 */
      preview: async () => ({ attachments: [], errors: [] }),
      store: bundle.stores.queue,
      service: queue,
    });
    const extra: RelatedSession[] = [];
    const application = new SessionManagementApplication({
      operatingPolicy: unused,
      getInstructions: unused,
      setInstructions: unused,
      /** 実ストアの Crew 範囲を解決し、テストで差し込んだ補助 Session は所属 Main の範囲に結び付ける。 */
      readSessionScope: async (actor, selection) => {
        const fixtureAuxiliary =
          actor.kind === "auxiliary" &&
          extra.find((entry) => entry.id === actor.sessionId);
        if (!fixtureAuxiliary || actor.kind !== "auxiliary")
          return bundle.stores.session.readSessionManagementScope(
            actor,
            selection,
          );
        const scope = await bundle.stores.session.readSessionManagementScope(
          {
            kind: "main",
            sessionId: actor.mainSessionId,
            incarnationId: actor.mainIncarnationId,
          },
          selection,
        );
        return { ...scope, actor: scope.actor ? fixtureAuxiliary : null };
      },
      /** 親には保存済みの送信元 Turn、他の Session には稼働中の Turn を割り当てる。 */
      currentTurn: async (actor) => ({
        turnId:
          actor.id === parent.id
            ? String(source.id)
            : (live.get(actor.id)?.sessionTurnId ?? null),
        receipt: null,
        origin: null,
      }),
      /** 隔離したテストルートを Crew Folder として返す。 */
      crewFolder: async () => ({ rootSessionId: parent.id, path: directory }),
      /** 呼出元と宛先の世代、および双方の Turn を保持して実 Steer 処理へ渡す。 */
      steer: (destination, input, actor, turnId, guard) =>
        runtime.steerChildSessionTurn(
          {
            sessionId: destination.id,
            incarnationId: destination.incarnationId,
          },
          input.turnId,
          input.message,
          { sessionId: actor.id, incarnationId: actor.incarnationId, turnId },
          guard,
        ),
      /** 同じ Worker を経て保存された実行履歴を公開操作へ返す。 */
      readExecution: async (_destination, operation, request) =>
        bundle.stores.execution.execute({
          target: request.target,
          operation,
          request,
        }),
      /** 通常送信は送信者の来歴を付け、実行中 Turn への Steer とは別のキューへ渡す。 */
      enqueue: (destination, input, actor, turnId, guard) =>
        facade.enqueueSessionMessage(
          input,
          {
            kind: "session",
            operation: "send",
            actorKind: actor.kind,
            actorSessionId: actor.id,
            actorIncarnationId: actor.incarnationId,
            actorTurnId: turnId,
            targetSessionId: destination.id,
            targetIncarnationId: destination.incarnationId,
          },
          guard,
        ),
      getReceipt: unused,
      directories: unused,
      updateMetadata: unused,
      cancelReceipt: unused,
      stopTurn: unused,
      createChild: unused,
      coordinate: unused,
      catalog: unused,
    });
    const bindings = new AgentRuntimeBindingRegistry(),
      turns = new ProviderAgentRuntimeTurnCoordinator();
    const routing = new SessionManagementRuntimeService({
      application,
      bindingRegistry: bindings,
      providerAgentRuntimeTurns: turns,
    });
    /** HTTP サーバーを介さず、binding と capability 付きの要求を本番のルーティングへ渡す。 */
    const runtimeCall: typeof callAgentRuntime = async (
      _connection,
      operation,
      bound,
    ) => {
      const response = await routing.route({
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
    /** Session の世代にバインドした実行権限を用意し、CLI と SDK MCP の両方で使えるようにする。 */
    async function endpoint(session: Session, identity = target(session)) {
      const binding = bindings.issueOrReuse({
        actorSessionId: identity.sessionId,
        providerId: session.provider,
        authoritySnapshot: { sessionIdentity: identity },
        operationGrants: getSessionAgentRuntimeOperations(),
      });
      const active = turns.begin({
        actorSessionId: identity.sessionId,
        providerId: session.provider,
      });
      const env = {
        WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: binding.bindingReference,
        WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: active.capability,
      };
      const server = createWithMateSessionMcpServer({
        env,
        connection,
        runtimeCall,
      });
      const client = new Client({ name: "parent-steer", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(b);
      await client.connect(a);
      cleanups.push(async () => {
        await client.close();
        await server.close();
        turns.end(active);
      });
      return {
        /** 接続を閉じず送信元 Turn の capability だけを失効させる。 */
        revoke: () => turns.end(active),
        /** 同じテスト入力を選んだ公開入口へ送り、構造化結果として取り出す。 */
        call: async (
          transport: "cli" | "mcp",
          operation: string,
          body: Record<string, unknown>,
        ): Promise<Record<string, any>> => {
          if (transport === "mcp") {
            const result = await client.callTool({
              name: `session.${operation}`,
              arguments: body,
            });
            return result.structuredContent ?? result;
          }
          let output = "";
          await runWithMateSessionCli(
            [operation.replaceAll("_", "-"), "--json", JSON.stringify(body)],
            {
              env,
              connection,
              runtimeCall,
              stdout: {
                /** CLI の JSON 出力を解析できるよう標準出力を連結する。 */
                write: (text) => {
                  output += String(text);
                  return true;
                },
              },
              stderr: {
                /** テストプロセスの標準エラーへ CLI 出力を流さない。 */
                write: () => true,
              },
            },
          );
          return JSON.parse(output);
        },
      };
    }
    let running: Promise<Session> | undefined;
    return {
      parent,
      child,
      sibling,
      grandchild,
      source,
      extra,
      runtime,
      bundle,
      hooks,
      sentInputChanges,
      live,
      sent,
      runs,
      endpoint,
      /** 子を起動し、adapter が追加入力可能になってから公開 Turn ID を返す。 */
      async start() {
        started = deferred();
        finish = deferred();
        running = runtime.runSessionTurn(child.id, {
          userMessage: "A",
          executionOptions: captureSessionExecutionOptions(child),
        });
        await Promise.race([
          started.promise,
          running.then(() => {
            throw new Error("Turn ended before starting");
          }),
        ]);
        return live.get(child.id)!.sessionTurnId!;
      },
      /** adapter の待機を解除し、現在の実行が実際に終わるまで待つ。 */
      async finish() {
        finish.resolve();
        await running;
      },
      /** 子の実行待機を解除し、SDK 接続・キュー・Worker を閉じて隔離データを片付ける。 */
      async close() {
        finish.resolve();
        await running?.catch(() => {});
        for (const cleanup of cleanups) await cleanup();
        await queue.close();
        await bundle.client.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await bundle.client.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

// @test-value v2
// kind = "contract"
// claim = "MCPとCLIの親Steerは同じ子Turnへ本文と実親来歴を保存し、pendingとconfirmed保存後それぞれ送信元無効化callbackを呼び、通常enqueueは次Turnを待ち保存設定を変えない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/938; https://github.com/natumekazuki/WithMate/issues/966; docs/design/desktop-ui.md#turn-input-details; docs/design/session-run-lifecycle.md#bound-session-api" }
// fault = "pendingまたは確定後の通知を欠落させる、Steerを通常queueへ送る、来歴をGUI扱いする、確定追加入力を取得できない、進行中設定や保存設定を変更する"
// observable = "両入口の結果、実Workerの送信元・受信元読取と入力状態、Provider到達時および確定保存応答時からのruntime通知件数の増加と新規origin、Providerへのnative Turnと来歴、receipt状態とTurn設定"
// observation_boundary = "public-boundary"
// scope = "SDK MCP/bound CLI→binding→application→production runtime/persistence→実Storage Worker。Provider・HTTP交換・currentTurn解決はfixture"
// lifecycle = "permanent"
// impact = "親の訂正が別作業へ届く、またはユーザーの発話と誤認される"
// distinction = "schema検査とruntime単体では両入口から永続化・履歴読取までの接続を検証できない"
// @end-test-value
/** CLI と MCP の親 Steer が指定 Turn へ来歴付きで届き、保留・確定の履歴更新を通知する一方、通常送信は実行設定を変えず次 Turn を待つ。 */
test("parent Steer preserves the exact Turn, attribution and settings through MCP and CLI", async () => {
  const f = await fixture();
  try {
    const parent = await f.endpoint(f.parent);
    const turnId = await f.start();
    const initial = captureSessionExecutionOptions(
      (await f.bundle.stores.session.getSession(f.child.id))!,
    );
    /** 送信元 Turn に属する Steer 履歴を MCP から取得し、状態変化を比較する。 */
    const outgoing = () =>
      parent.call("mcp", "list_sent_steers", {
        target: target(f.parent),
        messageSeqs: [],
        liveTurnIds: [String(f.source.id)],
      });
    const noticeCounts = { before: 0, pending: 0, settled: 0 };
    f.hooks.dispatch = async () => {
      const pending = await outgoing();
      assert.equal(pending.items.at(-1).state, "pending");
      assert.ok(
        f.sentInputChanges.length > noticeCounts.before,
        "This input must publish a pending notification before Provider dispatch.",
      );
      noticeCounts.pending = f.sentInputChanges.length;
      assert.equal(f.sentInputChanges.at(-1)?.actorSessionId, f.parent.id);
    };
    f.hooks.afterSettle = (state) => {
      assert.equal(state, "confirmed");
      noticeCounts.settled = f.sentInputChanges.length;
    };
    for (const transport of ["mcp", "cli"] as const) {
      assert.equal(
        (await parent.call(transport, "get", { target: target(f.child) }))
          .currentTurn.turnId,
        turnId,
      );
      const text = `B ${transport}: check loading before changing settings`;
      noticeCounts.before = f.sentInputChanges.length;
      noticeCounts.pending = noticeCounts.settled = 0;
      const response = await parent.call(transport, "steer", {
        target: target(f.child),
        turnId,
        message: text,
      });
      assert.equal(response.ok, true);
      assert.equal(response.result.outcome, "applied");
      assert.equal(response.result.turnId, turnId);
      const seq = response.result.messageSeq;
      const detail = await parent.call(transport, "get_execution_input", {
        target: target(f.child),
        turnId,
        seq,
      });
      assert.equal(detail.text, text);
      assert.equal(detail.turnId, turnId);
      assert.equal(detail.inputOrigin.operation, "steer");
      assert.equal(detail.inputOrigin.actorSessionId, f.parent.id);
      assert.equal(
        detail.inputOrigin.actorIncarnationId,
        f.parent.incarnationId,
      );
      assert.equal(detail.inputOrigin.actorTurnId, String(f.source.id));
      assert.equal(detail.inputOrigin.kind, "session");
      const sent = await outgoing();
      assert.deepEqual(
        [
          sent.items.at(-1).messageSeq,
          sent.items.at(-1).text,
          sent.items.at(-1).state,
        ],
        [seq, text, "confirmed"],
      );
      assert.deepEqual(sent.items.at(-1).target, target(f.child));
      assert.ok(
        noticeCounts.settled >= noticeCounts.pending &&
          noticeCounts.pending > noticeCounts.before,
      );
      const resultNotices = f.sentInputChanges.slice(noticeCounts.settled);
      assert.ok(
        resultNotices.length > 0,
        "Confirmed input must publish a new notification after its storage commit.",
      );
      for (const notice of resultNotices)
        assert.deepEqual(notice, detail.inputOrigin);
      const history = await parent.call(transport, "get_message", {
        target: target(f.child),
        seq,
      });
      assert.equal(history.speaker.kind, "agent");
      assert.equal(history.speaker.session.id, f.parent.id);
      assert.equal(f.sent.at(-1)!.expectedTurnId, "native-turn");
      const providerInputLines = f.sent.at(-1)!.userMessage.split("\n");
      for (const expectedLine of [
        "Sender: Session",
        `Session: ${JSON.stringify(f.parent.id)}`,
        `Incarnation: ${JSON.stringify(f.parent.incarnationId)}`,
        `Source Turn: ${JSON.stringify(String(f.source.id))}`,
        'Operation: "steer"',
      ]) {
        assert.ok(providerInputLines.includes(expectedLine), expectedLine);
      }
      assert.ok(f.sent.at(-1)!.userMessage.includes(text));
    }
    const inputs = await parent.call("cli", "list_execution_inputs", {
      target: target(f.child),
      turnId,
    });
    assert.deepEqual(
      inputs.items.map((item: { kind: string }) => item.kind),
      ["start", "additional", "additional"],
    );
    assert.equal(
      (
        await parent.call("mcp", "get_execution_input", {
          target: target(f.child),
          turnId,
          seq: inputs.items[0].seq,
        })
      ).text,
      "A",
    );
    const executions = await f.bundle.stores.execution.execute({
      target: target(f.child),
      operation: "list_executions",
      request: { target: target(f.child), kind: "turns" },
    });
    assert.ok(executions.ok);
    assert.equal(executions.total, 1);
    const queued = await parent.call("cli", "enqueue", {
      target: target(f.child),
      requestId: randomUUID(),
      message: "next Turn",
      model: "model",
      reasoningEffort: "high",
    });
    assert.equal(queued.receipt.state, "queued");
    assert.equal(f.sent.length, 2);
    assert.equal(f.runs.length, 1);
    assert.deepEqual(
      captureSessionExecutionOptions(
        (await f.bundle.stores.session.getSession(f.child.id))!,
      ),
      initial,
    );
    const execution = await parent.call("mcp", "get_execution", {
      target: target(f.child),
      turnId,
    });
    assert.deepEqual(
      [
        execution.executionSettings.model,
        execution.executionSettings.reasoningEffort,
        execution.executionSettings.approvalMode,
        execution.executionSettings.codexSandboxMode,
      ],
      ["model", "high", "on-request", "workspace-write"],
    );
    await f.finish();
    assert.equal((await outgoing()).items.length, 2);
    assert.equal(
      (
        await parent.call("cli", "list_execution_inputs", {
          target: target(f.child),
          turnId,
        })
      ).items.length,
      3,
    );
  } finally {
    await f.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "両入口のSteerは実直属親だけに許可し、旧世代・終了済Turn・非対応Providerを送信せず準備中の交代や失効も別Turnへ転送しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/938" }
// fault = "子・兄弟・祖父母・Auxiliaryを親扱いする、終了・交代・非対応や失効後にProviderへ送信する"
// observable = "両入口の拒否code/effectまたはnot-applied、Provider呼出数、子の保存入力件数"
// observation_boundary = "public-boundary"
// scope = "MCP/CLI→実認可・runtime、実Worker履歴、Provider/準備gateとAuxiliary metadataはfixture"
// lifecycle = "permanent"
// impact = "権限のないAgentや古い依頼が別作業の進行へ介入する"
// distinction = "正常系とschemaでは関係・世代・非同期Turn交代を検出できない"
// @end-test-value
/** 直属の Main 親以外、旧世代・旧 Turn、非対応プロバイダー、準備中に失効した要求を両入口で拒否し、プロバイダー送信や保存入力を残さない。 */
test("parent Steer rejects unrelated senders and never retargets stale or unsupported Turns", async () => {
  for (const provider of ["codex", "copilot", "claude", "opencode"]) {
    const f = await fixture(provider);
    try {
      const parent = await f.endpoint(f.parent),
        child = await f.endpoint(f.child),
        sibling = await f.endpoint(f.sibling);
      const turnId = await f.start();
      f.extra.push({
        ...resolveRelatedSessions([f.parent], [])[0],
        id: "aux",
        incarnationId: "aux-v1",
        kind: "auxiliary",
        role: "auxiliary",
        mainSessionId: f.parent.id,
        mainIncarnationId: f.parent.incarnationId!,
      });
      const aux = await f.endpoint(f.parent, {
        kind: "auxiliary",
        sessionId: "aux",
        incarnationId: "aux-v1",
        mainSessionId: f.parent.id,
        mainIncarnationId: f.parent.incarnationId!,
      });
      for (const transport of ["mcp", "cli"] as const) {
        for (const [sender, recipient] of [
          [child, f.parent],
          [sibling, f.child],
          [parent, f.grandchild],
          [aux, f.child],
        ] as const) {
          const response = await sender.call(transport, "steer", {
            target: target(recipient),
            turnId,
            message: "forbidden",
          });
          assert.equal(response.code, "SESSION_FORBIDDEN");
          assert.equal(response.effect, "none");
        }
        const replaced = await parent.call(transport, "steer", {
          target: { ...target(f.child), incarnationId: "old" },
          turnId,
          message: "old owner",
        });
        assert.equal(replaced.code, "SESSION_REPLACED");
        assert.equal(replaced.effect, "none");
        const notApplied = await parent.call(transport, "steer", {
          target: target(f.child),
          turnId: provider === "codex" ? "999999" : turnId,
          message: "not applicable",
        });
        assert.equal(notApplied.result.outcome, "not-applied");
      }
      if (provider === "codex") {
        const entered = deferred(),
          resume = deferred();
        f.hooks.preview = async () => {
          entered.resolve();
          await resume.promise;
        };
        const pending = parent.call("cli", "steer", {
          target: target(f.child),
          turnId,
          message: "race",
        });
        await entered.promise;
        await f.finish();
        resume.resolve();
        assert.equal((await pending).result.outcome, "not-applied");
        const nextId = await f.start();
        assert.notEqual(nextId, turnId);
        assert.equal(
          (
            await parent.call("cli", "steer", {
              target: target(f.child),
              turnId,
              message: "stale Turn",
            })
          ).result.outcome,
          "not-applied",
        );
        f.hooks.preview = async () => {
          parent.revoke();
        };
        assert.equal(
          (
            await parent.call("mcp", "steer", {
              target: target(f.child),
              turnId: nextId,
              message: "revoked",
            })
          ).result.outcome,
          "not-applied",
        );
      } else await f.finish();
      assert.equal(f.sent.length, 0);
      assert.ok(
        (await f.bundle.stores.session.getSession(f.child.id))!.messages.every(
          (message) => !message.turnInput,
        ),
      );
    } finally {
      await f.close();
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "親SteerのProvider結果不明は未送信と区別して受信元・送信元から取得でき、各結果の保存後に新しい無効化callbackを呼び、ACK喪失や終端競合でも自動再送しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/938; https://github.com/natumekazuki/WithMate/issues/966; docs/design/desktop-ui.md#turn-input-details" }
// fault = "pendingだけ通知して結果通知を欠落させる、送信後失敗をnot-appliedにする、確定保存を不明へ巻き戻す、未送信・不明を成功とする、終端が入力保存を追い越す"
// observable = "両入口のeffect/outcome、実Workerの保存stateとinputOrigin、結果保存応答時点以降のruntime通知件数の増加と新規origin、送信元projection、Provider回数、保存終端と入力本文"
// observation_boundary = "public-boundary"
// scope = "production runtime/persistenceと実Worker。Provider失敗、begin/confirm後ACKと終端のgateをfixture注入"
// lifecycle = "permanent"
// impact = "訂正の重複配送または適用済みと誤認したまま運用する"
// distinction = "通常Steer testは公開MCP/CLIの結果と保存された親来歴を照合しない"
// @end-test-value
/** 応答喪失と未送信を公開結果と送受信履歴で区別し、終端競合や確定応答の喪失でも確定入力を巻き戻さず自動再送しない。 */
test("parent Steer reports uncertain delivery and preserves confirmed input across terminal races", async () => {
  for (const mode of [
    "unknown",
    "not-sent",
    "confirm-lost",
    "terminal-race",
  ] as const) {
    const f = await fixture();
    try {
      const parent = await f.endpoint(f.parent);
      const turnId = await f.start();
      const noticeCounts = {
        before: f.sentInputChanges.length,
        settled: 0,
        state: "",
      };
      f.hooks.afterSettle = (state) => {
        noticeCounts.settled = f.sentInputChanges.length;
        noticeCounts.state = state;
      };
      if (mode === "unknown")
        f.hooks.dispatch = async () => {
          throw new Error("Provider response lost");
        };
      if (mode === "not-sent")
        f.hooks.afterBegin = async () => {
          parent.revoke();
        };
      if (mode === "confirm-lost")
        f.hooks.afterConfirm = async () => {
          throw new Error("Confirmation reply lost");
        };
      const dispatchEntered = deferred(),
        dispatchResume = deferred();
      if (mode === "terminal-race")
        f.hooks.dispatch = async () => {
          dispatchEntered.resolve();
          await dispatchResume.promise;
        };
      const pending = parent.call(
        mode === "unknown" || mode === "terminal-race" ? "cli" : "mcp",
        "steer",
        {
          target: target(f.child),
          turnId,
          message: "B",
        },
      );
      let finishing: Promise<void> | undefined;
      if (mode === "terminal-race") {
        await dispatchEntered.promise;
        finishing = f.finish();
        dispatchResume.resolve();
      }
      const response = await pending;
      const uncertain = mode === "unknown" || mode === "confirm-lost";
      assert.equal(response.ok, !uncertain);
      assert.equal(
        response.result.outcome,
        uncertain ? "unknown" : mode === "not-sent" ? "not-applied" : "applied",
      );
      if (uncertain) {
        assert.equal(response.code, "SESSION_STEER_UNKNOWN");
        assert.equal(response.effect, "unknown");
      }
      assert.equal(f.sent.length, mode === "not-sent" ? 0 : 1);
      await finishing;
      await f.finish();
      const reader = await f.endpoint(f.child);
      const inputState =
        mode === "unknown"
          ? "unresolved"
          : mode === "not-sent"
            ? "not-sent"
            : "confirmed";
      const inputs = await reader.call("cli", "list_execution_inputs", {
        target: target(f.child),
        turnId,
        state: inputState,
      });
      const additional = inputs.items.filter(
        (input: { kind: string }) => input.kind === "additional",
      );
      assert.equal(additional.length, 1);
      assert.equal(
        additional[0].state,
        mode === "unknown"
          ? "unknown"
          : mode === "not-sent"
            ? "not-sent"
            : "confirmed",
      );
      assert.equal(additional[0].inputOrigin.actorSessionId, f.parent.id);
      const outgoing = await f.bundle.stores.execution.execute({
        target: target(f.parent),
        operation: "list_sent_steers",
        request: {
          target: target(f.parent),
          messageSeqs: [],
          liveTurnIds: [String(f.source.id)],
        },
      });
      assert.ok(outgoing.ok);
      const projected =
        executionOperationResultSchemas.list_sent_steers.parse(outgoing);
      assert.deepEqual(
        projected.items.map((item) => [item.state, item.text, item.messageSeq]),
        [[additional[0].state, "B", additional[0].seq]],
      );
      assert.equal(
        noticeCounts.state,
        additional[0].state,
        "The baseline must follow the committed input state, including a lost confirmation reply.",
      );
      assert.ok(
        noticeCounts.settled > noticeCounts.before,
        "The pending notification must precede the result commit.",
      );
      const resultNotices = f.sentInputChanges.slice(noticeCounts.settled);
      assert.ok(
        resultNotices.length > 0,
        `${mode} must publish a new notification after the input state commit.`,
      );
      for (const notice of resultNotices)
        assert.deepEqual(notice, additional[0].inputOrigin);
      assert.equal(
        (
          await reader.call("mcp", "get_execution_input", {
            target: target(f.child),
            turnId,
            seq: additional[0].seq,
          })
        ).text,
        "B",
      );
      assert.deepEqual(
        (await f.bundle.stores.session.getSession(f.child.id))!.messages.map(
          (message) => message.text,
        ),
        ["A", "B", "done"],
      );
    } finally {
      await f.close();
    }
  }
});
