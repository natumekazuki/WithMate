import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import type { PermissionRequest } from "@github/copilot-sdk";

import {
  buildNewSession,
  createDefaultSessionMemory,
  type LiveRunStep,
} from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import type { ModelCatalogProvider, ResolvedModelSelection } from "../../src/model-catalog.js";
import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import {
  applyCopilotAssistantEvent,
  applyCopilotBackgroundTaskEvent,
  CopilotAdapter,
  buildLiveElicitationFieldFromCopilotSchema,
  buildLiveElicitationRequestFromCopilotEvent,
  buildCopilotSessionSettings,
  buildCopilotMessageAttachments,
  buildCopilotProviderQuotaTelemetry,
  buildCopilotProviderMetadata,
  collectCopilotAuditOperationsFromEventsForTesting,
  collectCopilotLiveStepsFromEventsForTesting,
  collectCopilotReasoningTextFromEventsForTesting,
  getCopilotPermissionCompletedLiveStatus,
  buildCopilotSessionContextTelemetry,
  buildCopilotSystemMessage,
  buildCopilotStableRawItems,
  buildCopilotToolSummary,
  buildCopilotClientEnv,
  isCopilotVisibleToolName,
  isRecoverableCopilotConnectionErrorMessage,
  resolveCopilotCliPath,
  resolveCopilotSessionForSettings,
  resolveNativeCopilotPackageName,
  shouldRetryCopilotTurn,
  sortLiveBackgroundTasks,
  toProviderQuotaSnapshots,
  toCopilotReasoningEffort,
} from "../../src-electron/copilot-adapter.js";
import { toProviderMetadataLogData } from "../../src-electron/provider-metadata-log.js";
import {
  PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER,
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV,
} from "../../src-electron/provider-agent-runtime-binding.js";
import { createDisabledWorkspaceSnapshotCapture } from "../../src-electron/workspace-diff-policy.js";
import {
  ProviderTurnError,
  type RunBackgroundStructuredPromptInput,
  type ProviderPromptComposition,
  type RunSessionTurnInput,
  type RunSessionTurnResult,
} from "../../src-electron/provider-runtime.js";

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
    logicalPrompt: {
      systemText: "",
      inputText: "",
      composedText: "",
    },
    transportPayload: null,
    operations: [],
    rawItemsJson: "[]",
    usage: null,
    ...overrides,
  };
}

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

function createBackgroundPromptInput(
  overrides?: Partial<RunBackgroundStructuredPromptInput>,
): RunBackgroundStructuredPromptInput {
  const session = buildNewSession({
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
    model: "gpt-4.1",
    reasoningEffort: "high",
    customAgentName: "reviewer",
  });

  return {
    providerId: "copilot",
    workspacePath: session.workspacePath,
    appSettings: createDefaultAppSettings(),
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    timeoutMs: 10000,
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

  it("Copilot child CLIへSession generationごとのopaque referenceだけを渡す", () => {
    const binding = {
      bindingId: "binding-a",
      bindingReference: "opaque-reference-a",
      providerId: "copilot",
      executionGeneration: "generation-a",
      transport: "env" as const,
      expiresAt: null,
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
    assert.equal(boundEnv.PATH, "test-path");
    assert.equal("EMPTY" in boundEnv, false);
    assert.equal(unboundEnv[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV], undefined);
    assert.equal(unboundEnv[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV.toLowerCase()], undefined);
  });

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
    };
    const bindingB = {
      ...bindingA,
      bindingId: "binding-b",
      bindingReference: "opaque-reference-b",
      executionGeneration: "generation-b",
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
    assert.equal(backgroundClient.resolvedEnv[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV], undefined);
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
    let releaseDisconnect = () => undefined;
    const disconnectBarrier = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });
    let signalDisconnectStarted = () => undefined;
    const disconnectStarted = new Promise<void>((resolve) => {
      signalDisconnectStarted = resolve;
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
    const input = createRunSessionInput({ customAgentName: "", threadId: "" });

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
    const input = createRunSessionInput({ customAgentName: "" });

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

  it("character prompt だけをCopilot systemMessageへ変換し、可変timingはinput側に留める", () => {
    const systemMessage = buildCopilotSystemMessage({
      systemBodyText: "あなたは頼れる相棒です。",
      inputBodyText: "# Conversation Timing\n\n- Observed local time: 2026-08-04T21:32:00+09:00\n\n# User Input\n\nhello",
      logicalPrompt: {
        systemText: "# System Prompt\n\nあなたは頼れる相棒です。",
        inputText: "# User Input Prompt\n\nhello",
        composedText: "# System Prompt\n\nあなたは頼れる相棒です。\n\n# User Input Prompt\n\nhello",
      },
      imagePaths: [],
      additionalDirectories: [],
    });

    assert.deepEqual(systemMessage, {
      mode: "append",
      content: "あなたは頼れる相棒です。",
    });
    assert.doesNotMatch(systemMessage?.content ?? "", /Conversation Timing|2026-08-04/);
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

  it("rawItems は delta / ephemeral を落として stable event だけ残す", () => {
    const items = buildCopilotStableRawItems([
      {
        type: "assistant.message_delta",
        timestamp: "2026-03-23T00:00:00.000Z",
        data: {
          deltaContent: "he",
        },
      } as never,
      {
        type: "permission.requested",
        timestamp: "2026-03-23T00:00:01.000Z",
        data: {
          requestId: "req-1",
          permissionRequest: {
            kind: "write",
            intention: "Create file",
            fileName: "F:/repo/tmp/output.txt",
          },
        },
        ephemeral: true,
      } as never,
      {
        type: "tool.execution_start",
        timestamp: "2026-03-23T00:00:02.000Z",
        data: {
          toolCallId: "call-1",
          toolName: "create",
          arguments: {
            path: "F:/repo/tmp/output.txt",
          },
        },
      } as never,
      {
        type: "tool.execution_complete",
        timestamp: "2026-03-23T00:00:03.000Z",
        data: {
          toolCallId: "call-1",
          success: true,
          result: {
            content: "Created file",
            detailedContent: "huge diff",
          },
        },
      } as never,
      {
        type: "assistant.message",
        timestamp: "2026-03-23T00:00:04.000Z",
        data: {
          content: "done",
          parentToolCallId: undefined,
        },
      } as never,
    ], "F:/repo");

    assert.deepEqual(items, [
      {
        type: "tool.execution_start",
        timestamp: "2026-03-23T00:00:02.000Z",
        data: {
          toolCallId: "call-1",
          toolName: "create",
          summary: "create tmp/output.txt",
        },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-03-23T00:00:03.000Z",
        data: {
          toolCallId: "call-1",
          toolName: "create",
          success: true,
          content: "Created file",
          errorMessage: null,
        },
      },
      {
        type: "assistant.message",
        timestamp: "2026-03-23T00:00:04.000Z",
        data: {
          content: "done",
          parentToolCallId: null,
        },
      },
    ]);
  });

  it("assistant.reasoning / reasoning_delta は rawItems に残さない", () => {
    const items = buildCopilotStableRawItems([
      {
        type: "assistant.reasoning_delta",
        timestamp: "2026-03-23T00:00:00.000Z",
        ephemeral: true,
        data: {
          reasoningId: "reasoning-1",
          deltaContent: "調査",
        },
      } as never,
      {
        type: "assistant.reasoning",
        timestamp: "2026-03-23T00:00:01.000Z",
        data: {
          reasoningId: "reasoning-1",
          content: "調査してから実装する",
        },
      } as never,
    ], "F:/repo");

    assert.deepEqual(items, []);
  });

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
    assert.deepEqual(collectCopilotAuditOperationsFromEventsForTesting(events, "F:/repo"), []);
    assert.equal(collectCopilotReasoningTextFromEventsForTesting(events, "F:/repo"), "調査してから実装する");
  });

  it("rawItems の大きな text payload は preview と metadata に畳み込む", () => {
    const longContent = "x".repeat(70 * 1024);
    const items = buildCopilotStableRawItems([
      {
        type: "assistant.message",
        timestamp: "2026-03-23T00:00:00.000Z",
        data: {
          content: longContent,
          parentToolCallId: undefined,
        },
      } as never,
    ], "F:/repo");

    const content = items[0]?.data?.content as {
      text: string;
      truncated: true;
      originalLength: number;
    };

    assert.equal(content.truncated, true);
    assert.equal(content.originalLength, longContent.length);
    assert.equal(content.text.includes("...[truncated "), true);
    assert.equal(content.text.length < longContent.length, true);
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

  it("進行途中の user-visible partial が無い stale connection / missing session だけ retry する", () => {
    const emptyPartial = new ProviderTurnError("Connection is closed.", createPartialResult(), false);
    const withAssistantText = new ProviderTurnError("Connection is closed.", createPartialResult({ assistantText: "4" }), false);
    const missingSession = new ProviderTurnError("SessionNotFound: session not found", createPartialResult(), false);
    const missingSessionCodeOnly = new ProviderTurnError("SessionNotFound", createPartialResult(), false);
    const missingSessionSnakeCase = new ProviderTurnError("session_not_found", createPartialResult(), false);
    const missingSessionWithRawItems = new ProviderTurnError(
      "SessionNotFound: session not found",
      createPartialResult({
        rawItemsJson: JSON.stringify([{ type: "session.error", data: { message: "SessionNotFound" } }]),
      }),
      false,
    );
    const missingSessionWithOperation = new ProviderTurnError(
      "SessionNotFound: session not found",
      createPartialResult({
        operations: [{ type: "command_execution", summary: "dir", status: "in_progress" } as never],
      }),
      false,
    );
    const missingSessionWithToolStartRawItems = new ProviderTurnError(
      "SessionNotFound: session not found",
      createPartialResult({
        rawItemsJson: JSON.stringify([
          { type: "tool.execution_start", data: { toolCallId: "call-1", toolName: "shell", summary: "dir" } },
          { type: "session.error", data: { message: "SessionNotFound" } },
        ]),
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
    assert.equal(shouldRetryCopilotTurn(missingSessionWithOperation), false);
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

  it("Copilot elicitation schema の enum / anyOf / number を live field へ正規化する", () => {
    assert.deepEqual(
      buildLiveElicitationFieldFromCopilotSchema("environment", {
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
      buildLiveElicitationFieldFromCopilotSchema("targets", {
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
      buildLiveElicitationFieldFromCopilotSchema("retries", {
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

it("Copilot final projectionはbinding referenceを除去しlogical promptは変更しない", async () => {
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
  const prompt: ProviderPromptComposition = {
    ...EMPTY_PROMPT,
    inputBodyText: `user supplied ${bindingReference}`,
    logicalPrompt: {
      ...EMPTY_PROMPT.logicalPrompt,
      inputText: `user supplied ${bindingReference}`,
      composedText: `user supplied ${bindingReference}`,
    },
  };
  const steps = new Map<string, LiveRunStep>([["command-1", {
    id: "command-1",
    type: "command_execution",
    summary: "env",
    details: `secret=${bindingReference}`,
    status: "completed",
  }]]);
  const rawItems = buildCopilotStableRawItems([{
    type: "assistant.message",
    timestamp: new Date().toISOString(),
    data: {
      messageId: "message-1",
      content: `answer ${bindingReference}`,
    },
  } as never], input.session.workspacePath);
  const disabledSnapshot = createDisabledWorkspaceSnapshotCapture();
  const selection: ResolvedModelSelection = {
    requestedModel: input.session.model,
    resolvedModel: input.session.model,
    requestedReasoningEffort: input.session.reasoningEffort,
    resolvedReasoningEffort: input.session.reasoningEffort,
  };
  const adapter = new CopilotAdapter() as unknown as {
    buildTurnResult(
      binding: RunSessionTurnInput["agentRuntimeBinding"],
      promptValue: ProviderPromptComposition,
      attachments: never[],
      threadId: string,
      assistantText: string,
      lastAssistantText: string,
      liveSteps: Map<string, LiveRunStep>,
      usage: null,
      rawItemsValue: ReturnType<typeof buildCopilotStableRawItems>,
      workspacePath: string,
      session: RunSessionTurnInput["session"],
      providerCatalog: RunSessionTurnInput["providerCatalog"],
      selectionValue: ResolvedModelSelection,
      beforeSnapshot: Map<string, string>,
      beforeSnapshotStats: ReturnType<typeof createDisabledWorkspaceSnapshotCapture>["stats"],
      providerQuotaTelemetry: null,
    ): Promise<RunSessionTurnResult>;
  };

  const result = await adapter.buildTurnResult(
    input.agentRuntimeBinding,
    prompt,
    [],
    "thread-redaction",
    `answer ${bindingReference}`,
    `answer ${bindingReference}`,
    steps,
    null,
    rawItems,
    input.session.workspacePath,
    input.session,
    input.providerCatalog,
    selection,
    disabledSnapshot.snapshot,
    disabledSnapshot.stats,
    null,
  );

  assert.match(result.logicalPrompt.composedText, new RegExp(bindingReference));
  assert.match(JSON.stringify(result.transportPayload), new RegExp(bindingReference));
  assert.doesNotMatch(JSON.stringify({
    assistantText: result.assistantText,
    lastNonEmptyAssistantMessageText: result.lastNonEmptyAssistantMessageText,
    artifact: result.artifact,
    operations: result.operations,
    rawItemsJson: result.rawItemsJson,
    providerMetadata: result.providerMetadata,
  }), new RegExp(bindingReference));
  assert.match(result.assistantText, new RegExp(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER));
});

it("Copilot bootstrap失敗projectionはbinding referenceを除去しlogical promptは変更しない", async () => {
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
  const prompt: ProviderPromptComposition = {
    ...EMPTY_PROMPT,
    inputBodyText: `user supplied ${bindingReference}`,
    logicalPrompt: {
      ...EMPTY_PROMPT.logicalPrompt,
      inputText: `user supplied ${bindingReference}`,
      composedText: `user supplied ${bindingReference}`,
    },
  };
  const adapter = new CopilotAdapter() as unknown as {
    getSession(): Promise<never>;
    runSessionTurnOnce(
      inputValue: RunSessionTurnInput,
      promptValue: ProviderPromptComposition,
    ): Promise<RunSessionTurnResult>;
  };
  adapter.getSession = async () => {
    throw new Error(`bootstrap failed: ${bindingReference}`);
  };

  await assert.rejects(
    () => adapter.runSessionTurnOnce(input, prompt),
    (error: unknown) => {
      assert.ok(error instanceof ProviderTurnError);
      assert.doesNotMatch(error.message, new RegExp(bindingReference));
      assert.match(error.message, new RegExp(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER));
      assert.match(error.partialResult.logicalPrompt.composedText, new RegExp(bindingReference));
      assert.match(JSON.stringify(error.partialResult.transportPayload), new RegExp(bindingReference));
      assert.doesNotMatch(error.partialResult.rawItemsJson, new RegExp(bindingReference));
      assert.match(error.partialResult.rawItemsJson, new RegExp(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER));
      return true;
    },
  );
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

  it("明示した custom agent が解決時に消えていた場合は既定agentへfallbackしない", () => {
    const input = createRunSessionInput({ customAgentName: "missing-agent" });

    assert.throws(
      () => buildCopilotSessionSettings(input, EMPTY_PROMPT, "client-key", () => ({
        customAgents: [...CUSTOM_AGENT_CONFIGS],
        selectedAgentName: null,
      })),
      /missing-agent/,
    );
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

  it("allow-all permission handler は legacy approve-once を返す", async () => {
    const input = createRunSessionInput();
    input.session.approvalMode = "never";
    const settings = buildCopilotSessionSettings(input, EMPTY_PROMPT, "client-key", resolveCustomAgents);

    assert.ok(settings.config.onPermissionRequest);
    await assert.doesNotReject(async () => {
      const result = await settings.config.onPermissionRequest?.(createWritePermissionRequest(), { sessionId: "session-1" });
      assert.deepEqual(result, { kind: "approve-once" });
    });
  });

  it("safety permission handler は read を legacy approve-once / write を reject で返す", async () => {
    const input = createRunSessionInput();
    input.session.approvalMode = "untrusted";
    const settings = buildCopilotSessionSettings(input, EMPTY_PROMPT, "client-key", resolveCustomAgents);

    assert.ok(settings.config.onPermissionRequest);
    const readResult = await settings.config.onPermissionRequest?.(createReadPermissionRequest(), { sessionId: "session-1" });
    const writeResult = await settings.config.onPermissionRequest?.(createWritePermissionRequest(), { sessionId: "session-1" });

    assert.deepEqual(readResult, { kind: "approve-once" });
    assert.deepEqual(writeResult, { kind: "reject" });
  });

  it("provider-controlled permission handler は approval callback 経由の approve / deny と handler 不在を legacy kind へ橋渡しする", async () => {
    const approvedInput = createRunSessionInput();
    const bindingReference = approvedInput.agentRuntimeBinding?.bindingReference ?? "";
    approvedInput.session.approvalMode = "on-request";
    const approvalRequests: unknown[] = [];
    approvedInput.onApprovalRequest = async (request) => {
      approvalRequests.push(request);
      return "approve";
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
    deniedInput.onApprovalRequest = async () => "deny";
    const deniedSettings = buildCopilotSessionSettings(deniedInput, EMPTY_PROMPT, "client-key", resolveCustomAgents);
    const deniedWriteResult = await deniedSettings.config.onPermissionRequest?.(createWritePermissionRequest(), { sessionId: "session-1" });
    assert.deepEqual(deniedWriteResult, { kind: "reject" });

    const missingHandlerInput = createRunSessionInput();
    missingHandlerInput.session.approvalMode = "on-request";
    const missingHandlerSettings = buildCopilotSessionSettings(missingHandlerInput, EMPTY_PROMPT, "client-key", resolveCustomAgents);
    const missingHandlerResult = await missingHandlerSettings.config.onPermissionRequest?.(createWritePermissionRequest(), { sessionId: "session-1" });
    assert.deepEqual(missingHandlerResult, { kind: "user-not-available" });
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

describe("CopilotAdapter background structured prompt", () => {
  it("schema submit tool 未呼び出し時は自然言語 fallback を使わない", async () => {
    const adapter = new CopilotAdapter() as unknown as {
      getOrCreateClientByAppSettings: (
        providerId: string,
        appSettings: unknown,
      ) => {
        start: () => Promise<void>;
        createSession: () => Promise<{
          on: (_event: "assistant.usage", _listener: (event: { data: { usage: unknown } }) => void) => () => void;
          sendAndWait: () => Promise<{ data: { content: string } }>;
          disconnect: () => Promise<void>;
        }>;
      };
      fetchProviderQuotaTelemetry: () => Promise<null>;
      runBackgroundPromptFromInput: <TOutput>(
        input: RunBackgroundStructuredPromptInput,
        parse: (rawText: string) => TOutput | null,
      ) => Promise<{
        threadId: string | null;
        rawText: string;
        output: TOutput | null;
        parsedJson: unknown | null;
        structuredOutput: unknown | null;
        rawItemsJson: string;
        usage: null;
        providerQuotaTelemetry: null;
      }>;
    };

    adapter.getOrCreateClientByAppSettings = () => ({
      start: async () => undefined,
      createSession: async () => ({
        on: () => () => undefined,
        sendAndWait: async () => ({ data: { content: "自然言語で応答します" } }),
        disconnect: async () => undefined,
      }),
    });
    adapter.fetchProviderQuotaTelemetry = async () => null;

    let parseCalled = false;
    await assert.rejects(
      adapter.runBackgroundPromptFromInput(createBackgroundPromptInput(), () => {
        parseCalled = true;
        return null;
      }),
      /Structured output tool was not called/i,
    );
    assert.equal(parseCalled, false);
  });

  it("schema submit tool 呼び出し時は tool の structured output を使用する", async () => {
    const expectedSchema = createBackgroundPromptInput().prompt.outputSchema;
    const adapter = new CopilotAdapter() as unknown as {
      getOrCreateClientByAppSettings: (
        providerId: string,
        appSettings: unknown,
      ) => {
        start: () => Promise<void>;
        createSession: (config: {
          tools?: Array<{
            name: string;
            handler: (args: Record<string, unknown>) => string;
          }>;
        }) => Promise<{
          on: (_event: "assistant.usage", _listener: (event: { data: { usage: unknown } }) => void) => () => void;
          sendAndWait: () => Promise<{ data: { content: string } }>;
          disconnect: () => Promise<void>;
        }>;
      };
      fetchProviderQuotaTelemetry: () => Promise<null>;
      runBackgroundPromptFromInput: <TOutput>(
        input: RunBackgroundStructuredPromptInput,
        parse: (rawText: string) => TOutput | null,
      ) => Promise<{
        threadId: string | null;
        rawText: string;
        output: TOutput | null;
        parsedJson: unknown | null;
        structuredOutput: unknown | null;
        rawItemsJson: string;
        usage: null;
        providerQuotaTelemetry: null;
      }>;
    };

    let handlerCalled = false;
    let submitSchema: unknown = null;
    let submitArgs: Record<string, unknown> | null = null;
    adapter.getOrCreateClientByAppSettings = () => ({
      start: async () => undefined,
      createSession: async (config) => {
        const submitTool = config.tools?.find((tool) => tool.name === "withmate_submit_structured_output");
        assert.ok(submitTool);
        submitSchema = submitTool.parameters;
        return {
          on: () => () => undefined,
          sendAndWait: async () => {
            const toolArgs: Record<string, unknown> = { answer: "ok" };
            submitArgs = toolArgs;
            const handlerResult = submitTool?.handler(toolArgs);
            handlerCalled = true;
            assert.equal(handlerResult, "structured output accepted");
            return { data: { content: "自然言語の応答" } };
          },
          disconnect: async () => undefined,
        };
      },
    });
    adapter.fetchProviderQuotaTelemetry = async () => null;

    const result = await adapter.runBackgroundPromptFromInput(createBackgroundPromptInput(), (rawText) => {
      return JSON.parse(rawText) as { answer: string };
    });

    assert.deepEqual(submitSchema, expectedSchema);
    assert.equal(handlerCalled, true);
    assert.deepEqual(submitArgs, { answer: "ok" });
    assert.equal(result.rawText, "{\"answer\":\"ok\"}");
    assert.equal(result.output?.answer, "ok");
    assert.deepEqual(result.parsedJson, { answer: "ok" });
  });

  it("background structured prompt は built-in read tools を塞がず approval mode を反映する", async () => {
    const adapter = new CopilotAdapter() as unknown as {
      getOrCreateClientByAppSettings: () => {
        start: () => Promise<void>;
        createSession: (config: {
          tools?: Array<{
            name: string;
            parameters?: unknown;
            handler: (args: Record<string, unknown>) => string;
          }>;
          availableTools?: string[];
          onPermissionRequest?: (
            request: PermissionRequest,
            context: { sessionId: string },
          ) => Promise<unknown> | unknown;
        }) => Promise<{
          on: (_event: "assistant.usage", _listener: (event: { data: { usage: unknown } }) => void) => () => void;
          sendAndWait: () => Promise<{ data: { content: string } }>;
          disconnect: () => Promise<void>;
        }>;
      };
      fetchProviderQuotaTelemetry: () => Promise<null>;
      runBackgroundPromptFromInput: <TOutput>(
        input: RunBackgroundStructuredPromptInput,
        parse: (rawText: string) => TOutput | null,
      ) => Promise<{
        threadId: string | null;
        rawText: string;
        output: TOutput | null;
        parsedJson: unknown | null;
        structuredOutput: unknown | null;
        rawItemsJson: string;
        usage: null;
        providerQuotaTelemetry: null;
      }>;
    };

    let capturedConfig: {
      tools?: Array<{
        name: string;
        handler: (args: Record<string, unknown>) => string;
      }>;
      availableTools?: string[];
      onPermissionRequest?: (
        request: PermissionRequest,
        context: { sessionId: string },
      ) => Promise<unknown> | unknown;
    } | null = null;
    adapter.getOrCreateClientByAppSettings = () => ({
      start: async () => undefined,
      createSession: async (config) => {
        capturedConfig = config;
        const submitTool = config.tools?.find((tool) => tool.name === "withmate_submit_structured_output");
        assert.ok(submitTool);
        return {
          on: () => () => undefined,
          sendAndWait: async () => {
            submitTool.handler({ answer: "ok" });
            return { data: { content: "" } };
          },
          disconnect: async () => undefined,
        };
      },
    });
    adapter.fetchProviderQuotaTelemetry = async () => null;

    await adapter.runBackgroundPromptFromInput(
      createBackgroundPromptInput({ approvalMode: "untrusted" }),
      (rawText) => JSON.parse(rawText) as { answer: string },
    );

    assert.ok(capturedConfig);
    assert.equal(capturedConfig.availableTools, undefined);
    assert.ok(capturedConfig.onPermissionRequest);
    const readResult = await capturedConfig.onPermissionRequest(createReadPermissionRequest(), { sessionId: "background" });
    const writeResult = await capturedConfig.onPermissionRequest(createWritePermissionRequest(), { sessionId: "background" });
    assert.deepEqual(readResult, { kind: "approve-once" });
    assert.deepEqual(writeResult, { kind: "reject" });
  });

  it("background structured prompt の未指定 approval は read-only に倒す", async () => {
    const adapter = new CopilotAdapter() as unknown as {
      getOrCreateClientByAppSettings: () => {
        start: () => Promise<void>;
        createSession: (config: {
          tools?: Array<{
            name: string;
            handler: (args: Record<string, unknown>) => string;
          }>;
          onPermissionRequest?: (
            request: PermissionRequest,
            context: { sessionId: string },
          ) => Promise<unknown> | unknown;
        }) => Promise<{
          on: (_event: "assistant.usage", _listener: (event: { data: { usage: unknown } }) => void) => () => void;
          sendAndWait: () => Promise<{ data: { content: string } }>;
          disconnect: () => Promise<void>;
        }>;
      };
      fetchProviderQuotaTelemetry: () => Promise<null>;
      runBackgroundPromptFromInput: <TOutput>(
        input: RunBackgroundStructuredPromptInput,
        parse: (rawText: string) => TOutput | null,
      ) => Promise<{
        threadId: string | null;
        rawText: string;
        output: TOutput | null;
        parsedJson: unknown | null;
        structuredOutput: unknown | null;
        rawItemsJson: string;
        usage: null;
        providerQuotaTelemetry: null;
      }>;
    };

    let writeResult: unknown = null;
    adapter.getOrCreateClientByAppSettings = () => ({
      start: async () => undefined,
      createSession: async (config) => {
        const submitTool = config.tools?.find((tool) => tool.name === "withmate_submit_structured_output");
        assert.ok(submitTool);
        assert.ok(config.onPermissionRequest);
        writeResult = await config.onPermissionRequest(createWritePermissionRequest(), { sessionId: "background" });
        return {
          on: () => () => undefined,
          sendAndWait: async () => {
            submitTool.handler({ answer: "ok" });
            return { data: { content: "" } };
          },
          disconnect: async () => undefined,
        };
      },
    });
    adapter.fetchProviderQuotaTelemetry = async () => null;

    await adapter.runBackgroundPromptFromInput(
      createBackgroundPromptInput(),
      (rawText) => JSON.parse(rawText) as { answer: string },
    );

    assert.deepEqual(writeResult, { kind: "reject" });
  });

  it("background structured prompt の never approval は write permission を許可する", async () => {
    const adapter = new CopilotAdapter() as unknown as {
      getOrCreateClientByAppSettings: () => {
        start: () => Promise<void>;
        createSession: (config: {
          tools?: Array<{
            name: string;
            handler: (args: Record<string, unknown>) => string;
          }>;
          onPermissionRequest?: (
            request: PermissionRequest,
            context: { sessionId: string },
          ) => Promise<unknown> | unknown;
        }) => Promise<{
          on: (_event: "assistant.usage", _listener: (event: { data: { usage: unknown } }) => void) => () => void;
          sendAndWait: () => Promise<{ data: { content: string } }>;
          disconnect: () => Promise<void>;
        }>;
      };
      fetchProviderQuotaTelemetry: () => Promise<null>;
      runBackgroundPromptFromInput: <TOutput>(
        input: RunBackgroundStructuredPromptInput,
        parse: (rawText: string) => TOutput | null,
      ) => Promise<{
        threadId: string | null;
        rawText: string;
        output: TOutput | null;
        parsedJson: unknown | null;
        structuredOutput: unknown | null;
        rawItemsJson: string;
        usage: null;
        providerQuotaTelemetry: null;
      }>;
    };

    let writeResult: unknown = null;
    adapter.getOrCreateClientByAppSettings = () => ({
      start: async () => undefined,
      createSession: async (config) => {
        const submitTool = config.tools?.find((tool) => tool.name === "withmate_submit_structured_output");
        assert.ok(submitTool);
        assert.ok(config.onPermissionRequest);
        writeResult = await config.onPermissionRequest(createWritePermissionRequest(), { sessionId: "background" });
        return {
          on: () => () => undefined,
          sendAndWait: async () => {
            submitTool.handler({ answer: "ok" });
            return { data: { content: "" } };
          },
          disconnect: async () => undefined,
        };
      },
    });
    adapter.fetchProviderQuotaTelemetry = async () => null;

    await adapter.runBackgroundPromptFromInput(
      createBackgroundPromptInput({ approvalMode: "never" }),
      (rawText) => JSON.parse(rawText) as { answer: string },
    );

    assert.deepEqual(writeResult, { kind: "approve-once" });
  });

  it("runBackgroundStructuredPrompt は optional 実行制御 fields を private runner へ渡す", async () => {
    const adapter = {
      runBackgroundStructuredPrompt: CopilotAdapter.prototype.runBackgroundStructuredPrompt,
      runBackgroundPromptFromInput: async (
        input: RunBackgroundStructuredPromptInput,
        parse: (rawText: string) => { answer: string } | null,
      ) => {
        assert.deepEqual(input.additionalDirectories, ["F:/repo/docs"]);
        assert.equal(input.approvalMode, "untrusted");
        assert.equal(input.codexSandboxMode, "read-only");
        const rawText = "{\"answer\":\"ok\"}";
        return {
          threadId: "thread-background",
          rawText,
          output: parse(rawText),
          parsedJson: { answer: "ok" },
          structuredOutput: { answer: "ok" },
          rawItemsJson: "[]",
          usage: null,
          providerQuotaTelemetry: null,
        };
      },
    } as unknown as {
      runBackgroundStructuredPrompt: CopilotAdapter["runBackgroundStructuredPrompt"];
      runBackgroundPromptFromInput: (
        input: RunBackgroundStructuredPromptInput,
        parse: (rawText: string) => { answer: string } | null,
        signal?: AbortSignal,
      ) => Promise<{
        threadId: string | null;
        rawText: string;
        output: { answer: string } | null;
        parsedJson: unknown | null;
        structuredOutput: unknown | null;
        rawItemsJson: string;
        usage: null;
        providerQuotaTelemetry: null;
      }>;
    };

    const result = await adapter.runBackgroundStructuredPrompt<{ answer: string }>(
      createBackgroundPromptInput({
        additionalDirectories: ["F:/repo/docs"],
        approvalMode: "untrusted",
        codexSandboxMode: "read-only",
      }),
    );

    assert.deepEqual(result.output, { answer: "ok" });
  });

  it("background provider timeoutでもusage listenerを解除してsessionをdisconnectする", async () => {
    const cleanup: string[] = [];
    const adapter = new CopilotAdapter() as unknown as {
      getOrCreateClientByAppSettings: () => {
        start: () => Promise<void>;
        createSession: () => Promise<{
          on: () => () => void;
          sendAndWait: () => Promise<never>;
          disconnect: () => Promise<void>;
        }>;
      };
      runBackgroundPromptFromInput: <TOutput>(
        input: RunBackgroundStructuredPromptInput,
        parse: (rawText: string) => TOutput | null,
      ) => Promise<unknown>;
    };
    adapter.getOrCreateClientByAppSettings = () => ({
      start: async () => undefined,
      createSession: async () => ({
        on: () => () => cleanup.push("unsubscribe"),
        sendAndWait: async () => {
          throw new Error("injected provider timeout");
        },
        disconnect: async () => {
          cleanup.push("disconnect");
        },
      }),
    });

    await assert.rejects(
      () => adapter.runBackgroundPromptFromInput(createBackgroundPromptInput({ timeoutMs: 15_000 }), JSON.parse),
      /provider timeout/,
    );
    assert.deepEqual(cleanup, ["unsubscribe", "disconnect"]);
  });

  it("schema submit tool の args が実 schema の anyOf / oneOf / bounds 不一致なら失敗する", async () => {
    const adapter = new CopilotAdapter() as unknown as {
      getOrCreateClientByAppSettings: () => {
        start: () => Promise<void>;
        createSession: (config: {
          tools?: Array<{
            name: string;
            handler: (args: Record<string, unknown>) => string;
          }>;
        }) => Promise<{
          on: (_event: "assistant.usage", _listener: (event: { data: { usage: unknown } }) => void) => () => void;
          sendAndWait: () => Promise<{ data: { content: string } }>;
          disconnect: () => Promise<void>;
        }>;
      };
      fetchProviderQuotaTelemetry: () => Promise<null>;
      runBackgroundPromptFromInput: <TOutput>(
        input: RunBackgroundStructuredPromptInput,
        parse: (rawText: string) => TOutput | null,
      ) => Promise<{
        threadId: string | null;
        rawText: string;
        output: TOutput | null;
        parsedJson: unknown | null;
        structuredOutput: unknown | null;
        rawItemsJson: string;
        usage: null;
        providerQuotaTelemetry: null;
      }>;
    };

    adapter.getOrCreateClientByAppSettings = () => ({
      start: async () => undefined,
      createSession: async (config) => {
        const submitTool = config.tools?.find((tool) => tool.name === "withmate_submit_structured_output");
        assert.ok(submitTool);
        return {
          on: () => () => undefined,
          sendAndWait: async () => {
            submitTool.handler({
              memories: [
                {
                  statement: "ユーザーは短い報告を好む",
                  growthSourceType: "explicit_user_instruction",
                  kind: "preference",
                  targetSection: "work_style",
                  confidence: 101,
                  salienceScore: 50,
                  tags: [],
                  relation: "new",
                  relatedRefs: [123],
                  supersedesRefs: [],
                  targetClaimKey: "work-style.short-report",
                  newTags: [],
                  remember: true,
                  sourceType: "session",
                  sourceSessionId: 123,
                  sourceAuditLogId: null,
                  projectDigestId: null,
                },
              ],
            });
            return { data: { content: "" } };
          },
          disconnect: async () => undefined,
        };
      },
    });
    adapter.fetchProviderQuotaTelemetry = async () => null;

    await assert.rejects(
      adapter.runBackgroundPromptFromInput(
        createBackgroundPromptInput({
          prompt: {
            systemText: "",
            userText: "extract memory candidates",
            outputSchema: TEST_STRUCTURED_OUTPUT_SCHEMA,
          },
        }),
        (rawText) => JSON.parse(rawText),
      ),
      /did not match schema/i,
    );
  });

  it("schema submit tool が複数回呼び出されたら失敗する", async () => {
    const adapter = new CopilotAdapter() as unknown as {
      getOrCreateClientByAppSettings: () => {
        start: () => Promise<void>;
        createSession: (config: {
          tools?: Array<{
            name: string;
            handler: (args: Record<string, unknown>) => string;
          }>;
        }) => Promise<{
          on: (_event: "assistant.usage", _listener: (event: { data: { usage: unknown } }) => void) => () => void;
          sendAndWait: () => Promise<{ data: { content: string } }>;
          disconnect: () => Promise<void>;
        }>;
      };
      fetchProviderQuotaTelemetry: () => Promise<null>;
      runBackgroundPromptFromInput: <TOutput>(
        input: RunBackgroundStructuredPromptInput,
        parse: (rawText: string) => TOutput | null,
      ) => Promise<{
        threadId: string | null;
        rawText: string;
        output: TOutput | null;
        parsedJson: unknown | null;
        structuredOutput: unknown | null;
        rawItemsJson: string;
        usage: null;
        providerQuotaTelemetry: null;
      }>;
    };

    adapter.getOrCreateClientByAppSettings = () => ({
      start: async () => undefined,
      createSession: async (config) => {
        const submitTool = config.tools?.find((tool) => tool.name === "withmate_submit_structured_output");
        assert.ok(submitTool);
        return {
          on: () => () => undefined,
          sendAndWait: async () => {
            submitTool.handler({ answer: "first" });
            submitTool.handler({ answer: "second" });
            return { data: { content: "" } };
          },
          disconnect: async () => undefined,
        };
      },
    });
    adapter.fetchProviderQuotaTelemetry = async () => null;

    await assert.rejects(
      adapter.runBackgroundPromptFromInput(createBackgroundPromptInput(), (rawText) => {
        return JSON.parse(rawText) as { answer: string };
      }),
      /called multiple times/i,
    );
  });
});

