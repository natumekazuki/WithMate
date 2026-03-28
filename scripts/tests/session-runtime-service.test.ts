import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildNewSession,
  currentTimestampLabel,
  type AuditLogEntry,
  type CharacterProfile,
  type ComposerPreview,
  type LiveApprovalDecision,
  type LiveApprovalRequest,
  type LiveSessionRunState,
  type ProviderQuotaTelemetry,
  type ProjectMemoryEntry,
  type Session,
  type SessionContextTelemetry,
  type SessionMemory,
} from "../../src/app-state.js";
import { normalizeAppSettings } from "../../src/provider-settings-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { type ModelCatalogProvider } from "../../src/model-catalog.js";
import { ProviderTurnError, type ProviderCodingAdapter } from "../../src-electron/provider-runtime.js";
import { SessionRuntimeService } from "../../src-electron/session-runtime-service.js";

function createSession(overrides?: Partial<Session>): Session {
  return {
    ...buildNewSession({
      taskTitle: "Runtime Test",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
    }),
    ...overrides,
  };
}

function createSessionMemory(sessionId: string): SessionMemory {
  return {
    sessionId,
    workspacePath: "C:/workspace",
    threadId: "",
    schemaVersion: 1,
    goal: "テストする",
    decisions: [],
    openQuestions: [],
    nextActions: [],
    notes: [],
    updatedAt: new Date().toISOString(),
  };
}

function createCharacter(): CharacterProfile {
  return {
    id: "char-a",
    name: "A",
    iconPath: "",
    roleMarkdown: "落ち着いて伴走する。",
    description: "",
    themeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    sessionCopy: {
      pendingApproval: [],
      pendingWorking: [],
      pendingResponding: [],
      pendingPreparing: [],
      retryInterruptedTitle: [],
      retryFailedTitle: [],
      retryCanceledTitle: [],
      latestCommandWaiting: [],
      latestCommandEmpty: [],
      changedFilesEmpty: [],
      contextEmpty: [],
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createProviderCatalog(id = "codex"): ModelCatalogProvider {
  return {
    id,
    label: id,
    defaultModelId: "gpt-5.4",
    defaultReasoningEffort: "high",
    models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["medium", "high"] }],
  };
}

function createAuditLogBase(input: Omit<AuditLogEntry, "id">): AuditLogEntry {
  return {
    id: 1,
    ...input,
  };
}

describe("SessionRuntimeService", () => {
  it("成功時に running -> idle を保存し、background task を起動する", async () => {
    const session = createSession();
    const storedSessions: Session[] = [];
    const auditUpdates: AuditLogEntry[] = [];
    const liveStates: Array<LiveSessionRunState | null> = [];
    const memoryTriggers: Array<{ sessionId: string; triggerReason: string }> = [];
    const reflectionTriggers: Array<{ sessionId: string; triggerReason: string }> = [];
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
      async runSessionTurn(input, onProgress) {
        await onProgress?.({
          sessionId: input.session.id,
          threadId: "",
          assistantText: "",
          steps: [],
          usage: null,
          errorMessage: "",
          approvalRequest: null,
        });
        return {
          threadId: "thread-1",
          assistantText: "完了したよ。",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          transportPayload: { summary: "transport", fields: [] },
          operations: [],
          rawItemsJson: "[]",
          usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 220 },
          providerQuotaTelemetry: {
            provider: "copilot",
            updatedAt: "2026-03-29T04:10:00.000Z",
            snapshots: [
              {
                quotaKey: "premium_interactions",
                entitlementRequests: 500,
                usedRequests: 120,
                remainingPercentage: 76.4,
                overage: 0,
                overageAllowedWithExhaustedQuota: false,
                resetDate: "2026-04-01T00:00:00.000Z",
              },
            ],
          },
        };
      },
    };

    const service = new SessionRuntimeService({
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      upsertSession(next) {
        storedSessions.push(next);
        return next;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] } satisfies ComposerPreview;
      },
      async resolveSessionCharacter() {
        return createCharacter();
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      resolveProviderCatalog() {
        return { snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() };
      },
      getProviderCodingAdapter() {
        return adapter;
      },
      getSessionMemory(current) {
        return createSessionMemory(current.id);
      },
      resolveProjectMemoryEntriesForPrompt(): ProjectMemoryEntry[] {
        return [];
      },
      createAuditLog(input) {
        return createAuditLogBase(input);
      },
      updateAuditLog(_id, entry) {
        auditUpdates.push(entry);
      },
      setLiveSessionRun(_sessionId, state) {
        liveStates.push(state);
      },
      getLiveSessionRun() {
        return null;
      },
      async waitForApprovalDecision(_sessionId, _request, _signal) {
        return "approve" satisfies LiveApprovalDecision;
      },
      setProviderQuotaTelemetry(_telemetry: ProviderQuotaTelemetry) {},
      setSessionContextTelemetry(_telemetry: SessionContextTelemetry) {},
      invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      runSessionMemoryExtraction(nextSession, _usage, options) {
        memoryTriggers.push({ sessionId: nextSession.id, triggerReason: options.triggerReason });
      },
      runCharacterReflection(nextSession, options) {
        reflectionTriggers.push({ sessionId: nextSession.id, triggerReason: options.triggerReason });
      },
      clearWorkspaceFileIndex() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, { userMessage: "お願いします" });

    assert.equal(result.runState, "idle");
    assert.equal(storedSessions.length, 2);
    assert.equal(storedSessions[0]?.runState, "running");
    assert.equal(storedSessions[1]?.runState, "idle");
    assert.equal(storedSessions[1]?.messages.at(-1)?.text, "完了したよ。");
    assert.equal(auditUpdates.at(-1)?.phase, "completed");
    assert.equal(
      auditUpdates.at(-1)?.transportPayload?.fields.find((field) => field.label === "remainingPercentage")?.value,
      "76%",
    );
    assert.equal(
      auditUpdates.at(-1)?.transportPayload?.fields.find((field) => field.label === "projectMemoryHits")?.value,
      "0",
    );
    assert.equal(
      auditUpdates.at(-1)?.transportPayload?.fields.find((field) => field.label === "attachmentCount")?.value,
      "0",
    );
    assert.deepEqual(memoryTriggers, [{ sessionId: session.id, triggerReason: "outputTokensThreshold" }]);
    assert.deepEqual(reflectionTriggers, [{ sessionId: session.id, triggerReason: "context-growth" }]);
    assert.equal(liveStates.at(-1), null);
    assert.equal(service.isRunInFlight(session.id), false);
  });

  it("provider failure 時は error session を保存し、cancel 時は idle へ戻す", async () => {
    const baseSession = createSession();
    const storedSessions: Session[] = [];
    const auditUpdates: AuditLogEntry[] = [];
    let canceledSessionId: string | null = null;
    const partialResult = {
      threadId: "thread-2",
      assistantText: "",
      logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
      transportPayload: null,
      operations: [],
      rawItemsJson: "[]",
      usage: null,
    };
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
      invalidateSessionThread(sessionId) {
        canceledSessionId = sessionId;
      },
      invalidateAllSessionThreads() {},
      async runSessionTurn() {
        throw new ProviderTurnError("cancelled", partialResult, true);
      },
    };

    const service = new SessionRuntimeService({
      getSession() {
        return baseSession;
      },
      upsertSession(next) {
        storedSessions.push(next);
        return next;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] };
      },
      async resolveSessionCharacter() {
        return createCharacter();
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      resolveProviderCatalog() {
        return { snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() };
      },
      getProviderCodingAdapter() {
        return adapter;
      },
      getSessionMemory(current) {
        return createSessionMemory(current.id);
      },
      resolveProjectMemoryEntriesForPrompt() {
        return [];
      },
      createAuditLog(input) {
        return createAuditLogBase(input);
      },
      updateAuditLog(_id, entry) {
        auditUpdates.push(entry);
      },
      setLiveSessionRun() {},
      getLiveSessionRun() {
        return null;
      },
      async waitForApprovalDecision(_sessionId, _request, _signal) {
        return "deny";
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      invalidateProviderSessionThread(providerId, sessionId) {
        adapter.invalidateSessionThread(sessionId);
      },
      scheduleProviderQuotaTelemetryRefresh() {},
      runSessionMemoryExtraction() {},
      runCharacterReflection() {},
      clearWorkspaceFileIndex() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(baseSession.id, { userMessage: "お願いします" });

    assert.equal(result.runState, "idle");
    assert.match(result.messages.at(-1)?.text ?? "", /キャンセル/);
    assert.equal(auditUpdates.at(-1)?.phase, "canceled");
    assert.equal(canceledSessionId, baseSession.id);
  });

  it("実行中の session は in-flight として見え、完了後に解放される", async () => {
    const session = createSession();
    let resolveRun: ((value: {
      threadId: string | null;
      assistantText: string;
      logicalPrompt: { systemText: string; inputText: string; composedText: string };
      transportPayload: null;
      operations: [];
      rawItemsJson: string;
      usage: null;
    }) => void) | null = null;

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
      runSessionTurn() {
        return new Promise((resolve) => {
          resolveRun = resolve;
        });
      },
    };

    const service = new SessionRuntimeService({
      getSession() {
        return session;
      },
      upsertSession(next) {
        return next;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] };
      },
      async resolveSessionCharacter() {
        return createCharacter();
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      resolveProviderCatalog() {
        return { snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() };
      },
      getProviderCodingAdapter() {
        return adapter;
      },
      getSessionMemory(current) {
        return createSessionMemory(current.id);
      },
      resolveProjectMemoryEntriesForPrompt() {
        return [];
      },
      createAuditLog(input) {
        return createAuditLogBase(input);
      },
      updateAuditLog() {},
      setLiveSessionRun() {},
      getLiveSessionRun() {
        return null;
      },
      async waitForApprovalDecision(_sessionId, _request, _signal) {
        return "approve";
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      runSessionMemoryExtraction() {},
      runCharacterReflection() {},
      clearWorkspaceFileIndex() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      currentTimestampLabel,
    });

    const promise = service.runSessionTurn(session.id, { userMessage: "お願いします" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(service.isRunInFlight(session.id), true);
    resolveRun?.({
      threadId: "thread-3",
      assistantText: "完了したよ。",
      logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
      transportPayload: null,
      operations: [],
      rawItemsJson: "[]",
      usage: null,
    });
    await promise;
    assert.equal(service.isRunInFlight(session.id), false);
  });
});
