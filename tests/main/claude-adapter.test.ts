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
// claim = "Claude progress保存の拒否はpartialを保持したfailedで返り、後続SDK eventを消費しない"
// oracle = { type = "contract", ref = "docs/design/audit-log.md" }
// fault = "callback rejectをwarnだけで握り潰してSDK実行を続けるかユーザー取消へ誤分類する"
// observable = "ProviderTurnErrorのcanceledとpartial assistant、拒否後のgenerator進行回数"
// observation_boundary = "public-boundary"
// scope = "ClaudeAdapter progress failure and cleanup"
// lifecycle = "permanent"
// impact = "保存できない状態で無制限に実行を進め、失敗を正常完了と誤表示することを防ぐ"
// distinction = "delivery helper単体ではSDK loop停止とpartial分類を検査できない"
// @end-test-value
it("Claudeはprogress拒否をpartial付きfailureとして返しSDK消費を止める", async () => {
  let advancedAfterPartial = false;
  const adapter = new ClaudeAdapter({ query: fakeQuery(async function* () {
    yield sdkMessage({ type: "assistant", session_id: "pressure", uuid: "partial", parent_tool_use_id: null, message: { content: [{ type: "text", text: "retained" }] } });
    advancedAfterPartial = true;
    yield result("pressure");
  }) });
  await assert.rejects(adapter.runSessionTurn(input(), () => Promise.reject(new Error("audit capacity"))), (error: unknown) => {
    assert.ok(error instanceof ProviderTurnError);
    assert.equal(error.canceled, false);
    assert.equal(error.partialResult?.assistantText, "retained");
    assert.match(error.message, /audit capacity/);
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
// claim = "Claudeの同期容量拒否は非cancel失敗とpartial本文を返し、元rejectionを未処理診断へ漏らさない"
// oracle = { type = "contract", ref = "docs/design/audit-log.md; docs/design/app-log-base.md" }
// fault = "signalRaceがalready-aborted分岐で引数Promiseの拒否を観測しない"
// observable = "ProviderTurnErrorのcanceled・partial本文、callback件数、process unhandledRejection event件数"
// observation_boundary = "public-boundary"
// scope = "Claude pre-handler capacity rejection"
// lifecycle = "permanent"
// impact = "捕捉済みの容量失敗をMainのfatal未処理診断として二重報告してしまう"
// distinction = "既存callback拒否testではcallback実行前の同期abortとalready-aborted raceへ到達しない"
// @end-test-value
it("Claudeの同期容量拒否は元rejectionを観測し非cancel partial failureを保つ", async (context) => {
  const body = "x".repeat(4 * 1024 * 1024);
  const unhandled: unknown[] = [];
  const observeUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", observeUnhandled);
  context.after(() => process.removeListener("unhandledRejection", observeUnhandled));
  let callbacks = 0;
  const adapter = new ClaudeAdapter({ query: fakeQuery(async function* () {
    yield sdkMessage({ type: "assistant", uuid: "capacity", parent_tool_use_id: null, message: { content: [{ type: "text", text: body }] } });
  }) });
  await assert.rejects(adapter.runSessionTurn(input(), () => { callbacks += 1; }), (error: unknown) => {
    assert.ok(error instanceof ProviderTurnError);
    assert.equal(error.canceled, false);
    assert.equal(error.partialResult.assistantText, body);
    assert.match(error.message, /Provider progress persistence capacity exceeded/);
    return true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(callbacks, 0);
  assert.deepEqual(unhandled, []);
});

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
    assert.equal(seen[index].prompt, completed.logicalPrompt.inputText);
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
  assert.equal(completed.operations[0]?.type, "command_execution");
  assert.match(completed.rawItemsJson, /"status":"failed"/);
  assert.doesNotMatch(completed.rawItemsJson, /Internal/);
});

// @test-value v2
// kind = "invariant"
// claim = "ClaudeのBash入力中はLatest Commandへ生のコマンドが表示され、非Bash toolをコマンド監査へ混入しない"
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
  assert.deepEqual(completed.operations.map((operation) => operation.type), ["command_execution", "tool_call"]);
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
// claim = "Claude内部容量停止は非cancel partial failureを保持し、child実exitまでcleanup completionまたはprovider Promiseを未終了に保つ"
// oracle = { type = "contract", ref = "docs/adr/002-provider-turn-terminal-and-cancellation.md; src-electron/providers/provider-runtime.ts: RunSessionTurnInput.onCleanupPending" }
// fault = "入力signal非abortの内部停止でSDK close/AbortErrorを実exitと誤認し、cleanup通知も実終了待ちも省く"
// observable = "close/AbortError後とexit後のprovider Promiseおよび通知cleanup completionのsettled状態、canceled、partial本文、consumer callback件数"
// observation_boundary = "public-boundary"
// scope = "Claude pre-handler overload child lifecycle"
// lifecycle = "permanent"
// impact = "生存中の旧childと同じSession/workspaceへの再送を許し副作用競合を起こす"
// distinction = "既存user cancel exit testでは入力signal非abortの容量拒否とcleanup通知経路を通らない"
// @end-test-value
it("Claude内部容量停止はfailed返却とchild実終了guardを両立する", async (context) => {
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
    const running = adapter.runSessionTurn(request, () => { callbacks += 1; }).catch((error: unknown) => { settled = true; return error; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.emit("error", Object.assign(new Error("aborted"), { name: "AbortError" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closeCalled, true);
    assert.equal(inputController.signal.aborted, false);
    assert.equal(callbacks, 0);
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
    assert.match(failure.message, /Provider progress persistence capacity exceeded/);
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

// @test-value v2
// kind = "invariant"
// claim = "Claude Bash summaryとraw保持は既存preview予算を守りassistant本文とoperation順序を保持する"
// oracle = { type = "contract", ref = "docs/design/audit-log.md: provider保持元64Ki previewと512Ki raw trace、assistant全本文保護" }
// fault = "Bash commandをstepsへ全量保持するかraw打切りで本文とoperationを失う"
// observable = "SDK消費中のprogress summary、最終operationsとraw省略marker、assistant全文"
// observation_boundary = "public-boundary"
// scope = "Claude coding turn owner"
// lifecycle = "permanent"
// impact = "大きいBash入力の反復でMain heapが増幅し監査と会話を失う"
// distinction = "shared helper testはClaude receiveからprogressとfinalへの接続を観測しない"
// @end-test-value
it("ClaudeはBash summaryとraw保持をboundedにし本文と操作順序を保つ", async () => {
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
  assert.deepEqual(completed.operations.filter((operation) => operation.type === "command_execution").map((operation) => operation.summary), Array(16).fill(expected));
  assert.equal(completed.assistantText, body);
  assert.ok(completed.rawItemsJson.length <= 512 * 1024);
  assert.ok(JSON.parse(completed.rawItemsJson).some((item: { type: string; data?: { omittedItems?: number } }) => item.type === "withmate.raw_items_truncated" && (item.data?.omittedItems ?? 0) > 0));
});
