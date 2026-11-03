import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { resolveBackgroundProviderAvailability } from "../../src-shared/settings/background-provider-support.js";
import { createBackgroundProviderAgent, type BackgroundProviderAgentDependencies } from "../../src-electron/providers/background-provider-agent.js";
import type { BackgroundAgentInput } from "../../src-electron/providers/background-call-service.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";

function fixture() {
  const session = { ...buildNewSession({ taskTitle: "Source", workspaceLabel: "fixture", workspacePath: "C:/fixture",
    branch: "fixture", characterId: "character", character: "Character", characterIconPath: "",
    characterThemeColors: { main: "#123456", sub: "#abcdef" }, approvalMode: "on-request" }),
    id: "main", incarnationId: "inc-main", threadId: "foreground-thread" };
  const input: BackgroundAgentInput = {
    session, selection: { providerId: "claude", modelId: "catalog-model" }, userInput: "/untrusted @private-path\nregistration and Character material",
    scope: { purpose: "affect", history: { source: { kind: "main", sessionId: "main", incarnationId: "inc-main",
      ownerIdentity: '["main","main","inc-main"]' }, fromMessageSeq: 0, throughMessageSeq: 1 },
    processing: { afterTurnId: null, throughTurnId: 1 }, memoryTargets: [] },
    binding: { bindingId: "binding", bindingReference: "reference", providerId: "claude", executionGeneration: "generation",
      transport: "env", expiresAt: null, background: true },
    handle: { actorSessionId: "main", providerId: "claude", bindingId: "binding", capability: "capability",
      revocationState: new SharedArrayBuffer(4) }, signal: new AbortController().signal,
  };
  const catalog: ModelCatalogSnapshot = { providers: [{ id: "claude", label: "Claude", defaultModelId: "catalog-model",
    defaultReasoningEffort: "", models: [{ id: "catalog-model", label: "Catalog Model", reasoningEfforts: [] }] }] };
  const deps: BackgroundProviderAgentDependencies = {
    getModelCatalog: () => catalog,
    projectBinding: (input) => ({ ...input.binding, turnCapability: input.handle.capability,
      memoryRuntimeOwner: { applicationInstanceId: "application", runtimeGenerationId: "runtime" },
      managedMcp: { memoryUrl: "http://localhost/memory", sessionHistoryUrl: "http://localhost/history",
        glossaryUrl: "http://localhost/glossary", sessionGraphUrl: "http://localhost/graph", token: "token" } }),
    resolveSettings: async () => ({ effective: {}, provenance: {}, sources: [] }), resolveBinaryPath: () => "fixed-native-binary",
  };
  return { input, deps, catalog };
}

function fakeQuery(messages: unknown[], closed: () => void = () => {}): Query {
  const iterator = (async function* () { for (const message of messages) yield message as SDKMessage; })();
  return Object.assign(iterator, { close: closed }) as unknown as Query;
}

// @test-value v2
// kind = "contract"
// claim = "背景Agentは発行済みbindingだけのMCPを機械的に制限し、本文を展開せず通常会話を変更しない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#共通基盤の責務" }
// fault = "coding toolや外部MCPやhookを継承するか、本文をslash commandとして展開するか、通常threadへ結果を混ぜる"
// observable = "SDKへ渡した隔離option、接続token、tool許否、promptと実行後のSession"
// observation_boundary = "consumer"
// scope = "background provider factory to injected SDK boundary"
// lifecycle = "permanent"
// impact = "背景入力が任意ファイル操作や外部tool実行へ拡大し、通常会話へ混入する"
// distinction = "型検査や共通binding testではnative SDKのoptionとtool許可を確認できない。fake SDK一回のみで低負担に権限境界を検出する"
// @end-test-value
test("background provider isolates SDK options, binding, prompt and output", async () => {
  const f = fixture(), before = structuredClone(f.input.session);
  let options: Options | undefined, prompt: unknown, closes = 0;
  const run = createBackgroundProviderAgent({ ...f.deps, query: (request) => {
    options = request.options; prompt = request.prompt;
    return fakeQuery([{ type: "assistant", message: { content: [{ type: "text", text: "private intermediate" }] } },
      { type: "result", subtype: "success", is_error: false, result: "not a save callback" }], () => { closes++; });
  } });
  assert.equal(await run(f.input), undefined);
  assert.equal(prompt, f.input.userInput);
  assert.deepEqual(f.input.session, before);
  assert.equal(closes, 1);
  assert.deepEqual(options!.tools, []); assert.deepEqual(options!.skills, []); assert.deepEqual(options!.plugins, []);
  assert.deepEqual(options!.settingSources, []); assert.equal(options!.strictMcpConfig, true);
  assert.equal(options!.persistSession, false); assert.equal(options!.verbatimPrompts, true);
  assert.equal(options!.model, "catalog-model"); assert.equal(options!.resume, undefined);
  assert.equal(typeof options!.systemPrompt, "string"); assert.ok(!String(options!.systemPrompt).includes(f.input.userInput));
  assert.equal(typeof options!.settings, "object");
  assert.deepEqual(options!.settings, { disableAllHooks: true, disableBundledSkills: true, autoMemoryEnabled: false,
    syncClaudeAiSkills: false, syncClaudeAiPlugins: false, disableClaudeAiConnectors: true });
  assert.deepEqual(Object.keys(options!.mcpServers!), ["withmate-session-history", "withmate-memory"]);
  assert.deepEqual(options!.mcpServers!["withmate-memory"], { type: "http", url: "http://localhost/memory", headers: { "x-withmate-mcp-token": "token" } });
  assert.equal(options!.env!.WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE, "reference");
  assert.equal(options!.env!.WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY, "capability");
  const permissionOptions = { signal: f.input.signal, toolUseID: "call", requestId: "request" };
  assert.equal((await options!.canUseTool!("mcp__withmate-memory__memory.append", {}, permissionOptions))?.behavior, "allow");
  assert.equal((await options!.canUseTool!("Bash", {}, permissionOptions))?.behavior, "deny");
  assert.equal((await options!.canUseTool!("mcp__external__write", {}, permissionOptions))?.behavior, "deny");
});

// @test-value v2
// kind = "contract"
// claim = "未対応選択・取得失敗・managed設定・別bindingを明示拒否し推論へfallbackしない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#共通基盤の責務" }
// fault = "不正選択を既定modelへ置換する、catalog失敗を無視する、または強制hook設定や別bindingを許す"
// observable = "availability statusと実行拒否code、SDK呼出回数"
// observation_boundary = "consumer"
// scope = "selection and configuration admission before SDK query"
// lifecycle = "permanent"
// impact = "通常Provider設定や権限を背景へ流用して意図しない実行を開始する"
// distinction = "AppSettings schemaは実catalogやnative managed設定とbindingの一致を保証しない"
// @end-test-value
test("background provider rejects unsupported selection, catalog and unsafe configuration", async () => {
  const f = fixture(); let calls = 0;
  const query: NonNullable<BackgroundProviderAgentDependencies["query"]> = () => { calls++; return fakeQuery([]); };
  assert.equal(resolveBackgroundProviderAvailability(undefined, f.catalog).status, "not_configured");
  assert.equal(resolveBackgroundProviderAvailability({ providerId: "codex", modelId: "catalog-model" }, f.catalog).status, "unavailable");
  assert.equal(resolveBackgroundProviderAvailability({ providerId: "claude", modelId: "missing" }, f.catalog).status, "unavailable");
  assert.equal(resolveBackgroundProviderAvailability(f.input.selection, null).status, "failed");
  assert.equal(resolveBackgroundProviderAvailability(f.input.selection, { ...f.catalog, discovery: { claude: { status: "error" } } }).status, "failed");
  await assert.rejects(createBackgroundProviderAgent({ ...f.deps, query })({ ...f.input, selection: { providerId: "codex", modelId: "catalog-model" } }), { code: "BACKGROUND_PROVIDER_UNSUPPORTED" });
  await assert.rejects(createBackgroundProviderAgent({ ...f.deps, query, getModelCatalog: () => { throw new Error("discovery"); } })(f.input), { code: "BACKGROUND_CATALOG_UNAVAILABLE" });
  await assert.rejects(createBackgroundProviderAgent({ ...f.deps, query, resolveSettings: async () => ({ effective: {}, provenance: {}, sources: [{ source: "managed", settings: {} }] }) })(f.input), { code: "BACKGROUND_PROVIDER_CONFIGURATION_UNSUPPORTED" });
  await assert.rejects(createBackgroundProviderAgent({ ...f.deps, query, projectBinding: async (input) => ({ ...await f.deps.projectBinding(input), bindingId: "different" }) })(f.input), { code: "BACKGROUND_BINDING_INVALID" });
  const previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
  try {
    process.env.ANTHROPIC_BASE_URL = "https://custom.invalid";
    await assert.rejects(createBackgroundProviderAgent({ ...f.deps, query })(f.input), { code: "BACKGROUND_PROVIDER_CONFIGURATION_UNSUPPORTED" });
  } finally {
    if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
  }
  assert.equal(calls, 0);
});

// @test-value v2
// kind = "contract"
// claim = "取消・Provider失敗でもcloseを実行しnative process終了前に背景portを解放しない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#共通基盤の責務" }
// fault = "SDK失敗を成功にするか、取消後に子process cleanup前にadmission所有者へ制御を返す"
// observable = "拒否code、close回数、process close前後のport完了状態"
// observation_boundary = "consumer"
// scope = "SDK cancellation and native cleanup lifetime"
// lifecycle = "permanent"
// impact = "終了扱いの背景processに権限が残るか、失敗を正常実行と誤認する"
// distinction = "共通service fake portでは実adapterがprocess cleanupをawaitすることを検出できない"
// @end-test-value
test("background provider propagates failures and waits for owned process cleanup on cancellation", async () => {
  const f = fixture(); let closes = 0;
  await assert.rejects(createBackgroundProviderAgent({ ...f.deps,
    query: () => fakeQuery([{ type: "result", subtype: "error_during_execution" }], () => { closes++; }) })(f.input), { code: "BACKGROUND_AGENT_FAILED" });
  await assert.rejects(createBackgroundProviderAgent({ ...f.deps, query: () => fakeQuery([]) })(f.input), { code: "BACKGROUND_AGENT_INCOMPLETE" });
  assert.equal(closes, 1);
  const controller = new AbortController(), child = new EventEmitter();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let settled = false;
  const run = createBackgroundProviderAgent({ ...f.deps,
    spawnProcess: (() => child) as unknown as NonNullable<BackgroundProviderAgentDependencies["spawnProcess"]>,
    query: ({ options }) => {
      options!.spawnClaudeCodeProcess!({ command: "fake", args: [], cwd: "C:/fixture", env: {}, signal: options!.abortController!.signal });
      const iterator = (async function* () { entered(); await waiting; })();
      return Object.assign(iterator, { close: () => { release(); } }) as unknown as Query;
    },
  });
  const pending = Promise.resolve(run({ ...f.input, signal: controller.signal })).finally(() => { settled = true; });
  await started; controller.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  child.emit("close");
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(settled, true);
});
