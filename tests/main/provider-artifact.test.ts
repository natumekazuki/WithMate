import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MessageOperation, ProviderUsage } from "../../src-shared/session/runtime-state.js";
import type { Session } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { ModelCatalogProvider, ResolvedModelSelection } from "../../src-shared/settings/model-catalog.js";
import { buildArtifactFromOperations } from "../../src-electron/providers/provider-artifact.js";
import type { SnapshotCaptureStats, WorkspaceSnapshot } from "../../src-electron/platform/snapshot-ignore.js";
import { normalizeMessage } from "../../src-shared/session/session-state.js";

// @test-value v2
// kind = "contract"
// claim = "通常履歴の新操作は取得済み結果を順序どおり保持し既存操作の欠損情報を補完しない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "optional結果情報を読取で落とすか旧履歴を成功・exitCode 0へ補完する"
// observable = "normalizeMessage後のartifact操作配列とoptional結果情報"
// observation_boundary = "public-boundary"
// scope = "normal history artifact normalization"
// lifecycle = "permanent"
// impact = "履歴のコマンド結果を誤表示し再保存時に取得済み詳細を失う"
// distinction = "型検査では既存JSONの欠損と新JSONの正規化結果を検証できない"
// @end-test-value
it("履歴の操作結果を保持し旧操作の未記録を補完しない", () => {
  const operations: MessageOperation[] = [
    { type: "command_execution", summary: "old", details: "old detail" },
    { id: "failed", type: "command_execution", summary: "new", status: "failed", exitCode: 9,
      error: { message: "failure", code: "E_TOOL" }, truncated: true, details: "partial" },
    { id: "pending", type: "command_execution", summary: "pending", status: "in_progress" },
  ];
  const message = normalizeMessage({ role: "assistant", text: "body", artifact: {
    title: "Result", activitySummary: [], changedFiles: [], runChecks: [], operationTimeline: operations,
  } })!;
  const recorded = message.artifact!.operationTimeline!;
  assert.deepEqual(JSON.parse(JSON.stringify(recorded)), operations);
  assert.equal(recorded[0].status, undefined);
  assert.equal(recorded[0].exitCode, undefined);
  assert.equal(recorded[0].truncated, undefined);
  assert.equal(message.text, "body");
});

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
    isPinned: false,
    sessionKind: "default",
    accessMode: "active",
    sourceSchemaVersion: 1,
    codexSpeed: "standard",
    codexReviewer: "user",
    taskTitle: "CSV を作る",
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
    characterRuntimeSnapshot: null,
    runState: "idle",
    approvalMode: "on-request",
    codexSandboxMode: "workspace-write",
    model: "gpt-5-mini",
    reasoningEffort: "medium",
    threadId: "thread-1",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    messages: [],
    stream: [],
  };
}

describe("provider artifact", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "artifactはoperationsとsnapshot diffから変更ファイルとrun checksを組み立てる"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md#Artifact-Summary-Policy" }
  // fault = "snapshot差分または操作をartifactから落とす"
  // observable = "artifact changedFiles、operationTimeline、runChecks"
  // observation_boundary = "component-behavior"
  // scope = "operations と snapshot diff"
  // lifecycle = "permanent"
  // impact = "turn結果の変更内容を利用者が確認できない"
  // distinction = "Provider SDK設定testではartifact projectionを観測しない"
  // @end-test-value
  it("operations と snapshot diff から最小 artifact を組み立てる", () => {
    const beforeSnapshot: WorkspaceSnapshot = new Map();
    const afterSnapshot: WorkspaceSnapshot = new Map([["tmp/output.txt", "hello"]]);
    const operations: MessageOperation[] = [
      {
        type: "command_execution",
        summary: "create tmp/output.txt",
      },
    ];
    const usage: ProviderUsage = {
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
      executionOptions: captureSessionExecutionOptions(createSession()),
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

