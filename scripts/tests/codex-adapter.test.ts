import assert from "node:assert/strict";
import type { Stats } from "node:fs";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildNewSession } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import type { ModelCatalogProvider } from "../../src/model-catalog.js";
import {
  buildCodexThreadSettings,
  collectCodexAssistantTextFromEventsForTesting,
  resolveCodexThreadForSettings,
  type CodexThreadOptions,
} from "../../src-electron/codex-adapter.js";
import {
  _setWalkDirectoryStatOverrideForTesting,
  captureWorkspaceSnapshotPaths,
  createWorkspaceSnapshotIndex,
  refreshWorkspaceSnapshotIndex,
} from "../../src-electron/snapshot-ignore.js";

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
