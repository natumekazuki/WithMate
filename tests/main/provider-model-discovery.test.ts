import assert from "node:assert/strict";
import path from "node:path";
import { it } from "node:test";
import type { query, ResolvedSettings, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CopilotClient, ModelInfo as CopilotModel } from "@github/copilot-sdk";
import type { OpenCodeClient, ModelInfo as OpenCodeModel } from "@opencode/client";
import { CodexAdapter, type CodexAdapterOptions } from "../../src-electron/providers/codex/codex-adapter.js";
import { ClaudeAdapter } from "../../src-electron/providers/claude/claude-adapter.js";
import { CopilotAdapter } from "../../src-electron/providers/copilot/copilot-adapter.js";
import { OpenCodeAdapter } from "../../src-electron/providers/opencode/opencode-adapter.js";
import { resolveOpenCodeModelRef } from "../../src-electron/providers/opencode/opencode-model.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";

const input = () => ({ appSettings: createDefaultAppSettings(), workspacePath: process.cwd() });
type CodexTransport = ReturnType<NonNullable<CodexAdapterOptions["createTransport"]>>;
function codexModel(id: string, isDefault = false) {
  return { id, model: id, displayName: `Label ${id}`, isDefault, hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }, { reasoningEffort: "persistent", description: "Persistent" }], defaultReasoningEffort: "persistent" };
}
function codexTransport(request: (method: string, params: unknown) => Promise<unknown>, close: () => Promise<void>): CodexTransport {
  return { start: async () => undefined, request, close, whenClosed: async () => undefined,
    nextEvent: async () => { throw new Error("Discovery must not read turn events"); } } as CodexTransport;
}
function openCodeModel(id: string, providerID: string, enabled = true): OpenCodeModel {
  return { id, providerID, name: `Label ${id}`, enabled, variants: [{ id: "careful" }] } as OpenCodeModel;
}
function copilotModel(id: string, reasoning = true): CopilotModel {
  return { id, name: `Label ${id}`, capabilities: { supports: { vision: false, reasoningEffort: reasoning }, limits: { max_context_window_tokens: 100 } },
    ...(reasoning ? { supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" } : {}) };
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
it("Codex discovery maps paginated models and SDK defaults then closes its transport", async () => {
  const cursors: unknown[] = [];
  let closed = 0;
  const adapter = new CodexAdapter(undefined, { createTransport: () => codexTransport(async (method, params) => {
    assert.equal(method, "model/list");
    const cursor = (params as { cursor: unknown }).cursor;
    cursors.push(cursor);
    return cursor === null ? { data: [codexModel("first")], nextCursor: "next" }
      : { data: [{ ...codexModel("preferred", true), id: "preferred-preset" }, { ...codexModel("hidden"), hidden: true }], nextCursor: null };
  }, async () => { closed++; }) });
  const catalog = await adapter.listModels(input());
  assert.deepEqual(cursors, [null, "next"]);
  assert.deepEqual(catalog.models, ["first", "preferred"].map((id) => ({ id, label: `Label ${id}`, reasoningEfforts: ["low", "persistent"], defaultReasoningEffort: "persistent" })));
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
it("Codex discovery rejects failures and repeated cursors with cleanup and sanitized errors", async () => {
  for (const failure of ["provider", "cursor"] as const) {
    let closed = 0;
    const adapter = new CodexAdapter(undefined, { createTransport: () => codexTransport(async () => {
      if (failure === "provider") throw new Error("secret-token-from-provider");
      return { data: [codexModel("first")], nextCursor: "repeated" };
    }, async () => { closed++; }) });
    await assert.rejects(adapter.listModels(input()), { message: "Codex models could not be retrieved" });
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
it("OpenCode discovery preserves enabled native provider IDs, variants and SDK default", async () => {
  const rows = [openCodeModel("shared", "first"), openCodeModel("shared", "second"), openCodeModel("disabled", "first", false)];
  let closed = 0;
  const location = { directory: process.cwd() };
  const client = { model: {
    list: async (args: unknown) => { assert.deepEqual(args, { location }); return { data: rows }; },
    default: async () => ({ data: rows[1] }),
  } } as unknown as OpenCodeClient;
  const adapter = new OpenCodeAdapter({ executable: path.resolve("opencode-test.exe"), databasePath: path.resolve("opencode-test.db"),
    createTransport: () => ({ start: async () => client, close: async () => { closed++; }, whenClosed: async () => undefined }) });
  const catalog = await adapter.listModels(input());
  assert.deepEqual(catalog.models, ["first", "second"].map((provider) => ({ id: `${provider}/shared`, label: "Label shared", sourceLabel: provider, reasoningEfforts: ["careful"], defaultReasoningEffort: "" })));
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
it("OpenCode model references preserve native variants and omit unspecified Depth", () => {
  assert.deepEqual(resolveOpenCodeModelRef("provider/model/nested", "careful"), { providerID: "provider", id: "model/nested", variant: "careful" });
  assert.deepEqual(resolveOpenCodeModelRef("provider/model/nested", ""), { providerID: "provider", id: "model/nested" });
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
it("Claude discovery reads metadata with a never-yielding prompt and closes the query", async () => {
  let closed = 0;
  let pendingInput: Promise<IteratorResult<SDKUserMessage>> | undefined;
  const runQuery = ((args: Parameters<typeof query>[0]) => {
    assert.notEqual(typeof args.prompt, "string");
    pendingInput = (args.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next();
    assert.deepEqual(args.options?.tools, []);
    assert.deepEqual(args.options?.settingSources, []);
    assert.deepEqual(args.options?.settings, { disableAllHooks: true });
    assert.equal(args.options?.strictMcpConfig, true);
    assert.equal(args.options?.persistSession, false);
    return { supportedModels: async () => [
      { value: "alias", displayName: "Native alias", supportsEffort: true, supportedEffortLevels: ["low", "max"] },
      { value: "no-depth", displayName: "No depth", supportsEffort: false },
    ], close: () => { closed++; } };
  }) as unknown as typeof query;
  const adapter = new ClaudeAdapter({ query: runQuery, resolveSettings: async () => ({ sources: [], effective: {}, provenance: {} } as ResolvedSettings) });
  const catalog = await adapter.listModels(input());
  assert.deepEqual(await pendingInput, { done: true, value: undefined });
  assert.deepEqual(catalog.models, [
    { id: "alias", label: "Native alias", reasoningEfforts: ["low", "max"], defaultReasoningEffort: "" },
    { id: "no-depth", label: "No depth", reasoningEfforts: [], defaultReasoningEffort: "" },
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
it("Copilot discovery uses capability and policy metadata with an owned client", async () => {
  let stopped = 0;
  const client = { start: async () => undefined, listModels: async () => [copilotModel("native"), copilotModel("no-depth", false),
    { ...copilotModel("blocked"), policy: { state: "disabled", terms: "" } }], stop: async () => { stopped++; return []; } } as unknown as CopilotClient;
  const adapter = new CopilotAdapter({ createClient: (options) => {
    assert.equal(options?.workingDirectory, process.cwd());
    return client;
  } });
  const catalog = await adapter.listModels(input());
  assert.deepEqual(catalog.models, [
    { id: "native", label: "Label native", reasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" },
    { id: "no-depth", label: "Label no-depth", reasoningEfforts: [], defaultReasoningEffort: "" },
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
it("Copilot discovery aborts a pending SDK metadata request and stops the owned client", async () => {
  let stopped = 0;
  const controller = new AbortController();
  const client = { start: async () => undefined, listModels: () => { controller.abort(); return new Promise(() => undefined); },
    stop: async () => { stopped++; return []; } } as unknown as CopilotClient;
  const adapter = new CopilotAdapter({ createClient: () => client });
  await assert.rejects(adapter.listModels({ ...input(), signal: controller.signal }), { message: "Copilot model discovery canceled" });
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
it("Claude and OpenCode discovery sanitize metadata failures and close their owned resources", async () => {
  let claudeClosed = 0;
  const claude = new ClaudeAdapter({
    query: (() => ({ supportedModels: async () => { throw new Error("secret-token"); }, close: () => { claudeClosed++; } })) as unknown as typeof query,
    resolveSettings: async () => ({ sources: [], effective: {}, provenance: {} } as ResolvedSettings),
  });
  await assert.rejects(claude.listModels(input()), { message: "Claude models could not be retrieved" });
  assert.equal(claudeClosed, 1);
  let openCodeClosed = 0;
  const client = { model: { list: async () => { throw new Error("secret-token"); }, default: async () => ({ data: null }) } } as unknown as OpenCodeClient;
  const openCode = new OpenCodeAdapter({ executable: path.resolve("opencode-test.exe"), databasePath: path.resolve("opencode-test.db"),
    createTransport: () => ({ start: async () => client, close: async () => { openCodeClosed++; }, whenClosed: async () => undefined }) });
  await assert.rejects(openCode.listModels(input()), { message: "OpenCode models could not be retrieved" });
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
it("Model discovery rejects a catalog when owned process cleanup fails", async () => {
  const codex = new CodexAdapter(undefined, { createTransport: () => codexTransport(async () => ({ data: [codexModel("model")], nextCursor: null }), async () => { throw new Error("secret-token"); }) });
  await assert.rejects(codex.listModels(input()), { message: "Codex model discovery process cleanup failed" });
  const client = { model: { list: async () => ({ data: [openCodeModel("model", "provider")] }), default: async () => ({ data: null }) } } as unknown as OpenCodeClient;
  const openCode = new OpenCodeAdapter({ executable: path.resolve("opencode-test.exe"), databasePath: path.resolve("opencode-test.db"),
    createTransport: () => ({ start: async () => client, close: async () => { throw new Error("secret-token"); }, whenClosed: async () => undefined }) });
  await assert.rejects(openCode.listModels(input()), { message: "OpenCode model discovery process cleanup failed" });
  const copilotClient = { start: async () => undefined, listModels: async () => [copilotModel("model")], stop: async () => [new Error("secret-token")],
    forceStop: async () => { throw new Error("secret-token"); } } as unknown as CopilotClient;
  const copilot = new CopilotAdapter({ createClient: () => copilotClient });
  await assert.rejects(copilot.listModels(input()), { message: "Copilot model discovery process cleanup failed" });
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
it("All provider discovery adapters return a successful empty catalog with cleanup", async () => {
  for (const filteredOnly of [false, true]) {
    const closed = { codex: 0, claude: 0, copilot: 0, opencode: 0 };
    const codex = new CodexAdapter(undefined, { createTransport: () => codexTransport(async () => ({
      data: filteredOnly ? [{ ...codexModel("hidden"), hidden: true }] : [], nextCursor: null,
    }), async () => { closed.codex++; }) });
    const claude = new ClaudeAdapter({
      query: (() => ({ supportedModels: async () => [], close: () => { closed.claude++; } })) as unknown as typeof query,
      resolveSettings: async () => ({ sources: [], effective: {}, provenance: {} } as ResolvedSettings),
    });
    const copilotClient = { start: async () => undefined, listModels: async () => filteredOnly
      ? [{ ...copilotModel("blocked"), policy: { state: "disabled", terms: "" } }] : [],
    stop: async () => { closed.copilot++; return []; } } as unknown as CopilotClient;
    const copilot = new CopilotAdapter({ createClient: () => copilotClient });
    let defaultCalls = 0;
    const openCodeClient = { model: {
      list: async () => ({ data: filteredOnly ? [openCodeModel("disabled", "provider", false)] : [] }),
      default: async () => { defaultCalls++; throw new Error("No default model exists"); },
    } } as unknown as OpenCodeClient;
    const opencode = new OpenCodeAdapter({ executable: path.resolve("opencode-test.exe"), databasePath: path.resolve("opencode-test.db"),
      createTransport: () => ({ start: async () => openCodeClient, close: async () => { closed.opencode++; }, whenClosed: async () => undefined }) });
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
