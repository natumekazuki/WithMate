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
import {
  ProviderTurnError,
  type ProviderCodingAdapter,
  type RunSessionTurnResult,
} from "../../src-electron/provider-runtime.js";
import {
  SessionRuntimeService,
  hasMeaningfulPartialRunResult,
  isRetryableStaleThreadSessionError,
  type SessionRuntimeServiceDeps,
} from "../../src-electron/session-runtime-service.js";

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
    notesMarkdown: "",
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

type CreateAuditLogInput = Parameters<SessionRuntimeServiceDeps["createAuditLog"]>[0];
type UpdateAuditLogInput = Parameters<SessionRuntimeServiceDeps["updateAuditLog"]>[1];

function createAuditLogBase(input: CreateAuditLogInput): AuditLogEntry {
  return {
    id: 1,
    ...input,
  };
}

function createPartialResult(overrides?: Partial<RunSessionTurnResult>): RunSessionTurnResult {
  return {
    threadId: null,
    assistantText: "",
    logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
    transportPayload: null,
    operations: [],
    rawItemsJson: "[]",
    usage: null,
    ...overrides,
  };
}

describe("SessionRuntimeService stale retry helpers", () => {
  it("stale classifier は narrow な thread / session 系だけを対象にする", () => {
    assert.equal(isRetryableStaleThreadSessionError(new Error("thread not found")), true);
    assert.equal(isRetryableStaleThreadSessionError(new Error("session expired on provider side")), true);
    assert.equal(isRetryableStaleThreadSessionError(new Error("invalid-thread identifier")), true);
    assert.equal(isRetryableStaleThreadSessionError(new Error("thread model incompatible with selected model")), true);
    assert.equal(isRetryableStaleThreadSessionError({ code: "thread_not_found" }), true);
    assert.equal(isRetryableStaleThreadSessionError({ code: "not_found" }), false);
    assert.equal(isRetryableStaleThreadSessionError({ code: "model_incompatible" }), false);
    assert.equal(isRetryableStaleThreadSessionError(new Error("Connection is closed.")), false);
    assert.equal(isRetryableStaleThreadSessionError(new Error("socket hang up")), false);
  });

  it("meaningful partial 判定は assistantText / operations / artifact を見る", () => {
    assert.equal(hasMeaningfulPartialRunResult(createPartialResult()), false);
    assert.equal(hasMeaningfulPartialRunResult(createPartialResult({ rawItemsJson: "[{\"kind\":\"trace\"}]" })), false);
    assert.equal(hasMeaningfulPartialRunResult(createPartialResult({ assistantText: "partial" })), true);
    assert.equal(hasMeaningfulPartialRunResult(createPartialResult({ operations: [{ type: "command_execution", summary: "npm test" }] })), true);
    assert.equal(hasMeaningfulPartialRunResult(createPartialResult({
      artifact: {
        title: "Artifact",
        activitySummary: [],
        changedFiles: [{ kind: "edit", path: "src/a.ts", summary: "updated", diffRows: [] }],
        runChecks: [],
      },
    })), true);
  });
});

describe("SessionRuntimeService", () => {
  it("成功時に running -> idle を保存し、background task を起動する", async () => {
    const session = createSession();
    const storedSessions: Session[] = [];
    const auditUpdates: UpdateAuditLogInput[] = [];
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
          backgroundTasks: [],
          usage: null,
          errorMessage: "",
          approvalRequest: null,
          elicitationRequest: null,
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
      async waitForApprovalDecision(_sessionId, _request, _signal): Promise<LiveApprovalDecision> {
        return "approve";
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
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
      resolvePendingElicitationRequest() {},
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
    const auditUpdates: UpdateAuditLogInput[] = [];
    let canceledSessionId: string | null = null;
    const partialResult: RunSessionTurnResult = {
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
      async waitForApprovalDecision(_sessionId, _request, _signal): Promise<LiveApprovalDecision> {
        return "deny";
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
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
      resolvePendingElicitationRequest() {},
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
    let resolveRun: ((value: RunSessionTurnResult) => void) | null = null;

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
        return new Promise<RunSessionTurnResult>((resolve) => {
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
      async waitForApprovalDecision(_sessionId, _request, _signal): Promise<LiveApprovalDecision> {
        return "approve";
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
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
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const promise = service.runSessionTurn(session.id, { userMessage: "お願いします" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(service.isRunInFlight(session.id), true);
    if (!resolveRun) {
      throw new Error("runSessionTurn の resolve が取得できていないよ。");
    }
    const completeRun: (value: RunSessionTurnResult) => void = resolveRun;
    completeRun({
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

  it("reset は in-flight run を abort して pending approval も deny する", async () => {
    const session = createSession();
    const approvalResolutions: Array<{ sessionId: string; decision: LiveApprovalDecision }> = [];
    let observedAbortSignal: AbortSignal | undefined;
    let observedAbort = false;
    const abortedPartialResult: RunSessionTurnResult = {
      threadId: null,
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
      invalidateSessionThread() {},
      invalidateAllSessionThreads() {},
      runSessionTurn(input) {
        observedAbortSignal = input.signal;
        if (!input.signal) {
          throw new Error("AbortSignal が渡されていないよ。");
        }
        const signal = input.signal;
        signal.addEventListener("abort", () => {
          observedAbort = true;
        }, { once: true });
        return new Promise<RunSessionTurnResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new ProviderTurnError("aborted", abortedPartialResult, true));
          }, { once: true });
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
      async waitForApprovalDecision(_sessionId, _request, _signal): Promise<LiveApprovalDecision> {
        return "approve";
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      runSessionMemoryExtraction() {},
      runCharacterReflection() {},
      clearWorkspaceFileIndex() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest(sessionId, decision) {
        approvalResolutions.push({ sessionId, decision });
      },
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const promise = service.runSessionTurn(session.id, { userMessage: "お願いします" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    service.reset();
    const result = await promise;

    if (!observedAbortSignal) {
      throw new Error("abort signal が観測できていないよ。");
    }
    assert.equal(observedAbort, true);
    assert.equal(result.runState, "idle");
    assert.equal(service.hasInFlightRuns(), false);
    assert.deepEqual(approvalResolutions, [
      { sessionId: session.id, decision: "deny" },
      { sessionId: session.id, decision: "deny" },
    ]);
  });

  it("stale thread / session error で meaningful partial が無い時だけ thread reset 後に 1 回 retry する", async () => {
    const session = createSession({ provider: "codex", threadId: "thread-stale" });
    const storedSessions: Session[] = [];
    const invalidated: Array<{ providerId: string | null | undefined; sessionId: string }> = [];
    const auditUpdates: UpdateAuditLogInput[] = [];
    const seenThreadIds: string[] = [];
    let attempt = 0;

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
        attempt += 1;
        seenThreadIds.push(input.session.threadId);
        if (attempt === 1) {
          throw new ProviderTurnError("thread not found", createPartialResult({ threadId: "thread-stale" }), false);
        }

        return createPartialResult({
          threadId: "thread-fresh",
          assistantText: "再試行で成功したよ。",
        });
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
      async waitForApprovalDecision(_sessionId, _request, _signal): Promise<LiveApprovalDecision> {
        return "approve";
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      invalidateProviderSessionThread(providerId, retrySessionId) {
        invalidated.push({ providerId, sessionId: retrySessionId });
      },
      scheduleProviderQuotaTelemetryRefresh() {},
      runSessionMemoryExtraction() {},
      runCharacterReflection() {},
      clearWorkspaceFileIndex() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, { userMessage: "お願いします" });

    assert.equal(result.runState, "idle");
    assert.equal(result.threadId, "thread-fresh");
    assert.equal(result.messages.filter((message) => message.role === "user").length, 1);
    assert.equal(result.messages.filter((message) => message.role === "assistant").length, 1);
    assert.deepEqual(seenThreadIds, ["thread-stale", ""]);
    assert.deepEqual(invalidated, [{ providerId: "codex", sessionId: session.id }]);
    assert.equal(storedSessions.length, 3);
    assert.equal(storedSessions[1]?.threadId, "");
    assert.equal(auditUpdates.length, 1);
    assert.equal(auditUpdates[0]?.phase, "completed");
  });

  it("meaningful partial が出た stale error は internal retry しない", async () => {
    const session = createSession({ provider: "codex", threadId: "thread-stale" });
    const storedSessions: Session[] = [];
    const invalidated: Array<{ providerId: string | null | undefined; sessionId: string }> = [];
    let attempt = 0;

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
      async runSessionTurn() {
        attempt += 1;
        throw new ProviderTurnError("thread not found", createPartialResult({ assistantText: "途中まで出たよ。" }), false);
      },
    };

    const service = new SessionRuntimeService({
      getSession() {
        return session;
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
      updateAuditLog() {},
      setLiveSessionRun() {},
      getLiveSessionRun() {
        return null;
      },
      async waitForApprovalDecision(_sessionId, _request, _signal): Promise<LiveApprovalDecision> {
        return "approve";
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      invalidateProviderSessionThread(providerId, retrySessionId) {
        invalidated.push({ providerId, sessionId: retrySessionId });
      },
      scheduleProviderQuotaTelemetryRefresh() {},
      runSessionMemoryExtraction() {},
      runCharacterReflection() {},
      clearWorkspaceFileIndex() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, { userMessage: "お願いします" });

    assert.equal(attempt, 1);
    assert.equal(result.runState, "error");
    assert.match(result.messages.at(-1)?.text ?? "", /途中まで出たよ。/);
    assert.deepEqual(invalidated, []);
    assert.equal(storedSessions.length, 2);
  });

  it("not_found 単独 code の provider error では internal retry しない", async () => {
    const session = createSession({ provider: "codex", threadId: "thread-stale" });
    const storedSessions: Session[] = [];
    const invalidated: Array<{ providerId: string | null | undefined; sessionId: string }> = [];
    let attempt = 0;

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
      async runSessionTurn() {
        attempt += 1;
        const error = new ProviderTurnError("resource not found", createPartialResult(), false) as ProviderTurnError & { code?: string };
        error.code = "not_found";
        throw error;
      },
    };

    const service = new SessionRuntimeService({
      getSession() {
        return session;
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
      updateAuditLog() {},
      setLiveSessionRun() {},
      getLiveSessionRun() {
        return null;
      },
      async waitForApprovalDecision(_sessionId, _request, _signal): Promise<LiveApprovalDecision> {
        return "approve";
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      invalidateProviderSessionThread(providerId, retrySessionId) {
        invalidated.push({ providerId, sessionId: retrySessionId });
      },
      scheduleProviderQuotaTelemetryRefresh() {},
      runSessionMemoryExtraction() {},
      runCharacterReflection() {},
      clearWorkspaceFileIndex() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, { userMessage: "お願いします" });

    assert.equal(attempt, 1);
    assert.equal(result.runState, "error");
    assert.match(result.messages.at(-1)?.text ?? "", /resource not found/);
    assert.deepEqual(invalidated, []);
    assert.equal(storedSessions.length, 2);
  });
});
