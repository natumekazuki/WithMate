import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import type {
  CopilotClient,
  CopilotSession,
  PermissionRequest,
  SessionEvent,
} from "@github/copilot-sdk";

import { buildNewSession } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type {
  LiveRunStep,
  LiveApprovalRequest,
  LiveSessionRunState,
  LiveElicitationRequest,
  LiveElicitationResponse,
} from "../../src-shared/session/runtime-state.js";
import type { LiveBackgroundTask } from "../../src-shared/session/runtime-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import type {
  ModelCatalogProvider,
  ResolvedModelSelection,
} from "../../src-shared/settings/model-catalog.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import {
  applyCopilotBackgroundTaskEvent,
  CopilotAdapter,
  buildCopilotSessionSettings,
  buildCopilotMessageAttachments,
  buildCopilotProviderMetadata,
  collectCopilotMessageOperationsFromEventsForTesting,
  collectCopilotLiveStepsFromEventsForTesting,
  collectCopilotReasoningTextFromEventsForTesting,
  getCopilotPermissionCompletedLiveStatus,
  buildCopilotToolSummary,
  buildCopilotClientEnv,
  isCopilotVisibleToolName,
  isRecoverableCopilotConnectionErrorMessage,
  resolveCopilotCliPath,
  resolveCopilotSessionForSettings,
  resolveNativeCopilotPackageName,
  sortLiveBackgroundTasks,
  toCopilotReasoningEffort,
} from "../../src-electron/providers/copilot/copilot-adapter.js";
import {
  buildLiveElicitationRequestFromCopilotEvent,
  buildLiveElicitationRequestFromCopilotUserInput,
} from "../../src-electron/providers/copilot/copilot-elicitation.js";
import { buildLiveElicitationFieldFromMcpSchema } from "../../src-electron/providers/mcp-elicitation.js";
import {
  buildCopilotProviderQuotaTelemetry,
  buildCopilotSessionContextTelemetry,
  toProviderQuotaSnapshots,
} from "../../src-electron/providers/copilot/copilot-quota-telemetry.js";
import { toProviderMetadataLogData } from "../../src-electron/providers/provider-metadata-log.js";
import {
  PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER,
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV,
  WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV,
  WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV,
} from "../../src-electron/providers/provider-agent-runtime-binding.js";
import { SessionApprovalService } from "../../src-electron/session/session-approval-service.js";
import {
  ProviderTurnError,
  type ProviderPromptComposition,
  type RunSessionTurnInput,
  type RunSessionTurnResult,
} from "../../src-electron/providers/provider-runtime.js";

const TEST_STRUCTURED_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    memories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          statement: { type: "string" },
        },
        required: ["statement"],
      },
    },
  },
  required: ["memories"],
} as const;

/** 個別結果だけ差し替えられるよう、部分失敗の検証用に空の Turn 結果を作る。 */
function createPartialResult(
  overrides?: Partial<RunSessionTurnResult>,
): RunSessionTurnResult {
  return {
    threadId: "",
    assistantText: "",
    usage: null,
    ...overrides,
  };
}

// @test-value v2
// kind = "contract"
// claim = "Copilotはterminal resultの個別成否・exitCode・構造化errorと未完了操作を配列順に通常履歴へ投影する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "未完了操作を除外または成功に補完し取得済み結果情報を落とす"
// observable = "collectCopilotMessageOperationsFromEventsForTestingが実event処理から返す操作配列"
// observation_boundary = "component-behavior"
// scope = "Copilot native event operation projection"
// lifecycle = "permanent"
// impact = "失敗・取消後のコマンド結果を誤表示または消失する"
// distinction = "SDK型検査ではliveからartifactに渡す結果情報の保持を確認できない"
// @end-test-value
/** 終了コードと構造化エラーを失敗した操作へ保持し、完了イベントのない操作も in_progress のまま順序を変えず履歴へ残す。 */
it("Copilotの個別結果と未完了操作を通常履歴へ保持する", () => {
  const events = [
    {
      type: "tool.execution_start",
      data: {
        toolCallId: "done",
        toolName: "shell",
        arguments: { command: "check" },
      },
    },
    {
      type: "tool.execution_complete",
      data: {
        toolCallId: "done",
        success: false,
        result: {
          contents: [{ type: "terminal", text: "output", exitCode: 7 }],
        },
        error: { message: "failure", code: "E_TOOL" },
      },
    },
    {
      type: "tool.execution_start",
      data: {
        toolCallId: "partial",
        toolName: "shell",
        arguments: { command: "pending" },
      },
    },
  ] as SessionEvent[];
  const operations =
    collectCopilotMessageOperationsFromEventsForTesting(events);
  assert.deepEqual(
    operations.map(({ id, status }) => ({ id, status })),
    [
      { id: "done", status: "failed" },
      { id: "partial", status: "in_progress" },
    ],
  );
  assert.equal(operations[0].exitCode, 7);
  assert.deepEqual(operations[0].error, { message: "failure", code: "E_TOOL" });
  assert.equal(operations[1].exitCode, undefined);
  assert.equal(operations[1].details, undefined);
});

const COPILOT_PROVIDER_CATALOG: ModelCatalogProvider = {
  id: "copilot",
  label: "GitHub Copilot",
  defaultModelId: "gpt-4.1",
  defaultReasoningEffort: "high",
  models: [
    {
      id: "gpt-4.1",
      label: "GPT-4.1",
      reasoningEfforts: ["low", "medium", "high"],
    },
    {
      id: "gpt-4.1-mini",
      label: "GPT-4.1 mini",
      reasoningEfforts: ["low", "medium"],
    },
  ],
};

const EMPTY_PROMPT: ProviderPromptComposition = {
  systemBodyText: "",
  inputBodyText: "hello",
  logicalPrompt: {
    systemText: "",
    inputText: "",
    composedText: "",
  },
  imagePaths: [],
  additionalDirectories: [],
};

const CUSTOM_AGENT_CONFIGS = [
  {
    name: "reviewer",
    displayName: "Reviewer",
    description: "review agent",
    prompt: "Review carefully.",
    tools: null,
  },
  {
    name: "planner",
    displayName: "Planner",
    description: "planning agent",
    prompt: "Plan carefully.",
    tools: null,
  },
] as const;

/** ターン中の SDK イベント購読を外部 RPC なしで成立させる。 */
function createInteractionRpc() {
  return {
    eventLog: {
      /** イベント名を購読解除に使えるハンドルとして返す。 */
      registerInterest: async ({ eventType }: { eventType: string }) => ({
        handle: eventType,
      }),
      /** 実 SDK を呼ばず購読解除を完了する。 */
      releaseInterest: async () => ({}),
    },
  };
}

/** 質問または elicitation を一回配信し、元の要求への回答、ACK、取消と購読解除を観測できる Turn を組み立てる。 */
function interactionTurn(
  event: SessionEvent,
  response?: LiveElicitationResponse,
  acknowledge = async () => ({ success: true }),
  signal?: AbortSignal,
) {
  const input = createRunSessionInput({ customAgentName: "" });
  input.signal = signal;
  const calls = { send: 0, abort: 0 };
  const requests: LiveElicitationRequest[] = [];
  const delivered: string[] = [];
  input.onElicitationDelivered = (requestId) => {
    delivered.push(requestId);
  };
  const replies: { method: string; payload: unknown }[] = [];
  const interests: string[] = [];
  const released: string[] = [];
  const logs: string[] = [];
  const listeners = new Set<(event: SessionEvent) => void>();
  /** テスト用イベントを現在購読している listener 全員へ配信する。 */
  const emit = (type: string, data: Record<string, unknown>) => {
    for (const listener of listeners) listener({ type, data } as SessionEvent);
  };
  /** 回答を記録し、ツール完了と idle を通知してから、別制御できる native ACK を返す。 */
  const reply = async (method: string, payload: unknown) => {
    replies.push({ method, payload });
    emit("tool.execution_complete", { toolCallId: "ask", success: true });
    emit("session.idle", {});
    return acknowledge();
  };
  const session = {
    sessionId: "interaction-thread",
    rpc: {
      eventLog: {
        /** 購読要求を順に記録し、イベント名を解除用ハンドルにする。 */
        async registerInterest({ eventType }: { eventType: string }) {
          interests.push(eventType);
          return { handle: eventType };
        },
        /** 解除したイベントのハンドルを観測可能にする。 */
        async releaseInterest({ handle }: { handle: string }) {
          released.push(handle);
          return {};
        },
      },
      ui: {
        /** 通常質問への回答が userInput RPC へ届いたことを記録する。 */
        handlePendingUserInput: (payload: unknown) =>
          reply("userInput", payload),
        /** MCP のフォーム回答が elicitation RPC へ届いたことを記録する。 */
        handlePendingElicitation: (payload: unknown) =>
          reply("elicitation", payload),
      },
    },
    /** テスト用イベントの listener を登録し、解除用の関数を返す。 */
    on(listener: (event: SessionEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 質問とフォームを購読済みであることを確認し、先行する本文と指定イベントを順に送る。 */
    async send() {
      calls.send += 1;
      assert.deepEqual(interests, [
        "user_input.requested",
        "elicitation.requested",
      ]);
      emit("assistant.message", { messageId: "before", content: "Before" });
      for (const listener of listeners) listener(event);
      return "sent";
    },
    /** 取消呼出を記録し、native Session が idle になったと通知する。 */
    async abort() {
      calls.abort += 1;
      emit("session.idle", {});
    },
    /** 外部接続を持たないため切断時は何もしない。 */
    async disconnect() {},
  };
  if (response)
    input.onElicitationRequest = (request) => {
      requests.push(request);
      return response;
    };
  const adapter = new CopilotAdapter({
    turnCancelGraceMs: 0,
    /** SDK 応答やスキーマの診断をメッセージ単位で記録する。 */
    log: (entry) => {
      logs.push(entry.message);
    },
  });
  const ports = adapter as unknown as {
    /** Turn が取得する native Session と client をテスト用に差し替える。 */
    getSession(): Promise<unknown>;
    /** 再試行を経由せず一回の実 adapter 処理を実行する。 */
    runSessionTurnOnce(
      input: RunSessionTurnInput,
      prompt: ProviderPromptComposition,
    ): Promise<RunSessionTurnResult>;
  };
  ports.getSession = async () => ({
    session,
    selection: {
      requestedModel: "gpt-4.1",
      resolvedModel: "gpt-4.1",
      requestedReasoningEffort: "high",
      resolvedReasoningEffort: "high",
    },
    client: {
      /** テスト用 client の正常停止をエラーなしで完了する。 */
      stop: async () => [],
      /** 通信のない client には強制停止時の副作用もない。 */
      forceStop: async () => {},
    },
    clientKey: "interaction-client",
  });
  return {
    /** 用意した入力と固定プロンプトで実際の Turn を開始する。 */
    run: () => ports.runSessionTurnOnce(input, EMPTY_PROMPT),
    requests,
    replies,
    interests,
    released,
    logs,
    calls,
    listeners,
    delivered,
  };
}

// @test-value v2
// kind = "contract"
// claim = "Copilot質問は候補と自由回答の許可を保ち、候補なしはtext入力として表示できる"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/915" }
// fault = "allowFreeform省略をfalseへ変える、候補を失う、または通常質問をMCP formとして返す"
// observable = "SDK eventから変換したkind・request ID・質問文・fieldと選択肢"
// observation_boundary = "component-behavior"
// scope = "Copilot user_input.requested projection"
// lifecycle = "permanent"
// impact = "利用者が回答を入力できないか、許可されていない自由回答を送る"
// distinction = "SDK型検査ではWithMateの質問fieldへの意味の写像を保証できず、小さい入力表で継続確認する"
// @end-test-value
/** 質問の候補を選択欄に写し、自由記入は明示禁止時だけ無効化し、候補がない場合はテキスト欄になることを確認する。 */
it("Copilotの質問は選択肢と自由回答の制約を共通fieldへ保持する", () => {
  for (const allowFreeform of [undefined, true, false]) {
    const request = buildLiveElicitationRequestFromCopilotUserInput("copilot", {
      type: "user_input.requested",
      data: {
        requestId: "question-1",
        question: "Which color?",
        choices: ["Red", "Blue"],
        allowFreeform,
      },
    } as SessionEvent & { type: "user_input.requested" });
    assert.deepEqual(request, {
      requestId: "question-1",
      provider: "copilot",
      kind: "question",
      mode: "form",
      message: "Which color?",
      fields: [
        {
          type: "select",
          name: "answer",
          title: "Which color?",
          required: true,
          options: [
            { value: "Red", label: "Red" },
            { value: "Blue", label: "Blue" },
          ],
          allowFreeText: allowFreeform !== false,
        },
      ],
    });
  }
  for (const choices of [undefined, []]) {
    assert.deepEqual(
      buildLiveElicitationRequestFromCopilotUserInput("copilot", {
        type: "user_input.requested",
        data: {
          requestId: "text-1",
          question: "Your name?",
          choices,
        },
      } as SessionEvent & { type: "user_input.requested" }).fields,
      [{ type: "text", name: "answer", title: "Your name?", required: true }],
    );
  }
});

// @test-value v2
// kind = "contract"
// claim = "Copilot質問を同一request IDでUIへ渡し、選択・自由回答の受付だけを履歴へ通知し、Close・UI不在でもturnを完了する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "interestを登録しない、別requestへ返信する、wasFreeformを誤る、またはCloseでturnを中断する"
// observable = "UI callbackのrequestと本文位置、SDK回答payload、受付通知、interest解放と正常turn result"
// observation_boundary = "public-boundary"
// scope = "Copilot turn interaction bridge"
// lifecycle = "permanent"
// impact = "質問が配信されないかtoolが待機し続け、利用者の回答を誤って送る"
// distinction = "projection単体ではevent購読・回答RPC・turn終了を確認できず、外部通信なしで4経路を検証する"
// @end-test-value
/** 質問の選択・自由回答・Close・UI 不在を元の native request に返し、受理された回答だけを通知して購読を解放する。 */
it("Copilot質問の回答とCloseを元のnative requestへ返す", async () => {
  for (const response of [
    { action: "accept", content: { answer: "Blue" } },
    { action: "accept", content: { answer: "Green" } },
    { action: "cancel" },
    undefined,
  ] as const) {
    const fixture = interactionTurn(
      {
        type: "user_input.requested",
        data: {
          requestId: "ask-1",
          question: "Which color?",
          choices: ["Red", "Blue"],
        },
      } as SessionEvent,
      response,
    );
    const result = await fixture.run();
    assert.equal(result.assistantText, "Before");
    assert.deepEqual(fixture.replies, [
      {
        method: "userInput",
        payload: {
          requestId: "ask-1",
          response: {
            answer:
              response?.action === "accept" ? response.content.answer : "",
            wasFreeform:
              response?.action !== "accept" ||
              response.content.answer !== "Blue",
          },
        },
      },
    ]);
    assert.deepEqual(fixture.released, fixture.interests);
    assert.deepEqual(
      fixture.delivered,
      response?.action === "accept" ? ["ask-1"] : [],
    );
    assert.equal(fixture.requests.length, response ? 1 : 0);
    if (response) {
      assert.equal(fixture.requests[0].kind, "question");
      assert.equal(fixture.requests[0].requestId, "ask-1");
      assert.equal(fixture.requests[0].textPosition, "Before".length);
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "Copilot MCP formは全fieldを変換できる場合だけUIへ提示し、unsupported fieldを含む要求全体をdeclineする"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "unsupported fieldを落とした不完全なformをacceptするか、回答をpending elicitation RPC以外へ送る"
// observable = "UIへ渡るfield、handlePendingElicitationへの要求単位の回答とunsupported診断"
// observation_boundary = "public-boundary"
// scope = "Copilot elicitation schema and response bridge"
// lifecycle = "permanent"
// impact = "必須の入力が欠けたまま外部toolに受理されるか、元の要求が保留のままになる"
// distinction = "既存schema単体testでは要求全体の拒否と実turnの回答RPCを検出できず、小さいschema表で保証する"
// @end-test-value
/** 対応できない項目が一つでもあればフォーム全体を UI に出さず辞退し、対応可能なフォームでは元の要求 ID に回答する。 */
it("Copilot MCP elicitationは不完全なformを受理せず要求単位で回答する", async () => {
  for (const unsupported of [false, true]) {
    const response: LiveElicitationResponse = {
      action: "accept",
      content: { name: "Project" },
    };
    const fixture = interactionTurn(
      {
        type: "elicitation.requested",
        data: {
          requestId: "mcp-1",
          message: "Project",
          mode: "form",
          elicitationSource: "server",
          requestedSchema: {
            type: "object",
            properties: {
              name: { type: "string" },
              ...(unsupported ? { nested: { type: "object" } } : {}),
            },
            required: ["name"],
          },
        },
      } as unknown as SessionEvent,
      response,
    );
    await fixture.run();
    assert.equal(fixture.requests.length, unsupported ? 0 : 1);
    assert.deepEqual(fixture.replies, [
      {
        method: "elicitation",
        payload: {
          requestId: "mcp-1",
          result: unsupported ? { action: "decline" } : response,
        },
      },
    ]);
    assert.equal(
      fixture.logs.some((log) =>
        log.includes("Unsupported Copilot elicitation schema"),
      ),
      unsupported,
    );
    assert.deepEqual(fixture.released, fixture.interests);
  }
});

// @test-value v2
// kind = "contract"
// claim = "Copilotの入力回答はnative ACK前にturn成功とせず、拒否・通信失敗を取消ではなく失敗として返す"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "idleが先に届くと回答RPC失敗を無視してturnを成功にする"
// observable = "ACK待機中の未完了、ACK拒否・例外で返るProviderTurnErrorとcanceled=false"
// observation_boundary = "public-boundary"
// scope = "Copilot interaction RPC acknowledgement"
// lifecycle = "permanent"
// impact = "届いていない回答を成功扱いしてユーザーへ伝える"
// distinction = "通常回答testはACK前のidleやRPC失敗を再現せず、deferred ACKで順序を決定して確認する"
// @end-test-value
/** idle が ACK に先行しても完了を待ち、負の ACK と RPC 例外を取消ではなく失敗として報告する。 */
it(
  "Copilotはidleが先でも回答ACKを待ち拒否とRPC失敗を報告する",
  { timeout: 1000 },
  async () => {
    for (const rejectRpc of [false, true]) {
      const ack = Promise.withResolvers<{ success: boolean }>();
      const fixture = interactionTurn(
        {
          type: "user_input.requested",
          data: { requestId: "ack-1", question: "Name?" },
        } as SessionEvent,
        { action: "accept", content: { answer: "Name" } },
        () => ack.promise,
      );
      let settled = false;
      const result = fixture.run();
      void result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      while (fixture.replies.length === 0)
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      assert.deepEqual(fixture.delivered, []);
      if (rejectRpc) ack.reject(new Error("input RPC unavailable"));
      else ack.resolve({ success: false });
      await assert.rejects(result, (error: unknown) => {
        assert.ok(error instanceof ProviderTurnError);
        assert.equal(error.canceled, false);
        assert.match(
          error.message,
          rejectRpc ? /input RPC unavailable/ : /no longer pending/,
        );
        return true;
      });
      assert.deepEqual(fixture.delivered, []);
    }
  },
);

// @test-value v2
// kind = "contract"
// claim = "Copilotのbootstrap中に取消済みとなったturnは未送信のまま既存取消経路で終了する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "既発火abortを見落とし、送信せず届かないidleを待ち続ける"
// observable = "ProviderTurnErrorのcanceled、sendとabort回数、turn後のlistener解放"
// observation_boundary = "public-boundary"
// scope = "Copilot pre-send cancellation"
// lifecycle = "permanent"
// impact = "Cancel後にturnと再送guardが終了しない"
// distinction = "実行中sendの既存取消testはbootstrap終了時の既発火signalを確認せず、未送信fixtureで有限時間に確認する"
// @end-test-value
/** bootstrap 終了前に発火済みの取消で送信を行わず、abort 後に購読を解放して終了する。 */
it(
  "Copilotはbootstrap終了時に取消済みでも未送信で終了する",
  { timeout: 1000 },
  async () => {
    const fixture = interactionTurn(
      { type: "session.idle", data: {} } as SessionEvent,
      undefined,
      undefined,
      AbortSignal.abort(),
    );
    await assert.rejects(fixture.run(), (error: unknown) => {
      assert.ok(error instanceof ProviderTurnError);
      assert.equal(error.canceled, true);
      return true;
    });
    assert.deepEqual(fixture.calls, { send: 0, abort: 1 });
    assert.equal(fixture.listeners.size, 0);
  },
);

/** 固定した Agent 一覧を返し、空白を除いた選択名がなければ未選択として扱う。 */
function resolveCustomAgents(
  _workspacePath: string,
  selectedAgentName: string,
) {
  return {
    customAgents: [...CUSTOM_AGENT_CONFIGS],
    selectedAgentName: selectedAgentName.trim() || null,
  };
}

/** Copilot の Session 設定を実行入力に捕捉し、モデル、Depth、Agent、thread や binding をケース別に差し替えられるようにする。 */
function createRunSessionInput(options?: {
  customAgentName?: string;
  threadId?: string;
  model?: string;
  reasoningEffort?: RunSessionTurnInput["session"]["reasoningEffort"];
  agentRuntimeBinding?: RunSessionTurnInput["agentRuntimeBinding"];
}): RunSessionTurnInput {
  const defaultAgentRuntimeBinding: NonNullable<
    RunSessionTurnInput["agentRuntimeBinding"]
  > = {
    bindingId: "binding-default",
    bindingReference: "opaque-reference-default",
    providerId: "copilot",
    executionGeneration: "generation-default",
    transport: "env",
    expiresAt: null,
  };
  const {
    customAgentName = "reviewer",
    threadId = "",
    model = "gpt-4.1",
    reasoningEffort = "high",
    agentRuntimeBinding = defaultAgentRuntimeBinding,
  } = options ?? {};
  const session = {
    ...buildNewSession({
      provider: "copilot",
      taskTitle: "copilot",
      workspaceLabel: "workspace",
      workspacePath: "F:/repo",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
      model,
      reasoningEffort,
      customAgentName,
    }),
    threadId,
  };

  return {
    session,
    executionOptions: captureSessionExecutionOptions(session),
    character: {} as never,
    providerCatalog: COPILOT_PROVIDER_CATALOG,
    userMessage: "hello",
    appSettings: createDefaultAppSettings(),
    attachments: [],
    agentRuntimeBinding,
  };
}

// @test-value v2
// kind = "contract"
// claim = "Copilot foregroundは当turnのGlossary・Graph HTTP MCP endpointとcredentialをsession設定へ渡し、promptへtokenを混ぜず第三者設定探索を無効にしない"
// oracle = { type = "contract", ref = "docs/adr/027-shared-localhost-http-mcp-turn-identity.md" }
// fault = "HTTP serverや認証headerを欠落させる、tokenをpromptへ混ぜる、またはnative設定探索を無効にする"
// observable = "buildCopilotSessionSettingsのconfigとcomposePromptの戻り値"
// observation_boundary = "consumer"
// scope = "Copilot native foreground session HTTP MCP configuration"
// lifecycle = "permanent"
// impact = "Glossary・Graphが認証できず、第三者設定が使えなくなるかtokenがprompt監査へ漏れる"
// distinction = "SDKの型だけではWithMateが設定を渡すことやprompt分離を保証しない。固定fixtureでnative設定境界を確認する"
// risk_tags = ["privacy", "authentication"]
// @end-test-value
/** 当 Turn の HTTP endpoint と token は native の MCP 設定だけで渡し、プロンプトへ漏らさず標準の設定探索も無効化しない。 */
it("Copilot foregroundの当turn HTTP MCP設定をpromptから分離する", () => {
  const input = createRunSessionInput();
  input.agentRuntimeBinding = {
    ...input.agentRuntimeBinding!,
    managedMcp: {
      glossaryUrl: "http://127.0.0.1:47891/glossary",
      sessionUrl: "http://127.0.0.1:47891/session",
      token: "opaque-http-token",
    },
  };
  const prompt = new CopilotAdapter().composePrompt(input);
  const { config } = buildCopilotSessionSettings(
    input,
    prompt,
    "client-key",
    resolveCustomAgents,
  );
  assert.deepEqual(config.mcpServers, {
    "withmate-glossary": {
      type: "http",
      url: "http://127.0.0.1:47891/glossary",
      headers: { "x-withmate-mcp-token": "opaque-http-token" },
    },
    "withmate-session": {
      type: "http",
      url: "http://127.0.0.1:47891/session",
      headers: { "x-withmate-mcp-token": "opaque-http-token" },
    },
  });
  assert.notEqual(config.enableConfigDiscovery, false);
  assert.equal(config.disabledMcpServers, undefined);
  assert.doesNotMatch(JSON.stringify(prompt), /opaque-http-token/);
});

/** 承認ハンドラーへ実変更なしで渡せるファイル書き込み要求を作る。 */
function createWritePermissionRequest(): Extract<
  PermissionRequest,
  { kind: "write" }
> {
  return {
    kind: "write",
    toolCallId: "tool-call-1",
    intention: "Create file",
    fileName: "F:/repo/tmp/output.txt",
    diff: "",
    newFileContents: "synthetic text",
    canOfferSessionApproval: false,
  };
}

// @test-value v2
// kind = "contract"
// claim = "CopilotはCrew Folderを含む捕捉済み追加directoryをSDKへ渡し、変更時はnative session設定を更新する"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md#crew-folder" }
// fault = "promptだけへpathを渡してSDKのadditionalDirectoriesを欠落させる、または旧設定cacheを再利用する"
// observable = "SDK configのadditionalDirectoriesとsettingsKey"
// observation_boundary = "consumer"
// scope = "buildCopilotSessionSettings managed directory設定"
// lifecycle = "permanent"
// impact = "Copilotだけ共有folderを利用できずSession間の引継ぎが止まる"
// distinction = "SDK型検査はoptional propertyの欠落やcache invalidationを保証しない"
// @end-test-value
/** 捕捉済み Crew Folder を SDK の additionalDirectories へ渡し、追加前の設定キーを再利用しない。 */
it("Copilotは共有folderをnative追加directoryへ接続する", () => {
  const input = createRunSessionInput();
  const prompt = {
    ...EMPTY_PROMPT,
    additionalDirectories: ["F:/user-data/crew-files/root"],
  };
  const configured = buildCopilotSessionSettings(
    input,
    prompt,
    "client-key",
    resolveCustomAgents,
  );
  const previous = buildCopilotSessionSettings(
    input,
    EMPTY_PROMPT,
    "client-key",
    resolveCustomAgents,
  );
  assert.deepEqual(
    configured.config.additionalDirectories,
    prompt.additionalDirectories,
  );
  assert.notEqual(configured.settingsKey, previous.settingsKey);
});

/** 承認ハンドラーに与える読み取り要求を、実ファイルに依存せず作る。 */
function createReadPermissionRequest(): Extract<
  PermissionRequest,
  { kind: "read" }
> {
  return {
    kind: "read",
    toolCallId: "tool-call-2",
    path: "F:/repo/src/index.ts",
    intention: "Read fixture",
  };
}

/** 手動の承認・拒否を、人の対話応答と分かる来歴付き決定で再現する。 */
const manualCopilotDecision = (kind: "approve-once" | "reject") => ({
  kind: "attributed",
  result: { kind },
  decisionContext: {
    source: "human_response",
    responseCapability: "interactive",
    surface: "sdk",
    outcome: "prompted_user",
  },
});

const blockedCopilotDecision = {
  kind: "attributed",
  result: { kind: "user-not-available" },
  decisionContext: {
    source: "unattended_fallback",
    surface: "sdk",
    outcome: "autopilot_denied",
  },
};

/** Copilot CLI の環境、binding ごとの接続管理、SDK イベントの取り込みを確認する。 */
describe("CopilotAdapter env", () => {
  /** 子 CLI の警告を抑止しても既存の PATH と Electron の Node 実行設定は保持する。 */
  it("Copilot child CLI では process warning を抑止する", () => {
    const env = buildCopilotClientEnv({
      PATH: "test-path",
      ELECTRON_RUN_AS_NODE: "1",
    });

    assert.equal(env.NODE_NO_WARNINGS, "1");
    assert.equal(env.PATH, "test-path");
    assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Copilot child environment receives the runtime owner selector only for bound execution"
  // oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
  // fault = "Copilot selector is missing for bound execution or stale binding survives in unbound environment"
  // observable = "bound/unbound environment binding reference and runtime owner fields, preserved PATH and omitted undefined entry"
  // observation_boundary = "component-behavior"
  // scope = "copilot-provider-environment"
  // lifecycle = "permanent"
  // @end-test-value
  /** bound CLI は新しい参照と所有者・世代を受け取り、unbound CLI へ残存参照を渡さない。PATH は保持し未定義値は除く。 */
  it("Copilot child CLIへSession generationごとのopaque referenceとruntime owner selectorを渡す", () => {
    const binding = {
      bindingId: "binding-a",
      bindingReference: "opaque-reference-a",
      providerId: "copilot",
      executionGeneration: "generation-a",
      transport: "env" as const,
      expiresAt: null,
      runtimeOwner: {
        applicationInstanceId: "app-instance-a",
        runtimeGenerationId: "memory-generation-a",
      },
    };
    const boundEnv = buildCopilotClientEnv(
      {
        PATH: "test-path",
        [WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV]: "stale-reference",
        EMPTY: undefined,
      },
      binding,
    );
    const unboundEnv = buildCopilotClientEnv({
      PATH: "test-path",
      [WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV.toLowerCase()]:
        "stale-reference",
    });

    assert.equal(
      boundEnv[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV],
      binding.bindingReference,
    );
    assert.equal(
      boundEnv[WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV],
      "app-instance-a",
    );
    assert.equal(
      boundEnv[WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV],
      "memory-generation-a",
    );
    assert.equal(boundEnv.PATH, "test-path");
    assert.equal("EMPTY" in boundEnv, false);
    assert.equal(
      unboundEnv[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV],
      undefined,
    );
    assert.equal(
      unboundEnv[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV.toLowerCase()],
      undefined,
    );
    assert.equal(
      unboundEnv[
        WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV.toLowerCase()
      ],
      undefined,
    );
    assert.equal(
      unboundEnv[WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV.toLowerCase()],
      undefined,
    );
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Copilot clients are separated by runtime owner selector and settings-only clients are unbound"
  // oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
  // fault = "Copilot client cache reuses a client across owners or passes Session binding to settings-only clients"
  // observable = "client identity and cache keys across retries/owners, and resolved environment of bound and settings-only clients"
  // observation_boundary = "component-behavior"
  // scope = "copilot-provider-adapter"
  // lifecycle = "permanent"
  // @end-test-value
  /** runtime 所有者と世代が一致する場合だけ client を再利用し、設定参照用 client と親プロセスには Session の参照を残さない。 */
  it("Session generationごとのclientを分離しsettings-only clientをunboundに保つ", () => {
    const adapter = new CopilotAdapter() as unknown as {
      /** 実行用 client とキーを取り出し、所有者による分離を照合する。 */
      getClient(
        providerId: string,
        input: RunSessionTurnInput,
      ): {
        client: { resolvedEnv: Record<string, string | undefined> };
        clientKey: string;
      };
      /** Session binding を持たない設定用 client の環境を調べる。 */
      getOrCreateClientByAppSettings(
        providerId: string,
        appSettings: RunSessionTurnInput["appSettings"],
      ): {
        resolvedEnv: Record<string, string | undefined>;
      };
    };
    const before = process.env[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV];
    const bindingA = {
      bindingId: "binding-a",
      bindingReference: "opaque-reference-a",
      providerId: "copilot",
      executionGeneration: "generation-a",
      transport: "env" as const,
      expiresAt: null,
      runtimeOwner: {
        applicationInstanceId: "app-instance-a",
        runtimeGenerationId: "memory-generation-a",
      },
    };
    const bindingB = {
      ...bindingA,
      bindingId: "binding-b",
      bindingReference: "opaque-reference-b",
      executionGeneration: "generation-b",
      runtimeOwner: {
        applicationInstanceId: "app-instance-b",
        runtimeGenerationId: "memory-generation-b",
      },
    };
    const inputA = createRunSessionInput({ agentRuntimeBinding: bindingA });
    const inputB = { ...inputA, agentRuntimeBinding: bindingB };

    const clientA = adapter.getClient("copilot", inputA);
    const clientARetry = adapter.getClient("copilot", inputA);
    const clientB = adapter.getClient("copilot", inputB);
    const backgroundClient = adapter.getOrCreateClientByAppSettings(
      "copilot",
      inputA.appSettings,
    );

    assert.equal(clientA.client, clientARetry.client);
    assert.notEqual(clientA.client, clientB.client);
    assert.notEqual(clientA.clientKey, clientB.clientKey);
    assert.equal(
      clientA.client.resolvedEnv[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV],
      bindingA.bindingReference,
    );
    assert.equal(
      clientB.client.resolvedEnv[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV],
      bindingB.bindingReference,
    );
    assert.equal(
      clientA.client.resolvedEnv[
        WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV
      ],
      "app-instance-a",
    );
    assert.equal(
      clientA.client.resolvedEnv[WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV],
      "memory-generation-a",
    );
    assert.equal(
      clientB.client.resolvedEnv[
        WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV
      ],
      "app-instance-b",
    );
    assert.equal(
      clientB.client.resolvedEnv[WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV],
      "memory-generation-b",
    );
    assert.equal(
      backgroundClient.resolvedEnv[
        WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV
      ],
      undefined,
    );
    assert.equal(
      backgroundClient.resolvedEnv[
        WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV
      ],
      undefined,
    );
    assert.equal(
      backgroundClient.resolvedEnv[WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV],
      undefined,
    );
    assert.equal(
      Object.keys(backgroundClient.resolvedEnv).some(
        (key) =>
          key.toLowerCase() ===
            WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV.toLowerCase() ||
          key.toLowerCase() ===
            WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV.toLowerCase(),
      ),
      false,
    );
    assert.equal(
      process.env[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV],
      before,
    );
  });

  /** binding のない実行入力を拒否し、client キャッシュを空のまま保つ。 */
  it("supported Sessionのbinding欠落をclient cache参照前に拒否する", () => {
    const adapter = new CopilotAdapter() as unknown as {
      clients: Map<string, unknown>;
      /** binding が必須のコード経路を直接呼び出す。 */
      getClient(providerId: string, input: RunSessionTurnInput): unknown;
    };
    const input = createRunSessionInput();

    assert.throws(
      () =>
        adapter.getClient("copilot", {
          ...input,
          agentRuntimeBinding: undefined,
        }),
      /requires an Agent runtime binding/,
    );
    assert.equal(adapter.clients.size, 0);
  });

  /** 単一 Session の無効化では対応する接続・bound client だけを終了し、背景用 client を残す。 */
  it("Session invalidationでbound clientを停止しbackground clientを維持する", async () => {
    const adapter = new CopilotAdapter() as unknown as {
      clients: Map<
        string,
        {
          /** キーごとに停止対象の client を観測する。 */
          stop(): Promise<Error[]>;
        }
      >;
      sessions: Map<
        string,
        {
          session: {
            /** キャッシュされた native Session の切断を検出する。 */
            disconnect(): Promise<void>;
          };
          settingsKey: string;
          backgroundTasks: Map<string, LiveBackgroundTask>;
        }
      >;
      clientKeysBySession: Map<string, string>;
      /** 対象 Session だけの接続を解放する。 */
      invalidateSessionThread(sessionId: string): Promise<void>;
    };
    let disconnected = false;
    let boundStopped = false;
    let backgroundStopped = false;
    adapter.clients.set("bound", {
      /** bound client が停止されたことを記録する。 */
      stop: async () => {
        boundStopped = true;
        return [];
      },
    });
    adapter.clients.set("background", {
      /** 背景用 client まで停止された場合を検出する。 */
      stop: async () => {
        backgroundStopped = true;
        return [];
      },
    });
    adapter.sessions.set("session-a", {
      session: {
        /** 対象の native Session が切断されたことを記録する。 */
        disconnect: async () => {
          disconnected = true;
        },
      },
      settingsKey: "settings",
      backgroundTasks: new Map(),
    });
    adapter.clientKeysBySession.set("session-a", "bound");

    await adapter.invalidateSessionThread("session-a");

    assert.equal(disconnected, true);
    assert.equal(boundStopped, true);
    assert.equal(backgroundStopped, false);
    assert.deepEqual([...adapter.clients.keys()], ["background"]);
    assert.equal(adapter.clientKeysBySession.has("session-a"), false);
  });

  /** native Session の切断応答が戻らなくても、期限で待機を打ち切り対応する client の停止と解放へ進む。 */
  it("Session disconnectがsettleしなくても期限後にbound client停止へ進む", async () => {
    const adapter = new CopilotAdapter({
      sessionDisconnectTimeoutMs: 0,
    }) as unknown as {
      clients: Map<
        string,
        {
          /** 切断が完了しない場合も停止できる client を差し込む。 */
          stop(): Promise<Error[]>;
        }
      >;
      sessions: Map<
        string,
        {
          session: {
            /** 期限処理を検証する native Session の切断口を表す。 */
            disconnect(): Promise<void>;
          };
          settingsKey: string;
          backgroundTasks: Map<string, LiveBackgroundTask>;
        }
      >;
      clientKeysBySession: Map<string, string>;
      /** 単一 Session の期限付き cleanup を実行する。 */
      invalidateSessionThread(sessionId: string): Promise<void>;
    };
    let stopped = false;
    adapter.clients.set("bound", {
      /** 未完了の切断後に client 停止へ到達したことを記録する。 */
      stop: async () => {
        stopped = true;
        return [];
      },
    });
    adapter.sessions.set("session-a", {
      session: {
        /** 切断の応答が返らない native Session を再現する。 */
        disconnect: () => new Promise<void>(() => undefined),
      },
      settingsKey: "settings",
      backgroundTasks: new Map(),
    });
    adapter.clientKeysBySession.set("session-a", "bound");

    await adapter.invalidateSessionThread("session-a");

    assert.equal(stopped, true);
    assert.equal(adapter.clients.size, 0);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Copilot session invalidation中の同一key再接続は旧cleanupで新clientを削除しない"
  // oracle = { type = "contract", ref = "src-electron/providers/copilot/copilot-adapter.ts: session lifecycle" }
  // fault = "旧sessionのcleanupが再接続済みclientを停止し、後続turnを失敗させる"
  // observable = "adapterのsession/client registryとstop呼出の最終状態"
  // observation_boundary = "implementation"
  // scope = "copilot-session-invalidation"
  // lifecycle = "permanent"
  // distinction = "単一sessionのcleanupでは検出できない同一key再接続競合を検証する"
  // @end-test-value
  /** 旧接続の切断中に同じキーで再接続しても、旧 cleanup は新しい Session と client を停止・削除しない。 */
  it("Session invalidation中の同一key再接続を旧cleanupで削除しない", async () => {
    const adapter = new CopilotAdapter() as unknown as {
      clients: Map<
        string,
        {
          /** キーの再利用前後で別 client の停止を検出する。 */
          stop(): Promise<Error[]>;
        }
      >;
      sessions: Map<
        string,
        {
          session: {
            /** 新旧 Session の競合を作る native 切断口を表す。 */
            disconnect(): Promise<void>;
          };
          settingsKey: string;
          backgroundTasks: Map<string, LiveBackgroundTask>;
        }
      >;
      clientKeysBySession: Map<string, string>;
      /** 旧 Session の切断だけを開始する。 */
      invalidateSessionThread(sessionId: string): Promise<void>;
    };
    /** 旧切断の待機を後で解除するための初期値を置く。 */
    let releaseDisconnect: () => void = () => undefined;
    const disconnectBarrier = new Promise<void>((resolve) => {
      releaseDisconnect = () => resolve();
    });
    /** 旧切断へ入った時点を後で通知するための初期値を置く。 */
    let signalDisconnectStarted: () => void = () => undefined;
    const disconnectStarted = new Promise<void>((resolve) => {
      signalDisconnectStarted = () => resolve();
    });
    let oldClientStopped = false;
    let newClientStopped = false;
    const oldClient = {
      /** 置き換え済みの旧 client が停止したことを記録する。 */
      stop: async () => {
        oldClientStopped = true;
        return [];
      },
    };
    const newClient = {
      /** 新しい client に誤って停止が届いた場合を記録する。 */
      stop: async () => {
        newClientStopped = true;
        return [];
      },
    };
    const newCachedSession = {
      session: {
        /** 競合中に再登録する新しい Session は待たずに切断できるようにする。 */
        disconnect: async () => undefined,
      },
      settingsKey: "new-settings",
      backgroundTasks: new Map<string, LiveBackgroundTask>(),
    };
    adapter.clients.set("bound", oldClient);
    adapter.sessions.set("session-a", {
      session: {
        /** 旧 Session の切断開始を通知し、再接続を差し込むまで保留する。 */
        disconnect: () => {
          signalDisconnectStarted();
          return disconnectBarrier;
        },
      },
      settingsKey: "old-settings",
      backgroundTasks: new Map(),
    });
    adapter.clientKeysBySession.set("session-a", "bound");

    const invalidation = adapter.invalidateSessionThread("session-a");
    assert.equal(adapter.clients.has("bound"), false);
    assert.equal(adapter.sessions.has("session-a"), false);
    assert.equal(adapter.clientKeysBySession.has("session-a"), false);

    adapter.clients.set("bound", newClient);
    adapter.sessions.set("session-a", newCachedSession);
    adapter.clientKeysBySession.set("session-a", "bound");
    await disconnectStarted;
    releaseDisconnect();
    await invalidation;

    assert.equal(oldClientStopped, true);
    assert.equal(newClientStopped, false);
    assert.equal(adapter.clients.get("bound"), newClient);
    assert.equal(adapter.sessions.get("session-a"), newCachedSession);
    assert.equal(adapter.clientKeysBySession.get("session-a"), "bound");
  });

  /** 回復可能な接続失敗後は同じ binding とキーを使いながら、新しい client で再試行する。 */
  it("recoverable connection retryではclientを再生成して同じbinding generationを使う", async () => {
    const adapter = new CopilotAdapter() as unknown as {
      /** 同じ binding で再取得した client とキーを比較する。 */
      getClient(
        providerId: string,
        input: RunSessionTurnInput,
      ): {
        client: { resolvedEnv: Record<string, string | undefined> };
        clientKey: string;
      };
      clientKeysBySession: Map<string, string>;
      /** 回復可能な切断を再試行前のリセットへ渡す。 */
      resetRecoverableConnection(input: RunSessionTurnInput): Promise<void>;
    };
    const binding = {
      bindingId: "binding-a",
      bindingReference: "opaque-reference-a",
      providerId: "copilot",
      executionGeneration: "generation-a",
      transport: "env" as const,
      expiresAt: null,
    };
    const input = createRunSessionInput({ agentRuntimeBinding: binding });
    const first = adapter.getClient("copilot", input);
    adapter.clientKeysBySession.set(input.session.id, first.clientKey);

    await adapter.resetRecoverableConnection(input);
    const retried = adapter.getClient("copilot", input);

    assert.equal(retried.clientKey, first.clientKey);
    assert.notEqual(retried.client, first.client);
    assert.equal(
      retried.client.resolvedEnv[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV],
      binding.bindingReference,
    );
  });

  /** Session の関連付けがない bootstrap 失敗でも、再試行はキャッシュ内の旧 client ではなく同じ binding の新 client を使う。 */
  it("session bootstrap失敗時のrecoverable retryでもcache済みclientを再生成する", async () => {
    const adapter = new CopilotAdapter() as unknown as {
      /** bootstrap 前後の client 本体とキャッシュキーを取り出す。 */
      getClient(
        providerId: string,
        input: RunSessionTurnInput,
      ): {
        client: { resolvedEnv: Record<string, string | undefined> };
        clientKey: string;
      };
      clients: Map<string, unknown>;
      clientKeysBySession: Map<string, string>;
      /** 所有関係のない client が残った状態を再試行向けにリセットする。 */
      resetRecoverableConnection(input: RunSessionTurnInput): Promise<void>;
    };
    const binding = {
      bindingId: "binding-a",
      bindingReference: "opaque-reference-a",
      providerId: "copilot",
      executionGeneration: "generation-a",
      transport: "env" as const,
      expiresAt: null,
    };
    const input = createRunSessionInput({ agentRuntimeBinding: binding });
    const first = adapter.getClient("copilot", input);

    assert.equal(adapter.clientKeysBySession.has(input.session.id), false);
    assert.equal(adapter.clients.has(first.clientKey), true);

    await adapter.resetRecoverableConnection(input);
    const retried = adapter.getClient("copilot", input);

    assert.equal(retried.clientKey, first.clientKey);
    assert.notEqual(retried.client, first.client);
    assert.equal(
      retried.client.resolvedEnv[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV],
      binding.bindingReference,
    );
  });

  /** native Session の作成が失敗しても、回復に使う client の所有キーは先に Session に関連付けられている。 */
  it("session bootstrap失敗前にclient ownershipをSessionへ関連付ける", async () => {
    const adapter = new CopilotAdapter() as unknown as {
      clientKeysBySession: Map<string, string>;
      /** bootstrap を試すため固定キーの client を差し込む。 */
      getClient(): { client: unknown; clientKey: string };
      /** native Session の初期化と client 所有権の確定を実行する。 */
      getSession(
        input: RunSessionTurnInput,
        prompt: ProviderPromptComposition,
      ): Promise<unknown>;
    };
    adapter.getClient = () => ({
      client: {
        /** 新規 native Session の初期化が失敗するケースを作る。 */
        createSession: async () => {
          throw new Error("bootstrap failed");
        },
        /** 誤って再開経路へ入った場合も正常終了させない。 */
        resumeSession: async () => {
          throw new Error("bootstrap failed");
        },
      },
      clientKey: "bootstrap-client",
    });
    const input = createRunSessionInput({ threadId: "" });

    await assert.rejects(
      () => adapter.getSession(input, EMPTY_PROMPT),
      /bootstrap failed/,
    );

    assert.equal(
      adapter.clientKeysBySession.get(input.session.id),
      "bootstrap-client",
    );
  });

  /** プロバイダー全体の無効化では native Session を切断し、bound と背景用両方の client を停止して全関連付けを除く。 */
  it("provider-wide invalidationで全sessionとclientを停止する", async () => {
    const adapter = new CopilotAdapter() as unknown as {
      clients: Map<
        string,
        {
          /** プロバイダー全体で管理している client の停止口を表す。 */
          stop(): Promise<Error[]>;
        }
      >;
      sessions: Map<
        string,
        {
          session: {
            /** 全体無効化に含まれる native Session の切断口を表す。 */
            disconnect(): Promise<void>;
          };
          settingsKey: string;
          backgroundTasks: Map<string, LiveBackgroundTask>;
          unsubscribeBackgroundObserver?: () => void;
        }
      >;
      clientKeysBySession: Map<string, string>;
      /** Copilot 全接続の cleanup を実行する。 */
      invalidateAllSessionThreads(): Promise<void>;
    };
    let disconnectCount = 0;
    let stopCount = 0;
    adapter.clients.set("bound", {
      /** 全体無効化で bound client が停止対象になったことを数える。 */
      stop: async () => {
        stopCount += 1;
        return [];
      },
    });
    adapter.clients.set("background", {
      /** 全体無効化で背景用 client も停止したことを数える。 */
      stop: async () => {
        stopCount += 1;
        return [];
      },
    });
    adapter.sessions.set("session-a", {
      session: {
        /** プロバイダー全体の処理が Session の切断を呼んだことを数える。 */
        disconnect: async () => {
          disconnectCount += 1;
        },
      },
      settingsKey: "settings",
      backgroundTasks: new Map(),
    });
    adapter.clientKeysBySession.set("session-a", "bound");

    await adapter.invalidateAllSessionThreads();

    assert.equal(disconnectCount, 1);
    assert.equal(stopCount, 2);
    assert.equal(adapter.sessions.size, 0);
    assert.equal(adapter.clients.size, 0);
    assert.equal(adapter.clientKeysBySession.size, 0);
  });

  /** 全体無効化は未完了の Session 切断を無期限に待たず、client を停止して両キャッシュを空にする。 */
  it("provider-wide invalidationはdisconnectがsettleしなくても完了する", async () => {
    const adapter = new CopilotAdapter({
      sessionDisconnectTimeoutMs: 0,
    }) as unknown as {
      clients: Map<
        string,
        {
          /** Session 切断が保留でも終了できる client の停止口を表す。 */
          stop(): Promise<Error[]>;
        }
      >;
      sessions: Map<
        string,
        {
          session: {
            /** 完了しない native Session の切断を差し込めるようにする。 */
            disconnect(): Promise<void>;
          };
          settingsKey: string;
          backgroundTasks: Map<string, LiveBackgroundTask>;
        }
      >;
      /** 応答のない Session を含む全体 cleanup を実行する。 */
      invalidateAllSessionThreads(): Promise<void>;
    };
    let stopped = false;
    adapter.clients.set("bound", {
      /** Session 切断の期限後に client 停止が行われたことを記録する。 */
      stop: async () => {
        stopped = true;
        return [];
      },
    });
    adapter.sessions.set("session-a", {
      session: {
        /** 全体 cleanup に切断応答を返さない Session を混ぜる。 */
        disconnect: () => new Promise<void>(() => undefined),
      },
      settingsKey: "settings",
      backgroundTasks: new Map(),
    });

    await adapter.invalidateAllSessionThreads();

    assert.equal(stopped, true);
    assert.equal(adapter.sessions.size, 0);
    assert.equal(adapter.clients.size, 0);
  });

  /** 通常停止が期限切れになった client には強制停止を呼び、管理対象から除く。 */
  it("provider-wide invalidationでgraceful stopが期限超過したclientをforce stopする", async () => {
    const adapter = new CopilotAdapter({
      clientStopTimeoutMs: 0,
    }) as unknown as {
      clients: Map<
        string,
        {
          /** 長引く通常停止を注入する口。 */
          stop(): Promise<Error[]>;
          /** 通常停止の期限後に呼ばれる強制停止口。 */
          forceStop(): Promise<void>;
        }
      >;
      /** 通常停止の期限付き全体 cleanup を実行する。 */
      invalidateAllSessionThreads(): Promise<void>;
    };
    let forceStopped = false;
    adapter.clients.set("bound", {
      /** 期限を超えても完了しない通常停止を再現する。 */
      stop: () => new Promise<Error[]>(() => undefined),
      /** 期限後に強制停止へ移ったことを記録する。 */
      forceStop: async () => {
        forceStopped = true;
      },
    });

    await adapter.invalidateAllSessionThreads();

    assert.equal(forceStopped, true);
    assert.equal(adapter.clients.size, 0);
  });

  /** 通常停止も強制停止も完了しない client を無期限に待たず、強制停止を一度呼んでキャッシュを空にする。 */
  it("provider-wide invalidationはforce stopがsettleしなくてもclientを解放する", async () => {
    const adapter = new CopilotAdapter({
      clientStopTimeoutMs: 0,
    }) as unknown as {
      clients: Map<
        string,
        {
          /** 保留された通常停止を模擬する口。 */
          stop(): Promise<Error[]>;
          /** 強制停止の未完了を差し込む口。 */
          forceStop(): Promise<void>;
        }
      >;
      /** 強制停止の応答を待ち続けない全体 cleanup を実行する。 */
      invalidateAllSessionThreads(): Promise<void>;
    };
    let forceStopCount = 0;
    adapter.clients.set("never-settles", {
      /** 強制停止が必要になるよう通常停止を保留する。 */
      stop: () => new Promise<Error[]>(() => undefined),
      /** 強制停止を数えたうえで、応答を未完了のままにする。 */
      forceStop: () => {
        forceStopCount += 1;
        return new Promise<void>(() => undefined);
      },
    });

    await adapter.invalidateAllSessionThreads();

    assert.equal(forceStopCount, 1);
    assert.equal(adapter.clients.size, 0);
  });

  /** 強制停止が同期的に例外を投げても、失敗した client を管理対象から解放する。 */
  it("provider-wide invalidationはforce stopの同期throwでもclientを解放する", async () => {
    const adapter = new CopilotAdapter({
      clientStopTimeoutMs: 0,
    }) as unknown as {
      clients: Map<
        string,
        {
          /** 正常終了しなかった通常停止を差し込む口。 */
          stop(): Promise<Error[]>;
          /** 同期例外を投げる強制停止口。 */
          forceStop(): Promise<void>;
        }
      >;
      /** 強制停止例外を含む全体 cleanup を実行する。 */
      invalidateAllSessionThreads(): Promise<void>;
    };
    adapter.clients.set("force-throws", {
      /** 通常停止で回収されたエラーを結果配列として返す。 */
      stop: async () => [new Error("graceful cleanup failed")],
      /** 強制停止そのものが同期例外で失敗する状況を作る。 */
      forceStop: () => {
        throw new Error("force cleanup failed");
      },
    });

    await adapter.invalidateAllSessionThreads();

    assert.equal(adapter.clients.size, 0);
  });

  /** 通常停止がエラー配列を返す場合も reject する場合も強制停止へ進み、両 client を解放する。 */
  it("provider-wide invalidationでgraceful stopが失敗したclientをforce stopする", async () => {
    const adapter = new CopilotAdapter() as unknown as {
      clients: Map<
        string,
        {
          /** エラー結果と reject を返す通常停止口。 */
          stop(): Promise<Error[]>;
          /** 通常停止失敗後の強制停止を観測する口。 */
          forceStop(): Promise<void>;
        }
      >;
      /** 通常停止の二種類の失敗を含む全体 cleanup を起動する。 */
      invalidateAllSessionThreads(): Promise<void>;
    };
    const forceStopped: string[] = [];
    adapter.clients.set("reported-error", {
      /** 通常停止を結果配列内のエラーとして失敗させる。 */
      stop: async () => [new Error("graceful cleanup failed")],
      /** 結果配列内のエラーから強制停止へ進んだ client を記録する。 */
      forceStop: async () => {
        forceStopped.push("reported-error");
      },
    });
    adapter.clients.set("rejected", {
      /** 通常停止の Promise が reject する失敗を作る。 */
      stop: async () => {
        throw new Error("graceful cleanup rejected");
      },
      /** Promise の reject から強制停止へ進んだ client を記録する。 */
      forceStop: async () => {
        forceStopped.push("rejected");
      },
    });

    await adapter.invalidateAllSessionThreads();

    assert.deepEqual(forceStopped.sort(), ["rejected", "reported-error"]);
    assert.equal(adapter.clients.size, 0);
  });

  /** 同一入力とプロンプトから解決された native Session を再利用し、キャッシュを一件に保つ。 */
  it("Copilot session は設定が同じならcacheを再利用する", async () => {
    const adapter = new CopilotAdapter() as unknown as {
      sessions: Map<string, unknown>;
      /** 同じ client を返して Session の設定だけを比較できる境界を表す。 */
      getClient(): { client: unknown; clientKey: string };
      /** 設定に対応する native Session を取得し、その参照を比較できるようにする。 */
      getSession(
        input: RunSessionTurnInput,
        prompt: ProviderPromptComposition,
      ): Promise<{ session: { sessionId: string } }>;
    };
    let sessionIndex = 0;
    /** 新規接続が発生するたびに異なる native Session ID を割り当てる。 */
    const createSession = () => ({
      sessionId: `session-${++sessionIndex}`,
      /** 実接続を持たない native Session の切断を完了する。 */
      disconnect: async () => undefined,
      /** 画面のイベント配信を伴わない購読解除口を返す。 */
      on: () => () => undefined,
    });
    adapter.getClient = () => ({
      client: {
        createSession,
        /** 既存 thread を指定した場合はその ID を持つ native Session を返す。 */
        resumeSession: async (threadId: string) => ({
          ...createSession(),
          sessionId: threadId,
        }),
      },
      clientKey: "client-key",
    });
    const input = createRunSessionInput();

    const firstSession = await adapter.getSession(input, EMPTY_PROMPT);
    const nextSession = await adapter.getSession(input, EMPTY_PROMPT);
    assert.equal(nextSession.session, firstSession.session);
    assert.equal(adapter.sessions.size, 1);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Copilotのplatformとarchから対応するSDK native package名を返す"
  // oracle = { type = "contract", ref = "docs/design/distribution-packaging.md#build-boundary" }
  // fault = "別OS用packageを選ぶか非対応archを許可する"
  // observable = "resolveNativeCopilotPackageNameの返却値"
  // observation_boundary = "public-boundary"
  // scope = "Copilot native runtime resolution"
  // lifecycle = "permanent"
  // impact = "SDKに対応する実行物を起動・配布できなくなる"
  // distinction = "package配置とruntime文字列pathの対応は型検査で確認できず、外部processなしで検査する"
  // @end-test-value
  /** 各 OS とアーキテクチャの組から該当 SDK パッケージ名を返し、未対応の組には名前を割り当てない。 */
  it("platform / arch から native Copilot package 名を決める", () => {
    assert.equal(
      resolveNativeCopilotPackageName("win32", "x64"),
      "@github/copilot-sdk-win32-x64",
    );
    assert.equal(
      resolveNativeCopilotPackageName("darwin", "arm64"),
      "@github/copilot-sdk-darwin-arm64",
    );
    assert.equal(
      resolveNativeCopilotPackageName("linux", "x64"),
      "@github/copilot-sdk-linux-x64",
    );
    assert.equal(resolveNativeCopilotPackageName("win32", "ia32"), null);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Electron開発時はSDK native packageのruntime wrapperを使う"
  // oracle = { type = "contract", ref = "docs/design/distribution-packaging.md#build-boundary" }
  // fault = "package内prebuilds階層を落とすかPATH版を優先する"
  // observable = "resolveCopilotCliPathのpackage照会と返却値"
  // observation_boundary = "public-boundary"
  // scope = "Copilot native runtime resolution"
  // lifecycle = "permanent"
  // impact = "SDKに対応する実行物を起動・配布できなくなる"
  // distinction = "package配置とruntime文字列pathの対応は型検査で確認できず、外部processなしで検査する"
  // @end-test-value
  /** Electron 開発時は OS・アーキテクチャ別 native SDK の配下にあるランタイム実行物を選ぶ。 */
  it("Electron では native Copilot CLI binary を優先して使う", () => {
    const resolved = resolveCopilotCliPath(
      (specifier) => {
        assert.equal(specifier, "@github/copilot-sdk-win32-x64/package.json");
        return path.join("C:\\sdk", "package.json");
      },
      (candidate) =>
        candidate ===
        path.join("C:\\sdk", "prebuilds", "win32-x64", "copilot-runtime.exe"),
      "win32",
      "x64",
      undefined,
    );

    assert.equal(
      resolved,
      path.join("C:\\sdk", "prebuilds", "win32-x64", "copilot-runtime.exe"),
    );
  });

  // @test-value v2
  // kind = "contract"
  // claim = "package.json非公開時はnative root exportをlocal commandより優先する"
  // oracle = { type = "contract", ref = "docs/design/distribution-packaging.md#build-boundary" }
  // fault = "subpath解決失敗で利用可能なnative実行物を無視する"
  // observable = "root export照会とlocal commandでない返却path"
  // observation_boundary = "public-boundary"
  // scope = "Copilot native runtime resolution"
  // lifecycle = "permanent"
  // impact = "SDKに対応する実行物を起動・配布できなくなる"
  // distinction = "package配置とruntime文字列pathの対応は型検査で確認できず、外部processなしで検査する"
  // @end-test-value
  /** package.json が export されていなくても root export の実行物を解決し、ローカルコマンドより優先する。 */
  it("Electron では package.json subpath が非公開でも Copilot native binary を優先して使う", () => {
    const expected = path.join(
      "C:\\sdk",
      "prebuilds",
      "win32-x64",
      "copilot-runtime.exe",
    );
    const resolved = resolveCopilotCliPath(
      (specifier) => {
        if (specifier === "@github/copilot-sdk-win32-x64/package.json") {
          throw Object.assign(
            new Error(
              "Package subpath './package.json' is not defined by exports",
            ),
            {
              code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
            },
          );
        }
        assert.equal(specifier, "@github/copilot-sdk-win32-x64");
        return expected;
      },
      (candidate) =>
        candidate === expected ||
        candidate ===
          path.resolve(process.cwd(), "node_modules", ".bin", "copilot.cmd"),
      "win32",
      "x64",
      undefined,
    );

    assert.equal(resolved, expected);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "配布時はASAR外のstaged Copilot SDK runtime wrapperを最優先する"
  // oracle = { type = "contract", ref = "docs/design/distribution-packaging.md#build-boundary" }
  // fault = "配布済みwrapperより開発環境packageを参照する"
  // observable = "開発package未照会とstaged pathの返却"
  // observation_boundary = "public-boundary"
  // scope = "Copilot native runtime resolution"
  // lifecycle = "permanent"
  // impact = "SDKに対応する実行物を起動・配布できなくなる"
  // distinction = "package配置とruntime文字列pathの対応は型検査で確認できず、外部processなしで検査する"
  // @end-test-value
  /** 配布用 resources の native ランタイムが存在する場合は、開発パッケージを照会しない。 */
  it("packaged runtime では staged Copilot CLI binary を最優先する", () => {
    const resourcesPath = "C:\\Program Files\\WithMate\\resources";
    const expected = path.join(
      resourcesPath,
      "provider-binaries",
      "@github",
      "copilot-sdk-win32-x64",
      "prebuilds",
      "win32-x64",
      "copilot-runtime.exe",
    );

    const resolved = resolveCopilotCliPath(
      () => {
        throw new Error("development binary は見ない");
      },
      (candidate) => candidate === expected,
      "win32",
      "x64",
      resourcesPath,
    );

    assert.equal(resolved, expected);
  });

  /** native 実行物が解決できなければ、プロジェクトの node_modules に置いた CLI を使う。 */
  it("native binary が見つからない時は local node_modules command を返す", () => {
    const resolved = resolveCopilotCliPath(
      () => {
        throw new Error("not found");
      },
      (candidate) =>
        candidate ===
        path.resolve(process.cwd(), "node_modules", ".bin", "copilot.cmd"),
      "win32",
      "x64",
      undefined,
    );

    assert.equal(
      resolved,
      path.resolve(process.cwd(), "node_modules", ".bin", "copilot.cmd"),
    );
  });

  /** native 実行物もローカル CLI も見つからなければ、パスなしの Windows コマンド名へフォールバックする。 */
  it("local command も無い時だけ bare command fallback を返す", () => {
    const resolved = resolveCopilotCliPath(
      () => {
        throw new Error("not found");
      },
      () => false,
      "win32",
      "x64",
      undefined,
    );

    assert.equal(resolved, "copilot.cmd");
  });

  /** 接続終了や CLI の予期しない終了を再試行対象とし、選択モデルの誤りは再試行しない。 */
  it("stale connection 系の message だけ recovery 対象にする", () => {
    assert.equal(
      isRecoverableCopilotConnectionErrorMessage("Connection is closed."),
      true,
    );
    assert.equal(
      isRecoverableCopilotConnectionErrorMessage(
        "CLI server exited unexpectedly with code 0",
      ),
      true,
    );
    assert.equal(
      isRecoverableCopilotConnectionErrorMessage(
        "selected model が model catalog に存在しないよ。",
      ),
      false,
    );
  });

  /** PowerShell やファイル作成は Latest Command に表示し、内部の意図報告は除く。 */
  it("Latest Command に載せる Copilot tool 名だけ可視化対象にする", () => {
    assert.equal(isCopilotVisibleToolName("powershell"), true);
    assert.equal(isCopilotVisibleToolName("create"), true);
    assert.equal(isCopilotVisibleToolName("report_intent"), false);
  });

  /** PowerShell の要約にツール名を足さず、実行されるコマンド文字列を返す。 */
  it("shell tool は raw command を summary に使う", () => {
    const summary = buildCopilotToolSummary(
      "powershell",
      {
        command: "Get-ChildItem src",
      },
      "F:/repo",
    );

    assert.equal(summary, "Get-ChildItem src");
  });

  /** ファイル作成の要約をツール名とワークスペースからの相対パスで構成する。 */
  it("file-write tool は workspace 相対 path を含む summary にする", () => {
    const summary = buildCopilotToolSummary(
      "create",
      {
        path: "F:/repo/tmp/output.txt",
      },
      "F:/repo",
    );

    assert.equal(summary, "create tmp/output.txt");
  });

  /** 移動操作の要約に移動元と移動先の相対パスを両方残す。 */
  it("move tool は source と destination の両方を summary にする", () => {
    const summary = buildCopilotToolSummary(
      "move",
      {
        source: "F:/repo/tmp/old.txt",
        destination: "F:/repo/tmp/new.txt",
      },
      "F:/repo",
    );

    assert.equal(summary, "move tmp/old.txt -> tmp/new.txt");
  });

  /** 添付の絶対パスと表示名を保持し、SDK 用の file と directory を使い分ける。 */
  it("file / folder 添付を Copilot attachments へ変換する", () => {
    const attachments = buildCopilotMessageAttachments([
      {
        id: "file:src/index.ts",
        kind: "file",
        source: "text",
        absolutePath: "F:\\repo\\src\\index.ts",
        displayPath: "src/index.ts",
        workspaceRelativePath: "src/index.ts",
        isOutsideWorkspace: false,
      },
      {
        id: "folder:docs",
        kind: "folder",
        source: "text",
        absolutePath: "F:\\repo\\docs",
        displayPath: "docs",
        workspaceRelativePath: "docs",
        isOutsideWorkspace: false,
      },
    ]);

    assert.deepEqual(attachments, [
      {
        type: "file",
        path: "F:\\repo\\src\\index.ts",
        displayName: "src/index.ts",
      },
      {
        type: "directory",
        path: "F:\\repo\\docs",
        displayName: "docs",
      },
    ]);
  });

  /** 画像にも SDK の file 種別を使い、元のパスと表示名を保持する。 */
  it("image 添付も Copilot では file attachment として送る", () => {
    const attachments = buildCopilotMessageAttachments([
      {
        id: "image:assets/sample.png",
        kind: "image",
        source: "text",
        absolutePath: "F:\\repo\\assets\\sample.png",
        displayPath: "assets/sample.png",
        workspaceRelativePath: "assets/sample.png",
        isOutsideWorkspace: false,
      },
    ]);

    assert.deepEqual(attachments, [
      {
        type: "file",
        path: "F:\\repo\\assets\\sample.png",
        displayName: "assets/sample.png",
      },
    ]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Copilotの共通Character promptはsession systemMessageへ渡し、timingとuser入力・添付から分離する"
  // oracle = { type = "contract", ref = "docs/design/prompt-composition.md" }
  // fault = "共通Character promptをsystemMessageで落とすか、timing・user入力との境界を混同する"
  // observable = "Copilot adapterのcomposePrompt結果とsession configのsystemMessage"
  // observation_boundary = "consumer"
  // scope = "copilot-system-message"
  // lifecycle = "permanent"
  // impact = "CopilotがCharacterの現行定義を受け取れないか、可変contextの配置を誤る"
  // distinction = "composer単体ではなくCopilotのsession設定へ渡す値を実際のcompose経路から確認する"
  // @end-test-value
  /** Copilot は固定指示をシステム設定に追記し、固定指示が消去されるとキャッシュキーを切り替える。 */
  it("固定指示とCharacterをCopilot systemMessageへ渡し、現在日時はinput側に留める", () => {
    const input = {
      ...createRunSessionInput(),
      sessionInstructions: "Copilot 固定指示 🧭",
    };
    input.session.characterRuntimeSnapshot = {
      characterId: "char-a",
      name: "A",
      description: "Saved metadata",
      iconFilePath: "C:/Character Data/キャラ/icon.png",
      theme: input.session.characterThemeColors,
      definitionMarkdown: "あなたは頼れる相棒です。",
      definitionSha256: "definition",
      definitionByteSize: 48,
      snapshotAt: "2026-10-03T00:00:00Z",
    };
    input.currentDateTime = "2026-08-04T21:32:00+09:00";
    const adapter = new CopilotAdapter();
    const prompt = adapter.composePrompt(input);
    const { config, settingsKey } = buildCopilotSessionSettings(
      input,
      prompt,
      "client-key",
      resolveCustomAgents,
    );
    const cleared = { ...input, sessionInstructions: "" };
    const clearedSettings = buildCopilotSessionSettings(
      cleared,
      adapter.composePrompt(cleared),
      "client-key",
      resolveCustomAgents,
    );

    assert.deepEqual(config.systemMessage, {
      mode: "append",
      content: prompt.systemBodyText,
    });
    assert.match(
      config.systemMessage?.content ?? "",
      /あなたは頼れる相棒です。/,
    );
    assert.match(
      config.systemMessage?.content ?? "",
      /# Session Instructions\n\nCopilot 固定指示 🧭$/,
    );
    assert.doesNotMatch(
      clearedSettings.config.systemMessage?.content ?? "",
      /# Session Instructions/,
    );
    assert.notEqual(clearedSettings.settingsKey, settingsKey);
    assert.doesNotMatch(
      config.systemMessage?.content ?? "",
      /Current Date|2026-08-04|# User Input/,
    );
    assert.match(
      prompt.inputBodyText,
      /# Current Date[\s\S]*# User Input\n\nhello/,
    );
    assert.deepEqual(buildCopilotMessageAttachments(input.attachments), []);
    assert.deepEqual(prompt.imagePaths, []);
  });

  /** 利用枠の残率を 0–1 から百分率へ直し、件数・超過・更新日の情報を保持する。 */
  it("quota snapshot は Copilot の 0-1 percentage を 0-100 表示用へ正規化する", () => {
    const snapshots = toProviderQuotaSnapshots({
      premium_interactions: {
        entitlementRequests: 500,
        usedRequests: 125,
        remainingPercentage: 0.75,
        overage: 0,
        overageAllowedWithExhaustedQuota: false,
        resetDate: "2026-04-01T00:00:00.000Z",
      },
    });

    assert.deepEqual(snapshots, [
      {
        quotaKey: "premium_interactions",
        entitlementRequests: 500,
        usedRequests: 125,
        remainingPercentage: 75,
        overage: 0,
        overageAllowedWithExhaustedQuota: false,
        resetDate: "2026-04-01T00:00:00.000Z",
      },
    ]);
  });

  /** 測定時刻とプロバイダー識別子を付け、正規化した利用枠をテレメトリーに載せる。 */
  it("quota snapshot から provider telemetry を組み立てる", () => {
    const telemetry = buildCopilotProviderQuotaTelemetry(
      "copilot",
      {
        premium_interactions: {
          entitlementRequests: 420,
          usedRequests: 118,
          remainingPercentage: 0.719,
          overage: 0,
          overageAllowedWithExhaustedQuota: false,
          resetDate: "2026-04-01T00:00:00.000Z",
        },
      },
      "2026-03-25T08:00:00.000Z",
    );

    assert.deepEqual(telemetry, {
      provider: "copilot",
      updatedAt: "2026-03-25T08:00:00.000Z",
      snapshots: [
        {
          quotaKey: "premium_interactions",
          entitlementRequests: 420,
          usedRequests: 118,
          remainingPercentage: 71.89999999999999,
          overage: 0,
          overageAllowedWithExhaustedQuota: false,
          resetDate: "2026-04-01T00:00:00.000Z",
        },
      ],
    });
  });

  /** SDK の usage_info を Session 別のコンテキスト使用量に写し、総量と内訳を保持する。 */
  it("session usage_info から context telemetry を組み立てる", () => {
    const telemetry = buildCopilotSessionContextTelemetry(
      "copilot",
      "session-1",
      {
        tokenLimit: 200000,
        currentTokens: 18420,
        messagesLength: 26,
        systemTokens: 840,
        conversationTokens: 17110,
        toolDefinitionsTokens: 470,
      },
      "2026-03-25T08:05:00.000Z",
    );

    assert.deepEqual(telemetry, {
      provider: "copilot",
      sessionId: "session-1",
      updatedAt: "2026-03-25T08:05:00.000Z",
      tokenLimit: 200000,
      currentTokens: 18420,
      messagesLength: 26,
      systemTokens: 840,
      conversationTokens: 17110,
      toolDefinitionsTokens: 470,
    });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "reasoning deltaと確定reasoningをlive本文へ投影し操作結果へ混入しない"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
  // fault = "reasoningを二重連結またはコマンドへ誤分類する"
  // observable = "live reasoning文字列と操作配列"
  // observation_boundary = "component-behavior"
  // scope = "Copilot reasoning projection"
  // lifecycle = "permanent"
  // impact = "利用者が誤った推論表示やコマンド表示を見る"
  // distinction = "SDK型だけではreasoning eventの投影先と重複を確認できない"
  // @end-test-value
  /** 推論の差分と確定イベントが同じ本文を重複させず、コマンド一覧や操作履歴へ混ざらないことを確認する。 */
  it("assistant.reasoning_delta / assistant.reasoning は live reasoning text にだけ変換する", () => {
    const events = [
      {
        type: "assistant.reasoning_delta",
        timestamp: "2026-03-23T00:00:00.000Z",
        ephemeral: true,
        data: {
          reasoningId: "reasoning-1",
          deltaContent: "調査して",
        },
      },
      {
        type: "assistant.reasoning_delta",
        timestamp: "2026-03-23T00:00:01.000Z",
        ephemeral: true,
        data: {
          reasoningId: "reasoning-1",
          deltaContent: "から実装する",
        },
      },
      {
        type: "assistant.reasoning",
        timestamp: "2026-03-23T00:00:02.000Z",
        data: {
          reasoningId: "reasoning-1",
          content: "調査してから実装する",
        },
      },
    ] as never[];

    assert.deepEqual(
      collectCopilotLiveStepsFromEventsForTesting(events, "F:/repo"),
      [],
    );
    assert.deepEqual(
      collectCopilotMessageOperationsFromEventsForTesting(events, "F:/repo"),
      [],
    );
    assert.equal(
      collectCopilotReasoningTextFromEventsForTesting(events, "F:/repo"),
      "調査してから実装する",
    );
  });

  /** 未知イベントのログは分類と payload の有無・型だけ示し、payload 自体は含めない。 */
  it("未対応 Copilot event の app log metadata は payload を含めない", () => {
    const metadata = buildCopilotProviderMetadata([
      {
        type: "new.event",
        timestamp: "2026-03-23T00:00:00.000Z",
        data: {
          token: "secret",
        },
      },
    ]);

    assert.equal(metadata.length, 1);
    assert.deepEqual(toProviderMetadataLogData(metadata[0]!), {
      provider: "copilot",
      kind: "unsupported_event",
      source: "copilot.session_event",
      eventType: "new.event",
      summary: "Unsupported Copilot event: new.event",
      payloadPresent: true,
      payloadRedacted: true,
      payloadType: "object",
    });
    assert.equal("payload" in toProviderMetadataLogData(metadata[0]!), false);
  });

  /** idle に到達したら未完了の agent と shell を片付け、完了済み agent の表示は保持する。 */
  it("session.idle で実行中の background task を掃除する", () => {
    /** 実イベント適用関数が受け取る背景タスクのマップ型を参照する。 */
    type BackgroundTasksMap = Parameters<
      typeof applyCopilotBackgroundTaskEvent
    >[0];
    /** 検証用タスクが実装のマップ要素と同じ型になるよう抽出する。 */
    type LiveBackgroundTask =
      BackgroundTasksMap extends Map<string, infer Task> ? Task : never;

    const tasks = new Map<string, LiveBackgroundTask>([
      [
        "agent:agent-1",
        {
          id: "agent:agent-1",
          kind: "agent",
          status: "running",
          title: "設計を調べる",
          updatedAt: "2026-04-04T11:59:00.000Z",
        },
      ],
      [
        "shell:shell-1",
        {
          id: "shell:shell-1",
          kind: "shell",
          status: "running",
          title: "npm test --watch",
          updatedAt: "2026-04-04T11:59:30.000Z",
        },
      ],
      [
        "agent:agent-completed",
        {
          id: "agent:agent-completed",
          kind: "agent",
          status: "completed",
          title: "完了済み agent",
          updatedAt: "2026-04-04T11:58:00.000Z",
        },
      ],
    ]);

    const changed = applyCopilotBackgroundTaskEvent(tasks, {
      type: "session.idle",
      timestamp: "2026-04-04T12:00:00.000Z",
      data: {},
    } as never);

    assert.equal(changed, true);
    assert.deepEqual(
      sortLiveBackgroundTasks(tasks.values()).map((task) => ({
        kind: task.kind,
        status: task.status,
        title: task.title,
      })),
      [{ kind: "agent", status: "completed", title: "完了済み agent" }],
    );
  });

  /** 先に idle になった agent を完了通知の同じ ID で更新し、説明・詳細と更新時刻を保持する。 */
  it("system.notification で background agent の完了状態を更新する", () => {
    const tasks = new Map();
    applyCopilotBackgroundTaskEvent(tasks, {
      type: "system.notification",
      timestamp: "2026-04-04T12:00:00.000Z",
      data: {
        content: "<system_notification>idle</system_notification>",
        kind: {
          type: "agent_idle",
          agentId: "agent-1",
          agentType: "task",
          description: "設計を調べる",
        },
      },
    } as never);

    const changed = applyCopilotBackgroundTaskEvent(tasks, {
      type: "system.notification",
      timestamp: "2026-04-04T12:05:00.000Z",
      data: {
        content: "<system_notification>completed</system_notification>",
        kind: {
          type: "agent_completed",
          agentId: "agent-1",
          agentType: "task",
          status: "completed",
          description: "設計を調べる",
          prompt: "repo を調べて要点をまとめる",
        },
      },
    } as never);

    assert.equal(changed, true);
    assert.deepEqual(tasks.get("agent:agent-1"), {
      id: "agent:agent-1",
      kind: "agent",
      status: "completed",
      title: "設計を調べる",
      details: "repo を調べて要点をまとめる",
      updatedAt: "2026-04-04T12:05:00.000Z",
    });
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "MCP elicitation schema の選択肢と制約を共通live fieldへ保持する"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
  // fault = "Provider別変換の欠落でoneOf・anyOf・scalar制約がlive fieldから失われる"
  // observable = "buildLiveElicitationFieldFromMcpSchemaの返却field"
  // observation_boundary = "component-behavior"
  // scope = "MCP elicitation field conversion"
  // lifecycle = "permanent"
  // @end-test-value
  /** enum と oneOf の選択肢、anyOf の複数選択、整数の制約を共通フォーム欄に落とさず写す。 */
  it("MCP elicitation schema の enum / oneOf / anyOf / number を共通live fieldへ正規化する", () => {
    assert.deepEqual(
      buildLiveElicitationFieldFromMcpSchema(
        "environment",
        {
          type: "string",
          title: "Environment",
          enum: ["dev", "prod"],
          enumNames: ["Development", "Production"],
          default: "dev",
        },
        true,
      ),
      {
        type: "select",
        name: "environment",
        title: "Environment",
        description: undefined,
        required: true,
        options: [
          { value: "dev", label: "Development" },
          { value: "prod", label: "Production" },
        ],
        defaultValue: "dev",
      },
    );
    assert.deepEqual(
      buildLiveElicitationFieldFromMcpSchema(
        "targets",
        {
          type: "array",
          title: "Targets",
          minItems: 1,
          items: {
            anyOf: [
              { const: "web", title: "Web" },
              { const: "desktop", title: "Desktop" },
            ],
          },
        },
        false,
      ),
      {
        type: "multi-select",
        name: "targets",
        title: "Targets",
        description: undefined,
        required: false,
        options: [
          { value: "web", label: "Web" },
          { value: "desktop", label: "Desktop" },
        ],
        defaultValue: undefined,
        minItems: 1,
        maxItems: undefined,
      },
    );
    assert.deepEqual(
      buildLiveElicitationFieldFromMcpSchema(
        "retries",
        {
          type: "integer",
          title: "Retries",
          minimum: 0,
          maximum: 3,
          default: 1,
        },
        false,
      ),
      {
        type: "number",
        numberKind: "integer",
        name: "retries",
        title: "Retries",
        description: undefined,
        required: false,
        defaultValue: 1,
        minimum: 0,
        maximum: 3,
      },
    );
    assert.deepEqual(
      buildLiveElicitationFieldFromMcpSchema(
        "destination",
        {
          type: "string",
          title: "Destination",
          oneOf: [
            { const: "local", title: "Local machine" },
            { const: "remote", title: "Remote host" },
          ],
          default: "local",
        },
        true,
      ),
      {
        type: "select",
        name: "destination",
        title: "Destination",
        description: undefined,
        required: true,
        options: [
          { value: "local", label: "Local machine" },
          { value: "remote", label: "Remote host" },
        ],
        defaultValue: "local",
      },
    );
  });

  /** native のフォーム要求を、元の要求 ID・サーバー識別子と必須／任意の入力欄を持つ live 要求へ変換する。 */
  it("elicitation.requested event を live elicitation request へ変換する", () => {
    const request = buildLiveElicitationRequestFromCopilotEvent("copilot", {
      type: "elicitation.requested",
      data: {
        requestId: "elic-1",
        elicitationSource: "server-a",
        message: "入力してね",
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: {
            projectName: {
              type: "string",
              title: "Project Name",
              minLength: 3,
            },
            confirm: {
              type: "boolean",
              title: "Confirm",
              default: true,
            },
          },
          required: ["projectName"],
        },
      },
    } as never);

    assert.deepEqual(request, {
      requestId: "elic-1",
      provider: "copilot",
      mode: "form",
      message: "入力してね",
      source: "server-a",
      fields: [
        {
          type: "text",
          name: "projectName",
          title: "Project Name",
          description: undefined,
          required: true,
          defaultValue: undefined,
          minLength: 3,
          maxLength: undefined,
          format: undefined,
        },
        {
          type: "boolean",
          name: "confirm",
          title: "Confirm",
          description: undefined,
          required: false,
          defaultValue: true,
        },
      ],
      url: undefined,
    });
  });
});

// @test-value v2
// kind = "invariant"
// claim = "Copilot 多数eventでもunsupported event metadataとassistant全本文を独立して保持する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "多数eventでunsupported metadataまたは本文を失う"
// observable = "実turn resultのproviderMetadata eventTypeとpayload、assistant全文"
// observation_boundary = "public-boundary"
// scope = "Copilot stream owner and final result"
// lifecycle = "permanent"
// impact = "長いturnで履歴の未対応event説明やユーザー応答を失う"
// distinction = "stable raw helperのみではstream metadataの独立保持とfinal接続を確認できない"
// @end-test-value
/** 大きなイベントが連続しても、最終応答本文を省略せず、未対応イベントの種別と時刻を別に保持する。 */
it("Copilot 多数eventでもnative metadataと全本文を保持する", async () => {
  const listeners = new Set<(event: SessionEvent) => void>();
  const body = "answer".repeat(20000);
  /** 多数のイベントを決まった順番で送出する native Session を用意する。 */
  const session = {
    sessionId: "bounded",
    rpc: createInteractionRpc(),
    /** 大量イベントを受け取る listener を登録し、処理後に解除できるようにする。 */
    on(listener: (event: SessionEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 大型ツール結果の連続後に未対応イベントと長い最終本文を配信する。 */
    async send() {
      /** 合成したイベントを現在の購読先へ届ける。 */
      const emit = (event: unknown) => {
        for (const listener of listeners) listener(event as SessionEvent);
      };
      for (let index = 0; index < 16; index++)
        emit({
          type: "tool.execution_complete",
          timestamp: "2026-10-05T00:00:00.000Z",
          data: {
            toolCallId: String(index),
            success: true,
            result: { content: "x".repeat(100000) },
          },
        });
      emit({
        type: "native.unsupported",
        timestamp: "2026-10-05T00:00:00.000Z",
        data: { irrelevant: "not retained" },
      });
      emit({
        type: "assistant.message",
        data: { messageId: "answer", content: body },
      });
      emit({ type: "session.idle", data: {} });
    },
    /** 大量イベントの正常終了では実 SDK の取消処理を行わない。 */
    async abort() {},
  };
  const adapter = new CopilotAdapter() as unknown as {
    /** イベントを生成する native Session をテストへ差し替える。 */
    getSession(): Promise<unknown>;
    /** 外部の利用枠問い合わせをテストから除外する。 */
    fetchProviderQuotaTelemetry(): Promise<null>;
    /** 再接続を介さず、実イベント取り込みと結果生成を一回実行する。 */
    runSessionTurnOnce(
      input: RunSessionTurnInput,
      prompt: ProviderPromptComposition,
    ): Promise<RunSessionTurnResult>;
  };
  adapter.getSession = async () => ({
    session,
    selection: {
      requestedModel: "gpt-4.1",
      requestedReasoningEffort: "high",
      resolvedModel: "gpt-4.1",
      resolvedReasoningEffort: "high",
    },
  });
  adapter.fetchProviderQuotaTelemetry = async () => null;
  const completed = await adapter.runSessionTurnOnce(
    createRunSessionInput(),
    EMPTY_PROMPT,
  );
  assert.equal(completed.assistantText, body);
  const unsupported = completed.providerMetadata?.filter(
    (metadata) => metadata.kind === "unsupported_event",
  );
  assert.deepEqual(
    unsupported?.map((metadata) => metadata.eventType),
    ["native.unsupported"],
  );
  assert.deepEqual(unsupported?.[0]?.payload, {
    type: "native.unsupported",
    timestamp: "2026-10-05T00:00:00.000Z",
  });
});

// @test-value v2
// kind = "invariant"
// claim = "Copilot final projectionはbinding referenceをassistantと通常artifactから除去する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "binding referenceがassistant本文または操作結果へ漏れる"
// observable = "runSessionTurnのassistantText・artifact・providerMetadata"
// observation_boundary = "public-boundary"
// scope = "Copilot final projectionはbinding reference"
// lifecycle = "permanent"
// impact = "binding referenceが利用者表示または通常履歴へ漏れる"
// distinction = "bootstrap失敗projectionでは通常final projectionを観測しない"
// @end-test-value
/** 合成 binding 参照が最終本文と通常操作履歴のどちらにも残らず、秘匿マーカーで置換されることを確認する。 */
it("Copilot final projectionはbinding referenceを通常履歴から除去する", async () => {
  const bindingReference = "opaque-reference-copilot-redaction-probe";
  const input = createRunSessionInput({
    agentRuntimeBinding: {
      bindingId: "binding-redaction",
      bindingReference,
      providerId: "copilot",
      executionGeneration: "generation-redaction",
      transport: "env",
      expiresAt: null,
    },
  });
  const listeners = new Set<(event: SessionEvent) => void>();
  /** 本文とツール結果の両方に同じ検証用参照を差し込む native Session を作る。 */
  const session = {
    sessionId: "thread-redaction",
    rpc: createInteractionRpc(),
    /** 秘匿対象を含むイベントの購読と解除を模擬する。 */
    on(listener: (event: SessionEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 同じ参照を含むツール結果と最終本文を送ってから idle にする。 */
    async send() {
      /** 登録先へ合成したイベントを順に配信する。 */
      const emit = (event: unknown) => {
        for (const listener of listeners) listener(event as SessionEvent);
      };
      emit({
        type: "tool.execution_start",
        data: {
          toolCallId: "command-1",
          toolName: "shell",
          arguments: { command: "env" },
        },
      });
      emit({
        type: "tool.execution_complete",
        data: {
          toolCallId: "command-1",
          success: true,
          result: { content: `secret=${bindingReference}` },
        },
      });
      emit({
        type: "assistant.message",
        data: { messageId: "message-1", content: `answer ${bindingReference}` },
      });
      emit({ type: "session.idle", data: {} });
      return "sent";
    },
  };
  const adapter = new CopilotAdapter();
  (
    adapter as unknown as {
      /** 秘匿対象を送る native Session を実 adapter の取得口へ差し込む。 */
      getSession(): Promise<unknown>;
    }
  ).getSession = async () => ({
    session,
    selection: {
      requestedModel: input.session.model,
      resolvedModel: input.session.model,
      requestedReasoningEffort: input.session.reasoningEffort,
      resolvedReasoningEffort: input.session.reasoningEffort,
    },
  });
  const result = await adapter.runSessionTurn(input);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(bindingReference));
  assert.match(
    result.assistantText,
    new RegExp(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER),
  );
  assert.match(
    result.artifact!.operationTimeline![0].details!,
    new RegExp(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER),
  );
});

// @test-value v2
// kind = "contract"
// claim = "bootstrap失敗でopaque binding referenceを返却errorと診断metadataから秘匿する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "SDK bootstrap errorを未秘匿で返す"
// observable = "ProviderTurnErrorとpartialResult providerMetadata"
// observation_boundary = "component-behavior"
// scope = "Copilot bootstrap diagnostic redaction"
// lifecycle = "permanent"
// impact = "runtime権限に関連する秘密を診断から漏らす"
// distinction = "正常turn redactor testはbootstrap前の異常経路を通らない"
// @end-test-value
/** bootstrap 失敗の例外本文と部分結果の診断メタデータを確認し、どちらにも生の binding 参照を残さない。 */
it("Copilot bootstrap失敗診断はbinding referenceを除去する", async () => {
  const bindingReference = "opaque-reference-copilot-bootstrap-redaction-probe";
  const input = createRunSessionInput({
    agentRuntimeBinding: {
      bindingId: "binding-bootstrap-redaction",
      bindingReference,
      providerId: "copilot",
      executionGeneration: "generation-bootstrap-redaction",
      transport: "env",
      expiresAt: null,
    },
  });
  const adapter = new CopilotAdapter() as unknown as {
    /** bootstrap の結果を毎回失敗として返せるようにする。 */
    getSession(): Promise<never>;
    /** 実 adapter の失敗時の戻り値と例外を確認する入口。 */
    runSessionTurn(
      inputValue: RunSessionTurnInput,
    ): Promise<RunSessionTurnResult>;
  };
  adapter.getSession = async () => {
    throw new Error(`bootstrap failed: ${bindingReference}`);
  };

  await assert.rejects(
    () => adapter.runSessionTurn(input),
    (error: unknown) => {
      assert.ok(error instanceof ProviderTurnError);
      assert.doesNotMatch(error.message, new RegExp(bindingReference));
      assert.match(
        error.message,
        new RegExp(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER),
      );
      assert.doesNotMatch(
        JSON.stringify(error.partialResult.providerMetadata),
        new RegExp(bindingReference),
      );
      assert.match(
        JSON.stringify(error.partialResult.providerMetadata),
        new RegExp(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER),
      );
      return true;
    },
  );
});

// @test-value v2
// kind = "invariant"
// claim = "Copilot tool errorのmessage/codeはpreview境界の前後でも全文秘匿され、liveと正常・失敗・取消のartifactへ有限な取得結果として渡る"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#Session Flow; src-electron/session/provider-payload-limits.ts#PROVIDER_TEXT_PREVIEW_LIMIT" }
// fault = "tool errorを秘匿前に切り詰めてbinding referenceの末尾欠け断片をliveまたはartifactに漏らす、または通常errorを消す"
// observable = "runSessionTurnのprogress stepsと返却artifact/ProviderTurnError.partialResult.artifactのerror.message/code・details・status"
// observation_boundary = "public-boundary"
// scope = "Copilot SDK tool.execution_completeからliveおよびcompleted/failed/canceled通常artifactへの投影"
// lifecycle = "permanent"
// impact = "runtime権限に関わるsecretが利用者表示・保存履歴へ漏れ、取得済みエラー内容が失われる"
// distinction = "既存final秘匿testは完全なsecretだけを観測し、preview境界の断片漏洩やlive error/codeを検出しない。外部接続なしの有限event列でこの秘匿契約を確認できる"
// risk_tags = ["privacy"]
// @end-test-value
/** ツールエラーを秘匿してから preview を生成し、通常・失敗・取消の結果と live 表示の両方で参照の断片を残さない。元の SDK イベントは変更しない。 */
it("Copilot tool errorは秘匿後にpreview化しliveと全terminal artifactを保護する", async () => {
  const limit = 65536;
  const secret = "opaque-reference-copilot-error-boundary-probe";
  const errorTexts = [
    "ordinary tool error",
    "x".repeat(limit - secret.length - 1) + secret + " tail",
    "x".repeat(limit - secret.length + 1) + secret + " tail",
    "x".repeat(limit + 1) + secret + " tail",
  ];
  for (const outcome of ["completed", "failed", "canceled"] as const) {
    const input = createRunSessionInput({
      customAgentName: "",
      agentRuntimeBinding: {
        bindingId: "binding-error-boundary",
        bindingReference: secret,
        providerId: "copilot",
        executionGeneration: "generation-error-boundary",
        transport: "env",
        expiresAt: null,
      },
    });
    const listeners = new Set<(event: SessionEvent) => void>();
    const sourceEvents: SessionEvent[] = [];
    const liveOperations = new Map<string, LiveRunStep>();
    /** preview 上限の前後に参照を置くエラーイベント用の native Session を作る。 */
    const session = {
      sessionId: "thread-error-boundary",
      rpc: createInteractionRpc(),
      /** 秘匿検証用イベントを受け取る listener の登録と解除を模擬する。 */
      on(listener: (event: SessionEvent) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      /** エラーを全件配信した後、テストケースに応じて正常終了・失敗・取消を再現する。 */
      async send() {
        /** イベントを購読先へ渡すとともに、元の入力が改変されないか照合できるよう参照を保存する。 */
        const emit = (type: string, data: Record<string, unknown>) => {
          const event = { type, data } as SessionEvent;
          sourceEvents.push(event);
          for (const listener of listeners) listener(event);
        };
        for (const [index, text] of errorTexts.entries()) {
          const toolCallId = `error-${index}`;
          emit("tool.execution_start", {
            toolCallId,
            toolName: "shell",
            arguments: { command: "synthetic check" },
          });
          emit("tool.execution_complete", {
            toolCallId,
            success: false,
            error: { message: text, code: text },
          });
        }
        if (outcome !== "completed")
          throw new Error(
            outcome === "canceled"
              ? "Abort requested"
              : "synthetic turn failed",
          );
        emit("session.idle", {});
        return "sent";
      },
    };
    const adapter = new CopilotAdapter();
    (
      adapter as unknown as {
        /** 実 adapter が境界長のツールエラーを含む合成 Session を使うよう差し替える。 */
        getSession(): Promise<unknown>;
      }
    ).getSession = async () => ({
      session,
      selection: {
        requestedModel: "gpt-4.1",
        resolvedModel: "gpt-4.1",
        requestedReasoningEffort: "high",
        resolvedReasoningEffort: "high",
      },
    });
    let result: RunSessionTurnResult;
    try {
      result = await adapter.runSessionTurn(input, (state, changes) => {
        assert.ok(
          !JSON.stringify(state).includes(secret.slice(0, -1)),
          "live snapshot leaked a secret fragment",
        );
        for (const step of changes.steps.upserts)
          liveOperations.set(step.id, step);
      });
      assert.equal(outcome, "completed");
    } catch (error) {
      assert.ok(error instanceof ProviderTurnError);
      assert.notEqual(outcome, "completed");
      assert.equal(error.canceled, outcome === "canceled");
      result = error.partialResult;
    }
    const operations = result.artifact!.operationTimeline!;
    assert.equal(operations.length, errorTexts.length);
    assert.ok(
      !JSON.stringify(result.artifact).includes(secret.slice(0, -1)),
      "artifact leaked a secret fragment",
    );
    for (const [index, rawText] of errorTexts.entries()) {
      const sanitized = rawText.replace(
        secret,
        PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER,
      );
      const expected =
        sanitized.length <= limit
          ? sanitized
          : `${sanitized.slice(0, limit)}\n...[truncated ${sanitized.length - limit} chars; originalLength=${sanitized.length}]`;
      const live = liveOperations.get(`error-${index}`);
      assert.ok(live, "tool completion did not reach live progress");
      for (const operation of [live, operations[index]]) {
        assert.equal(operation.status, "failed");
        assert.deepEqual(operation.error, {
          message: expected,
          code: expected,
        });
        assert.equal(operation.details, expected);
        assert.ok(operation.error!.message.length <= limit + 100);
      }
      const source = sourceEvents.find(
        (event) =>
          event.type === "tool.execution_complete" &&
          event.data.toolCallId === `error-${index}`,
      );
      assert.ok(source?.type === "tool.execution_complete");
      assert.deepEqual(
        source.data.error,
        { message: rawText, code: rawText },
        "SDK event was mutated",
      );
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Copilotは正常結果と取消partialで長文全文・操作結果・未対応event診断を保持しbinding referenceを秘匿する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "長文本文や取得済み操作結果を失う、未対応event診断を落とす、またはbinding referenceをartifact/診断へ残す"
// observable = "正常結果と取消partialResultのassistantText全文・最終非空本文・artifact操作件数/details・秘匿済みproviderMetadata"
// observation_boundary = "public-boundary"
// scope = "copilot-coding-turn long text, partial artifact and diagnostic redaction"
// lifecycle = "permanent"
// impact = "未対応eventの診断情報や取得済み応答が失われ、binding secretが履歴へ漏れる"
// distinction = "helper単体や通常cancelのtestは多数event後の長文全文・操作結果・未対応event診断の秘匿を同じ結果境界で観測しない"
// risk_tags = ["privacy"]
// @end-test-value
/** 長い応答を含む正常結果と取消時の部分結果に、全本文・操作の取得結果・秘匿済みの診断を残す。 */
it("Copilot 長文でもmetadataと正常・cancel partialを保持する", async () => {
  for (const canceled of [false, true]) {
    const input = createRunSessionInput({ customAgentName: "" });
    const secret = input.agentRuntimeBinding!.bindingReference;
    const listeners = new Set<(event: SessionEvent) => void>();
    let rawEventCount = 0;
    /** イベント ID を割り当て、永続イベントだけを数えながら購読者へ順に配信する。 */
    const emit = (
      type: string,
      data: Record<string, unknown>,
      ephemeral = false,
    ) => {
      const event = {
        id: `event-${rawEventCount}`,
        type,
        timestamp: "2026-10-05T00:00:00Z",
        data,
        ephemeral,
      } as SessionEvent;
      if (!ephemeral && !type.endsWith("_delta")) rawEventCount += 1;
      for (const listener of listeners) listener(event);
    };
    const body = `本文${"あ😀".repeat(180_000)}`;
    const session = {
      sessionId: "raw-retention-thread",
      rpc: createInteractionRpc(),
      /** 本文とメタデータを取り込む listener を登録し、解除用関数を返す。 */
      on(listener: (event: SessionEvent) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      /** 多数のメッセージ、操作結果、長い最終本文を流し、正常終了と取消の両経路を作る。 */
      async send() {
        for (let index = 0; index < 100; index += 1) {
          emit("user.message", {
            content: `${index}:あ😀\"\n${secret.repeat(2000)}`,
          });
        }
        emit("dropped.ephemeral", {}, true);
        emit("assistant.message_delta", {
          messageId: "last",
          deltaContent: "delta",
        });
        emit(`custom.event.${secret}`, {});
        emit("tool.execution_start", {
          toolCallId: "check",
          toolName: "shell",
          arguments: { command: "npm test" },
        });
        emit("tool.execution_complete", {
          toolCallId: "check",
          success: true,
          result: { content: "passed" },
        });
        emit("assistant.message", { messageId: "last", content: body });
        if (canceled) throw new Error("Abort requested");
        emit("session.idle", {});
        return "sent";
      },
    };
    const adapter = new CopilotAdapter() as unknown as {
      /** 長文と診断を生成するテスト用 SDK Session を選択情報とともに返す。 */
      getSession(): Promise<{
        session: CopilotSession;
        selection: ResolvedModelSelection;
        client: CopilotClient;
        clientKey: string;
      }>;
      /** 公開の実行経路から完了結果または取消時の部分結果を読む。 */
      runSessionTurn(value: RunSessionTurnInput): Promise<RunSessionTurnResult>;
    };
    adapter.getSession = async () => ({
      session: session as unknown as CopilotSession,
      client: {} as CopilotClient,
      clientKey: "fixture",
      selection: {
        requestedModel: "gpt-4.1",
        resolvedModel: "gpt-4.1",
        requestedReasoningEffort: "high",
        resolvedReasoningEffort: "high",
      },
    });
    let completed: RunSessionTurnResult;
    try {
      completed = await adapter.runSessionTurn(input);
      assert.equal(canceled, false);
    } catch (error) {
      assert.ok(
        canceled && error instanceof ProviderTurnError && error.canceled,
      );
      completed = error.partialResult;
    }
    assert.equal(completed.assistantText, body);
    assert.equal(completed.lastNonEmptyAssistantMessageText, body);
    assert.equal(completed.artifact!.operationTimeline!.length, 1);
    assert.equal(completed.artifact!.operationTimeline![0].details, "passed");
    assert.equal(completed.artifact?.operationTimeline?.length, 1);
    assert.ok(!JSON.stringify(completed.artifact).includes(secret));
    assert.deepEqual(completed.providerMetadata, [
      {
        provider: "copilot",
        kind: "unsupported_event",
        source: "copilot.session_event",
        eventType: `custom.event.${PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER}`,
        summary: `Unsupported Copilot event: custom.event.${PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER}`,
        payload: {
          type: `custom.event.${PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER}`,
          timestamp: "2026-10-05T00:00:00Z",
        },
      },
    ]);
  }
});

// @test-value v2
// kind = "contract"
// claim = "Copilotのturn完了は背景quota取得の完了を待たない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "完了経路でquota取得をawaitしてturnが停止する"
// observable = "quota取得未完了でも返るturn resultとquota取得回数"
// observation_boundary = "public-boundary"
// scope = "Copilot turn completion"
// lifecycle = "permanent"
// @end-test-value
/** native Session の完了後、実行結果が背景の利用枠取得を始めずに返ることを確認する。 */
it("Session完了後のquota telemetry停止はturn resultを待たせない", async () => {
  const input = createRunSessionInput();
  const prompt = EMPTY_PROMPT;
  const listeners = new Set<
    (event: { type: string; data: Record<string, unknown> }) => void
  >();
  const session = {
    sessionId: "thread-quota-background",
    rpc: createInteractionRpc(),
    /** idle を受け取るテスト用 listener を登録・解除する。 */
    on(
      listener: (event: {
        type: string;
        data: Record<string, unknown>;
      }) => void,
    ) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 送信直後に idle を通知し、利用枠取得と独立した完了を再現する。 */
    async send() {
      for (const listener of listeners) {
        listener({ type: "session.idle", data: {} });
      }
    },
    /** 正常終了だけのフィクスチャなので abort は副作用を起こさない。 */
    async abort() {},
  };
  let quotaFetchCalls = 0;
  const adapter = new CopilotAdapter() as unknown as {
    /** idle を直ちに通知する SDK Session に実接続を差し替える。 */
    getSession(): Promise<{
      session: typeof session;
      selection: ResolvedModelSelection;
    }>;
    /** 呼び出した場合は完了しない利用枠取得を注入する。 */
    fetchProviderQuotaTelemetry(): Promise<never>;
    /** 正常終了時に確認できる固定の Turn 結果を供給する。 */
    buildTurnResult(): Promise<RunSessionTurnResult>;
    /** 再試行を経由せず一回の adapter 実行を完了まで進める。 */
    runSessionTurnOnce(
      inputValue: RunSessionTurnInput,
      promptValue: ProviderPromptComposition,
    ): Promise<RunSessionTurnResult>;
  };
  adapter.getSession = async () => ({
    session,
    selection: {
      requestedModel: "gpt-4.1",
      requestedReasoningEffort: "high",
      resolvedModel: "gpt-4.1",
      resolvedReasoningEffort: "high",
      modelFallbackApplied: false,
      reasoningFallbackApplied: false,
    },
  });
  adapter.fetchProviderQuotaTelemetry = () => {
    quotaFetchCalls += 1;
    return new Promise<never>(() => undefined);
  };
  adapter.buildTurnResult = async () =>
    createPartialResult({
      threadId: session.sessionId,
      assistantText: "完了",
    });

  const outcome = await Promise.race([
    adapter.runSessionTurnOnce(input, prompt),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 50),
    ),
  ]);

  assert.notEqual(outcome, "timeout");
  assert.equal(quotaFetchCalls, 0);
  assert.equal((outcome as RunSessionTurnResult).assistantText, "完了");
});

/** Copilot SDK の実行設定、許可の判断、設定変更に伴う接続の再利用を確認する。 */
describe("CopilotAdapter session settings", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "Copilot effort変換はSDK対応値を保持し省略を許可し非対応値を別の値へ置換しない"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
  // fault = "maxを拒否するかminimalをlowへ暗黙変換する"
  // observable = "toCopilotReasoningEffortの戻り値と拒否"
  // observation_boundary = "public-boundary"
  // scope = "Copilot SDK effort conversion"
  // lifecycle = "permanent"
  // @end-test-value
  /** SDK が対応する max はそのまま渡し、空指定は省略し、ultra と minimal を別の値に変換せず拒否する。 */
  it("native effortと省略を保持しSDK未対応値は置換せず拒否する", () => {
    assert.equal(toCopilotReasoningEffort("max"), "max");
    assert.equal(toCopilotReasoningEffort(""), undefined);
    assert.throws(() => toCopilotReasoningEffort("ultra"), /ultra/);
    assert.throws(() => toCopilotReasoningEffort("minimal"), /minimal/);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Depth未指定のCopilot turnはSDK configへreasoningEffortを送らない"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
  // fault = "空文字のDepthをSDKへ明示値として送る"
  // observable = "buildCopilotSessionSettingsのSDK config property"
  // observation_boundary = "public-boundary"
  // scope = "Copilot omitted Depth"
  // lifecycle = "permanent"
  // @end-test-value
  /** 送信時に Depth を空指定した場合、SDK 設定に reasoningEffort のキーを含めない。 */
  it("Depth未指定はCopilot SDK configから省略する", () => {
    const request = createRunSessionInput();
    request.executionOptions = {
      ...request.executionOptions,
      reasoningEffort: "",
    };
    const settings = buildCopilotSessionSettings(
      request,
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    );
    assert.equal(Object.hasOwn(settings.config, "reasoningEffort"), false);
  });

  /** 同じスレッドで選択 Agent が変われば、設定キーを切り替え、全候補から新しい Agent を指定する。 */
  it("custom agent 変更後の session settings は新 agent 情報を反映する", () => {
    const previousInput = createRunSessionInput({
      customAgentName: "reviewer",
      threadId: "thread-1",
    });
    const nextInput = createRunSessionInput({
      customAgentName: "planner",
      threadId: "thread-1",
    });
    const previousSettings = buildCopilotSessionSettings(
      previousInput,
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    );
    const nextSettings = buildCopilotSessionSettings(
      nextInput,
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    );

    assert.notEqual(previousSettings.settingsKey, nextSettings.settingsKey);
    assert.equal(nextSettings.config.agent, "planner");
    assert.deepEqual(nextSettings.config.customAgents, CUSTOM_AGENT_CONFIGS);
  });

  /** 同じ Agent のままでもモデルと Depth の変更を新しい SDK 設定とキャッシュキーへ反映する。 */
  it("model / reasoning 変更後の session settings は新 config を反映する", () => {
    const previousInput = createRunSessionInput({
      customAgentName: "reviewer",
      threadId: "thread-1",
      model: "gpt-4.1",
      reasoningEffort: "high",
    });
    const nextInput = createRunSessionInput({
      customAgentName: "reviewer",
      threadId: "thread-1",
      model: "gpt-4.1-mini",
      reasoningEffort: "low",
    });
    const previousSettings = buildCopilotSessionSettings(
      previousInput,
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    );
    const nextSettings = buildCopilotSessionSettings(
      nextInput,
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    );

    assert.notEqual(previousSettings.settingsKey, nextSettings.settingsKey);
    assert.equal(nextSettings.config.agent, "reviewer");
    assert.equal(nextSettings.config.model, "gpt-4.1-mini");
    assert.equal(nextSettings.config.reasoningEffort, "low");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Copilot session settingsは保存済みSessionの実行欄ではなくturn送信値をSDK configとcache keyへ使う"
  // oracle = { type = "contract", ref = "Issue #738 turn execution options boundary" }
  // fault = "Sessionのmodel/depth/approval/custom agentを再取得して送信値を無視する"
  // observable = "SessionConfigとsettingsKey"
  // observation_boundary = "component-behavior"
  // scope = "Copilot foreground session settings"
  // lifecycle = "permanent"
  // impact = "表示選択と異なるmodelまたはagentでCopilot turnを実行する"
  // distinction = "既存testはSessionと送信値が一致しており二つの入力源を区別しない"
  // @end-test-value
  /** 保存時と送信時で値が異なる場合は、当 Turn のモデル・Depth・Agent と承認設定から SDK 設定とキーを選ぶ。 */
  it("保存済みSession Aに対して送信値BをCopilot session settingsへ使う", () => {
    const input = createRunSessionInput({
      model: "gpt-4.1",
      reasoningEffort: "high",
      customAgentName: "reviewer",
    });
    input.executionOptions = {
      ...input.executionOptions,
      model: "gpt-4.1-mini",
      reasoningEffort: "low",
      approvalMode: "never",
      customAgentName: "planner",
    };
    const settings = buildCopilotSessionSettings(
      input,
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    );
    assert.equal(settings.config.model, "gpt-4.1-mini");
    assert.equal(settings.config.reasoningEffort, "low");
    assert.equal(settings.config.agent, "planner");
    assert.match(settings.settingsKey, /never/);
    assert.match(settings.settingsKey, /planner/);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Copilot の system 側 prompt context 変更は session settings key を分け、input 側 Current Date 変更は同じ key を使う"
  // oracle = { type = "contract", ref = "Copilot prompt cache boundary" }
  // fault = "system message の切替で古い session を再利用するか、timing の変化だけで不要な session 再接続を起こす"
  // observable = "buildCopilotSessionSettings の settingsKey と systemMessage"
  // observation_boundary = "consumer"
  // scope = "copilot-system-prompt-cache-key"
  // lifecycle = "permanent"
  // impact = "Prompt Context 設定変更後の provider session が誤った固定 system prompt を使う、または毎 turn 再接続する"
  // distinction = "既存の model / agent cache key test とは別に system/input の境界を直接確認する"
  // @end-test-value
  /** システム本文の変更では接続を使い分け、入力側の時刻が変わっただけなら同じキーとシステム本文を保つ。 */
  it("system prompt context の変更だけを Copilot session cache key に反映する", () => {
    const input = createRunSessionInput({ threadId: "thread-1" });
    const promptWithContext: ProviderPromptComposition = {
      ...EMPTY_PROMPT,
      systemBodyText: "# Character Definition Snapshot\n\n更新された定義",
    };
    const promptWithoutContext: ProviderPromptComposition = {
      ...promptWithContext,
      systemBodyText: "",
    };
    const promptWithLaterTiming: ProviderPromptComposition = {
      ...promptWithContext,
      inputBodyText:
        "# Current Date\n\n- Observed local time: later\n\n# User Input\n\nhello",
    };

    const withContext = buildCopilotSessionSettings(
      input,
      promptWithContext,
      "client-key",
      resolveCustomAgents,
    );
    const withoutContext = buildCopilotSessionSettings(
      input,
      promptWithoutContext,
      "client-key",
      resolveCustomAgents,
    );
    const withLaterTiming = buildCopilotSessionSettings(
      input,
      promptWithLaterTiming,
      "client-key",
      resolveCustomAgents,
    );

    assert.notEqual(withContext.settingsKey, withoutContext.settingsKey);
    assert.equal(withLaterTiming.settingsKey, withContext.settingsKey);
    assert.equal(
      withContext.config.systemMessage?.content,
      promptWithContext.systemBodyText,
    );
    assert.equal(
      withLaterTiming.config.systemMessage?.content,
      promptWithContext.systemBodyText,
    );
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "CopilotのAuto Runは通常要求を今回だけ許可し、本人必須の要求には自動許可を返さない"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md#Approval-Modes" }
  // fault = "通常writeを拒否するか、本人確認必須のread/writeを自動許可する"
  // observable = "SDK callbackの通常・本人必須・確認不能時のdecisionと手動コールバックの引数"
  // observation_boundary = "component-behavior"
  // scope = "allow-all permission handler"
  // lifecycle = "permanent"
  // impact = "選択したpermission policyと実行が食い違う"
  // distinction = "untrusted/on-requestのpermission testとは異なるpolicy branch"
  // @end-test-value
  /** Auto Run の通常書き込みは一回許可し、本人確認必須の読み書きだけ人へ回す。利用者が応答できなければ許可しない。 */
  it("Copilot Auto Run skips ordinary confirmation but preserves mandatory human approval", async () => {
    const input = createRunSessionInput();
    input.session.approvalMode = "never";
    input.executionOptions = captureSessionExecutionOptions(input.session);
    const manual: unknown[] = [];
    input.onApprovalRequest = (_request, _signal, review, onDecisionSource) => {
      manual.push(review);
      onDecisionSource?.("manual");
      return "approve";
    };
    const settings = buildCopilotSessionSettings(
      input,
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    );

    assert.ok(settings.config.onPermissionRequest);
    const invocation = { sessionId: "session-1" };
    assert.deepEqual(
      await settings.config.onPermissionRequest(
        createWritePermissionRequest(),
        invocation,
      ),
      { kind: "approve-once" },
    );
    assert.deepEqual(manual, []);
    for (const request of [
      createReadPermissionRequest(),
      createWritePermissionRequest(),
    ]) {
      assert.deepEqual(
        await settings.config.onPermissionRequest(
          { ...request, managedApprovalRequired: true },
          invocation,
        ),
        manualCopilotDecision("approve-once"),
      );
    }
    assert.deepEqual(manual, [undefined, undefined]);
    const unavailable = buildCopilotSessionSettings(
      { ...input, onApprovalRequest: undefined },
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    );
    assert.deepEqual(
      await unavailable.config.onPermissionRequest?.(
        { ...createWritePermissionRequest(), managedApprovalRequired: true },
        invocation,
      ),
      { kind: "user-not-available" },
    );
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "untrusted approvalはreadを許可しwriteを拒否する"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md#Approval-Modes" }
  // fault = "readを拒否またはwriteを許可する"
  // observable = "read/write requestごとのpermission decision"
  // observation_boundary = "component-behavior"
  // scope = "safety permission handler"
  // lifecycle = "permanent"
  // impact = "安全設定でwriteを許してしまう"
  // distinction = "never/on-requestのpermission testとは異なるpolicy branch"
  // @end-test-value
  /** 従来の untrusted 設定は通常 read を今回だけ許可し、write を拒否する。 */
  it("safety permission handler は read を legacy approve-once / write を reject で返す", async () => {
    const input = createRunSessionInput();
    input.session.approvalMode = "untrusted";
    input.executionOptions = captureSessionExecutionOptions(input.session);
    const settings = buildCopilotSessionSettings(
      input,
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    );

    assert.ok(settings.config.onPermissionRequest);
    const readResult = await settings.config.onPermissionRequest?.(
      createReadPermissionRequest(),
      { sessionId: "session-1" },
    );
    const writeResult = await settings.config.onPermissionRequest?.(
      createWritePermissionRequest(),
      { sessionId: "session-1" },
    );

    assert.deepEqual(readResult, { kind: "approve-once" });
    assert.deepEqual(writeResult, { kind: "reject" });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Copilot Safety Focusedは通常のSDK分類readを通し、実際の要承認read/writeとMCPの自己申告を承認しない"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md#approval-modes" }
  // fault = "すべてのcallbackを拒否して通常readを失うか、実askやMCP readOnlyヒントを承認不要と誤認する"
  // observable = "通常read・要承認read/write・MCP callbackのSDK返却値と手動／審査bridgeの呼出"
  // observation_boundary = "component-behavior"
  // scope = "Copilot SDK permission callback、新しいSafety Focused"
  // lifecycle = "permanent"
  // risk_tags = ["authorization"]
  // impact = "要承認操作が無断で実行されるか、通常読取まで使えなくなる"
  // distinction = "runtime共通の実ask testはSDKの通常分類・promptRequestの差を通らない"
  // @end-test-value
  /** Safety Focused は通常の SDK 分類 read を通しても、明示確認が必要な read・write や MCP の readOnly 自己申告は許可せず、審査も開かない。 */
  it("Copilot Safety Focused distinguishes read classification from a real approval prompt", async () => {
    const input = createRunSessionInput();
    input.executionOptions = {
      ...input.executionOptions,
      approvalMode: "safety-focused",
    };
    input.onApprovalRequest = () =>
      assert.fail("Safety Focused must not open an approval or a review");
    const handler = buildCopilotSessionSettings(
      input,
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    ).config.onPermissionRequest!;
    const invocation = { sessionId: "session-1" };
    const read = createReadPermissionRequest();
    const readPrompt: NonNullable<
      Parameters<typeof handler>[1]["promptRequest"]
    > = { kind: "read", path: "F:/repo/sample.txt", intention: "Read fixture" };
    assert.deepEqual(await handler(read, invocation), { kind: "approve-once" });
    assert.deepEqual(
      await handler(read, {
        ...invocation,
        assistedApprovalAssessment: { status: "not-run", reason: "inactive" },
      }),
      { kind: "approve-once" },
    );
    assert.deepEqual(
      await handler(read, { ...invocation, promptRequest: readPrompt }),
      { kind: "reject" },
    );
    assert.deepEqual(
      await handler({ ...read, managedApprovalRequired: true }, invocation),
      { kind: "reject" },
    );
    assert.deepEqual(
      await handler(createWritePermissionRequest(), invocation),
      { kind: "reject" },
    );
    const mcp = {
      kind: "mcp",
      serverName: "fixture",
      toolName: "test",
      args: {},
      readOnly: true,
    } as PermissionRequest;
    assert.deepEqual(await handler(mcp, invocation), { kind: "reject" });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Copilotは資格を伏せた実要求を渡し、明示判断要求と本人必須・除外を分け、実回答だけを人間として返す"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md: CopilotAdapterのon-requestとSDK応答" }
  // fault = "明示判断を本人必須と誤る、managedやSDK除外を審査に出す、実要求の引数を落とす、資格を渡す、または出所不明な承認を採用する"
  // observable = "approval callbackの審査入力・出所別のSDK応答"
  // observation_boundary = "public-boundary"
  // scope = "copilot-provider-permission"
  // lifecycle = "permanent"
  // distinction = "通常turnの成功では検出できないprovider-controlled permission境界を検証する"
  // @end-test-value
  /** 確認で使う実要求は資格情報を伏せ、審査できる要求と本人確認が必要な要求を区別し、人の承認・拒否だけにその来歴を付けて返す。 */
  it("provider-controlled permission handler は approval callback 経由の approve / deny と handler 不在を legacy kind へ橋渡しする", async () => {
    const approvedInput = createRunSessionInput();
    const bindingReference =
      approvedInput.agentRuntimeBinding?.bindingReference ?? "";
    approvedInput.session.approvalMode = "on-request";
    approvedInput.executionOptions = captureSessionExecutionOptions(
      approvedInput.session,
    );
    const approvalRequests: Array<{
      request: LiveApprovalRequest;
      review: unknown;
    }> = [];
    approvedInput.onApprovalRequest = (
      request,
      _signal,
      review,
      onDecisionSource,
    ) => {
      approvalRequests.push({ request, review });
      onDecisionSource?.("manual");
      return "approve";
    };
    const approvedSettings = buildCopilotSessionSettings(
      approvedInput,
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    );

    assert.ok(approvedSettings.config.onPermissionRequest);
    const readResult = await approvedSettings.config.onPermissionRequest?.(
      createReadPermissionRequest(),
      { sessionId: "session-1" },
    );
    const approvedWriteResult =
      await approvedSettings.config.onPermissionRequest?.(
        {
          ...createWritePermissionRequest(),
          intention: `Create ${bindingReference}`,
          fileName: `F:/repo/${bindingReference}.txt`,
        } as PermissionRequest,
        { sessionId: "session-1" },
      );
    assert.deepEqual(readResult, { kind: "approve-once" });
    assert.deepEqual(
      approvedWriteResult,
      manualCopilotDecision("approve-once"),
    );
    assert.equal(approvalRequests.length, 1);
    assert.doesNotMatch(
      JSON.stringify(approvalRequests),
      new RegExp(bindingReference),
    );
    assert.match(
      JSON.stringify(approvalRequests),
      new RegExp(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER),
    );
    const cleanWrite = {
      ...createWritePermissionRequest(),
      fileName: "F:/repo/review-target.txt",
      intention: "Create draft",
    } as PermissionRequest;
    await approvedSettings.config.onPermissionRequest?.(cleanWrite, {
      sessionId: "session-1",
    });
    assert.deepEqual(approvalRequests[1].review, {
      operation: { request: cleanWrite, workspacePath: "F:/repo" },
    });
    await approvedSettings.config.onPermissionRequest?.(
      { ...createWritePermissionRequest(), managedApprovalRequired: true },
      { sessionId: "session-1" },
    );
    assert.equal(approvalRequests.length, 3);
    assert.equal(approvalRequests[2].review, undefined);
    const request = createReadPermissionRequest();
    const promptRequest = {
      ...request,
      resolvedPath: "F:/resolved/src/index.ts",
    };
    const assistedApprovalAssessment = {
      status: "completed",
      recommendation: "requireApproval",
    } as const;
    const invocation = {
      sessionId: "session-1",
      promptRequest,
      assistedApprovalAssessment,
    };
    assert.deepEqual(
      await approvedSettings.config.onPermissionRequest(request, invocation),
      manualCopilotDecision("approve-once"),
    );
    assert.deepEqual(approvalRequests[3].review, {
      operation: {
        request,
        workspacePath: "F:/repo",
        promptRequest,
        assistedApprovalAssessment,
      },
    });
    const confidentialPrompt = {
      ...promptRequest,
      intention: `Review ${bindingReference}`,
    };
    const confidentialAssessment = {
      ...assistedApprovalAssessment,
      rationale: `Rationale ${bindingReference}`,
    };
    await approvedSettings.config.onPermissionRequest(request, {
      sessionId: "session-1",
      promptRequest: confidentialPrompt,
      assistedApprovalAssessment: confidentialAssessment,
    });
    assert.deepEqual(approvalRequests[4].review, {
      operation: {
        request,
        workspacePath: "F:/repo",
        promptRequest: {
          ...confidentialPrompt,
          intention: `Review ${PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER}`,
        },
        assistedApprovalAssessment: {
          ...confidentialAssessment,
          rationale: `Rationale ${PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER}`,
        },
      },
    });
    const ineligibleReviews: unknown[] = [];
    const ineligibleHandler = buildCopilotSessionSettings(
      {
        ...approvedInput,
        /** 審査対象外の要求には承認らしい戻り値があっても適用しないことを確かめるため、渡された審査入力を記録する。 */
        onApprovalRequest: (_request, _signal, review, onDecisionSource) => {
          ineligibleReviews.push(review);
          onDecisionSource?.("reviewer");
          return "approve";
        },
      },
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    ).config.onPermissionRequest;
    for (const [blockedRequest, blockedInvocation] of [
      [
        request,
        {
          ...invocation,
          promptRequest: { ...promptRequest, managedApprovalRequired: true },
        },
      ],
      [
        request,
        {
          ...invocation,
          assistedApprovalAssessment: {
            status: "excluded",
            reason: "content-excluded",
          },
        },
      ],
      [
        request,
        {
          ...invocation,
          assistedApprovalAssessment: {
            status: "failed",
            reason: "model_error",
          },
        },
      ],
      [request, { ...invocation, promptRequest: undefined }],
      [{ ...request, path: "" }, invocation],
      [{ ...request, requestSandboxBypass: true }, invocation],
    ] as const) {
      assert.deepEqual(
        await ineligibleHandler(blockedRequest, blockedInvocation),
        blockedCopilotDecision,
      );
      assert.deepEqual(ineligibleReviews.splice(0), [undefined]);
    }

    const deniedInput = createRunSessionInput();
    deniedInput.session.approvalMode = "on-request";
    deniedInput.executionOptions = captureSessionExecutionOptions(
      deniedInput.session,
    );
    deniedInput.onApprovalRequest = (
      _request,
      _signal,
      _review,
      onDecisionSource,
    ) => {
      onDecisionSource?.("manual");
      return "deny";
    };
    const deniedSettings = buildCopilotSessionSettings(
      deniedInput,
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    );
    const deniedWriteResult = await deniedSettings.config.onPermissionRequest?.(
      createWritePermissionRequest(),
      { sessionId: "session-1" },
    );
    assert.deepEqual(deniedWriteResult, manualCopilotDecision("reject"));

    for (const source of [undefined, "blocked"] as const) {
      const handler = buildCopilotSessionSettings(
        {
          ...deniedInput,
          /** 出所が未記録または blocked の承認結果を作り、SDK が許可扱いしないことを確認する。 */
          onApprovalRequest: (_request, _signal, _review, onDecisionSource) => {
            if (source) onDecisionSource?.(source);
            return "approve";
          },
        },
        EMPTY_PROMPT,
        "client-key",
        resolveCustomAgents,
      ).config.onPermissionRequest;
      assert.deepEqual(
        await handler(request, invocation),
        blockedCopilotDecision,
      );
    }

    const controller = new AbortController();
    const reviewer = Promise.withResolvers<"approve">();
    const canceled = buildCopilotSessionSettings(
      {
        ...deniedInput,
        signal: controller.signal,
        /** 取消 signal を受け取り、解除されるまで審査結果を保留して、取消後に届く承認を再現する。 */
        onApprovalRequest: async (
          _request,
          signal,
          _review,
          onDecisionSource,
        ) => {
          assert.equal(signal, controller.signal);
          const decision = await reviewer.promise;
          onDecisionSource?.("reviewer");
          return decision;
        },
      },
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    );
    const canceledResponse = canceled.config.onPermissionRequest(
      request,
      invocation,
    );
    controller.abort();
    reviewer.resolve("approve");
    assert.deepEqual(await canceledResponse, blockedCopilotDecision);

    const missingHandlerInput = createRunSessionInput();
    missingHandlerInput.session.approvalMode = "on-request";
    missingHandlerInput.executionOptions = captureSessionExecutionOptions(
      missingHandlerInput.session,
    );
    const missingHandlerSettings = buildCopilotSessionSettings(
      missingHandlerInput,
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    );
    const missingHandlerResult =
      await missingHandlerSettings.config.onPermissionRequest?.(
        createWritePermissionRequest(),
        { sessionId: "session-1" },
      );
    assert.deepEqual(missingHandlerResult, { kind: "user-not-available" });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Copilotの同一request objectは判断を共有し、同じtoolCallIdやsummaryの別要求は会話内FIFOで個別判断する"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md: SessionApprovalService" }
  // fault = "toolCallIdまたはsummaryの一致で別要求をまとめるか、後続要求が先頭表示を上書きしてcallbackを未解決にする"
  // observable = "live approvalRequest、通知request ID、各callbackのapprove-once/reject/user-not-availableと出所"
  // observation_boundary = "consumer"
  // scope = "Copilot permission handlerと実SessionApprovalServiceの接続"
  // lifecycle = "permanent"
  // impact = "別の操作へ許可が流用される、または同時要求でprovider turnが承認待ちのまま停止する"
  // distinction = "service単体testやcallback mockではredaction前のrequest同一性とprovider返却値までの接続を検出できず、外部SDK接続なしの短いtestで認可境界を保護する"
  // risk_tags = ["authorization"]
  // @end-test-value
  /** 同じ要求オブジェクトだけが承認を共有し、識別子や要約が似た別要求は先着順に承認・拒否・リセットされる。 */
  it("Copilot permission は同一要求を共有し、別要求を FIFO で承認・拒否・resetする", async () => {
    const input = createRunSessionInput();
    input.session.approvalMode = "on-request";
    input.executionOptions = captureSessionExecutionOptions(input.session);
    let state: LiveSessionRunState = {
      sessionId: input.session.id,
      threadId: "thread-1",
      assistantText: "",
      steps: [],
      backgroundTasks: [],
      usage: null,
      errorMessage: "",
      approvalRequest: null,
      elicitationRequest: null,
    };
    const notifications: string[] = [];
    const requests: LiveApprovalRequest[] = [];
    const controller = new AbortController();
    const service = new SessionApprovalService({
      /** 実承認サービスの更新を、現在表示中の承認要求としてメモリーに反映する。 */
      updateLiveSessionRun: (_sessionId, recipe) => {
        state = recipe(state);
        return state;
      },
      /** 実承認サービスが次に表示を促した要求 ID を順に記録する。 */
      notifyApproval: (_sessionId, requestId) => {
        notifications.push(requestId);
      },
    });
    input.onApprovalRequest = (request, _signal, _review, onDecisionSource) => {
      requests.push(request);
      return service.waitForLiveApprovalDecision(
        input.session.id,
        request,
        controller.signal,
        undefined,
        onDecisionSource,
      );
    };
    const settings = buildCopilotSessionSettings(
      input,
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    );
    const handler = settings.config.onPermissionRequest;
    assert.ok(handler);
    const requestA = createWritePermissionRequest();
    const requestB = {
      ...createWritePermissionRequest(),
      fileName: "F:/repo/other.txt",
    } as PermissionRequest;
    const requestC = {
      ...requestA,
      toolCallId: undefined,
    } as PermissionRequest;
    const context = { sessionId: "session-1" };
    const decisions = [
      handler(requestA, context),
      handler(requestA, context),
      handler(requestB, context),
      handler(requestC, context),
    ];
    const [approvalA, duplicateA, approvalB, approvalC] = requests;
    assert.ok(approvalA && duplicateA && approvalB && approvalC);
    assert.equal(approvalA.requestId, duplicateA.requestId);
    assert.equal(
      new Set([approvalA.requestId, approvalB.requestId, approvalC.requestId])
        .size,
      3,
    );
    assert.equal(approvalA.summary, approvalC.summary);
    assert.equal(state.approvalRequest?.requestId, approvalA.requestId);
    assert.deepEqual(notifications, [approvalA.requestId]);

    service.resolveLiveApproval(
      input.session.id,
      approvalA.requestId,
      "approve",
    );
    assert.equal(state.approvalRequest?.requestId, approvalB.requestId);
    assert.deepEqual(notifications, [approvalA.requestId, approvalB.requestId]);
    service.resolveLiveApproval(input.session.id, approvalB.requestId, "deny");
    assert.equal(state.approvalRequest?.requestId, approvalC.requestId);
    assert.deepEqual(notifications, [
      approvalA.requestId,
      approvalB.requestId,
      approvalC.requestId,
    ]);
    service.reset();
    assert.equal(state.approvalRequest, null);
    assert.deepEqual(await Promise.all(decisions), [
      manualCopilotDecision("approve-once"),
      manualCopilotDecision("approve-once"),
      manualCopilotDecision("reject"),
      blockedCopilotDecision,
    ]);
  });

  /** Agent 設定を変更しても保存済み thread は維持し、旧接続を切断して新設定付きで一度だけ再開する。 */
  it("threadId がある custom agent 切り替え後は createSession ではなく resumeSession を使う", async () => {
    const previousInput = createRunSessionInput({
      customAgentName: "reviewer",
      threadId: "thread-1",
    });
    const nextInput = createRunSessionInput({
      customAgentName: "planner",
      threadId: "thread-1",
    });
    const previousSettings = buildCopilotSessionSettings(
      previousInput,
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    );
    const nextSettings = buildCopilotSessionSettings(
      nextInput,
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    );
    const cachedDisconnectCalls: string[] = [];
    const resumeCalls: Array<{
      threadId: string;
      config: {
        agent?: string;
        customAgents?: Array<{ name: string; prompt: string }>;
      };
    }> = [];
    const createCalls: unknown[] = [];
    const resumedSession = {
      /** 再開に成功したテスト用 Session は外部接続を持たない。 */
      disconnect: async () => undefined,
    } as never;

    assert.notEqual(previousSettings.settingsKey, nextSettings.settingsKey);

    const result = await resolveCopilotSessionForSettings({
      cached: {
        session: {
          /** Agent の変更で以前の接続の切断が呼ばれたことを記録する。 */
          disconnect: async () => {
            cachedDisconnectCalls.push("disconnect");
          },
        } as never,
        settingsKey: previousSettings.settingsKey,
      },
      nextSettingsKey: nextSettings.settingsKey,
      threadId: nextInput.session.threadId,
      config: nextSettings.config,
      client: {
        /** 再開する thread と新しい Agent 設定を捕捉する。 */
        resumeSession: async (
          threadId: string,
          config: {
            agent?: string;
            customAgents?: Array<{ name: string; prompt: string }>;
          },
        ) => {
          resumeCalls.push({ threadId, config });
          return resumedSession;
        },
        /** 新規作成が選ばれた場合に検出できるよう引数を記録する。 */
        createSession: async (config: unknown) => {
          createCalls.push(config);
          return resumedSession;
        },
      },
    });

    assert.equal(result.session, resumedSession);
    assert.equal(result.reusedCached, false);
    assert.equal(createCalls.length, 0);
    assert.equal(resumeCalls.length, 1);
    assert.deepEqual(cachedDisconnectCalls, ["disconnect"]);
    assert.equal(resumeCalls[0]?.threadId, "thread-1");
    assert.equal(resumeCalls[0]?.config.agent, "planner");
    assert.deepEqual(resumeCalls[0]?.config.customAgents, CUSTOM_AGENT_CONFIGS);
  });

  /** モデルや Depth が変われば旧接続を切って同じ thread を再開し、新しい設定と既存 Agent を渡す。 */
  it("threadId がある model / reasoning 変更後は新 config 付き resumeSession を使う", async () => {
    const previousInput = createRunSessionInput({
      customAgentName: "reviewer",
      threadId: "thread-1",
      model: "gpt-4.1",
      reasoningEffort: "high",
    });
    const nextInput = createRunSessionInput({
      customAgentName: "reviewer",
      threadId: "thread-1",
      model: "gpt-4.1-mini",
      reasoningEffort: "low",
    });
    const previousSettings = buildCopilotSessionSettings(
      previousInput,
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    );
    const nextSettings = buildCopilotSessionSettings(
      nextInput,
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    );
    const cachedDisconnectCalls: string[] = [];
    const resumeCalls: Array<{
      threadId: string;
      config: {
        agent?: string;
        model?: string;
        reasoningEffort?: string;
      };
    }> = [];
    const createCalls: unknown[] = [];
    const resumedSession = {
      /** 再開の戻り値用の Session には実際の接続を持たせない。 */
      disconnect: async () => undefined,
    } as never;

    assert.notEqual(previousSettings.settingsKey, nextSettings.settingsKey);

    const result = await resolveCopilotSessionForSettings({
      cached: {
        session: {
          /** モデルや Depth の変更で旧接続が切断されたことを記録する。 */
          disconnect: async () => {
            cachedDisconnectCalls.push("disconnect");
          },
        } as never,
        settingsKey: previousSettings.settingsKey,
      },
      nextSettingsKey: nextSettings.settingsKey,
      threadId: nextInput.session.threadId,
      config: nextSettings.config,
      client: {
        /** 保存済み thread の再開へ渡った新モデルと Depth を記録する。 */
        resumeSession: async (
          threadId: string,
          config: { model?: string; reasoningEffort?: string },
        ) => {
          resumeCalls.push({ threadId, config });
          return resumedSession;
        },
        /** モデル切替で誤って新規作成した場合を検出する。 */
        createSession: async (config: unknown) => {
          createCalls.push(config);
          return resumedSession;
        },
      },
    });

    assert.equal(result.session, resumedSession);
    assert.equal(result.reusedCached, false);
    assert.equal(createCalls.length, 0);
    assert.equal(resumeCalls.length, 1);
    assert.deepEqual(cachedDisconnectCalls, ["disconnect"]);
    assert.equal(resumeCalls[0]?.threadId, "thread-1");
    assert.equal(resumeCalls[0]?.config.agent, "reviewer");
    assert.equal(resumeCalls[0]?.config.model, "gpt-4.1-mini");
    assert.equal(resumeCalls[0]?.config.reasoningEffort, "low");
  });

  /** 保存済み thread の再開が SessionNotFound なら、新しい native Session を一度作成して返す。 */
  it("threadId が失効して SessionNotFound が返った時は createSession に fallback する", async () => {
    const input = createRunSessionInput({
      customAgentName: "reviewer",
      threadId: "thread-stale",
    });
    const settings = buildCopilotSessionSettings(
      input,
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    );
    const resumeCalls: string[] = [];
    const createCalls: unknown[] = [];
    const createdSession = {
      /** 失効後の新規作成結果に使う、外部接続のない Session。 */
      disconnect: async () => undefined,
    } as never;

    const result = await resolveCopilotSessionForSettings({
      cached: undefined,
      nextSettingsKey: settings.settingsKey,
      threadId: input.session.threadId,
      config: settings.config,
      client: {
        /** 指定された失効済み thread の再開を試みたことを残し、SessionNotFound を返す。 */
        resumeSession: async (threadId: string) => {
          resumeCalls.push(threadId);
          throw new Error("SessionNotFound: session not found");
        },
        /** 再開失敗後の新規作成に渡った設定を保持する。 */
        createSession: async (config: unknown) => {
          createCalls.push(config);
          return createdSession;
        },
      },
    });

    assert.equal(result.session, createdSession);
    assert.equal(result.reusedCached, false);
    assert.deepEqual(resumeCalls, ["thread-stale"]);
    assert.equal(createCalls.length, 1);
  });

  /** モデル変更後に保存済み thread が失効していれば旧接続を切断し、再開と代替の新規作成で同じ新設定を使う。 */
  it("threadId がある model 変更後でも stale session なら createSession に fallback する", async () => {
    const previousInput = createRunSessionInput({
      customAgentName: "reviewer",
      threadId: "thread-1",
      model: "gpt-4.1",
      reasoningEffort: "high",
    });
    const nextInput = createRunSessionInput({
      customAgentName: "reviewer",
      threadId: "thread-1",
      model: "gpt-4.1-mini",
      reasoningEffort: "low",
    });
    const previousSettings = buildCopilotSessionSettings(
      previousInput,
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    );
    const nextSettings = buildCopilotSessionSettings(
      nextInput,
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    );
    const cachedDisconnectCalls: string[] = [];
    const resumeCalls: Array<{
      threadId: string;
      model?: string;
      reasoningEffort?: string;
    }> = [];
    const createCalls: Array<{ model?: string; reasoningEffort?: string }> = [];
    const createdSession = {
      /** 新設定で作成した SDK Session を参照比較できるようにする。 */
      disconnect: async () => undefined,
    } as never;

    assert.notEqual(previousSettings.settingsKey, nextSettings.settingsKey);

    const result = await resolveCopilotSessionForSettings({
      cached: {
        session: {
          /** 設定変更に伴いキャッシュ内の旧接続が切断されたことを記録する。 */
          disconnect: async () => {
            cachedDisconnectCalls.push("disconnect");
          },
        } as never,
        settingsKey: previousSettings.settingsKey,
      },
      nextSettingsKey: nextSettings.settingsKey,
      threadId: nextInput.session.threadId,
      config: nextSettings.config,
      client: {
        /** 新しいモデル・Depth で旧 thread の再開を試み、失効を返す。 */
        resumeSession: async (
          threadId: string,
          config: { model?: string; reasoningEffort?: string },
        ) => {
          resumeCalls.push({
            threadId,
            model: config.model,
            reasoningEffort: config.reasoningEffort,
          });
          throw new Error("SessionNotFound: session not found");
        },
        /** 失効後の作成で使ったモデルと Depth を捕捉し、新しい SDK Session を返す。 */
        createSession: async (config: {
          model?: string;
          reasoningEffort?: string;
        }) => {
          createCalls.push({
            model: config.model,
            reasoningEffort: config.reasoningEffort,
          });
          return createdSession;
        },
      },
    });

    assert.equal(result.session, createdSession);
    assert.equal(result.reusedCached, false);
    assert.deepEqual(cachedDisconnectCalls, ["disconnect"]);
    assert.deepEqual(resumeCalls, [
      {
        threadId: "thread-1",
        model: "gpt-4.1-mini",
        reasoningEffort: "low",
      },
    ]);
    assert.deepEqual(createCalls, [
      {
        model: "gpt-4.1-mini",
        reasoningEffort: "low",
      },
    ]);
  });

  /** 保存済み thread の再開時に SessionNotFound 以外のエラーが出たら、新規作成で隠さず伝播する。 */
  it("threadId があっても unrelated error は createSession へ握りつぶさない", async () => {
    const input = createRunSessionInput({
      customAgentName: "reviewer",
      threadId: "thread-stale",
    });
    const settings = buildCopilotSessionSettings(
      input,
      EMPTY_PROMPT,
      "client-key",
      resolveCustomAgents,
    );
    const createCalls: unknown[] = [];

    await assert.rejects(
      resolveCopilotSessionForSettings({
        cached: undefined,
        nextSettingsKey: settings.settingsKey,
        threadId: input.session.threadId,
        config: settings.config,
        client: {
          /** 失効ではない再開失敗として権限エラーを再現する。 */
          resumeSession: async () => {
            throw new Error("Permission denied");
          },
          /** 権限エラーが新規作成で隠された場合を検出する。 */
          createSession: async (config: unknown) => {
            createCalls.push(config);
            return {
              /** 誤って新規作成に進んだ場合にも実 SDK の切断は発生させない。 */
              disconnect: async () => undefined,
            } as never;
          },
        },
      }),
      /Permission denied/,
    );

    assert.equal(createCalls.length, 0);
  });
});

/** SDK の承認完了イベントを live 操作の状態へ変える規則を確認する。 */
describe("CopilotAdapter permission.completed live status", () => {
  /** 許可の種別にかかわらずツールの処理自体はまだ完了していないため、live 表示では進行中とする。 */
  it("approval を表す result kind は live step を in_progress 扱いにする", () => {
    for (const kind of [
      "approved",
      "approve-once",
      "approve-for-session",
      "approve-for-location",
      "approved-for-session",
      "approved-for-location",
    ]) {
      assert.equal(
        getCopilotPermissionCompletedLiveStatus(kind),
        "in_progress",
      );
    }
  });

  /** 拒否・利用者不在など許可されなかった操作は、実行待ちとして残さず live 上の失敗にする。 */
  it("非 approval の result kind は live step を failed 扱いにする", () => {
    for (const kind of [
      "reject",
      "user-not-available",
      "denied-interactively-by-user",
      "denied-no-approval-rule-and-could-not-request-from-user",
      "denied-by-rules",
      "denied-by-content-exclusion-policy",
    ]) {
      assert.equal(getCopilotPermissionCompletedLiveStatus(kind), "failed");
    }
  });
});
