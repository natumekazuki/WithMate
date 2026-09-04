import assert from "node:assert/strict";
import type { Stats } from "node:fs";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { Codex, CodexOptions } from "@openai/codex-sdk";

import { buildNewSession } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import type { ModelCatalogProvider, ModelReasoningEffort } from "../../src/model-catalog.js";
import {
  CodexAdapter,
  buildCodexProviderMetadata,
  buildCodexSpeedRunCheck,
  buildCodexThreadSettings,
  buildCodexStableRawItems,
  collectCodexAssistantResponseFromEventsForTesting,
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
import { toProviderMetadataLogData } from "../../src-electron/provider-metadata-log.js";
import {
  PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER,
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV,
  WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV,
  WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV,
} from "../../src-electron/provider-agent-runtime-binding.js";

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

function createCodexStreamThatNeverClosesAfter(events: unknown[]): AsyncGenerator<never> {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (index < events.length) {
        return { done: false as const, value: events[index++] as never };
      }
      return await new Promise<IteratorResult<never>>(() => {});
    },
    async return() {
      return await new Promise<IteratorResult<never>>(() => {});
    },
    async throw(error?: unknown) {
      throw error;
    },
  };
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

  it("turn.completed 後に stream が閉じなくても terminal event で成功へ収束する", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-terminal-event-"));
    const logs: Array<{ kind: string }> = [];
    const adapter = new CodexAdapter((entry) => logs.push(entry), {
      streamCloseGraceMs: 5,
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
            id: "thread-terminal",
            runStreamed: async () => ({
              events: createCodexStreamThatNeverClosesAfter([
                {
                  type: "item.completed",
                  item: { id: "message-1", type: "agent_message", text: "done" },
                },
                { type: "turn.completed", usage: null },
              ]),
            }),
          }),
          resumeThread: undefined as never,
        },
        clientKey: "client-key",
      });

      const result = await Promise.race([
        adapter.runSessionTurn(createCodexRunSessionTurnInput(workspacePath)),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("terminal timeout")), 100)),
      ]);

      assert.equal(result.threadId, "thread-terminal");
      assert.equal(result.assistantText, "done");
      assert.equal(logs.some((entry) => entry.kind === "codex.run.stream-close-timeout"), true);
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("再接続通知の後に turn.completed を受けた場合は成功へ収束する", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-reconnect-completed-"));
    const reconnectMessage =
      "Reconnecting... 2/5 (stream disconnected before completion: WebSocket protocol error)";
    const progressErrors: string[] = [];
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
            id: "thread-reconnect-completed",
            runStreamed: async () => ({
              events: createCodexStreamFromEvents([
                { type: "error", message: reconnectMessage },
                {
                  type: "item.completed",
                  item: { id: "message-1", type: "agent_message", text: "recovered" },
                },
                { type: "turn.completed", usage: null },
              ]),
            }),
          }),
          resumeThread: undefined as never,
        },
        clientKey: "client-key",
      });

      const result = await adapter.runSessionTurn(
        createCodexRunSessionTurnInput(workspacePath),
        (state) => progressErrors.push(state.errorMessage),
      );

      assert.equal(result.threadId, "thread-reconnect-completed");
      assert.equal(result.assistantText, "recovered");
      assert.deepEqual(progressErrors.filter(Boolean), [reconnectMessage]);
      assert.equal(progressErrors.at(-1), "");
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("再接続通知の後に turn.failed を受けた場合は最終エラーを返す", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-reconnect-failed-"));
    const reconnectMessage =
      "Reconnecting... 2/5 (stream disconnected before completion: WebSocket protocol error)";
    const finalErrorMessage = "stream disconnected before completion after 5 retries";
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
            id: "thread-reconnect-failed",
            runStreamed: async () => ({
              events: createCodexStreamFromEvents([
                { type: "error", message: reconnectMessage },
                { type: "turn.failed", error: { message: finalErrorMessage } },
              ]),
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
          assert.equal((error as Error).message, finalErrorMessage);
          return true;
        },
      );
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("terminal event のない EOF は成功扱いにしない", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-no-terminal-"));
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
            id: "thread-no-terminal",
            runStreamed: async () => ({
              events: createCodexStreamFromEvents([
                {
                  type: "item.completed",
                  item: { id: "message-1", type: "agent_message", text: "partial" },
                },
              ]),
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
          assert.equal((error as ProviderTurnError).partialResult.assistantText, "partial");
          assert.match((error as Error).message, /terminal turn event/);
          return true;
        },
      );
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("workspace diff 無効時は停止した snapshot を待たず結果へ収束する", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-snapshot-timeout-"));
    const adapter = new CodexAdapter(undefined, { snapshotDeadlineMs: 5 }) as unknown as {
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
      await writeFile(path.join(workspacePath, "tracked.txt"), "before\n", "utf8");
      adapter.getClient = () => ({
        client: {
          startThread: () => ({
            id: "thread-snapshot-timeout",
            runStreamed: async () => {
              _setWalkDirectoryStatOverrideForTesting(async () => {
                return await new Promise<Stats>(() => {});
              });
              return {
                events: createCodexStreamFromEvents([
                  {
                    type: "item.completed",
                    item: { id: "message-1", type: "agent_message", text: "done" },
                  },
                  { type: "turn.completed", usage: null },
                ]),
              };
            },
          }),
          resumeThread: undefined as never,
        },
        clientKey: "client-key",
      });

      const result = await Promise.race([
        adapter.runSessionTurn(createCodexRunSessionTurnInput(workspacePath)),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("snapshot timeout")), 100)),
      ]);

      assert.equal(result.assistantText, "done");
      assert.equal(
        result.providerMetadata?.some((entry) => entry.source === "codex-adapter.workspace-snapshot"),
        false,
      );
    } finally {
      _setWalkDirectoryStatOverrideForTesting(null);
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

      const failedLog = logs.find((entry) => entry.kind === "codex.run.stream-error");
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

  it("複数の top-level assistant message は連結本文と最後の非空 message を分けて保持する", () => {
    const response = collectCodexAssistantResponseFromEventsForTesting([
      {
        type: "item.completed",
        item: {
          id: "message-1",
          type: "agent_message",
          text: "最初の案内",
        },
      } as never,
      {
        type: "item.completed",
        item: {
          id: "message-2",
          type: "agent_message",
          text: "最後の案内",
        },
      } as never,
      {
        type: "item.completed",
        item: {
          id: "message-3",
          type: "agent_message",
          text: "   ",
        },
      } as never,
    ]);

    assert.deepEqual(response, {
      assistantText: "最初の案内\n\n最後の案内",
      lastNonEmptyAssistantMessageText: "最後の案内",
    });
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

  it("未知の Codex item は provider metadata に分類する", () => {
    const metadata = buildCodexProviderMetadata([
      {
        id: "item-new",
        type: "new_provider_item",
        payload: { value: 1 },
      } as never,
      {
        id: "message-1",
        type: "agent_message",
        text: "done",
      } as never,
    ]);

    assert.equal(metadata.length, 1);
    assert.equal(metadata[0]?.provider, "codex");
    assert.equal(metadata[0]?.kind, "unsupported_response");
    assert.equal(metadata[0]?.responseType, "new_provider_item");
    assert.equal(metadata[0]?.summary, "Unsupported Codex item: new_provider_item");
    assert.deepEqual(toProviderMetadataLogData(metadata[0]!), {
      provider: "codex",
      kind: "unsupported_response",
      source: "codex.thread_item",
      responseType: "new_provider_item",
      summary: "Unsupported Codex item: new_provider_item",
      payloadPresent: true,
      payloadRedacted: true,
      payloadType: "object",
    });
    assert.equal("payload" in toProviderMetadataLogData(metadata[0]!), false);
  });

  it("stream 診断ログは通常運用の app log に流さず summary だけ残す", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-collab-log-"));
    const previousDebugValue = process.env.WITHMATE_CODEX_STREAM_DEBUG;
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
      delete process.env.WITHMATE_CODEX_STREAM_DEBUG;
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
      assert.equal(openedLog, undefined);
      assert.equal(finishedLog, undefined);
      assert.equal(collabLog, undefined);
      assert.equal(completedLog?.data?.turnCompleted, true);
      assert.equal(completedLog?.data?.operationCount, 2);
      assert.equal(completedLog?.data?.hasUsage, false);
    } finally {
      if (previousDebugValue === undefined) {
        delete process.env.WITHMATE_CODEX_STREAM_DEBUG;
      } else {
        process.env.WITHMATE_CODEX_STREAM_DEBUG = previousDebugValue;
      }
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("debug flag 有効時は collab_tool_call の stream lifecycle を app log に流す", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-collab-debug-log-"));
    const previousDebugValue = process.env.WITHMATE_CODEX_STREAM_DEBUG;
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
      process.env.WITHMATE_CODEX_STREAM_DEBUG = "1";
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
      if (previousDebugValue === undefined) {
        delete process.env.WITHMATE_CODEX_STREAM_DEBUG;
      } else {
        process.env.WITHMATE_CODEX_STREAM_DEBUG = previousDebugValue;
      }
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

  // @test-value v1
  // kind = "invariant"
  // claim = "SpeedまたはReviewerが異なるSessionは異なるthread settings identityを持つ"
  // oracle = { type = "contract", ref = "CODEX-AUTO-REVIEW-AR-4" }
  // failure_mode = "Reviewer変更後も旧client/thread settingsを再利用して異なるreviewer設定でturnを実行する"
  // scope = "codex-thread-settings"
  // lifecycle = "permanent"
  // @end-test-value
  it("SpeedとReviewerの実値でthread settings keyを分離する", () => {
    const standard = createSession({ threadId: "thread-1", codexSpeed: "standard" });
    const fast = createSession({ threadId: "thread-1", codexSpeed: "fast" });
    const autoReview = createSession({
      threadId: "thread-1",
      codexSpeed: "standard",
      codexReviewer: "auto-review",
    });

    const standardSettings = buildCodexThreadSettings(standard, CODEX_PROVIDER_CATALOG, "client-key");
    const fastSettings = buildCodexThreadSettings(fast, CODEX_PROVIDER_CATALOG, "client-key");
    const autoReviewSettings = buildCodexThreadSettings(autoReview, CODEX_PROVIDER_CATALOG, "client-key");

    assert.notEqual(standardSettings.settingsKey, fastSettings.settingsKey);
    assert.notEqual(standardSettings.settingsKey, autoReviewSettings.settingsKey);
    assert.deepEqual(buildCodexSpeedRunCheck("standard"), { label: "speed", value: "standard" });
    assert.deepEqual(buildCodexSpeedRunCheck("fast"), { label: "speed", value: "fast" });
  });

  it("max / ultra を Codex thread options へそのまま渡す", () => {
    for (const reasoningEffort of ["max", "ultra"] as const) {
      const session = createSession({
        model: "gpt-5.6-sol",
        reasoningEffort,
      });

      const settings = buildCodexThreadSettings(session, CODEX_PROVIDER_CATALOG, "client-key");

      assert.equal(settings.options.model, "gpt-5.6-sol");
      assert.equal(settings.options.modelReasoningEffort, reasoningEffort);
    }
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

describe("CodexAdapter service tier clients", () => {
  // @test-value v1
  // kind = "invariant"
  // claim = "foreground clientはSessionのtierとReviewerを明示し、background clientはdefault tierとUser Reviewerを明示する"
  // oracle = { type = "contract", ref = "CODEX-AUTO-REVIEW-AR-4" }
  // failure_mode = "Reviewer変更後も旧clientを使う、global設定を継承する、またはbackground jobへAuto-reviewが漏れる"
  // scope = "codex-client-cache"
  // lifecycle = "permanent"
  // @end-test-value
  it("service_tierとReviewerでforeground/background clientを分離しrun checkへ記録する", async () => {
    const createdOptions: CodexOptions[] = [];
    const resumedThreadIds: string[] = [];
    let threadSequence = 0;
    const adapter = new CodexAdapter(undefined, {
      createClient: (options) => {
        createdOptions.push(options);
        const createThread = (threadId: string) => ({
          id: threadId,
          runStreamed: async () => ({
            events: createCodexStreamFromEvents([
              { type: "item.completed", item: { id: "message", type: "agent_message", text: "done" } },
              { type: "turn.completed", usage: null },
            ]),
          }),
          run: async () => ({ finalResponse: "{\"answer\":\"ok\"}", usage: null }),
        });
        return {
          startThread: () => createThread(`thread-${++threadSequence}`),
          resumeThread: (threadId: string) => {
            resumedThreadIds.push(threadId);
            return createThread(threadId);
          },
        } as Codex;
      },
    });
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-speed-client-"));

    try {
      const fastInput = createCodexRunSessionTurnInput(workspacePath);
      fastInput.session.codexSpeed = "fast";
      const fastResult = await adapter.runSessionTurn(fastInput);
      await adapter.runBackgroundStructuredPrompt(createCodexBackgroundPromptInput({ workspacePath }));
      const standardInput = createCodexRunSessionTurnInput(workspacePath);
      standardInput.session.id = fastInput.session.id;
      standardInput.session.threadId = fastResult.threadId;
      standardInput.session.codexSpeed = "standard";
      standardInput.session.codexReviewer = "auto-review";
      const autoReviewResult = await adapter.runSessionTurn(standardInput);
      const userInput = createCodexRunSessionTurnInput(workspacePath);
      userInput.session.id = fastInput.session.id;
      userInput.session.threadId = autoReviewResult.threadId;
      userInput.session.codexSpeed = "standard";
      userInput.session.codexReviewer = "user";
      const userResult = await adapter.runSessionTurn(userInput);

      assert.deepEqual(createdOptions.map((options) => options.config?.service_tier), ["fast", "default", "default", "default"]);
      assert.deepEqual(createdOptions.map((options) => options.config?.approvals_reviewer), [
        "user",
        "user",
        "auto_review",
        "user",
      ]);
      assert.deepEqual(resumedThreadIds, [fastResult.threadId, autoReviewResult.threadId]);
      assert.equal(fastResult.artifact?.runChecks.some((check) => check.label === "speed" && check.value === "fast"), true);
      assert.equal(autoReviewResult.artifact?.runChecks.some(
        (check) => check.label === "reviewer" && check.value === "auto-review",
      ), true);
      assert.equal(userResult.artifact?.runChecks.some(
        (check) => check.label === "reviewer" && check.value === "user",
      ), true);
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
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

  it("background timeout signalをSDK runへ渡しAbortErrorへ収束させる", async () => {
    const adapter = new CodexAdapter() as unknown as {
      getClient: () => {
        client: {
          startThread: () => {
            id: string;
            run: (_input: string, options: { signal: AbortSignal }) => Promise<never>;
          };
        };
        clientKey: string;
      };
      runBackgroundStructuredPromptFromInput: <TOutput>(
        input: RunBackgroundStructuredPromptInput,
        parse: (rawText: string) => TOutput | null,
      ) => Promise<unknown>;
    };
    let observedAbort = false;
    adapter.getClient = () => ({
      client: {
        startThread: () => ({
          id: "thread-timeout",
          run: async (_input, options) => await new Promise<never>((_resolve, reject) => {
            options.signal.addEventListener("abort", () => {
              observedAbort = true;
              const error = new Error("The operation was aborted");
              error.name = "AbortError";
              reject(error);
            }, { once: true });
          }),
        }),
      },
      clientKey: "client-key",
    });

    await assert.rejects(
      () => adapter.runBackgroundStructuredPromptFromInput(
        createCodexBackgroundPromptInput({ timeoutMs: 1 }),
        JSON.parse,
      ),
      (error) => error instanceof Error && error.name === "AbortError",
    );
    assert.equal(observedAbort, true);
  });
});

describe("CodexAdapter agent runtime binding", () => {
// @test-value v1
// kind = "invariant"
// claim = "Codex clients for different Memory owners receive distinct selectors while background clients remain unbound"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "Codex client reuses another instance generation or exposes owner selectors through global environment"
// scope = "codex-provider-adapter"
// lifecycle = "permanent"
// @end-test-value
it("Session generationごとのclient envを分離しbackground clientをunboundに保つ", () => {
    const adapter = new CodexAdapter() as unknown as {
      getClient: (
        providerId: string,
        appSettings: ReturnType<typeof createDefaultAppSettings>,
        binding?: {
          bindingId: string;
          bindingReference: string;
          providerId: string;
          executionGeneration: string;
          transport: "env";
          expiresAt: null;
          memoryRuntimeOwner?: {
            applicationInstanceId: string;
            runtimeGenerationId: string;
          };
        },
      ) => {
        client: { options: { env?: Record<string, string> } };
        clientKey: string;
      };
    };
    const settings = createDefaultAppSettings();
    const before = process.env[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV];
    const beforeApplicationInstance = process.env[WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV];
    const beforeGeneration = process.env[WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV];
    const bindingA = {
      bindingId: "binding-a",
      bindingReference: "opaque-reference-a",
      providerId: "codex",
      executionGeneration: "generation-a",
      transport: "env" as const,
      expiresAt: null,
      memoryRuntimeOwner: { applicationInstanceId: "app-instance-a", runtimeGenerationId: "memory-generation-a" },
    };
    const bindingB = {
      bindingId: "binding-b",
      bindingReference: "opaque-reference-b",
      providerId: "codex",
      executionGeneration: "generation-b",
      transport: "env" as const,
      expiresAt: null,
      memoryRuntimeOwner: { applicationInstanceId: "app-instance-b", runtimeGenerationId: "memory-generation-b" },
    };

    const clientA = adapter.getClient("codex", settings, bindingA);
    const clientARetry = adapter.getClient("codex", settings, bindingA);
    const clientB = adapter.getClient("codex", settings, bindingB);
    const backgroundClient = adapter.getClient("codex", settings);

    assert.equal(clientA.client, clientARetry.client);
    assert.notEqual(clientA.client, clientB.client);
    assert.notEqual(clientA.clientKey, clientB.clientKey);
    assert.equal(
      clientA.client.options.env?.[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV],
      bindingA.bindingReference,
    );
    assert.equal(
      clientB.client.options.env?.[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV],
      bindingB.bindingReference,
    );
    assert.equal(clientA.client.options.env?.[WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV], "app-instance-a");
    assert.equal(clientA.client.options.env?.[WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV], "memory-generation-a");
    assert.equal(clientB.client.options.env?.[WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV], "app-instance-b");
    assert.equal(clientB.client.options.env?.[WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV], "memory-generation-b");
    assert.equal(
      backgroundClient.client.options.env?.[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV],
      undefined,
    );
    assert.equal(backgroundClient.client.options.env?.[WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV], undefined);
    assert.equal(backgroundClient.client.options.env?.[WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV], undefined);
    assert.equal(
      Object.keys(backgroundClient.client.options.env ?? {}).some(
        (key) => key.toLowerCase() === WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV.toLowerCase()
          || key.toLowerCase() === WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV.toLowerCase(),
      ),
      false,
    );
    assert.equal(process.env[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV], before);
    assert.equal(process.env[WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV], beforeApplicationInstance);
    assert.equal(process.env[WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV], beforeGeneration);
  });

  it("binding referenceをprovider由来のlive・audit projectionから除去しlogical promptは変更しない", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-binding-redaction-"));
    const bindingReference = "opaque-reference-redaction-probe";
    const logs: unknown[] = [];
    const progress: unknown[] = [];
    const adapter = new CodexAdapter((entry) => logs.push(entry)) as unknown as {
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
            id: "thread-redaction",
            runStreamed: async () => ({
              events: createCodexStreamFromEvents([
                {
                  type: "item.completed",
                  item: {
                    id: "command-1",
                    type: "command_execution",
                    command: "env",
                    aggregated_output: `secret=${bindingReference}`,
                    status: "completed",
                    exit_code: 0,
                  },
                },
                {
                  type: "item.completed",
                  item: { id: "message-1", type: "agent_message", text: `answer ${bindingReference}` },
                },
                { type: "turn.completed", usage: null },
              ]),
            }),
          }),
          resumeThread: undefined as never,
        },
        clientKey: "client-key",
      });
      const input = createCodexRunSessionTurnInput(workspacePath);
      input.userMessage = `user supplied ${bindingReference}`;
      input.agentRuntimeBinding = {
        bindingId: "binding-redaction",
        bindingReference,
        providerId: "codex",
        executionGeneration: "generation-redaction",
        transport: "env",
        expiresAt: null,
      };

      const result = await adapter.runSessionTurn(input, (state) => {
        progress.push(state);
      });

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
      assert.doesNotMatch(JSON.stringify(progress), new RegExp(bindingReference));
      assert.doesNotMatch(JSON.stringify(logs), new RegExp(bindingReference));
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("binding referenceをprovider errorと通常logから除去する", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-codex-binding-error-redaction-"));
    const bindingReference = "opaque-reference-error-redaction-probe";
    const logs: unknown[] = [];
    const adapter = new CodexAdapter((entry) => logs.push(entry)) as unknown as {
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
            id: "thread-error-redaction",
            runStreamed: async () => ({
              events: createCodexStreamFromEvents([{
                type: "turn.failed",
                error: { message: `provider echoed ${bindingReference}` },
              }]),
            }),
          }),
          resumeThread: undefined as never,
        },
        clientKey: "client-key",
      });
      const input = createCodexRunSessionTurnInput(workspacePath);
      input.agentRuntimeBinding = {
        bindingId: "binding-error-redaction",
        bindingReference,
        providerId: "codex",
        executionGeneration: "generation-error-redaction",
        transport: "env",
        expiresAt: null,
      };

      await assert.rejects(
        () => adapter.runSessionTurn(input),
        (error: unknown) => {
          assert.ok(error instanceof ProviderTurnError);
          assert.doesNotMatch(error.message, new RegExp(bindingReference));
          assert.match(error.message, new RegExp(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER));
          return true;
        },
      );

      assert.doesNotMatch(JSON.stringify(logs), new RegExp(bindingReference));
      assert.match(JSON.stringify(logs), new RegExp(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER));
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
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

  it("workspace diff 無効時は snapshot fallback を使わず明示された変更ファイルだけを残す", async () => {
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
      const changedFiles = result.artifact?.changedFiles ?? [];
      const changedPaths = changedFiles.map((file) => file.path).sort();

      assert.deepEqual(changedPaths, ["src/explicit.ts"]);
      assert.deepEqual(changedFiles[0]?.diffRows, []);
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
