import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import type { Session } from "../../src-shared/session/session-state.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import { AuxiliarySessionService } from "../../src-electron/auxiliary/auxiliary-session-service.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { CharacterAffectTurnOwnershipCoordinator } from "../../src-electron/character/character-affect-turn-ownership-coordinator.js";
import { ProviderRuntimeOperationCoordinator } from "../../src-electron/providers/provider-runtime-operation-coordinator.js";
import { SessionPersistenceService } from "../../src-electron/session/session-persistence-service.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";

import type { AffectEventInput } from "../../src-shared/character-affect/affect-contract.js";
import {
  createCharacterContextError,
  type CharacterAffectAppraiseResponse,
  type CharacterContextErrorResponse,
  type CharacterContextResponse,
} from "../../src-shared/character-context/character-context-contract.js";
import { CharacterAffectTurnSettlementStorage, hasCommittedAssistantMessage } from "../../src-electron/character/character-affect-turn-settlement-storage.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import {
  CharacterAffectTurnRetryScheduler,
  settleCharacterAffectTurnOrScheduleRetry,
} from "../../src-electron/character/character-affect-turn-retry-scheduler.js";
import { settleCharacterAffectTurnWithRetry } from "../../src-electron/character/character-affect-turn-settler.js";
import {
  characterAffectTurnThrownFailureCode,
  createCharacterAffectTurnFailureDiagnostic,
  createCharacterAffectTurnRecoveryFailureLogData,
  resolveCharacterAffectTurnContextFailureStage,
} from "../../src-electron/character/character-affect-turn-recovery.js";

function context(version: string): CharacterContextResponse {
  return {
    schemaVersion: "withmate-character-context-v1",
    baseline: { definitionSha256: "sha", snapshotAt: "2026-08-09T00:00:00.000Z" },
    affect: {
      mode: "active",
      effective: [],
      evaluatedAt: "2026-08-09T04:00:00.000Z",
      version,
      updatedAt: null,
    },
    memory: { items: [], updatedAt: null },
  };
}

function candidate(idempotencyKey: string, reason = "stable candidate"): AffectEventInput {
  return {
    schemaVersion: "withmate-affect-v1",
    characterId: "character-a",
    userId: "local-user",
    sessionId: "session-a",
    layer: "session",
    targetType: "task",
    targetId: "current-task",
    family: "interest",
    value: { label: "interest", valence: 0.4 },
    intensity: 0.5,
    reason,
    evidence: "settlement recovery test",
    occurredAt: "2026-08-09T04:00:00.000Z",
    idempotencyKey,
  };
}

function success(candidateIndex = 0): CharacterAffectAppraiseResponse {
  return {
    schemaVersion: "withmate-character-context-v1",
    characterId: "character-a",
    sessionId: "session-a",
    saved: [{ candidateIndex, eventId: `event-${candidateIndex}`, memoryEntryId: null, replayed: false }],
    rejected: [],
    version: "v-next",
    updatedAt: "2026-08-09T04:01:00.000Z",
  };
}

function enqueue(storage: CharacterAffectTurnSettlementStorage, correlationId: string): void {
  storage.enqueue({
    correlationId,
    characterId: "character-a",
    sessionId: "session-a",
    userMessage: "user",
    assistantMessage: "assistant",
    assistantMessageIndex: 1,
    occurredAt: "2026-08-09T04:00:00.000Z",
  });
}

function settle(
  storage: CharacterAffectTurnSettlementStorage,
  correlationId: string,
  deps: {
    getContext(): Promise<CharacterContextResponse | CharacterContextErrorResponse>;
    evaluate(context: CharacterContextResponse, idempotencyPrefix: string): Promise<AffectEventInput[]>;
    appraise(
      expectedVersion: string,
      candidates: AffectEventInput[],
    ): Promise<CharacterAffectAppraiseResponse | CharacterContextErrorResponse>;
    afterRecordAppraisalFailure?(result: { reevaluationPrepared: boolean }): void;
    validateOwner?(): Promise<boolean>;
    runAppraisalExclusive?<T>(operation: () => T | Promise<T>): Promise<T>;
  },
) {
  const unitOwnership = async <T>(operation: () => T | Promise<T>): Promise<T> => operation();
  return settleCharacterAffectTurnWithRetry({
    correlationId,
    getPending: () => storage.getPending(correlationId),
    isCurrentGeneration: () => true,
    getContext: deps.getContext,
    evaluate: deps.evaluate,
    persistEvaluation: (input) => {
      storage.saveEvaluation({ correlationId, ...input });
    },
    appraise: deps.appraise,
    validateOwner: deps.validateOwner,
    runAppraisalExclusive: deps.runAppraisalExclusive ?? unitOwnership,
    recordAppraisalFailure: (input) => {
      const result = storage.recordAppraisalFailure({ correlationId, ...input });
      deps.afterRecordAppraisalFailure?.(result);
      return result;
    },
    markSettled: () => {
      storage.markSettled(correlationId);
    },
  });
}

function createScheduledTaskQueue() {
  const tasks: Array<{ handle: symbol; delayMs: number; task: () => void | Promise<void> }> = [];
  return {
    tasks,
    scheduleTask(task: () => void | Promise<void>, delayMs: number): symbol {
      const handle = Symbol("scheduled-task");
      tasks.push({ handle, delayMs, task });
      return handle;
    },
    cancelTask(handle: unknown): void {
      const index = tasks.findIndex((item) => item.handle === handle);
      if (index >= 0) {
        tasks.splice(index, 1);
      }
    },
    async runNext(): Promise<void> {
      const next = tasks.shift();
      assert.ok(next, "a retry task must be scheduled");
      await next.task();
    },
  };
}

describe("settleCharacterAffectTurnWithRetry", () => {
  it("Context stageとprovider timeoutを安全なfailure diagnosticへ分類する", () => {
    const contextError = createCharacterContextError("storage_unavailable", "context read failed", {
      retryable: true,
      conversationMayContinue: true,
      effect: "none",
      details: { failureStage: "memory_search" },
    });
    assert.equal(resolveCharacterAffectTurnContextFailureStage(contextError), "context_memory_search");
    const timeout = new Error("C:/private/workspace secret-token");
    timeout.name = "AbortError";
    assert.equal(characterAffectTurnThrownFailureCode(timeout, "evaluation"), "provider_timeout");
    const diagnostic = createCharacterAffectTurnFailureDiagnostic({
      code: "provider_timeout",
      stage: "evaluation",
      error: timeout,
      durationMs: 15_000.9,
    });
    assert.deepEqual(diagnostic, {
      code: "provider_timeout",
      stage: "evaluation",
      errorName: "AbortError",
      safeMessage: "Character affect turn evaluation failed with provider_timeout.",
      durationMs: 15_000,
    });
    assert.doesNotMatch(JSON.stringify(diagnostic), /private|workspace|secret-token/);

    const unsafe = new Error("C:/private/workspace secret-token");
    unsafe.name = "Bad Name C:/private";
    unsafe.stack = "secret-token at C:/private/workspace";
    const logData = createCharacterAffectTurnRecoveryFailureLogData(unsafe);
    assert.deepEqual(logData, {
      code: "recovery_failure",
      stage: "runtime",
      errorName: "UnknownError",
    });
    assert.doesNotMatch(JSON.stringify(logData), /private|workspace|secret-token|stack/);
  });

  it("direct settlementがthrowしてもpendingをretry schedulerへ引き渡す", async () => {
    const scheduled = createScheduledTaskQueue();
    let drainCalls = 0;
    const scheduler = new CharacterAffectTurnRetryScheduler({
      scheduleTask: scheduled.scheduleTask,
      cancelTask: scheduled.cancelTask,
      onError(error) {
        throw error;
      },
      async drain() {
        drainCalls += 1;
        return false;
      },
    });
    await assert.rejects(
      settleCharacterAffectTurnOrScheduleRetry({
        async settle() {
          throw new Error("provider timeout");
        },
        scheduleRetry() {
          scheduler.request({ resetBackoff: true });
        },
      }),
      /provider timeout/,
    );
    assert.equal(scheduled.tasks.length, 1);
    await scheduled.runNext();
    assert.equal(drainCalls, 1);
    assert.equal(scheduled.tasks.length, 0);
    scheduler.dispose();
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Affect評価待ち中はSession作成・削除が進み、owner検証後の適用中は削除が完了まで待つ"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#character-affect-の完了後評価" }
  // fault = "評価待ちに広域排他を保持するか、owner検証後のappraiseに削除が割り込む"
  // observable = "評価barrier解放前の作成・削除、discard選択、適用barrier中のSession生存と解放後の削除"
  // observation_boundary = "public-boundary"
  // scope = "character-affect-settlement"
  // lifecycle = "permanent"
  // impact = "無関係なAuxiliary作成やSession操作がCharacter Affect評価の遅延で停止しない"
  // distinction = "型検査では検出できないawait中の共有ownership保持を、settlerの実行境界で確認する"
  // @end-test-value
  it("実サービスのAuxiliary作成・Session削除・Provider操作は評価待ち中も完了し、削除済みownerはdiscardする", { timeout: 10_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-settler-ownership-"));
    const dbPath = path.join(directory, "runtime.db");
    const settlement = new CharacterAffectTurnSettlementStorage(dbPath);
    const sessions = new SessionStorageV6(dbPath);
    const auxiliaries = new AuxiliarySessionStorage(dbPath);
    const affectOwnership = new CharacterAffectTurnOwnershipCoordinator();
    const providerOwnership = new ProviderRuntimeOperationCoordinator();
    const makeSession = (id: string): Session => ({
      ...buildNewSession({
        taskTitle: id,
        workspaceLabel: id,
        workspacePath: `C:/${id}`,
        branch: "main",
        characterId: "character-a",
        character: "Character A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      }),
      id,
      provider: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high",
      messages: [{ role: "user", text: "user" }, { role: "assistant", text: "assistant" }],
    });
    const sessionA = makeSession("session-a");
    const sessionB = makeSession("session-b");
    sessions.insertSession(sessionA);
    sessions.insertSession(sessionB);
    let cachedSessions = [sessionA, sessionB];
    const catalog: ModelCatalogSnapshot = {
      revision: 1,
      providers: [{
        id: "codex", label: "Codex", defaultModelId: "gpt-5.4", defaultReasoningEffort: "high",
        models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["high"] }],
      }],
    };
    const persistence = new SessionPersistenceService({
      getSessions: () => cachedSessions,
      setSessions: (next) => { cachedSessions = next; },
      getSession: (id) => cachedSessions.find((entry) => entry.id === id) ?? null,
      getStoredSession: (id) => sessions.getSession(id),
      isSessionRunInFlight: () => false,
      upsertStoredSession: (next, operation) => operation === "create" ? sessions.insertSession(next) : sessions.updateSession(next),
      replaceStoredSessions: (next) => { sessions.replaceSessions(next); },
      listStoredSessions: () => sessions.listSessions(),
      deleteStoredSession: (id) => sessions.deleteSession(id),
      deleteStoredSessions: (ids) => sessions.deleteSessions(ids),
      getAppSettings: () => normalizeAppSettings({}),
      getModelCatalogSnapshot: () => catalog,
      syncSessionDependencies: () => undefined,
      clearSessionContextTelemetry: () => undefined,
      clearSessionBackgroundActivities: () => undefined,
      invalidateProviderSessionThread: () => undefined,
      closeSessionWindow: () => undefined,
      broadcastSessions: () => undefined,
      runCharacterAffectTurnOwnershipExclusive: (operation) => affectOwnership.runExclusive(operation),
    });
    const auxiliaryService = new AuxiliarySessionService({
      runProviderRuntimeOperationExclusive: (operation) => providerOwnership.runExclusive(operation),
      runCharacterAffectTurnOwnershipExclusive: (operation) => affectOwnership.runExclusive(operation),
      resolveSessionLaunchSelection: async () => ({
        provider: "codex", catalogRevision: 1, model: "gpt-5.4", reasoningEffort: "high",
        approvalMode: DEFAULT_APPROVAL_MODE, codexSandboxMode: "workspace-write-network", codexSpeed: "standard",
        codexReviewer: "user", customAgentName: "",
      }),
      getParentSession: (id) => sessions.getSession(id),
      getStorage: () => auxiliaries,
      getModelCatalogSnapshot: () => catalog,
      listActiveCharacters: () => [{
        id: "character-b", name: "Character B", description: "", iconFilePath: "",
        theme: { main: "#6f8cff", sub: "#6fb8c7" }, state: "active",
        createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z", archivedAt: null,
      }],
      createCharacterRuntimeSnapshot: (id) => ({
        characterId: id, name: "Character B", description: "", iconFilePath: "",
        theme: { main: "#6f8cff", sub: "#6fb8c7" }, definitionMarkdown: "# Character B",
        definitionSha256: "fixture", definitionByteSize: 13, snapshotAt: "2026-08-09T00:00:00.000Z",
      }),
    });
    const correlationId = "turn:session-a:audit:ownership-boundary";
    let releaseEvaluation!: () => void;
    let evaluationReached!: () => void;
    const evaluationWaiting = new Promise<void>((resolve) => { releaseEvaluation = resolve; });
    const evaluationStarted = new Promise<void>((resolve) => { evaluationReached = resolve; });
    let appraisals = 0;
    let discards = 0;
    let releaseAppraisal: () => void = () => undefined;
    try {
      enqueue(settlement, correlationId);
      const settling = settleCharacterAffectTurnWithRetry({
        correlationId,
        getPending: () => settlement.getPending(correlationId),
        isCurrentGeneration: () => true,
        getContext: async () => context("v-ownership-boundary"),
        evaluate: async (_current, idempotencyPrefix) => {
          evaluationReached();
          await evaluationWaiting;
          return [candidate(`${idempotencyPrefix}:0`)];
        },
        persistEvaluation: (input) => { settlement.saveEvaluation({ correlationId, ...input }); },
        appraise: async () => { appraisals += 1; return success(); },
        recordAppraisalFailure: (input) => settlement.recordAppraisalFailure({ correlationId, ...input }),
        validateOwner: async () => {
          const owner = sessions.getSession(sessionA.id);
          return Boolean(owner && owner.characterId === sessionA.characterId
            && hasCommittedAssistantMessage(owner.messages, { assistantMessage: "assistant", assistantMessageIndex: 1 }));
        },
        runAppraisalExclusive: (operation) => affectOwnership.runExclusive(operation),
        markDiscarded: () => { discards += 1; settlement.markDiscarded(correlationId); },
        markSettled: () => { settlement.markSettled(correlationId); },
      });
      await evaluationStarted;
      const created = await auxiliaryService.createAuxiliarySession({ parentSessionId: sessionB.id, provider: "codex" });
      const deleted = await persistence.deleteSession(sessionA.id);
      let providerOperationCompleted = false;
      await providerOwnership.runExclusive(async () => { providerOperationCompleted = true; });
      assert.equal(created.parentSessionId, sessionB.id);
      assert.deepEqual(deleted.deletedSessionIds, [sessionA.id]);
      assert.equal(providerOperationCompleted, true);
      releaseEvaluation();
      const result = await settling;
      assert.deepEqual(result, { status: "settled", appraisal: null });
      assert.equal(appraisals, 0);
      assert.equal(discards, 1);
      assert.equal(settlement.getPending(correlationId), null);

      const liveCorrelationId = "turn:session-b:audit:ownership-boundary";
      settlement.enqueue({
        correlationId: liveCorrelationId,
        characterId: sessionB.characterId,
        sessionId: sessionB.id,
        userMessage: "user",
        assistantMessage: "assistant",
        assistantMessageIndex: 1,
        occurredAt: "2026-08-09T04:00:00.000Z",
      });
      let appraisalReached!: () => void;
      const appraisalWaiting = new Promise<void>((resolve) => { releaseAppraisal = resolve; });
      const appraisalStarted = new Promise<void>((resolve) => { appraisalReached = resolve; });
      const liveSettlement = settleCharacterAffectTurnWithRetry({
        correlationId: liveCorrelationId,
        isCurrentGeneration: () => true,
        getPending: () => settlement.getPending(liveCorrelationId),
        getContext: async () => ({ ...context("v-live"), sessionId: sessionB.id }),
        evaluate: async (_current, prefix) => [{ ...candidate(`${prefix}:0`), sessionId: sessionB.id }],
        persistEvaluation: (input) => { settlement.saveEvaluation({ correlationId: liveCorrelationId, ...input }); },
        validateOwner: async () => {
          const owner = sessions.getSession(sessionB.id);
          return Boolean(owner && owner.characterId === sessionB.characterId
            && hasCommittedAssistantMessage(owner.messages, { assistantMessage: "assistant", assistantMessageIndex: 1 }));
        },
        runAppraisalExclusive: (operation) => affectOwnership.runExclusive(operation),
        appraise: async () => {
          appraisalReached();
          await appraisalWaiting;
          return { ...success(), sessionId: sessionB.id };
        },
        recordAppraisalFailure: (input) => settlement.recordAppraisalFailure({ correlationId: liveCorrelationId, ...input }),
        markDiscarded: () => { throw new Error("live owner must not be discarded"); },
        markSettled: () => { settlement.markSettled(liveCorrelationId); },
      });
      await appraisalStarted;
      let deletionCompleted = false;
      const deleteLiveOwner = persistence.deleteSession(sessionB.id).then((value) => {
        deletionCompleted = true;
        return value;
      });
      // このfixtureの削除は同期DBとmicrotaskだけで進む。経過時間でなく次のevent-loop境界を観測する。
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(deletionCompleted, false);
      assert.ok(sessions.getSession(sessionB.id));
      releaseAppraisal();
      assert.equal((await liveSettlement).status, "settled");
      assert.deepEqual((await deleteLiveOwner).deletedSessionIds, [sessionB.id]);
      assert.equal(sessions.getSession(sessionB.id), null);
    } finally {
      releaseEvaluation();
      releaseAppraisal();
      settlement.close();
      auxiliaries.close();
      sessions.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "適用直前のowner検証がfalseならappraiseせずdiscard callbackを選ぶ"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#character-affect-の完了後評価" }
  // fault = "owner検証がfalseなのにappraiseするか正常settledとして処理する"
  // observable = "appraiseとdiscardの呼び出し回数とsettlement pending行の有無"
  // observation_boundary = "component-behavior"
  // scope = "character-affect-settlement-owner-lifecycle"
  // lifecycle = "permanent"
  // distinction = "owner検証失敗の分岐を、DB削除処理に依存せず直接確認する"
  // @end-test-value
  it("provider評価中にSession ownerが消えた場合はappraiseせずpendingを破棄する", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-owner-recheck-"));
    const storage = new CharacterAffectTurnSettlementStorage(path.join(directory, "settlement.db"));
    const correlationId = "turn:session-a:audit:owner-recheck";
    let appraisalCount = 0;
    let discardedCount = 0;
    let ownerAvailable = true;
    try {
      enqueue(storage, correlationId);
      const result = await settleCharacterAffectTurnWithRetry({
        correlationId,
        getPending: () => storage.getPending(correlationId),
        isCurrentGeneration: () => true,
        async getContext() {
          return context("v-owner-recheck");
        },
        async evaluate(_current: CharacterContextResponse, idempotencyPrefix: string) {
          ownerAvailable = false;
          return [candidate(`${idempotencyPrefix}:0`)];
        },
        persistEvaluation(input) {
          storage.saveEvaluation({ correlationId, ...input });
        },
        async appraise() {
          appraisalCount += 1;
          return success();
        },
        recordAppraisalFailure(input) {
          return storage.recordAppraisalFailure({ correlationId, ...input });
        },
        async validateOwner() {
          return ownerAvailable;
        },
        runAppraisalExclusive: async (operation) => operation(),
        markDiscarded() {
          discardedCount += 1;
          storage.markDiscarded(correlationId);
        },
        markSettled() {
          storage.markSettled(correlationId);
        },
      });

      assert.deepEqual(result, { status: "settled", appraisal: null });
      assert.equal(appraisalCount, 0);
      assert.equal(discardedCount, 1);
      assert.equal(storage.getPending(correlationId), null);
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("unknownからversion conflictになったpendingを予約済みdrainでrestartなしにsettledへ収束させる", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-scheduled-retry-"));
    const storage = new CharacterAffectTurnSettlementStorage(path.join(directory, "settlement.db"));
    const correlationId = "turn:session-a:audit:scheduled-retry";
    const scheduled = createScheduledTaskQueue();
    const appraisedKeys: string[] = [];
    let appraisalCount = 0;
    let drainCount = 0;
    try {
      enqueue(storage, correlationId);
      const scheduler = new CharacterAffectTurnRetryScheduler({
        initialRetryDelayMs: 10,
        maximumRetryDelayMs: 40,
        scheduleTask: scheduled.scheduleTask,
        cancelTask: scheduled.cancelTask,
        onError(error) {
          throw error;
        },
        async drain() {
          drainCount += 1;
          const result = await settle(storage, correlationId, {
            async getContext() {
              return context(`v-${drainCount}`);
            },
            async evaluate(_current, idempotencyPrefix) {
              return [candidate(`${idempotencyPrefix}:0`, `generation ${drainCount}`)];
            },
            async appraise(_expectedVersion, candidates) {
              appraisalCount += 1;
              appraisedKeys.push(candidates[0]!.idempotencyKey);
              if (appraisalCount === 1) {
                return createCharacterContextError("storage_unavailable", "response lost", {
                  retryable: true,
                  conversationMayContinue: true,
                  effect: "unknown",
                });
              }
              if (appraisalCount === 2) {
                return createCharacterContextError("version_conflict", "uncommitted generation", {
                  retryable: true,
                  conversationMayContinue: true,
                  effect: "none",
                });
              }
              return success();
            },
          });
          return result.status === "pending";
        },
      });

      scheduler.request({ immediate: true, resetBackoff: true });
      await scheduled.runNext();
      assert.equal(appraisalCount, 1);
      assert.equal(scheduled.tasks.length, 1);
      await scheduled.runNext();
      assert.equal(appraisalCount, 2);
      assert.equal(storage.getPending(correlationId)?.evaluationAttempt, 1);
      assert.equal(scheduled.tasks.length, 1);
      await scheduled.runNext();

      assert.equal(storage.getPending(correlationId), null);
      assert.equal(appraisalCount, 3);
      assert.equal(drainCount, 3);
      assert.deepEqual(appraisedKeys, [
        `${correlationId}:0`,
        `${correlationId}:0`,
        `${correlationId}:evaluation:1:0`,
      ]);
      assert.equal(scheduled.tasks.length, 0);
      scheduler.dispose();
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retry schedulerは同時要求をcoalesceし一回のdrainで一つのappraisalだけ実行する", async () => {
    const scheduled = createScheduledTaskQueue();
    let drainCount = 0;
    const scheduler = new CharacterAffectTurnRetryScheduler({
      initialRetryDelayMs: 10,
      maximumRetryDelayMs: 40,
      scheduleTask: scheduled.scheduleTask,
      cancelTask: scheduled.cancelTask,
      onError(error) {
        throw error;
      },
      async drain() {
        drainCount += 1;
        return drainCount < 3;
      },
    });

    scheduler.request({ immediate: true });
    scheduler.request({ immediate: true });
    assert.equal(scheduled.tasks.length, 1);
    await scheduled.runNext();
    assert.equal(drainCount, 1);
    assert.equal(scheduled.tasks.length, 1);
    assert.equal(scheduled.tasks[0]!.delayMs, 10);
    await scheduled.runNext();
    assert.equal(drainCount, 2);
    assert.equal(scheduled.tasks[0]!.delayMs, 20);
    await scheduled.runNext();
    assert.equal(drainCount, 3);
    assert.equal(scheduled.tasks.length, 0);
    scheduler.dispose();
  });

  it("drain実行中の追加要求も次の一回へcoalesceする", async () => {
    const scheduled = createScheduledTaskQueue();
    let drainCount = 0;
    let releaseFirstDrain: (() => void) | null = null;
    const firstDrainWaiting = new Promise<void>((resolve) => {
      releaseFirstDrain = resolve;
    });
    const scheduler = new CharacterAffectTurnRetryScheduler({
      initialRetryDelayMs: 10,
      maximumRetryDelayMs: 40,
      scheduleTask: scheduled.scheduleTask,
      cancelTask: scheduled.cancelTask,
      onError(error) {
        throw error;
      },
      async drain() {
        drainCount += 1;
        if (drainCount === 1) {
          await firstDrainWaiting;
        }
        return false;
      },
    });

    scheduler.request({ immediate: true });
    const running = scheduled.runNext();
    scheduler.request();
    scheduler.request();
    releaseFirstDrain!();
    await running;

    assert.equal(drainCount, 1);
    assert.equal(scheduled.tasks.length, 1);
    await scheduled.runNext();
    assert.equal(drainCount, 2);
    assert.equal(scheduled.tasks.length, 0);
    scheduler.dispose();
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "effect:noneのversion conflictだけを最新contextで再評価し、別idempotency namespaceへ進める"
  // oracle = { type = "contract", ref = "Character Affect settler retry contract" }
  // fault = "retry対象外のconflictを再評価する、または旧namespaceのkeyを再利用する"
  // observable = "context/appraisal回数、candidate idempotency keys、settlement状態"
  // observation_boundary = "component-behavior"
  // scope = "settleCharacterAffectTurnWithRetry version conflict recovery"
  // lifecycle = "permanent"
  // @end-test-value
  it("effect:noneのversion conflictだけ最新contextで再評価し、別idempotency namespaceを使う", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-settler-version-"));
    const storage = new CharacterAffectTurnSettlementStorage(path.join(directory, "settlement.db"));
    const correlationId = "turn:session-a:audit:42";
    const prefixes: string[] = [];
    let contextReadCount = 0;
    let appraisalCount = 0;
    try {
      enqueue(storage, correlationId);
      const deps = {
        async getContext() {
          contextReadCount += 1;
          return context(`v${contextReadCount}`);
        },
        async evaluate(_current: CharacterContextResponse, idempotencyPrefix: string) {
          prefixes.push(idempotencyPrefix);
          return [candidate(`${idempotencyPrefix}:0`, `evaluation ${prefixes.length}`)];
        },
        async appraise() {
          appraisalCount += 1;
          if (appraisalCount === 1) {
            return createCharacterContextError("version_conflict", "stale", {
              retryable: true,
              conversationMayContinue: true,
              effect: "none",
            });
          }
          return success();
        },
      };
      const firstResult = await settle(storage, correlationId, deps);
      assert.equal(firstResult.status, "pending");
      assert.deepEqual(prefixes, [correlationId]);
      assert.equal(appraisalCount, 1);
      assert.equal(storage.getPending(correlationId)?.evaluationAttempt, 1);
      assert.equal(storage.getPending(correlationId)?.evaluation, null);

      const result = await settle(storage, correlationId, deps);
      assert.equal(result.status, "settled");
      assert.deepEqual(prefixes, [correlationId, `${correlationId}:evaluation:1`]);
      assert.equal(appraisalCount, 2);
      assert.equal(storage.getPending(correlationId), null);
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("effect:noneのversion conflictが再評価後も続く場合、restartをまたぐretry generationでsettledへ収束する", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-settler-durable-retry-"));
    const dbPath = path.join(directory, "settlement.db");
    const correlationId = "turn:session-a:audit:durable-retry";
    const prefixes: string[] = [];
    let first: CharacterAffectTurnSettlementStorage | null = null;
    let second: CharacterAffectTurnSettlementStorage | null = null;
    let recovered: CharacterAffectTurnSettlementStorage | null = null;
    try {
      first = new CharacterAffectTurnSettlementStorage(dbPath);
      enqueue(first, correlationId);
      const firstResult = await settle(first, correlationId, {
        async getContext() {
          return context(`v${prefixes.length + 1}`);
        },
        async evaluate(_current, idempotencyPrefix) {
          prefixes.push(idempotencyPrefix);
          return [candidate(`${idempotencyPrefix}:0`, `evaluation ${prefixes.length}`)];
        },
        async appraise() {
          return createCharacterContextError("version_conflict", "stale", {
            retryable: true,
            conversationMayContinue: true,
            effect: "none",
          });
        },
      });
      assert.equal(firstResult.status, "pending");
      assert.deepEqual(prefixes, [correlationId]);
      const persisted = first.getPending(correlationId);
      assert.equal(persisted?.evaluationAttempt, 1);
      assert.equal(persisted?.evaluation, null);
      first.close();
      first = null;

      second = new CharacterAffectTurnSettlementStorage(dbPath);
      const secondResult = await settle(second, correlationId, {
        async getContext() {
          return context("v2");
        },
        async evaluate(_current, idempotencyPrefix) {
          prefixes.push(idempotencyPrefix);
          return [candidate(`${idempotencyPrefix}:0`, "evaluation 2")];
        },
        async appraise() {
          return createCharacterContextError("version_conflict", "still stale", {
            retryable: true,
            conversationMayContinue: true,
            effect: "none",
          });
        },
      });
      assert.equal(secondResult.status, "pending");
      assert.deepEqual(prefixes, [correlationId, `${correlationId}:evaluation:1`]);
      assert.equal(second.getPending(correlationId)?.evaluationAttempt, 2);
      assert.equal(second.getPending(correlationId)?.evaluation, null);
      second.close();
      second = null;

      recovered = new CharacterAffectTurnSettlementStorage(dbPath);
      const recoveredResult = await settle(recovered, correlationId, {
        async getContext() {
          return context("v3");
        },
        async evaluate(_current, idempotencyPrefix) {
          prefixes.push(idempotencyPrefix);
          return [candidate(`${idempotencyPrefix}:0`, "evaluation 3")];
        },
        async appraise() {
          return success();
        },
      });
      assert.equal(recoveredResult.status, "settled");
      assert.deepEqual(prefixes, [
        correlationId,
        `${correlationId}:evaluation:1`,
        `${correlationId}:evaluation:2`,
      ]);
      assert.equal(new Set(prefixes).size, prefixes.length);
      assert.equal(recovered.getPending(correlationId), null);
    } finally {
      recovered?.close();
      second?.close();
      first?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("effect:noneの記録直後にprocessが終了しても再評価準備をatomicに復旧する", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-settler-atomic-retry-"));
    const dbPath = path.join(directory, "settlement.db");
    const correlationId = "turn:session-a:audit:atomic-retry";
    let first: CharacterAffectTurnSettlementStorage | null = null;
    let recovered: CharacterAffectTurnSettlementStorage | null = null;
    try {
      first = new CharacterAffectTurnSettlementStorage(dbPath);
      enqueue(first, correlationId);
      await assert.rejects(() => settle(first!, correlationId, {
        async getContext() {
          return context("v1");
        },
        async evaluate(_current, idempotencyPrefix) {
          return [candidate(`${idempotencyPrefix}:0`)];
        },
        async appraise() {
          return createCharacterContextError("version_conflict", "stale", {
            retryable: true,
            conversationMayContinue: true,
            effect: "none",
          });
        },
        afterRecordAppraisalFailure(result) {
          assert.deepEqual(result, { reevaluationPrepared: true });
          throw new Error("simulated process exit after atomic retry commit");
        },
      }), /simulated process exit/);
      assert.equal(first.getPending(correlationId)?.evaluationAttempt, 1);
      assert.equal(first.getPending(correlationId)?.evaluation, null);
      first.close();
      first = null;

      recovered = new CharacterAffectTurnSettlementStorage(dbPath);
      const prefixes: string[] = [];
      const result = await settle(recovered, correlationId, {
        async getContext() {
          return context("v2");
        },
        async evaluate(_current, idempotencyPrefix) {
          prefixes.push(idempotencyPrefix);
          return [candidate(`${idempotencyPrefix}:0`, "recovered evaluation")];
        },
        async appraise() {
          return success();
        },
      });
      assert.equal(result.status, "settled");
      assert.deepEqual(prefixes, [`${correlationId}:evaluation:1`]);
      assert.equal(recovered.getPending(correlationId), null);
    } finally {
      recovered?.close();
      first?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("unknown後の同一candidate retryがeffect:none version conflictなら新generationへ進みsettledへ収束する", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-settler-ambiguous-conflict-"));
    const dbPath = path.join(directory, "settlement.db");
    const correlationId = "turn:session-a:audit:ambiguous-conflict";
    let first: CharacterAffectTurnSettlementStorage | null = null;
    let reconcile: CharacterAffectTurnSettlementStorage | null = null;
    let recovered: CharacterAffectTurnSettlementStorage | null = null;
    const appraisedKeys: string[] = [];
    try {
      first = new CharacterAffectTurnSettlementStorage(dbPath);
      enqueue(first, correlationId);
      const firstResult = await settle(first, correlationId, {
        async getContext() {
          return context("v1");
        },
        async evaluate(_current, idempotencyPrefix) {
          return [candidate(`${idempotencyPrefix}:0`)];
        },
        async appraise(_expectedVersion, candidates) {
          appraisedKeys.push(candidates[0]!.idempotencyKey);
          return createCharacterContextError("storage_unavailable", "response lost", {
            retryable: true,
            conversationMayContinue: true,
            effect: "unknown",
          });
        },
      });
      assert.equal(firstResult.status, "pending");
      const persistedCandidate = first.getPending(correlationId)?.evaluation?.candidates;
      first.close();
      first = null;

      reconcile = new CharacterAffectTurnSettlementStorage(dbPath);
      const reconcileResult = await settle(reconcile, correlationId, {
        async getContext() {
          throw new Error("ambiguous appraisal must not fetch a new context");
        },
        async evaluate() {
          throw new Error("ambiguous appraisal must not replace candidate identity");
        },
        async appraise(_expectedVersion, candidates) {
          assert.deepEqual(candidates, persistedCandidate);
          appraisedKeys.push(candidates[0]!.idempotencyKey);
          return createCharacterContextError("version_conflict", "reconcile conflict", {
            retryable: true,
            conversationMayContinue: true,
            effect: "none",
          });
        },
      });
      assert.equal(reconcileResult.status, "pending");
      assert.equal(reconcile.getPending(correlationId)?.evaluationAttempt, 1);
      assert.equal(reconcile.getPending(correlationId)?.evaluation, null);
      reconcile.close();
      reconcile = null;

      recovered = new CharacterAffectTurnSettlementStorage(dbPath);
      const recoveredResult = await settle(recovered, correlationId, {
        async getContext() {
          return context("v2");
        },
        async evaluate(_current, idempotencyPrefix) {
          return [candidate(`${idempotencyPrefix}:0`, "post-reconcile evaluation")];
        },
        async appraise(_expectedVersion, candidates) {
          appraisedKeys.push(candidates[0]!.idempotencyKey);
          return success();
        },
      });
      assert.equal(recoveredResult.status, "settled");
      assert.deepEqual(appraisedKeys, [
        `${correlationId}:0`,
        `${correlationId}:0`,
        `${correlationId}:evaluation:1:0`,
      ]);
      assert.equal(recovered.getPending(correlationId), null);
    } finally {
      recovered?.close();
      reconcile?.close();
      first?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  for (const effect of ["partial", "committed", "unknown"] as const) {
    it(`${effect} effect後のrestart recoveryは保存済みcandidateを再評価せずreconcileする`, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), `withmate-affect-settler-${effect}-`));
      const dbPath = path.join(directory, "settlement.db");
      const correlationId = `turn:session-a:audit:${effect}`;
      let first: CharacterAffectTurnSettlementStorage | null = null;
      let recovered: CharacterAffectTurnSettlementStorage | null = null;
      const evaluatedCandidates: AffectEventInput[][] = [];
      try {
        first = new CharacterAffectTurnSettlementStorage(dbPath);
        enqueue(first, correlationId);
        const firstResult = await settle(first, correlationId, {
          async getContext() {
            return context("v1");
          },
          async evaluate(_current, idempotencyPrefix) {
            return [candidate(`${idempotencyPrefix}:0`)];
          },
          async appraise(_expectedVersion, candidates) {
            evaluatedCandidates.push(candidates);
            return createCharacterContextError(
              effect === "unknown" ? "version_conflict" : "partial_failure",
              "injected ambiguous result",
              {
                retryable: true,
                conversationMayContinue: true,
                effect,
                ...(effect === "partial"
                  ? { details: { saved: [{ candidateIndex: 0 }] } }
                  : effect === "committed"
                    ? { details: { failedCandidateIndex: 0 } }
                    : {}),
              },
            );
          },
        });
        assert.equal(firstResult.status, "pending");
        const persistedCandidate = first.getPending(correlationId)?.evaluation?.candidates[0];
        assert.equal(first.getPending(correlationId)?.evaluation?.lastEffect, effect);
        first.close();
        first = null;

        recovered = new CharacterAffectTurnSettlementStorage(dbPath);
        const recoveredResult = await settle(recovered, correlationId, {
          async getContext() {
            throw new Error("stored evaluation must not fetch context before reconcile");
          },
          async evaluate() {
            throw new Error("stored candidate must not be re-evaluated");
          },
          async appraise(_expectedVersion, candidates) {
            evaluatedCandidates.push(candidates);
            return success();
          },
        });
        assert.equal(recoveredResult.status, "settled");
        assert.deepEqual(evaluatedCandidates[1], [persistedCandidate]);
        assert.equal(recovered.getPending(correlationId), null);
      } finally {
        recovered?.close();
        first?.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  it("ambiguous pendingが残っても後続settlementを処理できる", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-settler-starvation-"));
    const storage = new CharacterAffectTurnSettlementStorage(path.join(directory, "settlement.db"));
    const firstCorrelation = "turn:session-a:audit:first";
    const secondCorrelation = "turn:session-a:audit:second";
    try {
      enqueue(storage, firstCorrelation);
      enqueue(storage, secondCorrelation);
      for (const pending of storage.listPending()) {
        await settle(storage, pending.correlationId, {
          async getContext() {
            return context("v1");
          },
          async evaluate(_current, idempotencyPrefix) {
            return [candidate(`${idempotencyPrefix}:0`)];
          },
          async appraise() {
            if (pending.correlationId === firstCorrelation) {
              return createCharacterContextError("storage_unavailable", "unknown", {
                retryable: true,
                conversationMayContinue: true,
                effect: "unknown",
              });
            }
            return success();
          },
        });
      }
      assert.equal(storage.getPending(firstCorrelation)?.evaluation?.lastEffect, "unknown");
      assert.equal(storage.getPending(secondCorrelation), null);
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
