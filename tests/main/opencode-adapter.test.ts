import assert from "node:assert/strict";
import { it } from "node:test";
import path from "node:path";
import type { OpenCodeClient, OpenCodeEvent, SessionInfo, SessionMessageInfo, SessionPromptInput, FormInfo1 } from "@opencode/client";
import { OpenCodeAdapter, buildOpenCodePermissions } from "../../src-electron/providers/opencode/opencode-adapter.js";
import { resolveOpenCodeModelRef } from "../../src-electron/providers/opencode/opencode-model.js";
import { buildOpenCodeElicitation } from "../../src-electron/providers/opencode/opencode-interactions.js";
import { OpenCodeBackgroundAdapter } from "../../src-electron/providers/opencode/opencode-background.js";
import { SESSION_MEMORY_EXTRACTION_OUTPUT_SCHEMA } from "../../src-electron/session/session-memory-extraction.js";
import { ProviderTurnError, type RunSessionTurnInput, type RunBackgroundStructuredPromptInput } from "../../src-electron/providers/provider-runtime.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { createDefaultSessionMemory } from "../../src-shared/memory/session-memory-state.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";

function input(threadId = ""): RunSessionTurnInput {
  const session = { ...buildNewSession({ provider: "opencode", taskTitle: "test", workspaceLabel: "test", workspacePath: process.cwd(), branch: "main",
    characterId: "character", character: "Character", characterIconPath: "", characterThemeColors: { main: "#112233", sub: "#445566" }, approvalMode: "on-request",
    model: "opencode-go/glm-5.3", reasoningEffort: "high", customAgentName: "" }), id: crypto.randomUUID(), threadId };
  return { session, executionOptions: captureSessionExecutionOptions(session), runtimeOwner: { kind: "main", id: session.id, incarnationId: "incarnation" },
    sessionMemory: createDefaultSessionMemory(session), projectMemoryEntries: [], providerCatalog: { id: "opencode", label: "OpenCode", defaultModelId: "opencode-go/glm-5.3", defaultReasoningEffort: "high",
      models: [{ id: "opencode-go/glm-5.3", label: "GLM", reasoningEfforts: ["low", "high", "max"] }] }, userMessage: "hello", appSettings: createDefaultAppSettings(), attachments: [] };
}

function event(type: string, data: unknown, id = crypto.randomUUID()): OpenCodeEvent { return { id, created: 1, type, data } as OpenCodeEvent; }

function fixture(turn: RunSessionTurnInput, options: { disconnect?: boolean; unknownInbox?: "synthetic" | "owner-id" | "incarnation"; pendingInbox?: boolean; cleanupPending?: boolean; interactions?: boolean; createBackground?: (client: OpenCodeClient) => OpenCodeBackgroundAdapter } = {}) {
  const calls: string[] = [];
  let prompt: SessionPromptInput | undefined;
  let pending = Boolean(options.pendingInbox || options.unknownInbox);
  let permissionDone!: () => void;
  let formDone!: () => void;
  const permissionReply = new Promise<void>((resolve) => { permissionDone = resolve; });
  const formReply = new Promise<void>((resolve) => { formDone = resolve; });
  const mcpRegistrations: Array<{ server: string; location?: { directory?: string }; config: unknown }> = [];
  const root: SessionInfo = { id: "root", projectID: "project", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
    location: { directory: turn.executionWorkspacePath ?? turn.session.workspacePath }, metadata: { withmateOwner: { schema: 1, ...turn.runtimeOwner } } };
  const messages = (): SessionMessageInfo[] => [
    { id: "idle", type: "idle", outcome: "succeeded", time: { created: 4 } },
    { id: "assistant", type: "assistant", time: { created: 3 }, agent: "build", model: { providerID: "opencode-go", id: "glm-5.3" }, content: [{ type: "text", text: "final" }], tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 2, write: 0 } } },
    { id: prompt!.id!, type: "user", text: prompt!.text, metadata: prompt!.metadata, time: { created: 2 } },
  ];
  const client = {
    model: { list: async () => ({ data: [{ id: "glm-5.3", modelID: "upstream-glm", providerID: "opencode-go", enabled: true, variants: [{ id: "high" }], capabilities: { input: ["text"], output: ["text"], tools: true }, limit: { context: 1000 } }] }) },
    session: { create: async ({ location }: { location: { directory: string } }) => { calls.push("create"); root.location = location; return root; }, get: async ({ sessionID }: { sessionID: string }) => sessionID === "child" ? { ...root, id: "child", parentID: "root" } : root,
      switchModel: async () => {}, update: async () => {},
      inbox: { list: async () => pending ? [{ id: "old", type: options.unknownInbox === "synthetic" ? "synthetic" : "user", payload: { metadata: {
        withmateOwner: { schema: 1, ...turn.runtimeOwner, ...(options.unknownInbox === "owner-id" ? { id: "other-session" } : {}), ...(options.unknownInbox === "incarnation" ? { incarnationId: "other-incarnation" } : {}) },
        withmateRequestID: "old" } } }] : [], cancel: async () => { calls.push("cancel-inbox"); pending = false; } },
      prompt: async (value: SessionPromptInput) => { calls.push("prompt"); prompt = value; return { id: value.id, sessionID: "root", type: "user", payload: { text: value.text }, delivery: "queue" }; },
      interrupt: async () => { calls.push("interrupt"); }, form: { reply: async ({ answer }: { answer: unknown }) => { calls.push(`form:${JSON.stringify(answer)}`); formDone(); }, cancel: async () => { calls.push("form:cancel"); formDone(); } },
    },
    message: { list: async () => { calls.push("snapshot"); return { data: messages(), cursor: {} }; } },
    mcp: { add: async (registration: typeof mcpRegistrations[number]) => { mcpRegistrations.push(registration); }, list: async () => ({ data: mcpRegistrations.map((entry) => ({ name: entry.server, status: { status: "connected" } })) }) },
    permission: { reply: async ({ decision }: { decision: string }) => { calls.push(`permission:${decision}`); permissionDone(); } },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {
      const snapshots = calls.filter((call) => call === "snapshot").length;
      calls.push("connected"); yield event("server.connected", {});
      assert.ok(prompt, "event connection must be established before prompt admission");
      yield event("session.inbox.delivered", { sessionID: "root", inboxID: prompt.id });
      if (options.interactions) {
        yield event("permission.asked", { id: "permission", sessionID: "child", action: "bash", resources: ["echo test"] });
        await permissionReply;
        yield event("form.created", { form: { id: "form", sessionID: "child", title: "Choose", fields: [{ key: "answer", type: "string", options: [{ value: "yes", label: "Yes" }] }] } });
        await formReply;
      }
      yield event("session.text.delta", { sessionID: "root", assistantMessageID: "assistant", ordinal: 0, delta: "partial" });
      if (options.disconnect) return;
      yield event("session.execution.succeeded", { sessionID: "child" });
      assert.equal(calls.filter((call) => call === "snapshot").length, snapshots, "child completion is not root completion");
      yield event("session.text.ended", { sessionID: "root", assistantMessageID: "assistant", ordinal: 0, text: "full" });
      yield event("session.execution.succeeded", { sessionID: "root" });
    } }) },
  } as unknown as OpenCodeClient;
  let release!: () => void;
  const closed = new Promise<void>((resolve) => { release = resolve; });
  const adapter = new OpenCodeAdapter({ databasePath: path.join(process.cwd(), "unused.db"), executable: path.join(process.cwd(), "unused.exe"), backgroundAdapter: options.createBackground?.(client), createTransport: () => ({
    start: async () => client, close: async () => { calls.push("close"); if (options.cleanupPending) throw new Error("cleanup timeout"); release(); }, whenClosed: () => closed,
  }) });
  return { adapter, calls, getPrompt: () => prompt, mcpRegistrations, release };
}

function backgroundHarness(client: OpenCodeClient, options: { pendingCleanup?: boolean; holdGeneration?: boolean } = {}) {
  let launches = 0;
  let releaseCleanup!: () => void;
  let releaseGeneration!: () => void;
  let notifyGenerating!: () => void;
  const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  const generation = new Promise<void>((resolve) => { releaseGeneration = resolve; });
  const generating = new Promise<void>((resolve) => { notifyGenerating = resolve; });
  const adapter = new OpenCodeBackgroundAdapter({ databasePath: path.join(process.cwd(), "unused.db"), executable: path.join(process.cwd(), "unused.exe"), createTransport: () => {
    const first = launches++ === 0;
    let resolveClosed!: () => void;
    const closed = first && options.pendingCleanup ? cleanup : new Promise<void>((resolve) => { resolveClosed = resolve; });
    return { start: async () => ({ ...client, generate: { text: async () => {
      notifyGenerating();
      if (first && options.holdGeneration) await generation;
      return { text: '{"goal":null,"decisions":null,"openQuestions":null,"nextActions":null,"notes":null}' };
    } } }), close: async () => { if (first && options.pendingCleanup) throw new Error("cleanup timeout"); resolveClosed(); }, whenClosed: () => closed };
  } });
  return { adapter, launches: () => launches, releaseCleanup, releaseGeneration, generating, cleanup };
}

function backgroundInput(workspacePath = process.cwd()): RunBackgroundStructuredPromptInput {
  return { providerId: "opencode", workspacePath, appSettings: createDefaultAppSettings(), model: "opencode-go/glm-5.3", reasoningEffort: "high", timeoutMs: 5000,
    prompt: { systemText: "Evaluate", userText: "turn", outputSchema: SESSION_MEMORY_EXTRACTION_OUTPUT_SCHEMA } };
}

// @test-value v2
// kind = "contract"
// claim = "foregroundのcleanup未確認は同workspaceのbackgroundとextractだけを実終了まで拒否し正常active実行や別workspaceを妨げない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/879" }
// fault = "foreground close失敗後にbackgroundまたはextractを開始するか無関係なworkspaceまで停止する"
// observable = "公開入口のreject、background transport起動数、別workspace成功、whenClosed後の再開"
// observation_boundary = "public-boundary"
// scope = "OpenCode foreground to background cleanup exclusion"
// lifecycle = "permanent"
// impact = "終了未確認processと補助処理の競合を防ぎ通常の並行実行を保持する"
// distinction = "plane内のguard testはforegroundからbackgroundとextractへの境界を通らない"
// @end-test-value
it("OpenCode foreground pending cleanup guards background and extract by normalized workspace", async () => {
  const turn = input();
  let background!: ReturnType<typeof backgroundHarness>;
  const run = fixture(turn, { cleanupPending: true, createBackground: (client) => (background = backgroundHarness(client)).adapter });
  let pending: Promise<void> | undefined;
  turn.onCleanupPending = (completion) => { pending = completion; };
  let checkedActive = false;
  await run.adapter.runSessionTurn(turn, async () => {
    if (!checkedActive) { checkedActive = true; await run.adapter.runBackgroundStructuredPrompt(backgroundInput()); }
  });
  assert.equal(background.launches(), 1, "normal active foreground permits background execution");
  const normalizedWorkspace = `${process.cwd()}${path.sep}.`;
  const extract = { session: { ...turn.session, workspacePath: normalizedWorkspace }, appSettings: turn.appSettings, model: turn.executionOptions.model,
    reasoningEffort: turn.executionOptions.reasoningEffort, timeoutMs: 5000, prompt: { systemText: "Evaluate", userText: "turn", outputSchema: SESSION_MEMORY_EXTRACTION_OUTPUT_SCHEMA } };
  await assert.rejects(run.adapter.runBackgroundStructuredPrompt(backgroundInput(normalizedWorkspace)), /still terminating/);
  await assert.rejects(run.adapter.extractSessionMemoryDelta(extract), /still terminating/);
  assert.equal(background.launches(), 1, "blocked entrances must not launch a background process");
  await run.adapter.runBackgroundStructuredPrompt(backgroundInput(path.dirname(process.cwd())));
  assert.equal(background.launches(), 2);
  assert.ok(pending); run.release(); await pending;
  await run.adapter.runBackgroundStructuredPrompt(backgroundInput(normalizedWorkspace));
  await run.adapter.extractSessionMemoryDelta(extract);
  assert.equal(background.launches(), 4);
});

// @test-value v2
// kind = "contract"
// claim = "backgroundのcleanup未確認は同workspaceのforegroundを実終了まで拒否し正常active実行と別workspaceを妨げない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/879" }
// fault = "background close失敗後にforegroundを開始するか生成中というだけで通常実行を拒否する"
// observable = "foregroundの結果とreject、native prompt回数、whenClosed後の再開"
// observation_boundary = "public-boundary"
// scope = "OpenCode background to foreground cleanup exclusion"
// lifecycle = "permanent"
// impact = "補助processの残留との競合を防ぎMain/Auxの通常並行性を維持する"
// distinction = "background単体testはcoding plane入口のcleanup照合を通らない"
// @end-test-value
it("OpenCode background pending cleanup guards foreground until actual exit", async () => {
  const turn = input();
  let background!: ReturnType<typeof backgroundHarness>;
  const run = fixture(turn, { createBackground: (client) => (background = backgroundHarness(client, { pendingCleanup: true, holdGeneration: true })).adapter });
  const generation = run.adapter.runBackgroundStructuredPrompt(backgroundInput());
  await background.generating;
  await run.adapter.runSessionTurn(turn);
  assert.equal(run.calls.filter((call) => call === "prompt").length, 1, "normal active background permits foreground execution");
  background.releaseGeneration(); await generation;
  await assert.rejects(run.adapter.runSessionTurn({ ...turn, executionWorkspacePath: `${process.cwd()}${path.sep}.` }), /background process cleanup is still pending/);
  assert.equal(run.calls.filter((call) => call === "prompt").length, 1);
  await run.adapter.runSessionTurn({ ...turn, executionWorkspacePath: path.dirname(process.cwd()) });
  assert.equal(run.calls.filter((call) => call === "prompt").length, 2);
  background.releaseCleanup(); await background.cleanup;
  await run.adapter.runSessionTurn(turn);
  assert.equal(run.calls.filter((call) => call === "prompt").length, 3);
});

// @test-value v2
// kind = "contract"
// claim = "OpenCodeはevent接続後に合成promptを一度だけ送りrootの今回入力終端まで待ちsnapshotで暫定本文を置換する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/879" }
// fault = "admissionや子終端を成功とするか確定本文へdeltaを重複加算する"
// observable = "adapterの送信順序、prompt本文、結果threadと本文とusage"
// observation_boundary = "public-boundary"
// scope = "OpenCode coding root execution boundary"
// lifecycle = "permanent"
// impact = "回答の欠落・二重表示と実行中の後続turn開始を防ぐ"
// distinction = "型検査はlive-only購読の順序やnative終端の意味を検査しない"
// @end-test-value
it("OpenCode completes only the current root request and replaces provisional text", async () => {
  const turn = input(); const run = fixture(turn);
  const result = await run.adapter.runSessionTurn(turn);
  assert.equal(run.calls.filter((call) => call === "prompt").length, 1);
  assert.ok(run.calls.indexOf("connected") < run.calls.indexOf("prompt"));
  assert.equal(run.getPrompt()!.text, run.adapter.composePrompt(turn).logicalPrompt.composedText);
  assert.equal(run.getPrompt()!.metadata?.withmateRequestID, run.getPrompt()!.id);
  assert.equal(result.threadId, "root"); assert.equal(result.assistantText, "final");
  assert.deepEqual(result.usage, { inputTokens: 12, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 17 });
  assert.equal(run.calls.at(-1), "close");
});

// @test-value v2
// kind = "contract"
// claim = "OpenCodeの切断は取得済み本文とthreadをpartial errorへ保持しpromptを再送しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/879" }
// fault = "EOFを成功にするか再送で同じ入力の副作用を重複実行する"
// observable = "ProviderTurnError.partialResult、prompt回数、interruptとclose"
// observation_boundary = "public-boundary"
// scope = "OpenCode disconnected turn failure"
// lifecycle = "permanent"
// impact = "切断時の回答消失と入力二重実行を防ぐ"
// distinction = "正常終端testはEOF経路のpartial保存を通らない"
// @end-test-value
it("OpenCode preserves partial result and does not resend after stream EOF", async () => {
  const turn = input("root"); const run = fixture(turn, { disconnect: true });
  await assert.rejects(run.adapter.runSessionTurn(turn), (error: unknown) => {
    assert.ok(error instanceof ProviderTurnError); assert.equal(error.partialResult.threadId, "root"); assert.equal(error.partialResult.assistantText, "partial"); return true;
  });
  assert.equal(run.calls.filter((call) => call === "prompt").length, 1);
  assert.ok(run.calls.indexOf("interrupt") < run.calls.indexOf("close"));
  assert.ok(!run.calls.includes("create"));
});

// @test-value v2
// kind = "security"
// claim = "OpenCodeは同ownerの識別済み旧inboxだけを取消してから新入力を送り未知ownerは拒否する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/879" }
// fault = "旧入力が次turnで配送されるか所有不明入力を推測取消する"
// observable = "inbox取消とpromptの順序および未知入力時のrejectと未送信"
// observation_boundary = "public-boundary"
// scope = "OpenCode inbox ownership preflight"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// impact = "取消済み入力の遅延実行と別所有入力の破壊を防ぐ"
// distinction = "通常正常系と型は永続inboxの所有照合を検査しない"
// @end-test-value
it("OpenCode cancels only attributable pending inputs before the next prompt", async () => {
  const turn = input("root"); const known = fixture(turn, { pendingInbox: true });
  await known.adapter.runSessionTurn(turn);
  assert.ok(known.calls.indexOf("cancel-inbox") < known.calls.indexOf("prompt"));
  for (const unknownInbox of ["synthetic", "owner-id", "incarnation"] as const) {
    const unknown = fixture(turn, { unknownInbox });
    await assert.rejects(unknown.adapter.runSessionTurn(turn), /unknown ownership/);
    assert.ok(!unknown.calls.includes("cancel-inbox")); assert.ok(!unknown.calls.includes("prompt"));
  }
});

// @test-value v2
// kind = "contract"
// claim = "cleanup timeout後のOpenCode adapter再実行は実終了確認まで拒否しcompletionをruntimeへ渡す"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "bounded closeのrejectだけで同Sessionの再送guardを解除する"
// observable = "onCleanupPending completionと再実行拒否および実終了後の再実行"
// observation_boundary = "public-boundary"
// scope = "OpenCode cleanup pending guard"
// lifecycle = "permanent"
// impact = "旧processと次turnの二重実行を防ぐ"
// distinction = "transport終了testはadapterとruntime間のguard接続を通らない"
// @end-test-value
it("OpenCode retains its guard until actual process cleanup", async () => {
  const turn = input(); const run = fixture(turn, { cleanupPending: true });
  let pending: Promise<void> | undefined; turn.onCleanupPending = (completion) => { pending = completion; };
  await run.adapter.runSessionTurn(turn); assert.ok(pending);
  await assert.rejects(run.adapter.runSessionTurn(turn), /terminating/);
  const sameWorkspace = input();
  await assert.rejects(run.adapter.runSessionTurn(sameWorkspace), /workspace or thread is still terminating/);
  const sameThread = input("root");
  sameThread.executionWorkspacePath = path.dirname(process.cwd());
  await assert.rejects(run.adapter.runSessionTurn(sameThread), /workspace or thread is still terminating/);
  run.release(); await pending;
  await run.adapter.runSessionTurn(turn);
});

// @test-value v2
// kind = "security"
// claim = "OpenCodeの子承認とformはroot権限内で共通UIへ往復し承認はonceかrejectだけへ変換する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/879" }
// fault = "承認を永続alwaysへ変換するか子requestの型付き回答を失う"
// observable = "承認callbackの要求とnative replyのdecision、form answer"
// observation_boundary = "public-boundary"
// scope = "OpenCode child interaction routing"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// impact = "別turnまで残るproject権限や質問回答の取り違えを防ぐ"
// distinction = "共通UIのtestはOpenCode native reply変換と子帰属を通らない"
// @end-test-value
it("OpenCode routes child permissions and typed forms without permanent grants", async () => {
  for (const mode of ["on-request", "never"] as const) {
    const turn = input(); turn.executionOptions = { ...turn.executionOptions, approvalMode: mode };
    let approvals = 0;
    turn.onApprovalRequest = (request) => { approvals++; assert.equal(request.provider, "opencode"); return "deny"; };
    turn.onElicitationRequest = (request) => { assert.equal(request.fields[0].name, "answer"); return { action: "accept", content: { answer: "yes" } }; };
    const run = fixture(turn, { interactions: true });
    await run.adapter.runSessionTurn(turn);
    assert.equal(approvals, mode === "never" ? 0 : 1);
    assert.ok(run.calls.includes(mode === "never" ? "permission:once" : "permission:reject"));
    assert.ok(run.calls.includes('form:{"answer":"yes"}'));
  }
});

// @test-value v2
// kind = "security"
// claim = "同workspaceの並行OpenCode turnは各tokenを明示locationのruntime MCPだけへ渡す"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/879" }
// fault = "locationを省略するか並行turnのtokenを共有して別actorのMemoryを操作する"
// observable = "並行adapterのMCP登録locationとheaderおよび送信promptのsecret不在"
// observation_boundary = "public-boundary"
// scope = "OpenCode runtime MCP turn isolation"
// lifecycle = "permanent"
// risk_tags = ["authorization", "privacy"]
// impact = "Main/Aux間のMemory権限と本文の混線を防ぐ"
// distinction = "managed MCP host側testはnative location登録や並行provider変換を通らない"
// @end-test-value
it("OpenCode keeps per-turn managed MCP tokens at an explicit native location", async () => {
  const turns = [input(), input()];
  turns.forEach((turn, index) => { turn.agentRuntimeBinding = { providerId: "opencode", bindingId: `binding-${index}`, bindingReference: `secret-binding-${index}`, executionGeneration: `generation-${index}`, transport: "env", expiresAt: null,
    managedMcp: { token: `secret-token-${index}`, memoryUrl: "http://localhost/memory", glossaryUrl: "http://localhost/glossary" } }; });
  const fixtures = turns.map((turn) => fixture(turn));
  await Promise.all(fixtures.map((run, index) => run.adapter.runSessionTurn(turns[index])));
  fixtures.forEach((run, index) => {
    assert.equal(run.mcpRegistrations.length, 2);
    for (const registration of run.mcpRegistrations) {
      assert.deepEqual(registration.location, { directory: process.cwd() });
      assert.deepEqual(registration.config, { type: "remote", url: registration.server === "withmate-memory" ? "http://localhost/memory" : "http://localhost/glossary", headers: { "x-withmate-mcp-token": `secret-token-${index}` }, oauth: false });
    }
    assert.ok(!JSON.stringify(run.getPrompt()).includes("secret-token"));
    assert.ok(!JSON.stringify(run.getPrompt()).includes("secret-binding"));
  });
});

// @test-value v2
// kind = "security"
// claim = "OpenCode変換はmodel内slashとeffortを別保存しdirectoryのwildcard拡大と未表現form制約を拒否する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/879" }
// fault = "model境界を最後slashで分割するかdirectoryやformの意味を黙って緩める"
// observable = "native model Ref、permission rule、form変換rejectと選択肢label"
// observation_boundary = "component-behavior"
// scope = "OpenCode native input transformations"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// impact = "意図しないmodel実行、directory権限拡大、不正な質問回答を防ぐ"
// distinction = "各native schemaはWithMateからの意味変換を検査しない"
// @end-test-value
it("OpenCode native conversions preserve model and permission boundaries", () => {
  assert.deepEqual(resolveOpenCodeModelRef("provider/model/nested", "high"), { providerID: "provider", id: "model/nested", variant: "high" });
  assert.throws(() => resolveOpenCodeModelRef("provider/model#high", "high"));
  assert.throws(() => buildOpenCodePermissions([path.join(process.cwd(), "wild*card")]));
  assert.deepEqual(buildOpenCodePermissions([process.cwd()]), [{ action: "opencode_session_move", resource: "*", effect: "deny" }, { action: "external_directory", resource: path.join(process.cwd(), "*"), effect: "allow" }]);
  const form: FormInfo1 = { id: "form", sessionID: "root", title: "question", fields: [{ key: "choice", type: "string", options: [{ value: "a", label: "A" }] }] };
  const field = buildOpenCodeElicitation(form, "request").fields[0];
  assert.equal(field.type, "select");
  if (field.type === "select") assert.deepEqual(field.options, [{ value: "a", label: "A" }]);
  assert.throws(() => buildOpenCodeElicitation({ ...form, fields: [{ key: "x", type: "string", pattern: "a+" }] }, "request"));
});
