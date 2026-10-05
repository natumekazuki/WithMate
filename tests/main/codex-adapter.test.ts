import assert from "node:assert/strict";

import type { Stats } from "node:fs";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
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
import { AUDIT_RAW_ITEMS_JSON_LIMIT, AUDIT_TEXT_PREVIEW_LIMIT } from "../../src-electron/session/audit-payload-limits.js";
import { WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV, WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV } from "../../src-shared/agent-runtime/agent-runtime-binding-contract.js";
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
    return new Promise((resolve) => { this.waiter = resolve; });
  }
  push(event: CodexProtocolEvent) { if (this.waiter) { const waiter = this.waiter; this.waiter = null; waiter(event); } else this.events.push(event); }
  async close() { this.closed = true; }
  whenClosed(): Promise<void> { return Promise.resolve(); }
}

// @test-value v2
// kind = "contract"
// claim = "Codex progressは変更stepだけを渡し、resolved event burst中でもmacrotaskを実行する"
// oracle = { type = "contract", ref = "docs/design/audit-log.md" }
// fault = "1step変更で既存全stepを変更扱いするか、同期event連鎖でMainのtimerを飢餓させる"
// observable = "実adapter callbackのchanged step ID列と、全event処理前のsetImmediate実行位置"
// observation_boundary = "public-boundary"
// scope = "CodexAdapter progress owner and scheduling"
// lifecycle = "permanent"
// impact = "多数operationのAudit増幅と制御応答の遅延を防ぐ"
// distinction = "共有map単体や型検査ではnative eventからcallbackへの変更情報とevent-loop接続を確認できない"
// @end-test-value
it("Codexは変更stepだけを渡しevent burst中にもmacrotaskへyieldする", async () => workspace(async (directory) => {
  const transport = new FakeTransport();
  transport.events = [
    notification("item/started", { item: { type: "commandExecution", id: "one", command: "one", aggregatedOutput: "", exitCode: null, status: "inProgress" } }),
    notification("item/started", { item: { type: "commandExecution", id: "two", command: "two", aggregatedOutput: "", exitCode: null, status: "inProgress" } }),
    notification("item/commandExecution/outputDelta", { itemId: "one", delta: "changed" }),
    completed(),
  ];
  const changes: RunSessionTurnProgressChanges[] = [];
  let callbacksAtYield = -1;
  setImmediate(() => { callbacksAtYield = changes.length; });
  const adapter = new CodexAdapter(undefined, { createTransport: () => transport });
  await adapter.runSessionTurn(createCodexRunSessionTurnInput(directory), (_state, change) => { changes.push(change); });
  assert.deepEqual(changes.filter((change) => change.steps.upserts.length > 0).map((change) => change.steps.upserts.map((step) => step.id)), [["one"], ["two"], ["one"]]);
  assert.ok(callbacksAtYield >= 0 && callbacksAtYield < changes.length);
  assert.equal(changes[3].steps.upserts[0].details, "changed");
}));
// @test-value v2
// kind = "invariant"
// claim = "cleanup失敗はnative completed/failed/interruptedの結果を変えず診断を残し実終了まで競合実行を拒否する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "close例外で確定outcomeを上書きするか終了未確認のprocessと再実行を重複させる"
// observable = "run結果またはProviderTurnError、監査診断、cleanup完了前後のsession/workspace/thread再実行"
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
    assert.match(result.rawItemsJson, /cleanup failure/);
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
// fault = "背景構造化出力をclose例外で捨てるかAPI keyをcleanup監査へ漏らす"
// observable = "background output、rawItemsJsonと再実行拒否"
// observation_boundary = "component-behavior"
// scope = "codex-adapter background cleanup"
// lifecycle = "permanent"
// impact = "成功した背景抽出の喪失と秘密情報の監査漏洩を防ぐ"
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
// claim = "steer監査は一致ACKで受理した本文と添付のみを対応turnへ秘匿・上限付きで保存する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "追加入力を監査から落とす、拒否入力を受理扱いする、または秘密値と巨大本文を未制限で保存する"
// observable = "実送信paramsと結果rawItemsJsonの本文・file/image・turn ID・秘匿・サイズ"
// observation_boundary = "component-behavior"
// scope = "codex-adapter steer audit"
// lifecycle = "permanent"
// impact = "turn中の指示変更を監査できず、秘密情報や過大なpayloadが保存されることを防ぐ"
// distinction = "共有監査helperではACK確認とnative steer送信内容の関連付けを検査できない"
// @end-test-value
it("受理steerの本文と添付を秘匿してbounded監査へ残す", async () => workspace(async (directory) => {
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
  for (let index = 0; index < 10; index += 1) await adapter.steerSessionTurn({ sessionId: input.session.id, expectedTurnId: "turn-1", userMessage: "large " + "x".repeat(AUDIT_TEXT_PREVIEW_LIMIT * 2), attachments: [] });
  transport.push(completed([message("answer", "done")]));
  const result = await run;
  const raw = JSON.parse(result.rawItemsJson) as Array<{ type: string; data: any }>;
  const accepted = raw.find((item) => item.type === "withmate.accepted_steer")!;
  assert.equal(accepted.data.turnId, "turn-1");
  assert.equal(accepted.data.threadId, "thread-1");
  assert.match(accepted.data.input[0].text, /修正して/);
  assert.ok(accepted.data.input[0].text.includes(attachments[0].absolutePath));
  assert.deepEqual(accepted.data.input[1], { type: "localImage", path: attachments[1].absolutePath });
  assert.ok(!result.rawItemsJson.includes("fake-steer-key"));
  assert.ok(!result.rawItemsJson.includes("unaccepted-marker"));
  assert.match(result.rawItemsJson, /truncated/i);
  assert.ok(result.rawItemsJson.length <= AUDIT_RAW_ITEMS_JSON_LIMIT);
  const sent = transport.calls.find((call) => call.method === "turn/steer")!.params as any;
  assert.ok(sent.input[0].text.includes("fake-steer-key"));
  assert.equal(result.assistantText, "done");
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
async function workspace<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-native-"));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
// @test-value v2
// kind = "invariant"
// claim = "native itemの到着順とdeltaからassistant本文を確定する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "completed itemを再連結して本文を重複させる"
// observable = "stream中と確定後のassistant本文"
// observation_boundary = "component-behavior"
// scope = "codex-native-projection"
// lifecycle = "permanent"
// impact = "Codex実行の会話継続、監査または権限が失われる"
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
// impact = "Codex実行の会話継続、監査または権限が失われる"
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
// claim = "保存threadIdを明示resumeし失敗時も新規threadへ切替せず送信時modelとmax/ultraを含むdepth・権限設定をnative requestへ送る"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "保存sessionを新規threadへ置換する、sandbox rootsを落とす、または送信時model/depthを保存値や上限値へ置換する"
// observable = "thread/resumeとturn/startの送信params、resume失敗後のrequestとpartial threadId"
// observation_boundary = "component-behavior"
// scope = "codex-adapter"
// lifecycle = "permanent"
// impact = "Codex実行の会話継続、監査または権限が失われる"
// distinction = "型検査では検出できないnative通知と実行結果の対応を検証する"
// @end-test-value
it("foregroundは保存thread resumeとnative設定、監査結果を維持する", async () => workspace(async (directory) => {
  const transport = new FakeTransport();
  transport.events = [notification("item/completed", { item: message("answer", "done") }), completed([message("answer", "done")])];
  const input = createCodexRunSessionTurnInput(directory);
  input.session.threadId = "thread-1";
  input.session.allowedAdditionalDirectories = [path.join(directory, "..", "additional")];
  input.executionOptions = { ...input.executionOptions, codexSandboxMode: "workspace-write-network", codexSpeed: "fast", codexReviewer: "auto-review" };
  const adapter = new CodexAdapter(undefined, { createTransport: () => transport });
  const result = await adapter.runSessionTurn(input);
  assert.equal(transport.calls[0].method, "thread/resume");
  const start = transport.calls.find((call) => call.method === "turn/start")!.params as Record<string, any>;
  assert.equal(start.serviceTier, "fast");
  assert.equal(start.approvalsReviewer, "auto_review");
  assert.equal(start.sandboxPolicy.networkAccess, true);
  assert.deepEqual(start.sandboxPolicy.writableRoots, [directory, path.resolve(directory, "..", "additional")]);
  assert.equal(start.input[0].text, adapter.composePrompt(input).logicalPrompt.composedText);
  assert.equal(result.assistantText, "done");
  assert.equal(result.threadId, "thread-1");
  assert.match(result.rawItemsJson, /agentMessage/);
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
// impact = "Codex実行の会話継続、監査または権限が失われる"
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
      assert.ok(result.operations.some((operation) => operation.type === "command_execution"));
    } else {
      await assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof ProviderTurnError);
        assert.equal(error.partialResult.assistantText, "partial");
        assert.ok(error.partialResult.operations.some((operation) => operation.type === "command_execution"));
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
// impact = "Codex実行の会話継続、監査または権限が失われる"
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
// impact = "Codex実行の会話継続、監査または権限が失われる"
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
// impact = "Codex実行の会話継続、監査または権限が失われる"
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
// claim = "異なるforeground ownerとbackgroundのbinding・Memory owner envを分離し親env不変でlive audit error logからsecretを除去する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "bindingかMemory owner selectorを欠落・再利用するか出力secretをUIへ公開する"
// observable = "2 ownerのtransport env、process.env、live state、operations、raw、返却error、logger"
// observation_boundary = "component-behavior"
// scope = "codex-adapter"
// lifecycle = "permanent"
// impact = "会話監査とMCPのsession権限が誤ったSessionへ流れる"
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
      results.push(result.assistantText, result.operations, result.rawItemsJson, result.providerMetadata, result.artifact);
      assert.deepEqual(result.logicalPrompt, adapter.composePrompt(input).logicalPrompt);
    } else {
      await assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof ProviderTurnError);
        results.push(error.message, error.partialResult.assistantText, error.partialResult.operations, error.partialResult.rawItemsJson, error.partialResult.providerMetadata);
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
// impact = "利用者が変更されたfileや委譲作業の履歴を監査で確認できなくなる"
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
  assert.match(result.rawItemsJson, /move_path/);
}));
// @test-value v2
// kind = "invariant"
// claim = "大きいnative commandとMCP出力はlive audit previewとraw予算内に収め本文を保持する"
// oracle = { type = "contract", ref = "docs/design/audit-log.md" }
// fault = "Codexのnative itemを未制限でliveまたはauditへ投影する"
// observable = "live steps、operations details、rawItemsJsonの長さとtruncation marker、assistant本文"
// observation_boundary = "component-behavior"
// scope = "codex-native-projection"
// lifecycle = "permanent"
// impact = "大きいtool出力がUIと監査保存のメモリを圧迫し会話本文を失わせる"
// distinction = "shared予算helper testではCodexのnative projection配線を確認できない"
// @end-test-value
it("native commandとMCPの大きい出力をlive audit予算へ投影する", async () => workspace(async (directory) => {
  const largeText = "x".repeat(AUDIT_TEXT_PREVIEW_LIMIT * 2);
  const transport = new FakeTransport();
  const command = { type: "commandExecution", id: "command", command: "echo large", aggregatedOutput: largeText, exitCode: 0, status: "completed" };
  const mcps = Array.from({ length: 10 }, (_, index) => ({ type: "mcpToolCall", id: "mcp-" + index, server: "fixture", tool: "large", arguments: {}, result: { structuredContent: { text: largeText }, content: [] }, error: null, status: "completed" }));
  transport.events = [notification("item/completed", { item: command }), ...mcps.map((item) => notification("item/completed", { item })), completed([message("answer", "本文保持")])];
  const details: string[] = [];
  const result = await new CodexAdapter(undefined, { createTransport: () => transport }).runSessionTurn(createCodexRunSessionTurnInput(directory), (state) => {
    for (const step of state.steps) if (step.details) details.push(step.details);
  });
  assert.ok(details.length > 0);
  for (const detail of details) {
    assert.ok(detail.length < largeText.length);
    assert.match(detail, /truncated/);
  }
  for (const type of ["command_execution", "mcp_tool_call"]) {
    const detail = result.operations.find((operation) => operation.type === type)?.details;
    assert.ok(detail);
    assert.ok(detail.length < largeText.length);
    assert.match(detail, /truncated/);
  }
  assert.ok(result.rawItemsJson.length <= AUDIT_RAW_ITEMS_JSON_LIMIT);
  const raw = JSON.parse(result.rawItemsJson) as unknown;
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
// claim = "native thread累計から現在turnの全model response分だけを監査usageに集計する"
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
// claim = "terminalより後に返るsteer成功ACKも受理済みとして成功にし対応turnの監査へ残す"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "終端処理後の成功ACKを失敗へ置換し入力draftを復元させる"
// observable = "terminal先行時のsteer promise結果とturn rawItemsJson"
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
  assert.deepEqual(JSON.parse(result[0].rawItemsJson).find((item: any) => item.type === "withmate.accepted_steer")?.data, {
    threadId: "thread-1", turnId: "turn-1", input: [{ type: "text", text: "追加", text_elements: [] }],
  });
  assert.equal(transport.state, "closed");
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
// impact = "明示API keyを無視して別accountで実行したりCLI認証storeや監査へkeyを書き込む"
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
// impact = "明示API keyを無視して別accountで実行したりCLI認証storeや監査へkeyを書き込む"
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
// claim = "providerがAPI keyをechoしてもliveとaudit投影から除去する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "credentialsをprovider出力経由でUIとSQLite auditへ残す"
// observable = "live assistantとaudit rawItemsJsonおよび返却本文"
// observation_boundary = "component-behavior"
// scope = "codex-api-key-auth"
// lifecycle = "permanent"
// risk_tags = ["authentication", "privacy"]
// impact = "明示API keyを無視して別accountで実行したりCLI認証storeや監査へkeyを書き込む"
// distinction = "API key選択とlogin-before-thread順序は型検査では確認できない"
// @end-test-value
it("API keyをprovider echoのliveとauditから除去する", async () => workspace(async (directory) => {
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
