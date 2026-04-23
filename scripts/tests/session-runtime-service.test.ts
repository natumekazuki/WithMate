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
  type LiveElicitationRequest,
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

function createLiveRunState(overrides?: Partial<LiveSessionRunState>): LiveSessionRunState {
  return {
    sessionId: overrides?.sessionId ?? "session-1",
    threadId: overrides?.threadId ?? "",
    assistantText: overrides?.assistantText ?? "",
    steps: overrides?.steps ?? [],
    backgroundTasks: overrides?.backgroundTasks ?? [],
    usage: overrides?.usage ?? null,
    errorMessage: overrides?.errorMessage ?? "",
    approvalRequest: overrides?.approvalRequest ?? null,
    elicitationRequest: overrides?.elicitationRequest ?? null,
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
        await onProgress?.(createLiveRunState({
          sessionId: input.session.id,
        }));
        await onProgress?.(createLiveRunState({
          sessionId: input.session.id,
          threadId: "thread-progress",
          assistantText: "途中経過だよ。",
          steps: [
            {
              id: "step-1",
              type: "command_execution",
              summary: "npm test",
              details: "実行中",
              status: "in_progress",
            },
          ],
          usage: { inputTokens: 4, cachedInputTokens: 0, outputTokens: 1 },
        }));
        setTimeout(() => {
          void onProgress?.(createLiveRunState({
            sessionId: input.session.id,
            threadId: "thread-late",
            assistantText: "late progress",
            steps: [
              {
                id: "step-late",
                type: "command_execution",
                summary: "late step",
                status: "in_progress",
              },
            ],
          }));
        }, 0);
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(result.runState, "idle");
    assert.equal(storedSessions.length, 2);
    assert.equal(storedSessions[0]?.runState, "running");
    assert.equal(storedSessions[1]?.runState, "idle");
    assert.equal(storedSessions[1]?.messages.at(-1)?.text, "完了したよ。");
    assert.equal(auditUpdates.length, 2);
    assert.equal(auditUpdates[0]?.phase, "running");
    assert.equal(auditUpdates[0]?.assistantText, "途中経過だよ。");
    assert.equal(auditUpdates[0]?.threadId, "thread-progress");
    assert.equal(auditUpdates[0]?.operations[0]?.summary, "npm test");
    assert.equal(auditUpdates.at(-1)?.phase, "completed");
    assert.equal(auditUpdates.at(-1)?.assistantText, "完了したよ。");
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

  it("成功時に backgroundTasks を保持する finally でも completed session の threadId を使う", async () => {
    const session = createSession({ provider: "codex", threadId: "thread-old" });
    const storedSessions: Session[] = [];
    const backgroundTasks = [
      {
        id: "bg-1",
        kind: "shell" as const,
        status: "running" as const,
        title: "npm run watch",
        details: "watch mode",
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
    ];
    const liveStates: Array<LiveSessionRunState | null> = [];
    let liveState: LiveSessionRunState | null = createLiveRunState({
      sessionId: session.id,
      threadId: session.threadId,
      backgroundTasks,
    });

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
        return createPartialResult({
          threadId: "thread-new",
          assistantText: "完了したよ。",
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
      updateAuditLog() {},
      setLiveSessionRun(_sessionId, next) {
        liveState = next;
        liveStates.push(next);
      },
      getLiveSessionRun() {
        return liveState;
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

    const result = await service.runSessionTurn(session.id, { userMessage: "お願いします" });

    assert.equal(result.threadId, "thread-new");
    assert.equal(storedSessions[1]?.threadId, "thread-new");
    assert.equal(liveStates.at(-1)?.threadId, "thread-new");
    assert.deepEqual(liveStates.at(-1)?.backgroundTasks, backgroundTasks);
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
      async runSessionTurn(input, onProgress) {
        await onProgress?.(createLiveRunState({
          sessionId: input.session.id,
          threadId: "thread-before-cancel",
          assistantText: "途中まで進んだよ。",
          steps: [
            {
              id: "step-1",
              type: "command_execution",
              summary: "npm run build",
              status: "in_progress",
            },
          ],
        }));
        setTimeout(() => {
          void onProgress?.(createLiveRunState({
            sessionId: input.session.id,
            threadId: "thread-late",
            assistantText: "late cancel progress",
            steps: [
              {
                id: "step-late",
                type: "command_execution",
                summary: "late cancel step",
                status: "in_progress",
              },
            ],
          }));
        }, 0);
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(result.runState, "idle");
    assert.match(result.messages.at(-1)?.text ?? "", /キャンセル/);
    assert.equal(auditUpdates.length, 2);
    assert.equal(auditUpdates[0]?.phase, "running");
    assert.equal(auditUpdates[0]?.assistantText, "途中まで進んだよ。");
    assert.equal(auditUpdates.at(-1)?.phase, "canceled");
    assert.equal(auditUpdates.at(-1)?.assistantText, "");
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
    assert.equal(auditUpdates.length, 2);
    assert.equal(auditUpdates[0]?.phase, "running");
    assert.equal(auditUpdates.at(-1)?.phase, "completed");
  });

  it("stale retry 後の running audit log は前回 progress の断片を引き継がない", async () => {
    const session = createSession({ provider: "codex", threadId: "thread-stale" });
    const auditUpdates: UpdateAuditLogInput[] = [];
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
      async runSessionTurn(input, onProgress) {
        attempt += 1;
        if (attempt === 1) {
          await onProgress?.(createLiveRunState({
            sessionId: input.session.id,
            threadId: "thread-before-retry",
            assistantText: "1 回目の progress",
            steps: [{ id: "step-1", type: "command_execution", summary: "npm test", status: "in_progress" }],
            usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 1 },
          }));
          throw new ProviderTurnError("thread not found", createPartialResult({ threadId: "thread-stale" }), false);
        }

        await onProgress?.(createLiveRunState({
          sessionId: input.session.id,
          threadId: "",
          assistantText: "",
          steps: [],
          usage: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 2 },
        }));
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

    await service.runSessionTurn(session.id, { userMessage: "お願いします" });

    const runningUpdates = auditUpdates.filter((entry) => entry.phase === "running");
    assert.equal(runningUpdates.length, 3);
    assert.equal(runningUpdates[0]?.threadId, "thread-before-retry");
    assert.equal(runningUpdates[0]?.assistantText, "1 回目の progress");
    assert.equal(runningUpdates[0]?.operations[0]?.summary, "npm test");
    assert.deepEqual(runningUpdates[0]?.usage, { inputTokens: 10, cachedInputTokens: 0, outputTokens: 1 });
    assert.equal(runningUpdates[1]?.threadId, "");
    assert.equal(runningUpdates[1]?.assistantText, "");
    assert.deepEqual(runningUpdates[1]?.operations, []);
    assert.equal(runningUpdates[1]?.usage, null);
    assert.equal(runningUpdates[2]?.threadId, "");
    assert.equal(runningUpdates[2]?.assistantText, "");
    assert.deepEqual(runningUpdates[2]?.operations, []);
    assert.deepEqual(runningUpdates[2]?.usage, { inputTokens: 20, cachedInputTokens: 0, outputTokens: 2 });
  });

  it("stale retry 中は旧 attempt の late progress を live state と running audit log へ反映しない", async () => {
    const session = createSession({ provider: "codex", threadId: "thread-stale" });
    const auditUpdates: UpdateAuditLogInput[] = [];
    const liveStates: Array<LiveSessionRunState | null> = [];
    let attempt = 0;
    let notifySecondAttemptStarted: (() => void) | null = null;
    let releaseSecondAttempt: (() => void) | null = null;
    const secondAttemptStarted = new Promise<void>((resolve) => {
      notifySecondAttemptStarted = resolve;
    });
    const secondAttemptGate = new Promise<void>((resolve) => {
      releaseSecondAttempt = resolve;
    });

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
        attempt += 1;
        if (attempt === 1) {
          await onProgress?.(createLiveRunState({
            sessionId: input.session.id,
            threadId: "thread-before-retry",
            assistantText: "1 回目の progress",
            steps: [{ id: "step-1", type: "command_execution", summary: "npm test", status: "in_progress" }],
            usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 1 },
          }));
          setTimeout(() => {
            void onProgress?.(createLiveRunState({
              sessionId: input.session.id,
              threadId: "thread-stale-late",
              assistantText: "旧 attempt の late progress",
              steps: [{ id: "step-stale-late", type: "command_execution", summary: "stale step", status: "in_progress" }],
              usage: { inputTokens: 99, cachedInputTokens: 0, outputTokens: 9 },
            }));
          }, 0);
          throw new ProviderTurnError("thread not found", createPartialResult({ threadId: "thread-stale" }), false);
        }

        notifySecondAttemptStarted?.();
        await onProgress?.(createLiveRunState({
          sessionId: input.session.id,
          threadId: "thread-fresh-progress",
          assistantText: "2 回目の progress",
          steps: [{ id: "step-2", type: "command_execution", summary: "npm run build", status: "in_progress" }],
          usage: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 2 },
        }));
        await secondAttemptGate;
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
      setLiveSessionRun(_sessionId, state) {
        liveStates.push(state);
      },
      getLiveSessionRun() {
        return liveStates.at(-1) ?? null;
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

    const runPromise = service.runSessionTurn(session.id, { userMessage: "お願いします" });
    await secondAttemptStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseSecondAttempt?.();
    await runPromise;

    const runningUpdates = auditUpdates.filter((entry) => entry.phase === "running");
    assert.equal(runningUpdates.length, 3);
    assert.equal(runningUpdates[0]?.threadId, "thread-before-retry");
    assert.equal(runningUpdates[1]?.threadId, "");
    assert.equal(runningUpdates[2]?.threadId, "thread-fresh-progress");
    assert.equal(runningUpdates.some((entry) => entry.threadId === "thread-stale-late"), false);
    assert.equal(runningUpdates.some((entry) => entry.assistantText === "旧 attempt の late progress"), false);
    assert.equal(liveStates.some((state) => state?.threadId === "thread-stale-late"), false);
    assert.equal(liveStates.some((state) => state?.assistantText === "旧 attempt の late progress"), false);
  });

  it("Codex stdin bootstrap error でも thread reset 後に 1 回 retry する", async () => {
    const session = createSession({ provider: "codex", threadId: "" });
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
          throw new ProviderTurnError(
            "Codex Exec exited with code 1: Reading prompt from stdin...",
            createPartialResult({ threadId: "thread-broken" }),
            false,
          );
        }

        return createPartialResult({
          threadId: "thread-fresh",
          assistantText: "立て直して続行できたよ。",
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

    assert.equal(attempt, 2);
    assert.equal(result.runState, "idle");
    assert.equal(result.threadId, "thread-fresh");
    assert.deepEqual(seenThreadIds, ["", ""]);
    assert.deepEqual(invalidated, [{ providerId: "codex", sessionId: session.id }]);
    assert.equal(storedSessions.length, 2);
    assert.equal(storedSessions[1]?.threadId, "thread-fresh");
    assert.equal(auditUpdates.length, 2);
    assert.equal(auditUpdates[0]?.phase, "running");
    assert.equal(auditUpdates.at(-1)?.phase, "completed");
  });

  it("Codex stdin bootstrap error が続く時は failed session に壊れた threadId を残さない", async () => {
    const session = createSession({ provider: "codex", threadId: "" });
    const storedSessions: Session[] = [];
    const invalidated: Array<{ providerId: string | null | undefined; sessionId: string }> = [];
    const auditUpdates: UpdateAuditLogInput[] = [];
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
        throw new ProviderTurnError(
          "Codex Exec exited with code 1: Reading prompt from stdin...",
          createPartialResult({ threadId: "thread-broken" }),
          false,
        );
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

    assert.equal(attempt, 2);
    assert.equal(result.runState, "error");
    assert.equal(result.threadId, "");
    assert.match(result.messages.at(-1)?.text ?? "", /Reading prompt from stdin/i);
    assert.deepEqual(invalidated, [
      { providerId: "codex", sessionId: session.id },
      { providerId: "codex", sessionId: session.id },
    ]);
    assert.equal(storedSessions.length, 2);
    assert.equal(storedSessions[1]?.threadId, "");
    assert.equal(auditUpdates.length, 2);
    assert.equal(auditUpdates[0]?.phase, "running");
    assert.equal(auditUpdates.at(-1)?.phase, "failed");
    assert.equal(auditUpdates.at(-1)?.threadId, "thread-broken");
  });

  it("approval request の直後に progress が無くても running audit log を更新する", async () => {
    const session = createSession();
    const auditUpdates: UpdateAuditLogInput[] = [];
    let liveState = createLiveRunState({ sessionId: session.id, threadId: session.threadId });
    const approvalRequest: LiveApprovalRequest = {
      requestId: "approval-1",
      provider: session.provider,
      kind: "command",
      title: "コマンド実行の承認",
      summary: "npm test を実行する前に承認が必要だよ。",
      details: "workspace へ書き込みはしないよ。",
      warning: "外部コマンドを実行するよ。",
      decisionMode: "direct-decision",
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
      async runSessionTurn(input, onProgress) {
        await input.onApprovalRequest?.(approvalRequest);
        return createPartialResult({
          threadId: "thread-approval",
          assistantText: "承認後に完了したよ。",
        });
      },
    };

    const service = new SessionRuntimeService({
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
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
      getSessionMemory(currentSession) {
        return createSessionMemory(currentSession.id);
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
      setLiveSessionRun(_sessionId, next) {
        liveState = next;
      },
      getLiveSessionRun() {
        return liveState;
      },
      async waitForApprovalDecision(_sessionId, request) {
        liveState = {
          ...liveState,
          approvalRequest: request,
          elicitationRequest: null,
        };
        return "approve";
      },
      async waitForElicitationResponse() {
        return { action: "accept" } as const;
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

    await service.runSessionTurn(session.id, { userMessage: "お願いします" });

    const runningUpdate = auditUpdates.find((entry) =>
      entry.phase === "running" && entry.operations.some((operation) => operation.type === "approval_request"),
    );
    assert.ok(runningUpdate);
    assert.equal(runningUpdate?.operations[0]?.type, "approval_request");
    assert.equal(runningUpdate?.operations[0]?.summary, "コマンド実行の承認");
    assert.match(runningUpdate?.operations[0]?.details ?? "", /status:pending/);
  });

  it("elicitation request の直後に progress が無くても running audit log を更新する", async () => {
    const session = createSession();
    const auditUpdates: UpdateAuditLogInput[] = [];
    let liveState = createLiveRunState({ sessionId: session.id, threadId: session.threadId });
    const elicitationRequest: LiveElicitationRequest = {
      requestId: "elicitation-1",
      provider: session.provider,
      mode: "form",
      message: "実行対象のブランチを選んでね。",
      source: "copilot",
      fields: [
        {
          name: "branch",
          title: "対象ブランチ",
          required: true,
          type: "select",
          options: [
            { value: "main", label: "main" },
            { value: "feature", label: "feature" },
          ],
        },
      ],
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
      async runSessionTurn(input, onProgress) {
        await input.onElicitationRequest?.(elicitationRequest);
        return createPartialResult({
          threadId: "thread-elicitation",
          assistantText: "入力を受け取って完了したよ。",
        });
      },
    };

    const service = new SessionRuntimeService({
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
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
      getSessionMemory(currentSession) {
        return createSessionMemory(currentSession.id);
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
      setLiveSessionRun(_sessionId, next) {
        liveState = next;
      },
      getLiveSessionRun() {
        return liveState;
      },
      async waitForApprovalDecision() {
        return "approve";
      },
      async waitForElicitationResponse(_sessionId, request) {
        liveState = {
          ...liveState,
          approvalRequest: null,
          elicitationRequest: request,
        };
        return { action: "accept", content: { branch: "main" } };
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

    await service.runSessionTurn(session.id, { userMessage: "お願いします" });

    const runningUpdate = auditUpdates.find((entry) =>
      entry.phase === "running" && entry.operations.some((operation) => operation.type === "elicitation_request"),
    );
    assert.ok(runningUpdate);
    assert.equal(runningUpdate?.operations[0]?.type, "elicitation_request");
    assert.equal(runningUpdate?.operations[0]?.summary, "実行対象のブランチを選んでね。");
    assert.match(runningUpdate?.operations[0]?.details ?? "", /required:対象ブランチ/);
  });

  it("failed audit log は partial threadId が無くても live progress の threadId を維持する", async () => {
    const session = createSession({ provider: "codex", threadId: "thread-stale" });
    const storedSessions: Session[] = [];
    const auditUpdates: UpdateAuditLogInput[] = [];

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
        await onProgress?.(createLiveRunState({
          sessionId: input.session.id,
          threadId: "thread-live",
          assistantText: "途中まで進んだよ。",
        }));
        throw new ProviderTurnError("network timeout", createPartialResult({ threadId: null }), false);
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
      getSessionMemory(currentSession) {
        return createSessionMemory(currentSession.id);
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
      async waitForApprovalDecision() {
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

    const result = await service.runSessionTurn(session.id, { userMessage: "お願いします" });

    assert.equal(result.runState, "error");
    assert.equal(result.threadId, "thread-live");
    assert.equal(storedSessions.at(-1)?.threadId, "thread-live");
    assert.equal(auditUpdates.at(-1)?.phase, "failed");
    assert.equal(auditUpdates.at(-1)?.threadId, "thread-live");
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

  it("live run の progress を running audit log へ段階的に update する", async () => {
    const session = createSession();
    const auditUpdates: UpdateAuditLogInput[] = [];
    const liveStates: Array<LiveSessionRunState | null> = [];
    let progressUpdateCount = 0;

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
      async runSessionTurn(_input, onProgress) {
        // 複数回の progress update をシミュレート
        await onProgress?.({
          sessionId: session.id,
          threadId: "",
          assistantText: "",
          steps: [],
          backgroundTasks: [],
          usage: null,
          errorMessage: "",
          approvalRequest: null,
          elicitationRequest: null,
        });

        await onProgress?.({
          sessionId: session.id,
          threadId: "thread-1",
          assistantText: "処理中...",
          steps: [
            { id: "step-1", type: "command_execution", summary: "npm test", status: "in_progress" },
          ],
          backgroundTasks: [],
          usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 0 },
          errorMessage: "",
          approvalRequest: null,
          elicitationRequest: null,
        });

        await onProgress?.({
          sessionId: session.id,
          threadId: "thread-1",
          assistantText: "処理中... テスト完了",
          steps: [
            { id: "step-1", type: "command_execution", summary: "npm test", details: "OK", status: "completed" },
          ],
          backgroundTasks: [],
          usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 80 },
          errorMessage: "",
          approvalRequest: null,
          elicitationRequest: null,
        });

        return {
          threadId: "thread-1",
          assistantText: "完了したよ。",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          transportPayload: null,
          operations: [{ type: "command_execution", summary: "npm test", details: "OK" }],
          rawItemsJson: "[]",
          usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 100 },
        };
      },
    };

    const service = new SessionRuntimeService({
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
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
      updateAuditLog(_id, entry) {
        auditUpdates.push(entry);
        if (entry.phase === "running") {
          progressUpdateCount += 1;
        }
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

    await service.runSessionTurn(session.id, { userMessage: "お願いします" });

    // progress update が複数回発生したことを確認
    assert.ok(progressUpdateCount >= 2, `progress update は 2 回以上発生すべきだが ${progressUpdateCount} 回だったよ`);

    // running phase の update で assistantText / operations / usage が段階的に更新されていることを確認
    const runningUpdates = auditUpdates.filter((entry) => entry.phase === "running");
    assert.ok(runningUpdates.length >= 2, "running phase の update が複数回あるべきだよ");

    const firstRunningUpdate = runningUpdates[0];
    assert.ok(firstRunningUpdate, "最初の running update があるべきだよ");
    assert.equal(firstRunningUpdate.assistantText, "処理中...");
    assert.equal(firstRunningUpdate.operations.length, 1);
    assert.equal(firstRunningUpdate.operations[0]?.summary, "npm test");
    assert.deepEqual(firstRunningUpdate.usage, { inputTokens: 50, cachedInputTokens: 0, outputTokens: 0 });

    const secondRunningUpdate = runningUpdates[1];
    assert.ok(secondRunningUpdate, "2 回目の running update があるべきだよ");
    assert.equal(secondRunningUpdate.assistantText, "処理中... テスト完了");
    assert.equal(secondRunningUpdate.operations.length, 1);
    assert.equal(secondRunningUpdate.operations[0]?.summary, "npm test");
    assert.deepEqual(secondRunningUpdate.usage, { inputTokens: 50, cachedInputTokens: 0, outputTokens: 80 });

    // 最終的に completed phase で update されていることを確認
    const completedUpdate = auditUpdates.find((entry) => entry.phase === "completed");
    assert.ok(completedUpdate, "completed phase の update があるべきだよ");
    assert.equal(completedUpdate.assistantText, "完了したよ。");
    assert.equal(completedUpdate.operations.length, 1);
    assert.deepEqual(completedUpdate.usage, { inputTokens: 50, cachedInputTokens: 0, outputTokens: 100 });
  });

  it("success 後に backgroundTasks を保持しても completed threadId を live run へ残す", async () => {
    const session = createSession({ provider: "codex", threadId: "thread-stale" });
    const liveStates: Array<LiveSessionRunState | null> = [];
    let liveState: LiveSessionRunState | null = createLiveRunState({
      sessionId: session.id,
      threadId: session.threadId,
      backgroundTasks: [
        {
          id: "task-1",
          kind: "shell",
          status: "running",
          title: "バックグラウンド処理",
          details: "継続中",
          updatedAt: "2026-04-21T10:00:00.000Z",
        },
      ],
    });

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
        return createPartialResult({
          threadId: "thread-completed",
          assistantText: "完了したよ。",
        });
      },
    };

    const service = new SessionRuntimeService({
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      upsertSession(next) {
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
      updateAuditLog() {},
      setLiveSessionRun(_sessionId, state) {
        liveState = state;
        liveStates.push(state);
      },
      getLiveSessionRun() {
        return liveState;
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

    const result = await service.runSessionTurn(session.id, { userMessage: "お願いします" });

    assert.equal(result.threadId, "thread-completed");
    assert.ok(liveStates.at(-1));
    assert.equal(liveStates.at(-1)?.threadId, "thread-completed");
    assert.equal(liveStates.at(-1)?.backgroundTasks.length, 1);
    assert.equal(liveStates.at(-1)?.backgroundTasks[0]?.id, "task-1");
  });
});
