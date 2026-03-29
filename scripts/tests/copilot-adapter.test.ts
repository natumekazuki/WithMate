import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { buildNewSession, createDefaultSessionMemory } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import type { ModelCatalogProvider } from "../../src/model-catalog.js";
import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import {
  applyCopilotAssistantEvent,
  buildCopilotSessionSettings,
  buildCopilotMessageAttachments,
  buildCopilotProviderQuotaTelemetry,
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
  toProviderQuotaSnapshots,
} from "../../src-electron/copilot-adapter.js";
import {
  ProviderTurnError,
  type ProviderPromptComposition,
  type RunSessionTurnInput,
  type RunSessionTurnResult,
} from "../../src-electron/provider-runtime.js";

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

function createRunSessionInput(customAgentName: string, threadId: string): RunSessionTurnInput {
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
      model: "gpt-4.1",
      reasoningEffort: "high",
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
  };
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

  it("platform / arch から native Copilot package 名を決める", () => {
    assert.equal(resolveNativeCopilotPackageName("win32", "x64"), "@github/copilot-win32-x64");
    assert.equal(resolveNativeCopilotPackageName("darwin", "arm64"), "@github/copilot-darwin-arm64");
    assert.equal(resolveNativeCopilotPackageName("linux", "x64"), "@github/copilot-linux-x64");
    assert.equal(resolveNativeCopilotPackageName("win32", "ia32"), null);
  });

  it("Electron では native Copilot CLI binary を優先して使う", () => {
    const resolved = resolveCopilotCliPath(
      (specifier) => {
        assert.equal(specifier, "@github/copilot-win32-x64");
        return path.join("C:\\sdk", "copilot.exe");
      },
      (candidate) => candidate === path.join("C:\\sdk", "copilot.exe"),
      "win32",
      "x64",
    );

    assert.equal(resolved, path.join("C:\\sdk", "copilot.exe"));
  });

  it("native binary が見つからない時は local node_modules command を返す", () => {
    const resolved = resolveCopilotCliPath(
      () => {
        throw new Error("not found");
      },
      (candidate) => candidate === path.resolve(process.cwd(), "node_modules", ".bin", "copilot.cmd"),
      "win32",
      "x64",
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

  it("character prompt は Copilot systemMessage append へ変換する", () => {
    const systemMessage = buildCopilotSystemMessage({
      systemBodyText: "あなたは頼れる相棒です。",
      inputBodyText: "hello",
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

  it("top-level assistant message は arrival 順に空行区切りで連結する", () => {
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

    assert.equal(second.assistantText, "最初の案内\n\n次の案内");
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

  it("進行途中の partial result が無い stale connection だけ retry する", () => {
    const emptyPartial = new ProviderTurnError("Connection is closed.", createPartialResult(), false);
    const withAssistantText = new ProviderTurnError("Connection is closed.", createPartialResult({ assistantText: "4" }), false);

    assert.equal(shouldRetryCopilotTurn(emptyPartial), true);
    assert.equal(shouldRetryCopilotTurn(withAssistantText), false);
  });
});

describe("CopilotAdapter session settings", () => {
  it("custom agent 変更後の session settings は新 agent 情報を反映する", () => {
    const previousInput = createRunSessionInput("reviewer", "thread-1");
    const nextInput = createRunSessionInput("planner", "thread-1");
    const previousSettings = buildCopilotSessionSettings(previousInput, EMPTY_PROMPT, "client-key", resolveCustomAgents);
    const nextSettings = buildCopilotSessionSettings(nextInput, EMPTY_PROMPT, "client-key", resolveCustomAgents);

    assert.notEqual(previousSettings.settingsKey, nextSettings.settingsKey);
    assert.equal(nextSettings.config.agent, "planner");
    assert.deepEqual(nextSettings.config.customAgents, CUSTOM_AGENT_CONFIGS);
  });

  it("threadId がある custom agent 切り替え後は createSession ではなく resumeSession を使う", async () => {
    const previousInput = createRunSessionInput("reviewer", "thread-1");
    const nextInput = createRunSessionInput("planner", "thread-1");
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
});
