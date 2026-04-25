import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import type { PermissionRequest } from "@github/copilot-sdk";

import { buildNewSession, createDefaultSessionMemory } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import type { ModelCatalogProvider } from "../../src/model-catalog.js";
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
}): RunSessionTurnInput {
  const {
    customAgentName = "reviewer",
    threadId = "",
    model = "gpt-4.1",
    reasoningEffort = "high",
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

describe("CopilotAdapter session settings", () => {
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

  it("allow-all permission handler は legacy approve-once を返す", async () => {
    const input = createRunSessionInput();
    input.session.approvalMode = "allow-all";
    const settings = buildCopilotSessionSettings(input, EMPTY_PROMPT, "client-key", resolveCustomAgents);

    assert.ok(settings.config.onPermissionRequest);
    await assert.doesNotReject(async () => {
      const result = await settings.config.onPermissionRequest?.(createWritePermissionRequest(), { sessionId: "session-1" });
      assert.deepEqual(result, { kind: "approve-once" });
    });
  });

  it("safety permission handler は read を legacy approve-once / write を reject で返す", async () => {
    const input = createRunSessionInput();
    input.session.approvalMode = "safety";
    const settings = buildCopilotSessionSettings(input, EMPTY_PROMPT, "client-key", resolveCustomAgents);

    assert.ok(settings.config.onPermissionRequest);
    const readResult = await settings.config.onPermissionRequest?.(createReadPermissionRequest(), { sessionId: "session-1" });
    const writeResult = await settings.config.onPermissionRequest?.(createWritePermissionRequest(), { sessionId: "session-1" });

    assert.deepEqual(readResult, { kind: "approve-once" });
    assert.deepEqual(writeResult, { kind: "reject" });
  });

  it("provider-controlled permission handler は approval callback 経由の approve / deny と handler 不在を legacy kind へ橋渡しする", async () => {
    const approvedInput = createRunSessionInput();
    approvedInput.session.approvalMode = "provider-controlled";
    const approvalRequests: unknown[] = [];
    approvedInput.onApprovalRequest = async (request) => {
      approvalRequests.push(request);
      return "approve";
    };
    const approvedSettings = buildCopilotSessionSettings(approvedInput, EMPTY_PROMPT, "client-key", resolveCustomAgents);

    assert.ok(approvedSettings.config.onPermissionRequest);
    const readResult = await approvedSettings.config.onPermissionRequest?.(createReadPermissionRequest(), { sessionId: "session-1" });
    const approvedWriteResult = await approvedSettings.config.onPermissionRequest?.(createWritePermissionRequest(), { sessionId: "session-1" });
    assert.deepEqual(readResult, { kind: "approve-once" });
    assert.deepEqual(approvedWriteResult, { kind: "approve-once" });
    assert.equal(approvalRequests.length, 1);

    const deniedInput = createRunSessionInput();
    deniedInput.session.approvalMode = "provider-controlled";
    deniedInput.onApprovalRequest = async () => "deny";
    const deniedSettings = buildCopilotSessionSettings(deniedInput, EMPTY_PROMPT, "client-key", resolveCustomAgents);
    const deniedWriteResult = await deniedSettings.config.onPermissionRequest?.(createWritePermissionRequest(), { sessionId: "session-1" });
    assert.deepEqual(deniedWriteResult, { kind: "reject" });

    const missingHandlerInput = createRunSessionInput();
    missingHandlerInput.session.approvalMode = "provider-controlled";
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
