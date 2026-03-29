import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildNewSession } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import type { ModelCatalogProvider } from "../../src/model-catalog.js";
import {
  buildCodexThreadSettings,
  resolveCodexThreadForSettings,
  type CodexThreadOptions,
} from "../../src-electron/codex-adapter.js";

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
}) {
  const {
    threadId = "",
    model = "gpt-5.4",
    reasoningEffort = "high",
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
      approvalMode: DEFAULT_APPROVAL_MODE,
      model,
      reasoningEffort,
    }),
    threadId,
  };
}

describe("CodexAdapter thread settings", () => {
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
