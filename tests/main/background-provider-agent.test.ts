import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CopilotClient, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import type { OpenCodeClient, OpenCodeEvent, SessionInfo, SessionPromptInput } from "@opencode/client";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { createBackgroundProviderAgent, type BackgroundProviderAgentDependencies } from "../../src-electron/providers/background-provider-agent.js";
import type { BackgroundAgentInput } from "../../src-electron/providers/background-call-service.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import { resolveProviderCodingAdapter } from "../../src-electron/providers/provider-support.js";
import { ClaudeAdapter } from "../../src-electron/providers/claude/claude-adapter.js";
import { CodexAdapter } from "../../src-electron/providers/codex/codex-adapter.js";
import { CopilotAdapter } from "../../src-electron/providers/copilot/copilot-adapter.js";
import { OpenCodeAdapter } from "../../src-electron/providers/opencode/opencode-adapter.js";
import type { CodexProtocolEvent } from "../../src-electron/providers/codex/app-server-transport.js";
import type { OpenCodeTransportOptions } from "../../src-electron/providers/opencode/opencode-transport.js";

function fixture(providerId = "claude") {
  const session = { ...buildNewSession({ taskTitle: "Source", workspaceLabel: "fixture", workspacePath: process.cwd(),
    branch: "fixture", characterId: "character", character: "Character", characterIconPath: "",
    characterThemeColors: { main: "#123456", sub: "#abcdef" }, approvalMode: "on-request" }),
    id: "source-main", incarnationId: "inc-main", threadId: "foreground-thread" };
  const modelId = providerId === "opencode" ? "native/catalog-model" : "catalog-model";
  const input: BackgroundAgentInput = {
    session, selection: { providerId, modelId, reasoningEffort: "high" },
    userInput: "/untrusted @private-path\nregistration and Character reference material",
    scope: { purpose: "affect", history: { source: { kind: "main", sessionId: session.id, incarnationId: session.incarnationId,
      ownerIdentity: '["main","source-main","inc-main"]' }, fromMessageSeq: 0, throughMessageSeq: 1 },
      processing: { afterTurnId: null, throughTurnId: 1 }, memoryTargets: [] },
    binding: { bindingId: "background-binding", bindingReference: "reference", providerId, executionGeneration: "generation",
      transport: "env", expiresAt: null, background: true },
    handle: { actorSessionId: session.id, providerId, bindingId: "background-binding", capability: "capability",
      revocationState: new SharedArrayBuffer(4) }, signal: new AbortController().signal,
  };
  const catalog: ModelCatalogSnapshot = { providers: [{ id: providerId, label: providerId, defaultModelId: modelId,
    defaultReasoningEffort: "", models: [{ id: modelId, label: "Catalog Model", reasoningEfforts: ["high"] }] }] };
  const deps = {
    getModelCatalog: () => catalog,
    getAppSettings: () => createDefaultAppSettings(),
    projectBinding: (input: BackgroundAgentInput) => ({ ...input.binding, turnCapability: input.handle.capability,
      memoryRuntimeOwner: { applicationInstanceId: "application", runtimeGenerationId: "runtime" },
      managedMcp: { memoryUrl: "http://localhost/memory", sessionHistoryUrl: "http://localhost/history",
        glossaryUrl: "http://localhost/glossary", sessionGraphUrl: "http://localhost/graph", token: "token" } }),
  };
  return { input, deps, catalog };
}

type NativeCapture = {
  model?: unknown; depth?: unknown; prompt?: string; system?: string; env?: NodeJS.ProcessEnv;
  resumed: number; closed: number; approval?: unknown; binding?: unknown; observerUpdates: string[];
  permissionReply?: unknown;
};

function realAdapters(capture: NativeCapture) {
  let permissionAnswered!: () => void;
  const permissionDone = new Promise<void>((resolve) => { permissionAnswered = resolve; });
  const events: CodexProtocolEvent[] = [
    { kind: "serverRequest", id: "permission", method: "item/commandExecution/requestApproval",
      params: { threadId: "new-codex-thread", turnId: "turn", command: "write", availableDecisions: ["accept", "decline"] },
      respond: async (reply) => { capture.permissionReply = reply; permissionAnswered(); }, reject: async () => { permissionAnswered(); } },
    { kind: "notification", method: "turn/completed", params: { threadId: "new-codex-thread", turn: { id: "turn", status: "completed" } } },
  ];
  const codexAdapter = new CodexAdapter(undefined, { createTransport: (options) => {
    capture.env = options.env;
    return {
      start: async () => {},
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        const value = params as Record<string, unknown>;
        if (method === "config/read") return { config: {} } as T;
        if (method === "thread/resume") capture.resumed++;
        if (method === "thread/start" || method === "thread/resume") {
          capture.model = value.model; capture.approval = value.approvalPolicy;
          const config = value.config as Record<string, unknown>;
          capture.binding = config.mcp_servers;
          return { thread: { id: "new-codex-thread" } } as T;
        }
        if (method === "turn/start") {
          capture.depth = value.effort;
          capture.prompt = (value.input as { text: string }[])[0].text;
          return { turn: { id: "turn" } } as T;
        }
        return {} as T;
      },
      nextEvent: async () => { const event = events.shift(); assert.ok(event); if (event.kind === "notification") await permissionDone; return event; },
      close: async () => { capture.closed++; },
      whenClosed: async () => {},
    };
  } });
  const claudeAdapter = new ClaudeAdapter({ query: (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    capture.model = options.model; capture.depth = options.effort; capture.env = options.env;
    capture.system = JSON.stringify(options.systemPrompt); capture.binding = options.mcpServers;
    capture.approval = options.permissionMode;
    if (options.resume) capture.resumed++;
    return (async function* () {
      const submitted = (await prompt[Symbol.asyncIterator]().next()).value as SDKUserMessage;
      capture.prompt = JSON.stringify(submitted.message.content);
      capture.permissionReply = await options.canUseTool!("mcp__withmate-memory__character_affect_appraise", {}, { signal: new AbortController().signal, toolUseID: "registration", requestId: "registration" });
      try {
        yield { type: "system", subtype: "session_state_changed", state: "idle" } as SDKMessage;
        yield { type: "result", subtype: "success", is_error: false, result: "discarded",
          session_id: "new-claude-thread", user_message_uuid: submitted.uuid,
          usage: {}, modelUsage: {} } as SDKMessage;
      } finally { capture.closed++; }
    })();
  }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query });
  const listeners = new Set<(event: SessionEvent) => void>();
  const emit = (type: string, data: object) => {
    for (const listener of listeners) listener({ type, data } as SessionEvent);
  };
  const copilotSession = {
    sessionId: "new-copilot-thread",
    on: (listener: (event: SessionEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    rpc: { eventLog: { registerInterest: async () => ({ handle: "interest" }), releaseInterest: async () => ({}) } },
    send: async ({ prompt }: { prompt: string }) => { capture.prompt = prompt; emit("assistant.message", { messageId: "reply", content: "discarded" }); emit("session.idle", {}); },
    disconnect: async () => { capture.closed++; },
  };
  const copilotAdapter = new CopilotAdapter({
    onBackgroundTasksChanged: (id) => { capture.observerUpdates.push(id); },
    createClient: (options) => {
      capture.env = options?.env;
      const create = async (config: SessionConfig) => {
        capture.model = config.model; capture.depth = config.reasoningEffort; capture.binding = config.mcpServers;
        capture.system = JSON.stringify(config.systemMessage);
        capture.approval = await config.onPermissionRequest!({ kind: "shell", toolCallId: "write" } as never, {} as never);
        capture.permissionReply = capture.approval;
        return copilotSession;
      };
      return { start: async () => {}, stop: async () => [], createSession: create,
        resumeSession: async (_id: string, config: SessionConfig) => { capture.resumed++; return create(config); },
      } as unknown as CopilotClient;
    },
  });
  let request: SessionPromptInput | undefined;
  let root: SessionInfo;
  const registrations: { name: string }[] = [];
  const opencodeAdapter = new OpenCodeAdapter({ createTransport: (options: OpenCodeTransportOptions) => {
    capture.env = options.env;
    const client = {
      model: { list: async () => ({ data: [{ id: "catalog-model", providerID: "native", enabled: true,
        variants: [{ id: "high" }], capabilities: { input: ["text"] }, limit: { context: 0 } }] }) },
      session: {
        create: async (value: SessionInfo) => { root = { ...value, id: "new-opencode-thread" }; return root; },
        get: async () => { capture.resumed++; return root; },
        inbox: { list: async () => [] },
        switchModel: async (value: { model: { providerID: string; id: string; variant?: string } }) => {
          capture.model = value.model.providerID + "/" + value.model.id; capture.depth = value.model.variant;
        },
        update: async () => {},
        prompt: async (value: SessionPromptInput) => { request = value; capture.prompt = value.text; return { id: value.id, sessionID: root.id }; },
      },
      mcp: { add: async (value: { server: string }) => { registrations.push({ name: value.server }); capture.binding = registrations; },
        list: async () => ({ data: registrations.map((value) => ({ ...value, status: { status: "connected" } })) }) },
      permission: { reply: async (value: unknown) => { capture.permissionReply = value; permissionAnswered(); } },
      event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {
        yield { type: "server.connected", data: {} } as OpenCodeEvent;
        yield { type: "session.inbox.delivered", data: { sessionID: root.id, inboxID: request!.id } } as OpenCodeEvent;
        yield { type: "permission.asked", data: { id: "permission", sessionID: root.id, action: "bash", resources: ["write"] } } as OpenCodeEvent;
        await permissionDone;
        yield { type: "session.execution.succeeded", data: { sessionID: root.id } } as OpenCodeEvent;
      } }) },
      message: { list: async () => ({ data: [
        { id: "idle", type: "idle", outcome: "succeeded" },
        { id: request!.id, type: "user", text: request!.text, metadata: request!.metadata },
      ], cursor: {} }) },
    } as unknown as OpenCodeClient;
    return { start: async () => client, close: async () => { capture.closed++; }, whenClosed: async () => {} };
  } });
  return { codexAdapter, claudeAdapter, copilotAdapter, opencodeAdapter };
}

// @test-value v2
// kind = "contract"
// claim = "背景共通dispatchは4 Providerの既存adapterへModel/Depthと背景bindingを渡し、元Sessionの独立性と通常承認policyを保つ"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "Provider固定、Depth脱落、source thread再開、binding混同、通常runstateへの結果配送"
// observable = "実adapterからfake native SDK/transportへ出たModel・Depth・env・prompt・resume回数・承認返信と実行後Session"
// observation_boundary = "consumer"
// scope = "background factory through existing four provider adapters"
// lifecycle = "permanent"
// impact = "用途別設定とは異なる推論や元会話の書換え、保存先権限の混同を防ぐ"
// distinction = "共通port全stubや型検査ではnative接続・thread選択とDepth写像を検出できない"
// @end-test-value
test("background dispatch reaches all four real adapters with independent native targets", async () => {
  for (const providerId of ["codex", "copilot", "claude", "opencode"]) {
    const f = fixture(providerId), before = structuredClone(f.input.session);
    const capture: NativeCapture = { resumed: 0, closed: 0, observerUpdates: [] };
    const adapters = realAdapters(capture);
    const run = createBackgroundProviderAgent({ ...f.deps,
      getProviderCodingAdapter: (id) => resolveProviderCodingAdapter({ providerId: id, ...adapters }),
    });
    assert.equal(await run(f.input), undefined);
    assert.equal(capture.model, f.input.selection.modelId, providerId);
    assert.equal(capture.depth, "high", providerId);
    assert.equal(capture.env!.WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE, "reference", providerId);
    assert.equal(capture.env!.WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY, "capability", providerId);
    assert.ok(capture.binding, providerId);
    assert.ok(capture.prompt?.includes("registration and Character reference material"), providerId);
    assert.equal(capture.resumed, 0, providerId);
    assert.ok(capture.closed > 0, providerId);
    assert.deepEqual(capture.observerUpdates, [], providerId);
    assert.deepEqual(f.input.session, before, providerId);
    if (providerId === "codex") { assert.equal(capture.approval, "on-request"); assert.deepEqual(capture.permissionReply, { decision: "decline" }); }
    if (providerId === "claude") { assert.equal(capture.approval, "default"); assert.equal((capture.permissionReply as { behavior: string }).behavior, "deny"); }
    if (providerId === "copilot") assert.notEqual((capture.approval as { kind: string }).kind, "approve-once");
    if (providerId === "opencode") assert.equal((capture.permissionReply as { decision: string }).decision, "reject");
  }
});

// @test-value v2
// kind = "contract"
// claim = "背景実行は選択model不在、catalog失敗、別bindingをnative dispatch前に拒否する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "未設定を既定modelへ置換、catalog失敗を無視、または別bindingでSDKを実行する"
// observable = "拒否codeとadapter解決回数"
// observation_boundary = "consumer"
// scope = "background provider validation"
// lifecycle = "permanent"
// @end-test-value
test("background dispatch rejects unavailable models, failed discovery and mismatched bindings", async () => {
  const f = fixture();
  let calls = 0;
  const deps: BackgroundProviderAgentDependencies = { ...f.deps, getProviderCodingAdapter: () => { calls++; throw new Error("must not resolve"); } };
  await assert.rejects(createBackgroundProviderAgent(deps)({ ...f.input, selection: { providerId: "claude", modelId: "missing" } }), { code: "BACKGROUND_MODEL_UNAVAILABLE" });
  await assert.rejects(createBackgroundProviderAgent({ ...deps, getModelCatalog: () => { throw new Error("discovery"); } })(f.input), { code: "BACKGROUND_CATALOG_UNAVAILABLE" });
  await assert.rejects(createBackgroundProviderAgent({ ...deps, projectBinding: (input) => ({ ...f.deps.projectBinding(input), bindingId: "different" }) })(f.input), { code: "BACKGROUND_BINDING_INVALID" });
  assert.equal(calls, 0);
});

// @test-value v2
// kind = "contract"
// claim = "同じsourceの通常会話と複数背景呼出しは独立したCopilot native sessionを完了・解放する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "source IDをcache keyへ使い背景間または通常会話とnative session・clientを共有する"
// observable = "SDK client生成・停止対象、create/resume identity、送信先、各native sessionの解放順と通常progress"
// observation_boundary = "consumer"
// scope = "shared Copilot adapter concurrent foreground and background dispatch"
// lifecycle = "permanent"
// impact = "並行する生成指示が他の実行へ混ざり、通常会話が停止・更新される"
// distinction = "逐次の4 Provider testではsource単位cacheの競合を検出できない"
// @end-test-value
test("foreground and concurrent background calls use independent adapter cache identities", { timeout: 5_000 }, async () => {
  const f = fixture("copilot");
  const pending = new Map<string, () => void>();
  let allStarted!: () => void;
  const started = new Promise<void>((resolve) => { allStarted = resolve; });
  const resumed: string[] = [], created: string[] = [], disconnected: string[] = [], sent: string[] = [];
  const clients: number[] = [], stoppedClients: number[] = [];
  const clientByNativeSession = new Map<string, number>();
  const adapter = new CopilotAdapter({ createClient: () => {
    const clientId = clients.length; clients.push(clientId);
    const connect = async (id: string) => {
      clientByNativeSession.set(id, clientId);
      const listeners = new Set<(event: SessionEvent) => void>();
      return {
        sessionId: id,
        on: (listener: (event: SessionEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
        rpc: { eventLog: { registerInterest: async () => ({ handle: "interest" }), releaseInterest: async () => ({}) } },
        send: async () => { sent.push(id); pending.set(id, () => { for (const listener of listeners) listener({ type: "session.idle", data: {} } as SessionEvent); }); if (pending.size === 3) allStarted(); },
        disconnect: async () => { disconnected.push(id); },
      };
    };
    return { start: async () => {}, stop: async () => { stoppedClients.push(clientId); return []; },
      createSession: async () => { const id = `native-${created.length}`; created.push(id); return connect(id); },
      resumeSession: async (id: string) => { resumed.push(id); return connect(id); },
    } as unknown as CopilotClient;
  } });
  const sourceBinding = { ...f.deps.projectBinding(f.input), background: undefined,
    bindingId: "foreground-binding", bindingReference: "foreground-reference", executionGeneration: "foreground-generation", turnCapability: "foreground-capability" };
  let progress = 0;
  const foreground = adapter.runSessionTurn({ session: f.input.session, executionOptions: { ...captureSessionExecutionOptions(f.input.session), model: "catalog-model", reasoningEffort: "high" },
    providerCatalog: f.catalog.providers[0], userMessage: "foreground", appSettings: createDefaultAppSettings(), attachments: [], agentRuntimeBinding: sourceBinding }, () => { progress++; });
  const run = createBackgroundProviderAgent({ ...f.deps, getProviderCodingAdapter: () => adapter });
  const first = run(f.input);
  const second = run({ ...f.input, binding: { ...f.input.binding, bindingId: "second-binding", executionGeneration: "second-generation" },
    handle: { ...f.input.handle, bindingId: "second-binding" } });
  await started;
  assert.deepEqual(resumed, ["foreground-thread"]);
  assert.deepEqual(created, ["native-0", "native-1"]);
  assert.equal(clients.length, 3);
  assert.equal(new Set(clientByNativeSession.values()).size, 3);
  assert.equal(new Set(sent).size, 3);
  assert.deepEqual(disconnected, []);
  assert.deepEqual(stoppedClients, []);
  const foregroundProgress = progress;
  pending.get("native-0")!(); await first;
  assert.deepEqual(disconnected, ["native-0"]);
  assert.deepEqual(stoppedClients, [clientByNativeSession.get("native-0")]);
  pending.get("native-1")!(); await second;
  assert.deepEqual(disconnected.sort(), ["native-0", "native-1"]);
  assert.deepEqual(stoppedClients, [clientByNativeSession.get("native-0"), clientByNativeSession.get("native-1")]);
  assert.equal(progress, foregroundProgress);
  pending.get("foreground-thread")!(); await foreground;
  await adapter.invalidateSessionThread(f.input.session.id);
  assert.deepEqual(stoppedClients, [clientByNativeSession.get("native-0"), clientByNativeSession.get("native-1"), clientByNativeSession.get("foreground-thread")]);
});

// @test-value v2
// kind = "contract"
// claim = "取消済み背景呼出しは既存Claude adapterの子process実終了を待って失敗を返す"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "取消を成功へ変えるか、native processの実終了前にadmission所有者へ返す"
// observable = "子process終了前後の背景port完了状態とProviderTurnError.canceled"
// observation_boundary = "consumer"
// scope = "background factory through Claude cancellation cleanup"
// lifecycle = "permanent"
// impact = "実行中processが残っているのにbindingとadmissionが解放される"
// distinction = "通常adapter testだけでは背景共通層の完了タイミングを保証できない"
// @end-test-value
test("background cancellation waits for existing adapter process cleanup", async () => {
  const f = fixture(), controller = new AbortController();
  const child = Object.assign(new EventEmitter(), { pid: 123, stderr: { on() {}, resume() {} } });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const adapter = new ClaudeAdapter({ spawnProcess: (() => child) as unknown as typeof spawn,
    query: (({ options }: { options: Options }) => {
      options.spawnClaudeCodeProcess!({ command: "fake", args: [], cwd: process.cwd(), env: {}, signal: options.abortController!.signal });
      entered();
      return { next: () => new Promise(() => {}), close: () => {}, [Symbol.asyncIterator]() { return this; } };
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query,
  });
  let settled = false;
  const pending = createBackgroundProviderAgent({ ...f.deps, getProviderCodingAdapter: () => adapter })({ ...f.input, signal: controller.signal })
    .finally(() => { settled = true; });
  await started; controller.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  child.emit("exit");
  await assert.rejects(pending, (error: unknown) => Boolean(error && typeof error === "object" && "canceled" in error && error.canceled));
  assert.equal(settled, true);
});
