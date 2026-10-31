import assert from "node:assert/strict";
import { it } from "node:test";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { OpenCodeClient, OpenCodeEvent, SessionInfo, SessionMessageInfo, SessionPromptInput, SessionTransferData, FormInfo1 } from "@opencode/client";
import type { OpenCodeTransportOptions } from "../../src-electron/providers/opencode/opencode-transport.js";
import { OpenCodeAdapter, buildOpenCodePermissions } from "../../src-electron/providers/opencode/opencode-adapter.js";
import { resolveOpenCodeModelRef } from "../../src-electron/providers/opencode/opencode-model.js";
import { buildOpenCodeElicitation } from "../../src-electron/providers/opencode/opencode-interactions.js";
import { ProviderTurnError, type RunSessionTurnInput } from "../../src-electron/providers/provider-runtime.js";
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

function fixture(turn: RunSessionTurnInput, options: { disconnect?: boolean; unknownInbox?: "synthetic" | "owner-id" | "incarnation"; pendingInbox?: boolean; cleanupPending?: boolean; interactions?: boolean; form?: FormInfo1; lateInteraction?: "permission" | "form"; holdSnapshot?: () => Promise<void> } = {}) {
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
    message: { list: async () => { calls.push("snapshot"); await options.holdSnapshot?.(); return { data: messages(), cursor: {} }; } },
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
      if (options.lateInteraction === "permission") yield event("permission.asked", { id: "permission", sessionID: "child", action: "bash", resources: ["echo test"] });
      if (options.form) {
        yield event("form.created", { form: options.form });
        await formReply;
      }
      if (options.lateInteraction === "form") yield event("form.created", { form: { id: "form", sessionID: "child", title: "Choose", fields: [{ key: "answer", type: "string", options: [{ value: "yes", label: "Yes" }] }] } });
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
  const adapter = new OpenCodeAdapter({ executable: path.join(process.cwd(), "unused.exe"), createTransport: () => ({
    start: async () => client, close: async () => { calls.push("close"); if (options.cleanupPending) throw new Error("cleanup timeout"); release(); }, whenClosed: () => closed,
  }) });
  return { adapter, client, calls, getPrompt: () => prompt, mcpRegistrations, release };
}

async function migrationFixture(turn: RunSessionTurnInput) {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "withmate-opencode-migration-"));
  const databasePath = path.join(temporaryDirectory, "source.db");
  await writeFile(databasePath, "");
  const run = fixture(turn);
  const calls: string[] = [];
  const transports: OpenCodeTransportOptions[] = [];
  const targetData = new Map<string, SessionTransferData>();
  let pending = true;
  let failing = false;
  const root = await run.client.session.get({ sessionID: "root" });
  const child = { ...root, id: "child", parentID: "root" };
  const source = { session: {
    get: async ({ sessionID }: { sessionID: string }) => { calls.push(`source:get:${sessionID}`); return sessionID === "root" ? root : child; },
    inbox: { list: async ({ sessionID }: { sessionID: string }) => pending && sessionID === "root" ? [{ id: "old", type: "user", payload: { metadata: { withmateOwner: root.metadata!.withmateOwner, withmateRequestID: "old" } } }] : [],
      cancel: async () => { calls.push("source:cancel"); pending = false; } },
    active: async () => ({}),
    list: async ({ parentID }: { parentID?: string | null }) => ({ data: parentID === "root" ? [child] : [], cursor: {} }),
    export: async ({ sessionID }: { sessionID: string }): Promise<SessionTransferData> => {
      calls.push(`source:export:${sessionID}`);
      assert.equal(pending, false, "source preflight precedes export");
      return { info: sessionID === "root" ? root : child, messages: [{ id: `history-${sessionID}`, type: "user", text: "saved conversation", time: { created: 1 } }] };
    },
  } } as unknown as OpenCodeClient;
  run.client.session.get = async ({ sessionID }) => {
    if (!targetData.has(sessionID)) throw { _tag: "SessionNotFoundError", sessionID, message: "missing" };
    return targetData.get(sessionID)!.info;
  };
  run.client.session.import = async (data) => {
    calls.push(`target:import:${data.info.id}`);
    if (failing && data.info.id === "child") throw new Error("migration unavailable");
    const stored = structuredClone({ info: data.info, messages: data.messages }) as SessionTransferData;
    targetData.set(data.info.id, stored);
    return stored.info;
  };
  const nativePrompt = run.client.session.prompt;
  run.client.session.prompt = async (...args) => {
    calls.push("target:prompt");
    assert.ok(targetData.has("child"), "the family is transferred before admitting a turn");
    return nativePrompt(...args);
  };
  const adapter = new OpenCodeAdapter({ legacyDatabasePath: databasePath, createTransport: (options) => {
    transports.push(options);
    const label = options.databasePath ? "source" : "target";
    return { start: async () => { calls.push(`${label}:start`); return options.databasePath ? source : run.client; },
      close: async () => { calls.push(`${label}:close`); }, whenClosed: () => Promise.resolve() };
  } });
  return { adapter, calls, transports, targetData, getPrompt: run.getPrompt, fail: (value: boolean) => { failing = value; },
    dispose: () => rm(temporaryDirectory, { recursive: true, force: true }) };
}





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
  assert.equal(result.threadId, "native:root"); assert.equal(result.assistantText, "final");
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
  const turn = input("native:root"); const run = fixture(turn, { disconnect: true });
  await assert.rejects(run.adapter.runSessionTurn(turn), (error: unknown) => {
    assert.ok(error instanceof ProviderTurnError); assert.equal(error.partialResult.threadId, "native:root"); assert.equal(error.partialResult.assistantText, "partial"); return true;
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
  const turn = input("native:root"); const known = fixture(turn, { pendingInbox: true });
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
  const sameThread = input("native:root");
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
// kind = "contract"
// claim = "OpenCode questionの単一・複数質問は選択と自由入力を共通UIへ提示し、元のkeyと値で回答してturnを完了する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/914" }
// fault = "customを拒否する、自由入力や必須指定・選択肢説明を失う、または単一文字列と複数回答配列を取り違える"
// observable = "質問callbackのfields、native form.replyのanswer、完了したassistantText"
// observation_boundary = "public-boundary"
// scope = "OpenCode question tool form round trip"
// lifecycle = "permanent"
// impact = "標準question toolによるturn失敗と回答の欠落を防ぐ"
// distinction = "共通UI testはOpenCode form.createdからnative replyまでの変換とturn完了を通らず、型検査だけではcustomの拒否を検出しない"
// @end-test-value
it("OpenCode completes question forms with selected and custom answers", async () => {
  const options = [{ value: "a", label: "A", description: "First choice" }, { value: "b", label: "B" }];
  const single = { key: "q0", title: "Direction", description: "Which direction?", type: "string", options, custom: true } as const;
  const multiple = { key: "q1", title: "Tools", type: "multiselect", options, custom: true } as const;
  const cases: Array<{ fields: FormInfo1["fields"]; answer: Record<string, string | string[]> }> = [
    { fields: [single], answer: { q0: "a" } },
    { fields: [single], answer: { q0: "Another direction\nwith details" } },
    { fields: [multiple], answer: { q1: ["a", "Another tool\nwith details"] } },
    { fields: [single, multiple], answer: { q0: "b", q1: ["a", "Custom tool"] } },
    { fields: [{ ...single, options: [] }, { ...multiple, options: [] }], answer: { q0: "Custom direction", q1: ["Custom tool"] } },
  ];
  for (const scenario of cases) {
    const turn = input();
    let questions = 0;
    turn.onElicitationRequest = (request) => {
      questions++;
      assert.equal(request.provider, "opencode");
      assert.equal(request.kind, "question");
      assert.equal(request.blocking, true);
      assert.deepEqual(request.fields.map((field) => field.name), scenario.fields.map((field) => field.key));
      for (const field of request.fields) {
        assert.equal(field.required, true);
        assert.equal(field.type, field.name === "q0" ? "select" : "multi-select");
        assert.ok(field.type === "select" || field.type === "multi-select");
        assert.equal(field.allowFreeText, true);
        assert.deepEqual(field.options, "options" in scenario.fields[0] && scenario.fields[0].options?.length ? [{ value: "a", label: "A — First choice" }, { value: "b", label: "B" }] : []);
      }
      assert.equal(request.fields[0].title, scenario.fields[0].title);
      assert.equal(request.fields[0].description, scenario.fields[0].description);
      return { action: "accept", content: scenario.answer };
    };
    const run = fixture(turn, { form: { id: "form", sessionID: "root", title: "Questions", metadata: { kind: "question" }, fields: scenario.fields } });
    const result = await run.adapter.runSessionTurn(turn);
    assert.equal(questions, 1);
    assert.equal(result.assistantText, "final");
    assert.deepEqual(run.calls.filter((call) => call.startsWith("form:")), [`form:${JSON.stringify(scenario.answer)}`]);
  }
});

// @test-value v2
// kind = "contract"
// claim = "OpenCode questionだけ未指定requiredを必須化し、明示required・generic formのoptional・選択制約と既定値を維持する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: OpenCodeAdapter form contract" }
// fault = "全formを必須化するかnativeのrequired、custom、既定値や複数選択数の制約を上書きする"
// observable = "変換後fieldのrequired、allowFreeText、defaultValue、minItems、maxItems"
// observation_boundary = "component-behavior"
// scope = "OpenCode form field semantics"
// lifecycle = "permanent"
// distinction = "question往復fixtureにはgeneric formのoptionalとnativeの明示制約がなく、型検査は値の保持を検出しない"
// @end-test-value
it("OpenCode preserves explicit form constraints outside question defaults", () => {
  const form: FormInfo1 = { id: "form", sessionID: "root", title: "Form", fields: [
    { key: "text", type: "string" },
    { key: "choice", type: "string", required: false, custom: false, options: [{ value: "a", label: "A" }], default: "a" },
    { key: "many", type: "multiselect", required: true, custom: true, options: [{ value: "a", label: "A" }], default: ["a"], minItems: 1, maxItems: 2 },
  ] };
  const generic = buildOpenCodeElicitation(form, "generic").fields;
  assert.deepEqual(generic.map((field) => field.required), [false, false, true]);
  const question = buildOpenCodeElicitation({ ...form, metadata: { kind: "question" } }, "question").fields;
  assert.deepEqual(question.map((field) => field.required), [true, false, true]);
  const choice = question[1];
  assert.equal(choice.type, "select");
  assert.ok(choice.type === "select");
  assert.equal(choice.allowFreeText, false);
  assert.equal(choice.defaultValue, "a");
  const many = question[2];
  assert.equal(many.type, "multi-select");
  assert.ok(many.type === "multi-select");
  assert.equal(many.allowFreeText, true);
  assert.deepEqual(many.defaultValue, ["a"]);
  assert.equal(many.minItems, 1);
  assert.equal(many.maxItems, 2);
});

// @test-value v2
// kind = "contract"
// claim = "OpenCodeの選択肢付き文字列は自由入力の有無にかかわらず長さとformatの制約を共通fieldへ保持する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: OpenCode string constraints; review F-1" }
// fault = "enum変換でminLength、maxLength、formatを失いnativeが拒否する回答をUIへ許可する"
// observable = "変換後select fieldのminLength、maxLength、format、optionsとallowFreeText"
// observation_boundary = "component-behavior"
// scope = "OpenCode constrained string selection projection"
// lifecycle = "permanent"
// distinction = "renderer testと型検査はnative formから制約値が引き継がれることを保証しない"
// @end-test-value
it("OpenCode retains native string constraints on selection fields", () => {
  for (const format of ["email", "uri", "date", "date-time"] as const) {
    for (const custom of [true, false]) {
      const form: FormInfo1 = { id: "form", sessionID: "root", title: "Constrained", fields: [
        { key: "answer", type: "string", options: [{ value: "preset", label: "Preset" }], custom, minLength: 3, maxLength: 50, format },
      ] };
      const field = buildOpenCodeElicitation(form, "request").fields[0];
      assert.equal(field.type, "select");
      assert.ok(field.type === "select");
      assert.equal(field.allowFreeText, custom);
      assert.equal(field.minLength, 3);
      assert.equal(field.maxLength, 50);
      assert.equal(field.format, format);
      assert.deepEqual(field.options, [{ value: "preset", label: "Preset" }]);
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "OpenCodeはroot終端イベント受信後に解決した承認・form回答をnativeへ送らず最終snapshotの正常結果を維持する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/879" }
// fault = "最終snapshot取得完了まで回答受付を開いたままにして終了済みturnの承認・回答を送る、または受付停止で結果取得まで止める"
// observable = "root終端後に解決したcallbackに対するnative permission/form reply・cancelの有無と結果本文"
// observation_boundary = "public-boundary"
// scope = "OpenCode interaction closure at root completion"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// impact = "終了済みturnの承認がnativeへ届く権限付与と、その拒否による成功結果の失敗化を防ぐ"
// distinction = "子interaction往復testは終端前に回答が完了し、終端と回答の競合を通らない"
// @end-test-value
it("OpenCode ignores interaction answers resolved after root completion", async () => {
  for (const lateInteraction of ["permission", "form"] as const) {
    const turn = input();
    let resolveRequest: (() => void) | undefined;
    turn.onApprovalRequest = () => new Promise((resolve) => { resolveRequest = () => resolve("approve"); });
    turn.onElicitationRequest = () => new Promise((resolve) => { resolveRequest = () => resolve({ action: "accept", content: { answer: "yes" } }); });
    const run = fixture(turn, { lateInteraction, holdSnapshot: async () => {
      assert.ok(resolveRequest, `the ${lateInteraction} request is pending when the root completes`);
      resolveRequest();
      await new Promise((resolve) => setImmediate(resolve));
    } });
    const result = await run.adapter.runSessionTurn(turn);
    assert.equal(result.assistantText, "final");
    assert.deepEqual(run.calls.filter((call) => call.startsWith("permission:") || call.startsWith("form:")), []);
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
    managedMcp: { token: `secret-token-${index}`, memoryUrl: "http://localhost/memory", glossaryUrl: "http://localhost/glossary", sessionGraphUrl: "http://localhost/session-graph" } }; });
  const fixtures = turns.map((turn) => fixture(turn));
  await Promise.all(fixtures.map((run, index) => run.adapter.runSessionTurn(turns[index])));
  fixtures.forEach((run, index) => {
    const expectedUrls: Record<string, string> = {
      "withmate-memory": "http://localhost/memory", "withmate-glossary": "http://localhost/glossary", "withmate-session-graph": "http://localhost/session-graph",
    };
    assert.deepEqual(run.mcpRegistrations.map((registration) => registration.server).sort(), Object.keys(expectedUrls).sort());
    for (const registration of run.mcpRegistrations) {
      assert.deepEqual(registration.location, { directory: process.cwd() });
      assert.deepEqual(registration.config, { type: "remote", url: expectedUrls[registration.server], headers: { "x-withmate-mcp-token": `secret-token-${index}` }, oauth: false });
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

// @test-value v2
// kind = "contract"
// claim = "旧raw threadはsource preflightとfamily移行後にnative環境で続行しnative参照を返す"
// oracle = { type = "contract", ref = "docs/releases/README.md" }
// fault = "旧DBの会話を移す前に送信するか移行後もraw IDを保存して次回接続先を誤る"
// observable = "source取消・import・promptの順序、返却thread、transportのDB指定とclose"
// observation_boundary = "public-boundary"
// scope = "OpenCode adapter migration orchestration"
// lifecycle = "permanent"
// impact = "公開済みSessionを更新後も同じ会話として続行できる"
// distinction = "helper単体testではadapterのsource選択、preflightと送信の接続順、保存参照を検査できない"
// @end-test-value
it("OpenCode migrates raw threads before prompting in the native environment", async (context) => {
  const turn = input("root");
  const run = await migrationFixture(turn);
  context.after(run.dispose);
  const result = await run.adapter.runSessionTurn(turn);
  assert.equal(result.threadId, "native:root");
  assert.equal(result.assistantText, "final");
  assert.ok(run.calls.indexOf("source:cancel") < run.calls.indexOf("target:import:root"));
  assert.ok(run.calls.indexOf("target:import:root") < run.calls.indexOf("target:import:child"));
  assert.ok(run.calls.indexOf("target:import:child") < run.calls.indexOf("target:prompt"));
  assert.equal(run.getPrompt()?.sessionID, "root");
  assert.equal(run.transports[0].databasePath, undefined);
  assert.ok(run.transports[1].databasePath?.endsWith("source.db"));
  assert.equal(run.calls.filter((call) => call === "source:close").length, 1);
  assert.equal(run.calls.filter((call) => call === "target:close").length, 1);
});

// @test-value v2
// kind = "invariant"
// claim = "途中移行失敗はraw threadを維持し送信せず両transportを閉じ、次runで残りを移せる"
// oracle = { type = "contract", ref = "docs/releases/README.md" }
// fault = "移行失敗を新会話の成功へ置換するかnative参照へ早期更新して再試行不能にする"
// observable = "ProviderTurnErrorのpartial thread、prompt不在、両transport closeと再試行結果"
// observation_boundary = "public-boundary"
// scope = "OpenCode adapter migration failure recovery"
// lifecycle = "permanent"
// impact = "失敗後に公開済み会話の続きを失わず再試行できる"
// distinction = "helper単体testはadapterのerror thread保存、送信停止、process終了を通らない"
// @end-test-value
it("OpenCode retains raw thread identity and closes both transports after migration failure", async (context) => {
  const turn = input("root");
  const run = await migrationFixture(turn);
  context.after(run.dispose);
  run.fail(true);
  await assert.rejects(run.adapter.runSessionTurn(turn), (error: unknown) => {
    assert.ok(error instanceof ProviderTurnError);
    assert.equal(error.partialResult?.threadId, "root");
    return true;
  });
  assert.equal(run.getPrompt(), undefined);
  assert.equal(run.calls.filter((call) => call === "source:close").length, 1);
  assert.equal(run.calls.filter((call) => call === "target:close").length, 1);
  run.fail(false);
  const result = await run.adapter.runSessionTurn(turn);
  assert.equal(result.threadId, "native:root");
  assert.equal(run.calls.filter((call) => call === "target:import:root").length, 1);
  assert.equal(run.calls.filter((call) => call === "target:prompt").length, 1);
  assert.equal(run.calls.filter((call) => call === "source:close").length, 2);
  assert.equal(run.calls.filter((call) => call === "target:close").length, 2);
});

// @test-value v2
// kind = "contract"
// claim = "model一覧と通常turnは同じnative環境を使い保存Go keyで環境認証を上書きしない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/902" }
// fault = "一覧だけ専用DBへ接続するか保存keyをturn環境へ投影して認証先を変える"
// observable = "両transportへ渡すcwd・databasePath・環境keyと通常turnのnative参照"
// observation_boundary = "public-boundary"
// scope = "OpenCode adapter model and turn environment consistency"
// lifecycle = "permanent"
// risk_tags = ["authentication"]
// @end-test-value
it("OpenCode model discovery and turns preserve the same native authentication environment", async () => {
  const previousKey = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = "synthetic-native-key";
  try {
    const turn = input();
    turn.appSettings.codingProviderSettings.opencode = { ...turn.appSettings.codingProviderSettings.opencode, apiKey: "synthetic-saved-key" };
    const run = fixture(turn);
    run.client.model.default = async () => ({ location: { directory: turn.session.workspacePath }, data: (await run.client.model.list()).data[0] });
    const transports: OpenCodeTransportOptions[] = [];
    const adapter = new OpenCodeAdapter({ createTransport: (options) => {
      transports.push(options);
      return { start: async () => run.client, close: async () => {}, whenClosed: () => Promise.resolve() };
    } });
    await adapter.listModels({ workspacePath: turn.session.workspacePath, appSettings: turn.appSettings });
    assert.equal((await adapter.runSessionTurn(turn)).threadId, "native:root");
    assert.equal(transports.length, 2);
    for (const options of transports) {
      assert.equal(options.cwd, turn.session.workspacePath);
      assert.equal(options.databasePath, undefined);
      assert.equal(options.env?.OPENCODE_API_KEY, "synthetic-native-key");
    }
  } finally {
    if (previousKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = previousKey;
  }
});
