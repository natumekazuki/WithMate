import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  SESSION_AUTHORITY_MAPPING_REVISION,
  type MutationAuthorityProof,
} from "../../src/session-authority.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import {
  SessionExecutionOwnerMismatchError,
  SessionExecutionService,
  type SessionExecutionDispatchResult,
} from "../../src-electron/session-execution-service.js";
import { insertStandaloneRoleBindingsForSessions } from "./session-role-binding-fixture.js";
import {
  SessionExecutionBusyError,
  SessionExecutionIdempotencyConflictError,
  SessionExecutionStateConflictError,
  SessionExecutionStorageV6,
} from "../../src-electron/session-execution-storage-v6.js";
import { ResourceBudgetError, ResourceBudgetStorage } from "../../src-electron/resource-budget-storage.js";

const CREATED_AT = "2026-08-10T00:00:00.000Z";

function trustedExecutionProof(
  operation: "turn.run" | "turn.enqueue" | "turn.cancel",
  sessionId = "session-1",
): MutationAuthorityProof {
  return {
    principal: { kind: "system", service: "session-execution-service-test" },
    operation,
    mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION,
    action: operation,
    resolvedScope: {
      resourceKind: "execution",
      resourceId: null,
      rootSessionId: sessionId,
      ownerKind: "session",
      ownerId: sessionId,
      relation: "self",
    },
    effectClass: "external_side_effect",
    grantId: null,
    grantRevision: null,
    evaluatedAt: CREATED_AT,
  };
}

type DeferredDispatch = {
  promise: Promise<SessionExecutionDispatchResult>;
  resolve(result: SessionExecutionDispatchResult): void;
  reject(error: Error): void;
};

async function createFixture(options: {
  admissionFailures?: number;
  exhaustionWriteFailures?: number;
  queueRetryDelayMs?: number;
  shutdownGraceMs?: number;
  onExecutionChanged?: (executionId: string) => void;
  onExecutionTerminal?: (executionId: string, reason: "execution_canceled" | "execution_terminal", occurredAt: string) => void;
  normalizeRequest?: (request: unknown) => unknown;
  onCancelRunningTurn?: (input: {
    executionId: string;
    hasDurableIntent: boolean;
  }) => void;
  prepareBudgetAdmission?: (sessionId: string) => Promise<void> | void;
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-session-execution-service-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    const insert = db.prepare(`
      INSERT INTO sessions_v6 (
        id,
        title,
        state,
        provider_id,
        catalog_revision,
        model_id,
        approval_mode,
        created_at,
        updated_at,
        last_active_at
      ) VALUES (?, ?, 'active', 'codex', 1, 'gpt-5', 'on-request', ?, ?, ?)
    `);
    insert.run("session-1", "Session 1", CREATED_AT, CREATED_AT, CREATED_AT);
    insert.run("session-2", "Session 2", CREATED_AT, CREATED_AT, CREATED_AT);
    insertStandaloneRoleBindingsForSessions(db);
  } finally {
    db.close();
  }

  const storage = new SessionExecutionStorageV6(dbPath);
  const enqueueWithAuthority = storage.enqueue.bind(storage);
  storage.enqueue = (input) => enqueueWithAuthority({
    ...input,
    expectedContainerRevision: input.expectedContainerRevision ?? storage.getSessionContainerRevision(input.sessionId),
    proof: input.proof ?? trustedExecutionProof("turn.enqueue", input.sessionId),
  });
  const startImmediateWithAuthority = storage.startImmediate.bind(storage);
  storage.startImmediate = (input) => startImmediateWithAuthority({
    ...input,
    expectedContainerRevision: input.expectedContainerRevision ?? storage.getSessionContainerRevision(input.sessionId),
    proof: input.proof ?? trustedExecutionProof("turn.run", input.sessionId),
  });
  const cancelQueuedWithAuthority = storage.cancelQueuedIdempotent.bind(storage);
  storage.cancelQueuedIdempotent = (input) => cancelQueuedWithAuthority({
    ...input,
    expectedRevision: input.expectedRevision ?? storage.get(input.executionId)?.revision ?? 1,
  });
  const recordIdempotencyWithAuthority = storage.recordIdempotency.bind(storage);
  storage.recordIdempotency = (input) => recordIdempotencyWithAuthority({
    ...input,
    expectedRevision: input.expectedRevision ?? storage.get(input.executionId)?.revision ?? 1,
  });
  const activeSessions = new Set<string>();
  const dispatches = new Map<string, DeferredDispatch>();
  const dispatchEvents: Array<{ executionId: string; persistedState: string | undefined }> = [];
  const canceledExecutions: string[] = [];
  let admissionAttempts = 0;
  let remainingAdmissionFailures = options.admissionFailures ?? 0;
  let remainingExhaustionWriteFailures = options.exhaustionWriteFailures ?? 0;
  const admitNextQueued = storage.admitNextQueued.bind(storage);
  storage.admitNextQueued = (sessionId, admittedAt) => {
    admissionAttempts += 1;
    if (remainingAdmissionFailures > 0) {
      remainingAdmissionFailures -= 1;
      throw new Error("transient admission failure");
    }
    return admitNextQueued(sessionId, admittedAt);
  };
  const failNextQueued = storage.failNextQueued.bind(storage);
  storage.failNextQueued = (sessionId, failedAt, expiresAt) => {
    if (remainingExhaustionWriteFailures > 0) {
      remainingExhaustionWriteFailures -= 1;
      throw new Error("transient exhaustion write failure");
    }
    return failNextQueued(sessionId, failedAt, expiresAt);
  };
  let executionIndex = 0;
  let timestampIndex = 0;
  let validationError: Error | null = null;
  const productionService = new SessionExecutionService({
    storage,
    validateTurn(_sessionId, request) {
      if (validationError) {
        throw validationError;
      }
      if (typeof request !== "object" || request === null || !("userMessage" in request)) {
        throw new Error("invalid request");
      }
      return options.normalizeRequest?.(request) ?? request;
    },
    prepareBudgetAdmission: options.prepareBudgetAdmission,
    dispatchTurn(sessionId, executionId) {
      activeSessions.add(sessionId);
      dispatchEvents.push({ executionId, persistedState: storage.get(executionId)?.state });
      const deferred = createDeferredDispatch();
      dispatches.set(executionId, deferred);
      return deferred.promise.finally(() => {
        activeSessions.delete(sessionId);
      });
    },
    cancelRunningTurn(_sessionId, executionId) {
      canceledExecutions.push(executionId);
      options.onCancelRunningTurn?.({
        executionId,
        hasDurableIntent: storage.resolveIdempotency(
          "turn.cancel",
          trustedExecutionProof("turn.cancel"),
          "cancel-running",
          "cancel-running-fingerprint",
        ) !== null,
      });
    },
    isSessionRunInFlight(sessionId) {
      return activeSessions.has(sessionId);
    },
    createExecutionId() {
      executionIndex += 1;
      return "execution-" + executionIndex;
    },
    currentTimestamp() {
      timestampIndex += 1;
      return "2026-08-10T00:00:" + String(timestampIndex).padStart(2, "0") + ".000Z";
    },
    resolveIdempotencyExpiresAt() {
      return "2026-08-11T00:00:00.000Z";
    },
    queueRetryDelayMs: options.queueRetryDelayMs,
    shutdownGraceMs: options.shutdownGraceMs,
    onExecutionChanged: options.onExecutionChanged,
    onExecutionTerminal: options.onExecutionTerminal,
  });
  const service = new Proxy(productionService, {
    get(target, property, receiver) {
      if (property === "run" || property === "enqueue" || property === "cancel") {
        return (input: Parameters<SessionExecutionService[typeof property]>[0]) => target[property]({
          ...input,
          proof: trustedExecutionProof(
            property === "cancel" ? "turn.cancel" : property === "run" ? "turn.run" : "turn.enqueue",
            input.sessionId,
          ),
        } as never);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    directory,
    dbPath,
    storage,
    service,
    dispatches,
    dispatchEvents,
    canceledExecutions,
    getAdmissionAttempts() {
      return admissionAttempts;
    },
    setValidationError(error: Error | null) {
      validationError = error;
    },
  };
}

function createInput(index: number, sessionId = "session-1") {
  return {
    proof: trustedExecutionProof("turn.enqueue", sessionId),
    sessionId,
    request: { userMessage: "message-" + index },
    idempotencyKey: "key-" + index,
    requestFingerprint: "fingerprint-" + index,
  };
}

describe("SessionExecutionService", () => {
  // @test-value v2
  // kind = "regression"
  // claim = "root予算不足やdeadlineでdispatch準備が拒否されたqueued Turnはterminalへ変えず、root queue再開後に同じexecutionを実行する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md#Admission-と-settlement" }
  // fault = "予算待ちを一時的なadmission障害として再試行し、上限回数後にqueued executionをfailedへ確定する"
  // observable = "予算待ち中とresumeRootQueues後の同一execution state、dispatch数"
  // observation_boundary = "component-behavior"
  // scope = "session-execution-budget-deferral"
  // lifecycle = "permanent"
  // distinction = "同一executionにhard limit拒否とdeadline拒否を順に注入し、各保留時のqueued維持と拒否解除後のdispatchを観測する"
  // @end-test-value
  it("budget admission待ちはqueuedを維持しroot-wide wakeで再開する", async () => {
    let budgetDeferral: "BUDGET_HARD_LIMIT_EXCEEDED" | "BUDGET_DEADLINE_EXCEEDED" | null = "BUDGET_HARD_LIMIT_EXCEEDED";
    const fixture = await createFixture({
      prepareBudgetAdmission() {
        if (budgetDeferral) {
          throw new ResourceBudgetError(budgetDeferral, "root budget admission is deferred");
        }
      },
    });
    try {
      const queued = await fixture.service.enqueue(createInput(100));
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(fixture.storage.get(queued.id)?.state, "queued");
      assert.equal(fixture.dispatchEvents.length, 0);

      budgetDeferral = "BUDGET_DEADLINE_EXCEEDED";
      await fixture.service.resumeRootQueues("session-1");
      assert.equal(fixture.storage.get(queued.id)?.state, "queued");
      assert.equal(fixture.dispatchEvents.length, 0);

      budgetDeferral = null;
      await fixture.service.resumeRootQueues("session-1");
      assert.equal(fixture.storage.get(queued.id)?.state, "running");
      assert.equal(fixture.dispatchEvents.length, 1);

      fixture.dispatches.get(queued.id)?.resolve({ state: "completed", result: null });
      await fixture.service.waitForTerminal("session-1", queued.id);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "regression"
  // claim = "child allocation期限切れエラーを受けたqueued Turnは再評価を繰り返してもfailedへ確定せず、エラー解除後に同じexecutionを実行する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md#Admission-と-settlement" }
  // fault = "child allocation期限切れのBUDGET_AUTHORITY_REQUIREDを通常のauthority拒否として扱い、QUEUE_ADMISSION_FAILUREへ収束させる"
  // observable = "期限切れエラー保留中のqueued state、dispatch数、エラー解除後の同一execution dispatch"
  // observation_boundary = "component-behavior"
  // scope = "session-execution-child-allocation-expiry"
  // lifecycle = "permanent"
  // distinction = "allocation_expired detail付きauthority errorを保留対象として扱い、解除後に同じexecutionを再開する"
  // @end-test-value
  it("期限切れchild allocationのadmission待ちはretry exhaustionでfailedにしない", async () => {
    let allocationExpired = true;
    const fixture = await createFixture({
      queueRetryDelayMs: 1,
      prepareBudgetAdmission() {
        if (allocationExpired) {
          throw new ResourceBudgetError("BUDGET_AUTHORITY_REQUIRED", "child allocation expired", {
            reason: "allocation_expired",
            expiresAt: "2026-08-10T00:00:00.000Z",
          });
        }
      },
    });
    try {
      const queued = await fixture.service.enqueue(createInput(102));
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await fixture.service.resumeRootQueues("session-1");
      }
      assert.equal(fixture.storage.get(queued.id)?.state, "queued");
      assert.equal(fixture.storage.get(queued.id)?.errorCode, "");
      assert.equal(fixture.dispatchEvents.length, 0);

      allocationExpired = false;
      await fixture.service.resumeRootQueues("session-1");
      assert.equal(fixture.storage.get(queued.id)?.state, "running");
      assert.deepEqual(fixture.dispatchEvents.map((event) => event.executionId), [queued.id]);

      fixture.dispatches.get(queued.id)?.resolve({ state: "completed", result: null });
      await fixture.service.waitForTerminal("session-1", queued.id);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "regression"
  // claim = "期限切れ以外のBUDGET_AUTHORITY_REQUIREDはqueue保留へ昇格せず、既存のadmission failureへ収束する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md#Admission-と-settlement" }
  // fault = "authority不足をallocation expiryと同じdispatch deferralとして扱い、権限のないqueued Turnを無期限保留する"
  // observable = "同一executionのfailed state、QUEUE_ADMISSION_FAILURE errorCode、queue_admission_exhausted reason"
  // observation_boundary = "component-behavior"
  // scope = "session-execution-authority-admission-failure"
  // lifecycle = "permanent"
  // distinction = "detailsにallocation_expiredがないBUDGET_AUTHORITY_REQUIREDは通常のadmission failureとして確定する"
  // @end-test-value
  it("期限切れでないauthority拒否はqueue admission failureへ収束する", async () => {
    const fixture = await createFixture({
      queueRetryDelayMs: 1,
      prepareBudgetAdmission() {
        throw new ResourceBudgetError("BUDGET_AUTHORITY_REQUIRED", "authority is missing");
      },
    });
    try {
      const queued = await fixture.service.enqueue(createInput(103));
      await waitFor(() => fixture.storage.get(queued.id)?.state === "failed");
      assert.equal(fixture.storage.get(queued.id)?.errorCode, "QUEUE_ADMISSION_FAILURE");
      assert.equal(fixture.storage.get(queued.id)?.reason, "queue_admission_exhausted");
      assert.equal(fixture.dispatchEvents.length, 0);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "regression"
  // claim = "cancel terminal後もproviderが生存するexecutionはroot concurrent Turn予約を保持し、実終了時だけ解放する"
  // oracle = { type = "contract", ref = "docs/adr/030-root-resource-budget.md#決定" }
  // fault = "cancel graceでexecutionをterminalにした時点でrunning Turn予約を解放する"
  // observable = "budget.getが返すconcurrentTurns.reservedのterminal直後とprovider実終了後の値"
  // observation_boundary = "component-behavior"
  // scope = "session-execution-provider-termination-reservation"
  // lifecycle = "permanent"
  // distinction = "通常のterminal settlementではなく、providerTerminationPendingを伴うcancelだけをreconciliation_requiredとして保持する"
  // @end-test-value
  it("provider終了待ちのcancel executionはconcurrent Turn予約を保持する", async () => {
    const fixture = await createFixture();
    const budgetDb = new DatabaseSync(fixture.dbPath);
    const budget = new ResourceBudgetStorage(budgetDb);
    try {
      const running = await fixture.service.run(createInput(101));
      await waitFor(() => fixture.dispatches.has(running.id));
      fixture.dispatches.get(running.id)?.resolve({
        state: "canceled",
        result: null,
        reason: "user_requested",
        providerTerminationPending: true,
      });
      const terminal = await fixture.service.waitForTerminal("session-1", running.id);

      assert.equal(terminal.state, "canceled");
      assert.equal(budget.get("session-1").dimensions.concurrentTurns.reserved, 1);

      budget.settleTurn({
        sessionId: "session-1",
        executionId: running.id,
        outcome: "canceled",
        settledAt: "2026-08-10T00:01:00.000Z",
      });
      assert.equal(budget.get("session-1").dimensions.concurrentTurns.reserved, 0);
    } finally {
      budgetDb.close();
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-ATTACH-10: admissionで正規化した内部requestを永続化してdispatchへ渡す", async () => {
    const fixture = await createFixture({
      normalizeRequest: (request) => ({
        ...(request as object),
        attachments: [{
          kind: "file",
          relativePath: "brief.md",
          identity: { canonicalRelativePath: "brief.md" },
        }],
      }),
    });
    try {
      const execution = await fixture.service.run(createInput(1));
      assert.deepEqual(fixture.storage.get(execution.id)?.request, {
        userMessage: "message-1",
        attachments: [{
          kind: "file",
          relativePath: "brief.md",
          identity: { canonicalRelativePath: "brief.md" },
        }],
      });
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "compatibility"
  // claim = "runとenqueueの返却executionに対応するoutbound projectionはorigin fieldsと受付時刻を保持する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/00-shared-authority-and-history.md" }
  // fault = "outbound projectionが返却executionと異なるorigin fieldsまたはcreatedAtを公開する"
  // observable = "execution createdAtとoutbound record createdAt、origin fields"
  // observation_boundary = "component-behavior"
  // scope = "session-execution-outbound-origin-projection"
  // lifecycle = "permanent"
  // distinction = "transaction原子性ではなく、返却されたcanonical executionとoutbound projectionの公開値一致を観測する"
  // @end-test-value
  it("ORCH-OUTBOUND-01: runとenqueueはacceptanceと同じstorage境界へorigin snapshotを渡す", async () => {
    const fixture = await createFixture();
    try {
      const running = await fixture.service.run({
        ...createInput(1),
        origin: {
          sourceSessionId: "session-2",
          targetSessionTitle: "Session 1 snapshot",
          targetSessionRole: "executor" as const,
          userMessage: "message-1",
        },
      });
      assert.deepEqual(fixture.storage.listSessionOutboundExecutions("session-2"), [{
        sequence: 1,
        executionId: running.id,
        targetSessionId: "session-1",
        sourceMessageSequence: -1,
        operation: "turn.run",
        targetSessionTitle: "Session 1 snapshot",
        targetSessionRole: "executor",
        userMessage: "message-1",
        createdAt: running.createdAt,
      }]);

      const runningTerminal = fixture.service.waitForTerminal("session-1", running.id);
      fixture.dispatches.get(running.id)?.resolve({ state: "completed", result: null });
      await runningTerminal;

      const queued = await fixture.service.enqueue({
        ...createInput(2, "session-2"),
        origin: {
          sourceSessionId: "session-1",
          targetSessionTitle: "Session 2 snapshot",
          targetSessionRole: "executor" as const,
          userMessage: "message-2",
        },
      });
      assert.deepEqual(fixture.storage.listSessionOutboundExecutions("session-1"), [{
        sequence: 2,
        executionId: queued.id,
        targetSessionId: "session-2",
        sourceMessageSequence: -1,
        operation: "turn.enqueue",
        targetSessionTitle: "Session 2 snapshot",
        targetSessionRole: "executor",
        userMessage: "message-2",
        createdAt: queued.createdAt,
      }]);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "compatibility"
  // claim = "runとenqueueはrevision 2のdelegated WorkItem bindingを検証してexecution associationを同じacceptance境界へ保存する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#実行関連付けと再開" }
  // failure_mode = "schema revision追加後にdelegated WorkItem associationが拒否されるかexecutionだけが保存される"
  // scope = "SessionExecutionService WorkItem association admission"
  // lifecycle = "permanent"
  // distinction = "runとenqueueの双方をreal SQLiteのdelegated rowへ関連付けて観測する"
  // @end-test-value
  it("WORK-EXEC-05: runとenqueueは検証済みWork Item associationをexecutionと同時保存する", async () => {
    const fixture = await createFixture();
    const db = new DatabaseSync(fixture.dbPath);
    try {
      const insertWorkItem = db.prepare(`
        INSERT INTO work_items_v6 (
          id, kind, contract_revision, root_session_id, creator_session_id, target_session_id,
          parent_work_item_id, goal, scope, completion_criteria, authority,
          source_identity_json, state, revision, created_at, updated_at
        ) VALUES (?, 'delegated', 2, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)
      `);
      const commonValues = [
        "goal",
        "scope",
        "done",
        "local",
        JSON.stringify({ workspace: null, repository: null, branch: null, base: null, head: null }),
        CREATED_AT,
        CREATED_AT,
      ] as const;
      insertWorkItem.run(
        "work-run",
        "session-2",
        "session-2",
        "session-1",
        ...commonValues,
      );
      insertWorkItem.run(
        "work-enqueue",
        "session-1",
        "session-1",
        "session-2",
        ...commonValues,
      );
    } finally {
      db.close();
    }
    try {
      const running = await fixture.service.run({
        ...createInput(1),
        workItemId: "work-run",
      });
      const queued = await fixture.service.enqueue({
        ...createInput(2, "session-2"),
        workItemId: "work-enqueue",
      });
      assert.equal(fixture.storage.getExecutionWorkItemId(running.id), "work-run");
      assert.equal(fixture.storage.getExecutionWorkItemId(queued.id), "work-enqueue");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("I-01: canonical replayは現在のSession validationが失敗しても保存済みexecutionへ収束する", async () => {
    const fixture = await createFixture();
    try {
      const first = await fixture.service.run(createInput(1));
      const firstTerminal = fixture.service.waitForTerminal("session-1", first.id);
      fixture.dispatches.get(first.id)?.resolve({ state: "completed", result: { ok: true } });
      await firstTerminal;

      fixture.setValidationError(new Error("session became read-only"));
      const replay = await fixture.service.run(createInput(1));
      assert.equal(replay.id, first.id);
      assert.equal(replay.state, "completed");

      await assert.rejects(
        fixture.service.run({ ...createInput(1), requestFingerprint: "different" }),
        (error) => error instanceof SessionExecutionIdempotencyConflictError,
      );

      fixture.setValidationError(null);
      const enqueued = await fixture.service.enqueue(createInput(2, "session-2"));
      await waitFor(() => fixture.dispatches.has(enqueued.id));
      const enqueuedTerminal = fixture.service.waitForTerminal("session-2", enqueued.id);
      fixture.dispatches.get(enqueued.id)?.resolve({ state: "completed", result: null });
      await enqueuedTerminal;
      fixture.setValidationError(new Error("provider became unavailable"));
      const enqueueReplay = await fixture.service.enqueue(createInput(2, "session-2"));
      assert.equal(enqueueReplay.id, enqueued.id);
      assert.equal(enqueueReplay.state, "completed");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("E-01: 同一Sessionのturn.run競合をSESSION_BUSYで拒否し、暗黙にqueueへ変換しない", async () => {
    const fixture = await createFixture();
    try {
      const first = await fixture.service.run(createInput(1));
      assert.equal(first.state, "running");

      await assert.rejects(
        fixture.service.run(createInput(2)),
        (error) => error instanceof SessionExecutionBusyError && error.code === "SESSION_BUSY",
      );
      assert.equal(fixture.storage.listSessionExecutions("session-1").length, 1);

      fixture.dispatches.get(first.id)?.resolve({ state: "completed", result: { ok: true } });
      const completed = await fixture.service.waitForTerminal("session-1", first.id);
      assert.equal(completed.state, "completed");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("E-02: 先にcommitしたqueued executionを同時到着のturn.runが追い越さない", async () => {
    const fixture = await createFixture();
    try {
      const [enqueuedResult, runResult] = await Promise.allSettled([
        fixture.service.enqueue(createInput(1)),
        fixture.service.run(createInput(2)),
      ]);

      assert.equal(enqueuedResult.status, "fulfilled");
      assert.equal(runResult.status, "rejected");
      if (enqueuedResult.status !== "fulfilled") return;
      assert.equal(
        runResult.status === "rejected"
          && runResult.reason instanceof SessionExecutionBusyError
          && runResult.reason.code === "SESSION_BUSY",
        true,
      );
      await waitFor(() => fixture.dispatchEvents.length === 1);
      assert.equal(fixture.dispatchEvents[0]?.executionId, enqueuedResult.value.id);
      assert.equal(fixture.storage.get(enqueuedResult.value.id)?.state, "running");
      assert.equal(fixture.storage.listSessionExecutions("session-1").length, 1);

      fixture.dispatches.get(enqueuedResult.value.id)?.resolve({ state: "completed", result: null });
      await fixture.service.waitForTerminal("session-1", enqueuedResult.value.id);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("I-01: activeなturn.runのretryもcanonical executionへ収束する", async () => {
    const fixture = await createFixture();
    try {
      const first = await fixture.service.run(createInput(1));
      const replay = await fixture.service.run(createInput(1));

      assert.equal(replay.id, first.id);
      assert.equal(fixture.storage.listSessionExecutions("session-1").length, 1);

      fixture.dispatches.get(first.id)?.resolve({ state: "completed", result: null });
      await fixture.service.waitForTerminal("session-1", first.id);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("validation failureはexecutionとidempotency effectを作らない", async () => {
    const fixture = await createFixture();
    try {
      await assert.rejects(
        fixture.service.run({
          ...createInput(1),
          request: {},
        }),
        /invalid request/,
      );
      assert.equal(fixture.storage.listSessionExecutions("session-1").length, 0);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("E-02: enqueue commit後にrunningへ永続化してからFIFO順でdispatchする", async () => {
    const fixture = await createFixture();
    try {
      const first = await fixture.service.enqueue(createInput(1));
      const second = await fixture.service.enqueue(createInput(2));

      assert.equal(first.state, "queued");
      assert.equal(second.state, "queued");
      await waitFor(() => fixture.dispatchEvents.length === 1);
      assert.deepEqual(fixture.dispatchEvents[0], {
        executionId: first.id,
        persistedState: "running",
      });
      assert.equal(fixture.storage.get(second.id)?.state, "queued");

      fixture.dispatches.get(first.id)?.resolve({ state: "completed", result: { order: 1 } });
      await fixture.service.waitForTerminal("session-1", first.id);
      await waitFor(() => fixture.dispatchEvents.length === 2);
      assert.deepEqual(fixture.dispatchEvents[1], {
        executionId: second.id,
        persistedState: "running",
      });

      fixture.dispatches.get(second.id)?.resolve({ state: "completed", result: { order: 2 } });
      await fixture.service.waitForTerminal("session-1", second.id);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("C-01: queued cancelは対象Sessionとのownershipを検証してterminalへ遷移する", async () => {
    const fixture = await createFixture();
    try {
      const running = await fixture.service.run(createInput(1));
      const queued = await fixture.service.enqueue(createInput(2));

      await assert.rejects(
        fixture.service.cancel({
          sessionId: "session-2",
          executionId: queued.id,
          idempotencyKey: "cancel-wrong-owner",
          requestFingerprint: "cancel-wrong-owner-fingerprint",
        }),
        (error) => error instanceof SessionExecutionOwnerMismatchError
          && error.code === "EXECUTION_OWNER_MISMATCH",
      );
      const canceled = await fixture.service.cancel({
        sessionId: "session-1",
        executionId: queued.id,
        idempotencyKey: "cancel-queued",
        requestFingerprint: "cancel-queued-fingerprint",
      });
      assert.equal(canceled.state, "canceled");
      assert.equal(canceled.completedAt === null, false);
      const replay = await fixture.service.cancel({
        sessionId: "session-1",
        executionId: queued.id,
        idempotencyKey: "cancel-queued",
        requestFingerprint: "cancel-queued-fingerprint",
      });
      assert.equal(replay.id, canceled.id);
      assert.equal(replay.state, "canceled");

      fixture.dispatches.get(running.id)?.resolve({ state: "completed", result: null });
      await fixture.service.waitForTerminal("session-1", running.id);
      assert.equal(fixture.dispatchEvents.length, 1);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("C-01: running cancelはexecutionを変えずruntimeのabort境界へ渡す", async () => {
    const abortObservations: Array<{ executionId: string; hasDurableIntent: boolean }> = [];
    const fixture = await createFixture({
      onCancelRunningTurn: (input) => abortObservations.push(input),
    });
    try {
      const running = await fixture.service.run(createInput(1));
      const cancelResult = await fixture.service.cancel({
        sessionId: "session-1",
        executionId: running.id,
        idempotencyKey: "cancel-running",
        requestFingerprint: "cancel-running-fingerprint",
      });

      assert.equal(cancelResult.state, "running");
      assert.deepEqual(fixture.canceledExecutions, [running.id]);
      assert.deepEqual(abortObservations, [{
        executionId: running.id,
        hasDurableIntent: true,
      }]);

      const replay = await fixture.service.cancel({
        sessionId: "session-1",
        executionId: running.id,
        idempotencyKey: "cancel-running",
        requestFingerprint: "cancel-running-fingerprint",
      });
      assert.equal(replay.id, running.id);
      assert.deepEqual(fixture.canceledExecutions, [running.id, running.id]);

      fixture.dispatches.get(running.id)?.resolve({
        state: "canceled",
        result: null,
        reason: "user_requested",
      });
      const canceled = await fixture.service.waitForTerminal("session-1", running.id);
      assert.equal(canceled.state, "canceled");
      assert.equal(canceled.reason, "user_requested");
      const terminalReplay = await fixture.service.cancel({
        sessionId: "session-1",
        executionId: running.id,
        idempotencyKey: "cancel-running",
        requestFingerprint: "cancel-running-fingerprint",
      });
      assert.equal(terminalReplay.state, "canceled");
      assert.deepEqual(fixture.canceledExecutions, [running.id, running.id]);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("GUI-Q-03: queued限定cancelはadmission後のrunning executionを中断しない", async () => {
    const fixture = await createFixture();
    try {
      const running = await fixture.service.run(createInput(1));
      const queued = await fixture.service.enqueue(createInput(2));

      fixture.dispatches.get(running.id)?.resolve({ state: "completed", result: null });
      await fixture.service.waitForTerminal("session-1", running.id);
      await waitFor(() => fixture.storage.get(queued.id)?.state === "running");

      await assert.rejects(
        fixture.service.cancel({
          sessionId: "session-1",
          executionId: queued.id,
          idempotencyKey: "cancel-admitted-as-queued",
          requestFingerprint: "cancel-admitted-as-queued-fingerprint",
          expectedState: "queued",
        }),
        (error) => error instanceof SessionExecutionStateConflictError
          && error.state === "running",
      );
      assert.deepEqual(fixture.canceledExecutions, []);

      fixture.dispatches.get(queued.id)?.resolve({ state: "completed", result: null });
      await fixture.service.waitForTerminal("session-1", queued.id);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("CANCEL-IDEMPOTENCY-11: running cancelはintent保存失敗時にabort effectを起こさない", async () => {
    const fixture = await createFixture();
    try {
      const running = await fixture.service.run(createInput(1));
      const recordIdempotency = fixture.storage.recordIdempotency.bind(fixture.storage);
      fixture.storage.recordIdempotency = () => {
        throw new Error("cancel intent persistence failed");
      };

      await assert.rejects(
        fixture.service.cancel({
          sessionId: "session-1",
          executionId: running.id,
          idempotencyKey: "cancel-running",
          requestFingerprint: "cancel-running-fingerprint",
        }),
        /cancel intent persistence failed/,
      );
      assert.deepEqual(fixture.canceledExecutions, []);

      fixture.storage.recordIdempotency = recordIdempotency;
      const replayable = await fixture.service.cancel({
        sessionId: "session-1",
        executionId: running.id,
        idempotencyKey: "cancel-running",
        requestFingerprint: "cancel-running-fingerprint",
      });
      assert.equal(replayable.id, running.id);
      assert.deepEqual(fixture.canceledExecutions, [running.id]);

      fixture.dispatches.get(running.id)?.resolve({ state: "canceled", result: null });
      await fixture.service.waitForTerminal("session-1", running.id);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "terminal executionへの新規cancelはidempotency結果を作らずstate conflictで拒否する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/00-shared-authority-and-history.md" }
  // failure_mode = "terminal executionの取消再試行が新規effectまたはidempotency結果を生成する"
  // scope = "SessionExecutionService cancel state boundary"
  // lifecycle = "permanent"
  // @end-test-value
  it("CANCEL-STATE-10: terminal executionへの新規cancelはidempotency effect前に拒否する", async () => {
    const fixture = await createFixture();
    try {
      const running = await fixture.service.run(createInput(1));
      fixture.dispatches.get(running.id)?.resolve({ state: "completed", result: null });
      await fixture.service.waitForTerminal("session-1", running.id);

      await assert.rejects(
        fixture.service.cancel({
          sessionId: "session-1",
          executionId: running.id,
          idempotencyKey: "cancel-after-completion",
          requestFingerprint: "cancel-after-completion-fingerprint",
        }),
        (error) => error instanceof SessionExecutionStateConflictError
          && error.state === "completed",
      );
      assert.equal(
        fixture.storage.resolveIdempotency(
          "turn.cancel",
          trustedExecutionProof("turn.cancel"),
          "cancel-after-completion",
          "cancel-after-completion-fingerprint",
        ),
        null,
      );
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("ID-02: 異なるSessionの同一cancel key競合は一方のabort effect前に拒否する", async () => {
    const fixture = await createFixture();
    try {
      const first = await fixture.service.run(createInput(1, "session-1"));
      const second = await fixture.service.run(createInput(2, "session-2"));

      const results = await Promise.allSettled([
        fixture.service.cancel({
          sessionId: "session-1",
          executionId: first.id,
          idempotencyKey: "shared-cancel-key",
          requestFingerprint: "cancel-first",
        }),
        fixture.service.cancel({
          sessionId: "session-2",
          executionId: second.id,
          idempotencyKey: "shared-cancel-key",
          requestFingerprint: "cancel-second",
        }),
      ]);

      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter(
        (result) => result.status === "rejected"
          && result.reason instanceof SessionExecutionIdempotencyConflictError,
      ).length, 1);
      assert.equal(fixture.canceledExecutions.length, 1);

      fixture.dispatches.get(first.id)?.resolve({ state: "completed", result: null });
      fixture.dispatches.get(second.id)?.resolve({ state: "completed", result: null });
      await Promise.all([
        fixture.service.waitForTerminal("session-1", first.id),
        fixture.service.waitForTerminal("session-2", second.id),
      ]);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("LC-01: shutdown開始後はrunning完了時にqueued executionをadmitしない", async () => {
    const fixture = await createFixture();
    try {
      const running = await fixture.service.enqueue(createInput(1));
      await waitFor(() => fixture.dispatchEvents.length === 1);
      const queued = await fixture.service.enqueue(createInput(2));
      assert.equal(fixture.storage.get(queued.id)?.state, "queued");

      fixture.service.beginShutdown();
      fixture.dispatches.get(running.id)?.resolve({ state: "completed", result: null });
      await fixture.service.waitForTerminal("session-1", running.id);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      assert.equal(fixture.dispatchEvents.length, 1);
      assert.equal(fixture.storage.get(queued.id)?.state, "queued");
      await fixture.service.resumeQueue("session-1");
      assert.equal(fixture.dispatchEvents.length, 1);
      assert.equal(fixture.storage.get(queued.id)?.state, "queued");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-SHUTDOWN-07: stuck providerをcancelし、finite grace後にinterruptedへ確定する", async () => {
    const fixture = await createFixture({ shutdownGraceMs: 10 });
    let storageClosed = false;
    try {
      const running = await fixture.service.enqueue(createInput(1));
      await waitFor(() => fixture.dispatchEvents.length === 1);
      const queued = await fixture.service.enqueue(createInput(2));
      const terminal = fixture.service.waitForTerminal("session-1", running.id);

      await fixture.service.drainForShutdown();

      assert.deepEqual(fixture.canceledExecutions, [running.id]);
      assert.equal(fixture.storage.get(running.id)?.state, "interrupted");
      assert.equal(fixture.storage.get(running.id)?.reason, "runtime_shutdown");
      assert.equal(fixture.storage.get(queued.id)?.state, "queued");
      assert.equal(fixture.dispatchEvents.length, 1);

      fixture.storage.close();
      storageClosed = true;
      fixture.dispatches.get(running.id)?.resolve({ state: "completed", result: { tooLate: true } });
      const settled = await terminal;
      assert.equal(settled.state, "interrupted");
      assert.equal(settled.reason, "runtime_shutdown");
    } finally {
      if (!storageClosed) fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-QUEUE-08: transient admission failureは一つのtracked retryでqueuedを自動回復する", async () => {
    const fixture = await createFixture({ admissionFailures: 1, queueRetryDelayMs: 5 });
    try {
      const queued = await fixture.service.enqueue(createInput(1));

      await waitFor(() => fixture.dispatchEvents.length === 1);

      assert.equal(fixture.getAdmissionAttempts(), 2);
      assert.equal(fixture.storage.get(queued.id)?.state, "running");
      fixture.dispatches.get(queued.id)?.resolve({ state: "completed", result: null });
      await fixture.service.waitForTerminal("session-1", queued.id);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-QUEUE-08: shutdown開始後は予約済みqueue retryを実行しない", async () => {
    const fixture = await createFixture({ admissionFailures: 1, queueRetryDelayMs: 50 });
    try {
      const queued = await fixture.service.enqueue(createInput(1));
      await waitFor(() => fixture.getAdmissionAttempts() === 1);

      await fixture.service.drainForShutdown();
      await new Promise<void>((resolve) => setTimeout(resolve, 75));

      assert.equal(fixture.getAdmissionAttempts(), 1);
      assert.equal(fixture.storage.get(queued.id)?.state, "queued");
      assert.equal(fixture.dispatchEvents.length, 0);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-QUEUE-08: admission failure exhaustionはqueuedをdurable failedへ収束する", async () => {
    const fixture = await createFixture({ admissionFailures: 2, queueRetryDelayMs: 5 });
    try {
      const queued = await fixture.service.enqueue(createInput(1));
      await waitFor(() => fixture.storage.get(queued.id)?.state === "failed");

      assert.ok(fixture.getAdmissionAttempts() >= 2);
      assert.equal(fixture.storage.get(queued.id)?.state, "failed");
      assert.equal(fixture.storage.get(queued.id)?.errorCode, "QUEUE_ADMISSION_FAILURE");
      assert.equal(fixture.storage.get(queued.id)?.reason, "queue_admission_exhausted");
      assert.equal(fixture.dispatchEvents.length, 0);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-QUEUE-08: admission failure exhaustion後も次のqueuedを自動実行する", async () => {
    const fixture = await createFixture({ admissionFailures: 2, queueRetryDelayMs: 50 });
    try {
      const failed = await fixture.service.enqueue(createInput(1));
      const next = await fixture.service.enqueue(createInput(2));

      await waitFor(() => fixture.storage.get(failed.id)?.state === "failed");
      await waitFor(() => fixture.dispatchEvents.length === 1);

      assert.equal(fixture.getAdmissionAttempts(), 3);
      assert.equal(fixture.storage.get(next.id)?.state, "running");
      fixture.dispatches.get(next.id)?.resolve({ state: "completed", result: null });
      await fixture.service.waitForTerminal("session-1", next.id);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-QUEUE-08: exhaustion terminal writeの一時失敗後もqueuedを自動回復する", async () => {
    const fixture = await createFixture({
      admissionFailures: 2,
      exhaustionWriteFailures: 1,
      queueRetryDelayMs: 5,
    });
    try {
      const queued = await fixture.service.enqueue(createInput(1));

      await waitFor(() => fixture.dispatchEvents.length === 1);

      assert.equal(fixture.storage.get(queued.id)?.state, "running");
      fixture.dispatches.get(queued.id)?.resolve({ state: "completed", result: null });
      await fixture.service.waitForTerminal("session-1", queued.id);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-ERROR-06: dispatch exceptionはstable PROVIDER_FAILUREへ収束する", async () => {
    const fixture = await createFixture();
    try {
      const running = await fixture.service.run(createInput(1));
      fixture.dispatches.get(running.id)?.reject(new Error("provider failed"));

      const failed = await fixture.service.waitForTerminal("session-1", running.id);

      assert.equal(failed.state, "failed");
      assert.equal(failed.errorCode, "PROVIDER_FAILURE");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("P-01: public projectionはrequestとstorage sequenceを公開しない", async () => {
    const fixture = await createFixture();
    try {
      const execution = await fixture.service.run(createInput(1));
      assert.equal("request" in execution, false);
      assert.equal("sequence" in execution, false);

      fixture.dispatches.get(execution.id)?.resolve({ state: "completed", result: null });
      await fixture.service.waitForTerminal("session-1", execution.id);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("E-03: restart reconciliationはrunningを再dispatchせずinterruptedへ収束してFIFOを再開する", async () => {
    const fixture = await createFixture();
    try {
      fixture.storage.enqueue({
        id: "pre-restart-1",
        sessionId: "session-1",
        request: { userMessage: "before restart" },
        idempotencyKey: "pre-restart-key-1",
        requestFingerprint: "pre-restart-fingerprint-1",
        createdAt: "2026-08-10T00:00:01.000Z",
        expiresAt: "2026-08-11T00:00:00.000Z",
      });
      fixture.storage.enqueue({
        id: "pre-restart-2",
        sessionId: "session-1",
        request: { userMessage: "after restart" },
        idempotencyKey: "pre-restart-key-2",
        requestFingerprint: "pre-restart-fingerprint-2",
        createdAt: "2026-08-10T00:00:02.000Z",
        expiresAt: "2026-08-11T00:00:00.000Z",
      });
      fixture.storage.admitNextQueued("session-1", "2026-08-10T00:00:03.000Z");

      const interrupted = await fixture.service.reconcileAfterRestart();

      assert.deepEqual(interrupted.map((execution) => execution.id), ["pre-restart-1"]);
      assert.equal(interrupted[0]?.state, "interrupted");
      assert.equal(interrupted[0]?.reason, "runtime_restarted");
      await waitFor(() => fixture.dispatchEvents.length === 1);
      assert.equal(fixture.dispatchEvents[0]?.executionId, "pre-restart-2");
      assert.equal(fixture.storage.get("pre-restart-2")?.state, "running");

      fixture.dispatches.get("pre-restart-2")?.resolve({ state: "completed", result: null });
      await fixture.service.waitForTerminal("session-1", "pre-restart-2");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-INTERACTION-11: terminal commit後にinteraction expiry boundaryを通知する", async () => {
    const terminal: Array<{ id: string; reason: string; state: string | undefined }> = [];
    let fixture: Awaited<ReturnType<typeof createFixture>>;
    fixture = await createFixture({
      onExecutionTerminal: (id, reason) => terminal.push({ id, reason, state: fixture.storage.get(id)?.state }),
    });
    try {
      const running = await fixture.service.run(createInput(1));
      await waitFor(() => fixture.dispatchEvents.length === 1);
      fixture.dispatches.get(running.id)?.resolve({ state: "completed", result: { assistantText: "done" } });
      await fixture.service.waitForTerminal("session-1", running.id);
      assert.deepEqual(terminal, [{ id: running.id, reason: "execution_terminal", state: "completed" }]);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("TN-TERM-03: terminal observer例外はsource commitと次のFIFO admissionを巻き戻さない", async () => {
    const fixture = await createFixture({
      onExecutionTerminal: () => { throw new Error("observer failed"); },
    });
    try {
      const first = await fixture.service.enqueue(createInput(1));
      const second = await fixture.service.enqueue(createInput(2));
      await waitFor(() => fixture.dispatches.has(first.id));
      fixture.dispatches.get(first.id)?.resolve({
        state: "failed",
        result: null,
        errorCode: "PROVIDER_FAILURE",
        reason: "session_runtime_failed",
      });
      const terminal = await fixture.service.waitForTerminal("session-1", first.id);
      assert.equal(terminal.state, "failed");
      await waitFor(() => fixture.dispatches.has(second.id));
      assert.equal(fixture.storage.get(second.id)?.state, "running");
      fixture.dispatches.get(second.id)?.resolve({ state: "completed", result: null });
      await fixture.service.waitForTerminal("session-1", second.id);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXECUTION-OBSERVER-01: changed observer例外後もimmediate executionをdispatchする", async () => {
    const fixture = await createFixture({
      onExecutionChanged: () => { throw new Error("observer failed"); },
    });
    try {
      const running = await fixture.service.run(createInput(1));
      await waitFor(() => fixture.dispatches.has(running.id));
      assert.equal(fixture.storage.get(running.id)?.state, "running");
      fixture.dispatches.get(running.id)?.resolve({ state: "completed", result: null });
      assert.equal((await fixture.service.waitForTerminal("session-1", running.id)).state, "completed");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXECUTION-OBSERVER-01: changed observer例外後もqueue admissionとdrainを継続する", async () => {
    const fixture = await createFixture({
      onExecutionChanged: () => { throw new Error("observer failed"); },
    });
    try {
      const queued = await fixture.service.enqueue(createInput(1));
      await waitFor(() => fixture.dispatches.has(queued.id));
      assert.equal(fixture.storage.get(queued.id)?.state, "running");
      fixture.dispatches.get(queued.id)?.resolve({ state: "completed", result: null });
      assert.equal((await fixture.service.waitForTerminal("session-1", queued.id)).state, "completed");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("TN-TERM-03: restart interruptはcommit済みstateをterminal observerへ通知する", async () => {
    const terminal: Array<{ id: string; state: string | undefined }> = [];
    let fixture: Awaited<ReturnType<typeof createFixture>>;
    fixture = await createFixture({
      onExecutionTerminal: (id) => terminal.push({ id, state: fixture.storage.get(id)?.state }),
    });
    try {
      fixture.storage.startImmediate({
        id: "restart-source",
        sessionId: "session-1",
        request: { userMessage: "running before restart" },
        idempotencyKey: "restart-source-key",
        requestFingerprint: "restart-source-fingerprint",
        createdAt: "2026-08-10T00:00:00.000Z",
        expiresAt: "2026-08-11T00:00:00.000Z",
      });
      await fixture.service.reconcileAfterRestart();
      assert.deepEqual(terminal, [{ id: "restart-source", state: "interrupted" }]);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});

function createDeferredDispatch(): DeferredDispatch {
  let resolve!: (result: SessionExecutionDispatchResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<SessionExecutionDispatchResult>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition was not met");
}
