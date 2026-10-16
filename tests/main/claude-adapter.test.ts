import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { it } from "node:test";
import type { Options, ResolvedSettings, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter } from "../../src-electron/providers/claude/claude-adapter.js";
import { ProviderTurnError, type RunBackgroundStructuredPromptInput, type RunSessionTurnInput } from "../../src-electron/providers/provider-runtime.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { createDefaultSessionMemory } from "../../src-shared/memory/session-memory-state.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER } from "../../src-electron/providers/provider-agent-runtime-binding.js";
import { PROVIDER_TEXT_PREVIEW_LIMIT } from "../../src-electron/session/provider-payload-limits.js";

function fakeQuery(
  produce: (options: Options) => AsyncGenerator<SDKMessage, void>,
  capture: (options: Options, prompt: unknown) => void = () => undefined,
): typeof import("@anthropic-ai/claude-agent-sdk").query {
  return (({ options, prompt }: { options: Options; prompt: unknown }) => {
    capture(options, prompt);
    return produce(options);
  }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
}

// @test-value v2
// kind = "contract"
// claim = "Claudeのcompleted/failed/canceledは取得済みtool結果と未完了toolを通常artifactへ順序どおり保持する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "turnの失敗・取消で個別tool結果を上書きするか未完了toolをartifactから落とす"
// observable = "runSessionTurn結果またはProviderTurnError.partialResultのoperationTimeline"
// observation_boundary = "public-boundary"
// scope = "Claude coding artifact terminal and partial result"
// lifecycle = "permanent"
// impact = "失敗や取消後に取得済み操作の結果と順序が失われる"
// distinction = "既存本文partial testはtool結果と未完了toolの区別を観測しない"
// @end-test-value
it("Claudeはturn成否に依存せず個別tool結果を保持する", async () => {
  for (const outcome of ["completed", "failed", "canceled"] as const) {
    const controller = new AbortController();
    const adapter = new ClaudeAdapter({ query: fakeQuery(async function* () {
      yield sdkMessage({ type: "assistant", uuid: "tools", parent_tool_use_id: null, message: { content: [
        { type: "tool_use", id: "done", name: "Bash", input: { command: "first" } },
        { type: "tool_use", id: "pending", name: "Bash", input: { command: "second" } },
      ] } });
      yield sdkMessage({ type: "user", parent_tool_use_id: null, message: { content: [
        { type: "tool_result", tool_use_id: "done", is_error: true, content: "failed output" },
      ] } });
      if (outcome === "canceled") controller.abort();
      if (outcome === "failed") throw new Error("connection failure");
      yield result("thread");
    }) });
    let completed;
    try { completed = await adapter.runSessionTurn(input("", controller.signal)); assert.equal(outcome, "completed"); }
    catch (error) { assert.ok(error instanceof ProviderTurnError); assert.equal(error.canceled, outcome === "canceled"); completed = error.partialResult; }
    const operations = completed.artifact!.operationTimeline!;
    assert.deepEqual(operations.map(({ id, status }) => ({ id, status })), [
      { id: "done", status: "failed" }, { id: "pending", status: "in_progress" },
    ]);
    assert.deepEqual(operations[0].error, { message: "failed output" });
    assert.equal(operations[0].exitCode, undefined);
    assert.equal(operations[1].details, undefined);
  }
});

function input(threadId = "", signal?: AbortSignal): RunSessionTurnInput {
  const session = { ...buildNewSession({
    provider: "claude", taskTitle: "Claude test", workspaceLabel: "workspace", workspacePath: process.cwd(),
    branch: "main", characterId: "character", character: "Character", characterIconPath: "",
    characterThemeColors: { main: "#112233", sub: "#445566" }, approvalMode: "on-request",
    model: "claude-opus-5-5", reasoningEffort: "high", customAgentName: "",
  }), threadId };
  return {
    session, executionOptions: captureSessionExecutionOptions(session), sessionMemory: createDefaultSessionMemory(session),
    projectMemoryEntries: [], providerCatalog: {
      id: "claude", label: "Claude", defaultModelId: "claude-opus-5-5", defaultReasoningEffort: "high",
      models: [{ id: "claude-opus-5-5", label: "Opus", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] }],
    },
    userMessage: "hello", appSettings: createDefaultAppSettings(), attachments: [], signal,
  };
}

function sdkMessage(value: Record<string, unknown>): SDKMessage { return value as SDKMessage; }

// @test-value v2
// kind = "contract"
// claim = "Claude quota取得は空streamのcontrol APIだけを使い、子processの終了後に値を返す"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md" }
// fault = "quota取得でmodel promptを送るか、子processが生きたまま取得完了する"
// observable = "SDKへ渡すprompt、分離options、control引数、返却時のchild close状態"
// observation_boundary = "public-boundary"
// scope = "Claude quota control request lifecycle"
// lifecycle = "permanent"
// impact = "quota表示だけでmodel枠を消費しprocessを残すことを防ぐ"
// distinction = "通常turn testはprompt無しcontrol APIのprocess lifecycleを通らない"
// @end-test-value
it("retrieves Claude quota without a prompt and waits for child close", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 123, stderr: { on() {}, resume() {} } });
  let closed = false;
  let promptResult: Promise<IteratorResult<unknown>> | undefined;
  let initialized = false;
  const adapter = new ClaudeAdapter({
    resolveSettings: async () => ({ sources: [], effective: {}, provenance: {} } as ResolvedSettings),
    spawnProcess: ((_command: string, _args: string[], options: { windowsHide?: boolean }) => {
      assert.equal(options?.windowsHide, true);
      return child;
    }) as unknown as typeof spawn,
    query: (({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Options }) => {
      assert.deepEqual(options.tools, []);
      assert.deepEqual(options.mcpServers, {});
      assert.deepEqual(options.settingSources, []);
      assert.deepEqual(options.settings, { disableAllHooks: true });
      assert.equal(options.strictMcpConfig, true);
      assert.equal(options.persistSession, false);
      promptResult = prompt[Symbol.asyncIterator]().next();
      options.spawnClaudeCodeProcess!({ command: "claude", args: [], cwd: process.cwd(), env: process.env, signal: options.abortController!.signal });
      return {
        initializationResult: async () => { initialized = true; },
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (options: unknown) => {
          assert.equal(initialized, true);
          assert.deepEqual(options, { skipBehaviors: true });
          return { rate_limits_available: true, rate_limits: { five_hour: { utilization: 42, resets_at: null } } };
        },
        close: () => { setImmediate(() => { closed = true; child.emit("close"); }); },
      };
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query,
  });
  const result = await adapter.getProviderQuotaTelemetry({ providerId: "claude", appSettings: createDefaultAppSettings() });
  assert.equal(result?.rateLimits?.[0].usedPercentage, 42);
  assert.equal(closed, true);
  assert.deepEqual(await promptResult, { done: true, value: undefined });
});

// @test-value v2
// kind = "security"
// claim = "Claude quotaはmanaged policyの存在と検証失敗、取消時にSDK queryを起動しない"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md" }
// fault = "強制hookやMCPの検証前または取消後にquota processを起動する"
// observable = "getProviderQuotaTelemetryのrejectとquery起動回数"
// observation_boundary = "public-boundary"
// scope = "Claude quota background isolation gate"
// lifecycle = "permanent"
// risk_tags = ["privacy"]
// distinction = "background prompt testは独立したquota取得入口を通らない"
// @end-test-value
it("rejects unverified, managed or canceled Claude quota requests before query", async () => {
  for (const outcome of ["managed", "failure", "canceled"] as const) {
    let calls = 0;
    const controller = new AbortController();
    if (outcome === "canceled") controller.abort();
    const adapter = new ClaudeAdapter({
      query: (() => { calls++; throw new Error("Unexpected query"); }) as typeof import("@anthropic-ai/claude-agent-sdk").query,
      resolveSettings: async () => {
        if (outcome === "failure") throw new Error("Settings inspection failed");
        return { sources: [{ source: "managed", settings: {} }], effective: {}, provenance: {} } as ResolvedSettings;
      },
    });
    await assert.rejects(adapter.getProviderQuotaTelemetry({ providerId: "claude", appSettings: createDefaultAppSettings(), signal: controller.signal }));
    assert.equal(calls, 0);
  }
});

// @test-value v2
// kind = "contract"
// claim = "Claude quota取得は初期化中・control待機中の取消と30秒deadline、SDK失敗でcloseし実終了を待つ"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md" }
// fault = "control待機が取消・deadline後も続くか、失敗時に子processを残してrejectする"
// observable = "取得promiseのreject、SDK close回数、reject時のchild終了状態"
// observation_boundary = "public-boundary"
// scope = "Claude quota cancellation deadline and failure cleanup"
// lifecycle = "permanent"
// distinction = "通常turnの取消testはquotaのinitializationResultとcontrol待機を通らない"
// @end-test-value
it("closes and awaits Claude quota child after cancellation, deadline or SDK failure", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  for (const outcome of ["initialization-cancel", "control-cancel", "deadline", "failure"] as const) {
    const controller = new AbortController();
    const child = Object.assign(new EventEmitter(), { pid: 123, stderr: { on() {}, resume() {} } });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let closed = false;
    let closeCalls = 0;
    const pending = () => new Promise<never>(() => undefined);
    const adapter = new ClaudeAdapter({
      resolveSettings: async () => ({ sources: [], effective: {}, provenance: {} } as ResolvedSettings),
      spawnProcess: (() => child) as unknown as typeof spawn,
      query: (({ options }: { options: Options }) => {
        options.spawnClaudeCodeProcess!({ command: "claude", args: [], cwd: process.cwd(), env: process.env, signal: options.abortController!.signal });
        return {
          initializationResult: async () => {
            if (outcome === "initialization-cancel") { entered(); return pending(); }
          },
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
            entered();
            if (outcome === "failure") throw new Error("SDK usage failed");
            return pending();
          },
          close: () => { closeCalls++; setImmediate(() => { closed = true; child.emit("close"); }); },
        };
      }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const request = adapter.getProviderQuotaTelemetry({ providerId: "claude", appSettings: createDefaultAppSettings(), signal: controller.signal });
    const rejection = assert.rejects(request, outcome === "failure" ? /SDK usage failed/ : /Canceled/);
    await started;
    if (outcome === "deadline") context.mock.timers.tick(30_000);
    else if (outcome !== "failure") controller.abort();
    await rejection;
    assert.equal(closeCalls, 1);
    assert.equal(closed, true);
  }
});

// @test-value v2
// kind = "security"
// claim = "Bash commandのpreview境界を跨ぐcapabilityはliveと正常・失敗・取消artifactのsummaryに断片を残さない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Managed HTTP MCP / Streaming Policy" }
// fault = "commandを秘匿前に切り詰め、完全一致しなくなったtokenのprefixを公開する"
// observable = "progress stepとresultまたはpartialResultのcommand summary"
// observation_boundary = "public-boundary"
// scope = "Claude Bash command preview redaction"
// lifecycle = "permanent"
// risk_tags = ["privacy", "authentication"]
// impact = "runtime capabilityの断片が画面と保存履歴へ漏洩する"
// distinction = "既存tool_result testとbounded command testは入力command内のsecret境界を検査しない"
// @end-test-value
it("ClaudeはBash commandを秘匿してからpreviewを生成する", async () => {
  const secret = "synthetic-command-capability-0123456789";
  const prefix = secret.slice(0, 8);
  const command = "x".repeat(PROVIDER_TEXT_PREVIEW_LIMIT - prefix.length) + secret + " tail";
  const sanitized = command.replace(secret, PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER);
  const expected = `${sanitized.slice(0, PROVIDER_TEXT_PREVIEW_LIMIT)}\n...[truncated ${command.length - PROVIDER_TEXT_PREVIEW_LIMIT} chars; originalLength=${command.length}]`;
  for (const outcome of ["completed", "failed", "canceled"] as const) {
    const controller = new AbortController();
    const request = input("", controller.signal);
    request.agentRuntimeBinding = { bindingId: "fixture", bindingReference: "fixture-reference", turnCapability: secret,
      providerId: "claude", executionGeneration: "fixture", transport: "env", expiresAt: null };
    const adapter = new ClaudeAdapter({ query: fakeQuery(async function* () {
      yield sdkMessage({ type: "assistant", uuid: "command", parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: "command", name: "Bash", input: { command } }] } });
      if (outcome === "failed") throw new Error("connection failure");
      if (outcome === "canceled") controller.abort();
      yield result("thread");
    }) });
    const summaries: string[] = [];
    let completed;
    try {
      completed = await adapter.runSessionTurn(request, (state) => { summaries.push(...state.steps.map((step) => step.summary)); });
      assert.equal(outcome, "completed");
    } catch (error) {
      assert.ok(error instanceof ProviderTurnError);
      assert.notEqual(outcome, "completed");
      assert.equal(error.canceled, outcome === "canceled");
      completed = error.partialResult;
    }
    assert.ok(summaries.length > 0);
    summaries.push(completed.artifact!.operationTimeline![0].summary);
    for (const summary of summaries) {
      assert.equal(summary, expected);
      assert.ok(!summary.includes(prefix));
    }
  }
});

// @test-value v2
// kind = "security"
// claim = "Claude tool出力のpreview境界を跨ぐcapabilityは文字列と構造化結果のlive・正常・失敗・取消artifactに断片を残さない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Agent Runtime Binding / Streaming Policy" }
// fault = "secret全体の秘匿より先にtool結果を切り詰めて一致しないsecret prefixを公開する"
// observable = "runSessionTurn進捗stepと結果またはpartialResultのdetails・error・truncated"
// observation_boundary = "public-boundary"
// scope = "Claude tool_result preview redaction"
// lifecycle = "permanent"
// risk_tags = ["privacy", "authentication"]
// impact = "runtime capabilityの一部が画面と保存履歴へ漏洩することを防ぐ"
// distinction = "既存secret testは本文の完全一致を観測するだけでtool出力のpreview境界とerrorの断片を検査しない"
// @end-test-value
it("Claude tool出力はsecretを秘匿してからpreviewを生成する", async () => {
  const secret = "synthetic-tool-capability-0123456789XY";
  for (const structured of [false, true]) {
    for (const outcome of ["completed", "failed", "canceled"] as const) {
      const controller = new AbortController();
      const request = input("", controller.signal);
      request.agentRuntimeBinding = { bindingId: "fixture", bindingReference: "fixture-reference", turnCapability: secret,
        providerId: "claude", executionGeneration: "fixture", transport: "env", expiresAt: null };
      const wrapperLength = structured ? JSON.stringify([{ type: "text", text: "" }]).indexOf('""') + 1 : 0;
      const text = "x".repeat(PROVIDER_TEXT_PREVIEW_LIMIT - secret.length + 1 - wrapperLength) + secret + " tail";
      const content = structured ? [{ type: "text", text }] : text;
      const output = typeof content === "string" ? content : JSON.stringify(content);
      const sanitized = output.replace(secret, PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER);
      const expected = sanitized.length <= PROVIDER_TEXT_PREVIEW_LIMIT ? sanitized
        : `${sanitized.slice(0, PROVIDER_TEXT_PREVIEW_LIMIT)}\n...[truncated ${sanitized.length - PROVIDER_TEXT_PREVIEW_LIMIT} chars; originalLength=${sanitized.length}]`;
      const adapter = new ClaudeAdapter({ query: fakeQuery(async function* () {
        yield sdkMessage({ type: "assistant", uuid: "tool", parent_tool_use_id: null,
          message: { content: [{ type: "tool_use", id: "tool", name: "Bash", input: { command: "check" } }] } });
        yield sdkMessage({ type: "user", parent_tool_use_id: null,
          message: { content: [{ type: "tool_result", tool_use_id: "tool", is_error: true, content }] } });
        if (outcome === "failed") throw new Error("connection failure");
        if (outcome === "canceled") controller.abort();
        yield result("thread");
      }) });
      const steps: import("../../src-shared/session/runtime-state.js").LiveRunStep[] = [];
      let completed;
      try {
        completed = await adapter.runSessionTurn(request, (state) => { steps.push(...state.steps); });
        assert.equal(outcome, "completed");
      } catch (error) {
        assert.ok(error instanceof ProviderTurnError);
        assert.equal(error.canceled, outcome === "canceled");
        assert.notEqual(outcome, "completed");
        completed = error.partialResult;
      }
      const operation = completed.artifact!.operationTimeline![0];
      const live = steps.findLast((step) => step.id === "tool" && step.status === "failed");
      assert.ok(live);
      for (const projected of [live, operation]) {
        assert.equal(projected.details, expected);
        assert.deepEqual(projected.error, { message: expected });
        assert.equal(projected.truncated, sanitized.length > PROVIDER_TEXT_PREVIEW_LIMIT);
        assert.ok(!JSON.stringify(projected).includes(secret.slice(0, -1)));
      }
    }
  }
});

// @test-value v2
// kind = "security"
// claim = "Claude Bash commandのpreview境界を跨ぐbinding reference・capability・managed MCP tokenをliveと正常・失敗・取消artifactへ露出しない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Managed HTTP MCP / Streaming Policy" }
// fault = "全文secretを秘匿する前にcommand summaryを切り、末尾1文字を欠くsecretを公開する"
// observable = "runSessionTurn進捗のcommand_execution.summaryと結果またはpartialResultのoperationTimeline.summary"
// observation_boundary = "public-boundary"
// scope = "Claude Bash command summary redaction"
// lifecycle = "permanent"
// risk_tags = ["privacy", "authentication"]
// impact = "runtime資格情報のほぼ全体が画面と保存履歴へ漏洩する"
// distinction = "tool_result境界testはcommand入力を通らず、bounded summary testにはsecretがない。SDK通信不要の小さいfixtureで秘匿順序を継続検査する"
// @end-test-value
it("Claude Bash commandはsecretを秘匿してからpreviewを生成する", async () => {
  const secrets = ["synthetic-binding-reference-0123456789XY", "synthetic-turn-capability-0123456789XY", "synthetic-managed-mcp-token-0123456789XY"];
  for (const secret of secrets) {
    for (const outcome of ["completed", "failed", "canceled"] as const) {
      const controller = new AbortController();
      const request = input("", controller.signal);
      request.agentRuntimeBinding = { bindingId: "fixture", bindingReference: secrets[0], turnCapability: secrets[1],
        providerId: "claude", executionGeneration: "fixture", transport: "env", expiresAt: null,
        managedMcp: { memoryUrl: "http://localhost/mcp/memory", glossaryUrl: "http://localhost/mcp/glossary", token: secrets[2] } };
      const command = "x".repeat(PROVIDER_TEXT_PREVIEW_LIMIT - secret.length + 1) + secret + " tail".repeat(100);
      const prefix = "x".repeat(PROVIDER_TEXT_PREVIEW_LIMIT - secret.length + 1);
      const expected = `${(prefix + PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER).slice(0, PROVIDER_TEXT_PREVIEW_LIMIT)}\n...[truncated ${command.length - PROVIDER_TEXT_PREVIEW_LIMIT} chars; originalLength=${command.length}]`;
      const adapter = new ClaudeAdapter({ query: fakeQuery(async function* () {
        yield sdkMessage({ type: "assistant", uuid: "command", parent_tool_use_id: null,
          message: { content: [{ type: "tool_use", id: "command", name: "Bash", input: { command } }] } });
        if (outcome === "failed") throw new Error("connection failure");
        if (outcome === "canceled") controller.abort();
        yield result("thread");
      }) });
      const steps: import("../../src-shared/session/runtime-state.js").LiveRunStep[] = [];
      let completed;
      try {
        completed = await adapter.runSessionTurn(request, (state) => { steps.push(...state.steps); });
        assert.equal(outcome, "completed");
      } catch (error) {
        assert.ok(error instanceof ProviderTurnError);
        assert.equal(error.canceled, outcome === "canceled");
        assert.notEqual(outcome, "completed");
        completed = error.partialResult;
      }
      const live = steps.findLast((step) => step.id === "command");
      assert.ok(live);
      const operation = completed.artifact!.operationTimeline![0];
      for (const projected of [live, operation]) {
        assert.equal(projected.type, "command_execution");
        assert.ok(!projected.summary.includes(secret.slice(0, -1)));
        assert.equal(projected.summary, expected);
      }
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "Claudeのlive callback拒否は取得済み本文付きの非取消ProviderTurnErrorとなり、後続SDK eventを消費しない"
// oracle = { type = "contract", ref = "src-electron/providers/claude/claude-adapter.ts: runSessionTurn; src-electron/providers/provider-progress.ts: ProviderProgressDelivery.deliver" }
// fault = "callback rejectをwarnだけで握り潰してSDK実行を続けるかユーザー取消へ誤分類する"
// observable = "runSessionTurnがrejectするProviderTurnErrorのmessage/canceled/partialResult.assistantTextと後続generator実行フラグ"
// observation_boundary = "public-boundary"
// scope = "ClaudeAdapter progress failure and cleanup"
// lifecycle = "permanent"
// impact = "live consumerの失敗を無視した実行継続や取得済み本文の喪失、利用者取消への誤分類を防ぐ"
// distinction = "delivery helper単体ではSDK loop停止とpartial分類を検査できない"
// @end-test-value
it("Claudeはprogress拒否をpartial付きfailureとして返しSDK消費を止める", async () => {
  let advancedAfterPartial = false;
  const adapter = new ClaudeAdapter({ query: fakeQuery(async function* () {
    yield sdkMessage({ type: "assistant", session_id: "pressure", uuid: "partial", parent_tool_use_id: null, message: { content: [{ type: "text", text: "retained" }] } });
    advancedAfterPartial = true;
    yield result("pressure");
  }) });
  await assert.rejects(adapter.runSessionTurn(input(), () => Promise.reject(new Error("live delivery failure"))), (error: unknown) => {
    assert.ok(error instanceof ProviderTurnError);
    assert.equal(error.canceled, false);
    assert.equal(error.partialResult?.assistantText, "retained");
    assert.match(error.message, /live delivery failure/);
    return true;
  });
  assert.equal(advancedAfterPartial, false);
});

function result(sessionId: string, overrides: Record<string, unknown> = {}): SDKMessage {
  return sdkMessage({
    type: "result", subtype: "success", is_error: false, result: "Final", session_id: sessionId,
    usage: { input_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 5 },
    modelUsage: { "claude-opus-5-5": { inputTokens: 7, cacheReadInputTokens: 3, cacheCreationInputTokens: 2, outputTokens: 5, thinkingTokens: 1 } },
    ...overrides,
  });
}

// @test-value v2
// kind = "invariant"
// claim = "Claudeの長い本文はprogressへ全量配送して成功結果にも保持する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#streaming-policy" }
// fault = "必要な本文をprogress容量だけで拒否するか最終結果を切り捨てる"
// observable = "callbackの本文とrunSessionTurnの成功結果本文"
// observation_boundary = "public-boundary"
// scope = "Claude large valid progress"
// lifecycle = "permanent"
// impact = "正常な長文turnがアプリの人工的な容量判定で中断しない"
// distinction = "共有delivery単体ではSDK messageから最終本文までの配線を確認できない;固定4 Mi文字入力を通信なしで確認する"
// @end-test-value
it("Claudeの長い本文をprogressと成功結果に保持する", async () => {
  const body = "x".repeat(4 * 1024 * 1024);
  const received: string[] = [];
  const adapter = new ClaudeAdapter({ query: fakeQuery(async function* () {
    yield sdkMessage({ type: "assistant", uuid: "capacity", parent_tool_use_id: null, message: { content: [{ type: "text", text: body }] } });
    yield result("large", { result: body });
  }) });
  const completed = await adapter.runSessionTurn(input(), state => { received.push(state.assistantText); });
  assert.equal(completed.assistantText, body);
  assert.ok(received.length > 0);
  assert.ok(received.every(text => text === body));
});

// @test-value v2
// kind = "contract"
// claim = "Claude foregroundは当turnのHTTP MCP設定をSDKへ渡し、native設定探索とresumeを維持し、SDK応答中のtokenを保存用結果から除去する"
// oracle = { type = "contract", ref = "docs/adr/027-shared-localhost-http-mcp-turn-identity.md; docs/design/provider-adapter.md#Thread Management" }
// fault = "HTTP接続設定を欠落させる、第三者MCPをstrict設定で隠す、resumeを落とす、またはtokenを結果へ漏らす"
// observable = "queryのoptionsとprompt、runSessionTurnの確定結果"
// observation_boundary = "consumer"
// scope = "Claude foreground managed HTTP MCP injection and projection"
// lifecycle = "permanent"
// impact = "MemoryとGlossaryが使えない、既存第三者設定の探索や会話継続が失われる、またはtokenが監査へ保存される"
// distinction = "設定型検査では実行時queryへ渡す値やSDK応答のredactionを保証できない。fake SDKで通信せずadapter境界を確認する"
// risk_tags = ["privacy"]
// @end-test-value
it("Claude foregroundのHTTP MCP設定とtoken秘匿化を保つ", async () => {
  const request = input("saved-thread");
  request.agentRuntimeBinding = {
    bindingId: "binding", bindingReference: "reference", providerId: "claude",
    executionGeneration: "generation", transport: "env", expiresAt: null,
    managedMcp: { memoryUrl: "http://127.0.0.1:47891/memory", glossaryUrl: "http://127.0.0.1:47891/glossary", token: "opaque-http-token" },
  };
  let seen: Options | undefined;
  let submittedPrompt: unknown;
  const adapter = new ClaudeAdapter({ query: fakeQuery(async function* () {
    yield sdkMessage({ type: "assistant", session_id: "saved-thread", uuid: "http", parent_tool_use_id: null,
      message: { content: [{ type: "text", text: "echo opaque-http-token" }] } });
    yield result("saved-thread");
  }, (options, prompt) => { seen = options; submittedPrompt = prompt; }) });
  const output = await adapter.runSessionTurn(request);
  assert.deepEqual(seen?.mcpServers, {
    "withmate-memory": { type: "http", url: "http://127.0.0.1:47891/memory", headers: { "x-withmate-mcp-token": "opaque-http-token" } },
    "withmate-glossary": { type: "http", url: "http://127.0.0.1:47891/glossary", headers: { "x-withmate-mcp-token": "opaque-http-token" } },
  });
  assert.deepEqual(seen?.settingSources, ["user", "project", "local"]);
  assert.notEqual(seen?.strictMcpConfig, true);
  assert.equal(seen?.resume, "saved-thread");
  assert.doesNotMatch(JSON.stringify(submittedPrompt), /opaque-http-token/);
  assert.match(output.assistantText, /WITHMATE_BINDING_REFERENCE_REDACTED/);
  assert.doesNotMatch(JSON.stringify(output), /opaque-http-token/);
});

// @test-value v2
// kind = "invariant"
// claim = "Claudeの多数messageでも全文とartifactを正常終了とcancel partialで保持しsecretを除去する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "長文本文を切り詰める、cancelで取得済みartifact操作を落とす、またはbinding/capabilityをartifactへ残す"
// observable = "正常結果と取消partialResultのassistantText全文、artifact操作件数、artifact内のbinding/capability不在"
// observation_boundary = "public-boundary"
// scope = "claude-coding-turn long text and partial artifact redaction"
// lifecycle = "permanent"
// impact = "長いturnの応答と取得済み作業結果が欠落し、runtime secretが履歴へ漏れる"
// distinction = "単独messageのtestは多数長文の全文連結と取消partialのartifact秘匿を同時に観測せず、型検査では返却値の欠落を検知できない"
// risk_tags = ["privacy"]
// @end-test-value
it("Claude 長文でも全文と正常・cancel partialを保持する", async () => {
  for (const canceled of [false, true]) {
    const controller = new AbortController();
    const request = input("", controller.signal);
    const secret = "short-binding-reference";
    const longSecret = "long-capability-".repeat(8);
    request.agentRuntimeBinding = { bindingId: "fixture", bindingReference: secret, turnCapability: longSecret,
      providerId: "claude", executionGeneration: "fixture", transport: "env", expiresAt: null };
    const text = `あ😀\"\n${secret.repeat(1000)} ${longSecret}`;
    const adapter = new ClaudeAdapter({ query: fakeQuery(async function* () {
      for (let index = 0; index < 40; index += 1) {
        yield sdkMessage({ type: "assistant", session_id: "raw-thread", uuid: `message-${index}`, parent_tool_use_id: null,
          message: { content: [{ type: "text", text: `${index}:${text}` }] } });
      }
      if (canceled) controller.abort();
      yield result("raw-thread");
    }) });
    let completed;
    try {
      completed = await adapter.runSessionTurn(request);
      assert.equal(canceled, false);
    } catch (error) {
      assert.ok(canceled && error instanceof ProviderTurnError && error.canceled);
      completed = error.partialResult;
    }
    const cleanText = text.split(secret).join(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER)
      .split(longSecret).join(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER);
    assert.equal(completed.assistantText, Array.from({ length: 40 }, (_, index) => `${index}:${cleanText}`).join("\n\n"));
    assert.equal(completed.artifact!.operationTimeline!.length, 40);
    assert.equal(completed.artifact?.operationTimeline?.length, 40);
    assert.ok(!JSON.stringify(completed.artifact).includes(secret));
    assert.ok(!JSON.stringify(completed.artifact).includes(longSecret));
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Claudeの明示session再開は採用snapshotのiconを含む最新system appendを渡し、stream本文と確定本文を二重表示しない"
// oracle = { type = "contract", ref = "docs/design/prompt-composition.md; Issue #751" }
// fault = "resumeで旧promptやiconを使う、iconをuser入力へ混入する、またはstreamとassistant本文を連結して二重化する"
// observable = "SDK query options、確定assistantText、進捗assistantText"
// observation_boundary = "public-boundary"
// scope = "claude-coding-turn"
// lifecycle = "permanent"
// impact = "CharacterやAffectの現行投影が失われ、Sessionに重複した応答が出る"
// distinction = "型検査ではSDK option値とstream/final連結の実行結果を確認できない"
// @end-test-value
it("resumes by explicit id with the current system prompt and deduplicates streamed text", async () => {
  const seen: Array<{ options: Options; prompt: unknown }> = [];
  const adapter = new ClaudeAdapter({ query: fakeQuery(async function* () {
    yield sdkMessage({ type: "system", subtype: "init", session_id: "thread-1", model: "claude-opus-5-5" });
    yield sdkMessage({ type: "stream_event", session_id: "thread-1", uuid: "event-start", parent_tool_use_id: null, event: { type: "message_start", message: { id: "anthropic-msg-1" } } });
    yield sdkMessage({ type: "assistant", session_id: "thread-1", uuid: "sdk-thinking-1", parent_tool_use_id: null, message: { id: "anthropic-msg-1", content: [{ type: "thinking", thinking: "hidden" }] } });
    yield sdkMessage({ type: "stream_event", session_id: "thread-1", uuid: "event-delta", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } } });
    yield sdkMessage({ type: "assistant", session_id: "thread-1", uuid: "sdk-message-1", parent_tool_use_id: null, message: { id: "anthropic-msg-1", content: [{ type: "text", text: "Hello" }] } });
    yield sdkMessage({ type: "stream_event", session_id: "thread-1", uuid: "event-stop", parent_tool_use_id: null, event: { type: "message_stop" } });
    yield result("thread-1");
    throw new Error("Iterator was advanced after result");
  }, (options, prompt) => seen.push({ options, prompt })) });
  const progress: string[] = [];
  const request = input();
  let completed;
  for (const [index, marker] of ["FIRST", "SECOND", "EXPLICIT-RESUME"].entries()) {
    request.session.characterRuntimeSnapshot = {
      characterId: "character", name: "Character", description: "Saved metadata", iconFilePath: `C:/Character Data/${marker}/icon.png`,
      theme: { main: "#112233", sub: "#445566" }, definitionMarkdown: `Definition ${marker}`,
      definitionSha256: marker, definitionByteSize: marker.length, snapshotAt: "2026-10-03T00:00:00Z",
    };
    request.characterContext = {
      schemaVersion: "withmate-character-context-v1",
      baseline: { definitionSha256: marker, snapshotAt: "2026-10-03T00:00:00Z" },
      affect: { mode: "active", effective: [{ contributingLayers: ["session"], targetType: "user", targetId: "user", family: null,
        label: `Affect ${marker}`, valence: 0.5, intensity: 0.5 }], evaluatedAt: "2026-10-03T00:00:00Z", version: marker, updatedAt: null },
      memory: { items: [], updatedAt: null },
    };
    // Recreate the adapter for explicit resume: freshness must not rely on an in-memory query cache.
    const currentAdapter = index === 2 ? new ClaudeAdapter({ query: fakeQuery(async function* () { yield result("thread-1"); },
      (options, prompt) => seen.push({ options, prompt })) }) : adapter;
    completed = await currentAdapter.runSessionTurn(request, (state) => { progress.push(state.assistantText); });
    assert.equal(seen[index].options.resume, index === 0 ? undefined : "thread-1");
    const system = seen[index].options.systemPrompt;
    assert.ok(system && typeof system === "object" && !Array.isArray(system) && system.type === "preset");
    assert.equal(system.preset, "claude_code");
    assert.equal(system.snapshot, false);
    assert.match(system.append!, new RegExp(`Definition ${marker}`));
    assert.match(system.append!, new RegExp(`Affect ${marker}`));
    assert.ok(system.append!.includes(`Icon: \` C:/Character Data/${marker}/icon.png \``));
    for (const old of ["FIRST", "SECOND", "EXPLICIT-RESUME"].filter((value) => value !== marker)) {
      assert.doesNotMatch(system.append!, new RegExp(`Definition ${old}|Affect ${old}`));
      assert.ok(!system.append!.includes(`C:/Character Data/${old}/icon.png`));
    }
    assert.equal(seen[index].prompt, adapter.composePrompt(request).inputBodyText);
    assert.equal(seen[index].prompt, "# User Input\n\nhello");
    request.session.threadId = completed.threadId!;
    if (index < 2) assert.equal(completed.assistantText, "Hello");
  }
  assert.ok(progress.includes("Hello"));
  assert.ok(progress.every((text) => text !== "Hello\n\nHello"));
  assert.ok(completed);
  assert.equal(completed.usage?.inputTokens, 12);
});

// @test-value v2
// kind = "invariant"
// claim = "Claudeの返却artifactはBashのtool_result本文をcommand operationに保持し、子agent本文を親assistant応答へ混入しない"
// oracle = { type = "contract", ref = "src-electron/providers/claude/claude-adapter.ts: runSessionTurn; docs/design/provider-adapter.md: ClaudeAdapter / 通常履歴と最小turn" }
// fault = "tool_resultのfailed本文を失う、Bashをcommand_execution以外へ投影する、または子agentのInternal本文をFinal応答へ混入する"
// observable = "返却assistantTextとartifact.operationTimelineのdetails配列・先頭type"
// observation_boundary = "public-boundary"
// scope = "claude-coding-turn"
// lifecycle = "permanent"
// impact = "取得済みBash結果がDetailsから失われるか、内部subagent本文が利用者向け応答へ漏れる"
// distinction = "SDK型と既存provider testはClaude固有のmessage順序と親子境界を検査しない"
// @end-test-value
it("records tool completion only from tool results and excludes subagent text", async () => {
  const adapter = new ClaudeAdapter({ query: fakeQuery(async function* () {
    yield sdkMessage({ type: "assistant", session_id: "thread-2", uuid: "child", parent_tool_use_id: "tool-parent", message: { content: [{ type: "text", text: "Internal" }] } });
    yield sdkMessage({ type: "assistant", session_id: "thread-2", uuid: "parent", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "npm test" } }] } });
    yield sdkMessage({ type: "user", session_id: "thread-2", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "tool-1", is_error: true, content: "failed" }] } });
    yield result("thread-2");
  }) });
  const completed = await adapter.runSessionTurn(input());
  assert.equal(completed.assistantText, "Final");
  assert.deepEqual(completed.artifact!.operationTimeline!.map((operation) => operation.details), ["failed"]);
  assert.equal(completed.artifact!.operationTimeline![0]?.type, "command_execution");
});

// @test-value v2
// kind = "invariant"
// claim = "ClaudeのBash入力中はLatest Commandへ生のコマンドが表示され、非Bash toolをコマンド履歴へ混入しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md; Issue #751" }
// fault = "Bashをtool_callとして扱う、または全tool結果をcommand_executionへ記録する"
// observable = "進捗stepsと確定operations"
// observation_boundary = "public-boundary"
// scope = "claude-coding-turn"
// lifecycle = "permanent"
// impact = "実行中コマンドが利用者へ見えず、非コマンドを実行履歴と誤認する"
// distinction = "既存provider testではClaude SDKのtool_use/result投影を通らない"
// @end-test-value
it("projects only Bash as a live command with the raw command", async () => {
  const steps: Array<{ type: string; summary: string; status: string }> = [];
  const adapter = new ClaudeAdapter({ query: fakeQuery(async function* () {
    yield sdkMessage({ type: "assistant", session_id: "thread-tools", uuid: "parent", parent_tool_use_id: null, message: { content: [
      { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "npm test" } },
      { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "README.md" } },
    ] } });
    yield sdkMessage({ type: "user", session_id: "thread-tools", parent_tool_use_id: null, message: { content: [
      { type: "tool_result", tool_use_id: "bash-1", content: "done" },
      { type: "tool_result", tool_use_id: "read-1", content: "read" },
    ] } });
    yield result("thread-tools");
  }) });
  const completed = await adapter.runSessionTurn(input(), (state) => {
    steps.push(...state.steps.map((step) => ({ type: step.type, summary: step.summary, status: step.status })));
  });
  assert.ok(steps.some((step) => step.type === "command_execution" && step.summary === "npm test" && step.status === "in_progress"));
  assert.ok(steps.some((step) => step.type === "tool_call" && step.status === "in_progress"));
  assert.deepEqual(completed.artifact!.operationTimeline!.map((operation) => operation.type), ["command_execution", "tool_call"]);
});

// @test-value v2
// kind = "invariant"
// claim = "Claudeの同一turnで承認と質問が並行到着しても単一pending枠へ順に渡す"
// oracle = { type = "contract", ref = "src-electron/session/session-approval-service.ts; Issue #751" }
// fault = "先の未回答要求を次の要求で上書きし回答不能にする"
// observable = "callbackの呼出順、requestId、SDKへ返る判断"
// observation_boundary = "public-boundary"
// scope = "claude-coding-turn"
// lifecycle = "permanent"
// impact = "表示から消えた承認や質問がturnを停止させる"
// distinction = "単独callback testと型検査は並行制御を検査しない"
// @end-test-value
it("serializes concurrent approvals and elicitation without losing request identity", async () => {
  const active: string[] = [];
  const seen: string[] = [];
  const releases: Array<() => void> = [];
  const request = input();
  request.onApprovalRequest = (card) => {
    active.push(card.requestId);
    seen.push(card.requestId);
    return new Promise((resolve) => releases.push(() => { active.pop(); resolve("approve"); }));
  };
  request.onElicitationRequest = (card) => {
    active.push(card.requestId);
    seen.push(card.requestId);
    return new Promise((resolve) => releases.push(() => { active.pop(); resolve({ action: "accept", content: { answer: "yes" } }); }));
  };
  const adapter = new ClaudeAdapter({ query: fakeQuery(async function* (options) {
    const context = (toolUseID: string) => ({ toolUseID, signal: new AbortController().signal }) as Parameters<NonNullable<Options["canUseTool"]>>[2];
    const first = options.canUseTool!("Bash", { command: "one" }, context("approval-1"));
    const second = options.canUseTool!("Bash", { command: "two" }, context("approval-2"));
    const third = options.onElicitation!({ mode: "form", serverName: "test", message: "Choose", requestedSchema: { type: "object", properties: { answer: { type: "string" } } } } as Parameters<NonNullable<Options["onElicitation"]>>[0], { requestId: "elicitation-3", signal: new AbortController().signal } as Parameters<NonNullable<Options["onElicitation"]>>[1]);
    assert.deepEqual(await Promise.all([first, second, third]), [{ behavior: "allow" }, { behavior: "allow" }, { action: "accept", content: { answer: "yes" } }]);
    yield result("thread-queue");
  }) });
  const completed = adapter.runSessionTurn(request);
  for (const expected of ["approval-1", "approval-2", "elicitation-3"]) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(active, [expected]);
    releases.shift()?.();
  }
  await completed;
  assert.deepEqual(seen, ["approval-1", "approval-2", "elicitation-3"]);
});

// @test-value v2
// kind = "invariant"
// claim = "待機列内で取消されたClaude承認は後続のpending枠へ表示しない"
// oracle = { type = "contract", ref = "src-electron/session/session-approval-service.ts; Issue #751" }
// fault = "取消済み要求を先行回答後に再表示し、別のrequestIdへ回答を送る"
// observable = "approval callbackのrequestId列とSDKのdeny結果"
// observation_boundary = "public-boundary"
// scope = "claude-coding-turn"
// lifecycle = "permanent"
// impact = "利用者が取消済み操作を誤承認する"
// distinction = "並行要求の正常回答testでは待機中のcontext cancelを検査しない"
// @end-test-value
it("does not dispatch an approval canceled while queued", async () => {
  const seen: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const request = input();
  request.onApprovalRequest = (card) => {
    seen.push(card.requestId);
    return new Promise((resolve) => { releaseFirst = () => resolve("approve"); });
  };
  const adapter = new ClaudeAdapter({ query: fakeQuery(async function* (options) {
    const first = options.canUseTool!("Bash", { command: "one" }, { toolUseID: "first", signal: new AbortController().signal } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
    const canceled = new AbortController();
    const second = options.canUseTool!("Bash", { command: "two" }, { toolUseID: "second", signal: canceled.signal } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
    canceled.abort();
    assert.deepEqual(await Promise.all([first, second]), [{ behavior: "allow" }, { behavior: "deny", message: "Canceled" }]);
    yield result("thread-queued-cancel");
  }) });
  const completed = adapter.runSessionTurn(request);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["first"]);
  releaseFirst?.();
  await completed;
  assert.deepEqual(seen, ["first"]);
});

// @test-value v2
// kind = "invariant"
// claim = "ClaudeのMCP質問は共通field変換で選択肢・数値範囲・既定値を保持する"
// oracle = { type = "contract", ref = "Issue #751; MCP elicitation requestedSchema" }
// fault = "oneOfを自由入力化し、items.anyOfや数値制約を失う"
// observable = "共通質問callbackへ渡るfieldsとSDKへ返る回答"
// observation_boundary = "public-boundary"
// scope = "claude-coding-turn"
// lifecycle = "permanent"
// impact = "Providerごとに同じMCP質問の回答可否や値検証が異なる"
// distinction = "共通converterの単体testだけではClaude envelopeからの接続を検査しない"
// @end-test-value
it("preserves MCP selection and numeric constraints in Claude elicitation", async () => {
  const request = input();
  let fields: unknown;
  request.onElicitationRequest = (card) => {
    fields = card.fields;
    return { action: "accept", content: { single: "a", multiple: ["x"], count: 2 } };
  };
  const adapter = new ClaudeAdapter({ query: fakeQuery(async function* (options) {
    const response = await options.onElicitation!({
      mode: "form", serverName: "mcp-test", message: "Choose", requestedSchema: { type: "object", required: ["single", "multiple", "count"], properties: {
        single: { type: "string", oneOf: [{ const: "a", title: "Alpha" }] },
        multiple: { type: "array", items: { anyOf: [{ const: "x", title: "X" }] } },
        count: { type: "integer", minimum: 1, maximum: 3, default: 2 },
      } },
    } as Parameters<NonNullable<Options["onElicitation"]>>[0], { requestId: "mcp-1", signal: new AbortController().signal } as Parameters<NonNullable<Options["onElicitation"]>>[1]);
    assert.deepEqual(response, { action: "accept", content: { single: "a", multiple: ["x"], count: 2 } });
    yield result("thread-mcp");
  }) });
  await adapter.runSessionTurn(request);
  assert.deepEqual((fields as Array<{ type: string }>).map((field) => field.type), ["select", "multi-select", "number"]);
  assert.deepEqual((fields as Array<{ options?: unknown }>)[0].options, [{ value: "a", label: "Alpha" }]);
  assert.deepEqual((fields as Array<{ options?: unknown }>)[1].options, [{ value: "x", label: "X" }]);
  assert.deepEqual((fields as Array<{ minimum?: number; maximum?: number; defaultValue?: number }>)[2], {
    type: "number", numberKind: "integer", name: "count", title: "count", description: undefined,
    required: true, defaultValue: 2, minimum: 1, maximum: 3,
  });
});

// @test-value v2
// kind = "invariant"
// claim = "abort済みClaude turnはSDKがsuccess resultを返してもcanceledとしてpartialを保持する"
// oracle = { type = "contract", ref = "docs/adr/002-provider-turn-terminal-and-cancellation.md; Issue #751" }
// fault = "abort後の遅着successを完了扱いにする"
// observable = "ProviderTurnError.canceledとpartialResult.assistantText"
// observation_boundary = "public-boundary"
// scope = "claude-coding-turn"
// lifecycle = "permanent"
// impact = "キャンセルしたtool/応答を成功と履歴・Sessionへ確定する"
// distinction = "既存providerのキャンセルtestはClaude SDKのabort後success挙動を通らない"
// @end-test-value
it("lets cancellation dominate a later successful SDK result", async () => {
  const controller = new AbortController();
  const adapter = new ClaudeAdapter({ query: fakeQuery(async function* () {
    yield sdkMessage({ type: "assistant", session_id: "thread-3", uuid: "message", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Partial" }] } });
    controller.abort();
    yield result("thread-3");
  }) });
  await assert.rejects(adapter.runSessionTurn(input("", controller.signal)), (error: unknown) => {
    assert.ok(error instanceof ProviderTurnError);
    assert.equal(error.canceled, true);
    assert.equal(error.partialResult.assistantText, "Partial");
    return true;
  });
});

// @test-value v2
// kind = "invariant"
// claim = "Claude取消後は子プロセスのabort errorだけでprovider Promiseを終了せず、exitまで再送guardの対象を保持する"
// oracle = { type = "contract", ref = "docs/adr/002-provider-turn-terminal-and-cancellation.md" }
// fault = "SDK closeかabort errorを子の実終了とみなしprovider Promiseを早期解決する"
// observable = "abort error後とexit後のprovider Promise settled状態"
// observation_boundary = "public-boundary"
// scope = "claude-coding-turn"
// lifecycle = "permanent"
// impact = "取消済みでも生存する子と同じworkspaceへ新turnを送れてしまう"
// distinction = "通常のfake Query取消testは子のexit時刻を観測しない"
// @end-test-value
it("keeps the canceled provider promise pending until child exit", async () => {
  const controller = new AbortController();
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, stdin: {}, stdout: {}, killed: false, kill: () => true });
  let nextCount = 0;
  let closed = false;
  const query = (({ options }: { options: Options }) => {
    options.spawnClaudeCodeProcess!({ command: "unused", args: [], env: {}, signal: new AbortController().signal });
    return {
      next: () => ++nextCount === 1
        ? Promise.resolve({ done: false, value: sdkMessage({ type: "assistant", session_id: "thread-exit", uuid: "partial", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Partial" }] } }) })
        : new Promise(() => undefined),
      close: () => { closed = true; },
    };
  }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
  const adapter = new ClaudeAdapter({ query, spawnProcess: (() => child) as unknown as typeof spawn });
  let settled = false;
  const running = adapter.runSessionTurn(input("", controller.signal), (state) => {
    if (state.assistantText === "Partial") controller.abort();
  }).catch((error: unknown) => { settled = true; return error; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  child.emit("error", Object.assign(new Error("aborted"), { name: "AbortError" }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, true);
  assert.equal(settled, false);
  child.emit("exit", null, "SIGTERM");
  const error: unknown = await running;
  assert.ok(error instanceof ProviderTurnError);
  assert.equal(error.canceled, true);
  assert.equal(error.partialResult.assistantText, "Partial");
});

// @test-value v2
// kind = "invariant"
// claim = "Claudeのlive配送失敗は非cancel partial failureを保持し、child実exitまでcleanup completionまたはprovider Promiseを未終了に保つ"
// oracle = { type = "contract", ref = "docs/adr/002-provider-turn-terminal-and-cancellation.md; src-electron/providers/provider-runtime.ts: RunSessionTurnInput.onCleanupPending" }
// fault = "入力signal非abortの内部停止でSDK close/AbortErrorを実exitと誤認し、cleanup通知も実終了待ちも省く"
// observable = "close/AbortError後とexit後のprovider Promiseおよび通知cleanup completionのsettled状態、canceled、partial本文、consumer callback件数"
// observation_boundary = "public-boundary"
// scope = "Claude pre-handler overload child lifecycle"
// lifecycle = "permanent"
// impact = "生存中の旧childと同じSession/workspaceへの再送を許し副作用競合を起こす"
// distinction = "既存user cancel exit testでは入力signal非abortのlive配送拒否とcleanup通知経路を通らない"
// @end-test-value
it("Claudeのlive配送失敗はfailed返却とchild実終了guardを両立する", async (context) => {
  const body = "x".repeat(4 * 1024 * 1024);
  for (const notifyCleanup of [false, true]) {
    const inputController = new AbortController();
    const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, stdin: {}, stdout: {}, killed: false, kill: () => true });
    context.after(() => child.emit("exit", null, "SIGTERM"));
    let closeCalled = false;
    let callbacks = 0;
    let nextCount = 0;
    let settled = false;
    let cleanupSettled = false;
    let cleanupCompletion: Promise<void> | undefined;
    const query = (({ options }: { options: Options }) => {
      options.spawnClaudeCodeProcess!({ command: "unused", args: [], env: {}, signal: new AbortController().signal });
      return {
        next: () => ++nextCount === 1
          ? Promise.resolve({ done: false, value: sdkMessage({ type: "assistant", uuid: "capacity-child", parent_tool_use_id: null, message: { content: [{ type: "text", text: body }] } }) })
          : new Promise(() => undefined),
        close: () => { closeCalled = true; },
      };
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const request = input("", inputController.signal);
    if (notifyCleanup) request.onCleanupPending = (completion) => {
      cleanupCompletion = completion;
      void completion.then(() => { cleanupSettled = true; });
    };
    const adapter = new ClaudeAdapter({ query, spawnProcess: (() => child) as unknown as typeof spawn });
    const running = adapter.runSessionTurn(request, () => { callbacks += 1; throw new Error("live delivery failed"); }).catch((error: unknown) => { settled = true; return error; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.emit("error", Object.assign(new Error("aborted"), { name: "AbortError" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closeCalled, true);
    assert.equal(inputController.signal.aborted, false);
    assert.equal(callbacks, 1);
    assert.equal(nextCount, 1);
    assert.equal(settled, notifyCleanup);
    if (notifyCleanup) {
      assert.ok(cleanupCompletion);
      assert.equal(cleanupSettled, false);
      const failure: unknown = await running;
      assert.ok(failure instanceof ProviderTurnError);
      assert.equal(failure.canceled, false);
      assert.equal(failure.partialResult.assistantText, body);
    }
    child.emit("exit", null, "SIGTERM");
    await cleanupCompletion;
    const failure: unknown = await running;
    assert.ok(failure instanceof ProviderTurnError);
    assert.equal(failure.canceled, false);
    assert.match(failure.message, /live delivery failed/);
    assert.equal(failure.partialResult.assistantText, body);
    if (notifyCleanup) assert.equal(cleanupSettled, true);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "AskUserQuestionは二択承認で代用せず、自由入力をSDK answersへ戻す"
// oracle = { type = "contract", ref = "Issue #751; src-shared/session/runtime-state.ts LiveElicitationRequest" }
// fault = "Questionをapprovalへ誤配送する、またはOther入力を破棄する"
// observable = "Elicitation cardのfieldsとSDK permission updatedInput.answers"
// observation_boundary = "public-boundary"
// scope = "claude-coding-turn"
// lifecycle = "permanent"
// impact = "Claudeの質問へユーザーが正しい自由回答を返せず作業が停止する"
// distinction = "既存CopilotのMCP elicitation testはClaudeのAskUserQuestion更新入力を確認しない"
// @end-test-value
it("routes AskUserQuestion to elicitation and returns a free-text answer", async () => {
  let permission: unknown;
  let allowsFreeText = false;
  const adapter = new ClaudeAdapter({ query: fakeQuery(async function* (options) {
    permission = await options.canUseTool?.("AskUserQuestion", {
      questions: [{ question: "Which path?", options: [{ label: "A" }], multiSelect: false }],
    }, { toolUseID: "question-1", signal: new AbortController().signal } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
    yield result("thread-question");
  }) });
  const request = input();
  request.onElicitationRequest = (card) => {
    allowsFreeText = card.fields.some((field) => field.name === "0" && field.type === "select" && field.allowFreeText === true);
    return { action: "accept", content: { "0": "A custom path" } };
  };
  await adapter.runSessionTurn(request);
  assert.equal(allowsFreeText, true);
  assert.deepEqual(permission, { behavior: "allow", updatedInput: {
    questions: [{ question: "Which path?", options: [{ label: "A" }], multiSelect: false }], answers: { "Which path?": "A custom path" },
  } });
});

// @test-value v2
// kind = "invariant"
// claim = "Claude Backgroundはmanaged設定がある場合queryを開始せず、未管理時はtool・MCP・hookを無効にしてstructured outputを要求する"
// oracle = { type = "contract", ref = "Issue #751; docs/design/provider-adapter.md" }
// fault = "managed hookを実行可能なままread-only Backgroundを開始する、または出力schemaを省く"
// observable = "query呼出回数とSDK options、structured output"
// observation_boundary = "public-boundary"
// scope = "claude-background-turn"
// lifecycle = "permanent"
// impact = "補助評価で意図しない書込・shell実行が起こる、または不正出力を成功として保存する"
// distinction = "型検査はruntime managed設定判定とSDK起動前の停止を検証しない"
// @end-test-value
it("gates managed settings before background query and constrains clean background runs", async () => {
  const background: RunBackgroundStructuredPromptInput = {
    providerId: "claude", workspacePath: process.cwd(), appSettings: createDefaultAppSettings(), model: "claude-opus-5-5",
    reasoningEffort: "high", timeoutMs: 1000,
    prompt: { systemText: "Only JSON", userText: "Rate", outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } },
  };
  let starts = 0;
  const managed = new ClaudeAdapter({
    query: fakeQuery(async function* () { yield result("unused"); }, () => { starts += 1; }),
    resolveSettings: async () => ({ sources: [{ source: "managed", settings: {} }], effective: {}, provenance: {} } as ResolvedSettings),
  });
  await assert.rejects(managed.runBackgroundStructuredPrompt(background), /managed settings/);
  assert.equal(starts, 0);

  let options: Options | undefined;
  const clean = new ClaudeAdapter({
    query: fakeQuery(async function* () { yield result("background", { structured_output: { answer: "ok" } }); }, (value) => { options = value; }),
    resolveSettings: async () => ({ sources: [], effective: {}, provenance: {} } as ResolvedSettings),
  });
  const completed = await clean.runBackgroundStructuredPrompt<{ answer: string }>(background);
  assert.deepEqual(completed.output, { answer: "ok" });
  assert.deepEqual(options?.tools, []);
  assert.deepEqual(options?.mcpServers, {});
  assert.deepEqual(options?.settingSources, []);
  assert.deepEqual(options?.settings, { disableAllHooks: true });
  assert.equal(options?.hooks, undefined);
  assert.equal(options?.strictMcpConfig, true);
  assert.equal(options?.persistSession, false);
  assert.deepEqual(options?.outputFormat, { type: "json_schema", schema: background.prompt.outputSchema });
});

// @test-value v2
// kind = "invariant"
// claim = "Claude result前のEOFや失敗はpartial stream本文を失わず失敗として返す"
// oracle = { type = "contract", ref = "docs/adr/002-provider-turn-terminal-and-cancellation.md" }
// fault = "EOFを成功扱いする、または未確定stream本文を破棄する"
// observable = "ProviderTurnErrorとpartialResult.assistantText"
// observation_boundary = "public-boundary"
// scope = "claude-coding-turn"
// lifecycle = "permanent"
// impact = "失敗途中のユーザー可視応答が履歴から消え、turnが誤って完了する"
// distinction = "SDKのterminal/EOF境界はClaude固有で既存adapter testでは観測しない"
// @end-test-value
it("preserves streamed partial text when the SDK ends before result", async () => {
  const adapter = new ClaudeAdapter({ query: fakeQuery(async function* () {
    yield sdkMessage({ type: "stream_event", session_id: "thread-eof", uuid: "event-start", parent_tool_use_id: null, event: { type: "message_start", message: { id: "anthropic-partial" } } });
    yield sdkMessage({ type: "stream_event", session_id: "thread-eof", uuid: "event-delta", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Incomplete" } } });
  }) });
  await assert.rejects(adapter.runSessionTurn(input()), (error: unknown) => {
    assert.ok(error instanceof ProviderTurnError);
    assert.equal(error.canceled, false);
    assert.equal(error.partialResult.assistantText, "Incomplete");
    return true;
  });
});

// @test-value v2
// kind = "invariant"
// claim = "Claude BackgroundのtimeoutはSDK nextが停止しても有限時間で失敗しQueryをcloseする"
// oracle = { type = "contract", ref = "docs/adr/002-provider-turn-terminal-and-cancellation.md; Issue #751" }
// fault = "AbortSignalだけに依存して停止したiterator.nextを無期限に待つ"
// observable = "timeout後の拒否とQuery.close呼出"
// observation_boundary = "public-boundary"
// scope = "claude-background-turn"
// lifecycle = "permanent"
// impact = "Affectの補助処理が終了せずSession後処理を滞留させる"
// distinction = "通常のSDK fixtureはabortに協力し、この非協力transport境界を検査できない"
// @end-test-value
it("bounds background timeout even when SDK next never settles", async () => {
  let closed = false;
  const background: RunBackgroundStructuredPromptInput = {
    providerId: "claude", workspacePath: process.cwd(), appSettings: createDefaultAppSettings(), model: "claude-opus-5-5",
    reasoningEffort: "high", timeoutMs: 30,
    prompt: { systemText: "Only JSON", userText: "Rate", outputSchema: { type: "object" } },
  };
  const adapter = new ClaudeAdapter({
    query: (() => ({ next: () => new Promise(() => undefined), close: () => { closed = true; } })) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query,
    resolveSettings: async () => ({ sources: [], effective: {}, provenance: {} } as ResolvedSettings),
  });
  await assert.rejects(adapter.runBackgroundStructuredPrompt(background), /Canceled/);
  assert.equal(closed, true);
});

// @test-value v2
// kind = "invariant"
// claim = "Claudeの返却artifactに16件のBash command summaryを有限previewで保持し、観測されたliveのBash summaryも同じpreviewにする。assistant本文は全文保持する"
// oracle = { type = "contract", ref = "src-electron/providers/claude/claude-adapter.ts: runSessionTurn; src-electron/session/provider-payload-limits.ts: PROVIDER_TEXT_PREVIEW_LIMIT / toProviderTextPreview" }
// fault = "返却artifactのBash summaryを全量保持・欠落させる、観測されたliveのBash summaryへ全量commandを残す、またはassistant本文を欠落・切り詰める"
// observable = "progressから収集したsummaryのうちxで始まる値、返却artifactのcommand_execution.summary配列16件、assistantText全文"
// observation_boundary = "public-boundary"
// scope = "Claude coding turn owner"
// lifecycle = "permanent"
// impact = "大きいBash入力の反復でMain heapが増幅し履歴と会話を失う"
// distinction = "shared helper testはClaude receiveからprogressとfinalへの接続を観測しない"
// @end-test-value
it("ClaudeはBash summaryとoperation previewをboundedにし本文と操作順序を保つ", async () => {
  const command = "x".repeat(1024 * 1024);
  const body = "answer".repeat(20000);
  const adapter = new ClaudeAdapter({ query: fakeQuery(async function* () {
    for (let index = 0; index < 16; index++) {
      yield sdkMessage({ type: "assistant", uuid: "tool-" + index, parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: String(index), name: "Bash", input: { command } }] } });
      yield sdkMessage({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: String(index), is_error: false, content: "done" }] } });
    }
    yield sdkMessage({ type: "assistant", uuid: "answer", parent_tool_use_id: null, message: { content: [{ type: "text", text: body }] } });
    yield result("bounded");
  }) });
  const summaries: string[] = [];
  const completed = await adapter.runSessionTurn(input(), (progress) => { for (const step of progress.steps) summaries.push(step.summary); });
  const expected = command.slice(0, 65536) + "\n...[truncated 983040 chars; originalLength=1048576]";
  assert.ok(summaries.length > 0);
  assert.ok(summaries.filter((summary) => summary.startsWith("x")).every((summary) => summary === expected));
  assert.deepEqual(completed.artifact!.operationTimeline!.filter((operation) => operation.type === "command_execution").map((operation) => operation.summary), Array(16).fill(expected));
  assert.equal(completed.assistantText, body);
});

// @test-value v2
// kind = "security"
// claim = "ClaudeのBash summaryはpreview境界を跨ぐbinding reference・turn capability・MCP tokenのprefixをliveと正常・失敗・取消artifactに残さない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Agent Runtime Binding / Streaming Policy" }
// fault = "Bash commandを秘匿化より先に切り詰めて一致しないsecret prefixを表示・保存する"
// observable = "受信したcommand_execution進捗summaryと結果またはProviderTurnError.partialResultのoperation summary"
// observation_boundary = "public-boundary"
// scope = "Claude tool_use Bash bounded projection"
// lifecycle = "permanent"
// risk_tags = ["privacy", "authentication"]
// impact = "runtime認証情報の断片が画面と保存履歴へ漏洩することを防ぐ"
// distinction = "tool_result出力の秘匿化testはBash入力のcommand summary生成を通らない"
// @end-test-value
it("ClaudeのBash previewは切断境界のsecret prefixを秘匿する", async () => {
  const secrets = ["binding-reference-fixture-0123456789", "turn-capability-fixture-0123456789", "mcp-token-fixture-0123456789"];
  for (const secret of secrets) {
    for (const outcome of ["completed", "failed", "canceled"] as const) {
      const controller = new AbortController();
      const request = input("", controller.signal);
      request.agentRuntimeBinding = {
        bindingId: "binding", bindingReference: secrets[0], turnCapability: secrets[1], providerId: "claude",
        executionGeneration: "generation", transport: "env", expiresAt: null,
        managedMcp: { memoryUrl: "http://127.0.0.1:47891/memory", glossaryUrl: "http://127.0.0.1:47891/glossary", token: secrets[2] },
      };
      const command = "x".repeat(PROVIDER_TEXT_PREVIEW_LIMIT - 10) + secret + " tail";
      const expected = "x".repeat(PROVIDER_TEXT_PREVIEW_LIMIT - 10)
        + PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER.slice(0, 10)
        + `\n...[truncated ${command.length - PROVIDER_TEXT_PREVIEW_LIMIT} chars; originalLength=${command.length}]`;
      const adapter = new ClaudeAdapter({ query: fakeQuery(async function* () {
        yield sdkMessage({ type: "assistant", uuid: "tool", parent_tool_use_id: null,
          message: { content: [{ type: "tool_use", id: "boundary", name: "Bash", input: { command } }] } });
        if (outcome === "failed") throw new Error("connection failure");
        if (outcome === "canceled") controller.abort();
        yield result("thread");
      }) });
      const summaries: string[] = [];
      let completed;
      try {
        completed = await adapter.runSessionTurn(request, (state) => {
          summaries.push(...state.steps.filter((step) => step.type === "command_execution").map((step) => step.summary));
        });
        assert.equal(outcome, "completed");
      } catch (error) {
        assert.ok(error instanceof ProviderTurnError);
        assert.notEqual(outcome, "completed");
        assert.equal(error.canceled, outcome === "canceled");
        completed = error.partialResult;
      }
      assert.ok(summaries.length > 0);
      assert.ok(summaries.every((summary) => summary === expected && !summary.includes(secret.slice(0, 10))));
      assert.equal(completed.artifact!.operationTimeline![0].summary, expected);
    }
  }
});
