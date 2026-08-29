import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  preserveSessionTurnRequestMetadata,
  type SessionRuntimeServiceDeps,
} from "../../src-electron/session-runtime-service.js";
import type { ConversationTimingContext } from "../../src-electron/conversation-timing.js";
import type { CharacterContextResponse } from "../../src/character-context/character-context-contract.js";
import { CharacterAffectTurnSettlementStorage } from "../../src-electron/character-affect-turn-settlement-storage.js";
import type { SessionTurnTerminalCommit } from "../../src-electron/session-turn-terminal-commit.js";

async function waitForCondition(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

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
    reasoningText: overrides?.reasoningText ?? "",
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
    assert.equal(isRetryableStaleThreadSessionError(new Error("SessionNotFound")), true);
    assert.equal(isRetryableStaleThreadSessionError(new Error("session_not_found")), true);
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

  it("各turnで最新Character contextを取得し、terminal commit後はready・audit・appraisalを待たずに返す", async () => {
    let storedSession = createSession();
    let contextVersion = 0;
    let auditId = 0;
    let completionNotificationCount = 0;
    const appraisalCorrelations: string[] = [];
    const requestCorrelations: string[] = [];
    const callOrder: string[] = [];
    const timingCompletionSnapshots: Array<string | null> = [];
    let lastCommittedAt: string | null = null;
    let blockCompletedAudit = false;
    let releaseCompletedAudit: (() => void) | null = null;
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
        return createPartialResult({ assistantText: "完了" });
      },
    };
    const context = (version: number): CharacterContextResponse => ({
      schemaVersion: "withmate-character-context-v1",
      characterId: "char-a",
      sessionId: storedSession.id,
      baseline: { definitionSha256: "sha", snapshotAt: "2026-08-09T00:00:00.000Z" },
      affect: {
        mode: "active",
        effective: [],
        evaluatedAt: "2026-08-09T00:00:00.000Z",
        version: `affect-v1-${version}`,
        updatedAt: "2026-08-09T00:00:00.000Z",
      },
      memory: { items: [], updatedAt: null },
      scope: { userId: "local-user", characterId: "char-a", sessionId: storedSession.id },
    });

    const service = new SessionRuntimeService({
      getSession(sessionId) {
        return sessionId === storedSession.id ? storedSession : null;
      },
      upsertSession(next) {
        storedSession = next;
        return next;
      },
      upsertTerminalSession(next, terminalCommit) {
        if (next.status === "idle" && next.messages.at(-1)?.role === "assistant") {
          callOrder.push(`completed-upsert:${terminalCommit.auditLogId}`);
          assert.equal(terminalCommit.assistantMessageSeq, next.messages.length - 1);
        }
        lastCommittedAt = terminalCommit.completedAt;
        storedSession = next;
        return next;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] };
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
      getSessionMemory(session) {
        return createSessionMemory(session.id);
      },
      resolveProjectMemoryEntriesForPrompt() {
        return [];
      },
      resolveConversationTimingContext() {
        timingCompletionSnapshots.push(lastCommittedAt);
        return null;
      },
      resolveCharacterContext() {
        contextVersion += 1;
        return context(contextVersion);
      },
      async queueCompletedTurnAppraisal(input) {
        assert.equal(input.assistantMessageIndex, input.session.messages.length - 1);
        callOrder.push(`queued:${input.correlationId}`);
      },
      markCompletedTurnAppraisalReady(correlationId) {
        callOrder.push(`pending-ready:${correlationId}`);
      },
      requireDurableCompletedTurnAppraisal: true,
      async appraiseCompletedTurn(input) {
        appraisalCorrelations.push(input.correlationId);
        callOrder.push("appraisal-started");
        await new Promise<void>(() => undefined);
      },
      createAuditLog(input) {
        const requestMetadata = input.providerMetadata.find((entry) => entry.kind === "session_turn_request");
        const clientRequestId = requestMetadata?.payload && "clientRequestId" in requestMetadata.payload
          ? requestMetadata.payload.clientRequestId
          : null;
        if (typeof clientRequestId === "string") {
          requestCorrelations.push(clientRequestId);
        }
        auditId += 1;
        return { ...createAuditLogBase(input), id: auditId };
      },
      updateAuditLog(id, input) {
        if (input.phase === "completed" && callOrder.at(-1) !== `terminal-audit:${id}`) {
          callOrder.push(`terminal-audit:${id}`);
        }
        if (blockCompletedAudit && id === 3 && input.phase === "completed") {
          return new Promise<void>((resolve) => {
            releaseCompletedAudit = resolve;
          });
        }
      },
      setLiveSessionRun() {},
      getLiveSessionRun() {
        return null;
      },
      waitForApprovalDecision() {
        return "approve";
      },
      waitForElicitationResponse() {
        return { action: "cancel" };
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      notifySessionTurnCompleted() {
        completionNotificationCount += 1;
        callOrder.push(`completion-notification:${completionNotificationCount}`);
      },
      currentTimestampLabel,
    });

    await service.runSessionTurn(storedSession.id, {
      userMessage: "first",
      clientRequestId: "7c26d875-9117-4ad5-97b5-e9af775b94b1",
      submitSource: "composer",
    });
    callOrder.push("first-returned");
    const firstCompletedAt = lastCommittedAt;
    assert.equal(service.isRunInFlight(storedSession.id), false);
    assert.equal(callOrder.some((entry) => entry === `pending-ready:turn:${storedSession.id}:audit:1`), false);
    assert.equal(callOrder.some((entry) => entry === "terminal-audit:1"), false);
    await service.runSessionTurn(storedSession.id, {
      userMessage: "second",
      clientRequestId: "7c26d875-9117-4ad5-97b5-e9af775b94b2",
      submitSource: "retry",
    });
    callOrder.push("second-returned");

    await waitForCondition(
      () => appraisalCorrelations.length === 2
        && callOrder.filter((entry) => entry.startsWith("terminal-audit:")).length === 2,
      "ready・appraisal・terminal auditがbackgroundで完了すること",
    );

    assert.equal(contextVersion, 2);
    assert.deepEqual(requestCorrelations, [
      "7c26d875-9117-4ad5-97b5-e9af775b94b1",
      "7c26d875-9117-4ad5-97b5-e9af775b94b2",
    ]);
    assert.deepEqual(appraisalCorrelations, [
      `turn:${storedSession.id}:audit:1`,
      `turn:${storedSession.id}:audit:2`,
    ]);
    assert.equal(timingCompletionSnapshots[0], null);
    assert.equal(timingCompletionSnapshots[1], firstCompletedAt);
    for (const [auditId, returned] of [
      [1, "first-returned"],
      [2, "second-returned"],
    ] as const) {
      const correlationId = `turn:${storedSession.id}:audit:${auditId}`;
      assert.ok(callOrder.indexOf(`completed-upsert:${auditId}`) < callOrder.indexOf(`completion-notification:${auditId}`));
      assert.ok(callOrder.indexOf(`completion-notification:${auditId}`) < callOrder.indexOf(returned));
      assert.ok(callOrder.indexOf(returned) < callOrder.indexOf(`pending-ready:${correlationId}`));
      assert.ok(callOrder.indexOf(returned) < callOrder.indexOf(`terminal-audit:${auditId}`));
    }
    assert.equal(callOrder.filter((entry) => entry === "appraisal-started").length, 2);

    blockCompletedAudit = true;
    const completingRun = service.runSessionTurn(storedSession.id, {
      userMessage: "third",
      clientRequestId: "7c26d875-9117-4ad5-97b5-e9af775b94b3",
    });
    const thirdResult = await completingRun;
    callOrder.push("third-returned");
    await waitForCondition(() => Boolean(releaseCompletedAudit), "provider完了後のbackground auditへ到達すること");
    assert.ok(releaseCompletedAudit, "provider完了後のaudit終了処理へ到達すること");
    assert.equal(thirdResult.runState, "idle");
    assert.equal(service.isRunInFlight(storedSession.id), false);
    const followingResult = await service.runSessionTurn(storedSession.id, {
      userMessage: "background audit中の再送",
      clientRequestId: "7c26d875-9117-4ad5-97b5-e9af775b94b4",
    });
    assert.equal(followingResult.runState, "idle");
    blockCompletedAudit = false;
    releaseCompletedAudit();
  });

  it("terminal audit fallback はsession turn correlationだけを保持する", () => {
    const correlation = {
      provider: "codex",
      kind: "session_turn_request",
      source: "session-runtime-service.run-session-turn",
      summary: "Session turn request correlation",
      payload: { clientRequestId: "7c26d875-9117-4ad5-97b5-e9af775b94bc", submitSource: "composer" },
    };
    assert.deepEqual(preserveSessionTurnRequestMetadata([
      correlation,
      {
        provider: "codex",
        kind: "provider_detail",
        source: "provider",
        summary: "detail",
        payload: { secret: "drop" },
      },
    ]), [correlation]);
  });

  it("HTTP runtime未初期化でもpendingをcompleted Sessionより先に永続化し、保存失敗時はcompletedにしない", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-mandatory-appraisal-"));
    const storage = new CharacterAffectTurnSettlementStorage(path.join(directory, "app.sqlite"));
    const runtimeApi: null = null;
    const createService = (
      initialSession: Session,
      queueCompletedTurnAppraisal: NonNullable<SessionRuntimeServiceDeps["queueCompletedTurnAppraisal"]>,
      beforeCompletedUpsert?: () => void | Promise<void>,
      markCompletedTurnAppraisalReady?: NonNullable<SessionRuntimeServiceDeps["markCompletedTurnAppraisalReady"]>,
      appraiseCompletedTurn?: NonNullable<SessionRuntimeServiceDeps["appraiseCompletedTurn"]>,
    ) => {
      let storedSession = initialSession;
      const completedWrites: Session[] = [];
      const callOrder: string[] = [];
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
          return createPartialResult({ assistantText: "完了" });
        },
      };
      const service = new SessionRuntimeService({
        getSession(sessionId) {
          return sessionId === storedSession.id ? storedSession : null;
        },
        async upsertSession(next) {
          if (next.runState === "idle" && next.messages.at(-1)?.role === "assistant") {
            await beforeCompletedUpsert?.();
            completedWrites.push(next);
            callOrder.push("completed-upsert");
          }
          storedSession = next;
          return next;
        },
        async resolveComposerPreview() {
          return { attachments: [], errors: [] };
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
        getSessionMemory(session) {
          return createSessionMemory(session.id);
        },
        resolveProjectMemoryEntriesForPrompt() {
          return [];
        },
        queueCompletedTurnAppraisal(input) {
          callOrder.push("pending-enqueue");
          return queueCompletedTurnAppraisal(input);
        },
        markCompletedTurnAppraisalReady(correlationId) {
          callOrder.push("pending-ready");
          if (markCompletedTurnAppraisalReady) {
            return markCompletedTurnAppraisalReady(correlationId);
          }
          storage.markReady(correlationId);
        },
        appraiseCompletedTurn,
        requireDurableCompletedTurnAppraisal: true,
        createAuditLog(input) {
          return createAuditLogBase(input);
        },
        updateAuditLog() {},
        setLiveSessionRun() {},
        getLiveSessionRun() {
          return null;
        },
        waitForApprovalDecision() {
          return "approve";
        },
        waitForElicitationResponse() {
          return { action: "cancel" };
        },
        setProviderQuotaTelemetry() {},
        setSessionContextTelemetry() {},
        invalidateProviderSessionThread() {},
        scheduleProviderQuotaTelemetryRefresh() {},
        broadcastLiveSessionRun() {},
        resolvePendingApprovalRequest() {},
        resolvePendingElicitationRequest() {},
        currentTimestampLabel,
        appraisalReadyRetryMs: 0,
      });
      return { service, completedWrites, callOrder };
    };

    try {
      const successfulSession = createSession();
      const successful = createService(
        successfulSession,
        (input) => {
          assert.equal(runtimeApi, null);
          storage.enqueue({
            correlationId: input.correlationId,
            characterId: input.session.characterId,
            sessionId: input.session.id,
            userMessage: input.userMessage,
            assistantMessage: input.assistantMessage,
            assistantMessageIndex: input.assistantMessageIndex,
            occurredAt: input.occurredAt,
          });
        },
        () => {
          assert.equal(storage.listPending().length, 1);
          assert.deepEqual(storage.listReadyPending(), []);
        },
      );
      const successfulResult = await successful.service.runSessionTurn(successfulSession.id, {
        userMessage: "保存して",
      });
      await waitForCondition(
        () => storage.listReadyPending().length === 1,
        "terminal commit後にbackgroundでpendingがready化されること",
      );
      const pending = storage.listPending();

      assert.equal(successfulResult.runState, "idle", successfulResult.messages.at(-1)?.text);
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.assistantMessage, "完了");
      assert.notEqual(pending[0]?.readyAt, null);
      assert.deepEqual(successful.callOrder, ["pending-enqueue", "completed-upsert", "pending-ready"]);

      const failingSession = createSession();
      const failing = createService(failingSession, () => {
        throw new Error("settlement storage unavailable");
      });
      const failingResult = await failing.service.runSessionTurn(failingSession.id, {
        userMessage: "保存に失敗して",
      });

      assert.equal(failingResult.runState, "error");
      assert.equal(failing.completedWrites.length, 0);
      assert.deepEqual(failing.callOrder, ["pending-enqueue"]);

      const readinessFailureSession = createSession();
      let appraisalCalls = 0;
      let readinessAttempts = 0;
      let releaseReadiness = () => undefined;
      const readinessBarrier = new Promise<void>((resolve) => {
        releaseReadiness = resolve;
      });
      const readinessFailure = createService(
        readinessFailureSession,
        (input) => {
          storage.enqueue({
            correlationId: input.correlationId,
            characterId: input.session.characterId,
            sessionId: input.session.id,
            userMessage: input.userMessage,
            assistantMessage: input.assistantMessage,
            assistantMessageIndex: input.assistantMessageIndex,
            occurredAt: input.occurredAt,
          });
        },
        undefined,
        async (correlationId) => {
          readinessAttempts += 1;
          if (readinessAttempts === 1) {
            throw new Error("temporary readiness failure");
          }
          await readinessBarrier;
          storage.markReady(correlationId);
        },
        () => {
          appraisalCalls += 1;
        },
      );
      let readinessRunResolved = false;
      const readinessFailureRun = readinessFailure.service.runSessionTurn(readinessFailureSession.id, {
        userMessage: "ready化に失敗しても完了を維持して",
      });
      void readinessFailureRun.then(() => {
        readinessRunResolved = true;
      });

      await waitForCondition(() => readinessAttempts >= 2, "background ready retryが2回目へ進むこと");

      assert.equal(readinessRunResolved, true);
      assert.equal(appraisalCalls, 0);
      assert.equal(storage.getPending(`turn:${readinessFailureSession.id}:audit:1`)?.readyAt, null);

      releaseReadiness();
      const readinessFailureResult = await readinessFailureRun;
      await waitForCondition(() => appraisalCalls === 1, "ready成功後にappraisal schedulerが起動すること");

      assert.equal(readinessFailureResult.runState, "idle");
      assert.equal(readinessFailure.completedWrites.length, 1);
      assert.equal(readinessAttempts, 2);
      assert.equal(appraisalCalls, 1);
      assert.equal(readinessFailureResult.messages.filter((message) => message.role === "assistant").length, 1);

      const absentSession = createSession();
      let absentReadyCalls = 0;
      let absentAppraisalCalls = 0;
      const absent = createService(
        absentSession,
        (input) => {
          storage.enqueue({
            correlationId: input.correlationId,
            characterId: input.session.characterId,
            sessionId: input.session.id,
            userMessage: input.userMessage,
            assistantMessage: input.assistantMessage,
            assistantMessageIndex: input.assistantMessageIndex,
            occurredAt: input.occurredAt,
          });
        },
        undefined,
        () => {
          absentReadyCalls += 1;
          return "absent";
        },
        () => {
          absentAppraisalCalls += 1;
        },
      );
      const absentResult = await absent.service.runSessionTurn(absentSession.id, {
        userMessage: "削除済みpendingは終端して",
      });
      await waitForCondition(() => absentReadyCalls === 1, "missing pendingのready化が一度だけ試行されること");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      assert.equal(absentResult.runState, "idle");
      assert.equal(absentReadyCalls, 1);
      assert.equal(absentAppraisalCalls, 0);
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("character-authoring session は turn 開始時の最新 Character snapshot を使う", async () => {
    const staleSession = createSession({
      sessionKind: "character-authoring",
      characterRuntimeSnapshot: {
        characterId: "char-a",
        name: "Old",
        description: "",
        iconFilePath: "",
        theme: { main: "#111111", sub: "#222222" },
        definitionMarkdown: "# Old",
        definitionSha256: "old",
        definitionByteSize: 5,
        snapshotAt: "old",
      },
    });
    const freshSession = {
      ...staleSession,
      character: "Fresh",
      characterRuntimeSnapshot: {
        characterId: "char-a",
        name: "Fresh",
        description: "",
        iconFilePath: "",
        theme: { main: "#333333", sub: "#444444" },
        definitionMarkdown: "# Fresh",
        definitionSha256: "fresh",
        definitionByteSize: 7,
        snapshotAt: "fresh",
      },
    };
    let composeSessionName = "";
    let runSessionName = "";
    let composedSessionFolderPath = "";
    let runSessionFolderPath = "";
    let notifiedSession: Session | null = null;
    let notifiedLastNonEmptyAssistantMessageText = "";

    const adapter: ProviderCodingAdapter = {
      composePrompt(input) {
        composeSessionName = input.session.characterRuntimeSnapshot?.name ?? "";
        composedSessionFolderPath = input.sessionFolderPath ?? "";
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
        runSessionName = input.session.characterRuntimeSnapshot?.name ?? "";
        runSessionFolderPath = input.sessionFolderPath ?? "";
        return Promise.resolve(createPartialResult({
          threadId: "thread-1",
          assistantText: "途中の案内\n\n完了したよ。",
          lastNonEmptyAssistantMessageText: "完了したよ。",
        }));
      },
    };

    const service = new SessionRuntimeService({
      getSession(sessionId) {
        return sessionId === staleSession.id ? staleSession : null;
      },
      upsertSession(next) {
        return next;
      },
      resolveRuntimeSessionForTurn(session) {
        assert.equal(session.characterRuntimeSnapshot?.name, "Old");
        return freshSession;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] } satisfies ComposerPreview;
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
      resolveSessionFolderPath(sessionId) {
        return `F:/user-data/session-files/${sessionId}`;
      },
      getSessionMemory() {
        return createSessionMemory(staleSession.id);
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
      async waitForApprovalDecision(): Promise<LiveApprovalDecision> {
        return "approve";
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      notifySessionTurnCompleted(completedSession, lastNonEmptyAssistantMessageText) {
        notifiedSession = completedSession;
        notifiedLastNonEmptyAssistantMessageText = lastNonEmptyAssistantMessageText;
      },
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(staleSession.id, { userMessage: "お願いします" });

    assert.equal(composeSessionName, "Fresh");
    assert.equal(runSessionName, "Fresh");
    assert.equal(composedSessionFolderPath, `F:/user-data/session-files/${freshSession.id}`);
    assert.equal(runSessionFolderPath, composedSessionFolderPath);
    assert.equal(result.characterRuntimeSnapshot?.name, "Fresh");
    assert.equal(notifiedSession, result);
    assert.equal(notifiedLastNonEmptyAssistantMessageText, "完了したよ。");
  });

  it("resolveSessionCharacter 未提供でも provider turn まで進む", async () => {
    const session = createSession();
    let composeCalled = false;
    let runCalled = false;
    let hasCharacterKey = false;

    const adapter: ProviderCodingAdapter = {
      composePrompt(input) {
        composeCalled = true;
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
        runCalled = true;
        hasCharacterKey = Object.prototype.hasOwnProperty.call(input, "character");
        return Promise.resolve(createPartialResult({
          threadId: "thread-1",
          assistantText: "完了したよ。",
        }));
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
      runCharacterReflection() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, { userMessage: "お願い" });

    assert.equal(composeCalled, true);
    assert.equal(runCalled, true);
    assert.equal(hasCharacterKey, false);
    assert.equal(result.runState, "idle");
  });

  it("setup 失敗でも live state を掃除する", async () => {
    const session = createSession();
    const calls: string[] = [];
    const liveStates: Array<LiveSessionRunState | null> = [];
    const adapter: ProviderCodingAdapter = {
      composePrompt() {
        calls.push("compose");
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
        throw new Error("provider should not run");
      },
    };

    const service = new SessionRuntimeService({
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      upsertSession(next) {
        calls.push(`upsert:${next.runState}`);
        return next;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] } satisfies ComposerPreview;
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
      createAuditLog() {
        calls.push("createAuditLog");
        throw new Error("audit failed");
      },
      updateAuditLog() {},
      setLiveSessionRun(_sessionId, state) {
        liveStates.push(state);
      },
      getLiveSessionRun() {
        return liveStates.at(-1) ?? null;
      },
      async waitForApprovalDecision(): Promise<LiveApprovalDecision> {
        return "approve";
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {
        calls.push("broadcast");
      },
      resolvePendingApprovalRequest() {
        calls.push("approval:deny");
      },
      resolvePendingElicitationRequest() {
        calls.push("elicitation:cancel");
      },
      currentTimestampLabel,
    });

    await assert.rejects(
      service.runSessionTurn(session.id, { userMessage: "お願い" }),
      /audit failed/,
    );

    assert.deepEqual(calls, [
      "compose",
      "upsert:running",
      "createAuditLog",
      "approval:deny",
      "elicitation:cancel",
      "upsert:error",
      "broadcast",
    ]);
    assert.equal(liveStates.at(-1), null);
  });

  it("成功時に running -> idle を保存し、Memory / reflection background task は起動しない", async () => {
    const session = createSession();
    const storedSessions: Session[] = [];
    const auditUpdates: UpdateAuditLogInput[] = [];
    const liveStates: Array<LiveSessionRunState | null> = [];
    const reflectionTriggers: Array<{ sessionId: string; triggerReason: string }> = [];
    let emitQueuedProgressDuringWrite: (() => void) | null = null;
    let queuedProgressEmitted = false;
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
        emitQueuedProgressDuringWrite = () => {
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
        };
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
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        return {
          threadId: "thread-1",
          assistantText: "完了したよ。",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          transportPayload: null,
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
        if (entry.phase === "running" && !queuedProgressEmitted && emitQueuedProgressDuringWrite) {
          queuedProgressEmitted = true;
          emitQueuedProgressDuringWrite();
        }
        if (entry.phase === "completed" && entry.assistantText) {
          assert.equal(storedSessions.at(-1)?.messages.at(entry.assistantMessageSeq ?? -1)?.text, entry.assistantText);
        }
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
      runCharacterReflection(nextSession, options) {
        reflectionTriggers.push({ sessionId: nextSession.id, triggerReason: options.triggerReason });
      },
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, { userMessage: "お願いします" });
    await waitForCondition(() => auditUpdates.length === 3, "completed auditがbackgroundで保存されること");

    assert.equal(result.runState, "idle");
    assert.equal(storedSessions.length, 2);
    assert.equal(storedSessions[0]?.runState, "running");
    assert.equal(storedSessions[1]?.runState, "idle");
    assert.equal(storedSessions[1]?.messages.at(-1)?.text, "完了したよ。");
    assert.equal(auditUpdates.length, 3);
    assert.equal(auditUpdates[0]?.phase, "running");
    assert.equal(auditUpdates[0]?.assistantText, "途中経過だよ。");
    assert.equal(auditUpdates[0]?.threadId, "thread-progress");
    assert.equal(auditUpdates[0]?.operations[0]?.summary, "npm test");
    assert.equal(auditUpdates[1]?.phase, "running");
    assert.equal(auditUpdates[1]?.assistantText, "late progress");
    assert.equal(auditUpdates[1]?.threadId, "thread-late");
    assert.equal(auditUpdates[1]?.operations[0]?.summary, "late step");
    assert.equal(auditUpdates.at(-1)?.phase, "completed");
    assert.equal(auditUpdates.at(-1)?.assistantText, "完了したよ。");
    assert.equal(auditUpdates.at(-1)?.assistantMessageSeq, 1);
    assert.notEqual(auditUpdates.at(-1)?.createdAt, auditUpdates[0]?.createdAt);
    assert.equal(
      Date.parse(auditUpdates.at(-1)?.createdAt ?? "") > Date.parse(auditUpdates[0]?.createdAt ?? ""),
      true,
    );
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
    assert.equal(
      auditUpdates.at(-1)?.transportPayload?.fields.find((field) => field.label === "promptEstimatedChars")?.value,
      "12",
    );
    assert.equal(
      auditUpdates.at(-1)?.transportPayload?.fields.find((field) => field.label === "promptEstimatedTokens")?.value,
      "3",
    );
    assert.equal(
      auditUpdates.at(-1)?.transportPayload?.fields.find((field) => field.label === "promptSystemEstimatedChars")?.value,
      "6",
    );
    assert.equal(
      auditUpdates.at(-1)?.transportPayload?.fields.find((field) => field.label === "promptSystemEstimatedTokens")?.value,
      "2",
    );
    assert.equal(
      auditUpdates.at(-1)?.transportPayload?.fields.find((field) => field.label === "promptInputEstimatedChars")?.value,
      "5",
    );
    assert.equal(
      auditUpdates.at(-1)?.transportPayload?.fields.find((field) => field.label === "promptInputEstimatedTokens")?.value,
      "2",
    );
    assert.deepEqual(reflectionTriggers, []);
    assert.equal(liveStates.at(-1), null);
    assert.equal(service.isRunInFlight(session.id), false);
  });

  it("completed audit の詳細更新が停止しても最小 terminal 状態を先に保存して run を解放する", async () => {
    const session = createSession({ provider: "codex" });
    const storedSessions: Session[] = [];
    const auditUpdates: UpdateAuditLogInput[] = [];
    let terminalCommit: SessionTurnTerminalCommit | null = null;

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
          threadId: "thread-1",
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
      upsertTerminalSession(next, commit) {
        storedSessions.push(next);
        terminalCommit = commit;
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
        if (entry.phase === "completed" && entry.assistantText === "完了したよ。") {
          return new Promise<void>(() => {});
        }
      },
      auditEnrichmentGraceMs: 5,
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
      setProviderQuotaTelemetry(_telemetry: ProviderQuotaTelemetry) {},
      setSessionContextTelemetry(_telemetry: SessionContextTelemetry) {},
      invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      runCharacterReflection() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, {
      userMessage: "お願いします",
      clientRequestId: "7c26d875-9117-4ad5-97b5-e9af775b94bc",
      submitSource: "composer",
    });
    await waitForCondition(
      () => terminalCommit?.phase === "completed"
        && auditUpdates.some((entry) => entry.phase === "completed" && Boolean(entry.assistantText)),
      "atomic terminal marker保存後に詳細audit更新がbackgroundで開始すること",
    );

    assert.equal(result.runState, "idle");
    assert.equal(result.status, "idle");
    assert.equal(result.messages.at(-1)?.text, "完了したよ。");
    assert.equal(storedSessions.length, 2);
    assert.equal(storedSessions[0]?.runState, "running");
    assert.equal(storedSessions[1]?.runState, "idle");
    assert.equal(storedSessions[1]?.messages.at(-1)?.text, "完了したよ。");
    assert.equal(terminalCommit?.phase, "completed");
    assert.equal(terminalCommit?.assistantMessageSeq, 1);
    assert.equal(terminalCommit?.threadId, "thread-1");
    assert.equal(auditUpdates.at(-1)?.phase, "completed");
    assert.equal(auditUpdates.at(-1)?.operations.length, 0);
    assert.equal(auditUpdates.at(-1)?.assistantText, "完了したよ。");
    assert.equal(auditUpdates.some((entry) => entry.phase === "failed"), false);
    assert.equal(service.isRunInFlight(session.id), false);
  });

  it("pending中のrunning audit観測をcompleted・failed・canceledのterminal auditへ保持する", async () => {
    for (const outcome of ["completed", "failed", "canceled"] as const) {
      const session = createSession({ id: `pending-audit-${outcome}`, provider: "codex" });
      const auditUpdates: UpdateAuditLogInput[] = [];
      let releaseRunningAudit = () => undefined;
      const runningAuditBarrier = new Promise<void>((resolve) => {
        releaseRunningAudit = resolve;
      });
      let signalRunningAuditStarted = () => undefined;
      const runningAuditStarted = new Promise<void>((resolve) => {
        signalRunningAuditStarted = resolve;
      });
      const observedUsage = { inputTokens: 13, cachedInputTokens: 2, outputTokens: 5 };
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
          void onProgress?.(createLiveRunState({
            sessionId: session.id,
            threadId: "thread-observed",
            assistantText: "observed partial",
            steps: [{
              id: "observed-step",
              type: "command_execution",
              summary: "npm test",
              status: "completed",
            }],
            usage: observedUsage,
          }));
          await runningAuditStarted;
          const partialResult = createPartialResult({
            threadId: "thread-observed",
            assistantText: "",
            operations: [],
            usage: null,
          });
          if (outcome === "completed") {
            return partialResult;
          }
          throw new ProviderTurnError(`${outcome} turn`, partialResult, outcome === "canceled");
        },
      };
      let storedSession = session;
      const service = new SessionRuntimeService({
        getSession(sessionId) {
          return sessionId === session.id ? storedSession : null;
        },
        upsertSession(next) {
          storedSession = next;
          return next;
        },
        upsertTerminalSession(next) {
          storedSession = next;
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
        resolveProjectMemoryEntriesForPrompt() {
          return [];
        },
        createAuditLog(input) {
          return createAuditLogBase(input);
        },
        updateAuditLog(_id, entry) {
          auditUpdates.push(entry);
          if (entry.phase === "running" && entry.operations.some((operation) => operation.summary === "npm test")) {
            signalRunningAuditStarted();
            return runningAuditBarrier;
          }
        },
        auditEnrichmentGraceMs: 1,
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
        setProviderQuotaTelemetry() {},
        setSessionContextTelemetry() {},
        invalidateProviderSessionThread() {},
        scheduleProviderQuotaTelemetryRefresh() {},
        runCharacterReflection() {},
        broadcastLiveSessionRun() {},
        resolvePendingApprovalRequest() {},
        resolvePendingElicitationRequest() {},
        currentTimestampLabel,
      });

      const result = await service.runSessionTurn(session.id, { userMessage: "お願いします" });
      assert.equal(service.isRunInFlight(session.id), false);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      releaseRunningAudit();
      await waitForCondition(
        () => auditUpdates.some((entry) => entry.phase === outcome),
        `${outcome} terminal auditが保存されること`,
      );

      const terminalAudit = auditUpdates.find((entry) => entry.phase === outcome);
      assert.ok(terminalAudit);
      assert.equal(terminalAudit.assistantText, "observed partial");
      assert.deepEqual(terminalAudit.usage, observedUsage);
      assert.deepEqual(terminalAudit.operations, [{
        type: "command_execution",
        summary: "npm test",
        details: "completed",
      }]);
      assert.equal(result.runState, outcome === "failed" ? "error" : "idle");
    }
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
      runCharacterReflection() {},
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

  it("成功後も Reasoning は live state に保持し、次の prompt 用 state で空にする", async () => {
    const session = createSession({ provider: "codex", threadId: "thread-old" });
    let liveState: LiveSessionRunState | null = null;
    const liveStates: Array<LiveSessionRunState | null> = [];

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
        await onProgress?.(createLiveRunState({
          sessionId: session.id,
          threadId: "thread-new",
          reasoningText: "既存経路を確認してから表示へ流す",
        }));
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
      runCharacterReflection() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    await service.runSessionTurn(session.id, { userMessage: "お願いします" });

    assert.equal(liveStates[0]?.reasoningText, "");
    assert.equal(liveStates.at(-1)?.threadId, "thread-new");
    assert.equal(liveStates.at(-1)?.reasoningText, "既存経路を確認してから表示へ流す");
  });

  it("provider failure 時は error session を保存し、cancel 時は idle へ戻す", async () => {
    const baseSession = createSession();
    const storedSessions: Session[] = [];
    const auditUpdates: UpdateAuditLogInput[] = [];
    let detachedSessionId: string | null = null;
    let cleanupStartedSessionId: string | null = null;
    let notificationCount = 0;
    let releaseInvalidation = () => undefined;
    const invalidationBarrier = new Promise<void>((resolve) => {
      releaseInvalidation = resolve;
    });
    let signalInvalidationStarted = () => undefined;
    const invalidationStarted = new Promise<void>((resolve) => {
      signalInvalidationStarted = resolve;
    });
    const partialResult: RunSessionTurnResult = {
      threadId: null,
      assistantText: "",
      logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
      transportPayload: { summary: "transport", fields: [] },
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
      async invalidateSessionThread(sessionId) {
        detachedSessionId = sessionId;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        cleanupStartedSessionId = sessionId;
        signalInvalidationStarted();
        await invalidationBarrier;
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
          usage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 2 },
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
        return adapter.invalidateSessionThread(sessionId);
      },
      scheduleProviderQuotaTelemetryRefresh() {},
      runCharacterReflection() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      notifySessionTurnCompleted() {
        notificationCount += 1;
      },
      currentTimestampLabel,
    });

    const run = service.runSessionTurn(baseSession.id, { userMessage: "お願いします" });
    const result = await run;
    assert.equal(service.isRunInFlight(baseSession.id), false);
    assert.equal(detachedSessionId, baseSession.id);
    assert.equal(cleanupStartedSessionId, null);
    await invalidationStarted;
    assert.equal(cleanupStartedSessionId, baseSession.id);
    releaseInvalidation();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(result.runState, "idle");
    assert.match(result.messages.at(-1)?.text ?? "", /キャンセル/);
    assert.equal(auditUpdates.length, 2);
    assert.equal(auditUpdates[0]?.phase, "running");
    assert.equal(auditUpdates[0]?.assistantText, "途中まで進んだよ。");
    assert.equal(auditUpdates.at(-1)?.phase, "canceled");
    assert.equal(auditUpdates.at(-1)?.threadId, "thread-before-cancel");
    assert.equal(auditUpdates.at(-1)?.assistantText, "途中まで進んだよ。");
    assert.deepEqual(auditUpdates.at(-1)?.operations, [{ type: "command_execution", summary: "npm run build", details: "in_progress" }]);
    assert.deepEqual(auditUpdates.at(-1)?.usage, { inputTokens: 5, cachedInputTokens: 0, outputTokens: 2 });
    assert.equal(
      auditUpdates.at(-1)?.transportPayload?.fields.find((field) => field.label === "promptEstimatedChars")?.value,
      "12",
    );
    assert.equal(
      auditUpdates.at(-1)?.transportPayload?.fields.find((field) => field.label === "promptEstimatedTokens")?.value,
      "3",
    );
    assert.equal(
      auditUpdates.at(-1)?.transportPayload?.fields.find((field) => field.label === "promptSystemEstimatedChars")?.value,
      "6",
    );
    assert.equal(
      auditUpdates.at(-1)?.transportPayload?.fields.find((field) => field.label === "promptSystemEstimatedTokens")?.value,
      "2",
    );
    assert.equal(
      auditUpdates.at(-1)?.transportPayload?.fields.find((field) => field.label === "promptInputEstimatedChars")?.value,
      "5",
    );
    assert.equal(
      auditUpdates.at(-1)?.transportPayload?.fields.find((field) => field.label === "promptInputEstimatedTokens")?.value,
      "2",
    );
    assert.equal(detachedSessionId, baseSession.id);
    assert.equal(notificationCount, 0);
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
      runCharacterReflection() {},
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

  it("setup dependency が停止しても cancel deadline で呼び出しを収束させ、dependency の実終了まで再送を拒否する", async () => {
    const session = createSession();
    let resolveComposer: ((preview: ComposerPreview) => void) | null = null;
    let providerCalled = false;
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
        providerCalled = true;
        return createPartialResult();
      },
    };

    const service = new SessionRuntimeService({
      getSession() {
        return session;
      },
      upsertSession(next) {
        return next;
      },
      resolveComposerPreview() {
        return new Promise<ComposerPreview>((resolve) => {
          resolveComposer = resolve;
        });
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
      runCharacterReflection() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
      providerCancelGraceMs: 5,
    });

    const runPromise = service.runSessionTurn(session.id, { userMessage: "お願いします" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!resolveComposer) {
      throw new Error("composer setup が開始されていないよ。");
    }
    assert.equal(service.isRunInFlight(session.id), true);
    service.cancelRun(session.id);
    const outcome = await Promise.race([
      runPromise.then(() => "resolved", () => "rejected"),
      new Promise<"deadline">((resolve) => setTimeout(() => resolve("deadline"), 25)),
    ]);

    assert.equal(service.hasInFlightRuns(), true);
    await assert.rejects(
      service.runSessionTurn(session.id, { userMessage: "再送" }),
      /まだ実行中/,
    );
    if (!resolveComposer) {
      throw new Error("composer resolve が取得できていないよ。");
    }
    resolveComposer({ attachments: [], errors: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(outcome, "rejected");
    assert.equal(providerCalled, false);
    assert.equal(service.hasInFlightRuns(), false);
  });

  it("provider が cancel 後も生存する間は terminal session への再送を拒否する", async () => {
    const session = createSession();
    const approvalResolutions: Array<{ sessionId: string; decision: LiveApprovalDecision }> = [];
    let observedAbortSignal: AbortSignal | undefined;
    let observedAbort = false;
    let resolveProvider: ((result: RunSessionTurnResult) => void) | null = null;
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
        observedAbort = signal.aborted;
        signal.addEventListener("abort", () => {
          observedAbort = true;
        }, { once: true });
        return new Promise<RunSessionTurnResult>((resolve) => {
          resolveProvider = resolve;
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
      runCharacterReflection() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest(sessionId, decision) {
        approvalResolutions.push({ sessionId, decision });
      },
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
      providerCancelGraceMs: 5,
    });

    const promise = service.runSessionTurn(session.id, { userMessage: "お願いします" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!observedAbortSignal) {
      throw new Error("provider setup が開始されていないよ。");
    }
    service.cancelRun(session.id);
    const result = await promise;

    if (!observedAbortSignal) {
      throw new Error("abort signal が観測できていないよ。");
    }
    assert.equal(observedAbort, true);
    assert.equal(result.runState, "idle");
    assert.equal(service.hasInFlightRuns(), true);
    await assert.rejects(
      service.runSessionTurn(session.id, { userMessage: "再送" }),
      /まだ実行中/,
    );
    if (!resolveProvider) {
      throw new Error("provider resolve が取得できていないよ。");
    }
    resolveProvider(createPartialResult());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(service.hasInFlightRuns(), false);
    assert.deepEqual(approvalResolutions, [
      { sessionId: session.id, decision: "deny" },
      { sessionId: session.id, decision: "deny" },
    ]);
  });

  it("cancel 後に provider が grace 内で成功しても完了通知しない", async () => {
    const session = createSession();
    let resolveProvider: ((result: RunSessionTurnResult) => void) | null = null;
    let notificationCount = 0;
    let queuedAppraisalCount = 0;
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
          resolveProvider = resolve;
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
      queueCompletedTurnAppraisal(input) {
        queuedAppraisalCount += 1;
        assert.equal(input.assistantMessageIndex, input.session.messages.length - 1);
      },
      createAuditLog(input) {
        return createAuditLogBase(input);
      },
      updateAuditLog() {},
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
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      notifySessionTurnCompleted() {
        notificationCount += 1;
      },
      currentTimestampLabel,
      providerCancelGraceMs: 1_000,
    });

    const runPromise = service.runSessionTurn(session.id, { userMessage: "お願いします" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!resolveProvider) {
      throw new Error("provider resolve が取得できていないよ。");
    }

    service.cancelRun(session.id);
    resolveProvider(createPartialResult({ assistantText: "完了したよ。" }));
    const result = await runPromise;

    assert.equal(result.runState, "idle");
    assert.equal(result.messages.at(-1)?.text, "完了したよ。");
    assert.equal(notificationCount, 0);
    assert.equal(queuedAppraisalCount, 1);
  });

  it("stale thread / session error で meaningful partial が無い時だけ thread reset 後に 1 回 retry する", async () => {
    const session = createSession({ provider: "codex", threadId: "thread-stale" });
    const storedSessions: Session[] = [];
    const invalidated: Array<{ providerId: string | null | undefined; sessionId: string }> = [];
    const reset: Array<{ providerId: string | null | undefined; sessionId: string }> = [];
    const auditUpdates: UpdateAuditLogInput[] = [];
    const seenThreadIds: string[] = [];
    const seenBindingGenerations: Array<string | undefined> = [];
    let bindingGeneration = 0;
    const timingContexts: Array<ConversationTimingContext | undefined> = [];
    const fixedObservedAt = new Date("2026-08-04T12:32:00.000Z");
    const timingContext: ConversationTimingContext = {
      observedAt: "2026-08-04T21:32:00.000+09:00",
      observedDayOfWeek: "tuesday",
      currentSession: null,
      sameCharacterOtherSession: null,
      sameCharacterSharedWork: null,
    };
    let attempt = 0;
    let notificationCount = 0;
    let timingResolutionCount = 0;
    let currentDateCount = 0;
    const runtimeTurnHandles: object[] = [];
    const endedRuntimeTurnHandles: unknown[] = [];
    const seenTurnCapabilities: Array<string | undefined> = [];

    const adapter: ProviderCodingAdapter = {
      composePrompt(input) {
        timingContexts.push(input.conversationTimingContext);
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
        seenBindingGenerations.push(input.agentRuntimeBinding?.executionGeneration);
        seenTurnCapabilities.push(input.agentRuntimeBinding?.turnCapability);
        timingContexts.push(input.conversationTimingContext);
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
      getProviderAgentRuntimeBinding({ session: bindingSession, provider }) {
        bindingGeneration += 1;
        return {
          bindingId: `binding-${bindingGeneration}`,
          bindingReference: `reference-${bindingGeneration}`,
          providerId: provider.id,
          executionGeneration: `generation-${bindingGeneration}`,
          transport: "env",
          expiresAt: null,
        };
      },
      beginProviderAgentRuntimeTurn({ binding }) {
        assert.equal(binding?.executionGeneration, "generation-1");
        const handle = {};
        runtimeTurnHandles.push(handle);
        return {
          handle,
          binding: binding ? { ...binding, turnCapability: "turn-capability-a" } : null,
        };
      },
      endProviderAgentRuntimeTurn(handle) {
        endedRuntimeTurnHandles.push(handle);
      },
      getSessionMemory(current) {
        return createSessionMemory(current.id);
      },
      resolveProjectMemoryEntriesForPrompt() {
        return [];
      },
      resolveConversationTimingContext(_session, observedAt) {
        timingResolutionCount += 1;
        assert.equal(observedAt, fixedObservedAt);
        return timingContext;
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
      resetProviderSessionThread(providerId, retrySessionId) {
        reset.push({ providerId, sessionId: retrySessionId });
      },
      scheduleProviderQuotaTelemetryRefresh() {},
      runCharacterReflection() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      notifySessionTurnCompleted() {
        notificationCount += 1;
      },
      currentTimestampLabel,
      currentDate() {
        currentDateCount += 1;
        return fixedObservedAt;
      },
    });

    const result = await service.runSessionTurn(session.id, { userMessage: "お願いします" });
    await waitForCondition(() => auditUpdates.length === 2, "retry成功auditがbackgroundで完了すること");

    assert.equal(result.runState, "idle");
    assert.equal(result.threadId, "thread-fresh");
    assert.equal(result.messages.filter((message) => message.role === "user").length, 1);
    assert.equal(result.messages.filter((message) => message.role === "assistant").length, 1);
    assert.deepEqual(seenThreadIds, ["thread-stale", ""]);
    assert.deepEqual(seenBindingGenerations, ["generation-1", "generation-1"]);
    assert.deepEqual(seenTurnCapabilities, ["turn-capability-a", "turn-capability-a"]);
    assert.equal(bindingGeneration, 1);
    assert.equal(runtimeTurnHandles.length, 1);
    assert.deepEqual(endedRuntimeTurnHandles, runtimeTurnHandles);
    assert.deepEqual(reset, [{ providerId: "codex", sessionId: session.id }]);
    assert.deepEqual(invalidated, []);
    assert.equal(storedSessions.length, 3);
    assert.equal(storedSessions[1]?.threadId, "");
    assert.equal(auditUpdates.length, 2);
    assert.equal(auditUpdates[0]?.phase, "running");
    assert.equal(auditUpdates.at(-1)?.phase, "completed");
    assert.equal(notificationCount, 1);
    assert.equal(currentDateCount, 1);
    assert.equal(timingResolutionCount, 1);
    assert.deepEqual(timingContexts, [timingContext, timingContext, timingContext]);
    assert.equal(timingContexts[0], timingContexts[1]);
    assert.equal(timingContexts[1], timingContexts[2]);
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
      runCharacterReflection() {},
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
      runCharacterReflection() {},
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
      runCharacterReflection() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, { userMessage: "お願いします" });
    await waitForCondition(() => auditUpdates.length === 2, "bootstrap retry成功auditがbackgroundで完了すること");

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
      runCharacterReflection() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, { userMessage: "お願いします" });
    await waitForCondition(() => auditUpdates.length === 2, "bootstrap failure auditがbackgroundで完了すること");

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
          operations: [{ type: "command_execution", summary: "npm test", details: "OK" }],
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
      runCharacterReflection() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    await service.runSessionTurn(session.id, { userMessage: "お願いします" });
    await waitForCondition(
      () => auditUpdates.some((entry) => entry.phase === "completed"),
      "approval履歴を含むcompleted auditがbackgroundで保存されること",
    );

    const runningUpdate = auditUpdates.find((entry) =>
      entry.phase === "running" && entry.operations.some((operation) => operation.type === "approval_request"),
    );
    assert.ok(runningUpdate);
    const approvalOperation = runningUpdate?.operations[0];
    assert.ok(approvalOperation);
    assert.equal(approvalOperation.type, "approval_request");
    assert.equal(approvalOperation.summary, "コマンド実行の承認");
    assert.match(approvalOperation.details ?? "", /status:pending/);
    const completedUpdate = auditUpdates.filter((entry) => entry.phase === "completed").at(-1);
    assert.ok(completedUpdate);
    assert.deepEqual(completedUpdate?.operations, [
      { type: "command_execution", summary: "npm test", details: "OK" },
      approvalOperation,
    ]);
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
      runCharacterReflection() {},
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

  it("completed audit log では同じ summary の command_execution を重複保持する", async () => {
    const session = createSession();
    const auditUpdates: UpdateAuditLogInput[] = [];
    let liveState = createLiveRunState({ sessionId: session.id, threadId: session.threadId });

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
          threadId: "thread-duplicate-commands",
          assistantText: "完了したよ。",
          operations: [
            { type: "command_execution", summary: "npm test", details: "exit:0 (1回目)" },
            { type: "command_execution", summary: "npm test", details: "exit:0 (2回目)" },
          ],
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
      async waitForElicitationResponse() {
        return { action: "accept" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      runCharacterReflection() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    await service.runSessionTurn(session.id, { userMessage: "お願いします" });
    await waitForCondition(
      () => auditUpdates.some((entry) => entry.phase === "completed"),
      "重複command履歴を含むcompleted auditがbackgroundで保存されること",
    );

    const completedUpdate = auditUpdates.filter((entry) => entry.phase === "completed").at(-1);
    assert.ok(completedUpdate);
    assert.deepEqual(completedUpdate?.operations, [
      { type: "command_execution", summary: "npm test", details: "exit:0 (1回目)" },
      { type: "command_execution", summary: "npm test", details: "exit:0 (2回目)" },
    ]);
  });

  it("elicitation request の直後に progress が無くても completed audit log に履歴を残す", async () => {
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
      async runSessionTurn(input) {
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
      runCharacterReflection() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    await service.runSessionTurn(session.id, { userMessage: "お願いします" });
    await waitForCondition(
      () => auditUpdates.some((entry) => entry.phase === "completed"),
      "elicitation履歴を含むcompleted auditがbackgroundで保存されること",
    );

    const runningUpdate = auditUpdates.find((entry) =>
      entry.phase === "running" && entry.operations.some((operation) => operation.type === "elicitation_request"),
    );
    assert.ok(runningUpdate);
    const elicitationOperation = runningUpdate?.operations[0];
    assert.ok(elicitationOperation);
    const completedUpdate = auditUpdates.filter((entry) => entry.phase === "completed").at(-1);
    assert.ok(completedUpdate);
    assert.deepEqual(completedUpdate?.operations, [elicitationOperation]);
  });

  it("failed audit log は partial threadId が無くても live progress の threadId を維持する", async () => {
    const session = createSession({ provider: "codex", threadId: "thread-stale" });
    const storedSessions: Session[] = [];
    const auditUpdates: UpdateAuditLogInput[] = [];
    let notificationCount = 0;

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
          steps: [
            {
              id: "step-live",
              type: "command_execution",
              summary: "npm test",
              status: "in_progress",
            },
          ],
          usage: { inputTokens: 9, cachedInputTokens: 1, outputTokens: 3 },
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
      runCharacterReflection() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      notifySessionTurnCompleted() {
        notificationCount += 1;
      },
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, { userMessage: "お願いします" });
    await waitForCondition(() => auditUpdates.at(-1)?.phase === "failed", "failed auditがbackgroundで保存されること");

    assert.equal(result.runState, "error");
    assert.equal(result.threadId, "thread-live");
    assert.equal(storedSessions.at(-1)?.threadId, "thread-live");
    assert.equal(auditUpdates.at(-1)?.phase, "failed");
    assert.equal(auditUpdates.at(-1)?.threadId, "thread-live");
    assert.equal(auditUpdates.at(-1)?.assistantText, "途中まで進んだよ。");
    assert.deepEqual(auditUpdates.at(-1)?.operations, [{ type: "command_execution", summary: "npm test", details: "in_progress" }]);
    assert.deepEqual(auditUpdates.at(-1)?.usage, { inputTokens: 9, cachedInputTokens: 1, outputTokens: 3 });
    assert.equal(notificationCount, 0);
  });

  it("usage_limit reason は audit log と assistant fallback で通常失敗文言にしない", async () => {
    const session = createSession({ provider: "codex", threadId: "thread-before-limit" });
    const storedSessions: Session[] = [];
    const auditUpdates: UpdateAuditLogInput[] = [];
    const usageLimitMessage =
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jun 12th, 2026 2:07 AM.";

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
        throw new ProviderTurnError(
          usageLimitMessage,
          createPartialResult({ threadId: "thread-before-limit" }),
          false,
          "usage_limit",
        );
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
      runCharacterReflection() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, { userMessage: "お願いします" });
    await waitForCondition(() => auditUpdates.at(-1)?.phase === "failed", "usage limit auditがbackgroundで保存されること");
    const expectedMessage = "Codexの使用上限に達しました。\n再実行可能時刻: Jun 12th, 2026 2:07 AM";

    assert.equal(result.runState, "error");
    assert.equal(auditUpdates.at(-1)?.phase, "failed");
    assert.equal(auditUpdates.at(-1)?.errorMessage, expectedMessage);
    assert.equal(storedSessions.at(-1)?.messages.at(-1)?.text, expectedMessage);
    assert.doesNotMatch(storedSessions.at(-1)?.messages.at(-1)?.text ?? "", /実行に失敗したよ。/);
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
      runCharacterReflection() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, { userMessage: "お願いします" });

    assert.equal(attempt, 1);
    assert.equal(result.runState, "error");
    assert.match(result.messages.at(-1)?.text ?? "", /途中まで出たよ。/);
    assert.deepEqual(invalidated, [{ providerId: "codex", sessionId: session.id }]);
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
      runCharacterReflection() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, { userMessage: "お願いします" });

    assert.equal(attempt, 1);
    assert.equal(result.runState, "error");
    assert.match(result.messages.at(-1)?.text ?? "", /resource not found/);
    assert.deepEqual(invalidated, [{ providerId: "codex", sessionId: session.id }]);
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
      runCharacterReflection() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    await service.runSessionTurn(session.id, { userMessage: "お願いします" });
    await waitForCondition(
      () => auditUpdates.some((entry) => entry.phase === "completed"),
      "live progressを含むcompleted auditがbackgroundで保存されること",
    );

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
    const completedUpdate = auditUpdates.filter((entry) => entry.phase === "completed").at(-1);
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
      runCharacterReflection() {},
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

  it("既存 backgroundTasks が progress 無しで完了しても completed audit log に履歴を残す", async () => {
    const session = createSession({ provider: "codex", threadId: "thread-stale" });
    const auditUpdates: UpdateAuditLogInput[] = [];
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
      updateAuditLog(_id, entry) {
        auditUpdates.push(entry);
      },
      setLiveSessionRun(_sessionId, state) {
        liveState = state;
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
      runCharacterReflection() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    await service.runSessionTurn(session.id, { userMessage: "お願いします" });
    await waitForCondition(
      () => auditUpdates.some((entry) => entry.phase === "completed"),
      "background task履歴を含むcompleted auditがbackgroundで保存されること",
    );

    const completedUpdate = auditUpdates.filter((entry) => entry.phase === "completed").at(-1);
    assert.ok(completedUpdate);
    assert.deepEqual(completedUpdate?.operations, [
      { type: "background-shell", summary: "バックグラウンド処理", details: "running\n継続中" },
    ]);
  });

  it("Session success を保存後に通知し、通知 failure は turn を失敗させない", async () => {
    const session = createSession();
    let persistedCompletedSession: Session | null = null;
    let notifiedSession: Session | null = null;
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
          threadId: "thread-1",
          assistantText: "完了したよ。",
        });
      },
    };

    const service = new SessionRuntimeService({
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      upsertSession(next) {
        if (next.runState === "idle" && next.messages.at(-1)?.role === "assistant") {
          persistedCompletedSession = next;
        }
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
      async waitForApprovalDecision(): Promise<LiveApprovalDecision> {
        return "approve";
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      runCharacterReflection() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      notifySessionTurnCompleted(completedSession) {
        notifiedSession = completedSession;
        return Promise.reject(new Error("notification failed"));
      },
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, { userMessage: "お願い" });

    assert.equal(result.runState, "idle");
    assert.equal(result.messages.at(-1)?.text, "完了したよ。");
    assert.equal(notifiedSession, persistedCompletedSession);
    assert.equal(notifiedSession?.messages.at(-1)?.text, "完了したよ。");
  });
});
