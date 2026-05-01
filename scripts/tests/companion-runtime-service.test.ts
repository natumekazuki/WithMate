import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src/codex-sandbox-mode.js";
import type { CompanionSession } from "../../src/companion-state.js";
import { DEFAULT_CATALOG_REVISION, DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT, type ModelCatalogProvider } from "../../src/model-catalog.js";
import { normalizeAppSettings } from "../../src/provider-settings-state.js";
import type { ComposerPreview, LiveApprovalDecision, ProviderQuotaTelemetry, SessionContextTelemetry } from "../../src/runtime-state.js";
import type { ProviderCodingAdapter, RunSessionTurnInput } from "../../src-electron/provider-runtime.js";
import { CompanionRuntimeService } from "../../src-electron/companion-runtime-service.js";

function createProviderCatalog(): ModelCatalogProvider {
  return {
    id: "codex",
    label: "Codex",
    defaultModelId: "gpt-5.4",
    defaultReasoningEffort: "high",
    models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["medium", "high"] }],
  };
}

function createCompanionSession(overrides?: Partial<CompanionSession>): CompanionSession {
  return {
    id: "companion-session-1",
    groupId: "group-1",
    taskTitle: "Companion task",
    status: "active",
    repoRoot: "F:/repo",
    focusPath: "src",
    targetBranch: "main",
    baseSnapshotRef: "refs/withmate/companion/session-1/base",
    baseSnapshotCommit: "abc123",
    companionBranch: "withmate/companion/session-1",
    worktreePath: "F:/repo/.withmate/companion-worktree",
    selectedPaths: [],
    changedFiles: [],
    siblingWarnings: [],
    runState: "idle",
    threadId: "",
    provider: "codex",
    catalogRevision: DEFAULT_CATALOG_REVISION,
    model: DEFAULT_MODEL_ID,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    customAgentName: "",
    approvalMode: DEFAULT_APPROVAL_MODE,
    codexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
    characterId: "char-1",
    character: "Mia",
    characterRoleMarkdown: "落ち着いて伴走する。",
    characterIconPath: "icon.png",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    createdAt: "2026-04-26 10:00",
    updatedAt: "2026-04-26 10:00",
    messages: [],
    ...overrides,
  };
}

describe("CompanionRuntimeService", () => {
  it("CompanionSession の shadow worktree を provider 実行 workspace として渡して会話を保存する", async () => {
    let storedSession = createCompanionSession();
    const storedSessions: CompanionSession[] = [];
    const runInputRef: { current: RunSessionTurnInput | null } = { current: null };
    const adapter: ProviderCodingAdapter = {
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      async getProviderQuotaTelemetry() {
        return null;
      },
      invalidateSessionThread() {},
      invalidateAllSessionThreads() {},
      async runSessionTurn(input) {
        runInputRef.current = input;
        return {
          threadId: "thread-1",
          assistantText: "完了したよ。",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          transportPayload: null,
          operations: [],
          rawItemsJson: "[]",
          usage: null,
        };
      },
    };

    const service = new CompanionRuntimeService({
      getCompanionSession(sessionId) {
        return sessionId === storedSession.id ? storedSession : null;
      },
      updateCompanionSession(nextSession) {
        storedSession = nextSession;
        storedSessions.push(nextSession);
        return nextSession;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] } satisfies ComposerPreview;
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      resolveProviderCatalog() {
        const provider = createProviderCatalog();
        return { snapshot: { revision: 1, providers: [provider] }, provider };
      },
      getProviderCodingAdapter() {
        return adapter;
      },
      setLiveSessionRun() {},
      getLiveSessionRun() {
        return null;
      },
      async waitForApprovalDecision(): Promise<LiveApprovalDecision> {
        return "approve";
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry(_telemetry: ProviderQuotaTelemetry) {},
      setSessionContextTelemetry(_telemetry: SessionContextTelemetry) {},
      invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      clearWorkspaceFileIndex() {},
      broadcastCompanionSessions() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel: () => "2026-04-26 10:01",
    });

    const result = await service.runSessionTurn(storedSession.id, {
      userMessage: "お願いします",
      model: "gpt-5.4",
      reasoningEffort: "medium",
      approvalMode: "on-request",
      codexSandboxMode: "read-only",
    });

    const runInput = runInputRef.current;
    assert.ok(runInput);
    assert.equal(runInput.session.workspacePath, "F:/repo/.withmate/companion-worktree");
    assert.equal(runInput.session.model, "gpt-5.4");
    assert.equal(runInput.session.reasoningEffort, "medium");
    assert.equal(runInput.session.approvalMode, "on-request");
    assert.equal(runInput.session.codexSandboxMode, "read-only");
    assert.equal(runInput.executionWorkspacePath, "F:/repo/.withmate/companion-worktree");
    assert.equal(result.runState, "idle");
    assert.equal(result.threadId, "thread-1");
    assert.equal(result.model, "gpt-5.4");
    assert.equal(result.reasoningEffort, "medium");
    assert.equal(result.approvalMode, "on-request");
    assert.equal(result.codexSandboxMode, "read-only");
    assert.deepEqual(result.messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal(result.messages[0]?.text, "お願いします");
    assert.equal(result.messages[1]?.text, "完了したよ。");
    assert.equal(storedSessions[0]?.runState, "running");
    assert.equal(storedSessions[0]?.model, "gpt-5.4");
    assert.equal(storedSessions[0]?.reasoningEffort, "medium");
    assert.equal(storedSessions[0]?.approvalMode, "on-request");
    assert.equal(storedSessions[0]?.codexSandboxMode, "read-only");
    assert.equal(storedSessions[1]?.runState, "idle");
  });

  it("起動時に running の CompanionSession を error に戻して操作可能にする", () => {
    let storedSession = createCompanionSession({
      runState: "running",
      messages: [{ role: "user", text: "続けて" }],
    });
    let broadcastCount = 0;
    const liveCleared: string[] = [];

    const service = new CompanionRuntimeService({
      getCompanionSession(sessionId) {
        return sessionId === storedSession.id ? storedSession : null;
      },
      listCompanionSessionSummaries() {
        return [storedSession];
      },
      updateCompanionSession(nextSession) {
        storedSession = nextSession;
        return nextSession;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] } satisfies ComposerPreview;
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      resolveProviderCatalog() {
        const provider = createProviderCatalog();
        return { snapshot: { revision: 1, providers: [provider] }, provider };
      },
      getProviderCodingAdapter() {
        throw new Error("unexpected provider access");
      },
      setLiveSessionRun(sessionId, state) {
        if (state === null) {
          liveCleared.push(sessionId);
        }
      },
      getLiveSessionRun() {
        return null;
      },
      async waitForApprovalDecision(): Promise<LiveApprovalDecision> {
        return "approve";
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry(_telemetry: ProviderQuotaTelemetry) {},
      setSessionContextTelemetry(_telemetry: SessionContextTelemetry) {},
      invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      clearWorkspaceFileIndex() {},
      broadcastCompanionSessions() {
        broadcastCount += 1;
      },
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel: () => "2026-04-26 10:02",
    });

    service.recoverInterruptedSessions();

    assert.equal(storedSession.runState, "error");
    assert.equal(storedSession.updatedAt, "2026-04-26 10:02");
    assert.equal(storedSession.messages.at(-1)?.role, "assistant");
    assert.match(storedSession.messages.at(-1)?.text ?? "", /中断/);
    assert.deepEqual(liveCleared, [storedSession.id]);
    assert.equal(broadcastCount, 1);
  });
});
