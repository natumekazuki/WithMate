import assert from "node:assert/strict";

import type { Stats } from "node:fs";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import type { CodexProjectionRequest } from "../../src-electron/providers/codex/codex-projection-protocol.js";
import { CodexProjectionClient } from "../../src-electron/providers/codex/codex-projection-client.js";
import type { CodexProjectionCommand, CodexProjectionProgress } from "../../src-electron/providers/codex/codex-projection-protocol.js";
import { _setWalkDirectoryStatOverrideForTesting, captureWorkspaceSnapshotPaths, createWorkspaceSnapshotIndex, refreshWorkspaceSnapshotIndex } from "../../src-electron/platform/snapshot-ignore.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogProvider, ModelReasoningEffort } from "../../src-shared/settings/model-catalog.js";
import { CodexAdapter } from "../../src-electron/providers/codex/codex-adapter.js";
import { ProviderTurnError, type RunBackgroundStructuredPromptInput, type RunSessionTurnInput, type RunSessionTurnProgressChanges } from "../../src-electron/providers/provider-runtime.js";
import { applyCodexTurnEvent, createCodexTurnStreamState, getLiveCodexAssistantText } from "../../src-electron/providers/codex/codex-turn-events.js";
import { CodexAppServerTransport, CodexAppServerRpcError, type CodexProtocolEvent } from "../../src-electron/providers/codex/app-server-transport.js";
import { SESSION_MEMORY_EXTRACTION_OUTPUT_SCHEMA } from "../../src-electron/session/session-memory-extraction.js";
import { PROVIDER_RAW_ITEMS_JSON_LIMIT, PROVIDER_TEXT_PREVIEW_LIMIT } from "../../src-electron/session/provider-payload-limits.js";
import { buildCodexStableRawItems, toMessageOperations } from "../../src-electron/providers/codex/codex-event-projection.js";
import { WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV, WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV } from "../../src-shared/agent-runtime/agent-runtime-binding-contract.js";
import type { LiveElicitationRequest, LiveRunStep } from "../../src-shared/session/runtime-state.js";
const CODEX_PROVIDER_CATALOG: ModelCatalogProvider = {
  id: "codex",
  label: "OpenAI Codex",
  defaultModelId: "gpt-5.4",
  defaultReasoningEffort: "high",
  models: [
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      reasoningEfforts: ["medium", "high", "xhigh"],
    },
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4 mini",
      reasoningEfforts: ["low", "medium", "high"],
    },
    {
      id: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
  ],
};

function createSession(options?: {
  threadId?: string;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  approvalMode?: "never" | "on-request" | "untrusted";
  codexSandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  codexSpeed?: "standard" | "fast";
  codexReviewer?: "user" | "auto-review";
  allowedAdditionalDirectories?: string[];
}) {
  const {
    threadId = "",
    model = "gpt-5.4",
    reasoningEffort = "high",
    approvalMode = DEFAULT_APPROVAL_MODE,
    codexSandboxMode,
    codexSpeed,
    codexReviewer,
    allowedAdditionalDirectories,
  } = options ?? {};

  return {
    ...buildNewSession({
      provider: "codex",
      taskTitle: "codex session",
      workspaceLabel: "workspace",
      workspacePath: "F:/repo",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode,
      codexSandboxMode,
      codexSpeed,
      codexReviewer,
      model,
      reasoningEffort,
      allowedAdditionalDirectories,
    }),
    threadId,
  };
}

function createCodexBackgroundPromptInput(
  overrides?: Partial<RunBackgroundStructuredPromptInput>,
): RunBackgroundStructuredPromptInput {
  return {
    providerId: "codex",
    workspacePath: "F:/repo",
    appSettings: createDefaultAppSettings(),
    model: "gpt-5.4",
    reasoningEffort: "high",
    timeoutMs: 10_000,
    prompt: {
      systemText: "",
      userText: "extract data",
      outputSchema: {
        type: "object",
        properties: {
          answer: {
            type: "string",
          },
        },
        required: ["answer"],
        additionalProperties: false,
      },
    },
    ...overrides,
  };
}

function createCodexRunSessionTurnInput(workspacePath: string): RunSessionTurnInput {
  const session = { ...createSession({ threadId: "" }), workspacePath };
  return {
    session,
    executionOptions: captureSessionExecutionOptions(session),
    sessionMemory: {
      sessionId: "session-1",
      workspacePath,
      threadId: "",
      schemaVersion: 1,
      goal: "",
      decisions: [],
      openQuestions: [],
      nextActions: [],
      notes: [],
      updatedAt: "",
    },
    projectMemoryEntries: [],
    providerCatalog: CODEX_PROVIDER_CATALOG,
    userMessage: "run task",
    appSettings: createDefaultAppSettings(),
    attachments: [],
  };
}


class FakeTransport {
  calls: Array<{ method: string; params: unknown }> = [];
  events: CodexProtocolEvent[] = [];
  closed = false;
  failure: Error | null = null;
  waiter: ((event: CodexProtocolEvent) => void) | null = null;
  rejectWaiter: ((error: Error) => void) | null = null;
  steerResponse: Promise<{ turnId: string }> | null = null;
  loginError: Error | null = null;
  loginType = "apiKey";
  async start() {}
  async request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "account/login/start") {
      if (this.loginError) throw this.loginError;
      return { type: this.loginType } as T;
    }
    if (method === "thread/start" || method === "thread/resume") return { thread: { id: "thread-1" } } as T;
    if (method === "turn/start") return { turn: { id: "turn-1" } } as T;
    if (method === "turn/steer") return (await (this.steerResponse ?? Promise.resolve({ turnId: "turn-1" }))) as T;
    return {} as T;
  }
  async nextEvent(): Promise<CodexProtocolEvent> {
    const event = this.events.shift();
    if (event) return event;
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("Codex transport closed.");
    return new Promise((resolve, reject) => { this.waiter = resolve; this.rejectWaiter = reject; });
  }
  push(event: CodexProtocolEvent) { if (this.waiter) { const waiter = this.waiter; this.waiter = null; this.rejectWaiter = null; waiter(event); } else this.events.push(event); }
  async close() {
    this.closed = true;
    this.rejectWaiter?.(this.failure ?? new Error("Codex transport closed."));
    this.waiter = null;
    this.rejectWaiter = null;
  }
  whenClosed(): Promise<void> { return Promise.resolve(); }
}

// @test-value v2
// kind = "contract"
// claim = "Codex async構造化質問はcurrent turnで一度ずつ独立表示され、選択肢と自由入力を秘匿化し、回答待ちでもturn終了で失効する"
// oracle = { type = "contract", ref = "Issue #823; Codex 0.159.0 ThreadItem agentMessage delivery/questions" }
// fault = "開始完了通知で質問を重複表示する、他turnや最終snapshotから質問を表示する、回答待ちで処理を停止する、または質問にAPI keyを漏らす"
// observable = "CodexAdapterのelicitation callbackに渡るrequestとsignal、およびrunSessionTurnの完了"
// observation_boundary = "public-boundary"
// scope = "Codex foreground native通知から非同期質問callbackとturn終端まで"
// lifecycle = "permanent"
// impact = "ユーザーが質問を見落とす、重複回答する、実行が停止する、またはcredentialが画面へ漏れる"
// distinction = "型検査ではnative通知のscope・重複・非blocking lifecycleとruntime秘匿化を確認できない。合成transportの短い1turnで検証する"
// risk_tags = ["privacy"]
// @end-test-value
it("Codex async質問を重複なく非blockingで配信しturn終了で失効する", async () => workspace(async (directory) => {
  const secret = "synthetic-question-api-key";
  const first = { ...message("ask-1", "ordinary text"), delivery: "async", questions: [
    { title: "Which? " + secret, options: ["One " + secret, "Two"] },
    { title: "Details?", options: [] }, { title: "Anything else?", options: null }, { title: "Final detail?" },
  ] };
  const second = { ...message("ask-2", ""), delivery: "async", questions: [{ title: "Independent?" }] };
  const transport = new FakeTransport();
  transport.events = [
    notification("item/started", { item: first, threadId: "other-thread" }),
    notification("item/completed", { item: first, turnId: "other-turn" }),
    notification("item/started", { item: message("plain", "Should I proceed?") }),
    notification("item/started", { item: { ...first, delivery: "sync" } }),
    notification("item/started", { item: first }), notification("item/completed", { item: first }),
    notification("item/completed", { item: second }),
    completed([first, second, { ...second, id: "snapshot-only" }]),
  ];
  const input = createCodexRunSessionTurnInput(directory);
  input.signal = AbortSignal.timeout(10_000);
  input.appSettings.codingProviderSettings.codex.apiKey = secret;
  const requests: LiveElicitationRequest[] = [];
  const signals: AbortSignal[] = [];
  input.onElicitationRequest = (request, signal) => {
    assert.ok(signal);
    requests.push(request); signals.push(signal);
    if (request.requestId.endsWith(":ask-2")) return { action: "accept", content: { "question-1": "answer" } };
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("expired")), { once: true }));
  };
  await new CodexAdapter(undefined, { createTransport: () => transport }).runSessionTurn(input);
  assert.deepEqual(requests.map(request => request.requestId), ["async:turn-1:ask-1", "async:turn-1:ask-2"]);
  assert.ok(signals.every(signal => signal.aborted));
  const request = requests[0];
  assert.equal(request.delivery, "user-message");
  assert.equal(request.turnId, "turn-1");
  assert.equal(request.kind, "question");
  assert.equal(request.mode, "form");
  assert.equal(request.blocking, false);
  assert.equal(request.message, "Codex has a question");
  assert.deepEqual(request.fields.map(field => [field.name, field.type]), [
    ["question-1", "select"], ["question-2", "text"], ["question-3", "text"], ["question-4", "text"],
  ]);
  const choice = request.fields[0];
  assert.equal(choice.type, "select");
  if (choice.type !== "select") throw new Error("Expected select");
  assert.equal(choice.allowFreeText, true);
  assert.equal(choice.defaultValue, choice.options[0].value);
  assert.equal(choice.options[1].value, "Two");
  assert.equal(request.fields[1].title, "Details?");
  assert.match(choice.title, /REDACTED/);
  assert.match(choice.options[0].label, /REDACTED/);
  assert.ok(!JSON.stringify(requests).includes(secret));
  assert.equal(transport.calls.some(call => call.method === "turn/steer"), false);
}));

// @test-value v2
// kind = "contract"
// claim = "Codex async質問callbackの同期例外と非同期失敗はturn失敗として通知される"
// oracle = { type = "contract", ref = "Issue #823; docs/design/provider-adapter.md: provider errors" }
// fault = "非同期質問callbackの失敗を握り潰してturnを待ち続ける、または未処理Promise rejectionにする"
// observable = "runSessionTurnのProviderTurnErrorとtransport終了状態"
// observation_boundary = "public-boundary"
// scope = "Codex非同期質問のcallback失敗処理"
// lifecycle = "permanent"
// impact = "質問表示の失敗が利用者へ伝わらずsessionが実行中のまま残る"
// distinction = "既存のRPC interaction testは応答不要のasync質問callbackを通らない。同期とPromiseの2ケースで失敗伝播を確認する"
// @end-test-value
it("Codex async質問callbackの失敗をturnエラーとして伝える", async () => workspace(async (directory) => {
  for (const synchronous of [true, false]) {
    const transport = new FakeTransport();
    transport.events = [notification("item/started", { item: { ...message("ask", ""), delivery: "async", questions: [{ title: "Question?" }] } })];
    const input = createCodexRunSessionTurnInput(directory);
    input.signal = AbortSignal.timeout(10_000);
    input.onElicitationRequest = () => {
      if (synchronous) throw new Error("question delivery failed");
      return Promise.reject(new Error("question delivery failed"));
    };
    await assert.rejects(new CodexAdapter(undefined, { createTransport: () => transport }).runSessionTurn(input),
      (error: unknown) => error instanceof ProviderTurnError && /question delivery failed/.test(error.message));
    assert.equal(transport.closed, true);
  }
}));

// @test-value v2
// kind = "contract"
// claim = "Codex async質問は外部cancelと連動して回答待ちを失効しturn取消を完了する"
// oracle = { type = "contract", ref = "Issue #823; docs/design/provider-adapter.md: Cancellation" }
// fault = "質問待ちsignalをturn cancelに連動せず回答UIと処理を残す"
// observable = "質問callbackのsignalとrunSessionTurnのcanceled ProviderTurnError"
// observation_boundary = "public-boundary"
// scope = "Codex非同期質問中の外部取消"
// lifecycle = "permanent"
// impact = "取消済みturnの質問を回答できる状態が残り誤った追加入力を誘発する"
// distinction = "既存のturn cancel testには非同期質問のsignalがない。合成質問1件でcancelとの接続を検証する"
// @end-test-value
it("Codex async質問の待機を外部cancelと連動する", async () => workspace(async (directory) => {
  const controller = new AbortController();
  const transport = new FakeTransport();
  transport.events = [notification("item/started", { item: { ...message("ask", ""), delivery: "async", questions: [{ title: "Question?" }] } })];
  const input = createCodexRunSessionTurnInput(directory);
  input.signal = controller.signal;
  let questionSignal: AbortSignal | undefined;
  input.onElicitationRequest = (_request, signal) => {
    questionSignal = signal;
    controller.abort();
    return Promise.reject(new Error("canceled question"));
  };
  await assert.rejects(new CodexAdapter(undefined, { createTransport: () => transport }).runSessionTurn(input),
    (error: unknown) => error instanceof ProviderTurnError && error.canceled);
  assert.equal(questionSignal?.aborted, true);
}));

// @test-value v2
// kind = "contract"
// claim = "構造化background実行ではasync質問通知を受信しても対話待ちを作らず出力を確定する"
// oracle = { type = "contract", ref = "src-electron/providers/provider-runtime.ts: RunBackgroundStructuredPromptInput; Issue #823" }
// fault = "async質問をforeground専用callbackへ送ろうとしてbackground実行を停止する"
// observable = "runBackgroundStructuredPromptの構造化出力とtransport終了"
// observation_boundary = "public-boundary"
// scope = "Codex background構造化実行に届くasync質問通知"
// lifecycle = "permanent"
// impact = "Memory抽出などの非対話処理が質問待ちで停止する"
// distinction = "foreground質問testはsessionInputを必ず持つ。実際のbackground入口でsessionInputなしの動作を短い合成turnで確認する"
// @end-test-value
it("Codex async質問はbackground構造化実行を停止しない", async () => {
  const item = { ...message("ask", '{"answer":"done"}'), delivery: "async", questions: [{ title: "Question?" }] };
  const transport = new FakeTransport();
  transport.events = [notification("item/started", { item }), completed([item])];
  const result = await new CodexAdapter(undefined, { createTransport: () => transport })
    .runBackgroundStructuredPrompt(createCodexBackgroundPromptInput());
  assert.deepEqual(result.output, { answer: "done" });
  assert.equal(transport.closed, true);
});

// @test-value v2
// kind = "contract"
// claim = "Codex MCPの取得済みcontentとstructured false/0・明示空結果はliveと通常artifactに一致して残り、未取得は入力で補完せず失敗・取消でもpartial結果と個別error/statusを維持する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Boundary / Session Flow 8-10; src-electron/providers/codex/codex-turn-events.ts: CodexTurnItem mcpToolCall result" }
// fault = "content-onlyをargumentsへ置換する、false/0や空contentを未取得と混同する、errorまたはturn終端で取得結果を消す、結果のsecretや巨大出力をそのまま公開する"
// observable = "実Workerを使うCodexAdapterのprogress stepsとcompleted/failed/canceled result.artifact.operationTimelineのdetails・ID・status・error・exitCode"
// observation_boundary = "public-boundary"
// scope = "Codex MCP native通知から通常artifactとlive callbackまで"
// lifecycle = "permanent"
// impact = "利用者が取得済みtool結果をDetailsで読めない、入力を結果と誤認する、またはcredentialを公開する"
// distinction = "projection単体や型検査ではadapterの成功・partial artifact接続と実Worker redactionを確認できない。短い合成通知の3終端ケースで接続を維持する"
// @end-test-value
it("Codex MCPの取得結果をliveと成功・失敗・取消artifactへ保持する", async () => workspace(async (directory) => {
  const secret = "synthetic-mcp-api-secret";
  for (const terminal of ["completed", "failed", "interrupted"] as const) {
    const base = { type: "mcpToolCall", server: "fixture", tool: "lookup", arguments: { query: "synthetic input" }, error: null, status: "completed" };
    const items = [
      { ...base, id: "content", result: { structuredContent: null, content: [{ type: "text", text: "synthetic acquired result" }] } },
      { ...base, id: "structured", result: { structuredContent: { answer: "structured acquired result" }, content: [{ type: "text", text: "not selected" }] } },
      { ...base, id: "false", result: { structuredContent: false, content: [] } },
      { ...base, id: "zero", result: { structuredContent: 0, content: [] } },
      { ...base, id: "empty", result: { structuredContent: null, content: [] } },
      { ...base, id: "unavailable", result: null, status: "inProgress" },
      { ...base, id: "partial", result: { structuredContent: null, content: [{ type: "text", text: "partial acquired result" }] }, error: { message: "tool failure " + secret }, status: "failed" },
      { ...base, id: "large", result: { structuredContent: null, content: [{ type: "text", text: "protected " + secret + " " + "x".repeat(PROVIDER_TEXT_PREVIEW_LIMIT + 20) }] } },
    ];
    const transport = new FakeTransport();
    transport.events = [
      ...items.map(item => notification(item.status === "inProgress" ? "item/started" : "item/completed", { item })),
      notification("turn/completed", { turn: { id: "turn-1", status: terminal, items, error: terminal === "failed" ? { message: "turn failure" } : null } }),
    ];
    const input = createCodexRunSessionTurnInput(directory);
    input.appSettings.codingProviderSettings.codex.apiKey = secret;
    const live = new Map<string, LiveRunStep>();
    let rejected = false;
    const result = await new CodexAdapter(undefined, { createTransport: () => transport }).runSessionTurn(input, (_state, changes) => {
      for (const id of changes.steps.removes) live.delete(id);
      for (const step of changes.steps.upserts) live.set(step.id, step);
    }).catch((error: unknown) => {
      rejected = true;
      assert.notEqual(terminal, "completed");
      assert.ok(error instanceof ProviderTurnError);
      assert.equal(error.canceled, terminal === "interrupted");
      return error.partialResult;
    });
    assert.equal(rejected, terminal !== "completed");
    const operations = result.artifact!.operationTimeline!;
    assert.deepEqual(operations.map(operation => operation.id), items.map(item => item.id));
    const expectedDetails = [
      '[{"type":"text","text":"synthetic acquired result"}]',
      '{"answer":"structured acquired result"}', "false", "0", "[]", undefined,
      '[{"type":"text","text":"partial acquired result"}]',
    ];
    for (const [index, item] of items.entries()) {
      const operation = operations[index];
      const step = live.get(item.id);
      assert.ok(step, `${terminal}: missing live ${item.id}`);
      assert.ok(step.details === operation.details, `${terminal}: inconsistent live/artifact ${item.id}`);
      if (item.id !== "large") assert.equal(operation.details, expectedDetails[index]);
      assert.equal(operation.status, item.status === "inProgress" ? "in_progress" : item.status);
      assert.equal(step.status, operation.status);
      assert.equal(operation.exitCode, undefined);
      assert.equal(step.exitCode, undefined);
      assert.deepEqual(step.error, operation.error);
    }
    const partial = operations.find(operation => operation.id === "partial")!;
    assert.ok(partial.error);
    assert.ok(partial.error.message.startsWith("tool failure "));
    assert.match(partial.error.message, /REDACTED/);
    const large = operations.find(operation => operation.id === "large")!.details!;
    assert.ok(large.length <= PROVIDER_TEXT_PREVIEW_LIMIT + 100);
    assert.match(large, /truncated/);
    assert.match(large, /REDACTED/);
    assert.ok(!JSON.stringify([...live.values(), operations]).includes(secret));
    assert.equal(transport.closed, true);
  }
}));

// @test-value v2
// kind = "contract"
// claim = "CodexはHTTP credentialをprocess envだけへ渡し、存在する既知managed設定だけをturnで無効化し、第三者設定とpromptを維持してWorker出力からtokenを除去する"
// oracle = { type = "contract", ref = "docs/adr/027-shared-localhost-http-mcp-turn-identity.md" }
// fault = "tokenをargvやthread設定へ埋める、存在しないserverを無効化する、第三者serverを無効化する、またはWorker投影からtokenを漏らす"
// observable = "transport作成envとargv、config/readとthread/startの送信params、runSessionTurnの確定結果"
// observation_boundary = "consumer"
// scope = "Codex foreground HTTP MCP bootstrap and Worker projection"
// lifecycle = "permanent"
// impact = "native設定のvalidationに失敗してturnを開始できないか、第三者MCPが失われ、credentialが監査へ漏れる"
// distinction = "既存env testはHTTP tokenを扱わず、SDK型はnested native設定の存在依存やWorker越しの秘匿化を検査できない。fake transportでモデル通信せず確認する"
// risk_tags = ["privacy", "authentication"]
// @end-test-value
it("CodexのHTTP MCP credentialと既存native設定の境界を保つ", async () => workspace(async (directory) => {
  const input = createCodexRunSessionTurnInput(directory);
  input.agentRuntimeBinding = {
    bindingId: "binding", bindingReference: "reference", providerId: "codex",
    executionGeneration: "generation", transport: "env", expiresAt: null,
    managedMcp: { memoryUrl: "http://127.0.0.1:47891/memory", glossaryUrl: "http://127.0.0.1:47891/glossary", token: "opaque-http-token" },
  };
  const transport = new FakeTransport();
  const request = transport.request.bind(transport);
  transport.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "config/read") {
      transport.calls.push({ method, params });
      return { config: { mcp_servers: { "withmate-memory": { command: "stdio-fixture" }, "third-party": { command: "third-party-fixture" } } } } as T;
    }
    return request<T>(method, params);
  };
  transport.events = [completed([message("http", "echo opaque-http-token")])];
  let options: { env?: NodeJS.ProcessEnv; arguments?: readonly string[] } | undefined;
  const adapter = new CodexAdapter(undefined, { createTransport: (value) => { options = value; return transport; } });
  const output = await adapter.runSessionTurn(input);
  assert.equal(options?.env?.WITHMATE_MANAGED_MCP_TOKEN, "opaque-http-token");
  const argumentsText = options!.arguments!.join("\n");
  assert.match(argumentsText, /mcp_servers.withmate-memory-http=.*env_http_headers/);
  assert.match(argumentsText, /mcp_servers.withmate-glossary-http=.*env_http_headers/);
  assert.doesNotMatch(argumentsText, /opaque-http-token/);
  assert.deepEqual(transport.calls.find((call) => call.method === "config/read")?.params, { cwd: directory, includeLayers: false });
  const thread = transport.calls.find((call) => call.method === "thread/start")!.params as { config: { mcp_servers: unknown } };
  assert.deepEqual(thread.config.mcp_servers, {
    "withmate-memory": { enabled: false },
    "withmate-memory-http": { url: "http://127.0.0.1:47891/memory", env_http_headers: { "x-withmate-mcp-token": "WITHMATE_MANAGED_MCP_TOKEN" } },
    "withmate-glossary-http": { url: "http://127.0.0.1:47891/glossary", env_http_headers: { "x-withmate-mcp-token": "WITHMATE_MANAGED_MCP_TOKEN" } },
  });
  assert.doesNotMatch(JSON.stringify(transport.calls), /opaque-http-token/);
  assert.match(output.assistantText, /WITHMATE_BINDING_REFERENCE_REDACTED/);
  assert.doesNotMatch(JSON.stringify(output), /opaque-http-token/);
}));

// @test-value v2
// kind = "contract"
// claim = "Codex progressは変更stepだけを渡し、resolved event burst中でもmacrotaskを実行する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Codex projection owner; src-electron/providers/codex/codex-adapter.ts: executeTurn" }
// fault = "1step変更で既存全stepを変更扱いするか、同期event連鎖でMainのtimerを飢餓させる"
// observable = "実adapter callbackのchanged step ID列と、受信済みburstの全event読取前に予約したsetImmediateの実行位置"
// observation_boundary = "public-boundary"
// scope = "CodexAdapter progress owner and scheduling"
// lifecycle = "permanent"
// impact = "多数operationの履歴増幅と制御応答の遅延を防ぐ"
// distinction = "共有map単体や型検査ではnative eventからcallbackへの変更情報とevent-loop接続を確認できない"
// @end-test-value
it("Codexは変更stepだけを渡しevent burst中にもmacrotaskへyieldする", { timeout: 10_000 }, async () => workspace(async (directory) => {
  let readEvents = 0;
  let readEventsAtYield = -1;
  let burstProbe: Promise<void> | undefined;
  let initialStepsDelivered!: () => void;
  const initialDelivery = new Promise<void>(resolve => { initialStepsDelivered = resolve; });
  class BurstTransport extends FakeTransport {
    override async nextEvent() {
      readEvents += 1;
      if (readEvents === 3) await initialDelivery;
      if (readEvents > 3 && !burstProbe) burstProbe = new Promise<void>((resolve) => {
        setImmediate(() => { readEventsAtYield = readEvents; resolve(); });
      });
      return super.nextEvent();
    }
  }
  const transport = new BurstTransport();
  transport.events = [
    notification("item/started", { item: { type: "commandExecution", id: "one", command: "one", aggregatedOutput: "", exitCode: null, status: "inProgress" } }),
    notification("item/started", { item: { type: "commandExecution", id: "two", command: "two", aggregatedOutput: "", exitCode: null, status: "inProgress" } }),
    notification("item/commandExecution/outputDelta", { itemId: "one", delta: "changed" }),
    ...Array.from({ length: 100 }, () => notification("thread/status/changed", { status: "active" })),
    completed(),
  ];
  const changes: RunSessionTurnProgressChanges[] = [];
  const adapter = new CodexAdapter(undefined, { createTransport: () => transport });
  await adapter.runSessionTurn(createCodexRunSessionTurnInput(directory), (_state, change) => {
    changes.push(change);
    if (change.steps.upserts.some(step => step.id === "one") && change.steps.upserts.some(step => step.id === "two")) initialStepsDelivered();
  });
  assert.ok(burstProbe);
  await burstProbe;
  assert.deepEqual(changes.flatMap(change => change.steps.upserts.map(step => ({ id: step.id, details: step.details }))), [
    { id: "one", details: "" }, { id: "two", details: "" }, { id: "one", details: "changed" },
  ]);
  assert.ok(changes.every(change => change.steps.removes.length === 0));
  assert.ok(readEventsAtYield > 0 && readEventsAtYield < readEvents);
}));

// @test-value v2
// kind = "contract"
// claim = "Worker liveで消費済みの変更は応答直前の取消でもMainへ一度配送し、失敗したlive要求の未配送変更は終端flushしpartial artifactとcleanupを維持する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Codex projection owner / Streaming Policy" }
// fault = "取消signalで受信済み変更を捨てるか、live拒否後に終端変更またはpartial operationを失う"
// observable = "実Worker経由adapterの変更callbackにあるID/details・閉じたinputAvailable・ProviderTurnError partial artifact・transport閉鎖"
// observation_boundary = "public-boundary"
// scope = "CodexAdapter live response cancellation and rejected live flush"
// lifecycle = "permanent"
// impact = "Main snapshotと取消時Detailsに取得済み操作が欠落するか失敗を成功と誤認する"
// distinction = "通常取消testはWorkerが変更を消費した後からcallbackまでのsignal競合を固定せず、final consumer拒否とは別の配送境界。2件の短いfixtureで確認する"
// @end-test-value
it("live応答と取消の交差でも変更を届けlive拒否時は終端flushする", { timeout: 10_000 }, async (context) => workspace(async (directory) => {
  for (const scenario of ["cancel", "live-failure"] as const) {
    const transport = new FakeTransport();
    const command = { id: "one", type: "commandExecution", command: "one", aggregatedOutput: "acquired output", exitCode: 0, status: "completed" };
    transport.events = [notification("item/completed", { item: command })];
    const controller = new AbortController();
    const call = CodexProjectionClient.prototype.call;
    let intercepted = false;
    let eventsApplied = false;
    const spy = context.mock.method(CodexProjectionClient.prototype, "call", async function<T>(this: CodexProjectionClient, id: string, request: CodexProjectionCommand): Promise<T> {
      if (scenario === "live-failure" && request.type === "live" && !request.force && eventsApplied && !intercepted) {
        intercepted = true;
        throw new Error("live response failed");
      }
      const result = await call.call(this, id, request) as T;
      if (request.type === "events") eventsApplied = true;
      if (scenario === "cancel" && request.type === "live" && (result as CodexProjectionProgress | null)?.changes.steps.upserts.length && !intercepted) {
        intercepted = true;
        controller.abort();
      }
      return result;
    });
    const delivered: LiveRunStep[] = [];
    try {
      await assert.rejects(new CodexAdapter(undefined, { createTransport: () => transport }).runSessionTurn(
        { ...createCodexRunSessionTurnInput(directory), signal: controller.signal }, (state, changes) => {
          assert.equal(changes.snapshot, false);
          if (intercepted) assert.equal(state.inputAvailable, false);
          delivered.push(...changes.steps.upserts);
        }), (error: unknown) => {
          assert.ok(error instanceof ProviderTurnError);
          assert.equal(error.canceled, scenario === "cancel");
          if (scenario === "live-failure") assert.match(error.message, /live response failed/);
          assert.equal(error.partialResult.artifact?.operationTimeline?.[0].details, "acquired output");
          return true;
        });
      assert.equal(intercepted, true);
      assert.deepEqual(delivered.map(step => [step.id, step.details]), [["one", "acquired output"]]);
      assert.equal(transport.closed, true);
    } finally { spy.mock.restore(); controller.abort(); }
  }
}));
// @test-value v2
// kind = "invariant"
// claim = "cleanup失敗はnative completed/failed/interruptedの結果を変えず診断を残し実終了まで競合実行を拒否する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "close例外で確定outcomeを上書きするか終了未確認のprocessと再実行を重複させる"
// observable = "run結果またはProviderTurnError、履歴診断、cleanup完了前後のsession/workspace/thread再実行"
// observation_boundary = "component-behavior"
// scope = "codex-adapter terminal cleanup"
// lifecycle = "permanent"
// impact = "完了結果の喪失と同一workspaceでのprocess競合を防止する"
// distinction = "transport単体ではnative結果とadapterの再実行入口の組合せを確認できない"
// @end-test-value
it("cleanup失敗をoutcomeから分離し実終了まで再実行を拒否する", async () => workspace(async (directory) => {
  for (const status of ["completed", "failed", "interrupted"]) {
    let release!: () => void;
    const termination = new Promise<void>((resolve) => { release = resolve; });
    class CleanupFailure extends FakeTransport {
      override async close() { throw new Error("cleanup failure"); }
      override whenClosed() { return termination; }
    }
    let first = true;
    const transport = new CleanupFailure();
    transport.events = [completed([message("answer", "retained")], status)];
    const adapter = new CodexAdapter(undefined, { createTransport: () => {
      if (first) { first = false; return transport; }
      const next = new FakeTransport();
      next.events = [completed([message("answer", "next")])];
      return next;
    } });
    const input = createCodexRunSessionTurnInput(directory);
    let cleanup: Promise<void> | undefined;
    input.onCleanupPending = (completion) => { cleanup = completion; };
    let rejected = false;
    const result = await adapter.runSessionTurn(input).catch((error: unknown) => {
      rejected = true;
      assert.ok(error instanceof ProviderTurnError);
      assert.notEqual(status, "completed");
      assert.equal(error.canceled, status === "interrupted");
      assert.equal(error.message, status === "failed" ? "provider failed" : "Codex turn interrupted");
      return error.partialResult;
    });
    assert.equal(rejected, status !== "completed");
    assert.equal(result.assistantText, "retained");
    assert.ok(result.providerMetadata?.some((item) => item.source === "codex-adapter.process-cleanup"));
    assert.match(JSON.stringify(result.providerMetadata), /cleanup failure/);
    assert.ok(cleanup);
    await assert.rejects(adapter.runSessionTurn(input), /cleanup is still pending/);
    const sameSession = createCodexRunSessionTurnInput(path.join(directory, "other"));
    sameSession.session.id = input.session.id;
    await assert.rejects(adapter.runSessionTurn(sameSession), /cleanup is still pending/);
    const sameWorkspace = createCodexRunSessionTurnInput(directory);
    sameWorkspace.session.id = "other-session";
    await assert.rejects(adapter.runSessionTurn(sameWorkspace), /cleanup is still pending/);
    const sameThread = createCodexRunSessionTurnInput(path.join(directory, "other"));
    sameThread.session.id = "other-thread-session";
    sameThread.session.threadId = "thread-1";
    await assert.rejects(adapter.runSessionTurn(sameThread), /cleanup is still pending/);
    await assert.rejects(adapter.runBackgroundStructuredPrompt(createCodexBackgroundPromptInput({ workspacePath: directory })), /cleanup is still pending/);
    release();
    await cleanup;
    assert.equal((await adapter.runSessionTurn(input)).assistantText, "next");
  }
}));

// @test-value v2
// kind = "invariant"
// claim = "backgroundのcompleted出力もcleanup失敗で失わず秘匿済み診断と実終了までのguardを残す"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "背景構造化出力をclose例外で捨てるかAPI keyをcleanup履歴へ漏らす"
// observable = "background output、rawItemsJsonと再実行拒否"
// observation_boundary = "component-behavior"
// scope = "codex-adapter background cleanup"
// lifecycle = "permanent"
// impact = "成功した背景抽出の喪失と秘密情報の履歴漏洩を防ぐ"
// distinction = "Mainの結果構築を通らないbackground固有の返却経路を検査する"
// @end-test-value
it("background completedとcleanup診断を分離する", async () => {
  class CleanupFailure extends FakeTransport {
    override async close() { throw new Error("cleanup fake-cleanup-key"); }
    override whenClosed() { return new Promise<void>(() => {}); }
  }
  const transport = new CleanupFailure();
  transport.events = [completed([message("answer", '{"answer":"ok"}')])];
  const input = createCodexBackgroundPromptInput();
  input.appSettings.codingProviderSettings.codex.apiKey = "fake-cleanup-key";
  const logs: unknown[] = [];
  const adapter = new CodexAdapter((entry) => logs.push(entry), { createTransport: () => transport });
  const result = await adapter.runBackgroundStructuredPrompt(input);
  assert.deepEqual(result.output, { answer: "ok" });
  assert.match(result.rawItemsJson, /process_cleanup_failed/);
  assert.ok(!result.rawItemsJson.includes("fake-cleanup-key"));
  assert.ok(!JSON.stringify(logs).includes("fake-cleanup-key"));
  await assert.rejects(adapter.runBackgroundStructuredPrompt(input), /cleanup is still pending/);
});

// @test-value v2
// kind = "invariant"
// claim = "steer履歴は一致ACKで受理した本文と添付のみを対応turnへ秘匿・上限付きで保存する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "追加入力を履歴から落とす、拒否入力を受理扱いする、または秘密値と巨大本文を未制限で保存する"
// observable = "実送信paramsとproviderMetadataの本文・file/image・turn ID・秘匿・サイズ"
// observation_boundary = "component-behavior"
// scope = "codex-adapter steer artifact"
// lifecycle = "permanent"
// impact = "turn中の指示変更を履歴できず、秘密情報や過大なpayloadが保存されることを防ぐ"
// distinction = "共有履歴helperではACK確認とnative steer送信内容の関連付けを検査できない"
// @end-test-value
it("受理steerの本文と添付を秘匿してbounded履歴へ残す", async () => workspace(async (directory) => {
  const transport = new FakeTransport();
  const adapter = new CodexAdapter(undefined, { createTransport: () => transport });
  const input = createCodexRunSessionTurnInput(directory);
  input.appSettings.codingProviderSettings.codex.apiKey = "fake-steer-key";
  let ready!: () => void;
  const available = new Promise<void>((resolve) => { ready = resolve; });
  const run = adapter.runSessionTurn(input, (state) => { if (state.inputAvailable) ready(); });
  await available;
  const attachments: RunSessionTurnInput["attachments"] = [
    { id: "file", kind: "file", source: "text", displayPath: "note.txt", workspaceRelativePath: "note.txt", isOutsideWorkspace: false, absolutePath: path.join(directory, "note.txt") },
    { id: "image", kind: "image", source: "markdown-image", displayPath: "image.png", workspaceRelativePath: "image.png", isOutsideWorkspace: false, absolutePath: path.join(directory, "image.png") },
  ];
  await adapter.steerSessionTurn({ sessionId: input.session.id, expectedTurnId: "turn-1", userMessage: "修正して fake-steer-key", attachments });
  transport.steerResponse = Promise.resolve({ turnId: "wrong-turn" });
  await assert.rejects(adapter.steerSessionTurn({ sessionId: input.session.id, expectedTurnId: "turn-1", userMessage: "unaccepted-marker", attachments: [] }), /unexpected turn/);
  transport.steerResponse = null;
  for (let index = 0; index < 10; index += 1) await adapter.steerSessionTurn({ sessionId: input.session.id, expectedTurnId: "turn-1", userMessage: "large " + "x".repeat(PROVIDER_TEXT_PREVIEW_LIMIT * 2), attachments: [] });
  transport.push(completed([message("answer", "done")]));
  const result = await run;
  const raw = result.providerMetadata!.map((metadata) => metadata.payload) as Array<{ type: string; data: any }>;
  const accepted = raw.find((item) => item.type === "withmate.accepted_steer")!;
  assert.equal(accepted.data.turnId, "turn-1");
  assert.equal(accepted.data.threadId, "thread-1");
  assert.match(accepted.data.input[0].text, /修正して/);
  assert.ok(accepted.data.input[0].text.includes(attachments[0].absolutePath));
  assert.deepEqual(accepted.data.input[1], { type: "localImage", path: attachments[1].absolutePath });
  assert.ok(!JSON.stringify(result.providerMetadata).includes("fake-steer-key"));
  assert.ok(!JSON.stringify(result.providerMetadata).includes("unaccepted-marker"));
  assert.match(JSON.stringify(result.providerMetadata), /truncated/i);
  assert.ok(JSON.stringify(result.providerMetadata).length <= PROVIDER_RAW_ITEMS_JSON_LIMIT + 10000);
  const sent = transport.calls.find((call) => call.method === "turn/steer")!.params as any;
  assert.ok(sent.input[0].text.includes("fake-steer-key"));
  assert.equal(result.assistantText, "done");
}));
// @test-value v2
// kind = "contract"
// claim = "terminal control callbackが非同期未完了の間はCodex turnを成功にせず、解決は正常結果、拒否はpartial付きfailureとして返す"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Streaming Policy / Codex projection owner" }
// fault = "即時control通知のPromiseをdrainせず、未完了または後発拒否を正常終了にする"
// observable = "control受付後のrunSessionTurnのsettlementと解決後の本文、拒否時のProviderTurnError"
// observation_boundary = "public-boundary"
// scope = "Codex async terminal control consumer"
// lifecycle = "permanent"
// impact = "consumerの未完了・失敗を成功へ置換して終了後の状態と保存結果を誤認する"
// distinction = "既存slow live testは通常snapshotを止めるだけで、独立したcontrol callbackのPromiseを止めない"
// @end-test-value
it("Codexは非同期control callbackの完了と拒否をturn結果へ反映する", { timeout: 10_000 }, async () => workspace(async (directory) => {
  for (const outcome of ["resolve", "reject"] as const) {
    const transport = new FakeTransport();
    transport.events = [completed([message("answer", "retained answer")])];
    let resolveControl!: () => void;
    let rejectControl!: (error: Error) => void;
    const controlGate = new Promise<void>((resolve, reject) => { resolveControl = resolve; rejectControl = reject; });
    let sawControl!: () => void;
    const controlStarted = new Promise<void>((resolve) => { sawControl = resolve; });
    let held = false;
    const operation = new CodexAdapter(undefined, { createTransport: () => transport }).runSessionTurn(
      createCodexRunSessionTurnInput(directory), (state) => {
        if (!state.inputAvailable && !held) { held = true; sawControl(); return controlGate; }
      },
    );
    const settled = operation.then(() => "resolved", () => "rejected");
    let pendingGuard: NodeJS.Timeout | undefined;
    try {
      await controlStarted;
      const beforeRelease = await Promise.race([settled, new Promise<string>((resolve) => {
        pendingGuard = setTimeout(() => resolve("pending"), 250);
      })]);
      assert.equal(beforeRelease, "pending");
      if (outcome === "resolve") {
        resolveControl();
        assert.equal((await operation).assistantText, "retained answer");
      } else {
        rejectControl(new Error("control consumer failed"));
        await assert.rejects(operation, (error: unknown) => {
          assert.ok(error instanceof ProviderTurnError);
          assert.equal(error.canceled, false);
          assert.match(error.message, /control consumer failed/);
          assert.equal(error.partialResult.assistantText, "retained answer");
          return true;
        });
      }
    } finally {
      clearTimeout(pendingGuard);
      resolveControl();
      await settled;
    }
  }
}));

function notification(method: string, params: Record<string, unknown>): CodexProtocolEvent {
  if (method === "thread/tokenUsage/updated") {
    const usage = params.tokenUsage as Record<string, unknown>;
    params = { ...params, tokenUsage: { total: usage.last, ...usage } };
  }
  return { kind: "notification", method, params: { threadId: "thread-1", turnId: "turn-1", ...params } };
}
function message(id: string, text: string) { return { type: "agentMessage", id, text, phase: null }; }
function completed(items: unknown[] = [], status = "completed") { return notification("turn/completed", { turn: { id: "turn-1", status, items, error: status === "failed" ? { message: "provider failed" } : null } }); }

// @test-value v2
// kind = "contract"
// claim = "idle受信中の取消とtransport失敗は待機を解除し元の原因・取得済み本文とDetailsをpartialに保持する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: CodexAdapter / Error Handling" }
// fault = "idle waiterを解除しない、closeの汎用errorで元原因を隠す、またはpartial本文と操作結果を捨てる"
// observable = "ProviderTurnErrorのmessage・canceled・partial本文/操作Details、interrupt requestとtransport.closed"
// observation_boundary = "public-boundary"
// scope = "CodexAdapter idle event wait cancellation and transport failure"
// lifecycle = "permanent"
// impact = "取消不能なturnと切断時の取得済み結果消失を防ぐ"
// distinction = "既存terminal失敗とabort callback失敗はidle受信を単独で解除した元原因とDetailsを確認しない。短い2ケースを実Workerで処理する"
// @end-test-value
it("idle受信の取消とtransport失敗を元原因・partial付きで解除する", { timeout: 10_000 }, async () => workspace(async (directory) => {
  for (const mode of ["cancel", "transport"] as const) {
    const transport = new FakeTransport();
    transport.events = [
      notification("item/completed", { item: message("answer", "acquired body") }),
      notification("item/completed", { item: { type: "commandExecution", id: "command", command: "check", aggregatedOutput: "acquired details", exitCode: 0, status: "completed" } }),
    ];
    const controller = new AbortController();
    let bodySeen!: () => void;
    const projected = new Promise<void>(resolve => { bodySeen = resolve; });
    const operation = new CodexAdapter(undefined, { createTransport: () => transport }).runSessionTurn(
      { ...createCodexRunSessionTurnInput(directory), signal: controller.signal },
      (state, changes) => { if (state.assistantText && changes.steps.upserts.length) bodySeen(); },
    );
    void operation.catch(() => undefined);
    try {
      await projected;
      assert.ok(transport.waiter, "turn must be idle before failure/cancel");
      const cause = new Error(`idle ${mode} cause`);
      if (mode === "cancel") controller.abort(cause);
      else { transport.failure = cause; await transport.close(); }
      await assert.rejects(operation, error => {
        assert.ok(error instanceof ProviderTurnError);
        assert.equal(error.message, cause.message);
        assert.equal(error.canceled, mode === "cancel");
        assert.equal(error.partialResult.assistantText, "acquired body");
        assert.equal(error.partialResult.artifact?.operationTimeline?.find(item => item.type === "command_execution")?.details, "acquired details");
        return true;
      });
      assert.equal(transport.calls.some(call => call.method === "turn/interrupt"), mode === "cancel");
      assert.equal(transport.closed, true);
      assert.equal(transport.waiter, null);
    } finally { controller.abort(); await transport.close(); await operation.catch(() => undefined); }
  }
}));

// @test-value v2
// kind = "contract"
// claim = "idle受信中のprojection Worker失敗はclose経由で待機を解除しWorker原因を報告してWorkerを終了する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Codex projection owner / Error Handling" }
// fault = "Worker失敗後にnextEventが停止し続ける、close errorがWorker原因を上書きする、またはWorkerを解放しない"
// observable = "ProviderTurnErrorのmessage/canceled、transport.closed、実Worker terminate完了と終了threadId"
// observation_boundary = "public-boundary"
// scope = "CodexAdapter idle transport wait with pending projection Worker request"
// lifecycle = "permanent"
// impact = "Worker故障でturnが停止し取消・再実行できなくなることを防ぐ"
// distinction = "projection client単体ではadapterのidle受信解除と原因選択を通らない。実Workerの一要求を保持してerror eventを注入する短いケース"
// @end-test-value
it("idle受信中のWorker失敗を元原因で返してWorkerを解放する", { timeout: 10_000 }, async context => workspace(async (directory) => {
  const transport = new FakeTransport();
  transport.events = [notification("probe/fail", {})];
  let worker!: Worker;
  let dispatched!: () => void;
  const pending = new Promise<void>(resolve => { dispatched = resolve; });
  const postMessage = Worker.prototype.postMessage;
  context.mock.method(Worker.prototype, "postMessage", function (this: Worker, ...args: Parameters<Worker["postMessage"]>) {
    if ((args[0] as CodexProjectionRequest).command.type === "events") { worker = this; dispatched(); return; }
    return postMessage.apply(this, args);
  });
  let termination: Promise<number> | undefined;
  const terminate = Worker.prototype.terminate;
  context.mock.method(Worker.prototype, "terminate", function (this: Worker) {
    termination = terminate.call(this);
    return termination;
  });
  const operation = new CodexAdapter(undefined, { createTransport: () => transport }).runSessionTurn(createCodexRunSessionTurnInput(directory));
  void operation.catch(() => undefined);
  try {
    await pending;
    assert.ok(transport.waiter, "turn must be idle with a pending Worker request");
    worker.emit("error", new Error("injected Worker failure"));
    await assert.rejects(operation, error => {
      assert.ok(error instanceof ProviderTurnError);
      assert.equal(error.message, "Codex projection Worker failed.");
      assert.equal(error.canceled, false);
      return true;
    });
    assert.equal(transport.closed, true);
    assert.ok(termination);
    await termination;
    assert.equal(worker.threadId, -1);
  } finally { await transport.close(); await operation.catch(() => undefined); }
}));

// @test-value v2
// kind = "contract"
// claim = "EOF前に受信済みの本文・Details・completedは到着順に処理し、completedなしのEOFだけを失敗にする"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: CodexAdapter native terminal and EOF" }
// fault = "transport終端errorをFIFOより先に扱って受信済み結果を捨てる、またはEOFを成功にする"
// observable = "実stdio transportを使うadapterのcompleted結果と切断partial本文/Details・canceled、transport.state"
// observation_boundary = "public-boundary"
// scope = "CodexAdapter buffered native events before stdio EOF"
// lifecycle = "permanent"
// impact = "Providerが出力後に切断した場合の正常結果と取得済みpartialの消失を防ぐ"
// distinction = "FakeTransportのterminal testは実EOFとACK前FIFOを通らずtransport単体はWorkerの最終投影を確認しない。2つの短いローカルNode processのみ使う"
// @end-test-value
it("実stdioのEOF前completedと取得済み本文・Detailsを保持する", { timeout: 10_000 }, async () => workspace(async directory => {
  for (const terminal of [true, false]) {
    const fixture = String.raw`
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ id: request.id, result: { userAgent: 'fixture', codexHome: process.cwd(), platformFamily: 'fixture', platformOs: 'fixture' } });
  else if (request.method === 'thread/start') send({ id: request.id, result: { thread: { id: 'thread-1' } } });
  else if (request.method === 'turn/start') {
    send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'answer', text: 'before EOF' } } });
    send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'command', command: 'check', aggregatedOutput: 'EOF details', exitCode: 0, status: 'completed' } } });
    if (${terminal}) send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } } });
    send({ id: request.id, result: { turn: { id: 'turn-1' } } });
    process.stdout.end(() => process.exit(0));
  }
});
setInterval(() => {}, 1000);
`;
    let transport!: CodexAppServerTransport;
    const adapter = new CodexAdapter(undefined, { createTransport: options => {
      transport = new CodexAppServerTransport({ ...options, executable: process.execPath, arguments: ["--input-type=module", "-e", fixture] });
      return transport;
    } });
    const operation = adapter.runSessionTurn({ ...createCodexRunSessionTurnInput(directory), signal: AbortSignal.timeout(5_000) });
    let result: Awaited<typeof operation> | undefined;
    if (terminal) result = await operation;
    else await assert.rejects(operation, error => {
      assert.ok(error instanceof ProviderTurnError);
      assert.match(error.message, /stdout disconnected/);
      assert.equal(error.canceled, false);
      result = error.partialResult;
      return true;
    });
    assert.ok(result);
    assert.equal(result.assistantText, "before EOF");
    assert.equal(result.artifact?.operationTimeline?.find(item => item.type === "command_execution")?.details, "EOF details");
    assert.equal(transport.state, "closed");
  }
}));


// @test-value v2
// kind = "contract"
// claim = "Codexの一時errorはlive timerを待たず秘匿済みprogressで通知され、有効itemの回復で解除される"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Streaming Policy / Codex projection owner" }
// fault = "errorをcoalesced snapshotだけへ渡して次itemの回復で通知前に失う、またはcontrolへsecretを残す"
// observable = "live timer停止中の実adapter progressのerror列、変更step列、回復本文と正常結果"
// observation_boundary = "public-boundary"
// scope = "CodexAdapter transient error control through shared projection Worker"
// lifecycle = "permanent"
// impact = "再接続中の一時失敗を利用者が確認できず原因把握できないこととsecret漏洩を防ぐ"
// distinction = "state単体のerror解除testはWorker応答とadapterの33ms coalescing間の通知消失を観測しない"
// @end-test-value
it("Codexはlive timer前に一時errorを通知して回復時に解除する", async (context) => workspace(async (directory) => {
  const transport = new FakeTransport();
  const secret = "synthetic-transient-error-key";
  transport.events = [
    notification("error", { threadId: "other", error: { message: "outside scope" } }),
    notification("error", { error: { message: `retry ${secret}` }, willRetry: true }),
    notification("item/completed", { item: message("answer", "recovered") }),
    completed(),
  ];
  const input = createCodexRunSessionTurnInput(directory);
  input.appSettings.codingProviderSettings.codex.apiKey = secret;
  const progress: Array<{ error: string; assistant: string; upserts: number }> = [];
  try {
    const result = await new CodexAdapter(undefined, { createTransport: () => transport }).runSessionTurn(input, (state, changes) => {
      if (progress.length === 0) context.mock.timers.enable({ apis: ["setTimeout"] });
      progress.push({ error: state.errorMessage, assistant: state.assistantText, upserts: changes?.steps.upserts.length ?? 0 });
    });
    const errorIndex = progress.findIndex((frame) => frame.error === "retry [WITHMATE_BINDING_REFERENCE_REDACTED]");
    assert.ok(errorIndex >= 0);
    assert.equal(progress[errorIndex].assistant, "");
    assert.equal(progress[errorIndex].upserts, 0);
    assert.ok(progress.slice(errorIndex + 1).some((frame) => frame.error === ""));
    assert.ok(progress.every((frame) => !frame.error.includes(secret) && frame.error !== "outside scope"));
    assert.equal(progress.at(-1)?.assistant, "recovered");
    assert.equal(progress.at(-1)?.error, "");
    assert.equal(result.assistantText, "recovered");
  } finally { context.mock.timers.reset(); }
}));

// @test-value v2
// kind = "contract"
// claim = "遅いlive consumer中も承認が進みterminal／取消は入力を直ちに閉じfinal／partial本文をflushする"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Codex projection owner / Streaming Policy" }
// fault = "live待ちを承認の前提にする、terminal／取消後も入力を許す、最後の本文を落とす"
// observable = "live handler停止中の承認応答、停止解除前のinputAvailable、最終結果または取消partial本文"
// observation_boundary = "public-boundary"
// scope = "CodexAdapter independent live, 履歴 and control delivery"
// lifecycle = "permanent"
// impact = "描画の遅いWindowが保存・承認・取消を止めず取得済み応答を維持する"
// distinction = "Worker client単体とRuntimeのslow writer testでは実adapterのlive timerと承認・取消の並行経路を通らない"
// @end-test-value
it("live consumerが遅くても承認・terminalと取消を独立させる", { timeout: 10_000 }, async () => workspace(async (directory) => {
  for (const outcome of ["complete", "cancel"] as const) {
    const transport = new FakeTransport();
    transport.events = [notification("item/started", { item: message("answer", "") }), notification("item/agentMessage/delta", { itemId: "answer", delta: "i" })];
    let releaseLive!: () => void;
    const liveGate = new Promise<void>(resolve => { releaseLive = resolve; });
    let sawLive!: () => void;
    const firstLive = new Promise<void>(resolve => { sawLive = resolve; });
    let sawApproval!: () => void;
    const approved = new Promise<void>(resolve => { sawApproval = resolve; });
    let sawClosedInput!: () => void;
    const closedInput = new Promise<void>(resolve => { sawClosedInput = resolve; });
    let liveCount = 0;
    let heldLive = false;
    const controller = new AbortController();
    const input = { ...createCodexRunSessionTurnInput(directory), signal: controller.signal, onApprovalRequest: () => "approve" as const };
    const adapter = new CodexAdapter(undefined, { createTransport: () => transport });
    const operation = adapter.runSessionTurn(input, async (state, changes) => {

      if (!state.inputAvailable) sawClosedInput();
      {
        liveCount += 1;
        if (state.assistantText === "i" && !heldLive) { heldLive = true; sawLive(); await liveGate; }
      }
    });
    void operation.catch(() => undefined);
    try {
      await firstLive;
      for (let index = 0; index < 200; index += 1) transport.push(notification("item/agentMessage/delta", { itemId: "answer", delta: "x" }));
      transport.push({ kind: "serverRequest", id: 1, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", command: "run" },
        respond: async result => { assert.deepEqual(result, { decision: "accept" }); sawApproval(); }, reject: async () => { throw new Error("Approval was rejected"); } });
      await approved;
      assert.equal(heldLive, true);
      if (outcome === "complete") transport.push(completed());
      else controller.abort();
      await closedInput;
      releaseLive();
      const expected = `i${"x".repeat(200)}`;
      if (outcome === "complete") assert.equal((await operation).assistantText, expected);
      else await assert.rejects(operation, error => {
        assert.ok(error instanceof ProviderTurnError);
        assert.equal(error.canceled, true);
        assert.equal(error.partialResult.assistantText, expected);
        return true;
      });
      assert.ok(liveCount <= 4);
    } finally { releaseLive(); controller.abort(); await operation.catch(() => undefined); }
  }
}));
async function workspace<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-native-"));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
// @test-value v2
// kind = "contract"
// claim = "最終snapshotのconsumer rejectionを成功へ変換せず取得済み本文とcleanupを維持する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Streaming Policy / Codex projection owner" }
// fault = "timer前に完了したturnのfinal progress rejectionをwarnだけに変換する"
// observable = "本文付きcallbackの回数、ProviderTurnError message・partial本文・canceled、transport.closed"
// observation_boundary = "public-boundary"
// scope = "CodexAdapter final-only progress failure"
// lifecycle = "permanent"
// impact = "live表示consumerが失敗したturnを正常完了と誤認させず取得済み応答を保持する"
// distinction = "通常progress失敗testではcoalescing後のfinallyだけで届く本文consumer失敗を検出できない;短いfake transportで確認する"
// @end-test-value
it("最終snapshotのconsumer rejectionをpartial付き失敗へ伝播する", async (context) => workspace(async (directory) => {
  const transport = new FakeTransport();
  transport.events = [completed([message("answer", "final acquired body")])];
  let bodyCallbacks = 0;
  try {
    const operation = new CodexAdapter(undefined, { createTransport: () => transport }).runSessionTurn(createCodexRunSessionTurnInput(directory), state => {
      if (state.inputAvailable) context.mock.timers.enable({ apis: ["setTimeout"] });
      if (state.assistantText) { bodyCallbacks += 1; return Promise.reject(new Error("final consumer failure")); }
    });
    await assert.rejects(operation, error => {
      assert.ok(error instanceof ProviderTurnError);
      assert.equal(error.message, "final consumer failure");
      assert.equal(error.partialResult.assistantText, "final acquired body");
      assert.equal(error.canceled, false);
      return true;
    });
    assert.equal(bodyCallbacks, 1);
    assert.equal(transport.closed, true);
  } finally { context.mock.timers.reset(); }
}));

// @test-value v2
// kind = "contract"
// claim = "terminal controlの遅延consumer rejectionもturn結果へ伝播しnative終端で追加入力は先に閉じる"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Streaming Policy / Codex projection owner" }
// fault = "final snapshot配送後に受けたterminal control rejectionを正常turn結果へ変換する"
// observable = "final snapshot後のsteer拒否とcontrol reject後のProviderTurnError message・partial本文"
// observation_boundary = "public-boundary"
// scope = "CodexAdapter delayed terminal control consumer"
// lifecycle = "permanent"
// impact = "制御consumer失敗を正常完了と誤認せず入力受付と実行結果を一致させる"
// distinction = "同期callback失敗とslow live testではfinal配送後にrejectするcontrol Promiseを検知できない;明示gateのfake transportで確認する"
// @end-test-value
it("final配送後のterminal control rejectionをpartial付き失敗へ伝播する", async () => workspace(async (directory) => {
  const transport = new FakeTransport();
  transport.events = [completed([message("answer", "terminal acquired body")])];
  let rejectControl!: (error: Error) => void;
  const control = new Promise<void>((_resolve, reject) => { rejectControl = reject; });
  let sawFinal!: () => void;
  const finalSeen = new Promise<void>(resolve => { sawFinal = resolve; });
  let heldControl = false;
  let settled = false;
  const input = createCodexRunSessionTurnInput(directory);
  const adapter = new CodexAdapter(undefined, { createTransport: () => transport });
  const operation = adapter.runSessionTurn(input, state => {
    if (!state.inputAvailable && !heldControl) { heldControl = true; return control; }
    if (state.assistantText === "terminal acquired body") sawFinal();
  });
  void operation.then(() => { settled = true; }, () => { settled = true; });
  try {
    await finalSeen;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    await assert.rejects(adapter.steerSessionTurn({ sessionId: input.session.id, expectedTurnId: "turn-1", userMessage: "late", attachments: [] }), /no longer accepting/);
    rejectControl(new Error("delayed control failure"));
    await assert.rejects(operation, error => {
      assert.ok(error instanceof ProviderTurnError);
      assert.equal(error.message, "delayed control failure");
      assert.equal(error.partialResult.assistantText, "terminal acquired body");
      return true;
    });
    assert.equal(transport.closed, true);
  } finally { rejectControl(new Error("test cleanup")); await operation.catch(() => undefined); }
}));

// @test-value v2
// kind = "contract"
// claim = "AbortSignalからのcontrol同期throwを未捕捉例外にせず取消partial結果へ伝播する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Streaming Policy / Error Handling" }
// fault = "Promise.resolveの引数評価で同期callback例外がabort listenerから漏れる"
// observable = "abort後のProviderTurnError message・canceled・partial本文とtransport.closed"
// observation_boundary = "public-boundary"
// scope = "CodexAdapter AbortSignal control callback"
// lifecycle = "permanent"
// impact = "取消操作でMainの未捕捉例外を発生させず取得済み応答と取消状態を保持する"
// distinction = "非同期rejectionや通常通知からのthrowではAbortSignalの同期listener境界を通らない;fake transportの本文配送後に取消する"
// @end-test-value
it("abort controlの同期throwを取消partial結果へ閉じ込める", async () => workspace(async (directory) => {
  const transport = new FakeTransport();
  transport.events = [notification("item/completed", { item: message("answer", "cancel acquired body") })];
  const controller = new AbortController();
  let sawBody!: () => void;
  const bodySeen = new Promise<void>(resolve => { sawBody = resolve; });
  let threw = false;
  const operation = new CodexAdapter(undefined, { createTransport: () => transport }).runSessionTurn({ ...createCodexRunSessionTurnInput(directory), signal: controller.signal }, state => {
    if (state.assistantText) sawBody();
    if (!state.inputAvailable && !threw) { threw = true; throw new Error("abort control sync failure"); }
  });
  void operation.catch(() => undefined);
  await bodySeen;
  controller.abort();
  await assert.rejects(operation, error => {
    assert.ok(error instanceof ProviderTurnError);
    assert.equal(error.message, "abort control sync failure");
    assert.equal(error.canceled, true);
    assert.equal(error.partialResult.assistantText, "cancel acquired body");
    return true;
  });
  assert.equal(transport.closed, true);
}));
// @test-value v2
// kind = "invariant"
// claim = "native itemの到着順とdeltaからassistant本文を確定する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "completed itemを再連結して本文を重複させる"
// observable = "stream中と確定後のassistant本文"
// observation_boundary = "component-behavior"
// scope = "codex-native-projection"
// lifecycle = "permanent"
// impact = "Codex実行の会話継続、履歴または権限が失われる"
// distinction = "型検査では検出できないnative通知と実行結果の対応を検証する"
// @end-test-value
it("native agentMessageは到着順、deltaとcompletedの置換で連結する", () => {
  const state = createCodexTurnStreamState("thread-1");
  applyCodexTurnEvent(state, notification("turn/started", { turn: { id: "turn-1" } }));
  applyCodexTurnEvent(state, notification("item/started", { item: message("first", "") }));
  applyCodexTurnEvent(state, notification("item/agentMessage/delta", { itemId: "first", delta: "途中" }));
  assert.equal(getLiveCodexAssistantText(state), "途中");
  applyCodexTurnEvent(state, notification("item/completed", { item: message("first", "確定") }));
  applyCodexTurnEvent(state, notification("item/completed", { item: message("second", "次") }));
  applyCodexTurnEvent(state, completed([message("first", "確定"), message("second", "次")]));
  assert.equal(getLiveCodexAssistantText(state), "確定\n\n次");
});
// @test-value v2
// kind = "invariant"
// claim = "異なるthreadとturnの通知は現在の結果を汚染しない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "別turn本文とusageを現在turnへ投影する"
// observable = "現在turnのassistant本文とusage"
// observation_boundary = "component-behavior"
// scope = "codex-native-projection"
// lifecycle = "permanent"
// impact = "Codex実行の会話継続、履歴または権限が失われる"
// distinction = "型検査では検出できないnative通知と実行結果の対応を検証する"
// @end-test-value
it("native通知のthreadとturn scopeを保持する", () => {
  const state = createCodexTurnStreamState("thread-1");
  state.turnId = "turn-1";
  applyCodexTurnEvent(state, notification("item/completed", { threadId: "other", item: message("bad", "wrong") }));
  applyCodexTurnEvent(state, notification("item/completed", { turnId: "other", item: message("bad", "wrong") }));
  applyCodexTurnEvent(state, notification("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 2, totalTokens: 13, reasoningOutputTokens: 1 } } }));
  const foreignUsage = { inputTokens: 900, outputTokens: 800, cachedInputTokens: 700, totalTokens: 1700, reasoningOutputTokens: 600 };
  applyCodexTurnEvent(state, notification("thread/tokenUsage/updated", { threadId: "other", tokenUsage: { total: foreignUsage, last: foreignUsage } }));
  applyCodexTurnEvent(state, notification("thread/tokenUsage/updated", { turnId: "other", tokenUsage: { total: foreignUsage, last: foreignUsage } }));
  assert.equal(getLiveCodexAssistantText(state), "");
  assert.deepEqual(state.usage, { inputTokens: 10, outputTokens: 3, cachedInputTokens: 2, totalTokens: 13, reasoningOutputTokens: 1 });
});
// @test-value v2
// kind = "invariant"
// claim = "retry error後の同scope有効item activityでlive diagnosticを解除し別scopeや未知deltaでは解除せずterminal failureを保持する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#streaming-policy" }
// fault = "復帰したassistant生成中も古い再接続errorをlive alertへ出す、または別scope activityでerrorを隠す"
// observable = "terminal前のassistantText streamErrorMessage turnCompletedとfailed terminal後のerror"
// observation_boundary = "component-behavior"
// scope = "codex-native-projection"
// lifecycle = "permanent"
// impact = "回答生成が正常再開した現在状態を失敗と誤表示する"
// distinction = "確定結果と型検査では途中のdiagnostic解除とscope guardを検出できない"
// @end-test-value
it("同scopeのitem再開だけでretry diagnosticを解除しterminal failureを保持する", () => {
  for (const method of ["item/started", "item/completed", "item/agentMessage/delta"]) {
    const state = createCodexTurnStreamState("thread-1");
    state.turnId = "turn-1";
    applyCodexTurnEvent(state, notification("item/started", { item: message("answer", "") }));
    applyCodexTurnEvent(state, notification("error", { error: { message: "Reconnecting transient failure" }, willRetry: true }));
    const recovery = method === "item/agentMessage/delta"
      ? { itemId: "answer", delta: "Recovered response" }
      : { item: message("answer", "Recovered response") };
    for (const foreignScope of [{ threadId: "other" }, { turnId: "other" }]) {
      applyCodexTurnEvent(state, notification(method, { ...recovery, ...foreignScope }));
      assert.equal(state.streamErrorMessage, "Reconnecting transient failure");
      assert.equal(getLiveCodexAssistantText(state), "");
    }
    applyCodexTurnEvent(state, notification("item/agentMessage/delta", { itemId: "missing", delta: "not accepted" }));
    assert.equal(state.streamErrorMessage, "Reconnecting transient failure");
    applyCodexTurnEvent(state, notification(method, recovery));
    assert.deepEqual({ assistantText: getLiveCodexAssistantText(state), errorMessage: state.streamErrorMessage, terminal: state.turnCompleted }, {
      assistantText: "Recovered response", errorMessage: "", terminal: false,
    });
    applyCodexTurnEvent(state, completed([], "failed"));
    assert.equal(state.streamErrorMessage, "provider failed");
    assert.equal(state.terminalStatus, "failed");
    assert.equal(state.turnCompleted, true);
    applyCodexTurnEvent(state, notification(method, recovery));
    assert.equal(state.streamErrorMessage, "provider failed");
  }
});
// @test-value v2
// kind = "invariant"
// claim = "保存threadIdをexcludeTurns付きで明示resumeし、新規作成にはresume専用指定を送らず、失敗時も新規threadへ切替せず送信時modelとmax/ultraを含むdepth・権限設定をnative requestへ送る"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "不要な過去turn返送を要求してresume応答を肥大化させる、新規作成へresume専用指定を送る、保存sessionを新規threadへ置換する、sandbox rootsを落とす、または送信時model/depthを保存値や上限値へ置換する"
// observable = "thread/start・thread/resumeとturn/startの送信params、resume失敗後のrequestとpartial threadId"
// observation_boundary = "component-behavior"
// scope = "codex-adapter"
// lifecycle = "permanent"
// impact = "長い履歴の不要な一括返送による有限受信上限超過で再開が失敗する、または会話継続・履歴・権限が失われる"
// distinction = "型検査やtransport単体では検出できないadapterの新規/再開request選択とparamsを、既存の軽量mockで検証する"
// @end-test-value
it("foregroundは保存thread resumeとnative設定、履歴結果を維持する", async () => workspace(async (directory) => {
  const fresh = new FakeTransport();
  fresh.events = [completed([message("answer", "fresh")])];
  const freshResult = await new CodexAdapter(undefined, { createTransport: () => fresh }).runSessionTurn(createCodexRunSessionTurnInput(directory));
  assert.equal(fresh.calls[0].method, "thread/start");
  assert.equal(Object.hasOwn(fresh.calls[0].params as object, "excludeTurns"), false);
  assert.equal(Object.hasOwn(fresh.calls[0].params as object, "threadId"), false);
  assert.equal(freshResult.threadId, "thread-1");
  assert.equal(freshResult.assistantText, "fresh");
  assert.equal(fresh.closed, true);
  const transport = new FakeTransport();
  transport.events = [notification("item/completed", { item: message("answer", "done") }), completed([message("answer", "done")])];
  const input = createCodexRunSessionTurnInput(directory);
  input.session.threadId = "thread-1";
  input.session.allowedAdditionalDirectories = [path.join(directory, "..", "additional")];
  input.executionOptions = { ...input.executionOptions, codexSandboxMode: "workspace-write-network", codexSpeed: "fast", codexReviewer: "auto-review" };
  const adapter = new CodexAdapter(undefined, { createTransport: () => transport });
  const result = await adapter.runSessionTurn(input);
  assert.equal(transport.calls[0].method, "thread/resume");
  const resume = transport.calls[0].params as Record<string, unknown>;
  assert.equal(resume.threadId, "thread-1");
  assert.equal(resume.excludeTurns, true);
  const start = transport.calls.find((call) => call.method === "turn/start")!.params as Record<string, any>;
  assert.equal(start.serviceTier, "fast");
  assert.equal(start.approvalsReviewer, "auto_review");
  assert.equal(start.sandboxPolicy.networkAccess, true);
  assert.deepEqual(start.sandboxPolicy.writableRoots, [directory, path.resolve(directory, "..", "additional")]);
  assert.equal(start.input[0].text, adapter.composePrompt(input).logicalPrompt.composedText);
  assert.equal(result.assistantText, "done");
  assert.equal(result.threadId, "thread-1");
  assert.equal(transport.closed, true);
  for (const reasoningEffort of ["max", "ultra"] as const) {
    const updated = new FakeTransport();
    updated.events = [completed([message("answer", "updated")])];
    input.executionOptions = { ...input.executionOptions, model: "gpt-5.6-sol", reasoningEffort };
    await new CodexAdapter(undefined, { createTransport: () => updated }).runSessionTurn(input);
    const threadParams = updated.calls.find((call) => call.method === "thread/resume")!.params as Record<string, any>;
    const turnParams = updated.calls.find((call) => call.method === "turn/start")!.params as Record<string, any>;
    assert.equal(threadParams.model, "gpt-5.6-sol");
    assert.equal(threadParams.config.model_reasoning_effort, reasoningEffort);
    assert.equal(turnParams.model, "gpt-5.6-sol");
    assert.equal(turnParams.effort, reasoningEffort);
    assert.equal(updated.closed, true);
  }
  class ResumeFailureTransport extends FakeTransport {
    override async request<T>(method: string, params?: unknown): Promise<T> {
      if (method === "thread/resume") {
        this.calls.push({ method, params });
        throw new CodexAppServerRpcError(-32001, "saved thread unavailable");
      }
      return super.request<T>(method, params);
    }
  }
  const failed = new ResumeFailureTransport();
  await assert.rejects(new CodexAdapter(undefined, { createTransport: () => failed }).runSessionTurn(input), (error: unknown) => {
    assert.ok(error instanceof ProviderTurnError);
    assert.equal(error.partialResult.threadId, "thread-1");
    return true;
  });
  assert.deepEqual(failed.calls.map((call) => call.method), ["thread/resume"]);
  assert.equal(failed.closed, true);
}));

describe("workspace snapshot targeted capture", () => {
  it("指定された候補ファイルだけを snapshot に含める", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-snapshot-targeted-"));

    try {
      await mkdir(path.join(workspacePath, "src"), { recursive: true });
      await writeFile(path.join(workspacePath, "src", "changed.ts"), "changed\n", "utf8");
      await writeFile(path.join(workspacePath, "src", "unchanged.ts"), "unchanged\n", "utf8");

      const result = await captureWorkspaceSnapshotPaths(workspacePath, [
        "src/changed.ts",
        "src/deleted.ts",
      ]);

      assert.deepEqual(Array.from(result.snapshot.keys()), ["src/changed.ts"]);
      assert.equal(result.snapshot.get("src/changed.ts"), "changed\n");
      assert.equal(result.stats.capturedFiles, 1);
      assert.equal(result.stats.skippedBinaryOrOversizeFiles, 0);
      assert.equal(result.stats.skippedByLimitFiles, 0);
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("既存ファイルの本文更新は index の incremental refresh で反映する", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-snapshot-index-edit-"));

    try {
      await mkdir(path.join(workspacePath, "src"), { recursive: true });
      const filePath = path.join(workspacePath, "src", "changed.ts");
      await writeFile(filePath, "before\n", "utf8");

      const index = await createWorkspaceSnapshotIndex(workspacePath);
      await writeFile(filePath, "after\n", "utf8");

      const refreshed = await refreshWorkspaceSnapshotIndex(index);

      assert.equal(refreshed.usedFullRebuild, false);
      assert.equal(refreshed.reason, "file-refresh");
      assert.equal(refreshed.snapshot.get("src/changed.ts"), "after\n");
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("directory 構造が変わった場合は full rebuild に戻す", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-snapshot-index-structure-"));

    try {
      await mkdir(path.join(workspacePath, "src"), { recursive: true });
      await writeFile(path.join(workspacePath, "src", "existing.ts"), "existing\n", "utf8");

      const index = await createWorkspaceSnapshotIndex(workspacePath);
      await writeFile(path.join(workspacePath, "src", "added.ts"), "added\n", "utf8");
      const srcDirectoryPath = path.resolve(path.join(workspacePath, "src"));
      const realSrcStat = await stat(srcDirectoryPath);

      _setWalkDirectoryStatOverrideForTesting(async (directoryPath) => {
        if (path.resolve(directoryPath) === srcDirectoryPath) {
          return {
            ...realSrcStat,
            mtimeMs: realSrcStat.mtimeMs + 1_000,
          } as Stats;
        }
        return stat(directoryPath);
      });

      const refreshed = await refreshWorkspaceSnapshotIndex(index);

      assert.equal(refreshed.usedFullRebuild, true);
      assert.equal(refreshed.reason, "structure-change");
      assert.equal(refreshed.snapshot.get("src/added.ts"), "added\n");
    } finally {
      _setWalkDirectoryStatOverrideForTesting(null);
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("refresh 後の file count が limit と一致する場合は incremental refresh を維持する", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-snapshot-index-limit-"));

    try {
      await writeFile(path.join(workspacePath, "only.txt"), "only\n", "utf8");

      const index = await createWorkspaceSnapshotIndex(workspacePath, { maxFileCount: 1 });
      const refreshed = await refreshWorkspaceSnapshotIndex(index);

      assert.equal(refreshed.usedFullRebuild, false);
      assert.equal(refreshed.reason, "unchanged");
      assert.equal(refreshed.stats.capturedFiles, 1);
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("refresh 後に file count limit を超過した場合は full rebuild に戻す", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-snapshot-index-limit-exceeded-"));

    try {
      await writeFile(path.join(workspacePath, "one.txt"), "one\n", "utf8");
      await writeFile(path.join(workspacePath, "two.txt"), "two\n", "utf8");

      const index = await createWorkspaceSnapshotIndex(workspacePath, { maxFileCount: 2 });
      await writeFile(path.join(workspacePath, "three.txt"), "three\n", "utf8");

      const refreshed = await refreshWorkspaceSnapshotIndex(index, {
        candidatePaths: [path.join(workspacePath, "three.txt")],
        trustCandidatePaths: true,
      });

      assert.equal(refreshed.usedFullRebuild, true);
      assert.equal(refreshed.reason, "limit");
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});
// @test-value v2
// kind = "invariant"
// claim = "retry通知後もterminal statusで成否を決めpartialを保持し、You've hit your usage limit.・purchase more credits・try again atの3句が揃う失敗だけをusage_limit、1句でも欠ければunknownとする"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md; accepted contract: Codex usage_limit classification requires usage-limit, credits and retry-time markers" }
// fault = "retry中のerrorで成功terminalを失敗にする、partialを捨てる、取消を誤分類する、またはusage limitのreasonを欠落・誤検出する"
// observable = "completed結果とProviderTurnErrorのpartialResult canceled message reason"
// observation_boundary = "component-behavior"
// scope = "codex-adapter"
// lifecycle = "permanent"
// impact = "Codex実行の会話継続、履歴または権限が失われる"
// distinction = "型検査では検出できないnative通知と実行結果の対応を検証する"
// @end-test-value
it("retry通知後はterminalで成否を決め切断と失敗時のpartialを回収する", async () => workspace(async (directory) => {
  for (const status of ["completed", "disconnected", "failed", "interrupted"]) {
    const transport = new FakeTransport();
    transport.events = [notification("error", { error: { message: "Reconnecting transient failure" }, willRetry: true }), notification("item/completed", { item: message("answer", "partial") }), notification("item/completed", { item: { type: "commandExecution", id: "command", command: "echo done", aggregatedOutput: "done", exitCode: 0, status: "completed" } })];
    if (status === "disconnected") transport.failure = new Error("disconnected");
    else transport.events.push(completed([], status));
    const run = new CodexAdapter(undefined, { createTransport: () => transport }).runSessionTurn(createCodexRunSessionTurnInput(directory));
    if (status === "completed") {
      const result = await run;
      assert.equal(result.assistantText, "partial");
      assert.ok(result.artifact!.operationTimeline!.some((operation) => operation.type === "command_execution"));
    } else {
      await assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof ProviderTurnError);
        assert.equal(error.partialResult.assistantText, "partial");
        assert.ok(error.partialResult.artifact!.operationTimeline!.some((operation) => operation.type === "command_execution"));
        assert.equal(error.canceled, status === "interrupted");
        if (status === "failed") assert.equal(error.message, "provider failed");
        return true;
      });
    }
    assert.equal(transport.closed, true);
  }
  const usageMarkers = ["You've hit your usage limit.", "Purchase more credits", "Try again at 10:00"];
  for (const missingMarker of [-1, 0, 1, 2]) {
    const terminalMessage = usageMarkers.filter((_marker, index) => index !== missingMarker).join(" ");
    const transport = new FakeTransport();
    transport.events = [notification("turn/completed", { turn: { id: "turn-1", status: "failed", items: [], error: { message: terminalMessage } } })];
    await assert.rejects(new CodexAdapter(undefined, { createTransport: () => transport }).runSessionTurn(createCodexRunSessionTurnInput(directory)), (error: unknown) => {
      assert.ok(error instanceof ProviderTurnError);
      assert.equal(error.canceled, false);
      assert.equal(error.message, terminalMessage);
      assert.equal(error.reason, missingMarker === -1 ? "usage_limit" : "unknown");
      return true;
    });
    assert.equal(transport.closed, true);
  }
}));
// @test-value v2
// kind = "invariant"
// claim = "背景評価はcoding権限設定に関係なくread-only neverとschemaを使う"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "Sessionの書込権限がbackgroundへ漏れるか既定tierを変更する"
// observable = "背景thread/startとturn/startの権限、schema、result"
// observation_boundary = "component-behavior"
// scope = "codex-adapter"
// lifecycle = "permanent"
// impact = "Codex実行の会話継続、履歴または権限が失われる"
// distinction = "型検査では検出できないnative通知と実行結果の対応を検証する"
// @end-test-value
it("background structured promptはread-only never Standardを固定する", async () => {
  const transport = new FakeTransport();
  transport.events = [completed([message("answer", '{"answer":"ok"}')])];
  const adapter = new CodexAdapter(undefined, { createTransport: () => transport });
  const input = createCodexBackgroundPromptInput({ codexSandboxMode: "danger-full-access", approvalMode: "on-request" });
  const result = await adapter.runBackgroundStructuredPrompt<{ answer: string }>(input);
  const start = transport.calls.find((call) => call.method === "turn/start")!.params as Record<string, any>;
  assert.equal(transport.calls[0].method, "thread/start");
  const thread = transport.calls[0].params as Record<string, unknown>;
  assert.equal(thread.sandbox, "read-only");
  assert.equal(thread.approvalPolicy, "never");
  assert.deepEqual(start.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.equal(start.approvalPolicy, "never");
  assert.equal(start.serviceTier, "default");
  assert.deepEqual(start.outputSchema, input.prompt.outputSchema);
  assert.deepEqual(result.output, { answer: "ok" });
  assert.equal(transport.closed, true);
});
// @test-value v2
// kind = "contract"
// claim = "背景実行のtimeoutと呼出元取消をtransport起動のsignalへ伝播し待機を失敗として終了してcleanupする"
// oracle = { type = "contract", ref = "src-electron/providers/provider-runtime.ts: RunBackgroundStructuredPromptInput timeoutMs/signal" }
// fault = "timeoutか呼出元signalをadapterが落としtransport起動を無期限に待つ"
// observable = "signal待機中の起動から返るTimeoutError/AbortErrorとtransport.closed"
// observation_boundary = "component-behavior"
// scope = "codex-background-start-cancellation"
// lifecycle = "permanent"
// impact = "背景の構造化処理が期限超過や取消後も残留する"
// distinction = "RPC単体のtimeout testではbackground adapterのsignal合成と起動への伝播を検出できない"
// @end-test-value
it("backgroundのtimeoutと取消をtransport起動へ伝播する", async () => {
  for (const mode of ["timeout", "cancel"] as const) {
    const caller = new AbortController();
    class WaitingStartTransport extends FakeTransport {
      override async start(signal?: AbortSignal) {
        assert.ok(signal);
        signal.throwIfAborted();
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => rejectStart(signal.reason);
        let rejectStart!: (reason: unknown) => void;
        try {
          await new Promise<void>((_resolve, reject) => {
            rejectStart = reject;
            watchdog = setTimeout(() => reject(new Error("Background signal did not abort")), 1_000);
            signal.addEventListener("abort", onAbort, { once: true });
            if (mode === "cancel") queueMicrotask(() => caller.abort());
          });
        } finally {
          clearTimeout(watchdog);
          signal.removeEventListener("abort", onAbort);
        }
      }
    }
    const transport = new WaitingStartTransport();
    const input = createCodexBackgroundPromptInput({ timeoutMs: mode === "timeout" ? 20 : 10_000, signal: caller.signal });
    await assert.rejects(new CodexAdapter(undefined, { createTransport: () => transport }).runBackgroundStructuredPrompt(input), { name: mode === "timeout" ? "TimeoutError" : "AbortError" });
    assert.equal(transport.closed, true);
    assert.deepEqual(transport.calls, []);
  }
});
// @test-value v2
// kind = "invariant"
// claim = "背景の対話requestをUIへ転送せず明示拒否する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "背景tool requestが対話または書込承認へ流れる"
// observable = "JSON-RPC reject response"
// observation_boundary = "component-behavior"
// scope = "codex-adapter"
// lifecycle = "permanent"
// impact = "Codex実行の会話継続、履歴または権限が失われる"
// distinction = "型検査では検出できないnative通知と実行結果の対応を検証する"
// @end-test-value
it("backgroundではinteractive server requestを拒否する", async () => {
  const transport = new FakeTransport();
  const rejections: unknown[] = [];
  transport.events = [{ kind: "serverRequest", id: 1, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1" }, respond: async () => { throw new Error("must not approve"); }, reject: async (error) => { rejections.push(error); } }, completed([message("answer", "{}")])];
  await new CodexAdapter(undefined, { createTransport: () => transport }).runBackgroundStructuredPrompt(createCodexBackgroundPromptInput());
  assert.deepEqual(rejections, [{ code: -32601, message: "Interactive requests are disabled for structured background execution" }]);
});
// @test-value v2
// kind = "invariant"
// claim = "active turn限定でsteerしterminal後は同じIDも送信しない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "terminal後の入力を次turnとして実行する"
// observable = "turn/steer request数とterminal後の拒否"
// observation_boundary = "component-behavior"
// scope = "codex-adapter"
// lifecycle = "permanent"
// impact = "Codex実行の会話継続、履歴または権限が失われる"
// distinction = "型検査では検出できないnative通知と実行結果の対応を検証する"
// @end-test-value
it("steerはexpectedTurnIdを送信しterminalで入口を閉じる", async () => workspace(async (directory) => {
  const transport = new FakeTransport();
  const adapter = new CodexAdapter(undefined, { createTransport: () => transport });
  const input = createCodexRunSessionTurnInput(directory);
  let active!: () => void;
  const ready = new Promise<void>((resolve) => { active = resolve; });
  const run = adapter.runSessionTurn(input, (state) => { if (state.inputAvailable) active(); });
  await ready;
  await assert.rejects(adapter.steerSessionTurn({ sessionId: input.session.id, expectedTurnId: "old", userMessage: "wrong", attachments: [] }));
  assert.deepEqual(await adapter.steerSessionTurn({ sessionId: input.session.id, expectedTurnId: "turn-1", userMessage: "追加", attachments: [] }), { turnId: "turn-1" });
  const request = transport.calls.find((call) => call.method === "turn/steer")!.params as Record<string, any>;
  assert.equal(request.expectedTurnId, "turn-1");
  assert.equal(request.input[0].text, "追加");
  transport.push(completed([message("answer", "done")]));
  await run;
  await assert.rejects(adapter.steerSessionTurn({ sessionId: input.session.id, expectedTurnId: "turn-1", userMessage: "late", attachments: [] }));
  assert.equal(transport.calls.filter((call) => call.method === "turn/steer").length, 1);
}));

// @test-value v2
// kind = "invariant"
// claim = "異なるforeground ownerとbackgroundのbinding・Memory owner envを分離し親env不変でlive artifact error logからsecretを除去する"
// oracle = { type = "contract", ref = "src-electron/providers/codex/codex-adapter.ts: createTransport / executeTurn / buildTurnResult; docs/design/provider-adapter.md: Codex projection owner" }
// fault = "bindingかMemory owner selectorを欠落・再利用するか出力secretをUIへ公開する"
// observable = "2 ownerとbackgroundのtransport env、process.env、live state、返却artifact.operationTimeline/providerMetadata、ProviderTurnError.messageとlogger出力"
// observation_boundary = "component-behavior"
// scope = "codex-adapter"
// lifecycle = "permanent"
// impact = "会話履歴とMCPのsession権限が誤ったSessionへ流れる"
// distinction = "native通知と環境設定の実行時投影を確認し型検査では代替できない"
// @end-test-value
it("fresh process bindingを2 foreground ownerとbackgroundで分離し全出力境界をredactする", async () => workspace(async (directory) => {
  const parentEnvironment = { ...process.env };
  const transports: FakeTransport[] = [];
  const environments: NodeJS.ProcessEnv[] = [];
  const logs: unknown[] = [];
  const secrets = ["owner-a-binding", "owner-a-capability", "owner-b-binding", "owner-b-capability"];
  const adapter = new CodexAdapter((entry) => { logs.push(entry); }, { createTransport: (options) => {
    environments.push(options.env ?? {});
    const transport = new FakeTransport();
    if (transports.length < 2) {
      const echo = secrets.slice(transports.length * 2, transports.length * 2 + 2).join(" ");
      transport.events = [
        notification("item/completed", { item: message("answer", echo) }),
        notification("item/completed", { item: { type: "commandExecution", id: "command", command: echo, aggregatedOutput: echo, exitCode: 0, status: "completed" } }),
        notification("item/completed", { item: { type: "unsupported-" + echo, id: "unknown", payload: echo } }),
        notification("turn/completed", { turn: { id: "turn-1", status: transports.length ? "failed" : "completed", items: [], error: transports.length ? { message: echo } : null } }),
      ];
    } else transport.events = [completed([message("answer", "{}")])];
    transports.push(transport);
    return transport;
  } });
  const progress: unknown[] = [];
  const results: unknown[] = [];
  for (let owner = 0; owner < 2; owner += 1) {
    const input = createCodexRunSessionTurnInput(directory);
    input.session.id = "owner-" + owner;
    input.agentRuntimeBinding = { bindingId: "binding-" + owner, bindingReference: secrets[owner * 2], turnCapability: secrets[owner * 2 + 1], providerId: "codex", executionGeneration: "generation-" + owner, transport: "env", expiresAt: null,
      memoryRuntimeOwner: { applicationInstanceId: "app-instance-" + owner, runtimeGenerationId: "memory-generation-" + owner } };
    const run = adapter.runSessionTurn(input, (state) => { progress.push(state); });
    if (owner === 0) {
      const result = await run;
      results.push(result.assistantText, result.artifact!.operationTimeline!, result.providerMetadata, result.artifact);
    } else {
      await assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof ProviderTurnError);
        results.push(error.message, error.partialResult.assistantText, error.partialResult.artifact!.operationTimeline!, error.partialResult.providerMetadata);
        assert.ok(error.message.includes("[WITHMATE_BINDING_REFERENCE_REDACTED]"));
        return true;
      });
    }
  }
  await adapter.runBackgroundStructuredPrompt(createCodexBackgroundPromptInput({ workspacePath: directory }));
  for (const owner of [0, 1]) {
    assert.equal(environments[owner][WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV], "app-instance-" + owner);
    assert.equal(environments[owner][WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV], "memory-generation-" + owner);
  }
  assert.equal(environments[2][WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV], undefined);
  assert.equal(environments[2][WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV], undefined);
  for (const [index, secret] of secrets.entries()) {
    assert.ok(Object.values(environments[Math.floor(index / 2)]).includes(secret));
    assert.ok(!Object.values(environments[1 - Math.floor(index / 2)]).includes(secret));
    assert.ok(!Object.values(environments[2]).includes(secret));
    for (const output of [progress, results, logs]) assert.ok(!JSON.stringify(output).includes(secret));
  }
  assert.ok(JSON.stringify(progress).includes("[WITHMATE_BINDING_REFERENCE_REDACTED]"));
  assert.ok(JSON.stringify(logs).includes("[WITHMATE_BINDING_REFERENCE_REDACTED]"));
  assert.ok(logs.length >= 2);
  assert.deepEqual({ ...process.env }, parentEnvironment);
  assert.ok(transports.every((transport) => transport.closed));
}));
// @test-value v2
// kind = "invariant"
// claim = "native fileChangeのkindをartifact変更一覧へ正規化しcollaborationをtimelineへ投影する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "App Serverのkind objectを解釈せず変更一覧を失う"
// observable = "artifact.changedFilesとoperationTimeline"
// observation_boundary = "component-behavior"
// scope = "codex-adapter"
// lifecycle = "permanent"
// impact = "利用者が変更されたfileや委譲作業の履歴を履歴で確認できなくなる"
// distinction = "snapshot helper単体ではnative itemから変更一覧とtimelineへの実行時投影を確認できない"
// @end-test-value
it("native fileChangeとcollaborationをartifactへ投影する", async () => workspace(async (directory) => {
  const transport = new FakeTransport();
  const items = [
    { type: "fileChange", id: "file", status: "completed", changes: [{ path: path.join(directory, "changed.ts"), kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-before\n+after" }] },
    { type: "collabAgentToolCall", id: "agent", tool: "wait", status: "completed", agentsStates: { agent: { status: "completed" } } },
    message("answer", "done"),
  ];
  transport.events = [completed(items)];
  const result = await new CodexAdapter(undefined, { createTransport: () => transport }).runSessionTurn(createCodexRunSessionTurnInput(directory));
  assert.deepEqual(result.artifact?.changedFiles.map((file) => ({ path: file.path, kind: file.kind })), [{ path: "changed.ts", kind: "edit" }]);
  assert.ok(result.artifact?.operationTimeline?.some((operation) => operation.type === "collab_tool_call"));
}));
// @test-value v2
// kind = "invariant"
// claim = "大きいnative commandとMCP出力をliveとartifactの省略marker付きpreviewへ投影しassistant本文を保持する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "大きい操作出力をliveまたはartifactへ全文投影する、省略markerを落とす、またはassistant本文を失う"
// observable = "live stepsとartifact操作detailsのtruncation marker、assistant本文"
// observation_boundary = "component-behavior"
// scope = "codex-native-projection"
// lifecycle = "permanent"
// impact = "大きいtool出力がUIと通常履歴へ不要に複製され、省略表示や会話本文が失われる"
// distinction = "shared予算helper testではCodexのnative projection配線を確認できない"
// @end-test-value
it("native commandとMCPの大きい出力をlive artifact予算へ投影する", async () => workspace(async (directory) => {
  const largeText = "x".repeat(PROVIDER_TEXT_PREVIEW_LIMIT * 2);
  const transport = new FakeTransport();
  const command = { type: "commandExecution", id: "command", command: "echo large", aggregatedOutput: largeText, exitCode: 0, status: "completed" };
  const mcps = Array.from({ length: 10 }, (_, index) => ({ type: "mcpToolCall", id: "mcp-" + index, server: "fixture", tool: "large", arguments: {}, result: { structuredContent: { text: largeText }, content: [] }, error: null, status: "completed" }));
  transport.events = [notification("item/completed", { item: command }), ...mcps.map((item) => notification("item/completed", { item })), completed([message("answer", "本文保持")])];
  const details: string[] = [];
  const result = await new CodexAdapter(undefined, { createTransport: () => transport }).runSessionTurn(createCodexRunSessionTurnInput(directory), (_state, changes) => {
    for (const step of changes.steps.upserts) if (step.details) details.push(step.details);
  });
  assert.ok(details.length > 0);
  for (const detail of details) {
    assert.ok(detail.length < largeText.length);
    assert.match(detail, /truncated/);
  }
  for (const type of ["command_execution", "mcp_tool_call"]) {
    const detail = result.artifact!.operationTimeline!.find((operation) => operation.type === type)?.details;
    assert.ok(detail);
    assert.ok(detail.length < largeText.length);
    assert.match(detail, /truncated/);
  }
  const raw = result.artifact;
  assert.match(JSON.stringify(raw), /truncated/);
  assert.equal(result.assistantText, "本文保持");
  assert.equal(transport.closed, true);
}));
// @test-value v2
// kind = "invariant"
// claim = "session memory extractionもnative schema turnを実行しdeltaとusageを返す"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "Memory抽出でschemaを送らないかstructured responseとusageを返却結果へ反映しない"
// observable = "turn/start outputSchemaと抽出delta、usage"
// observation_boundary = "component-behavior"
// scope = "codex-adapter"
// lifecycle = "permanent"
// impact = "会話から抽出したMemoryや抽出処理のtoken使用量を失う"
// distinction = "JSON parser単体ではMemory入口からnative schema送信とdelta・usage返却までの接続を確認できない"
// @end-test-value
it("memory extractionはnative structured runnerを共有する", async () => {
  const transport = new FakeTransport();
  transport.events = [notification("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 8, outputTokens: 5, cachedInputTokens: 0, totalTokens: 13, reasoningOutputTokens: 0 } } }), completed([message("answer", '{"goal":"next","decisions":[],"notes":["note"]}')])];
  const adapter = new CodexAdapter(undefined, { createTransport: () => transport });
  const schema = SESSION_MEMORY_EXTRACTION_OUTPUT_SCHEMA;
  const result = await adapter.extractSessionMemoryDelta({ session: createSession(), appSettings: createDefaultAppSettings(), model: "gpt-5.4", reasoningEffort: "high", timeoutMs: 1000, prompt: { systemText: "extract", userText: "memory", outputSchema: schema } });
  assert.deepEqual(result.delta, { goal: "next", decisions: [], notes: ["note"] });
  assert.equal(result.usage?.outputTokens, 5);
  assert.deepEqual((transport.calls.find((call) => call.method === "turn/start")!.params as Record<string, unknown>).outputSchema, schema);
});

// @test-value v2
// kind = "invariant"
// claim = "native thread累計から現在turnの全model response分だけを履歴usageに集計する"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md" }
// fault = "last responseだけを保存するかresume前turnを現在turnへ加算する"
// observable = "複数usage通知後のstate.usage"
// observation_boundary = "component-behavior"
// scope = "codex-native-projection"
// lifecycle = "permanent"
// impact = "利用者のturn token使用量とmemory抽出閾値を誤る"
// distinction = "複数responseと重複通知の集計は型検査では確認できない"
// @end-test-value
it("native token usageはthread baselineからturn差分を集計する", () => {
  const state = createCodexTurnStreamState("thread-1");
  state.turnId = "turn-1";
  const breakdown = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: inputTokens + outputTokens });
  applyCodexTurnEvent(state, notification("thread/tokenUsage/updated", { turnId: "old", tokenUsage: { total: breakdown(100, 50), last: breakdown(10, 5) } }));
  applyCodexTurnEvent(state, notification("thread/tokenUsage/updated", { tokenUsage: { total: breakdown(110, 55), last: breakdown(10, 5) } }));
  applyCodexTurnEvent(state, notification("thread/tokenUsage/updated", { tokenUsage: { total: breakdown(130, 62), last: breakdown(20, 7) } }));
  applyCodexTurnEvent(state, notification("thread/tokenUsage/updated", { tokenUsage: { total: breakdown(130, 62), last: breakdown(20, 7) } }));
  assert.deepEqual(state.usage, breakdown(30, 12));
});

// @test-value v2
// kind = "invariant"
// claim = "terminalより後に返るsteer成功ACKも受理済みとして成功にし対応turnの履歴へ残す"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "終端処理後の成功ACKを失敗へ置換し入力draftを復元させる"
// observable = "terminal先行時のsteer promise結果とturn providerMetadata"
// observation_boundary = "component-behavior"
// scope = "codex-adapter"
// lifecycle = "permanent"
// impact = "受理済み追加入力の重複再送または有効な対話の喪失を防ぐ"
// distinction = "実stdio transportのcloseによるpending RPC rejectとterminal先行ACKの競合を短いNode子processで検証する"
// @end-test-value
it("steer成功ACKはterminalが先に届いても受理結果を保持する", { timeout: 5_000 }, async () => workspace(async (directory) => {
  const fixture = String.raw`
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ id: request.id, result: { userAgent: 'fixture', codexHome: process.cwd(), platformFamily: 'fixture', platformOs: 'fixture' } });
  else if (request.method === 'thread/start') send({ id: request.id, result: { thread: { id: 'thread-1' } } });
  else if (request.method === 'turn/start') send({ id: request.id, result: { turn: { id: 'turn-1' } } });
  else if (request.method === 'turn/steer') {
    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } } });
    setTimeout(() => send({ id: request.id, result: { turnId: 'turn-1' } }), 100);
  }
});
setInterval(() => {}, 1000);
`;
  let transport!: CodexAppServerTransport;
  const adapter = new CodexAdapter(undefined, { createTransport: (options) => {
    transport = new CodexAppServerTransport({ ...options, executable: process.execPath, arguments: ["--input-type=module", "-e", fixture] });
    return transport;
  } });
  const input = createCodexRunSessionTurnInput(directory);
  let ready!: () => void;
  const available = new Promise<void>((resolve) => { ready = resolve; });
  const run = adapter.runSessionTurn(input, (state) => { if (state.inputAvailable) ready(); });
  await available;
  const steer = adapter.steerSessionTurn({ sessionId: input.session.id, expectedTurnId: "turn-1", userMessage: "追加", attachments: [] });
  const result = await Promise.all([run, steer]);
  assert.deepEqual(result[1], { turnId: "turn-1" });
  assert.deepEqual((result[0].providerMetadata!.find((item) => item.kind === "withmate.accepted_steer")!.payload as { data: unknown }).data, {
    threadId: "thread-1", turnId: "turn-1", input: [{ type: "text", text: "追加", text_elements: [] }],
  });
  assert.equal(transport.state, "closed");
}));

// @test-value v2
// kind = "contract"
// claim = "実stdioのACK前burstは全本文・ツール結果・承認を保持し、別thread通知を破棄してWorker配送をbatch化する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#streaming-policy" }
// fault = "正常burstを拒否する、本文/承認を失う、別thread通知をWorkerへ転送する、またはevent毎にWorkerへ往復する"
// observable = "全assistantTextとtool出力、承認回数、transport close、実Worker境界の配送回数とevent数/scope"
// observation_boundary = "public-boundary"
// scope = "CodexAdapter with real stdio transport and projection Worker"
// lifecycle = "permanent"
// impact = "開始直後や再開時のburstが有効なturnを中断し本文とツール結果を失うことを防ぐ"
// distinction = "FakeTransportの既存burst testは受信キューを通らない;短いローカルNode processでACK前滞留と全量projectionを確認する"
// @end-test-value
it("実stdioの小delta burstを全量処理して承認後にturnを完了する", { timeout: 10_000 }, async (context) => workspace(async (directory) => {
  const count = 5000;
  let dispatches = 0;
  let forwarded = 0;
  let foreign = false;
  const postMessage = Worker.prototype.postMessage;
  context.mock.method(Worker.prototype, "postMessage", function (this: Worker, ...args: Parameters<Worker["postMessage"]>) {
    const command = (args[0] as CodexProjectionRequest).command;
    const events = command.type === "events" ? command.events : command.type === "event" ? [command.event] : [];
    if (events.length) {
      dispatches++;
      forwarded += events.length;
      foreign ||= events.some(event => (event.params as { threadId?: string }).threadId === "other-thread");
    }
    return postMessage.apply(this, args);
  });
  const fixture = String.raw`
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ id: request.id, result: { userAgent: 'fixture', codexHome: process.cwd(), platformFamily: 'fixture', platformOs: 'fixture' } });
  else if (request.method === 'thread/start') send({ id: request.id, result: { thread: { id: 'thread-1' } } });
  else if (request.method === 'turn/start') {
    const frames = [{ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'answer', text: '', phase: null } } }];
    for (let index = 0; index < ${count}; index++) {
      frames.push({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer', delta: index + ':日本語\n' } });
      frames.push({ method: 'item/agentMessage/delta', params: { threadId: 'other-thread', turnId: 'turn-1', itemId: 'answer', delta: 'unused' } });
    }
    frames.push({ id: 77, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', command: 'echo tool-result' } });
    frames.push({ id: request.id, result: { turn: { id: 'turn-1' } } });
    process.stdout.write(frames.map(frame => JSON.stringify(frame) + '\n').join(''));
  } else if (request.id === 77 && request.result?.decision === 'accept') {
    send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'command', command: 'echo tool-result', aggregatedOutput: 'tool-result', exitCode: 0, status: 'completed' } } });
    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } } });
  }
});
setInterval(() => {}, 1000);
`;
  let transport!: CodexAppServerTransport;
  let approvals = 0;
  const adapter = new CodexAdapter(undefined, { createTransport: (options) => {
    transport = new CodexAppServerTransport({ ...options, executable: process.execPath, arguments: ["--input-type=module", "-e", fixture] });
    return transport;
  } });
  const input = { ...createCodexRunSessionTurnInput(directory), onApprovalRequest: () => { approvals++; return "approve" as const; } };
  const result = await adapter.runSessionTurn(input);
  assert.equal(result.assistantText, Array.from({ length: count }, (_, index) => `${index}:日本語\n`).join(""));
  assert.equal(approvals, 1);
  assert.equal(result.artifact?.operationTimeline?.find(item => item.type === "command_execution")?.details, "tool-result");
  assert.equal(transport.state, "closed");
  assert.equal(forwarded, count + 3);
  assert.equal(foreign, false);
  assert.ok(dispatches < count / 8, `Expected batched Worker delivery, got ${dispatches} dispatches`);
}));

// @test-value v2
// kind = "invariant"
// claim = "current threadのMCP requestでturnIdがnullでも共通UIへ渡す"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "nullable turnIdを別turnと誤認し有効なelicitationを拒否する"
// observable = "共通UI requestとnative response"
// observation_boundary = "component-behavior"
// scope = "codex-adapter"
// lifecycle = "permanent"
// impact = "有効なMCP対話が拒否され利用者が回答できなくなる"
// distinction = "interaction helper単体ではadapterのthread/turn scope判定を通らずnullable turnIdの誤拒否を検出できない"
// @end-test-value
it("MCP elicitationのnullable turnIdをcurrent threadにscopeする", async () => workspace(async (directory) => {
  const transport = new FakeTransport();
  let response: unknown;
  transport.events = [{ kind: "serverRequest", id: 3, method: "mcpServer/elicitation/request", params: { threadId: "thread-1", turnId: null, mode: "url", serverName: "example", message: "Authorize", url: "https://example.com/auth" },
    respond: async (value) => { response = value; transport.push(completed()); },
    reject: async () => { throw new Error("valid MCP elicitation rejected"); } }];
  const input = createCodexRunSessionTurnInput(directory);
  let calls = 0;
  input.onElicitationRequest = (request) => { calls += 1; assert.equal(request.source, "example"); return { action: "decline" }; };
  await new CodexAdapter(undefined, { createTransport: () => transport }).runSessionTurn(input);
  assert.equal(calls, 1);
  assert.deepEqual(response, { action: "decline", content: null });
}));

// @test-value v2
// kind = "invariant"
// claim = "設定API keyと継承keyはephemeral公式loginへ送りkeyなしはCLI認証を維持する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "keyをenvに置くだけで無視し、またはkeyなしでも認証を変更する"
// observable = "process argv、login request paramsとthread request順序"
// observation_boundary = "component-behavior"
// scope = "codex-api-key-auth"
// lifecycle = "permanent"
// risk_tags = ["authentication", "privacy"]
// impact = "明示API keyを無視して別accountで実行したりCLI認証storeや履歴へkeyを書き込む"
// distinction = "API key選択とlogin-before-thread順序は型検査では確認できない"
// @end-test-value
it("API key選択をprocess-local ephemeral loginへ投影する", async () => {
  const previous = process.env.CODEX_API_KEY;
  try {
    for (const scenario of [{ configured: "fake-configured-key", inherited: "fake-inherited-key", expected: "fake-configured-key" }, { configured: "", inherited: "fake-inherited-key", expected: "fake-inherited-key" }, { configured: "", inherited: "", expected: "" }]) {
      if (scenario.inherited) process.env.CODEX_API_KEY = scenario.inherited;
      else delete process.env.CODEX_API_KEY;
      const input = createCodexBackgroundPromptInput();
      input.appSettings.codingProviderSettings.codex.apiKey = scenario.configured;
      const transport = new FakeTransport();
      transport.events = [completed([message("answer", "{}")])];
      let argv: readonly string[] = [];
      const adapter = new CodexAdapter(undefined, { createTransport: (options) => { argv = options.arguments ?? []; return transport; } });
      await adapter.runBackgroundStructuredPrompt(input);
      const login = transport.calls.find((call) => call.method === "account/login/start");
      if (scenario.expected) {
        assert.deepEqual(login?.params, { type: "apiKey", apiKey: scenario.expected });
        assert.equal(transport.calls[0].method, "account/login/start");
        assert.ok(argv.includes('cli_auth_credentials_store="ephemeral"'));
        assert.ok(!JSON.stringify(argv).includes(scenario.expected));
      } else {
        assert.equal(login, undefined);
        assert.ok(!argv.some((argument) => argument.includes("cli_auth_credentials_store")));
        assert.equal(transport.calls[0].method, "thread/start");
      }
    }
  } finally {
    if (previous === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = previous;
  }
});
// @test-value v2
// kind = "invariant"
// claim = "API key login拒否と不正応答はthread開始前に失敗しCLI認証へfallbackしない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "login失敗を無視して保存CLI accountでturnを実行する"
// observable = "auth ProviderTurnErrorとthread request不在"
// observation_boundary = "component-behavior"
// scope = "codex-api-key-auth"
// lifecycle = "permanent"
// risk_tags = ["authentication", "privacy"]
// impact = "明示API keyを無視して別accountで実行したりCLI認証storeや履歴へkeyを書き込む"
// distinction = "API key選択とlogin-before-thread順序は型検査では確認できない"
// @end-test-value
it("API key login失敗はfallbackせずauth失敗として収束する", async () => workspace(async (directory) => {
  for (const scenario of ["rejected", "wrong-type"]) {
    const transport = new FakeTransport();
    if (scenario === "rejected") transport.loginError = new Error("denied fake-private-key");
    else transport.loginType = "chatgpt";
    const input = createCodexRunSessionTurnInput(directory);
    input.appSettings.codingProviderSettings.codex.apiKey = "fake-private-key";
    const adapter = new CodexAdapter(undefined, { createTransport: () => transport });
    await assert.rejects(adapter.runSessionTurn(input), (error: unknown) => {
      assert.ok(error instanceof ProviderTurnError);
      assert.equal(error.reason, "auth");
      assert.ok(!error.message.includes("fake-private-key"));
      assert.ok(!JSON.stringify(error.partialResult).includes("fake-private-key"));
      return true;
    });
    assert.ok(!transport.calls.some((call) => call.method === "thread/start" || call.method === "thread/resume"));
    assert.equal(transport.closed, true);
  }
}));
// @test-value v2
// kind = "invariant"
// claim = "API key echoを含むCodex応答で、live assistantの少なくとも1件に秘匿markerが現れ、runSessionTurn返却JSONにはAPI keyが残らない"
// oracle = { type = "contract", ref = "src-electron/providers/codex/codex-projection-owner.ts: live / finish; docs/design/provider-adapter.md: Codex projection owner" }
// fault = "live assistantへ秘匿markerを一度も投影しない、または返却本文・artifactを含む返却JSONへAPI keyを残す"
// observable = "progress callbackのassistantText配列とrunSessionTurn返却値のJSON、assistantTextの秘匿marker"
// observation_boundary = "component-behavior"
// scope = "codex-api-key-auth"
// lifecycle = "permanent"
// risk_tags = ["authentication", "privacy"]
// impact = "providerがechoしたcredentialの返却会話・artifactへの漏洩と、live側の秘匿投影の欠落を検出する"
// distinction = "key選択やlogin順序のtestはprovider応答のredactionを観測せず、型検査も返却文字列のsecretを検出できない"
// @end-test-value
it("API keyをprovider echoのliveとartifactから除去する", async () => workspace(async (directory) => {
  const transport = new FakeTransport();
  transport.events = [completed([message("answer", "fake-echoed-key")])];
  const input = createCodexRunSessionTurnInput(directory);
  input.appSettings.codingProviderSettings.codex.apiKey = "fake-echoed-key";
  const live: string[] = [];
  const result = await new CodexAdapter(undefined, { createTransport: () => transport }).runSessionTurn(input, (state) => { live.push(state.assistantText); });
  assert.ok(live.some((text) => text.includes("[WITHMATE_BINDING_REFERENCE_REDACTED]")));
  assert.ok(!JSON.stringify(result).includes("fake-echoed-key"));
}));

// @test-value v2
// kind = "invariant"
// claim = "背景terminal RPCと取消例外から既知keyを除去しエラー種別と取消情報を保つ"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "login以外の背景例外をraw messageで返してkeyを漏らす"
// observable = "返却例外のmessage stack code dataとAbortError名"
// observation_boundary = "component-behavior"
// scope = "codex-api-key-auth"
// lifecycle = "permanent"
// risk_tags = ["authentication", "privacy"]
// impact = "背景評価の失敗またはcallbackの例外経由でcredentialを公開する"
// distinction = "型検査では例外messageとRPC dataのsecret除去を確認できない"
// @end-test-value
it("background失敗のkey echoを除去しRPCと取消の種別を保持する", async () => {
  const apiKey = "fake-background-error-key";
  for (const scenario of ["terminal", "rpc", "cancel"]) {
    class BackgroundErrorTransport extends FakeTransport {
      override async request<T>(method: string, params?: unknown): Promise<T> {
        if (scenario === "rpc" && method === "thread/start") throw new CodexAppServerRpcError(-32001, apiKey, { detail: apiKey });
        return super.request<T>(method, params);
      }
    }
    const transport = new BackgroundErrorTransport();
    if (scenario === "terminal") transport.events = [notification("turn/completed", { turn: { id: "turn-1", status: "failed", items: [], error: { message: apiKey } } })];
    if (scenario === "cancel") { transport.failure = new Error("aborted " + apiKey, { cause: new Error("cause " + apiKey) }); transport.failure.name = "AbortError"; }
    const input = createCodexBackgroundPromptInput();
    input.appSettings.codingProviderSettings.codex.apiKey = apiKey;
    await assert.rejects(new CodexAdapter(undefined, { createTransport: () => transport }).runBackgroundStructuredPrompt(input), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(apiKey));
      assert.ok(!error.stack?.includes(apiKey));
      if (scenario === "rpc") {
        assert.ok(error instanceof CodexAppServerRpcError);
        assert.equal(error.code, -32001);
        assert.deepEqual(error.data, { detail: "[WITHMATE_BINDING_REFERENCE_REDACTED]" });
      }
      if (scenario === "cancel") {
        assert.equal(error.name, "AbortError");
        assert.strictEqual(error, transport.failure);
        assert.ok(error.cause instanceof Error);
        assert.ok(!error.cause.message.includes(apiKey));
        assert.ok(!error.cause.stack?.includes(apiKey));
      }
      return true;
    });
    assert.equal(transport.closed, true);
  }
});
// @test-value v2
// kind = "invariant"
// claim = "final progress callbackの既知keyをloggerへ渡さない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "cleanup中callback例外をraw messageでapp logへ書く"
// observable = "loggerのfinal-progress-failed message"
// observation_boundary = "component-behavior"
// scope = "codex-api-key-auth"
// lifecycle = "permanent"
// risk_tags = ["authentication", "privacy"]
// impact = "背景評価の失敗またはcallbackの例外経由でcredentialを公開する"
// distinction = "型検査では例外messageとRPC dataのsecret除去を確認できない"
// @end-test-value
it("final progress失敗のkey echoをapp logから除去する", async () => workspace(async (directory) => {
  const apiKey = "fake-final-progress-key";
  const transport = new FakeTransport();
  transport.events = [completed()];
  const input = createCodexRunSessionTurnInput(directory);
  input.appSettings.codingProviderSettings.codex.apiKey = apiKey;
  const logMessages: string[] = [];
  const adapter = new CodexAdapter((entry) => { logMessages.push(entry.message); }, { createTransport: () => transport });
  await assert.rejects(adapter.runSessionTurn(input, (state) => { if (!state.inputAvailable) throw new Error(apiKey); }));
  assert.ok(logMessages.some((message) => message.includes("[WITHMATE_BINDING_REFERENCE_REDACTED]")));
  assert.ok(logMessages.every((message) => !message.includes(apiKey)));
}));

// @test-value v2
// kind = "contract"
// claim = "terminal control成功後の最終本文またはstep consumer拒否をpartial付き失敗で返し、cleanupを完遂して既存provider失敗を上書きしない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#streaming-policy" }
// fault = "最終consumer拒否を警告だけにして成功を返す、partialを捨てる、Workerを解放しない、またはcleanup例外で元の失敗を上書きする"
// observable = "成功したterminal control callback、ProviderTurnErrorのmessageとpartial本文・操作、transport.closeと実Worker terminateの完了"
// observation_boundary = "public-boundary"
// scope = "CodexAdapter final live consumer and cleanup"
// lifecycle = "permanent"
// impact = "最終表示consumerの実失敗をturn成功として保存する誤判定と終了resourceの残留を防ぐ"
// distinction = "既存key echo testは同期terminal control自体を拒否し、terminal items反映後だけの非同期本文・step拒否を通らない。fake transportと短い実Worker実行で最終配送契約を確認する"
// @end-test-value
it("最終consumer拒否はcleanup後にpartial付きで伝播し既存失敗を維持する", async (context) => workspace(async (directory) => {
  const terminate = Worker.prototype.terminate;
  let terminated = 0;
  context.mock.method(Worker.prototype, "terminate", async function (this: Worker) {
    const result = await terminate.call(this);
    terminated += 1;
    return result;
  });
  for (const scenario of ["text", "steps", "cleanup", "provider-failure"] as const) {
    const cleanupFails = scenario === "cleanup" || scenario === "provider-failure";
    class TerminalTransport extends FakeTransport {
      override async close() {
        await super.close();
        if (cleanupFails) throw new Error("cleanup failure");
      }
    }
    const transport = new TerminalTransport();
    const command = { type: "commandExecution", id: "command", command: "echo result", cwd: directory,
      status: "completed", aggregatedOutput: "result", exitCode: 0, durationMs: 1 };
    transport.events = [completed([message("answer", "final body"), command], scenario === "provider-failure" ? "failed" : "completed")];
    const adapter = new CodexAdapter(undefined, { createTransport: () => transport });
    let terminalControlSucceeded = false;
    let finalRejected = false;
    const beforeTerminated = terminated;
    await assert.rejects(adapter.runSessionTurn(createCodexRunSessionTurnInput(directory), (state, changes) => {
      const finalFrame = scenario === "steps" ? changes.steps.upserts.some(step => step.id === "command") : state.assistantText === "final body";
      if (finalFrame) {
        assert.equal(terminalControlSucceeded, true);
        finalRejected = true;
        return Promise.reject(new Error("final consumer failed"));
      }
      if (!state.inputAvailable) terminalControlSucceeded = true;
    }), (error: unknown) => {
      assert.ok(error instanceof ProviderTurnError);
      assert.equal(error.message, scenario === "provider-failure" ? "provider failed" : "final consumer failed");
      assert.equal(error.canceled, false);
      assert.equal(error.partialResult.assistantText, "final body");
      assert.ok(error.partialResult.artifact);
      assert.equal(error.partialResult.artifact.operationTimeline?.find(operation => operation.id === "command")?.status, "completed");
      if (cleanupFails) assert.match(JSON.stringify(error.partialResult.providerMetadata), /cleanup failure/);
      assert.equal(transport.closed, true);
      assert.equal(terminated, beforeTerminated + 1);
      return true;
    });
    assert.equal(finalRejected, true);
  }
}));

// @test-value v2
// kind = "contract"
// claim = "Codexのterminal入力閉鎖通知が同期throwまたは非同期rejectしても失敗として返し、受信済みterminal本文と操作結果をpartialへ保持する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Streaming Policy / Codex projection owner / Error Handling" }
// fault = "通知先の例外でterminal eventのWorker登録を飛ばし本文・操作結果を捨てる、またはconsumer失敗を成功へ置き換える"
// observable = "ProviderTurnErrorのmessage/canceled/partialResult.assistantText/artifact.operationTimelineとtransport閉鎖"
// observation_boundary = "public-boundary"
// scope = "CodexAdapter terminal control callback failure through real projection Worker"
// lifecycle = "permanent"
// impact = "取得済みの応答と操作結果が失敗履歴から失われ、利用者が処理結果を回収できなくなる"
// distinction = "既存partial testは通知consumer例外を発生させず、privacy testはpartialを読まない。短い2通知条件で実Workerを通す接続だけを確認する"
// @end-test-value
it("terminal制御通知の同期・非同期失敗でも本文と操作結果をpartialへ回収する", async () => workspace(async (directory) => {
  for (const failureMode of ["sync", "async"] as const) {
    const transport = new FakeTransport();
    transport.events = [completed([
      message("answer", "must retain"),
      { type: "commandExecution", id: "command", command: "echo retained", aggregatedOutput: "retained output", exitCode: 0, status: "completed" },
    ])];
    const failure = new Error(`consumer failure ${failureMode}`);
    const adapter = new CodexAdapter(undefined, { createTransport: () => transport });
    await assert.rejects(adapter.runSessionTurn(createCodexRunSessionTurnInput(directory), (state) => {
      if (state.inputAvailable) return;
      if (failureMode === "sync") throw failure;
      return Promise.reject(failure);
    }), (error: unknown) => {
      assert.ok(error instanceof ProviderTurnError);
      assert.equal(error.message, failure.message);
      assert.equal(error.canceled, false);
      assert.equal(error.partialResult.assistantText, "must retain");
      const operation = error.partialResult.artifact?.operationTimeline?.find((item) => item.id === "command");
      assert.ok(operation);
      assert.equal(operation.type, "command_execution");
      assert.equal(operation.status, "completed");
      assert.equal(operation.details, "retained output");
      assert.equal(operation.exitCode, 0);
      return true;
    });
    assert.equal(transport.closed, true);
  }
}));

// @test-value v2
// kind = "invariant"
// claim = "Codex command出力は保持元で64Ki prefixに制限しdeltaとterminal snapshotの元lengthを表示へ反映する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "deltaを全量保持する、terminal再設定で制限を外す、または省略lengthと本文を破損する"
// observable = "state.itemsのoutput prefix長、live/artifact/rawのtruncation length、assistant全文とnative input"
// observation_boundary = "component-behavior"
// scope = "Codex native stream owner and final projections"
// lifecycle = "permanent"
// impact = "長時間のcommand出力でMain heapを増幅し、失敗時の説明や会話本文を失う"
// distinction = "projectionのみの既存testはdelta累積とterminal再設定時のowner保持量を観測しない"
// @end-test-value
it("command output ownerはdeltaとterminal更新でもprefixと正確な元lengthを維持する", () => {
  const state = createCodexTurnStreamState(null);
  const initial = { type: "commandExecution", id: "bounded", command: "echo", aggregatedOutput: "a".repeat(PROVIDER_TEXT_PREVIEW_LIMIT - 2), exitCode: null, status: "inProgress" };
  applyCodexTurnEvent(state, { method: "item/started", params: { item: initial } });
  applyCodexTurnEvent(state, { method: "item/commandExecution/outputDelta", params: { itemId: initial.id, delta: "bc" + "d".repeat(100000) } });
  applyCodexTurnEvent(state, { method: "item/commandExecution/outputDelta", params: { itemId: initial.id, delta: "tail" } });
  const expected = initial.aggregatedOutput + "bc\n...[truncated 100004 chars; originalLength=165540]";
  const retained = state.items.get(initial.id);
  assert.equal(retained?.type, "commandExecution");
  if (retained?.type !== "commandExecution") return;
  assert.equal(retained.aggregatedOutput?.length, PROVIDER_TEXT_PREVIEW_LIMIT);
  assert.equal(retained.aggregatedOutputOriginalLength, 165540);
  assert.equal(state.liveSteps.get(initial.id)?.details, expected);
  assert.equal(toMessageOperations([retained])[0]?.details, expected);
  const raw = buildCodexStableRawItems([retained])[0]?.data?.aggregatedOutput as { text: string; originalLength: number };
  assert.equal(raw.text, expected);
  assert.equal(raw.originalLength, 165540);
  assert.equal(initial.aggregatedOutput.length, PROVIDER_TEXT_PREVIEW_LIMIT - 2);
  const finalOutput = "z".repeat(PROVIDER_TEXT_PREVIEW_LIMIT + 9);
  const assistantText = "answer".repeat(20000);
  applyCodexTurnEvent(state, { method: "turn/completed", params: { turn: { id: "turn", status: "completed", items: [{ ...initial, aggregatedOutput: finalOutput, exitCode: 0, status: "completed" }, { type: "agentMessage", id: "assistant", text: assistantText }] } } });
  const finalItem = state.items.get(initial.id);
  assert.equal(finalItem?.type, "commandExecution");
  if (finalItem?.type !== "commandExecution") return;
  assert.equal(finalItem.aggregatedOutput?.length, PROVIDER_TEXT_PREVIEW_LIMIT);
  assert.equal(finalItem.aggregatedOutputOriginalLength, finalOutput.length);
  assert.equal(toMessageOperations([finalItem])[0]?.details, finalOutput.slice(0, PROVIDER_TEXT_PREVIEW_LIMIT) + "\n...[truncated 9 chars; originalLength=65545]");
  assert.equal(getLiveCodexAssistantText(state), assistantText);
  assert.deepEqual([...state.items.keys()], ["bounded", "assistant"]);
});
