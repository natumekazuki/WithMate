import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import type { CopilotClient, CopilotSession, PermissionRequest, SessionEvent } from "@github/copilot-sdk";

import { buildNewSession } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { createDefaultSessionMemory } from "../../src-shared/memory/session-memory-state.js";
import type { LiveRunStep, LiveApprovalRequest, LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { LiveBackgroundTask, LiveApprovalDecision } from "../../src-shared/session/runtime-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import type { ModelCatalogProvider, ResolvedModelSelection } from "../../src-shared/settings/model-catalog.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import {
  applyCopilotBackgroundTaskEvent,
  CopilotAdapter,
  buildCopilotSessionSettings,
  buildCopilotMessageAttachments,
  buildCopilotProviderMetadata,
  collectCopilotMessageOperationsFromEventsForTesting,
  collectCopilotLiveStepsFromEventsForTesting,
  collectCopilotReasoningTextFromEventsForTesting,
  getCopilotPermissionCompletedLiveStatus,
  buildCopilotToolSummary,
  buildCopilotClientEnv,
  isCopilotVisibleToolName,
  isRecoverableCopilotConnectionErrorMessage,
  resolveCopilotCliPath,
  resolveCopilotSessionForSettings,
  resolveNativeCopilotPackageName,
  shouldRetryCopilotTurn,
  sortLiveBackgroundTasks,
  toCopilotReasoningEffort,
} from "../../src-electron/providers/copilot/copilot-adapter.js";
import { applyCopilotAssistantEvent } from "../../src-electron/providers/copilot/copilot-turn-events.js";
import { buildLiveElicitationRequestFromCopilotEvent } from "../../src-electron/providers/copilot/copilot-elicitation.js";
import { buildLiveElicitationFieldFromMcpSchema } from "../../src-electron/providers/mcp-elicitation.js";
import {
  buildCopilotProviderQuotaTelemetry,
  buildCopilotSessionContextTelemetry,
  toProviderQuotaSnapshots,
} from "../../src-electron/providers/copilot/copilot-quota-telemetry.js";
import { toProviderMetadataLogData } from "../../src-electron/providers/provider-metadata-log.js";
import { PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER, WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV, WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV, WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV } from "../../src-electron/providers/provider-agent-runtime-binding.js";
import { SessionApprovalService } from "../../src-electron/session/session-approval-service.js";
import { ProviderTurnError, type ProviderPromptComposition, type RunSessionTurnInput, type RunSessionTurnResult } from "../../src-electron/providers/provider-runtime.js";

const TEST_STRUCTURED_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    memories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          statement: { type: "string" },
        },
        required: ["statement"],
      },
    },
  },
  required: ["memories"],
} as const;

function createPartialResult(overrides?: Partial<RunSessionTurnResult>): RunSessionTurnResult {
  return {
    threadId: "",
    assistantText: "",
    usage: null,
    ...overrides,
  };
}

// @test-value v2
// kind = "contract"
// claim = "Copilotはterminal resultの個別成否・exitCode・構造化errorと未完了操作を配列順に通常履歴へ投影する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "未完了操作を除外または成功に補完し取得済み結果情報を落とす"
// observable = "collectCopilotMessageOperationsFromEventsForTestingが実event処理から返す操作配列"
// observation_boundary = "component-behavior"
// scope = "Copilot native event operation projection"
// lifecycle = "permanent"
// impact = "失敗・取消後のコマンド結果を誤表示または消失する"
// distinction = "SDK型検査ではliveからartifactに渡す結果情報の保持を確認できない"
// @end-test-value
it("Copilotの個別結果と未完了操作を通常履歴へ保持する", () => {
  const events = [
    { type: "tool.execution_start", data: { toolCallId: "done", toolName: "shell", arguments: { command: "check" } } },
    { type: "tool.execution_complete", data: { toolCallId: "done", success: false,
      result: { contents: [{ type: "terminal", text: "output", exitCode: 7 }] }, error: { message: "failure", code: "E_TOOL" } } },
    { type: "tool.execution_start", data: { toolCallId: "partial", toolName: "shell", arguments: { command: "pending" } } },
  ] as SessionEvent[];
  const operations = collectCopilotMessageOperationsFromEventsForTesting(events);
  assert.deepEqual(operations.map(({ id, status }) => ({ id, status })), [
    { id: "done", status: "failed" }, { id: "partial", status: "in_progress" },
  ]);
  assert.equal(operations[0].exitCode, 7);
  assert.deepEqual(operations[0].error, { message: "failure", code: "E_TOOL" });
  assert.equal(operations[1].exitCode, undefined);
  assert.equal(operations[1].details, undefined);
});

const COPILOT_PROVIDER_CATALOG: ModelCatalogProvider = {
  id: "copilot",
  label: "GitHub Copilot",
  defaultModelId: "gpt-4.1",
  defaultReasoningEffort: "high",
  models: [
    {
      id: "gpt-4.1",
      label: "GPT-4.1",
      reasoningEfforts: ["low", "medium", "high"],
    },
    {
      id: "gpt-4.1-mini",
      label: "GPT-4.1 mini",
      reasoningEfforts: ["low", "medium"],
    },
  ],
};

const EMPTY_PROMPT: ProviderPromptComposition = {
  systemBodyText: "",
  inputBodyText: "hello",
  logicalPrompt: {
    systemText: "",
    inputText: "",
    composedText: "",
  },
  imagePaths: [],
  additionalDirectories: [],
};

const CUSTOM_AGENT_CONFIGS = [
  {
    name: "reviewer",
    displayName: "Reviewer",
    description: "review agent",
    prompt: "Review carefully.",
    tools: null,
  },
  {
    name: "planner",
    displayName: "Planner",
    description: "planning agent",
    prompt: "Plan carefully.",
    tools: null,
  },
] as const;

function resolveCustomAgents(_workspacePath: string, selectedAgentName: string) {
  return {
    customAgents: [...CUSTOM_AGENT_CONFIGS],
    selectedAgentName: selectedAgentName.trim() || null,
  };
}

function createRunSessionInput(options?: {
  customAgentName?: string;
  threadId?: string;
  model?: string;
  reasoningEffort?: RunSessionTurnInput["session"]["reasoningEffort"];
  agentRuntimeBinding?: RunSessionTurnInput["agentRuntimeBinding"];
}): RunSessionTurnInput {
  const defaultAgentRuntimeBinding: NonNullable<RunSessionTurnInput["agentRuntimeBinding"]> = {
    bindingId: "binding-default",
    bindingReference: "opaque-reference-default",
    providerId: "copilot",
    executionGeneration: "generation-default",
    transport: "env",
    expiresAt: null,
  };
  const {
    customAgentName = "reviewer",
    threadId = "",
    model = "gpt-4.1",
    reasoningEffort = "high",
    agentRuntimeBinding = defaultAgentRuntimeBinding,
  } = options ?? {};
  const session = {
    ...buildNewSession({
      provider: "copilot",
      taskTitle: "copilot",
      workspaceLabel: "workspace",
      workspacePath: "F:/repo",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
      model,
      reasoningEffort,
      customAgentName,
    }),
    threadId,
  };

  return {
    session,
    executionOptions: captureSessionExecutionOptions(session),
    sessionMemory: createDefaultSessionMemory(session),
    projectMemoryEntries: [],
    character: {} as never,
    providerCatalog: COPILOT_PROVIDER_CATALOG,
    userMessage: "hello",
    appSettings: createDefaultAppSettings(),
    attachments: [],
    agentRuntimeBinding,
  };
}

// @test-value v2
// kind = "contract"
// claim = "Copilot foregroundは当turnのHTTP MCP endpointとcredentialをsession設定へ渡し、promptや第三者設定探索を変更しない"
// oracle = { type = "contract", ref = "docs/adr/027-shared-localhost-http-mcp-turn-identity.md" }
// fault = "HTTP serverや認証headerを欠落させる、tokenをpromptへ混ぜる、またはnative設定探索を無効にする"
// observable = "buildCopilotSessionSettingsのconfigとcomposePromptの戻り値"
// observation_boundary = "consumer"
// scope = "Copilot native foreground session HTTP MCP configuration"
// lifecycle = "permanent"
// impact = "MemoryとGlossaryが認証できず、第三者設定が使えなくなるかtokenがprompt監査へ漏れる"
// distinction = "SDKの型だけではWithMateが設定を渡すことやprompt分離を保証しない。固定fixtureでnative設定境界を確認する"
// risk_tags = ["privacy", "authentication"]
// @end-test-value
it("Copilot foregroundの当turn HTTP MCP設定をpromptから分離する", () => {
  const input = createRunSessionInput();
  input.agentRuntimeBinding = {
    ...input.agentRuntimeBinding!,
    managedMcp: { memoryUrl: "http://127.0.0.1:47891/memory", glossaryUrl: "http://127.0.0.1:47891/glossary", token: "opaque-http-token" },
  };
  const prompt = new CopilotAdapter().composePrompt(input);
  const { config } = buildCopilotSessionSettings(input, prompt, "client-key", resolveCustomAgents);
  assert.deepEqual(config.mcpServers, {
    "withmate-memory": { type: "http", url: "http://127.0.0.1:47891/memory", headers: { "x-withmate-mcp-token": "opaque-http-token" } },
    "withmate-glossary": { type: "http", url: "http://127.0.0.1:47891/glossary", headers: { "x-withmate-mcp-token": "opaque-http-token" } },
  });
  assert.notEqual(config.enableConfigDiscovery, false);
  assert.equal(config.disabledMcpServers, undefined);
  assert.doesNotMatch(JSON.stringify(prompt), /opaque-http-token/);
});


function createWritePermissionRequest(): PermissionRequest {
  return {
    kind: "write",
    toolCallId: "tool-call-1",
    intention: "Create file",
    fileName: "F:/repo/tmp/output.txt",
  } as unknown as PermissionRequest;
}

function createReadPermissionRequest(): PermissionRequest {
  return {
    kind: "read",
    toolCallId: "tool-call-2",
    path: "F:/repo/src/index.ts",
  } as unknown as PermissionRequest;
}

describe("CopilotAdapter env", () => {
  it("Copilot child CLI では process warning を抑止する", () => {
    const env = buildCopilotClientEnv({
      PATH: "test-path",
      ELECTRON_RUN_AS_NODE: "1",
    });

    assert.equal(env.NODE_NO_WARNINGS, "1");
    assert.equal(env.PATH, "test-path");
    assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  });

// @test-value v1
// kind = "invariant"
// claim = "Copilot child environment receives the Memory owner selector only for bound execution"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "Copilot selector is missing for bound execution or survives in unbound environment"
// scope = "copilot-provider-environment"
// lifecycle = "permanent"
// @end-test-value
it("Copilot child CLIへSession generationごとのopaque referenceとMemory owner selectorを渡す", () => {
    const binding = {
      bindingId: "binding-a",
      bindingReference: "opaque-reference-a",
      providerId: "copilot",
      executionGeneration: "generation-a",
      transport: "env" as const,
      expiresAt: null,
      memoryRuntimeOwner: { applicationInstanceId: "app-instance-a", runtimeGenerationId: "memory-generation-a" },
    };
    const boundEnv = buildCopilotClientEnv({
      PATH: "test-path",
      [WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV]: "stale-reference",
      EMPTY: undefined,
    }, binding);
    const unboundEnv = buildCopilotClientEnv({
      PATH: "test-path",
      [WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV.toLowerCase()]: "stale-reference",
    });

    assert.equal(boundEnv[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV], binding.bindingReference);
    assert.equal(boundEnv[WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV], "app-instance-a");
    assert.equal(boundEnv[WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV], "memory-generation-a");
    assert.equal(boundEnv.PATH, "test-path");
    assert.equal("EMPTY" in boundEnv, false);
    assert.equal(unboundEnv[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV], undefined);
    assert.equal(unboundEnv[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV.toLowerCase()], undefined);
    assert.equal(unboundEnv[WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV.toLowerCase()], undefined);
    assert.equal(unboundEnv[WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV.toLowerCase()], undefined);
  });

// @test-value v1
// kind = "invariant"
// claim = "Copilot clients are separated by Memory owner selector and background clients are unbound"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "Copilot client cache reuses a client for a different application instance or runtime generation"
// scope = "copilot-provider-adapter"
// lifecycle = "permanent"
// @end-test-value
it("Session generationごとのclientを分離しbackground clientをunboundに保つ", () => {
    const adapter = new CopilotAdapter() as unknown as {
      getClient(providerId: string, input: RunSessionTurnInput): {
        client: { resolvedEnv: Record<string, string | undefined> };
        clientKey: string;
      };
      getOrCreateClientByAppSettings(providerId: string, appSettings: RunSessionTurnInput["appSettings"]): {
        resolvedEnv: Record<string, string | undefined>;
      };
    };
    const before = process.env[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV];
    const bindingA = {
      bindingId: "binding-a",
      bindingReference: "opaque-reference-a",
      providerId: "copilot",
      executionGeneration: "generation-a",
      transport: "env" as const,
      expiresAt: null,
      memoryRuntimeOwner: { applicationInstanceId: "app-instance-a", runtimeGenerationId: "memory-generation-a" },
    };
    const bindingB = {
      ...bindingA,
      bindingId: "binding-b",
      bindingReference: "opaque-reference-b",
      executionGeneration: "generation-b",
      memoryRuntimeOwner: { applicationInstanceId: "app-instance-b", runtimeGenerationId: "memory-generation-b" },
    };
    const inputA = createRunSessionInput({ agentRuntimeBinding: bindingA });
    const inputB = { ...inputA, agentRuntimeBinding: bindingB };

    const clientA = adapter.getClient("copilot", inputA);
    const clientARetry = adapter.getClient("copilot", inputA);
    const clientB = adapter.getClient("copilot", inputB);
    const backgroundClient = adapter.getOrCreateClientByAppSettings("copilot", inputA.appSettings);

    assert.equal(clientA.client, clientARetry.client);
    assert.notEqual(clientA.client, clientB.client);
    assert.notEqual(clientA.clientKey, clientB.clientKey);
    assert.equal(
      clientA.client.resolvedEnv[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV],
      bindingA.bindingReference,
    );
    assert.equal(
      clientB.client.resolvedEnv[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV],
      bindingB.bindingReference,
    );
    assert.equal(clientA.client.resolvedEnv[WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV], "app-instance-a");
    assert.equal(clientA.client.resolvedEnv[WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV], "memory-generation-a");
    assert.equal(clientB.client.resolvedEnv[WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV], "app-instance-b");
    assert.equal(clientB.client.resolvedEnv[WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV], "memory-generation-b");
    assert.equal(backgroundClient.resolvedEnv[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV], undefined);
    assert.equal(backgroundClient.resolvedEnv[WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV], undefined);
    assert.equal(backgroundClient.resolvedEnv[WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV], undefined);
    assert.equal(
      Object.keys(backgroundClient.resolvedEnv).some(
        (key) => key.toLowerCase() === WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV.toLowerCase()
          || key.toLowerCase() === WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV.toLowerCase(),
      ),
      false,
    );
    assert.equal(process.env[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV], before);
  });

  it("supported Sessionのbinding欠落をclient cache参照前に拒否する", () => {
    const adapter = new CopilotAdapter() as unknown as {
      clients: Map<string, unknown>;
      getClient(providerId: string, input: RunSessionTurnInput): unknown;
    };
    const input = createRunSessionInput();

    assert.throws(
      () => adapter.getClient("copilot", { ...input, agentRuntimeBinding: undefined }),
      /requires an Agent runtime binding/,
    );
    assert.equal(adapter.clients.size, 0);
  });

  it("Session invalidationでbound clientを停止しbackground clientを維持する", async () => {
    const adapter = new CopilotAdapter() as unknown as {
      clients: Map<string, { stop(): Promise<Error[]> }>;
      sessions: Map<string, {
        session: { disconnect(): Promise<void> };
        settingsKey: string;
        backgroundTasks: Map<string, LiveBackgroundTask>;
      }>;
      clientKeysBySession: Map<string, string>;
      invalidateSessionThread(sessionId: string): Promise<void>;
    };
    let disconnected = false;
    let boundStopped = false;
    let backgroundStopped = false;
    adapter.clients.set("bound", {
      stop: async () => {
        boundStopped = true;
        return [];
      },
    });
    adapter.clients.set("background", {
      stop: async () => {
        backgroundStopped = true;
        return [];
      },
    });
    adapter.sessions.set("session-a", {
      session: {
        disconnect: async () => {
          disconnected = true;
        },
      },
      settingsKey: "settings",
      backgroundTasks: new Map(),
    });
    adapter.clientKeysBySession.set("session-a", "bound");

    await adapter.invalidateSessionThread("session-a");

    assert.equal(disconnected, true);
    assert.equal(boundStopped, true);
    assert.equal(backgroundStopped, false);
    assert.deepEqual([...adapter.clients.keys()], ["background"]);
    assert.equal(adapter.clientKeysBySession.has("session-a"), false);
  });

  it("Session disconnectがsettleしなくても期限後にbound client停止へ進む", async () => {
    const adapter = new CopilotAdapter({ sessionDisconnectTimeoutMs: 0 }) as unknown as {
      clients: Map<string, { stop(): Promise<Error[]> }>;
      sessions: Map<string, {
        session: { disconnect(): Promise<void> };
        settingsKey: string;
        backgroundTasks: Map<string, LiveBackgroundTask>;
      }>;
      clientKeysBySession: Map<string, string>;
      invalidateSessionThread(sessionId: string): Promise<void>;
    };
    let stopped = false;
    adapter.clients.set("bound", {
      stop: async () => {
        stopped = true;
        return [];
      },
    });
    adapter.sessions.set("session-a", {
      session: { disconnect: () => new Promise<void>(() => undefined) },
      settingsKey: "settings",
      backgroundTasks: new Map(),
    });
    adapter.clientKeysBySession.set("session-a", "bound");

    await adapter.invalidateSessionThread("session-a");

    assert.equal(stopped, true);
    assert.equal(adapter.clients.size, 0);
  });


  // @test-value v2
  // kind = "invariant"
  // claim = "Copilot session invalidation中の同一key再接続は旧cleanupで新clientを削除しない"
  // oracle = { type = "contract", ref = "src-electron/providers/copilot/copilot-adapter.ts: session lifecycle" }
  // fault = "旧sessionのcleanupが再接続済みclientを停止し、後続turnを失敗させる"
  // observable = "adapterのsession/client registryとstop呼出の最終状態"
  // observation_boundary = "implementation"
  // scope = "copilot-session-invalidation"
  // lifecycle = "permanent"
  // distinction = "単一sessionのcleanupでは検出できない同一key再接続競合を検証する"
  // @end-test-value
  it("Session invalidation中の同一key再接続を旧cleanupで削除しない", async () => {
    const adapter = new CopilotAdapter() as unknown as {
      clients: Map<string, { stop(): Promise<Error[]> }>;
      sessions: Map<string, {
        session: { disconnect(): Promise<void> };
        settingsKey: string;
        backgroundTasks: Map<string, LiveBackgroundTask>;
      }>;
      clientKeysBySession: Map<string, string>;
      invalidateSessionThread(sessionId: string): Promise<void>;
    };
    let releaseDisconnect: () => void = () => undefined;
    const disconnectBarrier = new Promise<void>((resolve) => {
      releaseDisconnect = () => resolve();
    });
    let signalDisconnectStarted: () => void = () => undefined;
    const disconnectStarted = new Promise<void>((resolve) => {
      signalDisconnectStarted = () => resolve();
    });
    let oldClientStopped = false;
    let newClientStopped = false;
    const oldClient = {
      stop: async () => {
        oldClientStopped = true;
        return [];
      },
    };
    const newClient = {
      stop: async () => {
        newClientStopped = true;
        return [];
      },
    };
    const newCachedSession = {
      session: { disconnect: async () => undefined },
      settingsKey: "new-settings",
      backgroundTasks: new Map<string, LiveBackgroundTask>(),
    };
    adapter.clients.set("bound", oldClient);
    adapter.sessions.set("session-a", {
      session: {
        disconnect: () => {
          signalDisconnectStarted();
          return disconnectBarrier;
        },
      },
      settingsKey: "old-settings",
      backgroundTasks: new Map(),
    });
    adapter.clientKeysBySession.set("session-a", "bound");

    const invalidation = adapter.invalidateSessionThread("session-a");
    assert.equal(adapter.clients.has("bound"), false);
    assert.equal(adapter.sessions.has("session-a"), false);
    assert.equal(adapter.clientKeysBySession.has("session-a"), false);

    adapter.clients.set("bound", newClient);
    adapter.sessions.set("session-a", newCachedSession);
    adapter.clientKeysBySession.set("session-a", "bound");
    await disconnectStarted;
    releaseDisconnect();
    await invalidation;

    assert.equal(oldClientStopped, true);
    assert.equal(newClientStopped, false);
    assert.equal(adapter.clients.get("bound"), newClient);
    assert.equal(adapter.sessions.get("session-a"), newCachedSession);
    assert.equal(adapter.clientKeysBySession.get("session-a"), "bound");
  });

  it("recoverable connection retryではclientを再生成して同じbinding generationを使う", async () => {
    const adapter = new CopilotAdapter() as unknown as {
      getClient(providerId: string, input: RunSessionTurnInput): {
        client: { resolvedEnv: Record<string, string | undefined> };
        clientKey: string;
      };
      clientKeysBySession: Map<string, string>;
      resetRecoverableConnection(input: RunSessionTurnInput): Promise<void>;
    };
    const binding = {
      bindingId: "binding-a",
      bindingReference: "opaque-reference-a",
      providerId: "copilot",
      executionGeneration: "generation-a",
      transport: "env" as const,
      expiresAt: null,
    };
    const input = createRunSessionInput({ agentRuntimeBinding: binding });
    const first = adapter.getClient("copilot", input);
    adapter.clientKeysBySession.set(input.session.id, first.clientKey);

    await adapter.resetRecoverableConnection(input);
    const retried = adapter.getClient("copilot", input);

    assert.equal(retried.clientKey, first.clientKey);
    assert.notEqual(retried.client, first.client);
    assert.equal(
      retried.client.resolvedEnv[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV],
      binding.bindingReference,
    );
  });

  it("session bootstrap失敗時のrecoverable retryでもcache済みclientを再生成する", async () => {
    const adapter = new CopilotAdapter() as unknown as {
      getClient(providerId: string, input: RunSessionTurnInput): {
        client: { resolvedEnv: Record<string, string | undefined> };
        clientKey: string;
      };
      clients: Map<string, unknown>;
      clientKeysBySession: Map<string, string>;
      resetRecoverableConnection(input: RunSessionTurnInput): Promise<void>;
    };
    const binding = {
      bindingId: "binding-a",
      bindingReference: "opaque-reference-a",
      providerId: "copilot",
      executionGeneration: "generation-a",
      transport: "env" as const,
      expiresAt: null,
    };
    const input = createRunSessionInput({ agentRuntimeBinding: binding });
    const first = adapter.getClient("copilot", input);

    assert.equal(adapter.clientKeysBySession.has(input.session.id), false);
    assert.equal(adapter.clients.has(first.clientKey), true);

    await adapter.resetRecoverableConnection(input);
    const retried = adapter.getClient("copilot", input);

    assert.equal(retried.clientKey, first.clientKey);
    assert.notEqual(retried.client, first.client);
    assert.equal(
      retried.client.resolvedEnv[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV],
      binding.bindingReference,
    );
  });

  it("session bootstrap失敗前にclient ownershipをSessionへ関連付ける", async () => {
    const adapter = new CopilotAdapter() as unknown as {
      clientKeysBySession: Map<string, string>;
      getClient(): { client: unknown; clientKey: string };
      getSession(input: RunSessionTurnInput, prompt: ProviderPromptComposition): Promise<unknown>;
    };
    adapter.getClient = () => ({
      client: {
        createSession: async () => {
          throw new Error("bootstrap failed");
        },
        resumeSession: async () => {
          throw new Error("bootstrap failed");
        },
      },
      clientKey: "bootstrap-client",
    });
    const input = createRunSessionInput({ threadId: "" });

    await assert.rejects(() => adapter.getSession(input, EMPTY_PROMPT), /bootstrap failed/);

    assert.equal(adapter.clientKeysBySession.get(input.session.id), "bootstrap-client");
  });

  it("provider-wide invalidationで全sessionとclientを停止する", async () => {
    const adapter = new CopilotAdapter() as unknown as {
      clients: Map<string, { stop(): Promise<Error[]> }>;
      sessions: Map<string, {
        session: { disconnect(): Promise<void> };
        settingsKey: string;
        backgroundTasks: Map<string, LiveBackgroundTask>;
        unsubscribeBackgroundObserver?: () => void;
      }>;
      clientKeysBySession: Map<string, string>;
      invalidateAllSessionThreads(): Promise<void>;
    };
    let disconnectCount = 0;
    let stopCount = 0;
    adapter.clients.set("bound", {
      stop: async () => {
        stopCount += 1;
        return [];
      },
    });
    adapter.clients.set("background", {
      stop: async () => {
        stopCount += 1;
        return [];
      },
    });
    adapter.sessions.set("session-a", {
      session: {
        disconnect: async () => {
          disconnectCount += 1;
        },
      },
      settingsKey: "settings",
      backgroundTasks: new Map(),
    });
    adapter.clientKeysBySession.set("session-a", "bound");

    await adapter.invalidateAllSessionThreads();

    assert.equal(disconnectCount, 1);
    assert.equal(stopCount, 2);
    assert.equal(adapter.sessions.size, 0);
    assert.equal(adapter.clients.size, 0);
    assert.equal(adapter.clientKeysBySession.size, 0);
  });

  it("provider-wide invalidationはdisconnectがsettleしなくても完了する", async () => {
    const adapter = new CopilotAdapter({ sessionDisconnectTimeoutMs: 0 }) as unknown as {
      clients: Map<string, { stop(): Promise<Error[]> }>;
      sessions: Map<string, {
        session: { disconnect(): Promise<void> };
        settingsKey: string;
        backgroundTasks: Map<string, LiveBackgroundTask>;
      }>;
      invalidateAllSessionThreads(): Promise<void>;
    };
    let stopped = false;
    adapter.clients.set("bound", {
      stop: async () => {
        stopped = true;
        return [];
      },
    });
    adapter.sessions.set("session-a", {
      session: { disconnect: () => new Promise<void>(() => undefined) },
      settingsKey: "settings",
      backgroundTasks: new Map(),
    });

    await adapter.invalidateAllSessionThreads();

    assert.equal(stopped, true);
    assert.equal(adapter.sessions.size, 0);
    assert.equal(adapter.clients.size, 0);
  });

  it("provider-wide invalidationでgraceful stopが期限超過したclientをforce stopする", async () => {
    const adapter = new CopilotAdapter({ clientStopTimeoutMs: 0 }) as unknown as {
      clients: Map<string, { stop(): Promise<Error[]>; forceStop(): Promise<void> }>;
      invalidateAllSessionThreads(): Promise<void>;
    };
    let forceStopped = false;
    adapter.clients.set("bound", {
      stop: () => new Promise<Error[]>(() => undefined),
      forceStop: async () => {
        forceStopped = true;
      },
    });

    await adapter.invalidateAllSessionThreads();

    assert.equal(forceStopped, true);
    assert.equal(adapter.clients.size, 0);
  });

  it("provider-wide invalidationはforce stopがsettleしなくてもclientを解放する", async () => {
    const adapter = new CopilotAdapter({ clientStopTimeoutMs: 0 }) as unknown as {
      clients: Map<string, { stop(): Promise<Error[]>; forceStop(): Promise<void> }>;
      invalidateAllSessionThreads(): Promise<void>;
    };
    let forceStopCount = 0;
    adapter.clients.set("never-settles", {
      stop: () => new Promise<Error[]>(() => undefined),
      forceStop: () => {
        forceStopCount += 1;
        return new Promise<void>(() => undefined);
      },
    });

    await adapter.invalidateAllSessionThreads();

    assert.equal(forceStopCount, 1);
    assert.equal(adapter.clients.size, 0);
  });

  it("provider-wide invalidationはforce stopの同期throwでもclientを解放する", async () => {
    const adapter = new CopilotAdapter({ clientStopTimeoutMs: 0 }) as unknown as {
      clients: Map<string, { stop(): Promise<Error[]>; forceStop(): Promise<void> }>;
      invalidateAllSessionThreads(): Promise<void>;
    };
    adapter.clients.set("force-throws", {
      stop: async () => [new Error("graceful cleanup failed")],
      forceStop: () => {
        throw new Error("force cleanup failed");
      },
    });

    await adapter.invalidateAllSessionThreads();

    assert.equal(adapter.clients.size, 0);
  });

  it("provider-wide invalidationでgraceful stopが失敗したclientをforce stopする", async () => {
    const adapter = new CopilotAdapter() as unknown as {
      clients: Map<string, { stop(): Promise<Error[]>; forceStop(): Promise<void> }>;
      invalidateAllSessionThreads(): Promise<void>;
    };
    const forceStopped: string[] = [];
    adapter.clients.set("reported-error", {
      stop: async () => [new Error("graceful cleanup failed")],
      forceStop: async () => {
        forceStopped.push("reported-error");
      },
    });
    adapter.clients.set("rejected", {
      stop: async () => {
        throw new Error("graceful cleanup rejected");
      },
      forceStop: async () => {
        forceStopped.push("rejected");
      },
    });

    await adapter.invalidateAllSessionThreads();

    assert.deepEqual(forceStopped.sort(), ["rejected", "reported-error"]);
    assert.equal(adapter.clients.size, 0);
  });

  it("Copilot session は設定が同じならcacheを再利用する", async () => {
    const adapter = new CopilotAdapter() as unknown as {
      sessions: Map<string, unknown>;
      getClient(): { client: unknown; clientKey: string };
      getSession(input: RunSessionTurnInput, prompt: ProviderPromptComposition): Promise<{ session: { sessionId: string } }>;
    };
    let sessionIndex = 0;
    const createSession = () => ({
      sessionId: `session-${++sessionIndex}`,
      disconnect: async () => undefined,
      on: () => () => undefined,
    });
    adapter.getClient = () => ({
      client: {
        createSession,
        resumeSession: async (threadId: string) => ({ ...createSession(), sessionId: threadId }),
      },
      clientKey: "client-key",
    });
    const input = createRunSessionInput();

    const firstSession = await adapter.getSession(input, EMPTY_PROMPT);
    const nextSession = await adapter.getSession(input, EMPTY_PROMPT);
    assert.equal(nextSession.session, firstSession.session);
    assert.equal(adapter.sessions.size, 1);
  });

  it("platform / arch から native Copilot package 名を決める", () => {
    assert.equal(resolveNativeCopilotPackageName("win32", "x64"), "@github/copilot-win32-x64");
    assert.equal(resolveNativeCopilotPackageName("darwin", "arm64"), "@github/copilot-darwin-arm64");
    assert.equal(resolveNativeCopilotPackageName("linux", "x64"), "@github/copilot-linux-x64");
    assert.equal(resolveNativeCopilotPackageName("win32", "ia32"), null);
  });

  it("Electron では native Copilot CLI binary を優先して使う", () => {
    const resolved = resolveCopilotCliPath(
      (specifier) => {
        assert.equal(specifier, "@github/copilot-win32-x64/package.json");
        return path.join("C:\\sdk", "package.json");
      },
      (candidate) => candidate === path.join("C:\\sdk", "copilot.exe"),
      "win32",
      "x64",
      undefined,
    );

    assert.equal(resolved, path.join("C:\\sdk", "copilot.exe"));
  });

  it("Electron では package.json subpath が非公開でも Copilot native binary を優先して使う", () => {
    const expected = path.join("C:\\sdk", "copilot.exe");
    const resolved = resolveCopilotCliPath(
      (specifier) => {
        if (specifier === "@github/copilot-win32-x64/package.json") {
          throw Object.assign(new Error("Package subpath './package.json' is not defined by exports"), {
            code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
          });
        }
        assert.equal(specifier, "@github/copilot-win32-x64");
        return expected;
      },
      (candidate) =>
        candidate === expected ||
        candidate === path.resolve(process.cwd(), "node_modules", ".bin", "copilot.cmd"),
      "win32",
      "x64",
      undefined,
    );

    assert.equal(resolved, expected);
  });

  it("packaged runtime では staged Copilot CLI binary を最優先する", () => {
    const resourcesPath = "C:\\Program Files\\WithMate\\resources";
    const expected = path.join(
      resourcesPath,
      "provider-binaries",
      "@github",
      "copilot-win32-x64",
      "copilot.exe",
    );

    const resolved = resolveCopilotCliPath(
      () => {
        throw new Error("development binary は見ない");
      },
      (candidate) => candidate === expected,
      "win32",
      "x64",
      resourcesPath,
    );

    assert.equal(resolved, expected);
  });

  it("native binary が見つからない時は local node_modules command を返す", () => {
    const resolved = resolveCopilotCliPath(
      () => {
        throw new Error("not found");
      },
      (candidate) => candidate === path.resolve(process.cwd(), "node_modules", ".bin", "copilot.cmd"),
      "win32",
      "x64",
      undefined,
    );

    assert.equal(resolved, path.resolve(process.cwd(), "node_modules", ".bin", "copilot.cmd"));
  });

  it("local command も無い時だけ bare command fallback を返す", () => {
    const resolved = resolveCopilotCliPath(
      () => {
        throw new Error("not found");
      },
      () => false,
      "win32",
      "x64",
      undefined,
    );

    assert.equal(resolved, "copilot.cmd");
  });

  it("stale connection 系の message だけ recovery 対象にする", () => {
    assert.equal(isRecoverableCopilotConnectionErrorMessage("Connection is closed."), true);
    assert.equal(isRecoverableCopilotConnectionErrorMessage("CLI server exited unexpectedly with code 0"), true);
    assert.equal(isRecoverableCopilotConnectionErrorMessage("selected model が model catalog に存在しないよ。"), false);
  });

  it("Latest Command に載せる Copilot tool 名だけ可視化対象にする", () => {
    assert.equal(isCopilotVisibleToolName("powershell"), true);
    assert.equal(isCopilotVisibleToolName("create"), true);
    assert.equal(isCopilotVisibleToolName("report_intent"), false);
  });

  it("shell tool は raw command を summary に使う", () => {
    const summary = buildCopilotToolSummary(
      "powershell",
      {
        command: "Get-ChildItem src",
      },
      "F:/repo",
    );

    assert.equal(summary, "Get-ChildItem src");
  });

  it("file-write tool は workspace 相対 path を含む summary にする", () => {
    const summary = buildCopilotToolSummary(
      "create",
      {
        path: "F:/repo/tmp/output.txt",
      },
      "F:/repo",
    );

    assert.equal(summary, "create tmp/output.txt");
  });

  it("move tool は source と destination の両方を summary にする", () => {
    const summary = buildCopilotToolSummary(
      "move",
      {
        source: "F:/repo/tmp/old.txt",
        destination: "F:/repo/tmp/new.txt",
      },
      "F:/repo",
    );

    assert.equal(summary, "move tmp/old.txt -> tmp/new.txt");
  });

  it("file / folder 添付を Copilot attachments へ変換する", () => {
    const attachments = buildCopilotMessageAttachments([
      {
        id: "file:src/index.ts",
        kind: "file",
        source: "text",
        absolutePath: "F:\\repo\\src\\index.ts",
        displayPath: "src/index.ts",
        workspaceRelativePath: "src/index.ts",
        isOutsideWorkspace: false,
      },
      {
        id: "folder:docs",
        kind: "folder",
        source: "text",
        absolutePath: "F:\\repo\\docs",
        displayPath: "docs",
        workspaceRelativePath: "docs",
        isOutsideWorkspace: false,
      },
    ]);

    assert.deepEqual(attachments, [
      {
        type: "file",
        path: "F:\\repo\\src\\index.ts",
        displayName: "src/index.ts",
      },
      {
        type: "directory",
        path: "F:\\repo\\docs",
        displayName: "docs",
      },
    ]);
  });

  it("image 添付も Copilot では file attachment として送る", () => {
    const attachments = buildCopilotMessageAttachments([
      {
        id: "image:assets/sample.png",
        kind: "image",
        source: "text",
        absolutePath: "F:\\repo\\assets\\sample.png",
        displayPath: "assets/sample.png",
        workspaceRelativePath: "assets/sample.png",
        isOutsideWorkspace: false,
      },
    ]);

    assert.deepEqual(attachments, [
      {
        type: "file",
        path: "F:\\repo\\assets\\sample.png",
        displayName: "assets/sample.png",
      },
    ]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Copilotの共通Character promptとiconはsession systemMessageへ渡し、timingとuser入力・添付から分離する"
  // oracle = { type = "contract", ref = "docs/design/prompt-composition.md" }
  // fault = "共通snapshotのiconをsystemMessageで落とすか、input・画像添付へ混入する"
  // observable = "Copilot adapterのcomposePrompt結果とsession configのsystemMessage"
  // observation_boundary = "consumer"
  // scope = "copilot-system-message"
  // lifecycle = "permanent"
  // impact = "CopilotがCharacterの画像参照を受け取れないか、意図しない画像を送信する"
  // distinction = "composer単体ではなくCopilotのsession設定へ渡す値を実際のcompose経路から確認する"
  // @end-test-value
  it("character prompt だけをCopilot systemMessageへ変換し、可変timingはinput側に留める", () => {
    const input = createRunSessionInput();
    input.session.characterRuntimeSnapshot = {
      characterId: "char-a", name: "A", description: "Saved metadata", iconFilePath: "C:/Character Data/キャラ/icon.png",
      theme: input.session.characterThemeColors, definitionMarkdown: "あなたは頼れる相棒です。",
      definitionSha256: "definition", definitionByteSize: 48, snapshotAt: "2026-10-03T00:00:00Z",
    };
    input.conversationTimingContext = {
      observedAt: "2026-08-04T21:32:00+09:00", observedDayOfWeek: "tuesday",
      currentSession: null, sameCharacterOtherSession: null, sameCharacterSharedWork: null,
    };
    const prompt = new CopilotAdapter().composePrompt(input);
    const { config } = buildCopilotSessionSettings(input, prompt, "client-key", resolveCustomAgents);

    assert.deepEqual(config.systemMessage, {
      mode: "append",
      content: prompt.systemBodyText,
    });
    assert.match(config.systemMessage?.content ?? "", /あなたは頼れる相棒です。/);
    assert.ok(config.systemMessage?.content.includes('Icon: ` C:/Character Data/キャラ/icon.png `'));
    assert.doesNotMatch(config.systemMessage?.content ?? "", /Conversation Timing|2026-08-04|# User Input/);
    assert.match(prompt.inputBodyText, /# Conversation Timing[\s\S]*# User Input\n\nhello/);
    assert.doesNotMatch(prompt.inputBodyText, /^Icon:|icon\.png/m);
    assert.deepEqual(buildCopilotMessageAttachments(input.attachments), []);
    assert.deepEqual(prompt.imagePaths, []);
  });

  it("quota snapshot は Copilot の 0-1 percentage を 0-100 表示用へ正規化する", () => {
    const snapshots = toProviderQuotaSnapshots({
      premium_interactions: {
        entitlementRequests: 500,
        usedRequests: 125,
        remainingPercentage: 0.75,
        overage: 0,
        overageAllowedWithExhaustedQuota: false,
        resetDate: "2026-04-01T00:00:00.000Z",
      },
    });

    assert.deepEqual(snapshots, [
      {
        quotaKey: "premium_interactions",
        entitlementRequests: 500,
        usedRequests: 125,
        remainingPercentage: 75,
        overage: 0,
        overageAllowedWithExhaustedQuota: false,
        resetDate: "2026-04-01T00:00:00.000Z",
      },
    ]);
  });

  it("quota snapshot から provider telemetry を組み立てる", () => {
    const telemetry = buildCopilotProviderQuotaTelemetry(
      "copilot",
      {
        premium_interactions: {
          entitlementRequests: 420,
          usedRequests: 118,
          remainingPercentage: 0.719,
          overage: 0,
          overageAllowedWithExhaustedQuota: false,
          resetDate: "2026-04-01T00:00:00.000Z",
        },
      },
      "2026-03-25T08:00:00.000Z",
    );

    assert.deepEqual(telemetry, {
      provider: "copilot",
      updatedAt: "2026-03-25T08:00:00.000Z",
      snapshots: [
        {
          quotaKey: "premium_interactions",
          entitlementRequests: 420,
          usedRequests: 118,
          remainingPercentage: 71.89999999999999,
          overage: 0,
          overageAllowedWithExhaustedQuota: false,
          resetDate: "2026-04-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("session usage_info から context telemetry を組み立てる", () => {
    const telemetry = buildCopilotSessionContextTelemetry(
      "copilot",
      "session-1",
      {
        tokenLimit: 200000,
        currentTokens: 18420,
        messagesLength: 26,
        systemTokens: 840,
        conversationTokens: 17110,
        toolDefinitionsTokens: 470,
      },
      "2026-03-25T08:05:00.000Z",
    );

    assert.deepEqual(telemetry, {
      provider: "copilot",
      sessionId: "session-1",
      updatedAt: "2026-03-25T08:05:00.000Z",
      tokenLimit: 200000,
      currentTokens: 18420,
      messagesLength: 26,
      systemTokens: 840,
      conversationTokens: 17110,
      toolDefinitionsTokens: 470,
    });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "reasoning deltaと確定reasoningをlive本文へ投影し操作結果へ混入しない"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
  // fault = "reasoningを二重連結またはコマンドへ誤分類する"
  // observable = "live reasoning文字列と操作配列"
  // observation_boundary = "component-behavior"
  // scope = "Copilot reasoning projection"
  // lifecycle = "permanent"
  // impact = "利用者が誤った推論表示やコマンド表示を見る"
  // distinction = "SDK型だけではreasoning eventの投影先と重複を確認できない"
  // @end-test-value
  it("assistant.reasoning_delta / assistant.reasoning は live reasoning text にだけ変換する", () => {
    const events = [
      {
        type: "assistant.reasoning_delta",
        timestamp: "2026-03-23T00:00:00.000Z",
        ephemeral: true,
        data: {
          reasoningId: "reasoning-1",
          deltaContent: "調査して",
        },
      },
      {
        type: "assistant.reasoning_delta",
        timestamp: "2026-03-23T00:00:01.000Z",
        ephemeral: true,
        data: {
          reasoningId: "reasoning-1",
          deltaContent: "から実装する",
        },
      },
      {
        type: "assistant.reasoning",
        timestamp: "2026-03-23T00:00:02.000Z",
        data: {
          reasoningId: "reasoning-1",
          content: "調査してから実装する",
        },
      },
    ] as never[];

    assert.deepEqual(collectCopilotLiveStepsFromEventsForTesting(events, "F:/repo"), []);
    assert.deepEqual(collectCopilotMessageOperationsFromEventsForTesting(events, "F:/repo"), []);
    assert.equal(collectCopilotReasoningTextFromEventsForTesting(events, "F:/repo"), "調査してから実装する");
  });


  it("未対応 Copilot event の app log metadata は payload を含めない", () => {
    const metadata = buildCopilotProviderMetadata([
      {
        type: "new.event",
        timestamp: "2026-03-23T00:00:00.000Z",
        data: {
          token: "secret",
        },
      },
    ]);

    assert.equal(metadata.length, 1);
    assert.deepEqual(toProviderMetadataLogData(metadata[0]!), {
      provider: "copilot",
      kind: "unsupported_event",
      source: "copilot.session_event",
      eventType: "new.event",
      summary: "Unsupported Copilot event: new.event",
      payloadPresent: true,
      payloadRedacted: true,
      payloadType: "object",
    });
    assert.equal("payload" in toProviderMetadataLogData(metadata[0]!), false);
  });

  it("top-level assistant message は arrival 順に空行区切りで連結し、最後の非空 message を保持する", () => {
    const first = applyCopilotAssistantEvent([], "", {
      type: "assistant.message",
      data: {
        content: "最初の案内",
        parentToolCallId: null,
      },
    } as never);
    const second = applyCopilotAssistantEvent(first.messages, first.draft, {
      type: "assistant.message",
      data: {
        content: "次の案内",
        parentToolCallId: null,
      },
    } as never);
    const trailingEmpty = applyCopilotAssistantEvent(second.messages, second.draft, {
      type: "assistant.message",
      data: {
        content: "  ",
        parentToolCallId: null,
      },
    } as never);

    assert.equal(trailingEmpty.assistantText, "最初の案内\n\n次の案内");
    assert.equal(trailingEmpty.lastNonEmptyAssistantMessageText, "次の案内");
  });

  it("delta のあとに同内容の final message が来ても二重化しない", () => {
    const streamed = applyCopilotAssistantEvent([], "", {
      type: "assistant.message_delta",
      data: {
        deltaContent: "進行中メッセージ",
        parentToolCallId: null,
      },
    } as never);
    const finalized = applyCopilotAssistantEvent(streamed.messages, streamed.draft, {
      type: "assistant.message",
      data: {
        content: "進行中メッセージ",
        parentToolCallId: null,
      },
    } as never);

    assert.equal(finalized.assistantText, "進行中メッセージ");
    assert.equal(finalized.messages.length, 1);
    assert.equal(finalized.draft, "");
  });

  it("tool 配下の assistant message は本文へ混ぜない", () => {
    const next = applyCopilotAssistantEvent(["本文"], "", {
      type: "assistant.message",
      data: {
        content: "tool 内メッセージ",
        parentToolCallId: "call-1",
      },
    } as never);

    assert.equal(next.assistantText, "本文");
    assert.deepEqual(next.messages, ["本文"]);
  });

  it("sub-agent の assistant message は本文へ混ぜない", () => {
    const afterDelta = applyCopilotAssistantEvent(["本文"], "", {
      type: "assistant.message_delta",
      agentId: "subagent-1",
      data: {
        deltaContent: "sub-agent の途中経過",
        parentToolCallId: null,
      },
    } as never);
    const afterFinal = applyCopilotAssistantEvent(afterDelta.messages, afterDelta.draft, {
      type: "assistant.message",
      agentId: "subagent-1",
      data: {
        content: "sub-agent の完了報告",
        parentToolCallId: null,
      },
    } as never);

    assert.equal(afterFinal.assistantText, "本文");
    assert.equal(afterFinal.lastNonEmptyAssistantMessageText, "本文");
    assert.deepEqual(afterFinal.messages, ["本文"]);
    assert.equal(afterFinal.draft, "");
  });

  it("session.idle で実行中の background task を掃除する", () => {
    type BackgroundTasksMap = Parameters<typeof applyCopilotBackgroundTaskEvent>[0];
    type LiveBackgroundTask = BackgroundTasksMap extends Map<string, infer Task> ? Task : never;

    const tasks = new Map<string, LiveBackgroundTask>([
      [
        "agent:agent-1",
        {
          id: "agent:agent-1",
          kind: "agent",
          status: "running",
          title: "設計を調べる",
          updatedAt: "2026-04-04T11:59:00.000Z",
        },
      ],
      [
        "shell:shell-1",
        {
          id: "shell:shell-1",
          kind: "shell",
          status: "running",
          title: "npm test --watch",
          updatedAt: "2026-04-04T11:59:30.000Z",
        },
      ],
      [
        "agent:agent-completed",
        {
          id: "agent:agent-completed",
          kind: "agent",
          status: "completed",
          title: "完了済み agent",
          updatedAt: "2026-04-04T11:58:00.000Z",
        },
      ],
    ]);

    const changed = applyCopilotBackgroundTaskEvent(tasks, {
      type: "session.idle",
      timestamp: "2026-04-04T12:00:00.000Z",
      data: {},
    } as never);

    assert.equal(changed, true);
    assert.deepEqual(
      sortLiveBackgroundTasks(tasks.values()).map((task) => ({
        kind: task.kind,
        status: task.status,
        title: task.title,
      })),
      [{ kind: "agent", status: "completed", title: "完了済み agent" }],
    );
  });

  it("system.notification で background agent の完了状態を更新する", () => {
    const tasks = new Map();
    applyCopilotBackgroundTaskEvent(tasks, {
      type: "system.notification",
      timestamp: "2026-04-04T12:00:00.000Z",
      data: {
        content: "<system_notification>idle</system_notification>",
        kind: {
          type: "agent_idle",
          agentId: "agent-1",
          agentType: "task",
          description: "設計を調べる",
        },
      },
    } as never);

    const changed = applyCopilotBackgroundTaskEvent(tasks, {
      type: "system.notification",
      timestamp: "2026-04-04T12:05:00.000Z",
      data: {
        content: "<system_notification>completed</system_notification>",
        kind: {
          type: "agent_completed",
          agentId: "agent-1",
          agentType: "task",
          status: "completed",
          description: "設計を調べる",
          prompt: "repo を調べて要点をまとめる",
        },
      },
    } as never);

    assert.equal(changed, true);
    assert.deepEqual(tasks.get("agent:agent-1"), {
      id: "agent:agent-1",
      kind: "agent",
      status: "completed",
      title: "設計を調べる",
      details: "repo を調べて要点をまとめる",
      updatedAt: "2026-04-04T12:05:00.000Z",
    });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "stale接続のretry判定は開始だけの操作を許可し、取得済み本文・terminal操作・changed filesでは抑止する"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md#Error Handling" }
  // fault = "未確定操作をretry blockerにする、または取得済み結果付きturnを再実行して副作用を重複する"
  // observable = "shouldRetryCopilotTurnの結果"
  // observation_boundary = "component-behavior"
  // scope = "Copilot retry admission"
  // lifecycle = "permanent"
  // impact = "取得済み作業の重複実行を防ぐ"
  // distinction = "取消testと型検査はstale失敗分類とpartial操作の組合せを検査しない"
  // @end-test-value
  it("進行途中の user-visible partial が無い stale connection / missing session だけ retry する", () => {
    const emptyPartial = new ProviderTurnError("Connection is closed.", createPartialResult(), false);
    const withAssistantText = new ProviderTurnError("Connection is closed.", createPartialResult({ assistantText: "4" }), false);
    const missingSession = new ProviderTurnError("SessionNotFound: session not found", createPartialResult(), false);
    const missingSessionCodeOnly = new ProviderTurnError("SessionNotFound", createPartialResult(), false);
    const missingSessionSnakeCase = new ProviderTurnError("session_not_found", createPartialResult(), false);
    const missingSessionWithRawItems = new ProviderTurnError(
      "SessionNotFound: session not found",
      createPartialResult({
        providerMetadata: [{ provider: "copilot", kind: "diagnostic", summary: "SessionNotFound" }],
      }),
      false,
    );
    const missingSessionWithOperation = new ProviderTurnError(
      "SessionNotFound: session not found",
      createPartialResult({
        artifact: { title: "Partial", activitySummary: [], changedFiles: [], runChecks: [], operationTimeline: [{ type: "command_execution", summary: "dir", status: "in_progress" }] },
      }),
      false,
    );
    const missingSessionWithToolStartRawItems = new ProviderTurnError(
      "SessionNotFound: session not found",
      createPartialResult({
        providerMetadata: [{ provider: "copilot", kind: "diagnostic", summary: "SessionNotFound" }],
      }),
      false,
    );

    assert.equal(shouldRetryCopilotTurn(emptyPartial), true);
    assert.equal(shouldRetryCopilotTurn(withAssistantText), false);
    assert.equal(shouldRetryCopilotTurn(missingSession), true);
    assert.equal(shouldRetryCopilotTurn(missingSessionCodeOnly), true);
    assert.equal(shouldRetryCopilotTurn(missingSessionSnakeCase), true);
    assert.equal(shouldRetryCopilotTurn(missingSessionWithRawItems), true);
    assert.equal(shouldRetryCopilotTurn(missingSessionWithToolStartRawItems), true);
    assert.equal(shouldRetryCopilotTurn(missingSessionWithOperation), true);
    for (const operation of [
      { type: "command_execution", summary: "dir", status: "completed" },
      { type: "command_execution", summary: "dir", status: "failed" },
      { type: "command_execution", summary: "dir", status: "canceled" },
    ]) {
      assert.equal(shouldRetryCopilotTurn(new ProviderTurnError("Connection is closed.", createPartialResult({
        artifact: { title: "Partial", activitySummary: [], changedFiles: [], runChecks: [], operationTimeline: [operation] },
      }), false)), false);
    }
    assert.equal(shouldRetryCopilotTurn(new ProviderTurnError("Connection is closed.", createPartialResult({
      artifact: { title: "Partial", activitySummary: [], runChecks: [], changedFiles: [
        { kind: "edit", path: "synthetic.txt", summary: "synthetic.txt updated", diffRows: [] },
      ] },
    }), false)), false);
  });

  it("CopilotAdapter は cached session の SessionNotFound を 1 回だけ internal retry する", async () => {
    const adapter = {
      composePrompt() {
        return EMPTY_PROMPT;
      },
      runSessionTurn: CopilotAdapter.prototype.runSessionTurn,
      runSessionTurnOnce: async () => {
        throw new Error("not replaced");
      },
      resetRecoverableConnection: async () => undefined,
    } as unknown as {
      composePrompt(input: RunSessionTurnInput): ProviderPromptComposition;
      runSessionTurn(input: RunSessionTurnInput): Promise<RunSessionTurnResult>;
      runSessionTurnOnce(input: RunSessionTurnInput, prompt: ProviderPromptComposition): Promise<RunSessionTurnResult>;
      resetRecoverableConnection(input: RunSessionTurnInput): Promise<void>;
    };

    const input = createRunSessionInput({ threadId: "thread-stale" });
    const attempts: string[] = [];
    const resetCalls: string[] = [];
    const expected = createPartialResult({ threadId: "thread-fresh", assistantText: "回復したよ。" });

    adapter.runSessionTurnOnce = async (_input, _prompt) => {
      attempts.push("attempt");
      if (attempts.length === 1) {
        throw new ProviderTurnError("SessionNotFound: session not found", createPartialResult(), false);
      }

      return expected;
    };
    adapter.resetRecoverableConnection = async (nextInput) => {
      resetCalls.push(nextInput.session.id);
    };

    const result = await adapter.runSessionTurn(input);

    assert.equal(result, expected);
    assert.equal(attempts.length, 2);
    assert.deepEqual(resetCalls, [input.session.id]);
  });

  it("CopilotAdapter は SessionNotFound 後に同じ入力で internal retry する", async () => {
    const adapter = {
      composePrompt() {
        return EMPTY_PROMPT;
      },
      runSessionTurn: CopilotAdapter.prototype.runSessionTurn,
      runSessionTurnOnce: async () => {
        throw new Error("not replaced");
      },
      resetRecoverableConnection: async () => undefined,
    } as unknown as {
      composePrompt(input: RunSessionTurnInput): ProviderPromptComposition;
      runSessionTurn(input: RunSessionTurnInput): Promise<RunSessionTurnResult>;
      runSessionTurnOnce(input: RunSessionTurnInput, prompt: ProviderPromptComposition): Promise<RunSessionTurnResult>;
      resetRecoverableConnection(input: RunSessionTurnInput): Promise<void>;
    };

    const attempts: string[] = [];
    const resetCalls: string[] = [];
    const expected = createPartialResult({ threadId: "thread-fresh", assistantText: "回復したよ。" });
    const input: RunSessionTurnInput = createRunSessionInput({ threadId: "thread-stale" });

    adapter.runSessionTurnOnce = async (nextInput) => {
      attempts.push(nextInput.session.threadId);
      if (attempts.length === 1) {
        throw new ProviderTurnError("SessionNotFound: session not found", createPartialResult(), false);
      }

      return expected;
    };
    adapter.resetRecoverableConnection = async (nextInput) => {
      resetCalls.push(nextInput.session.id);
    };

    const result = await adapter.runSessionTurn(input);

    assert.equal(result, expected);
    assert.deepEqual(attempts, ["thread-stale", "thread-stale"]);
    assert.deepEqual(resetCalls, [input.session.id]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "MCP elicitation schema の選択肢と制約を共通live fieldへ保持する"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
  // fault = "Provider別変換の欠落でoneOf・anyOf・scalar制約がlive fieldから失われる"
  // observable = "buildLiveElicitationFieldFromMcpSchemaの返却field"
  // observation_boundary = "component-behavior"
  // scope = "MCP elicitation field conversion"
  // lifecycle = "permanent"
  // @end-test-value
  it("MCP elicitation schema の enum / oneOf / anyOf / number を共通live fieldへ正規化する", () => {
    assert.deepEqual(
      buildLiveElicitationFieldFromMcpSchema("environment", {
        type: "string",
        title: "Environment",
        enum: ["dev", "prod"],
        enumNames: ["Development", "Production"],
        default: "dev",
      }, true),
      {
        type: "select",
        name: "environment",
        title: "Environment",
        description: undefined,
        required: true,
        options: [
          { value: "dev", label: "Development" },
          { value: "prod", label: "Production" },
        ],
        defaultValue: "dev",
      },
    );
    assert.deepEqual(
      buildLiveElicitationFieldFromMcpSchema("targets", {
        type: "array",
        title: "Targets",
        minItems: 1,
        items: {
          anyOf: [
            { const: "web", title: "Web" },
            { const: "desktop", title: "Desktop" },
          ],
        },
      }, false),
      {
        type: "multi-select",
        name: "targets",
        title: "Targets",
        description: undefined,
        required: false,
        options: [
          { value: "web", label: "Web" },
          { value: "desktop", label: "Desktop" },
        ],
        defaultValue: undefined,
        minItems: 1,
        maxItems: undefined,
      },
    );
    assert.deepEqual(
      buildLiveElicitationFieldFromMcpSchema("retries", {
        type: "integer",
        title: "Retries",
        minimum: 0,
        maximum: 3,
        default: 1,
      }, false),
      {
        type: "number",
        numberKind: "integer",
        name: "retries",
        title: "Retries",
        description: undefined,
        required: false,
        defaultValue: 1,
        minimum: 0,
        maximum: 3,
      },
    );
    assert.deepEqual(
      buildLiveElicitationFieldFromMcpSchema("destination", {
        type: "string",
        title: "Destination",
        oneOf: [
          { const: "local", title: "Local machine" },
          { const: "remote", title: "Remote host" },
        ],
        default: "local",
      }, true),
      {
        type: "select",
        name: "destination",
        title: "Destination",
        description: undefined,
        required: true,
        options: [
          { value: "local", label: "Local machine" },
          { value: "remote", label: "Remote host" },
        ],
        defaultValue: "local",
      },
    );
  });

  it("elicitation.requested event を live elicitation request へ変換する", () => {
    const request = buildLiveElicitationRequestFromCopilotEvent("copilot", {
      type: "elicitation.requested",
      data: {
        requestId: "elic-1",
        elicitationSource: "server-a",
        message: "入力してね",
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: {
            projectName: {
              type: "string",
              title: "Project Name",
              minLength: 3,
            },
            confirm: {
              type: "boolean",
              title: "Confirm",
              default: true,
            },
          },
          required: ["projectName"],
        },
      },
    } as never);

    assert.deepEqual(request, {
      requestId: "elic-1",
      provider: "copilot",
      mode: "form",
      message: "入力してね",
      source: "server-a",
      fields: [
        {
          type: "text",
          name: "projectName",
          title: "Project Name",
          description: undefined,
          required: true,
          defaultValue: undefined,
          minLength: 3,
          maxLength: undefined,
          format: undefined,
        },
        {
          type: "boolean",
          name: "confirm",
          title: "Confirm",
          description: undefined,
          required: false,
          defaultValue: true,
        },
      ],
      url: undefined,
    });
  });
});

// @test-value v2
// kind = "invariant"
// claim = "Copilot 多数eventでもunsupported event metadataとassistant全本文を独立して保持する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "多数eventでunsupported metadataまたは本文を失う"
// observable = "実turn resultのproviderMetadata eventTypeとpayload、assistant全文"
// observation_boundary = "public-boundary"
// scope = "Copilot stream owner and final result"
// lifecycle = "permanent"
// impact = "長いturnで履歴の未対応event説明やユーザー応答を失う"
// distinction = "stable raw helperのみではstream metadataの独立保持とfinal接続を確認できない"
// @end-test-value
it("Copilot 多数eventでもnative metadataと全本文を保持する", async () => {
  const listeners = new Set<(event: SessionEvent) => void>();
  const body = "answer".repeat(20000);
  const session = {
    sessionId: "bounded",
    on(listener: (event: SessionEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    async send() {
      const emit = (event: unknown) => { for (const listener of listeners) listener(event as SessionEvent); };
      for (let index = 0; index < 16; index++) emit({ type: "tool.execution_complete", timestamp: "2026-10-05T00:00:00.000Z", data: { toolCallId: String(index), success: true, result: { content: "x".repeat(100000) } } });
      emit({ type: "native.unsupported", timestamp: "2026-10-05T00:00:00.000Z", data: { irrelevant: "not retained" } });
      emit({ type: "assistant.message", data: { messageId: "answer", content: body } });
      emit({ type: "session.idle", data: {} });
    },
    async abort() {},
  };
  const adapter = new CopilotAdapter() as unknown as {
    getSession(): Promise<unknown>;
    fetchProviderQuotaTelemetry(): Promise<null>;
    runSessionTurnOnce(input: RunSessionTurnInput, prompt: ProviderPromptComposition): Promise<RunSessionTurnResult>;
  };
  adapter.getSession = async () => ({ session, selection: { requestedModel: "gpt-4.1", requestedReasoningEffort: "high", resolvedModel: "gpt-4.1", resolvedReasoningEffort: "high" } });
  adapter.fetchProviderQuotaTelemetry = async () => null;
  const completed = await adapter.runSessionTurnOnce(createRunSessionInput(), EMPTY_PROMPT);
  assert.equal(completed.assistantText, body);
  const unsupported = completed.providerMetadata?.filter((metadata) => metadata.kind === "unsupported_event");
  assert.deepEqual(unsupported?.map((metadata) => metadata.eventType), ["native.unsupported"]);
  assert.deepEqual(unsupported?.[0]?.payload, { type: "native.unsupported", timestamp: "2026-10-05T00:00:00.000Z" });
});



// @test-value v2
// kind = "invariant"
// claim = "Copilot final projectionはbinding referenceをassistantと通常artifactから除去する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "binding referenceがassistant本文または操作結果へ漏れる"
// observable = "runSessionTurnのassistantText・artifact・providerMetadata"
// observation_boundary = "public-boundary"
// scope = "Copilot final projectionはbinding reference"
// lifecycle = "permanent"
// impact = "binding referenceが利用者表示または通常履歴へ漏れる"
// distinction = "bootstrap失敗projectionでは通常final projectionを観測しない"
// @end-test-value
it("Copilot final projectionはbinding referenceを通常履歴から除去する", async () => {
  const bindingReference = "opaque-reference-copilot-redaction-probe";
  const input = createRunSessionInput({
    agentRuntimeBinding: {
      bindingId: "binding-redaction",
      bindingReference,
      providerId: "copilot",
      executionGeneration: "generation-redaction",
      transport: "env",
      expiresAt: null,
    },
  });
  const listeners = new Set<(event: SessionEvent) => void>();
  const session = {
    sessionId: "thread-redaction",
    on(listener: (event: SessionEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    async send() {
      const emit = (event: unknown) => { for (const listener of listeners) listener(event as SessionEvent); };
      emit({ type: "tool.execution_start", data: { toolCallId: "command-1", toolName: "shell", arguments: { command: "env" } } });
      emit({ type: "tool.execution_complete", data: { toolCallId: "command-1", success: true, result: { content: `secret=${bindingReference}` } } });
      emit({ type: "assistant.message", data: { messageId: "message-1", content: `answer ${bindingReference}` } });
      emit({ type: "session.idle", data: {} });
      return "sent";
    },
  };
  const adapter = new CopilotAdapter();
  (adapter as unknown as { getSession(): Promise<unknown> }).getSession = async () => ({ session,
    selection: { requestedModel: input.session.model, resolvedModel: input.session.model,
      requestedReasoningEffort: input.session.reasoningEffort, resolvedReasoningEffort: input.session.reasoningEffort } });
  const result = await adapter.runSessionTurn(input);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(bindingReference));
  assert.match(result.assistantText, new RegExp(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER));
  assert.match(result.artifact!.operationTimeline![0].details!, new RegExp(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER));
});

// @test-value v2
// kind = "contract"
// claim = "bootstrap失敗でopaque binding referenceを返却errorと診断metadataから秘匿する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "SDK bootstrap errorを未秘匿で返す"
// observable = "ProviderTurnErrorとpartialResult providerMetadata"
// observation_boundary = "component-behavior"
// scope = "Copilot bootstrap diagnostic redaction"
// lifecycle = "permanent"
// impact = "runtime権限に関連する秘密を診断から漏らす"
// distinction = "正常turn redactor testはbootstrap前の異常経路を通らない"
// @end-test-value
it("Copilot bootstrap失敗診断はbinding referenceを除去する", async () => {
  const bindingReference = "opaque-reference-copilot-bootstrap-redaction-probe";
  const input = createRunSessionInput({
    agentRuntimeBinding: {
      bindingId: "binding-bootstrap-redaction",
      bindingReference,
      providerId: "copilot",
      executionGeneration: "generation-bootstrap-redaction",
      transport: "env",
      expiresAt: null,
    },
  });
  const adapter = new CopilotAdapter() as unknown as {
    getSession(): Promise<never>;
    runSessionTurn(inputValue: RunSessionTurnInput): Promise<RunSessionTurnResult>;
  };
  adapter.getSession = async () => {
    throw new Error(`bootstrap failed: ${bindingReference}`);
  };

  await assert.rejects(
    () => adapter.runSessionTurn(input),
    (error: unknown) => {
      assert.ok(error instanceof ProviderTurnError);
      assert.doesNotMatch(error.message, new RegExp(bindingReference));
      assert.match(error.message, new RegExp(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER));
      assert.doesNotMatch(JSON.stringify(error.partialResult.providerMetadata), new RegExp(bindingReference));
      assert.match(JSON.stringify(error.partialResult.providerMetadata), new RegExp(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER));
      return true;
    },
  );
});

// @test-value v2
// kind = "invariant"
// claim = "Copilot tool errorのmessage/codeはpreview境界の前後でも全文秘匿され、liveと正常・失敗・取消のartifactへ有限な取得結果として渡る"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#Session Flow; src-electron/session/provider-payload-limits.ts#PROVIDER_TEXT_PREVIEW_LIMIT" }
// fault = "tool errorを秘匿前に切り詰めてbinding referenceの末尾欠け断片をliveまたはartifactに漏らす、または通常errorを消す"
// observable = "runSessionTurnのprogress stepsと返却artifact/ProviderTurnError.partialResult.artifactのerror.message/code・details・status"
// observation_boundary = "public-boundary"
// scope = "Copilot SDK tool.execution_completeからliveおよびcompleted/failed/canceled通常artifactへの投影"
// lifecycle = "permanent"
// impact = "runtime権限に関わるsecretが利用者表示・保存履歴へ漏れ、取得済みエラー内容が失われる"
// distinction = "既存final秘匿testは完全なsecretだけを観測し、preview境界の断片漏洩やlive error/codeを検出しない。外部接続なしの有限event列でこの秘匿契約を確認できる"
// risk_tags = ["privacy"]
// @end-test-value
it("Copilot tool errorは秘匿後にpreview化しliveと全terminal artifactを保護する", async () => {
  const limit = 65536;
  const secret = "opaque-reference-copilot-error-boundary-probe";
  const errorTexts = [
    "ordinary tool error",
    "x".repeat(limit - secret.length - 1) + secret + " tail",
    "x".repeat(limit - secret.length + 1) + secret + " tail",
    "x".repeat(limit + 1) + secret + " tail",
  ];
  for (const outcome of ["completed", "failed", "canceled"] as const) {
    const input = createRunSessionInput({ customAgentName: "", agentRuntimeBinding: {
      bindingId: "binding-error-boundary", bindingReference: secret, providerId: "copilot",
      executionGeneration: "generation-error-boundary", transport: "env", expiresAt: null,
    } });
    const listeners = new Set<(event: SessionEvent) => void>();
    const sourceEvents: SessionEvent[] = [];
    const liveOperations = new Map<string, LiveRunStep>();
    const session = {
      sessionId: "thread-error-boundary",
      on(listener: (event: SessionEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
      async send() {
        const emit = (type: string, data: Record<string, unknown>) => {
          const event = { type, data } as SessionEvent;
          sourceEvents.push(event);
          for (const listener of listeners) listener(event);
        };
        for (const [index, text] of errorTexts.entries()) {
          const toolCallId = `error-${index}`;
          emit("tool.execution_start", { toolCallId, toolName: "shell", arguments: { command: "synthetic check" } });
          emit("tool.execution_complete", { toolCallId, success: false, error: { message: text, code: text } });
        }
        if (outcome !== "completed") throw new Error(outcome === "canceled" ? "Abort requested" : "synthetic turn failed");
        emit("session.idle", {});
        return "sent";
      },
    };
    const adapter = new CopilotAdapter();
    (adapter as unknown as { getSession(): Promise<unknown> }).getSession = async () => ({ session,
      selection: { requestedModel: "gpt-4.1", resolvedModel: "gpt-4.1", requestedReasoningEffort: "high", resolvedReasoningEffort: "high" } });
    let result: RunSessionTurnResult;
    try {
      result = await adapter.runSessionTurn(input, (state, changes) => {
        assert.ok(!JSON.stringify(state).includes(secret.slice(0, -1)), "live snapshot leaked a secret fragment");
        for (const step of changes.steps.upserts) liveOperations.set(step.id, step);
      });
      assert.equal(outcome, "completed");
    } catch (error) {
      assert.ok(error instanceof ProviderTurnError);
      assert.notEqual(outcome, "completed");
      assert.equal(error.canceled, outcome === "canceled");
      result = error.partialResult;
    }
    const operations = result.artifact!.operationTimeline!;
    assert.equal(operations.length, errorTexts.length);
    assert.ok(!JSON.stringify(result.artifact).includes(secret.slice(0, -1)), "artifact leaked a secret fragment");
    for (const [index, rawText] of errorTexts.entries()) {
      const sanitized = rawText.replace(secret, PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER);
      const expected = sanitized.length <= limit ? sanitized
        : `${sanitized.slice(0, limit)}\n...[truncated ${sanitized.length - limit} chars; originalLength=${sanitized.length}]`;
      const live = liveOperations.get(`error-${index}`);
      assert.ok(live, "tool completion did not reach live progress");
      for (const operation of [live, operations[index]]) {
        assert.equal(operation.status, "failed");
        assert.deepEqual(operation.error, { message: expected, code: expected });
        assert.equal(operation.details, expected);
        assert.ok(operation.error!.message.length <= limit + 100);
      }
      const source = sourceEvents.find((event) => event.type === "tool.execution_complete" && event.data.toolCallId === `error-${index}`);
      assert.ok(source?.type === "tool.execution_complete");
      assert.deepEqual(source.data.error, { message: rawText, code: rawText }, "SDK event was mutated");
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Copilotは正常結果と取消partialで長文全文・操作結果・未対応event診断を保持しbinding referenceを秘匿する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "長文本文や取得済み操作結果を失う、未対応event診断を落とす、またはbinding referenceをartifact/診断へ残す"
// observable = "正常結果と取消partialResultのassistantText全文・最終非空本文・artifact操作件数/details・秘匿済みproviderMetadata"
// observation_boundary = "public-boundary"
// scope = "copilot-coding-turn long text, partial artifact and diagnostic redaction"
// lifecycle = "permanent"
// impact = "未対応eventの診断情報や取得済み応答が失われ、binding secretが履歴へ漏れる"
// distinction = "helper単体や通常cancelのtestは多数event後の長文全文・操作結果・未対応event診断の秘匿を同じ結果境界で観測しない"
// risk_tags = ["privacy"]
// @end-test-value
it("Copilot 長文でもmetadataと正常・cancel partialを保持する", async () => {
  for (const canceled of [false, true]) {
    const input = createRunSessionInput({ customAgentName: "" });
    const secret = input.agentRuntimeBinding!.bindingReference;
    const listeners = new Set<(event: SessionEvent) => void>();
    let rawEventCount = 0;
    const emit = (type: string, data: Record<string, unknown>, ephemeral = false) => {
      const event = { type, timestamp: "2026-10-05T00:00:00Z", data, ephemeral } as SessionEvent;
      if (!ephemeral && !type.endsWith("_delta")) rawEventCount += 1;
      for (const listener of listeners) listener(event);
    };
    const body = `本文${"あ😀".repeat(180_000)}`;
    const session = {
      sessionId: "raw-retention-thread",
      on(listener: (event: SessionEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
      async send() {
        for (let index = 0; index < 100; index += 1) {
          emit("user.message", { content: `${index}:あ😀\"\n${secret.repeat(2000)}` });
        }
        emit("dropped.ephemeral", {}, true);
        emit("assistant.message_delta", { deltaContent: "delta" });
        emit(`custom.event.${secret}`, {});
        emit("tool.execution_start", { toolCallId: "check", toolName: "shell", arguments: { command: "npm test" } });
        emit("tool.execution_complete", { toolCallId: "check", success: true, result: { content: "passed" } });
        emit("assistant.message", { messageId: "last", content: body });
        if (canceled) throw new Error("Abort requested");
        emit("session.idle", {});
        return "sent";
      },
    };
    const adapter = new CopilotAdapter() as unknown as {
      getSession(): Promise<{ session: CopilotSession; selection: ResolvedModelSelection; client: CopilotClient; clientKey: string }>;
      runSessionTurn(value: RunSessionTurnInput): Promise<RunSessionTurnResult>;
    };
    adapter.getSession = async () => ({ session: session as unknown as CopilotSession, client: {} as CopilotClient,
      clientKey: "fixture", selection: { requestedModel: "gpt-4.1", resolvedModel: "gpt-4.1", requestedReasoningEffort: "high", resolvedReasoningEffort: "high" } });
    let completed: RunSessionTurnResult;
    try {
      completed = await adapter.runSessionTurn(input);
      assert.equal(canceled, false);
    } catch (error) {
      assert.ok(canceled && error instanceof ProviderTurnError && error.canceled);
      completed = error.partialResult;
    }
    assert.equal(completed.assistantText, body);
    assert.equal(completed.lastNonEmptyAssistantMessageText, body);
    assert.equal(completed.artifact!.operationTimeline!.length, 1);
    assert.equal(completed.artifact!.operationTimeline![0].details, "passed");
    assert.equal(completed.artifact?.operationTimeline?.length, 1);
    assert.ok(!JSON.stringify(completed.artifact).includes(secret));
    assert.deepEqual(completed.providerMetadata, [{ provider: "copilot", kind: "unsupported_event", source: "copilot.session_event",
      eventType: `custom.event.${PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER}`,
      summary: `Unsupported Copilot event: custom.event.${PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER}`,
      payload: { type: `custom.event.${PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER}`, timestamp: "2026-10-05T00:00:00Z" },
    }]);
  }
});

it("Session完了後のquota telemetry停止はturn resultを待たせない", async () => {
  const input = createRunSessionInput();
  const prompt = EMPTY_PROMPT;
  const listeners = new Set<(event: { type: string; data: Record<string, unknown> }) => void>();
  const session = {
    sessionId: "thread-quota-background",
    on(listener: (event: { type: string; data: Record<string, unknown> }) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send() {
      for (const listener of listeners) {
        listener({ type: "session.idle", data: {} });
      }
    },
    async abort() {},
  };
  let quotaFetchCalls = 0;
  const adapter = new CopilotAdapter() as unknown as {
    getSession(): Promise<{ session: typeof session; selection: ResolvedModelSelection }>;
    fetchProviderQuotaTelemetry(): Promise<never>;
    buildTurnResult(): Promise<RunSessionTurnResult>;
    runSessionTurnOnce(
      inputValue: RunSessionTurnInput,
      promptValue: ProviderPromptComposition,
    ): Promise<RunSessionTurnResult>;
  };
  adapter.getSession = async () => ({
    session,
    selection: {
      requestedModel: "gpt-4.1",
      requestedReasoningEffort: "high",
      resolvedModel: "gpt-4.1",
      resolvedReasoningEffort: "high",
      modelFallbackApplied: false,
      reasoningFallbackApplied: false,
    },
  });
  adapter.fetchProviderQuotaTelemetry = () => {
    quotaFetchCalls += 1;
    return new Promise<never>(() => undefined);
  };
  adapter.buildTurnResult = async () => createPartialResult({
    threadId: session.sessionId,
    assistantText: "完了",
  });

  const outcome = await Promise.race([
    adapter.runSessionTurnOnce(input, prompt),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
  ]);

  assert.notEqual(outcome, "timeout");
  assert.equal(quotaFetchCalls, 0);
  assert.equal((outcome as RunSessionTurnResult).assistantText, "完了");
});

describe("CopilotAdapter session settings", () => {
  it("max / ultra は Copilot SDK 境界で拒否する", () => {
    assert.throws(() => toCopilotReasoningEffort("max"), /max/);
    assert.throws(() => toCopilotReasoningEffort("ultra"), /ultra/);
    assert.equal(toCopilotReasoningEffort("minimal"), "low");
  });

  it("custom agent 変更後の session settings は新 agent 情報を反映する", () => {
    const previousInput = createRunSessionInput({ customAgentName: "reviewer", threadId: "thread-1" });
    const nextInput = createRunSessionInput({ customAgentName: "planner", threadId: "thread-1" });
    const previousSettings = buildCopilotSessionSettings(previousInput, EMPTY_PROMPT, "client-key", resolveCustomAgents);
    const nextSettings = buildCopilotSessionSettings(nextInput, EMPTY_PROMPT, "client-key", resolveCustomAgents);

    assert.notEqual(previousSettings.settingsKey, nextSettings.settingsKey);
    assert.equal(nextSettings.config.agent, "planner");
    assert.deepEqual(nextSettings.config.customAgents, CUSTOM_AGENT_CONFIGS);
  });

  it("model / reasoning 変更後の session settings は新 config を反映する", () => {
    const previousInput = createRunSessionInput({
      customAgentName: "reviewer",
      threadId: "thread-1",
      model: "gpt-4.1",
      reasoningEffort: "high",
    });
    const nextInput = createRunSessionInput({
      customAgentName: "reviewer",
      threadId: "thread-1",
      model: "gpt-4.1-mini",
      reasoningEffort: "low",
    });
    const previousSettings = buildCopilotSessionSettings(previousInput, EMPTY_PROMPT, "client-key", resolveCustomAgents);
    const nextSettings = buildCopilotSessionSettings(nextInput, EMPTY_PROMPT, "client-key", resolveCustomAgents);

    assert.notEqual(previousSettings.settingsKey, nextSettings.settingsKey);
    assert.equal(nextSettings.config.agent, "reviewer");
    assert.equal(nextSettings.config.model, "gpt-4.1-mini");
    assert.equal(nextSettings.config.reasoningEffort, "low");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Copilot session settingsは保存済みSessionの実行欄ではなくturn送信値をSDK configとcache keyへ使う"
  // oracle = { type = "contract", ref = "Issue #738 turn execution options boundary" }
  // fault = "Sessionのmodel/depth/approval/custom agentを再取得して送信値を無視する"
  // observable = "SessionConfigとsettingsKey"
  // observation_boundary = "component-behavior"
  // scope = "Copilot foreground session settings"
  // lifecycle = "permanent"
  // impact = "表示選択と異なるmodelまたはagentでCopilot turnを実行する"
  // distinction = "既存testはSessionと送信値が一致しており二つの入力源を区別しない"
  // @end-test-value
  it("保存済みSession Aに対して送信値BをCopilot session settingsへ使う", () => {
    const input = createRunSessionInput({ model: "gpt-4.1", reasoningEffort: "high", customAgentName: "reviewer" });
    input.executionOptions = { ...input.executionOptions, model: "gpt-4.1-mini", reasoningEffort: "low", approvalMode: "never", customAgentName: "planner" };
    const settings = buildCopilotSessionSettings(input, EMPTY_PROMPT, "client-key", resolveCustomAgents);
    assert.equal(settings.config.model, "gpt-4.1-mini");
    assert.equal(settings.config.reasoningEffort, "low");
    assert.equal(settings.config.agent, "planner");
    assert.match(settings.settingsKey, /never/);
    assert.match(settings.settingsKey, /planner/);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Copilot の system 側 prompt context 変更は session settings key を分け、input 側 Conversation Timing 変更は同じ key を使う"
  // oracle = { type = "contract", ref = "Copilot prompt cache boundary" }
  // fault = "system message の切替で古い session を再利用するか、timing の変化だけで不要な session 再接続を起こす"
  // observable = "buildCopilotSessionSettings の settingsKey と systemMessage"
  // observation_boundary = "consumer"
  // scope = "copilot-system-prompt-cache-key"
  // lifecycle = "permanent"
  // impact = "Prompt Context 設定変更後の provider session が誤った固定 system prompt を使う、または毎 turn 再接続する"
  // distinction = "既存の model / agent cache key test とは別に system/input の境界を直接確認する"
  // @end-test-value
  it("system prompt context の変更だけを Copilot session cache key に反映する", () => {
    const input = createRunSessionInput({ threadId: "thread-1" });
    const promptWithContext: ProviderPromptComposition = {
      ...EMPTY_PROMPT,
      systemBodyText: "# Character Affect Context\n\n{}\n\n# Tool Call Presence\n\nreply first",
    };
    const promptWithoutContext: ProviderPromptComposition = {
      ...promptWithContext,
      systemBodyText: "",
    };
    const promptWithLaterTiming: ProviderPromptComposition = {
      ...promptWithContext,
      inputBodyText: "# Conversation Timing\n\n- Observed local time: later\n\n# User Input\n\nhello",
    };

    const withContext = buildCopilotSessionSettings(input, promptWithContext, "client-key", resolveCustomAgents);
    const withoutContext = buildCopilotSessionSettings(input, promptWithoutContext, "client-key", resolveCustomAgents);
    const withLaterTiming = buildCopilotSessionSettings(input, promptWithLaterTiming, "client-key", resolveCustomAgents);

    assert.notEqual(withContext.settingsKey, withoutContext.settingsKey);
    assert.equal(withLaterTiming.settingsKey, withContext.settingsKey);
    assert.equal(withContext.config.systemMessage?.content, promptWithContext.systemBodyText);
    assert.equal(withLaterTiming.config.systemMessage?.content, promptWithContext.systemBodyText);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "never approvalはCopilot write permission requestをapprove-onceへ変換する"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md#Approval-Modes" }
  // fault = "never送信値を無視してwriteを拒否する"
  // observable = "onPermissionRequestのdecision"
  // observation_boundary = "component-behavior"
  // scope = "allow-all permission handler"
  // lifecycle = "permanent"
  // impact = "選択したpermission policyと実行が食い違う"
  // distinction = "untrusted/on-requestのpermission testとは異なるpolicy branch"
  // @end-test-value
  it("allow-all permission handler は legacy approve-once を返す", async () => {
    const input = createRunSessionInput();
    input.session.approvalMode = "never";
    input.executionOptions = captureSessionExecutionOptions(input.session);
    const settings = buildCopilotSessionSettings(input, EMPTY_PROMPT, "client-key", resolveCustomAgents);

    assert.ok(settings.config.onPermissionRequest);
    await assert.doesNotReject(async () => {
      const result = await settings.config.onPermissionRequest?.(createWritePermissionRequest(), { sessionId: "session-1" });
      assert.deepEqual(result, { kind: "approve-once" });
    });
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "untrusted approvalはreadを許可しwriteを拒否する"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md#Approval-Modes" }
  // fault = "readを拒否またはwriteを許可する"
  // observable = "read/write requestごとのpermission decision"
  // observation_boundary = "component-behavior"
  // scope = "safety permission handler"
  // lifecycle = "permanent"
  // impact = "安全設定でwriteを許してしまう"
  // distinction = "never/on-requestのpermission testとは異なるpolicy branch"
  // @end-test-value
  it("safety permission handler は read を legacy approve-once / write を reject で返す", async () => {
    const input = createRunSessionInput();
    input.session.approvalMode = "untrusted";
    input.executionOptions = captureSessionExecutionOptions(input.session);
    const settings = buildCopilotSessionSettings(input, EMPTY_PROMPT, "client-key", resolveCustomAgents);

    assert.ok(settings.config.onPermissionRequest);
    const readResult = await settings.config.onPermissionRequest?.(createReadPermissionRequest(), { sessionId: "session-1" });
    const writeResult = await settings.config.onPermissionRequest?.(createWritePermissionRequest(), { sessionId: "session-1" });

    assert.deepEqual(readResult, { kind: "approve-once" });
    assert.deepEqual(writeResult, { kind: "reject" });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "provider-controlled permissionはapproval callbackのapprove/denyとhandler不在をlegacy kindへ変換する"
  // oracle = { type = "contract", ref = "src-electron/providers/copilot/copilot-adapter.ts: permission handler" }
  // fault = "approval decisionを誤変換し、provider permissionを許可または拒否できない"
  // observable = "approval callback入力と返却legacy kind"
  // observation_boundary = "public-boundary"
  // scope = "copilot-provider-permission"
  // lifecycle = "permanent"
  // distinction = "通常turnの成功では検出できないprovider-controlled permission境界を検証する"
  // @end-test-value
  it("provider-controlled permission handler は approval callback 経由の approve / deny と handler 不在を legacy kind へ橋渡しする", async () => {
    const approvedInput = createRunSessionInput();
    const bindingReference = approvedInput.agentRuntimeBinding?.bindingReference ?? "";
    approvedInput.session.approvalMode = "on-request";
    approvedInput.executionOptions = captureSessionExecutionOptions(approvedInput.session);
    const approvalRequests: unknown[] = [];
    approvedInput.onApprovalRequest = async (request) => {
      approvalRequests.push(request);
      return "approve" as LiveApprovalDecision;
    };
    const approvedSettings = buildCopilotSessionSettings(approvedInput, EMPTY_PROMPT, "client-key", resolveCustomAgents);

    assert.ok(approvedSettings.config.onPermissionRequest);
    const readResult = await approvedSettings.config.onPermissionRequest?.(createReadPermissionRequest(), { sessionId: "session-1" });
    const approvedWriteResult = await approvedSettings.config.onPermissionRequest?.({
      ...createWritePermissionRequest(),
      intention: `Create ${bindingReference}`,
      fileName: `F:/repo/${bindingReference}.txt`,
    } as PermissionRequest, { sessionId: "session-1" });
    assert.deepEqual(readResult, { kind: "approve-once" });
    assert.deepEqual(approvedWriteResult, { kind: "approve-once" });
    assert.equal(approvalRequests.length, 1);
    assert.doesNotMatch(JSON.stringify(approvalRequests), new RegExp(bindingReference));
    assert.match(JSON.stringify(approvalRequests), new RegExp(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER));

    const deniedInput = createRunSessionInput();
    deniedInput.session.approvalMode = "on-request";
    deniedInput.executionOptions = captureSessionExecutionOptions(deniedInput.session);
    deniedInput.onApprovalRequest = async () => "deny" as LiveApprovalDecision;
    const deniedSettings = buildCopilotSessionSettings(deniedInput, EMPTY_PROMPT, "client-key", resolveCustomAgents);
    const deniedWriteResult = await deniedSettings.config.onPermissionRequest?.(createWritePermissionRequest(), { sessionId: "session-1" });
    assert.deepEqual(deniedWriteResult, { kind: "reject" });

    const missingHandlerInput = createRunSessionInput();
    missingHandlerInput.session.approvalMode = "on-request";
    missingHandlerInput.executionOptions = captureSessionExecutionOptions(missingHandlerInput.session);
    const missingHandlerSettings = buildCopilotSessionSettings(missingHandlerInput, EMPTY_PROMPT, "client-key", resolveCustomAgents);
    const missingHandlerResult = await missingHandlerSettings.config.onPermissionRequest?.(createWritePermissionRequest(), { sessionId: "session-1" });
    assert.deepEqual(missingHandlerResult, { kind: "user-not-available" });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Copilotの同一request objectは判断を共有し、同じtoolCallIdやsummaryの別要求は会話内FIFOで個別判断する"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md: SessionApprovalService" }
  // fault = "toolCallIdまたはsummaryの一致で別要求をまとめるか、後続要求が先頭表示を上書きしてcallbackを未解決にする"
  // observable = "live approvalRequest、通知request ID、全permission callbackのapprove-once/reject結果"
  // observation_boundary = "consumer"
  // scope = "Copilot permission handlerと実SessionApprovalServiceの接続"
  // lifecycle = "permanent"
  // impact = "別の操作へ許可が流用される、または同時要求でprovider turnが承認待ちのまま停止する"
  // distinction = "service単体testやcallback mockではredaction前のrequest同一性とprovider返却値までの接続を検出できず、外部SDK接続なしの短いtestで認可境界を保護する"
  // risk_tags = ["authorization"]
  // @end-test-value
  it("Copilot permission は同一要求を共有し、別要求を FIFO で承認・拒否・resetする", async () => {
    const input = createRunSessionInput();
    input.session.approvalMode = "on-request";
    input.executionOptions = captureSessionExecutionOptions(input.session);
    let state: LiveSessionRunState = {
      sessionId: input.session.id,
      threadId: "thread-1",
      assistantText: "",
      steps: [],
      backgroundTasks: [],
      usage: null,
      errorMessage: "",
      approvalRequest: null,
      elicitationRequest: null,
    };
    const notifications: string[] = [];
    const requests: LiveApprovalRequest[] = [];
    const controller = new AbortController();
    const service = new SessionApprovalService({
      updateLiveSessionRun: (_sessionId, recipe) => {
        state = recipe(state);
        return state;
      },
      notifyApproval: (_sessionId, requestId) => { notifications.push(requestId); },
    });
    input.onApprovalRequest = (request) => {
      requests.push(request);
      return service.waitForLiveApprovalDecision(input.session.id, request, controller.signal);
    };
    const settings = buildCopilotSessionSettings(input, EMPTY_PROMPT, "client-key", resolveCustomAgents);
    const handler = settings.config.onPermissionRequest;
    assert.ok(handler);
    const requestA = createWritePermissionRequest();
    const requestB = { ...createWritePermissionRequest(), fileName: "F:/repo/other.txt" } as PermissionRequest;
    const requestC = { ...requestA, toolCallId: undefined } as PermissionRequest;
    const context = { sessionId: "session-1" };
    const decisions = [
      handler(requestA, context),
      handler(requestA, context),
      handler(requestB, context),
      handler(requestC, context),
    ];
    const [approvalA, duplicateA, approvalB, approvalC] = requests;
    assert.ok(approvalA && duplicateA && approvalB && approvalC);
    assert.equal(approvalA.requestId, duplicateA.requestId);
    assert.equal(new Set([approvalA.requestId, approvalB.requestId, approvalC.requestId]).size, 3);
    assert.equal(approvalA.summary, approvalC.summary);
    assert.equal(state.approvalRequest?.requestId, approvalA.requestId);
    assert.deepEqual(notifications, [approvalA.requestId]);

    service.resolveLiveApproval(input.session.id, approvalA.requestId, "approve");
    assert.equal(state.approvalRequest?.requestId, approvalB.requestId);
    assert.deepEqual(notifications, [approvalA.requestId, approvalB.requestId]);
    service.resolveLiveApproval(input.session.id, approvalB.requestId, "deny");
    assert.equal(state.approvalRequest?.requestId, approvalC.requestId);
    assert.deepEqual(notifications, [approvalA.requestId, approvalB.requestId, approvalC.requestId]);
    service.reset();
    assert.equal(state.approvalRequest, null);
    assert.deepEqual(await Promise.all(decisions), [
      { kind: "approve-once" },
      { kind: "approve-once" },
      { kind: "reject" },
      { kind: "reject" },
    ]);
  });

  it("threadId がある custom agent 切り替え後は createSession ではなく resumeSession を使う", async () => {
    const previousInput = createRunSessionInput({ customAgentName: "reviewer", threadId: "thread-1" });
    const nextInput = createRunSessionInput({ customAgentName: "planner", threadId: "thread-1" });
    const previousSettings = buildCopilotSessionSettings(previousInput, EMPTY_PROMPT, "client-key", resolveCustomAgents);
    const nextSettings = buildCopilotSessionSettings(nextInput, EMPTY_PROMPT, "client-key", resolveCustomAgents);
    const cachedDisconnectCalls: string[] = [];
    const resumeCalls: Array<{
      threadId: string;
      config: {
        agent?: string;
        customAgents?: Array<{ name: string; prompt: string }>;
      };
    }> = [];
    const createCalls: unknown[] = [];
    const resumedSession = {
      disconnect: async () => undefined,
    } as never;

    assert.notEqual(previousSettings.settingsKey, nextSettings.settingsKey);

    const result = await resolveCopilotSessionForSettings({
      cached: {
        session: {
          disconnect: async () => {
            cachedDisconnectCalls.push("disconnect");
          },
        } as never,
        settingsKey: previousSettings.settingsKey,
      },
      nextSettingsKey: nextSettings.settingsKey,
      threadId: nextInput.session.threadId,
      config: nextSettings.config,
      client: {
        resumeSession: async (threadId: string, config: { agent?: string; customAgents?: Array<{ name: string; prompt: string }> }) => {
          resumeCalls.push({ threadId, config });
          return resumedSession;
        },
        createSession: async (config: unknown) => {
          createCalls.push(config);
          return resumedSession;
        },
      },
    });

    assert.equal(result.session, resumedSession);
    assert.equal(result.reusedCached, false);
    assert.equal(createCalls.length, 0);
    assert.equal(resumeCalls.length, 1);
    assert.deepEqual(cachedDisconnectCalls, ["disconnect"]);
    assert.equal(resumeCalls[0]?.threadId, "thread-1");
    assert.equal(resumeCalls[0]?.config.agent, "planner");
    assert.deepEqual(resumeCalls[0]?.config.customAgents, CUSTOM_AGENT_CONFIGS);
  });

  it("threadId がある model / reasoning 変更後は新 config 付き resumeSession を使う", async () => {
    const previousInput = createRunSessionInput({
      customAgentName: "reviewer",
      threadId: "thread-1",
      model: "gpt-4.1",
      reasoningEffort: "high",
    });
    const nextInput = createRunSessionInput({
      customAgentName: "reviewer",
      threadId: "thread-1",
      model: "gpt-4.1-mini",
      reasoningEffort: "low",
    });
    const previousSettings = buildCopilotSessionSettings(previousInput, EMPTY_PROMPT, "client-key", resolveCustomAgents);
    const nextSettings = buildCopilotSessionSettings(nextInput, EMPTY_PROMPT, "client-key", resolveCustomAgents);
    const cachedDisconnectCalls: string[] = [];
    const resumeCalls: Array<{
      threadId: string;
      config: {
        agent?: string;
        model?: string;
        reasoningEffort?: string;
      };
    }> = [];
    const createCalls: unknown[] = [];
    const resumedSession = {
      disconnect: async () => undefined,
    } as never;

    assert.notEqual(previousSettings.settingsKey, nextSettings.settingsKey);

    const result = await resolveCopilotSessionForSettings({
      cached: {
        session: {
          disconnect: async () => {
            cachedDisconnectCalls.push("disconnect");
          },
        } as never,
        settingsKey: previousSettings.settingsKey,
      },
      nextSettingsKey: nextSettings.settingsKey,
      threadId: nextInput.session.threadId,
      config: nextSettings.config,
      client: {
        resumeSession: async (threadId: string, config: { model?: string; reasoningEffort?: string }) => {
          resumeCalls.push({ threadId, config });
          return resumedSession;
        },
        createSession: async (config: unknown) => {
          createCalls.push(config);
          return resumedSession;
        },
      },
    });

    assert.equal(result.session, resumedSession);
    assert.equal(result.reusedCached, false);
    assert.equal(createCalls.length, 0);
    assert.equal(resumeCalls.length, 1);
    assert.deepEqual(cachedDisconnectCalls, ["disconnect"]);
    assert.equal(resumeCalls[0]?.threadId, "thread-1");
    assert.equal(resumeCalls[0]?.config.agent, "reviewer");
    assert.equal(resumeCalls[0]?.config.model, "gpt-4.1-mini");
    assert.equal(resumeCalls[0]?.config.reasoningEffort, "low");
  });

  it("threadId が失効して SessionNotFound が返った時は createSession に fallback する", async () => {
    const input = createRunSessionInput({
      customAgentName: "reviewer",
      threadId: "thread-stale",
    });
    const settings = buildCopilotSessionSettings(input, EMPTY_PROMPT, "client-key", resolveCustomAgents);
    const resumeCalls: string[] = [];
    const createCalls: unknown[] = [];
    const createdSession = {
      disconnect: async () => undefined,
    } as never;

    const result = await resolveCopilotSessionForSettings({
      cached: undefined,
      nextSettingsKey: settings.settingsKey,
      threadId: input.session.threadId,
      config: settings.config,
      client: {
        resumeSession: async (threadId: string) => {
          resumeCalls.push(threadId);
          throw new Error("SessionNotFound: session not found");
        },
        createSession: async (config: unknown) => {
          createCalls.push(config);
          return createdSession;
        },
      },
    });

    assert.equal(result.session, createdSession);
    assert.equal(result.reusedCached, false);
    assert.deepEqual(resumeCalls, ["thread-stale"]);
    assert.equal(createCalls.length, 1);
  });

  it("threadId がある model 変更後でも stale session なら createSession に fallback する", async () => {
    const previousInput = createRunSessionInput({
      customAgentName: "reviewer",
      threadId: "thread-1",
      model: "gpt-4.1",
      reasoningEffort: "high",
    });
    const nextInput = createRunSessionInput({
      customAgentName: "reviewer",
      threadId: "thread-1",
      model: "gpt-4.1-mini",
      reasoningEffort: "low",
    });
    const previousSettings = buildCopilotSessionSettings(previousInput, EMPTY_PROMPT, "client-key", resolveCustomAgents);
    const nextSettings = buildCopilotSessionSettings(nextInput, EMPTY_PROMPT, "client-key", resolveCustomAgents);
    const cachedDisconnectCalls: string[] = [];
    const resumeCalls: Array<{ threadId: string; model?: string; reasoningEffort?: string }> = [];
    const createCalls: Array<{ model?: string; reasoningEffort?: string }> = [];
    const createdSession = {
      disconnect: async () => undefined,
    } as never;

    assert.notEqual(previousSettings.settingsKey, nextSettings.settingsKey);

    const result = await resolveCopilotSessionForSettings({
      cached: {
        session: {
          disconnect: async () => {
            cachedDisconnectCalls.push("disconnect");
          },
        } as never,
        settingsKey: previousSettings.settingsKey,
      },
      nextSettingsKey: nextSettings.settingsKey,
      threadId: nextInput.session.threadId,
      config: nextSettings.config,
      client: {
        resumeSession: async (threadId: string, config: { model?: string; reasoningEffort?: string }) => {
          resumeCalls.push({
            threadId,
            model: config.model,
            reasoningEffort: config.reasoningEffort,
          });
          throw new Error("SessionNotFound: session not found");
        },
        createSession: async (config: { model?: string; reasoningEffort?: string }) => {
          createCalls.push({
            model: config.model,
            reasoningEffort: config.reasoningEffort,
          });
          return createdSession;
        },
      },
    });

    assert.equal(result.session, createdSession);
    assert.equal(result.reusedCached, false);
    assert.deepEqual(cachedDisconnectCalls, ["disconnect"]);
    assert.deepEqual(resumeCalls, [
      {
        threadId: "thread-1",
        model: "gpt-4.1-mini",
        reasoningEffort: "low",
      },
    ]);
    assert.deepEqual(createCalls, [
      {
        model: "gpt-4.1-mini",
        reasoningEffort: "low",
      },
    ]);
  });

  it("threadId があっても unrelated error は createSession へ握りつぶさない", async () => {
    const input = createRunSessionInput({
      customAgentName: "reviewer",
      threadId: "thread-stale",
    });
    const settings = buildCopilotSessionSettings(input, EMPTY_PROMPT, "client-key", resolveCustomAgents);
    const createCalls: unknown[] = [];

    await assert.rejects(
      resolveCopilotSessionForSettings({
        cached: undefined,
        nextSettingsKey: settings.settingsKey,
        threadId: input.session.threadId,
        config: settings.config,
        client: {
          resumeSession: async () => {
            throw new Error("Permission denied");
          },
          createSession: async (config: unknown) => {
            createCalls.push(config);
            return {
              disconnect: async () => undefined,
            } as never;
          },
        },
      }),
      /Permission denied/,
    );

    assert.equal(createCalls.length, 0);
  });
});

describe("CopilotAdapter permission.completed live status", () => {
  it("approval を表す result kind は live step を in_progress 扱いにする", () => {
    for (const kind of [
      "approved",
      "approve-once",
      "approve-for-session",
      "approve-for-location",
      "approved-for-session",
      "approved-for-location",
    ]) {
      assert.equal(getCopilotPermissionCompletedLiveStatus(kind), "in_progress");
    }
  });

  it("非 approval の result kind は live step を failed 扱いにする", () => {
    for (const kind of [
      "reject",
      "user-not-available",
      "denied-interactively-by-user",
      "denied-no-approval-rule-and-could-not-request-from-user",
      "denied-by-rules",
      "denied-by-content-exclusion-policy",
    ]) {
      assert.equal(getCopilotPermissionCompletedLiveStatus(kind), "failed");
    }
  });
});
