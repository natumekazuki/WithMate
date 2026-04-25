import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AuditLogOperation, AuditLogUsage, Session } from "../../src/app-state.js";
import type { ModelCatalogProvider, ResolvedModelSelection } from "../../src/model-catalog.js";
import { buildArtifactFromOperations } from "../../src-electron/provider-artifact.js";
import type { SnapshotCaptureStats, WorkspaceSnapshot } from "../../src-electron/snapshot-ignore.js";

const EMPTY_SNAPSHOT_STATS: SnapshotCaptureStats = {
  capturedFiles: 1,
  capturedBytes: 10,
  skippedBinaryOrOversizeFiles: 0,
  skippedByLimitFiles: 0,
  hitFileCountLimit: false,
  hitTotalBytesLimit: false,
};

function createSession(): Session {
  return {
    id: "session-1",
    taskTitle: "CSV を作る",
    taskSummary: "",
    status: "idle",
    updatedAt: "2026-03-23 00:00",
    provider: "copilot",
    catalogRevision: 1,
    workspaceLabel: "repo",
    workspacePath: "F:/repo",
    branch: "main",
    characterId: "char-1",
    character: "test",
    characterIconPath: "",
    characterThemeColors: { main: "#fff", sub: "#000" },
    runState: "idle",
    approvalMode: "on-request",
    model: "gpt-5-mini",
    reasoningEffort: "medium",
    threadId: "thread-1",
    messages: [],
    stream: [],
  };
}

describe("provider artifact", () => {
  it("operations と snapshot diff から最小 artifact を組み立てる", () => {
    const beforeSnapshot: WorkspaceSnapshot = new Map();
    const afterSnapshot: WorkspaceSnapshot = new Map([["tmp/output.txt", "hello"]]);
    const operations: AuditLogOperation[] = [
      {
        type: "command_execution",
        summary: "create tmp/output.txt",
      },
    ];
    const usage: AuditLogUsage = {
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 20,
    };
    const providerCatalog: ModelCatalogProvider = {
      id: "copilot",
      label: "GitHub Copilot",
      defaultModelId: "gpt-5-mini",
      defaultReasoningEffort: "medium",
      models: [
        {
          id: "gpt-5-mini",
          label: "GPT-5 Mini",
          reasoningEfforts: ["low", "medium", "high"],
        },
      ],
    };
    const selection: ResolvedModelSelection = {
      requestedModel: "gpt-5-mini",
      resolvedModel: "gpt-5-mini",
      requestedReasoningEffort: "medium",
      resolvedReasoningEffort: "medium",
    };

    const artifact = buildArtifactFromOperations({
      session: createSession(),
      operations,
      usage,
      threadId: "thread-1",
      beforeSnapshot,
      afterSnapshot,
      beforeSnapshotStats: EMPTY_SNAPSHOT_STATS,
      afterSnapshotStats: EMPTY_SNAPSHOT_STATS,
      providerCatalog,
      selection,
    });

    assert.ok(artifact);
    assert.equal(artifact.title, "CSV を作る");
    assert.equal(artifact.changedFiles.length, 1);
    assert.equal(artifact.changedFiles[0]?.path, "tmp/output.txt");
    assert.equal(artifact.changedFiles[0]?.kind, "add");
    assert.equal(artifact.operationTimeline?.[0]?.summary, "create tmp/output.txt");
    assert.equal(artifact.runChecks.some((check) => check.label === "provider" && check.value === "GitHub Copilot"), true);
  });
});

