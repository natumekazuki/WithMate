import assert from "node:assert/strict";
import type { Stats } from "node:fs";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildNewSession } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import type { ModelCatalogProvider } from "../../src/model-catalog.js";
import {
  CodexAdapter,
  buildCodexThreadSettings,
  buildCodexStableRawItems,
  collectCodexAssistantTextSnapshotsFromEventsForTesting,
  collectCodexAssistantTextFromEventsForTesting,
  collectCodexReasoningTextFromEventsForTesting,
  isCodexWindowsTaskkillSuccessParseNoiseMessage,
  isCodexUsageLimitMessage,
  resolveCodexThreadForSettings,
  type CodexThreadOptions,
} from "../../src-electron/codex-adapter.js";
import {
  _setWalkDirectoryStatOverrideForTesting,
  captureWorkspaceSnapshotPaths,
  createWorkspaceSnapshotIndex,
  refreshWorkspaceSnapshotIndex,
} from "../../src-electron/snapshot-ignore.js";
import {
  ProviderTurnError,
  type RunBackgroundStructuredPromptInput,
  type RunSessionTurnInput,
} from "../../src-electron/provider-runtime.js";

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
  ],
};

function createSession(options?: {
  threadId?: string;
  model?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  approvalMode?: "never" | "on-request" | "untrusted";
  codexSandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  allowedAdditionalDirectories?: string[];
}) {
  const {
    threadId = "",
    model = "gpt-5.4",
    reasoningEffort = "high",
    approvalMode = DEFAULT_APPROVAL_MODE,
    codexSandboxMode,
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
  return {
    session: {
      ...createSession({ threadId: "" }),
      workspacePath,
    },
    sessionMemory: {
      entries: [],
      updatedAt: "",
    },
    projectMemoryEntries: [],
    providerCatalog: CODEX_PROVIDER_CATALOG,
    userMessage: "run task",
    appSettings: createDefaultAppSettings(),
    attachments: [],
  };
}

async function* createCodexStreamThatThrowsAfter(
  events: unknown[],
  errorMessage: string,
): AsyncGenerator<never> {
  for (const event of events) {
    yield event as never;
  }
  throw new Error(errorMessage);
}

async function* createCodexStreamFromEvents(
  events: unknown[],
  beforeYield?: () => Promise<void>,
): AsyncGenerator<never> {
  await beforeYield?.();
  for (const event of events) {
    yield event as never;
  }
}

describe("CodexAdapter thread settings", () => {
  const windowsTaskkillParseNoiseMessage =
    "Failed to parse item: SUCCESS: The process with PID 13760 (child process of PID 32340) has been terminated.";
  const usageLimitMessage =
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jun 12th, 2026 2:07 AM.";

  it("Windows taskkill の SUCCESS 行だけ Codex JSON parse noise として扱う", () => {
    assert.equal(
      isCodexWindowsTaskkillSuccessParseNoiseMessage(
        windowsTaskkillParseNoiseMessage,
      ),
      true,
    );
    assert.equal(
      isCodexWindowsTaskkillSuccessParseNoiseMessage(
        "Failed to parse item: ERROR: The process with PID 13760 could not be terminated.",
      ),
      false,
    );
    assert.equal(isCodexWindowsTaskkillSuccessParseNoiseMessage("SUCCESS: ordinary command output"), false);
  });

  it("Codex usage limit message は保守的な marker が揃う場合だけ扱う", () => {
    assert.equal(isCodexUsageLimitMessage(usageLimitMessage), true);
    assert.equal(isCodexUsageLimitMessage("You've hit your usage limit."), false);
    assert.equal(isCodexUsageLimitMessage("purchase more credits and try again at 2 AM"), false);
    assert.equal(isCodexUsageLimitMessage("ordinary provider failure"), false);
  });

  it("turn.completed 後の Windows taskkill parse noise は成功結果として返す", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-taskkill-completed-"));
    const adapter = new CodexAdapter() as unknown as {
      getClient: () => {
        client: {
          startThread: () => {
            id: string;
            runStreamed: () => Promise<{ events: AsyncGenerator<never> }>;
          };
          resumeThread: never;
        };
        clientKey: string;
      };
      runSessionTurn: CodexAdapter["runSessionTurn"];
    };

    try {
      adapter.getClient = () => ({
        client: {
          startThread: () => ({
            id: "thread-1",
            runStreamed: async () => ({
              events: createCodexStreamThatThrowsAfter([
                {
                  type: "item.completed",
                  item: {
                    id: "message-1",
                    type: "agent_message",
                    text: "done",
                  },
                },
                {
                  type: "turn.completed",
                  usage: null,
                },
              ], windowsTaskkillParseNoiseMessage),
            }),
          }),
          resumeThread: undefined as never,
        },
        clientKey: "client-key",
      });

      const result = await adapter.runSessionTurn(createCodexRunSessionTurnInput(workspacePath));

      assert.equal(result.threadId, "thread-1");
      assert.equal(result.assistantText, "done");
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("turn.completed 後の Windows taskkill parse noise event は進捗 error に出さず成功結果として返す", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-taskkill-event-completed-"));
    const adapter = new CodexAdapter() as unknown as {
      getClient: () => {
        client: {
          startThread: () => {
            id: string;
            runStreamed: () => Promise<{ events: AsyncGenerator<never> }>;
          };
          resumeThread: never;
        };
        clientKey: string;
      };
      runSessionTurn: CodexAdapter["runSessionTurn"];
    };
    const progressErrors: string[] = [];

    try {
      adapter.getClient = () => ({
        client: {
          startThread: () => ({
            id: "thread-1",
            runStreamed: async () => ({
              events: createCodexStreamFromEvents([
                {
                  type: "item.completed",
                  item: {
                    id: "message-1",
                    type: "agent_message",
                    text: "done",
                  },
                },
                {
                  type: "turn.completed",
                  usage: null,
                },
                {
                  type: "error",
                  message: windowsTaskkillParseNoiseMessage,
                },
              ]),
            }),
          }),
          resumeThread: undefined as never,
        },
        clientKey: "client-key",
      });

      const result = await adapter.runSessionTurn(
        createCodexRunSessionTurnInput(workspacePath),
        (state) => {
          progressErrors.push(state.errorMessage);
        },
      );

      assert.equal(result.threadId, "thread-1");
      assert.equal(result.assistantText, "done");
      assert.deepEqual(progressErrors.filter(Boolean), []);
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("assistant item 後でも turn.completed 前の Windows taskkill parse noise は失敗として返す", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-taskkill-item-completed-"));
    const adapter = new CodexAdapter() as unknown as {
      getClient: () => {
        client: {
          startThread: () => {
            id: string;
            runStreamed: () => Promise<{ events: AsyncGenerator<never> }>;
          };
          resumeThread: never;
        };
        clientKey: string;
      };
      runSessionTurn: CodexAdapter["runSessionTurn"];
    };

    try {
      adapter.getClient = () => ({
        client: {
          startThread: () => ({
            id: "thread-1",
            runStreamed: async () => ({
              events: createCodexStreamThatThrowsAfter([
                {
                  type: "item.completed",
                  item: {
                    id: "message-1",
                    type: "agent_message",
                    text: "done",
                  },
                },
              ], windowsTaskkillParseNoiseMessage),
            }),
          }),
          resumeThread: undefined as never,
        },
        clientKey: "client-key",
      });

      await assert.rejects(
        () => adapter.runSessionTurn(createCodexRunSessionTurnInput(workspacePath)),
        (error) => {
          assert.equal(error instanceof ProviderTurnError, true);
          assert.equal((error as ProviderTurnError).canceled, false);
          assert.equal((error as Error).message, windowsTaskkillParseNoiseMessage);
          assert.equal((error as ProviderTurnError).partialResult.threadId, "thread-1");
          assert.equal((error as ProviderTurnError).partialResult.assistantText, "done");
          return true;
        },
      );
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("assistant item 後でも turn.completed 前の Windows taskkill parse noise event は進捗 error に出して失敗にする", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-taskkill-event-item-completed-"));
    const adapter = new CodexAdapter() as unknown as {
      getClient: () => {
        client: {
          startThread: () => {
            id: string;
            runStreamed: () => Promise<{ events: AsyncGenerator<never> }>;
          };
          resumeThread: never;
        };
        clientKey: string;
      };
      runSessionTurn: CodexAdapter["runSessionTurn"];
    };
    const progressErrors: string[] = [];

    try {
      adapter.getClient = () => ({
        client: {
          startThread: () => ({
            id: "thread-1",
            runStreamed: async () => ({
              events: createCodexStreamFromEvents([
                {
                  type: "item.completed",
                  item: {
                    id: "message-1",
                    type: "agent_message",
                    text: "done",
                  },
                },
                {
                  type: "error",
                  message: windowsTaskkillParseNoiseMessage,
                },
              ]),
            }),
          }),
          resumeThread: undefined as never,
        },
        clientKey: "client-key",
      });

      await assert.rejects(
        () => adapter.runSessionTurn(
          createCodexRunSessionTurnInput(workspacePath),
          (state) => {
            progressErrors.push(state.errorMessage);
          },
        ),
        (error) => {
          assert.equal(error instanceof ProviderTurnError, true);
          assert.equal((error as ProviderTurnError).canceled, false);
          assert.equal((error as Error).message, windowsTaskkillParseNoiseMessage);
          assert.equal((error as ProviderTurnError).partialResult.threadId, "thread-1");
          assert.equal((error as ProviderTurnError).partialResult.assistantText, "done");
          return true;
        },
      );

      assert.deepEqual(progressErrors.filter(Boolean), [windowsTaskkillParseNoiseMessage]);
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("turn.completed 前の Windows taskkill parse noise は通常の失敗として返す", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-taskkill-before-completed-"));
    const adapter = new CodexAdapter() as unknown as {
      getClient: () => {
        client: {
          startThread: () => {
            id: string;
            runStreamed: () => Promise<{ events: AsyncGenerator<never> }>;
          };
          resumeThread: never;
        };
        clientKey: string;
      };
      runSessionTurn: CodexAdapter["runSessionTurn"];
    };

    try {
      adapter.getClient = () => ({
        client: {
          startThread: () => ({
            id: "thread-1",
            runStreamed: async () => ({
              events: createCodexStreamThatThrowsAfter([], windowsTaskkillParseNoiseMessage),
            }),
          }),
          resumeThread: undefined as never,
        },
        clientKey: "client-key",
      });

      await assert.rejects(
        () => adapter.runSessionTurn(createCodexRunSessionTurnInput(workspacePath)),
        (error) => {
          assert.equal(error instanceof ProviderTurnError, true);
          assert.equal((error as ProviderTurnError).canceled, false);
          assert.equal((error as Error).message, windowsTaskkillParseNoiseMessage);
          return true;
        },
      );
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("stream error の usage limit は SDK wrapper error より優先して reason を付ける", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-usage-limit-"));
    const logs: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    const adapter = new CodexAdapter((entry) => {
      logs.push(entry as { kind: string; data?: Record<string, unknown> });
    }) as unknown as {
      getClient: () => {
        client: {
          startThread: () => {
            id: string;
            runStreamed: () => Promise<{ events: AsyncGenerator<never> }>;
          };
          resumeThread: never;
        };
        clientKey: string;
      };
      runSessionTurn: CodexAdapter["runSessionTurn"];
    };

    try {
      adapter.getClient = () => ({
        client: {
          startThread: () => ({
            id: "thread-usage-limit",
            runStreamed: async () => ({
              events: createCodexStreamThatThrowsAfter([
                {
                  type: "error",
                  message: usageLimitMessage,
                },
                {
                  type: "turn.failed",
                  error: {
                    message: usageLimitMessage,
                  },
                },
              ], "Codex Exec exited with code 1: Reading prompt from stdin..."),
            }),
          }),
          resumeThread: undefined as never,
        },
        clientKey: "client-key",
      });

      await assert.rejects(
        () => adapter.runSessionTurn(createCodexRunSessionTurnInput(workspacePath)),
        (error) => {
          assert.equal(error instanceof ProviderTurnError, true);
          assert.equal((error as ProviderTurnError).canceled, false);
          assert.equal((error as ProviderTurnError).reason, "usage_limit");
          assert.equal((error as Error).message, usageLimitMessage);
          assert.equal((error as ProviderTurnError).partialResult.threadId, "thread-usage-limit");
          return true;
        },
      );

      const failedLog = logs.find((entry) => entry.kind === "codex.run.failed");
      assert.equal(failedLog?.data?.providerErrorReason, "usage_limit");
      assert.equal(failedLog?.data?.streamErrorMessage, usageLimitMessage);
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("delta 系 event から assistant text を逐次復元し、final item で確定形に置き換える", () => {
    const streamedText = collectCodexAssistantTextFromEventsForTesting([
      {
        type: "agent_message.delta",
        delta: "こ",
      } as never,
      {
        type: "response.output_text.delta",
        data: {
          delta: "んにちは",
        },
      } as never,
    ]);

    assert.equal(streamedText, "こんにちは");

    const finalizedText = collectCodexAssistantTextFromEventsForTesting([
      {
        type: "agent_message.delta",
        delta: "途中",
      } as never,
      {
        type: "item.completed",
        item: {
          id: "message-1",
          type: "agent_message",
          text: "確定メッセージ",
        },
      } as never,
    ]);

    assert.equal(finalizedText, "確定メッセージ");
  });

  it("delta で受けた assistant text を空の agent_message item で消さない", () => {
    const snapshots = collectCodexAssistantTextSnapshotsFromEventsForTesting([
      {
        type: "agent_message.delta",
        delta: "処理",
      } as never,
      {
        type: "item.started",
        item: {
          id: "message-1",
          type: "agent_message",
          text: "",
        },
      } as never,
      {
        type: "item.updated",
        item: {
          id: "message-1",
          type: "agent_message",
          text: "",
        },
      } as never,
      {
        type: "agent_message.delta",
        delta: "中",
      } as never,
      {
        type: "item.completed",
        item: {
          id: "message-1",
          type: "agent_message",
          text: "処理中です。",
        },
      } as never,
    ]);

    assert.deepEqual(snapshots, ["処理", "処理", "処理", "処理中", "処理中です。"]);
  });

  it("入れ子や配列の delta payload から assistant text を復元する", () => {
    const snapshots = collectCodexAssistantTextSnapshotsFromEventsForTesting([
      {
        type: "response.output_text.delta",
        data: {
          content: [
            { type: "output_text", text: "こ" },
            { type: "output_text", text: "ん" },
          ],
        },
      } as never,
      {
        type: "assistant.message_delta",
        data: {
          deltaContent: "にちは",
        },
      } as never,
      {
        type: "item.completed",
        item: {
          id: "message-1",
          type: "agent_message",
          text: "",
        },
      } as never,
    ]);

    assert.deepEqual(snapshots, ["こん", "こんにちは", "こんにちは"]);
  });

  it("rawItems は final item 全体ではなく bounded projection に変換する", () => {
    const longOutput = "x".repeat(70 * 1024);
    const items = buildCodexStableRawItems([
      {
        id: "cmd-1",
        type: "command_execution",
        command: "npm test",
        status: "completed",
        exit_code: 0,
        aggregated_output: longOutput,
      } as never,
      {
        id: "message-1",
        type: "agent_message",
        text: "done",
      } as never,
    ]);

    assert.deepEqual(items[0]?.data?.command, "npm test");
    assert.equal("aggregated_output" in (items[0]?.data ?? {}), false);

    const output = items[0]?.data?.output as {
      text: string;
      truncated: true;
      originalLength: number;
    };
    assert.equal(output.truncated, true);
    assert.equal(output.originalLength, longOutput.length);
    assert.equal(output.text.includes("...[truncated "), true);
    assert.deepEqual(items[1], {
      type: "agent_message",
      data: {
        id: "message-1",
        text: "done",
      },
    });
  });

  it("reasoning item は rawItems に残さず live reasoning text にだけ流す", () => {
    const events = [
      {
        type: "item.updated",
        item: {
          id: "reasoning-1",
          type: "reasoning",
          text: "既存経路を確認する",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "reasoning-1",
          type: "reasoning",
          text: "既存経路を確認してから UI に流す",
        },
      },
    ] as never[];

    assert.deepEqual(buildCodexStableRawItems([
      {
        id: "reasoning-1",
        type: "reasoning",
        text: "既存経路を確認してから UI に流す",
      } as never,
    ]), []);
    assert.equal(collectCodexReasoningTextFromEventsForTesting(events), "既存経路を確認してから UI に流す");
  });

  it("collab_tool_call は監査 rawItems に残す", () => {
    const items = buildCodexStableRawItems([
      {
        id: "item_33",
        type: "collab_tool_call",
        tool: "close_agent",
        status: "completed",
        agents_states: {
          "agent-1": {
            status: "completed",
            message: "Pass",
          },
        },
      } as never,
    ]);

    assert.deepEqual(items, [
      {
        type: "collab_tool_call",
        data: {
          id: "item_33",
          status: "completed",
          tool: "close_agent",
          agentsStates: {
            "agent-1": {
              status: "completed",
              message: "Pass",
            },
          },
          errorMessage: null,
        },
      },
    ]);
  });

  it("collab_tool_call の stream lifecycle を app log に流す", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-collab-log-"));
    const logs: Array<{ kind: string; level: string; data?: Record<string, unknown> }> = [];
    const adapter = new CodexAdapter((entry) => {
      logs.push(entry as { kind: string; level: string; data?: Record<string, unknown> });
    }) as unknown as {
      getClient: () => {
        client: {
          startThread: () => {
            id: string;
            runStreamed: () => Promise<{ events: AsyncGenerator<never> }>;
          };
          resumeThread: never;
        };
        clientKey: string;
      };
      runSessionTurn: CodexAdapter["runSessionTurn"];
    };

    try {
      adapter.getClient = () => ({
        client: {
          startThread: () => ({
            id: "thread-1",
            runStreamed: async () => ({
              events: createCodexStreamFromEvents([
                {
                  type: "item.completed",
                  item: {
                    id: "item_33",
                    type: "collab_tool_call",
                    tool: "wait",
                    status: "completed",
                    agents_states: {
                      "agent-1": {
                        status: "completed",
                        message: "Pass",
                      },
                    },
                  },
                },
                {
                  type: "item.completed",
                  item: {
                    id: "message-1",
                    type: "agent_message",
                    text: "done",
                  },
                },
                {
                  type: "turn.completed",
                  usage: null,
                },
              ]),
            }),
          }),
          resumeThread: undefined as never,
        },
        clientKey: "client-key",
      });

      const result = await adapter.runSessionTurn(createCodexRunSessionTurnInput(workspacePath));
      const openedLog = logs.find((entry) => entry.kind === "codex.run.stream.opened");
      const finishedLog = logs.find((entry) => entry.kind === "codex.run.stream.finished");
      const collabLog = logs.find(
        (entry) => entry.kind === "codex.run.stream.event" && entry.data?.itemType === "collab_tool_call",
      );
      const completedLog = logs.find((entry) => entry.kind === "codex.run.completed");

      assert.equal(result.assistantText, "done");
      assert.equal(openedLog?.data?.threadId, "thread-1");
      assert.equal(finishedLog?.data?.turnCompleted, true);
      assert.equal(collabLog?.data?.tool, "wait");
      assert.equal(collabLog?.data?.status, "completed");
      assert.deepEqual(collabLog?.data?.agents, {
        total: 1,
        statuses: {
          completed: 1,
        },
      });
      assert.equal(completedLog?.data?.turnCompleted, true);
      assert.equal(completedLog?.data?.operationCount, 2);
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("app log callback が失敗しても provider 実行は継続する", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-log-throw-"));
    const adapter = new CodexAdapter(() => {
      throw new Error("log write failed");
    }) as unknown as {
      getClient: () => {
        client: {
          startThread: () => {
            id: string;
            runStreamed: () => Promise<{ events: AsyncGenerator<never> }>;
          };
          resumeThread: never;
        };
        clientKey: string;
      };
      runSessionTurn: CodexAdapter["runSessionTurn"];
    };

    try {
      adapter.getClient = () => ({
        client: {
          startThread: () => ({
            id: "thread-1",
            runStreamed: async () => ({
              events: createCodexStreamFromEvents([
                {
                  type: "item.completed",
                  item: {
                    id: "message-1",
                    type: "agent_message",
                    text: "done",
                  },
                },
                {
                  type: "turn.completed",
                  usage: null,
                },
              ]),
            }),
          }),
          resumeThread: undefined as never,
        },
        clientKey: "client-key",
      });

      const result = await adapter.runSessionTurn(createCodexRunSessionTurnInput(workspacePath));

      assert.equal(result.threadId, "thread-1");
      assert.equal(result.assistantText, "done");
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("model / reasoning 変更後の thread settings は新 options と settingsKey を反映する", () => {
    const previousSession = createSession({
      threadId: "thread-1",
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
    const nextSession = createSession({
      threadId: "thread-1",
      model: "gpt-5.4-mini",
      reasoningEffort: "low",
    });

    const previousSettings = buildCodexThreadSettings(previousSession, CODEX_PROVIDER_CATALOG, "client-key");
    const nextSettings = buildCodexThreadSettings(nextSession, CODEX_PROVIDER_CATALOG, "client-key");

    assert.notEqual(previousSettings.settingsKey, nextSettings.settingsKey);
    assert.equal(nextSettings.options.model, "gpt-5.4-mini");
    assert.equal(nextSettings.options.modelReasoningEffort, "low");
  });

  it("approval / sandbox / additional directories 変更後の thread settings は新 options と settingsKey を反映する", () => {
    const previousSession = createSession({
      threadId: "thread-1",
      approvalMode: "untrusted",
      codexSandboxMode: "workspace-write",
      allowedAdditionalDirectories: ["F:/external-a"],
    });
    const nextSession = createSession({
      threadId: "thread-1",
      approvalMode: "never",
      codexSandboxMode: "danger-full-access",
      allowedAdditionalDirectories: ["F:/external-b"],
    });

    const previousSettings = buildCodexThreadSettings(previousSession, CODEX_PROVIDER_CATALOG, "client-key");
    const nextSettings = buildCodexThreadSettings(nextSession, CODEX_PROVIDER_CATALOG, "client-key");

    assert.notEqual(previousSettings.settingsKey, nextSettings.settingsKey);
    assert.equal(nextSettings.options.approvalPolicy, "never");
    assert.equal(nextSettings.options.sandboxMode, "danger-full-access");
    assert.deepEqual(nextSettings.options.additionalDirectories, [path.resolve("F:/external-b")]);
  });

  it("threadId がある場合は startThread ではなく resumeThread(threadId, options) を使う", () => {
    const previousSession = createSession({
      threadId: "thread-1",
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
    const nextSession = createSession({
      threadId: "thread-1",
      model: "gpt-5.4-mini",
      reasoningEffort: "low",
    });
    const previousSettings = buildCodexThreadSettings(previousSession, CODEX_PROVIDER_CATALOG, "client-key");
    const nextSettings = buildCodexThreadSettings(nextSession, CODEX_PROVIDER_CATALOG, "client-key");
    const resumeCalls: Array<{ threadId: string; options: CodexThreadOptions }> = [];
    const startCalls: unknown[] = [];
    const resumedThread = { id: "thread-1" } as never;

    assert.notEqual(previousSettings.settingsKey, nextSettings.settingsKey);

    const result = resolveCodexThreadForSettings({
      cached: {
        thread: { id: "cached-thread" } as never,
        settingsKey: previousSettings.settingsKey,
      },
      nextSettingsKey: nextSettings.settingsKey,
      threadId: nextSession.threadId,
      options: nextSettings.options,
      client: {
        resumeThread: (threadId: string, options: CodexThreadOptions) => {
          resumeCalls.push({ threadId, options });
          return resumedThread;
        },
        startThread: (options: CodexThreadOptions) => {
          startCalls.push(options);
          return { id: "started-thread" } as never;
        },
      } as never,
    });

    assert.equal(result.thread, resumedThread);
    assert.equal(result.reusedCached, false);
    assert.equal(startCalls.length, 0);
    assert.equal(resumeCalls.length, 1);
    assert.equal(resumeCalls[0]?.threadId, "thread-1");
    assert.equal(resumeCalls[0]?.options.model, "gpt-5.4-mini");
    assert.equal(resumeCalls[0]?.options.modelReasoningEffort, "low");
  });
});

describe("CodexAdapter background structured prompt", () => {
  it("runBackgroundStructuredPromptFromInput は outputSchema を thread.run の options.outputSchema へ渡す", async () => {
    const adapter = new CodexAdapter() as unknown as {
      getClient: (
        providerId: string,
        appSettings: unknown,
      ) => {
        client: {
          startThread: (options: { [key: string]: unknown }) => never;
        };
        clientKey: string;
      };
      runBackgroundStructuredPromptFromInput: <TOutput>(
        input: RunBackgroundStructuredPromptInput,
        parse: (rawText: string) => TOutput | null,
      ) => Promise<{
        threadId: string | null;
        rawText: string;
        output: TOutput | null;
        parsedJson: unknown | null;
        structuredOutput: undefined;
        rawItemsJson: string;
        usage: null;
        providerQuotaTelemetry: null;
      }>;
    };

    const backgroundInput = createCodexBackgroundPromptInput();
    let capturedThreadOptions: { [key: string]: unknown } | null = null;
    let capturedRunOptions: { [key: string]: unknown } | null = null;
    let capturedRunInput = "";
    let threadRunCalled = false;

    adapter.getClient = () => {
      return {
        client: {
          startThread: (threadOptions: { [key: string]: unknown }) => {
            capturedThreadOptions = threadOptions;
            return {
              id: "thread-1",
              run: async (input: string, options: { [key: string]: unknown }) => {
                threadRunCalled = true;
                capturedRunOptions = options;
                capturedRunInput = input;
                return {
                  finalResponse: "{\"answer\":\"ok\"}",
                  usage: null,
                };
              },
            } as never;
          },
        },
        clientKey: "client-key",
      };
    };

    const result = await adapter.runBackgroundStructuredPromptFromInput(backgroundInput, (rawText) => {
      return JSON.parse(rawText) as { answer: string };
    });

    assert.equal(threadRunCalled, true);
    assert.equal(capturedThreadOptions?.workingDirectory, backgroundInput.workspacePath);
    assert.equal(capturedThreadOptions?.skipGitRepoCheck, true);
    assert.equal(capturedThreadOptions?.sandboxMode, "read-only");
    assert.equal(capturedThreadOptions?.approvalPolicy, "never");
    assert.equal(capturedRunOptions?.outputSchema, backgroundInput.prompt.outputSchema);
    assert.equal(capturedRunInput, `${backgroundInput.prompt.systemText}\n\n${backgroundInput.prompt.userText}`.trim());
    assert.equal(result.rawText, "{\"answer\":\"ok\"}");
    assert.equal(result.output?.answer, "ok");
    assert.deepEqual(result.parsedJson, { answer: "ok" });
  });
});

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

  it("collab_tool_call がある場合は file_change 候補だけを信用せず snapshot fallback で差分を拾う", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-collab-diff-"));
    const adapter = new CodexAdapter() as unknown as {
      getClient: () => {
        client: {
          startThread: () => {
            id: string;
            runStreamed: () => Promise<{ events: AsyncGenerator<never> }>;
          };
          resumeThread: never;
        };
        clientKey: string;
      };
      runSessionTurn: CodexAdapter["runSessionTurn"];
    };

    try {
      await mkdir(path.join(workspacePath, "src"), { recursive: true });
      const explicitFilePath = path.join(workspacePath, "src", "explicit.ts");
      const collabSideEffectFilePath = path.join(workspacePath, "src", "collab-side-effect.ts");
      await writeFile(explicitFilePath, "before explicit\n", "utf8");
      await writeFile(collabSideEffectFilePath, "before collab\n", "utf8");

      adapter.getClient = () => ({
        client: {
          startThread: () => ({
            id: "thread-1",
            runStreamed: async () => ({
              events: createCodexStreamFromEvents([
                {
                  type: "item.completed",
                  item: {
                    id: "file-change-1",
                    type: "file_change",
                    status: "completed",
                    changes: [
                      {
                        kind: "update",
                        path: explicitFilePath,
                      },
                    ],
                  },
                },
                {
                  type: "item.completed",
                  item: {
                    id: "item_33",
                    type: "collab_tool_call",
                    tool: "close_agent",
                    status: "completed",
                    agents_states: {
                      "agent-1": {
                        status: "completed",
                        message: "Pass",
                      },
                    },
                  },
                },
                {
                  type: "item.completed",
                  item: {
                    id: "message-1",
                    type: "agent_message",
                    text: "done",
                  },
                },
                {
                  type: "turn.completed",
                  usage: null,
                },
              ], async () => {
                await writeFile(explicitFilePath, "after explicit\n", "utf8");
                await writeFile(collabSideEffectFilePath, "after collab\n", "utf8");
              }),
            }),
          }),
          resumeThread: undefined as never,
        },
        clientKey: "client-key",
      });

      const result = await adapter.runSessionTurn(createCodexRunSessionTurnInput(workspacePath));
      const changedPaths = result.artifact?.changedFiles.map((file) => file.path).sort();

      assert.deepEqual(changedPaths, [
        "src/collab-side-effect.ts",
        "src/explicit.ts",
      ]);
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
