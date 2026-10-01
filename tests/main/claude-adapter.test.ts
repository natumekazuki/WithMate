import assert from "node:assert/strict";
import { it } from "node:test";
import type { Options, ResolvedSettings, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter } from "../../src-electron/providers/claude/claude-adapter.js";
import { ProviderTurnError, type RunBackgroundStructuredPromptInput, type RunSessionTurnInput } from "../../src-electron/providers/provider-runtime.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { createDefaultSessionMemory } from "../../src-shared/memory/session-memory-state.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";

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

function result(sessionId: string, overrides: Record<string, unknown> = {}): SDKMessage {
  return sdkMessage({
    type: "result", subtype: "success", is_error: false, result: "Final", session_id: sessionId,
    usage: { input_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 5 },
    modelUsage: { "claude-opus-5-5": { inputTokens: 7, cacheReadInputTokens: 3, cacheCreationInputTokens: 2, outputTokens: 5, thinkingTokens: 1 } },
    ...overrides,
  });
}

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
// kind = "invariant"
// claim = "Claudeの明示session再開は最新system appendを渡し、stream本文と確定本文を二重表示しない"
// oracle = { type = "contract", ref = "docs/design/prompt-composition.md; Issue #751" }
// fault = "resumeで旧promptを使う、またはstreamとassistant本文を連結して二重化する"
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
  const completed = await adapter.runSessionTurn(input("thread-1"), (state) => { progress.push(state.assistantText); });
  assert.equal(seen[0].options.resume, "thread-1");
  assert.deepEqual(seen[0].options.systemPrompt, { type: "preset", preset: "claude_code", append: completed.logicalPrompt.systemText, snapshot: false });
  assert.equal(seen[0].prompt, completed.logicalPrompt.inputText);
  assert.equal(completed.assistantText, "Hello");
  assert.ok(progress.includes("Hello"));
  assert.ok(progress.every((text) => text !== "Hello\n\nHello"));
  assert.equal(completed.usage?.inputTokens, 12);
});

// @test-value v2
// kind = "invariant"
// claim = "Claudeのtool入力は成功扱いされず、実tool_resultでのみ確定する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md; Issue #751" }
// fault = "tool_useを実行完了として記録する、または子agentの本文を親応答へ混入する"
// observable = "確定operations、assistantText、監査raw items"
// observation_boundary = "public-boundary"
// scope = "claude-coding-turn"
// lifecycle = "permanent"
// impact = "未実行または失敗した変更を成功と誤認し、内部subagent出力がユーザー応答へ漏れる"
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
  assert.deepEqual(completed.operations.map((operation) => operation.details), ["Tool failed"]);
  assert.match(completed.rawItemsJson, /"status":"failed"/);
  assert.doesNotMatch(completed.rawItemsJson, /Internal/);
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
// impact = "キャンセルしたtool/応答を成功と監査・Sessionへ確定する"
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
    query: fakeQuery(async function* () { starts += 1; yield result("unused"); }),
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
// impact = "失敗途中のユーザー可視応答が監査から消え、turnが誤って完了する"
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
