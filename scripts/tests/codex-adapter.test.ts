import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";

import { buildNewSession } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import type { ModelCatalogProvider } from "../../src/model-catalog.js";
import {
  buildCodexThreadSettings,
  resolveCodexThreadForSettings,
  type CodexThreadOptions,
} from "../../src-electron/codex-adapter.js";
import {
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
      await sleep(10);
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
      await sleep(10);
      await writeFile(path.join(workspacePath, "src", "added.ts"), "added\n", "utf8");

      const refreshed = await refreshWorkspaceSnapshotIndex(index);

      assert.equal(refreshed.usedFullRebuild, true);
      assert.equal(refreshed.reason, "structure-change");
      assert.equal(refreshed.snapshot.get("src/added.ts"), "added\n");
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("refresh 後に file count limit へ達した場合は full rebuild に戻す", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-snapshot-index-limit-"));

    try {
      await writeFile(path.join(workspacePath, "only.txt"), "only\n", "utf8");

      const index = await createWorkspaceSnapshotIndex(workspacePath, { maxFileCount: 1 });
      const refreshed = await refreshWorkspaceSnapshotIndex(index);

      assert.equal(refreshed.usedFullRebuild, true);
      assert.equal(refreshed.reason, "limit");
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});
