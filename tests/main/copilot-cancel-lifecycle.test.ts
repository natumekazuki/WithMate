import type { SessionTurnRecord } from "../../src-shared/session/session-turn-state.js";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { it } from "node:test";
import {
  CopilotClient,
  RuntimeConnection,
  type CopilotSession,
  type SessionEvent,
} from "@github/copilot-sdk";

import { CopilotAdapter } from "../../src-electron/providers/copilot/copilot-adapter.js";
import { SessionRuntimeFixture as SessionRuntimeService } from "./session-runtime-fixture.js";
import { ProviderTurnError } from "../../src-electron/providers/provider-runtime.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type {
  LiveElicitationResponse,
  LiveSessionRunState,
} from "../../src-shared/session/runtime-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";

/** SDK の応答順をテスト側で選ぶため、外部から解決・拒否できる Promise を作る。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** 非同期の境界まで短く待機し、到達しないケースをタイムアウトとして失敗させる。 */
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("lifecycle boundary was not reached");
}

/** 送信、取り消し、切断、回答 ACK と SDK のイベントを個別に進められるセッションを模擬する。 */
class FakeSession {
  private eventSequence = 0;
  readonly inputAck = deferred<{ success: boolean }>();
  readonly inputAckStarted = deferred<void>();
  readonly rpc = {
    eventLog: {
      /** イベントの種類を登録ハンドルとして返す。 */
      registerInterest: async ({ eventType }: { eventType: string }) => ({
        handle: eventType,
      }),
      /** テスト用のイベント関心を追加処理なしで解除する。 */
      releaseInterest: async () => ({}),
    },
    ui: {
      /** ネイティブ質問への回答処理開始を通知し、テストが解放するまで ACK を保留する。 */
      handlePendingUserInput: async () => {
        this.inputAckStarted.resolve();
        return this.inputAck.promise;
      },
      /** MCP 入力の回答も開始通知と保留した ACK を使い、取り消しとの順序を選べるようにする。 */
      handlePendingElicitation: async () => {
        this.inputAckStarted.resolve();
        return this.inputAck.promise;
      },
    },
  };
  readonly sessionId = "preserved-thread";
  readonly listeners = new Set<(event: SessionEvent) => void>();
  readonly retainedListeners = new Set<(event: SessionEvent) => void>();
  readonly sends: ReturnType<typeof deferred<string>>[] = [];
  onSend?: (prompt: string) => void;
  readonly abortReply = deferred<void>();
  readonly abortStarted = deferred<void>();
  readonly disconnectStarted = deferred<void>();
  readonly disconnectReply = deferred<void>();
  abortCalls = 0;
  disconnectCalls = 0;
  delayDisconnect = false;
  /** 現在の購読者を登録し、解除後にも遅延コールバックを模擬できる参照を保持する。 */
  on(listener: (event: SessionEvent) => void) {
    this.listeners.add(listener);
    this.retainedListeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** 送信済みのプロンプトを記録可能にし、SDK の送信 ACK を後で確定できるようにする。 */
  send({ prompt }: { prompt: string }) {
    const reply = deferred<string>();
    this.sends.push(reply);
    this.onSend?.(prompt);
    return reply.promise;
  }
  /** 取り消し要求を数え、ACK の到着をテスト側で制御する。 */
  abort() {
    this.abortCalls += 1;
    this.abortStarted.resolve();
    return this.abortReply.promise;
  }
  /** セッション切断の開始を知らせ、設定に応じて応答を保留する。 */
  disconnect() {
    this.disconnectCalls += 1;
    this.disconnectStarted.resolve();
    if (this.delayDisconnect) return this.disconnectReply.promise;
    this.listeners.clear();
    return Promise.resolve();
  }
  /** 通常の購読者または解除済みの購読者に一意なイベントを送り、到着順を再現する。 */
  emit(type: string, data: Record<string, unknown> = {}, late = false) {
    const event = {
      id: `event-${++this.eventSequence}`,
      type,
      data,
    } as SessionEvent;
    for (const listener of late ? this.retainedListeners : this.listeners) {
      listener(event);
    }
  }
  /** 通信終了を模擬し、保留中の送信を接続切断エラーで拒否する。 */
  closeTransport() {
    this.listeners.clear();
    for (const reply of this.sends)
      reply.reject(new Error("Connection is closed."));
    this.abortReply.reject(new Error("Connection is closed."));
    this.disconnectReply.reject(new Error("Connection is closed."));
    this.inputAck.reject(new Error("Connection is closed."));
    // 使われなかった RPC の待機点は fixture の制御用であり、送出された要求ではない。
    void this.abortReply.promise.catch(() => undefined);
    void this.disconnectReply.promise.catch(() => undefined);
    void this.inputAck.promise.catch(() => undefined);
  }
}

/** 停止要求の受理と実際の終了イベントを分離した子プロセスを模擬する。 */
class FakeProcess extends ChildProcess {
  readonly exited = deferred<void>();
  autoExit = true;
  killAccepted = true;
  killCalls = 0;
  /** 停止シグナルの回数を記録し、設定に応じて拒否または即時終了する。 */
  override kill() {
    this.killCalls += 1;
    if (!this.killAccepted) return false;
    if (this.autoExit) this.exit();
    return true;
  }
  /** 終了コードを設定し、終了待ちと SDK の終了イベントを進める。 */
  exit() {
    Reflect.set(this, "exitCode", 0);
    this.emit("exit", 0, null);
    this.exited.resolve();
  }
}

/** SDK クライアントの作成・再開・通常停止・強制停止をテストから制御できるようにする。 */
class FakeClient {
  readonly child = new FakeProcess();
  cliProcess: FakeProcess | null = this.child;
  readonly sessions: FakeSession[] = [];
  readonly resumeIds: string[] = [];
  readonly stopStarted = deferred<void>();
  readonly stopReply = deferred<Error[]>();
  readonly forceStarted = deferred<void>();
  readonly forceReply = deferred<void>();
  stopMode: "normal" | "pending" | "reject" | "failed-kill" = "normal";
  forceMode: "normal" | "pending" | "reject" = "normal";
  stopCalls = 0;
  forceCalls = 0;
  deferRpcClosure = false;
  onSend?: (prompt: string) => void;
  /** 新規セッションを生成し、送信観測用のフックを引き継ぐ。 */
  createSession() {
    const session = new FakeSession();
    session.onSend = this.onSend;
    this.sessions.push(session);
    return Promise.resolve(session);
  }
  /** 再開したスレッド ID を記録し、別の疑似セッションを返す。 */
  resumeSession(id: string) {
    this.resumeIds.push(id);
    return this.createSession();
  }
  /** RPC 終了を保留する指定がなければ、配下のセッションを閉じて停止応答を解放する。 */
  closeTransport() {
    if (this.deferRpcClosure) return;
    for (const session of this.sessions) session.closeTransport();
    this.stopReply.resolve([]);
  }
  /** 設定どおりに停止を保留・拒否し、正常系だけ子プロセスの終了完了まで待つ。 */
  async stop() {
    this.stopCalls += 1;
    this.stopStarted.resolve();
    if (this.stopMode === "pending") return this.stopReply.promise;
    if (this.stopMode === "reject") throw new Error("stop unavailable");
    this.closeTransport();
    this.cliProcess = null;
    if (this.stopMode === "failed-kill") {
      this.child.kill();
      return [new Error("kill was not accepted")];
    }
    this.child.kill();
    await this.child.exited.promise;
    return [];
  }
  /** 強制停止では設定した故障を再現し、終了が確定する前にプロセスハンドルを失い得る。 */
  async forceStop() {
    this.forceCalls += 1;
    this.forceStarted.resolve();
    if (this.forceMode === "pending") await this.forceReply.promise;
    if (this.forceMode === "reject") throw new Error("force stop unavailable");
    this.closeTransport();
    // 終了に失敗する場合も含め、プロセスの終了確認なしで通信経路を破棄する状況を再現する。
    // アダプターは取得済みの子プロセスの生存期間を引き続き追跡する必要がある。
    const child = this.cliProcess;
    this.cliProcess = null;
    try {
      child?.kill();
    } catch {
      /* SDK は `kill` の失敗を握りつぶす。 */
    }
  }
}

/** 実アダプターとランタイムを疑似 Copilot 接続およびメモリ内のセッション・ターン保存に結線する。 */
function fixture(
  options: {
    cancelGraceMs?: number;
    runtimeGraceMs?: number;
    realForceStop?: boolean;
    elicitationResponse?: LiveElicitationResponse;
    configureClient?: (client: FakeClient, index: number) => void;
  } = {},
) {
  let stored = buildNewSession({
    provider: "copilot",
    taskTitle: "cancel lifecycle",
    workspaceLabel: "fixture",
    workspacePath: process.cwd(),
    branch: "fixture",
    characterId: "fixture",
    character: "Fixture",
    characterIconPath: "",
    characterThemeColors: { main: "#000000", sub: "#ffffff" },
    approvalMode: "on-request",
    model: "gpt-4.1",
    reasoningEffort: "high",
  });
  let live: LiveSessionRunState | null = null;
  const turns: SessionTurnRecord[] = [];
  const clients: FakeClient[] = [];
  const logs: string[] = [];
  const catalog: ModelCatalogProvider = {
    id: "copilot",
    label: "Copilot",
    defaultModelId: "gpt-4.1",
    defaultReasoningEffort: "high",
    models: [{ id: "gpt-4.1", label: "GPT-4.1", reasoningEfforts: ["high"] }],
  };
  const adapter = new CopilotAdapter({
    turnCancelGraceMs: options.cancelGraceMs ?? 0,
    sessionDisconnectTimeoutMs: 0,
    clientStopTimeoutMs: 0,
    /** 終了や停止が失敗したときに残す診断文を記録する。 */
    log: (entry) => {
      logs.push(entry.message);
    },
  });
  adapter.composePrompt = ({ userMessage }) => ({
    systemBodyText: "",
    inputBodyText: userMessage,
    logicalPrompt: {
      systemText: "",
      inputText: userMessage,
      composedText: userMessage,
    },
    imagePaths: [],
    additionalDirectories: [],
  });
  const ports = adapter as unknown as {
    clients: Map<string, CopilotClient>;
    /** テスト用接続を返すアダプター内部のクライアント取得口。 */
    getClient(): { client: CopilotClient; clientKey: string };
  };
  ports.getClient = () => {
    const clientKey = "owned-client";
    let client = ports.clients.get(clientKey);
    if (!client) {
      const fake = new FakeClient();
      options.configureClient?.(fake, clients.length);
      clients.push(fake);
      if (options.realForceStop) {
        // プロセスを起動せず、Copilot に接続せずに SDK のインスタンスを作る。
        const sdk = new CopilotClient({
          connection: RuntimeConnection.forStdio({
            path: "unused-cancel-fixture",
          }),
        });
        sdk.createSession = async () =>
          (await fake.createSession()) as unknown as CopilotSession;
        sdk.resumeSession = async (id) =>
          (await fake.resumeSession(id)) as unknown as CopilotSession;
        sdk.stop = async () => {
          const result = await fake.stop();
          Reflect.set(sdk, "cliProcess", fake.cliProcess);
          return result;
        };
        Reflect.set(sdk, "cliProcess", fake.child);
        Reflect.set(sdk, "connection", {
          /** SDK が接続を破棄したとき、疑似クライアントの RPC を閉じる。 */
          dispose: () => fake.closeTransport(),
        });
        const forceStop = sdk.forceStop.bind(sdk);
        sdk.forceStop = async () => {
          fake.forceCalls += 1;
          fake.forceStarted.resolve();
          await forceStop();
        };
        client = sdk;
      } else {
        client = fake as unknown as CopilotClient;
      }
      ports.clients.set(clientKey, client);
    }
    return { client, clientKey };
  };
  const service = new SessionRuntimeService({
    providerCancelGraceMs: options.runtimeGraceMs ?? 1000,
    /** 直前に保存したセッションを返し、次の実行で参照させる。 */
    getSession: () => stored,
    /** セッションの最新値をメモリへ保持する。 */
    upsertSession: (next) => {
      stored = next;
      return next;
    },
    /** 終了済みのターン更新とセッション保存を同じ代替ストアに反映する。 */
    upsertTerminalSession: (next, commit) => {
      stored = next;
      const index = turns.findIndex((turn) => turn.id === commit.turnId);
      turns[index] = {
        ...turns[index],
        phase: commit.phase,
        errorMessage: commit.errorMessage,
      };
      return next;
    },
    /** 添付や入力参照のないプレビューを返す。 */
    resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
    /** Copilot が利用可能なアプリ設定を返す。 */
    getAppSettings: () =>
      normalizeAppSettings({
        codingProviderSettings: { copilot: { enabled: true } },
      }),
    /** 設定したモデルを解決できるカタログを返す。 */
    resolveProviderCatalog: () => ({
      snapshot: { revision: 1, providers: [catalog] },
      provider: catalog,
    }),
    /** テストで接続先を差し替えた実 Copilot アダプターを返す。 */
    getProviderCodingAdapter: () => adapter,
    /** 新しいターンに連番を付け、保存した行を返す。 */
    createSessionTurn: (entry) => {
      const turn = { id: turns.length + 1, ...entry };
      turns.push(turn);
      return turn;
    },
    /** 指定ターンの現在の値を書き換え、最終状態を検証できるようにする。 */
    updateSessionTurn: (id, entry) => {
      const index = turns.findIndex((turn) => turn.id === id);
      turns[index] = { id, ...entry };
    },
    /** 実行中の表示状態を保持する。 */
    setLiveSessionRun: (_id, next) => {
      live = next;
    },
    /** 保持したライブ状態を実行と取り消しの検証に返す。 */
    getLiveSessionRun: () => live,
    /** 追加権限を承認しない条件で実行する。 */
    waitForApprovalDecision: () => "deny",
    /** 明示の回答がなければ入力要求を取り消す。 */
    waitForElicitationResponse: () =>
      options.elicitationResponse ?? { action: "cancel" },
    /** 使用量の通知は保存や停止の検証に含めない。 */
    setProviderQuotaTelemetry() {},
    /** コンテキストの計測値は記録しない。 */
    setSessionContextTelemetry() {},
    /** 停止処理のテスト中は使用量の定期更新を開始しない。 */
    scheduleProviderQuotaTelemetryRefresh() {},
    /** 実アダプターのスレッド無効化を通して終了対象を確認する。 */
    invalidateProviderSessionThread: (_provider, id) =>
      adapter.invalidateSessionThread(id),
    /** 実ウィンドウへは状態を配信せず、メモリ内の状態を検証する。 */
    broadcastLiveSessionRun() {},
    /** このフィクスチャでは未解決の承認ダイアログを持たない。 */
    resolvePendingApprovalRequest() {},
    /** このフィクスチャでは別の保留入力 UI を持たない。 */
    resolvePendingElicitationRequest() {},
  });
  return {
    adapter,
    ports,
    service,
    clients,
    turns,
    logs,
    /** 保存した履歴や実行状態を含むセッションを取得する。 */
    stored: () => stored,
    /** 実行の停止段階を観測できるライブ状態を取得する。 */
    live: () => live,
    /** ランタイム保存を介さず、アダプターに直接ターンを渡して応答の境界を試す。 */
    runAdapter: (userMessage: string) =>
      adapter.runSessionTurn({
        session: stored,
        userMessage,
        executionOptions: captureSessionExecutionOptions(stored),
        providerCatalog: catalog,
        appSettings: normalizeAppSettings({}),
        attachments: [],
      }),
    /** 現在のセッション設定を捕捉し、ランタイム経由で入力を送る。 */
    start: (message = "first") =>
      service.runSessionTurn(stored.id, {
        userMessage: message,
        executionOptions: captureSessionExecutionOptions(stored),
      }),
    /** 現在のセッションに対する取り消しをランタイムへ要求する。 */
    cancel: () => service.cancelRun(stored.id),
    /** 直近の SDK セッションが送信処理まで到達した後に返す。 */
    current: async () => {
      await until(() => Boolean(clients.at(-1)?.sessions.at(-1)?.sends.length));
      return clients.at(-1)!.sessions.at(-1)!;
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "Copilotの集中progressは全量を配送し、native完了後もconsumerの実完了を待ち実失敗はpartial付きfailedへ変換する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#streaming-policy; docs/adr/002-provider-turn-terminal-and-cancellation.md" }
// fault = "callback件数で正常burstを拒否するか、consumer未完了/失敗を成功にして所有接続cleanupを省く"
// observable = "全callback件数、gate前後のprovider完了、成功/partial本文、失敗時の旧client stopとchild exit"
// observation_boundary = "public-boundary"
// scope = "CopilotAdapter burst progress and owned SDK cleanup"
// lifecycle = "permanent"
// impact = "正常burstで必要本文を失うことと、実失敗後に旧接続と次Sendを競合させることを防ぐ"
// distinction = "delivery helper単体ではSDK emitter・native terminal・所有接続cleanupとの結線を通らない;小さい固定burstとgateで確認する"
// @end-test-value
/** 集中した進捗通知を全件届け、SDK 側が完了しても受信処理を待ち、受信失敗時は取得済み本文を伴う失敗として返す。 */
it(
  "Copilotのprogress burstは全量処理しconsumer完了と実失敗を区別する",
  { timeout: 5000 },
  async () => {
    for (const fail of [false, true]) {
      const f = fixture();
      const session = f.stored();
      const gate = deferred<void>();
      let delivered = 0;
      let settled = false;
      const run = f.adapter.runSessionTurn(
        {
          session,
          executionOptions: captureSessionExecutionOptions(session),
          providerCatalog: {
            id: "copilot",
            label: "Copilot",
            defaultModelId: "gpt-4.1",
            defaultReasoningEffort: "high",
            models: [
              { id: "gpt-4.1", label: "GPT", reasoningEfforts: ["high"] },
            ],
          },
          userMessage: "pressure",
          appSettings: normalizeAppSettings({}),
          attachments: [],
        },
        (state) => {
          if (state.assistantText) {
            delivered += 1;
            return gate.promise;
          }
        },
      );
      const outcome = run.then(
        (result) => {
          settled = true;
          return result;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      const owned = await f.current();
      try {
        for (let index = 0; index < 100; index++)
          owned.emit("assistant.message_delta", {
            messageId: "one",
            deltaContent: "x",
          });
        assert.equal(delivered, 100);
        owned.emit("session.idle");
        owned.sends[0].resolve("sent");
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(settled, false);
        if (fail) gate.reject(new Error("consumer failed"));
        else gate.resolve();
        const result = await outcome;
        if (fail) {
          assert.ok(result instanceof ProviderTurnError);
          assert.equal(result.canceled, false);
          assert.match(result.message, /consumer failed/);
          assert.equal(result.partialResult.assistantText, "x".repeat(100));
          assert.equal(f.clients[0].stopCalls, 1);
          assert.equal(f.clients[0].child.exitCode, 0);
        } else {
          assert.ok(
            result && typeof result === "object" && "assistantText" in result,
          );
          assert.equal(result.assistantText, "x".repeat(100));
          assert.equal(f.clients[0].stopCalls, 0);
        }
      } finally {
        gate.resolve();
      }
    }
  },
);

// @test-value v2
// kind = "contract"
// claim = "Copilotの回答ACK待ち中のCancelは取消として保存し、Cancelより先の回答失敗は後続Cancelでも失敗のまま保存する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md; docs/adr/002-provider-turn-terminal-and-cancellation.md" }
// fault = "取消cleanupの切断を回答失敗へ昇格するか、先行した回答失敗をCancelで隠す"
// observable = "共通runtimeが保存するturn phase・runState・エラーと、所有client停止・child exit・listener解放"
// observation_boundary = "consumer"
// scope = "Copilot user input / MCP elicitation ACKとCancelの交差から共通runtime終端保存まで"
// lifecycle = "permanent"
// impact = "利用者の取消を障害履歴にすることと、実際の回答障害を取消で消すことを防ぐ"
// distinction = "既存のACK拒否testと実行中取消testは両者の交差順序と保存phaseを確認せず、deferred ACKを使う6経路で直接確認する"
// @end-test-value
/** ネイティブ質問と MCP 入力の ACK 待ちで、先に取り消したときだけ取消として保存し、先行する回答故障は後の取消で上書きしない。 */
it(
  "Copilotの回答ACK待ちCancelと先行回答エラーを区別して保存する",
  { timeout: 5000 },
  async () => {
    for (const eventType of ["user_input.requested", "elicitation.requested"]) {
      for (const order of [
        "cancel-first",
        "failure-only",
        "failure-before-cancel",
      ]) {
        const f = fixture({
          elicitationResponse: {
            action: "accept",
            content: { answer: "Example" },
          },
        });
        const run = f.start();
        const session = await f.current();
        session.sends[0].resolve("sent");
        session.emit("assistant.message", {
          messageId: "before",
          content: "Question follows.",
        });
        session.emit(
          eventType,
          eventType === "user_input.requested"
            ? { requestId: "question", question: "Name?" }
            : {
                requestId: "question",
                mode: "form",
                message: "Name?",
                elicitationSource: "fixture",
                requestedSchema: {
                  type: "object",
                  properties: { answer: { type: "string" } },
                  required: ["answer"],
                },
              },
        );
        await session.inputAckStarted.promise;
        if (order === "cancel-first") f.cancel();
        else {
          session.inputAck.reject(new Error("input RPC unavailable"));
          if (order === "failure-before-cancel") {
            await session.abortStarted.promise;
            f.cancel();
          }
        }
        await run;
        const canceled = order === "cancel-first";
        assert.equal(f.turns[0].phase, canceled ? "canceled" : "failed");
        assert.equal(f.stored().runState, canceled ? "idle" : "error");
        if (canceled)
          assert.equal(f.stored().messages.at(-1)?.runFailure, undefined);
        else
          assert.match(f.turns[0].errorMessage ?? "", /input RPC unavailable/);
        assert.equal(f.clients[0].stopCalls, 1);
        assert.equal(f.clients[0].child.exitCode, 0);
        assert.equal(session.listeners.size, 0);
        assert.equal(f.service.isRunInFlight(f.stored().id), false);
      }
    }
  },
);

// @test-value v2
// kind = "contract"
// claim = "send/abort応答未完了の取消はSDK停止応答・旧child実exit・RPC終了を個別に待ち、guard解放後に同じ会話をresumeする"
// oracle = { type = "contract", ref = "docs/adr/002-provider-turn-terminal-and-cancellation.md; Issue #782 A/B" }
// fault = "send応答待ちに滞留するか、停止中の旧接続と次Sendを重ねる"
// observable = "SDK停止応答/旧child exit/RPC終了を順に解放した時の実runtime Send拒否、live取消状態、送信件数、保存phaseとresume ID"
// observation_boundary = "public-boundary"
// scope = "SessionRuntimeService through CopilotAdapter to SDK transport boundary"
// lifecycle = "permanent"
// impact = "取消後の再送不能と同一workspaceへの二重副作用を防ぐ"
// distinction = "provider stub単体ではsend/abort待ちとcache cleanup寿命が観測できず、deferred統合testでのみ検出できる"
// @end-test-value
/** 送信または取消に応答がない場合は強制停止へ進み、SDK 応答・実子プロセスの終了・RPC 終了が揃うまで次を拒否し、その後に同じスレッドを再開する。 */
it(
  "無応答send/abortを強制停止で収束し、停止完了まで次Sendを拒否する",
  { timeout: 5000 },
  async () => {
    for (const pendingSend of [true, false]) {
      const f = fixture({ runtimeGraceMs: 0 });
      const first = f.start();
      const old = await f.current();
      const owner = f.clients[0];
      if (!pendingSend) old.sends[0].resolve("first");
      owner.stopMode = "pending";
      owner.forceMode = "pending";
      owner.child.autoExit = false;
      owner.deferRpcClosure = true;
      f.cancel();
      f.cancel();
      if (!pendingSend)
        old.emit("session.error", { message: "Connection is closed." });
      await owner.forceStarted.promise;
      await first;
      assert.equal(old.abortCalls, 1);
      assert.equal(f.service.isRunInFlight(f.stored().id), true);
      assert.equal(f.live()?.cancellationState, "terminating");
      await assert.rejects(f.start("blocked"), /already running/);
      owner.forceReply.resolve();
      await until(() => owner.cliProcess === null);
      await assert.rejects(
        f.start("SDK replied but child alive"),
        /already running/,
      );
      owner.child.exit();
      await assert.rejects(
        f.start("child exited but RPC pending"),
        /already running/,
      );
      owner.deferRpcClosure = false;
      owner.closeTransport();
      await until(() => !f.service.isRunInFlight(f.stored().id));
      assert.equal(old.listeners.size, 0);
      assert.equal(f.turns[0].phase, "canceled");
      const next = f.start("next");
      await until(() => f.clients.length === 2);
      const fresh = await f.current();
      assert.notEqual(fresh, old);
      assert.deepEqual(f.clients[1].resumeIds, [old.sessionId]);
      old.emit(
        "assistant.message",
        { content: "old late response", messageId: "old" },
        true,
      );
      old.emit("session.idle", {}, true);
      old.sends[0].resolve("late send");
      old.abortReply.resolve();
      assert.equal(f.service.isRunInFlight(f.stored().id), true);
      fresh.sends[0].resolve("next");
      fresh.emit("assistant.message", {
        content: "next answer",
        messageId: "new",
      });
      fresh.emit("session.idle");
      await next;
      assert.match(f.stored().messages.at(-1)!.text, /next answer/);
      assert.doesNotMatch(
        JSON.stringify(f.stored().messages),
        /old late response/,
      );
      assert.equal(owner.stopCalls, 1);
      assert.equal(owner.forceCalls, 1);
    }
  },
);

// @test-value v2
// kind = "contract"
// claim = "取消中のidle単独またはabort応答単独では次Sendを許可せず、両方とsend応答および所有接続停止後に解放する"
// oracle = { type = "contract", ref = "Issue #782 B; docs/design/session-run-lifecycle.md#Session-Run-Cancel" }
// fault = "idle先行やabort先行で未完了RPCを次turnへ持ち越す"
// observable = "runtime Send拒否、abort/stop件数、guard解除、SDK listener数"
// observation_boundary = "public-boundary"
// scope = "Copilot graceful cancellation order through Main runtime"
// lifecycle = "permanent"
// impact = "遅い旧abortによる次turn停止を防ぐ"
// distinction = "強制停止caseでは確認できない正常な応答順序の両向きをdeferredで固定する"
// @end-test-value
/** idle と取消応答がどちらから届いても、それだけでは解放せず、送信応答と所有接続の停止まで次の送信を拒否する。 */
it(
  "idleとabortの順序が逆でも全RPCと接続停止までguardを保持する",
  { timeout: 5000 },
  async () => {
    for (const idleFirst of [true, false]) {
      const f = fixture({ cancelGraceMs: 1000 });
      const run = f.start();
      const session = await f.current();
      f.cancel();
      await session.abortStarted.promise;
      if (idleFirst) session.emit("session.idle");
      else session.abortReply.resolve();
      await assert.rejects(f.start("blocked"), /already running/);
      if (idleFirst) session.abortReply.resolve();
      else session.emit("session.idle");
      await assert.rejects(f.start("still blocked"), /already running/);
      session.sends[0].resolve("first");
      await run;
      assert.equal(f.service.isRunInFlight(f.stored().id), false);
      assert.equal(f.clients[0].forceCalls, 0);
      assert.equal(f.clients[0].stopCalls, 1);
      assert.equal(session.listeners.size, 0);
    }
  },
);

// @test-value v2
// kind = "contract"
// claim = "取消の停止失敗は診断ログを維持し、取得済みpartial本文と操作を通常履歴へ保存する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#Error-Handling; Issue #782" }
// fault = "停止errorをcatchで消すか取得済みpartialを取消通知だけへ置換する"
// observable = "保存messagesとartifact、canceled最小turn、adapter log"
// observation_boundary = "public-boundary"
// scope = "Copilot cancellation partial result and runtime terminal persistence"
// lifecycle = "permanent"
// impact = "途中成果を保護し停止失敗の診断を可能にする"
// distinction = "汎用runtime partial testはCopilot event変換と停止失敗のcatchを通らない"
// @end-test-value
/** 切断のタイムアウトや停止の失敗を診断に残しながら、取消として取得済み本文と操作を通常履歴に保存する。 */
it(
  "停止失敗の診断とpartial結果を取消後に保持する",
  { timeout: 5000 },
  async () => {
    const f = fixture();
    const run = f.start();
    const session = await f.current();
    session.sends[0].resolve("first");
    session.emit("assistant.message", {
      content: "partial answer",
      messageId: "partial",
    });
    session.emit("tool.execution_start", {
      toolCallId: "tool",
      toolName: "bash",
      arguments: { command: "echo partial" },
    });
    session.emit("tool.execution_complete", {
      toolCallId: "tool",
      success: true,
      result: { content: "partial" },
    });
    session.delayDisconnect = true;
    f.clients[0].stopMode = "reject";
    f.cancel();
    await session.abortStarted.promise;
    session.abortReply.reject(new Error("abort unavailable"));
    await run;
    assert.match(f.stored().messages.at(-1)!.text, /partial answer/);
    assert.equal(f.turns[0].phase, "canceled");
    assert.ok(
      f
        .stored()
        .messages.at(-1)
        ?.artifact?.operationTimeline?.some((operation) =>
          operation.summary.includes("echo partial"),
        ),
    );
    assert.match(f.logs.join("\n"), /session disconnect timed out/);
    assert.match(f.logs.join("\n"), /stop unavailable/);
    assert.equal(f.clients[0].forceCalls, 1);
  },
);

// @test-value v2
// kind = "contract"
// claim = "旧取消cleanupは捕捉ownerだけを停止し同一keyの新接続と無関係接続を停止しない"
// oracle = { type = "contract", ref = "Issue #782 cache ownership boundary; docs/design/session-run-lifecycle.md" }
// fault = "遅いcleanupがcacheを再取得して新clientまたは別Sessionを停止する"
// observable = "旧owner/新owner/無関係clientのstop件数とcache identity"
// observation_boundary = "component-behavior"
// scope = "Copilot captured cancellation owner across cache replacement"
// lifecycle = "permanent"
// impact = "別会話と再接続の実行を取消の巻き添えから保護する"
// distinction = "既存invalidation testと異なり実turnのCancelから遅延cleanupへ進める"
// @end-test-value
/** 取消後の旧接続の後処理が遅れても、同じキーの後継接続と無関係な接続を停止せずキャッシュに残す。 */
it(
  "取消の遅いcleanupは同一keyの新clientと無関係clientに触れない",
  { timeout: 5000 },
  async () => {
    const f = fixture();
    const run = f.start();
    const session = await f.current();
    const old = f.clients[0];
    old.stopMode = "pending";
    old.forceMode = "pending";
    f.cancel();
    await old.forceStarted.promise;
    const fresh = new FakeClient();
    const unrelated = new FakeClient();
    f.ports.clients.set("owned-client", fresh as unknown as CopilotClient);
    f.ports.clients.set("unrelated", unrelated as unknown as CopilotClient);
    old.forceReply.resolve();
    await run;
    assert.equal(f.ports.clients.get("owned-client"), fresh);
    assert.equal(f.ports.clients.get("unrelated"), unrelated);
    assert.equal(fresh.stopCalls + fresh.forceCalls, 0);
    assert.equal(unrelated.stopCalls + unrelated.forceCalls, 0);
    assert.equal(session.listeners.size, 0);
  },
);

// @test-value v2
// kind = "contract"
// claim = "実SDKのforceStopがchild終了を待つ場合とstop後にhandleを失う場合の両方で旧child実exitまでguardを保持する"
// oracle = { type = "contract", ref = "docs/adr/002-provider-turn-terminal-and-cancellation.md; Issue #782" }
// fault = "SDKの接続切断を停止証明にするかstopで失ったchild handleを追跡せず再送する"
// observable = "kill false後のruntime in-flightとSend拒否、handle欠落時のkill失敗log、実exit後のguard解除"
// observation_boundary = "public-boundary"
// scope = "Real Copilot SDK forceStop without process startup through runtime terminating guard"
// lifecycle = "permanent"
// impact = "停止不能な旧処理と新処理の二重実行を防ぐ"
// distinction = "mockのみの停止成功testでは実SDKのexit待機とstop後のhandle欠落の両経路を検証できない"
// @end-test-value
/** 実 SDK の強制停止が終了待ちになった場合も、通常停止で子のハンドルを失った場合も、子の実終了まで次の送信を拒否する。 */
it(
  "実SDKの停止待機とchild handle欠落でも実exitまでguardを維持する",
  { timeout: 5000 },
  async () => {
    for (const stopMode of ["reject", "failed-kill"] as const) {
      const f = fixture({ runtimeGraceMs: 0, realForceStop: true });
      const run = f.start();
      const session = await f.current();
      const owner = f.clients[0];
      owner.stopMode = stopMode;
      owner.child.killAccepted = false;
      f.cancel();
      await run;
      await owner.forceStarted.promise;
      if (stopMode === "failed-kill") {
        await until(() =>
          f.logs.some((message) =>
            message.includes("kill request was not accepted"),
          ),
        );
        assert.equal(
          owner.child.killCalls,
          2,
          "adapter still signals the captured old child after the SDK loses its handle",
        );
      } else {
        await until(() => owner.child.killCalls === 1);
      }
      assert.equal(owner.forceCalls, 1);
      assert.equal(f.service.isRunInFlight(f.stored().id), true);
      await assert.rejects(f.start("blocked"), /already running/);
      assert.equal(
        session.listeners.size,
        0,
        "recovery does not require idle from a disconnected session",
      );
      owner.child.exit();
      await until(() => !f.service.isRunInFlight(f.stored().id));
    }
  },
);

// @test-value v2
// kind = "contract"
// claim = "取消していない長時間turnは応答を期限で打ち切らず正常完了後に同じSDK Sessionを再利用する"
// oracle = { type = "contract", ref = "docs/adr/002-provider-turn-terminal-and-cancellation.md; docs/design/provider-adapter.md#Thread-Management" }
// fault = "取消用deadlineを正常turnへ適用するか正常完了で接続を破棄する"
// observable = "SDK send/stop件数、runtime in-flight、再送時Session identityと保存本文"
// observation_boundary = "public-boundary"
// scope = "Copilot normal completion and connection reuse through runtime"
// lifecycle = "permanent"
// impact = "正常な長時間応答と会話継続を保護する"
// distinction = "helperのcache key検査では実turnに対するtimerの誤適用を検出できない"
// @end-test-value
/** 取り消していないターンを取消期限で停止せず、正常完了後の次の応答は同じ SDK セッションを使う。 */
it(
  "正常turnには取消期限を適用せず、完了後はSessionを再利用する",
  { timeout: 5000 },
  async () => {
    const f = fixture();
    const first = f.start();
    const session = await f.current();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(f.service.isRunInFlight(f.stored().id), true);
    assert.equal(f.clients[0].stopCalls, 0);
    session.emit("assistant.message", {
      content: "first answer",
      messageId: "first",
    });
    session.emit("session.idle");
    session.sends[0].resolve("first");
    await first;
    const next = f.start("next");
    await until(() => session.sends.length === 2);
    assert.equal(f.clients.length, 1);
    assert.equal(f.clients[0].sessions.length, 1);
    session.emit("assistant.message", {
      content: "second answer",
      messageId: "second",
    });
    session.sends[1].resolve("next");
    session.emit("session.idle");
    await next;
    assert.match(f.stored().messages.at(-1)!.text, /second answer/);
    assert.equal(f.clients[0].stopCalls, 0);
  },
);

// @test-value v2
// kind = "contract"
// claim = "Copilotのsend呼出後は、応答ACKや実行結果がない接続失敗でも同じ指示を自動再送しない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#error-handling" }
// fault = "ACK・本文・tool結果の欠落を未実行とみなして、既に送出した同一入力の効果を重複させる"
// observable = "合成SDKへ渡したprompt列、send側の合成効果回数、ProviderTurnErrorの分類とpartial本文"
// observation_boundary = "public-boundary"
// scope = "CopilotAdapterからSDK sendまで。ACK拒否とACK後session.errorの両方"
// lifecycle = "permanent"
// distinction = "取得済み結果を保存する既存testでは、実行証拠が返らないまま起きた副作用の二重発行を検出しない"
// @end-test-value
/** 送信呼び出し後に接続を失った場合、ACK の有無にかかわらず再送せず、指示と模擬副作用は一度だけ発生する。 */
it(
  "Copilotはsend呼出後の結果不明を自動再送しない",
  { timeout: 5000 },
  async () => {
    for (const failure of [
      "Connection is closed.",
      "SessionNotFound: session not found",
    ]) {
      for (const acknowledge of [false, true]) {
        const prompts: string[] = [];
        const effects: string[] = [];
        const f = fixture({
          /** 送信と模擬副作用を記録し、初回接続の結果を任意の境界で失敗させる。 */
          configureClient: (client, index) => {
            client.onSend = (prompt) => {
              prompts.push(prompt);
              effects.push("external action accepted");
              // 想定外の二度目の送出を完了させ、
              // 再試行の完了を待ち続けるのではなく、アサーションで重複を報告できるようにする。
              if (index > 0) {
                const retried = client.sessions.at(-1)!;
                retried.sends[0].resolve("retried");
                retried.emit("session.idle");
              }
            };
          },
        });
        const run = f.runAdapter("perform one external action");
        const failureCheck = assert.rejects(run, (error: unknown) => {
          assert.ok(error instanceof ProviderTurnError);
          assert.equal(error.message, failure);
          assert.equal(error.canceled, false);
          assert.equal(error.partialResult.assistantText, "");
          return true;
        });
        const session = await f.current();
        if (acknowledge) {
          session.sends[0].resolve("accepted");
          session.emit("session.error", { message: failure });
        } else {
          session.sends[0].reject(new Error(failure));
        }
        const error = await failureCheck.catch((reason: unknown) => reason);
        assert.deepEqual(
          prompts,
          ["perform one external action"],
          "same input must be sent only once",
        );
        assert.deepEqual(effects, ["external action accepted"]);
        if (error) throw error;
      }
    }
  },
);

// @test-value v2
// kind = "contract"
// claim = "Copilotはsend未呼出の接続準備に失敗した場合だけ一度回復を試し、接続できた場合に元の指示を一度送る"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#error-handling" }
// fault = "未送出の接続回復まで失う、または二度目の準備失敗後も無制限にやり直す"
// observable = "接続したSDK client数・resume先・SDKへのprompt列・回復後の本文または二回目の準備失敗"
// observation_boundary = "public-boundary"
// scope = "CopilotAdapterのSession準備とcached Sessionのイベント登録の失敗からsendまで"
// lifecycle = "permanent"
// distinction = "接続エラー文字列の分類testでは、キャッシュ接続の入替とSDKへの送信が一回に限定されることを検出しない"
// @end-test-value
/** 送信前の起動・イベント登録に限って一度再接続し、準備できた場合だけ入力を一度届ける。 */
it(
  "Copilotはsend未呼出の接続準備を一度だけ回復する",
  { timeout: 5000 },
  async () => {
    for (const stage of ["bootstrap", "event registration"] as const) {
      for (const recover of [true, false]) {
        const prompts: string[] = [];
        const f = fixture({
          /** 指定段階で接続準備を失敗させ、次の接続が回復できるかを切り替える。 */
          configureClient: (client, index) => {
            if (stage === "bootstrap" && (index === 0 || !recover)) {
              client.createSession = async () => {
                throw new Error("Connection is closed.");
              };
            }
            if (stage === "event registration" && index > 0 && !recover) {
              client.resumeSession = async () => {
                throw new Error("Connection is closed.");
              };
            }
            client.onSend = (prompt) => {
              prompts.push(prompt);
              const session = client.sessions.at(-1)!;
              session.emit("assistant.message", {
                content: "prepared answer",
                messageId: "answer",
              });
              session.sends.at(-1)!.resolve("sent");
              session.emit("session.idle");
            };
          },
        });
        if (stage === "event registration") {
          // ランタイムの fixture を通じ、実アダプターのキャッシュと永続化されたスレッドを用意する。
          await f.start("prime");
          prompts.length = 0;
          const cached = await f.current();
          cached.rpc.eventLog.registerInterest = async () => {
            throw new Error("Connection is closed.");
          };
        }
        const run = f.runAdapter("send after connection setup");
        if (recover) {
          assert.equal((await run).assistantText, "prepared answer");
          assert.deepEqual(prompts, ["send after connection setup"]);
          if (stage === "event registration")
            assert.deepEqual(f.clients[1].resumeIds, ["preserved-thread"]);
        } else {
          await assert.rejects(run, /Connection is closed\./);
          assert.deepEqual(prompts, []);
        }
        assert.equal(f.clients.length, 2);
      }
    }
  },
);

// @test-value v2
// kind = "contract"
// claim = "cached Copilotは取得済み本文・表示/非表示toolのterminal結果・非空partialを持つstale失敗を自動再送せず通常artifactへ保存する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#Error Handling" }
// fault = "terminalまたは途中結果を持つ操作を未確定と扱って重複実行する、またはretry抑止時のpartialを捨てる"
// observable = "prime後のruntime経由SDK send/client件数、live step ID、保存assistant本文・artifact操作ID/type/status/details/error/exitCode"
// observation_boundary = "public-boundary"
// scope = "Copilot production eventからpartial artifact・retry admission・通常履歴保存まで"
// lifecycle = "permanent"
// impact = "実行済み副作用の重複と失敗前に取得した応答の消失を防ぐ"
// distinction = "helperへpartialを手渡すtestと取消testではstale失敗によるproduction retryを観測しない。既存fixtureの有限event列だけで検証する"
// @end-test-value
/** 本文やツールの成功・失敗・途中結果を受け取った後の接続故障は自動再送せず、得られた内容と操作を失敗したターンの履歴に保存する。 */
it(
  "取得済み結果付きstale turnは再送せずpartialを保存する",
  { timeout: 5000 },
  async () => {
    for (const toolName of [
      "shell",
      "withmate-memory.append_episode",
      "custom_fixture",
    ]) {
      for (const mode of [
        "assistant",
        "completed",
        "completed-empty",
        "failed",
        "partial",
      ] as const) {
        const f = fixture();
        const prime = f.start();
        const session = await f.current();
        session.emit("assistant.message", {
          content: "prime answer",
          messageId: "prime",
        });
        session.emit("session.idle");
        session.sends[0].resolve("prime");
        await prime;
        const run = f.start("input after prime");
        await until(() => session.sends.length === 2);
        if (mode === "assistant") {
          session.emit("assistant.message", {
            content: "acquired answer",
            messageId: "acquired",
          });
        } else {
          session.emit("tool.execution_start", {
            toolCallId: "acquired",
            toolName,
            arguments: { command: "synthetic side effect" },
          });
          if (mode === "partial") {
            session.emit("tool.execution_partial_result", {
              toolCallId: "acquired",
              partialOutput: "acquired output",
            });
          } else {
            session.emit("tool.execution_complete", {
              toolCallId: "acquired",
              success: mode !== "failed",
              ...(mode === "completed-empty"
                ? {}
                : {
                    result: {
                      contents: [
                        {
                          type: "terminal",
                          text: "acquired output",
                          exitCode: mode === "failed" ? 1 : 0,
                        },
                      ],
                    },
                  }),
              ...(mode === "failed"
                ? {
                    error: {
                      message: "acquired error",
                      code: "synthetic-error",
                    },
                  }
                : {}),
            });
          }
        }
        await until(() =>
          mode === "assistant"
            ? Boolean(f.live()?.assistantText.includes("acquired answer"))
            : toolName === "shell"
              ? Boolean(f.live()?.steps.some((step) => step.id === "acquired"))
              : true,
        );
        if (mode !== "assistant" && toolName !== "shell") {
          assert.equal(
            f.live()?.steps.some((step) => step.id === "acquired"),
            false,
          );
        }
        session.sends[1].reject(new Error("Connection is closed."));
        await run;
        assert.equal(
          f.clients.length,
          1,
          "acquired results prohibit retry and client replacement",
        );
        assert.equal(
          session.sends.length,
          2,
          "only the prime and cached turn are sent",
        );
        assert.equal(f.clients[0].stopCalls, 0);
        assert.equal(f.turns.at(-1)?.phase, "failed");
        if (mode === "assistant") {
          assert.match(f.stored().messages.at(-1)!.text, /acquired answer/);
        } else {
          const operation = f.stored().messages.at(-1)!.artifact!
            .operationTimeline![0];
          assert.equal(operation.id, "acquired");
          assert.equal(
            operation.type,
            toolName === "shell" ? "command_execution" : "tool_call",
          );
          assert.equal(
            operation.status,
            mode === "partial"
              ? "in_progress"
              : mode === "completed-empty"
                ? "completed"
                : mode,
          );
          if (mode === "completed-empty")
            assert.equal(operation.details, undefined);
          else assert.match(operation.details!, /acquired output/);
          if (mode === "completed" || mode === "failed")
            assert.equal(operation.exitCode, mode === "failed" ? 1 : 0);
          if (mode === "failed")
            assert.deepEqual(operation.error, {
              message: "acquired error",
              code: "synthetic-error",
            });
        }
      }
    }
  },
);
