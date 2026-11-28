import assert from "node:assert/strict";
import path from "node:path";
import { it } from "node:test";
import type {
  query,
  ResolvedSettings,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  CopilotClient,
  ModelInfo as CopilotModel,
} from "@github/copilot-sdk";
import type {
  OpenCodeClient,
  ModelInfo as OpenCodeModel,
} from "@opencode/client";
import {
  CodexAdapter,
  type CodexAdapterOptions,
} from "../../src-electron/providers/codex/codex-adapter.js";
import { ClaudeAdapter } from "../../src-electron/providers/claude/claude-adapter.js";
import { CopilotAdapter } from "../../src-electron/providers/copilot/copilot-adapter.js";
import { OpenCodeAdapter } from "../../src-electron/providers/opencode/opencode-adapter.js";
import { resolveOpenCodeModelRef } from "../../src-electron/providers/opencode/opencode-model.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";

/** 既定設定と現在の作業ディレクトリから、各 SDK に共通の探索入力を用意する。 */
const input = () => ({
  appSettings: createDefaultAppSettings(),
  workspacePath: process.cwd(),
});
/** Codex が探索時に作成できる通信路のインターフェース。 */
type CodexTransport = ReturnType<
  NonNullable<CodexAdapterOptions["createTransport"]>
>;
/** 既定の有無と、固定列挙では拾えない Depth を含む Codex の候補を作る。 */
function codexModel(id: string, isDefault = false) {
  return {
    id,
    model: id,
    displayName: `Label ${id}`,
    isDefault,
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Low" },
      { reasoningEffort: "persistent", description: "Persistent" },
    ],
    defaultReasoningEffort: "persistent",
  };
}
/** 取得結果と終了処理だけをケースごとに差し替える通信路を作る。 */
function codexTransport(
  request: (method: string, params: unknown) => Promise<unknown>,
  close: () => Promise<void>,
): CodexTransport {
  return {
    /** プロセスを起動せず通信準備が完了したものとする。 */ start: async () =>
      undefined,
    request,
    close,
    /** 通信路の終了待ちをブロックしない。 */ whenClosed: async () => undefined,
    /** 探索が turn のイベントに触れた場合は想定外として失敗させる。 */
    nextEvent: async () => {
      throw new Error("Discovery must not read turn events");
    },
  } as CodexTransport;
}
/** 同じモデル名でも提供元を区別できるよう、native ID と variant を持たせる。 */
function openCodeModel(
  id: string,
  providerID: string,
  enabled = true,
): OpenCodeModel {
  return {
    id,
    providerID,
    name: `Label ${id}`,
    enabled,
    variants: [{ id: "careful" }],
  } as OpenCodeModel;
}
/** Depth 対応の有無で、Copilot SDK が返す能力と既定値を切り替える。 */
function copilotModel(id: string, reasoning = true): CopilotModel {
  return {
    id,
    name: `Label ${id}`,
    capabilities: {
      supports: { vision: false, reasoningEffort: reasoning },
      limits: { max_context_window_tokens: 100 },
    },
    ...(reasoning
      ? {
          supportedReasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "high",
        }
      : {}),
  };
}

// @test-value v2
// kind = "contract"
// claim = "Codexモデル探索は全ページのSDKモデルと既定Depthを返し所有transportを閉じる"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "先頭ページだけを返すかSDK既定値と未知のDepthを固定値へ置換する"
// observable = "listModelsのcatalogとtransport close回数とmodel/listのcursor"
// observation_boundary = "public-boundary"
// scope = "Codex model discovery"
// lifecycle = "permanent"
// impact = "選択可能なモデルまたはSDKの推奨設定が失われる"
// distinction = "ネットワーク無しでpaginationとSDK metadataの公開変換を確認する"
// @end-test-value
/** 2 ページを取得し、非表示モデルを除いて native の既定モデルと Depth を残し、探索用通信路を閉じる。 */
it("Codex discovery maps paginated models and SDK defaults then closes its transport", async () => {
  const cursors: unknown[] = [];
  let closed = 0;
  const adapter = new CodexAdapter(undefined, {
    /** 一覧照会だけを受け付け、カーソルで返すページを切り替えて呼び出し順を記録する。 */ createTransport:
      () =>
        codexTransport(
          async (method, params) => {
            assert.equal(method, "model/list");
            const cursor = (params as { cursor: unknown }).cursor;
            cursors.push(cursor);
            return cursor === null
              ? { data: [codexModel("first")], nextCursor: "next" }
              : {
                  data: [
                    {
                      ...codexModel("preferred", true),
                      id: "preferred-preset",
                    },
                    { ...codexModel("hidden"), hidden: true },
                  ],
                  nextCursor: null,
                };
          },
          async () => {
            closed++;
          },
        ),
  });
  const catalog = await adapter.listModels(input());
  assert.deepEqual(cursors, [null, "next"]);
  assert.deepEqual(
    catalog.models,
    ["first", "preferred"].map((id) => ({
      id,
      label: `Label ${id}`,
      reasoningEfforts: ["low", "persistent"],
      defaultReasoningEffort: "persistent",
    })),
  );
  assert.equal(catalog.defaultModelId, "preferred");
  assert.equal(catalog.defaultReasoningEffort, "persistent");
  assert.equal(closed, 1);
});

// @test-value v2
// kind = "contract"
// claim = "Codex探索のprovider失敗と循環cursorは失敗として伝わりsecretを出さずtransportを閉じる"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "エラーを空catalogの成功にするかcursor循環で終了せずcredentialをエラーへ流す"
// observable = "listModelsの拒否messageとclose回数"
// observation_boundary = "public-boundary"
// scope = "Codex discovery failure"
// lifecycle = "permanent"
// @end-test-value
/** 取得エラーと循環カーソルのどちらでも生エラーを伏せ、通信路を一度だけ閉じることを確かめる。 */
it("Codex discovery rejects failures and repeated cursors with cleanup and sanitized errors", async () => {
  for (const failure of ["provider", "cursor"] as const) {
    let closed = 0;
    const adapter = new CodexAdapter(undefined, {
      /** 取得失敗または進まないカーソルを返す通信路を用意する。 */ createTransport:
        () =>
          codexTransport(
            async () => {
              if (failure === "provider")
                throw new Error("secret-token-from-provider");
              return { data: [codexModel("first")], nextCursor: "repeated" };
            },
            async () => {
              closed++;
            },
          ),
    });
    await assert.rejects(adapter.listModels(input()), {
      message: "Codex models could not be retrieved",
    });
    assert.equal(closed, 1);
  }
});

// @test-value v2
// kind = "contract"
// claim = "OpenCode探索はenabledモデルだけをnative provider/model IDとvariantsで返しSDK既定モデルを選ぶ"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "無効モデルを混ぜるかprovider境界を欠落させ同名モデルを混同する"
// observable = "listModels catalog、metadata requestのworkspaceとclose回数"
// observation_boundary = "public-boundary"
// scope = "OpenCode model discovery"
// lifecycle = "permanent"
// impact = "別providerまたは利用不可のモデルが選択される"
// distinction = "native SDK metadataから公開catalogまでをmock transportで観測する"
// @end-test-value
/** 同名候補を提供元別に残し、無効候補を落として SDK が選ぶ既定値を採用する。 */
it("OpenCode discovery preserves enabled native provider IDs, variants and SDK default", async () => {
  const rows = [
    openCodeModel("shared", "first"),
    openCodeModel("shared", "second"),
    openCodeModel("disabled", "first", false),
  ];
  let closed = 0;
  const location = { directory: process.cwd() };
  const client = {
    model: {
      /** 一覧照会が指定の作業場所を維持することを確認し、合成候補を返す。 */
      list: async (args: unknown) => {
        assert.deepEqual(args, { location });
        return { data: rows };
      },
      /** 候補一覧の二件目を SDK の既定値として明示する。 */
      default: async () => ({ data: rows[1] }),
    },
  } as unknown as OpenCodeClient;
  const adapter = new OpenCodeAdapter({
    executable: path.resolve("opencode-test.exe"),
    /** 候補一覧と既定値を持つ専用の通信路を引き渡す。 */
    createTransport: () => ({
      /** 実サービスを起動せず合成クライアントを返す。 */ start: async () =>
        client,
      /** 探索用の通信路を何度閉じたか記録する。 */ close: async () => {
        closed++;
      },
      /** 別の終了通知を待たずに完了する。 */ whenClosed: async () => undefined,
    }),
  });
  const catalog = await adapter.listModels(input());
  assert.deepEqual(
    catalog.models,
    ["first", "second"].map((provider) => ({
      id: `${provider}/shared`,
      label: "Label shared",
      sourceLabel: provider,
      reasoningEfforts: ["careful"],
      defaultReasoningEffort: "",
    })),
  );
  assert.equal(catalog.defaultModelId, "second/shared");
  assert.equal(catalog.defaultReasoningEffort, "");
  assert.equal(closed, 1);
});

// @test-value v2
// kind = "contract"
// claim = "OpenCodeは任意native variantを保持しDepth未指定ではvariant propertyを省略する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "空variantを送信するか既知のDepth名へ書き換える"
// observable = "providerに送るModelRef"
// observation_boundary = "public-boundary"
// scope = "OpenCode native variant conversion"
// lifecycle = "permanent"
// @end-test-value
/** モデル ID の途中のスラッシュを失わず、未指定の variant を送らないことを確かめる。 */
it("OpenCode model references preserve native variants and omit unspecified Depth", () => {
  assert.deepEqual(
    resolveOpenCodeModelRef("provider/model/nested", "careful"),
    { providerID: "provider", id: "model/nested", variant: "careful" },
  );
  assert.deepEqual(resolveOpenCodeModelRef("provider/model/nested", ""), {
    providerID: "provider",
    id: "model/nested",
  });
});

// @test-value v2
// kind = "contract"
// claim = "Claude探索はuser messageを送らずsupportedModels metadataだけを取得しqueryを閉じる"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "metadata探索のため生成promptを送るかSDK effortを欠落させる"
// observable = "queryへ渡したinput streamの完了値、catalog、close回数と安全なquery options"
// observation_boundary = "public-boundary"
// scope = "Claude metadata-only model discovery"
// lifecycle = "permanent"
// impact = "モデル一覧更新で生成料金や予期しないツール操作が発生する"
// distinction = "buildや型では保証できないmetadata-only query挙動を通信無しで検査する"
// @end-test-value
/** 生成用の入力を一件も流さず、能力情報だけを得て query を閉じることを確かめる。 */
it("Claude discovery reads metadata with a never-yielding prompt and closes the query", async () => {
  let closed = 0;
  let pendingInput: Promise<IteratorResult<SDKUserMessage>> | undefined;
  const runQuery = ((args: Parameters<typeof query>[0]) => {
    assert.notEqual(typeof args.prompt, "string");
    pendingInput = (args.prompt as AsyncIterable<SDKUserMessage>)
      [Symbol.asyncIterator]()
      .next();
    assert.deepEqual(args.options?.tools, []);
    assert.deepEqual(args.options?.settingSources, []);
    assert.deepEqual(args.options?.settings, { disableAllHooks: true });
    assert.equal(args.options?.strictMcpConfig, true);
    assert.equal(args.options?.persistSession, false);
    return {
      /** Depth の能力が異なる二件のメタデータを返す。 */ supportedModels:
        async () => [
          {
            value: "alias",
            displayName: "Native alias",
            supportsEffort: true,
            supportedEffortLevels: ["low", "max"],
          },
          { value: "no-depth", displayName: "No depth", supportsEffort: false },
        ],
      /** 所有する query の終了を数える。 */ close: () => {
        closed++;
      },
    };
  }) as unknown as typeof query;
  const adapter = new ClaudeAdapter({
    query: runQuery,
    /** ユーザー設定やフックを持たない解決済み設定で探索する。 */ resolveSettings:
      async () =>
        ({ sources: [], effective: {}, provenance: {} }) as ResolvedSettings,
  });
  const catalog = await adapter.listModels(input());
  assert.deepEqual(await pendingInput, { done: true, value: undefined });
  assert.deepEqual(catalog.models, [
    {
      id: "alias",
      label: "Native alias",
      reasoningEfforts: ["low", "max"],
      defaultReasoningEffort: "",
    },
    {
      id: "no-depth",
      label: "No depth",
      reasoningEfforts: [],
      defaultReasoningEffort: "",
    },
  ]);
  assert.equal(catalog.defaultModelId, "alias");
  assert.equal(catalog.defaultReasoningEffort, "");
  assert.equal(closed, 1);
});

// @test-value v2
// kind = "contract"
// claim = "Copilot探索はSDK capabilityとpolicyと既定effortを反映して個別clientを停止する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "policy無効モデルを返すか非対応モデルへ架空のDepthを与えclientを保持する"
// observable = "listModels catalog、client optionsとstop回数"
// observation_boundary = "public-boundary"
// scope = "Copilot model discovery"
// lifecycle = "permanent"
// @end-test-value
/** SDK の利用可否と推論能力から候補を作り、探索専用クライアントを停止する。 */
it("Copilot discovery uses capability and policy metadata with an owned client", async () => {
  let stopped = 0;
  const client = {
    /** 外部プロセスを起動せずクライアントの準備を完了する。 */ start:
      async () => undefined,
    /** 利用可能な二件に、ポリシーで無効な候補を混ぜる。 */ listModels:
      async () => [
        copilotModel("native"),
        copilotModel("no-depth", false),
        {
          ...copilotModel("blocked"),
          policy: { state: "disabled", terms: "" },
        },
      ],
    /** クライアントを停止した回数を記録し、停止エラーなしを返す。 */ stop: async () => {
      stopped++;
      return [];
    },
  } as unknown as CopilotClient;
  const adapter = new CopilotAdapter({
    /** 探索対象の作業ディレクトリが専用クライアントへ渡ることを確認する。 */ createClient:
      (options) => {
        assert.equal(options?.workingDirectory, process.cwd());
        return client;
      },
  });
  const catalog = await adapter.listModels(input());
  assert.deepEqual(catalog.models, [
    {
      id: "native",
      label: "Label native",
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
    },
    {
      id: "no-depth",
      label: "Label no-depth",
      reasoningEfforts: [],
      defaultReasoningEffort: "",
    },
  ]);
  assert.equal(catalog.defaultModelId, "native");
  assert.equal(catalog.defaultReasoningEffort, "high");
  assert.equal(stopped, 1);
});

// @test-value v2
// kind = "contract"
// claim = "Copilot探索の取消はmetadata待ちを終了して所有clientを停止し失敗を成功へ変えない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "取消後もSDK応答を待ち続けるか終了処理を省略する"
// observable = "listModelsの取消拒否とstop回数"
// observation_boundary = "public-boundary"
// scope = "Copilot discovery cancellation"
// lifecycle = "permanent"
// @end-test-value
/** 応答が永遠に返らない一覧照会でも、中止信号で待ちを抜けて停止できる。 */
it("Copilot discovery aborts a pending SDK metadata request and stops the owned client", async () => {
  let stopped = 0;
  const controller = new AbortController();
  const client = {
    /** 接続待ちではなく一覧待ちで中止させるため、起動は成功させる。 */ start:
      async () => undefined,
    /** 一覧照会の時点で中止し、SDK からは応答しない。 */ listModels: () => {
      controller.abort();
      return new Promise(() => undefined);
    },
    /** 中止後も所有クライアントを停止したことを記録する。 */
    stop: async () => {
      stopped++;
      return [];
    },
  } as unknown as CopilotClient;
  const adapter = new CopilotAdapter({
    /** 中止信号を制御できるクライアントだけを供給する。 */ createClient: () =>
      client,
  });
  await assert.rejects(
    adapter.listModels({ ...input(), signal: controller.signal }),
    { message: "Copilot model discovery canceled" },
  );
  assert.equal(stopped, 1);
});

// @test-value v2
// kind = "contract"
// claim = "ClaudeとOpenCodeのmetadata失敗はsecretを公開せず所有queryまたはtransportを閉じる"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "metadata取得の拒否でcleanupを飛ばすかproviderの生エラーを公開する"
// observable = "各listModels拒否messageとclose回数"
// observation_boundary = "public-boundary"
// scope = "Claude and OpenCode discovery failure"
// lifecycle = "permanent"
// @end-test-value
/** 両 SDK の取得失敗を利用者向けに変換し、専用リソースを残さない。 */
it("Claude and OpenCode discovery sanitize metadata failures and close their owned resources", async () => {
  let claudeClosed = 0;
  const claude = new ClaudeAdapter({
    query: (() => ({
      /** 公開メッセージに含めてはいけない生の SDK エラーを返す。 */ supportedModels:
        async () => {
          throw new Error("secret-token");
        },
      /** メタデータの拒否後にも query が閉じたことを記録する。 */ close:
        () => {
          claudeClosed++;
        },
    })) as unknown as typeof query,
    /** 設定ファイルに依存せず、メタデータ取得の失敗だけを再現する。 */
    resolveSettings: async () =>
      ({ sources: [], effective: {}, provenance: {} }) as ResolvedSettings,
  });
  await assert.rejects(claude.listModels(input()), {
    message: "Claude models could not be retrieved",
  });
  assert.equal(claudeClosed, 1);
  let openCodeClosed = 0;
  const client = {
    model: {
      /** OpenCode の一覧照会を資格情報を含む試験用エラーで失敗させる。 */ list: async () => {
        throw new Error("secret-token");
      },
      /** 一覧が失敗するケースには既定候補を供給しない。 */ default:
        async () => ({ data: null }),
    },
  } as unknown as OpenCodeClient;
  const openCode = new OpenCodeAdapter({
    executable: path.resolve("opencode-test.exe"),
    /** 起動可能だが一覧照会に失敗する OpenCode 通信路を作る。 */
    createTransport: () => ({
      /** 一覧だけが失敗するよう、クライアントの準備自体は成功させる。 */ start:
        async () => client,
      /** 取得エラー後にも通信路を閉じた回数を記録する。 */ close: async () => {
        openCodeClosed++;
      },
      /** 個別の終了イベントなしで待機を終える。 */ whenClosed: async () =>
        undefined,
    }),
  });
  await assert.rejects(openCode.listModels(input()), {
    message:
      "OpenCode models could not be retrieved. Check the installed OpenCode 2.2.5 CLI and its standalone provider configuration.",
  });
  assert.equal(openCodeClosed, 1);
});

// @test-value v2
// kind = "contract"
// claim = "model discoveryはprovider cleanup失敗を成功catalogとして返さない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "metadata成功後のprocess停止失敗を隠す"
// observable = "CodexとOpenCodeとCopilotのlistModels拒否message"
// observation_boundary = "public-boundary"
// scope = "model discovery cleanup failure"
// lifecycle = "permanent"
// impact = "所有processの終了未確認を隠して再取得を成功扱いする"
// distinction = "正常系cleanup呼出しの確認とは異なり失敗伝播を観測する"
// @end-test-value
/** 候補を得られても、探索で所有したプロセスの停止に失敗したときは成功を返さない。 */
it("Model discovery rejects a catalog when owned process cleanup fails", async () => {
  const codex = new CodexAdapter(undefined, {
    /** 一覧の一ページは成功させ、専用通信路の終了だけを失敗させる。 */ createTransport:
      () =>
        codexTransport(
          async () => ({ data: [codexModel("model")], nextCursor: null }),
          async () => {
            throw new Error("secret-token");
          },
        ),
  });
  await assert.rejects(codex.listModels(input()), {
    message: "Codex model discovery process cleanup failed",
  });
  const client = {
    model: {
      /** 利用できる OpenCode 候補を一件返す。 */ list: async () => ({
        data: [openCodeModel("model", "provider")],
      }),
      /** 一覧に含まれる候補とは別の既定モデルを指定しない。 */ default:
        async () => ({ data: null }),
    },
  } as unknown as OpenCodeClient;
  const openCode = new OpenCodeAdapter({
    executable: path.resolve("opencode-test.exe"),
    /** クライアントを起動できるが閉じられない通信路に置き換える。 */
    createTransport: () => ({
      /** 起動段階では型を満たす合成クライアントを返す。 */ start: async () =>
        client,
      /** 一覧の取得後にだけ停止エラーを発生させる。 */ close: async () => {
        throw new Error("secret-token");
      },
      /** 終了待ちの代役自体にはエラーを持たせない。 */ whenClosed: async () =>
        undefined,
    }),
  });
  await assert.rejects(openCode.listModels(input()), {
    message: "OpenCode model discovery process cleanup failed",
  });
  const copilotClient = {
    /** Copilot クライアントの開始を成功させ、停止処理まで到達させる。 */ start:
      async () => undefined,
    /** 失敗時にも候補が取れていたことを示すため、一件返す。 */ listModels:
      async () => [copilotModel("model")],
    /** 通常停止が完了できなかったことをエラー一覧で返す。 */ stop: async () => [
      new Error("secret-token"),
    ],
    /** 強制停止でも所有クライアントを解放できない状態を再現する。 */
    forceStop: async () => {
      throw new Error("secret-token");
    },
  } as unknown as CopilotClient;
  const copilot = new CopilotAdapter({
    /** 停止の二つの経路を失敗させる専用クライアントを返す。 */ createClient:
      () => copilotClient,
  });
  await assert.rejects(copilot.listModels(input()), {
    message: "Copilot model discovery process cleanup failed",
  });
});

// @test-value v2
// kind = "contract"
// claim = "4providerの正常0件は取得失敗と区別して空catalogを返し所有resourceを閉じる"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "正常な空SDK結果を取得失敗へ変換するか候補無しでOpenCode既定モデルAPIを呼ぶ"
// observable = "各listModelsのmodelsと空default値、close回数、OpenCode default API呼出し数"
// observation_boundary = "public-boundary"
// scope = "provider model discovery successful empty result"
// lifecycle = "permanent"
// impact = "利用可能モデルがない状態と通信や認証失敗をUIで区別できなくなる"
// distinction = "非空のmapping testや失敗testではSDK正常0件の分類とcleanupを保証できない"
// @end-test-value
/** 最初から候補がない場合と、無効候補を除いて空になった場合を成功として扱う。 */
it("All provider discovery adapters return a successful empty catalog with cleanup", async () => {
  for (const filteredOnly of [false, true]) {
    const closed = { codex: 0, claude: 0, copilot: 0, opencode: 0 };
    const codex = new CodexAdapter(undefined, {
      /** 空のページまたは非表示候補だけを返す Codex 通信路を用意する。 */ createTransport:
        () =>
          codexTransport(
            async () => ({
              data: filteredOnly
                ? [{ ...codexModel("hidden"), hidden: true }]
                : [],
              nextCursor: null,
            }),
            async () => {
              closed.codex++;
            },
          ),
    });
    const claude = new ClaudeAdapter({
      query: (() => ({
        /** Claude SDK に利用可能な候補がない場合を再現する。 */ supportedModels:
          async () => [],
        /** 空の一覧でも Claude の query を閉じたことを記録する。 */ close:
          () => {
            closed.claude++;
          },
      })) as unknown as typeof query,
      /** 空結果の検証を設定や利用者環境から独立させる。 */
      resolveSettings: async () =>
        ({ sources: [], effective: {}, provenance: {} }) as ResolvedSettings,
    });
    const copilotClient = {
      /** 探索用 Copilot クライアントの起動を成功させる。 */ start: async () =>
        undefined,
      /** 空の一覧か、ポリシーで無効になった候補だけを返す。 */ listModels:
        async () =>
          filteredOnly
            ? [
                {
                  ...copilotModel("blocked"),
                  policy: { state: "disabled", terms: "" },
                },
              ]
            : [],
      /** 候補がない場合も停止を一度だけ呼んだことを記録する。 */
      stop: async () => {
        closed.copilot++;
        return [];
      },
    } as unknown as CopilotClient;
    const copilot = new CopilotAdapter({
      /** 空結果用の専用クライアントを供給する。 */ createClient: () =>
        copilotClient,
    });
    let defaultCalls = 0;
    const openCodeClient = {
      model: {
        /** 空の一覧か、無効モデルだけの一覧を OpenCode SDK の形で返す。 */
        list: async () => ({
          data: filteredOnly
            ? [openCodeModel("disabled", "provider", false)]
            : [],
        }),
        /** 残った候補がないときに既定値を探しに行った場合は失敗させる。 */
        default: async () => {
          defaultCalls++;
          throw new Error("No default model exists");
        },
      },
    } as unknown as OpenCodeClient;
    const opencode = new OpenCodeAdapter({
      executable: path.resolve("opencode-test.exe"),
      /** 空の場合の一覧取得と終了を観測できる通信路を作る。 */
      createTransport: () => ({
        /** 探索専用の合成 OpenCode クライアントを返す。 */ start: async () =>
          openCodeClient,
        /** 空結果を返すときの通信路の終了を数える。 */ close: async () => {
          closed.opencode++;
        },
        /** プロセス終了の実イベントには依存しない。 */ whenClosed: async () =>
          undefined,
      }),
    });
    for (const adapter of [codex, claude, copilot, opencode]) {
      const catalog = await adapter.listModels(input());
      assert.deepEqual(catalog.models, []);
      assert.equal(catalog.defaultModelId, "");
      assert.equal(catalog.defaultReasoningEffort, "");
    }
    assert.deepEqual(closed, { codex: 1, claude: 1, copilot: 1, opencode: 1 });
    assert.equal(defaultCalls, 0);
  }
});
